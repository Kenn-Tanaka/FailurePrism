import type {
  GranularityWeights,
  LLMConfig,
  OthersConsolidationMode,
  VTAAnalysisScope,
  VTAFineGrainedBase,
  VTASchema,
  VTAUserAssumption,
} from '../../types/vta';
import { debugRecorder } from '../debugRecorder';
import { callLLMGateway, proposeVTAConnections } from '../llm/client';
import { proposeChainRepair } from './chainRepairService';
import { validateSelectedConnectionProposals, proposalRelation, type ConnectionProposal } from '../../features/vta/utils/connectionProposals';
import { projectAnalysis, recordGraphProjectionDebug, validateSavedAnalysis } from '../../features/vta/utils/eventAnalysis';
import {
  findIsolatedOutcomeCollectiveMatches,
  findUnreferencedSubstantiveParagraphs,
} from '../../features/vta/utils/eventLedger';
import { applyChainDelta, selectChainDependencies } from '../../features/vta/utils/chainRepair';
import { repairGeneratedLaneSequence } from '../../features/vta/utils/generatedLaneSequence';
import { graphDiagnostics } from '../../features/vta/utils/graphDiagnostics';
import { visibleSchema } from '../../features/vta/utils/presentation';
import { consolidatePeripheralSubjectsToOthers } from '../../features/vta/utils/subjectRanking';
import { SubjectPoset } from '../../features/vta/utils/subjectPoset';
import { isPeripheralAggregateId } from '../../features/vta/utils/subjectCompositeForest';
import {
  captureFineGrainedBase,
  optimizeLaneConsolidation,
} from './laneConsolidationOptimizer';

export interface AutoConnectionProgress {
  stage: 'inter_lane' | 'chain_repair' | 'lane_consolidation' | 'geometry_sync';
  message: string;
}

export interface AutoConnectionOptions {
  /** ADR-0072: 最終フェーズの目標最大主体数 K_post */
  finalMaxSubjects?: number;
  /** ADR-0072: 最終フェーズの subject_others 集約方式 */
  othersConsolidationMode?: OthersConsolidationMode;
  /** 固定維持主体ID */
  pinnedEntityIds?: string[];
  /** ADR-0079: 最細粒度VTA完成後にLLM候補一括提案＋山登り法でレーン統合を実行するか */
  useHillClimbingConsolidation?: boolean;
  refinementWeights?: GranularityWeights;
  oneTimeDirective?: string;
  assumptions?: VTAUserAssumption[];
  scope?: VTAAnalysisScope;
}

export interface AutoConnectionResult {
  schema: VTASchema;
  /** ADR-0079: レーン統合前の完成版・最細粒度VTAスキーマ */
  fineCompletedSchema?: VTASchema;
  fineLanesCount?: number;
  consolidatedLanesCount?: number;
  addedInterLaneConnections: number;
  addedChainConnections: number;
  addedEvents: number;
  addedSubjects: number;
  foldedOthersSubjects?: string[];
  warnings: string[];
}

