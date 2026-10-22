import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckSquare,
  ExternalLink,
  Info,
  RefreshCw,
  Sparkles,
  Square,
  Square as SquareIcon,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import {
  buildChatMessages,
  createPromptReferenceMaps,
  PromptPayload,
} from '../../services/llm/prompts';
import { gatewayClient } from '../../services/llm/gatewayClient';
import {
  extractAndParseAiJson,
  ProposalResponse,
  ReviewResponse,
  validateProposalResponse,
  validateReviewResponse,
} from '../../services/llm/aiSchemas';
import { adoptProposals, ProposalRunContext } from './proposalAdopter';
import { getRequestPreviewMetrics, RequestPreview } from './RequestPreview';
import { loadAppSettings } from '../../services/persistence/appStorage';
import { getModelMetadata } from '../settings/modelCatalog';
import { RequirementReportPanel } from './RequirementReportPanel';

interface ReviewRunContext {
  projectId: string;
  diagramId: string;
  revision: number;
}

export const AiPanel: React.FC = () => {
  const { state, dispatch } = useApp();
  const { present: project, revision: currentRevision } = state.history;
  const { activeDiagramId, selectedNodeId, gatewayToken } = state.ui;
  const currentDiagram =
    project.diagrams.find((diagram) => diagram.id === activeDiagramId) || project.diagrams[0];
  const focusNode = currentDiagram.nodes.find((node) => node.id === selectedNodeId);

  const [task, setTask] = useState<'expand' | 'alternatives' | 'review'>('expand');
  const [isReportMode, setIsReportMode] = useState(false);
  const [targetLevelId, setTargetLevelId] = useState(project.levels[0]?.id || '');
  const [userInstruction, setUserInstruction] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [streamChars, setStreamChars] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [proposalContext, setProposalContext] = useState<ProposalRunContext | null>(null);
  const [reviewContext, setReviewContext] = useState<ReviewRunContext | null>(null);
  const [proposalResult, setProposalResult] = useState<ProposalResponse | null>(null);
  const [reviewResult, setReviewResult] = useState<ReviewResponse | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());

  const getDefaultTargetLevelId = (
    nextTask: 'expand' | 'alternatives' | 'review',
    focusLevelId?: string
  ): string => {
    if (!focusLevelId) return project.levels[0]?.id || '';
    if (nextTask === 'alternatives') return focusLevelId;
    const focusIndex = project.levels.findIndex((level) => level.id === focusLevelId);
    return project.levels[focusIndex + 1]?.id || focusLevelId;
  };

  useEffect(() => {
    if (isRunning || proposalResult) return;
    if (task !== 'review') {
      setTargetLevelId(getDefaultTargetLevelId(task, focusNode?.levelId));
    }
    // タスクまたはフォーカスが変わった時だけ既定値へ戻す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, focusNode?.id, focusNode?.levelId, isRunning, proposalResult]);

  useEffect(() => {
    if (!project.levels.some((level) => level.id === targetLevelId)) {
      setTargetLevelId(getDefaultTargetLevelId(task, focusNode?.levelId));
    }
    // 定義削除後にだけ不正な選択を修復する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.levels, targetLevelId]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const clearResults = () => {
    setProposalResult(null);
    setReviewResult(null);
    setProposalContext(null);
    setReviewContext(null);
    setSelectedCandidates(new Set());
  };

  const handleTaskChange = (nextTask: 'expand' | 'alternatives' | 'review') => {
    if (isRunning || nextTask === task) return;
    clearResults();
    setErrorMessage(null);
    setTask(nextTask);
    if (nextTask !== 'review') {
      setTargetLevelId(getDefaultTargetLevelId(nextTask, focusNode?.levelId));
    }
  };

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

    const targetLevel = project.levels.find((level) => level.id === targetLevelId);
    if (task !== 'review' && !targetLevel) {
      setErrorMessage('配置先の列を選択してください。');
      return;
    }

    const executionTask = task;
    const executionDiagram = currentDiagram;
    const executionFocus = focusNode;
    const executionModelId = project.aiPreferences.modelId;
    const runContext: ProposalRunContext | null =
      executionTask !== 'review' && executionFocus && targetLevel
        ? {
            projectId: project.id,
            diagramId: executionDiagram.id,
            focusNodeId: executionFocus.id,
            targetLevelId: targetLevel.id,
            task: executionTask,
            revision: currentRevision,
            modelId: executionModelId,
          }
        : null;

    const payload: PromptPayload = {
      task: executionTask,
      focusNode: executionFocus,
      targetLevel,
      diagram: executionDiagram,
      levels: project.levels,
      nodeKinds: project.nodeKinds,
      userInstruction: userInstruction.trim() || undefined,
    };
    const messages = buildChatMessages(payload);
    const requestMetrics = getRequestPreviewMetrics(payload, messages);
    if (requestMetrics.isExceeded) {
      setErrorMessage(
        '送信上限（200ノード、400エッジ、1MB）を超えています。対象範囲または説明文を減らしてください。'
      );
      return;
    }

    setErrorMessage(null);
    clearResults();
    if (runContext) {
      setProposalContext(runContext);
    } else {
      setReviewContext({
        projectId: project.id,
        diagramId: executionDiagram.id,
        revision: currentRevision,
      });
    }
    setStreamChars(0);
    setIsRunning(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const references = createPromptReferenceMaps(project.nodeKinds, executionDiagram);
    const settings = loadAppSettings();

    try {
      const response = await gatewayClient.complete(
        {
          apiBaseUrl: settings.gatewayUrl,
          authEnabled: settings.gatewayAuthEnabled,
          token: gatewayToken,
        },
        {
          modelId: executionModelId,
          messages,
          temperature: project.aiPreferences.temperature,
          timeoutSeconds: project.aiPreferences.timeoutSeconds,
          stream: project.aiPreferences.stream,
          signal: controller.signal,
        },
        (chunk) => setStreamChars((previous) => previous + chunk.length)
      );

      const rawJson = extractAndParseAiJson(response.content);
      if (executionTask === 'review') {
        const validated = validateReviewResponse(rawJson, {
          nodeRefToId: references.nodeRefToId,
          edgeRefToId: references.edgeRefToId,
        });
        if (!validated.valid || !validated.data) {
          throw new Error(validated.error || 'レビュー出力の検証に失敗しました。');
        }
        setReviewResult(validated.data);
        setReviewContext({
          projectId: project.id,
          diagramId: executionDiagram.id,
          revision: currentRevision,
        });
      } else {
        const validated = validateProposalResponse(rawJson, {
          kindRefToId: references.kindRefToId,
        });
        if (!validated.valid || !validated.data || !runContext) {
          throw new Error(validated.error || '提案出力の検証に失敗しました。');
        }
        setProposalResult(validated.data);
        setProposalContext(runContext);
        setSelectedCandidates(
          new Set(validated.data.nodes.map((candidate) => candidate.candidateId))
        );
      }
    } catch (error: unknown) {
      setProposalContext(null);
      setReviewContext(null);
      if (error instanceof DOMException && error.name === 'AbortError') {
        setErrorMessage('リクエストはキャンセルされました。');
      } else {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsRunning(false);
      abortControllerRef.current = null;
    }
  };

  const handleToggleCandidate = (candidateId: string) => {
    const next = new Set(selectedCandidates);
    if (next.has(candidateId)) next.delete(candidateId);
    else next.add(candidateId);
    setSelectedCandidates(next);
  };

  const handleCandidateKindChange = (candidateId: string, kindId: string) => {
    setProposalResult((current) =>
      current
        ? {
            ...current,
            nodes: current.nodes.map((candidate) =>
              candidate.candidateId === candidateId ? { ...candidate, kindId } : candidate
            ),
          }
        : current
    );
  };

  const proposalMismatch = Boolean(
    proposalContext &&
      (proposalContext.projectId !== project.id ||
        proposalContext.revision !== currentRevision ||
        proposalContext.diagramId !== currentDiagram.id)
  );
  const reviewMismatch = Boolean(
    reviewContext &&
      (reviewContext.projectId !== project.id ||
        reviewContext.revision !== currentRevision ||
        reviewContext.diagramId !== currentDiagram.id)
  );
  const isResultMismatched = proposalResult ? proposalMismatch : reviewMismatch;
  const selectedUnresolvedCount = proposalResult
    ? proposalResult.nodes.filter(
        (candidate) =>
          selectedCandidates.has(candidate.candidateId) && candidate.kindId === null
      ).length
    : 0;

  const handleAdopt = () => {
    if (!proposalResult || !proposalContext) return;
    if (proposalMismatch) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `rev-mismatch-${Date.now()}`,
          type: 'warning',
          message: '推論開始後に対象または図が変更されたため採用できません。再度推論を実行してください。',
        },
      });
      return;
    }
    if (selectedCandidates.size === 0 || selectedUnresolvedCount > 0) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `select-candidate-${Date.now()}`,
          type: 'info',
          message:
            selectedCandidates.size === 0
              ? '採用する候補ノードを1件以上選択してください。'
              : '選択中の候補に未設定の内容種別があります。',
        },
      });
      return;
    }

    try {
      const result = adoptProposals(project, proposalContext, proposalResult, {
        selectedCandidateIds: selectedCandidates,
      });
      dispatch({ type: 'APPLY_PROJECT_UPDATE', project: result.project });
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `adopt-ok-${Date.now()}`,
          type: 'success',
          message: `${result.addedNodeCount}件の候補ノードと ${result.addedEdgeCount}件のエッジを採用しました。`,
        },
      });
      setProposalResult(null);
      setProposalContext(null);
    } catch (error) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `adopt-error-${Date.now()}`,
          type: 'error',
          message: error instanceof Error ? error.message : '候補の採用に失敗しました。',
        },
      });
    }
  };

  const currentModelMeta = getModelMetadata(project.aiPreferences.modelId);
  const selectedTargetLevel = project.levels.find((level) => level.id === targetLevelId);
  const resultTargetLevel = proposalContext
    ? project.levels.find((level) => level.id === proposalContext.targetLevelId)
    : undefined;
  const resultFocusNode = proposalContext
    ? project.diagrams
        .find((diagram) => diagram.id === proposalContext.diagramId)
        ?.nodes.find((node) => node.id === proposalContext.focusNodeId)
    : undefined;
  const showFrozenProposalContext = Boolean((isRunning || proposalResult) && proposalContext);
  const displayedFocusNode = showFrozenProposalContext ? resultFocusNode : focusNode;
  const displayedFocusKind = displayedFocusNode
    ? project.nodeKinds.find((kind) => kind.id === displayedFocusNode.kindId)
    : undefined;

  return (
    <>
    <div className={isReportMode ? 'hidden' : 'p-4 space-y-4 text-xs select-text overflow-y-auto max-h-full'}>
      <div className="bg-purple-50/70 border border-purple-200/80 p-2.5 rounded-lg flex items-center justify-between">
        <div>
          <span className="text-[10px] text-purple-600 block">推論モデル (左ペインで変更)</span>
          <strong
            className="text-purple-900 font-semibold truncate block max-w-[200px]"
            title={currentModelMeta.displayName}
          >
            {currentModelMeta.displayName}
          </strong>
        </div>
        <span className="font-mono text-[10px] text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">
          {project.aiPreferences.modelId.split('/')[0]}
        </span>
      </div>

      <div>
        <label className="text-slate-600 block mb-1 font-semibold">タスク選択</label>
        <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-lg">
          {(['expand', 'alternatives', 'review'] as const).map((item) => (
            <button
              key={item}
              onClick={() => handleTaskChange(item)}
              disabled={isRunning}
              className={`py-1.5 px-2 rounded text-xs font-medium transition-colors ${
                task === item
                  ? 'bg-white text-blue-600 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item === 'expand' ? '展開案' : item === 'alternatives' ? '代替案' : '図レビュー'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setIsReportMode(true)}
          disabled={isRunning}
          className="mt-2 w-full py-2 px-2 rounded-lg border border-purple-200 bg-purple-50 text-purple-800 hover:bg-purple-100 disabled:opacity-50 flex items-center justify-center gap-1.5 font-semibold"
        >
          <Sparkles className="w-3.5 h-3.5" />
          説明文生成（実験的）
        </button>
      </div>

      {task !== 'review' && (
        <>
          <div>
            <label className="text-slate-600 block mb-1 font-semibold">フォーカスノード (必須)</label>
            {displayedFocusNode ? (
              <div className="p-2 bg-slate-50 border border-slate-200 rounded flex items-center justify-between">
                <span className="truncate font-medium text-slate-800" title={displayedFocusNode.label}>
                  [{displayedFocusKind?.label || '未定義'}] {displayedFocusNode.label}
                </span>
                <span className="text-[10px] bg-slate-200 text-slate-600 px-1 rounded flex-shrink-0">
                  {showFrozenProposalContext ? '推論対象' : '選択中'}
                </span>
              </div>
            ) : (
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-amber-800 text-[11px] flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>図上のノードをクリックして選択してください。</span>
              </div>
            )}
          </div>

          <div>
            <label className="text-slate-600 block mb-1 font-semibold">
              配置列（図上の位置・設計段階）
            </label>
            <select
              value={targetLevelId}
              onChange={(event) => setTargetLevelId(event.target.value)}
              disabled={isRunning || Boolean(proposalResult)}
              className="w-full p-2 border border-slate-300 rounded bg-white focus:outline-blue-500"
            >
              {project.levels.map((level, index) => (
                <option key={level.id} value={level.id}>
                  {index + 1}. {level.label}
                </option>
              ))}
            </select>
            {selectedTargetLevel?.description && (
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                {selectedTargetLevel.description}
              </p>
            )}
          </div>
        </>
      )}

      <div>
        <label className="text-slate-600 block mb-1 font-medium">自由指示 (追加リクエスト)</label>
        <textarea
          value={userInstruction}
          onChange={(event) => setUserInstruction(event.target.value)}
          rows={2}
          placeholder="例: コスト削減を重視、フェイルセーフの観点を強化など"
          className="w-full p-2 border border-slate-300 rounded resize-y focus:outline-blue-500"
        />
      </div>

      <RequestPreview
        payload={{
          task,
          focusNode: showFrozenProposalContext ? resultFocusNode : focusNode,
          targetLevel:
            task === 'review'
              ? undefined
              : showFrozenProposalContext
                ? resultTargetLevel
                : selectedTargetLevel,
          diagram: currentDiagram,
          levels: project.levels,
          nodeKinds: project.nodeKinds,
          userInstruction,
        }}
        modelId={project.aiPreferences.modelId}
      />

      <div className="flex gap-2 pt-1">
        {isRunning ? (
          <button
            onClick={() => abortControllerRef.current?.abort()}
            className="w-full py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium flex items-center justify-center gap-1.5 shadow-sm"
          >
            <Square className="w-4 h-4" /> 推論を中止
          </button>
        ) : (
          <button
            onClick={handleExecute}
            disabled={task !== 'review' && (!focusNode || !selectedTargetLevel)}
            className="w-full py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 text-white rounded font-medium flex items-center justify-center gap-1.5 shadow-sm"
          >
            <Sparkles className="w-4 h-4" />
            {task === 'review' ? '図レビューを実行' : `${task === 'expand' ? '展開案' : '代替案'}を生成`}
          </button>
        )}
      </div>

      {isRunning && (
        <div className="p-4 bg-purple-50/50 border border-purple-100 rounded-lg flex flex-col items-center gap-2 text-purple-700">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span className="font-medium text-xs">
            {project.aiPreferences.stream && streamChars > 0
              ? `ストリーミング受信中 (${streamChars} 文字)...`
              : 'Gateway経由で推論中...'}
          </span>
          <span className="text-[10px] text-purple-500">
            タイムアウト: {project.aiPreferences.timeoutSeconds}秒
          </span>
        </div>
      )}

      {errorMessage && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs space-y-1">
          <div className="font-bold flex items-center gap-1">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> 推論エラー
          </div>
          <p className="text-[11px] leading-relaxed break-words">{errorMessage}</p>
        </div>
      )}

      {isResultMismatched && (proposalResult || reviewResult) && (
        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-amber-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <span>推論開始後に対象または図が変更されたため、この結果は適用できません。再生成してください。</span>
        </div>
      )}

      {proposalResult && (
        <div className="space-y-3 pt-2 border-t border-slate-200">
          <div className="bg-slate-50 p-2.5 rounded border border-slate-200">
            <span className="font-bold text-slate-800 block mb-1">【提案要約】</span>
            <p className="text-[11px] text-slate-600 leading-relaxed">{proposalResult.summary}</p>
            <p className="mt-1 text-[10px] text-slate-500">
              接続元: {resultFocusNode?.label || '不明'} / 配置先: {resultTargetLevel?.label || '不明'}
            </p>
          </div>

          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-700">
              候補ノード一覧 ({selectedCandidates.size} / {proposalResult.nodes.length} 選択)
            </span>
            <button
              onClick={() =>
                setSelectedCandidates(
                  selectedCandidates.size === proposalResult.nodes.length
                    ? new Set()
                    : new Set(proposalResult.nodes.map((candidate) => candidate.candidateId))
                )
              }
              className="text-blue-600 text-[11px] hover:underline"
            >
              {selectedCandidates.size === proposalResult.nodes.length ? '全解除' : '全選択'}
            </button>
          </div>

          <div className="space-y-2">
            {proposalResult.nodes.map((candidate) => {
              const isChecked = selectedCandidates.has(candidate.candidateId);
              return (
                <div
                  key={candidate.candidateId}
                  onClick={() => handleToggleCandidate(candidate.candidateId)}
                  className={`p-2.5 rounded border text-xs cursor-pointer transition-colors ${
                    isChecked
                      ? candidate.kindId
                        ? 'border-blue-400 bg-blue-50/40'
                        : 'border-amber-400 bg-amber-50/50'
                      : 'border-slate-200 bg-white opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <button type="button" className="mt-0.5 text-blue-600">
                      {isChecked ? (
                        <CheckSquare className="w-4 h-4" />
                      ) : (
                        <SquareIcon className="w-4 h-4 text-slate-400" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <span className="font-bold text-slate-800 block break-words">
                        {candidate.label}
                      </span>
                      <label className="block text-[10px] text-slate-500">
                        内容の種別（何を表すか）
                        <select
                          value={candidate.kindId || ''}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            handleCandidateKindChange(candidate.candidateId, event.target.value)
                          }
                          className={`mt-0.5 w-full p-1.5 rounded border bg-white ${
                            candidate.kindId ? 'border-slate-300' : 'border-amber-400 text-amber-800'
                          }`}
                        >
                          <option value="" disabled>
                            未設定（選択してください）
                          </option>
                          {project.nodeKinds.map((kind) => (
                            <option key={kind.id} value={kind.id}>
                              {kind.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!candidate.kindId && (
                        <p className="text-[10px] text-amber-700">
                          AIの種別参照「{candidate.kindRef || 'なし'}」を解決できませんでした。
                        </p>
                      )}
                      <p className="text-[11px] text-slate-600 leading-relaxed">
                        {candidate.description}
                      </p>
                      {candidate.rationale && (
                        <div className="text-[10px] text-slate-500 bg-slate-50 p-1 rounded border border-slate-100">
                          理由: {candidate.rationale}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            onClick={handleAdopt}
            disabled={proposalMismatch || selectedCandidates.size === 0 || selectedUnresolvedCount > 0}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded font-medium flex items-center justify-center gap-1.5 shadow-sm"
          >
            <Check className="w-4 h-4" /> 選択した候補を図へ採用 ({selectedCandidates.size}件)
          </button>
        </div>
      )}

      {reviewResult && (
        <div className="space-y-3 pt-2 border-t border-slate-200">
          <div className="bg-slate-50 p-2.5 rounded border border-slate-200">
            <span className="font-bold text-slate-800 block mb-1">【レビュー講評】</span>
            <p className="text-[11px] text-slate-600 leading-relaxed">{reviewResult.summary}</p>
          </div>
          <div className="font-bold text-slate-700">指摘事項 ({reviewResult.issues.length}件)</div>
          {reviewResult.issues.length === 0 ? (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-emerald-800 text-[11px] flex items-center gap-1.5">
              <Check className="w-4 h-4" /> 特に指摘事項は見つかりませんでした。
            </div>
          ) : (
            <div className="space-y-2">
              {reviewResult.issues.map((issue, index) => (
                <div
                  key={`${issue.category}-${index}`}
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
                      分類: {issue.category}
                    </span>
                    {issue.nodeIds.length > 0 && (
                      <button
                        onClick={() => dispatch({ type: 'SELECT_NODE', nodeId: issue.nodeIds[0] })}
                        className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5"
                      >
                        対象を選択 <ExternalLink className="w-2.5 h-2.5" />
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
    <div className={isReportMode ? 'h-full' : 'hidden'}>
        <RequirementReportPanel onBack={() => setIsReportMode(false)} />
    </div>
    </>
  );
};
