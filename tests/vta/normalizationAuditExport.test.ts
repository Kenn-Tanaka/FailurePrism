import { describe, expect, it } from 'vitest';
import type { VTAAnalysisData } from '../../src/tools/vta/types/vta';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import {
  buildParagraphPageMap,
  calculateSourceCoverage,
  generateNormalizationAuditMarkdown,
  generateNormalizationAuditTSV,
  generateNormalizationAuditJSON,
  formatVariationFactor,
  formatOutcomeKind,
  formatEventClassification,
} from '../../src/tools/vta/features/vta/utils/normalizationAuditExport';

function createSampleAnalysis(): VTAAnalysisData {
  return {
    version: 5,
    generation: {
      runId: 'run-123',
      schemeId: 'refined-chain',
      schemeVersion: '1',
      ruleVersion: '5.0.0',
      model: 'claude-3-5-sonnet',
      promptFingerprint: 'fp-abc',
      inputFingerprint: 'inp-xyz',
    },
    sources: [
      {
        id: 'source_1',
        text: '全テキスト内容...',
        paragraphs: [
          { id: 'p1', text: '### 【PDF ページ 1/40】' },
          { id: 'p2', text: '運輸安全委員会は、令和6年1月2日に発生した事故の調査を実施した。' },
          { id: 'p3', text: '当日の気象は視程10km以上、風向320度7ktと良好であった。' },
          { id: 'p4', text: '### 【PDF ページ 2/40】' },
          { id: 'p5', text: 'タワー管制官は海保機に対しC-5待機を指示した。' },
          { id: 'p6', text: '海保機は不注意にも滑走路34Rへ進入した。' },
          { id: 'p7', text: '着陸中のJAL機と進入した海保機が滑走路上で衝突し、炎上した。' },
          { id: 'p8', text: '空港消防隊による消火救助活動が速やかに開始された。' },
        ],
      },
    ],
    facts: [],
    entities: [
      { id: 'ent_tower', name: '東京タワー管制官', kind: 'person', focus: 'high' },
      { id: 'ent_ja722a', name: '海保機(JA722A)', kind: 'machine', focus: 'reporter' },
      { id: 'ent_jal516', name: 'JAL516便', kind: 'machine', focus: 'high' },
    ],
    events: [
      {
        id: 'E1',
        time: '17:45:10',
        title: 'タワー管制官の待機指示',
        description: '海保機に対しC-5誘導路での待機を指示',
        classification: 'normal',
        factIds: [],
        sourceOrder: 1,
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p5' }],
        classificationReason: '標準業務手順に従った指示伝達',
      },
      {
        id: 'E2',
        time: '17:46:02',
        title: '滑走路への進入',
        description: '海保機が停止位置を越えて滑走路34Rに進入',
        classification: 'variation',
        factIds: [],
        sourceOrder: 2,
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p6' }],
        classificationReason: '待機指示からの逸脱',
        variationFactor: {
          category: 'departure',
          polarity: 'negative',
          cognitiveLevel: 'rule',
          description: '待機指示の取り違えによる通常作業からの逸脱',
        },
      },
      {
        id: 'E3',
        time: '17:47:20',
        title: '航空機衝突',
        description: '滑走路上で2機が衝突し火災発生',
        classification: 'outcome',
        outcome_kind: 'loss',
        factIds: [],
        sourceOrder: 3,
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p7' }],
        classificationReason: '衝突および火災による機体全損',
      },
    ],
    participations: [
      {
        eventId: 'E1',
        entityId: 'ent_tower',
        role: 'actor',
        factIds: [],
      },
      {
        eventId: 'E1',
        entityId: 'ent_ja722a',
        role: 'target',
        inferred: true,
        evidenceBasis: 'source-context',
        factIds: [],
      },
      {
        eventId: 'E2',
        entityId: 'ent_ja722a',
        role: 'actor',
        factIds: [],
      },
      {
        eventId: 'E3',
        entityId: 'ent_ja722a',
        role: 'actor',
        factIds: [],
      },
      {
        eventId: 'E3',
        entityId: 'ent_jal516',
        role: 'actor',
        factIds: [],
      },
    ],
    relations: [
      {
        id: 'R1',
        kind: 'dependency',
        sourceEventId: 'E1',
        sourceEntityId: 'ent_tower',
        targetEventId: 'E2',
        targetEntityId: 'ent_ja722a',
        sourceRefs: [
          { sourceId: 'source_1', paragraphId: 'p5' },
          { sourceId: 'source_1', paragraphId: 'p6' },
        ],
        explanation: '待機指示の完了前に次工程が着手された',
        factIds: [],
      },
    ],
    cards: [
      { id: 'c1', laneEntityId: 'ent_tower', eventIds: ['E1'] },
      { id: 'c2', laneEntityId: 'ent_ja722a', eventIds: ['E2', 'E3'] },
      { id: 'c3', laneEntityId: 'ent_jal516', eventIds: ['E3'] },
    ],
    unassignedEventIds: [],
    dispositions: [
      {
        id: 'D1',
        kind: 'background',
        text: '当日の気象は視程10km以上、風向320度7ktと良好であった。',
        reason: '事故発生時の背景環境データ',
        sourceId: 'source_1',
        paragraphId: 'p3',
        quote: '',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }],
      },
    ],
    normalizationAudit: {
      version: 1,
      corrections: [
        {
          id: 'A1',
          kind: 'alias_unification',
          from: 'C滑走路',
          to: '滑走路34R(C)',
          reason: '正式呼称へ統一',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p5' }],
          detectedBy: 'llm',
        },
      ],
      subjectiveNotices: [
        {
          id: 'N1',
          phrase: '不注意にも',
          treatment: 'evaluative_word_removed',
          eventIds: ['E2'],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p6' }],
          detectedBy: 'both',
        },
      ],
    },
  };
}

