import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAnalysis,
  projectAnalysis,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
  validateSavedAnalysis,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { refineGranularity } from '../../src/tools/vta/services/generation/granularityRefinement';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { validateAndSanitizeProjectFile } from '../../src/tools/vta/features/vta/utils/schemaValidator';
import type { LLMConfig } from '../../src/tools/vta/types/vta';
import { callLLMGateway } from '../../src/tools/vta/services/llm/client';

vi.mock('../../src/tools/vta/services/llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/vta/services/llm/client')>();
  return {
    ...actual,
    callLLMGateway: vi.fn(),
  };
});

const dummyConfig: LLMConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  gatewayToken: 'test-key',
  selectedModel: 'test-model',
  timeoutSeconds: 30,
};

const createScenarioWithCustomEdits = () => {
  const source = sourceFromText('09:00 指示を出した。\n09:01 受領して復唱した。\n09:02 確認した。');
  const facts = validateFacts({
    facts: [
      { id: 'f1', text: '指示を出した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 指示を出した。' }] },
      { id: 'f2', text: '受領して復唱した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:01 受領して復唱した。' }] },
      { id: 'f3', text: '確認した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:02 確認した。' }] },
    ],
  }, [source]);
  const events = validateEvents({
    events: [
      { id: 'e1', title: '指示発出', description: '指示を出した', time: '09:00', factIds: ['f1'] },
      { id: 'e2', title: '復唱', description: '受領して復唱した', time: '09:01', factIds: ['f2'] },
      { id: 'e3', title: '確認', description: '確認した', time: '09:02', factIds: ['f3'] },
    ],
  }, facts);

  const parsed = validateParticipants({
    entities: [
      { id: 'ent_tower', name: '管制塔', kind: 'person' },
      { id: 'ent_pilot', name: '機長', kind: 'person' },
      { id: 'ent_copilot', name: '副操縦士', kind: 'person' },
    ],
    participations: [
      { eventId: 'e1', entityId: 'ent_tower', role: 'actor', factIds: ['f1'] },
      { eventId: 'e2', entityId: 'ent_pilot', role: 'actor', factIds: ['f2'] },
      { eventId: 'e3', entityId: 'ent_copilot', role: 'actor', factIds: ['f3'] },
    ],
    relations: [
      { id: 'r1', kind: 'transfer', sourceEventId: 'e1', sourceEntityId: 'ent_tower', targetEventId: 'e2', targetEntityId: 'ent_pilot', factIds: ['f1'] },
    ],
    cardGroups: [],
  }, events, facts);

  const analysis = buildAnalysis(source, facts, events, parsed);
  let schema = projectAnalysis(analysis);

  // ユーザー手動編集の注入
  const card1 = schema.nodes.find((n) => n.title === '指示発出')!;
  const card3 = schema.nodes.find((n) => n.title === '確認')!;

  // 1. ノード補足説明
  schema.nodes = schema.nodes.map((node) => {
    if (node.id === card1.id) {
      return { ...node, supplementary_note: '管制側の背景要因：直前の通信混雑' };
    }
    return node;
  });

  // 2. 手動接続線（card1 -> card3 への手動エッジ）
  schema.edges.push({
    id: 'manual_edge_1_3',
    source: card1.id,
    target: card3.id,
    generated: false,
    meaning: 'dependency',
    label: '事前確認依存',
  });

  // 3. カスタムメモ
  schema.custom_notes = [
    { id: 'cn_1', title: '注記メモ', content: '滑走路進入許可に関する留意点' },
  ];

  // 4. 補足サマリー
  schema.supplementary_summary = '全体総括：複数交信における聴取確認プロトコルの検討';

  return { source, facts, events, analysis, schema };
};

