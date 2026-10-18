import React, { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Square,
  Check,
  AlertTriangle,
  Info,
  CheckSquare,
  Square as SquareIcon,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { buildChatMessages, PromptPayload } from '../../services/llm/prompts';
import { gatewayClient } from '../../services/llm/gatewayClient';
import {
  extractAndParseAiJson,
  ProposalResponse,
  ReviewResponse,
  validateProposalResponse,
  validateReviewResponse,
} from '../../services/llm/aiSchemas';
import { adoptProposals } from './proposalAdopter';
import { RequestPreview } from './RequestPreview';
import { loadAppSettings } from '../../services/persistence/appStorage';
import { getModelMetadata } from '../settings/modelCatalog';
import { NODE_KIND_LABELS } from '../../rendering/svgExport';

export const AiPanel: React.FC = () => {
  const { state, dispatch } = useApp();
  const { present: project, revision: currentRevision } = state.history;
  const { activeDiagramId, selectedNodeId, gatewayToken } = state.ui;

  const currentDiagram = project.diagrams.find((d) => d.id === activeDiagramId) || project.diagrams[0];
  const focusNode = currentDiagram.nodes.find((n) => n.id === selectedNodeId);

  // タスクと指示
  const [task, setTask] = useState<'expand' | 'alternatives' | 'review'>('expand');
  const [userInstruction, setUserInstruction] = useState('');

  // 実行状態
  const [isRunning, setIsRunning] = useState(false);
  const [streamChars, setStreamChars] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 生成結果
  const [requestRevision, setRequestRevision] = useState<number | null>(null);
  const [requestDiagramId, setRequestDiagramId] = useState<string | null>(null);
  const [proposalResult, setProposalResult] = useState<ProposalResponse | null>(null);
  const [reviewResult, setReviewResult] = useState<ReviewResponse | null>(null);

  // 候補ノードの個別選択状態 (candidateId の Set)
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());

  // コンポーネントアンマウント時のAbortクリーンアップ
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // 実行ボタンハンドラー
  const handleExecute = async () => {
    if (isRunning) return;

    if (task !== 'review' && !focusNode) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `ai-hint-${Date.now()}`,
          type: 'info',
          message: '展開案または代替案を実行するには、対象となるノードを図上で選択してください。',
        },
      });
      return;
    }

    setErrorMessage(null);
    setProposalResult(null);
    setReviewResult(null);
    setStreamChars(0);
    setIsRunning(true);

    // リクエスト開始時のRevisionと図IDを記録 (仕様書 4/9.5: Revision/図不整合ガード)
    setRequestRevision(currentRevision);
    setRequestDiagramId(currentDiagram.id);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const payload: PromptPayload = {
      task,
      focusNode,
      diagram: currentDiagram,
      levels: project.levels,
      userInstruction: userInstruction.trim() || undefined,
    };

    const messages = buildChatMessages(payload);
    const settings = loadAppSettings();

    try {
      const response = await gatewayClient.complete(
        {
          apiBaseUrl: settings.gatewayUrl,
          authEnabled: settings.gatewayAuthEnabled,
          token: gatewayToken,
        },
        {
          modelId: project.aiPreferences.modelId,
          messages,
          temperature: project.aiPreferences.temperature,
          timeoutSeconds: project.aiPreferences.timeoutSeconds,
          stream: project.aiPreferences.stream,
          signal: controller.signal,
        },
        (chunk) => {
          setStreamChars((prev) => prev + chunk.length);
        }
      );

      // JSON パース & 構造検証
      const rawJson = extractAndParseAiJson(response.content);
      const validationContext = {
        validLevelIds: new Set(project.levels.map((l) => l.id)),
        existingNodeIds: new Set(currentDiagram.nodes.map((n) => n.id)),
        existingEdgeIds: new Set(currentDiagram.edges.map((e) => e.id)),
      };

      if (task === 'review') {
        const vResult = validateReviewResponse(rawJson, validationContext);
        if (!vResult.valid || !vResult.data) {
          throw new Error(vResult.error || 'レビュー出力の検証に失敗しました。');
        }
        setReviewResult(vResult.data);
      } else {
        const vResult = validateProposalResponse(rawJson, validationContext);
        if (!vResult.valid || !vResult.data) {
          throw new Error(vResult.error || '展開案出力の検証に失敗しました。');
        }
        setProposalResult(vResult.data);
        // デフォルトですべての候補ノードを選択
        setSelectedCandidates(new Set(vResult.data.nodes.map((n) => n.candidateId)));
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorMessage('リクエストはキャンセルされました。');
      } else {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsRunning(false);
      abortControllerRef.current = null;
    }
  };

  // キャンセル
  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  // 候補ノードの選択トグル
  const handleToggleCandidate = (cId: string) => {
    const next = new Set(selectedCandidates);
    if (next.has(cId)) {
      next.delete(cId);
    } else {
      next.add(cId);
    }
    setSelectedCandidates(next);
  };

  // 採用実行 (トランザクション)
  const handleAdopt = () => {
    if (!proposalResult) return;

    // 仕様書 9.5 / A04: Revision・対象図不整合ガード
    if (requestRevision !== currentRevision || requestDiagramId !== currentDiagram.id) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `rev-mismatch-${Date.now()}`,
          type: 'warning',
          message: '推論開始後に図または表示内容が変更されたため採用できません（整合性保護）。再度推論を実行してください。',
        },
      });
      return;
    }

    if (selectedCandidates.size === 0) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `select-candidate-${Date.now()}`,
          type: 'info',
          message: '採用する候補ノードを1件以上選択してください。',
        },
      });
      return;
    }

    const { project: nextProject, addedNodeCount, addedEdgeCount, omittedEdgeCount } = adoptProposals(
      project,
      currentDiagram.id,
      proposalResult,
      { selectedCandidateIds: selectedCandidates },
      { modelId: project.aiPreferences.modelId }
    );

    // 1回の操作として履歴へコミット (Undoスタックと表示中の図を維持)
    dispatch({ type: 'APPLY_PROJECT_UPDATE', project: nextProject });

    let msg = `${addedNodeCount}件の候補ノードと ${addedEdgeCount}件のエッジを採用しました。`;
    if (omittedEdgeCount > 0) {
      msg += `\n（※未選択の候補に繋がっていた ${omittedEdgeCount}件のエッジは自動除外されました）`;
    }
    dispatch({
      type: 'SET_NOTIFICATION',
      notification: {
        id: `adopt-ok-${Date.now()}`,
        type: 'success',
        message: msg,
      },
    });

    // 採用完了後は結果をクリア
    setProposalResult(null);
  };

  const isRevisionMismatched =
    (requestRevision !== null && requestRevision !== currentRevision) ||
    (requestDiagramId !== null && requestDiagramId !== currentDiagram.id);
  const currentModelMeta = getModelMetadata(project.aiPreferences.modelId);

  return (
    <div className="p-4 space-y-4 text-xs select-text overflow-y-auto max-h-full">
      {/* モデル情報バナー */}
      <div className="bg-purple-50/70 border border-purple-200/80 p-2.5 rounded-lg flex items-center justify-between">
        <div>
          <span className="text-[10px] text-purple-600 block">推論モデル (左ペインで変更)</span>
          <strong className="text-purple-900 font-semibold truncate block max-w-[200px]" title={currentModelMeta.displayName}>
            {currentModelMeta.displayName}
          </strong>
        </div>
        <span className="font-mono text-[10px] text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">
          {project.aiPreferences.modelId.split('/')[0]}
        </span>
      </div>

      {/* タスク選択 */}
      <div>
        <label className="text-slate-600 block mb-1 font-semibold">タスク選択</label>
        <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-lg">
          <button
            onClick={() => setTask('expand')}
            className={`py-1.5 px-2 rounded text-xs font-medium transition-colors ${
              task === 'expand' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            展開案
          </button>
          <button
            onClick={() => setTask('alternatives')}
            className={`py-1.5 px-2 rounded text-xs font-medium transition-colors ${
              task === 'alternatives' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            代替案
          </button>
          <button
            onClick={() => setTask('review')}
            className={`py-1.5 px-2 rounded text-xs font-medium transition-colors ${
              task === 'review' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            図レビュー
          </button>
        </div>
      </div>

      {/* フォーカスノード表示 */}
      {task !== 'review' && (
        <div>
          <label className="text-slate-600 block mb-1 font-semibold">フォーカスノード (必須)</label>
          {focusNode ? (
            <div className="p-2 bg-slate-50 border border-slate-200 rounded flex items-center justify-between">
              <span className="truncate font-medium text-slate-800" title={focusNode.label}>
                [{NODE_KIND_LABELS[focusNode.kind]}] {focusNode.label}
              </span>
              <span className="text-[10px] bg-slate-200 text-slate-600 px-1 rounded flex-shrink-0">
                選択中
              </span>
            </div>
          ) : (
            <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-amber-800 text-[11px] flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>図上のノードをクリックして選択してください。</span>
            </div>
          )}
        </div>
      )}

      {/* 自由指示 */}
      <div>
        <label className="text-slate-600 block mb-1 font-medium">自由指示 (追加リクエスト)</label>
        <textarea
          value={userInstruction}
          onChange={(e) => setUserInstruction(e.target.value)}
          rows={2}
          placeholder="例: コスト削減を重視、フェイルセーフ機構の観点を強化など"
          className="w-full p-2 border border-slate-300 rounded resize-y focus:outline-blue-500"
        />
      </div>

      {/* 送信プレビューカード */}
      <RequestPreview
        payload={{
          task,
          focusNode,
          diagram: currentDiagram,
          levels: project.levels,
          userInstruction,
        }}
        modelId={project.aiPreferences.modelId}
      />

      {/* 実行 / キャンセルボタン */}
      <div className="flex gap-2 pt-1">
        {isRunning ? (
          <button
            onClick={handleCancel}
            className="w-full py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium flex items-center justify-center gap-1.5 shadow-sm transition-colors"
          >
            <Square className="w-4 h-4" />
            推論を中止
          </button>
        ) : (
          <button
            onClick={handleExecute}
            disabled={task !== 'review' && !focusNode}
            className="w-full py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 text-white rounded font-medium flex items-center justify-center gap-1.5 shadow-sm transition-all"
          >
            <Sparkles className="w-4 h-4" />
            {task === 'review' ? '図レビューを実行' : `${task === 'expand' ? '展開案' : '代替案'}を生成`}
          </button>
        )}
      </div>

      {/* ローディングスピナー */}
      {isRunning && (
        <div className="p-4 bg-purple-50/50 border border-purple-100 rounded-lg flex flex-col items-center justify-center gap-2 text-purple-700">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span className="font-medium text-xs">
            {project.aiPreferences.stream && streamChars > 0
              ? `ストリーミング受信中 (${streamChars} 文字)...`
              : 'Gateway経由で推論中...'}
          </span>
          <span className="text-[10px] text-purple-500">タイムアウト: {project.aiPreferences.timeoutSeconds}秒</span>
        </div>
      )}

      {/* エラーメッセージ */}
      {errorMessage && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs space-y-1">
          <div className="font-bold flex items-center gap-1">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            推論エラー
          </div>
          <p className="text-[11px] leading-relaxed break-words">{errorMessage}</p>
        </div>
      )}

      {/* Revision不整合警告 */}
      {isRevisionMismatched && (proposalResult || reviewResult) && (
        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-amber-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <span>推論開始後に図が編集されたため、整合性保護によりこの結果は適用できません。再生成してください。</span>
        </div>
      )}

      {/* 展開案・代替案 結果表示 */}
      {proposalResult && (
        <div className="space-y-3 pt-2 border-t border-slate-200">
          <div className="bg-slate-50 p-2.5 rounded border border-slate-200">
            <span className="font-bold text-slate-800 block mb-1">【提案要約】</span>
            <p className="text-[11px] text-slate-600 leading-relaxed">{proposalResult.summary}</p>
          </div>

          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-700">
              候補ノード一覧 ({selectedCandidates.size} / {proposalResult.nodes.length} 選択)
            </span>
            <button
              onClick={() => {
                if (selectedCandidates.size === proposalResult.nodes.length) {
                  setSelectedCandidates(new Set());
                } else {
                  setSelectedCandidates(new Set(proposalResult.nodes.map((n) => n.candidateId)));
                }
              }}
              className="text-blue-600 text-[11px] hover:underline"
            >
              {selectedCandidates.size === proposalResult.nodes.length ? '全解除' : '全選択'}
            </button>
          </div>

          <div className="space-y-2">
            {proposalResult.nodes.map((cand) => {
              const isChecked = selectedCandidates.has(cand.candidateId);
              const level = project.levels.find((l) => l.id === cand.levelId);

              return (
                <div
                  key={cand.candidateId}
                  onClick={() => handleToggleCandidate(cand.candidateId)}
                  className={`p-2.5 rounded border text-xs cursor-pointer transition-colors ${
                    isChecked ? 'border-blue-400 bg-blue-50/40' : 'border-slate-200 bg-white opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <button type="button" className="mt-0.5 text-blue-600">
                      {isChecked ? <CheckSquare className="w-4 h-4" /> : <SquareIcon className="w-4 h-4 text-slate-400" />}
                    </button>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          [{NODE_KIND_LABELS[cand.kind]}] {cand.label}
                        </span>
                        <span className="text-[10px] bg-slate-100 text-slate-500 px-1 rounded">
                          {level?.label || cand.levelId}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 leading-relaxed">{cand.description}</p>
                      {cand.rationale && (
                        <div className="text-[10px] text-slate-500 bg-slate-50 p-1 rounded border border-slate-100">
                          理由: {cand.rationale}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 採用ボタン */}
          <button
            onClick={handleAdopt}
            disabled={isRevisionMismatched || selectedCandidates.size === 0}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded font-medium flex items-center justify-center gap-1.5 shadow-sm transition-colors"
          >
            <Check className="w-4 h-4" />
            選択した候補を図へ採用 ({selectedCandidates.size}件)
          </button>
        </div>
      )}

      {/* レビュー結果表示 */}
      {reviewResult && (
        <div className="space-y-3 pt-2 border-t border-slate-200">
          <div className="bg-slate-50 p-2.5 rounded border border-slate-200">
            <span className="font-bold text-slate-800 block mb-1">【レビュー講評】</span>
            <p className="text-[11px] text-slate-600 leading-relaxed">{reviewResult.summary}</p>
          </div>

          <div className="font-bold text-slate-700">指摘事項 ({reviewResult.issues.length}件)</div>

          {reviewResult.issues.length === 0 ? (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-emerald-800 text-[11px] flex items-center gap-1.5">
              <Check className="w-4 h-4" />
              <span>特に指摘事項は見つかりませんでした。良好な設計です。</span>
            </div>
          ) : (
            <div className="space-y-2">
              {reviewResult.issues.map((issue, idx) => (
                <div
                  key={idx}
                  className={`p-2.5 rounded border text-xs space-y-1.5 ${
                    issue.severity === 'warning'
                      ? 'bg-amber-50/50 border-amber-200 text-amber-900'
                      : 'bg-blue-50/50 border-blue-200 text-blue-900'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className="flex items-center gap-1">
                      {issue.severity === 'warning' ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                      ) : (
                        <Info className="w-3.5 h-3.5 text-blue-600" />
                      )}
                      <span>分類: {issue.category}</span>
                    </span>
                    {issue.nodeIds.length > 0 && (
                      <button
                        onClick={() => dispatch({ type: 'SELECT_NODE', nodeId: issue.nodeIds[0] })}
                        className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5"
                      >
                        対象を選択
                        <ExternalLink className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed">{issue.message}</p>
                  <div className="bg-white/80 p-1.5 rounded border border-slate-100 text-[10px] text-slate-700">
                    <strong>推奨対応:</strong> {issue.recommendation}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
