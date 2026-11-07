import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractParagraphs, buildAIDiagnostics, formatAIDiagnosticsAsMarkdown } from '../../src/tools/vta/services/diagnostics/aiDiagnostics';
import { SubjectPoset } from '../../src/tools/vta/features/vta/utils/subjectPoset';
import { parseLedger, inspectLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
import { sourceFromText, projectAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { consolidateSubjects } from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { applyChainDelta, parseChainDelta } from '../../src/tools/vta/features/vta/utils/chainRepair';
import { calculateVTALayout } from '../../src/tools/vta/features/vta/utils/layout';
import {
  canDrilldownEntity,
  getDrilldownSubEntities,
  visibleSchema,
} from '../../src/tools/vta/features/vta/utils/presentation';
import type { VTASchema, VTAAnalysisData } from '../../src/tools/vta/types/vta';

describe('羽田事故（要約版）におけるVTAエディタ全機能の実証検証', () => {
  const filePath = 'C:/Users/kenta/Dropbox/2026年/ソフトウェア開発/参照資料/羽田事故_20261025_141902.md';
  const fileExists = fs.existsSync(filePath);

  it('要約版ファイルが存在し、シナリオテキストが正常に読み込める', () => {
    expect(fileExists).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content.length).toBeGreaterThan(10000);
    expect(content).toContain('東京国際空港Ｃ滑走路');
    expect(content).toContain('海上保安庁ＤＨＣ－８－３１５型ＪＡ７２２Ａ');
    expect(content).toContain('日本航空Ａ３５０－９４１型ＪＡ１３ＸＪ');
  });

  it('段落インデックス抽出 (extractParagraphs) が機能し、報告書節番号と時系列を正規化できる', () => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const paragraphs = extractParagraphs(content);
    expect(paragraphs.size).toBeGreaterThan(10);

    // 抽出された段落スニペットの確認
    const firstP = paragraphs.get('P1') ?? paragraphs.get('p1');
    expect(firstP).toBeDefined();
  });

  it('羽田事故の多重所属主体からSubjectPoset DAGを構築し、推移律と多重親が成立する', () => {
    const poset = new SubjectPoset();

    // ノード登録
    poset.addNode('A1'); // 機長A
    poset.addNode('A2'); // 副操縦員A
    poset.addNode('A12'); // 海保機クルー (機能・チーム軸)
    poset.addNode('A10'); // 海上保安庁 (組織軸)

    poset.addNode('B1'); // 機長B
    poset.addNode('B2'); // 訓練乗員
    poset.addNode('B12'); // 日航機クルー
    poset.addNode('B10'); // 日本航空

    poset.addNode('C1'); // タワー東
    poset.addNode('C2'); // グラウンド東
    poset.addNode('C8'); // 羽田管制所
    poset.addNode('C10'); // 国土交通省航空局

    // エッジ登録 (多重包含)
    poset.addEdge('A1', 'A12'); // 機長A -> 海保機クルー
    poset.addEdge('A2', 'A12'); // 副操縦員A -> 海保機クルー
    poset.addEdge('A12', 'A10'); // 海保機クルー -> 海上保安庁
    poset.addEdge('A1', 'A10'); // 機長A -> 海上保安庁 (直接組織所属の多重親)

    poset.addEdge('B1', 'B12');
    poset.addEdge('B2', 'B12');
    poset.addEdge('B12', 'B10');

    poset.addEdge('C1', 'C8');
    poset.addEdge('C2', 'C8');
    poset.addEdge('C8', 'C10');

    // サイクル検証
    const check = poset.validate();
    expect(check.valid).toBe(true);

    // 推移律 (Transitivity)
    expect(poset.isAncestor('A10', 'A1')).toBe(true); // 海上保安庁は機長Aの祖先
    expect(poset.isAncestor('A12', 'A1')).toBe(true); // 海保機クルーは機長Aの親
    expect(poset.isDescendant('A1', 'A10')).toBe(true);

    expect(poset.isAncestor('C10', 'C1')).toBe(true); // 航空局はタワー東の祖先
    expect(poset.isAncestor('B10', 'B2')).toBe(true); // 日本航空は訓練乗員の祖先

    // 異組織間の包含がないこと (直交性)
    expect(poset.isAncestor('B10', 'A1')).toBe(false);
    expect(poset.isAncestor('C8', 'A1')).toBe(false);

    // 最小共通祖先 (LCA)
    expect(poset.findLCA('A1', 'A2')).toBe('A12'); // 機長Aと副操縦員Aの共通上位は海保機クルー
  });

  it('羽田事故台帳をパースし、上流でSubjectPosetが自動確定・凍結される', () => {
    const ledger = `[主体]
ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠
A1\t機長Ａ\tperson\thigh\tA12,A10\tp1
A2\t副操縦員Ａ\tperson\tmid\tA12\t-
A12\t海上保安庁機\torganization\thigh\tA10\tp1
A10\t海上保安庁\torganization\thigh\t-\tp1
B1\t機長Ｂ\tperson\thigh\tB12\tp1
B2\t訓練乗員\tperson\tmid\tB12\tp1
B12\t日本航空機\torganization\thigh\tB10\tp1
B10\t日本航空\torganization\thigh\t-\tp1
C1\tタワー東\tperson\thigh\tC8\tp1
C8\t羽田管制所\torganization\thigh\t-\tp1

[イベント]
ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分
E1\t17:25:00\t出発枠変更\t出発時刻が17:25に変更された\tA1:actor\tp1\trecorded
E2\t17:25:39\t管制承認要求\tスポットN957で管制承認を要求\tA1:actor\tp1\trecorded
E3\t17:44:56\tＢ機着陸許可\t滑走路34Rへの着陸許可発出\tC1:actor\tp1\trecorded
E4\t17:45:14\t海保機走行指示\tC5停止位置までの走行を指示\tC1:actor\tp1\trecorded
E5\t17:45:18\t進入許可と誤認\t滑走路進入許可と誤認して復唱\tA1:actor\tp1\trecorded
E6\t17:46:13\t滑走路進入\tC5停止線を越えて滑走路に進入\tA12:actor\tp1\trecorded
E7\t17:47:26\tＢ機接地・逆噴射\t滑走路34Rに接地し逆噴射操作\tB12:actor\tp1\trecorded
E8\t17:47:27\t両機衝突・炎上\t34R中心線上で両機が衝突・炎上\tA12:actor,B12:actor\tp1\trecorded
E9\t17:48:00\tＢ機全員脱出開始\t乗員乗客379名の非常脱出開始\tB1:actor\tp1\trecorded

[関係]
R1\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\tna
R2\tbefore\tE4\t-\tE5\t-\tp1\t-\t-\tna
R3\tbefore\tE5\t-\tE6\t-\tp1\t-\t-\tna
R4\tbefore\tE3\t-\tE7\t-\tp1\t-\t-\tna
R5\tbefore\tE7\t-\tE8\t-\tp1\t-\t-\tna
R6\tbefore\tE6\t-\tE8\t-\tp1\t-\t-\tna
R7\tbefore\tE8\t-\tE9\t-\tp1\t-\t-\tna

[共有カード]

[整理]

[帰結]
ID\t判定\tイベントID\t原文参照\t理由
OUT1\tidentified\tE8\tp1\t両機衝突・大破・搭乗者死傷

[完了]`;

    const source = sourceFromText('羽田空港C滑走路において航空機衝突事故が発生した。');
    const parsed = parseLedger(ledger);
    const inspected = inspectLedger(parsed, source);

    if (inspected.issues.length > 0) {
      console.log('Inspected issues:', inspected.issues);
    }
    expect(inspected.issues).toHaveLength(0);
    const analysis = inspected.analysis!;

    // SubjectPoset が自動生成・凍結されていること
    expect(analysis.subjectPoset).toBeDefined();
    const poset = SubjectPoset.fromData(analysis.subjectPoset);

    // 多重親 A1 -> A12, A10 の推移包含が成立
    expect(poset.isAncestor('A10', 'A1')).toBe(true);
    expect(poset.isAncestor('A12', 'A1')).toBe(true);
    expect(poset.isAncestor('B12', 'B1')).toBe(true);
    expect(poset.isAncestor('C8', 'C1')).toBe(true);
  });

  it('下流パイプラインで主体統合が行われても、時系列関係 (tmp_R1〜R5) がPoset解決により救済される', () => {
    const ledger = `[主体]
ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠
A1\t機長Ａ\tperson\thigh\tA12\tp1
A2\t副操縦員Ａ\tperson\tmid\tA12\t-
A12\t海上保安庁機\torganization\thigh\tA10\tp1
A10\t海上保安庁\torganization\thigh\t-\tp1
C1\tタワー東\tperson\thigh\tC8\tp1
C8\t羽田管制所\torganization\thigh\t-\tp1

[イベント]
ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分
E1\t17:25:00\t出発枠変更\t出発時刻が変更された\tA1:actor\tp1\trecorded
E2\t17:25:39\t管制承認要求\t管制承認を要求した\tA1:actor\tp1\trecorded
E3\t17:45:00\t走行指示\t滑走路手前までの走行を指示\tC1:actor\tp1\trecorded

[関係]

[共有カード]

[整理]

[帰結]
ID\t判定\tイベントID\t原文参照\t理由
OUT1\tnot_found\t-\t-\t被害なし

[完了]`;

    const source = sourceFromText('羽田空港C滑走路において航空機衝突事故が発生した。');
    const parsed = parseLedger(ledger);
    const inspected = inspectLedger(parsed, source);
    if (inspected.issues.length > 0) {
      console.log('Issues in test 4:', inspected.issues);
    }
    expect(inspected.issues).toHaveLength(0);

    const initialSchema = projectAnalysis(inspected.analysis!);

    // 上流で機長A (A1) を海保機 (A12) に統合
    const explicitMerges = new Map<string, string>([
      ['A1', 'A12'],
      ['A2', 'A12'],
    ]);
    const consolidatedAnalysis = consolidateSubjects(initialSchema.analysis!, 5, undefined, undefined, { explicitMerges });
    const workingSchema: VTASchema = {
      ...initialSchema,
      analysis: consolidatedAnalysis,
    };

    // 診断ログでリジェクトされていた tmp_R1 形式の差分:
    // LLM は細粒度主体 A1 を指定して時系列エッジ (before) を提案
    const repairDelta = `[追加主体]
[追加イベント]
[割当追加]
[関係追加]
tmp_R1\tbefore\tE1\tA1\tE2\tA1\tsource_1/p1\t-\t-\tna\trecorded\t出発枠変更から管制承認要求への時系列遷移
tmp_R2\tdependency\tE2\tA1\tE3\tC1\tsource_1/p1\t-\t-\tna\trecorded\t承認要求に対する管制応答
[要確認]
[完了]`;

    const deltaRows = parseChainDelta(repairDelta);
    expect(deltaRows).toHaveLength(2);

    // applyChainDelta で Poset 解決とフォールバック救済が働き、正常にエッジが追加されること
    const updated = applyChainDelta(workingSchema, deltaRows, false);

    const addedRel1 = updated.analysis?.relations.find((r) => r.id === 'tmp_R1');
    const addedRel2 = updated.analysis?.relations.find((r) => r.id === 'tmp_R2');

    expect(addedRel1).toBeDefined();
    expect(addedRel1?.kind).toBe('before');
    expect(addedRel1?.sourceEventId).toBe('E1');
    expect(addedRel1?.targetEventId).toBe('E2');

    expect(addedRel2).toBeDefined();
    expect(addedRel2?.kind).toBe('dependency');
    expect(addedRel2?.sourceEntityId).toBe('A12'); // Poset/mergedFrom により有効主体 A12 に解決
  });

  it('OLAP的ドリルダウン (ADR-0011) により、海保機レーンを展開・集約できる', () => {
    const analysis: VTAAnalysisData = {
      generation: { schemeId: 'event-chain' },
      entities: [
        { id: 'A1', name: '機長Ａ', parentEntityIds: ['A12'], mergedFrom: [] },
        { id: 'A2', name: '副操縦員Ａ', parentEntityIds: ['A12'], mergedFrom: [] },
        { id: 'A12', name: '海上保安庁機', parentEntityIds: [], mergedFrom: ['A1', 'A2'] },
        { id: 'C8', name: '羽田管制所', parentEntityIds: [], mergedFrom: [] },
        { id: 'B12', name: '日本航空機', parentEntityIds: [], mergedFrom: [] },
      ],
      subjectPoset: {
        nodes: ['A1', 'A2', 'A12', 'C8', 'B12'],
        relations: [
          { childId: 'A1', parentId: 'A12' },
          { childId: 'A2', parentId: 'A12' },
        ],
        aliases: {},
      },
      events: [
        { id: 'E1', title: '出発枠変更確認', description: '', time: '17:25', sourceOrder: 0, classification: 'normal', origin: 'manual', factIds: [] },
        { id: 'E2', title: 'FMS設定変更', description: '', time: '17:29', sourceOrder: 1, classification: 'normal', origin: 'manual', factIds: [] },
        { id: 'E3', title: '滑走路進入', description: '', time: '17:46', sourceOrder: 2, classification: 'normal', origin: 'manual', factIds: [] },
        { id: 'E4', title: '着陸許可', description: '', time: '17:44', sourceOrder: 3, classification: 'normal', origin: 'manual', factIds: [] },
        { id: 'E5', title: '接地', description: '', time: '17:47', sourceOrder: 4, classification: 'normal', origin: 'manual', factIds: [] },
      ],
      participations: [
        { eventId: 'E1', entityId: 'A1', role: 'actor', origin: 'manual', factIds: [] }, // 機長A
        { eventId: 'E2', entityId: 'A2', role: 'actor', origin: 'manual', factIds: [] }, // 副操縦員A
        { eventId: 'E3', entityId: 'A12', role: 'actor', origin: 'manual', factIds: [] }, // 海保機全体
        { eventId: 'E4', entityId: 'C8', role: 'actor', origin: 'manual', factIds: [] }, // 管制所
        { eventId: 'E5', entityId: 'B12', role: 'actor', origin: 'manual', factIds: [] }, // 日航機
      ],
      cards: [
        { id: 'card_1', laneEntityId: 'A12', eventIds: ['E1'] },
        { id: 'card_2', laneEntityId: 'A12', eventIds: ['E2'] },
        { id: 'card_3', laneEntityId: 'A12', eventIds: ['E3'] },
        { id: 'card_4', laneEntityId: 'C8', eventIds: ['E4'] },
        { id: 'card_5', laneEntityId: 'B12', eventIds: ['E5'] },
      ],
      relations: [],
    } as unknown as VTAAnalysisData;

    const baseSchema: VTASchema = {
      lanes: ['海上保安庁機', '羽田管制所', '日本航空機'],
      nodes: [
        { id: 'card_1', title: '出発枠変更確認', lane: '海上保安庁機', time: '17:25', type: 'normal', description: '', measure_type: null },
        { id: 'card_2', title: 'FMS設定変更', lane: '海上保安庁機', time: '17:29', type: 'normal', description: '', measure_type: null },
        { id: 'card_3', title: '滑走路進入', lane: '海上保安庁機', time: '17:46', type: 'normal', description: '', measure_type: null },
        { id: 'card_4', title: '着陸許可', lane: '羽田管制所', time: '17:44', type: 'normal', description: '', measure_type: null },
        { id: 'card_5', title: '接地', lane: '日本航空機', time: '17:47', type: 'normal', description: '', measure_type: null },
      ],
      edges: [],
      analysis,
      presentation: {
        lanes: {},
        suppressedCards: {},
      },
    };

    // 1. ロールアップ時（マクロ概要ビュー）
    const macroView = visibleSchema(baseSchema);
    expect(macroView.lanes).toEqual(['海上保安庁機', '羽田管制所', '日本航空機']);
    expect(macroView.nodes.filter((n) => n.lane === '海上保安庁機')).toHaveLength(3);

    // レイアウト計算
    const macroLayout = calculateVTALayout(macroView);
    expect(macroLayout.laneBounds).toHaveLength(3);
    expect(macroLayout.nodes).toHaveLength(5);

    // 2. ドリルダウン展開時（ミクロ詳細ビュー）
    const microSchema: VTASchema = {
      ...baseSchema,
      presentation: {
        ...baseSchema.presentation!,
        drilldownLanes: {
          A12: true, // 海保機を詳細展開
        },
      },
    };

    const microView = visibleSchema(microSchema);
    expect(microView.lanes).toContain('海上保安庁機');
    expect(microView.lanes).toContain('海上保安庁機（機長Ａ）');
    expect(microView.lanes).toContain('海上保安庁機（副操縦員Ａ）');
    expect(microView.lanes).toContain('羽田管制所');
    expect(microView.lanes).toContain('日本航空機');

    // カードの再配分
    expect(microView.nodes.find((n) => n.id === 'card_1')?.lane).toBe('海上保安庁機（機長Ａ）');
    expect(microView.nodes.find((n) => n.id === 'card_2')?.lane).toBe('海上保安庁機（副操縦員Ａ）');
    expect(microView.nodes.find((n) => n.id === 'card_3')?.lane).toBe('海上保安庁機'); // 機体・組織レベル

    // レイアウト計算が破綻なく実行されること
    const microLayout = calculateVTALayout(microView);
    expect(microLayout.laneBounds.length).toBe(5);
    expect(microLayout.width).toBeGreaterThan(macroLayout.width); // サブレーン展開により幅が拡張
  });

  it('羽田事故シナリオから高密度AI診断パッケージ (ADR-0009/0010) を生成し、Poset階層と原文根拠を出力できる', () => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const entries = [
      {
        time: '2026-11-06T02:00:00.000Z',
        sessionId: 'haneda_s1',
        stage: 'graph.projection',
        data: {
          cards: [
            { id: 'card_1', laneEntityId: 'A12', eventIds: ['E1'] },
            { id: 'card_7', laneEntityId: 'B12', eventIds: ['E7'] },
          ],
          nodes: [{ id: 'E1' }, { id: 'E7' }],
          entities: [
            { id: 'A1', name: '機長Ａ', parentEntityIds: ['A12', 'A10'], mergedFrom: [] },
            { id: 'A12', name: '海上保安庁機', parentEntityIds: ['A10'], mergedFrom: ['A1'] },
            { id: 'A10', name: '海上保安庁', parentEntityIds: [], mergedFrom: [] },
            { id: 'B12', name: '日本航空機', parentEntityIds: [], mergedFrom: [] },
          ],
          subjectPoset: {
            nodes: ['A1', 'A12', 'A10', 'B12'],
            relations: [
              { childId: 'A1', parentId: 'A12' },
              { childId: 'A1', parentId: 'A10' },
              { childId: 'A12', parentId: 'A10' },
            ],
            aliases: {},
          },
        },
        truncated: false,
        originalChars: 300,
      },
      {
        time: '2026-11-06T02:05:00.000Z',
        sessionId: 'haneda_s1',
        stage: 'chain-repair.validation',
        data: {
          issues: [
            {
              id: 'tmp_R1',
              raw: 'tmp_R1\tbefore\tE1\tA1\tE2\tA1\tsource_1/p1\t-\t-\tna\trecorded\t出発枠変更から管制承認要求への時系列遷移',
              reason: '関係の主体がイベントに関与していません。',
            },
          ],
        },
        truncated: false,
        originalChars: 200,
      },
    ];

    const pkg = buildAIDiagnostics({
      entries,
      scenarioText: content,
    });

    expect(pkg.subject_poset).toBeDefined();
    expect(pkg.subject_poset?.node_count).toBe(4);
    expect(pkg.contract_rules?.subject_poset_transitivity).toBeDefined();

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('Subject Poset DAG Hierarchy (Canonical Inclusion)');
    expect(md).toContain('機長Ａ');
    expect(md).toContain('海上保安庁機');
    expect(md).toContain('parents: ["A12", "A10"]');
    expect(md).toContain('ancestors: ["A12", "A10"]');
    expect(md).toContain('merged_into: "A12"');
    expect(md).toContain('subject_poset_transitivity');
    expect(md.length).toBeLessThan(15000); // 13,000文字の要約シナリオでも高密度に凝縮
  });
});
