import React from 'react';
import { useViewport } from '@xyflow/react';
import { Users } from 'lucide-react';

interface LaneBound {
  name: string;
  index: number;
  x: number;
  width: number;
  minY: number;
  maxY: number;
}

interface SwimlaneBackgroundProps {
  laneBounds: LaneBound[];
}

export const SwimlaneBackground: React.FC<SwimlaneBackgroundProps> = ({ laneBounds }) => {
  const { x, y, zoom } = useViewport();

  if (!laneBounds || laneBounds.length === 0) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none select-none z-0"
      style={{
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
    >
      {laneBounds.map((lane, index) => {
        const height = Math.max(lane.maxY - lane.minY, 800);
        const isEven = index % 2 === 0;

        return (
          <div
            key={lane.name + index}
            style={{
              position: 'absolute',
              left: `${lane.x}px`,
              top: `${lane.minY}px`,
              width: `${lane.width}px`,
              height: `${height}px`,
            }}
            className={`
              border-r border-slate-800/80 rounded-2xl transition-colors
              ${isEven ? 'bg-slate-900/35' : 'bg-slate-950/35'}
            `}
          >
            {/* Lane Header */}
            <div className="absolute top-2 left-3 right-3 p-2.5 rounded-lg bg-slate-900/95 border border-slate-700/80 shadow-md backdrop-blur flex items-center justify-between pointer-events-auto">
              <div className="flex items-center gap-2 truncate">
                <Users className="w-4 h-4 text-cyan-400 shrink-0" />
                <span className="text-xs font-semibold text-slate-200 truncate tracking-wide">
                  {lane.name}
                </span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                Lane {index + 1}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
