import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, FileUp, Play, RotateCcw, Square } from 'lucide-react';
import type { ToolComponentProps } from '../../shell/types';
import { createModelResolver } from './models.mjs';
import {
  exportOutput, loadInstallation, localWorkflow, readInput, saveTask, subtitleList, subtitleText,
  type Installation,
} from './api';
import { generate } from './gateway';
import { looksLikeWorkflow, preparePrompt, runWorkflow } from './workflow';
import { safeFilename } from './stringOps';
import type { SubtitleList } from './subtitles.mjs';
import { AliasEditor } from './AliasEditor';

import { button, field } from './styles';
const editor = field + ' h-full min-h-48 w-full resize-y font-mono leading-relaxed';
const primary = 'inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-45';

type Page = 'run' | 'tasks' | 'aliases' | 'log';

const tabNames: Record<Page, string> = { run: '実行', tasks: 'タスク', aliases: 'Alias メンテナ', log: '実行ログ' };
const exports = ['txt', 'md', 'docx', 'odt', 'pptx', 'html', 'epub', 'xml'];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface TaskSaveResult {
  tasks: Record<string, string>;
  name: string;
  previousName?: string;
  removed: boolean;
}

export function applyTaskSaveToRunState(
  currentTask: string,
  currentPrompt: string,
  previousTasks: Record<string, string>,
  saved: TaskSaveResult,
): { task: string; prompt: string } {
  if (!currentTask) return { task: currentTask, prompt: currentPrompt };
  const isPromptUnedited = currentPrompt === (previousTasks[currentTask] ?? '');
  const renamedCurrent = !saved.removed && Boolean(saved.previousName) && currentTask === saved.previousName;
  const nextTask = renamedCurrent ? saved.name : currentTask;
  if (!Object.hasOwn(saved.tasks, nextTask)) {
    return { task: '', prompt: isPromptUnedited ? '' : currentPrompt };
  }
  const shouldSyncPrompt = isPromptUnedited && (renamedCurrent || nextTask === saved.name);
  return {
    task: nextTask,
    prompt: shouldSyncPrompt ? (saved.tasks[nextTask] ?? '') : currentPrompt,
  };
}

function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function download(data: Blob, filename: string) {
  const uri = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = uri;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(uri), 1_000);
}

