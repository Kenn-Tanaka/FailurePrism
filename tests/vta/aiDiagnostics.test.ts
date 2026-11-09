import { describe, it, expect } from 'vitest';
import {
  buildAIDiagnostics,
  formatAIDiagnosticsAsMarkdown,
  extractParagraphs,
  detectTriggerEntityIds,
  traceEntityLineage,
} from '../../src/tools/vta/services/diagnostics/aiDiagnostics';
import { createDebugRecorder, debugRecorder, type DebugEntry } from '../../src/tools/vta/services/debugRecorder';
import { sourceFromText, projectAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { parseLedger, inspectLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
import { applyChainDelta } from '../../src/tools/vta/features/vta/utils/chainRepair';

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

  it('does not attribute a transport failure (HTTP 504) to an entity from earlier repaired anomalies', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-08T11:00:00.000Z', sessionId: 's1', stage: 'ledger.validation',
        data: { issues: [{ id: 'E1', rule: 'x', raw: 'E1\t-:actor', message: '主体または役割が不正です。' }] },
        truncated: false, originalChars: 50,
      },
    ];
    const error = '[通信/エラー] HTTP 504 (10084ms): {"error":{"code":"upstream_timeout","type":"gateway_error"}}';
    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario, lastError: error });

    expect(pkg.meta.pipeline_status).toBe('FAILED');
    expect(pkg.failure?.trigger_entity_id).toBeUndefined();
    expect(pkg.entity_lineage).toHaveLength(0);
  });

  it('captures LEDGER_PARSE_ERROR anomaly and does not attribute parse error to an entity', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-08T11:39:55.000Z', sessionId: 's1', stage: 'ledger.parse_error',
        data: {
          error: '台帳 119行目のIDが不正です（セクション=帰結、先頭セル="identified"）。タブ区切りで出力してください。',
          rawText: Array.from({ length: 125 }, (_, i) => i === 118 ? 'identified\tE1\tp1\t機能喪失' : `row_${i + 1}`).join('\n'),
        },
        truncated: false, originalChars: 500,
      },
      {
        time: '2026-11-08T11:39:55.792Z', sessionId: 's1', stage: 'operation',
        data: {
          type: 'error',
          stageTag: '解析',
          message: '台帳 119行目のIDが不正です（セクション=帰結、先頭セル="identified"）。タブ区切りで出力してください。',
        },
        truncated: false, originalChars: 100,
      },
    ];
    const pkg = buildAIDiagnostics({
      entries,
      scenarioText: sampleScenario,
      lastError: '台帳 119行目のIDが不正です（セクション=帰結、先頭セル="identified"）。タブ区切りで出力してください。',
    });

    expect(pkg.meta.pipeline_status).toBe('FAILED');
    expect(pkg.failure?.trigger_entity_id).toBeUndefined();
    expect(pkg.anomalies.some((a) => a.issue_type === 'LEDGER_PARSE_ERROR')).toBe(true);
    const parseAnomaly = pkg.anomalies.find((a) => a.issue_type === 'LEDGER_PARSE_ERROR');
    expect(parseAnomaly?.raw_llm_output).toContain('119: identified');
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

  it('extracts real-world LedgerIssue structure, GenerationProvenance labels, and non-A\\d+ subject IDs', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-08T02:24:00.000Z',
        sessionId: 's_real',
        stage: 'ledger.validation',
        data: {
          rows: [
            { section: '主体', id: 'ORG_JCG_A', cells: ['ORG_JCG_A', '海上保安庁A機乗務員', 'organization', 'high', 'ORG_JCG', 'p2'], lineNumber: 2 },
            { section: 'イベント', id: 'E1', cells: ['E1', '17:45', 'C5誘導指示', '管制官がC5停止位置までの走行を指示', 'ORG_JCG_A:confirmed_recipient', 'p3', 'recorded'], lineNumber: 5 },
            { section: 'イベント', id: 'E2', cells: ['E2', '17:46', '滑走路進入', 'A機がC滑走路内に進入', 'ORG_JCG_A:actor', 'p4', 'recorded'], lineNumber: 6 },
            { section: '関係', id: 'R_dep1', cells: ['R_dep1', 'dependency', 'E1', 'ORG_JCG_A', 'E2', 'ORG_JCG_A', 'p3', 'information', '-', 'na'], lineNumber: 9 },
          ],
          issues: [
            {
              row: {
                section: '関係',
                id: 'R_dep1',
                cells: ['R_dep1', 'dependency', 'E1', 'ORG_JCG_A', 'E2', 'ORG_JCG_A', 'p3', 'information', '-', 'na'],
                lineNumber: 9,
              },
              message: '[dependency] リソース: 受信=information、許容=-',
              code: 'relation_attribute',
            },
          ],
        },
        truncated: false,
        originalChars: 300,
      },
      {
        time: '2026-11-08T02:24:30.000Z',
        sessionId: 's_real',
        stage: 'graph.projection',
        data: {
          generation: {
            runId: 'run-1234',
            schemeId: 'fulltext-ledger',
            schemeVersion: '1',
            ruleVersion: 'relation-attributes-2',
            model: 'openrouter/google/gemini-3.7-flash',
            promptFingerprint: 'abc',
            inputFingerprint: 'def',
          },
          cards: [{ id: 'card_1', laneEntityId: 'ORG_JCG_A', eventIds: ['E1'] }],
          nodes: [{ id: 'card_1' }],
          entities: [
            { id: 'ORG_JCG', name: '海上保安庁', kind: 'organization', parentEntityIds: [] },
            { id: 'ORG_JCG_A', name: '海上保安庁A機乗務員', kind: 'organization', parentEntityIds: ['ORG_JCG'] },
          ],
        },
        truncated: false,
        originalChars: 300,
      },
    ];

    const pkg = buildAIDiagnostics({
      entries,
      scenarioText: sampleScenario,
    });

    // 1. Real LedgerIssue structure extracted properly
    expect(pkg.anomalies).toHaveLength(1);
    expect(pkg.anomalies[0]).toMatchObject({
      id: 'anomaly_1',
      stage: 'ledger.validation',
      issue_type: 'relation_attribute',
      target_id: 'R_dep1',
      raw_llm_output: 'R_dep1\tdependency\tE1\tORG_JCG_A\tE2\tORG_JCG_A\tp3\tinformation\t-\tna',
      violation_detail: '[dependency] リソース: 受信=information、許容=-',
    });
    expect(pkg.anomalies[0].evidence_paragraph?.id).toBe('p3');
    expect(pkg.anomalies[0].evidence_paragraph?.text).toContain('タキシー・トゥ・ホールディング・ポイント');

    // 2. Pipeline transitions count only 'イベント' section rows (2 events, not 4 total rows)
    expect(pkg.pipeline_transitions[0]).toEqual({
      phase: 'ledger.validation',
      counts: { events: 2, issues: 1 },
    });

    // 3. GenerationProvenance formatted cleanly without [object Object]
    expect(pkg.pipeline_transitions[1].notes).toBe('generation: fulltext-ledger@1');
    expect(pkg.pipeline_transitions[1].notes).not.toContain('[object Object]');

    // 4. Non-A\d+ subject ID ('ORG_JCG_A') recognized as VTASubject with Poset ancestors
    const subjectLineage = traceEntityLineage('ORG_JCG_A', entries);
    expect(subjectLineage.type).toBe('VTASubject');
    expect(subjectLineage.parents).toEqual(['ORG_JCG']);
    expect(subjectLineage.poset_ancestors).toEqual(['ORG_JCG']);
    expect(subjectLineage.lifecycle[0].raw_snippet).toContain('海上保安庁A機乗務員');

    // 5. Trigger entity lineage automatically includes R_dep1 from LedgerIssue
    expect(pkg.entity_lineage.some((l) => l.target_id === 'R_dep1' && l.type === 'VTARelation')).toBe(true);
  });

  it('collapses consecutive identical pipeline transitions using run-length compression (xN)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-08T13:25:00.000Z',
        sessionId: 's_dedup',
        stage: 'graph.projection',
        data: {
          generation: { schemeId: 'refined-chain', schemeVersion: '1' },
          cards: [{ id: 'c1' }, { id: 'c2' }],
          nodes: [{ id: 'c1' }, { id: 'c2' }],
          edges: [{ id: 'e1' }],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-08T13:25:01.000Z',
        sessionId: 's_dedup',
        stage: 'graph.projection',
        data: {
          generation: { schemeId: 'refined-chain', schemeVersion: '1' },
          cards: [{ id: 'c1' }, { id: 'c2' }],
          nodes: [{ id: 'c1' }, { id: 'c2' }],
          edges: [{ id: 'e1' }],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-08T13:25:02.000Z',
        sessionId: 's_dedup',
        stage: 'graph.projection',
        data: {
          generation: { schemeId: 'refined-chain', schemeVersion: '1' },
          cards: [{ id: 'c1' }, { id: 'c2' }],
          nodes: [{ id: 'c1' }, { id: 'c2' }],
          edges: [{ id: 'e1' }],
        },
        truncated: false,
        originalChars: 100,
      },
      // Different projection (different edge count) should NOT collapse
      {
        time: '2026-11-08T13:25:03.000Z',
        sessionId: 's_dedup',
        stage: 'graph.projection',
        data: {
          generation: { schemeId: 'refined-chain', schemeVersion: '1' },
          cards: [{ id: 'c1' }, { id: 'c2' }],
          nodes: [{ id: 'c1' }, { id: 'c2' }],
          edges: [{ id: 'e1' }, { id: 'e2' }],
        },
        truncated: false,
        originalChars: 100,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    expect(pkg.pipeline_transitions).toHaveLength(2);
    expect(pkg.pipeline_transitions[0].notes).toBe('generation: refined-chain@1 (x3)');
    expect(pkg.pipeline_transitions[0].counts?.edges).toBe(1);
    expect(pkg.pipeline_transitions[1].notes).toBe('generation: refined-chain@1');
    expect(pkg.pipeline_transitions[1].counts?.edges).toBe(2);

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('notes: "generation: refined-chain@1 (x3)"');
  });

  it('captures Stage 1b, Stage 3, LLM communication metrics, and outcome in Execution Meta', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-08T13:00:00.000Z',
        sessionId: 's_full',
        stage: 'llm.request',
        data: { model: 'openrouter/google/gemini-3.6-flash' },
        truncated: false,
        originalChars: 50,
      },
      {
        time: '2026-11-08T13:00:03.000Z',
        sessionId: 's_full',
        stage: 'llm.response',
        data: { elapsedMs: 3150 },
        truncated: false,
        originalChars: 50,
      },
      {
        time: '2026-11-08T13:00:04.000Z',
        sessionId: 's_full',
        stage: 'llm.request',
        data: { model: 'openrouter/google/gemini-3.6-flash' },
        truncated: false,
        originalChars: 50,
      },
      {
        time: '2026-11-08T13:00:06.000Z',
        sessionId: 's_full',
        stage: 'llm.response',
        data: { elapsedMs: 1850 },
        truncated: false,
        originalChars: 50,
      },
      {
        time: '2026-11-08T13:00:07.000Z',
        sessionId: 's_full',
        stage: 'ledger.validation',
        data: {
          analysis: {
            outcome: {
              status: 'identified',
              kind: 'loss',
              eventIds: ['E58'],
            },
          },
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-08T13:00:08.000Z',
        sessionId: 's_full',
        stage: 'operation',
        data: { message: '[仮判定完了] 50/58件のイベントに仮判定を付与しました。' },
        truncated: false,
        originalChars: 50,
      },
      {
        time: '2026-11-08T13:00:10.000Z',
        sessionId: 's_full',
        stage: 'connection-proposal.validation',
        data: {
          proposals: [{ id: 'p1' }, { id: 'p2' }],
          reviews: [{ id: 'r1' }],
          invalidRows: ['inv1\tbad_format'],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-08T13:00:12.000Z',
        sessionId: 's_full',
        stage: 'chain-repair.validation',
        data: {
          rows: [{ id: 'row1' }],
          issues: [{ id: 'issue1', reason: '循環' }],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-08T13:00:15.000Z',
        sessionId: 's_full',
        stage: 'operation',
        data: { message: '[VTAツリー自動生成完了] イベント 58件、カード 81件をキャンバスに反映しました。' },
        truncated: false,
        originalChars: 50,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });

    expect(pkg.meta.llm_calls).toBe(2);
    expect(pkg.meta.total_llm_ms).toBe(5000);
    expect(pkg.meta.outcome).toEqual({
      status: 'identified',
      kind: 'loss',
      event_ids: ['E58'],
    });

    // Check transition phases
    const phases = pkg.pipeline_transitions.map((t) => t.phase);
    expect(phases).toContain('preliminary.classification');
    expect(phases).toContain('connection.proposal');
    expect(phases).toContain('chain.repair');
    expect(phases).toContain('pipeline.completed');

    // Check connection proposal invalid row anomaly
    expect(pkg.anomalies.some((a) => a.issue_type === 'CONNECTION_PROPOSAL_INVALID_ROW')).toBe(true);

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('llm_calls: 2');
    expect(md).toContain('total_llm_ms: 5000');
    expect(md).toContain('outcome:');
    expect(md).toContain('status: "identified"');
    expect(md).toContain('kind: "loss"');
    expect(md).toContain('event_ids: ["E58"]');
    expect(md).toContain('phase: "connection.proposal"');
    expect(md).toContain('phase: "chain.repair"');
  });

  it('prevents debug recorder pollution during chain repair candidate dry-run', () => {
    debugRecorder.setEnabled(true);
    debugRecorder.clear();

    const source = sourceFromText('P1: テストシナリオ本文');
    const baseAnalysis = inspectLedger(parseLedger('[主体]\nA1\t担当\tperson\t高\t-\tp1\n[イベント]\nE1\t09:00\t開始\t説明\tA1:actor\tp1\trecorded\n[関係]\n[完了]', { partial: true }), source).analysis!;
    const baseSchema = projectAnalysis(baseAnalysis);

    const initialRecordings = debugRecorder.getSnapshot().count;

    // 1. Dry run (permanent = false) - should NOT record graph.projection
    applyChainDelta(baseSchema, [{ section: '追加イベント', id: 'tmp_E2', cells: ['tmp_E2', '09:05', '追加', '説明', `${source.id}/p1`, 'recorded'] }], false);
    expect(debugRecorder.getSnapshot().count).toBe(initialRecordings);

    // 2. Permanent adoption (permanent = true) - SHOULD record graph.projection
    applyChainDelta(baseSchema, [{ section: '追加イベント', id: 'tmp_E2', cells: ['tmp_E2', '09:05', '追加', '説明', `${source.id}/p1`, 'recorded'] }], true);
    expect(debugRecorder.getSnapshot().count).toBeGreaterThan(initialRecordings);

    debugRecorder.setEnabled(false);
    debugRecorder.clear();
  });
});
