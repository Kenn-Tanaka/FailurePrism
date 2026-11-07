import { describe, it, expect } from 'vitest';
import { applyRefinementOps } from '../../src/tools/vta/services/generation/granularityRefinement';
import { revertConsolidation, consolidateSubjects } from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { applyChainDelta, type ChainRow } from '../../src/tools/vta/features/vta/utils/chainRepair';
import { sourceFromText, projectAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { parseLedger, inspectLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
import type { VTASchema, VTAAnalysisData, VTAEventRelation } from '../../src/tools/vta/types/vta';

describe('VTA Relation Deduplication and Revert Preservation', () => {
  const createBaseScenario = (): { schema: VTASchema; analysis: VTAAnalysisData } => {
    const source = sourceFromText(
      '09:00 機長Aが離陸準備を開始した。\n09:10 管制官Cが離陸許可を発出した。\n09:15 機長Aが滑走路に進入した。'
    );
    const doc = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t機長A\tperson\thigh\tA10\tp1',
        'A10\t運航乗務員\torganization\thigh\t-\tp1',
        'A2\t管制官C\tperson\thigh\t-\tp2',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t離陸準備\t機長Aが離陸準備を開始した\tA1:actor\tp1\trecorded',
        'E2\t09:10\t離陸許可\t管制官Cが離陸許可を発出した\tA2:actor\tp2\trecorded',
        'E3\t09:15\t滑走路進入\t機長Aが滑走路に進入した\tA1:actor\tp3\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\tbefore\tE1\t-\tE3\t-\tp1,p3\t-\t-\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE3\tp3\t滑走路進入完了',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E1\tnormal\t通常作業\tp1',
        'E2\tnormal\t通常作業\tp2',
        'E3\tvariation\t滑走路進入\tp3',
        '[完了]',
      ].join('\n')
    );
    const analysis = inspectLedger(doc, source).analysis!;
    const schema = projectAnalysis(analysis);
    return { schema, analysis };
  };

  describe('applyRefinementOps - Relation ID deduplication and endpoint normalization', () => {
    it('disambiguates identical op IDs with deterministic suffix when adding distinct relations', () => {
      const { schema } = createBaseScenario();
      const ops = [
        {
          id: 'M1',
          op: 'add_relation' as const,
          targetId: '-',
          content: 'transfer:E2:A2:E3:A1:information:occurred:confirmed',
          sourceRefs: ['p2', 'p3'],
          reason: '管制官からの離陸許可伝達',
        },
        {
          id: 'M1', // Identical op ID from subsequent line or iteration
          op: 'add_relation' as const,
          targetId: '-',
          content: 'impact:E2:A2:E3:A1:other:occurred:na',
          sourceRefs: ['p2', 'p3'],
          reason: '管制指示による直接影響',
        },
      ];

      const { schema: nextSchema, appliedOps } = applyRefinementOps(
        schema,
        ops,
        5,
        new Set<string>(),
        () => {}
      );

      expect(appliedOps).toContain('add_relation:rel_ref_M1');
      expect(appliedOps).toContain('add_relation:rel_ref_M1_2');

      const rel1 = nextSchema.analysis?.relations.find((r) => r.id === 'rel_ref_M1');
      const rel2 = nextSchema.analysis?.relations.find((r) => r.id === 'rel_ref_M1_2');
      expect(rel1).toBeDefined();
      expect(rel2).toBeDefined();
      expect(rel1?.kind).toBe('transfer');
      expect(rel2?.kind).toBe('impact');
    });

    it('skips duplicate relation when kind and endpoints are completely identical', () => {
      const { schema } = createBaseScenario();
      const ops = [
        {
          id: 'M1',
          op: 'add_relation' as const,
          targetId: '-',
          content: 'transfer:E2:A2:E3:A1:information:occurred:confirmed',
          sourceRefs: ['p2', 'p3'],
          reason: '管制官からの離陸許可伝達',
        },
        {
          id: 'M2', // Different ID, but completely identical content
          op: 'add_relation' as const,
          targetId: '-',
          content: 'transfer:E2:A2:E3:A1:information:occurred:confirmed',
          sourceRefs: ['p2', 'p3'],
          reason: '管制官からの離陸許可伝達（重複）',
        },
      ];

      const { schema: nextSchema, appliedOps } = applyRefinementOps(
        schema,
        ops,
        5,
        new Set<string>(),
        () => {}
      );

      expect(appliedOps).toHaveLength(1);
      expect(appliedOps[0]).toBe('add_relation:rel_ref_M1');
      const relations = nextSchema.analysis?.relations.filter(
        (r) => r.sourceEventId === 'E2' && r.targetEventId === 'E3' && r.kind === 'transfer'
      );
      expect(relations).toHaveLength(1);
    });

    it('normalizes fine-grained subject endpoint to consolidated subject and records sourceEntityOrigin', () => {
      const { analysis, schema } = createBaseScenario();
      // Explicitly merge fine-grained A1 into parent organization A10
      const explicitMerges = new Map<string, string>([['A1', 'A10']]);
      const consolidated = consolidateSubjects(analysis, 2, undefined, undefined, { explicitMerges });
      const consolidatedSchema = projectAnalysis(consolidated, schema);

      // Now LLM proposes an add_relation specifying fine-grained A1
      const ops = [
        {
          id: 'M1',
          op: 'add_relation' as const,
          targetId: '-',
          content: 'transfer:E2:A2:E3:A1:information:occurred:confirmed',
          sourceRefs: ['p2', 'p3'],
          reason: '細粒度主体A1を指定した伝達関係',
        },
      ];

      const { schema: nextSchema } = applyRefinementOps(
        consolidatedSchema,
        ops,
        2,
        new Set<string>(),
        () => {}
      );

      const added = nextSchema.analysis?.relations.find((r) => r.id === 'rel_ref_M1');
      expect(added).toBeDefined();
      // Target entity should be normalized to the consolidated parent A10 so it aligns with cards and edges
      expect(added?.targetEntityId).toBe('A10');
      // Original fine-grained target should be preserved in targetEntityOrigin
      expect(added?.targetEntityOrigin).toBe('A1');
    });

    it('rejects relations with non-existent events or before-cycles', () => {
      const { schema } = createBaseScenario();
      const ops = [
        {
          id: 'M_BAD_EV',
          op: 'add_relation' as const,
          targetId: '-',
          content: 'before:E1:-:E_NONEXISTENT:-:-:-:na',
          sourceRefs: ['p1'],
          reason: '架空イベントへの参照',
        },
        {
          id: 'M_CYCLE',
          op: 'add_relation' as const,
          targetId: '-',
          content: 'before:E3:-:E1:-:-:-:na', // E1 -> E3 already exists in base scenario
          sourceRefs: ['p1', 'p3'],
          reason: '閉路を作る逆向き関係',
        },
      ];

      const { nextSchema, appliedOps } = applyRefinementOps(
        schema,
        ops,
        5,
        new Set<string>(),
        () => {}
      ) as any;

      expect(appliedOps).toHaveLength(0);
    });
  });

  describe('revertConsolidation - Defense-in-depth sanitization and relation preservation', () => {
    it('sanitizes duplicate relation IDs without throwing in validateParticipants', () => {
      const { analysis } = createBaseScenario();
      const consolidated = consolidateSubjects(analysis, 2);

      // Artificially inject duplicate relation IDs into analysis.relations (simulating legacy data)
      const corruptedAnalysis: VTAAnalysisData = {
        ...consolidated,
        relations: [
          ...consolidated.relations,
          {
            ...consolidated.relations[0],
            id: consolidated.relations[0].id, // Same ID R1!
            kind: 'transfer',
            sourceEventId: 'E2',
            sourceEntityId: 'A2',
            targetEventId: 'E3',
            targetEntityId: 'A10',
            resource: 'information',
            status: 'occurred',
            receipt: 'confirmed',
          },
        ],
      };

      // revertConsolidation must not throw "関係 のIDが重複しています。"
      expect(() => revertConsolidation(corruptedAnalysis)).not.toThrow();

      const reverted = revertConsolidation(corruptedAnalysis);
      const relIds = reverted.relations.map((r) => r.id);
      expect(new Set(relIds).size).toBe(relIds.length);
      expect(relIds).toContain('R1');
      expect(relIds).toContain('R1_2');
    });

    it('preserves post-consolidation relations added directly to aggregate / parent lanes', () => {
      const { analysis } = createBaseScenario();
      // Consolidate A1 into A10
      const consolidated = consolidateSubjects(analysis, 2);

      // Add a relation pointing to consolidated parent A10 without Origin (e.g. from connectionProposal or canvas edit)
      const postAddedRel: VTAEventRelation = {
        id: 'proposal_123',
        kind: 'transfer',
        sourceEventId: 'E2',
        sourceEntityId: 'A2',
        targetEventId: 'E3',
        targetEntityId: 'A10', // Points to consolidated entity
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
        factIds: [],
        resource: 'information',
        status: 'occurred',
        receipt: 'confirmed',
      };

      const analysisWithPostRel: VTAAnalysisData = {
        ...consolidated,
        relations: [...consolidated.relations, postAddedRel],
      };

      // Revert consolidation should resolve A10 back to fine-grained participant A1 and preserve the relation
      const reverted = revertConsolidation(analysisWithPostRel);
      const found = reverted.relations.find((r) => r.id === 'proposal_123');
      expect(found).toBeDefined();
      expect(found?.targetEntityId).toBe('A1'); // Successfully resolved to fine-grained A1!
    });
  });

  describe('applyChainDelta - Chain repair relation application', () => {
    it('applies valid chain repair proposal with tmp_ ID and creates permanent relation on adoption', () => {
      const { schema } = createBaseScenario();
      const rows: ChainRow[] = [
        {
          section: '関係追加',
          id: 'tmp_rel1',
          cells: ['tmp_rel1', 'transfer', 'E2', 'A2', 'E3', 'A1', 'source_1/p2', 'information', 'occurred', 'confirmed', 'recorded', '補完された指示'],
          generation: undefined,
        },
      ];

      const nextSchema = applyChainDelta(schema, rows, true);
      const addedRel = nextSchema.analysis?.relations.find((r) => r.proposalId === 'tmp_rel1');

      expect(addedRel).toBeDefined();
      expect(addedRel?.id).toMatch(/^added_/);
      expect(addedRel?.kind).toBe('transfer');
      expect(addedRel?.sourceEventId).toBe('E2');
      expect(addedRel?.targetEventId).toBe('E3');
    });
  });
});
