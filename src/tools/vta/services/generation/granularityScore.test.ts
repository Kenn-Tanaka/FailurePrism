import { describe, it, expect } from 'vitest';
import { computeMachineMetrics, totalScore } from './granularityScore';
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
});
