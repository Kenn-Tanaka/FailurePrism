import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  callLLMGateway,
  captureEventPrompts,
  classifyEventDraft,
  extractEventDraft,
  extractJSONFromResponse,
  populatePreliminaryClassifications,
} from '../../src/tools/vta/services/llm/client';
import { parseRetryAfterMs } from '../../src/shared/llm/retry';
import { autoConnectVTA } from '../../src/tools/vta/services/generation/autoConnectionService';
import * as clientModule from '../../src/tools/vta/services/llm/client';
import * as chainRepairModule from '../../src/tools/vta/services/generation/chainRepairService';
import {
  compileNormalizationSystemPrompt,
  compileClassificationSystemPrompt,
  compileConnectionProposalSystemPrompt,
  compilePreliminaryClassificationSystemPrompt,
  PRELIMINARY_CLASSIFICATION_PROMPT,
  OUTCOME_EXTRACTION_POLICY,
  OUTCOME_EXTRACTION_FIRST_POLICY,
  SECTION_ORDER_POLICY,
  SECTION_ORDER_ANCHOR_FIRST_POLICY,
  upsertPolicyBlock,
  EXTRACTION_ANCHORING_POLICY,
  SUBJECT_LANE_POLICY,
  POST_OUTCOME_SCOPE_POLICY,
} from '../../src/tools/vta/services/llm/eventPrompts';
import {
  parseLedger,
  inspectLedger,
  preliminaryClassificationInput,
  inspectPreliminaryClassifications,
} from '../../src/tools/vta/features/vta/utils/eventLedger';
import { sliceProposalSourceRows } from '../../src/tools/vta/services/generation/contextSlicer';
import { proposalContext } from '../../src/tools/vta/services/generation/proposalContext';
import {
  parseRefinementReviewTSV,
  applyRefinementOps,
} from '../../src/tools/vta/services/generation/granularityRefinement';
import { proposeChainRepair } from '../../src/tools/vta/services/generation/chainRepairService';
import type { LLMConfig, VTAAnalysisData, VTASchema, VTASource, VTAEvent } from '../../src/tools/vta/types/vta';

