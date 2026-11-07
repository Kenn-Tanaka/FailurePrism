import { describe, it, expect } from 'vitest';
import { parseRefinementReviewTSV, refineGranularity } from './granularityRefinement';
import { sourceFromText } from '../../features/vta/utils/eventAnalysis';
import { inspectLedger, parseLedger } from '../../features/vta/utils/eventLedger';
import type { LLMConfig } from '../../types/vta';

const dummyConfig: LLMConfig = {
  baseUrl: 'http://localhost:8765/v1',
  gatewayToken: '',
  selectedModel: 'test-model',
  timeoutSeconds: 30,
};

describe('granularityRefinement', () => {
  it('parses [評価] and [修正] TSV sections and ignores invalid lines without throwing', () => {
    const tsv = [
      '[評価]',
      '項目\t値\t理由',
      'C2\t0.88\t役割一貫',
      'C4\t0.92\t境界妥当',
      'シナリオ\t4\t主要因果は捉えている',
      'INVALID\t99\t不正行',
      '[修正]',
      'ID\t操作\t対象ID\t内容\t原文参照\t理由',
      'M1\tadd_relation\t-\timpact:E1:A1:E2:A2:other:occurred:na\tp2\t原文p2に影響が明記',
      'M_BAD\tdelete_event\tE1\t-\tp1\tイベント削除は不可',
      '[完了]',
    ].join('\n');

    const parsed = parseRefinementReviewTSV(tsv);
    expect(parsed.c2).toBe(0.88);
    expect(parsed.c4).toBe(0.92);
    expect(parsed.scenarioScore).toBe(0.75); // (4 - 1) / 4 = 0.75
    expect(parsed.scenarioReason).toBe('主要因果は捉えている');
    expect(parsed.ops).toHaveLength(1);
    expect(parsed.ops[0].op).toBe('add_relation');
    expect(parsed.invalidLines).toHaveLength(2);
  });

  it('improves disconnected chain by applying add_relation and records iterations in normalizationAudit', async () => {
    const source = sourceFromText(
      '09:00 整備士Aがボルトを仮止めした。\n09:30 運転員Bが装置を稼働させ、振動により部品が破損した。'
    );
    const doc = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t整備士A\tperson\thigh\t-\tp1',
        'A2\t運転員B\tperson\thigh\t-\tp2',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\tボルト仮止め\t整備士Aがボルトを仮止めした\tA1:actor\tp1\trecorded',
        'E2\t09:30\t稼働と部品破損\t運転員Bが装置を稼働させ部品が破損した\tA2:actor\tp2\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE2\tp2\t部品破損が発生',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E1\tvariation\t仮止めのまま終了\tp1',
        'E2\tvariation\t部品破損が発生\tp2',
        '[完了]',
      ].join('\n')
    );
    const rawAnalysis = inspectLedger(doc, source).analysis!;

    let callCount = 0;
    const mockChat = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          latencyMs: 10,
          content: [
            '[評価]',
            '項目\t値\t理由',
            'C2\t0.90\t役割は明確',
            'C4\t0.95\t境界も妥当',
            '[修正]',
            'ID\t操作\t対象ID\t内容\t原文参照\t理由',
            'OP1\tadd_relation\t-\timpact:E1:A1:E2:A2:material:occurred:na\tp2\t仮止め状態が稼働時の振動破損に影響',
            '[完了]',
          ].join('\n'),
        };
      }
      return {
        latencyMs: 10,
        content: [
          '[評価]',
          '項目\t値\t理由',
          'C2\t0.92\t一貫',
          'C4\t0.95\t妥当',
          '[修正]',
          'ID\t操作\t対象ID\t内容\t原文参照\t理由',
          '[完了]',
        ].join('\n'),
      };
    };

    const logs: string[] = [];
    const refined = await refineGranularity(
      dummyConfig,
      rawAnalysis,
      5,
      undefined,
      mockChat,
      (_type, msg) => logs.push(msg),
      2
    );

    expect(refined.analysis?.relations).toHaveLength(1);
    expect(refined.analysis?.relations[0].kind).toBe('impact');
    const iterations = refined.analysis?.normalizationAudit?.iterations;
    expect(iterations).toBeDefined();
    expect(iterations!.length).toBeGreaterThanOrEqual(2);
    expect(iterations![1].adopted).toBe(true);
    expect(iterations![1].score).toBeGreaterThan(iterations![0].score);
  });

  it('retains best-so-far snapshot when a subsequent iteration degrades the score', async () => {
    const source = sourceFromText(
      '09:00 整備士Aがボルトを仮止めした。\n09:30 運転員Bが装置を稼働させ、部品が破損した。'
    );
    const doc = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t整備士A\tperson\thigh\t-\tp1',
        'A2\t運転員B\tperson\thigh\t-\tp2',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\tボルト仮止め\t整備士Aがボルトを仮止めした\tA1:actor\tp1\trecorded',
        'E2\t09:30\t稼働と部品破損\t運転員Bが装置を稼働させ部品が破損した\tA2:actor\tp2\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\timpact\tE1\tA1\tE2\tA2\tp2\tmaterial\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE2\tp2\t部品破損が発生',
        '[完了]',
      ].join('\n')
    );
    const rawAnalysis = inspectLedger(doc, source).analysis!;

    const mockChat = async () => ({
      latencyMs: 10,
      content: [
        '[評価]',
        '項目\t値\t理由',
        'C2\t0.30\t低評価',
        'C4\t0.30\t低評価',
        '[修正]',
        'ID\t操作\t対象ID\t内容\t原文参照\t理由',
        'OP1\tremove_relation\tR1\t-\tp2\t関係を削除して分断させるテスト',
        '[完了]',
      ].join('\n'),
    });

    const refined = await refineGranularity(
      dummyConfig,
      rawAnalysis,
      5,
      undefined,
      mockChat,
      () => {},
      2
    );

    // Since removing R1 disconnects the graph and lowers score, the initial snapshot with R1 is kept
    expect(refined.analysis?.relations.some((r) => r.id === 'R1')).toBe(true);
    const iterations = refined.analysis?.normalizationAudit?.iterations!;
    expect(iterations[1].adopted).toBe(false);
  });

  it('injects user assumptions, pinned entity constraints, and one-time directive into review prompt', async () => {
    const source = sourceFromText('09:00 作業員Aがバルブを開けた。\n09:10 警報が鳴った。');
    const doc = parseLedger([
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t作業員A\tperson\thigh\t-\tp1',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\tバルブ開\t作業員Aがバルブを開けた\tA1:actor\tp1\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'O1\tnot_found\t-\t-\tなし',
      '[完了]',
    ].join('\n'));

    const inspected = inspectLedger(doc, source);
    const rawAnalysis = inspected.analysis!;

    let receivedUserPrompt = '';
    const mockChat = async (_cfg: unknown, messages: Array<{ role: string; content: string }>) => {
      receivedUserPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      return {
        latencyMs: 10,
        content: '[評価]\n項目\t値\t理由\nC2\t0.9\t良好\nC4\t0.9\t良好\n[修正]\nID\t操作\t対象ID\t内容\t原文参照\t理由\n[完了]',
      };
    };

    await refineGranularity(
      dummyConfig,
      rawAnalysis,
      3,
      undefined,
      mockChat,
      () => {},
      1,
      0.82,
      0.02,
      undefined,
      'ヒューマンエラーに着目して',
      [{ id: 'asm1', text: '当日は雨天で視界不良と仮定', enabled: true }],
      { pinnedEntityIds: ['A1'], timeRange: { enabled: true, start: '09:00', end: '09:30' } }
    );

    expect(receivedUserPrompt).toContain('当日は雨天で視界不良と仮定');
    expect(receivedUserPrompt).toContain('固定主体（マージ禁止）: A1');
    expect(receivedUserPrompt).toContain('対象時間帯: 09:00 〜 09:30');
    expect(receivedUserPrompt).toContain('ヒューマンエラーに着目して');
    expect(receivedUserPrompt).toContain('【現在の因果シナリオ（帰結から逆走抽出された主要プロセス）】');
    expect(receivedUserPrompt).toContain('【シナリオに含まれていないイベント一覧】');
  });
});
