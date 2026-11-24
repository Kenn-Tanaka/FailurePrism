import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_VTA_FIXTURES, seedVTAStoreWithFixture } from '../helpers/vtaTestFixtures';
import { createManualAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { MAX_INGESTION_FILE_SIZE, type ParsedFileResult } from '../../src/tools/vta/features/vta/utils/fileIngestion';
import {
  confirmProjectReplacement,
  importProjectJsonFile,
  ingestScenarioDocumentFile,
} from '../../src/tools/vta/features/vta/utils/projectFileLoader';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('VTA プロジェクト切替・下書き復元・25MiB上限ガード', () => {
  const sample0 = TEST_VTA_FIXTURES[0];
  const sample1 = TEST_VTA_FIXTURES[1];

  beforeEach(() => {
    seedVTAStoreWithFixture(0);
    useVTAStore.getState().clearDraftBackup();
    useVTAStore.setState({ past: [], future: [], toasts: [], logs: [] });
  });

  describe('[P1] 文書解析中のプロジェクト切替および連続ドロップの競合保護', () => {
    it('PDF等テキスト解析中にサンプル切替またはJSONプロジェクト読込を行うと、旧解析結果は切替先プロジェクトを書き換えない', async () => {
      const deferred = createDeferred<ParsedFileResult>();
      const parseSpy = vi.fn(async () => deferred.promise);
      const showToast = vi.fn();
      const addLog = vi.fn();
      const onSuccess = vi.fn();

      const fakePdf = { name: 'slow_incident.pdf', type: 'application/pdf', size: 1024 } as File;
      const parsePromise = ingestScenarioDocumentFile(fakePdf, {
        getState: () => useVTAStore.getState(),
        parseFile: parseSpy,
        onSuccess,
        showToast,
        addLog,
      });

      expect(useVTAStore.getState().isParsingFile).toBe(true);

      // 解析中に別サンプルへ切り替え（isParsingFile 中の警告確認も true となること）
      const confirmSpy = vi.fn(() => true);
      expect(confirmProjectReplacement(useVTAStore.getState(), '別サンプルを読み込みます', confirmSpy)).toBe(true);
      expect(confirmSpy).toHaveBeenCalledTimes(1);

      seedVTAStoreWithFixture(1);
      expect(useVTAStore.getState().isParsingFile).toBe(false);
      expect(useVTAStore.getState().scenarioText).toBe(sample1.scenarioText);

      // 遅延していた旧ファイルの解析結果が後から返ってきても切替先は上書きされない
      deferred.resolve({
        text: '古いPDFから抽出されたテキスト',
        filename: 'slow_incident.pdf',
        fileType: 'PDF',
        sizeBytes: 1024,
        characterCount: 15,
      });

      const outcome = await parsePromise;
      expect(outcome.status).toBe('aborted');
      expect(useVTAStore.getState().scenarioText).toBe(sample1.scenarioText);
      expect(useVTAStore.getState().selectedSampleId).toBe(sample1.id);
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('同じプロジェクト内で2ファイルを連続ドロップした場合、後から完了した先発ファイルの結果は破棄される', async () => {
      const firstDeferred = createDeferred<ParsedFileResult>();
      const secondDeferred = createDeferred<ParsedFileResult>();
      const showToast = vi.fn();
      const addLog = vi.fn();
      const applied: string[] = [];

      const firstPromise = ingestScenarioDocumentFile(
        { name: 'first_slow.pdf', type: 'application/pdf', size: 2048 } as File,
        {
          getState: () => useVTAStore.getState(),
          parseFile: async () => firstDeferred.promise,
          onSuccess: (r) => applied.push(r.filename),
          showToast,
          addLog,
        }
      );

      const secondPromise = ingestScenarioDocumentFile(
        { name: 'second_fast.txt', type: 'text/plain', size: 512 } as File,
        {
          getState: () => useVTAStore.getState(),
          parseFile: async () => secondDeferred.promise,
          onSuccess: (r) => applied.push(r.filename),
          showToast,
          addLog,
        }
      );

      secondDeferred.resolve({
        text: '2番目にドロップされた最新シナリオ',
        filename: 'second_fast.txt',
        fileType: 'TXT',
        sizeBytes: 512,
        characterCount: 18,
      });
      const secondOutcome = await secondPromise;
      expect(secondOutcome.status).toBe('applied');
      expect(useVTAStore.getState().scenarioText).toBe('2番目にドロップされた最新シナリオ');

      firstDeferred.resolve({
        text: '1番目にドロップされた古い長文',
        filename: 'first_slow.pdf',
        fileType: 'PDF',
        sizeBytes: 2048,
        characterCount: 16,
      });
      const firstOutcome = await firstPromise;
      expect(['aborted', 'discarded']).toContain(firstOutcome.status);
      expect(useVTAStore.getState().scenarioText).toBe('2番目にドロップされた最新シナリオ');
      expect(applied).toEqual(['second_fast.txt']);
    });
  });

  describe('[P1] 下書き破棄・復元確認の整合性', () => {
    it('サンプル切替・プロジェクトJSON読込・プロジェクト保存で既存の下書きバックアップを破棄する', () => {
      // 1. サンプル切替で下書きが破棄されること
      useVTAStore.getState().setScenarioText('編集中シナリオA');
      expect(useVTAStore.getState().hasDraftBackup).toBe(true);
      expect(useVTAStore.getState().checkDraftBackup()).toBe(true);

      seedVTAStoreWithFixture(1);
      expect(useVTAStore.getState().hasDraftBackup).toBe(false);
      expect(useVTAStore.getState().checkDraftBackup()).toBe(false);

      // 2. JSON読込: 不正JSONでは既存下書きを壊さず、正常JSONでは破棄すること
      useVTAStore.getState().setScenarioText('編集中シナリオB');
      expect(useVTAStore.getState().checkDraftBackup()).toBe(true);

      const badRes = useVTAStore.getState().importProjectJSON('{invalid-json');
      expect(badRes.success).toBe(false);
      expect(useVTAStore.getState().checkDraftBackup()).toBe(true);

      const validProjectJson = JSON.stringify({
        version: '5.0',
        savedAt: new Date().toISOString(),
        scenarioText: '保存済みシナリオ',
        vtaData: { ...sample0.vtaData, analysis: createManualAnalysis(sample0.vtaData) },
      });
      const goodRes = useVTAStore.getState().importProjectJSON(validProjectJson);
      expect(goodRes.success).toBe(true);
      expect(useVTAStore.getState().hasDraftBackup).toBe(false);
      expect(useVTAStore.getState().checkDraftBackup()).toBe(false);

      // 3. プロジェクト保存（exportProjectJSON）で未保存下書きが破棄されること
      useVTAStore.getState().setScenarioText('保存前の編集内容');
      expect(useVTAStore.getState().hasDraftBackup).toBe(true);

      const originalDocument = (globalThis as { document?: unknown }).document;
      const fakeAnchor = {
        setAttribute: vi.fn(),
        click: vi.fn(),
        remove: vi.fn(),
      };
      (globalThis as { document?: unknown }).document = {
        createElement: vi.fn(() => fakeAnchor),
        body: { appendChild: vi.fn() },
      };
      try {
        useVTAStore.getState().exportProjectJSON('saved-project.json');
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
      }

      expect(useVTAStore.getState().isDirty).toBe(false);
      expect(useVTAStore.getState().hasDraftBackup).toBe(false);
      expect(useVTAStore.getState().checkDraftBackup()).toBe(false);
    });

    it('未保存の変更や処理中の状態では下書き復元前に確認を求め、拒否時は作業を維持し、復元時は解析を中断する', () => {
      useVTAStore.getState().setScenarioText('退避された下書きテキスト');
      expect(useVTAStore.getState().hasDraftBackup).toBe(true);

      // 未保存編集がある状態で復元しようとすると確認ダイアログが呼ばれる
      useVTAStore.setState({ isDirty: true, scenarioText: '現在の未保存作業' });
      const declineConfirm = vi.fn(() => false);
      expect(
        confirmProjectReplacement(useVTAStore.getState(), '前回の未保存下書きを復元します', declineConfirm)
      ).toBe(false);
      expect(declineConfirm).toHaveBeenCalledTimes(1);
      expect(useVTAStore.getState().scenarioText).toBe('現在の未保存作業');

      // ファイル解析中に restoreDraftBackup() を実行すると解析もキャンセルされる
      const { controller } = useVTAStore.getState().startFileParse();
      expect(useVTAStore.getState().isParsingFile).toBe(true);

      const acceptConfirm = vi.fn(() => true);
      expect(
        confirmProjectReplacement(useVTAStore.getState(), '前回の未保存下書きを復元します', acceptConfirm)
      ).toBe(true);
      expect(useVTAStore.getState().restoreDraftBackup()).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(useVTAStore.getState().isParsingFile).toBe(false);
      expect(useVTAStore.getState().scenarioText).toBe('退避された下書きテキスト');
    });
  });

  describe('[P2] JSONプロジェクト読込の 25 MiB 入力上限と警告打切り', () => {
    it('25 MiB を超えるプロジェクト JSON (.json / .JSON) はメモリ読込前に打ち切り、警告を発する', async () => {
      const textSpy = vi.fn(async () => '{}');
      const importSpy = vi.fn(() => ({ success: true, message: 'ok' }));
      const confirmSpy = vi.fn(() => true);
      const showToast = vi.fn();
      const addLog = vi.fn();
      const onValidationError = vi.fn();

      const oversizedFile = {
        name: 'oversized_project.JSON',
        size: MAX_INGESTION_FILE_SIZE + 1,
        text: textSpy,
      };

      const res = await importProjectJsonFile(oversizedFile, {
        getBusyState: () => ({ ...useVTAStore.getState(), isDirty: true }),
        getCurrentProjectId: () => useVTAStore.getState().currentProjectId,
        importProjectJSON: importSpy,
        showToast,
        addLog,
        onValidationError,
        confirm: confirmSpy,
      });

      expect(res.status).toBe('rejected_size');
      expect(textSpy).not.toHaveBeenCalled();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(importSpy).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('warn', expect.stringContaining('25MiB'));
      expect(addLog).toHaveBeenCalledWith('warn', expect.stringContaining('25MiB'), 'PROJECT_IMPORT');
      expect(onValidationError).toHaveBeenCalledWith(expect.stringContaining('25MiB'));
    });

    it('未保存または解析中に確認ダイアログをキャンセルした場合、ファイルを読まずに中止する', async () => {
      const textSpy = vi.fn(async () => '{}');
      const confirmSpy = vi.fn(() => false);
      const res = await importProjectJsonFile(
        { name: 'normal.json', size: 128, text: textSpy },
        {
          getBusyState: () => ({ isDirty: false, isParsingFile: true }),
          getCurrentProjectId: () => useVTAStore.getState().currentProjectId,
          importProjectJSON: useVTAStore.getState().importProjectJSON,
          showToast: vi.fn(),
          addLog: vi.fn(),
          confirm: confirmSpy,
        }
      );

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('cancelled');
      expect(textSpy).not.toHaveBeenCalled();
    });

    it('25 MiB 以下の有効なプロジェクト JSON を読み込み、既存下書きを破棄する', async () => {
      useVTAStore.getState().setScenarioText('読込前の下書き');
      expect(useVTAStore.getState().hasDraftBackup).toBe(true);

      const jsonText = JSON.stringify({
        version: '5.0',
        savedAt: new Date().toISOString(),
        scenarioText: '25MiB以内のJSONプロジェクト',
        vtaData: { ...sample1.vtaData, analysis: createManualAnalysis(sample1.vtaData) },
      });
      const res = await importProjectJsonFile(
        {
          name: 'valid.json',
          size: jsonText.length,
          text: async () => jsonText,
        },
        {
          getBusyState: () => useVTAStore.getState(),
          getCurrentProjectId: () => useVTAStore.getState().currentProjectId,
          importProjectJSON: useVTAStore.getState().importProjectJSON,
          showToast: useVTAStore.getState().showToast,
          addLog: useVTAStore.getState().addLog,
          confirm: () => true,
        }
      );

      expect(res.status).toBe('imported');
      expect(useVTAStore.getState().scenarioText).toBe('25MiB以内のJSONプロジェクト');
      expect(useVTAStore.getState().hasDraftBackup).toBe(false);
    });

    it('JSONテキスト読込の完了前にプロジェクトが切り替わった場合は古いJSONを反映せず中止する', async () => {
      const textDeferred = createDeferred<string>();
      const importSpy = vi.fn(useVTAStore.getState().importProjectJSON);

      const loadPromise = importProjectJsonFile(
        {
          name: 'slow.json',
          size: 256,
          text: () => textDeferred.promise,
        },
        {
          getBusyState: () => useVTAStore.getState(),
          getCurrentProjectId: () => useVTAStore.getState().currentProjectId,
          importProjectJSON: importSpy,
          showToast: vi.fn(),
          addLog: vi.fn(),
          confirm: () => true,
        }
      );

      seedVTAStoreWithFixture(1);

      textDeferred.resolve(
        JSON.stringify({
          version: '5.0',
          savedAt: new Date().toISOString(),
          scenarioText: '遅れて到着したJSON',
          vtaData: { ...sample0.vtaData, analysis: createManualAnalysis(sample0.vtaData) },
        })
      );

      const res = await loadPromise;
      expect(res.status).toBe('superseded');
      expect(importSpy).not.toHaveBeenCalled();
      expect(useVTAStore.getState().scenarioText).toBe(sample1.scenarioText);
    });
  });
});
