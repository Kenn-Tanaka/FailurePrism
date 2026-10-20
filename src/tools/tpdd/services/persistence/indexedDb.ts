import { PROJECT_SCHEMA_VERSION, Project, ProjectSchema } from '../../domain/schema';
import { validateProject } from '../../domain/validation';

export interface AutoSaveSnapshot {
  id: string; // セッションIDまたは復旧スロットID
  projectId: string;
  projectTitle: string;
  savedAt: string; // ISO 8601
  project: Project;
  validationErrors?: { path: string; message: string }[];
}

const DB_NAME = 'ThoughtExpansionDB';
const DB_VERSION = 2;
const STORE_NAME = 'autosave_snapshots';
const MAX_SNAPSHOTS = 10;

/**
 * IndexedDB オープンヘルパー
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      // Project v2と互換性のない旧スナップショットは移行せず破棄する。
      if ((e as IDBVersionChangeEvent).oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt', { unique: false });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function withDB<T>(op: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDB();
  try {
    return await op(db);
  } finally {
    db.close();
  }
}

/**
 * 自動保存スナップショットを保存 (直近10件に自動整理)
 */
export async function saveAutoSaveSnapshot(
  sessionId: string,
  project: Project
): Promise<void> {
  try {
    await withDB(async (db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const snapshot: AutoSaveSnapshot = {
        id: sessionId,
        projectId: project.id,
        projectTitle: project.title,
        savedAt: new Date().toISOString(),
        project,
      };

      store.put(snapshot);

      // 10件超過時の古いスナップショット削除
      const getAllReq = store.getAll();
      await new Promise<void>((resolve, reject) => {
        getAllReq.onsuccess = () => resolve();
        getAllReq.onerror = () => reject(getAllReq.error);
      });

      const allSnapshots = (getAllReq.result as AutoSaveSnapshot[]) || [];
      if (allSnapshots.length > MAX_SNAPSHOTS) {
        allSnapshots.sort(
          (a, b) => new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime()
        );
        const toDeleteCount = allSnapshots.length - MAX_SNAPSHOTS;
        for (let i = 0; i < toDeleteCount; i++) {
          store.delete(allSnapshots[i].id);
        }
      }

      await waitForTx(tx);
    });
  } catch (err) {
    console.warn('IndexedDB自動保存エラー (編集操作は継続可能です):', err);
    throw err;
  }
}

/**
 * 全復旧候補を取得 (現行スキーマで検証済みのみ)
 */
export async function getAllAutoSaveSnapshots(): Promise<AutoSaveSnapshot[]> {
  try {
    return await withDB(async (db) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);

      const snapshots: AutoSaveSnapshot[] = await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result as AutoSaveSnapshot[]);
        req.onerror = () => reject(req.error);
      });

      // schema v2の必須構造を満たす候補だけを抽出し、参照整合性の警告は救出用に保持する。
      const recoverableSnapshots: AutoSaveSnapshot[] = [];
      for (const s of snapshots) {
        if (
          !s.project ||
          typeof s.project !== 'object' ||
          s.project.format !== 'tpdd-project' ||
          s.project.schemaVersion !== PROJECT_SCHEMA_VERSION ||
          !Array.isArray(s.project.diagrams) ||
          s.project.diagrams.length === 0 ||
          !Array.isArray(s.project.nodeKinds) ||
          s.project.nodeKinds.length === 0 ||
          !Array.isArray(s.project.levels) ||
          s.project.levels.length === 0
        ) {
          continue;
        }
        const schemaResult = ProjectSchema.safeParse(s.project);
        if (!schemaResult.success) {
          continue;
        }
        const project = schemaResult.data;
        const v = validateProject(project);
        recoverableSnapshots.push({
          ...s,
          project,
          validationErrors: v.valid ? undefined : v.errors,
        });
      }

      // 新しい順にソート
      return recoverableSnapshots.sort(
        (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
      );
    });
  } catch {
    return [];
  }
}

/**
 * 指定の復旧スナップショットを削除
 */
export async function deleteAutoSaveSnapshot(id: string): Promise<void> {
  try {
    await withDB(async (db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      await waitForTx(tx);
    });
  } catch {
    // no-op
  }
}

/**
 * 全復旧スナップショットをクリア
 */
export async function clearAllAutoSaveSnapshots(): Promise<void> {
  try {
    await withDB(async (db) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      await waitForTx(tx);
    });
  } catch {
    // no-op
  }
}

