let canvasContext: CanvasRenderingContext2D | null = null;

function getCanvasContext(): CanvasRenderingContext2D | null {
  if (canvasContext) return canvasContext;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvasContext = canvas.getContext('2d');
  }
  return canvasContext;
}

/**
 * 1文字または文字列の幅を推定/測定する
 */
export function measureTextWidth(text: string, fontSize = 14, fontFamily = 'sans-serif'): number {
  const ctx = getCanvasContext();
  if (ctx) {
    ctx.font = `${fontSize}px ${fontFamily}`;
    return ctx.measureText(text).width;
  }

  // フォールバック: 全角=1em, 半角=0.55em
  let width = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // ASCII 半角など
    if ((code >= 0x0020 && code <= 0x007e) || (code >= 0xff61 && code <= 0xff9f)) {
      width += fontSize * 0.55;
    } else {
      width += fontSize * 1.0;
    }
  }
  return width;
}

/**
 * 幅の制限に合わせてテキストを行ごとに分割（折り返し）する
 * 仕様書 7.3: 日本語は文字幅を測定し、文字境界で折り返す。複数行の折り返し結果を画面と出力で共通化する。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize = 14,
  fontFamily = 'system-ui, -apple-system, sans-serif'
): string[] {
  if (!text) return [];

  const ctx = getCanvasContext();
  if (ctx) {
    ctx.font = `${fontSize}px ${fontFamily}`;
  }

  const rawLines = text.split('\n');
  const resultLines: string[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine) {
      resultLines.push('');
      continue;
    }

    let currentLine = '';
    let currentWidth = 0;

    // Unicodeコードポイント単位で反復（サロゲートペア分断を防止）
    for (const char of rawLine) {
      const charWidth = ctx ? ctx.measureText(char).width : measureTextWidth(char, fontSize, fontFamily);

      if (currentWidth + charWidth > maxWidth && currentLine.length > 0) {
        resultLines.push(currentLine);
        currentLine = char;
        currentWidth = charWidth;
      } else {
        currentLine += char;
        currentWidth += charWidth;
      }
    }

    if (currentLine.length > 0) {
      resultLines.push(currentLine);
    }
  }

  return resultLines;
}
