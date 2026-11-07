/**
 * Shared retry utilities for OpenAI-compatible LLM Gateway communication.
 */

export const RETRYABLE_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parses a standard HTTP `Retry-After` header value (either delay-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(10, Math.ceil(seconds * 1000)));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const deltaMs = dateMs - nowMs;
    if (deltaMs > 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(10, deltaMs));
    }
  }
  return undefined;
}

export interface RetryableErrorCheckOptions {
  allowInterruptedStreamRetry?: boolean;
}

export function isRetryableGatewayError(
  err: unknown,
  statusCode?: number,
  options: RetryableErrorCheckOptions = {}
): boolean {
  if (statusCode !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) {
    return true;
  }
  if (err instanceof Error) {
    if (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED' || err.name === 'AbortError') {
      return false;
    }
    if (
      err.name === 'TypeError' ||
      err.message.includes('Failed to fetch') ||
      err.message.includes('network')
    ) {
      return true;
    }
    if (
      options.allowInterruptedStreamRetry &&
      err.message.includes('LLMストリームが正常終了通知なしで切断されました')
    ) {
      return true;
    }
  }
  return false;
}

export function computeRetryDelayMs(
  attempt: number,
  retryBaseDelayMs = 1200,
  retryAfterMs?: number
): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.round(retryBaseDelayMs * Math.pow(2, attempt) * jitter);
}

export async function waitForRetryBackoff(
  delayMs: number,
  externalSignal?: AbortSignal,
  createAbortError: () => Error = () => new DOMException('The operation was aborted.', 'AbortError')
): Promise<void> {
  if (externalSignal?.aborted) {
    throw createAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
  });
}
