import { describe,it,expect } from 'vitest';
import type { VTASchema } from '../../../types/vta';
import { connectionProposalSignature, parseConnectionProposalTSV, proposalRelation, validateSelectedConnectionProposals } from './connectionProposals';
import { connectSharedEvents } from './sharedEvents';
import { validateAndSanitizeVTASchema } from './schemaValidator';
import { reconcileAnalysis } from './eventAnalysis';
import { useVTAStore } from '../store/vtaStore';

const schema:VTASchema={lanes:['A','B'],nodes:[{id:'ca',event_ids:['e1'],lane:'A',time:'',type:'normal',title:'A',description:'',measure_type:null},{id:'cb',event_ids:['e2'],lane:'B',time:'',type:'normal',title:'B',description:'',measure_type:null}],edges:[],analysis:{version:5,sources:[{id:'s',text:'source',paragraphs:[{id:'p1',text:'AからBへ情報を送った。'}]}],facts:[],events:[{id:'e1',title:'A送信',description:'',time:'',sourceOrder:0,factIds:[],sourceRefs:[{sourceId:'s',paragraphId:'p1'}],classification:'normal'},{id:'e2',title:'B受信',description:'',time:'',sourceOrder:1,factIds:[],sourceRefs:[{sourceId:'s',paragraphId:'p1'}],classification:'normal'}],entities:[{id:'a',name:'A',kind:'person'},{id:'b',name:'B',kind:'person'}],participations:[{eventId:'e1',entityId:'a',role:'actor',factIds:[]},{eventId:'e2',entityId:'b',role:'target',factIds:[]}],relations:[],cards:[{id:'ca',laneEntityId:'a',eventIds:['e1']},{id:'cb',laneEntityId:'b',eventIds:['e2']}],unassignedEventIds:[]}};
const row='p1\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tExplicit transmission';

