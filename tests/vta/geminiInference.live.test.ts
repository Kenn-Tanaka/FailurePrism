import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { compileConnectionProposalSystemPrompt } from '../../src/tools/vta/services/llm/eventPrompts';
import { DEFAULT_PROMPT_CONFIG } from '../../src/tools/vta/services/llm/prompts';
import { parseConnectionProposalTSV, type ConnectionProposalResult } from '../../src/tools/vta/features/vta/utils/connectionProposals';
import type { VTASchema } from '../../src/tools/vta/types/vta';

describe('Live LLM Test with gemini-3.5-flash', () => {
  let gatewayProcess: ChildProcess | null = null;
  const gatewayUrl = 'http://127.0.0.1:8765';

  beforeAll(async () => {
    // 1. Check if Gateway is already running
    let running = false;
    try {
      const res = await fetch(`${gatewayUrl}/health`);
      if (res.ok) running = true;
    } catch {
      // not running
    }

    if (!running) {
      const rootDir = process.cwd();
      const gatewayExe = path.join(rootDir, 'gateway', 'bin', 'llm-gateway.exe');
      const configFile = path.join(rootDir, 'gateway', 'config', 'llm-gateway.json');
      const gatewayDir = path.join(rootDir, 'gateway', 'bin');

      gatewayProcess = spawn(gatewayExe, ['--config', configFile], {
        cwd: gatewayDir,
        stdio: 'ignore',
        detached: false,
      });

      // Wait for health endpoint to become ready
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch(`${gatewayUrl}/health`);
          if (res.ok) {
            running = true;
            break;
          }
        } catch {
          // keep waiting
        }
      }
    }

    expect(running).toBe(true);
  }, 20000);

  afterAll(() => {
    if (gatewayProcess && !gatewayProcess.killed) {
      gatewayProcess.kill();
    }
  });

  it('runs connection proposal with openrouter/google/gemini-3.5-flash and successfully parses proposals with self-healing', async () => {
    const testSchema: VTASchema = {
      lanes: ['A3', 'A5'],
      nodes: [
        { id: 'c12', event_ids: ['E12'], lane: 'A5', time: '17:00', type: 'normal', title: 'APU再停止不具合', description: '機上整備員がAPU停止を確認', measure_type: null },
        { id: 'c13', event_ids: ['E13'], lane: 'A3', time: '17:05', type: 'normal', title: '電源車使用同意', description: '機長Aが電源車使用に同意', measure_type: null },
      ],
      edges: [],
      analysis: {
        version: 5,
        sources: [
          {
            id: 'source_1',
            text: 'APU不具合と電源車使用',
            paragraphs: [
              { id: 'p29', text: 'APUが再停止する不具合が発生した。' },
              { id: 'p30', text: '機上整備員Aが電源車の使用を提案し、機長Aがそれに同意した。' },
            ],
          },
        ],
        facts: [],
        events: [
          { id: 'E12', title: 'APU再停止不具合', description: 'APU再停止不具合発生', time: '17:00', sourceOrder: 0, factIds: [], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p29' }], classification: 'normal' },
          { id: 'E13', title: '電源車使用同意', description: '機長が電源車使用に同意', time: '17:05', sourceOrder: 1, factIds: [], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p30' }], classification: 'normal' },
        ],
        entities: [
          { id: 'A3', name: '機長A', kind: 'person' },
          { id: 'A5', name: '機上整備員A', kind: 'person' },
        ],
        participations: [
          { eventId: 'E12', entityId: 'A5', role: 'actor', factIds: [] },
          { eventId: 'E13', entityId: 'A3', role: 'actor', factIds: [] },
          { eventId: 'E13', entityId: 'A5', role: 'actor', factIds: [] },
        ],
        relations: [],
        cards: [
          { id: 'c12', laneEntityId: 'A5', eventIds: ['E12'] },
          { id: 'c13', laneEntityId: 'A3', eventIds: ['E13'] },
        ],
        unassignedEventIds: [],
      },
    };

    const basePrompt = DEFAULT_PROMPT_CONFIG.connectionProposal!;
    const systemPrompt = compileConnectionProposalSystemPrompt(basePrompt.systemPrompt);

    const testLedger = [
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E12\t17:00\tAPU再停止不具合\tAPU再停止不具合発生\tA5:actor\tsource_1/p29\trecorded',
      'E13\t17:05\t電源車使用同意\t機長が電源車使用に同意\tA3:actor,A5:actor\tsource_1/p30\trecorded',
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A3\t機長A\tperson\thigh\t-\tsource_1/p30',
      'A5\t機上整備員A\tperson\tmid\t-\tsource_1/p29',
      '[作業依存の優先点検候補（非隣接も根拠があれば可）]',
      'sourceEventId\tsourceEntityId\ttargetEventId\ttargetEntityId',
      'E12\tA5\tE13\tA3',
      '[接続専用の採用可能カード]',
      'c12,c13',
      '[原文]',
      'ref\teventIds\tpurpose\ttext',
      'source_1/p29\tE12\t-\tAPUが再停止する不具合が発生した。',
      'source_1/p30\tE13\t-\t機上整備員Aが電源車の使用を提案し、機長Aがそれに同意した。',
    ].join('\n');

    const userPrompt = basePrompt.userPromptTemplate.replace('{ledger}', testLedger);

    console.log('Sending request to openrouter/google/gemini-3.5-flash via Gateway...');
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/google/gemini-3.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.log('Gateway error status:', response.status);
      console.log('Gateway error body:', await response.text());
    }
    expect(response.ok).toBe(true);
    const data = await response.json();
    const content = data.choices[0].message.content;
    console.log('LLM Raw Output:\n', content);

    // Parse with our updated parser
    const result: ConnectionProposalResult = parseConnectionProposalTSV(content, testSchema);
    console.log('Parsed Result: proposals =', result.proposals.length, ', reviews =', result.reviews.length, ', invalid =', result.invalidRows);

    // Verify no [提案ID] error occurred
    const hasIdError = result.invalidRows.some((r) => r.includes('[提案ID]'));
    expect(hasIdError).toBe(false);

    // Verify proposals or reviews were extracted
    expect(result.proposals.length + result.reviews.length).toBeGreaterThan(0);

    // Verify each proposal has a valid, non-empty, non-hyphen ID
    for (const p of result.proposals) {
      expect(p.id).toBeTruthy();
      expect(p.id).not.toBe('-');
    }
  }, 60000);
});
