import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Copy, Download, RefreshCw, Sparkles, Square } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { collectRequirementScope } from '../../domain/requirementScope';
import { loadAppSettings } from '../../services/persistence/appStorage';
import { buildRequirementReportMessages } from '../../services/llm/prompts';
import { gatewayClient } from '../../services/llm/gatewayClient';
import {
  extractAndParseAiJson,
  RequirementReportResponse,
  validateRequirementReportResponse,
} from '../../services/llm/aiSchemas';
import { buildRequirementReportMarkdown } from '../../services/llm/requirementReportDocument';
import { getProviderCategory } from './RequestPreview';

const MAX_SCOPE_NODES = 200;
const MAX_SCOPE_EDGES = 400;
const MAX_REQUEST_BYTES = 1_000_000;

interface ReportResult {
  markdown: string;
  data: RequirementReportResponse;
  projectId: string;
  projectTitle: string;
  revision: number;
  rootNodeId: string;
  generatedAt: string;
  warnings: string[];
}

interface RequirementReportPanelProps {
  onBack: () => void;
}

export const RequirementReportPanel: React.FC<RequirementReportPanelProps> = ({ onBack }) => {
  const { state, dispatch } = useApp();
  const { present: project, revision } = state.history;
  const { gatewayToken, selectedNodeId } = state.ui;
  const latestProjectContextRef = useRef({ projectId: project.id, revision });
  latestProjectContextRef.current = { projectId: project.id, revision };
  const [rootNodeId, setRootNodeId] = useState(selectedNodeId || '');
  const [styleInstruction, setStyleInstruction] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const availableNodes = useMemo(
    () => project.diagrams.flatMap((diagram) =>
      diagram.nodes.map((node) => ({ node, diagram }))
    ),
    [project.diagrams]
  );
  const rootEntry = availableNodes.find(({ node }) => node.id === rootNodeId);
  const scope = useMemo(
    () => rootNodeId ? collectRequirementScope(project, rootNodeId) : null,
    [project, rootNodeId]
  );
  const messages = useMemo(
    () => scope ? buildRequirementReportMessages(scope, styleInstruction) : [],
    [scope, styleInstruction]
  );
  const requestBytes = useMemo(
    () => messages.length ? new TextEncoder().encode(JSON.stringify(messages)).byteLength : 0,
    [messages]
  );
  const scopeExceeded = Boolean(scope && (
    scope.nodes.length > MAX_SCOPE_NODES ||
    scope.edges.length > MAX_SCOPE_EDGES ||
    requestBytes > MAX_REQUEST_BYTES
  ));
  const currentModelId = project.aiPreferences.modelId;
  const provider = getProviderCategory(currentModelId);
  const resultIsStale = Boolean(result && (
    result.projectId !== project.id ||
    result.revision !== revision ||
    result.rootNodeId !== rootNodeId
  ));

  useEffect(() => () => abortControllerRef.current?.abort(), [project.id, revision]);
  useEffect(() => {
    if (rootNodeId && !availableNodes.some(({ node }) => node.id === rootNodeId)) {
      setRootNodeId('');
    }
  }, [availableNodes, rootNodeId]);

  const handleGenerate = async () => {
    if (isRunning || !scope || !rootEntry) return;
    if (scopeExceeded) {
      setErrorMessage('対象範囲が上限を超えています。より上位の要求を選ぶか、図を分けてください。');
      return;
    }

    setErrorMessage(null);
    setIsRunning(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const settings = loadAppSettings();

    try {
      const response = await gatewayClient.complete(
        {
          apiBaseUrl: settings.gatewayUrl,
          authEnabled: settings.gatewayAuthEnabled,
          token: gatewayToken,
        },
        {
          modelId: currentModelId,
          messages,
          temperature: project.aiPreferences.temperature,
          timeoutSeconds: project.aiPreferences.timeoutSeconds,
          stream: project.aiPreferences.stream,
          signal: controller.signal,
        }
      );
      const latestContext = latestProjectContextRef.current;
      if (latestContext.projectId !== project.id || latestContext.revision !== revision) {
        setErrorMessage('生成中に図またはプロジェクトが変更されたため、古い応答を破棄しました。');
        return;
      }

      const rawJson = extractAndParseAiJson(response.content);
      const validated = validateRequirementReportResponse(rawJson, {
        rootNodeRef: scope.rootNodeRef,
        nodeRefs: new Set(scope.nodes.map((node) => node.ref)),
        edgesByRef: new Map(scope.edges.map((edge) => [edge.ref, {
          kind: edge.kind,
          sourceNodeRef: edge.sourceNodeRef,
          targetNodeRef: edge.targetNodeRef,
        }])),
      });
      if (!validated.valid || !validated.data) {
        throw new Error(validated.error || '説明文を検証できませんでした。');
      }

      const generatedAt = new Date().toLocaleString('ja-JP');
      setResult({
        markdown: buildRequirementReportMarkdown(
          project.title,
          scope,
          validated.data,
          generatedAt,
          validated.warnings || []
        ),
        data: validated.data,
        projectId: project.id,
        projectTitle: project.title,
        revision,
        rootNodeId,
        generatedAt,
        warnings: validated.warnings || [],
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const latestContext = latestProjectContextRef.current;
        setErrorMessage(
          latestContext.projectId !== project.id || latestContext.revision !== revision
            ? '生成中に図またはプロジェクトが変更されたため、古い応答を破棄しました。'
            : '説明文生成を中止しました。'
        );
      } else {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsRunning(false);
      abortControllerRef.current = null;
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.markdown);
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `report-copy-${Date.now()}`,
          type: 'success',
          message: '説明文をクリップボードにコピーしました。',
        },
      });
    } catch {
      setErrorMessage('クリップボードへコピーできませんでした。Markdownを選択してコピーしてください。');
    }
  };

  const handleDownload = () => {
    if (!result) return;
    const safeProjectTitle = result.projectTitle.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'tpdd-report';
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeProjectTitle}-要求説明.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleBack = () => {
    abortControllerRef.current?.abort();
    onBack();
  };

  return (
    <div className="p-4 space-y-4 text-xs select-text overflow-y-auto max-h-full">
      <div className="flex items-center justify-between border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-1 text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> AI支援へ戻る
        </button>
        <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
          実験的
        </span>
      </div>

      <div>
        <h2 className="font-bold text-slate-800 text-sm">要求から実現までの説明文</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          選んだノードから、図に記録された分解線と詳細図をたどって報告書の草稿を生成します。
        </p>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[11px] leading-relaxed text-amber-900 flex gap-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>根拠参照を検証しますが、文章の解釈や設計の妥当性は保証しません。実装済み・試験済みとは断定せず、原図と照合してください。</span>
      </div>

      <div>
        <label htmlFor="requirement-report-root" className="text-slate-700 block mb-1 font-semibold">
          起点ノード（説明したい要求）
        </label>
        <select
          id="requirement-report-root"
          value={rootNodeId}
          onChange={(event) => {
            setRootNodeId(event.target.value);
            setErrorMessage(null);
          }}
          disabled={isRunning}
          className="w-full p-2 border border-slate-300 rounded bg-white"
        >
          <option value="">ノードを選択してください</option>
          {availableNodes.map(({ node, diagram }) => {
            const kind = project.nodeKinds.find((item) => item.id === node.kindId);
            return (
              <option key={node.id} value={node.id}>
                {diagram.title} / [{kind?.label || '未定義'}] {node.label}
              </option>
            );
          })}
        </select>
        {rootEntry && (
          <p className="mt-1 text-[10px] text-slate-500">
            起点: [{project.nodeKinds.find((kind) => kind.id === rootEntry.node.kindId)?.label || '未定義'}] {rootEntry.node.label}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="requirement-report-style" className="text-slate-700 block mb-1 font-medium">
          文体・想定読者（任意）
        </label>
        <textarea
          id="requirement-report-style"
          value={styleInstruction}
          onChange={(event) => setStyleInstruction(event.target.value.slice(0, 1000))}
          disabled={isRunning}
          rows={2}
          placeholder="例: 技術部門以外の管理職向け。事実を変えず、簡潔な報告書文体にする。"
          className="w-full p-2 border border-slate-300 rounded resize-y focus:outline-blue-500"
        />
        <p className="mt-1 text-[10px] text-slate-400">設計上の事実を追加する欄ではありません。</p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
        <div className="flex justify-between gap-2">
          <strong className="text-slate-700">送信範囲</strong>
          <span className={provider.isCloud ? 'text-amber-700' : 'text-emerald-700'}>
            {provider.label}
          </span>
        </div>
        {scope ? (
          <>
            <p className="text-slate-600">
              詳細図 {scope.diagrams.length}件・ノード {scope.nodes.length}件・エッジ {scope.edges.length}件・約 {Math.ceil(requestBytes / 1024)} KB
            </p>
            {scope.edges.every((edge) => edge.kind !== 'decomposition') && (
              <p className="text-amber-700">対象範囲に分解線がありません。説明可能な内容が限られる場合があります。</p>
            )}
            {scopeExceeded && (
              <p role="alert" className="text-red-700">送信上限（200ノード、400エッジ、1MB）を超えています。</p>
            )}
            <details className="text-[10px] text-slate-600">
              <summary className="cursor-pointer select-none">対象ノード・接続を確認</summary>
              <ul className="mt-1 space-y-1 pl-3 list-disc max-h-48 overflow-y-auto">
                {scope.diagrams.map((diagram) => (
                  <li key={diagram.ref}>
                    {diagram.ref}: 図「{diagram.title}」{diagram.ownerNodeRef ? `（${diagram.ownerNodeRef}の詳細図）` : '（起点図）'}
                  </li>
                ))}
                {scope.nodes.map((node) => (
                  <li key={node.ref}>
                    {node.ref}: [{scope.nodeKinds.find((kind) => kind.ref === node.kindRef)?.label}] {node.label}
                    （図 {node.diagramRef}、列 {scope.levels.find((level) => level.ref === node.levelRef)?.label}、状態 {node.status}）
                    {node.description ? ` — ${node.description}` : ''}
                  </li>
                ))}
                {scope.edges.map((edge) => (
                  <li key={edge.ref}>
                    {edge.ref}: {edge.sourceNodeRef} → {edge.targetNodeRef} ({edge.kind}){edge.label ? `: ${edge.label}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p className="text-slate-500">対象ノードを選択すると、送信範囲を表示します。</p>
        )}
      </div>

      <div className="flex gap-2">
        {isRunning ? (
          <button
            type="button"
            onClick={() => abortControllerRef.current?.abort()}
            className="w-full py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium flex items-center justify-center gap-1.5"
          >
            <Square className="w-4 h-4" /> 生成を中止
          </button>
        ) : (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!scope || !rootEntry || scopeExceeded}
            className="w-full py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 text-white rounded font-medium flex items-center justify-center gap-1.5"
          >
            <Sparkles className="w-4 h-4" /> 説明文を生成
          </button>
        )}
      </div>

      {isRunning && (
        <div className="p-3 bg-purple-50 border border-purple-100 rounded-lg flex items-center justify-center gap-2 text-purple-700">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>AIが根拠付きの説明文を作成しています…</span>
        </div>
      )}

      {errorMessage && (
        <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-[11px] break-words">
          <strong className="block mb-1">説明文生成エラー</strong>{errorMessage}
        </div>
      )}

      {result && (
        <div className="space-y-2 pt-2 border-t border-slate-200">
          {resultIsStale && (
            <div role="status" className="p-2 bg-amber-50 border border-amber-200 rounded text-amber-800 text-[11px]">
              起点ノード・図・プロジェクトが生成時から変わりました。この草稿は変更前の内容に基づいています。再生成を推奨します。
            </div>
          )}
          {result.warnings.map((warning, index) => (
            <div key={`${index}-${warning}`} className="p-2 bg-amber-50 border border-amber-200 rounded text-amber-800 text-[11px]">
              {warning}
            </div>
          ))}
          <div className="flex items-center justify-between">
            <strong className="text-slate-700">生成された説明文（編集可能）</strong>
            <span className="text-[10px] text-slate-400">{result.generatedAt}</span>
          </div>
          <textarea
            value={result.markdown}
            onChange={(event) => setResult({ ...result, markdown: event.target.value })}
            rows={18}
            className="w-full p-2.5 border border-slate-300 rounded bg-white text-[11px] leading-relaxed font-mono resize-y"
            aria-label="生成された説明文。編集してコピーまたは保存できます。"
          />
          <div className="flex gap-2">
            <button type="button" onClick={handleCopy} className="flex-1 py-1.5 border border-slate-300 rounded text-slate-700 hover:bg-slate-50 flex items-center justify-center gap-1">
              <Copy className="w-3.5 h-3.5" /> コピー
            </button>
            <button type="button" onClick={handleDownload} className="flex-1 py-1.5 bg-slate-700 hover:bg-slate-800 rounded text-white flex items-center justify-center gap-1">
              <Download className="w-3.5 h-3.5" /> Markdown保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
