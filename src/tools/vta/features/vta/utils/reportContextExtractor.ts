import { VTASchema, VTANodeData, EdgeCategory, EdgeDirection } from '../../../types/vta';

export function getEdgeCategoryLabel(category?: EdgeCategory): string | undefined {
  switch (category) {
    case 'information': return '情報';
    case 'material': return '資機材';
    case 'person': return '人員';
    case 'handover': return '引継ぎ';
    case 'impact': return '物理影響';
    case 'sequential': return '時系列';
    case 'other': return 'その他';
    default: return undefined;
  }
}

export interface ReportAnalysisContext {
  eliminationNodes: Array<{
    id: string;
    lane: string;
    time: string;
    title: string;
    description: string;
    supplementaryNote?: string;
    customNotes?: Array<{ title: string; content: string }>;
  }>;
  breakPoints: Array<{
    edgeIndex: number;
    edgeLabel?: string;
    category?: EdgeCategory;
    categoryLabel?: string;
    direction?: EdgeDirection;
    sourceNode: {
      id: string;
      lane: string;
      time: string;
      title: string;
      description: string;
      type: 'normal' | 'variation';
      supplementaryNote?: string;
      customNotes?: Array<{ title: string; content: string }>;
    };
    targetNode: {
      id: string;
      lane: string;
      time: string;
      title: string;
      description: string;
      type: 'normal' | 'variation';
      supplementaryNote?: string;
      customNotes?: Array<{ title: string; content: string }>;
    };
  }>;
  keyConnections?: Array<{
    sourceId: string;
    sourceLane: string;
    sourceTime: string;
    sourceTitle: string;
    targetId: string;
    targetLane: string;
    targetTime: string;
    targetTitle: string;
    direction: EdgeDirection;
    label?: string;
    category?: EdgeCategory;
    categoryLabel?: string;
    isBreak: boolean;
  }>;
  finalEventNodes: Array<{
    id: string;
    lane: string;
    time: string;
    title: string;
    description: string;
    type: 'normal' | 'variation';
    customNotes?: Array<{ title: string; content: string }>;
  }>;
  timelineSummary: Array<{
    id: string;
    time: string;
    lane: string;
    title: string;
    description?: string;
    type: 'normal' | 'variation';
    measureType: string | null;
    supplementaryNote?: string;
    customNotes?: Array<{ title: string; content: string }>;
  }>;
  supplementarySummary?: string;
  generalCustomNotes?: Array<{ title: string; content: string }>;
}

export interface ExtractReportOptions {
  includeNodeDescriptionsInTimeline?: boolean;
  includeCustomNotes?: boolean;
}

/**
 * Extracts essential analysis points (elimination nodes, breaks with surrounding nodes,
 * final event nodes, and minimal timeline summary) from VTA data for Report Generation.
 *
 * Avoids dumping full raw JSON, eliminating layout/canvas noise and preventing
 * token overflow or distraction while fully retaining vital factual evidence (FUNC-001).
 */
