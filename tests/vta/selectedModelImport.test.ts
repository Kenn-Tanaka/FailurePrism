import { beforeEach, describe, expect, it } from 'vitest';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import {
  buildAnalysis,
  projectAnalysis,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';

const createValidProjectJSON = (selectedModel?: string) => {
  const source = sourceFromText('09:00 開始した。');
  const facts = validateFacts({
    facts: [
      { id: 'f1', text: '開始した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 開始した。' }] },
    ],
  }, [source]);
  const events = validateEvents({
    events: [
      { id: 'e1', title: '開始', description: '開始した', time: '09:00', factIds: ['f1'] },
    ],
  }, facts);
  const parsed = validateParticipants({
    entities: [{ id: 'ent_1', name: '担当者', kind: 'person' }],
    participations: [{ eventId: 'e1', entityId: 'ent_1', role: 'actor', factIds: ['f1'] }],
    relations: [],
    cardGroups: [],
  }, events, facts);
  const analysis = buildAnalysis(source, facts, events, parsed);
  const schema = projectAnalysis(analysis);

  return JSON.stringify({
    version: '5.0',
    savedAt: new Date().toISOString(),
    scenarioText: '09:00 開始した。',
    vtaData: schema,
    ...(selectedModel !== undefined ? { selectedModel } : {}),
  });
};

describe('Issue 3 Regression: Selected model restoration on project import', () => {
  beforeEach(() => {
    useVTAStore.setState({
      llmConfig: {
        baseUrl: 'https://custom-gateway.local/v1',
        gatewayToken: 'gw-secret-xyz',
        selectedModel: 'initial-model-original',
        timeoutSeconds: 45,
      },
      past: [],
      future: [],
    });
  });

  it('restores selectedModel from imported project while preserving other connection settings', () => {
    const json = createValidProjectJSON('imported-custom-model-v2');
    const res = useVTAStore.getState().importProjectJSON(json);

    expect(res.success).toBe(true);
    const currentConfig = useVTAStore.getState().llmConfig;

    // selectedModel が復元されていること
    expect(currentConfig.selectedModel).toBe('imported-custom-model-v2');

    // 他の接続設定が保持されていること
    expect(currentConfig.baseUrl).toBe('https://custom-gateway.local/v1');
    expect(currentConfig.gatewayToken).toBe('gw-secret-xyz');
    expect(currentConfig.timeoutSeconds).toBe(45);
  });

  it('preserves current selectedModel when imported project has no selectedModel field', () => {
    const json = createValidProjectJSON(undefined);
    const res = useVTAStore.getState().importProjectJSON(json);

    expect(res.success).toBe(true);
    const currentConfig = useVTAStore.getState().llmConfig;
    expect(currentConfig.selectedModel).toBe('initial-model-original');
  });

  it('preserves current selectedModel when imported project has empty or whitespace selectedModel', () => {
    const jsonEmpty = createValidProjectJSON('');
    const resEmpty = useVTAStore.getState().importProjectJSON(jsonEmpty);
    expect(resEmpty.success).toBe(true);
    expect(useVTAStore.getState().llmConfig.selectedModel).toBe('initial-model-original');

    const jsonWhitespace = createValidProjectJSON('   ');
    const resWhitespace = useVTAStore.getState().importProjectJSON(jsonWhitespace);
    expect(resWhitespace.success).toBe(true);
    expect(useVTAStore.getState().llmConfig.selectedModel).toBe('initial-model-original');
  });

  it('does not alter current model or connection settings when import fails with invalid project', () => {
    const invalidJson = '{ "version": "5.0", "vtaData": { "nodes": "not-an-array" } }';
    const res = useVTAStore.getState().importProjectJSON(invalidJson);

    expect(res.success).toBe(false);
    const currentConfig = useVTAStore.getState().llmConfig;
    expect(currentConfig.selectedModel).toBe('initial-model-original');
    expect(currentConfig.baseUrl).toBe('https://custom-gateway.local/v1');
    expect(currentConfig.gatewayToken).toBe('gw-secret-xyz');
    expect(currentConfig.timeoutSeconds).toBe(45);
  });
});
