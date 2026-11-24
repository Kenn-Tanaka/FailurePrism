import * as mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface ParsedFileResult {
  text: string;
  filename: string;
  fileType: string;
  sizeBytes: number;
  characterCount: number;
}

export const MAX_INGESTION_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 250;

export class FileIngestionAbortedError extends Error {
  constructor(message = 'ファイルの読み込みが中断されました。') {
    super(message);
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FileIngestionAbortedError();
  }
}

export function isProjectJsonFileName(filename: string): boolean {
  return filename.trim().toLowerCase().endsWith('.json');
}

export function validateIngestionFileSize(
  file: Pick<File, 'name' | 'size'>
): { valid: true } | { valid: false; message: string; sizeMiB: string } {
  if (file.size <= MAX_INGESTION_FILE_SIZE) {
    return { valid: true };
  }
  const sizeMiB = (file.size / 1024 / 1024).toFixed(1);
  const prefix = file.name ? `ファイル「${file.name}」は` : '入力ファイルは';
  return {
    valid: false,
    sizeMiB,
    message: `${prefix}入力上限25MiBを超えているため読み込みを打ち切りました (${sizeMiB}MiB)。`,
  };
}

export type IngestionProgressCallback = (progress: { current: number; total: number; stage: string }) => void;

/**
 * Safely decode text from ArrayBuffer with Shift_JIS / UTF-8 auto-detection
 */
function decodeTextBuffer(buffer: ArrayBuffer): string {
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(buffer);
  } catch {
    // If UTF-8 fatal error, fallback to Shift_JIS / CP932
    try {
      const sjisDecoder = new TextDecoder('shift-jis');
      return sjisDecoder.decode(buffer);
    } catch {
      const fallbackDecoder = new TextDecoder('utf-8');
      return fallbackDecoder.decode(buffer);
    }
  }
}

/**
 * Converts an XLSX Sheet into a formatted Markdown Table
 */
export function sheetToMarkdownTable(xlsxModule: typeof import('xlsx'), sheet: import('xlsx').WorkSheet, sheetName: string): string {
  const jsonRows = xlsxModule.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' });
  if (!jsonRows || jsonRows.length === 0) return '';

  const nonEmptyRows = jsonRows.filter((row) =>
    Array.isArray(row) && row.some((cell) => cell != null && String(cell).trim().length > 0)
  );

  if (nonEmptyRows.length === 0) return '';

  const output: string[] = [];
  output.push(`### 【シート: ${sheetName}】`);

  // Determine max columns safely with reduce to prevent call stack overflow (PERF-001)
  const maxCols = nonEmptyRows.reduce((max, r) => Math.max(max, r.length), 0);

  // Header
  const headerRow = nonEmptyRows[0];
  const headerCells = Array.from({ length: maxCols }, (_, i) => {
    const rawVal = headerRow[i];
    return rawVal != null && String(rawVal).trim() !== ''
      ? String(rawVal).trim()
      : `列${i + 1}`;
  });
  output.push(`| ${headerCells.join(' | ')} |`);
  output.push(`| ${headerCells.map(() => '---').join(' | ')} |`);

  // Data rows (cap at 1500 rows to prevent main-thread freeze, PERF-001)
  const MAX_ROWS = 1500;
  const targetRows = nonEmptyRows.slice(1, MAX_ROWS + 1);

  for (let i = 0; i < targetRows.length; i++) {
    const row = targetRows[i];
    const cells = Array.from({ length: maxCols }, (_, j) => {
      const rawVal = row[j];
      const strVal = rawVal != null ? String(rawVal) : '';
      return strVal.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
    });
    output.push(`| ${cells.join(' | ')} |`);
  }

  if (nonEmptyRows.length > MAX_ROWS + 1) {
    output.push(`\n> ※シート「${sheetName}」の行数が上限（${MAX_ROWS}行）に達したため、以降の行（${nonEmptyRows.length - MAX_ROWS - 1}行）は省略されました。`);
  }

  return output.join('\n');
}

/**
 * Parses and extracts text content from PDF ArrayBuffer
 */
