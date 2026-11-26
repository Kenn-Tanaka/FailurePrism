import React from 'react';
import { LevelDefinition } from '../../domain/schema';
import { truncateDisplayLabel } from '../../rendering/nodeStyles';
import { useUITheme } from '../../../../shared/theme/themeStore';

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
  const { isLight } = useUITheme();
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
              fill={isLight ? (isEven ? '#f8fafc' : '#ffffff') : (isEven ? '#0f172a' : '#020617')}
              opacity={0.7}
            />

            {/* 列の右境界線 */}
            <line
              x1={columnWidth}
              y1={0}
              x2={columnWidth}
              y2={height}
              stroke={isLight ? '#e2e8f0' : '#1e293b'}
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
                fill={isLight ? '#e2e8f0' : '#1e293b'}
                opacity={0.85}
              />
              <text
                x={4}
                y={0}
                fontSize={12}
                fontWeight="bold"
                fill={isLight ? '#475569' : '#cbd5e1'}
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
