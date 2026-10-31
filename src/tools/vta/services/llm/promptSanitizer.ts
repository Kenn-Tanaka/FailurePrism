import { LEDGER_HEADERS } from '../../features/vta/utils/eventLedger';
import type { VTASource } from '../../types/vta';

/** Ledger section names plus the terminator: a source line must never be able to imitate them. */
export const RESERVED_TAGS: readonly string[] = [...Object.keys(LEDGER_HEADERS), '完了'];

const reservedPattern = new RegExp(`\\[(${RESERVED_TAGS.join('|')})\\]`, 'g');

/**
 * Mechanical sanitization of one source paragraph for the LLM-bound view only.
 * Intentionally no NFKC and no quote rewriting: the original wording must survive.
 */
export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(reservedPattern, '［$1］')
    .replace(/`{3,}/g, (m) => '｀'.repeat(m.length));
}

/** `[p1] text` lines for the LLM. Paragraph ids are shared with the unmodified source. */
export function sanitizedParagraphs(source: VTASource): string {
  return source.paragraphs.map((part) => '[' + part.id + '] ' + sanitizeForPrompt(part.text)).join('\n');
}
