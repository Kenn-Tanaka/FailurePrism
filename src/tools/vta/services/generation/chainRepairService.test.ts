import {it,expect,vi,afterEach} from 'vitest';
import {callLLMGateway} from '../llm/client';
import {proposeChainRepair} from './chainRepairService';
import {inspectLedger,parseLedger} from '../../features/vta/utils/eventLedger';
import {applyChainDelta} from '../../features/vta/utils/chainRepair';
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

it('accepts a non-tmp colliding relation row like R15 in one pass without failing validation (ADR-0056)',async()=>{
 const s=schema();
 s.analysis!.relations.push({id:'R15',kind:'before',sourceEventId:'E1',targetEventId:'E2',sourceRefs:[{sourceId:'source_1',paragraphId:'p1'}],factIds:[]});
 const r15Row='R15\tdependency\tE2\tA2\tE3\tA3\tsource_1/p2\t-\t-\tna\trecorded\t根拠';
 reply(table(r15Row));reply(table(''));
 const result=await proposeChainRepair(config,s);
 expect(result.issues).toEqual([]);
 expect(result.rows.map(r=>r.id)).toEqual(['tmp_R15']);
 expect(result.rows[0].cells[0]).toBe('tmp_R15');
});

it('allows tmp_ ID rename repairs without Catch-22 deadlock while keeping unmatched omitted rows unresolved (ADR-0056)',async()=>{
 const badEv1='E98\t-\t追加事象1\t説明1\tsource_1/p1\trecorded\t根拠1';
 const badEv2='E99\t-\t追加事象2\t説明2\tsource_1/p2\trecorded\t根拠2';
 const initial='[追加主体]\n[追加イベント]\n'+badEv1+'\n'+badEv2+'\n[割当追加]\n[関係追加]\n[要確認]\n[完了]';
 const fixedOneOnly='[追加主体]\n[追加イベント]\ntmp_ev_renamed\t-\t追加事象1\t説明1\tsource_1/p1\trecorded\t根拠1\n[割当追加]\n[関係追加]\n[要確認]\n[完了]';
 const fixedSecond='[追加主体]\n[追加イベント]\ntmp_E99\t-\t追加事象2\t説明2\tsource_1/p2\trecorded\t根拠2\n[割当追加]\n[関係追加]\n[要確認]\n[完了]';
 reply(initial);
 reply(fixedOneOnly);
 reply(fixedSecond);
 reply(table(''));
 const result=await proposeChainRepair(config,schema());
 expect(result.issues).toEqual([]);
 expect(result.rows.map(r=>r.id)).toEqual(['tmp_ev_renamed','tmp_E99']);
 expect(result.trace.some(t=>t.candidateId==='tmp_ev_renamed'&&t.status==='rejected')).toBe(false);
});

it('does not mark multiple tmp_ ID errors resolved when repair returns only one renamed row (ADR-0056)',async()=>{
 const badEv1='E98\t-\t追加事象1\t説明1\tsource_1/p1\trecorded\t根拠1';
 const badEv2='E99\t-\t追加事象2\t説明2\tsource_1/p2\trecorded\t根拠2';
 const initial='[追加主体]\n[追加イベント]\n'+badEv1+'\n'+badEv2+'\n[割当追加]\n[関係追加]\n[要確認]\n[完了]';
 const fixedOneOnly='[追加主体]\n[追加イベント]\ntmp_ev_renamed\t-\t追加事象1\t説明1\tsource_1/p1\trecorded\t根拠1\n[割当追加]\n[関係追加]\n[要確認]\n[完了]';
 reply(initial);
 reply(fixedOneOnly);
 reply(table(''));
 const result=await proposeChainRepair(config,schema());
 expect(result.rows.map(r=>r.id)).toEqual(['tmp_ev_renamed']);
 expect(result.issues).toHaveLength(1);
 expect(result.issues[0].id).toBe('E99');
});

it('skips pass 2 when pass 1 only adds non-projected before relations and review notes without reducing disconnected components, and passes [完了] terminator (ADR-0067)',async()=>{
 const onlyBeforeAndReview=[
  '[追加主体]',
  '[追加イベント]',
  '[割当追加]',
  '[関係追加]',
  'tmp_b1\tbefore\tE1\t-\tE2\t-\tsource_1/p1,source_1/p2\t-\t-\tna\trecorded\t時間順のみ確認',
  '[要確認]',
  'rev_1\tE3\tsource_1/p2\tUNLINKED\t根拠不足のため確認待ち',
  '[完了]',
 ].join('\n');
 reply(onlyBeforeAndReview);
 const result=await proposeChainRepair(config,schema());
 expect(result.calls).toBe(1);
 expect(result.issues).toEqual([]);
 expect(result.rows.map(r=>r.id)).toEqual(['tmp_b1','rev_1']);
 expect(vi.mocked(callLLMGateway).mock.calls[0][4]).toEqual({terminator:'[完了]'});
});

