import React, { createContext, useContext, useReducer } from 'react';
import {
  addLevel,
  addNodeToDiagram,
  addEdgeToDiagram,
  createNewProject,
  createSubDiagramForNode,
  removeDiagramCascade,
  removeEdgeFromDiagram,
  removeLevelWithReassign,
  removeNodeWithDescendants,
  updateDiagramTitle,
  updateEdgeInDiagram,
  updateLevel,
  updateNodeInDiagram,
  updateNodesPosition,
  updateProjectTitle,
  updateProjectMeta,
  validateEdgePatch,
  validateNodePatch,
  validateProjectMetaPatch,
} from '../domain/commands';
import {
  HistoryState,
  createHistoryState,
  pushHistory,
  redoHistory,
  undoHistory,
} from '../domain/history';
import { EdgeKind, NodeKind, NodeStatus, Project, TPDD_LIMITS, ThoughtNode } from '../domain/schema';
import { computeAutoLayout } from '../rendering/autoLayout';
import { saveAutoSaveSnapshot } from '../services/persistence/indexedDb';

// 一時UI状態
export interface Viewport {
  panX: number;
  panY: number;
  zoom: number; // 0.25 - 4.0
}

export interface DragNodeOffset {
  nodeId: string;
  initialX: number;
  initialY: number;
}

export interface DragState {
  nodeId: string;
  offsetX: number;
  offsetY: number;
  currentX: number;
  currentY: number;
  initialPositions?: DragNodeOffset[];
}

export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface UIState {
  activeDiagramId: string;
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  edgeDraftSourceId: string | null; // エッジ作成中の始点ノードID
  viewports: Record<string, Viewport>; // 図IDごとのズーム・パン
  dragState: DragState | null;
  activeRightTab: 'detail' | 'ai';
  // 設定関連の一時状態
  gatewayToken: string; // メモリ限定保持
  notification: AppNotification | null;
  editingNodeId: string | null; // インプレース編集中のノードID
}

export interface AppState {
  history: HistoryState;
  ui: UIState;
}

// アクション定義
export type AppAction =
  // プロジェクト・履歴操作
  | { type: 'LOAD_PROJECT'; project: Project }
  | { type: 'NEW_PROJECT'; title?: string }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  // 図内要素操作 (確定操作)
  | {
      type: 'ADD_NODE';
      params: {
        label?: string;
        kind?: NodeKind;
        status?: NodeStatus;
        levelId: string;
        x: number;
        y: number;
      };
    }
  | {
      type: 'UPDATE_NODE';
      nodeId: string;
      patch: Partial<Omit<ThoughtNode, 'id' | 'provenance'>>;
    }
  | { type: 'REMOVE_NODE'; nodeId: string }
  | {
      type: 'ADD_EDGE';
      params: { sourceId: string; targetId: string; kind: EdgeKind; label?: string };
    }
  | { type: 'UPDATE_EDGE'; edgeId: string; patch: { kind?: EdgeKind; label?: string } }
  | { type: 'REMOVE_EDGE'; edgeId: string }
  // UI一時状態操作
  | { type: 'SET_ACTIVE_DIAGRAM'; diagramId: string }
  | { type: 'SELECT_NODE'; nodeId: string | null; multi?: boolean }
  | { type: 'SELECT_NODES'; nodeIds: string[] }
  | { type: 'SET_EDITING_NODE'; nodeId: string | null }
  | { type: 'UPDATE_NODES_POSITION'; positions: { id: string; x: number; y: number }[] }
  | { type: 'REMOVE_SELECTED_ELEMENTS' }
  | { type: 'SELECT_EDGE'; edgeId: string | null }
  | { type: 'SET_EDGE_DRAFT_SOURCE'; sourceId: string | null }
  | { type: 'SET_VIEWPORT'; diagramId: string; viewport: Viewport }
  | { type: 'START_DRAG'; dragState: DragState }
  | { type: 'UPDATE_DRAG'; currentX: number; currentY: number }
  | { type: 'COMMIT_DRAG' }
  | { type: 'CANCEL_DRAG' }
  | { type: 'SET_RIGHT_TAB'; tab: 'detail' | 'ai' }
  | { type: 'SET_GATEWAY_TOKEN'; token: string }
  | { type: 'UPDATE_PROJECT_MODEL'; modelId: string }
  | { type: 'UPDATE_AI_PREFERENCES'; patch: Partial<Project['aiPreferences']> }
  // 段階2: 階層・列・自動配置操作
  | { type: 'AUTO_LAYOUT' }
  | { type: 'CREATE_SUB_DIAGRAM'; parentNodeId: string }
  | { type: 'REMOVE_DIAGRAM'; diagramId: string }
  | { type: 'UPDATE_DIAGRAM_TITLE'; diagramId: string; title: string }
  | { type: 'UPDATE_PROJECT_TITLE'; title: string }
  | { type: 'UPDATE_PROJECT_META'; patch: { title?: string; description?: string } }
  | { type: 'ADD_LEVEL'; label: string }
  | { type: 'UPDATE_LEVEL'; levelId: string; patch: { label?: string; order?: number } }
  | { type: 'REORDER_LEVELS'; levels: Project['levels'] }
  | { type: 'REMOVE_LEVEL'; levelIdToRemove: string; targetLevelId: string }
  | { type: 'APPLY_PROJECT_UPDATE'; project: Project }
  | { type: 'SET_NOTIFICATION'; notification: AppNotification | null }
  | { type: 'CLEAR_NOTIFICATION' };