export function extractReportAnalysisContext(
  vtaData: VTASchema,
  options: ExtractReportOptions = {}
): ReportAnalysisContext {
  const includeDescInTimeline = options.includeNodeDescriptionsInTimeline !== false;
  const includeNotes = options.includeCustomNotes !== false;

  const nodeMap = new Map<string, VTANodeData>();
  for (const n of vtaData.nodes) {
    nodeMap.set(n.id, n);
  }

  // Group custom notes by nodeId
  const notesByNodeId = new Map<string, Array<{ title: string; content: string }>>();
  const generalNotes: Array<{ title: string; content: string }> = [];

  if (includeNotes && Array.isArray(vtaData.custom_notes)) {
    for (const cn of vtaData.custom_notes) {
      if (cn.nodeId && cn.nodeId.trim().length > 0) {
        const list = notesByNodeId.get(cn.nodeId) || [];
        list.push({ title: cn.title, content: cn.content });
        notesByNodeId.set(cn.nodeId, list);
      } else {
        generalNotes.push({ title: cn.title, content: cn.content });
      }
    }
  }

  // 1. Elimination nodes (variations to be eliminated at the root cause)
  const eliminationNodes = vtaData.nodes
    .filter((n) => n.measure_type === 'elimination')
    .map((n) => ({
      id: n.id,
      lane: n.lane,
      time: n.time || '時刻未指定',
      title: n.title,
      description: n.description || '',
      supplementaryNote: n.supplementary_note,
      customNotes: notesByNodeId.get(n.id),
    }));

  // 2. Break points (edges with is_break: true) with preceding and succeeding nodes
  const breakPoints: ReportAnalysisContext['breakPoints'] = [];
  let breakIndex = 1;
  for (const edge of vtaData.edges) {
    if (edge.is_break) {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (src && tgt) {
        const catLabel = getEdgeCategoryLabel(edge.category);
        breakPoints.push({
          edgeIndex: breakIndex++,
          edgeLabel: edge.label?.trim() || undefined,
          category: edge.category,
          categoryLabel: catLabel,
          direction: edge.direction,
          sourceNode: {
            id: src.id,
            lane: src.lane,
            time: src.time || '時刻未指定',
            title: src.title,
            description: src.description || '',
            type: src.type,
            supplementaryNote: src.supplementary_note,
            customNotes: notesByNodeId.get(src.id),
          },
          targetNode: {
            id: tgt.id,
            lane: tgt.lane,
            time: tgt.time || '時刻未指定',
            title: tgt.title,
            description: tgt.description || '',
            type: tgt.type,
            supplementaryNote: tgt.supplementary_note,
            customNotes: notesByNodeId.get(tgt.id),
          },
        });
      }
    }
  }

  // 3. Key Connections across lanes or with labels/categories
  const keyConnections: ReportAnalysisContext['keyConnections'] = [];
  for (const edge of vtaData.edges) {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) continue;
    const isCrossLane = src.lane !== tgt.lane;
    const hasLabel = Boolean(edge.label?.trim());
    const hasCategory = Boolean(edge.category && edge.category !== 'sequential');
    if (isCrossLane || hasLabel || hasCategory) {
      keyConnections.push({
        sourceId: src.id,
        sourceLane: src.lane,
        sourceTime: src.time || '時刻未指定',
        sourceTitle: src.title,
        targetId: tgt.id,
        targetLane: tgt.lane,
        targetTime: tgt.time || '時刻未指定',
        targetTitle: tgt.title,
        direction: edge.direction || (isCrossLane ? 'unidirectional' : 'sequential'),
        label: edge.label?.trim() || undefined,
        category: edge.category,
        categoryLabel: getEdgeCategoryLabel(edge.category),
        isBreak: Boolean(edge.is_break),
      });
    }
  }

  // 4. Final event nodes (nodes with no outgoing edges, or top-level variation events)
  const sourcesSet = new Set<string>();
  for (const e of vtaData.edges) {
    sourcesSet.add(e.source);
  }
  let terminalNodes = vtaData.nodes.filter((n) => !sourcesSet.has(n.id));
  if (terminalNodes.length === 0 && vtaData.nodes.length > 0) {
    terminalNodes = [vtaData.nodes[vtaData.nodes.length - 1]];
  }
  const finalEventNodes = terminalNodes.map((n) => ({
    id: n.id,
    lane: n.lane,
    time: n.time || '時刻未指定',
    title: n.title,
    description: n.description || '',
    type: n.type,
    customNotes: notesByNodeId.get(n.id),
  }));

  // 5. Timeline summary with optional descriptions & notes
  const timelineSummary = vtaData.nodes.map((n) => ({
    id: n.id,
    time: n.time || '時刻未指定',
    lane: n.lane,
    title: n.title,
    description: includeDescInTimeline ? (n.description || '') : undefined,
    type: n.type,
    measureType: n.measure_type || null,
    supplementaryNote: n.supplementary_note,
    customNotes: notesByNodeId.get(n.id),
  }));

  return {
    eliminationNodes,
    breakPoints,
    keyConnections: keyConnections.length > 0 ? keyConnections : undefined,
    finalEventNodes,
    timelineSummary,
    supplementarySummary: vtaData.supplementary_summary,
    generalCustomNotes: generalNotes.length > 0 ? generalNotes : undefined,
  };
}

