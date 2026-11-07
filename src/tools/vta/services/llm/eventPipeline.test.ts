import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyEventDraft, extractEventDraft, restoreNormalizedPassage, proposeVTAConnections } from './client';
import { inspectLedger, parseLedger } from '../../features/vta/utils/eventLedger';
import { projectAnalysis, sourceFromText } from '../../features/vta/utils/eventAnalysis';
import { ledgerFixture, ledgerSource } from '../../features/vta/utils/eventLedger.fixture';
import { visibleSchema } from '../../features/vta/utils/presentation';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { SUBJECT_LANE_POLICY } from './eventPrompts';

const config = { baseUrl: '/v1', gatewayToken: '', selectedModel: 'test/model', maxRetries: 0 };
beforeEach(() => useVTAStore.getState().createNewProjectId());
afterEach(() => vi.unstubAllGlobals());
function replies(items: Array<string | number>, finishReason = 'stop') {
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (!items.length) throw new Error('Unexpected request');
    const content = items.shift();
    if (typeof content === 'number') return new Response('upstream timeout', { status: content });
    return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }), { status: 200 });
  });
  vi.stubGlobal('fetch', mock); return mock;
}
const invalid = () => ledgerFixture().replace('A1:actor', 'A1:bad');
const repair = '[イベント]\nE1\t09:00\t起動\t担当者が装置を起動した\tA1:actor,A2:target\tp1\trecorded\n[完了]';

