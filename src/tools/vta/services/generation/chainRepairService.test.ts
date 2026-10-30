import {it,expect,vi,afterEach} from 'vitest';
import {callLLMGateway} from '../llm/client';
import {proposeChainRepair} from './chainRepairService';
import {inspectLedger,parseLedger} from '../../features/vta/utils/eventLedger';
import {ledgerFixture,ledgerSource} from '../../features/vta/utils/eventLedger.fixture';
import {sourceFromText,projectAnalysis} from '../../features/vta/utils/eventAnalysis';
import {wiringUnassignedFixture} from '../../features/vta/utils/wiringUnassigned.fixture';
vi.mock('../llm/client',()=>({callLLMGateway:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
function schema(){const a=inspectLedger(parseLedger(ledgerFixture()),sourceFromText(ledgerSource)).analysis!;a.events.push({...a.events[1],id:'E3',sourceOrder:2});a.entities.push({id:'A3',name:'第三部門',kind:'organization'});a.participations.push({eventId:'E3',entityId:'A3',role:'actor',factIds:[]});a.cards.push({id:'c3',laneEntityId:'A3',eventIds:['E3']});return projectAnalysis(a);}
const a='tmp_a\tdependency\tE1\tA1\tE2\tA2\tsource_1/p1\t-\t-\tna\trecorded\t根拠';
const b='tmp_b\tdependency\tE2\tA2\tE3\tA3\tsource_1/p2\t-\t-\tna\trecorded\t根拠';
const table=(rows:string)=>'[追加主体]\n[追加イベント]\n[割当追加]\n[関係追加]\n'+rows+'\n[要確認]\n[完了]';
const config={baseUrl:'/v1',selectedModel:'test',gatewayToken:''};
function reply(content:string){vi.mocked(callLLMGateway).mockResolvedValueOnce({content,latencyMs:1});}
it('runs a second semantic pass on a temporary graph, retaining IDs without editing the original',async()=>{
 const s=schema(),before=JSON.stringify(s);reply(table(a));reply(table(b));
 const result=await proposeChainRepair(config,s);
 expect(result.calls).toBe(2);expect(result.rows.map(r=>r.id)).toEqual(['tmp_a','tmp_b']);expect(result.issues).toEqual([]);expect(JSON.stringify(s)).toBe(before);
 expect(vi.mocked(callLLMGateway).mock.calls[1][1][1].content).toContain('tmp_a');
});
it('repairs only rejected IDs while retaining the valid row and records the repair',async()=>{
 reply(table(a+'\n'+b.replace('source_1/p2','source_1/missing')));reply(table(b));
 const result=await proposeChainRepair(config,schema());
 expect(result.rows.map(r=>r.id)).toEqual(['tmp_a','tmp_b']);expect(result.calls).toBe(2);expect(result.issues).toEqual([]);
 expect(result.trace.some(t=>t.candidateId==='tmp_b'&&t.status==='rejected')).toBe(true);
 expect(result.trace.some(t=>t.candidateId==='tmp_b'&&t.stage==='repair'&&t.status==='accepted')).toBe(true);
});
it('does not treat omission of a rejected row as a successful repair',async()=>{
 reply(table(a+'\n'+b.replace('source_1/p2','source_1/missing')));reply(table(''));
 const result=await proposeChainRepair(config,schema());
 expect(result.rows.map(r=>r.id)).toEqual(['tmp_a']);expect(result.issues.some(i=>i.id==='tmp_b')).toBe(true);expect(result.calls).toBe(2);
});
it('keeps normal candidates after an upstream failure',async()=>{
 reply(table(a));vi.mocked(callLLMGateway).mockRejectedValueOnce(Error('504'));
 const result=await proposeChainRepair(config,schema());expect(result.rows).toHaveLength(1);expect(result.trace.some(t=>t.reason.includes('504'))).toBe(true);
});
it('blocks incomplete framing and stops within the total call budget',async()=>{
 vi.mocked(callLLMGateway).mockResolvedValue({content:table(a).replace('[完了]',''),latencyMs:1});
 const result=await proposeChainRepair(config,schema());expect(result.complete).toBe(false);expect(result.rows).toHaveLength(1);expect(result.calls).toBeLessThanOrEqual(6);
});
it('sends unassigned energization/outcome events and accepts joint assignment and contextual dependency',async()=>{
 const text='[追加主体]\n[追加イベント]\n[割当追加]\nP7\tE7\tA2\tactor\tsource_1/p6,source_1/p7\tinferred\nP8\tE8\tA2\taffected\tsource_1/p7\tinferred\n[関係追加]\ntmp_dep\tdependency\tE5\tA3\tE7\tA2\tsource_1/p5,source_1/p7\t-\t-\tna\tsource-context\t結線結果を通電で使用\n[要確認]\n[完了]';
 reply(text);reply(table(''));
 const result=await proposeChainRepair(config,wiringUnassignedFixture());
 const request=vi.mocked(callLLMGateway).mock.calls[0][1];
 expect(request[1].content).toContain('source_1/p7\tE7,E8\tdirect');
 expect(request[1].content).toContain('unassigned');expect(request[1].content).not.toContain('"analysis":');
 expect(request[0].content).toContain('chain-delta-3');expect(request[0].content).toContain('source-context');
 expect(result.rows.map(r=>r.id)).toEqual(['P7','P8','tmp_dep']);expect(result.issues).toEqual([]);
});