describe('Issue 2 Regression: VTA reoptimization preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves manual edges, supplementary notes, custom notes, and summary when LLM proposes no ops', async () => {
    const { analysis, schema } = createScenarioWithCustomEdits();

    // LLM モック: 修正提案なし（C2/C4 のみ評価し、ops は空）
    const mockCallChat = vi.fn().mockResolvedValue({
      content: [
        '[評価]',
        '項目\t値\t理由',
        'C2\t0.90\t役割の一貫性良好',
        'C4\t0.90\t境界の妥当性良好',
        '[修正]',
        'ID\t操作\t対象ID\t内容\t原文参照\t理由',
        '[完了]',
      ].join('\n'),
      latencyMs: 100,
    });
    const logTrace = vi.fn();

    const result = await refineGranularity(
      dummyConfig,
      analysis,
      5,
      undefined,
      mockCallChat,
      logTrace,
      1,
      0.82,
      0.02,
      undefined,
      undefined,
      undefined,
      undefined,
      schema // 現在のスキーマを渡す
    );

    // 1. ノードの補足説明が保持されていること
    const refinedCard1 = result.nodes.find((n) => n.event_ids?.includes('e1'));
    expect(refinedCard1?.supplementary_note).toBe('管制側の背景要因：直前の通信混雑');

    // 2. 手動接続線が保持されていること
    const manualEdge = result.edges.find((e) => e.id === 'manual_edge_1_3');
    expect(manualEdge).toBeDefined();
    expect(manualEdge?.meaning).toBe('dependency');
    expect(manualEdge?.label).toBe('事前確認依存');

    // 3. カスタムメモが保持されていること
    expect(result.custom_notes).toHaveLength(1);
    expect(result.custom_notes?.[0].title).toBe('注記メモ');

    // 4. 補足サマリーが保持されていること
    expect(result.supplementary_summary).toBe('全体総括：複数交信における聴取確認プロトコルの検討');
  });

  it('preserves editable information and maintains valid endpoints when card configuration changes (subject merge)', async () => {
    const { analysis, schema } = createScenarioWithCustomEdits();

    // LLM モック: 機長と副操縦士を統合する提案（merge: ent_copilot -> ent_pilot）
    const mockCallChat = vi.fn().mockResolvedValue({
      content: [
        '[評価]',
        '項目\t値\t理由',
        'C2\t0.80\tクルー統合',
        'C4\t0.90\t良好',
        '[修正]',
        'ID\t操作\t対象ID\t内容\t原文参照\t理由',
        '1\tmerge\tent_copilot\tent_pilot\tsource_1/p3\t操縦クルーとして1レーンに統合',
        '[完了]',
      ].join('\n'),
      latencyMs: 100,
    });
    const logTrace = vi.fn();

    const result = await refineGranularity(
      dummyConfig,
      analysis,
      2, // 最大主体数を2に絞り、統合を促す
      undefined,
      mockCallChat,
      logTrace,
      1,
      0.82,
      0.02,
      undefined,
      undefined,
      undefined,
      undefined,
      schema
    );

    // 1. 補足情報がイベント経由で保持されていること
    const refinedCard1 = result.nodes.find((n) => n.event_ids?.includes('e1'));
    expect(refinedCard1?.supplementary_note).toBe('管制側の背景要因：直前の通信混雑');

    // 2. 手動接続線の端点が更新されて維持され、不正な孤立参照がないこと
    const manualEdge = result.edges.find((e) => e.meaning === 'dependency');
    expect(manualEdge).toBeDefined();
    // 端点ノードが result.nodes に存在すること
    expect(result.nodes.some((n) => n.id === manualEdge?.source)).toBe(true);
    expect(result.nodes.some((n) => n.id === manualEdge?.target)).toBe(true);

    // 3. 統合後のレーン (その他の関係者) 内に2カードが維持されていること (ADR-0008により「その他の関係者」内は独立配置)
    const otherNodes = result.nodes.filter((n) => n.lane === 'その他の関係者');
    expect(otherNodes).toHaveLength(2);

    // 4. スキーマ全体の検証が正常に通ること
    const projectValidation = validateAndSanitizeProjectFile({ version: '5.0', vtaData: result });
    expect(projectValidation.isValid).toBe(true);
  });

  it('regenerates intra-lane sequential edges on normal lanes when cards are reorganized during refinement', async () => {
    const source = sourceFromText('09:00 指示を出した。\n09:01 受領して復唱した。\n09:02 確認した。');
    const facts = validateFacts({
      facts: [
        { id: 'f1', text: '指示を出した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 指示を出した。' }] },
        { id: 'f2', text: '受領して復唱した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:01 受領して復唱した。' }] },
        { id: 'f3', text: '確認した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:02 確認した。' }] },
      ],
    }, [source]);
    const events = validateEvents({
      events: [
        { id: 'e1', title: '指示発出', description: '指示を出した', time: '09:00', factIds: ['f1'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }] },
        { id: 'e2', title: '復唱', description: '受領して復唱した', time: '09:01', factIds: ['f2'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }] },
        { id: 'e3', title: '確認', description: '確認した', time: '09:02', factIds: ['f3'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }] },
      ],
    }, facts, false, false, [source]);

    const parsed = validateParticipants({
      entities: [
        { id: 'ent_tower', name: '管制塔', kind: 'person' },
        { id: 'ent_pilot', name: '機長', kind: 'person' },
        { id: 'ent_copilot', name: '副操縦士', kind: 'person' },
      ],
      participations: [
        { eventId: 'e1', entityId: 'ent_tower', role: 'actor', factIds: ['f1'] },
        { eventId: 'e2', entityId: 'ent_pilot', role: 'actor', factIds: ['f2'] },
        { eventId: 'e3', entityId: 'ent_copilot', role: 'actor', factIds: ['f3'] },
      ],
      relations: [],
      cardGroups: [],
    }, events, facts);

    const analysis = buildAnalysis(source, facts, events, parsed);
    const schema = projectAnalysis(analysis);

    // LLM モック: 副操縦士を機長レーンに統合（merge: ent_copilot -> ent_pilot）
    const mockCallChat = vi.fn().mockResolvedValue({
      content: [
        '[評価]',
        '項目\t値\t理由',
        'C2\t0.90\t機長集約',
        'C4\t0.90\t良好',
        '[修正]',
        'ID\t操作\t対象ID\t内容\t原文参照\t理由',
        '1\tmerge\tent_copilot\tent_pilot\tsource_1/p3\t機長レーンに統合',
        '[完了]',
      ].join('\n'),
      latencyMs: 100,
    });
    const logTrace = vi.fn();

    const result = await refineGranularity(
      dummyConfig,
      analysis,
      3, // 最大3レーン（副操縦士が機長に統合され、管制塔と機長の2レーンに収まる）
      undefined,
      mockCallChat,
      logTrace,
      1,
      0.0,
      0.0,
      undefined,
      undefined,
      undefined,
      undefined,
      schema
    );

    // 機長レーンに2つのカード（e2: 復唱, e3: 確認）が存在すること
    const pilotNodes = result.nodes.filter((n) => n.lane === '機長');
    expect(pilotNodes).toHaveLength(2);

    // 機長レーン内の2カード間に sequential な時系列接続線が再構築されていること
    const seqEdge = result.edges.find((e) =>
      e.direction === 'sequential' &&
      ((e.source === pilotNodes[0].id && e.target === pilotNodes[1].id) ||
       (e.source === pilotNodes[1].id && e.target === pilotNodes[0].id))
    );
    expect(seqEdge).toBeDefined();

    // プロジェクト全体の検証が成功すること
    const valid = validateAndSanitizeProjectFile({ version: '5.0', vtaData: result });
    expect(valid.isValid).toBe(true);
  });

  it('preserves manual edits through useVTAStore.reoptimizeVTA and supports undo/redo and project reload', async () => {
    const { schema } = createScenarioWithCustomEdits();
    const store = useVTAStore.getState();
    store.importProjectJSON(JSON.stringify({ version: '5.0', vtaData: schema }));
    useVTAStore.setState({ past: [], future: [] });

    // callLLMGateway をモック
    vi.mocked(callLLMGateway).mockResolvedValue({
      content: [
        '[評価]',
        '項目\t値\t理由',
        'C2\t0.95\t良好',
        'C4\t0.95\t良好',
        '[修正]',
        'ID\t操作\t対象ID\t内容\t原文参照\t理由',
        '[完了]',
      ].join('\n'),
      latencyMs: 100,
    });

    const success = await useVTAStore.getState().reoptimizeVTA();
    expect(success).toBe(true);

    const reoptimized = useVTAStore.getState().vtaData;

    // 手動編集が保持されていること
    const card1 = reoptimized.nodes.find((n) => n.event_ids?.includes('e1'));
    expect(card1?.supplementary_note).toBe('管制側の背景要因：直前の通信混雑');

    const manualEdge = reoptimized.edges.find((e) => e.meaning === 'dependency');
    expect(manualEdge).toBeDefined();
    expect(manualEdge?.label).toBe('事前確認依存');

    expect(reoptimized.custom_notes).toHaveLength(1);
    expect(reoptimized.custom_notes?.[0].title).toBe('注記メモ');
    expect(reoptimized.supplementary_summary).toBe('全体総括：複数交信における聴取確認プロトコルの検討');

    // 保存検証
    expect(() => validateSavedAnalysis(reoptimized.analysis)).not.toThrow();
    const projectValid = validateAndSanitizeProjectFile({ version: '5.0', vtaData: reoptimized });
    expect(projectValid.isValid).toBe(true);

    // Undo で最適化前の状態に戻せること
    useVTAStore.getState().undo();
    const undone = useVTAStore.getState().vtaData;
    expect(undone.nodes.find((n) => n.event_ids?.includes('e1'))?.supplementary_note).toBe('管制側の背景要因：直前の通信混雑');

    // Redo で再適用できること
    useVTAStore.getState().redo();
    const redone = useVTAStore.getState().vtaData;
    expect(redone.nodes.find((n) => n.event_ids?.includes('e1'))?.supplementary_note).toBe('管制側の背景要因：直前の通信混雑');
  });
});
