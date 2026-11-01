import type { GenerationScheme, GenerationRequest } from '../registry';
import type { VTAAnalysisData, PromptConfig, LLMConfig } from '../../../types/vta';
import { normalizeSource, type LedgerCall, type LedgerLog } from '../fulltextLedger';

export const FULLTEXT_LEDGER_SCHEME_ID = 'fulltext-ledger';

export function createFulltextLedgerScheme(
  config: LLMConfig,
  fixedPrompts: PromptConfig,
  callLedgerStage: LedgerCall,
  logTrace: LedgerLog
): GenerationScheme {
  return {
    id: FULLTEXT_LEDGER_SCHEME_ID,
    version: '1',
    name: '全文正規化・TSV台帳方式',
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
