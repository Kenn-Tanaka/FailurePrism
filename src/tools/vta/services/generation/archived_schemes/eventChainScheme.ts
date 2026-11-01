import type { GenerationScheme, GenerationRequest } from '../registry';
import type { VTAAnalysisData, PromptConfig, LLMConfig } from '../../../types/vta';
import { normalizeSource, type LedgerCall, type LedgerLog } from '../fulltextLedger';

export const EVENT_CHAIN_SCHEME_ID = 'event-chain';

export function createEventChainScheme(
  config: LLMConfig,
  fixedPrompts: PromptConfig,
  callLedgerStage: LedgerCall,
  logTrace: LedgerLog
): GenerationScheme {
  return {
    id: EVENT_CHAIN_SCHEME_ID,
    version: '1',
    name: '事象連鎖方式',
    analysisVersion: 5,
    supportsPassage: true,
    async generate(request: GenerationRequest): Promise<VTAAnalysisData> {
      return normalizeSource(
        config,
        request.source,
        request.signal,
        '',
        fixedPrompts,
        request.projectId,
        callLedgerStage,
        logTrace
      );
    },
  };
}
