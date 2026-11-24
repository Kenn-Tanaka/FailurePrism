import React, { useRef, useState } from 'react';
import { useViewport } from '@xyflow/react';
import { Users, FolderTree, Folder, Pencil, Check, X } from 'lucide-react';

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
  onRenameLane?: (oldName: string, newName: string) => boolean;
}

export const SwimlaneBackground: React.FC<SwimlaneBackgroundProps> = ({
  laneBounds,
  provisionalLanes = [],
  drilldownCapableMap = {},
  onToggleDrilldown,
  onRenameLane,
}) => {
  const { x, y, zoom } = useViewport();
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

        const canRename = Boolean(onRenameLane) && !isSubLane;
        const isEditing = editingLane === lane.name && canRename;

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
            <div className="group absolute top-2 left-3 right-3 p-2.5 rounded-lg bg-slate-900/95 border border-slate-700/80 shadow-md backdrop-blur flex items-center justify-between pointer-events-auto">
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
                  <div
                    className={`flex items-center gap-2 min-w-0 truncate ${canRename ? 'cursor-text' : ''}`}
                    onDoubleClick={(e) => {
                      if (!canRename) return;
                      e.stopPropagation();
                      startEditing(lane.name);
                    }}
                    title={canRename ? `${lane.name}（ダブルクリックまたは鉛筆アイコンで表示名を編集）` : lane.name}
                  >
                    <Users className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span className="text-xs font-semibold text-slate-200 truncate tracking-wide">
                      {lane.name}
                    </span>
                    {canRename && (
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
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
