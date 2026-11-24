import { LaneManagementPanel } from '../../../components/control-panel/LaneManagementPanel';
import { visibleSchema, canDrilldownEntity, getDrilldownSubEntities } from '../utils/presentation';
import { runDeterministicUiTask, isUiActionBusy } from '../utils/uiProgressRunner';
import { DeterministicProgressIndicator } from './DeterministicProgressIndicator';
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { calculateVTALayout } from '../utils/layout';
import {
  ReactFlow,
  ConnectionMode,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';

import { VTANode } from './VTANode';
import { VTAJunctionNode } from './VTAJunctionNode';
import { VTAObjectJunctionNode } from './VTAObjectJunctionNode';
import { isDotProjectedNode, projectDisplayNode } from '../utils/nodeGeometry';
import { VTAEdge } from './VTAEdge';
import { SwimlaneBackground } from './SwimlaneBackground';
import { StickyLaneHeaderBar } from './StickyLaneHeaderBar';
import { NodeEditorModal } from './NodeEditorModal';
import { EdgeEditorModal } from './EdgeEditorModal';
import { SupplementaryNotesPanel } from './SupplementaryNotesPanel';
import { GenerationProgressOverlay } from './GenerationProgressOverlay';
import { AIMeasuresProposalModal } from './AIMeasuresProposalModal';
import { SVGExportModal } from './SVGExportModal';
import { NormalizationAuditExportModal } from './NormalizationAuditExportModal';
import { ConnectionRepairModal } from './ConnectionRepairModal';
import { OptimizationSettingsModal } from './OptimizationSettingsModal';
import { VTAAnimationPlayerBar } from './VTAAnimationPlayerBar';
import type { AnimationStep } from '../utils/animationSequencer';
import type { ConnectionRepairPlan } from '../utils/connectionRepairPlan';
import { useVTAStore } from '../store/vtaStore';
import type { VTAReactFlowNode, VTAReactFlowNodeData } from '../../../types/vta';
import {
  LayoutTemplate,
  Info,
  Layers,
  ArrowUp,
  PlusCircle,
  BookOpen,
  X,
  Sparkles,
  GitBranch,
  Sliders,
  ChevronRight,
  ChevronDown,
  Settings2,
  RefreshCw,
} from 'lucide-react';

const nodeTypes: NodeTypes = {
  vtaNode: VTANode as unknown as NodeTypes['vtaNode'],
  vtaJunction: VTAJunctionNode as unknown as NodeTypes['vtaJunction'],
  vtaObjectJunction: VTAObjectJunctionNode as unknown as NodeTypes['vtaObjectJunction'],
};

const edgeTypes: EdgeTypes = {
  vtaEdge: VTAEdge,
};

interface VTACanvasProps {
  isActive?: boolean;
}

const CanvasInner: React.FC<VTACanvasProps> = ({ isActive = true }) => {
  const dragOccurredRef = useRef(false);
  useEffect(() => {
    if (!isActive) {
      useVTAStore.getState().cancelNodeDrag();
      return;
    }
    const cancelDragOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useVTAStore.getState().cancelNodeDrag()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', cancelDragOnEscape, true);
    return () => window.removeEventListener('keydown', cancelDragOnEscape, true);
  }, [isActive]);
  const nodes = useVTAStore((state) => state.nodes);
  const edges = useVTAStore((state) => state.edges);
  const laneBounds = useVTAStore((state) => state.laneBounds);
  const onNodesChange = useVTAStore((state) => state.onNodesChange);
  const onNodesDelete = useVTAStore((state) => state.onNodesDelete);
  const onEdgesChange = useVTAStore((state) => state.onEdgesChange);
  const onConnect = useVTAStore((state) => state.onConnect);
  const recalculateLayout = useVTAStore((state) => state.recalculateLayout);
  const setLaneVisibility = useVTAStore((state) => state.setLaneVisibility);
  const addLane = useVTAStore((state) => state.addLane);
  const renameLane = useVTAStore((state) => state.renameLane);
  const simplifyCards = useVTAStore((state) => state.simplifyCards);
  const moveLane = useVTAStore((state) => state.moveLane);
  const applyLaneMergeProposal = useVTAStore((state) => state.applyLaneMergeProposal);
  const applyLaneSplitProposal = useVTAStore((state) => state.applyLaneSplitProposal);
  const forceMergeLanes = useVTAStore((state) => state.forceMergeLanes);
  const setObjectDisplayStyle = useVTAStore((state) => state.setObjectDisplayStyle);
  const vtaData = useVTAStore((state) => state.vtaData);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const isRegenerating = useVTAStore((state) => state.isRegenerating);
  const isProposing = useVTAStore((state) => state.isProposing);
  const generationProgressActive = useVTAStore((state) => state.generationProgress.isActive);
  const isProposalModalOpen = useVTAStore((state) => state.isProposalModalOpen);
  const isSVGExportModalOpen = useVTAStore((state) => state.isSVGExportModalOpen);
  const isNormalizationAuditExportModalOpen = useVTAStore((state) => state.isNormalizationAuditExportModalOpen);
  const isNodeEditorOpen = useVTAStore((state) => state.isNodeEditorOpen);
  const editingNodeData = useVTAStore((state) => state.editingNodeData);
  const openNodeEditor = useVTAStore((state) => state.openNodeEditor);
  const closeNodeEditor = useVTAStore((state) => state.closeNodeEditor);
  const editingEdgeId = useVTAStore((state) => state.editingEdgeId);
  const closeEdgeEditor = useVTAStore((state) => state.closeEdgeEditor);
  const isNotesPanelOpen = useVTAStore((state) => state.isNotesPanelOpen);
  const toggleNotesPanel = useVTAStore((state) => state.toggleNotesPanel);
  const setIsNotesPanelOpen = useVTAStore((state) => state.setIsNotesPanelOpen);
  const isLaneOrderOpen = useVTAStore((state) => state.isLanePanelOpen);
  const setIsLaneOrderOpen = useVTAStore((state) => state.setIsLanePanelOpen);
  const toggleLanePanel = useVTAStore((state) => state.toggleLanePanel);
  const uiTaskProgress = useVTAStore((state) => state.uiTaskProgress);

  const isAnimationPlayerOpen = useVTAStore((state) => state.isAnimationPlayerOpen);
  const closeAnimationPlayer = useVTAStore((state) => state.closeAnimationPlayer);
  const [animationStep, setAnimationStep] = useState<AnimationStep | null>(null);

  const { fitView } = useReactFlow();
  const compactView = useVTAStore((state) => state.compactView);
  const toggleCompactView = useVTAStore((state) => state.toggleCompactView);
  const snapToLaneCenter = useVTAStore((state) => state.snapToLaneCenter);
  const setSnapToLaneCenter = useVTAStore((state) => state.setSnapToLaneCenter);
  const toggleLaneDrilldown = useVTAStore((state) => state.toggleLaneDrilldown);
  const compactLayout = useMemo(() => compactView
    ? calculateVTALayout(vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' })
    : null, [compactView, vtaData]);
  const drilldownCapableMap = useMemo(() => {
    const map: Record<string, { entityId: string; isExpanded: boolean; subCount: number }> = {};
    if (!vtaData.analysis) return map;
    const { entities } = vtaData.analysis;
    const drilldownLanes = vtaData.presentation?.drilldownLanes ?? {};

    for (const ent of entities) {
      if (canDrilldownEntity(ent.id, vtaData.analysis)) {
        const sub = getDrilldownSubEntities(ent.id, vtaData.analysis);
        const isExpanded = Boolean(drilldownLanes[ent.id]);
        map[ent.name] = {
          entityId: ent.id,
          isExpanded,
          subCount: sub.length,
        };
      }
    }
    return map;
  }, [vtaData.analysis, vtaData.presentation?.drilldownLanes]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const linkedHoverNodeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const hovered = nodes.find((n) => n.id === hoveredNodeId);
    if (!hovered || !hovered.data.event_ids?.length) return new Set<string>();
    const linked = new Set<string>();
    for (const n of nodes) {
      if (n.id !== hoveredNodeId && n.data.event_ids?.some((id) => hovered.data.event_ids?.includes(id))) {
        linked.add(n.id);
      }
    }
    return linked;
  }, [hoveredNodeId, nodes]);

  const displayNodes = useMemo(() => {
    // リプレイ中で snapshotLayout がある場合（AI生成プロセスモード）
    if (isAnimationPlayerOpen && animationStep?.snapshotLayout) {
      return animationStep.snapshotLayout.nodes.map((n) => {
        const isHoveredLinked = linkedHoverNodeIds.has(n.id);
        const projected = projectDisplayNode(n, vtaData.presentation?.defaultObjectDisplayStyle);
        const isHighlighted = animationStep.highlightNodeIds.includes(n.id);
        return {
          ...projected,
          style: {
            ...projected.style,
            opacity: 1,
            filter: isHighlighted ? 'drop-shadow(0 0 12px rgba(245, 158, 11, 0.9))' : undefined,
            transition: 'opacity 0.3s ease-out, filter 0.3s ease-out',
            pointerEvents: 'auto' as const,
          },
          data: {
            ...projected.data,
            isHoveredLinked,
          },
        };
      });
    }

    const base = compactLayout
      ? compactLayout.nodes.map((node) => ({ ...node, selected: nodes.find((n) => n.id === node.id)?.selected }))
      : nodes;
    return base.map((n) => {
      const isHoveredLinked = linkedHoverNodeIds.has(n.id);
      const projected = projectDisplayNode(n, vtaData.presentation?.defaultObjectDisplayStyle);

      if (isAnimationPlayerOpen && animationStep) {
        const isVisible = animationStep.activeNodeIds.includes(n.id);
        const isHighlighted = animationStep.highlightNodeIds.includes(n.id);
        return {
          ...projected,
          style: {
            ...projected.style,
            opacity: isVisible ? 1 : 0.08,
            filter: isHighlighted ? 'drop-shadow(0 0 10px rgba(245, 158, 11, 0.9))' : undefined,
            transition: 'opacity 0.3s ease-out, filter 0.3s ease-out',
            pointerEvents: isVisible ? ('auto' as const) : ('none' as const),
          },
          data: {
            ...projected.data,
            isHoveredLinked,
          },
        };
      }

      if (isHoveredLinked) {
        return {
          ...projected,
          data: {
            ...projected.data,
            isHoveredLinked: true,
          },
        };
      }
      return projected;
    });
  }, [compactLayout, nodes, vtaData.presentation?.defaultObjectDisplayStyle, linkedHoverNodeIds, isAnimationPlayerOpen, animationStep]);

  const displayEdges = useMemo(() => {
    // リプレイ中で snapshotLayout がある場合（AI生成プロセスモード）
    if (isAnimationPlayerOpen && animationStep?.snapshotLayout) {
      return animationStep.snapshotLayout.edges.map((e) => ({
        ...e,
        style: {
          ...e.style,
          opacity: 1,
          transition: 'opacity 0.35s ease-out',
        },
      }));
    }

    const baseEdges = compactLayout
      ? compactLayout.edges.map((edge) => ({ ...edge, selected: edges.find((e) => e.id === edge.id)?.selected }))
      : edges;

    if (isAnimationPlayerOpen && animationStep) {
      return baseEdges.map((e) => {
        const edgeId = e.id ?? `e_${e.source}_${e.target}`;
        const isVisible = animationStep.activeEdgeIds.includes(edgeId);
        return {
          ...e,
          style: {
            ...e.style,
            opacity: isVisible ? 1 : 0,
            transition: 'opacity 0.35s ease-out',
          },
        };
      });
    }

    return baseEdges;
  }, [compactLayout, edges, isAnimationPlayerOpen, animationStep]);

  const displayLaneBounds = useMemo(() => {
    if (isAnimationPlayerOpen && animationStep?.snapshotLayout?.laneBounds) {
      return animationStep.snapshotLayout.laneBounds;
    }
    return compactLayout?.laneBounds ?? laneBounds;
  }, [compactLayout, laneBounds, isAnimationPlayerOpen, animationStep]);

  useEffect(() => {
    if (isAnimationPlayerOpen && animationStep?.snapshotLayout) {
      void fitView({ padding: 0.18, duration: 350 });
    }
  }, [isAnimationPlayerOpen, animationStep?.index, fitView]);
  useEffect(() => {
    const timer = setTimeout(() => { void fitView({ padding: 0.2, duration: 300 }); }, 100);
    return () => clearTimeout(timer);
  }, [compactView, fitView]);

  const handleAutoLayout = useCallback(() => {
    void runDeterministicUiTask(
      {
        actionKey: 'auto_layout',
        level: 'inline',
        title: 'スイムレーンの時系列配置を整列中...',
      },
      () => {
        recalculateLayout();
        setTimeout(() => {
          void fitView({ padding: 0.2, duration: 400 });
        }, 50);
      }
    );
  }, [recalculateLayout, fitView]);

  const handleToggleViewMode = useCallback(
    (targetCompact: boolean) => {
      if (targetCompact === compactView) return;
      void runDeterministicUiTask(
        {
          actionKey: 'compact_toggle',
          level: 'inline',
          title: '表示形式とカード配置を切り替え中...',
        },
        () => {
          if (targetCompact) {
            setIsLaneOrderOpen(false);
            setIsNotesPanelOpen(true);
          }
          toggleCompactView();
        }
      );
    },
    [compactView, setIsLaneOrderOpen, setIsNotesPanelOpen, toggleCompactView]
  );

  const handleToggleDrilldownWithProgress = useCallback(
    (entityId: string) => {
      void runDeterministicUiTask(
        {
          actionKey: 'lane_drilldown',
          level: 'inline',
          title: 'サブレーンの展開・集約を計算中...',
        },
        () => toggleLaneDrilldown(entityId)
      );
    },
    [toggleLaneDrilldown]
  );

  const handleSetLaneVisibilityWithProgress = useCallback(
    (entityId: string, mode: 'auto' | 'show' | 'hide') => {
      void runDeterministicUiTask(
        {
          actionKey: 'lane_visibility',
          level: 'inline',
          title: 'レーンの表示状態を更新中...',
        },
        () => setLaneVisibility(entityId, mode)
      );
    },
    [setLaneVisibility]
  );

  const handleSimplifyCardsWithProgress = useCallback(() => {
    void runDeterministicUiTask(
      {
        actionKey: 'simplify_cards',
        level: 'inline',
        title: '重複表示カードを整理中...',
      },
      () => simplifyCards()
    );
  }, [simplifyCards]);

  const handleApplyLaneMergeWithProgress = useCallback(
    (proposal: Parameters<typeof applyLaneMergeProposal>[0], customTargetName?: string) => {
      void runDeterministicUiTask(
        {
          actionKey: 'lane_merge',
          level: 'inline',
          title: '主体レーンを統合し再配置中...',
        },
        () => applyLaneMergeProposal(proposal, customTargetName)
      );
    },
    [applyLaneMergeProposal]
  );

  const handleApplyLaneSplitWithProgress = useCallback(
    (proposal: Parameters<typeof applyLaneSplitProposal>[0]) => {
      void runDeterministicUiTask(
        {
          actionKey: 'lane_split',
          level: 'inline',
          title: '主体レーンを分割展開し再配置中...',
        },
        () => applyLaneSplitProposal(proposal)
      );
    },
    [applyLaneSplitProposal]
  );

  const handleForceMergeLanesWithProgress = useCallback(
    (sourceLane: string, targetLane: string) => {
      void runDeterministicUiTask(
        {
          actionKey: 'lane_force_merge',
          level: 'inline',
          title: '指定レーンを統合し再配置中...',
        },
        () => forceMergeLanes(sourceLane, targetLane)
      );
    },
    [forceMergeLanes]
  );

  const handleToggleObjectDisplayStyleWithProgress = useCallback(
    (style: 'dot' | 'card') => {
      void runDeterministicUiTask(
        {
          actionKey: 'object_style',
          level: 'inline',
          title: '客体ノード表示形式を更新中...',
        },
        () => setObjectDisplayStyle(style)
      );
    },
    [setObjectDisplayStyle]
  );

  const notesCount = useMemo(
    () => visibleSchema(vtaData).nodes.filter((n) => Boolean(n.description?.trim() || n.supplementary_note?.trim())).length,
    [vtaData.nodes]
  );
  const [noteFocusRequest, setNoteFocusRequest] = useState<{ nodeId: string; sequence: number } | null>(null);
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false);
  const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
  const [connectionRepairPlan, setConnectionRepairPlan] = useState<ConnectionRepairPlan | null>(null);
  const closeConnectionRepair = useCallback(() => setConnectionRepairPlan(null), []);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  const displayMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isAiMenuOpen && !isDisplayMenuOpen) return;
    if (typeof document === 'undefined') return;
    const handlePointerDown = (e: MouseEvent) => {
      if (isAiMenuOpen && aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setIsAiMenuOpen(false);
      }
      if (isDisplayMenuOpen && displayMenuRef.current && !displayMenuRef.current.contains(e.target as Node)) {
        setIsDisplayMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAiMenuOpen(false);
        setIsDisplayMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAiMenuOpen, isDisplayMenuOpen]);

  const isModalBlocking =
    isNodeEditorOpen ||
    Boolean(editingEdgeId) ||
    isProposalModalOpen ||
    isSVGExportModalOpen ||
    isNormalizationAuditExportModalOpen ||
    Boolean(connectionRepairPlan) ||
    generationProgressActive ||
    Boolean(uiTaskProgress) ||
    isExtracting ||
    isRegenerating ||
    isProposing;

  const autoLayoutBusy = isUiActionBusy(uiTaskProgress, 'auto_layout');
  const compactBusy = isUiActionBusy(uiTaskProgress, 'compact_toggle');

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden flex flex-row">
      {/* Left / Main Canvas Area */}
      <div className="flex-1 min-w-0 h-full relative overflow-hidden flex flex-col">
        <DeterministicProgressIndicator isActive={isActive} />

        {/* Streamlined Top Canvas Toolbar (5 clear groups) */}
        <div className="relative mx-4 mt-3 z-20 flex shrink-0 flex-wrap w-fit max-w-[calc(100%-2rem)] items-center gap-1.5 bg-slate-900/90 border border-slate-800 p-1.5 rounded-xl shadow-xl backdrop-blur">
          {/* 1. Card Add */}
          <button
            type="button"
            onClick={() => openNodeEditor(null)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold transition-colors shadow-sm cursor-pointer"
            title="VTA図に新しい作業・変動要因カードを追加"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>カード追加</span>
          </button>

          {/* 2. Auto Layout */}
          <button
            type="button"
            disabled={!isActive || !vtaData.nodes.length || autoLayoutBusy}
            onClick={handleAutoLayout}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg text-xs font-semibold transition-colors border border-slate-700/80 cursor-pointer disabled:opacity-40"
            title="現在の表示を時系列（下から上）に自動整列"
          >
            {autoLayoutBusy ? (
              <RefreshCw className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
            ) : (
              <LayoutTemplate className="w-3.5 h-3.5 text-cyan-400" />
            )}
            <span>{autoLayoutBusy ? '整列中...' : '自動整列'}</span>
          </button>

          {/* 3. AI & Structure Adjustment Dropdown */}
          <div ref={aiMenuRef} className="relative">
            <button
              type="button"
              disabled={!isActive || !vtaData.nodes.length || isExtracting || isRegenerating || isProposing}
              onClick={() => setIsAiMenuOpen((prev) => !prev)}
              aria-expanded={isAiMenuOpen}
              data-vta-focus-id="canvas-ai-adjust-menu"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                isAiMenuOpen
                  ? 'bg-indigo-700 border-indigo-400 text-white'
                  : 'bg-indigo-950/80 hover:bg-indigo-900 border-indigo-600/80 text-indigo-200'
              }`}
              title="手動編集後の接続再探索・粒度再最適化・整流"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-300" />
              <span>AI再調整</span>
              <ChevronDown className="w-3 h-3 text-indigo-300" />
            </button>

            {isAiMenuOpen && (
              <div className="absolute left-0 top-full mt-2 w-64 bg-slate-900/98 border border-slate-700 rounded-xl p-1.5 shadow-2xl z-50 text-xs text-slate-200 space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setIsAiMenuOpen(false);
                    void useVTAStore.getState().autoConnectNodes();
                  }}
                  className="w-full flex items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-slate-100">接続を再探索（ノード自動接続）</div>
                    <div className="text-[10px] text-slate-400">未接続・不足関係をAIで探索し自動結線</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setIsAiMenuOpen(false);
                    void useVTAStore.getState().reoptimizeVTA();
                  }}
                  className="w-full flex items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors"
                >
                  <GitBranch className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-slate-100">レーン粒度を再最適化</div>
                    <div className="text-[10px] text-slate-400">主体統合・認知負荷スコアを反復最適化</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setIsAiMenuOpen(false);
                    useVTAStore.getState().setIsOptimizationSettingsOpen(true);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors text-slate-300"
                >
                  <Sliders className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>最適化の詳細設定...</span>
                </button>

                <div className="my-1 border-t border-slate-800" />

                <button
                  type="button"
                  disabled={vtaData.nodes.length < 2}
                  onClick={() => {
                    setIsAiMenuOpen(false);
                    void runDeterministicUiTask(
                      {
                        actionKey: 'connection_repair_plan',
                        level: 'inline',
                        title: '同一レーンの接続状態を確認中...',
                      },
                      () => {
                        setConnectionRepairPlan(useVTAStore.getState().getConnectionRepairPlan());
                      }
                    );
                  }}
                  className="w-full flex items-start gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors disabled:opacity-40"
                >
                  <LayoutTemplate className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-slate-100">同一レーン接続を整流...</div>
                    <div className="text-[10px] text-slate-400">縦方向の時系列順序に沿って線を整理</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          <div className="w-px h-5 bg-slate-800 mx-0.5" />

          {/* 4. View Switcher + Display Settings Popover */}
          <div className="flex items-center bg-slate-950/70 p-0.5 rounded-lg border border-slate-800">
            <button
              type="button"
              disabled={compactBusy}
              onClick={() => handleToggleViewMode(false)}
              aria-pressed={!compactView}
              className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                !compactView
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="本文を含めて詳細表示"
            >
              詳細カード
            </button>
            <button
              type="button"
              disabled={compactBusy}
              onClick={() => handleToggleViewMode(true)}
              aria-pressed={compactView}
              className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                compactView
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="見出しのみ表示して全体を俯瞰（本文は右の補足メモに表示）"
            >
              見出しのみ
            </button>
          </div>

          <div ref={displayMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setIsDisplayMenuOpen((prev) => !prev)}
              aria-expanded={isDisplayMenuOpen}
              className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                isDisplayMenuOpen || isLegendOpen
                  ? 'bg-cyan-950/80 border-cyan-600 text-cyan-200'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700/80'
              }`}
              title="表示オプションと凡例"
            >
              <Settings2 className="w-3.5 h-3.5 text-cyan-400" />
              <span>表示設定</span>
            </button>

            {isDisplayMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 bg-slate-900/98 border border-slate-700 rounded-xl p-3 shadow-2xl z-50 text-xs text-slate-200 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 font-bold text-slate-100">
                  <span>表示・操作オプション</span>
                  <button
                    type="button"
                    onClick={() => setIsDisplayMenuOpen(false)}
                    className="p-0.5 text-slate-400 hover:text-white rounded cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={snapToLaneCenter}
                    onChange={(event) => setSnapToLaneCenter(event.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-cyan-500"
                  />
                  <div>
                    <div className="font-medium text-slate-200">移動後に列中央へスナップ</div>
                    <div className="text-[10px] text-slate-400">ドラッグ終了時にカードの横位置を揃えます</div>
                  </div>
                </label>

                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    受動客体ノードの表示形式
                  </label>
                  <select
                    aria-label="客体ノードの表示形式"
                    value={vtaData.presentation?.defaultObjectDisplayStyle ?? 'dot'}
                    onChange={(e) => handleToggleObjectDisplayStyleWithProgress(e.target.value as 'dot' | 'card')}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-cyan-200 cursor-pointer"
                  >
                    <option value="dot">● ドット表示（標準）</option>
                    <option value="card">🗂 通常カード表示</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setIsLegendOpen((prev) => !prev);
                    setIsDisplayMenuOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-cyan-300 cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" />
                    <span>VTA記法・凡例を{isLegendOpen ? '隠す' : '表示'}</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          <div className="w-px h-5 bg-slate-800 mx-0.5" />

          {/* 5. Right Inspector / Dock Switcher */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleLanePanel}
              disabled={!isActive}
              aria-expanded={isLaneOrderOpen}
              aria-controls="vta-lane-order-panel"
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer disabled:opacity-40 transition-colors ${
                isLaneOrderOpen
                  ? 'bg-cyan-950/80 border-cyan-600 text-cyan-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700/80'
              }`}
              title="右パネルでレーンの表示・順序・統合/分割を管理"
            >
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <span>レーン管理</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (isLaneOrderOpen) {
                  setIsLaneOrderOpen(false);
                  if (!isNotesPanelOpen) setIsNotesPanelOpen(true);
                } else {
                  toggleNotesPanel();
                }
              }}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border cursor-pointer ${
                isNotesPanelOpen && !isLaneOrderOpen
                  ? 'bg-cyan-950/80 border-cyan-600 text-cyan-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border-slate-700/80'
              }`}
              title="右パネルでノード内容・補足説明を表示"
            >
              <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
              <span>補足メモ</span>
              {notesCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-cyan-900 text-cyan-300 border border-cyan-700 font-mono">
                  {notesCount}
                </span>
              )}
            </button>
          </div>
      {/* Floating Popover Legend Card (Toggled via display settings) */}
      {isLegendOpen && (
        <div className="absolute top-full mt-2 left-0 z-30 bg-slate-900/95 border border-slate-700/90 p-3.5 rounded-xl shadow-2xl backdrop-blur space-y-2 text-[11px] max-w-[260px] animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between text-slate-200 font-bold border-b border-slate-800 pb-1.5">
            <div className="flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-cyan-400" />
              <span>VTA 凡例</span>
            </div>
            <button
              type="button"
              onClick={() => setIsLegendOpen(false)}
              className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors cursor-pointer"
              title="凡例を閉じる"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-1.5 text-slate-300">
            <div className="flex items-center gap-2"><span>●</span><span>カード非表示（接続点）</span></div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3.5 border border-slate-600 bg-slate-800/80 rounded-sm shrink-0" />
              <span>通常作業（細枠線）</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="w-4 h-3.5 border-2 border-amber-400 bg-amber-950/40 rounded-sm shrink-0" />
              <span>変動要因（太枠線）</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                ○
              </div>
              <span>排除ノード（右上○印）</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="px-1.5 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-500 text-[9px] font-bold shrink-0">
                BREAK
              </div>
              <span>ブレイク（悪影響遮断）</span>
            </div>

            <div className="pt-1 border-t border-slate-800/80 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-cyan-400 font-mono font-bold text-xs shrink-0">──▶</span>
                <span className="text-[10px]">一方向の情報伝達</span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-purple-400 font-mono font-bold text-xs shrink-0">◀──▶</span>
                <span className="text-[10px]">双方向の伝達・相互確認</span>
              </div>
            </div>
          </div>
        </div>
      )}
        </div>

      {/* Time Axis Indicator (Bottom to Top) */}
      <div className="absolute left-4 bottom-6 z-20 flex items-center gap-2 bg-slate-900/90 border border-slate-800 px-3 py-2 rounded-xl shadow-lg backdrop-blur">
        <div className="w-6 h-6 rounded-full bg-cyan-950 border border-cyan-800 flex items-center justify-center text-cyan-400 animate-bounce">
          <ArrowUp className="w-3.5 h-3.5" />
        </div>
        <div className="text-[11px]">
          <span className="font-semibold text-cyan-300 block">時間経過軸 (BT)</span>
          <span className="text-slate-400 text-[10px]">下（過去/発端）→ 上（現在/不具合事象）</span>
        </div>
      </div>

      {/* Main Flow Canvas */}
      <div className="flex-1 min-h-0 w-full relative">
        {displayNodes.length === 0 && displayLaneBounds.length === 0 && !isExtracting && !uiTaskProgress && (
          <div
            data-testid="vta-empty-canvas-guide"
            className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none p-6"
          >
            <div className="max-w-md rounded-2xl border border-slate-800/90 bg-slate-900/75 px-6 py-5 text-center shadow-xl backdrop-blur-sm space-y-2">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-950/80 border border-cyan-800/70 text-cyan-400">
                <Layers className="w-5 h-5" />
              </div>
              <h2 className="text-sm font-bold text-slate-200">VTA図はまだ作成されていません</h2>
              <p className="text-xs leading-relaxed text-slate-400">
                左パネルからシナリオを入力またはファイル読込して「VTA構造を抽出」を実行するか、上部の「開く」「カード追加」から開始してください。
              </p>
            </div>
          </div>
        )}
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodesDraggable={isActive && !isModalBlocking && !isAnimationPlayerOpen}
          onNodeDragStart={() => useVTAStore.getState().allowNewNodeDrag()}
          nodesFocusable={isActive && !isModalBlocking && !isAnimationPlayerOpen}
          edgesFocusable={isActive && !isModalBlocking && !isAnimationPlayerOpen}
          onNodeClick={(_, node) => {
            if (!isActive) return;
            if (dragOccurredRef.current) { dragOccurredRef.current = false; return; }
            setIsLaneOrderOpen(false);
            setIsNotesPanelOpen(true);
            setNoteFocusRequest((previous) => ({
              nodeId: node.id,
              sequence: (previous?.sequence ?? 0) + 1,
            }));
          }}
          onPaneClick={() => setNoteFocusRequest(null)}
          onNodesChange={(changes) => {
            if (changes.some((change) => change.type === 'position' && change.dragging === true)) dragOccurredRef.current = true;
            if (changes.some((change) => change.type === 'position' && change.dragging === false)) {
              window.setTimeout(() => { dragOccurredRef.current = false; }, 80);
            }
            // Projected point dimensions/positions must never overwrite the stored card geometry.
            let applicable = changes.filter((change) =>
              (change.type !== 'dimensions' && change.type !== 'position') ||
              (change.type === 'position' || (!compactView && !isDotProjectedNode(nodes.find((node) => node.id === change.id), vtaData.presentation?.defaultObjectDisplayStyle))));
            if (!isActive || isModalBlocking || isAnimationPlayerOpen) {
              applicable = applicable.filter((change) => change.type !== 'remove' && change.type !== 'position');
            }
            if (applicable.length && !isAnimationPlayerOpen) onNodesChange(applicable, compactView ? 'compact' : 'detail');
          }}
          onNodesDelete={isActive && !isModalBlocking && !isAnimationPlayerOpen ? onNodesDelete : undefined}
          deleteKeyCode={isActive && !isModalBlocking && !isAnimationPlayerOpen ? ['Backspace', 'Delete'] : null}
          selectionKeyCode={isActive && !isModalBlocking && !isAnimationPlayerOpen ? 'Shift' : null}
          multiSelectionKeyCode={isActive && !isModalBlocking && !isAnimationPlayerOpen ? ['Meta', 'Control'] : null}
          panActivationKeyCode={isActive && !isModalBlocking ? 'Space' : null}
          zoomActivationKeyCode={isActive && !isModalBlocking ? ['Meta', 'Control'] : null}
          onEdgesChange={(changes) => {
            const applicable = isActive && !isModalBlocking && !isAnimationPlayerOpen
              ? changes
              : changes.filter((change) => change.type !== 'remove');
            if (applicable.length && !isAnimationPlayerOpen) onEdgesChange(applicable);
          }}
          onConnect={onConnect}
          connectionMode={ConnectionMode.Loose}
          onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
          onNodeMouseLeave={() => setHoveredNodeId(null)}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.1}
          maxZoom={2.5}
          panOnScroll={false}
          panOnDrag={true}
          zoomOnScroll={true}
          zoomOnPinch={true}
          defaultEdgeOptions={{
            type: 'vtaEdge',
          }}
          className="bg-transparent"
        >
          <SwimlaneBackground
            provisionalLanes={vtaData.analysis?.entities.filter(e=>e.resolution==='unresolved').map(e=>e.name)}
            laneBounds={displayLaneBounds}
            drilldownCapableMap={drilldownCapableMap}
            onToggleDrilldown={handleToggleDrilldownWithProgress}
            onRenameLane={isActive && !isModalBlocking && !isAnimationPlayerOpen ? renameLane : undefined}
          />
          <StickyLaneHeaderBar
            provisionalLanes={vtaData.analysis?.entities.filter(e=>e.resolution==='unresolved').map(e=>e.name)}
            laneBounds={displayLaneBounds}
            drilldownCapableMap={drilldownCapableMap}
            onToggleDrilldown={handleToggleDrilldownWithProgress}
            onRenameLane={isActive && !isModalBlocking && !isAnimationPlayerOpen ? renameLane : undefined}
          />
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            color="#334155"
          />
          <Controls
            position="bottom-right"
            className="!bg-slate-900 !border-slate-800 !text-slate-300 !rounded-xl !shadow-xl [&>button]:!bg-slate-900 [&>button]:!border-slate-800 [&>button]:!text-slate-300 hover:[&>button]:!bg-slate-800"
          />
          <MiniMap
            position="bottom-left"
            zoomable
            pannable
            nodeStrokeColor={(n) => {
              const d = n.data as VTAReactFlowNodeData | undefined;
              return d?.type === 'outcome' ? '#e11d48' : d?.type === 'variation' ? (d?.variation_factor?.polarity === 'resilient' ? '#0d9488' : '#f59e0b') : '#64748b';
            }}
            nodeColor={(n) => {
              const d = n.data as VTAReactFlowNodeData | undefined;
              return d?.type === 'outcome' ? (d?.outcome_kind === 'recovery' ? '#064e3b' : d?.outcome_kind === 'near_miss' ? '#78350f' : '#881337') : d?.measure_type === 'elimination' ? '#10b981' : '#1e293b';
            }}
            className="!bg-slate-900/90 !border-slate-800 !rounded-xl !overflow-hidden !mb-16 !shadow-xl"
            maskColor="rgba(15, 23, 42, 0.75)"
          />
        </ReactFlow>
      </div>

      {/* Card (Node) Creation & Edit Modal */}
      {isActive && connectionRepairPlan && <ConnectionRepairModal
        plan={connectionRepairPlan}
        onClose={closeConnectionRepair}
        onApply={() => {
          void runDeterministicUiTask(
            {
              actionKey: 'connection_repair_apply',
              level: 'inline',
              title: '同一レーンの接続線を整流中...',
            },
            () => {
              const store = useVTAStore.getState();
              if (store.applyConnectionRepair(connectionRepairPlan.sourceSignature)) closeConnectionRepair();
              else setConnectionRepairPlan(store.getConnectionRepairPlan());
            }
          );
        }}
      />}
      <NodeEditorModal
        isOpen={isActive && isNodeEditorOpen}
        initialData={editingNodeData}
        onClose={closeNodeEditor}
      />

      {/* Edge Label & Attribute Edit Modal */}
      <EdgeEditorModal
        isOpen={isActive && Boolean(editingEdgeId)}
        edgeId={editingEdgeId}
        onClose={closeEdgeEditor}
      />

      {/* Visual Generation Progress & Status Overlay */}
      <GenerationProgressOverlay isActive={isActive} />

      {/* AI Countermeasure Proposal Modal */}
      <AIMeasuresProposalModal isActive={isActive} />

      {/* SVG Export Configuration Modal */}
      <SVGExportModal isActive={isActive} />
      <NormalizationAuditExportModal isActive={isActive} />
      <OptimizationSettingsModal />

      {/* Floating Canvas Animation & Replay Player Bar */}
      {isActive && isAnimationPlayerOpen && (
        <VTAAnimationPlayerBar
          onStepChange={setAnimationStep}
          onClose={closeAnimationPlayer}
        />
      )}
    </div>

    {/* Right-Side Docked Panel (Lane Management or Supplementary Notes - never overlaps VTA canvas) */}
    {isLaneOrderOpen ? (
      <aside
        id="vta-lane-order-panel"
        aria-label="レーン管理・列の順序"
        className="w-88 xl:w-96 h-full bg-slate-900/95 border-l border-slate-800 flex flex-col z-30 shadow-2xl backdrop-blur shrink-0 transition-all"
      >
        <div className="p-4 border-b border-slate-800 bg-slate-950/60 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400 shrink-0">
              <Layers className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-sm text-slate-100 truncate">
                レーン管理・列の順序
              </h3>
              <p className="text-[10px] text-slate-400 truncate">
                図を確認しながらレーン表示・並び順・統合を操作
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => {
                setIsLaneOrderOpen(false);
                setIsNotesPanelOpen(true);
              }}
              className="px-2 py-1 text-[11px] font-medium text-cyan-300 hover:text-cyan-200 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors cursor-pointer"
              title="ノード補足説明欄に切り替え"
            >
              補足欄へ
            </button>
            <button
              type="button"
              onClick={() => setIsLaneOrderOpen(false)}
              aria-label="列順序を閉じる"
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="レーン管理を閉じる"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3.5">
          <LaneManagementPanel
            schema={vtaData}
            disabled={!isActive}
            docked
            onVisibility={handleSetLaneVisibilityWithProgress}
            onAdd={addLane}
            onRename={renameLane}
            onMove={moveLane}
            onSimplify={handleSimplifyCardsWithProgress}
            onApplyMergeProposal={handleApplyLaneMergeWithProgress}
            onApplySplitProposal={handleApplyLaneSplitWithProgress}
            onForceMergeLanes={handleForceMergeLanesWithProgress}
            onToggleObjectDisplayStyle={handleToggleObjectDisplayStyleWithProgress}
            onToggleDrilldown={handleToggleDrilldownWithProgress}
          />
        </div>
      </aside>
    ) : (
      <SupplementaryNotesPanel focusRequest={noteFocusRequest} />
    )}
  </div>
  );
};

export const VTACanvas: React.FC<VTACanvasProps> = ({ isActive = true }) => {
  return (
    <ReactFlowProvider>
      <CanvasInner isActive={isActive} />
    </ReactFlowProvider>
  );
};