export function appReducer(state: AppState, action: AppAction): AppState {
  const currentProject = state.history.present;
  const currentDiagId = currentProject.diagrams.some((d) => d.id === state.ui.activeDiagramId)
    ? state.ui.activeDiagramId
    : currentProject.rootDiagramId;

  switch (action.type) {
    case 'APPLY_PROJECT_UPDATE': {
      // AI提案採用等、プロジェクト全体更新時にUndo履歴に1ステップ記録する
      // 現在アクティブな図が更新後プロジェクトに存在すれば画面を維持する
      const nextDiagId = action.project.diagrams.some((d) => d.id === state.ui.activeDiagramId)
        ? state.ui.activeDiagramId
        : action.project.rootDiagramId;
      return {
        history: pushHistory(state.history, action.project),
        ui: {
          ...state.ui,
          activeDiagramId: nextDiagId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          edgeDraftSourceId: null,
          dragState: null,
          editingNodeId: null,
        },
      };
    }

    case 'LOAD_PROJECT': {
      return {
        history: createHistoryState(action.project),
        ui: {
          ...state.ui,
          activeDiagramId: action.project.rootDiagramId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          edgeDraftSourceId: null,
          dragState: null,
          editingNodeId: null,
        },
      };
    }

    case 'NEW_PROJECT': {
      const newProj = createNewProject(action.title);
      return {
        history: createHistoryState(newProj),
        ui: {
          ...state.ui,
          activeDiagramId: newProj.rootDiagramId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          edgeDraftSourceId: null,
          dragState: null,
          editingNodeId: null,
        },
      };
    }

    case 'UNDO': {
      const nextHistory = undoHistory(state.history);
      const nextDiagId = nextHistory.present.diagrams.some((d) => d.id === state.ui.activeDiagramId)
        ? state.ui.activeDiagramId
        : nextHistory.present.rootDiagramId;
      return {
        ...state,
        history: nextHistory,
        ui: {
          ...state.ui,
          activeDiagramId: nextDiagId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          edgeDraftSourceId: null,
          dragState: null,
          editingNodeId: null,
        },
      };
    }

    case 'REDO': {
      const nextHistory = redoHistory(state.history);
      const nextDiagId = nextHistory.present.diagrams.some((d) => d.id === state.ui.activeDiagramId)
        ? state.ui.activeDiagramId
        : nextHistory.present.rootDiagramId;
      return {
        ...state,
        history: nextHistory,
        ui: {
          ...state.ui,
          activeDiagramId: nextDiagId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          edgeDraftSourceId: null,
          dragState: null,
          editingNodeId: null,
        },
      };
    }

    case 'ADD_NODE': {
      if (!currentProject.levels.some((l) => l.id === action.params.levelId)) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: '指定された抽象度列が存在しません',
            },
          },
        };
      }
      const { project, newNode, error } = addNodeToDiagram(
        currentProject,
        currentDiagId,
        action.params
      );
      if (error || project === currentProject) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: error || 'ノードの作成に失敗しました',
            },
          },
        };
      }
      return {
        history: pushHistory(state.history, project),
        ui: {
          ...state.ui,
          selectedNodeId: newNode.id,
          selectedNodeIds: [newNode.id],
          selectedEdgeId: null,
          editingNodeId: null,
        },
      };
    }

    case 'UPDATE_NODE': {
      const validationError = validateNodePatch(
        currentProject,
        currentDiagId,
        action.nodeId,
        action.patch
      );
      if (validationError) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: validationError,
            },
          },
        };
      }
      const updatedProject = updateNodeInDiagram(
        currentProject,
        currentDiagId,
        action.nodeId,
        action.patch
      );
      if (updatedProject === currentProject) {
        return state;
      }
      return {
        ...state,
        history: pushHistory(state.history, updatedProject),
      };
    }

    case 'REMOVE_NODE': {
      const { project: updatedProject } = removeNodeWithDescendants(
        currentProject,
        currentDiagId,
        action.nodeId
      );
      return {
        history: pushHistory(state.history, updatedProject),
        ui: {
          ...state.ui,
          selectedNodeId: state.ui.selectedNodeId === action.nodeId ? null : state.ui.selectedNodeId,
          selectedNodeIds: state.ui.selectedNodeIds.filter((id) => id !== action.nodeId),
          editingNodeId: state.ui.editingNodeId === action.nodeId ? null : state.ui.editingNodeId,
        },
      };
    }

    case 'ADD_EDGE': {
      const result = addEdgeToDiagram(currentProject, currentDiagId, action.params);
      if (result.error || !result.newEdge) {
        return {
          ...state,
          ui: {
            ...state.ui,
            edgeDraftSourceId: null,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: result.error || 'エッジの作成に失敗しました',
            },
          },
        };
      }
      return {
        history: pushHistory(state.history, result.project),
        ui: {
          ...state.ui,
          selectedEdgeId: result.newEdge.id,
          selectedNodeId: null,
          selectedNodeIds: [],
          edgeDraftSourceId: null,
        },
      };
    }

    case 'UPDATE_EDGE': {
      const validationError = validateEdgePatch(
        currentProject,
        currentDiagId,
        action.edgeId,
        action.patch
      );
      if (validationError) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: validationError,
            },
          },
        };
      }
      const updatedProject = updateEdgeInDiagram(
        currentProject,
        currentDiagId,
        action.edgeId,
        action.patch
      );
      if (updatedProject === currentProject) {
        return state;
      }
      return {
        ...state,
        history: pushHistory(state.history, updatedProject),
      };
    }

    case 'REMOVE_EDGE': {
      const updatedProject = removeEdgeFromDiagram(currentProject, currentDiagId, action.edgeId);
      return {
        history: pushHistory(state.history, updatedProject),
        ui: {
          ...state.ui,
          selectedEdgeId: state.ui.selectedEdgeId === action.edgeId ? null : state.ui.selectedEdgeId,
        },
      };
    }

    case 'SET_ACTIVE_DIAGRAM': {
      return {
        ...state,
        ui: {
          ...state.ui,
          activeDiagramId: action.diagramId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          edgeDraftSourceId: null,
          dragState: null,
          editingNodeId: null,
        },
      };
    }

    case 'SELECT_NODE': {
      if (action.nodeId === null) {
        return {
          ...state,
          ui: {
            ...state.ui,
            selectedNodeId: null,
            selectedNodeIds: [],
            selectedEdgeId: null,
            editingNodeId: null,
          },
        };
      }
      if (action.multi) {
        const already = state.ui.selectedNodeIds.includes(action.nodeId);
        const nextIds = already
          ? state.ui.selectedNodeIds.filter((id) => id !== action.nodeId)
          : [...state.ui.selectedNodeIds, action.nodeId];
        return {
          ...state,
          ui: {
            ...state.ui,
            selectedNodeId: nextIds[0] || null,
            selectedNodeIds: nextIds,
            selectedEdgeId: null,
            editingNodeId: null,
          },
        };
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          selectedNodeId: action.nodeId,
          selectedNodeIds: [action.nodeId],
          selectedEdgeId: null,
          editingNodeId: null,
        },
      };
    }

    case 'SELECT_NODES': {
      return {
        ...state,
        ui: {
          ...state.ui,
          selectedNodeIds: action.nodeIds,
          selectedNodeId: action.nodeIds[0] || null,
          selectedEdgeId: null,
          editingNodeId: null,
        },
      };
    }

    case 'SET_EDITING_NODE': {
      return {
        ...state,
        ui: {
          ...state.ui,
          editingNodeId: action.nodeId,
        },
      };
    }

    case 'UPDATE_NODES_POSITION': {
      const updated = updateNodesPosition(currentProject, currentDiagId, action.positions);
      return {
        ...state,
        history: pushHistory(state.history, updated),
      };
    }

    case 'REMOVE_SELECTED_ELEMENTS': {
      let updated = currentProject;
      if (state.ui.selectedEdgeId) {
        updated = removeEdgeFromDiagram(updated, currentDiagId, state.ui.selectedEdgeId);
      }
      if (state.ui.selectedNodeIds.length > 0) {
        for (const nodeId of state.ui.selectedNodeIds) {
          const res = removeNodeWithDescendants(updated, currentDiagId, nodeId);
          updated = res.project;
        }
      }
      return {
        history: pushHistory(state.history, updated),
        ui: {
          ...state.ui,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          editingNodeId: null,
        },
      };
    }

    case 'SELECT_EDGE': {
      return {
        ...state,
        ui: {
          ...state.ui,
          selectedEdgeId: action.edgeId,
          selectedNodeId: null,
          selectedNodeIds: [],
          editingNodeId: null,
        },
      };
    }

    case 'SET_EDGE_DRAFT_SOURCE': {
      return {
        ...state,
        ui: {
          ...state.ui,
          edgeDraftSourceId: action.sourceId,
        },
      };
    }

    case 'SET_VIEWPORT': {
      return {
        ...state,
        ui: {
          ...state.ui,
          viewports: {
            ...state.ui.viewports,
            [action.diagramId]: action.viewport,
          },
        },
      };
    }

    case 'START_DRAG': {
      return {
        ...state,
        ui: {
          ...state.ui,
          dragState: action.dragState,
        },
      };
    }

    case 'UPDATE_DRAG': {
      if (!state.ui.dragState) return state;
      return {
        ...state,
        ui: {
          ...state.ui,
          dragState: {
            ...state.ui.dragState,
            currentX: action.currentX,
            currentY: action.currentY,
          },
        },
      };
    }

    case 'COMMIT_DRAG': {
      if (!state.ui.dragState) return state;
      const { nodeId, currentX, currentY, initialPositions } = state.ui.dragState;

      // 移動量がゼロ（単なるクリック）の場合はUndo履歴を追加せずdragStateのみリセット
      if (initialPositions && initialPositions.length > 1) {
        const mainInitial = initialPositions.find((n) => n.nodeId === nodeId);
        const dx = currentX - (mainInitial ? mainInitial.initialX : currentX);
        const dy = currentY - (mainInitial ? mainInitial.initialY : currentY);
        if (Math.round(dx) === 0 && Math.round(dy) === 0) {
          return {
            ...state,
            ui: {
              ...state.ui,
              dragState: null,
            },
          };
        }
        const positions = initialPositions.map((n) => ({
          id: n.nodeId,
          x: Math.round(n.initialX + dx),
          y: Math.round(n.initialY + dy),
        }));
        const updatedProject = updateNodesPosition(currentProject, currentDiagId, positions);
        return {
          history: pushHistory(state.history, updatedProject),
          ui: {
            ...state.ui,
            dragState: null,
          },
        };
      } else {
        const diag = currentProject.diagrams.find((d) => d.id === currentDiagId);
        const currentNode = diag?.nodes.find((n) => n.id === nodeId);
        if (currentNode && Math.round(currentX) === currentNode.x && Math.round(currentY) === currentNode.y) {
          return {
            ...state,
            ui: {
              ...state.ui,
              dragState: null,
            },
          };
        }
        const updatedProject = updateNodeInDiagram(currentProject, currentDiagId, nodeId, {
          x: Math.round(currentX),
          y: Math.round(currentY),
        });
        return {
          history: pushHistory(state.history, updatedProject),
          ui: {
            ...state.ui,
            dragState: null,
          },
        };
      }
    }

    case 'CANCEL_DRAG': {
      return {
        ...state,
        ui: {
          ...state.ui,
          dragState: null,
        },
      };
    }

    case 'UPDATE_AI_PREFERENCES': {
      const updatedProject: Project = {
        ...currentProject,
        aiPreferences: {
          ...currentProject.aiPreferences,
          ...action.patch,
        },
        updatedAt: new Date().toISOString(),
      };
      return {
        ...state,
        history: pushHistory(state.history, updatedProject),
      };
    }

    case 'SET_RIGHT_TAB': {
      return {
        ...state,
        ui: {
          ...state.ui,
          activeRightTab: action.tab,
        },
      };
    }

    case 'SET_GATEWAY_TOKEN': {
      return {
        ...state,
        ui: {
          ...state.ui,
          gatewayToken: action.token,
        },
      };
    }

    case 'UPDATE_PROJECT_MODEL': {
      const updated: Project = {
        ...currentProject,
        updatedAt: new Date().toISOString(),
        aiPreferences: {
          ...currentProject.aiPreferences,
          modelId: action.modelId,
        },
      };
      return {
        ...state,
        history: pushHistory(state.history, updated),
      };
    }

    case 'AUTO_LAYOUT': {
      const currentDiag = currentProject.diagrams.find((d) => d.id === currentDiagId);
      if (!currentDiag || currentDiag.nodes.length === 0) return state;

      const laidOutNodes = computeAutoLayout(currentDiag, currentProject.levels);
      const updatedDiagrams = currentProject.diagrams.map((d) => {
        if (d.id !== currentDiagId) return d;
        return {
          ...d,
          nodes: laidOutNodes,
        };
      });

      const updatedProj: Project = {
        ...currentProject,
        updatedAt: new Date().toISOString(),
        diagrams: updatedDiagrams,
      };

      return {
        ...state,
        history: pushHistory(state.history, updatedProj),
      };
    }

    case 'CREATE_SUB_DIAGRAM': {
      try {
        const result = createSubDiagramForNode(currentProject, currentDiagId, action.parentNodeId);
        return {
          history: result.created ? pushHistory(state.history, result.project) : state.history,
          ui: {
            ...state.ui,
            activeDiagramId: result.childDiagramId,
            selectedNodeId: null,
            selectedNodeIds: [],
            selectedEdgeId: null,
            editingNodeId: null,
          },
        };
      } catch (err) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: err instanceof Error ? err.message : '詳細図の作成に失敗しました',
            },
          },
        };
      }
    }

    case 'REMOVE_DIAGRAM': {
      const { project: nextProject } = removeDiagramCascade(currentProject, action.diagramId);
      const isCurrentActiveRemoved = !nextProject.diagrams.some((d) => d.id === state.ui.activeDiagramId);
      const nextActiveId = isCurrentActiveRemoved
        ? nextProject.rootDiagramId
        : state.ui.activeDiagramId;

      return {
        history: pushHistory(state.history, nextProject),
        ui: {
          ...state.ui,
          activeDiagramId: nextActiveId,
          selectedNodeId: null,
          selectedNodeIds: [],
          selectedEdgeId: null,
          editingNodeId: null,
        },
      };
    }

    case 'UPDATE_DIAGRAM_TITLE': {
      const trimmed = action.title.trim();
      if (!trimmed) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: '図タイトルは空にできません',
            },
          },
        };
      }
      if (trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: '図タイトルは200文字以内です',
            },
          },
        };
      }
      const updatedProj = updateDiagramTitle(currentProject, action.diagramId, trimmed);
      if (updatedProj === currentProject) return state;
      return {
        ...state,
        history: pushHistory(state.history, updatedProj),
      };
    }

    case 'UPDATE_PROJECT_TITLE': {
      const trimmed = action.title.trim();
      if (!trimmed) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: 'プロジェクト名は空にできません',
            },
          },
        };
      }
      if (trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: 'プロジェクト名は200文字以内です',
            },
          },
        };
      }
      const updatedProj = updateProjectTitle(currentProject, trimmed);
      if (updatedProj === currentProject) return state;
      return {
        ...state,
        history: pushHistory(state.history, updatedProj),
      };
    }

    case 'UPDATE_PROJECT_META': {
      const err = validateProjectMetaPatch(action.patch);
      if (err) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: err,
            },
          },
        };
      }
      const updatedProj = updateProjectMeta(currentProject, action.patch);
      if (updatedProj === currentProject) return state;
      return {
        ...state,
        history: pushHistory(state.history, updatedProj),
      };
    }

    case 'ADD_LEVEL': {
      try {
        const updatedProj = addLevel(currentProject, action.label);
        return {
          ...state,
          history: pushHistory(state.history, updatedProj),
        };
      } catch (err) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: err instanceof Error ? err.message : '列の追加に失敗しました',
            },
          },
        };
      }
    }

    case 'UPDATE_LEVEL': {
      if (action.patch.label !== undefined) {
        const trimmed = action.patch.label.trim();
        if (!trimmed) {
          return {
            ...state,
            ui: {
              ...state.ui,
              notification: {
                id: `notif-${Date.now()}`,
                type: 'error',
                message: '列名は空にできません',
              },
            },
          };
        }
        if (trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
          return {
            ...state,
            ui: {
              ...state.ui,
              notification: {
                id: `notif-${Date.now()}`,
                type: 'error',
                message: '列名は200文字以内です',
              },
            },
          };
        }
      }
      const updatedProj = updateLevel(currentProject, action.levelId, action.patch);
      if (updatedProj === currentProject) return state;
      return {
        ...state,
        history: pushHistory(state.history, updatedProj),
      };
    }

    case 'REORDER_LEVELS': {
      const updatedProj: Project = {
        ...currentProject,
        levels: action.levels,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...state,
        history: pushHistory(state.history, updatedProj),
      };
    }

    case 'REMOVE_LEVEL': {
      try {
        const updatedProj = removeLevelWithReassign(
          currentProject,
          action.levelIdToRemove,
          action.targetLevelId
        );
        return {
          ...state,
          history: pushHistory(state.history, updatedProj),
        };
      } catch (err) {
        return {
          ...state,
          ui: {
            ...state.ui,
            notification: {
              id: `notif-${Date.now()}`,
              type: 'error',
              message: err instanceof Error ? err.message : '列の削除に失敗しました',
            },
          },
        };
      }
    }

    case 'SET_NOTIFICATION': {
      return {
        ...state,
        ui: {
          ...state.ui,
          notification: action.notification,
        },
      };
    }

    case 'CLEAR_NOTIFICATION': {
      return {
        ...state,
        ui: {
          ...state.ui,
          notification: null,
        },
      };
    }

    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  autoSaveStatus: 'idle' | 'saving' | 'saved' | 'error';
  lastAutoSavedTime: string | null;
} | null>(null);

