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
async function parsePDF(buffer: ArrayBuffer): Promise<string> {
  const typedArray = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data: typedArray,
    useSystemFonts: true,
  });

  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  const pageTexts: string[] = [];

  const MAX_PAGES = 60;
  const targetPages = Math.min(numPages, MAX_PAGES);

  try {
    for (let pageNum = 1; pageNum <= targetPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();

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
    }

    if (numPages > MAX_PAGES) {
      pageTexts.push(`\n> ※PDFの総ページ数が上限（${MAX_PAGES}ページ）を超えているため、${MAX_PAGES + 1}ページ目以降（${numPages - MAX_PAGES}ページ）は省略されました。`);
    }

    return pageTexts.join('\n\n');
  } finally {
    try {
      await doc.cleanup();
    } catch {}
    try {
      await loadingTask.destroy();
    } catch {}
  }
}

/**
 * Main parser entry point supporting .txt, .md, .docx, .xlsx, .pdf
 */
export async function parseFileToScenarioText(file: File): Promise<ParsedFileResult> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const buffer = await file.arrayBuffer();
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
      extractedText = await parsePDF(buffer);
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
