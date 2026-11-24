import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyRefinementOps, parseRefinementReviewTSV, refineGranularity } from './granularityRefinement';
import { debugRecorder } from '../debugRecorder';
import { projectAnalysis, sourceFromText } from '../../features/vta/utils/eventAnalysis';
import { inspectLedger, parseLedger } from '../../features/vta/utils/eventLedger';
import { visibleSchema } from '../../features/vta/utils/presentation';
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

  it('decides adoption in later iterations with the same-iteration LLM scores on both sides (ADR-0059)', async () => {
    const source = sourceFromText(
      '09:00 整備士Aがボルトを仮止めした。\n09:30 運転員Bが装置を稼働させた。\n10:00 振動により部品が破損した。'
    );
    const doc = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t整備士A\tperson\thigh\t-\tp1',
        'A2\t運転員B\tperson\thigh\t-\tp2',
        'A3\t装置\tmachine\thigh\t-\tp3',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\tボルト仮止め\t整備士Aがボルトを仮止めした\tA1:actor\tp1\trecorded',
        'E2\t09:30\t装置稼働\t運転員Bが装置を稼働させた\tA2:actor\tp2\trecorded',
        'E3\t10:00\t部品破損\t振動により部品が破損した\tA3:actor\tp3\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE3\tp3\t部品破損が発生',
        '[完了]',
      ].join('\n')
    );
    const rawAnalysis = inspectLedger(doc, source).analysis!;
    const review = (c2: string, c4: string, op: string) => ({
      latencyMs: 10,
      content: ['[評価]', '項目\t値\t理由', `C2\t${c2}\t評価`, `C4\t${c4}\t評価`, '[修正]', 'ID\t操作\t対象ID\t内容\t原文参照\t理由', op, '[完了]'].join('\n'),
    });
    const replies = [
      // #1: the LLM rates the current diagram highly and proposes a connection.
      review('1.00', '1.00', 'OP1\tadd_relation\t-\timpact:E1:A1:E2:A2:material:occurred:na\tp2\t仮止め状態のまま稼働に影響'),
      // #2: the LLM now rates the (improved) diagram low, but proposes another valid connection that
      // improves machine metrics. The low score describes the reviewed diagram, not the candidate.
      review('0.00', '0.00', 'OP2\tadd_relation\t-\timpact:E2:A2:E3:A3:material:occurred:na\tp3\t稼働の振動が破損に影響'),
    ];
    const logs: string[] = [];
    const refined = await refineGranularity(dummyConfig, rawAnalysis, 5, undefined, async () => replies.shift()!, (_t, msg) => logs.push(msg), 2);

    const iterations = refined.analysis?.normalizationAudit?.iterations!;
    expect(iterations[1].adopted).toBe(true);
    // Previously the #2 candidate was compared against #1's LLM-boosted score and rejected by the LLM score drop.
    expect(iterations[2].adopted).toBe(true);
    expect(refined.analysis?.relations.map((r) => `${r.sourceEventId}->${r.targetEventId}`).sort()).toEqual(['E1->E2', 'E2->E3']);
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

  it('rejects first-iteration degradation via same-scale baseline comparison even when LLM C2/C4 are high, and keeps iterations[0] immutable', async () => {
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
        'C2\t0.98\t高評価',
        'C4\t0.98\t高評価',
        'シナリオ\t5\t非常に良好',
        '[修正]',
        'ID\t操作\t対象ID\t内容\t原文参照\t理由',
        'OP1\tremove_relation\tR1\t-\tp2\t分断させる誤提案',
        '[完了]',
      ].join('\n'),
    });

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

    expect(refined.analysis?.relations.some((r) => r.id === 'R1')).toBe(true);
    const iterations = refined.analysis?.normalizationAudit?.iterations!;
    expect(iterations[0].metrics.c2).toBeUndefined();
    expect(iterations[0].metrics.c4).toBeUndefined();
    expect(iterations[1].adopted).toBe(false);
    expect(logs.some((line) => line.includes('[粒度反復 #1]') && line.includes('C2=0.98') && line.includes('C4=0.98'))).toBe(true);
  });

  describe('diagnostics hygiene & intra-lane dependency guard', () => {
    beforeEach(() => {
      debugRecorder.setEnabled(false);
      debugRecorder.clear();
    });

    afterEach(() => {
      debugRecorder.setEnabled(false);
      debugRecorder.clear();
    });

    it('records graph.projection only for adopted iterations, includes appliedOps & rejection reasons in logs, and blocks same-consolidated-lane dependencies', async () => {
      debugRecorder.setEnabled(true);
      const source = sourceFromText(
        '09:00 整備士Aがボルトを仮止めした。\n09:30 運転員Bが装置を稼働させ、部品が破損した。'
      );
      const doc = parseLedger(
        [
          '[主体]',
          'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
          'TEAM\t作業チーム\torganization\thigh\t-\tp1',
          'A1\t整備士A\tperson\thigh\tTEAM\tp1',
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

      const logs: string[] = [];
      await refineGranularity(
        dummyConfig,
        rawAnalysis,
        5,
        undefined,
        async () => ({
          latencyMs: 10,
          content: [
            '[評価]',
            '項目\t値\t理由',
            'C2\t0.95\t高評価',
            'C4\t0.95\t高評価',
            'シナリオ\t5\t最良',
            '[修正]',
            'ID\t操作\t対象ID\t内容\t原文参照\t理由',
            'OP1\tremove_relation\tR1\t-\tp2\t分断させる不採用操作',
            '[完了]',
          ].join('\n'),
        }),
        (_t, msg) => logs.push(msg),
        1
      );

      // Only #0 initial projection should be recorded; rejected #1 must NOT pollute graph.projection
      const projections = debugRecorder.getEntries().filter((e) => e.stage === 'graph.projection');
      expect(projections).toHaveLength(1);
      expect(logs.some((l) => l.includes('[remove_relation:R1]') && l.includes('採用=いいえ') && l.includes('理由:'))).toBe(true);

      // Also verify add_relation dependency targeting same consolidated lane is ignored
      const consolidatedSchema = await refineGranularity(dummyConfig, rawAnalysis, 2, undefined, async () => ({
        latencyMs: 5,
        content: '[評価]\n項目\t値\t理由\nC2\t0.8\t良\nC4\t0.8\t良\n[修正]\nID\t操作\t対象ID\t内容\t原文参照\t理由\n[完了]',
      }), () => {}, 0);
      const { appliedOps } = applyRefinementOps(
        consolidatedSchema,
        [
          {
            id: 'DEP_SAME',
            op: 'add_relation',
            targetId: '-',
            content: `dependency:E1:${consolidatedSchema.analysis!.participations[0].entityId}:E2:${consolidatedSchema.analysis!.participations[0].entityId}:-:-:na`,
            sourceRefs: ['p1'],
            reason: '同一統合レーン内依存テスト',
          },
        ],
        2,
        new Set<string>(),
        () => {}
      );
      expect(appliedOps).toEqual([]);
    });

    it('rejects equal-score #1 iterations that add no visible edges or machine score improvement, and includes bottleneck hints in review prompt', async () => {
      const source = sourceFromText(
        '09:00 整備士Aが作業した。\n09:30 運転員Bが異常発生した。'
      );
      const doc = parseLedger(
        [
          '[主体]',
          'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
          'A1\t整備士A\tperson\thigh\t-\tp1',
          'A2\t運転員B\tperson\thigh\t-\tp2',
          '[イベント]',
          'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
          'E1\t09:00\t作業\t整備士Aが作業した\tA1:actor\tp1\trecorded',
          'E2\t09:30\t異常\t運転員Bが異常発生した\tA2:actor\tp2\trecorded',
          '[関係]',
          'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
          '[共有カード]',
          'ID\t主体\tイベント',
          '[整理]',
          'ID\t区分\t原文参照\t要旨\t理由',
          '[帰結]',
          'ID\t判定\tイベントID\t原文参照\t理由',
          'O1\tidentified\tE2\tp2\t異常発生',
          '[完了]',
        ].join('\n')
      );
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      let promptSeen = '';
      let calls = 0;
      const logs: string[] = [];
      const refined = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        1,
        undefined,
        async (_cfg, msgs) => {
          calls++;
          promptSeen = msgs.find((m) => m.role === 'user')?.content ?? '';
          return {
            latencyMs: 10,
            content: [
              '[評価]',
              '項目\t値\t理由',
              'C2\t0.75\t良好',
              'C4\t0.95\t良好',
              'シナリオ\t3\t一部欠落',
              '[修正]',
              'ID\t操作\t対象ID\t内容\t原文参照\t理由',
              'A1\tadd_relation\t-\tbefore:E1:-:E2:-:-:-:na\tp1,p2\t順序のみの追記（可視エッジ増なし）',
              '[完了]',
            ].join('\n'),
          };
        },
        (_t, msg) => logs.push(msg),
        2
      );

      // Adding a before relation adds 0 visible edges and leaves C1/C3/C5 equal -> reject equal-score tie & stop after #1
      expect(calls).toBe(1);
      const iterations = refined.analysis?.normalizationAudit?.iterations!;
      expect(iterations[1].adopted).toBe(false);
      expect(promptSeen).toContain('【現在の構造スコア】');
      expect(promptSeen).toContain('【現在の構造ボトルネックと優先改善指針】');
      expect(logs.some((l) => l.includes('採用=いいえ') && l.includes('実質的改善なし'))).toBe(true);
    });

    it('rejects temporally reversed precedence relations and same-event self-loops in applyRefinementOps', () => {
      const source = sourceFromText(
        '09:00 整備士Aがボルトを仮止めした。\n09:30 運転員Bが装置を稼働させた。'
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
          'E2\t09:30\t装置稼働\t運転員Bが装置を稼働させた\tA2:actor\tp2\trecorded',
          '[関係]',
          'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
          '[共有カード]',
          'ID\t主体\tイベント',
          '[整理]',
          'ID\t区分\t原文参照\t要旨\t理由',
          '[完了]',
        ].join('\n')
      );
      const baseAnalysis = inspectLedger(doc, source).analysis!;
      const { appliedOps, schema } = applyRefinementOps(
        projectAnalysis(baseAnalysis),
        [
          {
            id: 'M_REV',
            op: 'add_relation',
            targetId: '-',
            content: 'transfer:E2:A2:E1:A1:information:occurred:confirmed',
            sourceRefs: ['p1', 'p2'],
            reason: '時刻逆転の誤提案',
          },
          {
            id: 'M_SELF',
            op: 'add_relation',
            targetId: '-',
            content: 'transfer:E1:A1:E1:A1:information:occurred:confirmed',
            sourceRefs: ['p1'],
            reason: '同一イベント同一主体の自己ループ',
          },
          {
            id: 'M_OK',
            op: 'add_relation',
            targetId: '-',
            content: 'transfer:E1:A1:E2:A2:information:occurred:confirmed',
            sourceRefs: ['p1', 'p2'],
            reason: '時系列に沿った正常提案',
          },
        ],
        5,
        new Set(),
        () => {}
      );
      expect(appliedOps).toEqual(['add_relation:rel_ref_M_OK']);
      expect(schema.analysis?.relations.map((r) => r.id)).toEqual(['rel_ref_M_OK']);
    });

    it('does not destroy shared association edges or degrade C3 when ineligible multi-card suppress and group ops are proposed alongside add_relation (ADR-0056)', async () => {
      const source = sourceFromText(
        [
          '17:45 乗組員Aが指示を確認し待機位置へ向かった。',
          '17:46 乗組員Aと管制官Tが交信した。',
          '17:46 管制官Tが着陸許可を出した。',
          '17:47 乗客係Bが案内を開始した。',
          '17:48 衝突による損傷が発生した。',
        ].join('\n')
      );
      const doc = parseLedger(
        [
          '[主体]',
          'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
          'ACREW\tA機乗組員\tperson\thigh\t-\tp1',
          'TWR\tタワー管制\tperson\thigh\t-\tp2',
          'BCREW\tB機乗務員\tperson\thigh\t-\tp4',
          '[イベント]',
          'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
          'E1\t17:45\t指示確認\t乗組員Aが指示を確認した\tACREW:actor\tp1\trecorded',
          'E2\t17:45\t待機位置移動\t乗組員Aが待機位置へ向かった\tACREW:actor\tp1\trecorded',
          'E3\t17:46\t交信\t乗組員Aと管制官Tが交信した\tACREW:actor,TWR:actor\tp2\trecorded',
          'E3B\t17:46\t着陸許可\t管制官Tが着陸許可を出した\tTWR:actor\tp3\trecorded',
          'E4\t17:47\t案内開始\t乗客係Bが案内を開始した\tBCREW:actor\tp4\trecorded',
          'E5\t17:48\t衝突損傷\t衝突による損傷が発生した\tBCREW:affected\tp5\trecorded',
          '[関係]',
          'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
          '[共有カード]',
          'ID\t主体\tイベント',
          '[整理]',
          'ID\t区分\t原文参照\t要旨\t理由',
          '[帰結]',
          'ID\t判定\tイベントID\t原文参照\t理由',
          'O1\tidentified\tE5\tp5\t衝突による損傷が発生',
          '[仮判定]',
          'イベントID\t判定\t理由\t原文参照',
          'E1\tvariation\t確認不十分\tp1',
          'E2\tvariation\t移動判断の逸脱\tp1',
          'E4\tvariation\t案内手順の逸脱\tp4',
          '[完了]',
        ].join('\n')
      );
      const rawAnalysis = inspectLedger(doc, source).analysis!;
      const initialProjected = projectAnalysis(rawAnalysis);
      // E3 is shared across ACREW (which has 3 cards: E1, E2, E3) and TWR (which has 2 cards: E3, E3B)
      const acrewE3Card = initialProjected.analysis!.cards.find(
        (c) => c.laneEntityId === 'ACREW' && c.eventIds.includes('E3')
      )!;
      const twrE3Card = initialProjected.analysis!.cards.find(
        (c) => c.laneEntityId === 'TWR' && c.eventIds.includes('E3')
      )!;
      expect(acrewE3Card).toBeDefined();
      expect(twrE3Card).toBeDefined();

      const logs: string[] = [];
      let callCount = 0;
      const refined = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        5,
        undefined,
        async () => {
          callCount++;
          if (callCount === 1) {
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.55\t役割混在あり',
                'C4\t0.85\t境界妥当',
                'シナリオ\t3\t一部未接続',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M6\tadd_relation\t-\timpact:E3B:TWR:E4:BCREW:other:occurred:na\tp3,p4\t管制からB機への影響',
                'M7\tgroup\tACREW\tE1,E2\tp1\t同時刻動作の集約',
                `M8\tsuppress\t${acrewE3Card.id}\t-\tp2\t複数カードレーンの共有カードに対する無効なsuppress提案`,
                `M9\tsuppress\t${twrE3Card.id}\t-\tp2\t複数カードレーンの共有カードに対する無効なsuppress提案`,
                '[完了]',
              ].join('\n'),
            };
          }
          return {
            latencyMs: 10,
            content: '[評価]\n項目\t値\t理由\nC2\t0.80\t改善\nC4\t0.85\t妥当\nシナリオ\t4\t改善\n[修正]\nID\t操作\t対象ID\t内容\t原文参照\t理由\n[完了]',
          };
        },
        (_t, msg) => logs.push(msg),
        2
      );

      // Verify shared edge for E3 was NOT wiped out by the ineligible suppress ops
      expect(refined.edges.some((e) => e.meaning === 'association' && e.eventId === 'E3')).toBe(true);

      // Verify ineligible suppress ops were not falsely recorded in appliedOps, while add_relation and group were adopted
      const iter1 = refined.analysis?.normalizationAudit?.iterations?.[1];
      expect(iter1?.adopted).toBe(true);
      expect(iter1?.operations).toContain('add_relation:rel_ref_M6');
      expect(iter1?.operations).toContain('group:ACREW(E1,E2)');
      expect(iter1?.operations.some((op) => op.startsWith('suppress:'))).toBe(false);
    });

    it('does not record group op in appliedOps when buildAnalysis skips it due to mismatched paragraph timing (ADR-0056)', async () => {
      const source = sourceFromText(
        [
          '17:45 乗組員Aが指示を確認した。',
          '17:46 乗組員Aが待機位置へ向かった。',
        ].join('\n')
      );
      const doc = parseLedger(
        [
          '[主体]',
          'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
          'ACREW\tA機乗組員\tperson\thigh\t-\tp1',
          '[イベント]',
          'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
          'E1\t17:45\t指示確認\t乗組員Aが指示を確認した\tACREW:actor\tp1\trecorded',
          'E2\t-\t待機位置移動\t乗組員Aが待機位置へ向かった\tACREW:actor\tp2\trecorded',
          '[関係]',
          'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
          '[共有カード]',
          'ID\t主体\tイベント',
          '[整理]',
          'ID\t区分\t原文参照\t要旨\t理由',
          '[完了]',
        ].join('\n')
      );
      const baseAnalysis = inspectLedger(doc, source).analysis!;
      const initialSchema = projectAnalysis(baseAnalysis);
      expect(initialSchema.analysis?.cards).toHaveLength(2);

      const { appliedOps, schema } = applyRefinementOps(
        initialSchema,
        [
          {
            id: 'M_GRP_DIFF_TIME',
            op: 'group',
            targetId: 'ACREW',
            content: 'E1,E2',
            sourceRefs: ['p1', 'p2'],
            reason: '異なる時刻の近接アクションに対する無効なgroup提案',
          },
        ],
        5,
        new Set(),
        () => {}
      );

      expect(appliedOps).toEqual([]);
      expect(schema.analysis?.cards).toHaveLength(2);
    });

    it('adopts causal add_relation when pure machine score improves despite scenarioScore 0.4x compression and non-outcome degree increase', async () => {
      // Reproduce the exact mathematical case where ΔC3 ≈ +0.083 and ΔC5 ≈ -0.05:
      // With uncorrupted machine weights (w3=0.25, w5=0.15), ΔS_machine > 0.
      // Under the old 0.4*C3 mixing bug (0.4*w3=0.10 < w5=0.15), ΔS would turn negative and falsely reject.
      const source = sourceFromText([
        '09:00 A1が逸脱操作1を行った。',
        '09:05 A2が状態変化1を確認しA3と共有した。',
        '09:10 A3が逸脱操作2を行った。',
        '09:15 A4が逸脱操作3を行った。',
        '09:20 A5が逸脱操作4を行った。',
        '09:25 A2が監視装置と確認1を行った。',
        '09:30 A2が確認2を行った。',
        '09:35 A2が最終損失に到達した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t主体1\tperson\thigh\t-\tp1',
        'A2\t主体2\tperson\thigh\t-\tp2,p8',
        'A3\t主体3\tperson\thigh\t-\tp3',
        'A4\t主体4\tperson\thigh\t-\tp4',
        'A5\t主体5\tperson\thigh\t-\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t逸脱1\tA1が逸脱操作1を行った\tA1:actor\tp1\trecorded',
        'E2\t09:05\t共有確認\tA2が状態変化1を確認しA3と共有した\tA2:actor,A3:confirmed_recipient\tp2\trecorded',
        'E3\t09:10\t逸脱2\tA3が逸脱操作2を行った\tA3:actor\tp3\trecorded',
        'E4\t09:15\t逸脱3\tA4が逸脱操作3を行った\tA4:actor\tp4\trecorded',
        'E5\t09:20\t逸脱4\tA5が逸脱操作4を行った\tA5:actor\tp5\trecorded',
        'E6\t09:25\t確認1\tA2が監視装置と確認1を行った\tA2:actor,A1:target\tp6\trecorded',
        'E7\t09:30\t確認2\tA2が確認2を行った\tA2:actor\tp7\trecorded',
        'E8\t09:35\t最終損失\tA2が最終損失に到達した\tA2:affected\tp8\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\timpact\tE3\tA3\tE2\tA3\tp2,p3\tother\toccurred\tna',
        'R2\timpact\tE4\tA4\tE2\tA2\tp2,p4\tother\toccurred\tna',
        'R3\timpact\tE5\tA5\tE2\tA2\tp2,p5\tother\toccurred\tna',
        'R4\timpact\tE2\tA2\tE8\tA2\tp8\tother\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE8\tp8\t最終損失',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E1\tvariation\t逸脱1\tp1',
        'E3\tvariation\t逸脱2\tp3',
        'E4\tvariation\t逸脱3\tp4',
        'E5\tvariation\t逸脱4\tp5',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      const refined = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        5,
        undefined,
        async () => ({
          latencyMs: 10,
          content: [
            '[評価]',
            '項目\t値\t理由',
            'C2\t0.80\t役割一貫',
            'C4\t0.95\t境界妥当',
            'シナリオ\t3\t未接続の変動あり',
            '[修正]',
            'ID\t操作\t対象ID\t内容\t原文参照\t理由',
            'M1\tadd_relation\t-\timpact:E1:A1:E2:A2:other:occurred:na\tp1,p2\t逸脱1が状態変化1に影響',
            '[完了]',
          ].join('\n'),
        }),
        () => {},
        1
      );

      const iter1 = refined.analysis?.normalizationAudit?.iterations?.[1];
      expect(iter1?.adopted).toBe(true);
      expect(refined.analysis?.relations.some((r) => r.id === 'rel_ref_M1')).toBe(true);
    });

    it('keeps SubjectPoset acyclic when merging an ancestor organization into its child hub (ADR-0064)', () => {
      const source = sourceFromText([
        '09:00 空港事務所が方針を通達した。',
        '09:10 羽田調整席が飛行計画を確認した。',
        '09:20 管制所が離陸指示を出した。',
        '09:30 航空機Aが衝突した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CAB_ORG\t空港事務所\torganization\tlow\t-\tp1',
        'A_DF\t羽田調整席\tperson\tlow\tA_CAB_ORG\tp2',
        'A_TWR_ORG\t東京飛行場管制所\torganization\thigh\tA_CAB_ORG\tp3',
        'A_CAPT_A\t機長A\tperson\thigh\t-\tp4',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t通達\t空港事務所が方針を通達した\tA_CAB_ORG:actor\tp1\trecorded',
        'E2\t09:10\t確認\t羽田調整席が飛行計画を確認した\tA_DF:actor\tp2\trecorded',
        'E3\t09:20\t管制指示\t管制所が離陸指示を出した\tA_TWR_ORG:actor\tp3\trecorded',
        'E4\t09:30\t衝突\t航空機Aが衝突した\tA_CAPT_A:affected\tp4\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\ttransfer\tE3\tA_TWR_ORG\tE4\tA_CAPT_A\tp3,p4\tinformation\toccurred\tconfirmed',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE4\tp4\t衝突',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      const { schema, appliedOps } = applyRefinementOps(
        projectAnalysis(rawAnalysis),
        [
          {
            id: 'M_MERGE_UP',
            op: 'merge',
            targetId: 'A_CAB_ORG',
            content: 'A_TWR_ORG',
            sourceRefs: ['p1', 'p3'],
            reason: '現場管制所ハブへ統合',
          },
        ],
        2,
        new Set<string>(),
        () => {}
      );

      expect(appliedOps).toEqual(['merge:A_CAB_ORG->A_TWR_ORG']);
      const origCab = schema.analysis?.subjectRanking?.originalEntities.find((e) => e.id === 'A_CAB_ORG');
      const origTwr = schema.analysis?.subjectRanking?.originalEntities.find((e) => e.id === 'A_TWR_ORG');
      expect(origCab?.parentEntityId).toBeUndefined();
      expect(origCab?.parentEntityIds).toBeUndefined();
      expect(origTwr?.parentEntityId).toBe('A_CAB_ORG');
      expect(schema.analysis?.subjectPoset?.relations.some((r) => r.childId === 'A_CAB_ORG' && r.parentId === 'A_TWR_ORG')).toBe(false);
      expect(schema.analysis?.entities.map((e) => e.id).sort()).toEqual(['A_CAPT_A', 'A_TWR_ORG']);
    });

    it('adopts 1-for-1 semantic edge upgrades over association/sequential ties while blocking duplicate parallel semantic edges (ADR-0064)', async () => {
      const source = sourceFromText([
        '09:00 管制官が乗務員と調整した。',
        '09:10 乗務員が機器操作を誤った。',
        '09:20 最終損失が発生した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'TWR\t管制官\tperson\thigh\t-\tp1',
        'CREW\t乗務員\tperson\thigh\t-\tp1,p2,p3',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t調整\t管制官が乗務員と調整した\tTWR:actor,CREW:confirmed_recipient\tp1\trecorded',
        'E2\t09:10\t誤操作\t乗務員が機器操作を誤った\tCREW:actor\tp2\trecorded',
        'E3\t09:20\t最終損失\t最終損失が発生した\tCREW:affected\tp3\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R_TO_OUTCOME\timpact\tE2\tCREW\tE3\tCREW\tp2,p3\tother\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE3\tp3\t最終損失発生',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E2\tvariation\t誤操作が発生\tp2',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      let call = 0;
      const refined = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        5,
        undefined,
        async () => {
          call++;
          if (call === 1) {
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.90\t役割明確',
                'C4\t0.95\t境界妥当',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M6\tadd_relation\t-\ttransfer:E1:TWR:E1:CREW:information:occurred:confirmed\tp1\t共有イベント未判定線を伝達関係へ明確化',
                '[完了]',
              ].join('\n'),
            };
          }
          if (call === 2) {
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.92\t改善',
                'C4\t0.95\t妥当',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M_DUP\tadd_relation\t-\timpact:E1:TWR:E1:CREW:other:occurred:na\tp1\t既存意味関係ペアへの並列重複追加',
                '[完了]',
              ].join('\n'),
            };
          }
          return {
            latencyMs: 10,
            content: '[評価]\n項目\t値\t理由\nC2\t0.92\t改善\nC4\t0.95\t妥当\n[修正]\nID\t操作\t対象ID\t内容\t原文参照\t理由\n[完了]',
          };
        },
        () => {},
        3
      );

      const iterations = refined.analysis?.normalizationAudit?.iterations ?? [];
      expect(iterations[1]?.adopted).toBe(true);
      expect(iterations[1]?.operations).toContain('add_relation:rel_ref_M6');
      expect(iterations[2]?.operations).toContain('add_relation:rel_ref_M_DUP');
      expect(iterations[2]?.adopted).toBe(false);
      expect(refined.analysis?.relations.some((r) => r.id === 'rel_ref_M_DUP')).toBe(false);
    });

    it('uses uncompressed machineDelta for epsilon convergence break and logs raw C3 / scenario values (ADR-0065)', async () => {
      const source = sourceFromText([
        '09:00 A1が確認1を実施した。',
        '09:10 A2が確認2を実施した。',
        '09:20 A3が確認3を実施した。',
        '09:30 A4で最終損失が発生した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t担当1\tperson\thigh\t-\tp1',
        'A2\t担当2\tperson\thigh\t-\tp2',
        'A3\t担当3\tperson\thigh\t-\tp3',
        'A4\t担当4\tperson\thigh\t-\tp4',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t確認1\tA1が確認1を実施した\tA1:actor\tp1\trecorded',
        'E2\t09:10\t確認2\tA2が確認2を実施した\tA2:actor\tp2\trecorded',
        'E3\t09:20\t確認3\tA3が確認3を実施した\tA3:actor\tp3\trecorded',
        'E4\t09:30\t最終損失\tA4で最終損失が発生した\tA4:affected\tp4\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE4\tp4\t最終損失',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      let calls = 0;
      const logs: string[] = [];
      const refined = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        5,
        undefined,
        async () => {
          calls++;
          if (calls === 1) {
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.90\t良好',
                'C4\t0.95\t妥当',
                'シナリオ\t3\t未接続要素あり',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M1\tadd_relation\t-\timpact:E1:A1:E4:A4:other:occurred:na\tp1,p4\tE1から最終損失へ接続 (4->3成分, machineDelta=+0.0208, compressed=+0.0083)',
                '[完了]',
              ].join('\n'),
            };
          }
          if (calls === 2) {
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.92\t改善',
                'C4\t0.95\t妥当',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M2\tadd_relation\t-\timpact:E2:A2:E4:A4:other:occurred:na\tp2,p4\tE2から最終損失へ接続',
                '[完了]',
              ].join('\n'),
            };
          }
          return {
            latencyMs: 10,
            content: '[評価]\n項目\t値\t理由\nC2\t0.95\t完了\nC4\t0.95\t完了\n[修正]\nID\t操作\t対象ID\t内容\t原文参照\t理由\n[完了]',
          };
        },
        (_t, msg) => logs.push(msg),
        3,
        0.60, // targetScore reached at #1, testing whether compressed < 0.02 wrongly halts before #2
        0.02
      );

      expect(calls).toBeGreaterThanOrEqual(2);
      const iterations = refined.analysis?.normalizationAudit?.iterations ?? [];
      expect(iterations[1]?.adopted).toBe(true);
      expect(iterations[2]?.adopted).toBe(true);
      expect(refined.analysis?.relations.map((r) => r.id)).toEqual(
        expect.arrayContaining(['rel_ref_M1', 'rel_ref_M2'])
      );
      expect(logs.some((l) => l.includes('[機械C3=0.33, シナリオ=0.50]'))).toBe(true);
      expect(logs.some((l) => l.includes('機械S='))).toBe(true);
    });

    it('persists adopted explicitMerges across refinement iterations and avoids leaking rejected split/merge state', async () => {
      const source = sourceFromText([
        '09:05 機長Aが確認した。',
        '09:10 機長Bが進入確認した。',
        '09:08 出域調整席がタワー東管制官へ調整伝達した。',
        '09:20 客室乗務員Bと機長Bが安全確認を相互確認した。',
        '09:15 タワー東管制官が調整を受領した。',
        '09:25 タワー東管制官が進入許可を伝達した。',
        '09:12 訓練乗員Bが計器監視した。',
        '09:35 両機が滑走路上で衝突した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CAP_A\t機長A\tperson\treporter\t-\tp1,p8',
        'A_CAP_B\t機長B\tperson\thigh\t-\tp2,p8',
        'A_TWR_E\tタワー東管制官\tperson\thigh\tA_ATC\tp5,p6',
        'A_CABIN_B\t客室乗務員B\tperson\tmid\tA_CAP_B\tp4',
        'A_DF\t出域調整席\tperson\tlow\tA_ATC\tp3',
        'A_TRAIN_B\t訓練乗員B\tperson\tlow\t-\tp7',
        'A_ATC\t管制機関\torganization\tmid\t-\t-',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:05\t機長確認\t機長Aが確認した\tA_CAP_A:actor\tp1\trecorded',
        'E6\t09:08\t調整伝達\t出域調整席が調整伝達した\tA_DF:actor\tp3\trecorded',
        'E2\t09:10\t進入確認\t機長Bが進入確認した\tA_CAP_B:actor\tp2\trecorded',
        'E3\t09:12\t計器監視\t訓練乗員Bが計器監視した\tA_TRAIN_B:actor\tp7\trecorded',
        'E5a\t09:15\t調整受領\tタワー東管制官が調整を受領した\tA_TWR_E:actor\tp5\trecorded',
        'E4\t09:20\t相互確認\t客室乗務員Bと機長Bが相互確認した\tA_CABIN_B:actor,A_CAP_B:actor\tp4\trecorded',
        'E5b\t09:25\t許可発出\tタワー東管制官が許可を伝達した\tA_TWR_E:actor\tp6\trecorded',
        'E7\t09:35\t衝突事故\t両機が滑走路上で衝突した\tA_CAP_A:affected,A_CAP_B:affected\tp8\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\tmutual\tE4\tA_CABIN_B\tE4\tA_CAP_B\tp4\tinformation\toccurred\tconfirmed',
        'R3\ttransfer\tE6\tA_DF\tE5a\tA_TWR_E\tp3,p5\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE5b\tA_TWR_E\tE7\tA_CAP_B\tp6,p8\tinformation\toccurred\tconfirmed',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE7\tp8\t衝突事故',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E1\tvariation\t確認不十分\tp1',
        'E3\tvariation\t監視遅れ\tp7',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      let calls = 0;
      const refined = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        4,
        undefined,
        async () => {
          calls++;
          if (calls === 1) {
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.85\t訓練乗員を機長Bへ統合',
                'C4\t0.90\t妥当',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M1\tmerge\tA_TRAIN_B\tA_CAP_B\tp7\t訓練乗員Bを機長Bレーンに統合',
                '[完了]',
              ].join('\n'),
            };
          }
          if (calls === 2) {
            // Merge A_TWR_E -> A_ATC AFTER #1's A_TRAIN_B -> A_CAP_B:
            // Requires #1's explicitMerge to persist into #2 so subject_others disappears and lanes drop 5 -> 4.
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.92\t管制部門統合',
                'C4\t0.95\t妥当',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M2\tmerge\tA_TWR_E\tA_ATC\tp5\tタワー東管制官を管制機関へ統合',
                '[完了]',
              ].join('\n'),
            };
          }
          if (calls === 3) {
            // Rejected split attempt must NOT leak into forceRetained/explicitMerges
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.85\tテスト',
                'C4\t0.90\tテスト',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M3\tsplit\tA_TRAIN_B\t独立レーン化\tp7\t一時分離',
                '[完了]',
              ].join('\n'),
            };
          }
          return {
            latencyMs: 10,
            content: '[評価]\n項目\t値\t理由\nC2\t0.95\t完了\nC4\t0.95\t完了\n[修正]\nID\t操作\t対象ID\t内容\t原文参照\t理由\n[完了]',
          };
        },
        () => {},
        4,
        0.95,
        0.001
      );

      const iterations = refined.analysis?.normalizationAudit?.iterations ?? [];
      expect(iterations[1]?.adopted).toBe(true);
      expect(iterations[2]?.adopted).toBe(true);
      expect(iterations[3]?.adopted).toBe(false);
      const ranks = refined.analysis?.subjectRanking?.ranks ?? [];
      expect(ranks.find((r) => r.entityId === 'A_TRAIN_B')?.mergedInto).toBe('A_CAP_B');
      expect(ranks.find((r) => r.entityId === 'A_TWR_E')?.mergedInto).toBe('A_ATC');
      expect(ranks.find((r) => r.entityId === 'A_DF')?.mergedInto).toBe('A_ATC');
      const activeEntityIds = refined.analysis?.entities.map((e) => e.id) ?? [];
      expect(activeEntityIds).toEqual(expect.arrayContaining(['A_CAP_A', 'A_CAP_B', 'A_CABIN_B', 'A_ATC']));
      expect(activeEntityIds).not.toContain('A_TRAIN_B');
      expect(activeEntityIds).not.toContain('A_TWR_E');
      expect(activeEntityIds).not.toContain('subject_others');
      const visibleLanes = visibleSchema(refined).lanes;
      expect(visibleLanes).toHaveLength(4);
      expect(visibleLanes).not.toContain('訓練乗員B');
      expect(visibleLanes).not.toContain('タワー東管制官');
      expect(visibleLanes).not.toContain('その他の関係者');
    });

    it('filters post-outcome non-resilient omitted nodes only when excludePostOutcome is enabled, and avoids early convergence while C3 is below targetScore (ADR-0067)', async () => {
      const source = sourceFromText([
        '17:40 A1が確認1を実施した。',
        '17:42 A2が確認2を実施した。',
        '17:44 A3が確認3を実施した。',
        '17:45 A4が確認4を実施した。',
        '17:46 A5が確認5を実施した。',
        '17:47 A1で衝突損失が発生した。',
        '17:55 A2が緊急脱出誘導を実施した。',
        '18:30 A6が事後調査を実施した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t主体1\tperson\thigh\t-\tp1,p6',
        'A2\t主体2\tperson\thigh\t-\tp2,p7',
        'A3\t主体3\tperson\thigh\t-\tp3',
        'A4\t主体4\tperson\thigh\t-\tp4',
        'A5\t主体5\tperson\thigh\t-\tp5',
        'A6\t調査班\torganization\tlow\t-\tp8',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:40\t確認1\tA1が確認1を実施した\tA1:actor\tp1\trecorded',
        'E2\t17:42\t確認2\tA2が確認2を実施した\tA2:actor\tp2\trecorded',
        'E3\t17:44\t確認3\tA3が確認3を実施した\tA3:actor\tp3\trecorded',
        'E4\t17:45\t確認4\tA4が確認4を実施した\tA4:actor\tp4\trecorded',
        'E5\t17:46\t確認5\tA5が確認5を実施した\tA5:actor\tp5\trecorded',
        'E6\t17:47\t衝突損失\tA1で衝突損失が発生した\tA1:affected\tp6\trecorded',
        'E7\t17:55\t緊急脱出誘導\tA2が緊急脱出誘導を実施した\tA2:actor\tp7\trecorded',
        'E8\t18:30\t事後調査\tA6が事後調査を実施した\tA6:actor\tp8\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE6\tp6\t衝突損失',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E7\tvariation\tレジリエンスによる避難誘導\tp7',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      let promptWithExclude = '';
      let calls = 0;
      // 6 components -> #1 connects 6->5 (componentRatio 0.1667 -> 0.20, ΔC3=+0.0167, machineDelta=+0.0064 < epsilon=0.02)
      // High C1=1.0, C2=0.98, C4=0.98, C5=1.0 push bestScore >= targetScore (0.70), yet mNextRawC3=0.20 < 0.70 -> must NOT break before #2!
      const refined = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        6,
        undefined,
        async (_cfg, msgs) => {
          calls++;
          const userContent = msgs.find((m) => m.role === 'user')?.content ?? '';
          if (calls === 1) {
            promptWithExclude = userContent;
            return {
              latencyMs: 10,
              content: [
                '[評価]',
                '項目\t値\t理由',
                'C2\t0.98\t良好',
                'C4\t0.98\t良好',
                '[修正]',
                'ID\t操作\t対象ID\t内容\t原文参照\t理由',
                'M1\tadd_relation\t-\timpact:E2:A2:E6:A1:other:occurred:na\tp2,p6\t確認2から衝突へ接続',
                '[完了]',
              ].join('\n'),
            };
          }
          return {
            latencyMs: 10,
            content: [
              '[評価]',
              '項目\t値\t理由',
              'C2\t0.98\t良好',
              'C4\t0.98\t良好',
              '[修正]',
              'ID\t操作\t対象ID\t内容\t原文参照\t理由',
              'M2\tadd_relation\t-\timpact:E3:A3:E6:A1:other:occurred:na\tp3,p6\t確認3から衝突へ接続',
              '[完了]',
            ].join('\n'),
          };
        },
        () => {},
        2,
        0.70,
        0.02,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { excludePostOutcome: true }
      );

      expect(calls).toBe(2);
      expect(refined.analysis?.relations.map((r) => r.id)).toEqual(
        expect.arrayContaining(['rel_ref_M1', 'rel_ref_M2'])
      );
      const omittedSectionWithExclude = promptWithExclude.split('【シナリオに含まれていないイベント一覧】')[1] ?? '';
      expect(omittedSectionWithExclude).toContain('確認3');
      expect(omittedSectionWithExclude).toContain('緊急脱出誘導');
      expect(omittedSectionWithExclude).not.toContain('事後調査');

      // When excludePostOutcome is false, post-outcome nodes remain visible in omittedNodes
      let promptWithoutExclude = '';
      await refineGranularity(
        dummyConfig,
        rawAnalysis,
        6,
        undefined,
        async (_cfg, msgs) => {
          promptWithoutExclude = msgs.find((m) => m.role === 'user')?.content ?? '';
          return {
            latencyMs: 10,
            content: '[評価]\n項目\t値\t理由\nC2\t0.9\t良\nC4\t0.9\t良\n[修正]\nID\t操作\t対象ID\t内容\t原文参照\t理由\n[完了]',
          };
        },
        () => {},
        1,
        0.82,
        0.02,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { excludePostOutcome: false }
      );
      const omittedSectionWithoutExclude = promptWithoutExclude.split('【シナリオに含まれていないイベント一覧】')[1] ?? '';
      expect(omittedSectionWithoutExclude).toContain('事後調査');
    });

    it('prunes transitive ancestor edges on merge (e.g. merge:A_F->A_WRK) for Hasse-minimal parentEntityIds and defers subject_others until applyFinalOthersConsolidation (ADR-0072)', async () => {
      debugRecorder.setEnabled(true);
      const source = sourceFromText([
        '08:00 工務事務所が業務を発注した。',
        '08:30 下請会社が業務を受注した。',
        '10:00 作業班が準備した。',
        '10:30 F作業員と作業員らが散布作業を実施した。',
        '10:46 運転士の列車と作業員らが触車し事故が発生した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_TOBU_OF\t東武鉄道北関東工務事務所\torganization\tlow\t-\tp1',
        'A_SUB\t下請会社\torganization\tlow\t-\tp2',
        'A_CREW\t除草薬散布作業班\torganization\thigh\t-\tp3',
        'A_WRK\t作業員（E・H・I・J）\torganization\thigh\tA_CREW\tp4,p5',
        'A_F\tF作業員\tperson\tmid\tA_CREW\tp4',
        'A_DRV\t第1020列車運転士\tperson\thigh\t-\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t08:00\t業務発注\t工務事務所が発注した\tA_TOBU_OF:actor\tp1\trecorded',
        'E2\t08:30\t業務受注\t下請会社が受注した\tA_SUB:actor\tp2\trecorded',
        'E3\t10:00\t準備\t作業班が準備した\tA_CREW:actor\tp3\trecorded',
        'E4\t10:30\t散布作業\tF作業員と作業員らが散布した\tA_F:actor,A_WRK:actor\tp4\trecorded',
        'E5\t10:46\t触車事故\t運転士の列車と作業員らが触車した\tA_DRV:actor,A_WRK:affected\tp5\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\ttransfer\tE1\tA_TOBU_OF\tE2\tA_SUB\tp1,p2\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE2\tA_SUB\tE3\tA_CREW\tp2,p3\tinformation\toccurred\tconfirmed',
        'R3\timpact\tE3\tA_CREW\tE4\tA_WRK\tp3,p4\tother\toccurred\tna',
        'R4\timpact\tE4\tA_WRK\tE5\tA_DRV\tp4,p5\tother\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE5\tp5\t触車事故',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E4\tvariation\t退避遅れ\tp4',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;

      const mockMergeF = async () => ({
        latencyMs: 5,
        content: [
          '[評価]',
          '項目\t値\t理由',
          'C2\t0.90\t良好',
          'C4\t0.95\t良好',
          '[修正]',
          'ID\t操作\t対象ID\t内容\t原文参照\t理由',
          'M1\tmerge\tA_F\tA_WRK\tp4\tF作業員を作業員グループへ統合',
          '[完了]',
        ].join('\n'),
      });

      // 1) Stage 2 default (applyFinalOthersConsolidation omitted/false): keeps named lanes without subject_others even with maxSubjects=4
      const stage2Only = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        4,
        undefined,
        mockMergeF,
        () => {},
        1
      );
      expect(stage2Only.analysis?.entities.some((e) => e.aggregate)).toBe(false);
      expect(stage2Only.analysis?.entities.map((e) => e.id)).toEqual(
        expect.arrayContaining(['A_TOBU_OF', 'A_SUB', 'A_CREW', 'A_WRK', 'A_DRV'])
      );
      // Verify Hasse-minimal parentEntityIds on A_F (A_CREW pruned because A_WRK -> A_CREW already holds!)
      const origF = stage2Only.analysis?.subjectRanking?.originalEntities.find((e) => e.id === 'A_F');
      expect(origF?.parentEntityIds).toEqual(['A_WRK']);

      // 2) Standalone reoptimizeVTA mode (applyFinalOthersConsolidation: true): folds A_TOBU_OF + A_SUB into subject_others at the end
      const withFinalOthers = await refineGranularity(
        dummyConfig,
        rawAnalysis,
        4,
        undefined,
        mockMergeF,
        () => {},
        1,
        0.82,
        0.02,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { applyFinalOthersConsolidation: true }
      );
      expect(withFinalOthers.analysis?.entities.map((e) => e.id)).toEqual(
        expect.arrayContaining(['A_CREW', 'A_WRK', 'A_DRV', 'subject_others'])
      );
      expect(withFinalOthers.analysis?.entities).toHaveLength(4);
      const othersEntry = debugRecorder
        .getEntries()
        .find((e) => e.stage === 'subject.others_consolidation');
      expect(othersEntry?.data).toMatchObject({
        postMaxSubjects: 4,
        foldedEntityIds: ['A_TOBU_OF', 'A_SUB'],
      });
    });

    it('rejects inverted ancestor-organization -> person-descendant merge (e.g. ORG_JAL -> B_PIC) while keeping Poset intact (ADR-0074 / RM-VTA-01)', () => {
      const source = sourceFromText([
        'p1 日本航空が運航規程を定めた。',
        'p2 機長Bが着陸進入を継続した。',
        'p3 B機客室乗務員が非常脱出を指揮した。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'ORG_JAL\t日本航空\torganization\tmid\t-\tp1',
        'B_PIC\t機長B\tperson\thigh\tORG_JAL\tp2',
        'B_CA\tB機客室乗務員\tperson\thigh\tORG_JAL\tp3',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:00\t運航規程\t日本航空が運航規程を定めた\tORG_JAL:actor\tp1\trecorded',
        'E2\t17:47\t着陸衝突\t機長Bが着陸進入し衝突した\tB_PIC:affected\tp2\trecorded',
        'E3\t17:55\t非常脱出\tB機客室乗務員が非常脱出を指揮した\tB_CA:actor\tp3\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE2:loss,E3:recovery\tp2,p3\t衝突と非常脱出',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;
      const logs: string[] = [];

      const { schema, appliedOps } = applyRefinementOps(
        projectAnalysis(rawAnalysis),
        [
          {
            id: 'M_INV',
            op: 'merge',
            targetId: 'ORG_JAL',
            content: 'B_PIC',
            sourceRefs: ['p1', 'p2'],
            reason: '逆方向マージ試行',
          },
        ],
        3,
        new Set<string>(),
        (_type, msg) => logs.push(msg)
      );

      expect(appliedOps).toEqual([]);
      expect(logs.some((m) => m.includes('Poset逆方向統合不可'))).toBe(true);
      expect(schema.analysis?.entities.some((e) => e.id === 'ORG_JAL')).toBe(true);
      const rankJal = schema.analysis?.subjectRanking?.ranks.find((r) => r.entityId === 'ORG_JAL');
      expect(rankJal?.mergedInto).toBeUndefined();
    });

    it('enforces Stage 2 merge guards against resilient person -> loss org, :loss :affected person -> org, and strictAsymmetry while allowing symmetric person -> person merge (ADR-0077)', () => {
      const source = sourceFromText([
        'p1 日本航空と海上保安庁の機体が衝突し、機上整備員Aが死亡した。',
        'p2 L4ドア担当客室乗務員Bが安全確認の上で独断により非常脱出ドアを開放した。',
        'p3 先任客室乗務員Bと他の客室乗務員Bが客室状況を連絡した。',
        'p4 タワー東管制官と主任管制官の間で応援要員移動が行われた。',
        'p5 搭乗客全員の無事が確認された。',
      ].join('\n'));
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'ORG_JAL\t日本航空\torganization\thigh\t-\tp1',
        'B_PAX\tB機乗客\tperson\tmid\tORG_JAL\tp5',
        'B_CA_L4\tL4ドア担当客室乗務員B\tperson\thigh\tORG_JAL\tp2',
        'B_CA_LEAD\t先任客室乗務員B\tperson\tmid\tORG_JAL\tp3',
        'B_CA_OTH\t他の客室乗務員B\tperson\thigh\tORG_JAL\tp3',
        'ORG_JCG\t海上保安庁\torganization\thigh\t-\tp1',
        'A_MAINT\t機上整備員A\tperson\thigh\tORG_JCG\tp1',
        'TWR_E\tタワー東管制官\tperson\thigh\t-\tp4',
        'TWR_SUP\t主任管制官\tperson\tmid\t-\tp4',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E40\t17:47\t衝突・死傷\t両機が衝突し整備員Aが死亡した\tORG_JAL:affected,ORG_JCG:affected,A_MAINT:affected\tp1\trecorded',
        'E50\t17:52\tL4ドア開放判断\tL4担当CAが安全確認の上でドアを開放した\tB_CA_L4:actor\tp2\trecorded',
        'E51\t17:53\t客室連絡\t先任CAと他CAが客室状況を連絡した\tB_CA_LEAD:actor,B_CA_OTH:actor\tp3\trecorded',
        'E52\t17:54\t応援移動\t管制席間で人員移動が行われた\tTWR_SUP:actor,TWR_E:confirmed_recipient\tp4\trecorded',
        'E55\t20:45\t全員無事確認\t搭乗客全員の無事が確認された\tB_PAX:affected\tp5\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R_P\ttransfer\tE52\tTWR_SUP\tE52\tTWR_E\tp4\tperson\toccurred\tconfirmed',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE40:loss,E55:recovery\tp1,p5\t衝突損壊および全員無事確認',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E50\tvariation\tレジリエンス発揮：安全確認の上での非常脱出ドア開放\tp2',
        '[完了]',
      ].join('\n'));
      const rawAnalysis = inspectLedger(doc, source).analysis!;
      const logs: string[] = [];

      const { schema, appliedOps } = applyRefinementOps(
        projectAnalysis(rawAnalysis),
        [
          {
            id: 'M_RESILIENT_TO_ORG',
            op: 'merge',
            targetId: 'B_CA_L4',
            content: 'ORG_JAL',
            sourceRefs: ['p2'],
            reason: 'レジリエンスCAを親法人へ統合試行',
          },
          {
            id: 'M_LOSS_PERSON_TO_ORG',
            op: 'merge',
            targetId: 'A_MAINT',
            content: 'ORG_JCG',
            sourceRefs: ['p1'],
            reason: '死亡搭乗員を親法人へ統合試行',
          },
          {
            id: 'M_STRICT_ASYM',
            op: 'merge',
            targetId: 'TWR_E',
            content: 'TWR_SUP',
            sourceRefs: ['p4'],
            reason: '人員移動のある主体間統合試行',
          },
          {
            id: 'M_SYM_CA',
            op: 'merge',
            targetId: 'B_CA_LEAD',
            content: 'B_CA_OTH',
            sourceRefs: ['p3'],
            reason: '対称な客室乗務員同士の統合',
          },
        ],
        9,
        new Set<string>(),
        (_type, msg) => logs.push(msg)
      );

      expect(appliedOps).toEqual(['merge:B_CA_LEAD->B_CA_OTH']);
      const entityIds = schema.analysis?.entities.map((e) => e.id) ?? [];
      expect(entityIds).toContain('B_CA_L4');
      expect(entityIds).toContain('A_MAINT');
      expect(entityIds).toContain('TWR_E');
      expect(entityIds).toContain('B_CA_OTH');
      expect(entityIds).not.toContain('B_CA_LEAD');
      expect(logs.some((m) => m.includes('B_CA_L4 -> ORG_JAL') && m.includes('法人統合禁止'))).toBe(true);
      expect(logs.some((m) => m.includes('A_MAINT -> ORG_JCG') && m.includes('法人統合禁止'))).toBe(true);
      expect(logs.some((m) => m.includes('TWR_E -> TWR_SUP') && m.includes('厳格非対称ガード'))).toBe(true);
    });
  });
});
