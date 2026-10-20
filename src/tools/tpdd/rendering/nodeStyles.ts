import { NodePaletteKey, NodeStatus } from '../domain/schema';

export interface NodePalette {
  label: string;
  fill: string;
  stroke: string;
  text: string;
}

/**
 * ユーザー定義種別で選択できる、安全な固定パレット。
 * SVG属性へユーザー入力の色文字列を直接渡さないため、保存値はpaletteKeyに限定する。
 */
export const NODE_PALETTES: Record<NodePaletteKey, NodePalette> = {
  sky: { label: 'スカイ', fill: '#e0f2fe', stroke: '#0284c7', text: '#0369a1' },
  emerald: { label: 'エメラルド', fill: '#dcfce7', stroke: '#16a34a', text: '#15803d' },
  amber: { label: 'アンバー', fill: '#fef3c7', stroke: '#d97706', text: '#b45309' },
  purple: { label: 'パープル', fill: '#f3e8ff', stroke: '#9333ea', text: '#7e22ce' },
  rose: { label: 'ローズ', fill: '#fee2e2', stroke: '#dc2626', text: '#b91c1c' },
  slate: { label: 'スレート', fill: '#f1f5f9', stroke: '#64748b', text: '#475569' },
};

export const NODE_PALETTE_KEYS = Object.keys(NODE_PALETTES) as NodePaletteKey[];

/** Rescue表示などで不正な保存値が来ても描画を継続する。 */
export function getNodePalette(paletteKey: unknown): NodePalette {
  if (
    typeof paletteKey === 'string' &&
    Object.prototype.hasOwnProperty.call(NODE_PALETTES, paletteKey)
  ) {
    return NODE_PALETTES[paletteKey as NodePaletteKey];
  }
  return NODE_PALETTES.slate;
}

export const NODE_STATUS_STYLES: Record<
  NodeStatus,
  { label: string; dashArray?: string; opacity?: number }
> = {
  draft: { label: '下書き' },
  candidate: { label: '候補', dashArray: '4,4' },
  adopted: { label: '採用' },
  rejected: { label: '却下', dashArray: '2,2', opacity: 0.5 },
};

/** SVG上で長いユーザー定義名が状態表示や列境界を越えないようにする。 */
export function truncateDisplayLabel(value: string, maxCodePoints = 12): string {
  const chars = Array.from(value);
  if (chars.length <= maxCodePoints) return value;
  return `${chars.slice(0, Math.max(1, maxCodePoints - 1)).join('')}…`;
}
