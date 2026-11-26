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
    const pathMod = await import('path');
    const logPath = pathMod.resolve(process.cwd(), '..', 'log', 'FailurePrism-debug-2026-11-04T17-26-35-315Z.json');
    if (!fs.existsSync(logPath)) return;

    const data = JSON.parse(fs.readFileSync(logPath, 'utf8'));
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

  it('merges graph.projection poset/entities with prior ledger.validation outcome without dropping outcome metadata', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-09T07:00:00.000Z',
        sessionId: 's_outcome',
        stage: 'ledger.validation',
        data: {
          analysis: {
            outcome: { status: 'identified', kind: 'loss', eventIds: ['E20'] },
            entities: [{ id: 'A', name: '作業員', parentEntityIds: ['TEAM'] }],
          },
        },
        truncated: false,
        originalChars: 100,
      },
      // Terminal graph.projection only has subjectPoset, cards, edges, not analysis object
      {
        time: '2026-11-09T07:05:00.000Z',
        sessionId: 's_outcome',
        stage: 'graph.projection',
        data: {
          cards: [{ id: 'card_1', laneEntityId: 'TEAM', eventIds: ['E20'] }],
          nodes: [{ id: 'card_1' }],
          entities: [{ id: 'A', name: '作業員', parentEntityIds: ['TEAM'], mergedFrom: [] }],
          subjectPoset: { nodes: ['A', 'TEAM'], relations: [{ childId: 'A', parentId: 'TEAM' }], aliases: {} },
        },
        truncated: false,
        originalChars: 100,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: 'P1: 本文1\n\nP2: 本文2' });
    expect(pkg.meta.outcome).toEqual({
      status: 'identified',
      kind: 'loss',
      event_ids: ['E20'],
    });
    expect(pkg.subject_poset?.node_count).toBe(2);
  });

  it('extracts multi-paragraph evidence snippets and tracks repaired entity state as MUTATED', () => {
    const multiLineScenario = Array.from({ length: 70 }, (_, i) => `段落${i + 1}の本文内容`).join('\n');
    const entries: DebugEntry[] = [
      {
        time: '2026-11-09T07:10:00.000Z',
        sessionId: 's_multi',
        stage: 'ledger.validation',
        data: {
          rows: [
            { id: 'R21', section: '関係', cells: ['R21', 'impact', 'E20', '-', 'E22', 'OP', 'p60,p65', 'other', 'occurred', 'confirmed'] },
          ],
          issues: [
            {
              id: 'R21',
              raw: 'R21\timpact\tE20\t-\tE22\tOP\tp60,p65\tother\toccurred\tconfirmed',
              message: '[impact] 元主体: 受信=-、許容=イベントに割当済みの主体ID',
            },
          ],
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-09T07:10:05.000Z',
        sessionId: 's_multi',
        stage: 'ledger.validation',
        data: {
          rows: [
            { id: 'R21', section: '整理', cells: ['R21', 'review', 'p60,p65', '触車要旨', '特定不能'] },
          ],
        },
        truncated: false,
        originalChars: 100,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: multiLineScenario });
    expect(pkg.anomalies[0].evidence_paragraph).toBeDefined();
    expect(pkg.anomalies[0].evidence_paragraph?.id).toBe('p60, p65');
    expect(pkg.anomalies[0].evidence_paragraph?.text).toContain('[p60] 段落60の本文内容');
    expect(pkg.anomalies[0].evidence_paragraph?.text).toContain('[p65] 段落65の本文内容');

    const lineageR21 = pkg.entity_lineage.find((l) => l.target_id === 'R21');
    expect(lineageR21).toBeDefined();
    expect(lineageR21?.lifecycle).toHaveLength(2);
    expect(lineageR21?.lifecycle[0].state).toBe('CREATED');
    expect(lineageR21?.lifecycle[0].note).toContain('[関係]');
    expect(lineageR21?.lifecycle[1].state).toBe('MUTATED');
    expect(lineageR21?.lifecycle[1].note).toContain('[整理]');
  });

  it('classifies operation repair warnings as MUTATED (not ORPHANED_ERROR), skips info logs, and lists all cards for shared events', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-18T06:04:00.000Z',
        sessionId: 's_op',
        stage: 'operation',
        data: {
          type: 'warn',
          message: '[台帳修復] 関係/R5: [transfer] 先主体: 受信=ORG_A_CREW、許容=E25に割当済みの主体ID',
        },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-18T06:04:05.000Z',
        sessionId: 's_op',
        stage: 'operation',
        data: {
          type: 'info',
          message: '[帰結/確認待ち] E25 関連の確認情報',
        },
        truncated: false,
        originalChars: 50,
      },
      {
        time: '2026-11-18T06:05:00.000Z',
        sessionId: 's_op',
        stage: 'graph.projection',
        data: {
          cards: [
            { id: 'card_15', laneEntityId: 'ORG_A_CREW', eventIds: ['E25'] },
            { id: 'card_21', laneEntityId: 'A1', eventIds: ['E25'] },
          ],
          nodes: [{ id: 'card_15' }, { id: 'card_21' }],
        },
        truncated: false,
        originalChars: 100,
      },
    ];

    const lineage = traceEntityLineage('E25', entries);
    expect(lineage.type).toBe('VTAEvent');
    expect(lineage.lifecycle).toHaveLength(2);
    expect(lineage.lifecycle[0].step).toBe('operation');
    expect(lineage.lifecycle[0].state).toBe('MUTATED');
    expect(lineage.lifecycle[0].note).toMatch(/^\[参照関与\] \[台帳修復\] 関係\/R5:/);
    const directR5 = traceEntityLineage('R5', entries);
    expect(directR5.lifecycle[0].step).toBe('operation');
    expect(directR5.lifecycle[0].state).toBe('MUTATED');
    expect(directR5.lifecycle[0].note).toBe('[台帳修復] 関係/R5: [transfer] 先主体: 受信=ORG_A_CREW、許容=E25に割当済みの主体ID');
    expect(lineage.lifecycle[1].step).toBe('graph.projection');
    expect(lineage.lifecycle[1].note).toContain("'card_15' on lane 'ORG_A_CREW'");
    expect(lineage.lifecycle[1].note).toContain("'card_21' on lane 'A1'");
  });

  it('distinguishes eventsCount from nodes in graph.projection, expands full SubjectPoset hierarchy via subjectRanking, and surfaces refinement/proposal/chain-repair breakdowns', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-18T06:35:00.000Z',
        sessionId: 's_diag_fix',
        stage: 'graph.projection',
        data: {
          generation: { schemeId: 'refined-chain', schemeVersion: '1' },
          cards: Array.from({ length: 68 }, (_, idx) => ({ id: `c_${idx}` })),
          nodes: Array.from({ length: 68 }, (_, idx) => ({ id: `c_${idx}` })),
          visibleNodeCount: 62,
          eventsCount: 48,
          edges: Array.from({ length: 85 }, (_, idx) => ({ id: `e_${idx}` })),
          entities: [
            { id: 'A_CREW', name: 'Ａ機乗組員', kind: 'organization', mergedFrom: ['A_CO'] },
            { id: 'A_CAPT', name: '機長Ａ', kind: 'person', parentEntityId: 'A_CREW', parentEntityIds: ['A_CREW'] },
          ],
          subjectPoset: {
            nodes: ['JCG', 'A_CREW', 'A_CAPT', 'A_CO'],
            aliases: {},
            relations: [
              { childId: 'A_CREW', parentId: 'JCG' },
              { childId: 'A_CAPT', parentId: 'A_CREW' },
              { childId: 'A_CO', parentId: 'A_CREW' },
            ],
          },
          subjectRanking: {
            version: 1,
            maxSubjects: 5,
            weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
            originalEntities: [
              { id: 'JCG', name: '海上保安庁', kind: 'organization' },
              { id: 'A_CREW', name: 'Ａ機乗組員', kind: 'organization', parentEntityId: 'JCG', parentEntityIds: ['JCG'] },
              { id: 'A_CAPT', name: '機長Ａ', kind: 'person', parentEntityId: 'A_CREW', parentEntityIds: ['A_CREW'] },
              { id: 'A_CO', name: '副操縦員Ａ', kind: 'person', parentEntityId: 'A_CREW', parentEntityIds: ['A_CREW'] },
            ],
            ranks: [
              { entityId: 'A_CREW', rank: 1, score: 0.9, breakdown: { A: 1, O: 1, F: 1, C: 1, T: 1 }, retained: true, isInfluential: true, reason: '' },
              { entityId: 'A_CAPT', rank: 2, score: 0.85, breakdown: { A: 0.9, O: 1, F: 0.8, C: 0.7, T: 0.8 }, retained: true, isInfluential: true, reason: '' },
              { entityId: 'A_CO', rank: 3, score: 0.5, breakdown: { A: 0.5, O: 0.5, F: 0.5, C: 0.5, T: 0.5 }, retained: false, mergedInto: 'A_CREW', isInfluential: true, reason: '' },
              { entityId: 'JCG', rank: 4, score: 0.4, breakdown: { A: 0.3, O: 0.5, F: 0.5, C: 0.3, T: 0.4 }, retained: false, mergedInto: 'A_CREW', isInfluential: true, reason: '' },
            ],
          },
        },
        truncated: false,
        originalChars: 200,
      },
      {
        time: '2026-11-18T06:35:05.000Z',
        sessionId: 's_diag_fix',
        stage: 'operation',
        data: { type: 'info', message: '[粒度反復 #0] 初期スコア S=0.488 (C1=0.67, C3=0.51, C5=0.16)' },
        truncated: false,
        originalChars: 80,
      },
      {
        time: '2026-11-18T06:35:10.000Z',
        sessionId: 's_diag_fix',
        stage: 'operation',
        data: {
          type: 'info',
          message: '[粒度反復 #1] スコア S=0.659 (C1=0.67, C2=0.90, C3=0.65, C4=0.95, C5=0.16 | 前回基準=0.650) 適用操作=5件 採用=はい',
        },
        truncated: false,
        originalChars: 120,
      },
      {
        time: '2026-11-18T06:35:20.000Z',
        sessionId: 's_diag_fix',
        stage: 'connection-proposal.validation',
        data: { proposals: Array.from({ length: 25 }, (_, idx) => ({ id: `P${idx}` })), reviews: [{ id: 'Q1' }, { id: 'Q2' }], invalidRows: [] },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-18T06:35:21.000Z',
        sessionId: 's_diag_fix',
        stage: 'connection-proposal.adoption',
        data: { totalProposals: 25, omittedFilteredCount: 0, adoptedCount: 3, addCount: 3, refineCount: 0, rejectedCount: 22 },
        truncated: false,
        originalChars: 100,
      },
      {
        time: '2026-11-18T06:35:30.000Z',
        sessionId: 's_diag_fix',
        stage: 'chain-repair.validation',
        data: {
          rows: [
            { section: '関係追加', id: 'tmp_R1', cells: ['tmp_R1', 'before', 'E1', '-', 'E2', '-'] },
            { section: '関係追加', id: 'tmp_R2', cells: ['tmp_R2', 'transfer', 'E2', 'A_CREW', 'E3', 'A_CAPT'] },
            { section: '要確認', id: 'tmp_Q1', cells: ['tmp_Q1', 'E4', 'p1', 'check', '要確認'] },
          ],
          issues: [],
        },
        truncated: false,
        originalChars: 120,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });

    // 1. graph.projection preserves real events (48) separate from nodes (68) and visible_nodes (62)
    expect(pkg.pipeline_transitions[0].counts).toEqual({
      events: 48,
      cards: 68,
      nodes: 68,
      visible_nodes: 62,
      edges: 85,
    });

    // 2. SubjectPoset expands all 4 original entities including JCG & A_CO with merged_into & original parents
    expect(pkg.subject_poset?.hierarchies).toHaveLength(4);
    expect(pkg.subject_poset?.hierarchies.find((h) => h.id === 'JCG')).toBeDefined();
    expect(pkg.subject_poset?.hierarchies.find((h) => h.id === 'A_CO')?.merged_into).toBe('A_CREW');
    expect(pkg.subject_poset?.hierarchies.find((h) => h.id === 'A_CREW')?.parents).toEqual(['JCG']);

    // 3. granularity.refinement #0 has adopted: true, and #1 captures C1..C5
    expect(pkg.pipeline_transitions[1].score?.adopted).toBe(true);
    expect(pkg.pipeline_transitions[2].score).toMatchObject({
      S: 0.659,
      C1: 0.67,
      C2: 0.9,
      C3: 0.65,
      C4: 0.95,
      C5: 0.16,
      adopted: true,
    });

    // 4. connection.proposal shows adoption vs rejected breakdown, and chain.repair shows section breakdown
    expect(pkg.pipeline_transitions[3].notes).toContain('採用 3件');
    expect(pkg.pipeline_transitions[3].notes).toContain('制約除外 22件');
    expect(pkg.pipeline_transitions[4].notes).toContain('意味関係=1, before=1, 要確認=1');
  });

  it('surfaces backward/skip/missing wiring & layout anomalies, deduplicates repeated graph.projection lineage steps, and reports SubjectPoset catalog_count', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-18T07:20:00.000Z',
        sessionId: 's_wire',
        stage: 'ledger.validation',
        data: {
          rows: [
            { id: 'E48', section: 'イベント', raw: 'E48\t17:48\t確認\t客室乗務員確認\tA_BCC:actor\tp1\trecorded' },
          ],
        },
        truncated: false,
        originalChars: 100,
      },
      // Repeated identical graph.projection states for E48 (should compress to 1 VALIDATED step)
      ...Array.from({ length: 4 }, (_, idx) => ({
        time: `2026-11-18T07:21:0${idx}.000Z`,
        sessionId: 's_wire',
        stage: 'graph.projection',
        data: {
          cards: [
            { id: 'c1', laneEntityId: 'A_BCC', eventIds: ['E48'] },
            { id: 'c2', laneEntityId: 'A_BCC', eventIds: ['E49'] },
            { id: 'c3', laneEntityId: 'A_BCC', eventIds: ['E50'] },
          ],
          nodes: [
            { id: 'c1', lane: '客室乗務員', sequence_order: 0, title: 'N1', description: '', time: '', type: 'normal', measure_type: null },
            { id: 'c2', lane: '客室乗務員', sequence_order: 1, title: 'N2', description: '', time: '', type: 'normal', measure_type: null },
            { id: 'c3', lane: '客室乗務員', sequence_order: 2, title: 'N3', description: '', time: '', type: 'normal', measure_type: null },
          ],
          edges: [
            { source: 'c3', target: 'c1', direction: 'sequential' }, // backward AND skips c2!
          ],
          missingRelations: [{ id: 'R99', sourceEventId: 'E48', targetEventId: 'E50', sourceEntityId: 'A_BCC', targetEntityId: 'A_BCC' }],
          entities: [
            { id: 'A_BCC', name: '客室乗務員', kind: 'organization' },
            { id: 'subject_others', name: 'その他の関係者', kind: 'other', aggregate: true },
          ],
          subjectPoset: { nodes: ['A_BCC'], relations: [], aliases: {} },
        },
        truncated: false,
        originalChars: 150,
      })),
      {
        time: '2026-11-18T07:22:00.000Z',
        sessionId: 's_wire',
        stage: 'layout.audit',
        data: {
          backwardIntraLaneEdges: [{ id: 'e_back', lane: '客室乗務員', source: 'c3', target: 'c1', sourceY: 100, targetY: 500 }],
          detouredIntraLaneEdges: [{ id: 'e_back', lane: '客室乗務員', source: 'c3', target: 'c1', pointsCount: 6, isSemantic: false }],
          nonAdjacentIntraLaneEdges: [{ id: 'e_back', lane: '客室乗務員', source: 'c3', target: 'c1', visualSpan: 2, isSemantic: false }],
          overlappingIntraLanePairs: [],
        },
        truncated: false,
        originalChars: 100,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const issueTypes = pkg.anomalies.map((a) => a.issue_type);
    expect(issueTypes).toContain('MISSING_RELATION_PROJECTION');
    expect(issueTypes).toContain('BACKWARD_INTRA_LANE_EDGE');
    expect(issueTypes).toContain('INTRA_LANE_SKIP_SEQUENTIAL');
    expect(issueTypes).toContain('LAYOUT_DETOURED_SEQUENTIAL_EDGE');

    expect(pkg.subject_poset?.node_count).toBe(1);
    expect(pkg.subject_poset?.catalog_count).toBe(2);

    const lineageE48 = traceEntityLineage('E48', entries);
    const projSteps = lineageE48.lifecycle.filter((s) => s.step === 'graph.projection');
    expect(projSteps).toHaveLength(1);

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('catalog_count: 2');
    expect(md).toContain('phase: "layout.audit"');
  });

  it('matches exact row IDs in traceEntityLineage instead of unrelated descriptions (e.g. R3 vs E41 R3 door) and surfaces cross-lane layout audit issues', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-18T08:22:00.000Z',
      sessionId: 's_diag',
      stage,
      data,
      truncated: false,
      originalChars: 100,
    });
    const entries: DebugEntry[] = [
      mkEntry('ledger.validation', {
        rows: [
          {
            id: 'E41',
            section: 'イベント',
            cells: ['E41', '17:48', 'ドア確認', 'L2、R2、L3、R3、R4担当が不可と判断した', 'A_BCC:actor', 'p1', 'recorded'],
            raw: 'E41\t17:48\tドア確認\tL2、R2、L3、R3、R4担当が不可と判断した\tA_BCC:actor\tp1\trecorded',
          },
          {
            id: 'R3',
            section: '関係',
            cells: ['R3', 'dependency', 'E5', 'A_CREW', 'E6', 'A_CREW', 'p2', '-', '-', 'na'],
            raw: 'R3\tdependency\tE5\tA_CREW\tE6\tA_CREW\tp2\t-\t-\tna',
          },
          {
            id: 'R17',
            section: '関係',
            cells: ['R17', 'before', 'E1', '-', 'E2', '-', 'p3', '-', '-', 'na'],
            raw: 'R17\tbefore\tE1\t-\tE2\t-\tp3\t-\t-\tna',
          },
        ],
        issues: [{ id: 'R3', rule: 'relation_attribute', message: '[dependency] 依存端点: R3' }],
      }),
      mkEntry('operation', {
        type: 'warn',
        message: '[台帳修復] 関係/R17: [dependency] 依存端点エラー',
      }),
      mkEntry('layout.audit', {
        backwardIntraLaneEdges: [],
        detouredIntraLaneEdges: [],
        nonAdjacentIntraLaneEdges: [],
        overlappingIntraLanePairs: [],
        closeParallelHorizontalEdges: [{ edgeA: 'edge_1', edgeB: 'edge_2', relationA: 'R3', sourceA: 'c1', sourceB: 'c2', gapPx: 2.5 }],
        closeParallelVerticalEdges: [{ edgeA: 'edge_1', edgeB: 'edge_3', relationA: 'R3', sourceA: 'c1', sourceB: 'c3', gapPx: 1.4 }],
        overlappingEdgeBadges: [{ edgeA: 'edge_1', edgeB: 'edge_2', relationA: 'R3', sourceA: 'c1', sourceB: 'c2', overlapAreaPx: 420 }],
      }),
    ];

    const lineageR3 = traceEntityLineage('R3', entries);
    expect(lineageR3.type).toBe('VTARelation');
    const r3Ledger = lineageR3.lifecycle.filter((s) => s.step === 'ledger.validation');
    expect(r3Ledger).toHaveLength(1);
    expect(r3Ledger[0].raw_snippet).toContain('R3\tdependency');
    expect(r3Ledger[0].raw_snippet).not.toContain('E41');

    // Token boundary check: querying 'R1' must not match 'R17'
    const lineageR1 = traceEntityLineage('R1', entries);
    expect(lineageR1.lifecycle).toHaveLength(0);

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const issueTypes = pkg.anomalies.map((a) => a.issue_type);
    expect(issueTypes).toContain('LAYOUT_CLOSE_HORIZONTAL_EDGES');
    expect(issueTypes).toContain('LAYOUT_CLOSE_VERTICAL_EDGES');
    expect(issueTypes).toContain('LAYOUT_OVERLAPPING_EDGE_BADGES');
    const auditTransition = pkg.pipeline_transitions.find((t) => t.phase === 'layout.audit');
    expect(auditTransition?.counts?.issues).toBe(3);
    expect(auditTransition?.notes).toContain('平行水平近接=1, 平行垂直近接=1, バッジ重複=1');
  });

  it('surfaces non-cancelled llm.failure timeout context in pipeline_transitions and failure.source_hint', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-18T09:52:40.000Z',
      sessionId: 's_timeout',
      stage,
      data,
      truncated: false,
      originalChars: 100,
    });
    const entries: DebugEntry[] = [
      mkEntry('llm.failure', { attempt: 1, elapsedMs: 180005, timedOut: true, userCancelled: false, error: 'Abort timeout' }),
      mkEntry('operation', {
        type: 'error',
        stageTag: '通信',
        message: '[タイムアウト] 設定されたタイムアウト時間（180秒）を超過しました。',
      }),
    ];
    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    expect(pkg.meta.pipeline_status).toBe('FAILED');
    expect(pkg.failure?.source_hint).toContain('timedOut after 180005ms');
    const llmFail = pkg.pipeline_transitions.find((t) => t.phase === 'llm.failure');
    expect(llmFail?.notes).toContain('TIMEOUT');
    expect(llmFail?.notes).toContain('180005ms');
  });

  it('surfaces preliminary.classification breakdown counts and flags unexpected outcome variation preliminary', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-19T07:45:51.000Z',
      sessionId: 's_prelim',
      stage,
      data,
      truncated: false,
      originalChars: 100,
    });
    const entries: DebugEntry[] = [
      mkEntry('operation', { type: 'info', stageTag: '解析', message: '[仮判定パス] 対象イベント 26件（帰結 2件除外）を 1チャンクで事前評価します。' }),
      mkEntry('operation', { type: 'info', stageTag: '解析', message: '[仮判定完了] 26/26件の対象イベントに仮判定を付与しました（変動=8, 通常=16, 保留=2, 帰結除外=2）。' }),
      mkEntry('preliminary.classification', {
        eligibleCount: 26,
        preliminaryCount: 26,
        outcomeExcludedCount: 2,
        breakdown: { variation: 8, normal: 16, undetermined: 2 },
        outcomeWithPreliminary: [{ id: 'E25', value: 'variation' }],
      }),
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const prelimTransition = pkg.pipeline_transitions.filter((t) => t.phase === 'preliminary.classification').slice(-1)[0];
    expect(prelimTransition?.counts).toEqual({
      events: 26,
      variation: 8,
      normal: 16,
      undetermined: 2,
      outcome_excluded: 2,
      issues: 1,
    });
    expect(pkg.anomalies.some((a) => a.issue_type === 'OUTCOME_PRELIMINARY_VARIATION' && a.target_id === 'E25')).toBe(true);
  });

  it('surfaces LAYOUT_BACKWARD_CROSS_LANE_EDGE and クロスレーン逆行 count in layout.audit', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-19T08:27:55.000Z',
      sessionId: 's_cross_bw',
      stage,
      data,
      truncated: false,
      originalChars: 100,
    });
    const entries: DebugEntry[] = [
      mkEntry('layout.audit', {
        backwardIntraLaneEdges: [],
        backwardCrossLaneEdges: [
          {
            id: 'relation:R99',
            relationId: 'R99',
            sourceLane: 'A_G',
            targetLane: 'A_B',
            source: 'card_1',
            target: 'card_2',
            sourceCenterY: 120,
            targetCenterY: 260,
            dropPx: 140,
          },
        ],
        detouredIntraLaneEdges: [],
        nonAdjacentIntraLaneEdges: [],
        overlappingIntraLanePairs: [],
        closeParallelHorizontalEdges: [],
        closeParallelVerticalEdges: [],
        overlappingEdgeBadges: [],
      }),
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const layoutTransition = pkg.pipeline_transitions.find((t) => t.phase === 'layout.audit');
    expect(layoutTransition?.counts?.issues).toBe(1);
    expect(layoutTransition?.notes).toContain('クロスレーン逆行=1');
    expect(pkg.anomalies.some((a) => a.issue_type === 'LAYOUT_BACKWARD_CROSS_LANE_EDGE' && a.target_id === 'R99')).toBe(true);
  });

  it('includes finishReason, contentLength, reasoningLength, and contentTail in llm.failure transition notes', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-19T10:40:49.000Z',
      sessionId: 's_llm_fail',
      stage,
      data,
      truncated: false,
      originalChars: 200,
    });
    const entries: DebugEntry[] = [
      mkEntry('llm.failure', {
        attempt: 0,
        elapsedMs: 413266,
        timedOut: false,
        userCancelled: false,
        status: 200,
        finishReason: 'length',
        contentLength: 120,
        reasoningLength: 48000,
        contentTail: '[イベント]\nE1\t17:47\t衝突',
        error: 'LLMの出力上限に達しました。途中の結果は採用しません。出力上限の大きいモデルを選択してください。',
      }),
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const failTransition = pkg.pipeline_transitions.find((t) => t.phase === 'llm.failure');
    expect(failTransition?.notes).toContain('finish=length');
    expect(failTransition?.notes).toContain('content=120字');
    expect(failTransition?.notes).toContain('reasoning=48000字');
    expect(failTransition?.notes).toContain('tail="[イベント] E1 17:47 衝突"');
  });

  it('includes per-event outcome_kinds in outcome meta and markdown format (ADR-0054)', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-19T11:24:44.000Z',
      sessionId: 's_outcome',
      stage,
      data,
      truncated: false,
      originalChars: 200,
    });
    const entries: DebugEntry[] = [
      mkEntry('ledger.validation', {
        analysis: {
          schemaVersion: 1,
          events: [
            { id: 'E34', outcome_kind: 'loss' },
            { id: 'E35', outcome_kind: 'loss' },
            { id: 'E50', outcome_kind: 'recovery' },
          ],
          outcome: {
            status: 'identified',
            kind: 'loss',
            eventIds: ['E34', 'E35', 'E50'],
            reason: '衝突損失と脱出回復',
          },
        },
      }),
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    expect(pkg.meta.outcome).toBeDefined();
    expect(pkg.meta.outcome?.status).toBe('identified');
    expect(pkg.meta.outcome?.kind).toBe('loss');
    expect(pkg.meta.outcome?.event_ids).toEqual(['E34', 'E35', 'E50']);
    expect(pkg.meta.outcome?.event_kinds).toEqual(['E34:loss', 'E35:loss', 'E50:recovery']);

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('kind: "loss"');
    expect(md).toContain('event_ids: ["E34", "E35", "E50"]');
    expect(md).toContain('event_kinds: ["E34:loss", "E35:loss", "E50:recovery"]');
  });

  it('includes geometry context and relation raw output for LAYWARD backward cross-lane edge anomalies (ADR-0056)', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-20T00:00:00.000Z',
      sessionId: 's_cross_lane',
      stage,
      data,
      truncated: false,
      originalChars: 200,
    });
    const entries: DebugEntry[] = [
      mkEntry('ledger.validation', {
        analysis: {
          schemaVersion: 1,
          events: [
            { id: 'E4', time: '17:47' },
            { id: 'E12', time: '17:47:30' },
          ],
          relations: [
            {
              id: 'R3',
              kind: 'transfer',
              sourceEventId: 'E4',
              sourceEntityId: 'S1',
              targetEventId: 'E12',
              targetEntityId: 'S3',
              resource: '指示伝達',
              status: 'occurred',
              receipt: 'confirmed',
              sourceRefs: ['p1'],
            },
          ],
        },
      }),
      mkEntry('layout.audit', {
        backwardCrossLaneEdges: [
          {
            id: 'edge_R3',
            relationId: 'R3',
            sourceLane: '海上保安庁',
            targetLane: '機長Ａ',
            source: 'card_8',
            target: 'card_34',
            sourceCenterY: 13847.5,
            targetCenterY: 14798.5,
            dropPx: 951,
            sourceHeight: 64,
            targetHeight: 64,
            sourceMeasuredHeight: 72,
            targetMeasuredHeight: 72,
            sourceIsDot: false,
            targetIsDot: false,
            sourceTitle: 'A機出発',
            targetTitle: 'C5進入',
            sourceEventId: 'E4',
            targetEventId: 'E12',
          },
        ],
      }),
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const anomaly = pkg.anomalies.find((a) => a.issue_type === 'LAYOUT_BACKWARD_CROSS_LANE_EDGE');
    expect(anomaly).toBeDefined();
    expect(anomaly?.target_id).toBe('R3');
    expect(anomaly?.raw_llm_output).toBe('R3\ttransfer\tE4\tS1\tE12\tS3\tp1\t指示伝達\toccurred\tconfirmed');
    expect(anomaly?.geometry).toBeDefined();
    expect(anomaly?.geometry?.drop_px).toBe(951);
    expect((anomaly?.geometry?.source as Record<string, unknown>).id).toBe('card_8');
    expect((anomaly?.geometry?.source as Record<string, unknown>).measured_height).toBe(72);

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('issue_type: "LAYOUT_BACKWARD_CROSS_LANE_EDGE"');
    expect(md).toContain('target_id: "R3"');
    expect(md).toContain('drop_px: 951');
    expect(md).toContain('source:');
    expect(md).toContain('measured_height: 72');
  });

  it('keeps pipeline_status as SUCCESS when pipeline completed despite earlier recovered operation errors (ADR-0056)', () => {
    const mkEntry = (stage: string, data: unknown): DebugEntry => ({
      time: '2026-11-20T00:00:00.000Z',
      sessionId: 's_success_retry',
      stage,
      data,
      truncated: false,
      originalChars: 200,
    });
    const entries: DebugEntry[] = [
      mkEntry('operation', {
        type: 'error',
        stageTag: '通信',
        message: '[通信/エラー] HTTP 504 (10252ms): Gateway timeout',
      }),
      mkEntry('operation', {
        type: 'info',
        stageTag: '解析',
        message: 'VTAツリー自動生成完了: 34ノード 35エッジ',
      }),
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    expect(pkg.meta.pipeline_status).toBe('SUCCESS');
    expect(pkg.failure).toBeUndefined();
  });

  it('extracts rel_ref_* / proposal:* / added_* trigger IDs prioritizing primary target_ids and traces relation projection lineage (ADR-0062)', () => {
    const anomalies = [
      {
        id: 'anomaly_1',
        stage: 'layout.audit',
        issue_type: 'LAYOUT_CLOSE_VERTICAL_EDGES',
        target_id: 'R20',
        violation_detail: '平行垂直線の離隔不足 (0px): relation:R20 と relation:rel_ref_M2 (および proposal:p_1, added_rel_2)',
      },
      {
        id: 'anomaly_2',
        stage: 'graph.projection',
        issue_type: 'MISSING_RELATION_PROJECTION',
        target_id: 'R25',
        violation_detail: '関係 R25 が投影エッジに存在しません。',
      },
    ];

    const triggerIds = detectTriggerEntityIds(undefined, anomalies);
    // Primary target_ids (R20, R25) come first, followed by secondary relation IDs in violation_detail
    expect(triggerIds.slice(0, 2)).toEqual(['R20', 'R25']);
    expect(triggerIds).toContain('rel_ref_M2');
    expect(triggerIds).toContain('proposal:p_1');
    expect(triggerIds).toContain('added_rel_2');

    const entries: DebugEntry[] = [
      {
        time: '2026-11-20T12:30:00.000Z',
        sessionId: 's_rel',
        stage: 'graph.projection',
        data: {
          relations: [
            {
              id: 'rel_ref_M2',
              kind: 'transfer',
              sourceEventId: 'E30',
              targetEventId: 'E33',
              sourceEntityId: 'A_CREW_A',
              targetEntityId: 'A_CREW_A',
              sourceEntityOrigin: 'A_CAPT_A',
              targetEntityOrigin: 'A_COPILOT_A',
            },
          ],
          edges: [{ id: 'relation:rel_ref_M2', relationId: 'rel_ref_M2', source: 'card_30', target: 'card_33' }],
        },
        truncated: false,
        originalChars: 200,
      },
      // Consecutive identical projection should be deduplicated by pushProjectionStep
      {
        time: '2026-11-20T12:31:00.000Z',
        sessionId: 's_rel',
        stage: 'graph.projection',
        data: {
          relations: [
            {
              id: 'rel_ref_M2',
              kind: 'transfer',
              sourceEventId: 'E30',
              targetEventId: 'E33',
              sourceEntityId: 'A_CREW_A',
              targetEntityId: 'A_CREW_A',
              sourceEntityOrigin: 'A_CAPT_A',
              targetEntityOrigin: 'A_COPILOT_A',
            },
          ],
          edges: [{ id: 'relation:rel_ref_M2', relationId: 'rel_ref_M2', source: 'card_30', target: 'card_33' }],
        },
        truncated: false,
        originalChars: 200,
      },
    ];

    const lineage = traceEntityLineage('rel_ref_M2', entries);
    expect(lineage.type).toBe('VTARelation');
    expect(lineage.lifecycle).toHaveLength(1);
    expect(lineage.lifecycle[0].note).toContain('A_CREW_A (origin: A_CAPT_A) -> E33/A_CREW_A (origin: A_COPILOT_A)');
    expect(lineage.lifecycle[0].note).toContain('edge(card_30 -> card_33)');
  });

  it('marks ledger.validation anomalies as [REPAIRED] when a subsequent ledger.validation entry succeeds with 0 issues', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-21T00:00:00.000Z',
        sessionId: 's_repaired',
        stage: 'ledger.validation',
        data: {
          runId: 'run-1',
          attempt: 0,
          issues: [
            {
              id: 'R1',
              code: 'relation_attribute',
              raw: 'R1\tdependency\tE2\tA_JCG\tE3\tA_JCG\tp24,p26\t-\t-\tna',
              message: '[dependency] 依存端点: 受信=E2/A_JCG → E3/A_JCG、許容=別イベント・別主体',
            },
          ],
        },
        truncated: false,
        originalChars: 150,
      },
      {
        time: '2026-11-21T00:00:05.000Z',
        sessionId: 's_repaired',
        stage: 'ledger.validation',
        data: {
          runId: 'run-1',
          attempt: 1,
          issues: [],
        },
        truncated: false,
        originalChars: 50,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    expect(pkg.anomalies).toHaveLength(1);
    expect(pkg.anomalies[0].violation_detail).toMatch(/^\[REPAIRED\] /);
  });

  it('marks excluded subjects in Section 4 Subject Poset hierarchy while keeping retained/merged entries clean (ADR-0065)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-21T00:00:00.000Z',
        sessionId: 's_excluded',
        stage: 'graph.projection',
        data: {
          entities: [
            { id: 'A_CREW', name: '作業班', kind: 'organization', mergedFrom: ['A_LEADER'] },
          ],
          subjectPoset: {
            nodes: ['A_CORP', 'A_CREW', 'A_LEADER'],
            relations: [{ childId: 'A_LEADER', parentId: 'A_CREW' }],
          },
          subjectRanking: {
            version: 1,
            maxSubjects: 5,
            weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
            originalEntities: [
              { id: 'A_CORP', name: '東武鉄道株式会社', kind: 'organization' },
              { id: 'A_CREW', name: '作業班', kind: 'organization' },
              { id: 'A_LEADER', name: '作業指揮者', kind: 'person', parentEntityId: 'A_CREW' },
            ],
            ranks: [
              { entityId: 'A_CREW', rank: 1, score: 0.9, breakdown: { A: 1, O: 1, F: 1, C: 1, T: 1 }, retained: true, reason: '上位保持' },
              { entityId: 'A_LEADER', rank: 2, score: 0.5, breakdown: { A: 0.5, O: 0.5, F: 0.5, C: 0.5, T: 0.5 }, retained: false, mergedInto: 'A_CREW', reason: '統合' },
              { entityId: 'A_CORP', rank: 3, score: 0.1, breakdown: { A: 0, O: 0, F: 0.5, C: 0, T: 0 }, retained: false, excluded: true, reason: '定常背景除外' },
            ],
          },
        },
        truncated: false,
        originalChars: 300,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const corp = pkg.subject_poset?.hierarchies.find((h) => h.id === 'A_CORP');
    const crew = pkg.subject_poset?.hierarchies.find((h) => h.id === 'A_CREW');
    const leader = pkg.subject_poset?.hierarchies.find((h) => h.id === 'A_LEADER');
    expect(corp?.excluded).toBe(true);
    expect(crew?.excluded).toBeUndefined();
    expect(leader?.excluded).toBeUndefined();
    expect(leader?.merged_into).toBe('A_CREW');

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('  - id: "A_CORP"');
    expect(md).toContain('    excluded: true');
  });

  it('prioritizes unrepaired anomaly IDs over [REPAIRED] anomalies in detectTriggerEntityIds', () => {
    const anomalies = [
      {
        id: 'anomaly_1',
        stage: 'ledger.validation',
        issue_type: 'relation_attribute',
        target_id: 'R15',
        violation_detail: '[REPAIRED] [dependency] 依存端点: R15 / E31',
      },
      {
        id: 'anomaly_2',
        stage: 'ledger.validation',
        issue_type: 'relation_attribute',
        target_id: 'R27',
        violation_detail: '[REPAIRED] [dependency] 依存端点: R27 / E55',
      },
      {
        id: 'anomaly_3',
        stage: 'ledger.validation',
        issue_type: 'relation_attribute',
        target_id: 'R29',
        violation_detail: '[REPAIRED] [dependency] 依存端点: R29 / E60',
      },
      {
        id: 'anomaly_4',
        stage: 'layout.audit',
        issue_type: 'LAYOUT_CLOSE_VERTICAL_EDGES',
        target_id: 'card_21',
        violation_detail: '平行垂直線の離隔不足 (0px): shared:E29:card_21:card_84 と relation:R11',
      },
    ];

    const triggerIds = detectTriggerEntityIds(undefined, anomalies);
    expect(triggerIds.slice(0, 4)).toEqual(['card_21', 'E29', 'card_84', 'R11']);
  });

  it('does not emit redundant MUTATED steps when an entity ledger row is unchanged across validation passes', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-21T00:00:00.000Z',
        sessionId: 's_unchanged',
        stage: 'ledger.validation',
        data: {
          rows: [
            {
              id: 'E31',
              section: 'イベント',
              raw: 'E31\t17:45\t復唱\t副操縦員Aが復唱した\tA_COP_A:actor\tp55\trecorded',
            },
          ],
        },
        truncated: false,
        originalChars: 120,
      },
      {
        time: '2026-11-21T00:00:05.000Z',
        sessionId: 's_unchanged',
        stage: 'ledger.validation',
        data: {
          rows: [
            {
              id: 'E31',
              section: 'イベント',
              raw: 'E31\t17:45\t復唱\t副操縦員Aが復唱した\tA_COP_A:actor\tp55\trecorded',
            },
          ],
        },
        truncated: false,
        originalChars: 120,
      },
    ];

    const lineage = traceEntityLineage('E31', entries);
    expect(lineage.lifecycle).toHaveLength(1);
    expect(lineage.lifecycle[0].state).toBe('CREATED');
  });

  it('attaches structured geometry context for close vertical/horizontal edge anomalies and formats without drop_px', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-21T00:00:00.000Z',
        sessionId: 's_close_geom',
        stage: 'layout.audit',
        data: {
          backwardIntraLaneEdges: [],
          detouredIntraLaneEdges: [],
          nonAdjacentIntraLaneEdges: [],
          overlappingIntraLanePairs: [],
          closeParallelHorizontalEdges: [],
          closeParallelVerticalEdges: [
            {
              edgeA: 'shared:E29:card_21:card_84',
              edgeB: 'relation:R11',
              relationB: 'R11',
              sourceA: 'card_21',
              targetA: 'card_84',
              sourceB: 'card_18',
              targetB: 'card_84',
              sourceLaneA: '海上保安庁',
              targetLaneA: '東京空港事務所・管制機関',
              sourceIsDotA: false,
              targetIsDotA: true,
              gapPx: 0,
              coordA: 350,
              coordB: 350,
              overlapMin: 120,
              overlapMax: 440,
            },
          ],
          overlappingEdgeBadges: [],
        },
        truncated: false,
        originalChars: 200,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const cvAnomaly = pkg.anomalies.find((a) => a.issue_type === 'LAYOUT_CLOSE_VERTICAL_EDGES');
    expect(cvAnomaly?.geometry?.axis).toBe('x');
    expect(cvAnomaly?.geometry?.coord_a).toBe(350);
    expect(cvAnomaly?.geometry?.overlap_span).toBe('[120, 440]');

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('axis: "x"');
    expect(md).toContain('coord_a: 350');
    expect(md).toContain('overlap_span: "[120, 440]"');
    expect(md).toContain('target_is_dot: true');
    expect(md).not.toContain('drop_px: undefined');
  });

  it('defaults meta.outcome.kind to "loss" when status is identified without explicit kind suffix (ADR-0068)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-21T16:30:22.000Z',
        sessionId: 's_out_default',
        stage: 'graph.projection',
        data: {
          analysis: {
            version: 5,
            sources: [],
            facts: [],
            entities: [],
            events: [
              { id: 'E22', title: '触車', description: '触車発生', time: '10:46', sourceOrder: 0, factIds: [], classification: 'outcome', origin: 'extraction' },
              { id: 'E24', title: '死亡確認', description: '4名死亡', time: '11:00', sourceOrder: 1, factIds: [], classification: 'outcome', origin: 'extraction' },
            ],
            participations: [],
            relations: [],
            cards: [],
            unassignedEventIds: [],
            outcome: {
              status: 'identified',
              eventIds: ['E22', 'E24'],
              sourceRefs: [],
              reason: '作業員4名死亡',
            },
          },
          cards: [],
          nodes: [],
          edges: [],
        },
        truncated: false,
        originalChars: 100,
      },
    ];
    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    expect(pkg.meta.outcome?.status).toBe('identified');
    expect(pkg.meta.outcome?.kind).toBe('loss');
    expect(pkg.meta.outcome?.event_ids).toEqual(['E22', 'E24']);
  });

  it('surfaces chain-repair.triage skip/run reasons and connection-proposal reviewsSavedCount in Pipeline State Transitions (ADR-0069)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-22T00:00:01.000Z',
        sessionId: 's_triage',
        stage: 'connection-proposal.validation',
        data: { proposals: [{ id: 'P1' }], reviews: [{ id: 'Q1' }], invalidRows: [] },
        truncated: false,
        originalChars: 80,
      },
      {
        time: '2026-11-22T00:00:02.000Z',
        sessionId: 's_triage',
        stage: 'connection-proposal.adoption',
        data: {
          totalProposals: 1,
          adoptedCount: 1,
          addCount: 0,
          refineCount: 1,
          rejectedCount: 0,
          reviewsSavedCount: 1,
        },
        truncated: false,
        originalChars: 80,
      },
      {
        time: '2026-11-22T00:00:03.000Z',
        sessionId: 's_triage',
        stage: 'chain-repair.triage',
        data: {
          skipped: true,
          outcomeIdentified: true,
          canonicalComponents: 1,
          unassignedCount: 0,
          missingRelationsCount: 0,
        },
        truncated: false,
        originalChars: 80,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const cp = pkg.pipeline_transitions.find((t) => t.phase === 'connection.proposal');
    expect(cp?.notes).toContain('要確認保存 1件');
    const cr = pkg.pipeline_transitions.find((t) => t.phase === 'chain.repair');
    expect(cr?.notes).toBe('連鎖補完点検: スキップ（完全連結・未割当0・未投影関係0）');
  });

  it('includes non-zero subject/event/assignment row counts in chain-repair breakdown notes (ADR-0070)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-22T01:00:01.000Z',
        sessionId: 's_cr_breakdown',
        stage: 'chain-repair.triage',
        data: {
          skipped: false,
          outcomeIdentified: true,
          canonicalComponents: 1,
          unassignedCount: 1,
          missingRelationsCount: 0,
        },
        truncated: false,
        originalChars: 80,
      },
      {
        time: '2026-11-22T01:00:02.000Z',
        sessionId: 's_cr_breakdown',
        stage: 'chain-repair.validation',
        data: {
          rows: [
            { section: '割当追加', id: 'assign_1', cells: ['assign_1', 'E10', 'S_CREW', 'actor', 'source_1/p3', 'inferred'] },
            { section: '関係追加', id: 'tmp_r1', cells: ['tmp_r1', 'impact'] },
            { section: '関係追加', id: 'tmp_r2', cells: ['tmp_r2', 'before'] },
          ],
          issues: [],
        },
        truncated: false,
        originalChars: 120,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const cr = pkg.pipeline_transitions.find((t) => t.phase === 'chain.repair');
    expect(cr?.notes).toBe(
      '連鎖補完トリアージ: 実行（成分=1, 未割当=1, 未投影関係=0） / 差分候補 3行（割当=1, 意味関係=1, before=1, 要確認=0）、指摘 0件'
    );
  });

  it('marks retry-recovered llm.failure transitions with issues: 0 and [RECOVERED_RETRY] while keeping unrecovered failures at issues: 1 (ADR-0071)', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-22T02:00:01.000Z',
        sessionId: 's_retry',
        stage: 'llm.failure',
        data: {
          requestId: 'req_1',
          attempt: 1,
          willRetry: true,
          status: 502,
          error: 'Bad Gateway',
        },
        truncated: false,
        originalChars: 80,
      },
      {
        time: '2026-11-22T02:00:05.000Z',
        sessionId: 's_retry',
        stage: 'llm.response',
        data: {
          requestId: 'req_1',
          latencyMs: 3200,
        },
        truncated: false,
        originalChars: 80,
      },
      {
        time: '2026-11-22T02:00:10.000Z',
        sessionId: 's_retry',
        stage: 'llm.failure',
        data: {
          requestId: 'req_2',
          attempt: 2,
          willRetry: false,
          status: 504,
          error: 'Gateway Timeout',
        },
        truncated: false,
        originalChars: 80,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const failures = pkg.pipeline_transitions.filter((t) => t.phase === 'llm.failure');
    expect(failures).toHaveLength(2);
    expect(failures[0].counts?.issues).toBe(0);
    expect(failures[0].notes).toContain('[RECOVERED_RETRY]');
    expect(failures[1].counts?.issues).toBe(1);
    expect(failures[1].notes).not.toContain('[RECOVERED_RETRY]');
  });

  it('exports AI Diagnostics v2 from Always-On Tier 1 Flight Recorder when enabled is false, isolates latest_run, and audits outcome_details, silent_exclusions, consolidation_stage, and deep active_events_ledger (ADR-0074)', () => {
    const recorder = createDebugRecorder();
    expect(recorder.getSnapshot().enabled).toBe(false);

    const scenario = [
      'P1: 17:45 機長Aが滑走路へ進入した。',
      '',
      'P2: 17:47 A機とB機が衝突・炎上した。',
      '',
      'P3: 18:10 A機の副操縦士および乗組員4名の死亡が確認された。',
      '',
      'P4: 翌日 事故調査委員会が現地調査を実施した。',
    ].join('\n');

    // Earlier run (run_old): must be excluded by scope: 'latest_run'
    recorder.startRun('extract_full');
    recorder.record('llm.request', () => ({
      requestId: 'req_old',
      model: 'old-model',
      messages: [{ role: 'user', content: scenario }],
    }));
    recorder.endRun();

    // Latest run: recorded purely via Tier 1 Flight Recorder (enabled === false!)
    const latestRunId = recorder.startRun('extract_full');
    recorder.record(
      'llm.request',
      () => ({
        requestId: 'req_new',
        model: 'openrouter/google/gemini-3.8-flash',
        messages: [{ role: 'user', content: `${scenario} secret-key-999` }],
      }),
      undefined,
      ['secret-key-999']
    );
    recorder.record('llm.response', () => ({
      requestId: 'req_new',
      elapsedMs: 1250,
      content: 'very large raw response text that is stripped in Tier 1',
    }));
    recorder.recordEvent('granularity.iteration', () => ({
      index: 0,
      score: 0.812,
      c1: 1.0,
      c3: 0.78,
      c5: 0.89,
      preMaxSubjects: 8,
      postMaxSubjects: 6,
      laneCount: 3,
      adopted: true,
      appliedOps: [],
      note: '[粒度反復 #0] 初期スコア S=0.812',
    }));
    recorder.recordEvent('scope.post_outcome_excluded', () => ({
      excludedNodesCount: 1,
      excludedEventsCount: 1,
      droppedEvents: [
        {
          id: 'E4',
          time: '-',
          title: '現地調査実施',
          participants: ['JTSB:actor'],
          refs: ['source_1/p4'],
          dropRule: 'sourceOrder>maxOutcomeOrder',
        },
      ],
    }));
    recorder.record('graph.projection', () => ({
      generation: 'refined-chain@1',
      eventsCount: 2,
      visibleNodeCount: 2,
      cards: [
        { id: 'card_1', laneEntityId: 'A_PIC', eventIds: ['E1'] },
        { id: 'card_2', laneEntityId: 'A_PIC', eventIds: ['E2'] },
      ],
      nodes: [{ id: 'card_1' }, { id: 'card_2' }],
      edges: [{ id: 'e1', source: 'card_1', target: 'card_2', kind: 'impact' }],
      entities: [
        { id: 'ORG_JCG', name: '海上保安庁', kind: 'organization', focus: 'mid' },
        { id: 'A_PIC', name: '機長A', kind: 'person', focus: 'high', parentEntityIds: ['ORG_JCG'] },
      ],
      subjectPoset: {
        nodes: ['ORG_JCG', 'A_PIC', 'JCG_COMM'],
        relations: [
          { parentId: 'ORG_JCG', childId: 'A_PIC' },
          { parentId: 'ORG_JCG', childId: 'JCG_COMM' },
        ],
      },
      subjectRanking: {
        version: 1,
        maxSubjects: 6,
        weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
        originalEntities: [
          { id: 'ORG_JCG', name: '海上保安庁', kind: 'organization', focus: 'mid' },
          { id: 'A_PIC', name: '機長A', kind: 'person', focus: 'high', parentEntityIds: ['ORG_JCG'] },
          { id: 'JCG_COMM', name: '羽田通信', kind: 'organization', focus: 'low', parentEntityIds: ['ORG_JCG'] },
        ],
        ranks: [
          {
            entityId: 'ORG_JCG',
            rank: 1,
            score: 0.55,
            breakdown: { A: 0.2, O: 0, F: 0.5, C: 0.2, T: 0.2 },
            retained: true,
            reason: '主要組織',
          },
          {
            entityId: 'A_PIC',
            rank: 2,
            score: 0.92,
            breakdown: { A: 0.9, O: 1, F: 1, C: 0.8, T: 0.5 },
            retained: true,
            mergeBlockedReason: '帰結非対称',
            reason: '主要当事者',
          },
          {
            entityId: 'JCG_COMM',
            rank: 3,
            score: 0.18,
            breakdown: { A: 0.1, O: 0, F: 0.1, C: 0.1, T: 0.1 },
            retained: false,
            mergedInto: 'ORG_JCG',
            consolidationStage: 'stage2.5_b1_poset',
            reason: 'Poset包摂',
          },
        ],
      },
      analysis: {
        version: 5,
        sources: [],
        entities: [
          { id: 'ORG_JCG', name: '海上保安庁', kind: 'organization', focus: 'mid' },
          { id: 'A_PIC', name: '機長A', kind: 'person', focus: 'high', parentEntityIds: ['ORG_JCG'] },
        ],
        events: [
          {
            id: 'E1',
            time: '17:45',
            title: '滑走路進入',
            description: '機長Aが滑走路へ進入した',
            sourceOrder: 1,
            classification: 'variation',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            origin: 'extraction',
          },
          {
            id: 'E2',
            time: '17:47',
            title: '衝突・炎上',
            description: 'A機とB機が衝突・炎上した',
            sourceOrder: 2,
            classification: 'outcome',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
            origin: 'extraction',
            outcome_kind: 'loss',
          },
          {
            id: 'E4',
            time: '-',
            title: '現地調査実施',
            description: '事故調査委員会が現地調査を実施した',
            sourceOrder: 4,
            classification: 'unclassified',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p4' }],
            origin: 'extraction',
            ignored: true,
            ignoreReason: 'post_outcome',
            ignoreRule: 'sourceOrder>maxOutcomeOrder',
          },
        ],
        participations: [
          { eventId: 'E1', entityId: 'A_PIC', role: 'actor' },
          { eventId: 'E2', entityId: 'A_PIC', role: 'affected' },
        ],
        relations: [],
        cards: [],
        unassignedEventIds: [],
        dispositions: [
          {
            id: 'D1',
            kind: 'excluded',
            text: '運航背景の補足記述',
            reason: '直接因果外',
            sourceId: 'source_1',
            paragraphId: 'p1',
            quote: '',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          },
        ],
        outcome: {
          status: 'identified',
          kind: 'loss',
          eventIds: ['E2'],
          reason: '衝突炎上',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
        },
      },
    }));
    recorder.endRun();

    // Tier 2 full buffer is empty, Tier 1 flight buffer holds structured entries without raw prompt/response text
    expect(recorder.getEntries()).toHaveLength(0);
    expect(recorder.getFlightEntries().length).toBeGreaterThan(0);
    const flightJson = JSON.stringify(recorder.getFlightEntries());
    expect(flightJson).not.toContain('very large raw response text');
    expect(flightJson).not.toContain('secret-key-999');

    // Standard profile export scoped to latest_run
    const stdMd = recorder.exportAIDiagnostics(scenario, undefined, {
      profile: 'standard',
      scope: 'latest_run',
    });
    expect(stdMd).toContain(`run_id: "${latestRunId}"`);
    expect(stdMd).toContain('model: "openrouter/google/gemini-3.8-flash"');
    expect(stdMd).not.toContain('old-model');
    expect(stdMd).toContain('llm_calls: 1');
    expect(stdMd).toContain('outcome_details:');
    expect(stdMd).toContain('consolidation_stage: "stage2.5_b1_poset"');
    expect(stdMd).toContain('merge_guard: "帰結非対称"');
    expect(stdMd).toContain('Silent Exclusions & Unreferenced Paragraph Audit');
    expect(stdMd).toContain('post_outcome_dropped:');
    // Paragraph P3 contains "死亡" and was never referenced -> flagged_with_hazard_terms alerts immediately!
    expect(stdMd).toContain('flagged_with_hazard_terms:');
    expect(stdMd).toContain('"死亡"');
    expect(stdMd).not.toContain('Active Events Ledger');

    // Deep profile adds Active Events Ledger
    const deepMd = recorder.exportAIDiagnostics(scenario, undefined, {
      profile: 'deep',
      scope: 'latest_run',
    });
    expect(deepMd).toContain('profile: "deep"');
    expect(deepMd).toContain('Active Events Ledger (2 events)');
    expect(deepMd).toContain('title: "滑走路進入"');
  });

  it('surfaces remaining unassigned_events in Silent Exclusions and ignores ## 1. 題目 title paragraph in flagged_with_hazard_terms (ADR-0075)', () => {
    const scenarioWithTitle = [
      '## 1. 題目',
      '',
      '東武鉄道日光線 新鹿沼駅構内における触車事故（作業員4名死亡）',
      '',
      '## 2. 経緯',
      '',
      '10:42 中継見張員配置を確認しなかった。',
      '',
      '10:46 列車と作業員が触車し4名が死亡した。',
    ].join('\n');

    const entries: DebugEntry[] = [
      {
        time: '2026-11-23T08:00:00.000Z',
        sessionId: 's_title',
        stage: 'graph.projection',
        data: {
          generation: 'refined-chain@1',
          eventsCount: 2,
          visibleNodeCount: 1,
          cards: [{ id: 'c1', laneEntityId: 'D_TRAIN', eventIds: ['E2'] }],
          nodes: [{ id: 'c1' }],
          edges: [],
          entities: [{ id: 'D_TRAIN', name: '運転士', kind: 'person', focus: 'high' }],
          analysis: {
            version: 5,
            sources: [],
            entities: [{ id: 'D_TRAIN', name: '運転士', kind: 'person', focus: 'high' }],
            events: [
              {
                id: 'E18',
                time: '10:42',
                title: '中継見張員配置未確認',
                description: '配置を確認しなかった',
                sourceOrder: 1,
                classification: 'variation',
                sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p4' }],
                origin: 'extraction',
              },
              {
                id: 'E25',
                time: '10:46',
                title: '列車触車',
                description: '列車と作業員が触車し死亡した',
                sourceOrder: 2,
                classification: 'outcome',
                outcome_kind: 'loss',
                sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p5' }],
                origin: 'extraction',
              },
            ],
            participations: [{ eventId: 'E25', entityId: 'D_TRAIN', role: 'actor' }],
            relations: [],
            cards: [{ id: 'c1', laneEntityId: 'D_TRAIN', eventIds: ['E25'] }],
            unassignedEventIds: ['E18'],
            outcome: {
              status: 'identified',
              kind: 'loss',
              eventIds: ['E25'],
              reason: '触車死亡',
              sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p5' }],
            },
          },
        },
        truncated: false,
        originalChars: 200,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: scenarioWithTitle });
    expect(pkg.silent_exclusions?.unassigned_events).toEqual([
      {
        id: 'E18',
        time: '10:42',
        title: '中継見張員配置未確認',
        refs: ['source_1/p4'],
      },
    ]);
    // p2 (under ## 1. 題目) must NOT be flagged as an unreferenced hazard paragraph
    expect(pkg.silent_exclusions?.unreferenced_paragraphs?.flagged_with_hazard_terms).toBeUndefined();

    const md = formatAIDiagnosticsAsMarkdown(pkg);
    expect(md).toContain('unassigned_events:');
    expect(md).toContain('E18');
  });

  it('includes conservatively discovered Poset parents (group_*, subject_others) in Section 4 parents alongside explicit multi-axis parents', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-25T04:54:53.000Z',
        sessionId: 's_parents_sync',
        stage: 'graph.projection',
        data: {
          entities: [
            { id: 'A4', name: '除草薬散布作業班', kind: 'organization', focus: 'high' },
            { id: 'group_relay', name: '中継見張・待避作業員群', kind: 'organization', parentEntityIds: ['A4'], mergedFrom: ['A9'] },
            { id: 'subject_others', name: 'その他の関係者', kind: 'other', aggregate: true, mergedFrom: ['A3'] },
          ],
          subjectPoset: {
            nodes: ['A3', 'A4', 'A8', 'A9', 'group_relay', 'subject_others'],
            relations: [
              { childId: 'A9', parentId: 'A8' },
              { childId: 'A9', parentId: 'A4' },
              { childId: 'A8', parentId: 'group_relay' },
              { childId: 'group_relay', parentId: 'A4' },
              { childId: 'A3', parentId: 'subject_others' },
            ],
          },
          subjectRanking: {
            version: 1,
            maxSubjects: 7,
            weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
            originalEntities: [
              { id: 'A3', name: '下請会社', kind: 'organization', focus: 'mid' },
              { id: 'A4', name: '除草薬散布作業班', kind: 'organization', focus: 'high' },
              { id: 'A8', name: '中継見張員', kind: 'organization', focus: 'mid', parentEntityIds: ['A4'] },
              { id: 'A9', name: 'C中継見張員', kind: 'person', focus: 'mid', parentEntityIds: ['A8', 'A4'] },
            ],
            ranks: [
              { entityId: 'A4', rank: 1, score: 0.3, breakdown: { A: 0, O: 0, F: 1, C: 0, T: 0 }, retained: true, reason: '保持' },
              { entityId: 'A9', rank: 2, score: 0.2, breakdown: { A: 0.2, O: 0, F: 0.5, C: 0.2, T: 0 }, retained: false, mergedInto: 'group_relay', consolidationStage: 'stage3_hc_group', reason: '統合' },
              { entityId: 'A3', rank: 3, score: 0.1, breakdown: { A: 0.1, O: 0, F: 0.5, C: 0.1, T: 0 }, retained: false, mergedInto: 'subject_others', consolidationStage: 'stage3_hc_others', reason: '統合' },
              { entityId: 'A8', rank: 4, score: 0.1, breakdown: { A: 0, O: 0, F: 0.5, C: 0, T: 0 }, retained: false, excluded: true, consolidationStage: 'stage3_hc_prune', reason: '2段階統合' },
            ],
          },
        },
        truncated: false,
        originalChars: 300,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const a3 = pkg.subject_poset?.hierarchies.find((h) => h.id === 'A3');
    const a8 = pkg.subject_poset?.hierarchies.find((h) => h.id === 'A8');
    const a9 = pkg.subject_poset?.hierarchies.find((h) => h.id === 'A9');

    expect(a3?.parents).toContain('subject_others');
    expect(a8?.parents).toEqual(expect.arrayContaining(['A4', 'group_relay']));
    // A9 preserves explicit multi-axis parent A4 alongside Hasse parent A8
    expect(a9?.parents).toEqual(expect.arrayContaining(['A8', 'A4']));
  });

  it('surfaces lane.consolidation invalidCandidateLines as LANE_CONSOLIDATION_INVALID_ROW anomalies', () => {
    const entries: DebugEntry[] = [
      {
        time: '2026-11-26T04:24:00.000Z',
        sessionId: 's_lf15_invalid_row',
        stage: 'lane.consolidation',
        data: {
          fineLaneCount: 32,
          targetMaxSubjects: 7,
          finalLaneCount: 9,
          llmCalled: true,
          llmCandidateCount: 11,
          invalidCandidateCount: 1,
          invalidCandidateLines: ['[分離維持ペア] 未登録の主体ID/名称: group_unknown / A6'],
          evaluatedStates: 140,
          appliedCandidateIds: ['M1_aux', 'M2'],
          score: 0.78,
          metrics: { c1: 0.65, c2: 0.81, c3: 0.72, c4: 1, c5: 0.9 },
        },
        truncated: false,
        originalChars: 320,
      },
    ];

    const pkg = buildAIDiagnostics({ entries, scenarioText: sampleScenario });
    const invalidRowAnomaly = pkg.anomalies.find(
      (a) => a.issue_type === 'LANE_CONSOLIDATION_INVALID_ROW'
    );
    expect(invalidRowAnomaly).toBeDefined();
    expect(invalidRowAnomaly?.stage).toBe('lane.consolidation');
    expect(invalidRowAnomaly?.violation_detail).toContain('[分離維持ペア] 未登録の主体ID/名称');
  });

  it('distinguishes projected_events and unassigned_events in graph.projection transitions and preserves variation:resilient polarity in Section 6 Active Events Ledger (ADR-0098)', () => {
    debugRecorder.setEnabled(true);
    debugRecorder.clear();

    const scenario = [
      '10:40 見張員が接近合図を送った。',
      '10:45 E作業員が線路外へ緊急待避した。',
      '10:45 中継見張員配置が確認されていなかった。',
      '10:46 列車と作業員が触車した。',
    ].join('\n\n');
    const src = sourceFromText(scenario);
    const baseAnalysis = inspectLedger(
      parseLedger(
        [
          '[主体]',
          'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
          'A_LOOK\t見張員\tperson\thigh\t-\tp1',
          'A_EVAC\tE作業員\tperson\tmid\t-\tp2',
          'A_DRV\t運転士\tperson\thigh\t-\tp4',
          '[イベント]',
          'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
          'E1\t10:40\t接近合図送出\t見張員が接近合図を送った\tA_LOOK:actor\tp1\trecorded',
          'E2\t10:45\t線路外緊急待避\tE作業員が線路外へ待避した\tA_EVAC:actor\tp2\trecorded',
          'E3\t10:45\t配置未確認\t中継見張員配置が確認されていなかった\t-\tp3\trecorded',
          'E4\t10:46\t列車触車\t列車と作業員が触車した\tA_DRV:actor\tp4\trecorded',
          '[関係]',
          'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
          'R1\tbefore\tE1\t-\tE4\t-\tp1,p4\t-\t-\tna',
          '[共有カード]',
          '[整理]',
          '[帰結]',
          'O1\tidentified\tE4:loss\tp4\t触車発生',
          '[仮判定]',
          'E1\tnormal\t定常合図\tp1',
          'E2\tvariation:resilient\t被害拡大を防いだ緊急待避\tp2',
          'E3\tvariation\t配置未確認の逸脱\tp3',
          '[完了]',
        ].join('\n')
      ),
      src
    ).analysis!;

    // Also verify post-Stage-3 classification polarity preservation on E2
    baseAnalysis.events.find((e) => e.id === 'E2')!.classification = 'variation';
    baseAnalysis.events.find((e) => e.id === 'E2')!.variationFactor = {
      category: 'response',
      polarity: 'resilient',
      description: '緊急待避による被災回避',
    };

    projectAnalysis(baseAnalysis);
    const entries = debugRecorder.getEntries();
    debugRecorder.setEnabled(false);
    debugRecorder.clear();

    const pkg = buildAIDiagnostics({ entries, scenarioText: scenario, profile: 'deep' });
    const projTransition = pkg.pipeline_transitions.find((t) => t.phase === 'graph.projection');
    expect(projTransition?.counts).toMatchObject({
      events: 4,
      projected_events: 3,
      unassigned_events: 1,
      cards: 3,
      nodes: 3,
    });

    const e2Audit = pkg.active_events_ledger?.find((ev) => ev.id === 'E2');
    const e3Audit = pkg.active_events_ledger?.find((ev) => ev.id === 'E3');
    const e4Audit = pkg.active_events_ledger?.find((ev) => ev.id === 'E4');
    expect(e2Audit?.classification).toBe('variation:resilient');
    expect(e3Audit?.classification).toBe('variation');
    expect(e4Audit?.classification).toBe('outcome:loss');
  });
});