export function HaiaApp({ isActive, gatewayToken, onGatewayTokenChange, onStatusChange }: ToolComponentProps) {
  const [opened, setOpened] = useState(false);
  const [reload, setReload] = useState(0);
  const [installation, setInstallation] = useState<Installation>();
  const [selectedAlias, setSelectedAlias] = useState('');
  const [task, setTask] = useState('');
  const [prompt, setPrompt] = useState('');
  const [page, setPage] = useState<Page>('run');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [workflowSteps, setWorkflowSteps] = useState('');
  const [showWorkflowSteps, setShowWorkflowSteps] = useState(false);
  const [resultXml, setResultXml] = useState('');
  const [format, setFormat] = useState('md');
  const [temperature, setTemperature] = useState('0.1');
  const [timeout, setTimeoutValue] = useState('120');
  const [languages, setLanguages] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [aliasDirty, setAliasDirty] = useState(false);
  const [taskDirty, setTaskDirty] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(false);
  const [video, setVideo] = useState('');
  const [subtitles, setSubtitles] = useState<SubtitleList>();
  const [track, setTrack] = useState('');
  const job = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (isActive) setOpened(true); }, [isActive]);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void loadInstallation(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setInstallation(value);
      setSelectedAlias(current => value.models?.models.some(model => model.enabled && model.alias.includes(current)) ? current : '');
      setRestartNeeded(false);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(errorText(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [opened, reload]);
  useEffect(() => () => job.current?.abort(), []);
  useEffect(() => {
    onStatusChange?.({
      isBusy: Boolean(busy), busyLabel: busy, isDirty: aliasDirty || taskDirty,
    });
  }, [busy, aliasDirty, taskDirty, onStatusChange]);

  const log = (message: string) => setLogs(previous =>
    [...previous.slice(-199), new Date().toLocaleTimeString() + '  ' + message],
  );

  async function withJob(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action(controller.signal);
    } catch (cause) {
      const message = controller.signal.aborted ? '中止しました。' : errorText(cause);
      setError(controller.signal.aborted ? '' : message);
      if (controller.signal.aborted) setNotice(message);
      log(message);
    } finally {
      if (job.current === controller) {
        job.current = null;
        setBusy('');
      }
    }
  }

  function useTask(name: string) {
    setTask(name);
    setPrompt(installation?.tasks[name] ?? '');
    setPage('run');
  }

  function execute() {
    void withJob('実行中', async signal => {
      if (!installation) throw new Error('Haia のデータを読み込んでください。');
      const temp = Number(temperature);
      const time = Number(timeout);
      if (!temperature.trim() || !Number.isFinite(temp) || temp < 0 || temp > 2 ||
          !timeout.trim() || !Number.isFinite(time) || time < 0) {
        throw new Error('温度には 0〜2、タイムアウトには 0 以上の秒数を入力してください。');
      }
      if (!prompt.trim()) throw new Error('タスクを選ぶか、システムプロンプトを入力してください。');

      const isWorkflow = looksLikeWorkflow(prompt);
      setOutput('');
      setWorkflowSteps('');
      setShowWorkflowSteps(isWorkflow);
      setResultXml('');
      log(task || 'カスタムプロンプト');
      const models = installation.models;
      const append = isWorkflow ? setWorkflowSteps : setOutput;
      const onChunk = (chunk: string) => {
        if (!signal.aborted) append(previous => previous + chunk);
      };
      const infer = (request: Parameters<typeof generate>[0], write: (chunk: string) => void) =>
        generate(request, gatewayToken, signal, write);
      let final: string;
      if (isWorkflow) {
        const result = await runWorkflow(prompt, input, {
          models, tasks: installation.tasks, selectedAlias, temperature: temp, timeout: time,
          signal, generate: infer, local: localWorkflow(languages, time, signal, log), onChunk, onLog: log,
        });
        final = result.text;
        setResultXml(result.xml);
      } else {
        if (!models) throw new Error(installation.modelError || 'Alias の設定を確認してください。');
        const resolved = createModelResolver(models)(selectedAlias);
        final = await infer({
          model: resolved.model.id, system: preparePrompt(prompt), input, temperature: temp, timeout: time,
        }, onChunk);
      }
      signal.throwIfAborted();
      setOutput(final);
      setNotice('完了しました。');
      log('実行完了');
    });
  }

  const shellAction = (message: string) => { setError(''); setNotice(message); };
  const displayedOutput = showWorkflowSteps ? workflowSteps : output;
  const exportText = resultXml ? output : displayedOutput;
  const exportContent = format === 'xml' ? resultXml : exportText;
  const taskEntries = Object.keys(installation?.tasks ?? {});
  const modelOptions = installation?.models?.models.filter(model => model.enabled).flatMap(model =>
    model.alias.map(alias => ({ alias, name: model.name })),
  ) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-slate-100 text-slate-800">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <nav aria-label="HAIA" className="flex flex-wrap items-center gap-1">
          {Object.entries(tabNames).map(([key, name]) => (
            <button type="button" key={key} aria-pressed={page === key} onClick={() => setPage(key as Page)}
              className={'rounded-md px-3 py-1.5 text-sm font-medium ' + (page === key ? 'bg-indigo-50 text-indigo-800' : 'hover:bg-slate-100')}>
              {name}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          {restartNeeded && <span className="text-sm font-medium text-amber-800">Alias の変更は再起動後に反映</span>}
          <button type="button" className={button} disabled={!!busy || loading || aliasDirty || taskDirty}
            onClick={() => { setNotice(''); setReload(value => value + 1); }}>
            <RotateCcw size={14} /> Haia を再起動
          </button>
        </div>
      </header>
      <main className="flex flex-1 flex-col gap-3 p-3 sm:p-4">
        {(error || installation?.modelError) && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 break-words">
            {error || 'Alias 設定: ' + installation?.modelError}
          </p>
        )}
        {(notice || loading || busy) && <p role="status" className="text-sm text-slate-700">{busy || (loading ? 'Haia のデータを読み込み中…' : notice)}</p>}

        <div hidden={page !== 'run'}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3">
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-medium">
                タスク
                <select className={field + ' w-full'} value={task} onChange={e => useTask(e.target.value)}>
                  <option value="">カスタム</option>
                  {taskEntries.map(name => <option key={name}>{name}</option>)}
                </select>
              </label>
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-medium">
                モデル Alias
                <select className={field + ' w-full'} value={selectedAlias} onChange={e => setSelectedAlias(e.target.value)}>
                  <option value="">Haia の既定{installation?.models ? '（' + installation.models.defaultAlias + '）' : ''}</option>
                  {modelOptions.map(({ alias, name }) => <option key={alias} value={alias}>{alias} — {name}</option>)}
                </select>
              </label>
              <button type="button" className={primary} disabled={!!busy || loading || !installation}
                onClick={execute}><Play size={15} /> 実行</button>
              <button type="button" className={button} disabled={!busy} onClick={() => job.current?.abort()}>
                <Square size={13} /> 中止
              </button>
            </div>

            <details className="rounded-lg border border-slate-200 bg-white p-3">
              <summary className="cursor-pointer text-sm font-medium">実行設定</summary>
              <div className="mt-3 flex flex-wrap gap-3 text-xs">
                <label className="flex flex-col gap-1">温度<input className={field + ' w-28'} type="number" step="0.1" min="0" max="2" value={temperature} onChange={e => setTemperature(e.target.value)} /></label>
                <label className="flex flex-col gap-1">タイムアウト（秒）<input className={field + ' w-32'} type="number" min="0" value={timeout} onChange={e => setTimeoutValue(e.target.value)} /></label>
                <label className="flex flex-col gap-1">字幕の優先言語<input className={field} placeholder="自動（例 ja,en）" value={languages} onChange={e => setLanguages(e.target.value)} /></label>
                <label className="flex min-w-44 flex-col gap-1">Gateway トークン<input className={field} type="password" autoComplete="off" value={gatewayToken} onChange={e => onGatewayTokenChange(e.target.value)} /></label>
              </div>
            </details>

            <details className="rounded-lg border border-slate-200 bg-white p-3">
              <summary className="cursor-pointer text-sm font-medium">システムプロンプト／ワークフロー XML</summary>
              <textarea aria-label="システムプロンプト／ワークフロー XML" className={editor + ' mt-2'} spellCheck={false} value={prompt} onChange={e => setPrompt(e.target.value)} />
            </details>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Panel title="入力" actions={<div className="flex flex-wrap gap-2">
                <button type="button" className={button} disabled={!!busy} onClick={() => fileInput.current?.click()}><FileUp size={14} /> ファイル</button>
                <button type="button" className={button} disabled={!!busy} onClick={() => setShowSubtitles(value => !value)}>YouTube 字幕</button>
                <input type="file" ref={fileInput} hidden accept=".txt,.md,.pdf,.docx,.odt,.epub,.html" onChange={e => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (file) void withJob('読込中', async signal => {
                    const text = await readInput(file, signal);
                    signal.throwIfAborted();
                    setInput(text);
                    setNotice(file.name + ' を読み込みました。');
                  });
                }} />
              </div>}>
                {showSubtitles && (
                  <div className="flex flex-wrap gap-2 rounded-md bg-slate-50 p-2">
                    <input aria-label="YouTube 動画 URL" value={video} onChange={e => {
                      setVideo(e.target.value); setSubtitles(undefined); setTrack('');
                    }} disabled={!!busy} placeholder="YouTube 動画 URL" className={field + ' min-w-36 flex-1'} />
                    <button type="button" className={button} disabled={!!busy || !video.trim()} onClick={() => void withJob('字幕一覧を取得中', async signal => {
                      const list = await subtitleList(video, signal);
                      setSubtitles(list);
                      setTrack('');
                      if (!list.tracks.length) setNotice('この動画には取得可能な字幕がありません。');
                    })}>字幕一覧</button>
                    {subtitles && subtitles.tracks.length > 0 && <>
                      <select className={field} aria-label="字幕トラック" value={track} onChange={e => setTrack(e.target.value)}>
                        <option value="">字幕を選択</option>
                        {subtitles.tracks.map(value => <option key={value.id} value={value.id}>{value.language}（{value.languageCode}・{value.generated ? '自動生成' : '手動作成'}）</option>)}
                      </select>
                      <button type="button" className={button} disabled={!track || !!busy} onClick={() => void withJob('字幕を取得中', async signal => {
                        const result = await subtitleText(subtitles.videoId, track, signal);
                        setInput(result.text);
                        setShowSubtitles(false);
                        setNotice(subtitles.title + '（' + result.track.languageCode + '）の字幕を読み込みました。');
                      })}>読み込む</button>
                    </>}
                  </div>
                )}
                <textarea className={editor + ' lg:min-h-96'} aria-label="入力本文" value={input} onChange={e => setInput(e.target.value)} />
              </Panel>
              <Panel title="出力" actions={<div className="flex flex-wrap gap-2">
                {workflowSteps && (resultXml || !showWorkflowSteps) && (
                  <button type="button" className={button} disabled={!!busy} onClick={() => setShowWorkflowSteps(value => !value)}>
                    {showWorkflowSteps ? '最終出力を表示' : 'ステップ結果を表示'}
                  </button>
                )}
                <select className={field} aria-label="保存形式" value={format} onChange={e => setFormat(e.target.value)}>
                  {exports.map(option => <option key={option} value={option}>{option.toUpperCase()}</option>)}
                </select>
                <button type="button" className={button} disabled={!!busy || !exportContent} onClick={() => void withJob('保存中', async signal => {
                  const data = await exportOutput(exportContent, format, signal);
                  signal.throwIfAborted();
                  download(data, safeFilename(task || 'haia-output') + '.' + format);
                })}><Download size={14} /> 保存</button>
              </div>}>
                <textarea className={editor + ' lg:min-h-96'} aria-label="出力本文" value={displayedOutput}
                  readOnly={!!busy || showWorkflowSteps} onChange={e => setOutput(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={button} disabled={!displayedOutput || !!busy} onClick={() => setInput(displayedOutput)}>出力を入力へ</button>
                  <button type="button" className={button} disabled={!!busy} onClick={() => { setOutput(input); setShowWorkflowSteps(false); setResultXml(''); }}>入力を出力へ</button>
                  <button type="button" className={button} disabled={!!busy} onClick={() => { setInput(displayedOutput); setOutput(input); setShowWorkflowSteps(false); setResultXml(''); }}>入出力を交換</button>
                  <button type="button" className={button} disabled={!displayedOutput} onClick={() => void navigator.clipboard.writeText(displayedOutput).catch(cause => setError(errorText(cause)))}>コピー</button>
                </div>
              </Panel>
            </div>
          </div>
        </div>

        {installation && <>
          <div hidden={page !== 'tasks'}>
            <TaskEditor tasks={installation.tasks} onUse={useTask} onDirty={setTaskDirty}
              onSaved={saved => {
                const nextRunState = applyTaskSaveToRunState(task, prompt, installation.tasks, saved);
                setInstallation(previous => previous && { ...previous, tasks: saved.tasks });
                setTask(nextRunState.task);
                setPrompt(nextRunState.prompt);
                shellAction(saved.removed ? 'タスクを削除しました。' : 'タスクを保存しました。');
              }} />
          </div>
          <div hidden={page !== 'aliases'}>
            <AliasEditor key={installation.revision} installation={installation} onDirty={setAliasDirty}
              onSaved={() => { setRestartNeeded(true); shellAction('対応表を保存しました。Haia を再起動すると反映されます。'); }} />
          </div>
        </>}
        {page === 'log' && (
          <Panel title="実行ログ" actions={<button type="button" onClick={() => setLogs([])} className={button}>クリア</button>}>
            <pre className="min-h-40 whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">{logs.join('\n') || '実行ログはありません。'}</pre>
          </Panel>
        )}
      </main>
    </div>
  );
}

function TaskEditor({ tasks, onSaved, onUse, onDirty }: {
  tasks: Record<string, string>;
  onSaved: (result: TaskSaveResult) => void;
  onUse: (name: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = name !== selected || text !== (tasks[selected] ?? '');
  useEffect(() => { onDirty(dirty || saving); }, [dirty, saving, onDirty]);

  async function save(remove = false) {
    const key = (remove ? selected : name).trim();
    if (!key) return;
    if (remove && !window.confirm('タスク「' + key + '」を削除しますか？')) return;
    if (!remove && key !== selected && Object.hasOwn(tasks, key) && !window.confirm('タスク「' + key + '」を上書きしますか？')) return;
    const previousName = !remove && selected && key !== selected ? selected : undefined;
    setError('');
    setSaving(true);
    try {
      const next = (await saveTask(key, remove ? null : text, previousName)).tasks;
      setSelected(remove ? '' : key);
      setName(remove ? '' : key);
      if (remove) setText('');
      onSaved({ tasks: next, name: key, previousName, removed: remove });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="タスクとプロンプト">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="編集するタスク" className={field} value={selected} disabled={saving} onChange={e => {
          const value = e.target.value;
          if (dirty && !window.confirm('編集内容を破棄しますか？')) return;
          setSelected(value); setName(value); setText(tasks[value] ?? '');
        }}>
          <option value="">新規タスク</option>
          {Object.keys(tasks).map(option => <option key={option}>{option}</option>)}
        </select>
        <input className={field + ' min-w-36 flex-1'} aria-label="タスク名" placeholder="タスク名" value={name} disabled={saving} onChange={e => setName(e.target.value)} />
      </div>
      <textarea className={editor + ' min-h-80'} aria-label="タスク本文" spellCheck={false} value={text} disabled={saving} onChange={e => setText(e.target.value)} />
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} onClick={() => void save()} disabled={!dirty || saving || !name.trim()}>保存</button>
        <button type="button" className={button} disabled={!selected || dirty || saving} onClick={() => onUse(selected)}>このタスクを使う</button>
        <button type="button" className={button} disabled={!selected || saving} onClick={() => void save(true)}>削除</button>
      </div>
    </Panel>
  );
}
