import React from 'react';
import { ThoughtEdge, ThoughtNode } from '../../domain/schema';
import { calculateEdgePath } from '../../rendering/connectionPoints';

interface EdgeComponentProps {
  edge: ThoughtEdge;
  sourceNode: ThoughtNode;
  targetNode: ThoughtNode;
  isSelected: boolean;
  isReversePair: boolean;
  onClick: (e: React.MouseEvent, edge: ThoughtEdge) => void;
}

export const EdgeComponent: React.FC<EdgeComponentProps> = React.memo(({
  edge,
  sourceNode,
  targetNode,
  isSelected,
  isReversePair,
  onClick,
}) => {
  const { pathData, midPoint } = calculateEdgePath(
    sourceNode,
    targetNode,
    isReversePair
  );

  let strokeDash = '';
  let strokeColor = '#64748b'; // slate-500
  if (isSelected) {
    strokeColor = '#2563eb'; // blue-600
  } else if (edge.kind === 'dependency') {
    strokeColor = '#0284c7'; // sky-600
  } else if (edge.kind === 'constraint') {
    strokeColor = '#dc2626'; // rose-600
    strokeDash = '4,4';
  } else if (edge.kind === 'reference') {
    strokeColor = '#94a3b8'; // slate-400
    strokeDash = '2,2';
  }

  return (
    <g
      id={`edge-${edge.id}`}
      className="cursor-pointer group"
      onClick={(e) => onClick(e, edge)}
    >
      <title>{`${edge.label || edge.kind}: ${sourceNode.label} → ${targetNode.label}`}</title>

      {/* 仕様書 6.1: 太い透明ヒット領域 */}
      <path
        d={pathData}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        className="cursor-pointer"
      />

      {/* 実際の表示線 */}
      <path
        d={pathData}
        fill="none"
        stroke={strokeColor}
        strokeWidth={isSelected ? 2.5 : 1.5}
        strokeDasharray={strokeDash}
        markerEnd={`url(#arrow-${edge.kind}${isSelected ? '-selected' : ''})`}
        className="transition-colors group-hover:stroke-blue-500"
      />

      {/* ラベル表示 */}
      {edge.label && (
        <g transform={`translate(${midPoint.x}, ${midPoint.y})`}>
          <rect
            x={-edge.label.length * 5 - 4}
            y={-12}
            width={edge.label.length * 10 + 8}
            height={16}
            rx={3}
            fill="#ffffff"
            stroke="#cbd5e1"
            strokeWidth={1}
            opacity={0.9}
          />
          <text
            x={0}
            y={0}
            fontSize={11}
            textAnchor="middle"
            fill={isSelected ? '#2563eb' : '#475569'}
            className="pointer-events-none select-none font-medium"
          >
            {edge.label}
          </text>
        </g>
      )}
    </g>
  );
});
