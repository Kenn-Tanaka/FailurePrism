import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseHaiaModels } from '../models.mjs';
import {
  atomicWrite, confinedFile, decodeText, encodeText, executable, exportDocument, importDocument,
  maxFileBytes, readLocalFile, workflowDocumentExports, writeLocalFile,
} from './files.mjs';
import { loadSubtitles, parseVideoId, SubtitleError } from './youtube.mjs';

class ApiError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const revisionFor = (text: string) => createHash('sha256').update(text).digest('hex');
const decodeJson = (text: string) => JSON.parse(text.replace(/^\uFEFF/, ''));

function stringField(payload: Record<string, unknown>, key: string, required = false): string {
  const value = payload[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim())) throw new ApiError(key + ' を指定してください。');
  return value;
}

async function requestBytes(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > limit) {
    req.resume();
    throw new ApiError('送信データが大きすぎます。', 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    signal.throwIfAborted();
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      req.resume();
      throw new ApiError('送信データが大きすぎます。', 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readPayload(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError('application/json を指定してください。', 415);
  }
  try {
    const value = decodeJson((await requestBytes(req, limit, signal)).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new ApiError('JSON データを読み取れませんでした。');
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host?.toLowerCase();
  const site = req.headers['sec-fetch-site'];
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) ||
      (site && site !== 'same-origin' && site !== 'none')) return false;
  const expected = 'http://' + host;
  if (req.headers.origin && req.headers.origin !== expected) return false;
  return req.method === 'GET' || req.headers.origin === expected;
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function bytes(res: ServerResponse, value: Buffer, type = 'application/octet-stream') {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': value.length });
  res.end(value);
}

function relativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

async function taskSources(root: string): Promise<Record<string, string>> {
  const base: Record<string, string> = decodeJson(await readFile(path.join(root, 'tasks.json'), 'utf8'));
  const basePath = await realpath(root);
  const mutable = await taskChanges(root);
  const sources = await Promise.all(Object.entries(base).map(async ([name, source]) => {
    if (typeof source !== 'string') return [name, ''] as const;
    if (!source.startsWith('./')) return [name, source] as const;
    try {
      const filename = await realpath(path.resolve(basePath, source));
      if (!relativePath(basePath, filename).startsWith('prompts/')) throw new Error('Invalid task path');
      return [name, (await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')] as const;
    } catch {
      return [name, 'Error: File not found ' + source] as const;
    }
  }));
  const tasks = new Map(sources);
  for (const [name, value] of Object.entries(mutable)) {
    if (value === null) tasks.delete(name);
    else if (typeof value === 'string') tasks.set(name, value);
  }
  return Object.fromEntries(tasks);
}

async function taskChanges(root: string): Promise<Record<string, string | null>> {
  try {
    const raw = decodeJson(await readFile(path.join(root, 'tasks.local.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([, value]) => value === null || typeof value === 'string'),
    ) as Record<string, string | null>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function createHaiaHandler(root: string) {
  const modelPath = path.join(root, 'models.json');
  const work = path.join(root, 'temp');
  const pandoc = executable(root, 'pandoc', process.env.HAIA_PANDOC);
  const ytDlp = executable(root, 'yt-dlp', process.env.HAIA_YT_DLP);
  const captionCache = new Map<string, { expires: number; data: Awaited<ReturnType<typeof loadSubtitles>> }>();
  let pendingWrite: Promise<unknown> = Promise.resolve();
  function change<T>(operation: () => Promise<T>) {
    const task = pendingWrite.then(operation);
    pendingWrite = task.catch(() => {});
    return task;
  }

  async function subtitleData(input: string, signal: AbortSignal) {
    const id = parseVideoId(input);
    const entry = captionCache.get(id);
    if (entry && entry.expires > Date.now()) return entry.data;
    const data = await loadSubtitles(ytDlp, id, signal);
    if (captionCache.size >= 16) captionCache.delete(captionCache.keys().next().value!);
    captionCache.set(id, { expires: Date.now() + 120_000, data });
    return data;
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    const signal = controller.signal;
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      if (!isLocalRequest(req)) throw new ApiError('Haia API はローカルの画面から利用してください。', 403);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = req.method + ' ' + url.pathname;
      switch (route) {
        case 'GET /api/haia/state': {
          const modelText = await readFile(modelPath, 'utf8');
          let models = null;
          let modelError = '';
          try { models = parseHaiaModels(decodeJson(modelText)); }
          catch (error) { modelError = (error as Error).message; }
          json(res, { models, modelError, revision: revisionFor(modelText), tasks: await taskSources(root) });
          break;
        }
        case 'PUT /api/haia/models': {
          const body = await readPayload(req, 1024 * 1024, signal);
          const models = parseHaiaModels(body.models);
          const revision = await change(async () => {
            if (revisionFor(await readFile(modelPath, 'utf8')) !== body.revision) {
              throw new ApiError('対応表が別の操作で変更されました。Haia を再起動してから編集してください。', 409);
            }
            const text = JSON.stringify(models, null, 2) + '\n';
            await atomicWrite(modelPath, text, signal);
            return revisionFor(text);
          });
          json(res, { revision });
          break;
        }
        case 'PUT /api/haia/task': {
          const body = await readPayload(req, 8 * 1024 * 1024, signal);
          const name = stringField(body, 'name', true).trim();
          const previousName = stringField(body, 'previousName').trim();
          if (name.length > 300 || previousName.length > 300) throw new ApiError('タスク名が長すぎます。');
          if (body.text !== null && typeof body.text !== 'string') throw new ApiError('タスクの本文を指定してください。');
          const text: string | null = body.text;
          if (text === null && previousName && previousName !== name) {
            throw new ApiError('削除時に別名の previousName は指定できません。');
          }
          const tasks = await change(async () => {
            const baseRaw = decodeJson(await readFile(path.join(root, 'tasks.json'), 'utf8'));
            const inBase = (key: string) => Boolean(baseRaw && typeof baseRaw === 'object' && Object.hasOwn(baseRaw, key));
            const updated: Record<string, string | null> = { ...(await taskChanges(root)) };
            if (text === null) {
              if (inBase(name)) updated[name] = null;
              else delete updated[name];
            } else {
              updated[name] = text;
              if (previousName && previousName !== name) {
                if (inBase(previousName)) updated[previousName] = null;
                else delete updated[previousName];
              }
            }
            await atomicWrite(path.join(root, 'tasks.local.json'), JSON.stringify(updated, null, 2) + '\n', signal);
            return taskSources(root);
          });
          json(res, { tasks });
          break;
        }
        case 'POST /api/haia/document/import': {
          if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
            throw new ApiError('文書ファイルを指定してください。', 415);
          }
          const filename = url.searchParams.get('name') ?? '';
          const content = await requestBytes(req, maxFileBytes, signal);
          const output = await importDocument(pandoc, filename, content, signal);
          bytes(res, output, 'text/plain; charset=utf-8');
          break;
        }
        case 'POST /api/haia/document/export': {
          const body = await readPayload(req, maxFileBytes, signal);
          const output = await exportDocument(root, pandoc, stringField(body, 'format', true), stringField(body, 'text'), signal);
          bytes(res, output);
          break;
        }
        case 'POST /api/haia/file/read': {
          const body = await readPayload(req, 32 * 1024, signal);
          const provided = stringField(body, 'filename', true);
          const filename = await confinedFile(work, provided);
          const format = path.extname(filename).toLowerCase();
          const encoding = stringField(body, 'encoding').trim() || 'utf-8';
          const binary = body.binary === true;
          if (binary && format !== '.pdf') throw new ApiError('convert の fast プロファイルは PDF 用です。');
          const buffer = await readLocalFile(filename, signal);
          const text = binary ? '' : decodeText(buffer, encoding);
          const meta = {
            FILE_NAME: path.basename(filename), FILE_PATH: filename, REL_PATH: relativePath(path.dirname(work), filename),
            ENCODING: encoding, CHARS: String([...text].length), BYTES: String(buffer.length),
          };
          json(res, { text, meta, ...(binary ? { content: buffer.toString('base64') } : {}) });
          break;
        }
        case 'POST /api/haia/file/write': {
          const body = await readPayload(req, maxFileBytes, signal);
          const provided = stringField(body, 'filename', true);
          const input = stringField(body, 'text');
          const mode = stringField(body, 'mode').trim().toLowerCase() || 'create';
          if (mode !== 'create' && mode !== 'append') throw new ApiError('書き込みモードには create または append を指定してください。');
          const encoding = stringField(body, 'encoding').trim() || 'utf-8';
          const ext = path.extname(provided).toLowerCase().slice(1);
          const converted = workflowDocumentExports.has(ext);
          if (converted && mode === 'append') throw new ApiError('文書形式の追記保存には対応していません。');
          const content = converted ? await exportDocument(root, pandoc, ext, input, signal) : encodeText(input, encoding);
          const result = await change(async () => {
            const filename = await confinedFile(work, provided, true);
            await writeLocalFile(filename, mode, content, signal);
            const display = relativePath(path.dirname(work), filename);
            const filter = path.join(root, 'haia.lua');
            return {
              text: display,
              meta: {
                FILE_NAME: path.basename(filename), FILE_PATH: filename, REL_PATH: display,
                MODE: mode, ENCODING: converted ? '' : encoding, FORMAT: converted ? ext : 'text',
                PANDOC: converted ? 'True' : 'False', LUA_FILTER: existsSync(filter) ? filter : '',
                CHARS: String([...input].length), BYTES: String(mode === 'append' ? content.length : (await stat(filename)).size),
              },
            };
          });
          json(res, result);
          break;
        }
        case 'POST /api/haia/subtitles/list': case 'POST /api/haia/subtitles/get': {
          const body = await readPayload(req, 32 * 1024, signal);
          const subtitles = await subtitleData(stringField(body, 'source', true), signal);
          if (route.endsWith('/list')) json(res, subtitles.list);
          else json(res, await subtitles.download(stringField(body, 'trackId', true), signal));
          break;
        }
        default: throw new ApiError('Haia API が見つかりません。', 404);
      }
    } catch (error) {
      if (signal.aborted || res.headersSent) return;
      const status = error instanceof ApiError || error instanceof SubtitleError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      json(res, { error: detail }, status);
    }
  };
}
