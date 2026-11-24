# ADR-0079: 主体上限なしの最細粒度VTA先行完成・LLM統合候補一括提案＋ビーム併用山登り法レーン削減および表示エッジ統合ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-24
- **対象コンポーネント**: VTA Engine (`laneConsolidationOptimizer.ts`, `eventAnalysis.ts`, `sharedEvents.ts`, `graphDiagnostics.ts`, `autoConnectionService.ts`, `client.ts`), Store & UI (`vtaStore.ts`, `ScenarioInputSection.tsx`), LLM Prompts (`eventPrompts.ts`, `public/prompts.json`), Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0008](./0008-subject-consolidation-outcome-asymmetry-policy.md), [ADR-0011](./0011-vta-subject-olap-drilldown-and-rollup.md), [ADR-0071](./0071-penalty-based-subject-consolidation-and-gentle-lane-cap.md), [ADR-0075](./0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md), [ADR-0078](./0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md), [ROADMAP.md](../ROADMAP.md) (`RM-VTA4-01`..`04`)

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0078 適用後の実事例監査（`extract_full_1795454415441_yp2l`）およびパイプライン設計の見直しにより、従来の多段インターリーブ構成（Stage 2 早期統合 → Stage 3 接続補完 → Stage 3.5 周辺主体再統合）に以下の構造的課題があることが明らかになった。

1. **接続未完成グラフに対する早期統合の副作用**:
   レーン間接続提案（`connection.proposal`）や連鎖補完（`chain.repair`）を行う前の未完成グラフに対して Stage 2 で主体上限を適用し、さらに Stage 3 の `refine` でエッジ種別が変化した後に Stage 3.5 の手続き的ガード（`variationNeighborSemanticCount` 等）を通していたため、重要当事者（`D中継見張員`）の早期吸収や周辺組織（`下請会社`・`東武鉄道`）の集約デッドロックが発生していた。
2. **Stage 2 反復LLMループのトークン・レイテンシ消費**:
   未完成グラフに対してイベント・関係・原文抜粋を 2〜3 回反復送信しており、通信コストが高かった。
3. **レーン統合時の並列エッジ重複描画と対策ブレイク競合**:
   複数の細粒度主体を同一レーンへ統合した際、同一表示カード対 $(C_u, C_v)$ 間に複数の細粒度関係エッジが重複描画され、視認性低下や対策ブレイク（BREAK）一括配置のスキップを招いていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **因果構造構築と表示粒度最適化の直交分離**: まず最大主体数に制限を設けず最細粒度のまま接続・連鎖補完までVTA図を完成させ、その完成図を内部基底（`fineGrainedBase`）として保持した上で表示レーン数を削減する。
- **トークン効率と決定論的収束**: LLM呼び出しは「統合候補リスト＋意味コスト＋分離維持ペア」を一括提案する **1回のみ** とし、組み合わせ探索と採点はローカルの決定論的評価関数で行う。
- **プラトー（局所解）突破と過剰統合防止**: `その他の関係者` や `0件親組織ハブ` は2主体以上を同時投入して初めて列が減るため、1手近傍の単純山登り法では止まるプラトーを突破でき、かつ目標列数 $K$ 以下へ潰しすぎない採点・探索が必要である。
- **表示上の接続統合と無損失性**: 統合後の同一カード対間の並列エッジを1本へ束ね（`bundledRelationIds`）、異主体間の同一通常レーン内エッジを直列線へ吸収しつつ、内部の最細粒度VTA・JSON保存・OLAPドリルダウン・手動編集整合を無損失に維持する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A**: 従来の Stage 2 + Stage 3.5 の手続き的ガード条件を個別調整し続ける。
  - *不採用理由*: 未完成グラフでの早期統合と後段接続変化の結合が解消されず、通信回数も削減できない。
- **選択肢 B**: 山登り法の各ステップで LLM に図を採点させる。
  - *不採用理由*: 近傍評価のたびに通信が発生してトークンを浪費し、LLM採点の非決定性により山登りが収束しない。
- **選択肢 C（採用）**:
  1. 主体上限なしで最細粒度VTA（正規化・仮判定・自動接続・連鎖補完）を一度完成させ、`analysis.fineGrainedBase` に非破壊保存する。
  2. 完成した最細粒度VTAとシナリオ・ヒントから、LLMに **1回で複数の統合候補（単体・バンドル・役割グループ・その他集約＋意味コスト）と分離維持ペア** を提案させる。
  3. 事前計算済み `EventTimeDAG` を用いた高速ローカル採点器と **ビーム併用山登り法（2候補複合近傍付き）** で最高得点の統合ビューを選択し、並列エッジを束ねて投影する。

