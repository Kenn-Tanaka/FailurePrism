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

    // 主体を統合（上限 2 に制限 -> A12, B12, B1, A2 が subject_others に統合される）
    const consolidated = consolidateSubjects(initialAnalysis, 2);
    const others = consolidated.entities.find((e) => e.id === 'subject_others');
    expect(others).toBeDefined();

    // 統合後も親主体（その他の関係者）がドリルダウン可能であり、子主体が取得できること
    expect(canDrilldownEntity(others!.id, consolidated)).toBe(true);
    const subs = getDrilldownSubEntities(others!.id, consolidated);
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs.some((s) => s.id === 'A12')).toBe(true);
  });
});
