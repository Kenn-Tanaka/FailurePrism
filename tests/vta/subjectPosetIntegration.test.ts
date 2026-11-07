import { describe, it, expect } from 'vitest';
import { parseLedger, inspectLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
import { sourceFromText, projectAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { consolidateSubjects } from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { parseChainDelta, applyChainDelta } from '../../src/tools/vta/features/vta/utils/chainRepair';
import { SubjectPoset } from '../../src/tools/vta/features/vta/utils/subjectPoset';

describe('SubjectPoset Integration (包含DAGの確定と下流パイプライン一貫利用)', () => {
  const ledgerText = `[主体]
ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠
A1\t機長Ａ\tperson\thigh\tA12\tp1
A2\t副操縦員Ａ\tperson\tmid\tA12\t-
A12\tＡ機運航クルー\torganization\thigh\tA10\tp1
A10\t海上保安庁\torganization\thigh\t-\tp1
C1\tタワー東\tperson\thigh\tC8\tp1
C8\t羽田管制所\torganization\thigh\t-\tp1

[イベント]
ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分
E1\t17:45:00\t出発枠変更\t出発時刻が変更された\tA1:actor\tp1\trecorded
E2\t17:45:30\t管制承認要求\t滑走路進入の承認を求めた\tA1:actor\tp1\trecorded
E3\t17:46:00\t進入許可発出\t滑走路手前までの進入を許可した\tC1:actor\tp1\trecorded

[関係]
R1\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\tna

[共有カード]

[整理]

[帰結]
ID\t判定\tイベントID\t原文参照\t理由
OUT1\tnot_found\t-\t-\t被害なし

[完了]`;

  const sourceText = '17時45分に出発枠が変更され、機長Ａが管制承認を要求した。タワー東が進入を許可した。';

  it('台帳パース時に包含DAG (SubjectPoset) が確定・凍結され、推移律が成立する', () => {
    const source = sourceFromText(sourceText);
    const parsed = parseLedger(ledgerText);
    const inspected = inspectLedger(parsed, source);
    expect(inspected.issues).toHaveLength(0);
    const analysis = inspected.analysis!;

    expect(analysis.subjectPoset).toBeDefined();
    const poset = SubjectPoset.fromData(analysis.subjectPoset);

    // A1 -> A12 -> A10
    expect(poset.isAncestor('A12', 'A1')).toBe(true);
    expect(poset.isAncestor('A10', 'A1')).toBe(true); // 推移律
    expect(poset.isDescendant('A1', 'A10')).toBe(true);

    // C1 -> C8
    expect(poset.isAncestor('C8', 'C1')).toBe(true);
    expect(poset.isAncestor('C8', 'A1')).toBe(false);
  });

  it('主体統合後、LLMが元の細粒度主体を指定してもPosetとフォールバックによりリジェクトされず救済される', () => {
    const source = sourceFromText(sourceText);
    const schema = projectAnalysis(inspectLedger(parseLedger(ledgerText), source).analysis!);

    // A1, A2 を親組織 A12 に明示的に統合
    const explicitMerges = new Map<string, string>([
      ['A1', 'A12'],
      ['A2', 'A12'],
    ]);
    const consolidatedAnalysis = consolidateSubjects(schema.analysis!, 5, undefined, undefined, { explicitMerges });
    const workingSchema = {
      ...schema,
      analysis: consolidatedAnalysis,
    };

    // 統合後の participations では A1 が A12 に書き換わっていることを確認
    const partE1 = workingSchema.analysis.participations.find((p) => p.eventId === 'E1');
    expect(partE1?.entityId).toBe('A12');
    expect(partE1?.mergedFrom?.some((m) => m.entityId === 'A1')).toBe(true);

    // 連鎖点検 (Chain Repair) で、LLMが親切心から元の細粒度主体 A1 を書いて before 関係を提案
    // (以前のバグでは「関係の主体がイベントに関与していません」でリジェクトされていた)
    const repairDelta = `[追加主体]
[追加イベント]
[割当追加]
[関係追加]
tmp_R1\tbefore\tE1\tA1\tE2\tA1\tsource_1/p1\t-\t-\tna\trecorded\t出発枠変更から管制承認要求への時系列遷移
tmp_R2\tdependency\tE2\tA1\tE3\tC1\tsource_1/p1\t-\t-\tna\trecorded\t承認要求に対する進入許可
[要確認]
[完了]`;

    const deltaRows = parseChainDelta(repairDelta);
    const repairedSchema = applyChainDelta(workingSchema, deltaRows);

    // tmp_R1 (before) と tmp_R2 (dependency) の双方がリジェクトされずに正常採用されていることを検証
    const addedRel1 = repairedSchema.analysis?.relations.find((r) => r.id === 'tmp_R1');
    const addedRel2 = repairedSchema.analysis?.relations.find((r) => r.id === 'tmp_R2');

    expect(addedRel1).toBeDefined();
    expect(addedRel1?.kind).toBe('before');
    expect(addedRel1?.sourceEventId).toBe('E1');
    expect(addedRel1?.targetEventId).toBe('E2');

    expect(addedRel2).toBeDefined();
    expect(addedRel2?.kind).toBe('dependency');
    expect(addedRel2?.sourceEventId).toBe('E2');
    expect(addedRel2?.targetEventId).toBe('E3');
    // dependency の sourceEntityId は Poset / mergedFrom により現在の有効主体 A12 に解決されていること
    expect(addedRel2?.sourceEntityId).toBe('A12');
    expect(addedRel2?.targetEntityId).toBe('C1');
  });
});
