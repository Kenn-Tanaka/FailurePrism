import { describe, it, expect } from 'vitest';
import {
  sanitizeNode,
  sanitizeEdge,
  validateAndSanitizeVTASchema,
  validateAndSanitizeProjectFile,
} from './schemaValidator';

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

      const result = validateAndSanitizeProjectFile(raw);
      expect(result.isValid).toBe(true);
      expect(result.data?.version).toBe('1.0');
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
      const serialized = JSON.stringify(originalProject);
      const deserialized = JSON.parse(serialized);

      const validation = validateAndSanitizeProjectFile(deserialized);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      const recovered = validation.data!;
      expect(recovered.version).toBe(originalProject.version);
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

      const result = validateAndSanitizeProjectFile(emptyProject);
      expect(result.isValid).toBe(true);
      expect(result.data?.vtaData.nodes).toHaveLength(0);
      expect(result.data?.scenarioText).toBe('');
    });
  });
});
