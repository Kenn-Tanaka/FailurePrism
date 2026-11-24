import {
  parseFileToScenarioText,
  validateIngestionFileSize,
  type IngestionProgressCallback,
  type ParsedFileResult,
} from './fileIngestion';

export interface ProjectSessionBusyState {
  isDirty: boolean;
  isParsingFile?: boolean;
  isExtracting?: boolean;
  isRegenerating?: boolean;
  isProposing?: boolean;
}

export type ConfirmDialogFn = (message: string) => boolean;

/**
 * プロジェクト置換や下書き復元で確認が必要な状態（未保存変更・進行中の解析/AI処理）かを判定します。
 */
export function hasUnsavedOrActiveProjectWork(state: ProjectSessionBusyState): boolean {
  return Boolean(
    state.isDirty ||
      state.isParsingFile ||
      state.isExtracting ||
      state.isRegenerating ||
      state.isProposing
  );
}

/**
 * 未保存の変更または進行中の解析・生成処理がある場合に確認ダイアログを表示します。
 * ブラウザ外のテスト等で confirm 関数が利用できない場合は true を返します。
 */
export function confirmProjectReplacement(
  state: ProjectSessionBusyState,
  actionDescription: string,
  confirmFn?: ConfirmDialogFn
): boolean {
  const hasActiveWork = Boolean(
    state.isParsingFile || state.isExtracting || state.isRegenerating || state.isProposing
  );
  if (!state.isDirty && !hasActiveWork) {
    return true;
  }

  let message: string;
  if (state.isDirty && hasActiveWork) {
    message =
      `現在のプロジェクトに未保存の変更および実行中の解析・生成処理があります。\n` +
      `処理を中断して現在のプロジェクトを破棄し、${actionDescription}か？\n` +
      `（キャンセルして先に「プロジェクト保存」を行うことができます）`;
  } else if (hasActiveWork) {
    message =
      `現在、ファイル解析またはAI処理を実行中です。\n` +
      `実行中の処理を中断して現在のプロジェクトをクリアし、${actionDescription}か？`;
  } else {
    message =
      `現在のプロジェクトに変更が保存されていません。\n` +
      `現在のプロジェクトを破棄して${actionDescription}か？\n` +
      `（キャンセルして先に「プロジェクト保存」を行うことができます）`;
  }

  const invoker =
    confirmFn ??
    (typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? (msg: string) => window.confirm(msg)
      : null);

  return invoker ? invoker(message) : true;
}

function readTextWithFileReader(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      resolve(typeof event.target?.result === 'string' ? event.target.result : '');
    };
    reader.onerror = () => {
      reject(new Error('ファイルの読み込み中にエラーが発生しました。アクセス権限やファイル破損をご確認ください。'));
    };
    reader.readAsText(file);
  });
}

export type ProjectJsonReadableFile = Pick<File, 'name' | 'size'> & {
  text?: () => Promise<string>;
};

export interface ImportProjectJsonFileDeps {
  getBusyState: () => ProjectSessionBusyState;
  getCurrentProjectId: () => string;
  importProjectJSON: (
    jsonString: string
  ) => { success: boolean; message: string } | Promise<{ success: boolean; message: string }>;
  showToast: (type: 'success' | 'error' | 'info' | 'warn', message: string) => void;
  addLog: (type: 'info' | 'success' | 'warn' | 'error', message: string, stageTag?: string) => void;
  onValidationError?: (message: string) => void;
  confirm?: ConfirmDialogFn;
}

export type ImportProjectJsonFileResult =
  | { status: 'rejected_size'; message: string }
  | { status: 'cancelled' }
  | { status: 'superseded'; message: string }
  | { status: 'imported'; text: string; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'read_error'; message: string };

/**
 * 25 MiB 入力上限チェック、未保存/処理中確認、非同期読込中のプロジェクト切替ガードを統一的に適用し、
 * VTA プロジェクト JSON を安全にインポートします。
 */
export async function importProjectJsonFile(
  file: ProjectJsonReadableFile,
  deps: ImportProjectJsonFileDeps
): Promise<ImportProjectJsonFileResult> {
  const sizeCheck = validateIngestionFileSize(file);
  if (!sizeCheck.valid) {
    deps.showToast('warn', sizeCheck.message);
    deps.addLog('warn', sizeCheck.message, 'PROJECT_IMPORT');
    deps.onValidationError?.(sizeCheck.message);
    return { status: 'rejected_size', message: sizeCheck.message };
  }

  const confirmed = confirmProjectReplacement(
    deps.getBusyState(),
    '保存済みプロジェクトを読み込みます',
    deps.confirm
  );
  if (!confirmed) {
    return { status: 'cancelled' };
  }

  const startProjectId = deps.getCurrentProjectId();

  let content: string;
  try {
    content =
      typeof file.text === 'function'
        ? await file.text()
        : await readTextWithFileReader(file as File);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'ファイルの読み込みに失敗しました。';
    deps.showToast('error', message);
    deps.addLog('error', `読込エラー「${file.name}」: ${message}`, 'PROJECT_IMPORT');
    deps.onValidationError?.(`ファイル読込エラー: ${message}`);
    return { status: 'read_error', message };
  }

  if (deps.getCurrentProjectId() !== startProjectId) {
    const message = 'ファイル読込中に別のプロジェクトへ切り替わったため、インポートを中止しました。';
    deps.addLog('warn', message, 'PROJECT_IMPORT');
    return { status: 'superseded', message };
  }

  const res = await deps.importProjectJSON(content);
  if (!res.success) {
    deps.onValidationError?.(`JSONのインポートに失敗しました: ${res.message}`);
    return { status: 'invalid', message: res.message };
  }

  return { status: 'imported', text: content, message: res.message };
}

