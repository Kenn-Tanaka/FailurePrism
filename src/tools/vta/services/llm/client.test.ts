import { describe, it, expect } from 'vitest';
import { cleanMarkdownResponse } from './client';

describe('client.ts - cleanMarkdownResponse and response hygiene (FUNC-002)', () => {
  describe('cleanMarkdownResponse', () => {
    it('should pass-through plain markdown text', () => {
      const input = '## 1. エグゼクティブ・サマリー\n業務フローの改善内容です。';
      expect(cleanMarkdownResponse(input)).toBe(input);
    });

    it('should strip <think>...</think> reasoning tags', () => {
      const input = '<think>\nユーザーの意図を分析...\n</think>\n## 1. エグゼクティブ・サマリー\n本文です。';
      const result = cleanMarkdownResponse(input);
      expect(result).not.toContain('<think>');
      expect(result).not.toContain('ユーザーの意図を分析');
      expect(result).toBe('## 1. エグゼクティブ・サマリー\n本文です。');
    });

    it('should unwrap markdown fences (```markdown ... ```)', () => {
      const input = '```markdown\n## 分析レポート\n詳細な分析内容です。\n```';
      const result = cleanMarkdownResponse(input);
      expect(result).toBe('## 分析レポート\n詳細な分析内容です。');
    });

    it('should extract target field when LLM erroneously returns JSON format', () => {
      const jsonResponse = JSON.stringify({
        analysisReport: '## エグゼクティブ・サマリー\nJSON内部から抽出されたレポート本文です。',
      });
      const result = cleanMarkdownResponse(jsonResponse, 'analysisReport');
      expect(result).toBe('## エグゼクティブ・サマリー\nJSON内部から抽出されたレポート本文です。');
    });

    it('should strip polite Japanese conversational preambles', () => {
      const input = '承知いたしました。以下に分析レポートを出力します：\n\n## 1. エグゼクティブ・サマリー\n本文です。';
      const result = cleanMarkdownResponse(input);
      expect(result).toBe('## 1. エグゼクティブ・サマリー\n本文です。');
    });

    it('should PRESERVE all body text and not truncate when inner code blocks exist (CRITICAL REGRESSION TEST)', () => {
      // Recreating the exact 13k char failure mode where a ```text ... ``` diagram inside the report
      // caused the entire 12k chars of surrounding analysis text to be discarded!
      const preambleText = '## 1. エグゼクティブ・サマリー\n羽田空港C滑走路における事故の詳細分析です。\n\n## 2. 事故連鎖\n以下の連鎖図の通り推移しました：\n';
      const innerDiagram = '```text\n[管制東] ──taxi to C5──▶ [A機]\n         ──着陸許可──▶ [B機]\n```';
      const postambleText = '\n\n## 3. 原因分析\n指示復唱と滑走路停止位置での確認体制に課題がありました。\n\n## 4. 排除ノード分析\n対策の適用により連鎖が遮断されます。';

      const fullReport = preambleText + innerDiagram + postambleText;
      const result = cleanMarkdownResponse(fullReport);

      // Verify NO truncation occurred!
      expect(result).toContain('## 1. エグゼクティブ・サマリー');
      expect(result).toContain('羽田空港C滑走路における事故の詳細分析です');
      expect(result).toContain('```text\n[管制東] ──taxi to C5──▶ [A機]');
      expect(result).toContain('## 3. 原因分析');
      expect(result).toContain('## 4. 排除ノード分析');
      expect(result.length).toBe(fullReport.trim().length);
    });

    it('should unwrap outer code fences while preserving inner code blocks and preambles', () => {
      const innerContent = '## 1. 概要\n概要本文。\n\n```text\nDiagram\n```\n\n## 2. 結論\n結論本文。';
      const wrapped = '承知しました。以下に出力します：\n```markdown\n' + innerContent + '\n```';
      const result = cleanMarkdownResponse(wrapped);

      expect(result).toContain('## 1. 概要');
      expect(result).toContain('```text\nDiagram\n```');
      expect(result).toContain('## 2. 結論');
      expect(result).not.toContain('承知しました');
    });

    it('should PRESERVE all body text when an inner JSON code block is present in the markdown body', () => {
      // Recreating the exact failure mode identified in Codex review:
      // "原因分析の本文 → JSONコードブロック（analysisReportフィールドを含む例） → 対策・まとめの本文"
      const reportWithJsonExample = 
        '## 1. エグゼクティブ・サマリー\n事故の概要分析です。\n\n' +
        '## 2. システム連携仕様\n連携フォーマットの例は以下の通りです：\n\n' +
        '```json\n{\n  "analysisReport": "例示データ",\n  "status": "ok"\n}\n```\n\n' +
        '## 3. 根本原因分析\n上記のフォーマットに基づく通信確認手順に不整合がありました。\n\n' +
        '## 8. まとめ\n再発防止策を講じる必要があります。';

      const result = cleanMarkdownResponse(reportWithJsonExample, 'analysisReport');

      // The entire report MUST be preserved and NOT replaced by "例示データ"!
      expect(result).toContain('## 1. エグゼクティブ・サマリー');
      expect(result).toContain('## 2. システム連携仕様');
      expect(result).toContain('```json');
      expect(result).toContain('"analysisReport": "例示データ"');
      expect(result).toContain('## 3. 根本原因分析');
      expect(result).toContain('## 8. まとめ');
      expect(result).not.toBe('例示データ');
    });
  });
});
