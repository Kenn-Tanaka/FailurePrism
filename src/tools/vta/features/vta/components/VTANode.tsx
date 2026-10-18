import React, { useState, useLayoutEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { compactNodeHeight, compactTitleLines } from '../utils/layout';
import { Clock, ShieldCheck, ChevronDown, ChevronUp, AlertTriangle, Activity, Edit2, Trash2 } from 'lucide-react';
import { VTAReactFlowNode, VTANodeData } from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';

export const VTANode: React.FC<NodeProps<VTAReactFlowNode>> = ({
  data,
  selected,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const compact = useVTAStore((state) => state.compactView);
  const updateNodeInternals = useUpdateNodeInternals();
  useLayoutEffect(() => {
    updateNodeInternals(data.id);
  }, [data.id, data.title, data.description, compact, isExpanded, updateNodeInternals]);
  const toggleNodeElimination = useVTAStore((state) => state.toggleNodeElimination);
  const deleteNode = useVTAStore((state) => state.deleteNode);
  const openNodeEditor = useVTAStore((state) => state.openNodeEditor);

  const isVariation = data.type === 'variation';
  const isElimination = data.measure_type === 'elimination';

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nodeData: VTANodeData = {
      id: data.id,
      lane: data.lane,
      time: data.time,
      type: data.type,
      title: data.title,
      description: data.description,
      measure_type: data.measure_type,
      supplementary_note: data.supplementary_note || '',
      position: data.position,
    };
    openNodeEditor(nodeData);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`カード「${data.title}」を削除しますか？\n（関連する矢印の接続も解除されます）`)) {
      deleteNode(data.id);
    }
  };

  return (
    <div
      style={compact ? { height: compactNodeHeight(data.title) } : undefined}
      className={`
        relative w-[260px] rounded-xl flex flex-col transition-colors duration-200 select-none group
        ${
          isVariation
            ? 'bg-slate-900/95 border-2 border-amber-400 text-slate-100 shadow-lg shadow-amber-950/30'
            : 'bg-slate-900/90 border border-slate-700 text-slate-200 shadow-md'
        }
        ${selected ? 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-950' : ''}
        hover:border-cyan-400/80
      `}
    >
      {/* Target & Source Handles for 4 Directions */}
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="!w-3 !h-3 !bg-slate-400 !border-2 !border-slate-900 hover:!bg-cyan-400 !-bottom-1.5"
      />
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        className="!w-3 !h-3 !bg-slate-400 !border-2 !border-slate-900 hover:!bg-cyan-400 !-top-1.5"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left-target"
        style={{ top: '38%' }}
        title="左受信端子 (他レーンからの情報を受信)"
        className="!w-2.5 !h-2.5 !bg-cyan-500 !border-2 !border-slate-900 hover:!bg-cyan-300 !-left-1.5 cursor-crosshair"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left-source"
        style={{ top: '62%' }}
        title="左送信端子 (左レーンへ情報を送信)"
        className="!w-2.5 !h-2.5 !bg-cyan-500 !border-2 !border-slate-900 hover:!bg-cyan-300 !-left-1.5 cursor-crosshair"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right-target"
        style={{ top: '38%' }}
        title="右受信端子 (他レーンからの情報を受信)"
        className="!w-2.5 !h-2.5 !bg-cyan-500 !border-2 !border-slate-900 hover:!bg-cyan-300 !-right-1.5 cursor-crosshair"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right-source"
        style={{ top: '62%' }}
        title="右送信端子 (右レーンへ情報を送信)"
        className="!w-2.5 !h-2.5 !bg-cyan-500 !border-2 !border-slate-900 hover:!bg-cyan-300 !-right-1.5 cursor-crosshair"
      />

      {/* Elimination Badge (○印バッジ) on Top-Right Corner */}
      {isElimination && (
        <div
          title="排除ノード（対策済み: クリックして解除）"
          onClick={(e) => {
            e.stopPropagation();
            toggleNodeElimination(data.id);
          }}
          className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white flex items-center justify-center font-bold text-lg shadow-lg border-2 border-slate-950 animate-in zoom-in-50 duration-150 z-20 cursor-pointer"
        >
          ○
        </div>
      )}

      {/* Header Bar */}
      <div
        className={`px-3 py-2 rounded-t-lg flex items-center justify-between border-b ${
          isVariation
            ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
            : 'bg-slate-800/60 border-slate-700/60 text-slate-400'
        }`}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium truncate">
          {isVariation ? (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : (
            <Activity className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}
          <span className="font-semibold">{isVariation ? '変動要因' : '通常作業'}</span>
        </div>

        <div className="flex items-center gap-1">
          {/* Time Badge */}
          {data.time && (
            <div className="flex items-center gap-1 text-[11px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-300 font-mono truncate max-w-[90px]">
              <Clock className="w-3 h-3 text-slate-400 shrink-0" />
              <span className="truncate">{data.time}</span>
            </div>
          )}

          {/* Quick Edit & Delete Actions */}
          <button
            type="button"
            onClick={handleEdit}
            className="p-1 text-slate-400 hover:text-cyan-300 hover:bg-slate-800 rounded transition-colors"
            title="カードを編集"
          >
            <Edit2 className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors"
            title="カードを削除"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="p-3 flex-1">
        {/* Title */}
        <h4 className="font-semibold text-sm leading-5 text-slate-100 mb-1 break-words">
          {compact ? compactTitleLines(data.title).map((line, i) => <span className="block" key={i}>{line || '\u00a0'}</span>) : data.title}
        </h4>

        {/* Expandable Description */}
        {!compact && data.description && (
          <div className="mt-2">
            {isExpanded && (
              <p className="text-xs text-slate-300 bg-slate-950/60 p-2 rounded border border-slate-800 leading-relaxed break-words">
                {data.description}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer / Interactive Action Bar */}
      {!compact && (
      <div className="px-3 py-1.5 bg-slate-950/40 rounded-b-lg border-t border-slate-800/60 flex items-center justify-between text-xs">
        {/* Toggle Elimination Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleNodeElimination(data.id);
          }}
          className={`
            inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer
            ${
              isElimination
                ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/40'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700 border border-slate-700'
            }
          `}
          title="クリックして対策（排除ノード○印）を付与/解除"
        >
          <ShieldCheck className="w-3 h-3" />
          <span>{isElimination ? '排除指定中 (○)' : '対策: 排除'}</span>
        </button>

        {/* Expand/Collapse Toggle */}
        {!compact && data.description && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="text-slate-400 hover:text-slate-200 p-0.5 rounded cursor-pointer"
            title={isExpanded ? '詳細を閉じる' : '詳細を展開'}
          >
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      )}
    </div>
  );
};
