import {isSubjectInferred} from '../../features/vta/utils/subjectInference';
import { GraphDiagnosticsPanel } from './GraphDiagnosticsPanel';
import { UnassignedEventsPanel } from './UnassignedEventsPanel';
import { eventSourceRefs } from '../../features/vta/utils/eventLedger';
import { LaneManagementPanel } from './LaneManagementPanel';
import { maintainPresentation, planCardSimplification } from '../../features/vta/utils/presentation';
import { restoreNormalizedPassage } from '../../services/llm/client';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import React, { useState } from 'react';
import type { VTAAnalysisData, VTASchema } from '../../types/vta';
import { projectAnalysis } from '../../features/vta/utils/eventAnalysis';
import { repairGeneratedLaneSequence } from '../../features/vta/utils/generatedLaneSequence';
import { consolidateSubjects, revertConsolidation, clampSubjectLimit } from '../../features/vta/utils/subjectRanking';

interface Props {
  schema: VTASchema;
  onChange: (schema: VTASchema) => void;
  onConfirm: () => void;
  onCancel: () => void;
  autoConnect?: boolean;
}

export const EventReviewPanel: React.FC<Props> = ({ schema, onChange, onConfirm, onCancel, autoConnect = false }) => {
  const analysis = schema.analysis!;
  const [newEntity, setNewEntity] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [limitDraft, setLimitDraft] = useState<number>(() => analysis.subjectRanking?.maxSubjects ?? useVTAStore.getState().subjectLimit);
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);
  React.useEffect(() => {
    if (analysis.subjectRanking?.maxSubjects) {
      setLimitDraft(analysis.subjectRanking.maxSubjects);
    }
  }, [analysis.subjectRanking?.maxSubjects]);

  const update = (next: VTAAnalysisData) => {
    const projected = projectAnalysis(next, schema);
    onChange(autoConnect ? repairGeneratedLaneSequence(projected).schema : projected);
  };
  const changeEvent = (id: string, field: 'title' | 'description' | 'time', value: string) => {
    const events = analysis.events.map((event) => event.id === id && event[field] !== value
      ? { ...event, [field]: value, origin: 'manual' as const, classification: 'unclassified' as const,
        classificationReason: undefined, classificationFactIds: undefined, classificationSourceRefs: undefined } : event);
    const byId = new Map(events.map((event) => [event.id, event]));
    const cards = field === 'time' ? analysis.cards.flatMap((card) => {
      if (!card.eventIds.includes(id) || card.eventIds.length < 2) return [card];
      const times = [...new Set(card.eventIds.map((eventId) => byId.get(eventId)?.time).filter(Boolean))];
      if (times.length < 2) return [card];
      return [{ ...card, eventIds: card.eventIds.filter((eventId) => eventId !== id) },
        { id: `card_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, laneEntityId: card.laneEntityId, eventIds: [id] }];
    }) : analysis.cards;
    update({ ...analysis, events, cards });
  };
  const toggleEntity = (eventId: string, entityId: string) => {
    const present = analysis.participations.some((part) => part.eventId === eventId && part.entityId === entityId);
    const participations = present
      ? analysis.participations.filter((part) => !(part.eventId === eventId && part.entityId === entityId))
      : [...analysis.participations, { eventId, entityId, role: 'affected' as const, factIds: [], origin: 'manual' as const }];
    const cards = analysis.cards.flatMap((card) => {
      const kept = card.eventIds.filter((id) => participations.some((part) => part.eventId === id && part.entityId === card.laneEntityId));
      return kept.length ? [{ ...card, eventIds: kept }] : [];
    });
    if (!present) cards.push({ id: `card_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, laneEntityId: entityId, eventIds: [eventId] });
    update({ ...analysis, participations, cards,
      unassignedEventIds: analysis.events.filter((item) => !cards.some((card) => card.eventIds.includes(item.id))).map((item) => item.id) });
  };
  const changeRole = (eventId: string, entityId: string, role: VTAAnalysisData['participations'][number]['role']) => {
    update({ ...analysis, participations: analysis.participations.map((part) => part.eventId === eventId && part.entityId === entityId
      ? { ...part, role, factIds: [], origin: 'manual',evidenceBasis:'user',reason:'利用者が役割を変更',generation:undefined } : part) });
  };
  const changeClassification = (eventId: string, classification: VTAAnalysisData['events'][number]['classification']) => {
    update({ ...analysis, events: analysis.events.map((event) => event.id === eventId
      ? { ...event, classification, classificationReason: undefined, classificationFactIds: undefined } : event) });
  };
  const splitCard = (cardId: string, eventId: string) => {
    const cards = analysis.cards.flatMap((card) => card.id === cardId
      ? [{ ...card, eventIds: card.eventIds.filter((id) => id !== eventId) },
        { id: `card_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, laneEntityId: card.laneEntityId, eventIds: [eventId] }]
      : [card]);
    update({ ...analysis, cards });
  };
  const addEntity = () => {
    const name = newEntity.trim();
    if (!name || analysis.entities.some((entity) => entity.name === name)) return;
    const id = `user_entity_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    onChange(projectAnalysis({ ...analysis, entities: [...analysis.entities, { id, name, kind: 'other' }] }, { ...schema, presentation: { lanes: { ...schema.presentation?.lanes, [id]: 'show' }, suppressedCards: { ...schema.presentation?.suppressedCards } } }));
    setNewEntity('');
  };
  const reapplySubjectLimit = () => {
    if (!analysis.subjectRanking || !autoConnect) return;
    const clamped = clampSubjectLimit(limitDraft);
    const manualParticipations = analysis.participations.filter((part) => part.origin === 'manual');
    if (manualParticipations.length > 0 && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const proceed = window.confirm('手動で変更した主体割当を保持したまま、抽出された主体の統合上限を再適用しますか？');
      if (!proceed) return;
    }
    setLimitDraft(clamped);
    useVTAStore.getState().setSubjectLimit(clamped);
    const reverted = revertConsolidation(analysis);
    const reconsolidated = consolidateSubjects(reverted, clamped);

    if (!manualParticipations.length) {
      update(reconsolidated);
      return;
    }

    const nextParts = [...reconsolidated.participations];
    const entityIds = new Set(reconsolidated.entities.map((e) => e.id));
    const othersEntity = reconsolidated.entities.find((e) => e.aggregate);

    for (const manual of manualParticipations) {
      let targetId: string | undefined;
      if (entityIds.has(manual.entityId)) {
        targetId = manual.entityId;
      } else {
        const rankEntry = reconsolidated.subjectRanking?.ranks.find((r) => r.entityId === manual.entityId);
        if (rankEntry?.mergedInto && entityIds.has(rankEntry.mergedInto)) {
          targetId = rankEntry.mergedInto;
        } else if (othersEntity) {
          targetId = othersEntity.id;
        }
      }

      if (targetId) {
        const existingIdx = nextParts.findIndex((p) => p.eventId === manual.eventId && p.entityId === targetId);
        if (existingIdx !== -1) {
          nextParts[existingIdx] = {
            ...nextParts[existingIdx],
            role: manual.role,
            origin: 'manual',
            evidenceBasis: manual.evidenceBasis ?? 'user',
            reason: manual.reason ?? '利用者が役割を変更',
          };
        } else {
          nextParts.push({
            ...manual,
            entityId: targetId,
            origin: 'manual',
            evidenceBasis: manual.evidenceBasis ?? 'user',
          });
        }
      }
    }

    update({
      ...reconsolidated,
      participations: nextParts,
    });
  };

  return (
    <section className="rounded-lg border border-cyan-700/70 bg-slate-950/80 p-3 space-y-3 text-xs" aria-label="イベントと主体の確認">
      <div className="font-semibold text-cyan-200">イベント・主体の確認と編集（イベント {analysis.events.length}件）</div>
      {!analysis.events.length && <p className="text-amber-300">イベントは抽出されませんでした。背景・除外・要確認の記述を確認し、必要な記述を再抽出してください。</p>}
      <p className="text-slate-400">出来事・時刻・関係主体を確認してから図へ反映してください。根拠が不明な割当は外せます。</p>
      <div className="flex gap-1.5">
        <input value={newEntity} onChange={(event) => setNewEntity(event.target.value)} placeholder="主体を追加" aria-label="主体を追加"
          className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-100" />
        <button type="button" onClick={addEntity} disabled={restoring} className="rounded border border-slate-600 px-2 text-slate-200">追加</button>
      </div>
      <GraphDiagnosticsPanel schema={schema} onChange={onChange}/>
      {analysis.subjectRanking && (
        <details className="rounded border border-slate-700 bg-slate-900/70 p-2 text-slate-200" open={analysis.subjectRanking.originalEntities.length > analysis.entities.length}>
          <summary className="cursor-pointer font-semibold text-cyan-200">
            主体の重要度（上限 {analysis.subjectRanking.maxSubjects}件／抽出 {analysis.subjectRanking.originalEntities.length}件・採用 {analysis.entities.length}件）
          </summary>
          <div className="mt-2 space-y-2">
            {analysis.subjectRanking.warning && (
              <p role="alert" className="rounded border border-amber-500/80 bg-amber-950/70 p-2 text-xs text-amber-200">
                {analysis.subjectRanking.warning}
              </p>
            )}
            {autoConnect ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-slate-300">
                  <span>主体の最大数</span>
                  <input
                    type="number"
                    min={2}
                    max={12}
                    aria-label="主体の最大数を変更"
                    value={limitDraft}
                    onChange={(e) => setLimitDraft(Number(e.target.value))}
                    disabled={restoring}
                    className="w-14 rounded border border-slate-600 bg-slate-950 px-1.5 py-0.5 text-center text-slate-100"
                  />
                  <span>個</span>
                </label>
                <button
                  type="button"
                  onClick={reapplySubjectLimit}
                  disabled={restoring}
                  className="rounded border border-cyan-600 bg-cyan-950/80 px-2 py-0.5 text-cyan-100 hover:bg-cyan-900"
                >
                  上限を再適用
                </button>
                <span className="text-[10px] text-slate-400">（LLM再通信なしで即座に再統合します）</span>
              </div>
            ) : (
              <p className="text-[11px] text-slate-400">
                ※ 図面へ反映済みの編集モードです。レーンやカード配置を保護するため、上限の再統合は抽出直後の確認時のみ実行できます。
              </p>
            )}
            <div className="max-h-48 overflow-y-auto space-y-1">
              {analysis.subjectRanking.ranks.map((entry) => {
                const origEntity = analysis.subjectRanking?.originalEntities.find((item) => item.id === entry.entityId);
                const entityName = origEntity?.name ?? analysis.entities.find((item) => item.id === entry.entityId)?.name ?? entry.entityId;
                const entityKind = origEntity?.kind ?? analysis.entities.find((item) => item.id === entry.entityId)?.kind ?? 'other';
                const mergedTarget = entry.mergedInto
                  ? (analysis.entities.find((item) => item.id === entry.mergedInto)?.name
                    ?? analysis.subjectRanking?.originalEntities.find((item) => item.id === entry.mergedInto)?.name
                    ?? entry.mergedInto)
                  : undefined;
                const focusRefs = origEntity?.focusSourceRefs?.map((r) => `${r.sourceId}/${r.paragraphId}`).join(', ');
                return (
                  <div key={entry.entityId} className="rounded border border-slate-800 bg-slate-950/70 px-2 py-1 text-[11px] space-y-0.5">
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="font-semibold text-slate-100">
                        #{entry.rank} {entityName}
                        <span className="ml-1 text-[10px] font-normal text-slate-400">({entityKind})</span>
                        {entry.priority === 'reporter' && (
                          <span className="ml-1.5 rounded bg-cyan-900/80 px-1 py-0.2 text-[10px] text-cyan-200">報告当事者・優先保持</span>
                        )}
                        {entry.priority === 'outcome-actor' && (
                          <span className="ml-1.5 rounded bg-amber-900/80 px-1 py-0.2 text-[10px] text-amber-200">帰結発生主体・優先保持</span>
                        )}
                      </span>
                      <span className={entry.retained ? 'text-emerald-300 font-semibold' : 'text-amber-300'}>
                        {entry.retained ? '個別レーン採用' : `統合 → ${mergedTarget ?? 'その他の関係者'}`}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 flex flex-wrap gap-x-2">
                      <span>総合: {entry.score.toFixed(2)}</span>
                      <span>行為A: {entry.breakdown.A.toFixed(2)}</span>
                      <span>帰結O: {entry.breakdown.O.toFixed(2)}</span>
                      <span>焦点F: {entry.breakdown.F.toFixed(2)}</span>
                      <span>結節C: {entry.breakdown.C.toFixed(2)}</span>
                      <span>時間T: {entry.breakdown.T.toFixed(2)}</span>
                      {focusRefs && <span>根拠: {focusRefs}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </details>
      )}
      <UnassignedEventsPanel schema={schema} onChange={updateSchema=>onChange(updateSchema)} disabled={restoring}/><LaneManagementPanel schema={schema} disabled={restoring}
        onVisibility={(id, mode) => onChange(maintainPresentation({ ...schema, presentation: { lanes: { ...schema.presentation?.lanes, [id]: mode }, suppressedCards: { ...schema.presentation?.suppressedCards } } }))}
        onAdd={(name) => {
          name = name.trim(); if (!name || analysis.entities.some((entity) => entity.name === name)) return false;
          const id = 'user_entity_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
          onChange(projectAnalysis({ ...analysis, entities: [...analysis.entities, { id, name, kind: 'other' }] }, { ...schema, presentation: { lanes: { ...schema.presentation?.lanes, [id]: 'show' }, suppressedCards: { ...schema.presentation?.suppressedCards } } }));
          return true;
        }}
        onSimplify={() => onChange({ ...schema, presentation: planCardSimplification(schema) })} />
      {Boolean(analysis.dispositions?.length) && <details className="text-slate-300">
        <summary className="cursor-pointer">背景・除外・要確認の記述（{analysis.dispositions?.length}件）</summary>
        <p className="text-xs">{analysis.generation?.schemeId==='fulltext-ledger'?'生成方式：全文正規化・TSV台帳方式':analysis.generation?.schemeId==='event-chain'?'生成方式：事象連鎖方式（選択した記述のみ再解析可能）':analysis.generation?'この生成方式の部分再抽出には対応していません。':'生成方式不明：部分再抽出には全文正規化・TSV台帳方式を使用します。'}</p>
        <div className="max-h-60 overflow-auto space-y-2">
          {analysis.dispositions?.map((item) => <div key={item.id} className="border border-slate-700 rounded p-2">
            <p>{item.kind === 'background' ? '背景' : item.kind === 'excluded' ? '除外' : '要確認'}：{item.reason}</p>
            <p className="whitespace-pre-wrap">{item.text ?? item.quote}</p>
            <details><summary className="cursor-pointer">対応する原文</summary>{(item.sourceRefs ?? [item]).map((ref) => <p key={ref.sourceId + '/' + ref.paragraphId} className="whitespace-pre-wrap">{ref.sourceId}/{ref.paragraphId}：{analysis.sources.find((source) => source.id === ref.sourceId)?.paragraphs.find((part) => part.id === ref.paragraphId)?.text}</p>)}</details>
            <button type="button" data-vta-focus-id={`restore-passage-${item.id}`} disabled={restoring||!!analysis.generation&&!['fulltext-ledger','event-chain'].includes(analysis.generation.schemeId)} className="border border-slate-600 rounded px-2 py-1" onClick={async () => {
              setRestoring(true); setRestoreError('');
              const store = useVTAStore.getState();
              const controller = store.createAbortController(); abortRef.current = controller;
              controller.signal.addEventListener('abort', () => setRestoring(false), { once: true });
              const projectId = store.currentProjectId;
              try {
                const next = await restoreNormalizedPassage(store.llmConfig, schema, item.id, controller.signal);
                if (!controller.signal.aborted && projectId === useVTAStore.getState().currentProjectId) onChange(autoConnect ? repairGeneratedLaneSequence(next).schema : next);
              } catch (error) {
                const isCancelled = controller.signal.aborted || (error instanceof Error && (error.name === 'UserCancelledError' || error.message === 'USER_CANCELLED'));
                if (!isCancelled) setRestoreError(error instanceof Error ? error.message : String(error));
              } finally {
                setRestoring(false);
                useVTAStore.getState().resetGenerationProgress();
              }
            }}>この記述からイベントを再抽出</button>
          </div>)}
        </div>
      </details>}
      {restoring && <p role="status">選択した記述を再解析しています…</p>}
      {restoreError && <p role="alert" className="text-amber-300">{restoreError}</p>}
      <fieldset disabled={restoring} className="max-h-80 overflow-y-auto space-y-3">
        {analysis.events.map((event) => (
          <div key={event.id} className="space-y-1.5 rounded border border-slate-700 bg-slate-900/80 p-2">
            <div className="text-[10px] text-slate-400">{event.id} · 原文参照: {eventSourceRefs(analysis, event).map((ref) => ref.paragraphId).join('、') || 'なし（手動入力）'}</div>
            <input value={event.title} onChange={(change) => changeEvent(event.id, 'title', change.target.value)} aria-label={`${event.id} の見出し`}
              className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-slate-100" />
            <textarea value={event.description} onChange={(change) => changeEvent(event.id, 'description', change.target.value)} aria-label={`${event.id} の内容`}
              rows={2} className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-slate-100" />
            <input value={event.time} onChange={(change) => changeEvent(event.id, 'time', change.target.value)} placeholder="発生時刻が不明なら空欄"
              aria-label={`${event.id} の時刻`} className="w-full rounded border border-slate-700 bg-slate-950 p-1.5 text-slate-100" />
            {!autoConnect && <select value={event.classification} onChange={(change) => changeClassification(event.id, change.target.value as VTAAnalysisData['events'][number]['classification'])}
              aria-label={`${event.id} の変動判定`} className="rounded border border-slate-700 bg-slate-950 p-1.5 text-slate-200">
              <option value="unclassified">未判定</option><option value="undetermined">判定保留</option>
              <option value="normal">通常作業</option><option value="variation">変動要因</option>
            </select>}
            {event.classificationReason && <p className="text-[10px] text-slate-400">判定理由: {event.classificationReason}</p>}
            <div className="flex flex-wrap gap-2" aria-label={`${event.id} の関係主体`}>
              {analysis.entities.map((entity) => {
                const participation = analysis.participations.find((part) => part.eventId === event.id && part.entityId === entity.id);
                return <span key={entity.id} className="flex items-center gap-1 text-slate-300">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(participation)} onChange={() => toggleEntity(event.id, entity.id)} />{entity.name}{participation&&isSubjectInferred(participation)&&<span className="text-amber-300 text-xs">（主体は推定）</span>}</label>
                  {participation && <select aria-label={`${event.id} / ${entity.name} の役割`} value={participation.role}
                    onChange={(change) => changeRole(event.id, entity.id, change.target.value as VTAAnalysisData['participations'][number]['role'])}
                    className="rounded border border-slate-700 bg-slate-950 p-1 text-slate-200">
                    <option value="actor">発生主体</option><option value="target">直接の対象</option><option value="affected">影響先</option>
                    <option value="intended_recipient">通知先</option><option value="confirmed_recipient">確認された受信先</option>
                  </select>}
                </span>;
              })}
            </div>
            {analysis.cards.filter((card) => card.eventIds.includes(event.id) && card.eventIds.length > 1).map((card) => (
              <button key={card.id} type="button" onClick={() => splitCard(card.id, event.id)}
                className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300">
                {analysis.entities.find((entity) => entity.id === card.laneEntityId)?.name} の共有カードから分割
              </button>
            ))}
            {!analysis.cards.some((card) => card.eventIds.includes(event.id)) && <p className="text-amber-300">主体未割当：図上のカードは作りません。イベントは記録に残ります。</p>}
            <details className="text-[10px] text-slate-400">
              <summary className="cursor-pointer">原文の根拠を表示</summary>
              <p>{event.recordKind === 'claim' ? '証言・主張' : event.recordKind === 'assessment' ? '評価・推定' : '記録'}：参照番号は内容の正しさを保証するものではありません。原文と照合してください。</p>
              {eventSourceRefs(analysis, event).map((ref) => <p key={ref.sourceId + '/' + ref.paragraphId} className="whitespace-pre-wrap">{ref.sourceId}/{ref.paragraphId}：{analysis.sources.find((source) => source.id === ref.sourceId)?.paragraphs.find((part) => part.id === ref.paragraphId)?.text}</p>)}

            </details>
          </div>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <button type="button" onClick={() => { abortRef.current?.abort(); onCancel(); }} className="rounded border border-slate-600 px-3 py-1.5 text-slate-300">破棄</button>
        <button type="button" data-vta-focus-id="review-confirm" onClick={onConfirm} disabled={restoring} className="flex-1 rounded bg-cyan-600 px-3 py-1.5 font-semibold text-white">確認してVTA図に反映</button>
      </div>
    </section>
  );
};
