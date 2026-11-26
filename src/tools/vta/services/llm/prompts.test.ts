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

  it('should use event-ledger-25 with multi-axis Poset, pure upper hubs, man-machine composite subjects, explicit before ordering, affected-vs-target role contract, and post-loss stop non-recovery scope in normalization & preliminary prompts', async () => {
    const {
      EVENT_PIPELINE_PROMPTS,
      EVENT_PIPELINE_PROMPT_VERSION,
      PRELIMINARY_CLASSIFICATION_PROMPT,
      SUBJECT_FOCUS_POLICY,
      AUDIT_SECTIONS_POLICY,
      AUDIT_SECTIONS_WITHOUT_PRELIMINARY_POLICY,
      compileNormalizationSystemPrompt,
    } = await import('./eventPrompts');
    const { FACTUALITY_POLICY } = await import('./factualityPolicy');
    expect(EVENT_PIPELINE_PROMPT_VERSION).toBe('event-ledger-25');
    expect(PRELIMINARY_CLASSIFICATION_PROMPT).toContain('非常停止・緊急制動・電源遮断・通報等の事後停止操作は outcome:* に昇格させず');
    const norm = EVENT_PIPELINE_PROMPTS.normalization;
    expect(norm.systemPrompt).not.toContain('（またはその上位組織ID）');
    expect(norm.systemPrompt).toContain('同一主体ID同士の dependency は禁止');
    expect(norm.systemPrompt).toContain('必ず[関係]のbefore行で実際の発生順序を明示する');
    expect(norm.systemPrompt).toContain('人員派遣・配置・委託・通常指示の対象主体にはaffectedではなくtarget');
    expect(norm.systemPrompt).toContain('半順序集合 / Poset');
    expect(norm.systemPrompt).toContain('雇用・組織軸');
    expect(norm.systemPrompt).toContain('現場編成・職能軸');
    expect(norm.systemPrompt).toContain('人間-機械系（操縦・操作単位）軸');
    expect(norm.systemPrompt).toContain('【重要：構成員既出グループの純粋上位ハブ化と最細粒度主体へのイベント割当】');
    expect(norm.systemPrompt).toContain('活動場所・機体・空間軸');
    expect(norm.systemPrompt).toContain('帰結・状況軸');
    expect(norm.systemPrompt).toContain('ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠');
    expect(norm.systemPrompt).toContain(SUBJECT_FOCUS_POLICY);
    expect(norm.systemPrompt).toContain(FACTUALITY_POLICY);
    expect(norm.systemPrompt).toContain(AUDIT_SECTIONS_POLICY);
    expect(norm.systemPrompt).toContain('reporter/high/mid/low');
    expect(norm.systemPrompt).toContain('E2\t09:05\t停止\t装置が停止した\t-\tp2\trecorded');

    // P3 regression check: omitPreliminary: true must completely remove [仮判定] even when base prompt has AUDIT_SECTIONS_POLICY
    const compiledOmitted = compileNormalizationSystemPrompt(norm.systemPrompt, {
      includeChainDirective: true,
      omitPreliminary: true,
    });
    expect(compiledOmitted).toContain(AUDIT_SECTIONS_WITHOUT_PRELIMINARY_POLICY);
    expect(compiledOmitted).not.toContain('[仮判定]');

    // When omitPreliminary is false, [仮判定] must be retained
    const compiledRetained = compileNormalizationSystemPrompt(norm.systemPrompt, {
      includeChainDirective: true,
      omitPreliminary: false,
    });
    expect(compiledRetained).toContain('[仮判定]');
    // ADR-0076 prompt contract assertions: 10-column same-event transfer example, collective casualty reuse, and natural phenomenon next-paragraph rule
    expect(compiledRetained).toContain('R3\ttransfer\tE3\tA1\tE3\tA2\tp3\tinformation\toccurred\tconfirmed');
    expect(compiledRetained).toContain('【重要：集合的な被災・死傷記述における既存個別主体の再利用】');
    expect(compiledRetained).toContain('affected:inferred');
  });
});

