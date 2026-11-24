import {it,expect} from 'vitest';
import {parseChainDelta,inspectChainDelta,validateChainRows,applyChainDelta,selectChainDependencies} from './chainRepair';
import {inspectLedger,parseLedger} from './eventLedger';
import {ledgerFixture,ledgerSource} from './eventLedger.fixture';
import {sourceFromText,projectAnalysis} from './eventAnalysis';
import {connectionProposalSignature} from './connectionProposals';
import {useVTAStore} from '../store/vtaStore';
const schema=()=>projectAnalysis(inspectLedger(parseLedger(ledgerFixture()),sourceFromText(ledgerSource)).analysis!);
const text='[追加主体]\n[追加イベント]\ntmp_e\t-\t記録の再確認\t停止後に装置の記録を再確認\tsource_1/p2\trecorded\t原文の記録\n[割当追加]\nP1\ttmp_e\tA2\tactor\tsource_1/p2\t-\n[関係追加]\ntmp_r\tdependency\tE1\tA1\ttmp_e\tA2\tsource_1/p1,source_1/p2\t-\t-\tna\trecorded\t先行状態を使用\n[要確認]\n[完了]';
it('previews dependent additions without mutating the graph and rejects an orphan line selection',()=>{
 const original=schema(),snapshot=JSON.stringify(original),rows=parseChainDelta(text);
 expect(applyChainDelta(original,rows).analysis?.events.some(e=>e.id==='tmp_e')).toBe(true);
 expect(JSON.stringify(original)).toBe(snapshot);
 expect(()=>applyChainDelta(original,rows.filter(r=>r.section==='関係追加'))).toThrow();
 expect(()=>applyChainDelta(original,parseChainDelta(text.replace('source_1/p1,source_1/p2','source_1/missing')))).toThrow('原文');
});
it('adopts all additions as one reversible change through the real store',()=>{
 const s=schema();expect(useVTAStore.getState().importProjectJSON(JSON.stringify({version:'5.0',savedAt:new Date().toISOString(),scenarioText:ledgerSource,vtaData:s})).success).toBe(true);
 const before=useVTAStore.getState().vtaData,signature=connectionProposalSignature(before);
 const applied=applyChainDelta(before,parseChainDelta(text),true);
 useVTAStore.getState().commitVTAChange({schema:applied,preserveDerivedRemovals:true});
 expect(useVTAStore.getState().vtaData.analysis?.events).toHaveLength(3);
 expect(useVTAStore.getState().vtaData.edges.some(e=>e.meaning==='dependency')).toBe(true);
 useVTAStore.getState().undo();expect(connectionProposalSignature(useVTAStore.getState().vtaData)).toBe(signature);
 useVTAStore.getState().redo();expect(useVTAStore.getState().vtaData.analysis?.events).toHaveLength(3);
});
it('rejects incomplete transport and duplicate additions',()=>{
 expect(()=>parseChainDelta(text.replace('[完了]',''))).toThrow();
 expect(()=>applyChainDelta(schema(),parseChainDelta(text.replace('tmp_e\t-','E1\t-')))).toThrow();
});

it('rescues before relations when endpoints are omitted or mismatch, and resolves entities via SubjectPoset',()=>{
 const s=schema();
 // E1 と E2 間に before 関係を追加 (主体列に A1 や未関与主体が書かれていても安全に救済・適用される)
 const beforeDelta = '[追加主体]\n[追加イベント]\n[割当追加]\n[関係追加]\ntmp_b1\tbefore\tE1\tA1\tE2\tA1\tsource_1/p1,source_1/p2\t-\t-\tna\trecorded\t時系列遷移\n[要確認]\n[完了]';
 const applied = applyChainDelta(s, parseChainDelta(beforeDelta));
 expect(applied.analysis?.relations.some(r => r.id === 'tmp_b1')).toBe(true);
 const rel = applied.analysis?.relations.find(r => r.id === 'tmp_b1');
 expect(rel?.kind).toBe('before');
 expect(rel?.sourceEventId).toBe('E1');
 expect(rel?.targetEventId).toBe('E2');
});

