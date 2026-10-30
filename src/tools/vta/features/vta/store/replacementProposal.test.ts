import { describe, expect, it, beforeEach } from 'vitest';
import { useVTAStore } from './vtaStore';
import { SAMPLE_SCENARIOS } from '../data/sampleData';
import { createManualAnalysis } from '../utils/eventAnalysis';

describe('VTA proposal invalidation on project replacement', () => {
  beforeEach(() => useVTAStore.getState().loadSample(SAMPLE_SCENARIOS[0].id));

  it('clears an existing measures proposal and closes its modal after project import', () => {
    const store = useVTAStore.getState();
    const proposal = {
      summary: '旧プロジェクト向け',
      eliminationProposals: [],
      breakProposals: [],
      generatedAt: new Date().toISOString(),
    };
    store.setMeasuresProposal(proposal);
    store.setIsProposalModalOpen(true);

    const imported = store.importProjectJSON(JSON.stringify({
      version: '5.0',
      savedAt: new Date().toISOString(),
      scenarioText: '別プロジェクト',
      vtaData: { ...SAMPLE_SCENARIOS[0].vtaData, analysis: createManualAnalysis(SAMPLE_SCENARIOS[0].vtaData) },
      regenerationResult: null,
    }));

    expect(imported.success).toBe(true);
    expect(useVTAStore.getState().measuresProposal).toBeNull();
    expect(useVTAStore.getState().isProposalModalOpen).toBe(false);
  });
});
