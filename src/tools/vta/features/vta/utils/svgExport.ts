import { VTASchema, VTAReactFlowNode, VTAReactFlowEdge } from '../../../types/vta';
import { routingOffset } from './edgeRouting';
import {
  LayoutResult,
  calculateVTALayout,
  NODE_WIDTH,
  NODE_HEIGHT,
  LANE_WIDTH,
  VERTICAL_GAP,
  getOrthogonalStepPath,
  getNodeHeight,
  compactTitleLines,
} from './layout';

export interface SVGExportOptions {
  filename?: string;
  scenarioText?: string;
  includeEmptyLanes?: boolean;
  includeNotes?: boolean;
  compact?: boolean;
}

/**
 * Escapes characters for XML/SVG text
 */
function escapeXML(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wraps text into multiple lines based on maximum character count per line
 */
function wrapTextLines(text: string, maxCharsPerLine = 24): string[] {
  if (!text) return [];
  const rawLines = text.split('\n');
  const result: string[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) {
      result.push('');
      continue;
    }

    let remaining = rawLine;
    while (remaining.length > 0) {
      if (remaining.length <= maxCharsPerLine) {
        result.push(remaining);
        break;
      }

      const sliceLen = maxCharsPerLine;
      result.push(remaining.substring(0, sliceLen));
      remaining = remaining.substring(sliceLen);
    }
  }

  return result;
}

const LANE_HEADER_HEIGHT = 42;
const PADDING = 40;
const TOP_BANNER_HEIGHT = 80;
const NOTES_PANEL_WIDTH = 460;

/**
 * Generates high-quality standalone SVG XML representing Variation Tree Analysis (VTA) Diagram with embedded Supplementary Notes.
 */
