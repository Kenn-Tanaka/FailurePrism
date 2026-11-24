import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHaiaHandler } from '../../src/tools/haia/local/server.mjs';
import { confinedFile, runPandoc } from '../../src/tools/haia/local/files.mjs';
import { parseVideoId } from '../../src/tools/haia/local/youtube.mjs';

const models = {
  defaultAlias: 'first',
  models: [
    { name: 'First', id: 'openrouter/first', alias: ['first'], enabled: true },
    { name: 'Second', id: 'openrouter/second', alias: ['second'], enabled: true },
  ],
};
let root: string;
let handler: ReturnType<typeof createHaiaHandler>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'haia-test-'));
  await writeFile(join(root, 'models.json'), JSON.stringify(models));
  await writeFile(join(root, 'tasks.json'), JSON.stringify({ Preset: 'Original' }));
  handler = createHaiaHandler(root);
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function call(
  method: string,
  route: string,
  payload?: unknown,
  origin = 'http://127.0.0.1:3000',
  contentType = 'application/json',
) {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.url = '/api/haia/' + route;
  req.method = method;
  req.headers = { host: '127.0.0.1:3000', origin, 'content-type': contentType };

  const response = new EventEmitter() as EventEmitter & {
    headersSent: boolean; status: number; setHeader: () => void;
    writeHead: (status: number) => void; end: (content: string) => void;
  };
  let body = '';
  response.setHeader = () => {};
  response.writeHead = status => { response.status = status; };
  response.end = content => { body = content; response.headersSent = true; };

  stream.end(payload === undefined ? undefined : JSON.stringify(payload));
  await handler(req, response as unknown as ServerResponse);
  return { status: response.status, body: JSON.parse(body) };
}

