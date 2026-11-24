import { describe, expect, it, vi } from 'vitest';

// Make ledger validation throw a deterministic (non-network) error on demand.
const inspectState = vi.hoisted(() => ({ throwNext: 0 }));
vi.mock('../../features/vta/utils/eventLedger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/vta/utils/eventLedger')>();
  return {
    ...actual,
    inspectLedger: (...args: Parameters<typeof actual.inspectLedger>) => {
      if (inspectState.throwNext > 0) {
        inspectState.throwNext--;
        throw new Error('validateParticipants: deterministic validation failure');
      }
      return actual.inspectLedger(...args);
    },
  };
});

import { normalizeSource } from './fulltextLedger';
import { DEFAULT_PROMPT_CONFIG } from '../llm/prompts';
import { sourceFromText } from '../../features/vta/utils/eventAnalysis';
import { ledgerFixture, ledgerSource } from '../../features/vta/utils/eventLedger.fixture';

const config = { baseUrl: '/v1', gatewayToken: '', selectedModel: 'mock' };
const source = sourceFromText(ledgerSource);

describe('pendingLedgers cache eviction (H4)', () => {
  it('drops the cached ledger after a deterministic validation error so a retry re-fetches the full text', async () => {
    const projectId = crypto.randomUUID();
    const call = vi.fn<Parameters<typeof normalizeSource>[6]>(async () => ledgerFixture());
    const log = vi.fn();
    inspectState.throwNext = 1;
    await expect(normalizeSource(config, source, undefined, '', DEFAULT_PROMPT_CONFIG, projectId, call, log)).rejects.toThrow('deterministic validation failure');
    expect(log.mock.calls.some((c) => c[0] === 'warn' && String(c[1]).includes('[台帳破棄]'))).toBe(true);

    // Same project / input / model / prompts: must not resume from the broken cached ledger.
    const result = await normalizeSource(config, source, undefined, '', DEFAULT_PROMPT_CONFIG, projectId, call, log);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.events).toHaveLength(2);
    expect(log.mock.calls.some((c) => String(c[1]).includes('[台帳再開]'))).toBe(false);
  });

  it('keeps the cached ledger after a repair network failure so the retry resumes without a full pass', async () => {
    const projectId = crypto.randomUUID();
    // A dependency whose both ends are the same subject requires a repair call.
    const broken = ledgerFixture().replace('[共有カード]', 'R2\tdependency\tE1\tA2\tE2\tA2\tp1\t-\t-\tna\n[共有カード]');
    const replies: Array<string | Error> = [broken, new Error('network down'), '[関係]\nR2\tdependency\tE1\tA1\tE2\tA2\tp1,p2\t-\t-\tna\n[完了]'];
    const call = vi.fn<Parameters<typeof normalizeSource>[6]>(async () => {
      const next = replies.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const log = vi.fn();
    await expect(normalizeSource(config, source, undefined, '', DEFAULT_PROMPT_CONFIG, projectId, call, log)).rejects.toThrow('network down');
    const result = await normalizeSource(config, source, undefined, '', DEFAULT_PROMPT_CONFIG, projectId, call, log);
    expect(call).toHaveBeenCalledTimes(3);
    // The third call is a repair request, not a full-text normalization.
    expect(call.mock.calls[2][4]).toBe(true);
    expect(log.mock.calls.some((c) => String(c[1]).includes('[台帳再開]'))).toBe(true);
    expect(result.relations.map((r) => r.id)).toContain('R2');
  });
});
