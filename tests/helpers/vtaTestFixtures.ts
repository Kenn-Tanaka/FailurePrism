import type { SampleScenario } from '../../src/tools/vta/features/vta/data/sampleData';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { createManualAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { calculateVTALayout } from '../../src/tools/vta/features/vta/utils/layout';

export const TEST_VTA_FIXTURES: readonly [SampleScenario, SampleScenario] = [
  {
    id: 'test-fixture-alpha',
    title: 'テスト用フィクスチャA',
    scenarioText: [
      '部門Aが仕様変更を実施した。',
      '部門Aが部門Bへの変更連絡を失念した。',
      '部門Aが手順書の改訂を行わなかった。',
      '部門Bが旧仕様のまま確認手順を作成した。',
      '作業担当が旧手順書に従って作業を実施した。',
      '部門Bが事前確認で不整合に気付かなかった。',
      '試験通電時に過電圧が発生し機器が損傷した。',
    ].join('\n'),
    vtaData: {
      lanes: ['部門B', '部門A', '作業担当'],
      nodes: [
        {
          id: 'node_1',
          lane: '部門A',
          time: 'Phase 1',
          type: 'normal',
          title: '仕様変更の実施',
          description: '機器の仕様変更を実施した。',
          measure_type: null,
        },
        {
          id: 'node_2',
          lane: '部門A',
          time: 'Phase 2',
          type: 'variation',
          title: '変更連絡の失念',
          description: '部門Bへ変更内容を伝達しなかった。',
          measure_type: null,
        },
        {
          id: 'node_3',
          lane: '部門A',
          time: 'Phase 2',
          type: 'variation',
          title: '手順書改訂の未実施',
          description: '手順書を旧版のまま据え置いた。',
          measure_type: null,
        },
        {
          id: 'node_4',
          lane: '部門B',
          time: 'Phase 3',
          type: 'variation',
          title: '旧仕様での確認手順作成',
          description: '変更未反映のまま確認手順を作成した。',
          measure_type: null,
        },
        {
          id: 'node_5',
          lane: '作業担当',
          time: 'Phase 4',
          type: 'variation',
          title: '旧手順での結線作業',
          description: '改訂前の手順書に従い結線した。',
          measure_type: null,
        },
        {
          id: 'node_6',
          lane: '部門B',
          time: 'Phase 5',
          type: 'variation',
          title: '事前確認での見落とし',
          description: '不整合を検出できず確認を完了した。',
          measure_type: null,
        },
        {
          id: 'node_7',
          lane: '部門B',
          time: 'Phase 6',
          type: 'variation',
          title: '過電圧印加・機器損傷',
          description: '通電時に機器が損傷した。',
          measure_type: null,
        },
      ],
      edges: [
        { source: 'node_1', target: 'node_2', is_break: false, category: 'sequential', direction: 'sequential' },
        { source: 'node_1', target: 'node_3', is_break: false, category: 'sequential', direction: 'sequential' },
        { source: 'node_2', target: 'node_4', is_break: false, label: '連絡欠落', category: 'information', direction: 'unidirectional' },
        { source: 'node_3', target: 'node_5', is_break: false, category: 'information', direction: 'unidirectional' },
        { source: 'node_4', target: 'node_6', is_break: false, category: 'sequential', direction: 'sequential' },
        { source: 'node_5', target: 'node_6', is_break: false, category: 'information', direction: 'unidirectional' },
        { source: 'node_6', target: 'node_7', is_break: false, category: 'sequential', direction: 'sequential' },
      ],
    },
  },
  {
    id: 'test-fixture-beta',
    title: 'テスト用フィクスチャB',
    scenarioText: '運用チームと監視チームのテストシナリオB。',
    vtaData: {
      lanes: ['運用チーム', '監視チーム'],
      nodes: [
        {
          id: 'b_node_1',
          lane: '運用チーム',
          time: '10:00',
          type: 'variation',
          title: '設定変更の適用漏れ',
          description: '設定反映手順を一部省略した。',
          measure_type: null,
        },
        {
          id: 'b_node_2',
          lane: '監視チーム',
          time: '10:15',
          type: 'variation',
          title: '応答遅延アラート発生',
          description: 'サービス応答遅延が発生した。',
          measure_type: null,
        },
      ],
      edges: [
        { source: 'b_node_1', target: 'b_node_2', is_break: false, category: 'information', direction: 'unidirectional' },
      ],
    },
  },
];

export function seedVTAStoreWithFixture(index: 0 | 1 = 0): SampleScenario {
  const fixture = TEST_VTA_FIXTURES[index];
  useVTAStore.getState().resetProject();
  const baseData = structuredClone(fixture.vtaData);
  const schema = { ...baseData, analysis: createManualAnalysis(baseData) };
  const layout = calculateVTALayout(schema);
  useVTAStore.setState({
    selectedSampleId: fixture.id,
    scenarioText: fixture.scenarioText,
    vtaData: schema,
    nodes: layout.nodes,
    edges: layout.edges,
    laneBounds: layout.laneBounds,
    regenerationResult: null,
    isReportOutdated: false,
    error: null,
    activeTab: 'scenario',
    isDirty: false,
    past: [],
    future: [],
  });
  useVTAStore.getState().clearDraftBackup();
  return fixture;
}
