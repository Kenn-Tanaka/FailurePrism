import React from 'react';
import { ThoughtNode } from '../../domain/schema';
import {
  NODE_KIND_COLORS,
  NODE_KIND_LABELS,
  NODE_STATUS_STYLES,
} from '../../rendering/svgExport';
import { wrapText } from '../../rendering/textWrap';

interface NodeComponentProps {
  node: ThoughtNode;
  levelLabel?: string;
  isSelected: boolean;
  isDraftSource: boolean;
  isDragging: boolean;
  dragX?: number;
  dragY?: number;
  isEditing?: boolean;
  onPointerDown: (e: React.PointerEvent<SVGGElement>, node: ThoughtNode) => void;
  onClick: (e: React.MouseEvent, node: ThoughtNode) => void;
  onDoubleClick?: (e: React.MouseEvent, node: ThoughtNode) => void;
  onStartEdgeDrag?: (e: React.PointerEvent<SVGCircleElement>, node: ThoughtNode) => void;
}

export const NodeComponent: React.FC<NodeComponentProps> = React.memo(({
  node,
  levelLabel,
  isSelected,
  isDraftSource,
  isDragging,
  dragX,
  dragY,
  isEditing = false,
  onPointerDown,
  onClick,
  onDoubleClick,
  onStartEdgeDrag,
}) => {
  const [isHovered, setIsHovered] = React.useState(false);
  const x = isDragging && dragX !== undefined ? dragX : node.x;
  const y = isDragging && dragY !== undefined ? dragY : node.y;

  const colors = NODE_KIND_COLORS[node.kind] || NODE_KIND_COLORS.note;
  const statusStyle = NODE_STATUS_STYLES[node.status] || NODE_STATUS_STYLES.draft;
  const kindLabel = NODE_KIND_LABELS[node.kind] || node.kind;

  const FONT_SIZE = 13;
  const LINE_HEIGHT = 18;
  const wrappedLines = wrapText(node.label, node.width - 24, FONT_SIZE);

  const ports = [
    { id: 'top', cx: node.width / 2, cy: 0 },
    { id: 'right', cx: node.width, cy: node.height / 2 },
    { id: 'bottom', cx: node.width / 2, cy: node.height },
    { id: 'left', cx: 0, cy: node.height / 2 },
  ];

  return (
    <g
      id={`node-${node.id}`}
      className="cursor-move select-none"
      transform={`translate(${x}, ${y})`}
      opacity={statusStyle.opacity ?? 1}
      onPointerDown={(e) => onPointerDown(e, node)}
      onClick={(e) => onClick(e, node)}
      onDoubleClick={(e) => onDoubleClick?.(e, node)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <title>{`[${kindLabel}] ${node.label} (${statusStyle.label}${levelLabel ? ' / ' + levelLabel : ''})\n${node.meta.description}`}</title>

      {/* ノード背景カード */}
      <rect
        width={node.width}
        height={node.height}
        rx={6}
        ry={6}
        fill={colors.fill}
        stroke={isSelected ? '#2563eb' : colors.stroke}
        strokeWidth={isSelected ? 2.5 : 1.5}
        strokeDasharray={statusStyle.dashArray}
        className="transition-colors drop-shadow-sm"
      />

      {/* エッジ作成の接続元ハイライト */}
      {isDraftSource && (
        <rect
          x={-4}
          y={-4}
          width={node.width + 8}
          height={node.height + 8}
          rx={10}
          ry={10}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={2}
          strokeDasharray="4,4"
        />
      )}

      {/* 種別 & 状態バッジ */}
      <text
        x={10}
        y={16}
        fontSize={10}
        fontWeight="bold"
        fill={colors.text}
        className="pointer-events-none"
      >
        [{kindLabel}]
      </text>

      <text
        x={node.width - 10}
        y={16}
        fontSize={10}
        textAnchor="end"
        fill="#64748b"
        className="pointer-events-none"
      >
        {statusStyle.label}
      </text>

      {/* ラベル本文 (text/tspan) - 編集中は非表示にして入力欄をオーバーレイ表示 */}
      {!isEditing && (
        <text
          x={12}
          y={36}
          fontSize={FONT_SIZE}
          fill="#1e293b"
          className="pointer-events-none"
        >
          {wrappedLines.map((line, idx) => (
            <tspan key={idx} x={12} dy={idx === 0 ? 0 : LINE_HEIGHT}>
              {line}
            </tspan>
          ))}
        </text>
      )}

      {/* サブ図アイコン (存在する場合) */}
      {node.childDiagramId && (
        <text
          x={node.width - 12}
          y={node.height - 8}
          fontSize={11}
          textAnchor="end"
          fill="#3b82f6"
          className="pointer-events-none font-bold"
        >
          ↳ 詳細図
        </text>
      )}

      {/* 接続ポート (ホバー時または選択時に表示) */}
      {(isHovered || isSelected) && !isDragging && !isEditing && (
        <g className="transition-opacity duration-150">
          {ports.map((p) => (
            <circle
              key={p.id}
              cx={p.cx}
              cy={p.cy}
              r={5}
              fill="#ffffff"
              stroke="#2563eb"
              strokeWidth={2}
              className="cursor-crosshair hover:fill-blue-100 hover:scale-125 transition-transform"
              onPointerDown={(e) => {
                e.stopPropagation();
                onStartEdgeDrag?.(e, node);
              }}
            />
          ))}
        </g>
      )}
    </g>
  );
});
