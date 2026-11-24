import React, { useRef, useState } from 'react';
import { useViewport, Panel } from '@xyflow/react';
import { Users, FolderTree, Folder, Pencil, Check, X } from 'lucide-react';

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
  onRenameLane?: (oldName: string, newName: string) => boolean;
}

export const StickyLaneHeaderBar: React.FC<StickyLaneHeaderBarProps> = ({
  laneBounds,
  provisionalLanes = [],
  drilldownCapableMap = {},
  onToggleDrilldown,
  onRenameLane,
}) => {
  const { x, zoom } = useViewport();
  const [editingLane, setEditingLane] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const cancellingRef = useRef(false);

  if (!laneBounds || laneBounds.length === 0) return null;

  const startEditing = (laneName: string) => {
    if (!onRenameLane) return;
    cancellingRef.current = false;
    setEditingLane(laneName);
    setDraftName(laneName);
  };

  const cancelEditing = () => {
    cancellingRef.current = true;
    setEditingLane(null);
    setDraftName('');
  };

  const commitEditing = (oldName: string) => {
    if (cancellingRef.current) {
      cancellingRef.current = false;
      return;
    }
    if (!onRenameLane) {
      setEditingLane(null);
      return;
    }
    const ok = onRenameLane(oldName, draftName);
    if (ok) {
      setEditingLane(null);
      setDraftName('');
    }
  };

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
          const canRename = Boolean(onRenameLane) && !isSubLane;
          const isEditing = editingLane === lane.name && canRename;

          return (
            <div
              key={lane.name + index}
              style={{
                position: 'absolute',
                left: `${screenX}px`,
                width: `${screenWidth}px`,
              }}
              className="group top-1 bottom-1 px-2 flex items-center justify-between border-r border-slate-800/80 bg-slate-900/90 rounded-lg shadow-sm"
            >
              {isEditing ? (
                <div
                  className="nodrag nopan flex items-center gap-1 w-full min-w-0"
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="text"
                    autoFocus
                    value={draftName}
                    aria-label={`${lane.name}の表示名を編集`}
                    onChange={(e) => setDraftName(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => commitEditing(lane.name)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitEditing(lane.name);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEditing();
                      }
                    }}
                    className="nodrag nopan min-w-0 flex-1 rounded border border-cyan-500 bg-slate-950 px-1.5 py-0.5 text-xs font-semibold text-slate-100 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="主体名の変更を確定"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      commitEditing(lane.name);
                    }}
                    className="p-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white cursor-pointer shrink-0"
                    title="確定 (Enter)"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    aria-label="主体名の変更をキャンセル"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelEditing();
                    }}
                    className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer shrink-0"
                    title="キャンセル (Esc)"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <>
                  {/* レーン名称 */}
                  <div
                    className={`flex items-center gap-1.5 min-w-0 truncate mr-1 ${canRename ? 'cursor-text' : ''}`}
                    onDoubleClick={(e) => {
                      if (!canRename) return;
                      e.stopPropagation();
                      startEditing(lane.name);
                    }}
                    title={canRename ? `${lane.name}（ダブルクリックまたは鉛筆アイコンで表示名を編集）` : lane.name}
                  >
                    <Users className={`w-3.5 h-3.5 shrink-0 ${isSubLane ? 'text-amber-400' : 'text-cyan-400'}`} />
                    <span
                      className={`text-xs font-semibold truncate tracking-wide ${
                        isSubLane ? 'text-amber-200' : 'text-slate-200'
                      }`}
                    >
                      {lane.name}
                    </span>
                    {canRename && !isCompact && (
                      <button
                        type="button"
                        aria-label={`${lane.name}の表示名を編集`}
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditing(lane.name);
                        }}
                        className="nodrag nopan p-0.5 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 opacity-70 group-hover:opacity-100 transition-opacity cursor-pointer shrink-0"
                        title="主体の表示名を編集"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
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
                </>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
};
