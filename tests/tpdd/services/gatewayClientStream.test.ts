import { describe, expect, it, vi } from 'vitest';
import { gatewayClient } from '../../../src/tools/tpdd/services/llm/gatewayClient';

const options = { modelId: 'test/model', messages: [], temperature: null, timeoutSeconds: 30, stream: true };
const connection = { apiBaseUrl: '/v1', authEnabled: false };

describe('Gateway streaming completion validation', () => {
  it('rejects an upstream error even when a JSON-looking content chunk arrived first', async () => {
    const events = [
      { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: null }] },
      { error: { message: 'upstream failed' } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(events, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    try {
      await expect(gatewayClient.complete(connection, options)).rejects.toThrow('upstream failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects EOF without DONE or an explicit finish reason', async () => {
    const event = { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    try {
      await expect(gatewayClient.complete(connection, options)).rejects.toThrow('正常終了通知なし');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
