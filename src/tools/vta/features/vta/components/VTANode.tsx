import React, { useState, useEffect, useLayoutEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { compactNodeHeight, compactTitleLines } from '../utils/layout';
import { Clock, ShieldCheck, ChevronDown, ChevronUp, AlertTriangle, AlertOctagon, CheckCircle2, Activity, Edit2, Trash2, EyeOff } from 'lucide-react';
import { VTAReactFlowNode, VTANodeData } from '../../../types/vta';
import { useVTAStore } from '../store/vtaStore';
import { CROSS_LANE_SOURCE_HANDLE_Y, CROSS_LANE_TARGET_HANDLE_Y } from '../utils/edgeHandles';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export const VTANode: React.FC<NodeProps<VTAReactFlowNode>> = ({
  data,
  selected,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const compact = useVTAStore((state) => state.compactView);
  const updateNodeInternals = useUpdateNodeInternals();
  useIsomorphicLayoutEffect(() => {
    updateNodeInternals(data.id);
  }, [data.id, data.title, data.description, compact, isExpanded, updateNodeInternals]);
  const toggleNodeElimination = useVTAStore((state) => state.toggleNodeElimination);
  const setNodeHidden = useVTAStore((state) => state.setNodeHidden);
  const deleteNode = useVTAStore((state) => state.deleteNode);
  const openNodeEditor = useVTAStore((state) => state.openNodeEditor);

  const isVariation = data.type === 'variation';
  const isOutcome = data.type === 'outcome';
  const outcomeKind = data.outcome_kind ?? 'loss';
  const variationFactor = data.variation_factor;
  const isResilient = isVariation && variationFactor?.polarity === 'resilient';
  const isElimination = data.measure_type === 'elimination';

  const handleEdit = (e: React.MouseEvent) => {
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
      is_hidden: data.is_hidden,
      hidden_card_height: data.hidden_card_height,
      supplementary_note: data.supplementary_note || '',
      position: data.position,
      compact_position: data.compact_position,
    };
    openNodeEditor(nodeData);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`カード「${data.title}」を削除しますか？\n（関連する矢印の接続も解除されます）`)) {
      deleteNode(data.id);
    }
  };

  const cardBorderClass = isOutcome
    ? outcomeKind === 'loss'
      ? 'bg-slate-900/95 border-2 border-rose-600 text-rose-50 shadow-lg shadow-rose-950/40'
      : outcomeKind === 'near_miss'
        ? 'bg-slate-900/95 border-2 border-amber-500 text-amber-50 shadow-lg shadow-amber-950/30'
        : 'bg-slate-900/95 border-2 border-emerald-500 text-emerald-50 shadow-lg shadow-emerald-950/30'
    : isVariation
      ? isResilient
        ? 'bg-slate-900/95 border-2 border-teal-400 text-slate-100 shadow-lg shadow-teal-950/30'
        : 'bg-slate-900/95 border-2 border-amber-400 text-slate-100 shadow-lg shadow-amber-950/30'
      : 'bg-slate-900/90 border border-slate-700 text-slate-200 shadow-md';

  return (
    <div
      style={compact ? { height: compactNodeHeight(data.title) } : undefined}
      className={`
        relative w-[260px] rounded-xl flex flex-col transition-colors duration-200 select-none group
        ${cardBorderClass}
        ${selected ? 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-950' : ''}
        ${data.isHoveredLinked ? 'ring-2 ring-cyan-300 ring-offset-2 ring-offset-slate-950 animate-pulse' : ''}
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
        style={{ top: `${CROSS_LANE_TARGET_HANDLE_Y * 100}%` }}
        title="左受信端子 (他レーンからの情報を受信)"
        className="!w-2.5 !h-2.5 !bg-cyan-500 !border-2 !border-slate-900 hover:!bg-cyan-300 !-left-1.5 cursor-crosshair"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left-source"
        style={{ top: `${CROSS_LANE_SOURCE_HANDLE_Y * 100}%` }}
        title="左送信端子 (左レーンへ情報を送信)"
        className="!w-2.5 !h-2.5 !bg-cyan-500 !border-2 !border-slate-900 hover:!bg-cyan-300 !-left-1.5 cursor-crosshair"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right-target"
        style={{ top: `${CROSS_LANE_TARGET_HANDLE_Y * 100}%` }}
        title="右受信端子 (他レーンからの情報を受信)"
        className="!w-2.5 !h-2.5 !bg-cyan-500 !border-2 !border-slate-900 hover:!bg-cyan-300 !-right-1.5 cursor-crosshair"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right-source"
        style={{ top: `${CROSS_LANE_SOURCE_HANDLE_Y * 100}%` }}
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
          isOutcome
            ? outcomeKind === 'loss'
              ? 'bg-rose-950/70 border-rose-800/70 text-rose-300'
              : outcomeKind === 'near_miss'
                ? 'bg-amber-950/70 border-amber-800/70 text-amber-300'
                : 'bg-emerald-950/70 border-emerald-800/70 text-emerald-300'
            : isVariation
              ? isResilient
                ? 'bg-teal-950/60 border-teal-800/60 text-teal-300'
                : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
              : 'bg-slate-800/60 border-slate-700/60 text-slate-400'
        }`}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium truncate">
          {isOutcome ? (
            outcomeKind === 'loss' ? (
              <AlertOctagon className="w-3.5 h-3.5 text-rose-400 shrink-0" />
            ) : outcomeKind === 'near_miss' ? (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            )
          ) : isVariation ? (
            isResilient ? (
              <ShieldCheck className="w-3.5 h-3.5 text-teal-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            )
          ) : (
            <Activity className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}
          <span className="font-semibold">
            {isOutcome
              ? outcomeKind === 'loss'
                ? '帰結: 損失発生'
                : outcomeKind === 'near_miss'
                  ? '帰結: 直前停止'
                  : '帰結: 正常復帰'
              : isVariation
                ? isResilient
                  ? '変動: レジリエンス'
                  : '変動要因'
                : data.type === 'normal'
                  ? '通常作業'
                  : data.type === 'undetermined'
                    ? '判定保留'
                    : '未判定'}
          </span>
          {data.is_assumption && (
            <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-600/70 text-amber-200 font-bold shrink-0 shadow-sm" title="ユーザー設定の仮定に基づくカード">
              仮定
            </span>
          )}
          {data.entity_role === 'object' && (
            <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/80 border border-cyan-600/70 text-cyan-300 font-normal shrink-0" title="受動客体（被作用・受領）">
              客体
            </span>
          )}
          {data.entity_role === 'subject' && (
            <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded bg-slate-800/90 border border-slate-700 text-slate-300 font-normal shrink-0" title="作用主体（能動行動）">
              主体
            </span>
          )}
          {isVariation && variationFactor && (
            <span
              className="ml-1 text-[10px] px-1.5 py-0.2 rounded bg-slate-800/90 border border-slate-700 text-slate-300 font-normal shrink-0"
              title={`変動分類: ${variationFactor.category}${variationFactor.cognitiveLevel ? ` (${variationFactor.cognitiveLevel})` : ''} / 極性: ${variationFactor.polarity}`}
            >
              {{
                response: `先行応答${variationFactor.cognitiveLevel ? `(${variationFactor.cognitiveLevel})` : ''}`,
                internal: '内部要因',
                departure: '人為逸脱',
                external: '外部要因',
              }[variationFactor.category]}
            </span>
          )}
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
      <div className="px-3 py-1.5 bg-slate-950/40 border-t border-slate-800/60 flex items-center justify-between text-xs">
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
      {!compact && (
        <div className="px-3 pb-2 bg-slate-950/40 rounded-b-lg">
          <button type="button" onClick={(event) => {
            event.stopPropagation();
            setNodeHidden(data.id, true);
          }} title="カードを接続点に置き換えます。説明欄から再表示できます"
            className="w-full flex items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-800/70 px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-600 hover:text-cyan-300 cursor-pointer">
            <EyeOff className="w-3 h-3" />
            <span>図上では接続点として表示</span>
          </button>
        </div>
      )}
    </div>
  );
};
