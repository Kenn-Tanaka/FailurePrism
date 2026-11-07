import type {
  VTAAnalysisData,
  VTAEntity,
  LaneMergeProposal,
  LaneSplitProposal,
  GranularityProposals,
} from '../../../types/vta';
import { SubjectPoset } from './subjectPoset';

/**
 * 現在の分析データ（analysis）および原本情報（originalEntities / subjectRanking）から、
 * ユーザーがワンクリックで適用可能な「レーン統合案（マクロ化）」と「レーン分割案（ミクロ化）」を自動検知します。
 */
export function detectGranularityProposals(analysis: VTAAnalysisData): GranularityProposals {
  const merges: LaneMergeProposal[] = [];
  const splits: LaneSplitProposal[] = [];

  if (!analysis) return { merges, splits };

  const currentEntities = analysis.entities ?? [];
  const currentEntityById = new Map(currentEntities.map((e) => [e.id, e]));
  const currentEntityNames = new Set(currentEntities.map((e) => e.name));

  const origEntities: VTAEntity[] = analysis.subjectRanking?.originalEntities ?? currentEntities;
  const origEntityById = new Map(origEntities.map((e) => [e.id, e]));

  // イベント数集計 (現在のエンティティ別)
  const eventCountByCurrentEntity = new Map<string, number>();
  for (const part of analysis.participations ?? []) {
    if (part.role === 'actor' || part.role === 'target' || part.role === 'affected') {
      eventCountByCurrentEntity.set(
        part.entityId,
        (eventCountByCurrentEntity.get(part.entityId) ?? 0) + 1
      );
    }
  }

  // イベント数集計 (原本エンティティ別)
  const eventCountByOrigEntity = new Map<string, number>();
  for (const part of analysis.participations ?? []) {
    if (part.mergedFrom?.length) {
      for (const m of part.mergedFrom) {
        eventCountByOrigEntity.set(
          m.entityId,
          (eventCountByOrigEntity.get(m.entityId) ?? 0) + 1
        );
      }
    } else {
      eventCountByOrigEntity.set(
        part.entityId,
        (eventCountByOrigEntity.get(part.entityId) ?? 0) + 1
      );
    }
  }

  // 表記ゆれ・エイリアス情報から機体・乗り物等の呼称候補（A機、B機など）を抽出
  const knownAliases = new Map<string, string>(); // e.g. "JA722A" -> "Ａ機", "JA13XJ" -> "Ｂ機"
  for (const corr of analysis.normalizationAudit?.corrections ?? []) {
    if (corr.kind === 'alias_unification' && corr.to) {
      knownAliases.set(corr.from, corr.to);
    }
  }

  // -------------------------------------------------------------------------
  // 1. 統合案（Merge Proposals）の検知
  // -------------------------------------------------------------------------
  const handledMergeEntityIds = new Set<string>();

  // A. 航空機・乗り物クルー（vehicle_crew）の統合案
  // 例: "機長Ａ", "副操縦員Ａ", "機上整備員Ａ" 等、名前に同じ英字識別子や乗り物接尾辞を持つクルー
  const crewPatterns = [
    { key: 'A', label: 'Ａ機', regex: /^[AＡ機長副操縦員整備士]/ },
    { key: 'B', label: 'Ｂ機', regex: /^[BＢ機長訓練乗員客室乗務員]/ },
  ];

  for (const pat of crewPatterns) {
    const matched = currentEntities.filter((e) => {
      if (handledMergeEntityIds.has(e.id)) return false;
      const normName = e.name.normalize('NFKC');
      const isPilotOrCrew = /機長|操縦|乗員|客室|乗務員|整備/.test(normName);
      const hasKey = normName.includes(pat.key) || normName.includes(pat.key.toLowerCase());
      return isPilotOrCrew && hasKey;
    });

    if (matched.length >= 2) {
      const sourceIds = matched.map((e) => e.id);
      sourceIds.forEach((id) => handledMergeEntityIds.add(id));
      const sourceNames = matched.map((e) => e.name);
      const totalEvents = sourceIds.reduce(
        (sum, id) => sum + (eventCountByCurrentEntity.get(id) ?? 0),
        0
      );
      // 推奨名称: 既存エイリアスがあればそれを優先（例: 'Ａ機' または 'A機'）
      const suggestedName = pat.label;

      merges.push({
        id: `merge_crew_${pat.key}`,
        type: 'merge',
        sourceEntityIds: sourceIds,
        sourceEntityNames: sourceNames,
        suggestedTargetName: suggestedName,
        suggestedKind: 'machine',
        totalEventsCount: totalEvents,
        reducedLanesCount: sourceIds.length - 1,
        reason: `${pat.key}機の運航・搭乗クルーです。機体レーンに統合して滑走路上の全体動線を整理できます。`,
        category: 'vehicle_crew',
      });
    }
  }

  // B. 共通の上位組織・親主体（common_parent）の統合案
  // SubjectPoset または parentEntityId / parentEntityIds が共通する主体群 (管制所配下の各管制席など)
  const poset = analysis.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(currentEntities);

  const byParent = new Map<string, VTAEntity[]>();
  for (const ent of currentEntities) {
    if (handledMergeEntityIds.has(ent.id)) continue;
    const parentIds = poset.getImmediateParents(ent.id);
    const effectiveParents = parentIds.length
      ? parentIds
      : (ent.parentEntityIds?.length ? ent.parentEntityIds : (ent.parentEntityId ? [ent.parentEntityId] : []));

    for (const pId of effectiveParents) {
      const list = byParent.get(pId) ?? [];
      list.push(ent);
      byParent.set(pId, list);
    }
  }

  for (const [parentId, children] of byParent.entries()) {
    if (children.length >= 2) {
      const parentEnt = origEntityById.get(parentId) || currentEntityById.get(parentId);
      const parentName = parentEnt?.name ?? parentId;
      const sourceIds = children.map((e) => e.id);
      sourceIds.forEach((id) => handledMergeEntityIds.add(id));
      const sourceNames = children.map((e) => e.name);
      const totalEvents = sourceIds.reduce(
        (sum, id) => sum + (eventCountByCurrentEntity.get(id) ?? 0),
        0
      );

      merges.push({
        id: `merge_parent_${parentId}`,
        type: 'merge',
        sourceEntityIds: sourceIds,
        sourceEntityNames: sourceNames,
        targetEntityId: parentEnt ? parentEnt.id : undefined,
        suggestedTargetName: parentName,
        suggestedKind: parentEnt?.kind ?? 'organization',
        totalEventsCount: totalEvents,
        reducedLanesCount: sourceIds.length - 1,
        reason: `共通の組織「${parentName}」に属する主体です。親組織レーンに集約して交差を低減できます。`,
        category: 'common_parent',
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. 分割案（Split Proposals）の検知
  // -------------------------------------------------------------------------
  // 既に統合されている元主体（ranks で retained === false かつ mergedInto があるもの）
  // または participations の mergedFrom に存在する元主体
  const mergedOriginByTarget = new Map<string, Set<string>>(); // targetEntityId -> Set of origEntityId

  // ranks から集計
  for (const r of analysis.subjectRanking?.ranks ?? []) {
    if (!r.retained && r.mergedInto) {
      const list = mergedOriginByTarget.get(r.mergedInto) ?? new Set<string>();
      list.add(r.entityId);
      mergedOriginByTarget.set(r.mergedInto, list);
    }
  }

  // participations の mergedFrom からも補完
  for (const p of analysis.participations ?? []) {
    if (p.mergedFrom?.length) {
      const list = mergedOriginByTarget.get(p.entityId) ?? new Set<string>();
      for (const m of p.mergedFrom) {
        if (m.entityId !== p.entityId) list.add(m.entityId);
      }
      mergedOriginByTarget.set(p.entityId, list);
    }
  }

  // 各統合先（ターゲット）ごとに分割候補を精査
  for (const [targetId, origIdSet] of mergedOriginByTarget.entries()) {
    const parentEnt = currentEntityById.get(targetId) || origEntityById.get(targetId);
    const parentName = parentEnt?.name ?? targetId;
    const origList = Array.from(origIdSet)
      .map((id) => origEntityById.get(id))
      .filter((e): e is VTAEntity => Boolean(e));

    if (origList.length === 0) continue;

    // A. 内部関係（CRM連携など）があるか検索
    // relations の sourceEntityOrigin / targetEntityOrigin を調査
    let internalRelationsCount = 0;
    const relatedOrigIds = new Set<string>();

    for (const rel of analysis.relations ?? []) {
      const srcOrig = rel.sourceEntityOrigin;
      const tgtOrig = rel.targetEntityOrigin;
      if (srcOrig && tgtOrig && srcOrig !== tgtOrig && origIdSet.has(srcOrig) && origIdSet.has(tgtOrig)) {
        internalRelationsCount++;
        relatedOrigIds.add(srcOrig);
        relatedOrigIds.add(tgtOrig);
      }
    }

    // 内部関係がある主要サブ主体を展開する分割案
    if (internalRelationsCount > 0 && relatedOrigIds.size >= 2) {
      const splitEntities = Array.from(relatedOrigIds)
        .map((id) => origEntityById.get(id))
        .filter((e): e is VTAEntity => Boolean(e));

      splits.push({
        id: `split_crm_${targetId}`,
        type: 'split',
        parentEntityId: targetId,
        parentEntityName: parentName,
        splitEntityIds: splitEntities.map((e) => e.id),
        splitEntityNames: splitEntities.map((e) => e.name),
        internalRelationsCount,
        reason: `内部の主体間に${internalRelationsCount}件の意思疎通・復唱・連携関係があります。CRM・判断ミスの詳細分析用に独立レーンを展開できます。`,
        category: 'crm_interaction',
      });
    } else {
      // 内部関係が少なくても、活動イベント数が多い（>= 3件）サブ主体があれば展開案を提示
      const activeOrigs = origList.filter((e) => (eventCountByOrigEntity.get(e.id) ?? 0) >= 3);
      if (activeOrigs.length > 0) {
        splits.push({
          id: `split_activity_${targetId}`,
          type: 'split',
          parentEntityId: targetId,
          parentEntityName: parentName,
          splitEntityIds: activeOrigs.map((e) => e.id),
          splitEntityNames: activeOrigs.map((e) => e.name),
          internalRelationsCount: 0,
          reason: `統合された主体の中に活動件数の多い主体（${activeOrigs.map((e) => `${e.name}: ${eventCountByOrigEntity.get(e.id)}件`).join('、')}）があります。独立レーンとして展開可能です。`,
          category: 'high_activity',
        });
      }
    }
  }

  // ソート: 削減レーン数または内部関係数が多い順
  merges.sort((a, b) => b.reducedLanesCount - a.reducedLanesCount || b.totalEventsCount - a.totalEventsCount);
  splits.sort((a, b) => b.internalRelationsCount - a.internalRelationsCount || b.splitEntityIds.length - a.splitEntityIds.length);

  return { merges, splits };
}
