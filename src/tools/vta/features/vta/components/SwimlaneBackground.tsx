import React from 'react';
import { useViewport } from '@xyflow/react';
import { Users, FolderTree, Folder } from 'lucide-react';

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
  provisionalLanes?: string[];
  drilldownCapableMap?: Record<string, { entityId: string; isExpanded: boolean; subCount: number }>;
  onToggleDrilldown?: (entityId: string) => void;
}

export const SwimlaneBackground: React.FC<SwimlaneBackgroundProps> = ({
  laneBounds,
  provisionalLanes = [],
  drilldownCapableMap = {},
  onToggleDrilldown,
}) => {
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
        let drilldownInfo = drilldownCapableMap[lane.name];
        let isSubLane = false;
        let parentLaneName: string | undefined;

        if (!drilldownInfo) {
          const match = lane.name.match(/^(.*?)（(.*?)）$/);
          if (match) {
            parentLaneName = match[1];
            const parentInfo = drilldownCapableMap[parentLaneName];
            if (parentInfo && parentInfo.isExpanded) {
              drilldownInfo = parentInfo;
              isSubLane = true;
            }
          }
        }

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
              <div className="flex items-center gap-1.5 shrink-0">
                {drilldownInfo && onToggleDrilldown && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleDrilldown(drilldownInfo.entityId);
                    }}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                      drilldownInfo.isExpanded
                        ? 'border-cyan-600 bg-cyan-950 text-cyan-200 hover:bg-cyan-900'
                        : 'border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                    title={
                      drilldownInfo.isExpanded
                        ? isSubLane
                          ? `「${parentLaneName}」へ集約（ロールアップ）`
                          : '親組織に集約（ロールアップ）'
                        : `子主体を展開（ドリルダウン: ${drilldownInfo.subCount}件）`
                    }
                  >
                    {drilldownInfo.isExpanded ? (
                      <>
                        <Folder className="w-3 h-3 text-cyan-300" />
                        <span>集約</span>
                      </>
                    ) : (
                      <>
                        <FolderTree className="w-3 h-3 text-slate-300" />
                        <span>展開({drilldownInfo.subCount})</span>
                      </>
                    )}
                  </button>
                )}
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                  {provisionalLanes.includes(lane.name) ? '主体未特定' : `Lane ${index + 1}`}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
