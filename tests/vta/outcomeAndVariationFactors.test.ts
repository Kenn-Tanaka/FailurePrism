import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VTANode } from '../../src/tools/vta/features/vta/components/VTANode';
import { projectAnalysis, reconcileAnalysis, validateSavedAnalysis, sourceFromText } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { validateAndSanitizeProjectFile } from '../../src/tools/vta/features/vta/utils/schemaValidator';
import { generateVTASVG } from '../../src/tools/vta/features/vta/utils/svgExport';
import type { VTASchema, VTAAnalysisData, VTANodeData } from '../../src/tools/vta/types/vta';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useUpdateNodeInternals: () => vi.fn(),
}));

vi.mock('../../src/tools/vta/features/vta/store/vtaStore', () => ({
  useVTAStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    compactView: false,
    toggleNodeElimination: vi.fn(),
    setNodeHidden: vi.fn(),
    deleteNode: vi.fn(),
    openNodeEditor: vi.fn(),
  }),
}));

describe('Outcome Node & Variation Factor Refinements (Items 8, 9, 10)', () => {
  const source = sourceFromText('作業員が手順を省略した。\nシステムが緊急停止した。');
  const baseAnalysis: VTAAnalysisData = {
    version: 5,
    sources: source.paragraphs.length ? [source] : [],
    facts: [],
    events: [
      {
        id: 'E1',
        time: '10:00',
        title: '手順省略',
        description: '作業員が手順を省略した',
        sourceOrder: 0,
        factIds: [],
        sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[0].id }],
        classification: 'variation',
        variationFactor: {
          category: 'departure',
          polarity: 'negative',
        },
      },
      {
        id: 'E2',
        time: '10:05',
        title: '緊急停止',
        description: 'システムが緊急停止した',
        sourceOrder: 1,
        factIds: [],
        sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[1].id }],
        classification: 'outcome',
        outcome_kind: 'near_miss',
      },
    ],
    entities: [
      { id: 'A1', name: '作業員', kind: 'person' },
      { id: 'A2', name: 'システム', kind: 'machine' },
    ],
    participations: [
      { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] },
      { eventId: 'E2', entityId: 'A2', role: 'actor', factIds: [] },
    ],
    relations: [],
    cards: [
      { id: 'C1', laneEntityId: 'A1', eventIds: ['E1'] },
      { id: 'C2', laneEntityId: 'A2', eventIds: ['E2'] },
    ],
    unassignedEventIds: [],
    outcome: {
      status: 'identified',
      kind: 'near_miss',
      eventIds: ['E2'],
      sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[1].id }],
      reason: '直前での緊急停止',
    },
  };
  describe('Visual rendering of Outcome Nodes on Canvas', () => {
    it('renders loss outcome node with crimson theme and label', () => {
      const html = renderToStaticMarkup(React.createElement(VTANode, {
        data: {
          id: 'n_loss',
          lane: 'システム部門',
          time: '10:30',
          type: 'outcome',
          outcome_kind: 'loss',
          title: '主回路遮断器の爆損',
          description: '過電圧印加により全損',
          measure_type: null,
        },
        selected: false,
      } as any));

      expect(html).toContain('帰結: 損失発生');
      expect(html).toContain('主回路遮断器の爆損');
      expect(html).toContain('border-rose-600');
    });

    it('renders near_miss outcome node with amber theme and label', () => {
      const html = renderToStaticMarkup(React.createElement(VTANode, {
        data: {
          id: 'n_near_miss',
          lane: '安全装置',
          time: '10:29',
          type: 'outcome',
          outcome_kind: 'near_miss',
          title: '過負荷検知による緊急停止',
          description: '破損寸前で遮断器トリップ',
          measure_type: null,
        },
        selected: false,
      } as any));

      expect(html).toContain('帰結: 直前停止');
      expect(html).toContain('過負荷検知による緊急停止');
      expect(html).toContain('border-amber-500');
    });

    it('renders recovery outcome node with emerald theme and label', () => {
      const html = renderToStaticMarkup(React.createElement(VTANode, {
        data: {
          id: 'n_rec',
          lane: '当直管制官',
          time: '10:35',
          type: 'outcome',
          outcome_kind: 'recovery',
          title: '代替航路への再進入誘導完了',
          description: '損失なく通常状態へ復旧',
          measure_type: null,
        },
        selected: false,
      } as any));

      expect(html).toContain('帰結: 正常復帰');
      expect(html).toContain('代替航路への再進入誘導完了');
      expect(html).toContain('border-emerald-500');
    });
  });

  describe('Visual rendering of Variation Factor Refinements & Safety-II Polarity', () => {
    it('renders resilient variation node with teal theme and recovery badge', () => {
      const html = renderToStaticMarkup(React.createElement(VTANode, {
        data: {
          id: 'n_resilient',
          lane: '機長',
          time: '10:20',
          type: 'variation',
          variation_factor: {
            category: 'response',
            cognitiveLevel: 'knowledge',
            polarity: 'resilient',
            description: '臨機応変な判断による回避介入',
          },
          title: '非定型な手動復旧操作の実施',
          description: '未規定の手順を適用して危機を回避',
          measure_type: null,
        },
        selected: false,
      } as any));

      expect(html).toContain('変動: レジリエンス');
      expect(html).toContain('border-teal-400');
      expect(html).toContain('先行応答(knowledge)');
    });

    it('renders standard negative variation node with category badges', () => {
      const html = renderToStaticMarkup(React.createElement(VTANode, {
        data: {
          id: 'n_dep',
          lane: '現場作業員',
          time: '09:50',
          type: 'variation',
          variation_factor: {
            category: 'departure',
            polarity: 'negative',
          },
          title: '指差し確認の省略',
          description: '急ぎのためスキップ',
          measure_type: null,
        },
        selected: false,
      } as any));

      expect(html).toContain('変動要因');
      expect(html).toContain('人為逸脱');
      expect(html).toContain('border-amber-400');
    });
  });

  describe('Reconciliation and Projection of Outcomes and Factors', () => {
    it('projects outcome and variation factor details to VTASchema nodes', () => {
      const schema = projectAnalysis(baseAnalysis);
      const e2Node = schema.nodes.find((n) => n.id === 'C2');
      expect(e2Node).toBeDefined();
      expect(e2Node?.type).toBe('outcome');
      expect(e2Node?.outcome_kind).toBe('near_miss');

      const e1Node = schema.nodes.find((n) => n.id === 'C1');
      expect(e1Node).toBeDefined();
      expect(e1Node?.type).toBe('variation');
      expect(e1Node?.variation_factor?.category).toBe('departure');
      expect(e1Node?.variation_factor?.polarity).toBe('negative');
    });

    it('reconciles user edits of outcome and variation factor into analysis events', () => {
      const prevSchema = projectAnalysis(baseAnalysis);
      const changedSchema: VTASchema = {
        ...prevSchema,
        nodes: prevSchema.nodes.map((n) => {
          if (n.id === 'C1') {
            return {
              ...n,
              variation_factor: {
                category: 'response',
                cognitiveLevel: 'skill',
                polarity: 'resilient',
              },
            };
          }
          if (n.id === 'C2') {
            return {
              ...n,
              type: 'outcome',
              outcome_kind: 'recovery',
            };
          }
          return n;
        }),
      };

      const reconciled = reconcileAnalysis(prevSchema, changedSchema);
      const e1 = reconciled.analysis?.events.find((e) => e.id === 'E1');
      expect(e1?.variationFactor?.category).toBe('response');
      expect(e1?.variationFactor?.cognitiveLevel).toBe('skill');
      expect(e1?.variationFactor?.polarity).toBe('resilient');

      const e2 = reconciled.analysis?.events.find((e) => e.id === 'E2');
      expect(e2?.outcome_kind).toBe('recovery');
      expect(reconciled.analysis?.outcome?.kind).toBe('recovery');
    });

    it('cleans up outcome and factor attributes when node is changed back to normal', () => {
      const prevSchema = projectAnalysis(baseAnalysis);
      const changedSchema: VTASchema = {
        ...prevSchema,
        nodes: prevSchema.nodes.map((n) => {
          if (n.id === 'C1') {
            return {
              ...n,
              type: 'normal',
              variation_factor: undefined,
            };
          }
          if (n.id === 'C2') {
            return {
              ...n,
              type: 'normal',
              outcome_kind: undefined,
            };
          }
          return n;
        }),
      };

      const reconciled = reconcileAnalysis(prevSchema, changedSchema);
      const n1 = reconciled.nodes.find((n) => n.id === 'C1');
      expect(n1?.type).toBe('normal');
      expect(n1?.variation_factor).toBeUndefined();

      const n2 = reconciled.nodes.find((n) => n.id === 'C2');
      expect(n2?.type).toBe('normal');
      expect(n2?.outcome_kind).toBeUndefined();

      const e1 = reconciled.analysis?.events.find((e) => e.id === 'E1');
      expect(e1?.classification).toBe('normal');
      expect(e1?.variationFactor).toBeUndefined();

      const e2 = reconciled.analysis?.events.find((e) => e.id === 'E2');
      expect(e2?.classification).toBe('normal');
      expect(e2?.outcome_kind).toBeUndefined();
      expect(reconciled.analysis?.outcome?.status).toBe('not_found');
    });

    it('cleans up manual outcome events and outcome metadata when card is deleted', () => {
      const prevSchema = projectAnalysis(baseAnalysis);
      // Delete C2 (the outcome card)
      const changedSchema: VTASchema = {
        ...prevSchema,
        nodes: prevSchema.nodes.filter((n) => n.id !== 'C2'),
      };

      const reconciled = reconcileAnalysis(prevSchema, changedSchema);
      expect(reconciled.nodes.some((n) => n.id === 'C2')).toBe(false);
    });
  });

  describe('Serialization and Schema Validation of Projects with Outcomes & Factors', () => {
    it('validates and preserves outcome and variation factors across JSON save/load', () => {
      const projected = projectAnalysis(baseAnalysis);
      const sampleProject = {
        version: '5.0',
        savedAt: new Date().toISOString(),
        scenarioText: source.text,
        vtaData: projected,
      };

      const val = validateAndSanitizeProjectFile(sampleProject);
      expect(val.isValid).toBe(true);
      const n1 = val.data?.vtaData.nodes.find((n) => n.id === 'C1');
      expect(n1?.type).toBe('variation');
      expect(n1?.variation_factor?.category).toBe('departure');
      expect(n1?.variation_factor?.polarity).toBe('negative');

      const n2 = val.data?.vtaData.nodes.find((n) => n.id === 'C2');
      expect(n2?.type).toBe('outcome');
      expect(n2?.outcome_kind).toBe('near_miss');
    });
  });

  describe('SVG Export for Outcome and Resilient Variation Nodes', () => {
    it('exports SVG with distinct color themes for outcome kinds and resilient nodes', () => {
      const schema: VTASchema = {
        lanes: ['部門A'],
        nodes: [
          {
            id: 'n_loss',
            lane: '部門A',
            time: '10:00',
            type: 'outcome',
            outcome_kind: 'loss',
            title: '機器破損',
            description: '',
            measure_type: null,
            position: { x: 100, y: 100 },
          },
          {
            id: 'n_res',
            lane: '部門A',
            time: '09:30',
            type: 'variation',
            variation_factor: { category: 'response', polarity: 'resilient' },
            title: '早期対応',
            description: '',
            measure_type: null,
            position: { x: 100, y: 200 },
          },
        ],
        edges: [],
      };

      const svg = generateVTASVG(schema, [], [], []);
      expect(svg).toContain('【帰結: 損失】');
      expect(svg).toContain('#e11d48'); // crimson stroke
      expect(svg).toContain('【変動: 回復】');
      expect(svg).toContain('#0d9488'); // teal stroke
    });
  });
});
