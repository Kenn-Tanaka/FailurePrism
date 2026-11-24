import React, { useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useNodes,
  useEdges,
  type EdgeProps,
} from '@xyflow/react';
import {
  Scissors,
  ZapOff,
  ArrowRightLeft,
  Trash2,
  Edit3,
} from 'lucide-react';
import {
  VTAReactFlowEdge,
  VTAReactFlowEdgeData,
  VTAReactFlowNode,
  type VTAObjectDisplayStyle,
} from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';
import {
  getOrthogonalStepPath,
  resolveVTAEdgePaths,
  type EdgePathTuple,
} from '../utils/layout';
import { routingOffset } from '../utils/edgeRouting';
import { getDisplayRect, getEdgeAnchor, routingObstacles, type NodeRect } from '../utils/nodeGeometry';
import {
  EDGE_LABEL_CLIP_PATHS,
  resolveEdgeArrowOrientation,
  resolveEdgeLabelContent,
  type EdgeArrowOrientation,
  type EdgeLabelContent,
} from '../utils/edgeLabels';

interface ConnectionLabelBadgeProps {
  orientation: EdgeArrowOrientation;
  content: EdgeLabelContent;
  isBidirectional: boolean;
  isCrossLane: boolean;
  isSecondaryBreak?: boolean;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}

const ConnectionLabelBadge: React.FC<ConnectionLabelBadgeProps> = ({
  orientation,
  content,
  isBidirectional,
  isCrossLane,
  isSecondaryBreak = false,
  title,
  onClick,
}) => {
  const clipPaths = EDGE_LABEL_CLIP_PATHS[orientation];
  const { customLabel, categoryLabel, displayLabel } = content;
  const labelBody = customLabel ? (
    <>
      <span className="truncate max-w-[96px]">{customLabel}</span>
      {categoryLabel && <span className="text-[9px] text-slate-400 shrink-0">({categoryLabel})</span>}
    </>
  ) : (
    <span className="whitespace-nowrap">{displayLabel}</span>
  );

  const colorPalette = isSecondaryBreak
    ? {
        outerBg: 'bg-slate-600 group-hover/badge:bg-slate-500',
        innerBg: 'bg-slate-900 group-hover/badge:bg-slate-800',
        text: 'text-slate-200',
        capsule: 'bg-slate-900/95 text-slate-200 border-slate-700 hover:bg-slate-800',
      }
    : isBidirectional
      ? {
          outerBg: 'bg-purple-500/90 group-hover/badge:bg-purple-400',
          innerBg: 'bg-purple-950 group-hover/badge:bg-purple-900',
          text: 'text-purple-100',
          capsule: 'bg-purple-950/90 text-purple-200 border-purple-500/80 shadow-purple-950/50 hover:bg-purple-900',
        }
      : isCrossLane
        ? {
            outerBg: 'bg-cyan-500/90 group-hover/badge:bg-cyan-400',
            innerBg: 'bg-cyan-950 group-hover/badge:bg-cyan-900',
            text: 'text-cyan-100',
            capsule: 'bg-cyan-950/90 text-cyan-200 border-cyan-500/80 shadow-cyan-950/50 hover:bg-cyan-900',
          }
        : {
            outerBg: 'bg-slate-600 group-hover/badge:bg-slate-500',
            innerBg: 'bg-slate-900 group-hover/badge:bg-slate-800',
            text: 'text-slate-200',
            capsule: 'bg-slate-900/90 text-slate-300 border-slate-700 shadow-slate-950/50 hover:bg-slate-800',
          };

  if (clipPaths) {
    const paddingClass =
      orientation === 'right'
        ? 'pl-2.5 pr-4'
        : orientation === 'left'
          ? 'pl-4 pr-2.5'
          : orientation === 'horizontal-both'
            ? 'pl-3.5 pr-3.5'
            : 'px-3';

    const shapeBoundsClass =
      orientation === 'up'
        ? 'inset-x-0 -top-[7px] bottom-0'
        : orientation === 'down'
          ? 'inset-x-0 top-0 -bottom-[7px]'
          : orientation === 'vertical-both'
            ? 'inset-x-0 -top-[7px] -bottom-[7px]'
            : 'inset-0';

    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        data-arrow-orientation={orientation}
        className="group/badge relative inline-flex items-center h-6 text-[10px] font-semibold drop-shadow-md transition-transform hover:scale-105 active:scale-95 cursor-pointer"
      >
        <span aria-hidden="true" className={`pointer-events-none absolute ${shapeBoundsClass}`}>
          <span
            style={{ clipPath: clipPaths.outer }}
            className={`absolute inset-0 transition-colors ${colorPalette.outerBg}`}
          />
          <span
            style={{ clipPath: clipPaths.inner }}
            className={`absolute inset-[1.5px] transition-colors ${colorPalette.innerBg}`}
          />
        </span>
        <span className={`relative z-10 flex items-center gap-1 ${paddingClass} ${colorPalette.text}`}>
          {labelBody}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-arrow-orientation={orientation}
      className={`flex items-center gap-1 h-6 px-2.5 rounded-full text-[10px] font-semibold border shadow-md transition-all hover:scale-105 active:scale-95 cursor-pointer ${colorPalette.capsule}`}
    >
      {labelBody}
    </button>
  );
};

