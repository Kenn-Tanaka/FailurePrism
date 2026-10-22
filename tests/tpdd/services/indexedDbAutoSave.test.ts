import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveAutoSaveSnapshot, getAllAutoSaveSnapshots } from '../../../src/tools/tpdd/services/persistence/indexedDb';
import { Project } from '../../../src/tools/tpdd/domain/schema';

describe('IndexedDB AutoSave error handling & regression tests', () => {
  const originalIndexedDB = globalThis.indexedDB;

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIndexedDB,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  const dummyProject: Project = {
    format: 'tpdd-project',
    schemaVersion: 2,
    id: 'proj-1',
    title: 'Test Project',
    description: 'Test description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rootDiagramId: 'diag-root',
    nodeKinds: [
      {
        id: 'function',
        label: '機能',
        description: 'システムが実現する働き',
        paletteKey: 'teal',
      },
    ],
    diagrams: [
      {
        id: 'diag-root',
        title: 'Root Diagram',
        nodes: [
          {
            id: 'node-1',
            label: 'Test Node',
            kindId: 'function',
            status: 'draft',
            levelId: 'lvl-1',
            x: 100,
            y: 100,
            width: 140,
            height: 60,
            meta: {
              description: 'Test description',
              tags: [],
              sourceLinks: [],
            },
            provenance: {
              origin: 'manual',
              createdAt: new Date().toISOString(),
            },
          },
        ],
        edges: [],
      },
    ],
    levels: [
      {
        id: 'lvl-1',
        label: 'Level 1',
        description: 'Test level',
      },
    ],
    aiPreferences: {
      modelId: 'test-model',
      temperature: 0.7,
      stream: false,
      timeoutSeconds: 30,
    },
  };

  it('rejects when indexedDB is undefined instead of silently resolving', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    await expect(saveAutoSaveSnapshot('session-1', dummyProject)).rejects.toThrow(
      /IndexedDB is not supported/i
    );
  });

  it('rejects when indexedDB.open fails (e.g. QuotaExceeded or security block)', async () => {
    const mockRequest = {
      onerror: null as ((ev: any) => void) | null,
      onsuccess: null as ((ev: any) => void) | null,
      error: new Error('Database access denied by security policy'),
    };

    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open: vi.fn(() => {
          setTimeout(() => {
            if (mockRequest.onerror) {
              mockRequest.onerror({} as any);
            }
          }, 0);
          return mockRequest;
        }),
      },
      writable: true,
      configurable: true,
    });

    await expect(saveAutoSaveSnapshot('session-1', dummyProject)).rejects.toThrow(
      'Database access denied by security policy'
    );
  });

  it('returns empty array safely in getAllAutoSaveSnapshots when DB is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const snapshots = await getAllAutoSaveSnapshots();
    expect(snapshots).toEqual([]);
  });
});
