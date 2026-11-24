import type { HaiaModels } from './models.mjs';
import { selectSubtitle, type SubtitleList, type SubtitleTrack } from './subtitles.mjs';
import { safeFilename, seconds, type Attributes } from './stringOps';
import { wait, type LocalStep, type StepResult } from './workflow';
import { withTimeout } from './gateway';

export interface Installation {
  models: HaiaModels | null;
  modelError: string;
  revision: string;
  tasks: Record<string, string>;
}

class LocalApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api(route: string, init?: RequestInit): Promise<Response> {
  const response = await fetch('/api/haia/' + route, { cache: 'no-store', ...init });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new LocalApiError(detail?.error ?? 'Haia のローカル API に接続できません（HTTP ' + response.status + '）。', response.status);
  }
  return response;
}

function jsonRequest(method: 'POST' | 'PUT', value: unknown, signal?: AbortSignal): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal };
}

export async function loadInstallation(signal?: AbortSignal): Promise<Installation> {
  const response = await api('state', { signal });
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error('Haia のローカル API を読み込めません。FailurePrism のサーバーを起動してください。');
  }
  return response.json();
}

export async function saveModels(models: HaiaModels, revision: string): Promise<{ revision: string }> {
  return (await api('models', jsonRequest('PUT', { models, revision }))).json();
}

export async function saveTask(
  name: string,
  text: string | null,
  previousName?: string,
): Promise<{ tasks: Record<string, string> }> {
  const payload = previousName ? { name, text, previousName } : { name, text };
  return (await api('task', jsonRequest('PUT', payload))).json();
}

export async function subtitleList(source: string, signal?: AbortSignal): Promise<SubtitleList> {
  return (await api('subtitles/list', jsonRequest('POST', { source }, signal))).json();
}

export async function subtitleText(source: string, trackId: string, signal?: AbortSignal):
  Promise<{ text: string; rows: number; track: SubtitleTrack }> {
  return (await api('subtitles/get', jsonRequest('POST', { source, trackId }, signal))).json();
}

async function extractPdf(data: Uint8Array, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.mjs?url'),
  ]);
  signal?.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const loading = pdfjs.getDocument({ data, stopAtErrors: true });
  let destroyed: Promise<void> | undefined;
  const destroy = () => { destroyed ??= loading.destroy().catch(() => {}); };
  signal?.addEventListener('abort', destroy, { once: true });
  if (signal?.aborted) destroy();
  try {
    const pdf = await loading.promise;
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trimEnd());
      page.cleanup();
    }
    return pages.join('\n');
  } finally {
    signal?.removeEventListener('abort', destroy);
    destroy();
    await destroyed;
  }
}

export async function readInput(file: File, signal: AbortSignal): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return extractPdf(new Uint8Array(await file.arrayBuffer()), signal);
  if (ext && ['docx', 'odt', 'epub', 'html'].includes(ext)) {
    const response = await api('document/import?name=' + encodeURIComponent(file.name), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal,
    });
    return response.text();
  }
  return file.text();
}

export async function exportOutput(text: string, format: string, signal: AbortSignal): Promise<Blob> {
  if (['txt', 'md', 'xml'].includes(format)) {
    return new Blob([text], { type: format === 'xml' ? 'application/xml' : 'text/plain' });
  }
  return (await api('document/export', jsonRequest('POST', { text, format }, signal))).blob();
}

async function workflowSubtitle(
  source: string, attr: Attributes, languages: string, timeout: number, signal: AbortSignal, onLog: (text: string) => void,
): Promise<StepResult> {
  const timed = withTimeout(signal, seconds(attr.timeout, timeout));
  try {
    const retryCount = Number(attr.retries?.trim() || 3);
    if (!Number.isInteger(retryCount) || retryCount < 0) throw new Error('字幕の retries は 0 以上の整数です。');
    const waitTime = seconds(attr.retry_wait, 20);
    const maxWait = Math.max(waitTime, seconds(attr.retry_wait_max, 120));
    const backoff = Number(attr.retry_backoff?.trim() || 2);
    if (!Number.isFinite(backoff) || backoff < 1) throw new Error('字幕の retry_backoff は 1 以上です。');

    for (let attempt = 0; ; attempt++) {
      try {
        const list = await subtitleList(source, timed.signal);
        const choice = selectSubtitle(list.tracks,
          attr.languages || attr.language || attr.language_codes || attr.lang || languages,
          attr.prefer || attr.kind,
        );
        const result = await subtitleText(list.videoId, choice.id, timed.signal);
        return {
          text: result.text,
          meta: {
            VIDEO_ID: list.videoId, URL: 'https://www.youtube.com/watch?v=' + list.videoId,
            TITLE: list.title, SANITIZED_TITLE: safeFilename(list.title || list.videoId),
            AUTHOR_NAME: list.author, SANITIZED_AUTHOR_NAME: safeFilename(list.author.trim() || 'unknown_author'),
            AUTHOR_URL: list.authorUrl, LANGUAGE: result.track.language, LANGUAGE_CODE: result.track.languageCode,
            IS_GENERATED: result.track.generated ? 'True' : 'False', ROW_COUNT: String(result.rows),
          },
        };
      } catch (error) {
        timed.signal.throwIfAborted();
        if (!(error instanceof LocalApiError) || ![429, 502].includes(error.status) || attempt >= retryCount) throw error;
        const delay = Math.min(maxWait, waitTime * backoff ** attempt);
        onLog('YouTube 字幕取得を ' + delay + ' 秒後に再試行します。');
        await wait(delay, timed.signal);
      }
    }
  } catch (error) {
    timed.signal.throwIfAborted();
    throw error;
  } finally {
    timed.close();
  }
}

export function localWorkflow(
  languages: string, timeout: number, signal: AbortSignal, onLog: (text: string) => void,
) {
  return async (type: LocalStep, attr: Attributes, input: string, filename: string): Promise<StepResult> => {
    if (type === 'youtube_subtitle') return workflowSubtitle(input, attr, languages, timeout, signal, onLog);
    const body = { filename, encoding: attr.encoding, mode: attr.mode, text: input, binary: type === 'convert' };
    if (type === 'file_write' || type === 'file_read') {
      const route = type === 'file_write' ? 'file/write' : 'file/read';
      return (await api(route, jsonRequest('POST', body, signal))).json();
    }
    const profile = attr.profile?.trim() || 'fast';
    if (profile !== 'fast') throw new Error('文書変換プロファイル「' + profile + '」は利用できません。');
    const response = await api('file/read', jsonRequest('POST', body, signal));
    const { content, meta } = await response.json() as StepResult & { content: string };
    const now = performance.now();
    const text = await extractPdf(Uint8Array.from(atob(content), c => c.charCodeAt(0)), signal);
    return {
      text,
      meta: {
        ...meta, EXTENSION: '.pdf', PROFILE_ID: 'fast', PROFILE_LABEL: '高速読込',
        CONVERTER_ID: 'pdfjs', VARIANT: '', CHARS: String([...text].length),
        ELAPSED_SECONDS: ((performance.now() - now) / 1000).toFixed(6), FALLBACK_USED: 'False',
      },
    };
  };
}