/**
 * Formats the extracted ReportAnalysisContext into structured Markdown text
 * to be passed directly into the LLM report generation prompt.
 */
export function formatReportAnalysisContextText(ctx: ReportAnalysisContext): string {
  const sections: string[] = [];
  let sectionIndex = 1;

  // Section 1: Elimination Nodes
  sections.push(`### ${sectionIndex++}. 排除ノード一覧（根本原因・変動要因の発生ポイント）`);
  if (ctx.eliminationNodes.length > 0) {
    sections.push(`計 ${ctx.eliminationNodes.length} 件:`);
    ctx.eliminationNodes.forEach((n, i) => {
      let item = `${i + 1}. **【${n.id}】${n.title}**\n` +
        `   - 担当/関係者（レーン）: ${n.lane}\n` +
        `   - 時刻/時期: ${n.time}\n` +
        `   - 事象内容: ${n.description}\n` +
        `   - 対策種別: 根本排除 (Elimination - この変動要因自体の発生を未然に防ぐポイント)`;
      if (n.supplementaryNote?.trim()) {
        item += `\n   - 補足事実: ${n.supplementaryNote.trim()}`;
      }
      if (n.customNotes && n.customNotes.length > 0) {
        item += `\n   - 付箋メモ: ` + n.customNotes.map((cn) => `[${cn.title}] ${cn.content}`).join(' / ');
      }
      sections.push(item);
    });
  } else {
    sections.push(`※指定されている排除ノードはありません。`);
  }
  sections.push('');

  // Section 2: Break Points
  sections.push(`### ${sectionIndex++}. ブレーク一覧（連鎖遮断・検出・介入・リカバリーポイント）`);
  if (ctx.breakPoints.length > 0) {
    sections.push(`計 ${ctx.breakPoints.length} 箇所:`);
    ctx.breakPoints.forEach((b) => {
      const srcType = b.sourceNode.type === 'variation' ? '変動要因' : '通常作業';
      const tgtType = b.targetNode.type === 'variation' ? '変動要因' : '通常作業';
      const edgeMeta: string[] = [];
      if (b.edgeLabel) edgeMeta.push(`ラベル: 「${b.edgeLabel}」`);
      if (b.categoryLabel) edgeMeta.push(`分類: ${b.categoryLabel}`);
      const edgeMetaStr = edgeMeta.length > 0 ? ` (${edgeMeta.join(', ')})` : '';

      let item = `**【ブレーク ${b.edgeIndex}】**\n` +
        `   - 先行事象（前ノード: ${b.sourceNode.id}）: 【${b.sourceNode.lane}】${b.sourceNode.title} (${b.sourceNode.time}) [${srcType}]\n` +
        `     - 内容: ${b.sourceNode.description}\n` +
        `   - ──[ BREAK: 連鎖の遮断 / 確認・停止・介入・リカバリー${edgeMetaStr} ]──▶\n` +
        `   - 後続事象（後ノード: ${b.targetNode.id}）: 【${b.targetNode.lane}】${b.targetNode.title} (${b.targetNode.time}) [${tgtType}]\n` +
        `     - 内容: ${b.targetNode.description}\n` +
        `   - 役割: 前ノードから後ノードへの悪影響の伝播を遮断し、検出・確認・停止・リカバリーを図る防護壁`;
      if (b.sourceNode.supplementaryNote?.trim()) {
        item += `\n     - 前ノード補足: ${b.sourceNode.supplementaryNote.trim()}`;
      }
      if (b.sourceNode.customNotes && b.sourceNode.customNotes.length > 0) {
        item += `\n     - 前ノード付箋メモ: ` + b.sourceNode.customNotes.map((cn) => `[${cn.title}] ${cn.content}`).join(' / ');
      }
      if (b.targetNode.supplementaryNote?.trim()) {
        item += `\n     - 後ノード補足: ${b.targetNode.supplementaryNote.trim()}`;
      }
      if (b.targetNode.customNotes && b.targetNode.customNotes.length > 0) {
        item += `\n     - 後ノード付箋メモ: ` + b.targetNode.customNotes.map((cn) => `[${cn.title}] ${cn.content}`).join(' / ');
      }
      sections.push(item);
    });
  } else {
    sections.push(`※指定されているブレークはありません。`);
  }
  sections.push('');

  // Section 3: Final Event Nodes
  sections.push(`### ${sectionIndex++}. 最終事象（ツリーの終点・結果事象）`);
  ctx.finalEventNodes.forEach((fn, i) => {
    let item = `${i + 1}. **【${fn.id}】${fn.title}** (${fn.lane}, ${fn.time})\n` +
      `   - 詳細: ${fn.description}`;
    if (fn.customNotes && fn.customNotes.length > 0) {
      item += `\n   - 付箋メモ: ` + fn.customNotes.map((cn) => `[${cn.title}] ${cn.content}`).join(' / ');
    }
    sections.push(item);
  });
  sections.push('');

  // Section 4: Timeline Summary
  sections.push(`### ${sectionIndex++}. 時系列要約（通常作業と変動要因の遷移）`);
  ctx.timelineSummary.forEach((t, i) => {
    const typeLabel = t.type === 'variation' ? '★変動要因' : '通常作業';
    const measureLabel = t.measureType === 'elimination' ? ' [排除指定]' : '';
    let line = `${i + 1}. [${t.time}] 【${t.lane}】${t.title} (${typeLabel}${measureLabel})`;
    if (t.description?.trim()) {
      line += ` - ${t.description.trim()}`;
    }
    if (t.supplementaryNote?.trim()) {
      line += ` (※補足: ${t.supplementaryNote.trim()})`;
    }
    sections.push(line);
  });

  // Section 5: Key Connections across lanes / categories
  if (ctx.keyConnections && ctx.keyConnections.length > 0) {
    sections.push('');
    sections.push(`### ${sectionIndex++}. レーン間接続・伝達一覧（関係者間のやり取り・影響関係）`);
    sections.push(`※接続・伝達は関係者間の連携・受渡しを示す客観的事実であり、因果関係を自動断定するものではありません。`);
    sections.push(`計 ${ctx.keyConnections.length} 件:`);
    ctx.keyConnections.forEach((c, i) => {
      const dirArrow = c.direction === 'bidirectional' ? '◀──(相互確認)──▶' : '──────▶';
      const labelDesc = c.label ? `「${c.label}」` : '';
      const catDesc = c.categoryLabel ? `[分類: ${c.categoryLabel}]` : '';
      const breakDesc = c.isBreak ? ' (※ブレーク適用箇所)' : '';
      const connMeta = [labelDesc, catDesc].filter(Boolean).join(' ');
      sections.push(
        `${i + 1}. 【${c.sourceLane}】${c.sourceTitle} (${c.sourceId}) ` +
        `${dirArrow}${connMeta ? ` ${connMeta} ` : ' '}【${c.targetLane}】${c.targetTitle} (${c.targetId})${breakDesc}`
      );
    });
  }

  // Section 6: Overall Background & Premise
  if (ctx.supplementarySummary?.trim()) {
    sections.push('');
    sections.push(`### ${sectionIndex++}. 全体前提・背景\n${ctx.supplementarySummary.trim()}`);
  }

  // Section 7: General Hearing / Custom Notes (not bound to a single node)
  if (ctx.generalCustomNotes && ctx.generalCustomNotes.length > 0) {
    sections.push('');
    sections.push(`### ${sectionIndex++}. 現場ヒアリング・追加付箋メモ（全体事項）`);
    ctx.generalCustomNotes.forEach((gn, i) => {
      sections.push(`${i + 1}. **${gn.title}**: ${gn.content}`);
    });
  }

  return sections.join('\n');
}
