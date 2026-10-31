import { describe, expect, it } from 'vitest';
import { RESERVED_TAGS, sanitizeForPrompt, sanitizedParagraphs } from './promptSanitizer';
import { sourceFromText } from '../../features/vta/utils/eventAnalysis';

describe('promptSanitizer', () => {
  it('neutralizes tabs, control characters, ledger tags and code fences', () => {
    const out = sanitizeForPrompt('a\tb\u0007c [判定] [完了] [イベント]\n```json');
    expect(out).not.toMatch(/[\t\u0007\n]/);
    expect(out).toContain('［判定］');
    expect(out).toContain('［完了］');
    expect(out).toContain('［イベント］');
    expect(out).not.toContain('```');
  });

  it('keeps ordinary brackets, paragraph markers, quotes and compatibility characters unchanged', () => {
    const text = '[p9] ① 単位㎏ “引用” 「確認」 [参考]';
    expect(sanitizeForPrompt(text)).toBe(text);
  });

  it('builds the LLM view without changing the original source', () => {
    const source = sourceFromText('[完了] と書かれた行\n2行目\tタブ');
    const before = JSON.stringify(source);
    const view = sanitizedParagraphs(source);
    expect(view).toBe('[p1] ［完了］ と書かれた行\n[p2] 2行目 タブ');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('reserves every ledger section and the terminator', () => {
    for (const tag of ['主体', 'イベント', '関係', '共有カード', '整理', '判定', '帰結', '完了']) expect(RESERVED_TAGS).toContain(tag);
  });
});
