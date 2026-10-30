import { describe,it,expect } from 'vitest';
import { inspectLedger,parseLedger } from './eventLedger';
import { ledgerFixture,ledgerSource } from './eventLedger.fixture';
import { projectAnalysis,sourceFromText,validateSavedAnalysis } from './eventAnalysis';
import { dependencyCandidates,dependencyProblem } from './eventOrder';
import { parseConnectionProposalTSV,validateSelectedConnectionProposals } from './connectionProposals';
import type { VTAEventRelation } from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';
import { connectionProposalSignature } from './connectionProposals';
import { generateVTASVG } from './svgExport';
import { calculateVTALayout } from './layout';
const analysis=()=>inspectLedger(parseLedger(ledgerFixture()),sourceFromText(ledgerSource)).analysis!;
const dep:VTAEventRelation={id:'D',kind:'dependency',sourceEventId:'E1',sourceEntityId:'A1',targetEventId:'E2',targetEntityId:'A2',sourceRefs:[{sourceId:'source_1',paragraphId:'p1'}],factIds:[],receipt:'na'};
const tsv='[接続提案]\nP\tadd\t-\tdependency\tE1\tA1\tE2\tA2\tsource_1/p1\t-\t-\tna\trecorded\t起動の完了を前提として停止作業を行う\n[完了]';
describe('work dependencies',()=>{
 it('accepts adjacent canonical events and draws a directed dependency without transfer status',()=>{
   const a=analysis(); expect(dependencyProblem(a,dep)).toBeUndefined();
   a.relations.push(dep); const schema=projectAnalysis(a);
   expect(schema.edges.find(e=>e.relationId==='D')).toMatchObject({direction:'unidirectional',meaning:'dependency',category:'dependency',label:'作業依存'});
   expect(validateSavedAnalysis(JSON.parse(JSON.stringify(a))).relations[0]).toMatchObject(dep);
 });
 it('checks initial extraction against the baseline and repairs only a bad dependency row',()=>{
   const valid=ledgerFixture().replace('[共有カード]','D\tdependency\tE1\tA1\tE2\tA2\tp1\t-\t-\tna\n[共有カード]');
   expect(inspectLedger(parseLedger(valid),sourceFromText(ledgerSource)).analysis?.relations[0].kind).toBe('dependency');
   const invalid=valid.replace('dependency\tE1\tA1\tE2\tA2','dependency\tE2\tA2\tE1\tA1').replace('[共有カード]','B\tbefore\tE1\t-\tE2\t-\tp1\t-\toccurred\tna\n[共有カード]');
   expect(inspectLedger(parseLedger(invalid),sourceFromText(ledgerSource)).issues.map(i=>i.row.id)).toEqual(['D']);
 });
 it('counts an intermediate event even when its card is suppressed',()=>{
   const a=analysis(); a.events.push({...a.events[0],id:'MID',sourceOrder:.5}); a.participations.push({eventId:'MID',entityId:'A1',role:'actor',factIds:[]}); a.cards.push({id:'MID',eventIds:['MID'],laneEntityId:'A1'});
   expect(dependencyProblem(a,dep)).toBeUndefined();
 });
 it('does not let an unrelated third lane break adjacency',()=>{
   const a=analysis(); a.entities.push({id:'C',name:'C',kind:'person'}); a.events.push({...a.events[0],id:'MID',sourceOrder:.5}); a.participations.push({eventId:'MID',entityId:'C',role:'actor',factIds:[]}); a.cards.push({id:'MID',eventIds:['MID'],laneEntityId:'C'});
   expect(dependencyProblem(a,dep)).toBeUndefined();
 });
 it('permits source-order reversal when no explicit precedence contradicts it',()=>{
   expect(dependencyProblem(analysis(),{...dep,sourceEventId:'E2',sourceEntityId:'A2',targetEventId:'E1',targetEntityId:'A1'})).toBeUndefined();
 });
 it('accepts a dependency proposal and rejects unprovided references or transfer attributes',()=>{
   const schema=projectAnalysis(analysis());schema.presentation={lanes:{A1:'show',A2:'show'},suppressedCards:{}}; const p=parseConnectionProposalTSV(tsv,schema);
   expect(p.invalidRows).toEqual([]); expect(p.proposals).toHaveLength(1);
   expect(validateSelectedConnectionProposals(schema,p.proposals)).toEqual([]);
   expect(parseConnectionProposalTSV(tsv,schema,undefined,new Set()).proposals).toEqual([]);
   expect(parseConnectionProposalTSV(tsv.replace('\t-\t-\tna','\tinformation\toccurred\tconfirmed'),schema).proposals).toEqual([]);
   expect(validateSelectedConnectionProposals({...schema,presentation:{lanes:{},suppressedCards:{},omittedDependencies:[JSON.stringify(['E1','A1','E2','A2','dependency'])]}},p.proposals).join()).toContain('削除済み');
 });
 it('allows returning to the same entity at a later event without a temporal cycle',()=>{
   const a=analysis(); a.events.push({...a.events[0],id:'E3',sourceOrder:2}); a.participations.push({eventId:'E3',entityId:'A1',role:'actor',factIds:[]}); a.cards.push({id:'E3',eventIds:['E3'],laneEntityId:'A1'});
   a.relations.push({...dep,kind:'transfer',status:'occurred',resource:'information'});
   const row=tsv.replace('E1\tA1\tE2\tA2','E2\tA2\tE3\tA1');const schema=projectAnalysis(a);
   expect(validateSelectedConnectionProposals(schema,parseConnectionProposalTSV(row,schema).proposals)).toEqual([]);
 });
 it('keeps saved nonadjacent manual dependencies readable',()=>{
   const a=analysis();a.events.push({...a.events[0],id:'MID',sourceOrder:.5});a.relations=[dep];
   expect(validateSavedAnalysis(JSON.parse(JSON.stringify(a))).relations[0].kind).toBe('dependency');
   expect(dependencyCandidates(a).length).toBeGreaterThan(0);
 });
 it('adopts one undoable change, preserves the arrow in SVG and remembers deletion across re-proposal',()=>{
   const schema=projectAnalysis(analysis());schema.presentation={lanes:{A1:'show',A2:'show'},suppressedCards:{}};
   const store=useVTAStore.getState();
   expect(store.importProjectJSON(JSON.stringify({version:'5.0',savedAt:new Date().toISOString(),scenarioText:ledgerSource,vtaData:schema})).success).toBe(true);
   const p=parseConnectionProposalTSV(tsv,schema).proposals;
   const state=useVTAStore.getState();
   expect(state.applyConnectionProposals(state.currentProjectId!,connectionProposalSignature(state.vtaData),p)).toBe(true);
   const applied=useVTAStore.getState().vtaData,edge=applied.edges.find(e=>e.meaning==='dependency')!;
   expect(edge.id).toBeDefined();expect(edge.relationId).not.toBe('proposal:P');
   const layout=calculateVTALayout(applied);
   expect(generateVTASVG(applied,layout.nodes,layout.edges,layout.laneBounds,{})).toContain('stroke-dasharray="8,3,2,3"');
   useVTAStore.getState().undo();expect(useVTAStore.getState().vtaData.analysis?.relations.some(r=>r.kind==='dependency')).toBe(false);
   useVTAStore.getState().redo();expect(useVTAStore.getState().vtaData.edges.some(e=>e.id===edge.id)).toBe(true);
   useVTAStore.getState().deleteEdge(edge.id!);
   const after=useVTAStore.getState().vtaData;
   expect(after.presentation?.omittedDependencies).toHaveLength(1);
   expect(validateSelectedConnectionProposals(after,p).join()).toContain('削除済み');
 });
});