export async function autoConnectVTA(
  config: LLMConfig,
  currentSchema: VTASchema,
  signal?: AbortSignal,
  onProgress?: (progress: AutoConnectionProgress) => void,
  options?: AutoConnectionOptions
): Promise<AutoConnectionResult> {
  if (!currentSchema.analysis) {
    throw new Error('イベント分析データがありません。先にイベント抽出を実行してください。');
  }

  let workingSchema: VTASchema = structuredClone(currentSchema);
  const originalPositions = new Map(currentSchema.nodes.map((n) => [n.id, n.position]));
  let addedInterLaneConnections = 0;
  let addedChainConnections = 0;
  let addedEvents = 0;
  let addedSubjects = 0;
  let foldedOthersSubjects: string[] | undefined;
  const warnings: string[] = [];
  const othersMode: OthersConsolidationMode = options?.othersConsolidationMode ?? 'deterministic';
  const requestLlmPeripheral =
    !options?.useHillClimbingConsolidation &&
    typeof options?.finalMaxSubjects === 'number' &&
    othersMode === 'llm_assisted';
  let llmPeripheralEntityIds: Set<string> | undefined;
  let llmPeripheralSectionPresent = false;

  // =========================================================================
  // Stage 1: レーン間接続提案（作業依存・資源移動・影響・相互確認・共通影響）
  // =========================================================================
  onProgress?.({
    stage: 'inter_lane',
    message: 'レーン間の因果関係・作業依存・資源移動をAIで探索しています...',
  });

  try {
    const proposalResult = requestLlmPeripheral
      ? await proposeVTAConnections(config, workingSchema, signal, undefined, {
          includePeripheralSubjects: true,
          followedByChainRepair: true,
        })
      : await proposeVTAConnections(config, workingSchema, signal, undefined, {
          followedByChainRepair: true,
        });
    if (proposalResult.peripheralSectionPresent) {
      llmPeripheralSectionPresent = true;
      llmPeripheralEntityIds = new Set(
        (proposalResult.peripheralSubjects ?? []).map((s) => s.entityId)
      );
    }
    const omittedKeys = new Set(workingSchema.presentation?.omittedDependencies ?? []);

    const candidateProposals = proposalResult.proposals.filter((p) => {
      const key = JSON.stringify([p.sourceEventId, p.sourceEntityId, p.targetEventId, p.targetEntityId, p.kind]);
      return !omittedKeys.has(key);
    });

    // 循環・整合性を検証しながら、有効な提案をすべて採択し、棄却内訳を記録
    const validProposals: ConnectionProposal[] = [];
    const rejectedProposals: Array<{ id: string; kind: string; reason: string }> = [];
    for (const prop of candidateProposals) {
      const testSet = [...validProposals, prop];
      const errors = validateSelectedConnectionProposals(workingSchema, testSet);
      if (!errors.length) {
        validProposals.push(prop);
      } else {
        rejectedProposals.push({ id: prop.id, kind: prop.kind, reason: errors[0] });
      }
    }

    const existingDispositions = workingSchema.analysis?.dispositions ?? [];
    const existingReviewKeys = new Set(
      existingDispositions
        .filter((d) => d.kind === 'review')
        .map((d) => {
          const refSig = (d.sourceRefs ?? [])
            .map((r) => `${r.sourceId}/${r.paragraphId}`)
            .sort()
            .join(',');
          return `${refSig}\u0000${d.reason.trim()}`;
        })
    );
    const usedDispositionIds = new Set(existingDispositions.map((d) => d.id));
    const newReviewDispositions = proposalResult.reviews
      .filter((r) => r.sourceRefs.length > 0 && r.reason.trim().length > 0)
      .filter((r) => {
        const refSig = r.sourceRefs
          .map((ref) => `${ref.sourceId}/${ref.paragraphId}`)
          .sort()
          .join(',');
        const key = `${refSig}\u0000${r.reason.trim()}`;
        if (existingReviewKeys.has(key)) return false;
        existingReviewKeys.add(key);
        return true;
      })
      .map((r) => {
        let dispId = `review_conn_${crypto.randomUUID()}`;
        while (usedDispositionIds.has(dispId)) {
          dispId = `review_conn_${crypto.randomUUID()}`;
        }
        usedDispositionIds.add(dispId);
        return {
          id: dispId,
          kind: 'review' as const,
          sourceRefs: r.sourceRefs,
          ...r.sourceRefs[0],
          quote: '',
          text: 'レーン間接続の要確認',
          reason: r.reason.trim(),
        };
      });

    debugRecorder.record(
      'connection-proposal.adoption',
      () => ({
        totalProposals: proposalResult.proposals.length,
        omittedFilteredCount: proposalResult.proposals.length - candidateProposals.length,
        adoptedCount: validProposals.length,
        addCount: validProposals.filter((p) => p.operation === 'add').length,
        refineCount: validProposals.filter((p) => p.operation === 'refine').length,
        rejectedCount: rejectedProposals.length,
        reviewsSavedCount: newReviewDispositions.length,
        rejectedSample: rejectedProposals.slice(0, 10),
      }),
      undefined,
      [config.gatewayToken ?? '']
    );

    if ((validProposals.length > 0 || newReviewDispositions.length > 0) && workingSchema.analysis) {
      let relations = [...workingSchema.analysis.relations];
      for (const proposal of validProposals) {
        if (proposal.operation === 'refine') {
          relations = relations.filter(
            (rel) =>
              !(
                rel.sourceEventId === proposal.sourceEventId &&
                rel.targetEventId === proposal.sourceEventId &&
                rel.sourceEntityId === proposal.sourceEntityId &&
                rel.targetEntityId === proposal.targetEntityId &&
                rel.kind === 'common' &&
                (rel.status === 'unknown' || !rel.status)
              )
          );
        }
        relations.push({
          ...proposalRelation(proposal),
          id: 'proposal:' + crypto.randomUUID(),
        });
      }

      const dispositions =
        newReviewDispositions.length > 0
          ? [...existingDispositions, ...newReviewDispositions]
          : workingSchema.analysis.dispositions;
      const analysis = {
        ...workingSchema.analysis,
        relations,
        ...(dispositions !== undefined ? { dispositions } : {}),
      };
      const validated = validateSavedAnalysis(analysis);
      workingSchema = projectAnalysis(validated, workingSchema);
      addedInterLaneConnections = validProposals.length;
    }

    if (proposalResult.invalidRows.length > 0) {
      warnings.push(`一部の接続提案行を自動解釈できませんでした（${proposalResult.invalidRows.length}件）。`);
    }
  } catch (err: unknown) {
    if (signal?.aborted || (err instanceof Error && (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED'))) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`レーン間接続の探索中に警告またはエラーが発生しました: ${msg}`);
  }

  // =========================================================================
  // Stage 2: 連鎖不足・孤立ノードの補完点検（決定論的整流の先行適用 ＋ 事前トリアージ）
  // =========================================================================
  // Stage 1の直後に同一レーン内の時系列接続を決定論的に整流（Pre-LLM Deterministic Pass）
  workingSchema = repairGeneratedLaneSequence(workingSchema).schema;

  // グラフ診断による事前トリアージ：帰結ノードが確定しており、かつ全事象が完全連結し、集合被災重複候補・未参照実質段落もない場合はStage 2 LLM推論をスキップ
  const preDiag = graphDiagnostics(workingSchema);
  const outcomeIdentified = Boolean(workingSchema.analysis?.outcome?.status === 'identified');
  const isolatedOutcomeCollectivesCount = workingSchema.analysis
    ? findIsolatedOutcomeCollectiveMatches(workingSchema.analysis).length
    : 0;
  const unreferencedParagraphCount = workingSchema.analysis
    ? workingSchema.analysis.sources.reduce(
        (sum, src) => sum + findUnreferencedSubstantiveParagraphs(src, workingSchema.analysis!).length,
        0
      )
    : 0;
  const isAlreadyFullyConnected =
    outcomeIdentified &&
    preDiag.canonical.length <= 1 &&
    preDiag.unassigned.length === 0 &&
    preDiag.missingRelations.length === 0 &&
    isolatedOutcomeCollectivesCount === 0 &&
    unreferencedParagraphCount === 0;

  debugRecorder.record(
    'chain-repair.triage',
    () => ({
      skipped: isAlreadyFullyConnected,
      outcomeIdentified,
      canonicalComponents: preDiag.canonical.length,
      unassignedCount: preDiag.unassigned.length,
      missingRelationsCount: preDiag.missingRelations.length,
      isolatedOutcomeCollectivesCount,
      unreferencedParagraphCount,
      missingRelations: preDiag.missingRelations.slice(0, 10),
    }),
    undefined,
    [config.gatewayToken ?? '']
  );

  if (isAlreadyFullyConnected) {
    onProgress?.({
      stage: 'chain_repair',
      message: '全事象が帰結ノードまで完全連結しているため、連鎖点検AI推論を省略します。',
    });
  } else {
    onProgress?.({
      stage: 'chain_repair',
      message: '孤立ノードおよび連鎖の不足箇所をAIで点検・補完しています...',
    });

    try {
      const repairResult = await proposeChainRepair(config, workingSchema, signal, (msg) => {
        onProgress?.({ stage: 'chain_repair', message: msg });
      });

      if (repairResult.rows.length > 0) {
        const allKeys = repairResult.rows.map((r) => r.section + '/' + r.id);
        const chosenKeys = selectChainDependencies(repairResult.rows, allKeys);
        const candidateRows = repairResult.rows.filter((r) => chosenKeys.includes(r.section + '/' + r.id));

        if (candidateRows.length > 0) {
          try {
            let nextSchema = applyChainDelta(workingSchema, candidateRows, true);
            // ADR-0075: Prune premature Stage 1 review_conn_* items that merely flagged an unassigned event now resolved by Stage 2 chain.repair
            if (nextSchema.analysis?.dispositions?.length) {
              const remainingUnassigned = new Set(nextSchema.analysis.unassignedEventIds);
              const chainReviewedEvents = new Set(
                candidateRows
                  .filter((r) => r.section === '要確認')
                  .flatMap((r) => (r.cells[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
              );
              const cleanedDispositions = nextSchema.analysis.dispositions.filter((d) => {
                if (!d.id.startsWith('review_conn_') || !/(?:unassigned|未割当)/i.test(d.reason)) {
                  return true;
                }
                const citedEvents = Array.from(
                  `${d.quote ?? ''} ${d.text ?? ''} ${d.reason}`.matchAll(/\b(E\d+)\b/g),
                  (m) => m[1]
                );
                if (citedEvents.length === 0) return true;
                return citedEvents.some(
                  (evId) => remainingUnassigned.has(evId) && !chainReviewedEvents.has(evId)
                );
              });
              if (cleanedDispositions.length !== nextSchema.analysis.dispositions.length) {
                nextSchema = {
                  ...nextSchema,
                  analysis: {
                    ...nextSchema.analysis,
                    dispositions: cleanedDispositions,
                  },
                };
              }
            }
            workingSchema = nextSchema;

            addedChainConnections = candidateRows.filter((r) => r.section === '関係追加').length;
            addedEvents = candidateRows.filter((r) => r.section === '追加イベント').length;
            addedSubjects = candidateRows.filter((r) => r.section === '追加主体').length;
          } catch (applyErr: unknown) {
            const applyMsg = applyErr instanceof Error ? applyErr.message : String(applyErr);
            warnings.push(`連鎖補完差分の適用中に一部除外が発生しました: ${applyMsg}`);
          }
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof Error && (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED'))) {
        throw err;
      }
      // SR-03: ステージ1で接続が追加されていれば、ステージ2の通信エラー時もロールバックせず部分採用
      const msg = err instanceof Error ? err.message : String(err);
      if (addedInterLaneConnections > 0) {
        warnings.push(`連鎖不足点検の通信に失敗しましたが、レーン間接続（${addedInterLaneConnections}件）は採用されました: ${msg}`);
      } else {
        warnings.push(`連鎖不足点検に失敗しました: ${msg}`);
      }
    }
  }

  // =========================================================================
  // Stage 2.5 (Final Phase):
  // - ADR-0079: 完成した最細粒度VTAを基底保存し、LLM候補提案＋山登り法でレーン統合
  // - Legacy: 非変動接続の周辺主体を「その他の関係者」へ集約 (ADR-0072)
  // =========================================================================
  let consolidationChanged = false;
  let fineCompletedSchema: VTASchema | undefined;
  let fineLanesCount: number | undefined;
  let consolidatedLanesCount: number | undefined;

  if (options?.useHillClimbingConsolidation && workingSchema.analysis) {
    // Merge any preserved 0-event Poset parent hubs from initial fineGrainedBase with completed Stage 1+2 entities/relations
    const priorFineEntities = currentSchema.analysis?.fineGrainedBase?.entities ?? [];
    const currentIds = new Set(workingSchema.analysis.entities.map((e) => e.id));
    const preservedHubs = priorFineEntities.filter((e) => !e.aggregate && !currentIds.has(e.id));
    const combinedEntities = [
      ...workingSchema.analysis.entities.filter((e) => !e.aggregate),
      ...preservedHubs,
    ];
    const basePosetJson = SubjectPoset.fromEntities(combinedEntities).toJSON();
    const validSet = new Set(combinedEntities.map((e) => e.id));
    const mergedRelations = [...basePosetJson.relations];
    const mergedAliases: Record<string, string> = { ...(basePosetJson.aliases ?? {}) };
    for (const extraPoset of [
      currentSchema.analysis?.fineGrainedBase?.subjectPoset,
      workingSchema.analysis.subjectPoset,
    ]) {
      if (!extraPoset) continue;
      const parsedPoset = SubjectPoset.fromData(extraPoset).toJSON();
      for (const [alias, canonical] of Object.entries(parsedPoset.aliases ?? {})) {
        if (validSet.has(canonical)) mergedAliases[alias] = canonical;
      }
      for (const rel of parsedPoset.relations) {
        if (
          validSet.has(rel.childId) &&
          validSet.has(rel.parentId) &&
          !mergedRelations.some((r) => r.childId === rel.childId && r.parentId === rel.parentId)
        ) {
          mergedRelations.push(rel);
        }
      }
    }
    const mergedPoset = SubjectPoset.fromData({
      nodes: basePosetJson.nodes,
      aliases: mergedAliases,
      relations: mergedRelations,
    });
    const restoredEntities = combinedEntities.map((ent) => {
      const parents = mergedPoset.getImmediateParents(ent.id);
      if (parents.length > 0) {
        return { ...ent, parentEntityId: parents[0], parentEntityIds: parents };
      }
      const copy = { ...ent };
      delete copy.parentEntityId;
      delete copy.parentEntityIds;
      return copy;
    });

    const completedFineBase: VTAFineGrainedBase = captureFineGrainedBase({
      ...workingSchema.analysis,
      fineGrainedBase: {
        entities: restoredEntities,
        participations: workingSchema.analysis.participations,
        relations: workingSchema.analysis.relations,
        cards: workingSchema.analysis.cards,
        subjectPoset: mergedPoset.toJSON(),
      },
    });

    const fineRepaired = repairGeneratedLaneSequence(
      {
        ...workingSchema,
        analysis: {
          ...workingSchema.analysis,
          subjectPoset: mergedPoset.toJSON(),
          fineGrainedBase: completedFineBase,
        },
      },
      { preservePositions: true }
    ).schema;
    workingSchema = fineRepaired;
    fineCompletedSchema = structuredClone(fineRepaired);

    onProgress?.({
      stage: 'lane_consolidation',
      message: '完成した最細粒度VTAからレーン統合候補を提案し、山登り法で最適化しています...',
    });

    const effectiveScope: VTAAnalysisScope | undefined = options.scope
      ? {
          ...options.scope,
          pinnedEntityIds: Array.from(
            new Set([...(options.scope.pinnedEntityIds ?? []), ...(options.pinnedEntityIds ?? [])])
          ),
        }
      : options.pinnedEntityIds?.length
        ? { pinnedEntityIds: options.pinnedEntityIds }
        : undefined;

    const hcRes = await optimizeLaneConsolidation(
      config,
      workingSchema,
      (cfg, msgs, temp, sig) => callLLMGateway(cfg, msgs, temp, sig, { terminator: '[完了]' }),
      undefined,
      signal,
      {
        targetMaxSubjects: options.finalMaxSubjects,
        weights: options.refinementWeights,
        oneTimeDirective: options.oneTimeDirective,
        assumptions: options.assumptions,
        scope: effectiveScope,
      }
    );

    workingSchema = hcRes.schema;
    fineLanesCount = hcRes.fineLaneCount;
    consolidatedLanesCount = hcRes.finalLaneCount;
    consolidationChanged =
      hcRes.consolidation.appliedCandidateIds.length > 0 ||
      hcRes.finalLaneCount !== hcRes.fineLaneCount;
    const othersFolded = Object.entries(hcRes.consolidation.laneAssignment)
      .filter(([src, tgt]) => isPeripheralAggregateId(tgt) && !isPeripheralAggregateId(src))
      .map(([src]) => src);
    if (othersFolded.length > 0) {
      foldedOthersSubjects = othersFolded;
    }
  } else if (typeof options?.finalMaxSubjects === 'number' && workingSchema.analysis) {
    const preMax = workingSchema.analysis.subjectRanking?.preConsolidationMaxSubjects;
    const beforeConsolidationSchema = workingSchema;
    const consolidationResult = consolidatePeripheralSubjectsToOthers(
      workingSchema,
      options.finalMaxSubjects,
      {
        ...(options.pinnedEntityIds?.length
          ? { forceRetain: new Set(options.pinnedEntityIds) }
          : {}),
        othersConsolidationMode: othersMode,
        ...(llmPeripheralEntityIds ? { llmPeripheralEntityIds } : {}),
        ...(llmPeripheralSectionPresent ? { llmPeripheralSectionPresent: true } : {}),
      },
      (msg) => warnings.push(msg)
    );
    workingSchema = consolidationResult.schema;
    consolidationChanged =
      consolidationResult.foldedEntityIds.length > 0 ||
      consolidationResult.rolledUpPosetEntityIds.length > 0 ||
      consolidationResult.schema !== beforeConsolidationSchema;
    if (consolidationResult.foldedEntityIds.length > 0) {
      foldedOthersSubjects = consolidationResult.foldedEntityIds;
    }
    debugRecorder.record(
      'subject.others_consolidation',
      () => ({
        mode: consolidationResult.modeUsed,
        preMaxSubjects: preMax,
        postMaxSubjects: options.finalMaxSubjects,
        rolledUpPosetEntityIds: consolidationResult.rolledUpPosetEntityIds,
        foldedEntityIds: consolidationResult.foldedEntityIds,
        skippedReason: consolidationResult.skippedReason,
        visibleLanes: visibleSchema(workingSchema).lanes.length,
      }),
      undefined,
      [config.gatewayToken ?? '']
    );
  }

  // =========================================================================
  // Stage 3: 同一レーン時系列線の整流確定
  // =========================================================================
  onProgress?.({
    stage: 'geometry_sync',
    message: '同一レーンの時系列接続を整流・確定しています...',
  });

  const laneOrderKeyByLane = (schemaToCheck: VTASchema): Map<string, string> => {
    const grouped = new Map<string, Array<{ id: string; seq: number; idx: number }>>();
    schemaToCheck.nodes.forEach((n, idx) => {
      const list = grouped.get(n.lane) ?? [];
      list.push({
        id: n.id,
        seq: typeof n.sequence_order === 'number' && Number.isFinite(n.sequence_order) ? n.sequence_order : idx,
        idx,
      });
      grouped.set(n.lane, list);
    });
    const keys = new Map<string, string>();
    for (const [lane, list] of grouped) {
      list.sort((a, b) => a.seq - b.seq || a.idx - b.idx);
      keys.set(lane, list.map((item) => item.id).join('\u0000'));
    }
    return keys;
  };
  const originalLaneOrderKeys = laneOrderKeyByLane(currentSchema);
  const repaired = repairGeneratedLaneSequence(workingSchema, { preservePositions: true }).schema;
  const repairedLaneOrderKeys = laneOrderKeyByLane(repaired);
  const finalSchema: VTASchema = {
    ...repaired,
    nodes: repaired.nodes.map((n) => {
      const laneOrderUnchanged =
        originalLaneOrderKeys.get(n.lane) !== undefined &&
        originalLaneOrderKeys.get(n.lane) === repairedLaneOrderKeys.get(n.lane);
      const preservedPos =
        workingSchema.nodes.find((p) => p.id === n.id)?.position ??
        (laneOrderUnchanged ? originalPositions.get(n.id) : undefined);
      return {
        ...n,
        position: preservedPos ?? n.position,
      };
    }),
  };

  if (consolidationChanged) {
    recordGraphProjectionDebug(finalSchema);
  }

  return {
    schema: finalSchema,
    ...(fineCompletedSchema ? { fineCompletedSchema } : {}),
    ...(fineLanesCount !== undefined ? { fineLanesCount } : {}),
    ...(consolidatedLanesCount !== undefined ? { consolidatedLanesCount } : {}),
    addedInterLaneConnections,
    addedChainConnections,
    addedEvents,
    addedSubjects,
    ...(foldedOthersSubjects ? { foldedOthersSubjects } : {}),
    warnings,
  };
}
