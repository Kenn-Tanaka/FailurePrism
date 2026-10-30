import { describe, it, expect } from 'vitest';
import {
  sanitizeNode,
  sanitizeEdge,
  validateAndSanitizeVTASchema,
  validateAndSanitizeProjectFile,
} from './schemaValidator';
import { createManualAnalysis } from './eventAnalysis';

const asV4Project = (project: any) => {
  const schema = validateAndSanitizeVTASchema(project.vtaData, true).data!;
  return { ...project, version: '5.0', vtaData: { ...schema, analysis: createManualAnalysis(schema) } };
};

describe('schemaValidator.ts - Runtime Schema Validation & Sanitization (DATA-002)', () => {
  describe('sanitizeNode', () => {
    it('should reject non-object node inputs', () => {
      const res = sanitizeNode(null, 0);
      expect(res.error).toBeDefined();
      expect(res.node).toBeUndefined();
    });

    it('should coerce numbers and non-string types safely for titles and notes', () => {
      const raw = {
        id: 'n1',
        lane: '現場作業員',
        time: 1234, // number instead of string
        title: 999, // number
        description: false, // boolean
        supplementary_note: 456, // number
        type: 'variation',
        measure_type: 'elimination',
        position: { x: 100, y: 200 },
      };

      const { node, error } = sanitizeNode(raw, 0);
      expect(error).toBeUndefined();
      expect(node).toBeDefined();
      expect(node?.time).toBe('1234');
      expect(node?.title).toBe('999');
      expect(node?.description).toBe('false');
      expect(node?.supplementary_note).toBe('456');
      expect(node?.type).toBe('variation');
      expect(node?.measure_type).toBe('elimination');
      expect(node?.position).toEqual({ x: 100, y: 200 });
    });

    it('should discard invalid non-finite positions', () => {
      const raw = {
        id: 'n2',
        lane: '現場作業員',
        position: { x: NaN, y: Infinity },
      };

      const { node } = sanitizeNode(raw, 1);
      expect(node?.position).toBeUndefined();
    });

    it('restores finite compact positions only for saved presentation data', () => {
      const raw = { id: 'n3', lane: 'A', compact_position: { x: -20, y: 35 } };
      expect(sanitizeNode(raw, 2, true).node?.compact_position).toEqual({ x: -20, y: 35 });
      expect(sanitizeNode(raw, 2, false).node?.compact_position).toBeUndefined();
      expect(sanitizeNode({ ...raw, compact_position: { x: '20', y: Infinity } }, 2, true).node?.compact_position).toBeUndefined();
      expect(sanitizeNode({ ...raw, compact_position: { x: '20', y: Infinity } }, 2, true).warning).toContain('座標が不正');
    });
  });

  describe('sanitizeEdge', () => {
    const validNodeIds = new Set(['n1', 'n2', 'n3']);

    it('should reject edges with empty source or target', () => {
      const res = sanitizeEdge({ source: '', target: 'n2' }, validNodeIds, 0);
      expect(res.error).toContain('空です');
    });

    it('should reject self-loop edges', () => {
      const res = sanitizeEdge({ source: 'n1', target: 'n1' }, validNodeIds, 0);
      expect(res.error).toContain('自己ループ');
    });

    it('should reject orphaned edges pointing to non-existent nodes', () => {
      const res = sanitizeEdge({ source: 'n1', target: 'ghost_node' }, validNodeIds, 0);
      expect(res.error).toContain('存在しないノード');
    });

    it('should sanitize valid edge data properly', () => {
      const res = sanitizeEdge({
        source: 'n1',
        target: 'n2',
        is_break: 1, // truthy
        direction: 'bidirectional',
      }, validNodeIds, 0);

      expect(res.error).toBeUndefined();
      expect(res.edge).toEqual({
        source: 'n1',
        target: 'n2',
        is_break: true,
        direction: 'bidirectional',
      });
    });
  });

  describe('validateAndSanitizeVTASchema', () => {
    it('should validate and parse a valid full schema', () => {
      const raw = {
        lanes: ['レーンA', 'レーンB'],
        nodes: [
          { id: 'n1', lane: 'レーンA', title: '作業1', time: '10:00' },
          { id: 'n2', lane: 'レーンB', title: '作業2', time: '10:05' },
        ],
        edges: [
          { source: 'n1', target: 'n2', direction: 'unidirectional' },
        ],
        supplementary_summary: '補足まとめ',
      };

      const result = validateAndSanitizeVTASchema(raw);
      expect(result.isValid).toBe(true);
      expect(result.data?.lanes).toEqual(['レーンA', 'レーンB']);
      expect(result.data?.nodes.length).toBe(2);
      expect(result.data?.edges.length).toBe(1);
      expect(result.data?.supplementary_summary).toBe('補足まとめ');
    });

    it('should automatically deduplicate IDs, edges, and include unlisted lanes', () => {
      const raw = {
        lanes: ['レーンA'],
        nodes: [
          { id: 'dup_id', lane: 'レーンA', title: 'ノード1' },
          { id: 'dup_id', lane: '未登録レーンX', title: 'ノード2' }, // duplicate id & unlisted lane
        ],
        edges: [
          { source: 'dup_id', target: 'dup_id_dup_1' },
          { source: 'dup_id', target: 'dup_id_dup_1' }, // duplicate edge
        ],
      };

      const result = validateAndSanitizeVTASchema(raw);
      expect(result.isValid).toBe(true);
      expect(result.data?.nodes.length).toBe(2);
      expect(result.data?.nodes[1].id).toBe('dup_id_dup_1');
      expect(result.data?.lanes).toContain('未登録レーンX');
      expect(result.data?.edges.length).toBe(1);
    });

    it('should return isValid = false if nodes array is missing or empty', () => {
      const res1 = validateAndSanitizeVTASchema({ nodes: [] });
      expect(res1.isValid).toBe(false);

      const res2 = validateAndSanitizeVTASchema({ edges: [] });
      expect(res2.isValid).toBe(false);
    });
  });

  describe('validateAndSanitizeProjectFile', () => {
    it('should successfully validate project file and retain report/scenario', () => {
      const raw = {
        version: '1.0',
        savedAt: '2026-10-10T12:00:00Z',
        scenarioText: 'シナリオ本文',
        vtaData: {
          lanes: ['A'],
          nodes: [{ id: 'n1', lane: 'A', title: 'T' }],
          edges: [],
        },
        regenerationResult: {
          idealFlow: '改善された業務フロー',
          analysisReport: '# 分析レポート',
          generatedAt: '2026-10-10T12:05:00Z',
        },
      };

      const result = validateAndSanitizeProjectFile(asV4Project(raw));
      expect(result.isValid).toBe(true);
      expect(result.data?.version).toBe('5.0');
      expect(result.data?.scenarioText).toBe('シナリオ本文');
      expect(result.data?.regenerationResult?.analysisReport).toBe('# 分析レポート');
    });

    it('should guarantee complete round-trip integrity of all fields (DATA-001)', () => {
      const originalProject = {
        version: '1.0',
        savedAt: '2026-10-10T15:30:00Z',
        scenarioText: '完全往復テストシナリオ',
        vtaData: {
          lanes: ['製造課', '品証課'],
          nodes: [
            {
              id: 'node_1',
              lane: '製造課',
              time: '09:00',
              title: '部品加工',
              description: 'NC旋盤による切削加工',
              type: 'variation' as const,
              measure_type: 'elimination' as const,
              supplementary_note: '寸法公差逸脱',
              sequence_order: 1,
              position: { x: 120, y: 340 },
            },
            {
              id: 'node_2',
              lane: '品証課',
              time: '09:30',
              title: '受入検査',
              description: '三次元測定機による測定',
              type: 'normal' as const,
              measure_type: null,
              sequence_order: 2,
              position: { x: 420, y: 150 },
            },
          ],
          edges: [
            {
              source: 'node_1',
              target: 'node_2',
              is_break: true,
              direction: 'bidirectional' as const,
              label: '検査依頼伝票',
            },
          ],
          supplementary_summary: '工程間検査の不備に関するまとめ',
          custom_notes: [
            {
              id: 'note_1',
              nodeId: 'node_1',
              title: '作業員ヒアリング',
              content: '工具の摩耗に気づいていたが交換を怠った',
            },
          ],
        },
        regenerationResult: {
          idealFlow: '### 改善された業務フロー\n三次元測定による自動フィードバック',
          analysisReport: '# 分析・対策レポート\n## 1. エグゼクティブ・サマリー',
          generatedAt: '2026-10-10T15:35:00Z',
          sourceHash: 'abc123hash',
        },
      };

      // Emulate JSON serialization / deserialization round-trip
      const serialized = JSON.stringify(asV4Project(originalProject));
      const deserialized = JSON.parse(serialized);

      const validation = validateAndSanitizeProjectFile(deserialized);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      const recovered = validation.data!;
      expect(recovered.version).toBe('5.0');
      expect(recovered.scenarioText).toBe(originalProject.scenarioText);

      // Verify node fields including sequence_order and position
      const n1 = recovered.vtaData.nodes.find((n) => n.id === 'node_1')!;
      expect(n1.sequence_order).toBe(1);
      expect(n1.position).toEqual({ x: 120, y: 340 });
      expect(n1.supplementary_note).toBe('寸法公差逸脱');
      expect(n1.measure_type).toBe('elimination');

      // Verify edge fields including label and direction
      const e1 = recovered.vtaData.edges[0];
      expect(e1.label).toBe('検査依頼伝票');
      expect(e1.direction).toBe('bidirectional');
      expect(e1.is_break).toBe(true);

      // Verify custom notes with nodeId
      expect(recovered.vtaData.custom_notes).toHaveLength(1);
      expect(recovered.vtaData.custom_notes![0].nodeId).toBe('node_1');
      expect(recovered.vtaData.custom_notes![0].content).toContain('工具の摩耗');

      // Verify regenerationResult including sourceHash
      expect(recovered.regenerationResult?.sourceHash).toBe('abc123hash');
      expect(recovered.regenerationResult?.idealFlow).toContain('三次元測定');
    });

    it('should safely handle empty project schemas', () => {
      const emptyProject = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        scenarioText: '',
        vtaData: {
          lanes: [],
          nodes: [],
          edges: [],
        },
      };

      const result = validateAndSanitizeProjectFile(asV4Project(emptyProject));
      expect(result.isValid).toBe(true);
      expect(result.data?.vtaData.nodes).toHaveLength(0);
      expect(result.data?.scenarioText).toBe('');
    });

    it('should validate, sanitize and preserve subjectRanking, mergedFrom, and entity origins', () => {
      const projectWithRanking = {
        version: '5.0',
        savedAt: new Date().toISOString(),
        scenarioText: 'p1 報告者が作業し、現場リーダーへ連絡した。',
        vtaData: {
          lanes: ['報告者（私）', 'その他の関係者'],
          nodes: [
            { id: 'card_1', lane: '報告者（私）', title: '作業', event_ids: ['e1'] },
            { id: 'card_2', lane: 'その他の関係者', title: '受領', event_ids: ['e2'] },
          ],
          edges: [],
          analysis: {
            version: 5,
            sources: [{ id: 's1', text: 'p1 報告者が作業し、現場リーダーへ連絡した。', paragraphs: [{ id: 'p1', text: 'p1 報告者が作業し、現場リーダーへ連絡した。' }] }],
            facts: [],
            events: [
              { id: 'e1', title: '作業', description: '作業した', time: '09:00', sourceOrder: 0, factIds: [], sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }], classification: 'normal' },
              { id: 'e2', title: '受領', description: '受領した', time: '09:10', sourceOrder: 1, factIds: [], sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }], classification: 'normal' },
            ],
            entities: [
              { id: 'A1', name: '報告者（私）', kind: 'person', focus: 'reporter', focusSourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }] },
              { id: 'subject_others', name: 'その他の関係者', kind: 'other', aggregate: true },
            ],
            participations: [
              { eventId: 'e1', entityId: 'A1', role: 'actor', factIds: [] },
              {
                eventId: 'e2',
                entityId: 'subject_others',
                role: 'confirmed_recipient',
                factIds: [],
                mergedFrom: [
                  { entityId: 'A2', role: 'confirmed_recipient' },
                  { entityId: 'unknown_ghost_entity', role: 'affected' }, // should be discarded during sanitization
                ],
              },
            ],
            relations: [
              {
                kind: 'transfer',
                sourceEventId: 'e1',
                targetEventId: 'e2',
                sourceEntityId: 'A1',
                targetEntityId: 'subject_others',
                sourceEntityOrigin: 'A1',
                targetEntityOrigin: 'A2',
                resource: 'information',
                status: 'occurred',
                receipt: 'confirmed',
                sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
                factIds: [],
              },
            ],
            cards: [
              { id: 'card_1', laneEntityId: 'A1', eventIds: ['e1'] },
              { id: 'card_2', laneEntityId: 'subject_others', eventIds: ['e2'] },
            ],
            unassignedEventIds: [],
            subjectRanking: {
              version: 1,
              maxSubjects: 2,
              weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
              warning: 'テスト用注意文',
              originalEntities: [
                { id: 'A1', name: '報告者（私）', kind: 'person', focus: 'reporter', focusSourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }] },
                { id: 'A2', name: '現場リーダー', kind: 'person', focus: 'high' },
              ],
              ranks: [
                { entityId: 'A1', rank: 1, score: 0.95, breakdown: { A: 1, O: 1, F: 1, C: 0.5, T: 1 }, priority: 'reporter', retained: true, reason: '優先保持' },
                { entityId: 'A2', rank: 2, score: 0.55, breakdown: { A: 0.5, O: 0.5, F: 0.5, C: 1, T: 0.5 }, retained: false, mergedInto: 'subject_others', reason: '統合' },
                { entityId: 'ghost', rank: 3, score: 0, breakdown: { A: 0, O: 0, F: 0, C: 0, T: 0 }, retained: false, reason: '破棄されるべき不正行' },
              ],
            },
          },
        },
      };

      const result = validateAndSanitizeProjectFile(projectWithRanking);
      expect(result.isValid).toBe(true);
      const analysis = result.data?.vtaData.analysis;
      expect(analysis).toBeDefined();
      expect(analysis?.subjectRanking?.maxSubjects).toBe(2);
      expect(analysis?.subjectRanking?.warning).toBe('テスト用注意文');
      expect(analysis?.subjectRanking?.originalEntities).toHaveLength(2);
      expect(analysis?.subjectRanking?.ranks).toHaveLength(2); // ghost rank discarded

      const p2 = analysis?.participations.find((p) => p.eventId === 'e2')!;
      expect(p2.mergedFrom).toEqual([{ entityId: 'A2', role: 'confirmed_recipient' }]); // unknown_ghost_entity discarded

      const rel = analysis?.relations[0]!;
      expect(rel.sourceEntityOrigin).toBe('A1');
      expect(rel.targetEntityOrigin).toBe('A2');
    });
  });
});
