import React, { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { VTAReactFlowNode, VTANodeData } from '../../../types/vta';
import { OBJECT_JUNCTION_SIZE, OBJECT_JUNCTION_RADIUS } from '../utils/nodeGeometry';
import { useVTAStore } from '../store/vtaStore';

const ports = [
  ['top', 'source', Position.Top],
  ['bottom', 'target', Position.Bottom],
  ['left-source', 'source', Position.Left],
  ['left-target', 'target', Position.Left],
  ['right-source', 'source', Position.Right],
  ['right-target', 'target', Position.Right],
] as const;

export const VTAObjectJunctionNode: React.FC<NodeProps<VTAReactFlowNode>> = ({ data, selected }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const openNodeEditor = useVTAStore((state) => state.openNodeEditor);
  const isVariation = data.type === 'variation';
  const isOutcome = data.type === 'outcome';

  // カラーテーマの決定
  const colorClasses = isOutcome
    ? 'border-rose-500 bg-rose-950/80 text-rose-300 shadow-rose-900/40'
    : isVariation
      ? 'border-amber-400 bg-amber-950/80 text-amber-300 shadow-amber-900/40'
      : 'border-cyan-400 bg-slate-900 text-cyan-300 shadow-cyan-900/30';

  const isHighlighted = Boolean(data.isHoveredLinked);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nodeData: VTANodeData = {
      id: data.id,
      event_ids: data.event_ids,
      lane: data.lane,
      time: data.time,
      type: data.type,
      title: data.title,
      description: data.description,
      measure_type: data.measure_type,
      outcome_kind: data.outcome_kind,
      variation_factor: data.variation_factor,
      entity_role: data.entity_role,
      object_display_style: data.object_display_style,
      is_hidden: data.is_hidden,
      hidden_card_height: data.hidden_card_height,
      supplementary_note: data.supplementary_note || '',
      position: data.position,
      compact_position: data.compact_position,
    };
    openNodeEditor(nodeData);
  };

  return (
    <div
      title={`【受動客体】${data.title}（クリックで選択、ダブルクリックで編集）`}
      aria-label={`${data.title}：受動客体接続点`}
      style={{ width: OBJECT_JUNCTION_SIZE, height: OBJECT_JUNCTION_SIZE }}
      className="relative cursor-pointer select-none group"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onDoubleClick={handleDoubleClick}
    >
      {/* エッジ接続用隠しハンドル */}
      {ports.map(([id, type, position]) => (
        <Handle
          key={id}
          id={id}
          type={type}
          position={position}
          isConnectable={false}
          style={{
            left: '50%',
            top: '50%',
            right: 'auto',
            bottom: 'auto',
            width: 1,
            height: 1,
            transform: 'translate(-50%, -50%)',
            opacity: 0,
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* ドット本体（二重円デザイン） */}
      <div
        style={{ width: OBJECT_JUNCTION_RADIUS * 2, height: OBJECT_JUNCTION_RADIUS * 2 }}
        className={`
          absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2
          flex items-center justify-center transition-all duration-150 shadow-md
          ${colorClasses}
          ${selected ? 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-950 scale-110' : ''}
          ${isHighlighted ? 'ring-2 ring-cyan-300 ring-offset-1 ring-offset-slate-950 scale-125 animate-pulse' : ''}
          group-hover:scale-110
        `}
      >
        {/* 中心の核（コア） */}
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            isOutcome ? 'bg-rose-400' : isVariation ? 'bg-amber-300' : 'bg-cyan-300'
          }`}
        />
      </div>

      {/* ホバーツールチップ */}
      {showTooltip && (
        <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2.5 z-50 pointer-events-none min-w-[200px] max-w-[280px] rounded-lg border border-slate-700 bg-slate-950/95 p-2 shadow-2xl backdrop-blur animate-in fade-in zoom-in-95 duration-100 text-left">
          <div className="flex items-center justify-between gap-1 border-b border-slate-800 pb-1 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300 flex items-center gap-1">
              <span>●</span>
              <span>受動客体（受領・被作用）</span>
            </span>
            {data.time && <span className="text-[10px] text-slate-400">{data.time}</span>}
          </div>
          <p className="text-xs font-semibold text-slate-100 leading-snug">{data.title}</p>
          {data.description && (
            <p className="text-[11px] text-slate-400 mt-1 line-clamp-3 leading-relaxed">
              {data.description}
            </p>
          )}
          <p className="text-[10px] text-slate-500 mt-1.5">
            所属: {data.lane} ／ Wクリックで編集
          </p>
        </div>
      )}
    </div>
  );
};
