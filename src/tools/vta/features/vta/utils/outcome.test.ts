import { it,expect } from 'vitest';
import { inspectLedger,parseLedger,ledgerRepairInput } from './eventLedger';
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
