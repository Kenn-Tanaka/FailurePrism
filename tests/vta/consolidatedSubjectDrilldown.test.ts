import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { extractParagraphs } from '../../src/tools/vta/services/diagnostics/aiDiagnostics';
import { parseLedger, inspectLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
import { sourceFromText, projectAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { consolidateSubjects } from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { canDrilldownEntity, getDrilldownSubEntities } from '../../src/tools/vta/features/vta/utils/presentation';
import type { VTASchema } from '../../src/tools/vta/types/vta';

describe('羽田事故におけるドリルダウン機能の検証', () => {
  it('consolidateSubjects 実行後に親主体の canDrilldownEntity が true になるか', () => {
    const ledger = `[主体]
ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠
A1\t機長Ａ\tperson\thigh\tA12\tp1
A2\t副操縦員Ａ\tperson\tmid\tA12\t-
A12\t海上保安庁機\torganization\thigh\t-\tp1
B1\t機長Ｂ\tperson\thigh\tB12\tp1
B12\t日本航空機\torganization\thigh\t-\tp1

[イベント]
ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分
E1\t17:25:00\t出発枠変更\t出発時刻が変更された\tA1:actor\tp1\trecorded
E2\t17:47:00\t衝突\t衝突した\tA12:actor,B12:actor\tp1\trecorded

[関係]

[共有カード]

[整理]

[帰結]
ID\t判定\tイベントID\t原文参照\t理由
OUT1\tnot_found\t-\t-\t被害なし

[完了]`;

    const source = sourceFromText('羽田空港');
    const inspected = inspectLedger(parseLedger(ledger), source);
    expect(inspected.issues).toHaveLength(0);

    const initialAnalysis = inspected.analysis!;
    console.log('--- BEFORE CONSOLIDATION ---');
    for (const ent of initialAnalysis.entities) {
      console.log(ent.id, ent.name, 'canDrilldown:', canDrilldownEntity(ent.id, initialAnalysis));
    }

    // 1. 2機（A12・B12）への統合（上限2）：子主体 A1 は親組織 A12（海上保安庁機）へ統合され、subject_others を作らず親組織をドリルダウン可能
    const consolidated = consolidateSubjects(initialAnalysis, 2);
    expect(consolidated.entities.map((e) => e.id)).toEqual(['A12', 'B12']);
    expect(canDrilldownEntity('A12', consolidated)).toBe(true);
    const a12Subs = getDrilldownSubEntities('A12', consolidated);
    expect(a12Subs.some((s) => s.id === 'A1')).toBe(true);

    // 2. 独立主体が3件以上あり subject_others が生成される場合も、その他の関係者がドリルダウン可能であり子主体を取得できること
    const multiOrgLedger = ledger.replace(
      'B12\t日本航空機\torganization\thigh\t-\tp1',
      'B12\t日本航空機\torganization\thigh\t-\tp1\nC12\t東京飛行場管制所\torganization\tmid\t-\tp1\nD12\t空港消防\torganization\tlow\t-\tp1'
    ).replace(
      'E2\t17:47:00\t衝突\t衝突した\tA12:actor,B12:actor\tp1\trecorded',
      'E2\t17:47:00\t衝突\t衝突した\tA12:actor,B12:actor,C12:actor,D12:actor\tp1\trecorded'
    );
    const multiAnalysis = inspectLedger(parseLedger(multiOrgLedger), source).analysis!;
    const consolidatedWithOthers = consolidateSubjects(multiAnalysis, 3);
    const others = consolidatedWithOthers.entities.find((e) => e.id === 'subject_others');
    expect(others).toBeDefined();
    expect(canDrilldownEntity(others!.id, consolidatedWithOthers)).toBe(true);
    const subs = getDrilldownSubEntities(others!.id, consolidatedWithOthers);
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs.some((s) => s.id === 'C12')).toBe(true);
  });
});
