import React, { useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useNodes,
  useEdges,
  type EdgeProps,
} from '@xyflow/react';
import { Scissors, ZapOff, ArrowRightLeft, ArrowRight, Trash2, Edit3, Tag } from 'lucide-react';
import { VTAReactFlowEdgeData, EdgeCategory } from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';
import { getOrthogonalStepPath } from '../utils/layout';
import { routingOffset } from '../utils/edgeRouting';

const CATEGORY_NAMES: Record<EdgeCategory, string> = {
  information: '情報',
  material: '資機材',
  person: '人員',
  handover: '引継ぎ',
  impact: '物理影響',
  sequential: '時系列',
  other: '接続',
};

export const VTAEdge: React.FC<EdgeProps> = ({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  style = {},
}) => {
  const nodes = useNodes();
  const edges = useEdges();
  const sourceNode = nodes.find((node) => node.id === source);
  const sourceNodeHeight =
    sourceNode?.measured?.height ??
    (sourceNode?.data as { measuredHeight?: number } | undefined)?.measuredHeight;

  const [edgePath, labelX, labelY] = getOrthogonalStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    sourceNodeHeight,
    routeOffset: routingOffset(id, edges.filter((edge) => edge.data?.is_cross_lane)),
    obstacles: nodes.map((node) => ({
      x: node.position.x, y: node.position.y,
      width: node.measured?.width ?? 260,
      height: node.measured?.height ?? Number(node.data.measuredHeight ?? 140),
    })),
  });

  const [isHovered, setIsHovered] = useState(false);
  const edgeData = data as VTAReactFlowEdgeData | undefined;
  const isBreak = Boolean(edgeData?.is_break);
  const isCrossLane = Boolean(edgeData?.is_cross_lane);
  const direction = edgeData?.direction || (isCrossLane ? 'unidirectional' : 'sequential');

  const toggleEdgeBreak = useVTAStore((state) => state.toggleEdgeBreak);
  const toggleEdgeDirection = useVTAStore((state) => state.toggleEdgeDirection);
  const openEdgeEditor = useVTAStore((state) => state.openEdgeEditor);
  const deleteEdge = useVTAStore((state) => state.deleteEdge);

  const isBidirectional = direction === 'bidirectional';
  const isUnidirectional = direction === 'unidirectional';

  // Determine stroke color
  const strokeColor = isBreak
    ? '#f43f5e' // rose-500
    : selected
    ? '#38bdf8' // sky-400
    : isBidirectional
    ? '#a855f7' // purple-500 (双方向)
    : isUnidirectional && isCrossLane
    ? '#06b6d4' // cyan-500 (一方向)
    : '#64748b'; // slate-500 (時系列)

  const markerEndId = `marker-end-${id}`;
  const markerStartId = `marker-start-${id}`;

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('この接続線（矢印）を削除しますか？')) {
      deleteEdge(id);
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    openEdgeEditor(id);
  };

  const customLabel = edgeData?.label?.trim();
  const category = edgeData?.category;
  const categoryLabel = category && category !== 'other' ? CATEGORY_NAMES[category] : undefined;

  // Compute display label text (neutral default, never assuming "情報伝達" without reason)
  const displayLabel = customLabel || categoryLabel || (isCrossLane ? (isBidirectional ? '相互確認 ↔' : '伝達 ➔') : undefined);

  return (
    <>
      {/* SVG Custom Marker Definitions */}
      <defs>
        <marker
          id={markerEndId}
          viewBox="0 0 12 12"
          refX="9"
          refY="6"
          markerWidth="8"
          markerHeight="8"
          orient="auto"
        >
          <path d="M 1 2 L 10 6 L 1 10 z" fill={strokeColor} />
        </marker>

        {isBidirectional && (
          <marker
            id={markerStartId}
            viewBox="0 0 12 12"
            refX="3"
            refY="6"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 11 2 L 2 6 L 11 10 z" fill={strokeColor} />
          </marker>
        )}
      </defs>

      {/* Background wider interactive path */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={28}
        className="cursor-pointer"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={() => toggleEdgeBreak(id)}
      />

      {/* Main Edge Line */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={`url(#${markerEndId})`}
        markerStart={isBidirectional ? `url(#${markerStartId})` : undefined}
        style={{
          strokeWidth: isBreak ? 2.5 : isCrossLane ? 2.5 : 2,
          stroke: strokeColor,
          strokeDasharray: isBreak ? '6 4' : isBidirectional ? '5 3' : undefined,
          ...style,
        }}
      />

      {/* Edge Controls & Direction / Break Badges */}
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className="nodrag nopan flex items-center gap-1.5 z-20"
        >
          {/* 1. Break Badge (If active) */}
          {isBreak && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleEdgeBreak(id);
                }}
                title="ブレイク対策（悪影響遮断）が設定されています。クリックで解除"
                className="group flex items-center gap-1.5 px-2.5 py-1 bg-rose-950/95 text-rose-200 border-2 border-rose-500 rounded-full shadow-xl hover:bg-rose-900 transition-all hover:scale-105 active:scale-95 cursor-pointer animate-in zoom-in-75 duration-150"
              >
                <ZapOff className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
                <span className="text-[10px] font-bold tracking-wider uppercase font-mono">BREAK</span>
                <span className="text-xs font-mono text-rose-300">✕</span>
              </button>
              {customLabel && (
                <span className="px-2 py-0.5 bg-slate-900/90 text-slate-300 border border-slate-700 rounded text-[10px] truncate max-w-[140px] shadow-md">
                  {customLabel}
                </span>
              )}
            </div>
          )}

          {/* 2. Connection Label Pill (Editable on click) */}
          {!isBreak && displayLabel && (
            <button
              type="button"
              onClick={handleEdit}
              title={`【接続ラベル】${customLabel ? `「${customLabel}」` : ''} クリックして接続ラベルや分類を編集`}
              className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold border shadow-md transition-all hover:scale-105 active:scale-95 cursor-pointer ${
                isBidirectional
                  ? 'bg-purple-950/90 text-purple-200 border-purple-500/80 shadow-purple-950/50 hover:bg-purple-900'
                  : isCrossLane
                  ? 'bg-cyan-950/90 text-cyan-200 border-cyan-500/80 shadow-cyan-950/50 hover:bg-cyan-900'
                  : 'bg-slate-900/90 text-slate-300 border-slate-700 shadow-slate-950/50 hover:bg-slate-800'
              }`}
            >
              {customLabel ? (
                <>
                  <Tag className="w-3 h-3 text-cyan-400 shrink-0" />
                  <span className="truncate max-w-[120px]">{customLabel}</span>
                  {categoryLabel && <span className="text-[9px] text-slate-400">({categoryLabel})</span>}
                </>
              ) : isBidirectional ? (
                <>
                  <ArrowRightLeft className="w-3 h-3 text-purple-400 shrink-0" />
                  <span>{displayLabel}</span>
                </>
              ) : (
                <>
                  <ArrowRight className="w-3 h-3 text-cyan-400 shrink-0" />
                  <span>{displayLabel}</span>
                </>
              )}
            </button>
          )}

          {/* 3. Hover Actions (Scissors to add Break / Edit / Direction switch / Delete) */}
          {isHovered && (
            <div className="flex items-center gap-1 bg-slate-900/95 p-1 rounded-full border border-slate-700 shadow-xl backdrop-blur animate-in fade-in zoom-in-75 duration-150">
              {/* Edit Label & Category */}
              <button
                type="button"
                onClick={handleEdit}
                title="接続情報（ラベル・分類・方向）を編集"
                className="p-1 hover:bg-cyan-950/80 text-slate-400 hover:text-cyan-400 rounded-full transition-colors cursor-pointer"
              >
                <Edit3 className="w-3 h-3" />
              </button>

              {/* Toggle Break */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleEdgeBreak(id);
                }}
                title={isBreak ? 'ブレイクを解除' : 'ブレイク（悪影響遮断）を設定'}
                className={`p-1 rounded-full transition-colors cursor-pointer ${
                  isBreak ? 'bg-rose-900 text-rose-200' : 'hover:bg-rose-950/80 text-slate-400 hover:text-rose-400'
                }`}
              >
                <Scissors className="w-3 h-3" />
              </button>

              {/* Toggle Direction */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleEdgeDirection(id);
                }}
                title={
                  isBidirectional
                    ? '一方向に切り替え'
                    : '双方向（相互確認）に切り替え'
                }
                className="p-1 hover:bg-purple-950/80 text-slate-400 hover:text-purple-400 rounded-full transition-colors cursor-pointer"
              >
                <ArrowRightLeft className="w-3 h-3" />
              </button>

              {/* Delete Edge */}
              <button
                type="button"
                onClick={handleDelete}
                title="この接続線（矢印）を削除"
                className="p-1 hover:bg-rose-900/80 text-slate-400 hover:text-rose-300 rounded-full transition-colors cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