interface EdgePathCacheEntry {
  nodes: readonly VTAReactFlowNode[];
  edges: readonly VTAReactFlowEdge[];
  style: VTAObjectDisplayStyle | undefined;
  geometryKey: string;
  rects: Map<string, NodeRect>;
  paths: Map<string, EdgePathTuple>;
}

let lastSharedEdgeCache: EdgePathCacheEntry | null = null;

function buildEdgeGeometryKey(
  rects: ReadonlyMap<string, NodeRect>,
  edges: readonly VTAReactFlowEdge[],
  style: VTAObjectDisplayStyle | undefined
): string {
  const parts: string[] = [style ?? 'dot'];
  for (const [id, r] of rects) {
    parts.push(
      `${id}:${Math.round(r.x * 2)},${Math.round(r.y * 2)},${Math.round(r.width * 2)},${Math.round(r.height * 2)},${r.isHidden ? 1 : 0},${r.isObjectJunction ? 1 : 0}`
    );
  }
  parts.push('|');
  for (const e of edges) {
    const d = e.data;
    const rawLabel = typeof (d?.label ?? e.label) === 'string' ? String(d?.label ?? e.label) : '';
    parts.push(
      `${e.id}:${e.source}>${e.target}:${e.sourceHandle ?? ''}:${e.targetHandle ?? ''}:${d?.is_cross_lane ? 1 : 0}:${d?.direction ?? ''}:${d?.laneDistance ?? ''}:${d?.is_break ? 1 : 0}:${d?.category ?? ''}:${d?.status ?? ''}:${d?.receipt ?? ''}:${rawLabel}`
    );
  }
  return parts.join(';');
}

export function getSharedEdgeLayout(
  nodes: readonly VTAReactFlowNode[],
  edges: readonly VTAReactFlowEdge[],
  style: VTAObjectDisplayStyle | undefined
): EdgePathCacheEntry {
  // Level 1: O(1) array-reference fast path for the remaining E-1 edge renders in the same commit
  if (
    lastSharedEdgeCache &&
    lastSharedEdgeCache.nodes === nodes &&
    lastSharedEdgeCache.edges === edges &&
    lastSharedEdgeCache.style === style
  ) {
    return lastSharedEdgeCache;
  }

  // Level 2: O(N + E) geometry signature check so hover / selection changes never re-run O(E^2 * N) routing
  const rects = new Map<string, NodeRect>(
    nodes.map((node) => [node.id, getDisplayRect(node, style)])
  );
  const geometryKey = buildEdgeGeometryKey(rects, edges, style);
  if (lastSharedEdgeCache && lastSharedEdgeCache.geometryKey === geometryKey) {
    lastSharedEdgeCache = {
      nodes,
      edges,
      style,
      geometryKey,
      rects,
      paths: lastSharedEdgeCache.paths,
    };
    return lastSharedEdgeCache;
  }

  const paths = resolveVTAEdgePaths(edges, rects);
  const entry: EdgePathCacheEntry = { nodes, edges, style, geometryKey, rects, paths };
  lastSharedEdgeCache = entry;
  return entry;
}

