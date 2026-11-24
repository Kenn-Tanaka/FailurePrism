export type Attributes = Record<string, string>;

export function bool(value: string | undefined, defaultValue = false): boolean {
  const text = value?.trim().toLowerCase();
  if (!text) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  throw new Error('真偽値が不正です（' + value + '）。');
}

export function seconds(value: string | undefined, defaultValue: number): number {
  if (!value?.trim()) return defaultValue;
  const text = value.trim().toLowerCase();
  if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(text)) {
    return text.split(':').reduce((time, part) => time * 60 + Number(part), 0);
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/.exec(text);
  if (!match || !Number.isFinite(Number(match[1]))) throw new Error('時間指定が不正です（' + value + '）。');
  const unit = match[2] ?? 's';
  return Number(match[1]) * (unit === 'ms' ? 0.001 : unit.startsWith('m') ? 60 : unit.startsWith('h') ? 3600 : 1);
}

export function separator(value: string | undefined, defaultValue = '\n'): string {
  return value === undefined ? defaultValue : value.replace(/\\[ntr]/g, escape => ({ '\\n': '\n', '\\t': '\t', '\\r': '\r' })[escape]!);
}

function int(value: string | undefined, fallback?: number): number | undefined {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!/^[+-]?\d+$/.test(value.trim()) || !Number.isSafeInteger(parsed)) {
    throw new Error('整数の指定が不正です（' + value + '）。');
  }
  return parsed;
}

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function safeFilename(text: string, replacement = '_'): string {
  let result = text.replace(/[:|/\\]/g, ' - ').replace(/"/g, "'").replace(/[?*<>]/g, '')
    .replace(/[\x00-\x1f]/g, () => replacement).replace(/ {2,}/g, ' ');
  if (replacement) {
    const escaped = replacement.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp('(?:' + escaped + ')+', 'gu'), () => replacement);
  }
  result = trimChars(result, ' .-_' + replacement, true, true);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = (replacement || '_') + result;
  const encoded = new TextEncoder().encode(result || 'untitled');
  if (encoded.length <= 255) return result || 'untitled';
  // A final partial UTF-8 code point is discarded.
  return new TextDecoder().decode(encoded.subarray(0, 255), { stream: true });
}

function trimChars(text: string, chars: string | undefined, left: boolean, right: boolean): string {
  if (chars === undefined) return left && right ? text.trim() : left ? text.trimStart() : text.trimEnd();
  const units = [...text];
  let start = 0;
  let end = units.length;
  while (left && start < end && chars.includes(units[start])) start++;
  while (right && end > start && chars.includes(units[end - 1])) end--;
  return units.slice(start, end).join('');
}

function splitField(text: string, delimiter: string, count: number): string[] {
  if (!delimiter) return [...text];
  if (count < 0) return text.split(delimiter);
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const next = text.indexOf(delimiter, start);
    if (next < 0) break;
    result.push(text.slice(start, next));
    start = next + delimiter.length;
  }
  return [...result, text.slice(start)];
}

const UNICODE_ESCAPE_OUTSIDE = /^[\^$\\.*+?()[\]{}|/dDsSwWfnrtv0-9bBckpPuUx]$/;
const UNICODE_ESCAPE_CLASS = /^[\^$\\.*+?()[\]{}|/\-dDsSwWfnrtv0bcpPux]$/;

function normalizeCharacterClass(token: string): string {
  return '[' + token.slice(1, -1).replace(/\\([\s\S])/g, (escape, ch: string) =>
    UNICODE_ESCAPE_CLASS.test(ch) ? escape : ch,
  ) + ']';
}

