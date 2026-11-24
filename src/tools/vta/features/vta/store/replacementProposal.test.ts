import { describe, expect, it, beforeEach } from 'vitest';
import { useVTAStore } from './vtaStore';
import { TEST_VTA_FIXTURES, seedVTAStoreWithFixture } from '../../../../../../tests/helpers/vtaTestFixtures';
import { createManualAnalysis } from '../utils/eventAnalysis';

describe('VTA proposal invalidation on project replacement', () => {
  beforeEach(() => {
    seedVTAStoreWithFixture(0);
  });

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
      vtaData: { ...TEST_VTA_FIXTURES[0].vtaData, analysis: createManualAnalysis(TEST_VTA_FIXTURES[0].vtaData) },
      regenerationResult: null,
    }));

    expect(imported.success).toBe(true);
    expect(useVTAStore.getState().measuresProposal).toBeNull();
    expect(useVTAStore.getState().isProposalModalOpen).toBe(false);
  });
});