## 4. 決定事項 (Decision Outcome)

### 4.1 4フェーズ直列パイプラインと正規化プロンプト整備 (`eventPrompts.ts`, `client.ts`, `autoConnectionService.ts`, `ScenarioInputSection.tsx`)
- 正規化段階（Phase 1）では主体数上限を設けず最細粒度で抽出し、同一対象の呼称揺れ統一（`[表記] alias`）と完全同質メンバーのグループ化、および終局 `:recovery` 帰結と途中経過の適応行動（`variation:resilient`）・集団避難時の `:actor`/`:affected` 役割区分を明記する。
- `extractEventDraft(..., { skipEarlyRefinement: true })` により早期 Stage 2 反復を廃止し、最細粒度のまま `autoConnectVTA`（`proposeVTAConnections` + `proposeChainRepair`）を完了させて `analysis.fineGrainedBase` を確定する（Phase 2）。

### 4.2 LLM候補一括提案とビーム併用山登りオプティマイザ (`laneConsolidationOptimizer.ts`, `vtaStore.ts`)
- Phase 3 にて `LANE_CONSOLIDATION_SYSTEM_PROMPT` で `[統合候補]`（`poset_rollup` / `role_group` / `peripheral_others` / `object_absorb` + `semanticCost`）と `[分離維持ペア]`（`hard` / `soft`）を1回のLLM通信で取得し、Poset構造フォールバック候補と統合する（既に $L_{\text{fine}} \le K$ の場合はLLM通信自体を省略）。
- Phase 4（`searchOptimalLaneConsolidation`）にて、ハードゲート（固定主体保護、`hard` 分離ペア保護、単独 `subject_others` / 1子孫以下0件ハブ禁止、帰結表示・同一レーン逆行ゼロ検証）の下で $S = \sum_{i=1}^5 w_i C_i$（$C_1$: $L=K$ ピーク関数、$C_2$: LLM意味コスト＋ソフト分離、$C_3$: 帰結到達率＋細粒度クロスレーン相互作用保存率、$C_4$: 受動客体境界、$C_5$: 束ね後カード密度・交差数）を最大化するビーム併用山登り探索（複合2手近傍含む）を実行する。
- `reoptimizeVTA` も `fineGrainedBase` 基点の本オプティマイザへ統一し、ワンタイム指示がない場合はキャッシュ済みAI候補を再利用して 0 トークンで即時再探索可能とする。

### 4.3 内部最細粒度保持と表示上の接続（エッジ）統合 (`vta.ts`, `eventAnalysis.ts`, `sharedEvents.ts`, `graphDiagnostics.ts`, `aiDiagnostics.ts`)
- `VTAAnalysisData` に `fineGrainedBase`・`laneConsolidation`、`VTAEdgeData` に `bundledRelationIds` を追加し、`validateSavedAnalysis` および `reconcileAnalysis`（手動ノード追加・束ねエッジ削除同期）に対応させる。
- `projectAnalysis` および `connectSharedEvents` にて、同一カード対 $(C_u, C_v)$ に集約された複数関係を代表属性・双方向判定・統合ラベル付きの **1本のエッジ（`bundledRelationIds` 保持）** に束ね、統合により同一通常レーン内に入った異主体間実施済み関係（`omitted` 除く）を直列線へ吸収する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 細粒度因果接続が確定した後に全体を見渡してレーン削減を行うため、重要当事者の誤吸収や周辺組織の集約漏れが解消される。
  - 従来の Stage 2 反復LLMループ（2〜3回）が軽量な候補提案1回（$L_{\text{fine}} \le K$ 時は0回）＋ローカル探索（$<50\text{ms}$）に置き換わり、トークン消費と待ち時間が大幅に削減される。
  - 重複並列エッジが解消され、対策ブレイク（BREAK）の一括配置や配線視認性が向上する一方、内部には最細粒度VTAが完全保持される。
- **トレードオフ・考慮事項**:
  - プロジェクトJSONに `fineGrainedBase` と `laneConsolidation` が追加される（原文テキストは重複保持しないためサイズ増は数KB程度）。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts` / `laneConsolidationOptimizer.test.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`, `sharedEvents.ts`, `graphDiagnostics.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts`, `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`, `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`, `public/prompts.json`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
