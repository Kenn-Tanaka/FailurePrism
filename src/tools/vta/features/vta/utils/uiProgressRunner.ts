import type { DeterministicTaskLevel, VTADeterministicTaskState } from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';
import { yieldForPaint } from './paintYield';
import {
  importProjectJsonFile,
  type ImportProjectJsonFileResult,
  type ProjectJsonReadableFile,
} from './projectFileLoader';

export { yieldForPaint };

export interface DeterministicUiTaskOptions {
  actionKey: string;
  level: DeterministicTaskLevel;
  title: string;
  detail?: string;
  stepCurrent?: number;
  stepTotal?: number;
}

export interface DeterministicTaskStepPatch {
  title?: string;
  detail?: string;
  stepCurrent?: number;
  stepTotal?: number;
}

let uiTaskSeq = 0;

/**
 * Checks whether a deterministic UI task matching `actionKey` is currently running.
 */
export function isUiActionBusy(
  uiTaskProgress: VTADeterministicTaskState | null | undefined,
  actionKey: string
): boolean {
  return Boolean(uiTaskProgress && uiTaskProgress.actionKey === actionKey);
}

/**
 * Executes deterministic work while guaranteeing that pending UI busy states
 * (button spinners, inline pills, or step overlays) are painted before heavy
 * synchronous work runs on the main thread.
 */
export async function runDeterministicUiTask<T>(
  options: DeterministicUiTaskOptions,
  workFn: (updateStep: (patch: DeterministicTaskStepPatch) => Promise<void>) => T | Promise<T>
): Promise<T | undefined> {
  const store = useVTAStore.getState();
  if (store.uiTaskProgress) {
    return undefined;
  }

  const taskId = `ui_task_${++uiTaskSeq}_${Date.now()}`;
  const setProgress = (next: VTADeterministicTaskState | null) => {
    useVTAStore.getState().setUiTaskProgress(next);
  };

  setProgress({
    id: taskId,
    level: options.level,
    actionKey: options.actionKey,
    title: options.title,
    detail: options.detail,
    stepCurrent: options.stepCurrent,
    stepTotal: options.stepTotal,
  });

  await yieldForPaint();

  const updateStep = async (patch: DeterministicTaskStepPatch): Promise<void> => {
    const current = useVTAStore.getState().uiTaskProgress;
    if (!current || current.id !== taskId) return;
    setProgress({
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.stepCurrent !== undefined ? { stepCurrent: patch.stepCurrent } : {}),
      ...(patch.stepTotal !== undefined ? { stepTotal: patch.stepTotal } : {}),
    });
    await yieldForPaint();
  };

  try {
    return await workFn(updateStep);
  } finally {
    const current = useVTAStore.getState().uiTaskProgress;
    if (current?.id === taskId) {
      setProgress(null);
    }
  }
}

/**
 * Shared UI helper for importing a VTA project `.json` file with multi-step overlay progress.
 */
export async function importProjectJsonWithOverlay(
  file: ProjectJsonReadableFile,
  onValidationError?: (message: string) => void
): Promise<ImportProjectJsonFileResult> {
  const store = useVTAStore.getState();
  return importProjectJsonFile(file, {
    getBusyState: () => useVTAStore.getState(),
    getCurrentProjectId: () => useVTAStore.getState().currentProjectId,
    importProjectJSON: async (content) => {
      const res = await runDeterministicUiTask(
        {
          actionKey: 'project_import',
          level: 'overlay',
          title: `プロジェクト「${file.name}」を読み込み中...`,
          detail: 'JSONデータを解析しています...',
          stepCurrent: 1,
          stepTotal: 3,
        },
        (updateStep) => useVTAStore.getState().importProjectJSONWithProgress(content, updateStep)
      );
      return res ?? { success: false, message: '他の処理が実行中です。' };
    },
    showToast: store.showToast,
    addLog: store.addLog,
    onValidationError,
  });
}
