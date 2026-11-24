import { parseSseStream } from '../../shared/llm/sseParser';
import { computeRetryDelayMs, isRetryableGatewayError, parseRetryAfterMs, waitForRetryBackoff } from '../../shared/llm/retry';

export interface Generation {
  model: string;
  system: string;
  input: string;
  temperature: number;
  timeout: number;
}

export function withTimeout(signal: AbortSignal, seconds: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const abort = () => {
    clearTimeout(timer);
    controller.abort(signal.reason);
  };
  const reset = () => {
    if (closed || controller.signal.aborted || seconds <= 0) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error('タイムアウトしました（' + seconds + '秒）。')),
      Math.min(seconds * 1000, 2_147_483_647),
    );
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  reset();
  return {
    signal: controller.signal,
    reset,
    close: () => {
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}

export async function generate(
  request: Generation,
  token: string,
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const body = JSON.stringify({
    model: request.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.input },
    ],
    temperature: request.temperature,
    stream: true,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token.trim()) headers.Authorization = 'Bearer ' + token.trim();

  for (let attempt = 0; ; attempt++) {
    const timed = withTimeout(signal, request.timeout);
    let retryDelay: number;
    try {
      timed.signal.throwIfAborted();
      const response = await fetch('/v1/chat/completions', {
        method: 'POST', headers, body, signal: timed.signal, redirect: 'error',
      });
      timed.reset();
      const received = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (chunk.byteLength > 0) timed.reset();
          controller.enqueue(chunk);
        },
      }));
      if (!response.ok) {
        // Retry explicit transient status codes before any text is emitted.
        const detail = await new Response(received).text();
        let message = '';
        try { message = JSON.parse(detail).error?.message ?? ''; } catch { /* Response may be plain text. */ }
        const error = new Error('Gateway HTTP ' + response.status + (message ? ': ' + message : ''));
        if (attempt >= 2 || !isRetryableGatewayError(error, response.status)) throw error;
        retryDelay = Math.min(computeRetryDelayMs(attempt + 1, 800, parseRetryAfterMs(response.headers.get('Retry-After'))), 30_000);
      } else if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
        if (!received) throw new Error('Gateway のストリームに本文がありません。');
        let output = '';
        try {
          for await (const chunk of parseSseStream(received.getReader(), timed.signal)) {
            if (chunk.content) {
              output += chunk.content;
              onChunk(chunk.content);
            }
          }
          return output;
        } finally {
          // The parser can finish at [DONE] before the response body closes.
          void received.cancel().catch(() => {});
        }
      } else {
        const value = await new Response(received).json();
        const output = value?.choices?.[0]?.message?.content;
        if (typeof output !== 'string') throw new Error('Gateway 応答に本文がありません。');
        onChunk(output);
        return output;
      }
    } catch (error) {
      timed.signal.throwIfAborted();
      throw error;
    } finally {
      timed.close();
    }
    await waitForRetryBackoff(retryDelay, signal, () => signal.reason);
  }
}
