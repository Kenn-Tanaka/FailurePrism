import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelResolver, parseHaiaModels } from '../../src/tools/haia/models.mjs';
import { runWorkflow, type ExecutionOptions } from '../../src/tools/haia/workflow';
import { selectSubtitle, type SubtitleTrack } from '../../src/tools/haia/subtitles.mjs';
import { applyStringOp, safeFilename } from '../../src/tools/haia/stringOps';
import { localWorkflow } from '../../src/tools/haia/api';
import { applyTaskSaveToRunState } from '../../src/tools/haia/App';
import { AliasEditor } from '../../src/tools/haia/AliasEditor';

const folder = resolve('src/tools/haia/data');
const models = parseHaiaModels(JSON.parse(readFileSync(join(folder, 'models.json'), 'utf8')));
const tasks: Record<string, string> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(join(folder, 'tasks.json'), 'utf8')) as Record<string, string>).map(([name, source]) =>
    [name, source.startsWith('./') ? readFileSync(join(folder, source), 'utf8') : source],
  ),
);

function options(overrides: Partial<ExecutionOptions> = {}) {
  return {
    models, tasks, temperature: 0.1, timeout: 120, signal: new AbortController().signal,
    generate: vi.fn<ExecutionOptions['generate']>(async (req, write) => {
      const text = '  固定応答\n';
      write(text);
      return text;
    }),
    local: vi.fn<ExecutionOptions['local']>(async () => { throw new Error('Unexpected local step'); }),
    onChunk: vi.fn<ExecutionOptions['onChunk']>(), onLog: vi.fn(),
    ...overrides,
  } satisfies ExecutionOptions;
}

beforeEach(() => {
  vi.stubGlobal('DOMParser', DOMParser);
  vi.stubGlobal('XMLSerializer', XMLSerializer);
});
afterEach(() => vi.unstubAllGlobals());

