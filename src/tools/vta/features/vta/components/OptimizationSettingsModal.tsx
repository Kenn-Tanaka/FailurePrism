import React, { useState } from 'react';
import {
  X,
  Sparkles,
  Sliders,
  RotateCcw,
  Zap,
  CheckCircle2,
  Lightbulb,
  FileText,
  Target,
  Plus,
  Trash2,
  Pin,
  Ban,
  Clock,
  Layers,
} from 'lucide-react';
import { useVTAStore } from '../store/vtaStore';
import {
  OPTIMIZATION_PRESETS,
  METRIC_DESCRIPTIONS,
} from '../utils/optimizationPresets';
import type {
  OptimizationPresetId,
  GranularityWeights,
  VTAUserAssumption,
} from '../../../types/vta';

export interface OptimizationSettingsModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

type ActiveTab = 'weights' | 'assumptions' | 'scope' | 'directive';

export const OptimizationSettingsModal: React.FC<OptimizationSettingsModalProps> = ({
  isOpen: propIsOpen,
  onClose: propOnClose,
}) => {
  const storeIsOpen = useVTAStore((state) => state.isOptimizationSettingsOpen);
  const isOpen = propIsOpen !== undefined ? propIsOpen : storeIsOpen;
  const storeSetIsOpen = useVTAStore((state) => state.setIsOptimizationSettingsOpen);
  const setIsOpen = propOnClose ? () => propOnClose() : (val: boolean) => storeSetIsOpen(val);
  const settings = useVTAStore((state) => state.refinementSettings);
  const setRefinementSettings = useVTAStore((state) => state.setRefinementSettings);
  const resetRefinementSettings = useVTAStore((state) => state.resetRefinementSettings);
  const reoptimizeVTA = useVTAStore((state) => state.reoptimizeVTA);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const vtaData = useVTAStore((state) => state.vtaData);

  const [activeTab, setActiveTab] = useState<ActiveTab>('weights');
  const [newAssumptionText, setNewAssumptionText] = useState('');

  if (!isOpen) return null;

  const currentWeights = settings.weights;
  const weightSum =
    (currentWeights.w1 || 0) +
    (currentWeights.w2 || 0) +
    (currentWeights.w3 || 0) +
    (currentWeights.w4 || 0) +
    (currentWeights.w5 || 0) || 1;

  const assumptions = settings.assumptions ?? [];
  const scope = settings.scope ?? {
    timeRange: { enabled: false },
    includedEntityIds: [],
    excludedEntityIds: [],
    pinnedEntityIds: [],
  };

  const handlePresetSelect = (presetId: OptimizationPresetId) => {
    if (presetId === 'custom') {
      setRefinementSettings({ preset: 'custom' });
      return;
    }
    const preset = OPTIMIZATION_PRESETS[presetId];
    if (!preset) return;
    setRefinementSettings({
      preset: presetId,
      maxIterations: preset.maxIterations,
      weights: { ...preset.weights },
    });
  };

  const handleWeightChange = (key: keyof GranularityWeights, rawVal: number) => {
    const val = Math.max(0, Math.min(100, rawVal)) / 100;
    setRefinementSettings({
      preset: 'custom',
      weights: {
        ...currentWeights,
        [key]: val,
      },
    });
  };

  // Assumptions handlers
  const handleAddAssumption = (text: string) => {
    if (!text.trim()) return;
    const item: VTAUserAssumption = {
      id: `asm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      text: text.trim(),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    setRefinementSettings({
      assumptions: [...assumptions, item],
    });
    setNewAssumptionText('');
  };

  const handleToggleAssumption = (id: string) => {
    setRefinementSettings({
      assumptions: assumptions.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    });
  };

  const handleDeleteAssumption = (id: string) => {
    setRefinementSettings({
      assumptions: assumptions.filter((a) => a.id !== id),
    });
  };

  // Scope handlers
  const entities = vtaData.analysis?.entities ?? vtaData.lanes.map((l) => ({ id: l, name: l }));
  const pinnedIds = new Set(scope.pinnedEntityIds ?? []);
  const excludedIds = new Set(scope.excludedEntityIds ?? []);

  const handleTogglePinEntity = (entityId: string) => {
    const next = new Set(pinnedIds);
    if (next.has(entityId)) next.delete(entityId);
    else {
      next.add(entityId);
      excludedIds.delete(entityId);
    }
    setRefinementSettings({
      scope: {
        ...scope,
        pinnedEntityIds: [...next],
        excludedEntityIds: [...excludedIds],
      },
    });
  };

  const handleToggleExcludeEntity = (entityId: string) => {
    const next = new Set(excludedIds);
    if (next.has(entityId)) next.delete(entityId);
    else {
      next.add(entityId);
      pinnedIds.delete(entityId);
    }
    setRefinementSettings({
      scope: {
        ...scope,
        excludedEntityIds: [...next],
        pinnedEntityIds: [...pinnedIds],
      },
    });
  };

  const handleExecute = () => {
    setIsOpen(false);
    void reoptimizeVTA();
  };

  const sampleDirectives = [
    { label: '連絡・確認の不備に着目', text: '機器の故障や動作だけでなく、作業員間の連絡・確認・手順の行き違いに強く着目してツリーを再構成してください。' },
    { label: '役割・責任境界を厳格化', text: '現場作業員と管理職・指示系統の役割や責任境界を厳格に分離し、同一レーンへの作業混在を解消してください。' },
    { label: '大括りにカードを集約', text: '微細なアクションを大括りに集約し、カード総数を減らして全体構造を一目で把握できるようにしてください。' },
    { label: '原因から結末への連鎖を重視', text: '変動要因から最終的な事故・不具合事象に至るまでの因果関係の矢印が途切れないよう、重点的に結線を繋げてください。' },
  ];

  const sampleAssumptions = [
    '当日は激しい雨天であり、足場が滑りやすく視界が著しく不良であったと仮定する',
    '作業員Aは作業標準マニュアルを携帯しておらず、記憶のみに頼って操作したと仮定する',
    '現場の警報器の音量が周囲の重機騒音にかき消され、聞き取れなかった可能性を仮定する',
    '前直からの引き継ぎ事項に、機器の初期不具合についての注意書きが抜けていたと仮定する',
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="optimization-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in-50"
    >
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl shadow-cyan-950/40 text-slate-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center text-indigo-400">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 id="optimization-modal-title" className="text-sm font-bold text-white flex items-center gap-2">
                <span>VTA最適化・対話的分析設定</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-950/80 border border-indigo-700/60 text-indigo-300 font-normal">
                  パラメータ＆トライ＆エラー
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                AIによる主体粒度・接続構造の反復レビュー条件とチェックリストの重みを調整します
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
            title="閉じる"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/30 px-6 pt-2 gap-4 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('weights')}
            className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'weights'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>パラメータ ＆ 評価重み</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('assumptions')}
            className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'assumptions'
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>前提・仮定（What-if）</span>
            {assumptions.some((a) => a.enabled) && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-amber-900/80 text-amber-300 font-bold">
                {assumptions.filter((a) => a.enabled).length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('scope')}
            className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'scope'
                ? 'border-emerald-400 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Target className="w-3.5 h-3.5" />
            <span>スコープ ＆ 制約</span>
            {(pinnedIds.size > 0 || excludedIds.size > 0 || scope.timeRange?.enabled) && (
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('directive')}
            className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              activeTab === 'directive'
                ? 'border-indigo-400 text-indigo-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            <span>局所最適脱出指示</span>
            {settings.useOneTimeDirective && (
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
            )}
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'weights' && (
            <>
              {/* Presets */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span>ワンクリック・プリセット</span>
                  </label>
                  <span className="text-[10px] text-slate-400">用途に合わせて最適な重みを一発設定</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(['balanced', 'presentation', 'causality', 'organization'] as const).map((id) => {
                    const preset = OPTIMIZATION_PRESETS[id];
                    const isSelected = settings.preset === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => handlePresetSelect(id)}
                        className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                          isSelected
                            ? 'bg-cyan-950/60 border-cyan-500/80 text-cyan-100 shadow-md shadow-cyan-950/50'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold">{preset.name}</span>
                          {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />}
                        </div>
                        <span className="text-[10px] text-slate-400 mt-1">{preset.tagline}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400 bg-slate-950/50 border border-slate-800/80 rounded-lg p-2 leading-relaxed">
                  {settings.preset === 'custom'
                    ? '🛠️ 現在は手動カスタム調整モードです。各スライダーでお好みのバランスに設定されています。'
                    : OPTIMIZATION_PRESETS[settings.preset].description}
                </p>
              </div>

              {/* Iteration Count */}
              <div className="space-y-2 p-3 bg-slate-950/40 border border-slate-800/80 rounded-xl">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-bold text-slate-200">反復改善の回数 (Max Iterations)</label>
                    <p className="text-[10px] text-slate-400">AIが図の改善（カードや主体の整理、接続見直し）を試行錯誤する最大回数</p>
                  </div>
                  <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-700 px-2 py-0.5 rounded-md">
                    <span className="text-xs font-mono font-bold text-cyan-400">{settings.maxIterations}</span>
                    <span className="text-[10px] text-slate-400">回</span>
                  </div>
                </div>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={settings.maxIterations}
                  onChange={(e) => setRefinementSettings({ maxIterations: Number(e.target.value) })}
                  className="w-full accent-cyan-400 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span>1回（高速）</span>
                  <span>2回（推奨）</span>
                  <span>3回（綿密）</span>
                  <span>5回（最高品質）</span>
                </div>
              </div>

              {/* Checklist Weights */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                      <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                      <span>評価チェックリストの重み付け (C1〜C5)</span>
                    </label>
                    <p className="text-[10px] text-slate-400">最適化時にAIがどの観点をどれくらい重視して構造を改善するかを設定します</p>
                  </div>
                </div>

                <div className="space-y-2.5">
                  {(['c1', 'c2', 'c3', 'c4', 'c5'] as const).map((k) => {
                    const desc = METRIC_DESCRIPTIONS[k];
                    const rawVal = Math.round((currentWeights[desc.weightKey] || 0) * 100);
                    const normPercent = Math.round(((currentWeights[desc.weightKey] || 0) / weightSum) * 100);

                    return (
                      <div
                        key={k}
                        className="p-3 bg-slate-950/60 border border-slate-800 rounded-xl space-y-1.5 transition-all hover:border-slate-700"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-200">{desc.label}</span>
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 uppercase">
                              {k}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs font-mono">
                            <span className="text-cyan-300 font-bold">{normPercent}%</span>
                            <span className="text-[10px] text-slate-400">({rawVal}pt)</span>
                          </div>
                        </div>

                        <p className="text-[11px] text-slate-300 leading-tight">
                          {desc.summary}
                        </p>

                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={rawVal}
                          onChange={(e) => handleWeightChange(desc.weightKey, Number(e.target.value))}
                          className="w-full accent-cyan-400 cursor-pointer mt-1"
                        />

                        <p className="text-[10px] text-slate-400 leading-tight pt-0.5">
                          💡 {desc.detail}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {activeTab === 'assumptions' && (
            <div className="space-y-4">
              <div className="p-3.5 bg-amber-950/40 border border-amber-800/60 rounded-xl space-y-2">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold text-white">入力補足・前提の追加（What-if分析）</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  原文テキストに書かれていない現場状況や前提条件を仮定として追加し、ツリーへの波及効果を検証できます。客観的事実と混同されないよう、仮定に基づくカードには <span className="text-amber-300 font-bold">[仮定]</span> バッジが付与されます。
                </p>
              </div>

              {/* Add New Assumption Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">新しい仮定・前提条件を入力</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newAssumptionText}
                    onChange={(e) => setNewAssumptionText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddAssumption(newAssumptionText);
                    }}
                    placeholder="例：当日は激しい雨天であり視界が著しく不良であったと仮定する"
                    className="flex-1 bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500"
                  />
                  <button
                    type="button"
                    onClick={() => handleAddAssumption(newAssumptionText)}
                    disabled={!newAssumptionText.trim()}
                    className="px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>追加</span>
                  </button>
                </div>
              </div>

              {/* List of current assumptions */}
              <div className="space-y-2">
                <span className="text-xs font-semibold text-slate-300">設定済みの仮定一覧 ({assumptions.length}件)</span>
                {assumptions.length === 0 ? (
                  <p className="text-[11px] text-slate-500 p-4 border border-dashed border-slate-800 rounded-xl text-center">
                    まだ仮定は追加されていません。上の入力欄または下の定型例から追加できます。
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {assumptions.map((asm) => (
                      <div
                        key={asm.id}
                        className={`p-2.5 rounded-lg border flex items-center justify-between gap-2 transition-all ${
                          asm.enabled
                            ? 'bg-amber-950/30 border-amber-800/60 text-slate-200'
                            : 'bg-slate-950/40 border-slate-800/60 text-slate-500'
                        }`}
                      >
                        <label className="flex items-center gap-2.5 flex-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={asm.enabled}
                            onChange={() => handleToggleAssumption(asm.id)}
                            className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                          />
                          <span className={`text-xs ${asm.enabled ? 'font-medium' : 'line-through'}`}>
                            {asm.text}
                          </span>
                        </label>
                        <button
                          type="button"
                          onClick={() => handleDeleteAssumption(asm.id)}
                          className="p-1 text-slate-500 hover:text-rose-400 rounded transition-colors cursor-pointer"
                          title="削除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Quick sample chips */}
              <div className="space-y-2 pt-1">
                <span className="text-[11px] font-semibold text-slate-400">💡 よくある仮定のクイック追加</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {sampleAssumptions.map((sample, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleAddAssumption(sample)}
                      className="p-2 bg-slate-950/60 hover:bg-slate-800 border border-slate-800 hover:border-amber-500/50 rounded-lg text-left text-[11px] text-slate-300 transition-colors cursor-pointer"
                    >
                      <span>+ {sample}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'scope' && (
            <div className="space-y-5">
              <div className="p-3.5 bg-emerald-950/40 border border-emerald-800/60 rounded-xl space-y-2">
                <div className="flex items-center gap-2">
                  <Target className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-bold text-white">分析スコープの絞り込み ＆ 制約条件</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  分析対象の主体を絞り込んだり、重要主体を独立レーンとして固定（マージ禁止）できます。また、特定時間帯に焦点を当ててツリーを部分最適化することも可能です。
                </p>
              </div>

              {/* Time Range Scope */}
              <div className="p-3 bg-slate-950/50 border border-slate-800 rounded-xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(scope.timeRange?.enabled)}
                      onChange={(e) =>
                        setRefinementSettings({
                          scope: {
                            ...scope,
                            timeRange: {
                              ...scope.timeRange,
                              enabled: e.target.checked,
                            },
                          },
                        })
                      }
                      className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
                    />
                    <Clock className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-xs font-bold text-slate-200">時間帯で絞り込み (Time Scope)</span>
                  </label>
                  <span className="text-[10px] text-slate-400">特定フェーズのみに集中して分析</span>
                </div>

                {scope.timeRange?.enabled && (
                  <div className="grid grid-cols-2 gap-3 pt-1 animate-in fade-in-50">
                    <div>
                      <span className="text-[10px] text-slate-400">開始時刻 / 基準</span>
                      <input
                        type="text"
                        value={scope.timeRange?.start || ''}
                        onChange={(e) =>
                          setRefinementSettings({
                            scope: {
                              ...scope,
                              timeRange: { ...scope.timeRange, enabled: true, start: e.target.value },
                            },
                          })
                        }
                        placeholder="例：08:00 または 発端"
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 mt-0.5"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400">終了時刻 / 基準</span>
                      <input
                        type="text"
                        value={scope.timeRange?.end || ''}
                        onChange={(e) =>
                          setRefinementSettings({
                            scope: {
                              ...scope,
                              timeRange: { ...scope.timeRange, enabled: true, end: e.target.value },
                            },
                          })
                        }
                        placeholder="例：10:30 または 事故発生"
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 mt-0.5"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Subject Entity Scope & Pinning */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-emerald-400" />
                    <span>主体の固定（Pin）＆ 除外（Scope）</span>
                  </label>
                  <span className="text-[10px] text-slate-400">
                    🔒 固定: マージ禁止（独立維持） / 🚫 除外: 分析対象外
                  </span>
                </div>

                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {entities.length === 0 ? (
                    <p className="text-[11px] text-slate-500 p-3 text-center border border-slate-800 rounded-lg">
                      主体が検出されていません
                    </p>
                  ) : (
                    entities.map((entity) => {
                      const isPinned = pinnedIds.has(entity.id);
                      const isExcluded = excludedIds.has(entity.id);

                      return (
                        <div
                          key={entity.id}
                          className={`px-3 py-2 rounded-xl border flex items-center justify-between transition-all ${
                            isPinned
                              ? 'bg-emerald-950/40 border-emerald-600/70 text-emerald-200'
                              : isExcluded
                              ? 'bg-rose-950/30 border-rose-900/60 text-slate-500 line-through'
                              : 'bg-slate-950/60 border-slate-800 text-slate-200'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold">{entity.name}</span>
                            <span className="text-[10px] text-slate-500 font-mono">({entity.id})</span>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleTogglePinEntity(entity.id)}
                              className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                                isPinned
                                  ? 'bg-emerald-600 text-white shadow-sm'
                                  : 'bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-emerald-300'
                              }`}
                              title={isPinned ? '固定を解除' : 'マージ禁止（独立レーンとして死守）'}
                            >
                              <Pin className="w-3 h-3" />
                              <span>{isPinned ? '固定中' : '固定'}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleToggleExcludeEntity(entity.id)}
                              className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer ${
                                isExcluded
                                  ? 'bg-rose-700 text-white shadow-sm'
                                  : 'bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-rose-300'
                              }`}
                              title={isExcluded ? '除外を解除' : 'ツリーから除外'}
                            >
                              <Ban className="w-3 h-3" />
                              <span>{isExcluded ? '除外中' : '除外'}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'directive' && (
            <div className="space-y-4">
              <div className="p-3.5 bg-indigo-950/40 border border-indigo-800/60 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Lightbulb className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-bold text-white">局所最適から抜け出すための一時指示</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(settings.useOneTimeDirective)}
                      onChange={(e) => setRefinementSettings({ useOneTimeDirective: e.target.checked })}
                      className="w-4 h-4 accent-indigo-500 rounded cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-indigo-300">次回1回のみ適用</span>
                  </label>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  AIの最適化が似たような図（局所解）にとどまり改善が進まない場合や、特定の視点（ヒューマンエラー、コミュニケーション、手順違反など）でツリーを再構成させたい場合に、**次回1回限りの特別指示**をAIに与えます。実行後に自動でOFFになります。
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">指示内容（自由記述）</label>
                <textarea
                  rows={4}
                  value={settings.oneTimeDirective || ''}
                  onChange={(e) => {
                    setRefinementSettings({
                      oneTimeDirective: e.target.value,
                      useOneTimeDirective: Boolean(e.target.value.trim()),
                    });
                  }}
                  placeholder="例：機器の故障だけでなく、連絡・確認・手順の不備に着目してツリーを再構成してください。カード数が多すぎるため同一フェーズを大括りにまとめてください。"
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl p-3 text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500 leading-relaxed font-sans resize-y"
                />
              </div>

              <div className="space-y-2">
                <span className="text-[11px] font-semibold text-slate-400">💡 定型指示のクイック入力</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {sampleDirectives.map((sample) => (
                    <button
                      key={sample.label}
                      type="button"
                      onClick={() => {
                        setRefinementSettings({
                          oneTimeDirective: sample.text,
                          useOneTimeDirective: true,
                        });
                      }}
                      className="p-2 bg-slate-950/60 hover:bg-slate-800 border border-slate-800 hover:border-indigo-500/50 rounded-lg text-left text-[11px] text-slate-300 transition-colors cursor-pointer flex flex-col gap-0.5"
                    >
                      <span className="font-bold text-indigo-300">{sample.label}</span>
                      <span className="text-[10px] text-slate-400 line-clamp-1">{sample.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-950/60">
          <button
            type="button"
            onClick={resetRefinementSettings}
            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            title="標準バランス（デフォルト設定）に復元"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>標準値に戻す</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-4 py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs font-semibold transition-colors cursor-pointer"
            >
              閉じる
            </button>
            <button
              type="button"
              disabled={isExtracting}
              onClick={handleExecute}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-indigo-950/50 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-200" />
              <span>この設定でVTA最適化を実行</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
