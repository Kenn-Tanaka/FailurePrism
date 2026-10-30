import React, { useState } from 'react';
import type { VTASchema } from '../../types/vta';
import { planCardSimplification, visibleSchema } from '../../features/vta/utils/presentation';

interface Props {
  schema: VTASchema;
  disabled?: boolean;
  onVisibility: (entityId: string, mode: 'auto' | 'show' | 'hide') => void;
  onAdd: (name: string) => boolean;
  onMove?: (name: string, direction: -1 | 1) => void;
  onSimplify: () => void;
}

export const LaneManagementPanel: React.FC<Props> = ({ schema, disabled, onVisibility, onAdd, onMove, onSimplify }) => {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const visible = visibleSchema(schema);
  const analysis = schema.analysis;
  if (!analysis) return null;
  const drawnIds = new Set(visible.nodes.map((node) => node.id));
  const unseenEvents = analysis.events.filter((event) => analysis.cards.some((card) => card.eventIds.includes(event.id))
    && !analysis.cards.some((card) => drawnIds.has(card.id) && card.eventIds.includes(event.id)));
  const candidate = preview ? planCardSimplification(schema) : undefined;
  return <section className="space-y-2 text-xs text-slate-200" aria-label="レーン管理">
    <p className="text-slate-400">表示の整理です。元のイベント・主体・分析対象は保持します。「表示」で除外カードも戻ります。</p>
    <div className="max-h-64 overflow-y-auto space-y-2">
      {schema.lanes.map((lane, index) => {
        const entity = analysis.entities.find((item) => item.name === lane);
        if (!entity) return null;
        const cards = analysis.cards.filter((card) => card.laneEntityId === entity.id);
        const displayed = cards.filter((card) => drawnIds.has(card.id)).length;
        const mergedOriginNames = (analysis.subjectRanking?.ranks ?? [])
          .filter((entry) => !entry.retained && entry.mergedInto === entity.id)
          .map((entry) => analysis.subjectRanking?.originalEntities.find((orig) => orig.id === entry.entityId)?.name ?? entry.entityId);
        return <div key={entity.id} className="rounded border border-slate-700 p-2 space-y-1">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 break-words">{lane}（表示 {displayed} / 割当 {cards.length}）</span>
            <select aria-label={`${lane}の表示`} disabled={disabled} value={schema.presentation?.lanes[entity.id] ?? 'auto'}
              onChange={(event) => onVisibility(entity.id, event.target.value as 'auto' | 'show' | 'hide')}
              className="rounded border border-slate-600 bg-slate-950 p-1">
              <option value="auto">自動</option><option value="show">表示</option><option value="hide">非表示</option>
            </select>
            {onMove && <>
              <button type="button" disabled={disabled || index === 0} onClick={() => onMove(lane, -1)} aria-label={`${lane}を左へ`} className="border border-slate-600 rounded p-1 disabled:opacity-30">左へ</button>
              <button type="button" disabled={disabled || index === schema.lanes.length - 1} onClick={() => onMove(lane, 1)} aria-label={`${lane}を右へ`} className="border border-slate-600 rounded p-1 disabled:opacity-30">右へ</button>
            </>}
          </div>
          {mergedOriginNames.length > 0 && (
            <p className="text-[11px] text-cyan-300">統合元：{mergedOriginNames.join('、')}</p>
          )}
          {!visible.lanes.includes(lane) && <p className="text-amber-200">{schema.presentation?.lanes[entity.id] === 'hide' ? 'ユーザー指定で非表示' : '表示カードがないため自動非表示'}</p>}
          {cards.some((card) => !drawnIds.has(card.id)) && <details><summary className="cursor-pointer text-cyan-300">非表示カードの内容・理由</summary>
            {cards.filter((card) => !drawnIds.has(card.id)).map((card) => <div key={card.id} className="mt-1 border-t border-slate-700 pt-1">
              {card.eventIds.map((id) => { const event = analysis.events.find((item) => item.id === id); return <p key={id}>{event?.time} {event?.title}：{event?.description}</p>; })}
              <p className="text-slate-400">{schema.presentation?.suppressedCards[card.id] ?? 'レーンが非表示です。'}</p>
            </div>)}
          </details>}
        </div>;
      })}
    </div>
    <p className="text-slate-400">図に表示されない割当済みイベント: {unseenEvents.length}件 ／ 非表示の線: {schema.edges.length - visible.edges.length}本</p>
    <div className="flex gap-1">
      <input aria-label="追加レーン名" placeholder="レーン名" disabled={disabled} value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-950 p-1" />
      <button type="button" disabled={disabled} onClick={() => { if (onAdd(name)) { setName(''); setError(''); } else setError('空欄または同名のレーンは追加できません。'); }} className="rounded border border-slate-600 px-2">追加</button>
    </div>
    {error && <p role="alert" className="text-amber-200">{error}</p>}
    <button type="button" disabled={disabled} onClick={() => setPreview(!preview)} className="rounded border border-slate-600 px-2 py-1">カード整理の候補を確認</button>
    {candidate && <div className="rounded border border-cyan-800 p-2 space-y-1">
      <p>整理後の表示除外: {Object.keys(candidate.suppressedCards).length}枚</p>
      <ul>{Object.entries(candidate.suppressedCards).map(([id, reason]) => <li key={id}>{schema.nodes.find((node) => node.id === id)?.lane}：{reason}</li>)}</ul>
      <button type="button" disabled={disabled} onClick={() => { onSimplify(); setPreview(false); }} className="rounded bg-cyan-700 px-2 py-1">整理を適用</button>
    </div>}
  </section>;
};