describe('VTA LLM Prompt & Architecture Improvements (ADR-0015)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. SSE Streaming & Finish-Reason Guard in callLLMGateway', () => {
    it('streams text/event-stream chunks and concatenates delta content accurately', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"[主"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"体]\\nA1\\t機長A\\tperson\\tsource_1/p1\\t-"}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"\\n[完了]"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of sseChunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'openrouter/google/gemini-3.8-flash',
        gatewayToken: 'test-token',
        timeoutSeconds: 30,
      };

      const res = await callLLMGateway(config, [{ role: 'user', content: 'test' }]);
      expect(res.content).toBe('[主体]\nA1\t機長A\tperson\tsource_1/p1\t-\n[完了]');

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const sentPayload = JSON.parse(String(requestInit.body));
      expect(sentPayload.stream).toBe(true);
    });

    it('rejects truncated SSE stream when finish_reason is length', async () => {
      const ssePayload = [
        'data: {"choices":[{"delta":{"content":"partial output"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      global.fetch = vi.fn().mockResolvedValue(
        new Response(ssePayload, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      ) as unknown as typeof fetch;

      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'test-model',
        gatewayToken: '',
      };

      await expect(callLLMGateway(config, [{ role: 'user', content: 'test' }])).rejects.toThrow(
        'LLMの出力上限に達しました'
      );
    });
  });

  describe('2. Automatic Exponential Backoff & Retry on HTTP 504 / 429', () => {
    it('automatically retries HTTP 504 upstream_timeout and succeeds on subsequent attempt', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: 'upstream_timeout', message: 'Upstream provider read timed out.' },
            }),
            { status: 504 }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '[完了]' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'openrouter/google/gemini-3.8-flash',
        gatewayToken: '',
        maxRetries: 2,
        retryBaseDelayMs: 15,
      };

      const result = await callLLMGateway(config, [{ role: 'user', content: 'retry test' }]);
      expect(result.content).toBe('[完了]');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('honors Retry-After header (delay-seconds and HTTP-date) and defaults maxRetries to 3 without test-env branches', async () => {
      expect(parseRetryAfterMs('0.02')).toBe(20);
      const baseNow = Date.UTC(2026, 10, 6, 12, 0, 0);
      const futureDate = new Date(baseNow + 2000).toUTCString();
      expect(parseRetryAfterMs(futureDate, baseNow)).toBe(2000);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '0.01' },
          })
        )
        .mockResolvedValueOnce(
          new Response('bad gateway', {
            status: 502,
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'test-model',
        gatewayToken: '',
        // Omit maxRetries to verify default is 3 (even inside Vitest)
        retryBaseDelayMs: 10,
      };

      const result = await callLLMGateway(config, [{ role: 'user', content: 'retry-after test' }]);
      expect(result.content).toBe('recovered');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('3. Idempotent Policy Injection & Prompt Compilation', () => {
    it('replaces older policy blocks in-place without duplicating headers across multiple invocations', () => {
      const legacyPrompt = [
        'ベースプロンプト先頭',
        '【抽出・構造化の思考手順（アンカリング順序）】\n旧バージョンの思考順序テキスト',
        '【主体と客体の区別】\n旧バージョンの主体定義テキスト',
        '【関係属性契約: relation-attributes-1】\n旧バージョンの関係属性契約',
      ].join('\n');

      const compiledOnce = compileNormalizationSystemPrompt(legacyPrompt, {
        includeChainDirective: true,
        excludePostOutcome: true,
      });
      const compiledTwice = compileNormalizationSystemPrompt(compiledOnce, {
        includeChainDirective: true,
        excludePostOutcome: true,
      });

      expect(compiledOnce).toBe(compiledTwice);
      expect(compiledTwice).toContain(EXTRACTION_ANCHORING_POLICY);
      expect(compiledTwice).toContain(SUBJECT_LANE_POLICY);
      expect(compiledTwice).toContain(POST_OUTCOME_SCOPE_POLICY);
      expect(compiledTwice).not.toContain('旧バージョンの思考順序テキスト');
      expect(compiledTwice).not.toContain('旧バージョンの主体定義テキスト');
      expect(compiledTwice).not.toContain('relation-attributes-1');

      const countHeaderOccurrences = (text: string, header: string) =>
        text.split('\n').filter((line) => line.startsWith(header)).length;
      expect(countHeaderOccurrences(compiledTwice, '【抽出・構造化の思考手順（アンカリング順序）】')).toBe(1);
      expect(countHeaderOccurrences(compiledTwice, '【主体と客体の区別】')).toBe(1);
      expect(countHeaderOccurrences(compiledTwice, '【事実性・客観記述の方針')).toBe(1);
      expect(countHeaderOccurrences(compiledTwice, '【帰結以降の事後調査活動の除外方針')).toBe(1);

      const captured = captureEventPrompts();
      expect(countHeaderOccurrences(captured.normalization!.systemPrompt, '【主体と客体の区別】')).toBe(1);
      expect(countHeaderOccurrences(compileClassificationSystemPrompt(captured.classification!.systemPrompt), '【事実性・客観記述の方針')).toBe(1);
      expect(countHeaderOccurrences(compileConnectionProposalSystemPrompt('接続ベース'), '【事実性・客観記述の方針')).toBe(1);
    });

    it('upsertPolicyBlock updates a matching marker block cleanly', () => {
      const initial = '導入文\n【テスト規約】\n旧ルール1\n【別の規約】\n別ルール';
      const updated = upsertPolicyBlock(initial, '【テスト規約】', '【テスト規約】\n新ルールA\n新ルールB');
      expect(updated).toContain('新ルールA');
      expect(updated).not.toContain('旧ルール1');
      expect(updated).toContain('【別の規約】\n別ルール');
    });
  });

  describe('4. Adaptive Context Slicer & Proposal Context assignedEntities', () => {
    it('slices large source documents within budget while retaining direct citations and opening paragraphs', () => {
      const rows = Array.from({ length: 100 }, (_, i) => ({
        ref: `source_1/p${i + 1}`,
        eventIds: i === 45 || i === 80 ? [`E${i + 1}`] : [],
        purpose: (i === 45 || i === 80 ? 'direct' : 'context') as 'direct' | 'context',
        text: `段落${i + 1}の本文: ` + 'あ'.repeat(400),
      }));

      const sliced = sliceProposalSourceRows(rows, 5000);
      const totalChars = sliced.reduce((sum, r) => sum + r.text.length, 0);
      expect(totalChars).toBeLessThanOrEqual(5000);

      const refs = new Set(sliced.map((r) => r.ref));
      // Direct citations must be preserved
      expect(refs.has('source_1/p46')).toBe(true);
      expect(refs.has('source_1/p81')).toBe(true);
      // Opening context p1 must be preserved
      expect(refs.has('source_1/p1')).toBe(true);
    });

    it('includes assignedEntities column in [全イベント] table of proposalContext', () => {
      const analysis: VTAAnalysisData = {
        version: 5,
        sources: [
          {
            id: 'source_1',
            text: 'p1 text',
            paragraphs: [{ id: 'p1', text: '機長Aが管制官Bへ連絡した。' }],
          },
        ],
        facts: [],
        entities: [
          { id: 'A1', name: '機長A', kind: 'person' },
          { id: 'A2', name: '管制官B', kind: 'person' },
        ],
        events: [
          {
            id: 'E1',
            title: '連絡実施',
            description: '機長Aが管制官Bへ連絡した',
            time: '17:45',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            classification: 'normal',
            origin: 'extraction',
          },
        ],
        participations: [
          { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] },
          { eventId: 'E1', entityId: 'A2', role: 'affected', factIds: [] },
        ],
        relations: [],
        cards: [{ id: 'C1', laneEntityId: 'A1', eventIds: ['E1'] }],
        unassignedEventIds: [],
      };
      const schema: VTASchema = {
        lanes: ['機長A'],
        nodes: [],
        edges: [],
        analysis,
      };

      const ctx = proposalContext(schema);
      expect(ctx.text).toContain('eventId\ttime\ttitle\tdescription\trecordKind\tsourceRefs\tstate\tassignedEntities');
      expect(ctx.text).toContain('E1\t17:45\t連絡実施\t機長Aが管制官Bへ連絡した\trecorded\tsource_1/p1\tvisible\tA1:actor,A2:affected');
    });
  });

  describe('5. Granularity Refinement 13-Column TSV Normalization & Uninvolved Subject Cleansing', () => {
    it('normalizes 13-column tab-expanded add_relation rows and cleanses uninvolved subjects on before relations', () => {
      const rawTsv = [
        '[評価]',
        '項目\t値\t理由',
        'C2\t0.9\t良好',
        'C4\t0.9\t良好',
        '[修正]',
        'ID\t操作\t対象ID\t内容\t原文参照\t理由',
        // 13-column tab-expanded relation row where LLM output tabs inside content
        'OP1\tadd_relation\t-\tbefore\tE1\tA2\tE2\tA2\t-\t-\tna\tsource_1/p1\t時系列の前後関係を追加',
        '[完了]',
      ].join('\n');

      const parsed = parseRefinementReviewTSV(rawTsv);
      expect(parsed.ops).toHaveLength(1);
      expect(parsed.ops[0].id).toBe('OP1');
      expect(parsed.ops[0].op).toBe('add_relation');
      expect(parsed.ops[0].content).toBe('before:E1:A2:E2:A2:-:-:na');
      expect(parsed.ops[0].sourceRefs).toEqual(['source_1/p1']);
      expect(parsed.ops[0].reason).toBe('時系列の前後関係を追加');

      const baseAnalysis: VTAAnalysisData = {
        version: 5,
        sources: [{ id: 'source_1', text: 'p1', paragraphs: [{ id: 'p1', text: 'テスト段落' }] }],
        facts: [],
        entities: [
          { id: 'A1', name: '機長A', kind: 'person' },
          { id: 'A2', name: '管制官B', kind: 'person' },
        ],
        events: [
          {
            id: 'E1',
            title: '事象1',
            description: '事象1の説明',
            time: '10:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            classification: 'normal',
            origin: 'extraction',
          },
          {
            id: 'E2',
            title: '事象2',
            description: '事象2の説明',
            time: '10:05',
            sourceOrder: 1,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            classification: 'normal',
            origin: 'extraction',
          },
        ],
        // Note: E1 and E2 only have A1 participating, NOT A2!
        participations: [
          { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] },
          { eventId: 'E2', entityId: 'A1', role: 'actor', factIds: [] },
        ],
        relations: [],
        cards: [{ id: 'C1', laneEntityId: 'A1', eventIds: ['E1', 'E2'] }],
        unassignedEventIds: [],
      };
      const baseSchema: VTASchema = {
        lanes: ['機長A', '管制官B'],
        nodes: [],
        edges: [],
        analysis: baseAnalysis,
      };

      const { schema: nextSchema, appliedOps } = applyRefinementOps(
        baseSchema,
        parsed.ops,
        10,
        new Set<string>(),
        () => {}
      );
      expect(appliedOps).toEqual(['add_relation:rel_ref_OP1']);
      expect(nextSchema.analysis?.relations).toHaveLength(1);
      expect(nextSchema.analysis?.relations[0].kind).toBe('before');
      // Uninvolved A2 on `before` relation must be safely cleansed to undefined so validateSavedAnalysis succeeds
      expect(nextSchema.analysis?.relations[0].sourceEntityId).toBeUndefined();
      expect(nextSchema.analysis?.relations[0].targetEntityId).toBeUndefined();
    });
  });

  describe('6. Chain Repair Atomic Rule & Connectivity Diagnostics Hint', () => {
    it('appends [連結診断ヒント] to chain repair user prompt', async () => {
      let capturedMessages: Array<{ role: string; content: string }> = [];
      global.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body));
        capturedMessages = body.messages;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '[完了]' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as unknown as typeof fetch;

      const analysis: VTAAnalysisData = {
        version: 5,
        sources: [{ id: 'source_1', text: 'p1', paragraphs: [{ id: 'p1', text: '段落1' }] }],
        facts: [],
        entities: [{ id: 'A1', name: '主体1', kind: 'person' }],
        events: [
          {
            id: 'E1',
            title: 'イベント1',
            description: '説明1',
            time: '10:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            classification: 'normal',
            origin: 'extraction',
          },
          {
            id: 'E2',
            title: '未割当イベント2',
            description: '説明2',
            time: '10:01',
            sourceOrder: 1,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            classification: 'normal',
            origin: 'extraction',
          },
        ],
        participations: [{ eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] }],
        relations: [],
        cards: [{ id: 'C1', laneEntityId: 'A1', eventIds: ['E1'] }],
        unassignedEventIds: ['E2'],
      };
      const schema: VTASchema = {
        lanes: ['主体1'],
        nodes: [
          {
            id: 'C1',
            lane: '主体1',
            time: '10:00',
            title: 'イベント1',
            description: '説明1',
            type: 'normal',
            measure_type: null,
            event_ids: ['E1'],
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        analysis,
      };
      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'test-model',
        gatewayToken: '',
      };

      await proposeChainRepair(config, schema);
      expect(capturedMessages).toHaveLength(2);
      expect(capturedMessages[0].content).toContain('【関係追加における主体関与の絶対規則】');
      expect(capturedMessages[1].content).toContain('[連結診断ヒント]');
      expect(capturedMessages[1].content).toContain('未割当イベントID: E2(未割当)');
      expect(capturedMessages[1].content).toContain('G1[E1(A1:actor)]');
    });
  });

  describe('7. Phase 3-1: Deterministic Pre-Pass and Auto-Connection Pre-Triage', () => {
    it('skips proposeChainRepair when graph is already fully connected with an identified outcome', async () => {
      const proposeSpy = vi.spyOn(chainRepairModule, 'proposeChainRepair').mockResolvedValue({
        requestId: 'test_req',
        calls: 0,
        rows: [],
        issues: [],
        trace: [],
        complete: true,
      });

      const fullyConnectedSchema: VTASchema = {
        lanes: ['主体A'],
        nodes: [
          {
            id: 'N1',
            lane: '主体A',
            time: '10:00',
            title: '事象1',
            description: '事象1の内容',
            type: 'normal',
            measure_type: null,
            event_ids: ['E1'],
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
        analysis: {
          version: 5,
          sources: [{ id: 'source_1', text: 'p1', paragraphs: [{ id: 'p1', text: '事象1' }] }],
          facts: [],
          entities: [{ id: 'A1', name: '主体A', kind: 'person' }],
          events: [
            {
              id: 'E1',
              title: '事象1',
              description: '事象1の内容',
              time: '10:00',
              sourceOrder: 0,
              factIds: [],
              sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
              classification: 'normal',
              origin: 'extraction',
            },
          ],
          participations: [{ eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] }],
          relations: [],
          cards: [{ id: 'N1', laneEntityId: 'A1', eventIds: ['E1'] }],
          unassignedEventIds: [],
          outcome: {
            status: 'identified',
            eventIds: ['E1'],
            reason: '帰結',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          },
        },
      };

      vi.spyOn(clientModule, 'proposeVTAConnections').mockResolvedValueOnce({
        proposals: [],
        reviews: [],
        invalidRows: [],
      });

      const progressMessages: string[] = [];
      const result = await autoConnectVTA(
        { baseUrl: 'http://localhost:8765/v1', selectedModel: 'test-model', gatewayToken: '' },
        fullyConnectedSchema,
        undefined,
        (p) => progressMessages.push(p.message)
      );

      // proposeChainRepair must be skipped because canonical count is 1, 0 unassigned, outcome is identified
      expect(proposeSpy).not.toHaveBeenCalled();
      expect(progressMessages.some((m) => m.includes('全事象が帰結ノードまで完全連結しているため、連鎖点検AI推論を省略します'))).toBe(true);
      expect(result.addedChainConnections).toBe(0);
    });
  });

  describe('8. Phase 3-2: ADR-0001-Compliant Differential Event Classification', () => {
    it('preserves user-confirmed / batch-adopted events and sends only unclassified events to LLM', async () => {
      let requestedClassificationInput = '';
      global.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body));
        requestedClassificationInput = body.messages[1].content;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '[判定]\nID\t判定\t理由\t原文参照\nE2\tnormal\t定められた通常確認\tsource_1/p2\n[完了]',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as unknown as typeof fetch;

      const analysis: VTAAnalysisData = {
        version: 5,
        sources: [
          {
            id: 'source_1',
            text: 'text',
            paragraphs: [
              { id: 'p1', text: '変動発生段落' },
              { id: 'p2', text: '通常確認段落' },
            ],
          },
        ],
        facts: [],
        entities: [{ id: 'A1', name: '作業員', kind: 'person' }],
        events: [
          {
            id: 'E1',
            title: '遅延発生',
            description: '部品不具合により遅延した',
            time: '10:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            // Confirmed by user or ADR-0001 batch-adoption prior to running AI classification
            classification: 'variation',
            classificationReason: '利用者確認済みの変動要因',
            classificationSourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            origin: 'extraction',
          },
          {
            id: 'E2',
            title: '確認実施',
            description: '手順に従い確認した',
            time: '10:15',
            sourceOrder: 1,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
            classification: 'unclassified',
            origin: 'extraction',
            // Preliminary exists as reference only (not auto-promoted without user action per ADR-0001)
            preliminary: {
              value: 'normal',
              reason: '正規化時の仮判定',
              sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
            },
          },
        ],
        participations: [
          { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] },
          { eventId: 'E2', entityId: 'A1', role: 'actor', factIds: [] },
        ],
        relations: [],
        cards: [],
        unassignedEventIds: [],
      };

      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'test-model',
        gatewayToken: '',
      };

      const result = await classifyEventDraft(config, analysis);

      // E1 must retain its confirmed classification untouched
      expect(result.events[0].classification).toBe('variation');
      expect(result.events[0].classificationReason).toBe('利用者確認済みの変動要因');

      // E2 must be classified by LLM
      expect(result.events[1].classification).toBe('normal');
      expect(result.events[1].classificationReason).toBe('定められた通常確認');

      // Only unclassified E2 is sent in the [イベント] table; confirmed E1 is excluded
      expect(requestedClassificationInput).toContain('E2\t10:15\t確認実施');
      expect(requestedClassificationInput).not.toContain('E1\t10:00\t遅延発生');
    });

    it('skips LLM call entirely if all events are already confirmed', async () => {
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      const analysis: VTAAnalysisData = {
        version: 5,
        sources: [{ id: 'source_1', text: 'text', paragraphs: [{ id: 'p1', text: '段落1' }] }],
        facts: [],
        entities: [{ id: 'A1', name: '作業員', kind: 'person' }],
        events: [
          {
            id: 'E1',
            title: '点検実施',
            description: '通常点検を実施した',
            time: '10:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            classification: 'normal',
            classificationReason: '確認済み',
            classificationSourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            origin: 'extraction',
          },
        ],
        participations: [{ eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] }],
        relations: [],
        cards: [],
        unassignedEventIds: [],
      };

      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'test-model',
        gatewayToken: '',
      };

      const result = await classifyEventDraft(config, analysis);
      expect(result.events[0].classification).toBe('normal');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('9. Phase 3-3: Response Hygiene & Dead Legacy Code Removal', () => {
    it('extractJSONFromResponse correctly strips thinking tags and extracts json without circular legacyExtract dependency', () => {
      const rawWithThink = '<think>思考プロセス...</think>```json\n{"lanes":["現場"]}\n```';
      const extracted = extractJSONFromResponse(rawWithThink);
      expect(extracted.hasThinkTag).toBe(true);
      expect(JSON.parse(extracted.jsonString)).toEqual({ lanes: ['現場'] });
      expect('extractVTAFromScenario' in clientModule).toBe(false);
    });
  });

  describe('10. Phase A: Preliminary Classification Pipeline Separation (ADR-0016)', () => {
    it('compileNormalizationSystemPrompt omits [仮判定] section when omitPreliminary is true', () => {
      const basePrompt = '入力資料をVTA用の簡潔なTSV台帳に変換する。';
      const promptWithoutPreliminary = compileNormalizationSystemPrompt(basePrompt, { omitPreliminary: true });
      expect(promptWithoutPreliminary).not.toContain('[仮判定]');
      expect(promptWithoutPreliminary).not.toContain('各イベントにnormal・variation・undeterminedを仮に付ける');
      expect(promptWithoutPreliminary).toContain('[表記]');
      expect(promptWithoutPreliminary).toContain('[表現]');

      const defaultPrompt = compileNormalizationSystemPrompt(basePrompt);
      expect(defaultPrompt).toContain('[仮判定]');
      expect(defaultPrompt).toContain('各イベントにnormal・variation・undeterminedを仮に付ける');
    });

    it('preliminaryClassificationInput formats events and referenced paragraphs cleanly', () => {
      const source: VTASource = {
        id: 'source_1',
        text: 'dummy',
        paragraphs: [
          { id: 'p1', text: '機長は指示を待機した。' },
          { id: 'p2', text: 'その後、滑走路へ進入した。' },
          { id: 'p3', text: '事後調査が行われた。' },
        ],
      };
      const events: VTAEvent[] = [
        {
          id: 'E1',
          title: '待機',
          description: '指示待機',
          time: '17:45:00',
          sourceOrder: 0,
          factIds: [],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          classification: 'unclassified',
          origin: 'extraction',
        },
        {
          id: 'E2',
          title: '進入',
          description: '滑走路進入',
          time: '17:47:00',
          sourceOrder: 1,
          factIds: [],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
          classification: 'unclassified',
          origin: 'extraction',
        },
      ];

      const input = preliminaryClassificationInput(events, source);
      expect(input).toContain('[対象イベント]');
      expect(input).toContain('E1\t17:45:00\t待機\t指示待機\tp1');
      expect(input).toContain('E2\t17:47:00\t進入\t滑走路進入\tp2');
      expect(input).toContain('[p1] 機長は指示を待機した。');
      expect(input).toContain('[p2] その後、滑走路へ進入した。');
      // p3 is not referenced by events, so not included
      expect(input).not.toContain('[p3]');
    });

    it('inspectPreliminaryClassifications assigns preliminary to events while keeping classification as unclassified (ADR-0001)', () => {
      const source: VTASource = {
        id: 'source_1',
        text: 'dummy',
        paragraphs: [
          { id: 'p1', text: '機長は指示を待機した。' },
          { id: 'p2', text: 'その後、滑走路へ進入した。' },
        ],
      };
      const events: VTAEvent[] = [
        {
          id: 'E1',
          title: '待機',
          description: '指示待機',
          time: '17:45:00',
          sourceOrder: 0,
          factIds: [],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          classification: 'unclassified',
          origin: 'extraction',
        },
        {
          id: 'E2',
          title: '進入',
          description: '滑走路進入',
          time: '17:47:00',
          sourceOrder: 1,
          factIds: [],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
          classification: 'unclassified',
          origin: 'extraction',
        },
      ];

      const tsvReply = [
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E1\tnormal\t通常の手順待機\tp1',
        'E2\tvariation\t指示前の進入\tp2',
      ].join('\n');

      const doc = parseLedger(tsvReply, { partial: true, allowMissingComplete: true, defaultSection: '仮判定' });
      const result = inspectPreliminaryClassifications(doc, events, source);

      expect(result.issues).toHaveLength(0);
      expect(result.events[0].preliminary).toEqual({
        value: 'normal',
        reason: '通常の手順待機',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
      });
      expect(result.events[1].preliminary).toEqual({
        value: 'variation',
        reason: '指示前の進入',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
      });
      // ADR-0001 constraint: classification MUST stay 'unclassified'
      expect(result.events[0].classification).toBe('unclassified');
      expect(result.events[1].classification).toBe('unclassified');
    });

    it('populatePreliminaryClassifications populates preliminary and gracefully falls back on LLM failure', async () => {
      const source: VTASource = {
        id: 'source_1',
        text: 'dummy',
        paragraphs: [{ id: 'p1', text: '点検を実施した。' }],
      };
      const analysis: VTAAnalysisData = {
        version: 5,
        sources: [source],
        facts: [],
        entities: [{ id: 'A1', name: '作業員', kind: 'person' }],
        events: [
          {
            id: 'E1',
            title: '点検',
            description: '通常点検',
            time: '10:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            classification: 'unclassified',
            origin: 'extraction',
          },
        ],
        participations: [{ eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] }],
        relations: [],
        cards: [],
        unassignedEventIds: [],
      };

      const config: LLMConfig = {
        baseUrl: 'http://localhost:8765/v1',
        selectedModel: 'test-model',
        gatewayToken: '',
      };

      // 1. Success case
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"[仮判定]\\nE1\\tnormal\\t正常点検\\tp1"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const encoder = new TextEncoder();
      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      global.fetch = vi.fn().mockResolvedValue(
        new Response(mockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        })
      );

      const successResult = await populatePreliminaryClassifications(config, analysis, source);
      expect(successResult.events[0].preliminary).toEqual({
        value: 'normal',
        reason: '正常点検',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
      });
      expect(successResult.events[0].classification).toBe('unclassified');

      // 2. Failure fallback case (e.g. 504 timeout or network error)
      global.fetch = vi.fn().mockRejectedValue(new Error('Gateway HTTP 504 Timeout'));
      const analysisWithoutPreliminary = {
        ...analysis,
        events: [{ ...analysis.events[0], preliminary: undefined }],
      };
      const fallbackResult = await populatePreliminaryClassifications(config, analysisWithoutPreliminary, source);
      // Does not throw; returns analysis intact with unclassified events
      expect(fallbackResult.events[0].preliminary).toBeUndefined();
      expect(fallbackResult.events[0].classification).toBe('unclassified');
    });

    it('extractEventDraft compiles normalization prompt with omitPreliminary based on schemeId', () => {
      const baseSystemPrompt = '入力資料をVTA用の簡潔なTSV台帳に変換する。';
      const promptForRefinedChain = compileNormalizationSystemPrompt(baseSystemPrompt, {
        includeChainDirective: true,
        omitPreliminary: true,
      });
      const promptForEventChain = compileNormalizationSystemPrompt(baseSystemPrompt, {
        includeChainDirective: true,
        omitPreliminary: false,
      });

      expect(promptForRefinedChain).not.toContain('[仮判定]');
      expect(promptForRefinedChain).toContain('全文から不具合に至る事象の連鎖を構成する。');
      expect(promptForEventChain).toContain('[仮判定]');
      expect(promptForEventChain).toContain('全文から不具合に至る事象の連鎖を構成する。');
    });
  });

  describe('11. Phase B: Outcome-First Anchoring Prompt Order (ADR-0017)', () => {
    it('compileNormalizationSystemPrompt compiles outcome-first anchoring prompt order when outcomeFirst is true', () => {
      const basePrompt = '入力資料をVTA用の簡潔なTSV台帳に変換する。\n次の基本5セクションと帰結確認セクションを順に出力する。\n[主体]\n[イベント]\n[関係]\n[共有カード]\n[整理]\n[帰結]\n[完了]';
      const promptAnchorFirst = compileNormalizationSystemPrompt(basePrompt, { outcomeFirst: true });

      // In outcome-first mode:
      // 1. Policy should instruct placing [帰結] before [主体]
      expect(promptAnchorFirst).toContain('アンカリング思考手順に従い、[主体]セクションの前に必ず次の5列TSVを1行出す。');
      expect(promptAnchorFirst).toContain('アンカリング思考手順に従い、帰結確認セクションと基本5セクションを順に出力する。');

      // 2. Section order should show [帰結] before [主体]
      const outcomeIdx = promptAnchorFirst.indexOf('[帰結]\nID\t判定\tイベントID\t原文参照\t理由\nout_1\tidentified');
      const subjectIdx = promptAnchorFirst.indexOf('[主体]\nID\t名称\t種類');
      expect(outcomeIdx).toBeGreaterThan(-1);
      expect(subjectIdx).toBeGreaterThan(-1);
      expect(outcomeIdx).toBeLessThan(subjectIdx);
    });

    it('compileNormalizationSystemPrompt retains default order when outcomeFirst is false or omitted, and allows idempotent toggling', () => {
      const basePrompt = '入力資料をVTA用の簡潔なTSV台帳に変換する。\n次の基本5セクションと帰結確認セクションを順に出力する。\n[主体]\n[イベント]\n[関係]\n[共有カード]\n[整理]\n[帰結]\n[完了]';
      const promptDefault = compileNormalizationSystemPrompt(basePrompt, { outcomeFirst: false });

      expect(promptDefault).toContain('通常の5セクションの後、[完了]の前に必ず次の5列TSVを1行出す。');
      expect(promptDefault).toContain('次の基本5セクションと帰結確認セクションを順に出力する。');

      // Toggling: turn outcomeFirst ON, then turn it OFF again
      const promptOn = compileNormalizationSystemPrompt(basePrompt, { outcomeFirst: true });
      const promptToggledOff = compileNormalizationSystemPrompt(promptOn, { outcomeFirst: false });

      expect(promptToggledOff).toContain('通常の5セクションの後、[完了]の前に必ず次の5列TSVを1行出す。');
      expect(promptToggledOff).toContain('次の基本5セクションと帰結確認セクションを順に出力する。');
      expect(promptToggledOff).not.toContain('アンカリング思考手順に従い、[主体]セクションの前に');
    });

    it('parseLedger and inspectLedger correctly parse and validate TSV ledgers with [帰結] placed ahead of [イベント]', () => {
      const source: VTASource = {
        id: 'source_1',
        text: 'dummy text',
        paragraphs: [
          { id: 'p1', text: '航空機Aは誘導路で待機した。' },
          { id: 'p2', text: '滑走路内で衝突が発生し大破した。' },
        ],
      };

      const outcomeFirstLedgerText = [
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'out_1\tidentified\tE2\tp2\t滑走路内での航空機衝突',
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t機長A\tperson\treporter\t-\tp1',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:45\t待機指示\t誘導路で待機\tA1:actor\tp1\trecorded',
        'E2\t17:47\t衝突炎上\t航空機衝突による大破\tA1:affected\tp2\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\tbefore\tE1\t-\tE2\t-\tp1,p2\t-\t-\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[完了]',
      ].join('\n');

      const doc = parseLedger(outcomeFirstLedgerText);
      expect(doc.rows[0].section).toBe('帰結');
      expect(doc.rows[0].id).toBe('out_1');

      const result = inspectLedger(doc, source);
      expect(result.issues).toHaveLength(0);
      expect(result.analysis).toBeDefined();
      expect(result.analysis?.outcome).toEqual({
        status: 'identified',
        eventIds: ['E2'],
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
        reason: '滑走路内での航空機衝突',
      });
      expect(result.analysis?.events).toHaveLength(2);
      expect(result.analysis?.events[1].id).toBe('E2');
    });
  });
});
