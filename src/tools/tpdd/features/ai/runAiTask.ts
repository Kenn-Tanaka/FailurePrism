import {
  extractAndParseAiJson,
  ProposalResponse,
  ReviewResponse,
  validateProposalResponse,
  validateReviewResponse,
} from '../../services/llm/aiSchemas';
import { gatewayClient } from '../../services/llm/gatewayClient';
import {
  buildChatMessages,
  createPromptReferenceMaps,
  PromptPayload,
} from '../../services/llm/prompts';
import { LlmChatMessage, LlmConnection, LlmService } from '../../services/llm/types';

export interface RunAiTaskOptions {
  connection: LlmConnection;
  payload: PromptPayload;
  messages?: LlmChatMessage[];
  modelId: string;
  temperature: number | null;
  timeoutSeconds: number;
  stream: boolean;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  signal?: AbortSignal;
  onTextChunk?: (chunk: string) => void;
  onRetry?: (attempt: number) => void;
  client?: LlmService;
}

export type RunAiTaskResult =
  | { task: 'review'; review: ReviewResponse }
  | { task: 'expand' | 'alternatives'; proposal: ProposalResponse };

/**
 * Pure service runner for TPDD AI tasks (message building -> gateway call -> JSON extraction -> schema/reference validation).
 */
export async function runAiTask(options: RunAiTaskOptions): Promise<RunAiTaskResult> {
  const {
    connection,
    payload,
    messages = buildChatMessages(payload),
    modelId,
    temperature,
    timeoutSeconds,
    stream,
    maxRetries = 2,
    retryBaseDelayMs,
    signal,
    onTextChunk,
    onRetry,
    client = gatewayClient,
  } = options;

  const references = createPromptReferenceMaps(payload.nodeKinds, payload.diagram);
  const response = await client.complete(
    connection,
    {
      modelId,
      messages,
      temperature,
      timeoutSeconds,
      stream,
      maxRetries,
      retryBaseDelayMs,
      signal,
      onRetry,
    },
    onTextChunk
  );

  const rawJson = extractAndParseAiJson(response.content);
  if (payload.task === 'review') {
    const validated = validateReviewResponse(rawJson, {
      nodeRefToId: references.nodeRefToId,
      edgeRefToId: references.edgeRefToId,
    });
    if (!validated.valid || !validated.data) {
      throw new Error(validated.error || 'レビュー出力の検証に失敗しました。');
    }
    return { task: 'review', review: validated.data };
  }

  const validated = validateProposalResponse(rawJson, {
    kindRefToId: references.kindRefToId,
  });
  if (!validated.valid || !validated.data) {
    throw new Error(validated.error || '提案出力の検証に失敗しました。');
  }
  return { task: payload.task, proposal: validated.data };
}
