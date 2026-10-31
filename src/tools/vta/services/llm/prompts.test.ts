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
    
    // This check must never overwrite the product configuration.

    const readConfig = JSON.parse(fs.readFileSync(promptsJsonPath, 'utf-8'));
    expect(readConfig.version).toBe(DEFAULT_PROMPT_CONFIG.version);
    expect(readConfig.normalization).toEqual(DEFAULT_PROMPT_CONFIG.normalization);
    expect(readConfig.extraction.systemPrompt).toBe(DEFAULT_PROMPT_CONFIG.extraction.systemPrompt);
    expect(readConfig.reportGeneration.systemPrompt).toBe(DEFAULT_PROMPT_CONFIG.reportGeneration?.systemPrompt);
    expect(readConfig.flowGeneration.systemPrompt).toBe(DEFAULT_PROMPT_CONFIG.flowGeneration?.systemPrompt);
    expect(readConfig.connectionProposal).toEqual(DEFAULT_PROMPT_CONFIG.connectionProposal);
  });

  it('should use event-ledger-14 with 6-column subject header, SUBJECT_FOCUS_POLICY, FACTUALITY_POLICY, and AUDIT_SECTIONS_POLICY in normalization prompt', async () => {
    const { EVENT_PIPELINE_PROMPTS, EVENT_PIPELINE_PROMPT_VERSION, SUBJECT_FOCUS_POLICY, AUDIT_SECTIONS_POLICY } = await import('./eventPrompts');
    const { FACTUALITY_POLICY } = await import('./factualityPolicy');
    expect(EVENT_PIPELINE_PROMPT_VERSION).toBe('event-ledger-14');
    const norm = EVENT_PIPELINE_PROMPTS.normalization;
    expect(norm.systemPrompt).toContain('ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠');
    expect(norm.systemPrompt).toContain(SUBJECT_FOCUS_POLICY);
    expect(norm.systemPrompt).toContain(FACTUALITY_POLICY);
    expect(norm.systemPrompt).toContain(AUDIT_SECTIONS_POLICY);
    expect(norm.systemPrompt).toContain('reporter/high/mid/low');
  });
});

