import { existsSync, rmSync } from 'node:fs';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const seed = path.join(project, 'src', 'tools', 'haia', 'data');

async function seedModels(from, root) {
  try {
    await copyFile(from, path.join(root, 'models.json'), constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

export async function loadHaiaHandler() {
  const distributionRoot = path.join(here, 'haia');
  const projectRuntime = path.join(project, '.runtime', 'haia');
  const root = existsSync(seed) ? projectRuntime : distributionRoot;
  const entry = path.join(root, 'runtime', 'local', 'server.mjs');
  if (!existsSync(entry)) return undefined;
  try {
    if (root === projectRuntime) {
      await mkdir(root, { recursive: true });
      await cp(seed, root, { force: false, recursive: true, filter: (source) => source !== path.join(seed, 'models.json') });
      await seedModels(path.join(seed, 'models.json'), root);
    } else {
      await seedModels(path.join(root, 'models.default.json'), root);
    }
    const { createHaiaHandler } = await import(/* @vite-ignore */ pathToFileURL(entry).href);
    return createHaiaHandler(root);
  } catch (error) {
    console.error('Haia の初期化に失敗しました。', error);
    return (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Haia のインストールフォルダにアクセスできません。' }));
    };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
    process.argv.includes('--build') && existsSync(seed)) {
  const runtimeDir = path.resolve(project, '.runtime', 'haia', 'runtime');
  const expectedRel = path.join('.runtime', 'haia', 'runtime');
  if (path.relative(project, runtimeDir) !== expectedRel) {
    throw new Error(`Unexpected Haia runtime directory: ${runtimeDir}`);
  }
  rmSync(runtimeDir, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    path.join(project, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', path.join(project, 'tsconfig.haia-server.json'),
  ], { cwd: project, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
