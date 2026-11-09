import { it,expect } from 'vitest';
import { inspectLedger,parseLedger,ledgerRepairInput,applyLedgerRepair } from './eventLedger';
import { sourceFromText,validateSavedAnalysis,projectAnalysis } from './eventAnalysis';
import { graphDiagnostics } from './graphDiagnostics';
const source=sourceFromText('システム部門が試験前確認を完了した。\n通電試験中に搭載機器が破損した。');
const base='[主体]\nA1\tシステム部門\torganization\n[イベント]\nE1\t-\t試験前確認完了\tシステム部門が試験前確認を完了した\tA1:actor\tp1\trecorded\nE2\t-\t機器破損\t通電試験中に搭載機器が破損した\tA1:affected\tp2\trecorded\n[関係]\n[共有カード]\n[整理]\n';
it('retains the loss independently from preparation, including saved evidence',()=>{
 const a=inspectLedger(parseLedger(base+'[帰結]\nO1\tidentified\tE2\tp2\t通電試験中の機器破損が損失\n[完了]'),source).analysis!;
 expect(a.events).toHaveLength(2);expect(a.outcome?.eventIds).toEqual(['E2']);
 expect(validateSavedAnalysis(JSON.parse(JSON.stringify(a))).outcome).toEqual(a.outcome);
});
it('rejects an outcome reference missing from the event table and sends the loss paragraph for repair',()=>{
 const doc=parseLedger(base+'[帰結]\nO1\tidentified\tE9\tp2\t破損\n[完了]');
 const result=inspectLedger(doc,source);expect(result.analysis).toBeUndefined();expect(result.issues[0].row.section).toBe('帰結');
 expect(ledgerRepairInput(doc,result.issues,source)).toContain('[p2] 通電試験中に搭載機器が破損した。');
});
it('does not certify connectivity as a successful outcome extraction when the table is absent',()=>{
 const a=inspectLedger(parseLedger(base+'[完了]'),source).analysis!;
 const s=projectAnalysis(a);s.analysis!.context={selectedTargetEventIds:['E1']};
 expect(graphDiagnostics(s).outcomeUnchecked).toBe(true);expect(graphDiagnostics(s).complete).toBe(false);
});
it('preserves an unassigned loss and distinguishes it from no recorded loss',()=>{
 const a=inspectLedger(parseLedger(base.replace('A1:affected','-')+'[帰結]\nO1\tidentified\tE2\tp2\t機器破損、対応主体は要確認\n[完了]'),source).analysis!;
 expect(a.unassignedEventIds).toContain('E2');expect(a.outcome?.status).toBe('identified');expect(graphDiagnostics(projectAnalysis(a)).complete).toBe(false);
 const none=inspectLedger(parseLedger(base+'[帰結]\nO1\tnot_found\t-\t-\t帰結を確認できないとの応答\n[完了]'),source).analysis!;
 expect(none.outcome?.status).toBe('not_found');expect(graphDiagnostics(projectAnalysis(none)).outcomeUnchecked).toBe(true);
});

it('merges multiple outcome rows deterministically with warning and preserves both events and citations', () => {
  const multiOutcome = base + '[帰結]\nO1\tidentified\tE1\tp1\t確認完了\nO2\tidentified\tE2\tp2\t機器破損\n[完了]';
  const result = inspectLedger(parseLedger(multiOutcome), source);
  expect(result.issues).toEqual([]);
  expect(result.warnings?.some((w) => w.includes('統合しました'))).toBe(true);
  expect(result.analysis?.outcome).toEqual({
    status: 'identified',
    eventIds: ['E1', 'E2'],
    sourceRefs: [
      { sourceId: 'source_1', paragraphId: 'p1' },
      { sourceId: 'source_1', paragraphId: 'p2' },
    ],
    reason: '確認完了 / 機器破損',
  });
});

it('swaps inverted eventId and sourceRef in outcome row with warning', () => {
  // Column 3 is p2 (sourceRef), Column 4 is E2 (eventId)
  const invertedOutcome = base + '[帰結]\nO1\tidentified\tp2\tE2\t機器破損\n[完了]';
  const result = inspectLedger(parseLedger(invertedOutcome), source);
  expect(result.issues).toEqual([]);
  expect(result.warnings?.some((w) => w.includes('列順（イベントIDと原文参照）を自動補正しました'))).toBe(true);
  expect(result.analysis?.outcome).toEqual({
    status: 'identified',
    eventIds: ['E2'],
    sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
    reason: '機器破損',
  });
});

it('inspects outcome syntax even when earlier event section has an issue (early validation)', () => {
  // Bad event actor role, plus bad outcome referencing undefined event E99
  const doc = parseLedger(base.replace('A1:actor', 'A1:bad_role') + '[帰結]\nO1\tidentified\tE99\tp2\t破損\n[完了]');
  const result = inspectLedger(doc, source);
  expect(result.issues.some((i) => i.row.section === 'イベント')).toBe(true);
  // Outcome issue must be captured on the first pass
  expect(result.issues.some((i) => i.row.section === '帰結')).toBe(true);
});

it('allows LLM to consolidate multiple outcome repair targets into a single row or prune redundant rows without deadlock', () => {
  // Doc with two outcome targets that both reference undefined event
  const doc = parseLedger(base + '[帰結]\nO1\tidentified\tE99\tp1\t未定義1\nO2\tidentified\tE98\tp2\t未定義2\n[完了]');
  const result = inspectLedger(doc, source);
  expect(result.issues.map((i) => i.row.id)).toEqual(['O1', 'O2']);

  // Case 1: LLM consolidates into single valid row O1
  const consolidated = applyLedgerRepair(doc, result.issues, '[帰結]\nO1\tidentified\tE1,E2\tp1,p2\t統合帰結\n[完了]');
  expect(consolidated.rows.filter((r) => r.section === '帰結')).toHaveLength(1);
  const validated1 = inspectLedger(consolidated, source);
  expect(validated1.issues).toEqual([]);
  expect(validated1.analysis?.outcome?.eventIds).toEqual(['E1', 'E2']);

  // Case 2: One outcome is already valid (O1), second (O2) was invalid and LLM prunes (deletes) O2 from repair response
  const docWithOneValid = parseLedger(base + '[帰結]\nO1\tidentified\tE1\tp1\t正常\nO2\tidentified\tE99\tp2\t不正\n[完了]');
  const res2 = inspectLedger(docWithOneValid, source);
  expect(res2.issues.map((i) => i.row.id)).toEqual(['O2']);
  // LLM returns empty/no outcome rows to prune O2
  const pruned = applyLedgerRepair(docWithOneValid, res2.issues, '[完了]');
  expect(pruned.rows.filter((r) => r.section === '帰結')).toHaveLength(1);
  expect(pruned.rows.find((r) => r.section === '帰結')?.id).toBe('O1');
  const validated2 = inspectLedger(pruned, source);
  expect(validated2.issues).toEqual([]);
});
