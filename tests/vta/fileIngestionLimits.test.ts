import { describe, expect, it, vi } from 'vitest';
import * as xlsx from 'xlsx';
import { MAX_INGESTION_FILE_SIZE, parseFileToScenarioText } from '../../src/tools/vta/features/vta/utils/fileIngestion';

describe('VTA file ingestion safeguards', () => {
  it('uses the patched official SheetJS release', () => {
    expect(xlsx.version).toBe('0.20.3');
  });

  it.each([
    ['xlsx', 'xlsx'] as const,
    ['xls', 'biff8'] as const,
  ])('continues to parse .%s workbooks after the dependency update', async (extension, bookType) => {
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['項目'], ['動作確認']]), 'シート1');
    const bytes = xlsx.write(workbook, { type: 'array', bookType }) as ArrayBuffer;
    const result = await parseFileToScenarioText(new File([bytes], `ingestion.${extension}`));
    expect(result.text).toContain('動作確認');
  });

  it('rejects oversized inputs before reading them into memory', async () => {
    const arrayBuffer = vi.fn();
    const file = { name: 'large.xlsx', size: MAX_INGESTION_FILE_SIZE + 1, arrayBuffer } as unknown as File;
    await expect(parseFileToScenarioText(file)).rejects.toThrow('上限25MiB');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