export interface IngestScenarioDocumentDeps {
  getState: () => {
    currentProjectId: string;
    activeFileParseRequestId: number;
    isParsingFile: boolean;
    isExtracting: boolean;
    isRegenerating: boolean;
    isProposing: boolean;
    startFileParse: () => { reqId: number; projectId: string; controller: AbortController };
    finishFileParse: (reqId: number) => void;
    clearDraftBackup: () => void;
    setScenarioText: (text: string) => void;
  };
  parseFile?: (
    file: File,
    onProgress?: IngestionProgressCallback,
    options?: { signal?: AbortSignal }
  ) => Promise<ParsedFileResult>;
  onProgress?: (stage: string | null) => void;
  onError?: (message: string | null) => void;
  onSuccess?: (result: ParsedFileResult) => void;
  showToast: (type: 'success' | 'error' | 'info' | 'warn', message: string) => void;
  addLog: (type: 'info' | 'success' | 'warn' | 'error', message: string, stageTag?: string) => void;
}

export type IngestScenarioDocumentResult =
  | { status: 'blocked_ai' }
  | { status: 'discarded' }
  | { status: 'aborted' }
  | { status: 'error'; message: string }
  | { status: 'applied'; result: ParsedFileResult };

/**
 * 非JSON文書をシナリオ本文へ取り込みます。
 * 開始時のプロジェクトIDと解析要求IDを追跡し、プロジェクト切替や後続ドロップに追い抜かれた結果は破棄します。
 */
export async function ingestScenarioDocumentFile(
  file: File,
  deps: IngestScenarioDocumentDeps
): Promise<IngestScenarioDocumentResult> {
  const storeAtStart = deps.getState();
  if (storeAtStart.isExtracting || storeAtStart.isRegenerating || storeAtStart.isProposing) {
    deps.showToast('warn', 'AI処理中は新しいシナリオファイルを取り込めません。');
    return { status: 'blocked_ai' };
  }

  const { reqId, projectId: startProjectId, controller } = storeAtStart.startFileParse();
  deps.onProgress?.(null);
  deps.onError?.(null);

  const parser = deps.parseFile ?? parseFileToScenarioText;

  try {
    deps.addLog('info', `ファイル「${file.name}」(${file.type || '未指定'}) の解析を開始します...`, 'FILE_PARSE');
    const result = await parser(
      file,
      (p) => {
        const latest = deps.getState();
        if (latest.currentProjectId === startProjectId && latest.activeFileParseRequestId === reqId) {
          deps.onProgress?.(p.stage);
        }
      },
      { signal: controller.signal }
    );

    const latest = deps.getState();
    if (
      controller.signal.aborted ||
      latest.currentProjectId !== startProjectId ||
      latest.activeFileParseRequestId !== reqId
    ) {
      if (!controller.signal.aborted && latest.currentProjectId === startProjectId) {
        deps.addLog('warn', `後続のファイル解析が始まったため、「${file.name}」の解析結果を破棄しました。`, 'FILE_PARSE');
      }
      return { status: controller.signal.aborted ? 'aborted' : 'discarded' };
    }

    latest.clearDraftBackup();
    latest.setScenarioText(result.text);
    deps.onSuccess?.(result);
    deps.addLog(
      'success',
      `「${result.filename}」(${result.fileType.toUpperCase()}) の抽出完了: ${result.characterCount.toLocaleString()}文字をシナリオに入力しました。`,
      'FILE_PARSE'
    );
    return { status: 'applied', result };
  } catch (err: unknown) {
    if ((err instanceof Error && err.name === 'AbortError') || controller.signal.aborted) {
      return { status: 'aborted' };
    }
    const latest = deps.getState();
    if (latest.currentProjectId !== startProjectId || latest.activeFileParseRequestId !== reqId) {
      return { status: 'discarded' };
    }
    const msg = err instanceof Error ? err.message : 'ファイル解析中にエラーが発生しました。';
    deps.onError?.(`ファイル解析エラー: ${msg}`);
    deps.addLog('error', `解析エラー「${file.name}」: ${msg}`, 'FILE_PARSE');
    return { status: 'error', message: msg };
  } finally {
    deps.getState().finishFileParse(reqId);
    if (!deps.getState().isParsingFile) {
      deps.onProgress?.(null);
    }
  }
}
