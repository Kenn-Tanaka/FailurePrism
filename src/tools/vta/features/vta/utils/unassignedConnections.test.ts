import {describe,it,expect} from 'vitest';
import {wiringUnassignedFixture} from './wiringUnassigned.fixture';
import {proposalContext,proposalSourceRows} from '../../../services/generation/proposalContext';
import {applyChainDelta,parseChainDelta,selectChainDependencies} from './chainRepair';
import {assignUnassignedEvent,confirmProvisionalEntity} from './unassignedEvents';
import {graphDiagnostics} from './graphDiagnostics';
import {validateSavedAnalysis} from './eventAnalysis';
import {validateAndSanitizeProjectFile} from './schemaValidator';
import {extractReportAnalysisContext,formatReportAnalysisContextText} from './reportContextExtractor';
import {generateVTASVG} from './svgExport';
import {calculateVTALayout} from './layout';
import {useVTAStore} from '../store/vtaStore';

const delta='[追加主体]\n[追加イベント]\n[割当追加]\nP7\tE7\tA2\tactor\tsource_1/p6,source_1/p7\tinferred\nP8\tE8\tA2\taffected\tsource_1/p7\tinferred\n[関係追加]\ntmp_dep\tdependency\tE5\tA3\tE7\tA2\tsource_1/p5,source_1/p7\t-\t-\tna\tsource-context\t結線結果に対する後工程の通電試験\n[要確認]\n[完了]';
describe('unassigned wiring/energization regression',()=>{
 it('retains unassigned outcomes in context and labels p7 only with E7/E8',()=>{
  const schema=wiringUnassignedFixture(),input=proposalContext(schema);
  expect(graphDiagnostics(schema).unassigned).toEqual(['E7','E8']);
  expect(input.text).toContain('E7');expect(input.text).toContain('unassigned');
  expect(proposalSourceRows(schema).find(p=>p.ref==='source_1/p7')?.eventIds).toEqual(['E7','E8']);
  expect(input.text).not.toContain('source_1/p7\tE6');
 });
 it('cannot apply an orphan relation but can jointly adopt its existing-event assignment with provenance',()=>{
  const schema=wiringUnassignedFixture(),rows=parseChainDelta(delta),before=JSON.stringify(schema);
  expect(()=>applyChainDelta(schema,rows.filter(r=>r.section==='関係追加'))).toThrow();
  const selected=selectChainDependencies(rows,['関係追加/tmp_dep']);expect(selected).toContain('割当追加/P7');expect(selected).not.toContain('割当追加/P8');
  const next=applyChainDelta(schema,rows,true);
  expect(next.analysis?.events).toHaveLength(8);expect(next.analysis?.outcome?.eventIds).toEqual(['E8']);
  expect(next.edges.some(e=>e.meaning==='dependency')).toBe(true);expect(next.analysis?.unassignedEventIds).toEqual([]);
  expect(validateSavedAnalysis(next.analysis).participations.find(p=>p.eventId==='E7')).toMatchObject({inferred:true});
  expect(validateAndSanitizeProjectFile({version:'5.0',vtaData:next}).isValid).toBe(true);
  const context=extractReportAnalysisContext(next),report=formatReportAnalysisContextText(context);
  expect(report).toContain('文脈からの判断');expect(report).toContain('原文明示ではない');
  const layout=calculateVTALayout(next);expect(generateVTASVG(next,layout.nodes,layout.edges,layout.laneBounds)).toContain('主体は推定');
  expect(JSON.stringify(schema)).toBe(before);
 });
 it('makes provisional lanes only through an explicit action, and does not mark them complete',()=>{
  const original=wiringUnassignedFixture();expect(original.analysis?.entities.some(e=>e.resolution)).toBe(false);
  const next=assignUnassignedEvent(original,'E7',undefined,'actor'),entity=next.analysis!.entities.find(e=>e.resolution)!;
  expect(graphDiagnostics(next).provisional).toEqual([entity.id]);expect(graphDiagnostics(next).complete).toBe(false);
  expect(()=>confirmProvisionalEntity(next,entity.id,entity.name)).toThrow('名称');
  const confirmed=confirmProvisionalEntity(next,entity.id,'試験実施チーム');
  expect(graphDiagnostics(confirmed).provisional).toEqual([]);expect(confirmed.lanes).not.toContain(entity.name);
  expect(confirmed.analysis?.participations.find(p=>p.eventId==='E7')?.evidenceBasis).toBe('user');
 });
 it('adds a missing trial without replacing the extracted overvoltage or outcome',()=>{
  const original=wiringUnassignedFixture();
  const trial=delta.replace('[追加イベント]\n','[追加イベント]\ntmp_trial\t-\t通電試験の実施\t通電試験を実施した\tsource_1/p7\trecorded\t試験時という原文表現\n').replace('[割当追加]\n','[割当追加]\nPT\ttmp_trial\tA2\tactor\tsource_1/p6,source_1/p7\tinferred\n').replace('E5\tA3\tE7\tA2','E5\tA3\ttmp_trial\tA2').replace('[関係追加]\n','[関係追加]\ntmp_before\tbefore\ttmp_trial\t-\tE7\t-\tsource_1/p7\t-\t-\tna\trecorded\t試験実施中の印加\n');
  const next=applyChainDelta(original,parseChainDelta(trial));
  expect(next.analysis?.events).toHaveLength(9);
  for(const id of ['E7','E8'])expect(next.analysis?.events.find(e=>e.id===id)).toMatchObject(original.analysis!.events.find(e=>e.id===id)!);
  const deps=selectChainDependencies(parseChainDelta(trial),['関係追加/tmp_dep']);
  expect(deps).toContain('追加イベント/tmp_trial');expect(deps).toContain('割当追加/PT');
 });
 it('preserves outcome and assignment changes through one Undo/Redo',()=>{
  const schema=wiringUnassignedFixture();useVTAStore.getState().importProjectJSON(JSON.stringify({version:'5.0',scenarioText:schema.analysis!.sources[0].text,vtaData:schema}));
  const original=useVTAStore.getState().vtaData;
  useVTAStore.getState().commitVTAChange({schema:applyChainDelta(original,parseChainDelta(delta),true),preserveDerivedRemovals:true});
  useVTAStore.getState().undo();expect(useVTAStore.getState().vtaData.analysis?.unassignedEventIds).toEqual(['E7','E8']);
  useVTAStore.getState().redo();expect(useVTAStore.getState().vtaData.analysis?.unassignedEventIds).toEqual([]);
 });
 it('rejects malformed assignment output and unsupported references',()=>{
  expect(()=>parseChainDelta(delta.replace('source_1/p6,source_1/p7\tinferred','source_1/p6,source_1/p7\tinferred\textra'))).toThrow('列数');
  expect(()=>applyChainDelta(wiringUnassignedFixture(),parseChainDelta(delta.replace('source_1/p6,source_1/p7','source_1/missing')))).toThrow('原文');
 });
 it('retains manual visibility, positions and BREAK while adopting assignments',()=>{
  const schema=wiringUnassignedFixture();schema.presentation={lanes:{A1:'hide'},suppressedCards:{}};
  schema.nodes[0].position={x:20,y:30};schema.edges[0]={...schema.edges[0],is_break:true};
  const next=applyChainDelta(schema,parseChainDelta(delta));
  expect(next.presentation?.lanes.A1).toBe('hide');expect(next.nodes.find(n=>n.id===schema.nodes[0].id)?.position).toEqual({x:20,y:30});
  expect(next.edges.some(e=>e.source===schema.edges[0].source&&e.target===schema.edges[0].target&&e.is_break)).toBe(true);
 });
 it('rejects malformed inference flags',()=>{
  const next=applyChainDelta(wiringUnassignedFixture(),parseChainDelta(delta));
  const invalid=structuredClone(next.analysis!);(invalid.participations.find(p=>p.eventId==='E7') as unknown as {inferred:unknown}).inferred='yes';
  expect(()=>validateSavedAnalysis(invalid)).toThrow('推定表示');
 });
});
