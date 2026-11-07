import type { LLMConfig, VTASchema, VTAEventRelation } from '../../types/vta';
import { proposeVTAConnections } from '../llm/client';
import { proposeChainRepair } from './chainRepairService';
import { validateSelectedConnectionProposals, proposalRelation, type ConnectionProposal } from '../../features/vta/utils/connectionProposals';
import { dependencyKey } from '../../features/vta/utils/eventOrder';
import { projectAnalysis, validateSavedAnalysis } from '../../features/vta/utils/eventAnalysis';
import { applyChainDelta, selectChainDependencies, type ChainRow } from '../../features/vta/utils/chainRepair';
import { repairGeneratedLaneSequence } from '../../features/vta/utils/generatedLaneSequence';
import { graphDiagnostics } from '../../features/vta/utils/graphDiagnostics';

export interface AutoConnectionProgress {
  stage: 'inter_lane' | 'chain_repair' | 'geometry_sync';
  message: string;
}

export interface AutoConnectionResult {
  schema: VTASchema;
  addedInterLaneConnections: number;
  addedChainConnections: number;
  addedEvents: number;
  addedSubjects: number;
  warnings: string[];
}

export async function autoConnectVTA(
  config: LLMConfig,
  currentSchema: VTASchema,
  signal?: AbortSignal,
  onProgress?: (progress: AutoConnectionProgress) => void
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
  const warnings: string[] = [];

  // =========================================================================
  // Stage 1: レーン間接続提案（作業依存・資源移動・影響・相互確認・共通影響）
  // =========================================================================
  onProgress?.({
    stage: 'inter_lane',
    message: 'レーン間の因果関係・作業依存・資源移動をAIで探索しています...',
  });

  try {
    const proposalResult = await proposeVTAConnections(config, workingSchema, signal);
    const omittedKeys = new Set(workingSchema.presentation?.omittedDependencies ?? []);

    const candidateProposals = proposalResult.proposals.filter((p) => {
      const key = JSON.stringify([p.sourceEventId, p.sourceEntityId, p.targetEventId, p.targetEntityId, p.kind]);
      return !omittedKeys.has(key);
    });

    // 循環・整合性を検証しながら、有効な提案をすべて採択
    const validProposals: ConnectionProposal[] = [];
    for (const prop of candidateProposals) {
      const testSet = [...validProposals, prop];
      const errors = validateSelectedConnectionProposals(workingSchema, testSet);
      if (!errors.length) {
        validProposals.push(prop);
      }
    }

    if (validProposals.length > 0 && workingSchema.analysis) {
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

      const analysis = { ...workingSchema.analysis, relations };
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

  // グラフ診断による事前トリアージ：帰結ノードが確定しており、かつ全事象が完全連結している場合はStage 2 LLM推論をスキップ
  const preDiag = graphDiagnostics(workingSchema);
  const isAlreadyFullyConnected =
    Boolean(workingSchema.analysis?.outcome?.status === 'identified') &&
    preDiag.canonical.length <= 1 &&
    preDiag.unassigned.length === 0 &&
    preDiag.missingRelations.length === 0;

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
            const nextSchema = applyChainDelta(workingSchema, candidateRows, true);
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
  // Stage 3: 同一レーン時系列線の整流確定
  // =========================================================================
  onProgress?.({
    stage: 'geometry_sync',
    message: '同一レーンの時系列接続を整流・確定しています...',
  });

  const repaired = repairGeneratedLaneSequence(workingSchema).schema;
  const finalSchema: VTASchema = {
    ...repaired,
    nodes: repaired.nodes.map((n) => ({
      ...n,
      position: originalPositions.get(n.id) ?? workingSchema.nodes.find((p) => p.id === n.id)?.position ?? n.position,
    })),
  };

  return {
    schema: finalSchema,
    addedInterLaneConnections,
    addedChainConnections,
    addedEvents,
    addedSubjects,
    warnings,
  };
}
