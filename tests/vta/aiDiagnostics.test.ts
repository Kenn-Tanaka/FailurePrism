import { describe, it, expect } from 'vitest';
import {
  buildAIDiagnostics,
  formatAIDiagnosticsAsMarkdown,
  extractParagraphs,
  detectTriggerEntityIds,
  traceEntityLineage,
} from '../../src/tools/vta/services/diagnostics/aiDiagnostics';
import { createDebugRecorder, type DebugEntry } from '../../src/tools/vta/services/debugRecorder';

describe('VTA Structured AI Diagnostics (ADR-0009)', () => {
  const sampleScenario = `2024年1月2日 羽田空港C滑走路において航空機衝突事故が発生した。

P2: 当該海上保安庁機（A機）は支援物資輸送のためスポットを出発した。

P3: 管制官はA機に対して「タキシー・トゥ・ホールディング・ポイント・C5」を指示した。

P4: A機機長は滑走路進入許可を得たと誤認し、C5停止線を越えてC滑走路内に進入した。

P5: 進入継続中の日本航空機（B機）が滑走路34Rに着陸し、両機が衝突した。`;

  it('extracts paragraphs into a normalized lookup map', () => {
    const map = extractParagraphs(sampleScenario);
    expect(map.has('P2')).toBe(true);
    expect(map.has('p2')).toBe(true);
    expect(map.has('source_1/p2')).toBe(true);
    expect(map.get('P2')).toContain('当該海上保安庁機');
    expect(map.get('P4')).toContain('C5停止線を越えて');
  });

  it('detects trigger entity IDs from error messages and anomalies', () => {
    const errorMsg = '[抽出失敗] カード card_61 にイベントがありません。';
    const ids = detectTriggerEntityIds(errorMsg);
    expect(ids).toContain('card_61');

    const multiIds = detectTriggerEntityIds('関与 E6/A2 の参照が不正です (card_12)');
    expect(multiIds).toContain('E6');
    expect(multiIds).toContain('A2');
    expect(multiIds).toContain('card_12');
  });

  it('traces entity lineage across pipeline stages (card_61 orphan diagnosis)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-05T02:21:38.000Z',
        sessionId: 's1',
        stage: 'ledger.validation',
        data: {
          rows: [
            { id: 'card_61', raw: 'card_61\tR1\tE6\tA1\t09:15', events: ['E6'] },
          ],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-05T02:22:32.000Z',
        sessionId: 's1',
        stage: 'graph.projection',
        data: {
          cards: [{ id: 'card_61', laneEntityId: 'A1', eventIds: ['E6'] }],
          nodes: [{ id: 'E6' }],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-05T02:23:50.000Z',
        sessionId: 's1',
        stage: 'chain-repair.validation',
        data: {
          issues: [{ id: 'tmp_R1', raw: 'tmp_R1\tbefore\tE1\tE6', reason: '関与 E6/A1 の参照・役割が不正です。' }],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-05T02:24:01.000Z',
        sessionId: 's1',
        stage: 'operation',
        data: {
          type: 'error',
          message: '[抽出失敗] カード card_61 にイベントがありません。',
          stageTag: '解析',
        },
        truncated: false,
        originalChars: 100,
      },
    ];

    const lineage = traceEntityLineage('card_61', entries);
    expect(lineage.target_id).toBe('card_61');
    expect(lineage.type).toBe('VTACard');
    expect(lineage.lifecycle.length).toBeGreaterThanOrEqual(3);

    const states = lineage.lifecycle.map((s) => s.state);
    expect(states).toContain('CREATED');
    expect(states).toContain('VALIDATED');
    expect(states).toContain('ORPHANED_ERROR');
  });

  it('builds structured AI diagnostics package with pinpoint paragraph evidence', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-05T02:21:00.000Z',
        sessionId: 's1',
        stage: 'llm.request',
        data: {
          model: 'openrouter/google/gemini-3.8-flash',
          messages: [{ role: 'user', content: 'test request' }],
        },
        truncated: false,
        originalChars: 50,
      },
      {
        time: '2026-11-05T02:21:38.000Z',
        sessionId: 's1',
        stage: 'ledger.validation',
        data: {
          issues: [
            {
              id: 'X1',
              rule: 'PARAGRAPH_CITATION_MISMATCH',
              raw: 'X1\t主観\tsource_1/p3\t急激な逸脱\t操縦士',
              message: 'Phrase not found in paragraph',
            },
          ],
        },
        truncated: false,
        originalChars: 150,
      },
      {
        time: '2026-11-05T02:24:01.000Z',
        sessionId: 's1',
        stage: 'operation',
        data: {
          type: 'error',
          message: '[抽出失敗] カード card_61 にイベントがありません。',
          stageTag: '解析',
        },
        truncated: false,
        originalChars: 80,
      },
    ];

    const pkg = buildAIDiagnostics({
      entries,
      scenarioText: sampleScenario,
      lastError: '[抽出失敗] カード card_61 にイベントがありません。',
    });

    expect(pkg.meta.pipeline_status).toBe('FAILED');
    expect(pkg.meta.model).toBe('openrouter/google/gemini-3.8-flash');
    expect(pkg.failure?.trigger_entity_id).toBe('card_61');

    // Check pinpoint evidence
    expect(pkg.anomalies.length).toBe(1);
    expect(pkg.anomalies[0].evidence_paragraph?.id).toBe('source_1/p3');
    expect(pkg.anomalies[0].evidence_paragraph?.text).toContain('タキシー・トゥ・ホールディング・ポイント');

    // Format markdown
    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('# FailurePrism / VTA AI Diagnostics Package');
    expect(md).toContain('Prompt for AI Assistant');
    expect(md).toContain('card_61');
    expect(md).toContain('source_1/p3');
    expect(md).toContain('タキシー・トゥ・ホールディング・ポイント');

    // Check token budget (compact size)
    expect(md.length).toBeLessThan(10000); // Well under 2,500 tokens
  });

  it('optimizes raw debug log size via deduplication and sharedContext', () => {
    const recorder = createDebugRecorder();
    recorder.setEnabled(true);

    const longScenario = 'A'.repeat(5000);

    recorder.record('recording.start', () => ({
      projectId: 'proj_1',
      scenarioText: longScenario,
      schema: {},
    }));

    for (let i = 0; i < 5; i++) {
      recorder.record('llm.request', () => ({
        requestId: `req_${i}`,
        model: 'gemini-flash',
        messages: [
          { role: 'system', content: 'You are an incident analyzer.' },
          { role: 'user', content: `Please analyze this scenario: ${longScenario} and find step ${i}` },
        ],
      }));
    }

    const rawExport = recorder.exportText({ deduplicate: false });
    const deduplicatedExport = recorder.exportText({ deduplicate: true });

    const parsed = JSON.parse(deduplicatedExport);
    expect(parsed.sharedContext.scenario).toBe(longScenario);
    expect(parsed.aiDiagnostics).toBeDefined();

    const rawSize = rawExport.length;
    const dedupSize = deduplicatedExport.length;
    expect(dedupSize).toBeLessThan(rawSize * 0.5);
  });

  it('condenses real-world failure log to under 20KB markdown package if file exists', async () => {
    const fs = await import('fs');
    const path = 'C:/Users/kenta/Dropbox/2026年/ソフトウェア開発/log/FailurePrism-debug-2026-11-04T17-26-35-315Z.json';
    if (!fs.existsSync(path)) return;

    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    const start = data.entries.find((e: any) => e.stage === 'recording.start');
    const scenarioText = start?.data?.scenarioText;

    const pkg = buildAIDiagnostics({
      entries: data.entries,
      scenarioText,
      lastError: '[抽出失敗] カード card_61 にイベントがありません。',
    });

    const md = formatAIDiagnosticsAsMarkdown(pkg);

    // Verify key elements from the real failure
    expect(md).toContain('card_61');
    expect(md).toContain('Failure Point');
    expect(md).toContain('error_message');
    expect(md).toContain('ORPHANED_ERROR');

    // The raw JSON was 1,494,287 bytes (1.5 MB).
    // The markdown diagnostics package should be under 25,000 bytes (< 6,000 tokens)
    expect(md.length).toBeLessThan(25000);
    // Reduction should be > 98%
    const reduction = 1 - (md.length / 1494287);
    expect(reduction).toBeGreaterThan(0.98);
  });

  it('incorporates Subject Poset DAG hierarchy and transitivity lineage (ADR-0010)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-06T00:00:00.000Z',
        sessionId: 's_poset',
        stage: 'graph.projection',
        data: {
          cards: [{ id: 'card_1', laneEntityId: 'A2', eventIds: ['E1'] }],
          nodes: [{ id: 'E1' }],
          entities: [
            { id: 'A1', name: '機長', parentEntityIds: ['A2'], mergedFrom: [] },
            { id: 'A2', name: '海上保安庁機', parentEntityIds: ['A10'], mergedFrom: ['A1'] },
            { id: 'A10', name: '海上保安庁', parentEntityIds: [], mergedFrom: [] },
          ],
          subjectPoset: {
            nodes: ['A1', 'A2', 'A10'],
            relations: [
              { parentId: 'A2', childId: 'A1' },
              { parentId: 'A10', childId: 'A2' },
            ],
          },
        },
        truncated: false,
        originalChars: 200,
      },
      {
        time: '2026-11-06T00:01:00.000Z',
        sessionId: 's_poset',
        stage: 'chain-repair.validation',
        data: {
          issues: [
            {
              id: 'tmp_R1',
              raw: 'tmp_R1\tbefore\tE1\tA1\tE2\tA2\tsource_1/p1\t-\t-\tna\trecorded\tテスト遷移',
              reason: '関係の主体がイベントに関与していません。',
            },
          ],
        },
        truncated: false,
        originalChars: 200,
      },
    ];

    const lineageA1 = traceEntityLineage('A1', entries);
    expect(lineageA1.target_id).toBe('A1');
    expect(lineageA1.type).toBe('VTASubject');
    expect(lineageA1.parents).toEqual(['A2']);
    expect(lineageA1.poset_ancestors).toContain('A2');
    expect(lineageA1.poset_ancestors).toContain('A10');
    expect(lineageA1.resolved_to).toBe('A2 (海上保安庁機)');

    const lineageR1 = traceEntityLineage('tmp_R1', entries);
    expect(lineageR1.type).toBe('VTARelation');
    expect(lineageR1.lifecycle[0].note).toContain('Poset hint');

    const pkg = buildAIDiagnostics({
      entries,
      scenarioText: sampleScenario,
    });

    expect(pkg.subject_poset).toBeDefined();
    expect(pkg.subject_poset?.node_count).toBe(3);
    expect(pkg.subject_poset?.edge_count).toBe(2);
    expect(pkg.contract_rules?.subject_poset_transitivity).toBeDefined();

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('Subject Poset DAG Hierarchy (Canonical Inclusion)');
    expect(md).toContain('機長');
    expect(md).toContain('海上保安庁機');
    expect(md).toContain('parents: ["A2"]');
    expect(md).toContain('ancestors: ["A2", "A10"]');
    expect(md).toContain('merged_into: "A2"');
    expect(md).toContain('subject_poset_transitivity');
  });
});
