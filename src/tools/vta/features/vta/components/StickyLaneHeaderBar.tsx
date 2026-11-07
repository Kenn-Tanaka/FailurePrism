import React from 'react';
import { useViewport, Panel } from '@xyflow/react';
import { Users, FolderTree, Folder } from 'lucide-react';

interface LaneBound {
  name: string;
  index: number;
  x: number;
  width: number;
  minY: number;
  maxY: number;
}

interface StickyLaneHeaderBarProps {
  laneBounds: LaneBound[];
  provisionalLanes?: string[];
  drilldownCapableMap?: Record<string, { entityId: string; isExpanded: boolean; subCount: number }>;
  onToggleDrilldown?: (entityId: string) => void;
}

export const StickyLaneHeaderBar: React.FC<StickyLaneHeaderBarProps> = ({
  laneBounds,
  provisionalLanes = [],
  drilldownCapableMap = {},
  onToggleDrilldown,
}) => {
  const { x, zoom } = useViewport();

  if (!laneBounds || laneBounds.length === 0) return null;

  return (
    <Panel position="top-left" className="!m-0 !p-0 pointer-events-none select-none z-10 w-full overflow-hidden">
      <div className="relative h-11 w-full bg-slate-950/85 backdrop-blur-md border-b border-slate-800 shadow-lg pointer-events-auto">
        {laneBounds.map((lane, index) => {
          // ReactFlow のビューポート座標系から画面上のピクセル位置をリアルタイム計算
          const screenX = x + lane.x * zoom;
          const screenWidth = lane.width * zoom;

          // 親主体またはサブレーンのドリルダウン情報を解決
          let drilldownInfo = drilldownCapableMap[lane.name];
          let isSubLane = false;
          let parentLaneName: string | undefined;

          if (!drilldownInfo) {
            // サブレーン（例：「海上保安庁機（機長Ａ）」）の場合、親レーン情報を検索
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

          // ズームが極端に小さい場合（画面外・極小）の配慮
          const isCompact = screenWidth < 140;

          return (
            <div
              key={lane.name + index}
              style={{
                position: 'absolute',
                left: `${screenX}px`,
                width: `${screenWidth}px`,
              }}
              className="top-1 bottom-1 px-2 flex items-center justify-between border-r border-slate-800/80 bg-slate-900/90 rounded-lg shadow-sm"
            >
              {/* レーン名称 */}
              <div className="flex items-center gap-1.5 truncate mr-1">
                <Users className={`w-3.5 h-3.5 shrink-0 ${isSubLane ? 'text-amber-400' : 'text-cyan-400'}`} />
                <span
                  className={`text-xs font-semibold truncate tracking-wide ${
                    isSubLane ? 'text-amber-200' : 'text-slate-200'
                  }`}
                  title={lane.name}
                >
                  {lane.name}
                </span>
              </div>

              {/* 展開・集約ボタン & レーン番号 */}
              <div className="flex items-center gap-1 shrink-0">
                {drilldownInfo && onToggleDrilldown && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleDrilldown(drilldownInfo.entityId);
                    }}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold border transition-all cursor-pointer shadow-sm ${
                      drilldownInfo.isExpanded
                        ? 'border-cyan-500 bg-cyan-950/90 text-cyan-200 hover:bg-cyan-900 hover:border-cyan-400'
                        : 'border-cyan-600 bg-cyan-900/80 text-cyan-100 hover:bg-cyan-800 hover:border-cyan-400 animate-pulse'
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
                        <Folder className="w-3.5 h-3.5 text-cyan-300" />
                        {!isCompact && <span>集約</span>}
                      </>
                    ) : (
                      <>
                        <FolderTree className="w-3.5 h-3.5 text-cyan-200" />
                        <span>展開({drilldownInfo.subCount})</span>
                      </>
                    )}
                  </button>
                )}
                {!isCompact && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                    {provisionalLanes.includes(lane.name) ? '主体未特定' : `L${index + 1}`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
};
