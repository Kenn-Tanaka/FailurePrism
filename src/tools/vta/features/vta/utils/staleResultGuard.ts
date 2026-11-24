import type { VTASchema } from '../../../types/vta';
import { computeVTADataHash } from './hash';

/**
 * Semantic fingerprint of the diagram content used to detect user edits made while a long-running
 * AI operation was in flight. Coordinates are excluded (see computeVTADataHash), so DOM-measurement
 * position syncs and plain drags do not count as content changes.
 */
export function vtaContentFingerprint(schema: VTASchema): string {
  return computeVTADataHash(schema);
}

export type StaleResultDecision = 'unchanged' | 'apply' | 'discard';

/**
 * Decides how to handle an AI result computed from a diagram that may have been edited meanwhile.
 * - unchanged: content is identical to the start of the operation; apply silently.
 * - apply / discard: content changed; the user chooses whether the result may overwrite the edits.
 */
export function resolveStaleResult(
  startFingerprint: string,
  current: VTASchema,
  operationLabel: string,
  confirmFn: (message: string) => boolean = (message) =>
    typeof globalThis.confirm === 'function' ? Boolean(globalThis.confirm(message)) : false
): StaleResultDecision {
  if (vtaContentFingerprint(current) === startFingerprint) return 'unchanged';
  return confirmFn(
    `${operationLabel}の実行中に図が編集されました。\n` +
      `結果を適用すると、実行中に行った編集は失われます（Ctrl+Z で適用前に戻せます）。\n\n` +
      `OK: 結果を適用する / キャンセル: 結果を破棄して現在の図を保持する`
  )
    ? 'apply'
    : 'discard';
}