// タブごとの一意なセッション復旧ID
const tabSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialProject = createNewProject();
  const [state, dispatch] = useReducer(appReducer, {
    history: createHistoryState(initialProject),
    ui: {
      activeDiagramId: initialProject.rootDiagramId,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      edgeDraftSourceId: null,
      viewports: {
        [initialProject.rootDiagramId]: { panX: 50, panY: 50, zoom: 1 },
      },
      dragState: null,
      activeRightTab: 'detail',
      gatewayToken: '',
      notification: null,
      editingNodeId: null,
    },
  });

  const [autoSaveStatus, setAutoSaveStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastAutoSavedTime, setLastAutoSavedTime] = React.useState<string | null>(null);

  // 仕様書 7.2: Project確定変更後、1秒のdebounceでIndexedDBへ保存
  React.useEffect(() => {
    // ノードが0件の空プロジェクト（初期状態や未編集）は復旧候補として無駄に保存しない
    const totalNodes = state.history.present.diagrams.reduce((sum, d) => sum + d.nodes.length, 0);
    if (totalNodes === 0) {
      setAutoSaveStatus('idle');
      return;
    }

    setAutoSaveStatus('saving');
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        await saveAutoSaveSnapshot(tabSessionId, state.history.present);
        if (!cancelled) {
          setAutoSaveStatus('saved');
          setLastAutoSavedTime(new Date().toLocaleTimeString());
        }
      } catch (e) {
        console.warn('AutoSave failed:', e);
        if (!cancelled) {
          setAutoSaveStatus('error');
        }
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state.history.present]);

  return (
    <AppContext.Provider value={{ state, dispatch, autoSaveStatus, lastAutoSavedTime }}>
      {children}
    </AppContext.Provider>
  );
};

export function useApp(): {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  autoSaveStatus: 'idle' | 'saving' | 'saved' | 'error';
  lastAutoSavedTime: string | null;
} {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
