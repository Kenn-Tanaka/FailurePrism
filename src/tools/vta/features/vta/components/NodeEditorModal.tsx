import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PlusCircle, Edit3, X, Users, Clock, AlertTriangle, Activity, ShieldCheck, Check } from 'lucide-react';
import { VTANodeData, VTANodeType, MeasureType } from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';

interface NodeEditorModalProps {
  isOpen: boolean;
  initialData?: VTANodeData | null;
  onClose: () => void;
}

export const NodeEditorModal: React.FC<NodeEditorModalProps> = ({
  isOpen,
  initialData,
  onClose,
}) => {
  const { vtaData, addNode, updateNode } = useVTAStore();
  const existingLanes = vtaData.lanes.length > 0 ? vtaData.lanes : ['主要部門'];

  const isEditing = Boolean(initialData);

  const [lane, setLane] = useState<string>('');
  const [customLane, setCustomLane] = useState<string>('');
  const [isCustomLane, setIsCustomLane] = useState<boolean>(false);
  const [time, setTime] = useState<string>('');
  const [type, setType] = useState<VTANodeType>('normal');
  const [measureType, setMeasureType] = useState<MeasureType>(null);
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [supplementaryNote, setSupplementaryNote] = useState<string>('');
  const [connectFromNodeId, setConnectFromNodeId] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setLane(initialData.lane);
        setIsCustomLane(!existingLanes.includes(initialData.lane));
        setCustomLane(existingLanes.includes(initialData.lane) ? '' : initialData.lane);
        setTime(initialData.time || '');
        setType(initialData.type);
        setMeasureType(initialData.measure_type);
        setTitle(initialData.title);
        setDescription(initialData.description || '');
        setSupplementaryNote(initialData.supplementary_note || '');
        setConnectFromNodeId('');
      } else {
        const defaultLane = existingLanes[0] || '現場作業員';
        setLane(defaultLane);
        setIsCustomLane(false);
        setCustomLane('');
        setTime('');
        setType('normal');
        setMeasureType(null);
        setTitle('');
        setDescription('');
        setSupplementaryNote('');
        setConnectFromNodeId('');
      }
    }
  }, [isOpen, initialData, existingLanes]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalLane = isCustomLane && customLane.trim() ? customLane.trim() : lane || '主要部門';
    const finalTitle = title.trim() || '無題のカード';

    if (isEditing && initialData) {
      updateNode(initialData.id, {
        lane: finalLane,
        time: time.trim(),
        type,
        measure_type: measureType,
        title: finalTitle,
        description: description.trim(),
        supplementary_note: supplementaryNote.trim(),
      });
    } else {
      addNode(
        {
          lane: finalLane,
          time: time.trim(),
          type,
          measure_type: measureType,
          title: finalTitle,
          description: description.trim(),
          supplementary_note: supplementaryNote.trim(),
        },
        connectFromNodeId ? connectFromNodeId : undefined
      );
    }
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-editor-modal-title"
        className="bg-slate-900 border border-slate-700/90 rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-cyan-950/80 border border-cyan-800 text-cyan-400">
              {isEditing ? <Edit3 className="w-4 h-4" /> : <PlusCircle className="w-4 h-4" />}
            </div>
            <div>
              <h3 id="node-editor-modal-title" className="font-bold text-sm text-slate-100">
                {isEditing ? 'カード（ノード）の編集' : '新しいカード（ノード）を追加'}
              </h3>
              <p className="text-[11px] text-slate-400">
                {isEditing ? 'カードの内容・レーン・対策種別を変更します' : 'VTA図上に新しい作業・変動要因カードを配置します'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          {/* Lane Selection */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-200 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-cyan-400" />
              <span>所属スイムレーン（当事者・部門）</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={isCustomLane ? '__custom__' : lane}
                onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setIsCustomLane(true);
                  } else {
                    setIsCustomLane(false);
                    setLane(e.target.value);
                  }
                }}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                {existingLanes.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
                <option value="__custom__">＋ 新しいレーン名を作成...</option>
              </select>

              {isCustomLane && (
                <input
                  type="text"
                  placeholder="新しいレーン名を入力..."
                  value={customLane}
                  onChange={(e) => setCustomLane(e.target.value)}
                  className="w-full bg-slate-950 border border-cyan-500/80 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                  autoFocus
                />
              )}
            </div>
          </div>

          {/* Node Type & Measure Type Selection */}
          <div className="grid grid-cols-2 gap-3">
            {/* Type */}
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-200">ノード種別</label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setType('normal')}
                  className={`p-2 rounded-lg border text-center font-medium transition-all ${
                    type === 'normal'
                      ? 'bg-slate-800 border-slate-500 text-white ring-1 ring-slate-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Activity className="w-3.5 h-3.5 mx-auto mb-1 text-slate-400" />
                  <span>通常作業 (細枠)</span>
                </button>

                <button
                  type="button"
                  onClick={() => setType('variation')}
                  className={`p-2 rounded-lg border text-center font-medium transition-all ${
                    type === 'variation'
                      ? 'bg-amber-950/60 border-amber-500 text-amber-200 ring-1 ring-amber-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5 mx-auto mb-1 text-amber-400" />
                  <span>変動要因 (太枠)</span>
                </button>
              </div>
            </div>

            {/* Measure (Elimination) */}
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-200">対策指定（排除ノード）</label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setMeasureType(null)}
                  className={`p-2 rounded-lg border text-center font-medium transition-all ${
                    measureType === null
                      ? 'bg-slate-800 border-slate-600 text-slate-200 ring-1 ring-slate-500'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="block text-xs mb-1">✕</span>
                  <span>対策なし</span>
                </button>

                <button
                  type="button"
                  onClick={() => setMeasureType('elimination')}
                  className={`p-2 rounded-lg border text-center font-medium transition-all ${
                    measureType === 'elimination'
                      ? 'bg-emerald-950/70 border-emerald-500 text-emerald-200 ring-1 ring-emerald-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="inline-block w-4 h-4 rounded-full bg-emerald-500 text-white text-[10px] font-bold mx-auto mb-0.5">
                    ○
                  </span>
                  <span>○ 排除ノード</span>
                </button>
              </div>
            </div>
          </div>

          {/* Time & Title */}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5 col-span-1">
              <label className="font-semibold text-slate-200 flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-400" />
                <span>時間 / 順序</span>
              </label>
              <input
                type="text"
                placeholder="例: 10:05, ステップ2"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="space-y-1.5 col-span-2">
              <label className="font-semibold text-slate-200">カードタイトル <span className="text-rose-400">*</span></label>
              <input
                type="text"
                required
                placeholder="例: 手順書確認の省略"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-200">詳細説明（任意）</label>
            <textarea
              rows={2}
              placeholder="作業や変動要因の具体的な内容を記入..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 resize-none leading-relaxed"
            />
          </div>

          {/* Supplementary Note (Background / Human Factors) */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-200 flex items-center justify-between">
              <span>補足説明・背景要因（ヒューマンファクタ・設備状況）</span>
              <span className="text-[10px] text-cyan-400 font-normal">再生成時に考慮されます</span>
            </label>
            <textarea
              rows={2}
              placeholder="発生の背景にある心理的要因、思い込み、手順の形骸化、設備インターフェース課題などを記入..."
              value={supplementaryNote}
              onChange={(e) => setSupplementaryNote(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 resize-none leading-relaxed text-xs"
            />
          </div>

          {/* Optional Preceding Node Connection (Only when creating new node) */}
          {!isEditing && vtaData.nodes.length > 0 && (
            <div className="space-y-1.5 pt-1 border-t border-slate-800">
              <label className="font-semibold text-slate-300 flex items-center gap-1.5">
                <span>前段ノードとの接続（任意）</span>
                <span className="text-[10px] text-slate-500 font-normal">
                  （選択したノードからこのノードへ矢印を接続します）
                </span>
              </label>
              <select
                value={connectFromNodeId}
                onChange={(e) => setConnectFromNodeId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-300 focus:outline-none focus:border-cyan-500 text-xs"
              >
                <option value="">接続しない（後でドラッグ接続）</option>
                {vtaData.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    [{n.lane}] {n.title} ({n.type === 'variation' ? '変動要因' : '通常作業'})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Footer Buttons */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors cursor-pointer shadow-md shadow-cyan-900/30"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{isEditing ? '変更を保存' : 'カードを追加'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