describe('HAIA workflow compatibility', () => {
  it('runs the unchanged registered CAST workflow with fixed model output', async () => {
    const runtime = options();
    const { text, xml } = await runWorkflow(tasks['W01 STAMP/CAST分析 Workflow'], 'fixture', runtime);
    const llmSteps = ['ANALYSIS_v1', 'REVIEW_v1', 'ANALYSIS_v2', 'REVIEW_v2', 'ANALYSIS_v3', 'Executive_Summary'];
    expect(text).toContain('エクゼクティブサマリー');
    expect(text).toContain('  固定応答\n');
    expect((xml.match(/<result>/g) ?? []).length).toBe(7);
    expect(runtime.generate).toHaveBeenCalledTimes(llmSteps.length);
    expect(vi.mocked(runtime.onChunk).mock.calls.flat().join('')).toBe(
      llmSteps.map(id => `<${id}>\n  固定応答\n\n</${id}>\n`).join('') + `<final_output>\n${text}\n</final_output>\n`,
    );
  });

  it('reports the unfinished W02 reference at its step', async () => {
    const runtime = options();
    await expect(runWorkflow(tasks['W02 レジリエンス分析 Workflow'], 'fixture', runtime))
      .rejects.toThrow(/Y2.*F07/);
    expect(vi.mocked(runtime.onChunk).mock.calls.flat().join('')).toContain('<Y1>\n  固定応答\n\n</Y1>');
  });

  it('streams tagged chunks while a step is still running and keeps the result text intact', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const runtime = options({
      generate: async (_request, write) => {
        write('入力 < 3');
        await pending;
        write(' & 4');
        return '入力 < 3 & 4';
      },
    });
    const run = runWorkflow('<workflow><step id="draft"><system>draft</system></step></workflow>', '', runtime);
    expect(vi.mocked(runtime.onChunk).mock.calls).toEqual([['<draft>\n'], ['入力 < 3']]);
    finish();
    const { text, xml } = await run;
    expect(vi.mocked(runtime.onChunk).mock.calls.slice(2)).toEqual([[' & 4'], ['\n</draft>\n']]);
    expect(text).toBe('入力 < 3 & 4');
    expect(xml).toContain('<result>入力 &lt; 3 &amp; 4</result>');
  });

  it('falls back to the installation default for an unknown explicit alias and keeps usable metadata', async () => {
    const runtime = options({ selectedAlias: 'opus' });
    const { text } = await runWorkflow(
      '<workflow default_model_alias="opus"><step id="draft" alias="MISSING"><system>draft</system></step>' +
      '<step id="final" type="passthrough"><input>[[draft.MODEL_ALIAS]] / [[draft.MODEL_ID]]</input></step></workflow>',
      '', runtime,
    );
    const defaultModel = createModelResolver(models)('');
    expect(runtime.generate).toHaveBeenCalledWith(expect.objectContaining({ model: defaultModel.model.id }), expect.any(Function));
    expect(text).toBe(defaultModel.alias + ' / ' + defaultModel.model.id);
    expect(runtime.onLog).toHaveBeenCalledWith(expect.stringContaining('missing'));
  });

  it('preserves nested foreach values and per-item errors without a configured model', async () => {
    const runtime = options({
      models: null,
      local: async (_type, _attr, input) => {
        if (input === 'bad') throw new Error('fixture failure');
        return { text: 'saved:' + input };
      },
    });
    const { text, xml } = await runWorkflow(
      '<workflow><step id="batch" type="foreach" item_var="ROW" continue_on_error="true" unique="true">' +
      '<input>[[DOCUMENT_X]]</input><workflow><step id="save" type="file_write"><input>[[ROW]]</input></step>' +
      '</workflow></step><step id="final" type="pass"><input>[[batch.OK_COUNT]]/[[batch.ERROR_COUNT]] [[batch]]</input></step></workflow>',
      'a\nbad\na\n', runtime,
    );
    expect(text).toBe('1/1 saved:a');
    expect(xml).toContain('<item index="2" index0="1" value="bad" ok="false"');
    expect(vi.mocked(runtime.onChunk).mock.calls.flat().join('')).toBe(
      '<batch>\n<save>\nsaved:a\n</save>\n<save>\n\n</save>\n\n</batch>\n<final>\n1/1 saved:a\n</final>\n',
    );
  });

  it('rejects legacy direct model attributes without contacting the gateway', async () => {
    const runtime = options();
    await expect(runWorkflow('<workflow><step id="old" model_id="openrouter/a"/></workflow>', '', runtime))
      .rejects.toThrow(/old.*alias/);
    expect(runtime.generate).not.toHaveBeenCalled();
  });

  it('preserves Japanese filename characters and the legacy punctuation rules', () => {
    expect(safeFilename(' 日本語：題名: 副題 / 例? ')).toBe('日本語：題名 - 副題 - 例');
    expect(new TextEncoder().encode(safeFilename('文'.repeat(100))).length).toBe(255);
  });
});