describe('normalizationAuditExport - Post-normalization audit report generator', () => {
  it('correctly maps paragraphs to PDF pages based on page delimiter tags', () => {
    const analysis = createSampleAnalysis();
    const pageMap = buildParagraphPageMap(analysis.sources);

    // p1 is page header for 1
    expect(pageMap.get('p1')).toBe(1);
    expect(pageMap.get('p2')).toBe(1);
    expect(pageMap.get('p3')).toBe(1);

    // p4 is page header for 2
    expect(pageMap.get('p4')).toBe(2);
    expect(pageMap.get('p5')).toBe(2);
    expect(pageMap.get('p6')).toBe(2);
    expect(pageMap.get('p7')).toBe(2);
    expect(pageMap.get('p8')).toBe(2);
  });

  it('calculates source coverage and accurately detects unreferenced paragraphs', () => {
    const analysis = createSampleAnalysis();
    const stats = calculateSourceCoverage(analysis);

    // Total paragraphs = 8 (p1 to p8)
    // Structural delimiters = 2 (p1 and p4)
    // Body paragraphs = 6 (p2, p3, p5, p6, p7, p8)
    // Referenced:
    // - p3 is used by disposition D1
    // - p5 is used by E1 and A1
    // - p6 is used by E2 and N1
    // - p7 is used by E3
    // Unreferenced: p2, p8 (2 paragraphs)
    expect(stats.totalParagraphs).toBe(8);
    expect(stats.bodyParagraphsCount).toBe(6);
    expect(stats.referencedBodyCount).toBe(4);
    expect(stats.unreferencedCount).toBe(2);
    expect(stats.coverageRate).toBeCloseTo((4 / 6) * 100, 1);

    const unrefIds = stats.unreferencedUsages.map((u) => u.paragraphId);
    expect(unrefIds).toContain('p2');
    expect(unrefIds).toContain('p8');
    expect(unrefIds).not.toContain('p3');
    expect(unrefIds).not.toContain('p5');
  });

  it('formats variation factors and outcome kinds correctly', () => {
    expect(
      formatVariationFactor({
        category: 'departure',
        polarity: 'negative',
        cognitiveLevel: 'rule',
        description: '手順からの逸脱',
      })
    ).toContain('通常作業からの逸脱 (人為的行為)');

    expect(
      formatVariationFactor({
        category: 'response',
        polarity: 'resilient',
        cognitiveLevel: 'skill',
      })
    ).toContain('【レジリエンス要因】 状態変化への応答 (Skillベース)');

    expect(formatOutcomeKind('loss')).toBe('損失発生');
    expect(formatOutcomeKind('near_miss')).toBe('直前停止');
    expect(formatOutcomeKind('recovery')).toBe('レジリエンス復帰');

    expect(formatEventClassification('outcome', 'loss')).toBe('帰結ノード (損失発生)');
    expect(formatEventClassification('variation')).toBe('変動要因');
    expect(formatEventClassification('normal')).toBe('通常作業');
  });

  it('generates exhaustive Markdown audit report with all audit sections', () => {
    const analysis = createSampleAnalysis();
    const md = generateNormalizationAuditMarkdown(analysis, {
      projectName: '羽田衝突事故検証',
      includeAuditCheckboxes: true,
      includeUnreferencedSection: true,
      includeFullCoverageMatrix: true,
    });

    // Verify Title & Meta
    expect(md).toContain('# VTA正規化処理 監査記録書（Normalization Audit Report）');
    expect(md).toContain('羽田衝突事故検証');
    expect(md).toContain('claude-3-5-sonnet');

    // Section 1: Executive Summary & Alerts
    expect(md).toContain('## 1. 監査メタデータ・全体サマリー');
    expect(md).toContain('通常作業ノード: **1** 件');
    expect(md).toContain('変動要因ノード: **1** 件');
    expect(md).toContain('帰結ノード: **1** 件');
    expect(md).toContain('AIによる文脈推論・主体の推定補完');
    expect(md).toContain('E1'); // Inferred participation in E1

    // Section 2: Normalization corrections & notices
    expect(md).toContain('## 2. 表記統一および主観・評価表現の処置記録');
    expect(md).toContain('C滑走路');
    expect(md).toContain('滑走路34R(C)');
    expect(md).toContain('不注意にも');
    expect(md).toContain('評価語を除去');

    // Section 3: Unreferenced paragraphs
    expect(md).toContain('## 3. 【要点検】原文の未参照・脱落懸念段落一覧');
    expect(md).toContain('source_1/p2');
    expect(md).toContain('source_1/p8');

    // Section 4: Events audit sheet
    expect(md).toContain('## 4. 正規化イベント台帳');
    expect(md).toContain('タワー管制官の待機指示');
    expect(md).toContain('滑走路への進入');
    expect(md).toContain('航空機衝突');
    expect(md).toContain('海保機(JA722A) [対象(客体)]⚠️[推論]');
    expect(md).toContain('[PDF P.2]'); // Verified page resolution!

    // Section 5: Entities
    expect(md).toContain('## 5. 主体（当事者・関係組織・設備）の監査記録');
    expect(md).toContain('東京タワー管制官');
    expect(md).toContain('海保機(JA722A)');

    // Section 6: Relations
    expect(md).toContain('## 6. 事象間関係・因果連鎖の監査記録');
    expect(md).toContain('作業依存');
    expect(md).toContain('E1 (東京タワー管制官)');
    expect(md).toContain('E2 (海保機(JA722A))');

    // Section 7: Dispositions
    expect(md).toContain('## 7. 背景・除外・要確認事象（Dispositions）の監査記録');
    expect(md).toContain('事故発生時の背景環境データ');

    // Section 8: Coverage matrix
    expect(md).toContain('## 8. 原文パラグラフ対照マトリクス');
    expect(md).toContain('[ ] OK'); // Audit checkboxes included
  });

  it('generates valid TSV tabular output suitable for spreadsheet audit', () => {
    const analysis = createSampleAnalysis();
    const tsv = generateNormalizationAuditTSV(analysis, {
      projectName: '羽田テスト',
      includeFullCoverageMatrix: true,
    });

    expect(tsv).toContain('### 【1. 監査メタデータ】');
    expect(tsv).toContain('### 【2. 要点検_未参照段落一覧】');
    expect(tsv).toContain('### 【3. 正規化イベント台帳】');
    expect(tsv).toContain('### 【4. 表記統一・誤字脱字補正】');
    expect(tsv).toContain('### 【5. 主観・評価表現の点検記録】');
    expect(tsv).toContain('### 【6. 主体一覧】');
    expect(tsv).toContain('### 【7. 事象間関係】');
    expect(tsv).toContain('### 【8. 背景・除外・要確認】');
    expect(tsv).toContain('### 【9. 原文全段落対照マトリクス】');

    // Columns check in Event table
    expect(tsv).toContain(
      'イベントID\t時刻\t見出し\t内容詳細\t変動区分\t変動要因詳細/帰結種別\t関与主体と役割\t原文参照\t判定根拠\t監査判定\t監査指摘メモ\t確認者'
    );
    expect(tsv).toContain('E2\t17:46:02\t滑走路への進入');
  });

  it('generates valid JSON audit trail format', () => {
    const analysis = createSampleAnalysis();
    const jsonStr = generateNormalizationAuditJSON(analysis);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.coverage.totalParagraphs).toBe(8);
    expect(parsed.coverage.unreferencedCount).toBe(2);
    expect(parsed.analysis.events).toHaveLength(3);
    expect(parsed.analysis.entities).toHaveLength(3);
  });

  it('manages modal open/close and custom analysis target in vtaStore', () => {
    const analysis = createSampleAnalysis();
    useVTAStore.getState().openNormalizationAuditExportModal(analysis);
    expect(useVTAStore.getState().isNormalizationAuditExportModalOpen).toBe(true);
    expect(useVTAStore.getState().normalizationAuditTargetAnalysis).toBe(analysis);

    useVTAStore.getState().closeNormalizationAuditExportModal();
    expect(useVTAStore.getState().isNormalizationAuditExportModalOpen).toBe(false);
    expect(useVTAStore.getState().normalizationAuditTargetAnalysis).toBeNull();
  });
});
