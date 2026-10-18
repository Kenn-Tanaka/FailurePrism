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
import { VTAEdge } from './VTAEdge';
import { SwimlaneBackground } from './SwimlaneBackground';
import { NodeEditorModal } from './NodeEditorModal';
import { EdgeEditorModal } from './EdgeEditorModal';
import { SupplementaryNotesPanel } from './SupplementaryNotesPanel';
import { GenerationProgressOverlay } from './GenerationProgressOverlay';
import { AIMeasuresProposalModal } from './AIMeasuresProposalModal';
import { SVGExportModal } from './SVGExportModal';
import { useVTAStore } from '../store/vtaStore';
import type { VTAReactFlowNode } from '../../../types/vta';
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
} from 'lucide-react';

const nodeTypes: NodeTypes = {
  vtaNode: VTANode as unknown as NodeTypes['vtaNode'],
};

const edgeTypes: EdgeTypes = {
  vtaEdge: VTAEdge,
};

interface VTACanvasProps {
  isActive?: boolean;
}

const CanvasInner: React.FC<VTACanvasProps> = ({ isActive = true }) => {
  const nodes = useVTAStore((state) => state.nodes);
  const edges = useVTAStore((state) => state.edges);
  const laneBounds = useVTAStore((state) => state.laneBounds);
  const onNodesChange = useVTAStore((state) => state.onNodesChange);
  const onNodesDelete = useVTAStore((state) => state.onNodesDelete);
  const onEdgesChange = useVTAStore((state) => state.onEdgesChange);
  const onConnect = useVTAStore((state) => state.onConnect);
  const recalculateLayout = useVTAStore((state) => state.recalculateLayout);
  const vtaData = useVTAStore((state) => state.vtaData);
  const isNodeEditorOpen = useVTAStore((state) => state.isNodeEditorOpen);
  const editingNodeData = useVTAStore((state) => state.editingNodeData);
  const openNodeEditor = useVTAStore((state) => state.openNodeEditor);
  const closeNodeEditor = useVTAStore((state) => state.closeNodeEditor);
  const editingEdgeId = useVTAStore((state) => state.editingEdgeId);
  const closeEdgeEditor = useVTAStore((state) => state.closeEdgeEditor);
  const isNotesPanelOpen = useVTAStore((state) => state.isNotesPanelOpen);
  const toggleNotesPanel = useVTAStore((state) => state.toggleNotesPanel);
  const setIsProposalModalOpen = useVTAStore((state) => state.setIsProposalModalOpen);
  const undo = useVTAStore((state) => state.undo);
  const redo = useVTAStore((state) => state.redo);
  const canUndo = useVTAStore((state) => state.past.length > 0);
  const canRedo = useVTAStore((state) => state.future.length > 0);

  const { fitView } = useReactFlow();
  const compactView = useVTAStore((state) => state.compactView);
  const toggleCompactView = useVTAStore((state) => state.toggleCompactView);
  const compactLayout = useMemo(() => compactView
    ? calculateVTALayout(vtaData, undefined, undefined, { compact: true, forceRecompute: true })
    : null, [compactView, vtaData]);
  const displayNodes = useMemo(() => compactLayout
    ? compactLayout.nodes.map((node) => ({ ...node, selected: nodes.find((n) => n.id === node.id)?.selected }))
    : nodes, [compactLayout, nodes]);
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
    () => vtaData.nodes.filter((n) => Boolean(n.supplementary_note?.trim())).length,
    [vtaData.nodes]
  );
  const [isLegendOpen, setIsLegendOpen] = useState(false);

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
            disabled={compactView}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg text-xs font-semibold transition-colors border border-slate-700/80 cursor-pointer"
            title="時系列階層レイアウト（BT: 下から上）を再計算"
          >
            <LayoutTemplate className="w-3.5 h-3.5 text-cyan-400" />
            <span>BT自動整列</span>
          </button>

          <button
            type="button"
            onClick={toggleCompactView}
            aria-pressed={compactView}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs border border-slate-700 cursor-pointer"
            title="本文を隠して自動整列します。詳細表示の手動配置は保持されます。見出し表示中はカードの移動を停止します。"
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
          edges={compactLayout ? compactLayout.edges.map((edge) => ({ ...edge, selected: edges.find((e) => e.id === edge.id)?.selected })) : edges}
          nodesDraggable={!compactView}
          nodesFocusable={isActive}
          edgesFocusable={isActive}
          onNodesChange={(changes) => {
            let applicable = compactView
              ? changes.filter((change) => change.type !== 'dimensions' && change.type !== 'position')
              : changes;
            if (!isActive) {
              applicable = applicable.filter((change) => change.type !== 'remove');
            }
            if (applicable.length) onNodesChange(applicable);
          }}
          onNodesDelete={isActive ? onNodesDelete : undefined}
          deleteKeyCode={isActive ? ['Backspace', 'Delete'] : null}
          selectionKeyCode={isActive ? 'Shift' : null}
          multiSelectionKeyCode={isActive ? ['Meta', 'Control'] : null}
          panActivationKeyCode={isActive ? 'Space' : null}
          zoomActivationKeyCode={isActive ? ['Meta', 'Control'] : null}
          onEdgesChange={(changes) => {
            const applicable = isActive
              ? changes
              : changes.filter((change) => change.type !== 'remove');
            if (applicable.length) onEdgesChange(applicable);
          }}
          onConnect={onConnect}
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
          <SwimlaneBackground laneBounds={compactLayout?.laneBounds ?? laneBounds} />
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
            nodeStrokeColor={(n) => (n.data?.type === 'variation' ? '#f59e0b' : '#64748b')}
            nodeColor={(n) => (n.data?.measure_type === 'elimination' ? '#10b981' : '#1e293b')}
            className="!bg-slate-900/90 !border-slate-800 !rounded-xl !overflow-hidden !mb-16 !shadow-xl"
            maskColor="rgba(15, 23, 42, 0.75)"
          />
        </ReactFlow>
      </div>

      {/* Card (Node) Creation & Edit Modal */}
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
      <GenerationProgressOverlay />

      {/* AI Countermeasure Proposal Modal */}
      <AIMeasuresProposalModal isActive={isActive} />

      {/* SVG Export Configuration Modal */}
      <SVGExportModal isActive={isActive} />
    </div>

    {/* Right-Side Collapsible Supplementary Notes Panel */}
    <SupplementaryNotesPanel />
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
