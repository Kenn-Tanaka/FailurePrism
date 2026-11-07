import { ChainRepairModal } from './ChainRepairModal';
import { LaneManagementPanel } from '../../../components/control-panel/LaneManagementPanel';
import { visibleSchema, canDrilldownEntity, getDrilldownSubEntities } from '../utils/presentation';
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { calculateVTALayout } from '../utils/layout';
import {
  ReactFlow,
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
import { projectDisplayNode } from '../utils/nodeGeometry';
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
import { ConnectionProposalModal } from './ConnectionProposalModal';
import { OptimizationSettingsModal } from './OptimizationSettingsModal';
import { VTAAnimationPlayerBar } from './VTAAnimationPlayerBar';
import type { AnimationStep } from '../utils/animationSequencer';
import type { ConnectionRepairPlan } from '../utils/connectionRepairPlan';
import { useVTAStore } from '../store/vtaStore';
import type { VTAReactFlowNode, VTAReactFlowNodeData } from '../../../types/vta';
import {
  LayoutTemplate,
  Maximize2,
  Download,
  Info,
  Layers,
  ShieldCheck,
  ZapOff,
  Activity,
  AlertTriangle,
  ArrowUp,
  PlusCircle,
  BookOpen,
  FolderOpen,
  Save,
  Lightbulb,
  X,
  Undo2,
  Redo2,
  Sparkles,
  GitBranch,
  Sliders,
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
  const setIsProposalModalOpen = useVTAStore((state) => state.setIsProposalModalOpen);
  const undo = useVTAStore((state) => state.undo);
  const redo = useVTAStore((state) => state.redo);
  const canUndo = useVTAStore((state) => state.past.length > 0);
  const canRedo = useVTAStore((state) => state.future.length > 0);

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
    recalculateLayout();
    setTimeout(() => {
      fitView({ padding: 0.2, duration: 400 });
    }, 50);
  }, [recalculateLayout, fitView]);

  const notesCount = useMemo(
    () => visibleSchema(vtaData).nodes.filter((n) => Boolean(n.description?.trim() || n.supplementary_note?.trim())).length,
    [vtaData.nodes]
  );
  const [noteFocusRequest, setNoteFocusRequest] = useState<{ nodeId: string; sequence: number } | null>(null);
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [isLaneOrderOpen, setIsLaneOrderOpen] = useState(false);
  const [connectionRepairPlan, setConnectionRepairPlan] = useState<ConnectionRepairPlan | null>(null);
  const [chainRepairOpen,setChainRepairOpen]=useState(false);
  const [connectionProposalOpen, setConnectionProposalOpen] = useState(false);
  const closeConnectionRepair = useCallback(() => setConnectionRepairPlan(null), []);
  const isModalBlocking =
    isNodeEditorOpen ||
    Boolean(editingEdgeId) ||
    isProposalModalOpen ||
    isSVGExportModalOpen ||
    isNormalizationAuditExportModalOpen ||
    Boolean(connectionRepairPlan) ||
    chainRepairOpen ||
    connectionProposalOpen ||
    generationProgressActive ||
    isExtracting ||
    isRegenerating ||
    isProposing;

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden flex flex-row">
      {/* Left / Main Canvas Area */}
      <div className="flex-1 h-full relative overflow-hidden flex flex-col">
        {/* Top Canvas Toolbar */}
        <div className="relative mx-4 mt-4 z-20 flex shrink-0 flex-wrap w-fit max-w-[calc(100%-2rem)] items-center gap-2 bg-slate-900/90 border border-slate-800 p-1.5 rounded-xl shadow-xl backdrop-blur">
          {/* Undo / Redo Buttons */}
          <div className="flex items-center gap-0.5 bg-slate-950/70 p-0.5 rounded-lg border border-slate-800">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className={`p-1.5 rounded-md text-xs font-medium transition-colors ${
                canUndo
                  ? 'text-slate-200 hover:text-white hover:bg-slate-800 cursor-pointer'
                  : 'text-slate-600 cursor-not-allowed opacity-40'
              }`}
              title="元に戻す (Ctrl+Z)"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              className={`p-1.5 rounded-md text-xs font-medium transition-colors ${
                canRedo
                  ? 'text-slate-200 hover:text-white hover:bg-slate-800 cursor-pointer'
                  : 'text-slate-600 cursor-not-allowed opacity-40'
              }`}
              title="やり直す (Ctrl+Y / Ctrl+Shift+Z)"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="w-px h-5 bg-slate-800 mx-0.5" />

          <button
            type="button"
            onClick={() => setIsProposalModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white rounded-lg text-xs font-semibold transition-colors shadow-md shadow-amber-950/40 cursor-pointer"
            title="LLMによる排除ノード・ブレイク対策の自動推薦モーダルを開く"
          >
            <Lightbulb className="w-3.5 h-3.5 text-amber-200" />
            <span>💡 AI対策提案</span>
          </button>

          <button
            type="button"
            onClick={() => openNodeEditor(null)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold transition-colors shadow-md shadow-cyan-950/40 cursor-pointer"
            title="VTA図に新しい作業・変動要因カードを追加"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>＋ カード追加</span>
          </button>

          <button
            type="button"
            onClick={handleAutoLayout}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg text-xs font-semibold transition-colors border border-slate-700/80 cursor-pointer"
            title={`現在の${compactView ? '見出しのみ' : '詳細'}表示を時系列階層レイアウト（BT: 下から上）で再計算`}
          >
            <LayoutTemplate className="w-3.5 h-3.5 text-cyan-400" />
            <span>BT自動整列</span>
          </button>

          <label className="flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 cursor-pointer"
            title="ドラッグ終了時に、移動したカード・接続点だけを所属列の中央に合わせます">
            <input type="checkbox" checked={snapToLaneCenter}
              onChange={(event) => setSnapToLaneCenter(event.target.checked)}
              className="h-3.5 w-3.5 accent-cyan-500" />
            <span>移動後に列中央へスナップ</span>
          </label>

          <button
            type="button"
            disabled={!isActive || vtaData.nodes.length < 2}
            onClick={() => {
              setConnectionRepairPlan(useVTAStore.getState().getConnectionRepairPlan());
            }}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700/80 disabled:opacity-40 disabled:cursor-not-allowed"
            title={`現在の${compactView ? '見出しのみ' : '詳細'}表示の順序で同一レーンの隣接線を確認・整流`}
          >
            同一レーン整流
          </button>

          <button
            type="button"
            disabled={!isActive || !vtaData.nodes.length || isExtracting || isRegenerating || isProposing}
            onClick={() => void useVTAStore.getState().autoConnectNodes()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg text-xs font-semibold border border-indigo-500/70 shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="AIが未接続・不足関係を探索し自動接続（レーン間接続＋連鎖点検＋全採択）"
          >
            <Sparkles className="w-3.5 h-3.5 text-indigo-200" />
            <span>ノード自動接続</span>
          </button>

          <div className="flex items-center shadow-sm">
            <button
              type="button"
              disabled={!isActive || !vtaData.nodes.length || isExtracting || isRegenerating || isProposing}
              onClick={() => void useVTAStore.getState().reoptimizeVTA()}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded-l-lg text-xs font-semibold border-t border-b border-l border-indigo-500/70 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title="手修正後のツリーに対して主体粒度・認知負荷を再評価・反復最適化"
            >
              <GitBranch className="w-3.5 h-3.5 text-indigo-200" />
              <span>VTA最適化</span>
            </button>
            <button
              type="button"
              disabled={!isActive || isExtracting}
              onClick={() => useVTAStore.getState().setIsOptimizationSettingsOpen(true)}
              className="px-2 py-1.5 bg-indigo-800 hover:bg-indigo-700 text-indigo-200 hover:text-white rounded-r-lg text-xs font-semibold border-t border-b border-r border-indigo-500/70 border-l border-l-indigo-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title="最適化パラメータ（反復回数・重み）や局所最適脱出の指示を調整"
            >
              <Sliders className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsLaneOrderOpen((open) => !open)}
            disabled={!isActive}
            aria-expanded={isLaneOrderOpen}
            aria-controls="vta-lane-order-panel"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700/80 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="レーンの表示・非表示・追加・列順序・カード整理"
          >
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>レーン管理</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (!compactView) setIsNotesPanelOpen(true);
              toggleCompactView();
            }}
            aria-pressed={compactView}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs border border-slate-700 cursor-pointer"
            title="本文を右側の補足説明欄に表示します。見出しのみ表示の配置は詳細表示と別に保持されます。"
          >
            {compactView ? '詳細表示に戻す' : '見出しのみ・詰めて表示'}
          </button>

          <button
            type="button"
            onClick={() => fitView({ padding: 0.2, duration: 300 })}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg text-xs font-medium transition-colors border border-slate-700/80 cursor-pointer"
            title="全体を表示"
          >
            <Maximize2 className="w-3.5 h-3.5 text-slate-400" />
            <span>全画面フィット</span>
          </button>

          <div className="w-px h-5 bg-slate-800 mx-0.5" />

          <button
            type="button"
            onClick={toggleNotesPanel}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border cursor-pointer ${
              isNotesPanelOpen
                ? 'bg-cyan-950/80 border-cyan-600 text-cyan-300'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border-slate-700/80'
            }`}
            title="ノード補足説明欄（右サイドパネル）の表示/非表示"
          >
            <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
            <span>補足説明欄</span>
            {notesCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-cyan-900 text-cyan-300 border border-cyan-700 font-mono">
                {notesCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setIsLegendOpen((prev) => !prev)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border cursor-pointer ${
              isLegendOpen
                ? 'bg-cyan-950/80 border-cyan-600 text-cyan-300'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border-slate-700/80'
            }`}
            title="VTA記法・凡例の表示/非表示を切り替え"
          >
            <Info className="w-3.5 h-3.5 text-cyan-400" />
            <span>凡例</span>
          </button>
          {vtaData.nodes.some((node) => node.is_hidden) && <span className="text-[11px] text-slate-300">
            ● 接続点: {vtaData.nodes.filter((node) => node.is_hidden).length}件
          </span>}
          {isLaneOrderOpen && (
            <div
              id="vta-lane-order-panel"
              role="dialog"
              aria-label="列の順序"
              className="absolute top-full left-0 z-40 mt-2 w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl"
            >
              <div className="mb-2 flex items-center justify-between text-sm font-semibold text-slate-100">
                <span>レーン管理・列の順序</span>
                <button type="button" onClick={() => setIsLaneOrderOpen(false)} aria-label="列順序を閉じる" className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <LaneManagementPanel
                schema={vtaData}
                disabled={!isActive}
                onVisibility={setLaneVisibility}
                onAdd={addLane}
                onMove={moveLane}
                onSimplify={simplifyCards}
                onApplyMergeProposal={applyLaneMergeProposal}
                onApplySplitProposal={applyLaneSplitProposal}
                onForceMergeLanes={forceMergeLanes}
                onToggleObjectDisplayStyle={setObjectDisplayStyle}
                onToggleDrilldown={toggleLaneDrilldown}
              />
            </div>
          )}
      {/* Floating Popover Legend Card (Toggled via toolbar button) */}
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
              (change.type === 'position' || (!compactView && !nodes.find((node) => node.id === change.id)?.data.is_hidden)));
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
            onToggleDrilldown={toggleLaneDrilldown}
          />
          <StickyLaneHeaderBar
            provisionalLanes={vtaData.analysis?.entities.filter(e=>e.resolution==='unresolved').map(e=>e.name)}
            laneBounds={displayLaneBounds}
            drilldownCapableMap={drilldownCapableMap}
            onToggleDrilldown={toggleLaneDrilldown}
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
          const store = useVTAStore.getState();
          if (store.applyConnectionRepair(connectionRepairPlan.sourceSignature)) closeConnectionRepair();
          else setConnectionRepairPlan(store.getConnectionRepairPlan());
        }}
      />}
      {isActive && chainRepairOpen && <ChainRepairModal onClose={()=>setChainRepairOpen(false)}/>}
      {isActive && connectionProposalOpen && <ConnectionProposalModal onClose={() => setConnectionProposalOpen(false)} />}
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

    {/* Right-Side Collapsible Supplementary Notes Panel */}
    <SupplementaryNotesPanel focusRequest={noteFocusRequest} />
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
