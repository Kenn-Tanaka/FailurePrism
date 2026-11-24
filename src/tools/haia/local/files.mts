import { spawn } from 'node:child_process';
import { open, lstat, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const documentExports = new Set(['docx', 'odt', 'pptx', 'html', 'epub']);
export const workflowDocumentExports = new Set(['docx', 'odt', 'pptx']);
const documentImports = new Set(['docx', 'odt', 'epub', 'html']);
export const maxFileBytes = 64 * 1024 * 1024;

export async function atomicWrite(filename: string, contents: Uint8Array | string, signal?: AbortSignal) {
  const temp = path.join(path.dirname(filename), '.' + randomUUID() + '.tmp');
  try {
    if (typeof contents !== 'string' && contents.byteLength > maxFileBytes) throw new Error('ファイルが大きすぎます。');
    await writeFile(temp, contents, { flag: 'wx', signal });
    signal?.throwIfAborted();
    await rename(temp, filename);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function confinedFile(root: string, suppliedPath: string, creating = false): Promise<string> {
  const input = suppliedPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^temp\//i, '');
  if (!input || /^[\\/]/.test(input)) throw new Error('相対ファイル名を指定してください。');
  const segments = input.split('/').filter(segment => segment && segment !== '.');
  if (!segments.length || segments.some(segment =>
    segment === '..' || /[<>:"|?*\x00-\x1f]|[. ]$/.test(segment) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment),
  )) throw new Error('作業フォルダ外のパスまたは利用できないファイル名です。');

  await mkdir(root, { recursive: true });
  const base = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('作業フォルダにリンクは使用できません。');
  let filename = base;
  for (const [index, segment] of segments.entries()) {
    filename = path.join(filename, segment);
    const leaf = index === segments.length - 1;
    let info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && creating) return undefined;
      throw error;
    });
    if (!info && !leaf) {
      await mkdir(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(filename);
    }
    if (info && (info.isSymbolicLink() || (leaf ? !info.isFile() : !info.isDirectory()))) {
      throw new Error('作業ファイルへのリンクまたは無効なパスです。');
    }
    if (info) {
      const relative = path.relative(base, await realpath(filename));
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
        throw new Error('作業フォルダ外のパスです。');
      }
    }
  }
  return filename;
}

export function executable(root: string, name: string, override?: string): string {
  if (override) return path.resolve(override);
  const diskName = name + (process.platform === 'win32' ? '.exe' : '');
  const installed = path.join(root, 'bin', diskName);
  return existsSync(installed) ? installed : diskName;
}

export async function runPandoc(exe: string, args: string[], contents: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 180_000);
    const chunks: Buffer[] = [];
    let stderr = '';
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxFileBytes) {
        child.kill();
        finish(() => reject(new Error('文書変換後のファイルが大きすぎます。')));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 8_000) stderr += String(chunk).slice(0, 8_000); });
    child.stdin.on('error', () => { /* The process may reject the document before reading stdin. */ });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') reject(new Error('文書変換には Pandoc が必要です。Haia の bin フォルダまたは PATH を確認してください。'));
        else reject(error);
      });
    });
    child.on('close', code => {
      finish(() => {
        if (timedOut) reject(new Error('Pandoc 変換がタイムアウトしました。'));
        else if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error('Pandoc 変換に失敗しました。' + (stderr.trim() ? ' ' + stderr.trim() : '')));
      });
    });
    child.stdin.end(contents);
  });
}

export function importDocument(exe: string, filename: string, contents: Buffer, signal: AbortSignal) {
  const format = path.extname(filename).toLowerCase().slice(1);
  if (!documentImports.has(format)) throw new Error('対応する文書形式は DOCX、ODT、EPUB、HTML です。');
  return runPandoc(exe, ['--sandbox', '--from=' + format, '--to=markdown', '--', '-'], contents, signal);
}

export function exportDocument(root: string, exe: string, format: string, text: string, signal: AbortSignal) {
  if (!documentExports.has(format)) throw new Error('対応していない出力形式です。');
  const args = ['--sandbox', '--standalone', '--from=markdown+raw_html', '--to=' + format];
  const filter = path.join(root, 'haia.lua');
  const template = path.join(root, 'templates', 'custom.' + format);
  if (existsSync(filter)) args.push('--lua-filter=' + filter);
  // Load the trusted packaged filter and template explicitly. Arbitrary Markdown is still sandboxed.
  if (workflowDocumentExports.has(format) && existsSync(template)) args.push('--reference-doc=' + template);
  return runPandoc(exe, [...args, '--output=-', '--', '-'], Buffer.from(text), signal);
}

export function encodeText(text: string, encoding: string): Buffer {
  const normalized = encoding.toLowerCase().replace(/[-_]/g, '');
  const aliases: Record<string, BufferEncoding> = { utf8: 'utf8', utf16le: 'utf16le', latin1: 'latin1', iso88591: 'latin1', ascii: 'ascii' };
  if (normalized === 'utf8sig') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  const selected = Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined;
  if (!selected) throw new Error('未対応の書き込みエンコーディング（' + encoding + '）。');
  if (selected === 'latin1' && /[^\x00-\xff]/u.test(text) || selected === 'ascii' && /[^\x00-\x7f]/u.test(text)) {
    throw new Error('指定したエンコーディングで表現できない文字があります。');
  }
  return Buffer.from(text, selected);
}

export function decodeText(buffer: Buffer, encoding: string): string {
  const trimmed = encoding.trim();
  const normalized = trimmed.toLowerCase().replace(/[-_]/g, '');
  if (normalized === 'utf8' || normalized === 'utf8sig') {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: normalized === 'utf8' }).decode(buffer);
  }
  if (normalized === 'utf16le') {
    if (buffer.length % 2 !== 0) throw new Error('指定したエンコーディングで読み取れないバイト列があります。');
    return new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
  }
  if (normalized === 'latin1' || normalized === 'iso88591') {
    return buffer.toString('latin1');
  }
  if (normalized === 'ascii') {
    for (const byte of buffer) {
      if (byte > 0x7f) throw new Error('指定したエンコーディングで読み取れない文字があります。');
    }
    return buffer.toString('ascii');
  }
  const decoderAliases: Record<string, string> = {
    shiftjis: 'shift_jis',
    sjis: 'shift_jis',
    cp932: 'shift_jis',
    ms932: 'shift_jis',
    windows31j: 'shift_jis',
    eucjp: 'euc-jp',
  };
  const label = Object.hasOwn(decoderAliases, normalized) ? decoderAliases[normalized] : trimmed;
  return new TextDecoder(label, { fatal: true }).decode(buffer);
}

export async function readLocalFile(filename: string, signal: AbortSignal): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await handle.stat()).size > maxFileBytes) throw new Error('ファイルが大きすぎます。');
    signal.throwIfAborted();
    const content = await handle.readFile();
    signal.throwIfAborted();
    return content;
  } finally {
    await handle.close();
  }
}

export async function writeLocalFile(filename: string, mode: string, bytes: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  if (mode === 'create') return atomicWrite(filename, bytes, signal);
  if (mode !== 'append') throw new Error('対応する保存モードは create と append です。');
  const current = await stat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if ((current?.size ?? 0) + bytes.length > maxFileBytes) throw new Error('ファイルが大きすぎます。');
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    signal.throwIfAborted();
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