describe('subtitle language priority', () => {
  const tracks: SubtitleTrack[] = [
    { id: 'manual:en', language: 'English', languageCode: 'en', generated: false },
    { id: 'auto:ja', language: '日本語', languageCode: 'ja', generated: true },
  ];

  it('ranks the explicitly ordered languages before preferring a track type', () => {
    expect(selectSubtitle(tracks, 'JA,en', 'manual').id).toBe('auto:ja');
    expect(selectSubtitle(tracks, 'ja,en', 'manual_only').id).toBe('manual:en');
    expect(selectSubtitle(tracks, 'en-US,en').id).toBe('manual:en');
  });

  it('preserves automatic selection and reports the available languages on a strict miss', () => {
    expect(selectSubtitle(tracks).id).toBe('auto:ja');
    expect(() => selectSubtitle(tracks, 'de')).toThrow(/en.*ja/);
  });

  it('uses unknown_author for SANITIZED_AUTHOR_NAME when video author is empty', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        videoId: 'ABCDEFGHIJK',
        title: 'Sample Title',
        author: '',
        authorUrl: '',
        tracks: [{ id: 'auto:ja', language: '日本語', languageCode: 'ja', generated: true }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        text: '字幕本文',
        rows: 1,
        track: { id: 'auto:ja', language: '日本語', languageCode: 'ja', generated: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const local = localWorkflow('ja', 30, new AbortController().signal, vi.fn());
    const result = await local('youtube_subtitle', {}, 'https://youtu.be/ABCDEFGHIJK', '');
    expect(result.meta?.SANITIZED_AUTHOR_NAME).toBe('unknown_author');
  });
});

describe('Python-compatible string regex ops and UI task state', () => {
  it('supports Python escapes, anchors, inline flags, and preserves \\p{L} under unicode mode', () => {
    expect(applyStringOp('key: #tag-1', { op: 'regex_extract', pattern: '(\\:\\s\\#[\\w\\-]+)' })).toBe(': #tag-1');
    expect(applyStringOp('a:b#c', { op: 'regex_replace', pattern: '[\\:\\#]', repl: '-' })).toBe('a-b-c');
    expect(applyStringOp('Hello', { op: 'regex_extract', pattern: '(?i)hello' })).toBe('Hello');
    expect(applyStringOp('first\nsecond', { op: 'regex_replace', pattern: '\\Asecond', repl: 'X', multiline: 'true' })).toBe('first\nsecond');
    expect(applyStringOp('first\nsecond', { op: 'regex_replace', pattern: '\\Afirst', repl: 'X', multiline: 'true' })).toBe('X\nsecond');
    expect(applyStringOp('first\nsecond', { op: 'regex_replace', pattern: 'first\\Z', repl: 'X', multiline: 'true' })).toBe('first\nsecond');
    expect(applyStringOp('first\nsecond', { op: 'regex_replace', pattern: 'second\\Z', repl: 'X', multiline: 'true' })).toBe('first\nX');
    expect(applyStringOp('foo #bar', { op: 'regex_extract', pattern: '(?x)foo\\ \\#bar # comment' })).toBe('foo #bar');
    expect(applyStringOp('123日本語😀456', { op: 'regex_extract', pattern: '(\\p{L}+)' })).toBe('日本語');
    expect(applyStringOp('😀a', { op: 'regex_extract', pattern: '^(.)' })).toBe('😀');
  });

  it('tracks task renames in run state while protecting manually edited prompts', () => {
    const prevTasks = { A: 'orig-A', B: 'orig-B' };
    // Rename currently selected task with unedited prompt -> follows new name and text
    expect(applyTaskSaveToRunState('A', 'orig-A', prevTasks, {
      tasks: { A2: 'new-A', B: 'orig-B' }, name: 'A2', previousName: 'A', removed: false,
    })).toEqual({ task: 'A2', prompt: 'new-A' });

    // Rename currently selected task with manually edited prompt -> follows new name, keeps manual prompt
    expect(applyTaskSaveToRunState('A', 'manual-edit', prevTasks, {
      tasks: { A2: 'new-A', B: 'orig-B' }, name: 'A2', previousName: 'A', removed: false,
    })).toEqual({ task: 'A2', prompt: 'manual-edit' });

    // Edit same task while run prompt is manually edited -> keeps manual prompt
    expect(applyTaskSaveToRunState('A', 'manual-edit', prevTasks, {
      tasks: { A: 'updated-A', B: 'orig-B' }, name: 'A', removed: false,
    })).toEqual({ task: 'A', prompt: 'manual-edit' });

    // Delete selected task while unedited -> clears selection and prompt
    expect(applyTaskSaveToRunState('A', 'orig-A', prevTasks, {
      tasks: { B: 'orig-B' }, name: 'A', removed: true,
    })).toEqual({ task: '', prompt: '' });
  });

  it('renders an overwrite warning in AliasEditor when models.json failed to parse', () => {
    const html = renderToStaticMarkup(React.createElement(AliasEditor, {
      installation: { models: null, modelError: 'invalid json', revision: 'rev1', tasks: {} },
      onSaved: () => {},
      onDirty: () => {},
    }));
    expect(html).toContain('元のファイル全体が上書きされます');
  });
});
