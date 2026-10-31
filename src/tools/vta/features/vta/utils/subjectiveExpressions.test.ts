import { describe, expect, it } from 'vitest';
import {
  findSubjectiveExpressions, scanGeneratedText, scanSource, stripQuotedSpans,
} from './subjectiveExpressions';
import { sourceFromText } from './eventAnalysis';

describe('subjectiveExpressions', () => {
  it('detects evaluative phrases with their positions and ignores ordinary words', () => {
    const hits = findSubjectiveExpressions('機長は誤って進入した。計測誤差は小さく、責任者が確認した。');
    expect(hits.map((hit) => hit.phrase)).toEqual(['誤って']);
    expect(findSubjectiveExpressions('停止位置に進入した。')).toEqual([]);
  });

  it('records every source hit including quoted statements, once per phrase and paragraph', () => {
    const source = sourceFromText('機長は誤って誤って進入した。\n副操縦士は「勘違いしていた」と述べた。\n通常の記述。');
    const notices = scanSource(source);
    expect(notices.map((n) => [n.sourceRefs[0].paragraphId, n.phrase, n.detectedBy])).toEqual([
      ['p1', '誤って', 'app'],
      ['p2', '勘違い', 'app'],
    ]);
    expect(new Set(notices.map((n) => n.id)).size).toBe(notices.length);
  });

  it('allows evaluative words inside a quoted statement only for a claim', () => {
    const text = '副操縦士は「勘違いしていた」と供述した';
    expect(scanGeneratedText(text, 'claim')).toEqual([]);
    expect(scanGeneratedText(text, 'recorded').map((h) => h.phrase)).toEqual(['勘違い']);
    expect(scanGeneratedText('機長は誤って操作した', 'claim').map((h) => h.phrase)).toEqual(['誤って']);
  });

  it('keeps string length when stripping quotes so positions stay meaningful', () => {
    const text = 'A「xx」B『yy』C';
    expect(stripQuotedSpans(text)).toHaveLength(text.length);
    expect(stripQuotedSpans(text).replace(/　/g, '')).toBe('ABC');
  });
});