export function generateVTASVG(
  vtaData: VTASchema,
  _initialNodes: VTAReactFlowNode[],
  _initialEdges: VTAReactFlowEdge[],
  _initialLaneBounds: LayoutResult['laneBounds'],
  options: SVGExportOptions = {}
): string {
  const includeEmptyLanes = options.includeEmptyLanes ?? false;
  const includeNotes = options.includeNotes ?? true;

  // Determine effective lanes based on includeEmptyLanes option
  const rawLanes = vtaData.lanes && vtaData.lanes.length > 0
    ? vtaData.lanes
    : Array.from(new Set(vtaData.nodes.map((n) => n.lane || '主要部門')));

  let effectiveLanes: string[];
  if (includeEmptyLanes) {
    effectiveLanes = rawLanes;
  } else {
    const activeLanes = rawLanes.filter((lane) =>
      vtaData.nodes.some((n) => (n.lane || '主要部門') === lane)
    );
    effectiveLanes = activeLanes.length > 0 ? activeLanes : rawLanes;
  }

  // Recalculate layout with the effective lanes so coordinates and lane bounds are contiguous
  const effectiveSchema: VTASchema = {
    ...vtaData,
    lanes: effectiveLanes,
  };
  const layout = calculateVTALayout(effectiveSchema, undefined, undefined, {
    compact: options.compact ?? true,
    forceRecompute: true,
  });
  const nodes = layout.nodes;
  const edges = layout.edges;
  const laneBounds = layout.laneBounds;

  // 1. Calculate Diagram Coordinates
  let minDiagramX = Infinity;
  let maxDiagramX = -Infinity;
  let minDiagramY = Infinity;
  let maxDiagramY = -Infinity;

  if (laneBounds && laneBounds.length > 0) {
    laneBounds.forEach((lb) => {
      if (lb.x < minDiagramX) minDiagramX = lb.x;
      if (lb.x + lb.width > maxDiagramX) maxDiagramX = lb.x + lb.width;
      if (lb.minY < minDiagramY) minDiagramY = lb.minY;
      if (lb.maxY > maxDiagramY) maxDiagramY = lb.maxY;
    });
  }

  nodes.forEach((n) => {
    if (n.position.x < minDiagramX) minDiagramX = n.position.x;
    if (n.position.x + NODE_WIDTH > maxDiagramX) maxDiagramX = n.position.x + NODE_WIDTH;
    if (n.position.y < minDiagramY) minDiagramY = n.position.y;
    if (n.position.y + NODE_HEIGHT > maxDiagramY) maxDiagramY = n.position.y + NODE_HEIGHT;
  });

  if (minDiagramX === Infinity) {
    minDiagramX = 0;
    maxDiagramX = 800;
    minDiagramY = 0;
    maxDiagramY = 600;
  }

  // Adjust offsets so diagram starts at (PADDING, TOP_BANNER_HEIGHT + PADDING + LANE_HEADER_HEIGHT)
  const diagramOriginX = PADDING + 30; // Extra space on left for Time Axis
  const diagramOriginY = TOP_BANNER_HEIGHT + PADDING + LANE_HEADER_HEIGHT;
  const diagramWidth = Math.max(540, maxDiagramX - minDiagramX + 60);
  const diagramHeight = Math.max(500, maxDiagramY - minDiagramY + 80);

  // Mapping function from node coordinate to SVG coordinate
  const mapX = (x: number) => x - minDiagramX + diagramOriginX;
  const mapY = (y: number) => y - minDiagramY + diagramOriginY;

  // 2. Compute Supplementary Notes Content and Layout (if enabled)
  const notesX = diagramOriginX + diagramWidth + 30;
  const notesY = TOP_BANNER_HEIGHT + PADDING;

  let currentNoteY = notesY + 50;
  const noteBlocks: Array<{
    type: 'summary' | 'node' | 'custom';
    title: string;
    nodeId?: string;
    lane?: string;
    nodeType?: 'normal' | 'variation';
    measureType?: 'elimination' | null;
    lines: string[];
    y: number;
    height: number;
  }> = [];

  const nodesWithNotes = vtaData.nodes.filter((n) => Boolean(n.supplementary_note?.trim()));

  if (includeNotes) {
    // Summary note
    if (vtaData.supplementary_summary && vtaData.supplementary_summary.trim()) {
      const lines = wrapTextLines(vtaData.supplementary_summary.trim(), 28);
      const blockHeight = 40 + lines.length * 18 + 15;
      noteBlocks.push({
        type: 'summary',
        title: '全体総括・組織的背景要因',
        lines,
        y: currentNoteY,
        height: blockHeight,
      });
      currentNoteY += blockHeight + 15;
    }

    // Node notes
    nodesWithNotes.forEach((n) => {
      const lines = wrapTextLines(n.supplementary_note!.trim(), 28);
      const blockHeight = 42 + lines.length * 18 + 12;
      noteBlocks.push({
        type: 'node',
        title: n.title,
        nodeId: n.id,
        lane: n.lane,
        nodeType: n.type,
        measureType: n.measure_type,
        lines,
        y: currentNoteY,
        height: blockHeight,
      });
      currentNoteY += blockHeight + 12;
    });

    // Custom notes
    if (vtaData.custom_notes && vtaData.custom_notes.length > 0) {
      vtaData.custom_notes.forEach((cn) => {
        const lines = wrapTextLines(cn.content.trim(), 28);
        const blockHeight = 40 + lines.length * 18 + 12;
        noteBlocks.push({
          type: 'custom',
          title: cn.title || '補足メモ',
          lines,
          y: currentNoteY,
          height: blockHeight,
        });
        currentNoteY += blockHeight + 12;
      });
    }
  }

  const notesTotalHeight = currentNoteY - notesY + 30;
  const contentHeight = includeNotes
    ? Math.max(diagramHeight + LANE_HEADER_HEIGHT + 100, notesTotalHeight, 600)
    : Math.max(diagramHeight + LANE_HEADER_HEIGHT + 100, 600);

  const totalSVGWidth = includeNotes
    ? Math.max(760, notesX + NOTES_PANEL_WIDTH + PADDING)
    : Math.max(760, diagramOriginX + diagramWidth + PADDING + 20);

  const totalSVGHeight = TOP_BANNER_HEIGHT + PADDING + contentHeight + 60;

  // 3. Build SVG Elements
  const eliminationCount = vtaData.nodes.filter((n) => n.measure_type === 'elimination').length;
  const breakCount = vtaData.edges.filter((e) => e.is_break).length;
  const timestamp = new Date().toLocaleString('ja-JP');

  // Node ID to position map for Edge rendering
  const nodeMap = new Map<string, { x: number; y: number; width: number; height: number }>();
  nodes.forEach((n) => {
    const nodeHeight = n.measured?.height ?? getNodeHeight(n, _initialNodes);
    nodeMap.set(n.id, {
      x: mapX(n.position.x),
      y: mapY(n.position.y),
      width: NODE_WIDTH,
      height: nodeHeight,
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSVGWidth} ${totalSVGHeight}" width="${totalSVGWidth}" height="${totalSVGHeight}" style="background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', Meiryo, 'Yu Gothic', sans-serif;">
  
  <defs>
    <!-- Arrow Markers -->
    <marker id="arrow-sequential" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M1,1 L1,7 L7,4 z" fill="#334155" />
    </marker>
    <marker id="arrow-unidirectional" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
      <path d="M1,1 L1,7 L8,4 z" fill="#0284c7" />
    </marker>
    <marker id="arrow-start-bidirectional" markerWidth="10" markerHeight="8" refX="1" refY="4" orient="auto-start-reverse">
      <path d="M8,1 L8,7 L1,4 z" fill="#7c3aed" />
    </marker>
    <marker id="arrow-end-bidirectional" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
      <path d="M1,1 L1,7 L8,4 z" fill="#7c3aed" />
    </marker>

    <!-- Node Drop Shadows -->
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="115%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0f172a" flood-opacity="0.08" />
    </filter>
    <filter id="variation-shadow" x="-8%" y="-8%" width="116%" height="120%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#b45309" flood-opacity="0.15" />
    </filter>
  </defs>

  <!-- Canvas Border Sheet -->
  <rect x="15" y="15" width="${totalSVGWidth - 30}" height="${totalSVGHeight - 30}" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />

  <!-- ================= TOP HEADER BANNER ================= -->
  <g id="top-header">
    <rect x="16" y="16" width="${totalSVGWidth - 32}" height="${TOP_BANNER_HEIGHT - 2}" rx="10" fill="#0f172a" />
    
    <!-- Title & Subtitle -->
    <text x="36" y="46" fill="#f8fafc" font-size="18" font-weight="bold" letter-spacing="0.5">
      バリエーションツリー (VTA) 分析図 ${includeNotes ? '＆ ノード補足説明' : ''}
    </text>
    <text x="36" y="68" fill="#94a3b8" font-size="11">
      バリエーションツリー分析（Variation Tree Analysis） ｜ 出力日時: ${escapeXML(timestamp)} ${!includeEmptyLanes ? '｜ 空レーン除外モード' : ''}
    </text>

    <!-- Stat Badges (Right aligned) -->
    <g transform="translate(${Math.max(340, totalSVGWidth - 480)}, 30)">
      <!-- Lanes Badge -->
      <rect x="0" y="0" width="80" height="26" rx="6" fill="#1e293b" stroke="#334155" />
      <text x="40" y="17" fill="#cbd5e1" font-size="11" text-anchor="middle">レーン: ${effectiveLanes.length}</text>

      <!-- Nodes Badge -->
      <rect x="88" y="0" width="105" height="26" rx="6" fill="#1e293b" stroke="#334155" />
      <text x="140" y="17" fill="#cbd5e1" font-size="11" text-anchor="middle">ノード: ${vtaData.nodes.length}件</text>

      <!-- Elimination Badge -->
      <rect x="201" y="0" width="105" height="26" rx="6" fill="#064e3b" stroke="#059669" />
      <text x="253" y="17" fill="#6ee7b7" font-size="11" font-weight="bold" text-anchor="middle">○ 排除: ${eliminationCount}件</text>

      <!-- Break Badge -->
      <rect x="314" y="0" width="115" height="26" rx="6" fill="#4c0519" stroke="#e11d48" />
      <text x="371" y="17" fill="#fda4af" font-size="11" font-weight="bold" text-anchor="middle">BREAK: ${breakCount}件</text>
    </g>
  </g>

  <!-- ================= TIME AXIS (LEFT SIDE) ================= -->
  <g id="time-axis" transform="translate(${PADDING - 15}, ${diagramOriginY})">
    <line x1="0" y1="${diagramHeight}" x2="0" y2="10" stroke="#0284c7" stroke-width="2.5" marker-end="url(#arrow-unidirectional)" />
    <!-- Vertical Text -->
    <text x="-10" y="${diagramHeight / 2}" fill="#0369a1" font-size="11" font-weight="bold" text-anchor="middle" transform="rotate(-90, -10, ${diagramHeight / 2})">
      時間経過軸 (BT: 下＝発端 → 上＝不具合事象)
    </text>
  </g>

  <!-- ================= SWIMLANES (BACKGROUND & HEADERS) ================= -->
  <g id="swimlanes">
    ${
      laneBounds && laneBounds.length > 0
        ? laneBounds
            .map((lb) => {
              const svgX = mapX(lb.x);
              const headerY = TOP_BANNER_HEIGHT + PADDING;
              return `
      <!-- Lane: ${escapeXML(lb.name)} -->
      <rect x="${svgX}" y="${headerY}" width="${lb.width}" height="${contentHeight}" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1" />
      <!-- Lane Header -->
      <rect x="${svgX}" y="${headerY}" width="${lb.width}" height="${LANE_HEADER_HEIGHT}" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" />
      <text x="${svgX + lb.width / 2}" y="${headerY + 26}" fill="#1e293b" font-size="13" font-weight="bold" text-anchor="middle">
        ${escapeXML(lb.name)}
      </text>
      <!-- Lane Vertical Center Divider -->
      <line x1="${svgX + lb.width}" y1="${headerY}" x2="${svgX + lb.width}" y2="${headerY + contentHeight}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,4" />
              `;
            })
            .join('')
        : ''
    }
  </g>

  <!-- ================= EDGES (CONNECTIONS & BREAKS) ================= -->
  <g id="vta-edges">
    ${edges
      .map((edge) => {
        const srcNode = nodeMap.get(edge.source);
        const tgtNode = nodeMap.get(edge.target);
        if (!srcNode || !tgtNode) return '';

        const isCrossLane = Boolean(edge.data?.is_cross_lane || Math.abs(srcNode.x - tgtNode.x) > 40);
        const isBreak = Boolean(edge.data?.is_break);
        const direction = edge.data?.direction || (isCrossLane ? 'unidirectional' : 'sequential');

        let sourceX: number;
        let sourceY: number;
        let targetX: number;
        let targetY: number;
        let sourcePosition: string;
        let targetPosition: string;

        if (isCrossLane) {
          // Information Transmission: Connect side-to-side (Left/Right)
          if (srcNode.x < tgtNode.x) {
            // Left lane to Right lane -> Right side of source to Left side of target
            sourceX = srcNode.x + NODE_WIDTH;
            sourceY = srcNode.y + srcNode.height * 0.62;
            targetX = tgtNode.x;
            targetY = tgtNode.y + tgtNode.height * 0.38;
            sourcePosition = 'right';
            targetPosition = 'left';
          } else {
            // Right lane to Left lane -> Left side of source to Right side of target
            sourceX = srcNode.x;
            sourceY = srcNode.y + srcNode.height * 0.62;
            targetX = tgtNode.x + NODE_WIDTH;
            targetY = tgtNode.y + tgtNode.height * 0.38;
            sourcePosition = 'left';
            targetPosition = 'right';
          }
        } else {
          // Intra-lane Sequential Flow: Lower node top center -> Upper node bottom center
          sourceX = srcNode.x + NODE_WIDTH / 2;
          sourceY = srcNode.y;
          targetX = tgtNode.x + NODE_WIDTH / 2;
          targetY = tgtNode.y + tgtNode.height;
          sourcePosition = 'top';
          targetPosition = 'bottom';
        }

        const [pathD, midX, midY] = getOrthogonalStepPath({
          sourceX,
          sourceY,
          targetX,
          targetY,
          sourcePosition,
          targetPosition,
          verticalGap: VERTICAL_GAP,
          sourceNodeHeight: srcNode.height,
          routeOffset: routingOffset(edge.id, edges.filter((item) => item.data?.is_cross_lane)),
          obstacles: Array.from(nodeMap.values()),
        });

        let strokeColor = '#334155';
        let markerAttr = 'marker-end="url(#arrow-sequential)"';
        let strokeDash = '';

        if (isCrossLane) {
          if (direction === 'bidirectional') {
            strokeColor = '#7c3aed';
            markerAttr = 'marker-start="url(#arrow-start-bidirectional)" marker-end="url(#arrow-end-bidirectional)"';
            strokeDash = 'stroke-dasharray="6,4"';
          } else {
            strokeColor = '#0284c7';
            markerAttr = 'marker-end="url(#arrow-unidirectional)"';
            strokeDash = 'stroke-dasharray="6,4"';
          }
        }

        const rawLabel = edge.data?.label || edge.label;
        const customLabel = rawLabel ? escapeXML(String(rawLabel).trim()) : undefined;
        const category = edge.data?.category || (edge as any).category;
        const categoryName = category && category !== 'other'
          ? (category === 'information' ? '情報' : category === 'material' ? '資機材' : category === 'person' ? '人員' : category === 'handover' ? '引継ぎ' : category === 'impact' ? '物理影響' : category === 'sequential' ? '時系列' : '接続')
          : undefined;

        const displayLabel = customLabel || categoryName || (isCrossLane ? (direction === 'bidirectional' ? '相互確認' : '伝達') : undefined);
        const labelText = customLabel && categoryName ? `${customLabel} (${categoryName})` : displayLabel;
        const labelWidth = labelText ? Math.max(50, labelText.length * 10 + 16) : 0;

        return `
      <!-- Edge ${edge.source} -> ${edge.target} -->
      <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="2" ${strokeDash} ${markerAttr} />
      
      ${
        isBreak
          ? `
      <!-- Break Barrier Marker -->
      <g transform="translate(${midX}, ${midY})">
        <rect x="-35" y="-12" width="70" height="24" rx="4" fill="#fff1f2" stroke="#e11d48" stroke-width="1.8" />
        <text x="0" y="4" fill="#be123c" font-size="10" font-weight="bold" text-anchor="middle" letter-spacing="0.5">
          BREAK
        </text>
        <line x1="-15" y1="-10" x2="-15" y2="10" stroke="#e11d48" stroke-width="1.5" />
        <line x1="15" y1="-10" x2="15" y2="10" stroke="#e11d48" stroke-width="1.5" />
      </g>
      ${
        labelText
          ? `
      <!-- Break Associated Label -->
      <g transform="translate(${midX}, ${midY + 22})">
        <rect x="-${labelWidth / 2}" y="-9" width="${labelWidth}" height="18" rx="3" fill="#ffffff" stroke="#94a3b8" stroke-width="0.8" />
        <text x="0" y="4" fill="#334155" font-size="9" font-weight="medium" text-anchor="middle">
          ${labelText}
        </text>
      </g>`
          : ''
      }
          `
          : labelText
          ? `
      <!-- Edge Label Pill -->
      <g transform="translate(${midX}, ${midY})">
        <rect x="-${labelWidth / 2}" y="-10" width="${labelWidth}" height="20" rx="10" fill="#ffffff" stroke="${strokeColor}" stroke-width="1.2" />
        <text x="0" y="4" fill="${strokeColor}" font-size="9.5" font-weight="bold" text-anchor="middle">
          ${labelText}
        </text>
      </g>
          `
          : ''
      }
        `;
      })
      .join('')}
  </g>

  <!-- ================= NODES (VTA CARDS) ================= -->
  <g id="vta-nodes">
    ${nodes
      .map((node) => {
        const svgX = mapX(node.position.x);
        const svgY = mapY(node.position.y);
        const isVariation = node.data?.type === 'variation';
        const isElimination = node.data?.measure_type === 'elimination';
        const hasNote = Boolean(node.data?.supplementary_note?.trim());

        const titleLines = compactTitleLines(node.data?.title || '無題ノード');

        const nodeHeight = nodeMap.get(node.id)?.height ?? (node.measured?.height ?? getNodeHeight(node, _initialNodes));

        // Styling based on Normal (thin) vs Variation (thick bold)
        const boxFill = isVariation ? '#fffbeb' : '#ffffff';
        const boxStroke = isVariation ? '#d97706' : '#1e293b';
        const boxStrokeWidth = isVariation ? '3.5' : '1.5';
        const filterAttr = isVariation ? 'filter="url(#variation-shadow)"' : 'filter="url(#shadow)"';

        return `
      <!-- Node: ${escapeXML(node.id)} -->
      <g id="${escapeXML(node.id)}" transform="translate(${svgX}, ${svgY})">
        <!-- Main Card Box -->
        <rect x="0" y="0" width="${NODE_WIDTH}" height="${nodeHeight}" rx="6" fill="${boxFill}" stroke="${boxStroke}" stroke-width="${boxStrokeWidth}" ${filterAttr} />
        
        <!-- Header Strip: Time & Type Badge -->
        <g transform="translate(10, 18)">
          <text x="0" y="0" fill="#64748b" font-size="10" font-weight="600">
            ${escapeXML(node.data?.time || '時間未設定')}
          </text>
          
          <rect x="${NODE_WIDTH - 90}" y="-11" width="70" height="16" rx="3" fill="${isVariation ? '#fef3c7' : '#f1f5f9'}" stroke="${isVariation ? '#f59e0b' : '#cbd5e1'}" />
          <text x="${NODE_WIDTH - 55}" y="1" fill="${isVariation ? '#b45309' : '#475569'}" font-size="9" font-weight="bold" text-anchor="middle">
            ${isVariation ? '【変動要因】' : '【通常作業】'}
          </text>
        </g>

        <!-- Divider Line inside card -->
        <line x1="10" y1="26" x2="${NODE_WIDTH - 10}" y2="26" stroke="${isVariation ? '#fde68a' : '#e2e8f0'}" stroke-width="1" />

        <!-- Title Text -->
        <text x="12" y="48" fill="#0f172a" font-size="14" font-weight="bold">
          ${titleLines.map((line, idx) => `<tspan x="12" dy="${idx === 0 ? 0 : 20}">${escapeXML(line)}</tspan>`).join('')}
        </text>

        <!-- Elimination Badge (○印 on Top Right) -->
        ${
          isElimination
            ? `
        <g transform="translate(${NODE_WIDTH - 12}, 12)">
          <circle cx="0" cy="0" r="11" fill="#10b981" stroke="#ffffff" stroke-width="2" />
          <text x="0" y="4" fill="#ffffff" font-size="13" font-weight="bold" text-anchor="middle">○</text>
        </g>
            `
            : ''
        }

        <!-- Supplementary Note Indicator Tag (Bottom Right) -->
        ${
          hasNote
            ? `
        <g transform="translate(${NODE_WIDTH - 68}, ${nodeHeight - 18})">
          <rect x="0" y="0" width="58" height="14" rx="3" fill="#e0f2fe" stroke="#0284c7" stroke-width="0.8" />
          <text x="29" y="10" fill="#0369a1" font-size="8.5" font-weight="bold" text-anchor="middle">補足説明あり</text>
        </g>
            `
            : ''
        }
      </g>
        `;
      })
      .join('')}
  </g>

  <!-- ================= RIGHT PANEL: SUPPLEMENTARY NOTES ================= -->
  ${
    includeNotes
      ? `
  <g id="supplementary-notes-panel" transform="translate(${notesX}, ${notesY})">
    <!-- Panel Outer Box -->
    <rect x="0" y="0" width="${NOTES_PANEL_WIDTH}" height="${contentHeight}" rx="8" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" />
    
    <!-- Panel Header Banner -->
    <rect x="0" y="0" width="${NOTES_PANEL_WIDTH}" height="${LANE_HEADER_HEIGHT}" rx="8" fill="#1e293b" />
    <rect x="0" y="${LANE_HEADER_HEIGHT - 8}" width="${NOTES_PANEL_WIDTH}" height="8" fill="#1e293b" />
    <text x="20" y="26" fill="#f8fafc" font-size="13" font-weight="bold">
      ノード補足説明・背景要因（ヒューマンファクタ分析）
    </text>
    <text x="${NOTES_PANEL_WIDTH - 20}" y="26" fill="#94a3b8" font-size="10" text-anchor="end">
      該当ノード数: ${nodesWithNotes.length}件
    </text>

    <!-- Notes Content Items -->
    ${
      noteBlocks.length > 0
        ? noteBlocks
            .map((b) => {
              const relY = b.y - notesY;
              const isVar = b.nodeType === 'variation';

              return `
      <!-- Note Item: ${escapeXML(b.title)} -->
      <g transform="translate(16, ${relY})">
        <rect x="0" y="0" width="${NOTES_PANEL_WIDTH - 32}" height="${b.height}" rx="6" fill="#ffffff" stroke="${isVar ? '#f59e0b' : '#cbd5e1'}" stroke-width="${isVar ? '1.5' : '1'}" filter="url(#shadow)" />
        
        <!-- Header in Card -->
        <g transform="translate(12, 20)">
          <text x="0" y="0" fill="#0f172a" font-size="11.5" font-weight="bold">
            ${b.nodeId ? `[${escapeXML(b.nodeId)}] ` : ''}${escapeXML(b.title)}
          </text>
          
          ${
            b.lane
              ? `<text x="${NOTES_PANEL_WIDTH - 56}" y="0" fill="#64748b" font-size="9.5" text-anchor="end">${escapeXML(b.lane)}</text>`
              : ''
          }
        </g>

        <!-- Divider Line -->
        <line x1="12" y1="28" x2="${NOTES_PANEL_WIDTH - 44}" y2="28" stroke="#f1f5f9" stroke-width="1" />

        <!-- Content Lines -->
        <text x="14" y="44" fill="#334155" font-size="10.5" leading="18">
          ${b.lines.map((l, idx) => `<tspan x="14" dy="${idx === 0 ? 0 : 18}">${escapeXML(l)}</tspan>`).join('')}
        </text>
      </g>
              `;
            })
            .join('')
        : `
      <!-- No Notes Placeholder -->
      <g transform="translate(${NOTES_PANEL_WIDTH / 2}, 150)">
        <text x="0" y="0" fill="#94a3b8" font-size="12" text-anchor="middle">
          （現在ノードへの補足説明テキストは登録されていません）
        </text>
      </g>
        `
    }
  </g>
      `
      : ''
  }

  <!-- ================= BOTTOM LEGEND ================= -->
  <g id="bottom-legend" transform="translate(${diagramOriginX}, ${totalSVGHeight - 48})">
    <rect x="-10" y="-12" width="${Math.min(diagramWidth, totalSVGWidth - diagramOriginX - 20)}" height="32" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" />
    
    <g transform="translate(10, 8)">
      <!-- Normal Node -->
      <rect x="0" y="-8" width="16" height="12" rx="2" fill="#ffffff" stroke="#1e293b" stroke-width="1.2" />
      <text x="22" y="1" fill="#334155" font-size="10">通常作業 (細枠)</text>

      <!-- Variation Node -->
      <rect x="120" y="-8" width="16" height="12" rx="2" fill="#fffbeb" stroke="#d97706" stroke-width="2.5" />
      <text x="142" y="1" fill="#334155" font-size="10">変動要因 (太枠)</text>

      <!-- Elimination Node -->
      <circle cx="250" cy="-2" r="7" fill="#10b981" stroke="#ffffff" stroke-width="1.5" />
      <text x="250" y="2" fill="#ffffff" font-size="9" font-weight="bold" text-anchor="middle">○</text>
      <text x="264" y="1" fill="#334155" font-size="10">排除ノード (○印)</text>

      <!-- Break Barrier -->
      <rect x="380" y="-8" width="34" height="12" rx="2" fill="#fff1f2" stroke="#e11d48" stroke-width="1" />
      <text x="397" y="1" fill="#be123c" font-size="7.5" font-weight="bold" text-anchor="middle">BREAK</text>
      <text x="420" y="1" fill="#334155" font-size="10">ブレイク (遮断)</text>

      <!-- Transmission Arrow -->
      <text x="515" y="1" fill="#0284c7" font-size="10" font-weight="bold">──▶</text>
      <text x="540" y="1" fill="#334155" font-size="10">接続・伝達</text>
    </g>
  </g>

</svg>
`;
}

/**
 * Triggers client-side download of the VTA diagram + supplementary notes as a single SVG file.
 */
export function exportVTAToSVGFile(
  vtaData: VTASchema,
  nodes: VTAReactFlowNode[],
  edges: VTAReactFlowEdge[],
  laneBounds: LayoutResult['laneBounds'],
  options: SVGExportOptions = {}
): { success: boolean; filename: string } {
  try {
    const svgContent = generateVTASVG(vtaData, nodes, edges, laneBounds, options);
    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const defaultFilename = `vta-diagram-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.svg`;
    const filename = options.filename || defaultFilename;

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);
    downloadAnchor.setAttribute('download', filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    URL.revokeObjectURL(url);

    return { success: true, filename };
  } catch (err: unknown) {
    console.error('Failed to export SVG:', err);
    throw err;
  }
}