describe('LLM connection proposal validation',()=>{
 it('parses valid TSV as unselected candidates and validates source references',()=>{
  const result=parseConnectionProposalTSV(`[接続提案]\n${row}\n[要確認]\n[完了]`,schema);
  expect(result.proposals).toHaveLength(1); expect(result.proposals[0].selected).toBe(false); expect(result.invalidRows).toEqual([]);
 });
 it('retains malformed rows separately instead of reporting an empty success',()=>{
  const result=parseConnectionProposalTSV(`[接続提案]\n${row.replace('s/p1','s/missing')}\n[完了]`,schema);
  expect(result.proposals).toHaveLength(0); expect(result.invalidRows).toHaveLength(1);
 });
 it('detects opposite transfer candidates as a selected-set cycle',()=>{
  const proposals=parseConnectionProposalTSV(`[接続提案]\n${row}\np2\tadd\t-\ttransfer\te2\tb\te1\ta\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tReturn\n[完了]`,schema).proposals.map(p=>({...p,selected:true}));
  expect(validateSelectedConnectionProposals(schema,proposals).some((error)=>error.includes('循環'))).toBe(true);
 });
 it('retains distinct original LLM and adopted reasons in relation provenance',()=>{
  const proposal={...parseConnectionProposalTSV(`[接続提案]\n${row}\n[完了]`,schema).proposals[0],reason:'user checked reason'};
  const relation=proposalRelation(proposal); expect(relation.proposalReason).toBe('Explicit transmission'); expect(relation.adoptionReason).toBe('user checked reason');
 });
 it('replaces a derived neutral shared-event line with a selected semantic relation without recording a manual deletion',()=>{
  const shared={...schema,analysis:{...schema.analysis!,events:[{...schema.analysis!.events[0],id:'shared'}],cards:[{id:'ca',laneEntityId:'a',eventIds:['shared']},{id:'cb',laneEntityId:'b',eventIds:['shared']}],participations:[{eventId:'shared',entityId:'a',role:'actor' as const,factIds:[]},{eventId:'shared',entityId:'b',role:'target' as const,factIds:[]}],relations:[],unassignedEventIds:[]},nodes:schema.nodes.map(n=>({...n,event_ids:['shared']}))};
  const neutral=connectSharedEvents(shared).edges[0];
  expect(neutral.meaning).toBe('association');
  const withNeutral={...shared,edges:[neutral]};
  const parsed=parseConnectionProposalTSV(`[接続提案]\npx\trefine\t${neutral.id}\tmutual\tshared\ta\tshared\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tConfirmed cross-check\n[完了]`,withNeutral);
  expect(parsed.invalidRows).toEqual([]);
  const proposal={...parsed.proposals[0],selected:true};
  expect(proposal).toMatchObject({sourceEventId:'shared',targetEventId:'shared',sourceEntityId:'a',targetEntityId:'b',kind:'mutual'});
  const appliedRelation=proposalRelation(proposal);
  expect(appliedRelation).toMatchObject({sourceEventId:'shared',targetEventId:'shared',sourceEntityId:'a',targetEntityId:'b',kind:'mutual'});
  const next=connectSharedEvents({...withNeutral,analysis:{...shared.analysis!,relations:[appliedRelation]},presentation:{lanes:{},suppressedCards:{}}});
  expect(next.analysis?.relations).toHaveLength(1);
  expect(next.edges.filter(e=>e.meaning==='association')).toEqual([]);
  expect(next.edges.some(e=>e.relationId==='proposal:px'&&e.direction==='bidirectional')).toBe(true);
  expect(next.presentation?.omittedEdges).toBeUndefined();
 });
 it('round-trips proposal provenance through saved schema validation',()=>{
  const relation=proposalRelation({...parseConnectionProposalTSV(`[接続提案]\n${row}\n[完了]`,schema).proposals[0],reason:'Human approved'});
  const validSource={...schema.analysis!.sources[0],text:schema.analysis!.sources[0].paragraphs[0].text};
  const validation=validateAndSanitizeVTASchema({...schema,analysis:{...schema.analysis!,sources:[validSource],relations:[relation]}},true);
  expect(validation.isValid,JSON.stringify(validation.errors)).toBe(true);
  expect(validation.data?.analysis?.relations[0]).toMatchObject({proposalReason:'Explicit transmission',adoptionReason:'Human approved',provenance:'llm-proposal'});
 });
 it('marks later manual edge edits as user provenance while retaining the original proposal reason',()=>{
  const relation=proposalRelation(parseConnectionProposalTSV(`[接続提案]\n${row}\n[完了]`,schema).proposals[0]);
  const base={...schema,analysis:{...schema.analysis!,relations:[relation]},edges:[{id:'relation:proposal:p1',relationId:'proposal:p1',generated:true,meaning:'transfer' as const,source:'ca',target:'cb',direction:'unidirectional' as const}]};
  const edited={...base,edges:[{...base.edges[0],generated:false,meaning:'impact' as const,resource:'material'}]};
  const reconciled=reconcileAnalysis(base,edited);
  expect(reconciled.analysis?.relations[0]).toMatchObject({kind:'impact',resource:'material',provenance:'user',proposalReason:'Explicit transmission',adoptionReason:'利用者が図上で関係属性を手動編集。'});
 });
 it('signature ignores positions and lane ordering but changes with semantic data',()=>{
  const original=connectionProposalSignature(schema);
  expect(connectionProposalSignature({...schema,nodes:schema.nodes.map(n=>({...n,position:{x:200,y:300}})),lanes:['B','A']})).toBe(original);
  expect(connectionProposalSignature({...schema,analysis:{...schema.analysis!,events:schema.analysis!.events.map(e=>({...e,title:e.id==='e1'?'Changed':e.title}))}})).not.toBe(original);
 });
 it('recalculates ReactFlow edges in applyConnectionProposals even when schema.presentation is undefined',()=>{
  const schemaWithoutPresentation:VTASchema={...schema,presentation:undefined};
  useVTAStore.getState().setVTAData(schemaWithoutPresentation);
  // Ensure presentation remains undefined before applying proposals
  useVTAStore.setState({vtaData:{...useVTAStore.getState().vtaData,presentation:undefined}});
  const stateBefore=useVTAStore.getState();
  expect(stateBefore.vtaData.presentation).toBeUndefined();
  const parsed=parseConnectionProposalTSV(`[接続提案]\n${row}\n[完了]`,stateBefore.vtaData);
  const selected=parsed.proposals.map(p=>({...p,selected:true}));
  const applied=stateBefore.applyConnectionProposals(
   stateBefore.currentProjectId,
   connectionProposalSignature(stateBefore.vtaData),
   selected
  );
  expect(applied).toBe(true);
  const stateAfter=useVTAStore.getState();
  expect(stateAfter.vtaData.edges.some(e=>e.source==='ca'&&e.target==='cb')).toBe(true);
  expect(stateAfter.edges.some(e=>e.source==='ca'&&e.target==='cb')).toBe(true);
 });
 it('self-heals hyphen "-" or empty proposal IDs with unique sequential IDs (P1, P2...)', () => {
  const hyphenRow1 = '-\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tTransfer 1';
  const hyphenRow2 = '-\tadd\t-\ttransfer\te2\tb\te1\ta\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tTransfer 2';
  const emptyRow3 = '\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tTransfer 3';
  const text = `[接続提案]\n${hyphenRow1}\n${hyphenRow2}\n${emptyRow3}\n[完了]`;
  const result = parseConnectionProposalTSV(text, schema);
  expect(result.invalidRows).toEqual([]);
  expect(result.proposals).toHaveLength(3);
  expect(result.proposals[0].id).toBe('P1');
  expect(result.proposals[1].id).toBe('P2');
  expect(result.proposals[2].id).toBe('P3');
 });
 it('self-heals duplicate proposal IDs by appending a suffix', () => {
  const dupRow1 = 'p1\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tFirst';
  const dupRow2 = 'p1\tadd\t-\ttransfer\te2\tb\te1\ta\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tSecond';
  const dupRow3 = 'p1\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\tThird';
  const text = `[接続提案]\n${dupRow1}\n${dupRow2}\n${dupRow3}\n[完了]`;
  const result = parseConnectionProposalTSV(text, schema);
  expect(result.invalidRows).toEqual([]);
  expect(result.proposals).toHaveLength(3);
  expect(result.proposals[0].id).toBe('p1');
  expect(result.proposals[1].id).toBe('p1_2');
  expect(result.proposals[2].id).toBe('p1_3');
 });
 it('self-heals hyphen "-" or duplicate review IDs in [要確認]', () => {
  const review1 = '-\ts/p1\tFirst review';
  const review2 = '-\ts/p1\tSecond review';
  const review3 = 'Q1\ts/p1\tThird review';
  const review4 = 'Q1\ts/p1\tFourth review';
  const text = `[接続提案]\n[要確認]\n${review1}\n${review2}\n${review3}\n${review4}\n[完了]`;
  const result = parseConnectionProposalTSV(text, schema);
  expect(result.invalidRows).toEqual([]);
  expect(result.reviews).toHaveLength(4);
  expect(result.reviews[0].id).toBe('Q1');
  expect(result.reviews[1].id).toBe('Q2');
  expect(result.reviews[2].id).toBe('Q1_2');
  expect(result.reviews[3].id).toBe('Q1_3');
 });
 it('reproduces and fixes the diagnostics log scenario where all rows have hyphen "-" as ID', () => {
  const logRows = [
   '-\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\treason 1',
   '-\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\treason 2',
   '-\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\treason 3',
   '-\tadd\t-\ttransfer\te1\ta\te2\tb\ts/p1\tinformation\toccurred\tconfirmed\trecorded\treason 4',
  ];
  const text = `[接続提案]\n${logRows.join('\n')}\n[完了]`;
  const result = parseConnectionProposalTSV(text, schema);
  expect(result.invalidRows).toEqual([]);
  expect(result.proposals).toHaveLength(4);
  expect(result.proposals.map((p) => p.id)).toEqual(['P1', 'P2', 'P3', 'P4']);
 });
});
