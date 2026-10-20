import { Diagram, LevelDefinition, NodeKindDefinition } from '../domain/schema';
import { sanitizeFilename } from '../services/persistence/fileIo';
import { calculateEdgePath } from './connectionPoints';
import {
  NODE_STATUS_STYLES,
  getNodePalette,
  truncateDisplayLabel,
} from './nodeStyles';
import { wrapText } from './textWrap';

/**
 * XML 特殊文字エスケープ
 */
export function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '\'':
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

/**
 * Diagramをスタンドアロン静的SVG文字列として生成する純粋関数
 * 仕様書 7.3 に完全準拠
 */
export function generateDiagramSvg(
  diagram: Diagram,
  levels: LevelDefinition[],
  nodeKinds: NodeKindDefinition[]
): string {
  const MARGIN = 40;

  // 外接範囲の計算
  if (diagram.nodes.length === 0) {
    const width = 800;
    const height = 600;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <style>
    text { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#94a3b8" font-size="16">空の図 (${escapeXml(diagram.title)})</text>
</svg>`;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of diagram.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }

  const viewBoxX = minX - MARGIN;
  const viewBoxY = minY - MARGIN;
  const viewBoxWidth = maxX - minX + MARGIN * 2;
  const viewBoxHeight = maxY - minY + MARGIN * 2;

  // ノードマップ
  const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
  const kindMap = new Map(nodeKinds.map((kind) => [kind.id, kind]));

  // エッジ描画SVG文字列
  const edgesSvg: string[] = [];

  for (const edge of diagram.edges) {
    const sourceNode = nodeMap.get(edge.sourceId);
    const targetNode = nodeMap.get(edge.targetId);
    if (!sourceNode || !targetNode) continue;

    // 逆方向ペアの存在チェック
    const isReversePair = diagram.edges.some(
      (e) => e.sourceId === edge.targetId && e.targetId === edge.sourceId
    );

    const { pathData, midPoint } = calculateEdgePath(
      sourceNode,
      targetNode,
      isReversePair
    );

    let strokeDash = '';
    let strokeColor = '#64748b'; // slate-500
    if (edge.kind === 'dependency') {
      strokeColor = '#0284c7'; // sky-600
    } else if (edge.kind === 'constraint') {
      strokeColor = '#dc2626'; // rose-600
      strokeDash = 'stroke-dasharray="4,4"';
    } else if (edge.kind === 'reference') {
      strokeColor = '#94a3b8'; // slate-400
      strokeDash = 'stroke-dasharray="2,2"';
    }

    const labelSvg = edge.label
      ? `<g transform="translate(${midPoint.x}, ${midPoint.y})">
          <rect x="${-edge.label.length * 5 - 4}" y="-12" width="${edge.label.length * 10 + 8}" height="16" rx="3" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" opacity="0.95"/>
          <text x="0" y="0" text-anchor="middle" font-size="11" font-weight="500" fill="${strokeColor}">${escapeXml(edge.label)}</text>
        </g>`
      : '';

    edgesSvg.push(`
    <g class="edge" id="edge-${escapeXml(edge.id)}">
      <title>${escapeXml(edge.label || edge.kind)}: ${escapeXml(sourceNode.label)} → ${escapeXml(targetNode.label)}</title>
      <path d="${pathData}" fill="none" stroke="${strokeColor}" stroke-width="1.5" ${strokeDash} marker-end="url(#arrow-${edge.kind})"/>
      ${labelSvg}
    </g>`);
  }

  // ノード描画SVG文字列
  const nodesSvg: string[] = [];
  const FONT_SIZE = 13;
  const LINE_HEIGHT = 18;

  for (const node of diagram.nodes) {
    const kindDefinition = kindMap.get(node.kindId);
    const colors = getNodePalette(kindDefinition?.paletteKey);
    const statusStyle = NODE_STATUS_STYLES[node.status] || NODE_STATUS_STYLES.draft;
    const kindLabel = kindDefinition?.label ?? '未定義の種別';
    const kindLabelCapacity = Math.max(4, Math.min(12, Math.floor((node.width - 72) / 10)));
    const displayedKindLabel = truncateDisplayLabel(kindLabel, kindLabelCapacity);

    const dashAttr = statusStyle.dashArray ? `stroke-dasharray="${statusStyle.dashArray}"` : '';
    const opacityAttr = statusStyle.opacity ? `opacity="${statusStyle.opacity}"` : '';

    // ラベルのテキスト折り返し
    const wrappedLines = wrapText(node.label, node.width - 24, FONT_SIZE);

    const tspans = wrappedLines.map((line, idx) => {
      return `<tspan x="${node.x + 12}" dy="${idx === 0 ? 0 : LINE_HEIGHT}">${escapeXml(line)}</tspan>`;
    });

    const level = levels.find((l) => l.id === node.levelId);
    const levelLabel = level ? level.label : '';

    const subDiagramBadge = node.childDiagramId
      ? `<text x="${node.x + node.width - 12}" y="${node.y + node.height - 8}" font-size="11" font-weight="bold" text-anchor="end" fill="#3b82f6">↳ 詳細図</text>`
      : '';

    nodesSvg.push(`
    <g class="node" id="node-${escapeXml(node.id)}" ${opacityAttr}>
      <title>[${escapeXml(kindLabel)}] ${escapeXml(node.label)} (${escapeXml(statusStyle.label)}${levelLabel ? ' / ' + escapeXml(levelLabel) : ''})&#10;${escapeXml(node.meta.description)}</title>
      <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="6" ry="6" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1.5" ${dashAttr}/>
      
      <!-- ヘッダー・バッジ -->
      <text x="${node.x + 10}" y="${node.y + 16}" font-size="10" font-weight="bold" fill="${colors.text}">[${escapeXml(displayedKindLabel)}]</text>
      <text x="${node.x + node.width - 10}" y="${node.y + 16}" font-size="10" text-anchor="end" fill="#64748b">${escapeXml(statusStyle.label)}</text>
      
      <!-- ラベル本文 -->
      <text x="${node.x + 12}" y="${node.y + 36}" font-size="${FONT_SIZE}" fill="#1e293b">
        ${tspans.join('\n        ')}
      </text>
      
      <!-- サブ図バッジ -->
      ${subDiagramBadge}
    </g>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}" width="${viewBoxWidth}" height="${viewBoxHeight}">
  <defs>
    <style>
      text { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", sans-serif; }
    </style>
    <marker id="arrow-decomposition" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b"/>
    </marker>
    <marker id="arrow-dependency" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#0284c7"/>
    </marker>
    <marker id="arrow-constraint" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#dc2626"/>
    </marker>
    <marker id="arrow-reference" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="${viewBoxX}" y="${viewBoxY}" width="${viewBoxWidth}" height="${viewBoxHeight}" fill="#ffffff"/>
  <g class="edges">
    ${edgesSvg.join('\n')}
  </g>
  <g class="nodes">
    ${nodesSvg.join('\n')}
  </g>
</svg>`;
}

/**
 * 生成したSVG文字列をブラウザからダウンロード
 */
export function downloadSvg(svgString: string, filename: string): void {
  const baseName = sanitizeFilename(filename.replace(/\.svg$/i, ''));
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 現在図をPNGラスタ画像として生成・ダウンロード
 */
export async function downloadDiagramPng(
  diagram: Diagram,
  levels: LevelDefinition[],
  nodeKinds: NodeKindDefinition[],
  filename: string,
  scale = 2
): Promise<void> {
  const baseName = sanitizeFilename(filename.replace(/\.png$/i, ''));
  const svgString = generateDiagramSvg(diagram, levels, nodeKinds);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = (img.width || 800) * scale;
        canvas.height = (img.height || 600) * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('Canvas 2D context を取得できませんでした'));
          return;
        }

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);

        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(url);
          if (!pngBlob) {
            reject(new Error('PNG生成に失敗しました'));
            return;
          }

          const pngUrl = URL.createObjectURL(pngBlob);
          const a = document.createElement('a');
          a.href = pngUrl;
          a.download = `${baseName}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
          resolve();
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG画像の読み込みに失敗しました'));
    };

    img.src = url;
  });
}

/**
 * プロジェクト内のすべての図面を順次SVGダウンロード
 */
export function exportAllDiagramsAsSvg(
  diagrams: Diagram[],
  levels: LevelDefinition[],
  nodeKinds: NodeKindDefinition[],
  projectTitle: string
): void {
  diagrams.forEach((diag, index) => {
    setTimeout(() => {
      const svgStr = generateDiagramSvg(diag, levels, nodeKinds);
      const filename = `${sanitizeFilename(projectTitle)}_${sanitizeFilename(diag.title)}`;
      downloadSvg(svgStr, filename);
    }, index * 350);
  });
}
