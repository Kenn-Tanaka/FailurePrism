import { describe, it, expect } from 'vitest';
import {
  collectPostOutcomeExcludedNodeIds,
  computeComplexityBudgets,
  computeMachineMetrics,
  filterPostOutcomeScope,
  totalScore,
} from './granularityScore';
import { projectAnalysis, sourceFromText } from '../../features/vta/utils/eventAnalysis';
import { inspectLedger, parseLedger } from '../../features/vta/utils/eventLedger';

describe('granularityScore', () => {
  it('computes C1, C3, C5 and respects provisional variation reachability to outcome', () => {
    const source = sourceFromText(
      '09:00 作業員Aがバルブを開いた。\n09:05 監視員Bが圧力上昇を検知した。\n09:10 配管から漏洩が発生し設備が損傷した。'
    );
    const ledger = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t作業員A\tperson\thigh\t-\tp1',
        'A2\t監視員B\tperson\tmid\t-\t-',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\tバルブ開操作\t作業員Aがバルブを開いた\tA1:actor\tp1\trecorded',
        'E2\t09:05\t圧力上昇検知\t監視員Bが圧力上昇を検知した\tA2:actor\tp2\trecorded',
        'E3\t09:10\t漏洩と設備損傷\t配管から漏洩が発生し設備が損傷した\tA1:affected,A2:affected\tp3\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\timpact\tE1\tA1\tE2\tA2\tp2\tother\toccurred\tna',
        'R2\timpact\tE2\tA2\tE3\tA2\tp3\tother\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE3\tp3\t設備損傷が発生',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E1\tvariation\t手順外の開操作\tp1',
        'E2\tnormal\t通常の監視検知\tp2',
        'E3\tvariation\t漏洩・損傷の発生\tp3',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(ledger, source);
    expect(res.issues).toEqual([]);
    const schema = projectAnalysis(res.analysis!);

    const metrics = computeMachineMetrics(schema, 5);
    expect(metrics.gateViolations).toEqual([]);
    expect(metrics.c1).toBeGreaterThan(0.8);
    expect(metrics.c3).toBeGreaterThan(0.8);
    expect(metrics.c5).toBeGreaterThan(0.8);
    expect(metrics.details.variationReachability).toBe(1);

    // Weighted total score with C2/C4 omitted vs provided
    const sMachineOnly = totalScore({ c1: metrics.c1, c3: metrics.c3, c5: metrics.c5 });
    const sFull = totalScore({ c1: metrics.c1, c2: 0.9, c3: metrics.c3, c4: 0.9, c5: metrics.c5 });
    expect(sMachineOnly).toBeGreaterThan(0.8);
    expect(sFull).toBeGreaterThan(0.8);
  });

  it('penalizes C5 when lane count exceeds maxSubjects or graph has disconnected components', () => {
    const source = sourceFromText(
      'p1: Aが作業1。\np2: Bが作業2。\np3: Cが作業3。\np4: Dが作業4。'
    );
    const ledger = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t主体A\tperson\tmid\t-\t-',
        'A2\t主体B\tperson\tmid\t-\t-',
        'A3\t主体C\tperson\tmid\t-\t-',
        'A4\t主体D\tperson\tmid\t-\t-',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t-\t作業1\tAが作業1\tA1:actor\tp1\trecorded',
        'E2\t-\t作業2\tBが作業2\tA2:actor\tp2\trecorded',
        'E3\t-\t作業3\tCが作業3\tA3:actor\tp3\trecorded',
        'E4\t-\t作業4\tDが作業4\tA4:actor\tp4\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tnot_found\t-\t-\t損失記述なし',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(ledger, source);
    const schema = projectAnalysis(res.analysis!);
    const metrics = computeMachineMetrics(schema, 2);
    // 4 lanes vs maxSubjects=2 -> C1 and C5 are penalized, and 4 disconnected components -> C3 is low
    expect(metrics.c1).toBeLessThan(0.6);
    expect(metrics.c3).toBeLessThan(0.6);
    expect(metrics.c5).toBeLessThan(1.0);
  });

  it('does not penalize C1 when cards naturally concentrate on a main actor lane in incident causality', () => {
    const source = sourceFromText(
      'p1: 指令Aが命令した。\np2: 機長Bが操作1した。\np3: 機長Bが操作2した。\np4: 機長Bが操作3した。\np5: 機長Bが操作4した。'
    );
    const ledger = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t指令A\tperson\tmid\t-\t-',
        'A2\t機長B\tperson\thigh\t-\t-',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t-\t命令\t指令Aが命令した\tA1:actor\tp1\trecorded',
        'E2\t-\t操作1\t機長Bが操作1した\tA2:actor\tp2\trecorded',
        'E3\t-\t操作2\t機長Bが操作2した\tA2:actor\tp3\trecorded',
        'E4\t-\t操作3\t機長Bが操作3した\tA2:actor\tp4\trecorded',
        'E5\t-\t操作4\t機長Bが操作4した\tA2:actor\tp5\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\ttransfer\tE1\tA1\tE2\tA2\tp2\tinformation\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tnot_found\t-\t-\t損失記述なし',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(ledger, source);
    const schema = projectAnalysis(res.analysis!);
    // 2 lanes, 5 cards total: A1 has 1 card, A2 has 4 cards (80% concentration).
    // In the new model, this is natural for incident progression and C1 remains 1.0.
    const metrics = computeMachineMetrics(schema, 4);
    expect(metrics.c1).toBe(1.0);
  });

  it('uses global EventTimeDAG ranks for crossingCount and avoids penalizing cross-lane chain lengthening or duplicate edges in C5', () => {
    // Lane A1 has 14 events (seq 0..13), Lane A2 has 2 events (seq 0..1) aligned at 10:12 and 10:13.
    // Cross-lane edges A1(10:12)->A2(10:12) and A1(10:13)->A2(10:13) are parallel in global time,
    // even though local sequence_order (12 vs 0, 13 vs 1) would invert against earlier cross-lane edges if compared locally.
    const paragraphs = Array.from({ length: 14 }, (_, i) => {
      const mm = String(i).padStart(2, '0');
      return `10:${mm} A1が作業${i}を実施した。`;
    });
    paragraphs.push('10:00 A2が初期確認を行った。');
    paragraphs.push('10:13 A2が最終受領を行った。');
    const source = sourceFromText(paragraphs.join('\n'));

    const eventLines: string[] = [];
    for (let i = 0; i < 14; i++) {
      const mm = String(i).padStart(2, '0');
      eventLines.push(`E${i + 1}\t10:${mm}\t作業${i}\tA1が作業${i}を実施した\tA1:actor\tp${i + 1}\trecorded`);
    }
    eventLines.push('E15\t10:00\t初期確認\tA2が初期確認を行った\tA2:actor\tp15\trecorded');
    eventLines.push('E16\t10:13\t最終受領\tA2が最終受領を行った\tA2:actor\tp16\trecorded');

    const ledger = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t主体A\torganization\thigh\t-\tp1',
        'A2\t主体B\torganization\thigh\t-\tp15',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        ...eventLines,
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\ttransfer\tE1\tA1\tE15\tA2\tp15\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE14\tA1\tE16\tA2\tp16\tinformation\toccurred\tconfirmed',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE16\tp16\t最終受領',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(ledger, source);
    expect(res.issues).toEqual([]);
    const schema = projectAnalysis(res.analysis!);
    const metrics = computeMachineMetrics(schema, 5);

    // Parallel cross-lane edges at 10:00 and 10:13 must NOT register as crossings despite local sequence_order difference (0 vs 13)
    expect(metrics.details.crossingCount).toBe(0);
    // Unique-neighbor maxDegree counts each neighbor once
    expect(metrics.details.maxDegree).toBeLessThanOrEqual(3);
  });

  it('increases C3 variationReachability when an explicit directed relation replaces reliance on shared-event association edges', () => {
    const source = sourceFromText(
      '10:00 主体Aが逸脱操作を行った。\n10:05 主体Aと主体Bが情報共有した。\n10:10 主体Bで重大事象が発生した。'
    );
    const baseLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t主体A\tperson\thigh\t-\tp1',
      'A2\t主体B\tperson\thigh\t-\tp3',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:00\t逸脱操作\t主体Aが逸脱操作を行った\tA1:actor\tp1\trecorded',
      'E2\t10:05\t情報共有\t主体Aと主体Bが情報共有した\tA1:actor,A2:actor\tp2\trecorded',
      'E3\t10:10\t重大事象\t主体Bで重大事象が発生した\tA2:affected\tp3\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
    ];
    const tailLedger = [
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'O1\tidentified\tE3\tp3\t重大事象',
      '[仮判定]',
      'イベントID\t判定\t理由\t原文参照',
      'E1\tvariation\t手順逸脱\tp1',
      '[完了]',
    ];

    const withoutCausal = projectAnalysis(inspectLedger(parseLedger([...baseLedger, ...tailLedger].join('\n')), source).analysis!);
    const withCausal = projectAnalysis(
      inspectLedger(
        parseLedger([...baseLedger, 'R1\timpact\tE1\tA1\tE3\tA2\tp3\tother\toccurred\tna', ...tailLedger].join('\n')),
        source
      ).analysis!
    );

    const mBefore = computeMachineMetrics(withoutCausal, 4);
    const mAfter = computeMachineMetrics(withCausal, 4);
    expect(mAfter.details.variationReachability).toBeGreaterThan(mBefore.details.variationReachability);
    expect(mAfter.c3).toBeGreaterThan(mBefore.c3);
  });

  it('excludes intra-lane sequential backbone edges and outcome convergence from maxDegree hubPenalty, while still penalizing non-outcome causal hubs', () => {
    const source = sourceFromText([
      '09:00 A1が作業1を行った。',
      '09:10 A3が作業3を行った。',
      '09:15 A4が作業4を行った。',
      '09:20 A5が作業5を行った。',
      '09:22 A2が作業2を行った。',
      '09:25 A2が中間2を行った。',
      '09:30 A2が中間3を行った。',
      '09:35 A2が帰結に達した。',
    ].join('\n'));
    const ledger = parseLedger([
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t主体1\tperson\thigh\t-\tp1',
      'A2\t主体2\tperson\thigh\t-\tp5,p8',
      'A3\t主体3\tperson\thigh\t-\tp2',
      'A4\t主体4\tperson\thigh\t-\tp3',
      'A5\t主体5\tperson\thigh\t-\tp4',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t作業1\tA1が作業1を行った\tA1:actor\tp1\trecorded',
      'E3\t09:10\t作業3\tA3が作業3を行った\tA3:actor\tp2\trecorded',
      'E4\t09:15\t作業4\tA4が作業4を行った\tA4:actor\tp3\trecorded',
      'E5\t09:20\t作業5\tA5が作業5を行った\tA5:actor\tp4\trecorded',
      'E2\t09:22\t作業2\tA2が作業2を行った\tA2:actor\tp5\trecorded',
      'E6\t09:25\t中間2\tA2が中間2を行った\tA2:actor\tp6\trecorded',
      'E7\t09:30\t中間3\tA2が中間3を行った\tA2:actor\tp7\trecorded',
      'E8\t09:35\t帰結\tA2が帰結に達した\tA2:affected\tp8\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      // 5 causal edges all converging into outcome E8 -> must NOT trigger hubPenalty on E8
      'R1\timpact\tE1\tA1\tE8\tA2\tp8\tother\toccurred\tna',
      'R2\timpact\tE3\tA3\tE8\tA2\tp8\tother\toccurred\tna',
      'R3\timpact\tE4\tA4\tE8\tA2\tp8\tother\toccurred\tna',
      'R4\timpact\tE5\tA5\tE8\tA2\tp8\tother\toccurred\tna',
      'R5\timpact\tE6\tA2\tE8\tA2\tp8\tother\toccurred\tna',
      // 4 causal edges into non-outcome E2 (which also has sequential neighbor E6) -> degree=4, NOT 5!
      'R6\timpact\tE1\tA1\tE2\tA2\tp5\tother\toccurred\tna',
      'R7\timpact\tE3\tA3\tE2\tA2\tp5\tother\toccurred\tna',
      'R8\timpact\tE4\tA4\tE2\tA2\tp5\tother\toccurred\tna',
      'R9\timpact\tE5\tA5\tE2\tA2\tp5\tother\toccurred\tna',
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'O1\tidentified\tE8\tp8\t帰結',
      '[完了]',
    ].join('\n'));

    const res = inspectLedger(ledger, source);
    expect(res.issues).toEqual([]);
    const schema = projectAnalysis(res.analysis!);
    const metrics = computeMachineMetrics(schema, 5);
    expect(metrics.details.maxDegree).toBe(4);
  });

  it('preserves pre-outcome unassigned events when filtering post-outcome scope', () => {
    const source = sourceFromText([
      '09:00 A1が点検を開始した。',
      '09:05 警報ランプが点灯した（主体未特定）。',
      '09:10 A2で重大損失が発生した。',
      '10:00 調査班が事後調査を実施した。',
    ].join('\n'));
    const ledger = parseLedger([
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t主体A\tperson\thigh\t-\tp1',
      'A2\t主体B\tperson\thigh\t-\tp3',
      'A3\t調査班\torganization\tlow\t-\tp4',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t点検開始\tA1が点検を開始した\tA1:actor\tp1\trecorded',
      'E2\t09:05\t警報点灯\t警報ランプが点灯した\t-\tp2\trecorded',
      'E3\t09:10\t重大損失\tA2で重大損失が発生した\tA2:affected\tp3\trecorded',
      'E4\t10:00\t事後調査\t調査班が事後調査を実施した\tA3:actor\tp4\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\timpact\tE1\tA1\tE3\tA2\tp3\tother\toccurred\tna',
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'O1\tidentified\tE3\tp3\t重大損失',
      '[完了]',
    ].join('\n'));

    const res = inspectLedger(ledger, source);
    expect(res.analysis?.unassignedEventIds).toContain('E2');
    const schema = projectAnalysis(res.analysis!);
    const filtered = filterPostOutcomeScope(schema);

    expect(filtered.nodes.some((n) => n.event_ids?.includes('E4'))).toBe(false);
    const e2 = filtered.analysis?.events.find((e) => e.id === 'E2');
    const e4 = filtered.analysis?.events.find((e) => e.id === 'E4');
    expect(e2?.ignored).toBeFalsy();
    expect(e4?.ignored).toBe(true);
    expect(e4?.ignoreReason).toBe('post_outcome');
    expect(filtered.analysis?.unassignedEventIds).toContain('E2');
    expect(filtered.analysis?.dispositions?.some((d) => d.id === 'disp_post_E2')).toBe(false);
    expect(filtered.analysis?.dispositions?.some((d) => d.id === 'disp_post_E4')).toBe(true);
  });

  it('keeps C5 healthy on large 68-event scenarios, preserves card-reduction and extreme lane-overload gradients, and fixes per-lane budget to maxSubjects (ADR-0067)', () => {
    const paragraphs = Array.from({ length: 68 }, (_, i) => {
      const mm = String(Math.floor(i / 2)).padStart(2, '0');
      const ss = i % 2 === 0 ? '00' : '30';
      return `17:${mm}:${ss} 事象${i + 1}が記録された。`;
    });
    const source = sourceFromText(paragraphs.join('\n'));
    const subjectLines = Array.from({ length: 6 }, (_, i) => `A${i + 1}\t部門${i + 1}\torganization\thigh\t-\tp1`);
    // First 28 events are shared across 2 lanes -> 68 + 28 = 96 cards across 6 lanes
    const eventLines = Array.from({ length: 68 }, (_, i) => {
      const mm = String(Math.floor(i / 2)).padStart(2, '0');
      const ss = i % 2 === 0 ? '00' : '30';
      const a = `A${(i % 6) + 1}`;
      const b = `A${((i + 1) % 6) + 1}`;
      const parts = i < 28 ? `${a}:actor,${b}:confirmed_recipient` : `${a}:actor`;
      return `E${i + 1}\t17:${mm}:${ss}\t事象${i + 1}\t事象${i + 1}が記録された\t${parts}\tp${i + 1}\trecorded`;
    });

    const buildLargeSchema = (suppressedCount: number) => {
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        ...subjectLines,
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        ...eventLines,
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE68\tp68\t最終事象',
        '[完了]',
      ].join('\n'));
      const base = projectAnalysis(inspectLedger(doc, source).analysis!);
      if (suppressedCount <= 0) return base;
      const sharedCardIds = (base.analysis?.cards ?? [])
        .filter((c) => Number(c.eventIds[0]?.slice(1)) <= suppressedCount && c.laneEntityId === `A${((Number(c.eventIds[0]?.slice(1)) % 6) + 1)}`)
        .map((c) => c.id);
      const suppressedCards = Object.fromEntries(sharedCardIds.map((id) => [id, '重複整理']));
      return {
        ...base,
        presentation: {
          lanes: { ...base.presentation?.lanes },
          suppressedCards,
        },
      };
    };

    const budgets = computeComplexityBudgets(68, 6);
    expect(budgets.targetMaxCards).toBe(79);
    expect(budgets.targetMaxLaneNodes).toBe(25);

    const schema96 = buildLargeSchema(0);
    const schema86 = buildLargeSchema(10);
    const m96 = computeMachineMetrics(schema96, 6);
    const m86 = computeMachineMetrics(schema86, 6);

    // Previously C5 collapsed to ~0.03; now it stays healthy (> 0.85) while still rewarding card cleanup (86 > 96)
    expect(m96.c5).toBeGreaterThan(0.85);
    expect(m86.c5).toBeGreaterThan(m96.c5);

    // Extreme lane overload (10 lanes -> 9 lanes vs maxSubjects=4): C1 is 0 in both, but C5 still strictly improves
    const overload10Source = sourceFromText(Array.from({ length: 10 }, (_, i) => `p${i + 1}: 担当${i + 1}が作業した。`).join('\n'));
    const buildOverload = (lanes: number) => {
      const subs = Array.from({ length: lanes }, (_, i) => `S${i + 1}\t担当${i + 1}\tperson\thigh\t-\tp1`);
      const evs = Array.from({ length: 10 }, (_, i) => `E${i + 1}\t-\t作業${i + 1}\t作業した\tS${Math.min(i + 1, lanes)}:actor\tp${i + 1}\trecorded`);
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        ...subs,
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        ...evs,
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
      return projectAnalysis(inspectLedger(doc, overload10Source).analysis!);
    };
    const mOver10 = computeMachineMetrics(buildOverload(10), 4);
    const mOver9 = computeMachineMetrics(buildOverload(9), 4);
    expect(mOver10.c1).toBe(0);
    expect(mOver9.c1).toBe(0);
    expect(mOver9.c5).toBeGreaterThan(mOver10.c5);
  });

  it('protects flashback pre-outcome events (sourceOrder > maxOutcomeOrder but earlier timestamp) in collectPostOutcomeExcludedNodeIds (ADR-0067)', () => {
    const source = sourceFromText([
      '17:45 A1が進入した。',
      '17:47 A1で衝突損失が発生した。',
      '17:35 A2が事前に設定変更していたことが判明した。',
      '18:15 A3が事後調査を実施した。',
    ].join('\n'));
    const ledger = parseLedger([
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t主体1\tperson\thigh\t-\tp1,p2',
      'A2\t主体2\tperson\tmid\t-\tp3',
      'A3\t調査班\torganization\tlow\t-\tp4',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t17:45\t進入\tA1が進入した\tA1:actor\tp1\trecorded',
      'E2\t17:47\t衝突損失\tA1で衝突損失が発生した\tA1:affected\tp2\trecorded',
      'E3\t17:35\t事前設定変更\tA2が事前に設定変更していた\tA2:actor\tp3\trecorded',
      'E4\t18:15\t事後調査\tA3が事後調査を実施した\tA3:actor\tp4\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'O1\tidentified\tE2\tp2\t衝突損失',
      '[完了]',
    ].join('\n'));

    const schema = projectAnalysis(inspectLedger(ledger, source).analysis!);
    const excludedIds = collectPostOutcomeExcludedNodeIds(schema);
    const e3Node = schema.nodes.find((n) => n.event_ids?.includes('E3'))!;
    const e4Node = schema.nodes.find((n) => n.event_ids?.includes('E4'))!;
    expect(excludedIds.has(e3Node.id)).toBe(false);
    expect(excludedIds.has(e4Node.id)).toBe(true);

    const filtered = filterPostOutcomeScope(schema);
    expect(filtered.nodes.some((n) => n.event_ids?.includes('E3'))).toBe(true);
    expect(filtered.nodes.some((n) => n.event_ids?.includes('E4'))).toBe(false);
  });

  it('applies gentle convex C1 decay on +1 lane overflow and penalizes substantive multi-actor subject_others collisions (ADR-0071)', () => {
    const source = sourceFromText(
      Array.from({ length: 8 }, (_, i) => `p${i + 1}: 組織${i + 1}が工程${i + 1}を実施した。`).join('\n')
    );
    const buildSchemaWithLanes = (laneCount: number) => {
      const subs = Array.from({ length: laneCount }, (_, i) => `S${i + 1}\t組織${i + 1}\torganization\thigh\t-\tp${i + 1}`);
      const evs = Array.from({ length: laneCount }, (_, i) => `E${i + 1}\t09:0${i}\t工程${i + 1}\t実施した\tS${i + 1}:actor\tp${i + 1}\trecorded`);
      const doc = parseLedger([
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        ...subs,
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        ...evs,
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        `O1\tidentified\tE${laneCount}\tp${laneCount}\t最終事象`,
        '[完了]',
      ].join('\n'));
      return projectAnalysis(inspectLedger(doc, source).analysis!);
    };

    const m6Named = computeMachineMetrics(buildSchemaWithLanes(6), 6);
    const m7Named = computeMachineMetrics(buildSchemaWithLanes(7), 6);
    const m8Named = computeMachineMetrics(buildSchemaWithLanes(8), 6);

    // Build a 6-lane schema where subject_others merges 2 substantive (focus: high) organizations
    const base7 = buildSchemaWithLanes(7);
    const sixWithOthersSchema = projectAnalysis({
      ...base7.analysis!,
      entities: [
        ...base7.analysis!.entities.slice(0, 5),
        { id: 'subject_others', name: 'その他の関係者', kind: 'other', aggregate: true, mergedFrom: ['S6', 'S7'] },
      ],
      participations: base7.analysis!.participations.map((p) =>
        p.entityId === 'S6' || p.entityId === 'S7' ? { ...p, entityId: 'subject_others' } : p
      ),
      cards: base7.analysis!.cards.map((c) =>
        c.laneEntityId === 'S6' || c.laneEntityId === 'S7' ? { ...c, laneEntityId: 'subject_others' } : c
      ),
      subjectRanking: {
        version: 1,
        maxSubjects: 6,
        weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
        originalEntities: base7.analysis!.entities,
        ranks: [],
      },
    });
    const m6WithMultiOthers = computeMachineMetrics(sixWithOthersSchema, 6);

    expect(m6Named.c1).toBe(1.0);
    expect(m7Named.c1).toBeGreaterThan(0.9);
    // 7 named lanes (+1 gentle overflow) scores higher on C1 than lumping 2 high-focus organizations into subject_others
    expect(m7Named.c1).toBeGreaterThan(m6WithMultiOthers.c1);
    // Convex decay makes +2 lanes (8 lanes) steeper than subject_others
    expect(m6WithMultiOthers.c1).toBeGreaterThan(m8Named.c1);
  });

  it('separates Stage 2 preLimit C1 scoring from K_post cardBudgetMaxSubjects in computeMachineMetrics (ADR-0074 / RM-VTA-02)', () => {
    const source = sourceFromText(
      Array.from({ length: 8 }, (_, i) => `p${i + 1}: 担当${i + 1}が工程${i + 1}を実施した。`).join('\n')
    );
    const subs = Array.from({ length: 8 }, (_, i) => `S${i + 1}\t担当${i + 1}\tperson\thigh\t-\tp${i + 1}`);
    const evs = Array.from(
      { length: 8 },
      (_, i) => `E${i + 1}\t09:0${i}\t工程${i + 1}\t実施した\tS${i + 1}:actor\tp${i + 1}\trecorded`
    );
    const doc = parseLedger([
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      ...subs,
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      ...evs,
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'O1\tidentified\tE8\tp8\t最終事象',
      '[完了]',
    ].join('\n'));
    const schema = projectAnalysis(inspectLedger(doc, source).analysis!);

    // Evaluated against K_post = 6 directly -> C1 penalized; evaluated against K_pre = 9 with cardBudgetMaxSubjects = 6 -> C1 = 1.0
    const postMetrics = computeMachineMetrics(schema, 6);
    const stage2Metrics = computeMachineMetrics(schema, 9, { cardBudgetMaxSubjects: 6 });
    expect(postMetrics.c1).toBeLessThan(0.8);
    expect(stage2Metrics.c1).toBe(1.0);
  });

  it('uses domain-agnostic LLM preliminary tokens (outcome:*, variation:resilient, post_outcome) instead of accident keyword regexes across IT/business and safety domains (ADR-0078)', () => {
    // 1. IT / Payment Service Outage domain (no physical-accident vocabulary at all)
    const itSource = sourceFromText([
      '14:00 決済バッチがリトライ上限超過を起こした。',
      '14:02 本番APIが503エラーで一時停止した。',
      '14:05 フェイルオーバーによりAPI応答が復旧した。',
      '14:05ごろ 手動キュー退避により二次障害波及を抑止した。',
      '14:20 未コミット決済ジョブ320件の欠損が判明した。',
      '14:25 API停止に伴い外部提携システムへの通知遅延が発生した。',
      '翌週 SRE委員会がポストモーテム振り返り会議を開催した。',
      '14:30 未割当の補助ログ欠損が記録された。',
    ].join('\n'));
    const itLedger = parseLedger([
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'S_BATCH\t決済基盤チーム\torganization\thigh\t-\tp1,p2',
      'S_SRE\tSRE担当\tperson\thigh\t-\tp3,p4',
      'S_BIZ\t決済業務部門\torganization\tmid\t-\tp5',
      'S_EXT\t外部提携基盤\torganization\tmid\t-\tp6',
      'S_AUDIT\t振り返り委員会\torganization\tlow\t-\tp7',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t14:00\tリトライ上限超過\t決済バッチが上限超過した\tS_BATCH:actor\tp1\trecorded',
      'E2\t14:02\t本番API停止\t本番APIが503エラーで停止した\tS_BATCH:affected\tp2\trecorded',
      'E3\t14:05\tAPI応答復旧\tフェイルオーバーでAPI応答が復旧した\tS_SRE:actor\tp3\trecorded',
      'E4\t14:05ごろ\t手動キュー退避\t手動キュー退避で波及を抑止した\tS_SRE:actor\tp4\trecorded',
      'E5\t14:20\t未コミット決済320件欠損\t未コミット決済ジョブ320件の欠損が判明した\tS_BIZ:affected\tp5\trecorded',
      'E6\t14:25\t外部通知遅延\tAPI停止に伴い外部通知遅延が発生した\tS_EXT:affected\tp6\trecorded',
      'E7\t-\t振り返り会議開催\t翌週に振り返り会議を開催した\tS_AUDIT:actor\tp7\trecorded',
      'E8\t14:30\t補助ログ欠損\t未割当の補助ログ欠損が記録された\t-\tp8\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\timpact\tE1\tS_BATCH\tE2\tS_BATCH\tp1,p2\tother\toccurred\tna',
      // Direct downstream consequence from outcome E2 -> E6
      'R2\timpact\tE2\tS_BATCH\tE6\tS_EXT\tp2,p6\tother\toccurred\tna',
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'O1\tidentified\tE2:loss,E3:recovery\tp2,p3\tAPI停止とフェイルオーバー復旧',
      '[仮判定]',
      'イベントID\t判定\t理由\t原文参照',
      'E1\tvariation\tリトライ設定不備\tp1',
      'E4\tvariation:resilient\t手動キュー退避による波及抑止\tp4',
      // E5 was omitted from [帰結], but Step 1b LLM marks it outcome:loss -> auto-promoted to outcome!
      'E5\toutcome:loss\t決済ジョブ欠損という重大な業務損失帰結\tp5',
      'E6\tvariation\t外部システムへの影響波及\tp6',
      // E7 is explicitly marked post_outcome by LLM -> deterministically excluded!
      'E7\tpost_outcome\t障害終息後の振り返り会議\tp7',
      // E8 is unassigned outcome:loss -> kept in-scope WITHOUT violating Gate G4!
      'E8\toutcome:loss\t補助ログ欠損\tp8',
      '[完了]',
    ].join('\n'));

    const inspected = inspectLedger(itLedger, itSource);
    expect(inspected.issues).toEqual([]);
    // E5 (assigned) is promoted into analysis.outcome; E8 (unassigned) stays out of outcome.eventIds so Gate G4 passes
    expect(inspected.analysis?.outcome?.eventIds).toEqual(['E2', 'E3', 'E5']);
    expect(inspected.analysis?.outcome?.kind).toBe('loss');

    const schema = projectAnalysis(inspected.analysis!);
    const metricsBefore = computeMachineMetrics(schema, 5);
    expect(metricsBefore.gateViolations).toEqual([]);

    const excludedNodeIds = collectPostOutcomeExcludedNodeIds(schema);
    const e4Node = schema.nodes.find((n) => n.event_ids?.includes('E4'))!;
    const e5Node = schema.nodes.find((n) => n.event_ids?.includes('E5'))!;
    const e6Node = schema.nodes.find((n) => n.event_ids?.includes('E6'))!;
    const e7Node = schema.nodes.find((n) => n.event_ids?.includes('E7'))!;

    expect(excludedNodeIds.has(e4Node.id)).toBe(false);
    expect(excludedNodeIds.has(e5Node.id)).toBe(false);
    expect(excludedNodeIds.has(e6Node.id)).toBe(false);
    expect(excludedNodeIds.has(e7Node.id)).toBe(true);

    const filtered = filterPostOutcomeScope(schema);
    expect(filtered.nodes.some((n) => n.event_ids?.includes('E5'))).toBe(true);
    expect(filtered.nodes.some((n) => n.event_ids?.includes('E7'))).toBe(false);
    expect(filtered.analysis?.unassignedEventIds).toContain('E8');
    const ignoredE7 = filtered.analysis?.events.find((e) => e.id === 'E7');
    expect(ignoredE7?.ignored).toBe(true);
    expect(ignoredE7?.ignoreRule).toContain('llm_preliminary:post_outcome');
  });
});
