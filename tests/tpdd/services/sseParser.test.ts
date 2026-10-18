import { describe, it, expect } from 'vitest';
import { parseSseStream } from '../../../src/tools/tpdd/services/llm/sseParser';

function createMockStream(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read() {
      if (index < chunks.length) {
        return Promise.resolve({ done: false, value: chunks[index++] });
      }
      return Promise.resolve({ done: true, value: undefined });
    },
    releaseLock() {},
    cancel() {
      return Promise.resolve();
    },
    closed: Promise.resolve(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe('SSE Parser', () => {
  it('parses standard SSE events and terminates with [DONE]', async () => {
    const encoder = new TextEncoder();
    const streamData = [
      encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'),
      encoder.encode('data: [DONE]\n\n'),
    ];

    const reader = createMockStream(streamData);
    const collected: string[] = [];

    for await (const chunk of parseSseStream(reader)) {
      if (chunk.content) collected.push(chunk.content);
    }

    expect(collected.join('')).toBe('Hello World');
  });

  it('handles CRLF line terminators and multiple events in single chunk', async () => {
    const encoder = new TextEncoder();
    const singleChunk =
      'data: {"choices":[{"delta":{"content":"Line1"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"Line2"}}]}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';

    const reader = createMockStream([encoder.encode(singleChunk)]);
    const collected: string[] = [];

    for await (const chunk of parseSseStream(reader)) {
      if (chunk.content) collected.push(chunk.content);
    }

    expect(collected.join('')).toBe('Line1Line2');
  });

  it('handles UTF-8 multi-byte characters split across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const text = 'data: {"choices":[{"delta":{"content":"日本語テスト"}}]}\n\ndata: [DONE]\n\n';
    const allBytes = encoder.encode(text);

    // Split bytes right in the middle of a multi-byte character (e.g. index 36)
    const splitIndex = 36;
    const chunk1 = allBytes.slice(0, splitIndex);
    const chunk2 = allBytes.slice(splitIndex);

    const reader = createMockStream([chunk1, chunk2]);
    const collected: string[] = [];

    for await (const chunk of parseSseStream(reader)) {
      if (chunk.content) collected.push(chunk.content);
    }

    expect(collected.join('')).toBe('日本語テスト');
  });

  it('captures finish_reason on final chunk', async () => {
    const encoder = new TextEncoder();
    const streamData = [
      encoder.encode('data: {"choices":[{"delta":{"content":"Complete"},"finish_reason":"stop"}]}\n\n'),
      encoder.encode('data: [DONE]\n\n'),
    ];

    const reader = createMockStream(streamData);
    let lastFinishReason: string | null | undefined = null;

    for await (const chunk of parseSseStream(reader)) {
      if (chunk.finishReason) {
        lastFinishReason = chunk.finishReason;
      }
    }

    expect(lastFinishReason).toBe('stop');
  });

  it('respects AbortSignal cancellation', async () => {
    const encoder = new TextEncoder();
    const streamData = [
      encoder.encode('data: {"choices":[{"delta":{"content":"First"}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":"Second"}}]}\n\n'),
    ];

    const controller = new AbortController();
    const reader = createMockStream(streamData);

    const iterator = parseSseStream(reader, controller.signal);
    const first = await iterator.next();
    expect(first.value?.content).toBe('First');

    controller.abort();

    await expect(iterator.next()).rejects.toThrow();
  });
});
