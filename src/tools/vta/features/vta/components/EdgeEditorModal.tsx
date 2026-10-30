import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Edit3, X, ArrowRight, ArrowRightLeft, Scissors, Trash2, Check, Tag, Info } from 'lucide-react';
import { EdgeDirection, EdgeCategory } from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';

interface EdgeEditorModalProps {
  isOpen: boolean;
  edgeId: string | null;
  onClose: () => void;
}

const CATEGORY_OPTIONS: Array<{ value: EdgeCategory; label: string; desc: string }> = [
  { value: 'dependency', label: '作業依存', desc: '前提作業から、その成果・完了・状態を必要とする作業への関係' },
  { value: 'information', label: '情報・指示・連絡', desc: '無線交信、指示伝達、手順通達、報告、相互確認など' },
  { value: 'material', label: '物・機材・現品', desc: '部品支給、資材搬入、機材受渡しなど' },
  { value: 'person', label: '人・移動', desc: '作業員移動、担当交代、搭乗など' },
  { value: 'handover', label: '作業引継ぎ・交代', desc: 'シフト交代、工程完了引継ぎなど' },
  { value: 'impact', label: '物理的影響・波及', desc: '通電、過電圧印加、物理的連動、力学的影響など' },
  { value: 'sequential', label: '時系列・手順順序', desc: '同一主体における前手順から次手順への自然な進行' },
  { value: 'other', label: 'その他・未分類', desc: '特定の分類に依らない中立的な接続' },
];

