import { Project } from './schema';

export interface HistoryState {
  past: Project[];
  present: Project;
  future: Project[];
  revision: number; // 単調増加カウンター (Undo/Redo時もインクリメント)
}

const MAX_HISTORY_LENGTH = 50;

/**
 * 履歴初期状態生成
 */
export function createHistoryState(initialProject: Project): HistoryState {
  return {
    past: [],
    present: initialProject,
    future: [],
    revision: 1,
  };
}

/**
 * 新しい確定操作をプッシュする純粋関数
 */
export function pushHistory(
  state: HistoryState,
  newProject: Project
): HistoryState {
  // 変更がない場合は何もしない
  if (state.present === newProject) {
    return state;
  }

  const past = [...state.past, state.present];
  if (past.length > MAX_HISTORY_LENGTH) {
    past.shift();
  }

  return {
    past,
    present: newProject,
    future: [], // 新しい操作によりRedo履歴は破棄
    revision: state.revision + 1,
  };
}

/**
 * Undo処理
 */
export function undoHistory(state: HistoryState): HistoryState {
  if (state.past.length === 0) return state;

  const previous = state.past[state.past.length - 1];
  const newPast = state.past.slice(0, state.past.length - 1);

  return {
    past: newPast,
    present: previous,
    future: [state.present, ...state.future],
    revision: state.revision + 1, // 仕様書 4.3: Undoでもrevisionを増やし、古い値へ戻さない
  };
}

/**
 * Redo処理
 */
export function redoHistory(state: HistoryState): HistoryState {
  if (state.future.length === 0) return state;

  const next = state.future[0];
  const newFuture = state.future.slice(1);

  return {
    past: [...state.past, state.present],
    present: next,
    future: newFuture,
    revision: state.revision + 1, // 仕様書 4.3: Redoでもrevisionを増やす
  };
}
