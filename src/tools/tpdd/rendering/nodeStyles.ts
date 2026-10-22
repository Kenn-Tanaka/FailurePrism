import { NodePaletteKey, NodeStatus } from '../domain/schema';

export interface NodePalette {
  label: string;
  fill: string;
  stroke: string;
  text: string;
}

/**
 * Paul Tol Light に基づく、ノード背景用の固定パレット。
 * SVG属性へユーザー入力の色文字列を直接渡さないため、保存値はpaletteKeyに限定する。
 */
export const NODE_PALETTES: Record<NodePaletteKey, NodePalette> = {
  blue: { label: 'ライトブルー', fill: '#77aadd', stroke: '#334155', text: '#1e293b' },
  cyan: { label: 'シアン', fill: '#99ddff', stroke: '#334155', text: '#1e293b' },
  teal: { label: '青緑', fill: '#44bb99', stroke: '#334155', text: '#1e293b' },
  lime: { label: '黄緑', fill: '#bbcc33', stroke: '#334155', text: '#1e293b' },
  yellow: { label: '黄色', fill: '#eedd88', stroke: '#334155', text: '#1e293b' },
  orange: { label: 'オレンジ', fill: '#ee8866', stroke: '#334155', text: '#1e293b' },
  pink: { label: 'ピンク', fill: '#ffaabb', stroke: '#334155', text: '#1e293b' },
  olive: { label: 'オリーブ', fill: '#aaaa00', stroke: '#334155', text: '#1e293b' },
  gray: { label: 'グレー', fill: '#dddddd', stroke: '#334155', text: '#1e293b' },
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
  return NODE_PALETTES.gray;
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
