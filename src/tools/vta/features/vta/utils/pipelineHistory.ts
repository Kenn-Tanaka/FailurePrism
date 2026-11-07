import type {
  VTASchema,
  VTANodeData,
  VTAEdgeData,
  VTAPipelineSnapshot,
  VTAPipelineStageId,
  VTAAnalysisData,
} from '../../../types/vta';
import { revertConsolidation } from './subjectRanking';
import { projectAnalysis } from './eventAnalysis';

/**
 * 任意のスキーマから単一のパイプラインスナップショットを生成する
 */
export function createPipelineSnapshot(
  id: VTAPipelineStageId | string,
  stageIndex: number,
  title: string,
  subtitle: string,
  description: string,
  schema: VTASchema
): VTAPipelineSnapshot {
  const variationCount = schema.nodes.filter(
    (n) => n.type === 'variation' || Boolean(n.variation_factor)
  ).length;
  const outcomeCount = schema.nodes.filter(
    (n) => n.type === 'outcome' || Boolean(n.outcome_kind)
  ).length;
  const eventCount = schema.analysis?.events?.length ?? schema.nodes.length;

  return {
    id,
    stageIndex,
    title,
    subtitle,
    description,
    timestamp: new Date().toISOString(),
    lanes: [...schema.lanes],
    nodes: structuredClone(schema.nodes),
    edges: structuredClone(schema.edges),
    presentation: schema.presentation ? structuredClone(schema.presentation) : undefined,
    stats: {
      eventCount,
      nodeCount: schema.nodes.length,
      laneCount: schema.lanes.length,
      edgeCount: schema.edges.length,
      variationCount,
      outcomeCount,
    },
  };
}

/**
 * 履歴配列にスナップショットを追加・更新する（stageIndex 昇順で整列）
 */
export function upsertPipelineSnapshot(
  history: VTAPipelineSnapshot[] | undefined,
  snapshot: VTAPipelineSnapshot
): VTAPipelineSnapshot[] {
  const list = history ? [...history] : [];
  const existingIdx = list.findIndex((s) => s.id === snapshot.id);
  if (existingIdx >= 0) {
    list[existingIdx] = snapshot;
  } else {
    list.push(snapshot);
  }
  return list.sort((a, b) => a.stageIndex - b.stageIndex);
}

/**
 * 既存の VTASchema（およびその analysis 監査台帳）から、
 * 4段階の AI 推論パイプライン変遷スナップショットを高精度にロスレス復元する
 */