export async function parsePDF(
  buffer: ArrayBuffer,
  onProgress?: IngestionProgressCallback,
  maxPages: number = MAX_PDF_PAGES,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const typedArray = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data: typedArray,
    useSystemFonts: true,
  });

  let doc: Awaited<typeof loadingTask.promise> | null = null;
  try {
    doc = await loadingTask.promise;
    throwIfAborted(signal);
    const numPages = doc.numPages;
    const pageTexts: string[] = [];
    const targetPages = Math.min(numPages, maxPages);

    for (let pageNum = 1; pageNum <= targetPages; pageNum++) {
      throwIfAborted(signal);
      if (onProgress) {
        onProgress({
          current: pageNum,
          total: targetPages,
          stage: `PDF ページ解析中 (${pageNum}/${targetPages})`,
        });
      }
      throwIfAborted(signal);
      const page = await doc.getPage(pageNum);
      try {
        throwIfAborted(signal);
        const content = await page.getTextContent();
        throwIfAborted(signal);

        // Group items by line (Y coordinate)
        const items = content.items as Array<{ str: string; transform: number[] }>;
        if (!items || items.length === 0) continue;

        // Sort items top-to-bottom, left-to-right
        const sorted = [...items].sort((a, b) => {
          const yA = a.transform[5] || 0;
          const yB = b.transform[5] || 0;
          // If same line (within 4px)
          if (Math.abs(yA - yB) < 4) {
            return (a.transform[4] || 0) - (b.transform[4] || 0);
          }
          return yB - yA; // top to bottom
        });

        let currentY = sorted[0]?.transform[5] || 0;
        let pageLines: string[] = [];
        let currentLine = '';

        for (const item of sorted) {
          const itemY = item.transform[5] || 0;
          if (Math.abs(itemY - currentY) > 4) {
            if (currentLine.trim()) {
              pageLines.push(currentLine.trim());
            }
            currentLine = item.str;
            currentY = itemY;
          } else {
            currentLine += (currentLine ? ' ' : '') + item.str;
          }
        }
        if (currentLine.trim()) {
          pageLines.push(currentLine.trim());
        }

        if (pageLines.length > 0) {
          pageTexts.push(
            `### 【PDF ページ ${pageNum}/${numPages}】\n` + pageLines.join('\n')
          );
        }
      } finally {
        try {
          page.cleanup();
        } catch {}
      }
    }

    if (numPages > maxPages) {
      pageTexts.push(`\n> ※PDFの総ページ数が上限（${maxPages}ページ）を超えているため、${maxPages + 1}ページ目以降（${numPages - maxPages}ページ）は省略されました。`);
    }

    return pageTexts.join('\n\n');
  } finally {
    try {
      await doc?.cleanup();
    } catch {}
    try {
      await loadingTask.destroy();
    } catch {}
  }
}

/**
 * Main parser entry point supporting .txt, .md, .docx, .xlsx, .pdf
 */
export async function parseFileToScenarioText(
  file: File,
  onProgress?: IngestionProgressCallback,
  options?: { maxPdfPages?: number; signal?: AbortSignal }
): Promise<ParsedFileResult> {
  throwIfAborted(options?.signal);
  const sizeCheck = validateIngestionFileSize(file);
  if (!sizeCheck.valid) {
    throw new Error(sizeCheck.message);
  }
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const buffer = await file.arrayBuffer();
  throwIfAborted(options?.signal);
  let extractedText = '';

  switch (extension) {
    case 'txt':
    case 'log':
      extractedText = decodeTextBuffer(buffer);
      break;

    case 'md':
    case 'markdown':
      extractedText = decodeTextBuffer(buffer);
      break;

    case 'docx': {
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      throwIfAborted(options?.signal);
      extractedText = result.value
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join('\n\n');
      break;
    }

    case 'xlsx':
    case 'xls': {
      const XLSX = await import('xlsx');
      throwIfAborted(options?.signal);
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheetTexts: string[] = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (sheet) {
          const mdTable = sheetToMarkdownTable(XLSX, sheet, sheetName);
          if (mdTable.trim()) {
            sheetTexts.push(mdTable);
          }
        }
      }
      extractedText = sheetTexts.join('\n\n');
      break;
    }

    case 'pdf': {
      extractedText = await parsePDF(buffer, onProgress, options?.maxPdfPages ?? MAX_PDF_PAGES, options?.signal);
      break;
    }

    default:
      // Fallback try as text
      extractedText = decodeTextBuffer(buffer);
      break;
  }

  const trimmedText = extractedText.trim();
  return {
    text: trimmedText,
    filename: file.name,
    fileType: extension.toUpperCase() || 'UNKNOWN',
    sizeBytes: file.size,
    characterCount: trimmedText.length,
  };
}
