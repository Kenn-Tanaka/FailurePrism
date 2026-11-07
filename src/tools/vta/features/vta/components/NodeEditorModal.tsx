import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PlusCircle, Edit3, X, Users, Clock, AlertTriangle, AlertOctagon, CheckCircle2, Activity, ShieldCheck, Check } from 'lucide-react';
import { VTANodeData, VTANodeType, MeasureType, VTAOutcomeKind, VariationCategory, CognitiveBehaviorLevel, VariationPolarity, VTANodeEntityRole, VTAObjectDisplayStyle } from '../../../types/vta';
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
  const isGrouped = (initialData?.event_ids?.length ?? 0) > 1;

  const [lane, setLane] = useState<string>('');
  const [customLane, setCustomLane] = useState<string>('');
  const [isCustomLane, setIsCustomLane] = useState<boolean>(false);
  const [time, setTime] = useState<string>('');
  const [type, setType] = useState<VTANodeType>('normal');
  const [outcomeKind, setOutcomeKind] = useState<VTAOutcomeKind>('loss');
  const [variationCategory, setVariationCategory] = useState<VariationCategory>('response');
  const [cognitiveLevel, setCognitiveLevel] = useState<CognitiveBehaviorLevel>('rule');
  const [variationPolarity, setVariationPolarity] = useState<VariationPolarity>('negative');
  const [variationDescription, setVariationDescription] = useState<string>('');
  const [measureType, setMeasureType] = useState<MeasureType>(null);
  const [isHidden, setIsHidden] = useState(false);
  const [entityRole, setEntityRole] = useState<VTANodeEntityRole>('subject');
  const [objectDisplayStyle, setObjectDisplayStyle] = useState<VTAObjectDisplayStyle>('dot');
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
        setOutcomeKind(initialData.outcome_kind || 'loss');
        if (initialData.variation_factor) {
          setVariationCategory(initialData.variation_factor.category);
          setVariationPolarity(initialData.variation_factor.polarity);
          setCognitiveLevel(initialData.variation_factor.cognitiveLevel || 'rule');
          setVariationDescription(initialData.variation_factor.description || '');
        } else {
          setVariationCategory('response');
          setVariationPolarity('negative');
          setCognitiveLevel('rule');
          setVariationDescription('');
        }
        setMeasureType(initialData.measure_type);
        setIsHidden(Boolean(initialData.is_hidden));
        setEntityRole(initialData.entity_role || 'subject');
        setObjectDisplayStyle(initialData.object_display_style || 'dot');
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
        setOutcomeKind('loss');
        setVariationCategory('response');
        setVariationPolarity('negative');
        setCognitiveLevel('rule');
        setVariationDescription('');
        setMeasureType(null);
        setIsHidden(false);
        setEntityRole('subject');
        setObjectDisplayStyle('dot');
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
    const finalVariationFactor = type === 'variation' ? {
      category: variationCategory,
      polarity: variationPolarity,
      ...(variationCategory === 'response' ? { cognitiveLevel } : {}),
      ...(variationDescription.trim() ? { description: variationDescription.trim() } : {}),
    } : undefined;

    if (isEditing && initialData) {
      updateNode(initialData.id, {
        lane: finalLane,
        ...(!isGrouped ? {
          time: time.trim(),
          type,
          outcome_kind: type === 'outcome' ? outcomeKind : undefined,
          variation_factor: finalVariationFactor,
          entity_role: entityRole,
          object_display_style: entityRole === 'object' ? objectDisplayStyle : undefined,
          title: finalTitle,
          description: description.trim(),
        } : {}),
        measure_type: measureType,
        is_hidden: isHidden,
        supplementary_note: supplementaryNote.trim(),
      });
    } else {
      addNode(
        {
          lane: finalLane,
          time: time.trim(),
          type,
          outcome_kind: type === 'outcome' ? outcomeKind : undefined,
          variation_factor: finalVariationFactor,
          entity_role: entityRole,
          object_display_style: entityRole === 'object' ? objectDisplayStyle : undefined,
          measure_type: measureType,
          is_hidden: isHidden,
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
                {isGrouped ? '複数イベントの見出し・本文は「イベント・主体の割当」から個別に編集します' : isEditing ? 'カードの内容・レーン・対策種別を変更します' : 'VTA図上に新しい作業・変動要因カードを配置します'}
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
          <label className="flex items-start gap-2 p-3 rounded-lg border border-slate-700 bg-slate-950 cursor-pointer">
            <input type="checkbox" checked={isHidden} onChange={(e) => setIsHidden(e.target.checked)} className="mt-0.5" />
            <span><strong>図上では接続点として表示（カードを非表示）</strong>
              <span className="block text-slate-400 mt-1">接続線と内容は保持します。説明欄の「再表示」からカードに戻せます。</span>
            </span>
          </label>
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
              <div className="grid grid-cols-3 gap-1">
                {(type === 'unclassified' || type === 'undetermined') && (
                  <div className="col-span-3 rounded border border-amber-700/70 bg-amber-950/40 p-1.5 text-[10px] text-amber-200">
                    {type === 'unclassified' ? '未判定' : '判定保留'}。判定を選択してください。
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setType('normal')}
                  disabled={isGrouped}
                  className={`p-1.5 rounded-lg border text-center font-medium transition-all text-[11px] ${
                    type === 'normal'
                      ? 'bg-slate-800 border-slate-500 text-white ring-1 ring-slate-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Activity className="w-3.5 h-3.5 mx-auto mb-0.5 text-slate-400" />
                  <span>通常(細枠)</span>
                </button>

                <button
                  type="button"
                  onClick={() => setType('variation')}
                  disabled={isGrouped}
                  className={`p-1.5 rounded-lg border text-center font-medium transition-all text-[11px] ${
                    type === 'variation'
                      ? 'bg-amber-950/60 border-amber-500 text-amber-200 ring-1 ring-amber-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5 mx-auto mb-0.5 text-amber-400" />
                  <span>変動(太枠)</span>
                </button>

                <button
                  type="button"
                  onClick={() => setType('outcome')}
                  disabled={isGrouped}
                  className={`p-1.5 rounded-lg border text-center font-medium transition-all text-[11px] ${
                    type === 'outcome'
                      ? 'bg-rose-950/60 border-rose-500 text-rose-200 ring-1 ring-rose-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <AlertOctagon className="w-3.5 h-3.5 mx-auto mb-0.5 text-rose-400" />
                  <span>帰結ノード</span>
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

          {/* 作用役割（主体 / 客体）の選択 */}
          <div className="p-3 rounded-lg border border-slate-700 bg-slate-950/60 space-y-2">
            <label className="font-semibold text-slate-200 flex items-center justify-between text-xs">
              <span>レーン間における作用役割</span>
              <span className="text-[10px] text-slate-400 font-normal">能動的な行動か、受動的な影響・受領か</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setEntityRole('subject')}
                className={`p-2 rounded-lg border text-left transition-all ${
                  entityRole === 'subject'
                    ? 'bg-cyan-950/80 border-cyan-500 text-cyan-200 ring-1 ring-cyan-400'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="font-bold text-xs flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-cyan-400" />
                  <span>作用主体 (能動行動)</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">指示・操作・発信など自らの行為（通常カード）</div>
              </button>
              <button
                type="button"
                onClick={() => setEntityRole('object')}
                className={`p-2 rounded-lg border text-left transition-all ${
                  entityRole === 'object'
                    ? 'bg-cyan-950/80 border-cyan-500 text-cyan-200 ring-1 ring-cyan-400'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="font-bold text-xs flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full border-2 border-cyan-400 bg-cyan-900" />
                  <span>受動客体 (被作用・受領)</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">他者からの指示受領・外乱影響など</div>
              </button>
            </div>

            {entityRole === 'object' && (
              <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-[11px]">
                <span className="text-slate-300 font-medium">客体ノードの表示形式:</span>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1 cursor-pointer text-slate-300">
                    <input
                      type="radio"
                      name="objectDisplayStyle"
                      value="dot"
                      checked={objectDisplayStyle === 'dot'}
                      onChange={() => setObjectDisplayStyle('dot')}
                      className="text-cyan-500"
                    />
                    <span>● ドット（推奨）</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer text-slate-300">
                    <input
                      type="radio"
                      name="objectDisplayStyle"
                      value="card"
                      checked={objectDisplayStyle === 'card'}
                      onChange={() => setObjectDisplayStyle('card')}
                      className="text-cyan-500"
                    />
                    <span>🗂 通常カード</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Outcome Kind Selector (Visible only when type === 'outcome') */}
          {type === 'outcome' && (
            <div className="p-3 rounded-lg border border-rose-800/60 bg-rose-950/30 space-y-2">
              <label className="font-semibold text-rose-200 flex items-center gap-1.5 text-xs">
                <AlertOctagon className="w-3.5 h-3.5 text-rose-400" />
                <span>帰結の種類（事故・インシデントの終局状態・表示色）</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setOutcomeKind('loss')}
                  className={`p-2 rounded-lg border text-left transition-all ${
                    outcomeKind === 'loss'
                      ? 'bg-rose-900/60 border-rose-500 text-rose-100 ring-1 ring-rose-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="font-bold text-[11px] text-rose-300">損失発生 (loss)</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">物的破損・負傷・重大損失（濃赤）</div>
                </button>
                <button
                  type="button"
                  onClick={() => setOutcomeKind('near_miss')}
                  className={`p-2 rounded-lg border text-left transition-all ${
                    outcomeKind === 'near_miss'
                      ? 'bg-amber-900/60 border-amber-500 text-amber-100 ring-1 ring-amber-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="font-bold text-[11px] text-amber-300">直前停止 (near_miss)</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">直前で防護・停止（琥珀色）</div>
                </button>
                <button
                  type="button"
                  onClick={() => setOutcomeKind('recovery')}
                  className={`p-2 rounded-lg border text-left transition-all ${
                    outcomeKind === 'recovery'
                      ? 'bg-emerald-900/60 border-emerald-500 text-emerald-100 ring-1 ring-emerald-400'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="font-bold text-[11px] text-emerald-300">正常復帰 (recovery)</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">レジリエンス回復（エメラルド）</div>
                </button>
              </div>
            </div>
          )}

          {/* Refined Variation Factor Selector (Visible only when type === 'variation') */}
          {type === 'variation' && (
            <div className="p-3 rounded-lg border border-amber-700/60 bg-amber-950/20 space-y-2.5">
              <label className="font-semibold text-amber-200 flex items-center justify-between text-xs">
                <span>変動要因の分類・極性（精緻化判定）</span>
                <span className="text-[10px] text-amber-400 font-normal">先行応答・内部・逸脱・外部 ＆ レジリエンス</span>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="block text-[11px] text-slate-300 mb-1 font-medium">分類カテゴリ</span>
                  <select
                    value={variationCategory}
                    onChange={(e) => setVariationCategory(e.target.value as VariationCategory)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                  >
                    <option value="response">先行変動への応答 (SRK)</option>
                    <option value="internal">内部要因 (装置・部品故障、ソフト異常、急病等)</option>
                    <option value="departure">人為的行為による通常逸脱 (過失・故意)</option>
                    <option value="external">外部要因 (天候・外乱・外部インフラ等)</option>
                  </select>
                </div>

                <div>
                  <span className="block text-[11px] text-slate-300 mb-1 font-medium">変動の極性 (Safety-II観点)</span>
                  <select
                    value={variationPolarity}
                    onChange={(e) => setVariationPolarity(e.target.value as VariationPolarity)}
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-cyan-500"
                  >
                    <option value="negative">負の変動 (不具合・エラー・事故進展)</option>
                    <option value="resilient">正の変動 (レジリエンス・リカバリー要因)</option>
                  </select>
                </div>
              </div>

              {variationCategory === 'response' && (
                <div className="pt-1.5 border-t border-amber-800/40">
                  <span className="block text-[11px] text-slate-300 mb-1 font-medium">応答行動レベル (Rasmussen SRKモデル)</span>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(['skill', 'rule', 'knowledge', 'other'] as const).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setCognitiveLevel(lvl)}
                        className={`py-1 px-1.5 rounded border text-center text-[10px] font-medium transition-colors ${
                          cognitiveLevel === lvl
                            ? 'bg-amber-600/40 border-amber-400 text-amber-200'
                            : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-300'
                        }`}
                      >
                        {lvl === 'skill' ? 'Skillベース' : lvl === 'rule' ? 'Ruleベース' : lvl === 'knowledge' ? 'Knowledge' : 'その他'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

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
                disabled={isGrouped}
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
                disabled={isGrouped}
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
              disabled={isGrouped}
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
                    [{n.lane}] {n.title} ({n.type === 'outcome' ? '帰結' : n.type === 'variation' ? '変動要因' : n.type === 'normal' ? '通常作業' : '未判定'})
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
