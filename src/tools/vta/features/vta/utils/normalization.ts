import { readSourceRefs } from './eventLedger';
import type { VTASource, VTASourceDisposition } from '../../../types/vta';

export function validateDispositions(raw: unknown, sources: VTASource[]): VTASourceDisposition[] {
  if (!Array.isArray(raw)) throw new Error('背景・除外一覧が配列ではありません。');
  const ids = new Set<string>();
  return raw.map((item) => {
    if (item && typeof item === 'object' && item.sourceRefs !== undefined) {
      const sourceRefs = readSourceRefs(item.sourceRefs, sources);
      if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) || !['background', 'excluded', 'review'].includes(item.kind)
        || typeof item.reason !== 'string' || !item.reason.trim() || typeof item.text !== 'string' || !item.text.trim()) throw new Error('背景・除外記録が不正です。');
      ids.add(item.id);
      return { id: item.id, kind: item.kind, text: item.text, reason: item.reason, sourceRefs, ...sourceRefs[0], quote: '' };
    }
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || !['background', 'excluded', 'review'].includes(item.kind) || typeof item.reason !== 'string' || !item.reason.trim()
      || typeof item.quote !== 'string' || !item.quote.trim()) throw new Error('背景・除外記録が不正です。');
    const paragraph = sources.find((source) => source.id === item.sourceId)?.paragraphs.find((part) => part.id === item.paragraphId);
    if (!paragraph?.text.includes(item.quote)) throw new Error(`背景・除外 ${item.id} の引用が原文と一致しません。`);
    ids.add(item.id);
    return { id: item.id, sourceId: item.sourceId, paragraphId: item.paragraphId, quote: item.quote, kind: item.kind, reason: item.reason };
  });
}

