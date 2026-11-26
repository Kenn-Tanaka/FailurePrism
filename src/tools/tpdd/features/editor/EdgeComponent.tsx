import React from 'react';
import { ThoughtEdge, ThoughtNode } from '../../domain/schema';
import { calculateEdgePath } from '../../rendering/connectionPoints';
import { useUITheme } from '../../../../shared/theme/themeStore';

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
  const { isLight } = useUITheme();
  const { pathData, midPoint } = calculateEdgePath(
    sourceNode,
    targetNode,
    isReversePair
  );

  let strokeDash = '';
  let strokeColor = isLight ? '#64748b' : '#94a3b8';
  if (isSelected) {
    strokeColor = isLight ? '#2563eb' : '#60a5fa';
  } else if (edge.kind === 'dependency') {
    strokeColor = isLight ? '#0284c7' : '#38bdf8';
  } else if (edge.kind === 'constraint') {
    strokeColor = isLight ? '#dc2626' : '#f87171';
    strokeDash = '4,4';
  } else if (edge.kind === 'reference') {
    strokeColor = isLight ? '#94a3b8' : '#64748b';
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
            fill={isLight ? '#ffffff' : '#0f172a'}
            stroke={isLight ? '#cbd5e1' : '#334155'}
            strokeWidth={1}
            opacity={0.92}
          />
          <text
            x={0}
            y={0}
            fontSize={11}
            textAnchor="middle"
            fill={isSelected ? (isLight ? '#2563eb' : '#60a5fa') : (isLight ? '#475569' : '#cbd5e1')}
            className="pointer-events-none select-none font-medium"
          >
            {edge.label}
          </text>
        </g>
      )}
    </g>
  );
});