export const VTAEdge: React.FC<EdgeProps> = ({
  id,
  source,
  target,
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
  const nodes = useNodes<VTAReactFlowNode>();
  const edges = useEdges<VTAReactFlowEdge>();
  const defaultObjectDisplayStyle = useVTAStore((state) => state.vtaData.presentation?.defaultObjectDisplayStyle);
  const { rects, paths: resolvedPaths } = getSharedEdgeLayout(nodes, edges, defaultObjectDisplayStyle);
  const sourceRect = rects.get(source);
  const targetRect = rects.get(target);
  const sourceAnchor = sourceRect && getEdgeAnchor(sourceRect, sourcePosition, true);
  const targetAnchor = targetRect && getEdgeAnchor(targetRect, targetPosition, false);
  const targetIsJunction = Boolean(targetRect?.isHidden || targetRect?.isObjectJunction);
  const sourceIsJunction = Boolean(sourceRect?.isHidden || sourceRect?.isObjectJunction);

  const resolvedSourceX = sourceAnchor?.x ?? sourceX;
  const resolvedSourceY = sourceAnchor?.y ?? sourceY;
  const resolvedTargetX = targetAnchor?.x ?? targetX;
  const resolvedTargetY = targetAnchor?.y ?? targetY;

  const [edgePath, labelX, labelY] = resolvedPaths.get(id) ?? getOrthogonalStepPath({
    sourceX: resolvedSourceX,
    sourceY: resolvedSourceY,
    targetX: resolvedTargetX,
    targetY: resolvedTargetY,
    sourcePosition,
    targetPosition,
    sourceNodeHeight: sourceRect?.height,
    sourceNodeTop: sourceRect?.y,
    laneDistance: typeof data?.laneDistance === 'number' ? data.laneDistance : undefined,
    routeOffset: routingOffset(id, edges.filter((edge) => edge.data?.is_cross_lane)),
    obstacles: routingObstacles(rects, source, target),
    targetIsJunction,
    sourceIsJunction,
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

  const labelContent = resolveEdgeLabelContent({
    label: edgeData?.label,
    category: edgeData?.category,
    direction,
    isCrossLane,
    status: edgeData?.status,
    receipt: edgeData?.receipt,
  });
  const arrowOrientation = resolveEdgeArrowOrientation({
    direction,
    isCrossLane,
    sourceX: resolvedSourceX,
    sourceY: resolvedSourceY,
    targetX: resolvedTargetX,
    targetY: resolvedTargetY,
    sourcePosition,
    path: edgePath,
    labelX,
    labelY,
  });
  const { customLabel, displayLabel, fullText } = labelContent;

  return (
    <>
      {/* SVG Custom Marker Definitions */}
      <defs>
        <marker
          id={markerEndId}
          viewBox="0 0 12 12"
          refX={targetRect?.isHidden ? 17 : 9}
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
            refX={sourceRect?.isHidden ? 17 : 3}
            refY="6"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d={sourceRect?.isHidden ? 'M 1 2 L 10 6 L 1 10 z' : 'M 11 2 L 2 6 L 11 10 z'} fill={strokeColor} />
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
        markerEnd={direction === 'undirected' ? undefined : `url(#${markerEndId})`}
        markerStart={isBidirectional ? `url(#${markerStartId})` : undefined}
        style={{
          strokeWidth: isBreak ? 2.5 : isCrossLane ? 2.5 : 2,
          stroke: strokeColor,
          strokeDasharray: edgeData?.meaning === 'dependency' ? '8 3 2 3' : isBreak || edgeData?.status === 'omitted' ? '6 4' : isBidirectional ? '5 3' : undefined,
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
                className="group flex items-center gap-1 px-2 py-0.5 bg-rose-950/95 text-rose-200 border border-rose-500 rounded-full shadow-md hover:bg-rose-900 transition-all hover:scale-105 active:scale-95 cursor-pointer animate-in zoom-in-75 duration-150"
              >
                <ZapOff className="w-3 h-3 text-rose-400 animate-pulse" />
                <span className="text-[10px] font-bold uppercase font-mono">BREAK</span>
                <span className="text-[10px] font-mono text-rose-300">✕</span>
              </button>
              {customLabel && (
                <ConnectionLabelBadge
                  orientation={arrowOrientation}
                  content={labelContent}
                  isBidirectional={isBidirectional}
                  isCrossLane={isCrossLane}
                  isSecondaryBreak
                  title={`【接続ラベル】「${fullText}」 クリックして接続ラベルや分類を編集`}
                  onClick={handleEdit}
                />
              )}
            </div>
          )}

          {/* 2. Connection Label Pill (Editable on click) */}
          {!isBreak && displayLabel && (
            <ConnectionLabelBadge
              orientation={arrowOrientation}
              content={labelContent}
              isBidirectional={isBidirectional}
              isCrossLane={isCrossLane}
              title={`【接続ラベル】${fullText ? `「${fullText}」 ` : ''}クリックして接続ラベルや分類を編集`}
              onClick={handleEdit}
            />
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