function regexOptions(attributes: Attributes, pattern: string, global: boolean): RegExp {
  let flags = (attributes.flags ?? '').toLowerCase();
  while (true) {
    const inline = /^\(\?([imsx]+)\)/.exec(pattern);
    if (!inline) break;
    flags += inline[1];
    pattern = pattern.slice(inline[0].length);
  }
  const verbose = flags.includes('x') || bool(attributes.verbose);
  const tokenizer = verbose
    ? /\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|\(\?P<(\w+)>|\(\?P=(\w+)\)|#[^\n]*|\s+/g
    : /\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|\(\?P<(\w+)>|\(\?P=(\w+)\)/g;

  pattern = pattern.replace(tokenizer, (token, groupName?: string, backrefName?: string) => {
    if (groupName !== undefined) return `(?<${groupName}>`;
    if (backrefName !== undefined) return `\\k<${backrefName}>`;
    if (token.startsWith('[')) return normalizeCharacterClass(token);
    if (token.startsWith('\\')) {
      const ch = token[1];
      if (ch === 'A') return '(?<![\\s\\S])';
      if (ch === 'Z') return '(?![\\s\\S])';
      return UNICODE_ESCAPE_OUTSIDE.test(ch) ? token : ch;
    }
    return '';
  });

  return new RegExp(pattern, [
    'u',
    global ? 'g' : '',
    flags.includes('i') || bool(attributes.ignore_case) ? 'i' : '',
    flags.includes('m') || bool(attributes.multiline) ? 'm' : '',
    flags.includes('s') || bool(attributes.dotall) ? 's' : '',
  ].join(''));
}

export const stringOp = (attr: Attributes) => (attr.op || attr.operation || 'strip').trim().toLowerCase();

export function applyStringOp(text: string, attr: Attributes): string {
  const op = stringOp(attr);
  const fallback = separator(attr.default, '');
  const missing = (message: string) => {
    if (bool(attr.required)) throw new Error(message);
    return fallback;
  };
  switch (op) {
    case 'identity': case 'raw': case 'copy': case 'noop': case 'none': return text;
    case 'strip': case 'lstrip': case 'rstrip':
      return trimChars(text, attr.chars === undefined ? undefined : separator(attr.chars), op !== 'rstrip', op !== 'lstrip');
    case 'normalize_space': case 'collapse_space': case 'collapse_whitespace':
      return text.replace(/\s+/gu, ' ').trim();
    case 'replace': {
      const old = separator(attr.from ?? attr.old ?? attr.pattern, '');
      const replacement = separator(attr.to ?? attr.new ?? attr.repl ?? attr.replacement, '');
      const count = int(attr.count, -1)!;
      if (count === 0) return text;
      if (!old) {
        const parts = [...text, ''];
        return parts.map((item, index) => (count < 0 || index < count ? replacement : '') + item).join('');
      }
      return splitField(text, old, count).join(replacement);
    }
    case 'regex_replace': case 're_replace': case 'regexp_replace': {
      const pattern = separator(attr.pattern ?? attr.regex, '');
      if (!pattern) throw new Error('regex_replace に pattern が必要です。');
      const replacement = separator(attr.repl ?? attr.replacement ?? attr.to, '');
      const limit = int(attr.count, 0)!;
      if (limit < 0) return text;
      let count = 0;
      return text.replace(regexOptions(attr, pattern, true), (match: string, ...parts: unknown[]) => {
        if (limit && count++ >= limit) return match;
        const last = parts.at(-1);
        const named = typeof last === 'object' && last !== null ? last as Record<string, string> : undefined;
        const captures = [match, ...parts.slice(0, named ? -3 : -2)];
        return replacement.replace(/\\(?:g<([^>]+)>|([1-9]\d?)|(\\))/g, (_, name, number, slash) => {
          if (slash) return '\\';
          const key = name ?? number;
          return (/^\d+$/.test(key) ? captures[Number(key)] : named?.[key]) as string ?? '';
        });
      });
    }
    case 'regex_extract': case 're_extract': case 'regexp_extract': case 'extract': {
      const pattern = separator(attr.pattern ?? attr.regex, '');
      if (!pattern) throw new Error('regex_extract に pattern が必要です。');
      const match = regexOptions(attr, pattern, false).exec(text);
      if (!match) return missing('パターンに一致する文字列がありません。');
      const group = attr.group?.trim() || (match.slice(1).some(part => part !== undefined) ? '1' : '0');
      const exists = /^\d+$/.test(group) ? Number(group) < match.length : Object.hasOwn(match.groups ?? {}, group);
      if (!exists) return missing('正規表現のグループが見つかりません。');
      return (/^\d+$/.test(group) ? match[Number(group)] : match.groups?.[group]) ?? '';
    }
    case 'truncate': {
      const max = int(attr.max ?? attr.length);
      if (max === undefined || max < 0) throw new Error('truncate に 0 以上の max または length が必要です。');
      const units = [...text];
      const suffix = separator(attr.suffix, '');
      if (units.length <= max) return text;
      const suffixLength = [...suffix].length;
      return suffix && max > suffixLength ? units.slice(0, max - suffixLength).join('') + suffix : units.slice(0, max).join('');
    }
    case 'slice': return [...text].slice(int(attr.start), int(attr.end)).join('');
    case 'lower': return text.toLowerCase();
    case 'upper': return text.toUpperCase();
    case 'title': return text.toLowerCase().replace(/[\p{Lu}\p{Ll}\p{Lt}]+/gu, word => word[0].toUpperCase() + word.slice(1));
    case 'capitalize': {
      const [first, ...rest] = text;
      return first ? first.toUpperCase() + rest.join('').toLowerCase() : '';
    }
    case 'field': case 'split_field': case 'split': {
      const parts = splitField(text, separator(attr.sep ?? attr.separator ?? attr.delimiter, '\t'), int(attr.maxsplit, -1)!);
      return parts.at(int(attr.index, 0)!) ?? missing('フィールドの番号が範囲外です。');
    }
    case 'sanitize_filename': case 'filename_sanitize': case 'sanitize':
      return safeFilename(text, separator(attr.replacement, '_'));
    case 'sanitize_path': case 'path_sanitize': case 'sanitize_folder': case 'folder_sanitize':
      return text.split(/[/\\]/).map(part => part.trim()).filter(part => part && part !== '.' && part !== '..')
        .map(part => safeFilename(part, separator(attr.replacement, '_'))).join('/') || fallback;
    default: throw new Error('未対応の文字列操作（' + op + '）。');
  }
}
