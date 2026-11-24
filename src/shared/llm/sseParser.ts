/**
 * Server-Sent Events (SSE) Parser for OpenAI-compatible LLM Gateway streaming responses.
 *
 * Handles:
 * - UTF-8 multi-byte characters split across chunk boundaries (via TextDecoder({ stream: true }))
 * - Multiple SSE events in a single network chunk
 * - A single SSE event split across multiple network chunks
 * - Both LF (\n) and CRLF (\r\n) line terminators
 * - "data: [DONE]" termination signal
 * - JSON delta content extraction (choices[0].delta.content)
 */

export interface SseDeltaChunk {
  content: string;
  reasoning?: string;
  finishReason?: string | null;
  streamComplete?: boolean;
  rawJson?: unknown;
}

function extractReasoningDelta(choice: unknown): string {
  if (!choice || typeof choice !== 'object') return '';
  const delta = (choice as { delta?: Record<string, unknown> }).delta;
  if (!delta || typeof delta !== 'object') return '';
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
  return '';
}

/**
 * Parses an SSE stream from a ReadableStreamDefaultReader.
 * Yields content chunks as they arrive.
 */
export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseDeltaChunk, void, unknown> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawDone = false;
  let sawFinishReason = false;

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      const { done, value } = await reader.read();
      if (done) {
        // Flush remaining buffer
        buffer += decoder.decode(new Uint8Array(), { stream: false });
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines (supports CRLF and LF)
      // SSE lines are delimited by \n or \r\n
      let lineEndIndex: number;
      while ((lineEndIndex = findLineBreak(buffer)) !== -1) {
        const line = buffer.slice(0, lineEndIndex);
        const breakLen = buffer[lineEndIndex] === '\r' && buffer[lineEndIndex + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(lineEndIndex + breakLen);

        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith(':')) {
          // Empty line (SSE event separator) or SSE comment/keepalive
          continue;
        }

        if (trimmedLine.startsWith('data:')) {
          const dataStr = trimmedLine.slice(5).trim();

          if (dataStr === '[DONE]') {
            sawDone = true;
            yield { content: '', streamComplete: true };
            return;
          }

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed?.error) {
              const message = typeof parsed.error.message === 'string'
                ? parsed.error.message
                : JSON.stringify(parsed.error);
              throw new Error(`LLMストリームエラー: ${message}`);
            }
            const choice = parsed.choices?.[0];
            const content = choice?.delta?.content;
            const reasoning = extractReasoningDelta(choice);
            const finishReason = choice?.finish_reason ?? null;
            if (finishReason) sawFinishReason = true;

            if (content || reasoning || finishReason) {
              yield {
                content: content || '',
                ...(reasoning ? { reasoning } : {}),
                finishReason,
                rawJson: parsed,
              };
            }
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('LLMストリームエラー:')) {
              throw error;
            }
            // Non-JSON or malformed data line, skip or ignore per SSE spec
          }
        }
      }
    }

    // Process any remaining data in buffer after stream ends
    if (buffer.trim().startsWith('data:')) {
      const dataStr = buffer.trim().slice(5).trim();
      if (dataStr === '[DONE]') {
        sawDone = true;
        yield { content: '', streamComplete: true };
      } else {
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed?.error) {
            const message = typeof parsed.error.message === 'string'
              ? parsed.error.message
              : JSON.stringify(parsed.error);
            throw new Error(`LLMストリームエラー: ${message}`);
          }
          const choice = parsed.choices?.[0];
          const content = choice?.delta?.content;
          const reasoning = extractReasoningDelta(choice);
          const finishReason = choice?.finish_reason ?? null;
          if (finishReason) sawFinishReason = true;
          if (content || reasoning || finishReason) {
            yield {
              content: content || '',
              ...(reasoning ? { reasoning } : {}),
              finishReason,
              rawJson: parsed,
            };
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('LLMストリームエラー:')) {
            throw error;
          }
          // Ignore trailing incomplete JSON
        }
      }
    }

    if (!sawDone && !sawFinishReason) {
      throw new Error('LLMストリームが正常終了通知なしで切断されました。');
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore if lock release fails
    }
  }
}

/**
 * Finds index of first \r\n or \n or \r
 */
function findLineBreak(str: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\n' || str[i] === '\r') {
      return i;
    }
  }
  return -1;
}
