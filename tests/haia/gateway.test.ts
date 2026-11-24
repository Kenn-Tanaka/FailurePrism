import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generate } from '../../src/tools/haia/gateway';

const request = { model: 'fixture', system: '', input: '', temperature: 0.1, timeout: 1 };
const encoder = new TextEncoder();

function streamResponse(signal: AbortSignal, contentType = 'text/event-stream') {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
      signal.addEventListener('abort', () => body.error(signal.reason), { once: true });
    },
  });
  return {
    response: new Response(stream, { headers: { 'Content-Type': contentType } }),
    send: (text: string) => body.enqueue(encoder.encode(text)),
    end: () => body.close(),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HAIA LLM inactivity timeout', () => {
  it('keeps receiving when partial SSE events and keep-alives arrive within the timeout', async () => {
    let stream!: ReturnType<typeof streamResponse>;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      stream = streamResponse(init.signal!);
      return stream.response;
    });
    const onChunk = vi.fn();
    const outcome = expect(generate(request, '', new AbortController().signal, onChunk)).resolves.toBe('回答');
    await vi.advanceTimersByTimeAsync(750);
    stream.send('data: {"choices":[{"delta":{"content":"回');
    await vi.advanceTimersByTimeAsync(750);
    stream.send('答"}}]}\n\n');
    await vi.advanceTimersByTimeAsync(750);
    stream.send(': keep-alive\n\n');
    await vi.advanceTimersByTimeAsync(750);
    stream.send('data: [DONE]\n\n');
    await outcome;
    expect(onChunk.mock.calls).toEqual([['回答']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out one interval after the last bytes of a stalled response', async () => {
    let stream!: ReturnType<typeof streamResponse>;
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      stream = streamResponse(signal);
      return stream.response;
    });
    const onChunk = vi.fn();
    const outcome = expect(generate(request, '', new AbortController().signal, onChunk)).rejects.toThrow('タイムアウトしました（1秒）。');
    await vi.advanceTimersByTimeAsync(750);
    stream.send('data: {"choices":[{"delta":{"content":"途中"}}]}\n\n');
    await vi.advanceTimersByTimeAsync(999);
    expect(onChunk).toHaveBeenCalledWith('途中');
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it('starts the timeout when sending the request even if no response headers arrive', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const outcome = expect(generate(request, '', new AbortController().signal, vi.fn())).rejects.toThrow('タイムアウトしました（1秒）。');
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });

  it('gives a retried request its own timeout after the retry wait', async () => {
    let stream!: ReturnType<typeof streamResponse>;
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        stream = streamResponse(init.signal!, 'application/json');
        return stream.response;
      });
    vi.stubGlobal('fetch', fetch);
    const outcome = expect(generate(request, '', new AbortController().signal, vi.fn())).resolves.toBe('回答');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(751);
    expect(fetch).toHaveBeenCalledTimes(2);
    stream.send('{"choices":[{"message":');
    await vi.advanceTimersByTimeAsync(750);
    stream.send('{"content":"回答"}}]}');
    stream.end();
    await outcome;
  });
});
