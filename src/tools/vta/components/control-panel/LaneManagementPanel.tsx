import React, { useState } from 'react';
import type { VTASchema, LaneMergeProposal, LaneSplitProposal } from '../../types/vta';
import { planCardSimplification, visibleSchema } from '../../features/vta/utils/presentation';
import { detectGranularityProposals } from '../../features/vta/utils/subjectGranularityProposals';

interface Props {
  schema: VTASchema;
  disabled?: boolean;
  onVisibility: (entityId: string, mode: 'auto' | 'show' | 'hide') => void;
  onAdd: (name: string) => boolean;
  onMove?: (name: string, direction: -1 | 1) => void;
  onSimplify: () => void;
  onApplyMergeProposal?: (proposal: LaneMergeProposal, customTargetName?: string) => void;
  onApplySplitProposal?: (proposal: LaneSplitProposal) => void;
}

export const LaneManagementPanel: React.FC<Props> = ({
  schema,
  disabled,
  onVisibility,
  onAdd,
  onMove,
  onSimplify,
  onApplyMergeProposal,
  onApplySplitProposal,
}) => {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const [showProposals, setShowProposals] = useState(true);
  const [customTargetNames, setCustomTargetNames] = useState<Record<string, string>>({});

  const visible = visibleSchema(schema);
  const analysis = schema.analysis;
  if (!analysis) return null;

  const drawnIds = new Set(visible.nodes.map((node) => node.id));
  const unseenEvents = analysis.events.filter(
    (event) =>
      analysis.cards.some((card) => card.eventIds.includes(event.id)) &&
      !analysis.cards.some((card) => drawnIds.has(card.id) && card.eventIds.includes(event.id))
  );
  const candidate = preview ? planCardSimplification(schema) : undefined;

  // 粒度提案（統合案・分割案）の検知
  const proposals = detectGranularityProposals(analysis);
  const hasProposals = proposals.merges.length > 0 || proposals.splits.length > 0;

  return (
    <section className="space-y-2 text-xs text-slate-200" aria-label="レーン管理">
      {/* 粒度提案セクション */}
      {hasProposals && (
        <div className="rounded border border-cyan-800 bg-slate-900/90 p-2 space-y-2 shadow-sm">
          <button
            type="button"
            onClick={() => setShowProposals(!showProposals)}
            className="flex items-center justify-between w-full text-left text-cyan-300 font-semibold focus:outline-none"
            aria-expanded={showProposals}
          >
            <span className="flex items-center gap-1.5">
              <span>💡</span>
              <span>レーン粒度の提案</span>
            </span>
            <span className="text-[11px] text-slate-400 font-normal">
              統合 {proposals.merges.length}件 ／ 分割 {proposals.splits.length}件 {showProposals ? '▲' : '▼'}
            </span>
          </button>

          {showProposals && (
            <div className="space-y-2 pt-1 border-t border-cyan-950/80">
              {/* 統合案リスト */}
              {proposals.merges.map((proposal) => {
                const targetName = customTargetNames[proposal.id] ?? proposal.suggestedTargetName;
                return (
                  <div key={proposal.id} className="rounded border border-slate-700 bg-slate-950/80 p-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-semibold text-amber-200 break-words flex-1">
                        【統合案】{proposal.sourceEntityNames.join('・')}
                      </span>
                      <span className="rounded bg-amber-950 border border-amber-800/80 text-[10px] text-amber-300 px-1 py-0.5 whitespace-nowrap">
                        -{proposal.reducedLanesCount}レーン
                      </span>
                    </div>

                    <p className="text-[11px] text-slate-400 leading-relaxed">{proposal.reason}</p>

                    <div className="flex items-center gap-1.5 pt-1">
                      <label className="text-[11px] text-slate-300 whitespace-nowrap">統合先名:</label>
                      <input
                        type="text"
                        value={targetName}
                        disabled={disabled || !onApplyMergeProposal}
                        onChange={(e) =>
                          setCustomTargetNames({ ...customTargetNames, [proposal.id]: e.target.value })
                        }
                        placeholder={proposal.suggestedTargetName}
                        className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-cyan-200"
                      />
                      <button
                        type="button"
                        disabled={disabled || !onApplyMergeProposal || !targetName.trim()}
                        onClick={() => onApplyMergeProposal?.(proposal, targetName)}
                        className="rounded border border-cyan-700 bg-cyan-950/90 hover:bg-cyan-900 text-cyan-200 px-2 py-0.5 font-medium disabled:opacity-40 whitespace-nowrap"
                      >
                        統合を適用
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* 分割案リスト */}
              {proposals.splits.map((proposal) => (
                <div key={proposal.id} className="rounded border border-slate-700 bg-slate-950/80 p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-semibold text-emerald-300 break-words flex-1">
                      【分割案】{proposal.parentEntityName} → {proposal.splitEntityNames.join('・')}
                    </span>
                    {proposal.internalRelationsCount > 0 && (
                      <span className="rounded bg-emerald-950 border border-emerald-800/80 text-[10px] text-emerald-300 px-1 py-0.5 whitespace-nowrap">
                        CRM関係 {proposal.internalRelationsCount}件
                      </span>
                    )}
                  </div>

                  <p className="text-[11px] text-slate-400 leading-relaxed">{proposal.reason}</p>

                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      disabled={disabled || !onApplySplitProposal}
                      onClick={() => onApplySplitProposal?.(proposal)}
                      className="rounded border border-emerald-700 bg-emerald-950/90 hover:bg-emerald-900 text-emerald-200 px-2.5 py-0.5 font-medium disabled:opacity-40"
                    >
                      独立レーンとして展開
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="text-slate-400">表示の整理です。元のイベント・主体・分析対象は保持します。「表示」で除外カードも戻ります。</p>

      {/* レーン一覧 */}
      <div className="max-h-64 overflow-y-auto space-y-2">
        {schema.lanes.map((lane, index) => {
          const entity = analysis.entities.find((item) => item.name === lane);
          if (!entity) return null;
          const cards = analysis.cards.filter((card) => card.laneEntityId === entity.id);
          const displayed = cards.filter((card) => drawnIds.has(card.id)).length;
          const mergedOriginNames = (analysis.subjectRanking?.ranks ?? [])
            .filter((entry) => !entry.retained && entry.mergedInto === entity.id)
            .map(
              (entry) =>
                analysis.subjectRanking?.originalEntities.find((orig) => orig.id === entry.entityId)?.name ??
                entry.entityId
            );
          return (
            <div key={entity.id} className="rounded border border-slate-700 p-2 space-y-1">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 break-words">
                  {lane}（表示 {displayed} / 割当 {cards.length}）
                </span>
                <select
                  aria-label={`${lane}の表示`}
                  disabled={disabled}
                  value={schema.presentation?.lanes[entity.id] ?? 'auto'}
                  onChange={(event) => onVisibility(entity.id, event.target.value as 'auto' | 'show' | 'hide')}
                  className="rounded border border-slate-600 bg-slate-950 p-1"
                >
                  <option value="auto">自動</option>
                  <option value="show">表示</option>
                  <option value="hide">非表示</option>
                </select>
                {onMove && (
                  <>
                    <button
                      type="button"
                      disabled={disabled || index === 0}
                      onClick={() => onMove(lane, -1)}
                      aria-label={`${lane}を左へ`}
                      className="border border-slate-600 rounded p-1 disabled:opacity-30"
                    >
                      左へ
                    </button>
                    <button
                      type="button"
                      disabled={disabled || index === schema.lanes.length - 1}
                      onClick={() => onMove(lane, 1)}
                      aria-label={`${lane}を右へ`}
                      className="border border-slate-600 rounded p-1 disabled:opacity-30"
                    >
                      右へ
                    </button>
                  </>
                )}
              </div>
              {mergedOriginNames.length > 0 && (
                <p className="text-[11px] text-cyan-300">統合元：{mergedOriginNames.join('、')}</p>
              )}
              {!visible.lanes.includes(lane) && (
                <p className="text-amber-200">
                  {schema.presentation?.lanes[entity.id] === 'hide'
                    ? 'ユーザー指定で非表示'
                    : '表示カードがないため自動非表示'}
                </p>
              )}
              {cards.some((card) => !drawnIds.has(card.id)) && (
                <details>
                  <summary className="cursor-pointer text-cyan-300">非表示カードの内容・理由</summary>
                  {cards
                    .filter((card) => !drawnIds.has(card.id))
                    .map((card) => (
                      <div key={card.id} className="mt-1 border-t border-slate-700 pt-1">
                        {card.eventIds.map((id) => {
                          const event = analysis.events.find((item) => item.id === id);
                          return (
                            <p key={id}>
                              {event?.time} {event?.title}：{event?.description}
                            </p>
                          );
                        })}
                        <p className="text-slate-400">
                          {schema.presentation?.suppressedCards[card.id] ?? 'レーンが非表示です。'}
                        </p>
                      </div>
                    ))}
                </details>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-slate-400">
        図に表示されない割当済みイベント: {unseenEvents.length}件 ／ 非表示の線: {schema.edges.length - visible.edges.length}本
      </p>

      <div className="flex gap-1">
        <input
          aria-label="追加レーン名"
          placeholder="レーン名"
          disabled={disabled}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-950 p-1"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (onAdd(name)) {
              setName('');
              setError('');
            } else setError('空欄または同名のレーンは追加できません。');
          }}
          className="rounded border border-slate-600 px-2"
        >
          追加
        </button>
      </div>
      {error && <p role="alert" className="text-amber-200">{error}</p>}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setPreview(!preview)}
        className="rounded border border-slate-600 px-2 py-1"
      >
        カード整理の候補を確認
      </button>
      {candidate && (
        <div className="rounded border border-cyan-800 p-2 space-y-1">
          <p>整理後の表示除外: {Object.keys(candidate.suppressedCards).length}枚</p>
          <ul>
            {Object.entries(candidate.suppressedCards).map(([id, reason]) => (
              <li key={id}>
                {schema.nodes.find((node) => node.id === id)?.lane}：{reason}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onSimplify();
              setPreview(false);
            }}
            className="rounded bg-cyan-700 px-2 py-1"
          >
            整理を適用
          </button>
        </div>
      )}
    </section>
  );
};
