import React from 'react';
import { Eye, ShieldAlert, Cpu, Globe } from 'lucide-react';
import { extractScopeElements, PromptPayload } from '../../services/llm/prompts';

interface RequestPreviewProps {
  payload: PromptPayload;
  modelId: string;
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

  // 概算文字数の算出
  const roughText =
    (payload.userInstruction?.length || 0) +
    scopedNodes.reduce((acc, n) => acc + n.label.length + (n.meta.description?.length || 0), 0) +
    scopedEdges.reduce((acc, e) => acc + (e.label?.length || 0), 0) +
    payload.levels.reduce((acc, l) => acc + l.label.length, 0);

  const isExceeded = scopedNodes.length > 200 || scopedEdges.length > 400 || roughText > 1000000;

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

      <div className="flex items-center justify-between text-[11px] bg-white p-2 rounded border border-slate-100 text-slate-600">
        <span>ノード: <strong className="text-slate-800">{scopedNodes.length}</strong> 件</span>
        <span>エッジ: <strong className="text-slate-800">{scopedEdges.length}</strong> 件</span>
        <span>概算文字数: <strong className="text-slate-800">{roughText.toLocaleString()}</strong> 字</span>
      </div>

      {isExceeded && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-[10px] flex items-center gap-1.5">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <span>送信上限（200ノード、400エッジ、1MB）を超過しています。対象範囲を絞り込んでください。</span>
        </div>
      )}
    </div>
  );
};
