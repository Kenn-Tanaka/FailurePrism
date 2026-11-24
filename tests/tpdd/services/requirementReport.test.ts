import { describe, expect, it } from 'vitest';
import { validateRequirementReportResponse } from '../../../src/tools/tpdd/services/llm/aiSchemas';
import { buildRequirementReportMessages } from '../../../src/tools/tpdd/services/llm/prompts';
import { buildRequirementReportMarkdown } from '../../../src/tools/tpdd/services/llm/requirementReportDocument';
import { RequirementScope } from '../../../src/tools/tpdd/domain/requirementScope';

const context = {
  rootNodeRef: 'N1',
  nodeRefs: new Set(['N1', 'N2', 'N3']),
  detailNodeRefs: new Set(['N3']),
  edgesByRef: new Map([
    ['E1', { kind: 'decomposition', sourceNodeRef: 'N1', targetNodeRef: 'N2' }],
    ['E2', { kind: 'dependency', sourceNodeRef: 'N1', targetNodeRef: 'N2' }],
  ]),
};

describe('validateRequirementReportResponse', () => {
  it('keeps evidence-backed statements and resolves edge endpoints into node citations', () => {
    const result = validateRequirementReportResponse({
      sections: [
        {
          id: 'breakdown',
          statements: [{
            text: '起点ノードは機能要素へ分解されています。',
            nodeRefs: [],
            edgeRefs: ['e1'],
          }],
        },
        {
          id: 'concretization',
          statements: [{
            text: '詳細図のノードN3で具体化されています。',
            nodeRefs: ['n3'],
            edgeRefs: [],
          }],
        },
      ],
    }, context);

    expect(result.valid).toBe(true);
    expect(result.data?.sections[0].statements[0]).toEqual({
      text: '起点ノードは機能要素へ分解されています。',
      nodeRefs: ['N1', 'N2'],
      edgeRefs: ['E1'],
    });
    expect(result.data?.sections[1].statements[0]).toEqual({
      text: '詳細図のノードN3で具体化されています。',
      nodeRefs: ['N3'],
      edgeRefs: [],
    });
  });

  it('requires the requirement statement itself to cite the selected root', () => {
    const result = validateRequirementReportResponse({
      sections: [{
        id: 'requirement',
        statements: [{
          text: '起点の要求です。',
          nodeRefs: [],
          edgeRefs: ['E1'],
        }],
      }],
    }, context);

    expect(result.valid).toBe(true);
    expect(result.data?.sections).toEqual([]);
    expect(result.warnings).toContain('起点要求を根拠に含まない説明文を除外しました。');
  });

  it('requires concretization statements to cite at least one detail-diagram node and returns empty sections with warning when all statements are discarded', () => {
    const result = validateRequirementReportResponse({
      sections: [{
        id: 'concretization',
        statements: [{
          text: '起点図のノードN2のみを参照した具体化文。',
          nodeRefs: ['N2'],
          edgeRefs: [],
        }],
      }],
    }, context);

    expect(result.valid).toBe(true);
    expect(result.data?.sections).toEqual([]);
    expect(result.warnings).toContain('詳細図のノードを根拠に含まない具体化の説明を除外しました。');
  });

  it('drops breakdown claims without a decomposition edge and claims with unknown references', () => {
    const result = validateRequirementReportResponse({
      sections: [{
        id: 'breakdown',
        statements: [
          { text: '分解されています。', nodeRefs: ['N1', 'N2'], edgeRefs: ['E2'] },
          { text: 'さらに分解されています。', nodeRefs: ['N1'], edgeRefs: ['E99'] },
        ],
      }],
    }, context);

    expect(result.valid).toBe(true);
    expect(result.data?.sections).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('rejects malformed output instead of passing it through as report text', () => {
    const result = validateRequirementReportResponse({ sections: 'free-form text' }, context);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('形式');
  });

  it('supports multiple project-wide rootNodeRefs for whole-project requirement statements', () => {
    const multiRootContext = {
      rootNodeRefs: new Set(['N1', 'N4']),
      nodeRefs: new Set(['N1', 'N2', 'N3', 'N4']),
      detailNodeRefs: new Set(['N3']),
      edgesByRef: new Map([
        ['E1', { kind: 'decomposition', sourceNodeRef: 'N1', targetNodeRef: 'N2' }],
      ]),
    };

    const result = validateRequirementReportResponse(
      {
        sections: [
          {
            id: 'requirement',
            statements: [
              { text: '第1の最上位要求です。', nodeRefs: ['N1'], edgeRefs: [] },
              { text: '第2の最上位要求です。', nodeRefs: ['n4'], edgeRefs: [] },
              { text: '中間ノードのみの記述です。', nodeRefs: ['N2'], edgeRefs: [] },
            ],
          },
        ],
      },
      multiRootContext
    );

    expect(result.valid).toBe(true);
    expect(result.data?.sections[0].statements.map((s) => s.nodeRefs)).toEqual([['N1'], ['N4']]);
    expect(result.warnings).toContain('起点要求を根拠に含まない説明文を除外しました。');
  });

  it('builds whole-project proposal and presentation markdown with Gemini/ChatGPT prompt header and level-grouped ledger', () => {
    const sampleScope: RequirementScope = {
      rootNodeRef: 'N1',
      rootNodeRefs: ['N1', 'N3'],
      projectTitle: '次世代物流管理システム',
      projectDescription: '倉庫内搬送と配送計画を統合最適化するプロジェクト',
      diagrams: [
        { ref: 'D1', sourceId: 'd1', title: '全体構想図' },
        { ref: 'D2', sourceId: 'd2', title: '配車モジュール詳細', ownerNodeRef: 'N2' },
      ],
      nodeKinds: [
        { ref: 'K1', label: '要求', description: '' },
        { ref: 'K2', label: '機能', description: '' },
      ],
      levels: [
        { ref: 'L1', label: '目的・要求', description: '上位の事業要求' },
        { ref: 'L2', label: '機能構成', description: 'システム機能' },
      ],
      nodes: [
        {
          ref: 'N1',
          sourceId: 'n1',
          diagramRef: 'D1',
          kindRef: 'K1',
          levelRef: 'L1',
          label: '配送リードタイムの半減',
          status: 'adopted',
          description: '当日配送率を高める',
          tags: ['KPI'],
          isRoot: true,
        },
        {
          ref: 'N2',
          sourceId: 'n2',
          diagramRef: 'D1',
          kindRef: 'K2',
          levelRef: 'L2',
          label: '動的配車エンジン',
          status: 'adopted',
          description: '',
          tags: [],
          isRoot: false,
        },
        {
          ref: 'N3',
          sourceId: 'n3',
          diagramRef: 'D1',
          kindRef: 'K1',
          levelRef: 'L1',
          label: '荷待ち時間の削減',
          status: 'candidate',
          description: '',
          tags: [],
          isRoot: true,
        },
        {
          ref: 'N4',
          sourceId: 'n4',
          diagramRef: 'D2',
          kindRef: 'K2',
          levelRef: 'L2',
          label: '渋滞予測ルート探索',
          status: 'adopted',
          description: '',
          tags: [],
          isRoot: false,
        },
      ],
      edges: [
        {
          ref: 'E1',
          sourceId: 'e1',
          diagramRef: 'D1',
          sourceNodeRef: 'N1',
          targetNodeRef: 'N2',
          kind: 'decomposition',
          label: '機能分解',
        },
      ],
      excludedRejectedCount: 1,
    };

    const messages = buildRequirementReportMessages(sampleScope, {
      format: 'presentation',
      styleInstruction: '経営会議向けの10枚スライド構成用',
    });
    expect(messages[0].content).toContain('プレゼンテーション資料構成形式');
    expect(messages[1].content).toContain('次世代物流管理システム');
    expect(messages[1].content).toContain('"rootNodeRefs": [\n    "N1",\n    "N3"\n  ]');

    const markdown = buildRequirementReportMarkdown(
      '次世代物流管理システム',
      sampleScope,
      {
        sections: [
          {
            id: 'requirement',
            statements: [{ text: 'リードタイム半減と荷待ち削減を目指します。', nodeRefs: ['N1', 'N3'], edgeRefs: [] }],
          },
          {
            id: 'breakdown',
            statements: [{ text: '動的配車エンジンへ機能展開します。', nodeRefs: ['N1', 'N2'], edgeRefs: ['E1'] }],
          },
          {
            id: 'concretization',
            statements: [{ text: '詳細図で渋滞予測ルート探索を具体化しています。', nodeRefs: ['N4'], edgeRefs: [] }],
          },
        ],
      },
      '2026/11/17 23:30:00',
      [],
      {
        format: 'presentation',
        styleInstruction: '経営会議向けの10枚スライド構成用',
        includeAiPromptHeader: true,
      }
    );

    expect(markdown).toContain('## AIアシスタント（Gemini / ChatGPT）への作成指示');
    expect(markdown).toContain('プレゼンテーション資料（スライド構成案');
    expect(markdown).toContain('経営会議向けの10枚スライド構成用');
    expect(markdown).toContain('## プロジェクト背景・全体説明');
    expect(markdown).toContain('倉庫内搬送と配送計画を統合最適化するプロジェクト');
    expect(markdown).toContain('## 1. 背景・目的・対象要求（導入スライド構成）');
    expect(markdown).toContain('## 抽象度列（レベル）別の設計要素一覧');
    expect(markdown).toContain('### [L1] 目的・要求');
  });
});