describe('LLM text-conversion extraction', () => {
  it.each(['event-chain','fulltext-ledger'] as const)('keeps controlled equipment as event content rather than a lane in %s',async(scheme)=>{
    const source='システム部門が搭載機器への通電試験を行った。\nその試験中に搭載機器が破損した。';
    const ledger='[主体]\nID\t名称\t種類\nA1\tシステム部門\torganization\n[イベント]\nID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分\nE1\t-\t通電試験\tシステム部門が搭載機器への通電試験を行った\tA1:actor\tp1\trecorded\nE2\t-\t搭載機器の破損\tその試験中に搭載機器が破損した\tA1:actor\tp2\trecorded\n[関係]\n[共有カード]\n[整理]\n[完了]';
    const mock=replies([ledger]); const schema=await extractEventDraft(config,source,undefined,scheme);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mock.mock.calls[0][1]?.body)).messages[0].content).toContain(SUBJECT_LANE_POLICY);
    expect(schema.lanes).toEqual(['システム部門']);
    expect(schema.analysis?.events).toHaveLength(2);
    expect(schema.analysis?.events[1].description).toContain('搭載機器が破損');
  });
  it('retains a machine lane when the source records autonomous detection and signal transmission',async()=>{
    const source='保護装置が過電流を検知し、自動停止信号を送信した。';
    const ledger='[主体]\nA1\t保護装置\tmachine\n[イベント]\nE1\t-\t異常検知\t保護装置が過電流を検知した\tA1:actor\tp1\trecorded\nE2\t-\t信号送信\t保護装置が自動停止信号を送信した\tA1:actor\tp1\trecorded\n[関係]\n[共有カード]\n[整理]\n[完了]';
    replies([ledger]);const schema=await extractEventDraft(config,source);
    expect(schema.analysis?.entities[0]).toMatchObject({name:'保護装置',kind:'machine'});
    expect(schema.nodes).toHaveLength(2);
  });
  it('keeps damage with an unknown actor as an unassigned event requiring review',async()=>{
    const source='搭載機器の破損事故が発生した。';
    replies(['[主体]\n[イベント]\nE1\t-\t搭載機器の破損\t搭載機器の破損事故が発生した\t-\tp1\trecorded\n[関係]\n[共有カード]\n[整理]\nR1\treview\tp1\t破損イベントの主体未割当\t対応する操作・試験主体は原文から不明\n[完了]']);
    const schema=await extractEventDraft(config,source);
    expect(schema.analysis?.events).toHaveLength(1);
    expect(schema.analysis?.entities).toEqual([]);
    expect(schema.analysis?.unassignedEventIds).toEqual(['E1']);
    expect(schema.analysis?.dispositions?.[0].kind).toBe('review');
  });
  it('stops identical invalid repairs and obtains a fresh ledger on the next attempt', async () => {
    const bad = ledgerFixture().replace('[共有カード]', 'R6\tmutual\tE1\t-\tE2\t-\tp1\tinformation\toccurred\tna\n[共有カード]');
    const same = '[関係]\nR6\tmutual\tE1\t-\tE2\t-\tp1\tinformation\toccurred\tna\n[完了]';
    const first = replies([bad, same]);
    await expect(extractEventDraft(config,ledgerSource)).rejects.toThrow('修復内容が変わらない');
    expect(first).toHaveBeenCalledTimes(2);
    const retry = replies([ledgerFixture()]);
    await expect(extractEventDraft(config,ledgerSource)).resolves.toBeDefined();
    expect(JSON.parse(String(retry.mock.calls[0][1]?.body)).messages[1].content).toContain('段落番号付き原文');
  });
  it('sends the neutral line ID and complete enum contract so the LLM can refine it in one response', async () => {
    const analysis = inspectLedger(parseLedger(ledgerFixture()),sourceFromText(ledgerSource)).analysis!;
    const schema = projectAnalysis(analysis,{lanes:['担当者','装置'],nodes:[],edges:[],presentation:{lanes:{A1:'show',A2:'show'},suppressedCards:{}}});
    const line = schema.edges.find((edge) => edge.meaning === 'association')!;
    expect(line).toBeDefined();
    const mock = replies([`[接続提案]\nP1\trefine\t${line.id}\ttransfer\tE1\tA1\tE1\tA2\tsource_1/p1\tinformation\toccurred\tconfirmed\trecorded\t担当者による装置への操作\n[要確認]\n[完了]`]);
    const result = await proposeVTAConnections(config,schema);
    expect(mock).toHaveBeenCalledTimes(1); expect(result.invalidRows).toEqual([]); expect(result.proposals).toHaveLength(1);
    const request = JSON.parse(String(mock.mock.calls[0][1]?.body));
    expect(request.messages[1].content).toContain(line.id);
    expect(request.messages[0].content).toContain('occurred/omitted/unknown');
    expect(request.messages[0].content).toContain('add');
  });
  it('uses one plain-text request before deterministic drawing and keeps the source immutable', async () => {
    const mock = replies([ledgerFixture()]); const schema = await extractEventDraft(config, ledgerSource);
    expect(mock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(mock.mock.calls[0][1]?.body));
    expect(request.messages[1].content).toContain('[p1] 09:00');
    expect(request.messages[1].content).not.toContain('"paragraphId"');
    expect(schema.analysis?.facts).toEqual([]); expect(schema.analysis?.events).toHaveLength(2);
    expect(schema.analysis?.sources[0].text).toBe(ledgerSource);
    expect(visibleSchema(schema).nodes).toHaveLength(3); expect(visibleSchema(schema).edges).toHaveLength(2);
  });
  it('sends only the bad row and referenced source in a repair', async () => {
    const mock = replies([invalid(), repair]); const schema = await extractEventDraft(config, ledgerSource);
    expect(mock).toHaveBeenCalledTimes(2); expect(schema.analysis?.events.map((event) => event.id)).toEqual(['E1','E2']);
    const request = JSON.parse(String(mock.mock.calls[1][1]?.body));
    expect(request.messages[1].content).not.toContain('装置が停止した');
    expect(request.messages[1].content).not.toContain('[p2]');
  });
  it('does not accept empty repairs or changes to unaffected IDs', async () => {
    const mock = replies([invalid(), '[イベント]\n[完了]', '[イベント]\nE3\t-\tX\tX\t-\tp1\trecorded\n[完了]']);
    await expect(extractEventDraft(config, ledgerSource)).rejects.toThrow('修復'); expect(mock).toHaveBeenCalledTimes(3);
  });
  it('retains the accepted rows after an upstream failure and resumes the repair', async () => {
    const first = replies([invalid(), 504]);
    await expect(extractEventDraft(config, ledgerSource)).rejects.toThrow('504'); expect(first).toHaveBeenCalledTimes(2);
    const second = replies([repair]);
    expect((await extractEventDraft(config, ledgerSource)).analysis?.events).toHaveLength(2);
    expect(second).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(second.mock.calls[0][1]?.body)); expect(request.messages[1].content).toContain('修復対象');
  });
  it('rejects truncated content even if it contains a complete table', async () => {
    const mock = replies([ledgerFixture()], 'length'); await expect(extractEventDraft(config, ledgerSource)).rejects.toThrow('出力上限'); expect(mock).toHaveBeenCalledTimes(1);
  });
  it('does not silently retry a JSON response or missing completion marker with the full source', async () => {
    const mock = replies(['{"events":[]}']); await expect(extractEventDraft(config, ledgerSource)).rejects.toThrow(); expect(mock).toHaveBeenCalledTimes(1);
  });
  it('stops before making a cancelled request', async () => {
    const mock = replies([]); const controller = new AbortController(); controller.abort();
    await expect(extractEventDraft(config, ledgerSource, controller.signal)).rejects.toThrow('USER_CANCELLED'); expect(mock).not.toHaveBeenCalled();
  });
  it('classifies with TSV and direct source references in a separate operation', async () => {
    const mock = replies([ledgerFixture(), '[判定]\nE1\tnormal\t記録された作業\tsource_1/p1\nE2\tundetermined\t根拠不足\t-\n[完了]']);
    const schema = await extractEventDraft(config, ledgerSource);
    const classified = await classifyEventDraft(config, schema.analysis!);
    expect(classified.events.map((event) => event.classification)).toEqual(['normal','undetermined']);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('repairs missing classification rows without changing the accepted rows', async () => {
    replies([ledgerFixture(), '[判定]\nE1\tnormal\t記録\tsource_1/p1\n[完了]', '[判定]\nE2\tundetermined\t根拠不足\t-\n[完了]']);
    const schema = await extractEventDraft(config, ledgerSource);
    expect((await classifyEventDraft(config, schema.analysis!)).events[0].classification).toBe('normal');
  });
  it('re-extracts the selected source with existing-event context, retaining the original IDs', async () => {
    const extra = '[主体]\nA2\t装置\tmachine\n[イベント]\nE1\t-\t再確認\t装置を再確認した\tA2:actor\tp3\trecorded\n[関係]\n[共有カード]\n[整理]\n[完了]';
    const text = ledgerSource.replace('参考文献', '装置を再確認した。');
    const initial = ledgerFixture().replace('D1\texcluded', 'D1\treview');
    const mock = replies([initial, extra]); const schema = await extractEventDraft(config, text);
    const restored = await restoreNormalizedPassage(config, schema, 'D1');
    expect(restored.analysis?.events).toHaveLength(3); expect(restored.analysis?.entities).toHaveLength(2);
    expect(restored.analysis?.events.slice(0,2).map((event) => event.id)).toEqual(['E1','E2']);
    expect(restored.analysis?.dispositions).toEqual([]);
    expect(JSON.parse(String(mock.mock.calls[1][1]?.body)).messages[1].content).not.toContain('[p1]');
  });
  it('consolidates extracted subjects to maxSubjects and respects the limit during restoreNormalizedPassage', async () => {
    const sixSubjectsLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t報告者（私）\tperson\treporter\t-\tp1',
      'A2\t現場リーダー\tperson\thigh\t-\tp1',
      'A3\t保守担当\tperson\thigh\t-\tp2',
      'A4\t品質担当\tperson\tmid\t-\tp2',
      'A5\t倉庫係\tperson\tlow\t-\tp2',
      'A6\t運送業者\torganization\tlow\t-\tp2',
      '[イベント]',
      'E1\t09:00\t連絡\t報告者が現場リーダーへ連絡した\tA1:actor,A2:confirmed_recipient\tp1\trecorded',
      'E2\t10:00\t確認\t保守担当・品質担当・倉庫係・運送業者が確認した\tA3:actor,A4:affected,A5:affected,A6:affected\tp2\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      'D1\treview\tp3\t追加記述\t再抽出対象',
      '[完了]',
    ].join('\n');
    const restoreLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A7\t外部監査員\tperson\tlow\t-\tp3',
      '[イベント]',
      'E1\t11:00\t監査記録\t外部監査員が記録した\tA7:actor\tp3\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    replies([sixSubjectsLedger, restoreLedger]);
    const schema = await extractEventDraft(config, ledgerSource, undefined, 'event-chain', 4);
    expect(schema.analysis?.entities).toHaveLength(4);
    expect(schema.analysis?.entities.some((e) => e.name === 'その他の関係者' && e.aggregate)).toBe(true);
    expect(schema.analysis?.subjectRanking?.maxSubjects).toBe(4);
    expect(schema.analysis?.subjectRanking?.originalEntities).toHaveLength(6);

    const restored = await restoreNormalizedPassage(config, schema, 'D1');
    expect(restored.analysis?.entities).toHaveLength(4);
    expect(restored.analysis?.events).toHaveLength(3);
  });
});
