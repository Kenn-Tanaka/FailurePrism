import { execFile } from 'node:child_process';
import { get, Agent } from 'node:https';
import { promisify } from 'node:util';
import type { SubtitleList, SubtitleTrack } from '../subtitles.mjs';

const run = promisify(execFile);
const directAgent = new Agent();
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

export class SubtitleError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export function parseVideoId(value: string): string {
  const input = value.trim();
  if (videoIdPattern.test(input)) return input;
  const trailingPunctuation = /[.,;)\]\}）】」』〉》〕。、']+$/;
  const urlCandidates = Array.from(input.matchAll(/https?:\/\/[^\s<>"\]]+/g), match =>
    match[0].replace(trailingPunctuation, ''),
  );
  if (!urlCandidates.length && /^(?:(?:www|m)\.)?(youtube\.com|youtu\.be)\//i.test(input)) {
    urlCandidates.push('https://' + input.replace(trailingPunctuation, ''));
  }
  for (const candidate of urlCandidates) {
    let id = '';
    try {
      const url = new URL(candidate);
      if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1] ?? '';
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
        const [, type, part] = url.pathname.split('/');
        if (type === 'watch') id = url.searchParams.get('v') ?? '';
        if (['shorts', 'live', 'embed', 'v'].includes(type)) id = part ?? '';
      }
    } catch { /* Try next candidate. */ }
    if (videoIdPattern.test(id)) return id;
  }
  throw new SubtitleError('YouTube 動画の URL または ID を入力してください。', 400);
}

interface Caption extends SubtitleTrack { url: string; format: 'json3' | 'vtt' }
interface CaptionSource { ext?: string; url?: string; name?: string }
interface CaptionInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  uploader_url?: string;
  channel_url?: string;
  subtitles?: Record<string, CaptionSource[]>;
  automatic_captions?: Record<string, CaptionSource[]>;
}

function captionUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) &&
        url.pathname === '/api/timedtext' && !url.searchParams.has('tlang')) return url;
  } catch { /* Invalid caption URL. */ }
  return undefined;
}

function getTracks(info: CaptionInfo): Caption[] {
  const tracks: Caption[] = [];
  const sources = [[false, info.subtitles], [true, info.automatic_captions]] as const;
  for (const [generated, byLanguage] of sources) {
    for (const [code, variants] of Object.entries(byLanguage ?? {})) {
      if (!Array.isArray(variants)) continue;
      const sorted = [...variants.filter(v => v?.ext === 'json3'), ...variants.filter(v => v?.ext === 'vtt')];
      const chosen = sorted.find(v => typeof v.url === 'string' && captionUrl(v.url));
      if (!chosen?.url) continue;
      const languageCode = code.replace(/-orig$/, '');
      if (tracks.some(track => track.languageCode === languageCode && track.generated === generated)) continue;
      tracks.push({
        id: (generated ? 'auto:' : 'manual:') + languageCode,
        languageCode, language: chosen.name?.replace(/ \(Original\)$/, '') || languageCode,
        generated, url: chosen.url, format: chosen.ext === 'json3' ? 'json3' : 'vtt',
      });
    }
  }
  return tracks;
}

function fetchCaption(url: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(url, { signal, agent: directAgent }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new SubtitleError('YouTube 字幕本文の取得に失敗しました（HTTP ' + response.statusCode + '）。',
          response.statusCode === 429 ? 429 : 502));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 12 * 1024 * 1024) request.destroy(new SubtitleError('字幕ファイルが大きすぎます。', 413));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

function decodeVtt(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(/\n{2,}/).flatMap(block => {
    const lines = block.split('\n');
    const timing = lines.findIndex(line => line.includes(' --> '));
    if (timing < 0) return [];
    return [lines.slice(timing + 1).join('\n').replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm);/g, (_, name: string) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' })[name] ?? '',
      ).trim()];
  });
}

export async function loadSubtitles(executable: string, videoIdOrUrl: string, signal: AbortSignal) {
  const videoId = parseVideoId(videoIdOrUrl);
  const canonicalUrl = 'https://www.youtube.com/watch?v=' + videoId;
  let info: CaptionInfo;
  try {
    const result = await run(executable, [
      '--ignore-config', '--no-plugin-dirs', '--proxy', '', '--no-playlist', '--skip-download',
      '--no-js-runtimes', '--js-runtimes', 'node:' + process.execPath,
      '--no-warnings', '--ignore-no-formats-error', '--socket-timeout', '15', '--retries', '0', '--dump-single-json',
      '--', canonicalUrl,
    ], { signal, windowsHide: true, timeout: 120_000, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8' });
    info = JSON.parse(result.stdout);
  } catch (error) {
    signal.throwIfAborted();
    const execError = error as Error & { code?: string | number; stderr?: string };
    if (execError.code === 'ENOENT') {
      throw new SubtitleError('字幕取得には yt-dlp が必要です。Haia の bin フォルダまたは PATH を確認してください。', 503);
    }
    const reason = (execError.stderr ?? '').trim().split(/\r?\n/).at(-1)?.slice(0, 300);
    const blocked = /429|too many requests|confirm you.re not a bot/i.test(reason ?? '');
    throw new SubtitleError('YouTube への直接接続で字幕情報を取得できませんでした。' + (reason ? ' ' + reason : ''), blocked ? 429 : 502);
  }
  const captions = getTracks(info);
  const list: SubtitleList = {
    videoId, title: info.title ?? '', author: info.uploader ?? info.channel ?? '',
    authorUrl: info.uploader_url ?? info.channel_url ?? '',
    tracks: captions.map(({ id, language, languageCode, generated }) => ({ id, language, languageCode, generated })),
  };
  return {
    list,
    async download(trackId: string, signal: AbortSignal) {
      const track = captions.find(entry => entry.id === trackId);
      if (!track) throw new SubtitleError('選択した字幕トラックが見つかりません。字幕一覧を取得し直してください。', 404);
      const body = await fetchCaption(track.url, signal);
      let rows: string[];
      if (track.format === 'json3') {
        try {
          const value = JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
          rows = (value.events ?? []).map(event => event.segs?.map(segment => segment.utf8 ?? '').join('').trim() ?? '');
        } catch {
          throw new SubtitleError('YouTube の字幕データを読み取れませんでした。');
        }
      } else {
        rows = decodeVtt(body);
      }
      const text = rows.filter(Boolean).join('\n');
      if (!text) throw new SubtitleError('YouTube から空の字幕が返されました。');
      return { text, rows: rows.length, track: list.tracks.find(entry => entry.id === track.id)! };
    },
  };
}
