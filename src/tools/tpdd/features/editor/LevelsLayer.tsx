import React from 'react';
import { LevelDefinition } from '../../domain/schema';
import { truncateDisplayLabel } from '../../rendering/nodeStyles';

interface LevelsLayerProps {
  levels: LevelDefinition[];
  columnWidth?: number;
  height?: number;
}

export const LevelsLayer: React.FC<LevelsLayerProps> = React.memo(({
  levels,
  columnWidth = 320,
  height = 4000,
}) => {
  return (
    <g className="levels-layer pointer-events-none select-none">
      {levels.map((lvl, index) => {
        const x = index * columnWidth;
        const isEven = index % 2 === 0;
        const displayedLabel = truncateDisplayLabel(lvl.label, 18);

        return (
          <g key={lvl.id} transform={`translate(${x}, -500)`}>
            <title>{`${lvl.label}${lvl.description ? `: ${lvl.description}` : ''}`}</title>
            {/* 列の背景帯 */}
            <rect
              width={columnWidth}
              height={height}
              fill={isEven ? '#f8fafc' : '#ffffff'}
              opacity={0.7}
            />

            {/* 列の右境界線 */}
            <line
              x1={columnWidth}
              y1={0}
              x2={columnWidth}
              y2={height}
              stroke="#e2e8f0"
              strokeWidth={1}
              strokeDasharray="4,4"
            />

            {/* 列ヘッダー */}
            <g transform="translate(16, 520)">
              <rect
                x={-8}
                y={-18}
                width={Math.min(columnWidth - 24, Array.from(displayedLabel).length * 16 + 24)}
                height={26}
                rx={13}
                fill="#e2e8f0"
                opacity={0.8}
              />
              <text
                x={4}
                y={0}
                fontSize={12}
                fontWeight="bold"
                fill="#475569"
              >
                {displayedLabel}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
});
