import { describe, expect, it } from 'vitest';
import { validateRequirementReportResponse } from '../../../src/tools/tpdd/services/llm/aiSchemas';

const context = {
  rootNodeRef: 'N1',
  nodeRefs: new Set(['N1', 'N2']),
  edgesByRef: new Map([
    ['E1', { kind: 'decomposition', sourceNodeRef: 'N1', targetNodeRef: 'N2' }],
    ['E2', { kind: 'dependency', sourceNodeRef: 'N1', targetNodeRef: 'N2' }],
  ]),
};

describe('validateRequirementReportResponse', () => {
  it('keeps evidence-backed statements and resolves edge endpoints into node citations', () => {
    const result = validateRequirementReportResponse({
      sections: [{
        id: 'breakdown',
        statements: [{
          text: '起点ノードは機能要素へ分解されています。',
          nodeRefs: [],
          edgeRefs: ['e1'],
        }],
      }],
    }, context);

    expect(result.valid).toBe(true);
    expect(result.data?.sections[0].statements[0]).toEqual({
      text: '起点ノードは機能要素へ分解されています。',
      nodeRefs: ['N1', 'N2'],
      edgeRefs: ['E1'],
    });
  });

  it('requires the requirement statement itself to cite the selected root', () => {
    const result = validateRequirementReportResponse({
      sections: [{
        id: 'requirement',
        statements: [{
          text: '起点の要求です。',
          nodeRefs: [],
          edgeRefs: ['E1'],
        }],
      }],
    }, context);

    expect(result.valid).toBe(true);
    expect(result.data?.sections).toEqual([]);
    expect(result.warnings).toContain('起点要求を根拠に含まない説明文を除外しました。');
  });

  it('drops breakdown claims without a decomposition edge and claims with unknown references', () => {
    const result = validateRequirementReportResponse({
      sections: [{
        id: 'breakdown',
        statements: [
          { text: '分解されています。', nodeRefs: ['N1', 'N2'], edgeRefs: ['E2'] },
          { text: 'さらに分解されています。', nodeRefs: ['N1'], edgeRefs: ['E99'] },
        ],
      }],
    }, context);

    expect(result.valid).toBe(true);
    expect(result.data?.sections).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('rejects malformed output instead of passing it through as report text', () => {
    const result = validateRequirementReportResponse({ sections: 'free-form text' }, context);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('形式');
  });
});
