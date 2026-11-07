import type { GranularityWeights, OptimizationPresetId, VTARefinementSettings } from '../../../types/vta';
import { DEFAULT_GRANULARITY_WEIGHTS } from '../../../services/generation/granularityScore';

export interface PresetDefinition {
  id: OptimizationPresetId;
  name: string;
  tagline: string;
  description: string;
  maxIterations: number;
  weights: GranularityWeights;
}

export const OPTIMIZATION_PRESETS: Record<Exclude<OptimizationPresetId, 'custom'>, PresetDefinition> = {
  balanced: {
    id: 'balanced',
    name: '標準バランス',
    tagline: '標準推奨',
    description: '主体の適正数、役割分担、因果の到達性、図のシンプルさをバランス良く最適化します。',
    maxIterations: 2,
    weights: { w1: 0.25, w2: 0.20, w3: 0.25, w4: 0.15, w5: 0.15 },
  },
  presentation: {
    id: 'presentation',
    name: '見やすさ重視',
    tagline: 'プレゼン・報告向け',
    description: '線の交差やカード数を抑制し、全体を一目でスッキリ把握しやすい図に整えます。',
    maxIterations: 2,
    weights: { w1: 0.35, w2: 0.10, w3: 0.15, w4: 0.10, w5: 0.30 },
  },
  causality: {
    id: 'causality',
    name: '因果・厳密性重視',
    tagline: '詳細調査向け',
    description: 'トラブル要因から最終事故までの矢印の途切れなさと、因果の到達性を最優先します。',
    maxIterations: 3,
    weights: { w1: 0.15, w2: 0.15, w3: 0.45, w4: 0.15, w5: 0.10 },
  },
  organization: {
    id: 'organization',
    name: '組織・役割重視',
    tagline: 'ヒューマンファクタ向け',
    description: '現場・管理部門・機器の責任境界を明確にし、役割の一貫性を最重要視します。',
    maxIterations: 2,
    weights: { w1: 0.20, w2: 0.35, w3: 0.15, w4: 0.25, w5: 0.05 },
  },
};

export const METRIC_DESCRIPTIONS = {
  c1: {
    id: 'c1',
    weightKey: 'w1' as const,
    label: '主体の数（レーン幅）',
    summary: '登場人物（レーン）が多すぎず少なすぎず、全体を見渡しやすい横幅に整える度合い',
    detail: '画面の認知限界（3〜6レーン程度）に収まるようレーン数を調整します（事故の主役にカードが集まる偏りは自然な構造として許容されます）。',
  },
  c2: {
    id: 'c2',
    weightKey: 'w2' as const,
    label: '役割・立場の一貫性',
    summary: '同じレーンに立場や責任の異なる人の行動が混ざらないように区別する度合い',
    detail: '現場作業員と管理職、あるいは別部門の行動が1つのレーンに混在するのを防ぎます（※組織間インシデントでは同一組織のマネジメント一体化を許容します）。',
  },
  c3: {
    id: 'c3',
    weightKey: 'w3' as const,
    label: '因果シナリオと結果へのつながり',
    summary: 'トラブル要因から帰結までの因果ストーリーが漏れなく過不足なく一本に繋がる度合い',
    detail: '帰結（損失・直前停止・回復）に至る一連のストーリーが網羅され、無関係なノードや未接続の重要な出来事がないかを評価します。',
  },
  c4: {
    id: 'c4',
    weightKey: 'w4' as const,
    label: '装置・システムの境界',
    summary: '自律動作しない単なる物・部品が不要に独立レーン化しないようにする度合い',
    detail: 'スイッチや計器など自律動作しない受動的な機器が、無駄に独立したレーンになるのを防ぎます。',
  },
  c5: {
    id: 'c5',
    weightKey: 'w5' as const,
    label: '図の見やすさ・簡潔さ',
    summary: '線の交差や深すぎる階層を減らし、全体を一目でスッキリ見渡せるようにする度合い',
    detail: 'レーンを跨ぐ線の交差数、多すぎるカード数、深すぎる直列階段を抑え、認知負荷を下げます。',
  },
} as const;

export const DEFAULT_REFINEMENT_SETTINGS: VTARefinementSettings = {
  maxIterations: 2,
  targetScore: 0.82,
  epsilon: 0.02,
  weights: { ...DEFAULT_GRANULARITY_WEIGHTS },
  preset: 'balanced',
  assumptions: [],
  scope: {
    timeRange: { enabled: false },
    includedEntityIds: [],
    excludedEntityIds: [],
    pinnedEntityIds: [],
  },
};
