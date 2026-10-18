import { describe, it, expect } from 'vitest';
import * as xlsx from 'xlsx';
import { sheetToMarkdownTable } from './fileIngestion';

describe('fileIngestion.ts - Excel & File Ingestion (DATA-005)', () => {
  it('should preserve 0 and false cell values in markdown table', () => {
    // Create a worksheet with 0 and false values
    const data = [
      ['項目', '数値フラグ', 'ブール値', '説明'],
      ['エラーコード', 0, false, '正常終了'],
      ['再試行回数', 5, true, '再試行済み'],
      ['ゼロ値のみ', 0, 0, '0保持確認'],
    ];

    const worksheet = xlsx.utils.aoa_to_sheet(data);
    const md = sheetToMarkdownTable(xlsx, worksheet, 'テストシート');

    expect(md).toContain('### 【シート: テストシート】');
    // Ensure '0' and 'false' are present in the table rows
    expect(md).toContain('| エラーコード | 0 | false | 正常終了 |');
    expect(md).toContain('| 再試行回数 | 5 | true | 再試行済み |');
    expect(md).toContain('| ゼロ値のみ | 0 | 0 | 0保持確認 |');
  });

  it('should truncate rows when exceeding MAX_ROWS (1500) and append notice (PERF-001)', () => {
    // Generate 1600 rows
    const rows: (string | number)[][] = [['ID', '内容']];
    for (let i = 1; i <= 1600; i++) {
      rows.push([i, `行データ_${i}`]);
    }

    const worksheet = xlsx.utils.aoa_to_sheet(rows);
    const md = sheetToMarkdownTable(xlsx, worksheet, '巨大シート');

    expect(md).toContain('### 【シート: 巨大シート】');
    // Row 1500 should exist
    expect(md).toContain('| 1500 | 行データ_1500 |');
    // Row 1501 should NOT exist in the table rows
    expect(md).not.toContain('| 1501 | 行データ_1501 |');
    // Warning notice must be appended
    expect(md).toContain('※シート「巨大シート」の行数が上限（1500行）に達したため、以降の行（100行）は省略されました。');
  });

  it('should return empty string for empty worksheet', () => {
    const worksheet = xlsx.utils.aoa_to_sheet([]);
    const md = sheetToMarkdownTable(xlsx, worksheet, '空シート');
    expect(md).toBe('');
  });
});

