import type { VTASource, VTASubjectiveNotice } from '../../../types/vta';

/**
 * Dictionary of evaluative / blame-implying expressions. A plain phrase match: context-dependent false
 * positives are possible, so source hits are only recorded (never blocking) and generated-text hits
 * are handled as row-level repair targets by the callers.
 */
export const SUBJECTIVE_PHRASES: readonly string[] = [
  '誤って', '誤認', '誤解', '誤判断', '誤操作', '勘違い', '思い込', '見落と', '見誤', '怠っ', '怠慢',
  '不注意', 'うっかり', '失念', '軽率', '不適切に', 'ミスを', 'ミスした', '過失', '落ち度', '責任を',
];

export interface SubjectiveHit { phrase: string; index: number; }

/** Remove 「…」 and 『…』 spans so quoted statements are not treated as the narrator's judgment. */
export function stripQuotedSpans(text: string): string {
  return text.replace(/「[^「」]*」/g, (m) => '　'.repeat(m.length)).replace(/『[^『』]*』/g, (m) => '　'.repeat(m.length));
}

export function findSubjectiveExpressions(text: string): SubjectiveHit[] {
  const hits: SubjectiveHit[] = [];
  for (const phrase of SUBJECTIVE_PHRASES) {
    let from = 0;
    for (let at = text.indexOf(phrase, from); at !== -1; at = text.indexOf(phrase, from)) {
      hits.push({ phrase, index: at });
      from = at + phrase.length;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Scan the immutable source. Quoted text is included: recording must not depend on the LLM. */
export function scanSource(source: VTASource): VTASubjectiveNotice[] {
  const notices: VTASubjectiveNotice[] = [];
  for (const paragraph of source.paragraphs) {
    const phrases = [...new Set(findSubjectiveExpressions(paragraph.text).map((hit) => hit.phrase))];
    for (const phrase of phrases) {
      notices.push({
        id: `S${notices.length + 1}`,
        sourceRefs: [{ sourceId: source.id, paragraphId: paragraph.id }],
        phrase,
        eventIds: [],
        detectedBy: 'app',
      });
    }
  }
  return notices;
}

/** Generated narrative text. A claim may keep evaluative words only inside a quoted statement. */
export function scanGeneratedText(
  text: string,
  recordKind: 'recorded' | 'claim' | 'assessment' | 'assumption' = 'recorded'
): SubjectiveHit[] {
  return findSubjectiveExpressions(recordKind === 'claim' ? stripQuotedSpans(text) : text);
}
