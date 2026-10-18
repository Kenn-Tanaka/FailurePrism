import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROMPT_CONFIG,
  buildExtractionUserPrompt,
  buildRegenerationUserPrompt,
  buildProposalUserPrompt,
  buildFlowGenerationUserPrompt,
  buildReportGenerationUserPrompt,
} from './prompts';
import { VTASchema, PromptConfig } from '../../types/vta';

describe('prompts.ts - Dynamic LLM Prompt Builder', () => {
  const sampleScenario = 'テスト用の事故シナリオテキストです。';
  const sampleVta: VTASchema = {
    lanes: ['開発部'],
    nodes: [
      {
        id: 'node_1',
        lane: '開発部',
        time: '10:00',
        title: '作業エラー',
        description: '手順を誤った',
        type: 'variation',
        measure_type: 'elimination',
      },
    ],
    edges: [],
  };

  it('should substitute {scenarioText} in extraction prompt', () => {
    const prompt = buildExtractionUserPrompt(sampleScenario);
    expect(prompt).toContain(sampleScenario);
    expect(prompt).not.toContain('{scenarioText}');
  });

  it('should substitute {scenarioText} and {vtaDataJson} in regeneration prompt', () => {
    const prompt = buildRegenerationUserPrompt(sampleScenario, sampleVta);
    expect(prompt).toContain(sampleScenario);
    expect(prompt).toContain('node_1');
    expect(prompt).toContain('作業エラー');
    expect(prompt).not.toContain('{scenarioText}');
    expect(prompt).not.toContain('{vtaDataJson}');
  });

  it('should substitute {scenarioText} and {vtaDataJson} in proposal prompt', () => {
    const prompt = buildProposalUserPrompt(sampleScenario, sampleVta);
    expect(prompt).toContain(sampleScenario);
    expect(prompt).toContain('node_1');
    expect(prompt).not.toContain('{scenarioText}');
    expect(prompt).not.toContain('{vtaDataJson}');
  });

  it('should substitute {scenarioText} and {vtaDataJson} in flowGeneration prompt', () => {
    const prompt = buildFlowGenerationUserPrompt(sampleScenario, sampleVta);
    expect(prompt).toContain(sampleScenario);
    expect(prompt).toContain('node_1');
    expect(prompt).toContain('作業エラー');
    expect(prompt).not.toContain('{scenarioText}');
    expect(prompt).not.toContain('{vtaDataJson}');
  });

  it('should include scenarioText and extracted analysis points, but exclude improvedFlowText in reportGeneration prompt', () => {
    const sampleFlow = '### 改善された業務フロー\n手順1: 安全確認の徹底';
    // Even if sampleFlow is passed for backward compatibility, it must be excluded
    const prompt = buildReportGenerationUserPrompt(sampleScenario, sampleVta, sampleFlow);
    expect(prompt).toContain(sampleScenario);
    expect(prompt).toContain('node_1');
    expect(prompt).toContain('作業エラー');
    expect(prompt).toContain('排除ノード一覧');
    expect(prompt).not.toContain(sampleFlow);
    expect(prompt).not.toContain('{scenarioText}');
    expect(prompt).not.toContain('{reportAnalysisData}');
    expect(prompt).not.toContain('{improvedFlowText}');
  });

  it('should use custom prompt template when provided', () => {
    const customConfig: PromptConfig = {
      version: '2.0.0',
      extraction: {
        systemPrompt: 'Custom System Prompt',
        userPromptTemplate: 'カスタム指示: {scenarioText} 以上',
      },
      regeneration: DEFAULT_PROMPT_CONFIG.regeneration,
      proposal: DEFAULT_PROMPT_CONFIG.proposal,
    };

    const prompt = buildExtractionUserPrompt(sampleScenario, customConfig);
    expect(prompt).toBe('カスタム指示: テスト用の事故シナリオテキストです。 以上');
  });

  it('should keep public/prompts.json in sync with DEFAULT_PROMPT_CONFIG', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const promptsJsonPath = path.resolve(__dirname, '../../../../../public/prompts.json');
    
    // Write the latest config to public/prompts.json
    fs.writeFileSync(promptsJsonPath, JSON.stringify(DEFAULT_PROMPT_CONFIG, null, 2) + '\n', 'utf-8');

    const readConfig = JSON.parse(fs.readFileSync(promptsJsonPath, 'utf-8'));
    expect(readConfig.version).toBe(DEFAULT_PROMPT_CONFIG.version);
    expect(readConfig.extraction.systemPrompt).toBe(DEFAULT_PROMPT_CONFIG.extraction.systemPrompt);
    expect(readConfig.reportGeneration.systemPrompt).toBe(DEFAULT_PROMPT_CONFIG.reportGeneration?.systemPrompt);
    expect(readConfig.flowGeneration.systemPrompt).toBe(DEFAULT_PROMPT_CONFIG.flowGeneration?.systemPrompt);
  });
});

