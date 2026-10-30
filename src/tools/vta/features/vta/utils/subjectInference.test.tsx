import React from 'react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {extractEventDraft} from '../../../services/llm/client';
import {SUBJECT_INFERENCE_POLICY} from '../../../services/llm/contextEvidencePolicy';
import {sourceFromText,validateSavedAnalysis,projectAnalysis} from './eventAnalysis';
import {parseLedger,inspectLedger,applyLedgerRepair} from './eventLedger';
import {evidenceNotes} from './evidenceNotes';
import {isSubjectInferred} from './subjectInference';
import {extractReportAnalysisContext,formatReportAnalysisContextText} from './reportContextExtractor';
import {generateVTASVG} from './svgExport';
import {calculateVTALayout} from './layout';
import {EventReviewPanel} from '../../../components/control-panel/EventReviewPanel';
import {useVTAStore} from '../store/vtaStore';

const source='試験当日、作業員が旧手順書に従って結線した。\nシステム部門が試験前確認を完了した。\nその結果、通電試験時に過電圧が印加され搭載機器が破損した。';
const ledger='[主体]\nA1\t作業員\tperson\nA2\tシステム部門\torganization\n[イベント]\nE1\t試験当日\t結線\t旧手順書による結線\tA1:actor\tp1\trecorded\nE2\t-\t試験前確認\t試験前確認を完了\tA2:actor\tp2\trecorded\nE3\t-\t通電試験\t通電試験を実施\tA2:actor:inferred\tp3\trecorded\nE4\t-\t過電圧印加\t過電圧が印加された\tA2:actor:inferred\tp3\trecorded\nE5\t-\t機器破損\t搭載機器が破損した\tA2:affected:inferred\tp3\trecorded\n[関係]\nR1\tdependency\tE1\tA1\tE3\tA2\tp1,p3\t-\t-\tna\nR2\tbefore\tE2\t-\tE3\t-\tp2,p3\t-\t-\tna\n[共有カード]\n[整理]\n[帰結]\nO1\tidentified\tE5\tp3\t機器の物的損失\n[完了]';
const inspect=(text=ledger)=>inspectLedger(parseLedger(text),sourceFromText(source));
afterEach(()=>vi.unstubAllGlobals());
describe('LLM subject inference during normalization',()=>{
 it('accepts inferred assignments in one request, without requiring reasons or another repair',async()=>{
  useVTAStore.getState().createNewProjectId();
  const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:ledger}}]})));vi.stubGlobal('fetch',fetch);
  const schema=await extractEventDraft({baseUrl:'/v1',selectedModel:'mock',gatewayToken:''},source);
  expect(fetch).toHaveBeenCalledTimes(1);expect(schema.analysis?.unassignedEventIds).toEqual([]);
  const system=JSON.parse(String(fetch.mock.calls[0][1]?.body)).messages[0].content;
  expect(system).toContain(SUBJECT_INFERENCE_POLICY);expect(system).toContain('同じ1パス');
  const part=schema.analysis!.participations.find(p=>p.eventId==='E3')!;
  expect(part).toMatchObject({entityId:'A2',inferred:true});expect(part.reason).toBeUndefined();expect(part.evidenceBasis).toBeUndefined();
  expect(schema.nodes.find(n=>n.event_ids?.includes('E3'))?.lane).toBe('システム部門');
  expect(schema.edges.some(e=>e.meaning==='dependency')).toBe(true);
  expect(schema.analysis!.events.find(e=>e.id==='E3')?.recordKind).toBe('recorded');
 });
 it('marks only inferred assignments, retaining the flag through save validation and all text outputs',()=>{
  const analysis=validateSavedAnalysis(inspect().analysis),schema=projectAnalysis(analysis);
  expect(isSubjectInferred(analysis.participations.find(p=>p.eventId==='E2')!)).toBe(false);
  const card=schema.nodes.find(n=>n.event_ids?.includes('E3'))!;
  expect(evidenceNotes(schema,card.id)).toContain('システム部門：主体は推定');
  expect(evidenceNotes(schema,card.id).join('\n')).not.toContain('原文明示');
  expect(renderToStaticMarkup(<EventReviewPanel schema={schema} onChange={()=>{}} onConfirm={()=>{}} onCancel={()=>{}}/>)).toContain('主体は推定');
  expect(formatReportAnalysisContextText(extractReportAnalysisContext(schema))).toContain('主体は推定');
  const layout=calculateVTALayout(schema);expect(generateVTASVG(schema,layout.nodes,layout.edges,layout.laneBounds)).toContain('主体は推定');
 });
 it('takes the model assignment as provided, rather than copying the preceding event actor',()=>{
  const analysis=inspect(ledger.replace('E3\t-\t通電試験\t通電試験を実施\tA2:actor:inferred','E3\t-\t通電試験\t通電試験を実施\tA1:actor:inferred').replace('R1\tdependency','R1\tbefore').replace('E1\tA1\tE3\tA2','E1\t-\tE3\t-')).analysis!;
  expect(analysis.participations.find(p=>p.eventId==='E3')?.entityId).toBe('A1');
 });
 it('repairs malformed markers by event row without inventing an actor locally',()=>{
  const doc=parseLedger(ledger.replace('A2:actor:inferred\tp3','A2:actor:maybe\tp3'));
  const result=inspectLedger(doc,sourceFromText(source));expect(result.issues.map(i=>i.row.id)).toEqual(['E3']);
  const rows=parseLedger(ledger).rows.filter(r=>r.id==='E3');
  const repaired=applyLedgerRepair(doc,result.issues,'[イベント]\n'+rows.map(r=>r.cells.join('\t')).join('\n')+'\n[完了]');
  expect(inspectLedger(repaired,sourceFromText(source)).analysis?.participations.find(p=>p.eventId==='E3')?.inferred).toBe(true);
 });
 it('reads existing assignments and legacy contextual data without new required fields or detailed displays',()=>{
  const analysis=inspect().analysis!,part=analysis.participations.find(p=>p.eventId==='E3')!;
  delete part.inferred;part.evidenceBasis='source-context';part.sourceRefs=analysis.events.find(e=>e.id==='E3')!.sourceRefs;part.reason='legacy reasoning';
  const schema=projectAnalysis(validateSavedAnalysis(analysis));
  expect(evidenceNotes(schema).join('\n')).toContain('主体は推定');expect(evidenceNotes(schema).join('\n')).not.toContain('legacy reasoning');
 });
 it('marks only the inferred participant card in a shared event',()=>{
  const analysis=inspect(ledger.replace('A1:actor\tp1','A1:actor,A2:affected:inferred\tp1')).analysis!,schema=projectAnalysis(analysis);
  const a=schema.analysis!.cards.find(c=>c.eventIds.includes('E1')&&c.laneEntityId==='A1')!,b=schema.analysis!.cards.find(c=>c.eventIds.includes('E1')&&c.laneEntityId==='A2')!;
  expect(evidenceNotes(schema,a.id).join('\n')).not.toContain('主体は推定');
  expect(evidenceNotes(schema,b.id)).toContain('システム部門：主体は推定');
 });
});