it('auto-normalizes non-tmp relation IDs colliding with existing relations or events without mutating event references (ADR-0056)',()=>{
 const s=schema();
 s.analysis!.relations.push({id:'R15',kind:'before',sourceEventId:'E1',targetEventId:'E2',sourceRefs:[{sourceId:'source_1',paragraphId:'p1'}],factIds:[]});
 const delta=[
  '[追加主体]',
  '[追加イベント]',
  'tmp_e2\t-\t事後確認\t確認を実施\tsource_1/p2\trecorded\t原文の記載',
  '[割当追加]',
  'P_assign\ttmp_e2\tA2\tactor\tsource_1/p2\t-',
  '[関係追加]',
  'R15\tbefore\tE1\t-\ttmp_e2\t-\tsource_1/p1,source_1/p2\t-\t-\tna\trecorded\t時間順',
  'E1\tdependency\tE1\tA1\ttmp_e2\tA2\tsource_1/p1,source_1/p2\t-\t-\tna\trecorded\tイベントIDと衝突する関係ID',
  'R15\ttransfer\tE1\tA1\tE2\tA2\tsource_1/p1,source_1/p2\tinformation\toccurred\tconfirmed\trecorded\tセクション内重複ID',
  '[要確認]',
  '[完了]',
 ].join('\n');

 const inspected=inspectChainDelta(delta);
 expect(inspected.issues).toEqual([]);
 expect(inspected.complete).toBe(true);
 const relRows=inspected.rows.filter(r=>r.section==='関係追加');
 expect(relRows.map(r=>r.id)).toEqual(['tmp_R15','tmp_E1','tmp_R15_2']);
 expect(relRows.every((r,i)=>r.cells[0]===relRows[i].id)).toBe(true);

 const checked=validateChainRows(s,inspected.rows);
 expect(checked.issues).toEqual([]);
 const applied=applyChainDelta(s,checked.rows);
 expect(applied.analysis?.relations.some(r=>r.id==='tmp_R15'&&r.sourceEventId==='E1'&&r.targetEventId==='tmp_e2')).toBe(true);
 expect(applied.analysis?.relations.some(r=>r.id==='tmp_E1'&&r.sourceEventId==='E1'&&r.targetEventId==='tmp_e2')).toBe(true);
 expect(applied.analysis?.relations.some(r=>r.id==='tmp_R15_2'&&r.kind==='transfer')).toBe(true);
});

it('accepts existing relation IDs and newly added relation row IDs in [要確認] across both preview and permanent apply (ADR-0064)', () => {
  const s = schema();
  s.analysis!.relations.push({
    id: 'R2',
    kind: 'before',
    sourceEventId: 'E1',
    targetEventId: 'E2',
    sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }, { sourceId: 'source_1', paragraphId: 'p2' }],
    factIds: [],
  });
  const delta = [
    '[追加主体]',
    '[追加イベント]',
    'tmp_e2\t-\t中間事象\t中間の確認を実施\tsource_1/p2\trecorded\t原文記載',
    '[割当追加]',
    'P_chk\ttmp_e2\tA2\tactor\tsource_1/p2\t-',
    '[関係追加]',
    'tmp_rel1\tbefore\tE1\t-\ttmp_e2\t-\tsource_1/p1,source_1/p2\t-\t-\tna\trecorded\t補足順',
    '[要確認]',
    'chk_1\tE1, E2, R2, tmp_e2, tmp_rel1\tsource_1/p1,source_1/p2\tredundant_relation\t既存のR2と新規tmp_rel1の関係整理が必要です。',
    '[完了]',
  ].join('\n');

  const inspected = inspectChainDelta(delta);
  expect(inspected.issues).toEqual([]);
  const checked = validateChainRows(s, inspected.rows);
  expect(checked.issues).toEqual([]);

  const deps = selectChainDependencies(checked.rows, ['要確認/chk_1']);
  expect(deps).toContain('関係追加/tmp_rel1');

  const previewApplied = applyChainDelta(s, checked.rows, false);
  expect(
    previewApplied.analysis?.dispositions?.some(
      (d) => d.kind === 'review' && d.text?.includes('[redundant_relation]') && d.text?.includes('対象: E1')
    )
  ).toBe(true);

  const permanentApplied = applyChainDelta(s, checked.rows, true);
  expect(
    permanentApplied.analysis?.dispositions?.some(
      (d) => d.kind === 'review' && d.text?.includes('[redundant_relation]') && d.text?.includes('対象: E1')
    )
  ).toBe(true);

  const emptyTargets = delta.replace('E1, E2, R2, tmp_e2, tmp_rel1', '-');
  expect(() => applyChainDelta(s, parseChainDelta(emptyTargets), false)).toThrow('要確認の対象がありません');
  const unknownTarget = delta.replace('E1, E2, R2, tmp_e2, tmp_rel1', 'E1,R999');
  expect(() => applyChainDelta(s, parseChainDelta(unknownTarget), false)).toThrow('要確認の対象がありません');

  // When code is generic "review", summary formats clean target IDs/titles without redundant "[review]" prefix
  const genericReviewDelta = delta.replace('\tredundant_relation\t', '\treview\t');
  const genericApplied = applyChainDelta(s, parseChainDelta(genericReviewDelta), true);
  const genericDisp = genericApplied.analysis?.dispositions?.find((d) => d.id.startsWith('review_'));
  expect(genericDisp?.text?.startsWith('対象: E1')).toBe(true);
  expect(genericDisp?.text).not.toContain('[review]');
});
