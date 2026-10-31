import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NormalizationAuditPanel,
  formatNormalizationAuditMarkdown,
  formatNormalizationAuditJSON,
} from './NormalizationAuditPanel';
import type { VTAAnalysisData } from '../../types/vta';

function baseAnalysis(withAudit: boolean): VTAAnalysisData {
  return {
    version: 5,
    sources: [
      {
        id: 'source_1',
        text: 'A機長は誤ってスイッチを切った。',
        paragraphs: [{ id: 'p1', text: 'A機長は誤ってスイッチを切った。' }],
      },
    ],
    facts: [],
    events: [
      {
        id: 'E1',
        origin: 'extraction',
        title: 'スイッチ切操作',
        description: '機長がスイッチを切った',
        time: '-',
        sourceOrder: 0,
        factIds: [],
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
        classification: 'unclassified',
        measure_type: null,
      },
    ],
    entities: [{ id: 'A1', name: '機長', kind: 'person' }],
    participations: [{ eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] }],
    relations: [],
    cards: [{ id: 'card_1', laneEntityId: 'A1', eventIds: ['E1'] }],
    unassignedEventIds: [],
    ...(withAudit
      ? {
          normalizationAudit: {
            version: 1,
            corrections: [
              {
                id: 'C1',
                kind: 'alias_unification',
                from: 'A機長',
                to: '機長',
                sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
                reason: '同一人物の呼称統一',
                detectedBy: 'llm',
              },
            ],
            subjectiveNotices: [
              {
                id: 'S1',
                sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
                phrase: '誤って',
                treatment: 'evaluative_word_removed',
                eventIds: ['E1'],
                detectedBy: 'both',
              },
            ],
            iterations: [
              {
                index: 0,
                score: 0.85,
                metrics: { c1: 0.9, c3: 0.8, c5: 0.85 },
                gateViolations: [],
                operations: ['initial_consolidation'],
                adopted: true,
              },
            ],
          },
        }
      : {}),
  };
}

describe('NormalizationAuditPanel', () => {
  it('renders fallback notice when normalizationAudit is absent (legacy project)', () => {
    const html = renderToStaticMarkup(<NormalizationAuditPanel analysis={baseAnalysis(false)} />);
    expect(html).toContain('記録なし（旧形式または記録未生成）');
  });

  it('renders corrections, subjective notices, and iteration history when present, and formats Markdown/JSON appendix', () => {
    const analysis = baseAnalysis(true);
    const html = renderToStaticMarkup(<NormalizationAuditPanel analysis={analysis} />);
    expect(html).toContain('「A機長」 → 「機長」');
    expect(html).toContain('語句：「誤って」');
    expect(html).toContain('反復 #0 — 総合スコア S: 0.850');

    const md = formatNormalizationAuditMarkdown(analysis.normalizationAudit);
    expect(md).toContain('## 付録：入力正規化・主観表現点検・粒度評価の記録');
    expect(md).toContain('| C1 | 表記統一 | A機長 | 機長 |');
    expect(md).toContain('| S1 | 誤って |');

    const json = JSON.parse(formatNormalizationAuditJSON(analysis.normalizationAudit));
    expect(json.version).toBe(1);
    expect(json.corrections).toHaveLength(1);
    expect(json.subjectiveNotices).toHaveLength(1);
  });
});