it('triggers targeted repair when pass 1 leaves diag.unassigned events with only before relations and neither [割当追加] nor [要確認] (ADR-0075)',async()=>{
 const onlyBeforeOnUnassigned=[
  '[追加主体]',
  '[追加イベント]',
  '[割当追加]',
  '[関係追加]',
  'tmp_b_only\tbefore\tE5\t-\tE7\t-\tsource_1/p5,source_1/p7\t-\t-\tna\trecorded\t時間順のみ',
  '[要確認]',
  '[完了]',
 ].join('\n');
 const assignInRepair=[
  '[追加主体]',
  '[追加イベント]',
  '[割当追加]',
  'tmp_as7\tE7\tA2\tactor\tsource_1/p6,source_1/p7\tinferred',
  'tmp_as8\tE8\tA2\taffected\tsource_1/p7\tinferred',
  '[関係追加]',
  '[要確認]',
  '[完了]',
 ].join('\n');
 reply(onlyBeforeOnUnassigned);
 reply(assignInRepair);
 reply(table(''));
 const result=await proposeChainRepair(config,wiringUnassignedFixture());
 expect(result.issues).toEqual([]);
 expect(result.rows.some(r=>r.section==='割当追加'&&r.cells[1]==='E7')).toBe(true);
 expect(result.rows.some(r=>r.section==='割当追加'&&r.cells[1]==='E8')).toBe(true);
});

it('surfaces isolated collective outcome stubs and unreferenced substantive paragraphs in [連結診断ヒント] and accepts sibling :affected + unreferenced_paragraph review (ADR-0098)',async()=>{
 const src = sourceFromText([
  'A機には機長Aと副操縦員Aが搭乗していた。',
  '副操縦員Aが停止位置指示を復唱し機長Aが進入した。',
  '両機が衝突し機長Aが重傷、A機乗組員が死亡した。',
  '当時の空港周辺風向は北北東4ktであった。',
 ].join('\n\n'));
 const ledger = [
  '[主体]',
  'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
  'A_CREW\tA機搭乗員\torganization\thigh\t-\tp1',
  'A_CAPT\t機長A\tperson\thigh\tA_CREW\tp1',
  'A_FO\t副操縦員A\tperson\thigh\tA_CREW\tp1',
  'A_VIC\tA機死亡乗組員\torganization\thigh\tA_CREW\tp3',
  '[イベント]',
  'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
  'E1\t17:45\t復唱と進入\t副操縦員Aが復唱し機長Aが進入した\tA_FO:actor,A_CAPT:actor\tp2\trecorded',
  'E2\t17:47\t衝突・死傷\t衝突し機長Aが重傷、乗組員が死亡した\tA_CAPT:affected,A_VIC:affected\tp3\trecorded',
  '[関係]',
  'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
  'R1\tbefore\tE1\t-\tE2\t-\tp2,p3\t-\t-\tna',
  '[共有カード]',
  '[整理]',
  '[帰結]',
  'O1\tidentified\tE2:loss\tp3\t衝突死傷',
  '[完了]',
 ].join('\n');
 const s = projectAnalysis(inspectLedger(parseLedger(ledger), src).analysis!);
 reply([
  '[追加主体]',
  '[追加イベント]',
  '[割当追加]',
  'tmp_as_fo\tE2\tA_FO\taffected\tsource_1/p1,source_1/p3\t-',
  '[関係追加]',
  'tmp_imp\timpact\tE1\tA_FO\tE2\tA_FO\tsource_1/p2,source_1/p3\tother\toccurred\tna\tsource-context\t進入継続から衝突被災へ至る連鎖',
  '[要確認]',
  'tmp_q_p4\t-\tsource_1/p4\tunreferenced_paragraph\t気象背景記述のみのため事象外として確認記録',
  '[完了]',
 ].join('\n'));
 reply(table(''));
 const result = await proposeChainRepair(config, s);
 const sentUserPrompt = vi.mocked(callLLMGateway).mock.calls[0][1][1].content;
 expect(sentUserPrompt).toContain('帰結単独出現の重複候補主体: A_VIC@E2(同親A_CREWの帰結未関与兄弟:A_FO)');
 expect(sentUserPrompt).toContain('未参照の実質段落: source_1/p1,source_1/p4');
 expect(result.issues).toEqual([]);
 const applied = applyChainDelta(s, result.rows, true);
 expect(applied.analysis?.participations.some((p) => p.eventId === 'E2' && p.entityId === 'A_FO' && p.role === 'affected')).toBe(true);
 expect(applied.analysis?.dispositions?.some((d) => d.kind === 'review' && Boolean(d.text?.includes('[unreferenced_paragraph]') && d.text?.includes('source_1/p4')))).toBe(true);
});