export function reconstructPipelineSnapshots(schema: VTASchema): VTAPipelineSnapshot[] {
  const analysis = schema.analysis;
  const hasRankingHistory = Boolean(
    analysis?.subjectRanking && analysis.subjectRanking.originalEntities.length > 0
  );

  // -------------------------------------------------------------------------
  // Stage 1: 全文正規化 (初期抽出)
  // -------------------------------------------------------------------------
  let stage1Schema: VTASchema;
  let stage1LanesCount = schema.lanes.length;
  let stage1EventsCount = analysis?.events.length ?? schema.nodes.length;

  if (hasRankingHistory && analysis) {
    try {
      const reverted = revertConsolidation(analysis);
      stage1LanesCount = reverted.entities.length;
      stage1EventsCount = reverted.events.length;

      // 自動接続提案（proposal:* または llm-proposal）由来の関係を除外
      const baseRelations = reverted.relations.filter((r) => {
        if (r.id?.startsWith('proposal:')) return false;
        if (r.provenance === 'llm-proposal') return false;
        return true;
      });

      const cleanReverted: VTAAnalysisData = {
        ...reverted,
        relations: baseRelations,
      };

      const projected = projectAnalysis(cleanReverted);
      // 全ノードの種別を未判定（normal）に初期化（帰結は保持）
      const normalizedNodes = projected.nodes.map((n) => ({
        ...n,
        type: (n.type === 'outcome' ? 'outcome' : 'normal') as VTANodeData['type'],
        variation_factor: undefined,
        measure_type: null,
      }));

      // 初期抽出時はレーン間自動接続・同一レーン整流エッジはまだ引かれていない
      const manualOrLedgerEdges = projected.edges.filter((e) => !e.generated);

      stage1Schema = {
        ...projected,
        nodes: normalizedNodes,
        edges: manualOrLedgerEdges,
      };
    } catch {
      stage1Schema = createFallbackStageSchema(schema, false, false);
    }
  } else {
    stage1Schema = createFallbackStageSchema(schema, false, false);
  }

  const s1 = createPipelineSnapshot(
    'stage1_normalize',
    0,
    'Stage 1: 全文正規化 (初期抽出)',
    `イベント ${stage1EventsCount}件、主体 ${stage1LanesCount}列`,
    `事故報告書全文からイベントと関係主体を一次抽出し、客体・根拠を台帳整理した初期抽出ツリー`,
    stage1Schema
  );

  // -------------------------------------------------------------------------
  // Stage 2: 粒度反復最適化 (refined-chain)
  // -------------------------------------------------------------------------
  // レーンは現在の統合済み主体、エッジはまだ自動接続前、ノードは未分類
  const stage2Nodes = schema.nodes.map((n) => ({
    ...n,
    type: (n.type === 'outcome' ? 'outcome' : 'normal') as VTANodeData['type'],
    variation_factor: undefined,
    measure_type: null,
  }));
  // 自動接続（proposal:* / generated）前の初期関係のみ
  const stage2Edges = schema.edges.filter((e) => !e.generated && !e.id?.startsWith('proposal:'));

  let stage2Description = '主体重要度ランキングと認知負荷評価に基づくレーン統合・客体化';
  const iterations = analysis?.normalizationAudit?.iterations;
  if (iterations && iterations.length > 1) {
    const first = iterations[0];
    const last = iterations[iterations.length - 1];
    stage2Description += ` (最適化反復スコア: S=${first.score.toFixed(3)} → S=${last.score.toFixed(3)})`;
  }

  const stage2Schema: VTASchema = {
    ...schema,
    nodes: stage2Nodes,
    edges: stage2Edges,
  };

  const s2 = createPipelineSnapshot(
    'stage2_refine',
    1,
    'Stage 2: 粒度反復最適化 (refined-chain)',
    `主体集約 ${schema.lanes.length}列（受動機器の客体分離完了）`,
    stage2Description,
    stage2Schema
  );

  // -------------------------------------------------------------------------
  // Stage 3: ノード自動接続 (autoConnect)
  // -------------------------------------------------------------------------
  // 全エッジ（レーン間伝達・前後連鎖）を結線、ノードはまだ未分類
  const stage3Schema: VTASchema = {
    ...schema,
    nodes: stage2Nodes, // まだ白カード（未判定）
    edges: schema.edges, // 全エッジ結線
  };

  const s3 = createPipelineSnapshot(
    'stage3_connect',
    2,
    'Stage 3: ノード自動接続 (autoConnect)',
    `レーン間伝達・前後連鎖エッジ ${schema.edges.length}本の探索と補完`,
    '作業依存・資源移動・情報伝達および時系列連鎖をAIで自動探索し、完全な因果ネットワークを結線',
    stage3Schema
  );

  // -------------------------------------------------------------------------
  // Stage 4: 変動要因判定・帰結確定
  // -------------------------------------------------------------------------
  // 現在の完成スキーマ（変動要因・帰結の着色と全エッジを含む）
  const variationCount = schema.nodes.filter(
    (n) => n.type === 'variation' || Boolean(n.variation_factor)
  ).length;
  const outcomeCount = schema.nodes.filter(
    (n) => n.type === 'outcome' || Boolean(n.outcome_kind)
  ).length;

  const s4 = createPipelineSnapshot(
    'stage4_classify',
    3,
    'Stage 4: 変動要因判定・帰結確定',
    `変動要因 ${variationCount}件、帰結 ${outcomeCount}件`,
    '事故シナリオにおける通常作業（白）・変動要因（黄/橙）・不具合帰結（赤）の判定・確定',
    schema
  );

  return [s1, s2, s3, s4];
}

/**
 * フォールバック用のステージスキーマを生成する内部ヘルパー
 */
function createFallbackStageSchema(
  base: VTASchema,
  includeEdges: boolean,
  includeClassifications: boolean
): VTASchema {
  return {
    ...base,
    nodes: base.nodes.map((n) => ({
      ...n,
      type: includeClassifications
        ? n.type
        : (n.type === 'outcome' ? 'outcome' : 'normal'),
      variation_factor: includeClassifications ? n.variation_factor : undefined,
      measure_type: includeClassifications ? n.measure_type : null,
    })),
    edges: includeEdges ? base.edges : [],
  };
}

/**
 * スキーマに保存されている pipelineHistory を取得する。
 * 未定義または空の場合は、既存のデータから動的に 4 ステージをロスレス復元する。
 */
export function resolvePipelineSnapshots(schema: VTASchema): VTAPipelineSnapshot[] {
  if (schema.pipelineHistory && schema.pipelineHistory.length > 0) {
    return schema.pipelineHistory;
  }
  return reconstructPipelineSnapshots(schema);
}
