import { describe, expect, it, vi } from 'vitest';
import * as xlsx from 'xlsx';

const { mockDocCleanup, mockDestroy, mockPageCleanup, getPageMock, mockGetDocument } = vi.hoisted(() => {
  const mockDocCleanup = vi.fn(async () => {});
  const mockDestroy = vi.fn(async () => {});
  const mockPageCleanup = vi.fn(() => true);
  const getPageMock = vi.fn(async (pageNum: number) => ({
    getTextContent: async () => ({
      items: [{ str: `事象発生の記録 (P.${pageNum})`, transform: [1, 0, 0, 1, 10, 200] }],
    }),
    cleanup: mockPageCleanup,
  }));
  const mockGetDocument = vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 260,
      cleanup: mockDocCleanup,
      getPage: getPageMock,
    }),
    destroy: mockDestroy,
  }));
  return { mockDocCleanup, mockDestroy, mockPageCleanup, getPageMock, mockGetDocument };
});

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: mockGetDocument,
}));

import {
  MAX_INGESTION_FILE_SIZE,
  MAX_PDF_PAGES,
  parseFileToScenarioText,
} from '../../src/tools/vta/features/vta/utils/fileIngestion';

describe('VTA file ingestion safeguards', () => {
  it('uses the patched official SheetJS release', () => {
    expect(xlsx.version).toBe('0.20.3');
  });

  it('defines MAX_PDF_PAGES as 250 to accommodate major incident reports', () => {
    expect(MAX_PDF_PAGES).toBe(250);
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

  it('parses large PDFs up to 250 pages, frees page resources, and reports progress', async () => {
    getPageMock.mockClear();
    mockPageCleanup.mockClear();
    mockDocCleanup.mockClear();
    mockDestroy.mockClear();

    const progressSteps: Array<{ current: number; total: number }> = [];
    const fakePdf = new File([new Uint8Array(100)], 'haneda_incident_report.pdf');

    const result = await parseFileToScenarioText(fakePdf, (p) => {
      progressSteps.push({ current: p.current, total: p.total });
    });

    // Target was clamped to MAX_PDF_PAGES (250)
    expect(getPageMock).toHaveBeenCalledTimes(250);
    expect(mockPageCleanup).toHaveBeenCalledTimes(250);
    expect(mockDocCleanup).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalled();

    // Progress reporting
    expect(progressSteps.length).toBe(250);
    expect(progressSteps[0]).toEqual({ current: 1, total: 250 });
    expect(progressSteps[249]).toEqual({ current: 250, total: 250 });

    // Verifies output contains first and 250th page, and omits 251st page
    expect(result.text).toContain('### 【PDF ページ 1/260】');
    expect(result.text).toContain('事象発生の記録 (P.1)');
    expect(result.text).toContain('### 【PDF ページ 250/260】');
    expect(result.text).toContain('事象発生の記録 (P.250)');
    expect(result.text).not.toContain('### 【PDF ページ 251/260】');
    expect(result.text).toContain('※PDFの総ページ数が上限（250ページ）を超えているため、251ページ目以降（10ページ）は省略されました。');
  });
});
