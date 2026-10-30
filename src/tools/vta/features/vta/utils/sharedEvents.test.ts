import { describe,it,expect } from 'vitest';
import {parseLedger,inspectLedger} from './eventLedger';
import {ledgerFixture,ledgerSource} from './eventLedger.fixture';
import {sourceFromText,projectAnalysis} from './eventAnalysis';
import {connectSharedEvents} from './sharedEvents';
import {validateAndSanitizeProjectFile} from './schemaValidator';
import {computeTimeRanks} from './layout';
import {useVTAStore} from '../store/vtaStore';
import {generateVTASVG} from './svgExport';
import {calculateVTALayout} from './layout';
function fixture(kind='transfer',status='occurred') {
 const text=ledgerFixture().replace('[共有カード]',`R1\t${kind}\tE1\tA1\tE1\tA2\tp1\tinformation\t${status}\tunconfirmed\n[共有カード]`);
 const checked=inspectLedger(parseLedger(text),sourceFromText(ledgerSource));expect(checked.issues).toEqual([]);
 return projectAnalysis(checked.analysis!);
}
describe('shared event connections',()=>{
 it('retains omission metadata for connections between different events',()=>{
  const text=ledgerFixture().replace('[共有カード]','R1\ttransfer\tE1\tA1\tE2\tA2\tp1\tinformation\tomitted\tna\n[共有カード]');
  const checked=inspectLedger(parseLedger(text),sourceFromText(ledgerSource));expect(checked.issues).toEqual([]);
  const schema=projectAnalysis(checked.analysis!);const edge=schema.edges.find(e=>e.relationId==='R1')!;
  expect(edge.status).toBe('omitted');expect(edge.direction).toBe('undirected');expect(edge.label).toBe('未実施');
 });
 it('edits and deletes one of two parallel relationships by ID',()=>{
  const schema=fixture();const relation={...schema.analysis!.relations[0],id:'R2',kind:'mutual' as const};
  schema.analysis!.relations.push(relation);
  useVTAStore.getState().setVTAData(connectSharedEvents(schema));
  useVTAStore.getState().updateEdge('relation:R1',{label:'個別修正',status:'omitted'});
  let saved=useVTAStore.getState().vtaData;
  expect(saved.edges.find(e=>e.id==='relation:R1')?.label).toBe('個別修正');
  expect(saved.edges.find(e=>e.id==='relation:R2')?.label).toBe('相互確認');
  useVTAStore.getState().deleteEdge('relation:R1');saved=useVTAStore.getState().vtaData;
  expect(saved.edges.some(e=>e.id==='relation:R1')).toBe(false);
  expect(saved.edges.some(e=>e.id==='relation:R2')).toBe(true);
 });
 it('exports common impact as a line without arrow markers',()=>{
  const schema=fixture('common');const layout=calculateVTALayout(schema);
  const svg=generateVTASVG(schema,layout.nodes,layout.edges,layout.laneBounds);
  expect(svg).toContain('共通影響');
  const line=layout.edges.find(e=>e.id==='relation:R1')!;
  expect(line.data?.direction).toBe('undirected');
 });
 it.each([['transfer','occurred','unidirectional'],['mutual','occurred','bidirectional'],['common','occurred','undirected'],['transfer','omitted','undirected']])('draws %s %s as %s',(kind,status,direction)=>{
  const schema=fixture(kind,status);const line=schema.edges.find(e=>e.relationId==='R1')!;expect(line.direction).toBe(direction);
  expect(schema.edges.filter(e=>e.eventId==='E1')).toHaveLength(1);
  expect(connectSharedEvents(schema).edges).toEqual(schema.edges);
  const ranks=computeTimeRanks(schema);expect(ranks.get(line.source)).toBe(ranks.get(line.target));
  const loaded=validateAndSanitizeProjectFile({version:'5.0',vtaData:schema});expect(loaded.errors).toEqual([]);expect(loaded.isValid).toBe(true);expect(loaded.data?.vtaData.edges.find(e=>e.id===line.id)?.direction).toBe(direction);
 });
 it('connects the remaining shared cards without inventing a transfer',()=>{
  const checked=inspectLedger(parseLedger(ledgerFixture()),sourceFromText(ledgerSource));const original=projectAnalysis(checked.analysis!);
  const schema=projectAnalysis(checked.analysis!,{...original,presentation:{lanes:{A1:'show',A2:'show'},suppressedCards:{}}});
  expect(schema.edges.find(e=>e.eventId==='E1')?.direction).toBe('undirected');
 });
 it('retains an explicit deletion instead of restoring it on projection',()=>{
  const schema=fixture();const line=schema.edges.find(e=>e.relationId==='R1')!;
  const next=connectSharedEvents({...schema,edges:schema.edges.filter(e=>e.id!==line.id),presentation:{...schema.presentation!,omittedEdges:[line.id!]}});
  expect(next.edges.some(e=>e.id===line.id)).toBe(false);
 });
});