export const EdgeEditorModal: React.FC<EdgeEditorModalProps> = ({
  isOpen,
  edgeId,
  onClose,
}) => {
  const { edges, vtaData, updateEdge, deleteEdge } = useVTAStore();

  const currentReactEdge = edges.find((e) => e.id === edgeId);
  const currentSchemaEdge = currentReactEdge
    ? vtaData.edges.find((e) => e.id ? e.id === currentReactEdge.id : e.source === currentReactEdge.source && e.target === currentReactEdge.target)
    : undefined;

  const srcNode = currentReactEdge ? vtaData.nodes.find((n) => n.id === currentReactEdge.source) : undefined;
  const tgtNode = currentReactEdge ? vtaData.nodes.find((n) => n.id === currentReactEdge.target) : undefined;

  const [label, setLabel] = useState<string>('');
  const [category, setCategory] = useState<EdgeCategory>('other');
  const [direction, setDirection] = useState<EdgeDirection>('unidirectional');
  const [meaning, setMeaning] = useState<NonNullable<import('../../../types/vta').VTAEdgeData['meaning']>>('association');
  const [status, setStatus] = useState<'occurred' | 'omitted' | 'unknown'>('unknown');
  const [receipt, setReceipt] = useState<'confirmed' | 'unconfirmed' | 'na'>('na');
  const [resource, setResource] = useState('');
  const [isBreak, setIsBreak] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen && currentReactEdge) {
      setLabel(currentSchemaEdge?.label || (currentReactEdge.data?.label as string) || '');
      setCategory((currentSchemaEdge?.category || (currentReactEdge.data?.category as EdgeCategory) || 'other'));
      setDirection((currentSchemaEdge?.direction || (currentReactEdge.data?.direction as EdgeDirection) || 'unidirectional'));
      setMeaning(currentSchemaEdge?.meaning ?? 'association');
      setStatus(currentSchemaEdge?.status ?? 'unknown'); setReceipt(currentSchemaEdge?.receipt ?? 'na'); setResource(currentSchemaEdge?.resource ?? '');
      setIsBreak(Boolean(currentSchemaEdge?.is_break ?? currentReactEdge.data?.is_break));
    }
  }, [isOpen, currentReactEdge, currentSchemaEdge]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !currentReactEdge || !edgeId) return null;

  const handleSave = () => {
    if(meaning==='dependency' && (srcNode?.lane===tgtNode?.lane || srcNode?.event_ids?.length!==1 || tgtNode?.event_ids?.length!==1 || srcNode.event_ids[0]===tgtNode.event_ids[0])) { useVTAStore.getState().showToast('warn','作業依存は別レーンの異なる単一イベント間に指定してください。'); return; }
    updateEdge(edgeId, {
      label: meaning==='dependency'?'作業依存':label.trim() || undefined,
      category: meaning==='dependency'?'dependency':category,
      direction: meaning === 'dependency' ? 'unidirectional' : status === 'omitted' || meaning === 'common' ? 'undirected' : meaning === 'mutual' ? 'bidirectional' : direction, meaning, status: meaning === 'dependency' ? undefined : status, receipt: meaning === 'dependency' ? 'na' : receipt, resource: meaning === 'dependency' ? undefined : resource,
      is_break: isBreak,
    });
    onClose();
  };

  const handleDelete = () => {
    if (window.confirm('この接続線（矢印）を削除しますか？')) {
      deleteEdge(edgeId);
      onClose();
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-slate-800/80 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-100 font-bold text-sm">
            <Edit3 className="w-4 h-4 text-cyan-400" />
            <span>接続線（エッジ）の編集</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-700/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Connected Nodes Context */}
          <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 space-y-2">
            <div className="text-[11px] text-slate-400 font-semibold flex items-center gap-1">
              <Info className="w-3.5 h-3.5 text-cyan-400" />
              <span>接続元と接続先</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-200">
              <div className="flex-1 bg-slate-800/80 px-2 py-1.5 rounded border border-slate-700 truncate">
                <span className="text-[10px] text-slate-400 block">{srcNode?.lane || 'レーン'}</span>
                <span className="font-medium truncate block">{srcNode?.title || currentReactEdge.source}</span>
              </div>
              <span className="text-cyan-400 font-bold">➔</span>
              <div className="flex-1 bg-slate-800/80 px-2 py-1.5 rounded border border-slate-700 truncate">
                <span className="text-[10px] text-slate-400 block">{tgtNode?.lane || 'レーン'}</span>
                <span className="font-medium truncate block">{tgtNode?.title || currentReactEdge.target}</span>
              </div>
            </div>
          </div>

          {/* Label Input */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-200 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-cyan-400" />
              <span>接続ラベル（具体的な伝達・事象名）</span>
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例: 指示復唱、誘導路指示、着陸許可発出、手順書受渡、過電圧印加"
              className="w-full bg-slate-950 border border-slate-700 focus:border-cyan-400 rounded-lg px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
            <p className="text-[10px] text-slate-400 leading-tight">
              ※図面上およびSVG出力、AI分析レポートに反映されます。
            </p>
          </div>

          {/* Category Dropdown */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-200">接続の分類</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as EdgeCategory)}
              className="w-full bg-slate-950 border border-slate-700 focus:border-cyan-400 rounded-lg px-3 py-2 text-slate-100 focus:outline-none cursor-pointer"
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-400 leading-tight">
              {CATEGORY_OPTIONS.find((c) => c.value === category)?.desc}
            </p>
          </div>

          {/* Direction Options */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-200">伝達方向</label>
            <button type="button" onClick={() => setDirection('undirected')} className="rounded border border-slate-600 p-2 text-slate-200">矢印なし（共通イベント）</button>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDirection('unidirectional')}
                className={`py-2 px-3 rounded-lg border flex items-center justify-center gap-1.5 font-medium transition-colors cursor-pointer ${
                  direction === 'unidirectional'
                    ? 'bg-cyan-950/80 border-cyan-500 text-cyan-200'
                    : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                <ArrowRight className="w-3.5 h-3.5" />
                <span>一方向（──▶）</span>
              </button>
              <button
                type="button"
                onClick={() => setDirection('bidirectional')}
                className={`py-2 px-3 rounded-lg border flex items-center justify-center gap-1.5 font-medium transition-colors cursor-pointer ${
                  direction === 'bidirectional'
                    ? 'bg-purple-950/80 border-purple-500 text-purple-200'
                    : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                <span>双方向・相互確認（◀──▶）</span>
              </button>
            </div>
          </div>

<label className="block text-slate-200">関係の意味<select value={meaning} onChange={(e) => setMeaning(e.target.value as typeof meaning)} className="bg-slate-800 p-2"><option value="association">同一イベント・未判定</option><option value="dependency">作業依存</option><option value="transfer">リソース移動</option><option value="mutual">相互確認</option><option value="common">外部事象の共通影響</option><option value="impact">影響</option></select></label>
          <label className="block text-slate-200">実施状態<select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="bg-slate-800 p-2"><option value="unknown">不明</option><option value="occurred">実施済み</option><option value="omitted">未実施</option></select></label>
          <label className="block text-slate-200">受領確認<select value={receipt} onChange={(e) => setReceipt(e.target.value as typeof receipt)} className="bg-slate-800 p-2"><option value="na">対象外</option><option value="unconfirmed">未確認</option><option value="confirmed">確認済み</option></select></label>
          <label className="block text-slate-200">リソース<select value={resource} onChange={(e) => setResource(e.target.value)} className="bg-slate-800 p-2"><option value="">未指定</option><option value="information">情報</option><option value="material">物</option><option value="person">人</option><option value="money">資金</option><option value="other">その他</option></select></label>
          {/* Break Barrier Checkbox */}
          <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Scissors className="w-3.5 h-3.5 text-rose-400" />
                <span>ブレイク対策（悪影響の遮断・防護壁）</span>
              </span>
              <p className="text-[10px] text-slate-400">
                この接続で連鎖を遮断（ダブルチェック・インターロック等）
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsBreak(!isBreak)}
              className={`px-3 py-1.5 rounded-lg border font-bold text-xs transition-colors cursor-pointer ${
                isBreak
                  ? 'bg-rose-950 text-rose-200 border-rose-500'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
              }`}
            >
              {isBreak ? 'BREAK 指定中 ✕' : '未設定'}
            </button>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 bg-slate-800/80 border-t border-slate-700 flex items-center justify-between">
          <button
            type="button"
            onClick={handleDelete}
            className="px-3 py-2 text-rose-400 hover:text-rose-300 hover:bg-rose-950/50 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>接続を削除</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold shadow-lg transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>保存する</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
