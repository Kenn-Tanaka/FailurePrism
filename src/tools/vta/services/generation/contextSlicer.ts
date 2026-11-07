import type { VTAAnalysisData, VTASource } from '../../types/vta';
import { sanitizedParagraphs, sanitizeForPrompt } from '../llm/promptSanitizer';

export interface ProposalSourceRow {
  ref: string;
  eventIds: string[];
  purpose: 'direct' | 'context';
  text: string;
}

/**
 * Slices a VTASource into a prompt-safe paragraph table bounded by maxChars.
 * Preserves the full source when within maxChars; otherwise extracts header paragraphs (p1-p3)
 * and paragraphs directly referenced by extracted events or outcomes.
 */
export function sliceRelevantSourceParagraphs(
  source: VTASource,
  analysis: VTAAnalysisData,
  maxChars = 15000
): string {
  const fullText = sanitizedParagraphs(source);
  if (fullText.length <= maxChars) {
    return fullText;
  }

  const referencedParagraphIds = new Set<string>();
  for (const ev of analysis.events) {
    for (const ref of ev.sourceRefs ?? []) {
      if (ref.sourceId === source.id || !ref.sourceId) {
        referencedParagraphIds.add(ref.paragraphId);
      }
    }
  }
  for (const ref of analysis.outcome?.sourceRefs ?? []) {
    if (ref.sourceId === source.id || !ref.sourceId) {
      referencedParagraphIds.add(ref.paragraphId);
    }
  }
  for (const disp of analysis.dispositions ?? []) {
    if (disp.kind === 'excluded') continue;
    for (const ref of disp.sourceRefs ?? []) {
      if (ref.sourceId === source.id || !ref.sourceId) {
        referencedParagraphIds.add(ref.paragraphId);
      }
    }
  }

  const selectedParagraphs: VTASource['paragraphs'] = [];
  let currentChars = 0;

  for (let i = 0; i < source.paragraphs.length; i++) {
    const p = source.paragraphs[i];
    const isDirect = referencedParagraphIds.has(p.id);
    const isHeader = i < 3;

    if (isDirect || isHeader) {
      const line = `[${p.id}] ${sanitizeForPrompt(p.text)}`;
      if (currentChars + line.length > maxChars && selectedParagraphs.length > 0) {
        break;
      }
      selectedParagraphs.push(p);
      currentChars += line.length + 1;
    }
  }

  const result = selectedParagraphs
    .map((p: VTASource['paragraphs'][number]) => `[${p.id}] ${sanitizeForPrompt(p.text)}`)
    .join('\n');
  return (
    result +
    `\n※（原文長大につき、抽出イベント・帰結に直接関連する主要段落（約${currentChars}文字）を抜粋提示しています）`
  );
}

/**
 * Adaptively filters source rows for downstream proposal stages (connectionProposal / chainRepair)
 * when the raw source text exceeds maxChars.
 * Retains all direct reference rows first, plus header rows and immediate neighbor rows within budget.
 */
export function sliceProposalSourceRows(
  rows: ProposalSourceRow[],
  maxChars = 25000
): ProposalSourceRow[] {
  const totalChars = rows.reduce((sum, r) => sum + r.text.length, 0);
  if (totalChars <= maxChars) {
    return rows;
  }

  const directIndices = new Set<number>();
  const neighborIndices = new Set<number>();

  rows.forEach((row, idx) => {
    if (row.purpose === 'direct' || row.eventIds.length > 0) {
      directIndices.add(idx);
      if (idx > 0) neighborIndices.add(idx - 1);
      if (idx + 1 < rows.length) neighborIndices.add(idx + 1);
    }
  });

  const keptIndices = new Set<number>();
  let usedChars = 0;

  // Pass 1: Always include direct reference paragraphs first (up to maxChars)
  for (const idx of directIndices) {
    const len = rows[idx].text.length;
    if (usedChars + len <= maxChars || keptIndices.size === 0) {
      keptIndices.add(idx);
      usedChars += len;
    }
  }

  // Pass 2: Include header paragraphs (first 3) for global context
  for (let idx = 0; idx < Math.min(3, rows.length); idx++) {
    if (keptIndices.has(idx)) continue;
    const len = rows[idx].text.length;
    if (usedChars + len <= maxChars) {
      keptIndices.add(idx);
      usedChars += len;
    }
  }

  // Pass 3: Include immediate neighbor context paragraphs if budget remains
  for (const idx of neighborIndices) {
    if (keptIndices.has(idx)) continue;
    const len = rows[idx].text.length;
    if (usedChars + len <= maxChars) {
      keptIndices.add(idx);
      usedChars += len;
    }
  }

  return rows.filter((_, idx) => keptIndices.has(idx));
}