describe('HAIA local API', () => {
  it('saves to the installation JSON and detects an outdated Alias editor', async () => {
    const current = await call('GET', 'state');
    expect(current.body.models.defaultAlias).toBe('first');
    const next = { ...models, defaultAlias: 'second' };
    expect((await call('PUT', 'models', { models: next, revision: current.body.revision })).status).toBe(200);
    expect(JSON.parse(await readFile(join(root, 'models.json'), 'utf8'))).toEqual(next);
    expect((await call('GET', 'state')).body.models.defaultAlias).toBe('second');
    expect((await call('PUT', 'models', { models, revision: current.body.revision })).status).toBe(409);
  });

  it('preserves the shipped tasks while saving an edited overlay', async () => {
    await call('PUT', 'task', { name: 'Preset', text: 'Edited' });
    expect((await call('GET', 'state')).body.tasks.Preset).toBe('Edited');
    expect(JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')).Preset).toBe('Original');
  });

  it('reads, writes, and appends within temp and rejects paths outside it', async () => {
    const name = './temp/nested/例.md';
    expect((await call('POST', 'file/write', { filename: name, text: '最初\n' })).status).toBe(200);
    expect((await call('POST', 'file/write', { filename: name, text: '追記', mode: 'append' })).status).toBe(200);
    expect((await call('POST', 'file/read', { filename: name })).body.text).toBe('最初\n追記');
    expect((await call('POST', 'file/write', { filename: './temp/../models.json', text: 'bad' })).status).toBe(400);
    expect((await call('POST', 'file/write', { filename: 'C:\\outside.txt', text: 'bad' })).status).toBe(400);
    expect((await call('POST', 'file/read', { filename: name }, 'https://example.test')).status).toBe(403);
  });

  it('rejects junctions and symbolic links in workflow paths', async ({ skip }) => {
    const work = join(root, 'temp');
    const outside = join(root, 'elsewhere');
    await mkdir(work);
    await mkdir(outside);
    try {
      await symlink(outside, join(work, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        skip('Creating links is unavailable');
      }
      throw error;
    }
    await expect(confinedFile(work, './temp/link/out.txt', true)).rejects.toThrow(/リンク/);
  });

  it('canonicalizes supported video URLs and rejects non-YouTube hosts', () => {
    expect(parseVideoId('https://youtu.be/ABCDEFGHIJK?si=xyz')).toBe('ABCDEFGHIJK');
    expect(parseVideoId('https://www.youtube.com/shorts/ABCDEFGHIJK')).toBe('ABCDEFGHIJK');
    expect(parseVideoId('(https://youtu.be/ABCDEFGHIJK)。')).toBe('ABCDEFGHIJK');
    expect(parseVideoId('参考: https://example.test と https://www.youtube.com/watch?v=ABCDEFGHIJK,')).toBe('ABCDEFGHIJK');
    expect(() => parseVideoId('https://example.test/watch?v=ABCDEFGHIJK')).toThrow(/YouTube/);
  });

  it('renames shipped and custom tasks atomically, avoids stale tombstones, and skips invalid entries', async () => {
    // Shipped task rename writes tombstone for old key and stores new key
    const renamedShipped = await call('PUT', 'task', { name: 'PresetRenamed', previousName: 'Preset', text: 'Updated' });
    expect(renamedShipped.status).toBe(200);
    expect(renamedShipped.body.tasks).toEqual({ PresetRenamed: 'Updated' });
    const afterShippedRename = JSON.parse(await readFile(join(root, 'tasks.local.json'), 'utf8'));
    expect(afterShippedRename).toEqual({ Preset: null, PresetRenamed: 'Updated' });

    // User task rename removes old key without adding null tombstone
    await call('PUT', 'task', { name: 'CustomA', text: 'BodyA' });
    const renamedCustom = await call('PUT', 'task', { name: 'CustomB', previousName: 'CustomA', text: 'BodyB' });
    expect(renamedCustom.status).toBe(200);
    expect(renamedCustom.body.tasks.CustomA).toBeUndefined();
    expect(renamedCustom.body.tasks.CustomB).toBe('BodyB');
    const afterCustomRename = JSON.parse(await readFile(join(root, 'tasks.local.json'), 'utf8'));
    expect(Object.hasOwn(afterCustomRename, 'CustomA')).toBe(false);
    expect(afterCustomRename.CustomB).toBe('BodyB');

    // Deleting a user-added task removes its key rather than storing null
    const deletedCustom = await call('PUT', 'task', { name: 'CustomB', text: null });
    expect(deletedCustom.status).toBe(200);
    expect(deletedCustom.body.tasks.CustomB).toBeUndefined();
    const afterCustomDelete = JSON.parse(await readFile(join(root, 'tasks.local.json'), 'utf8'));
    expect(Object.hasOwn(afterCustomDelete, 'CustomB')).toBe(false);

    // Invalid value types in tasks.local.json are skipped instead of crashing state load
    await writeFile(join(root, 'tasks.local.json'), JSON.stringify({ Preset: null, PresetRenamed: 'Updated', Corrupt: 123, Arr: [] }));
    const state = await call('GET', 'state');
    expect(state.status).toBe(200);
    expect(state.body.tasks).toEqual({ PresetRenamed: 'Updated' });
  });

  it('decodes encoding aliases strictly for latin1/ascii and supports cp932/utf8sig reads', async () => {
    // utf-8-sig round-trip and alias normalization
    expect((await call('POST', 'file/write', { filename: 'bom.txt', text: '見出し', encoding: 'utf-8-sig' })).status).toBe(200);
    expect((await call('POST', 'file/read', { filename: 'bom.txt', encoding: 'utf8sig' })).body.text).toBe('見出し');
    expect((await call('POST', 'file/read', { filename: 'bom.txt', encoding: 'UTF-8-SIG' })).body.text).toBe('見出し');
    expect((await call('POST', 'file/read', { filename: 'bom.txt', encoding: 'utf_8' })).body.text).toBe('\uFEFF見出し');

    // Strict latin1 (0x80 must map to U+0080, not U+20AC Euro sign) and strict ascii (reject >= 0x80)
    const workDir = join(root, 'temp');
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'bytes.bin'), Buffer.from([0x41, 0x80, 0x9f, 0xe9]));
    const latin1Res = await call('POST', 'file/read', { filename: 'bytes.bin', encoding: 'latin1' });
    expect(latin1Res.status).toBe(200);
    expect(latin1Res.body.text).toBe('A\u0080\u009f\u00e9');
    const asciiReject = await call('POST', 'file/read', { filename: 'bytes.bin', encoding: 'ascii' });
    expect(asciiReject.status).toBe(400);

    await writeFile(join(workDir, 'ascii.txt'), Buffer.from('Hello 123', 'ascii'));
    expect((await call('POST', 'file/read', { filename: 'ascii.txt', encoding: 'ascii' })).body.text).toBe('Hello 123');

    // cp932 / shift_jis read-only support ("あ" = 0x82 0xA0)
    await writeFile(join(workDir, 'sjis.txt'), Buffer.from([0x82, 0xa0]));
    const cp932Res = await call('POST', 'file/read', { filename: 'sjis.txt', encoding: 'cp932' });
    expect(cp932Res.status).toBe(200);
    expect(cp932Res.body.text).toBe('あ');
  });

  it('accepts case-insensitive Content-Type with parameters and validates binary PDF extension before read', async () => {
    const res = await call('POST', 'file/write', { filename: 'ct.txt', text: 'ok' }, 'http://127.0.0.1:3000', 'Application/JSON; charset=utf-8');
    expect(res.status).toBe(200);
    const badBinary = await call('POST', 'file/read', { filename: 'ct.txt', binary: true });
    expect(badBinary.status).toBe(400);
    expect(badBinary.body.error).toContain('PDF');
  });

  it('clears timeout timer when Pandoc fails to spawn (ENOENT)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await expect(
        runPandoc(join(root, 'missing-pandoc-binary'), ['--version'], Buffer.from(''), new AbortController().signal),
      ).rejects.toThrow(/Pandoc/);
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });
});
