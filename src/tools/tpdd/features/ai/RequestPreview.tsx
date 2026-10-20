import React from 'react';
import { Eye, ShieldAlert, Cpu, Globe } from 'lucide-react';
import {
  buildChatMessages,
  extractScopeElements,
  PromptPayload,
} from '../../services/llm/prompts';
import { LlmChatMessage } from '../../services/llm/types';

interface RequestPreviewProps {
  payload: PromptPayload;
  modelId: string;
}

export interface RequestPreviewMetrics {
  nodeCount: number;
  edgeCount: number;
  requestByteLength: number;
  isExceeded: boolean;
}

const MAX_SCOPE_NODES = 200;
const MAX_SCOPE_EDGES = 400;
const MAX_REQUEST_BYTES = 1_000_000;

function getMessageBytes(messages: LlmChatMessage[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
}

export function getRequestPreviewMetrics(
  payload: PromptPayload,
  messages: LlmChatMessage[] = buildChatMessages(payload)
): RequestPreviewMetrics {
  const isReview = payload.task === 'review';
  const { nodes, edges } = extractScopeElements(
    payload.diagram,
    payload.focusNode?.id,
    isReview
  );
  const requestByteLength = getMessageBytes(messages);

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    requestByteLength,
    isExceeded:
      nodes.length > MAX_SCOPE_NODES ||
      edges.length > MAX_SCOPE_EDGES ||
      requestByteLength > MAX_REQUEST_BYTES,
  };
}

/**
 * モデルIDから送信先区分（ローカル/リモート/クラウド/不明）を推定
 */
export function getProviderCategory(modelId: string): { label: string; isCloud: boolean } {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('lmstudio/') || lower.startsWith('ollama/')) {
    return { label: 'ローカル (PC内)', isCloud: false };
  }
  if (lower.startsWith('lmstudio_remote/')) {
    return { label: 'リモート (LAN / Tailscale)', isCloud: false };
  }
  if (lower.startsWith('openrouter/') || lower.startsWith('openai/') || lower.startsWith('anthropic/')) {
    return { label: 'クラウド (外部API)', isCloud: true };
  }
  return { label: '不明 (Gateway設定依存)', isCloud: false };
}

export const RequestPreview: React.FC<RequestPreviewProps> = ({ payload, modelId }) => {
  const isReview = payload.task === 'review';
  const { nodes: scopedNodes, edges: scopedEdges } = extractScopeElements(
    payload.diagram,
    payload.focusNode?.id,
    isReview
  );

  const provider = getProviderCategory(modelId);

  const metrics = getRequestPreviewMetrics(payload);

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between text-slate-700 font-semibold border-b border-slate-200 pb-1.5">
        <span className="flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5 text-blue-600" />
          送信プレビュー
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 ${
            provider.isCloud ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
          }`}
        >
          {provider.isCloud ? <Globe className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
          {provider.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
        <div>
          <span className="text-slate-400 block">対象図:</span>
          <strong className="text-slate-800 truncate block">{payload.diagram.title}</strong>
        </div>
        <div>
          <span className="text-slate-400 block">タスク:</span>
          <span className="font-medium text-slate-800">
            {payload.task === 'expand' ? '展開案 (1-hop)' : payload.task === 'alternatives' ? '代替案 (1-hop)' : '図レビュー (全体)'}
          </span>
        </div>
      </div>

      {!isReview && payload.targetLevel && (
        <div className="text-[11px] bg-white p-2 rounded border border-slate-100 text-slate-600">
          <span className="text-slate-400 block">配置列（図上の位置・設計段階）:</span>
          <strong className="text-slate-800 block">{payload.targetLevel.label}</strong>
          {payload.targetLevel.description && (
            <span className="text-[10px] text-slate-500 leading-relaxed">
              {payload.targetLevel.description}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] bg-white p-2 rounded border border-slate-100 text-slate-600">
        <span>ノード: <strong className="text-slate-800">{scopedNodes.length}</strong> 件</span>
        <span>エッジ: <strong className="text-slate-800">{scopedEdges.length}</strong> 件</span>
        <span>送信サイズ: <strong className="text-slate-800">{Math.ceil(metrics.requestByteLength / 1024).toLocaleString()}</strong> KB</span>
      </div>

      {metrics.isExceeded && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-[10px] flex items-center gap-1.5">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <span>送信上限（200ノード、400エッジ、1MB）を超過しています。対象範囲を絞り込んでください。</span>
        </div>
      )}
    </div>
  );
};
