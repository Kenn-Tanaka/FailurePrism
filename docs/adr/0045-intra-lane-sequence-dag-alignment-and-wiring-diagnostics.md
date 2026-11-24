# ADR-0045: レーン内順序線とEventTimeDAGランクの完全同期・同ランクBottom-to-Top配置および配線幾何診断ポリシー

- **ステータス**: `Accepted`
- **決定日**: 2026-11-18
- **対象コンポーネント**: `src/tools/vta/features/vta/utils/eventTimePoset.ts`, `src/tools/vta/features/vta/utils/layout.ts`, `src/tools/vta/features/vta/utils/eventRanks.ts`, `src/tools/vta/features/vta/utils/generatedLaneSequence.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`, `src/tools/vta/features/vta/utils/chainRepair.ts`, `src/tools/vta/services/generation/granularityRefinement.ts`, `src/tools/vta/services/generation/granularityScore.ts`, `src/tools/vta/services/generation/autoConnectionService.ts`, `src/tools/vta/services/llm/client.ts`, `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`, `src/tools/vta/features/vta/store/vtaStore.ts`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- **関連ドキュメント・コミット**: [ADR-0014](file:///docs/adr/0014-junction-edge-routing-and-smooth-arrival.md), [ADR-0022](file:///docs/adr/0022-pre-outcome-node-protection-and-refinement-lane-sequence-repair.md), [ADR-0025](file:///docs/adr/0025-ai-diagnostics-trace-hygiene-and-full-pipeline-observability.md), [ADR-0034](file:///docs/adr/0034-row-cell-layout-and-matrix-event-time-dag.md), [ADR-0043](file:///docs/adr/0043-poset-transitivity-across-ledger-and-lane-relation-preservation.md), [ADR-0044](file:///docs/adr/0044-connection-proposal-prefilter-history-preservation-and-diagnostics-accuracy.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

実機VTAツリーの画面および AI Diagnostics Package トレースの診断により、同一レーン内のノード接続乱れ（カード外周30pxの大回り迂回線、上から下への逆行線、客体ドット `◎` 直上でのクランク折れ曲がり）および診断ログの観測盲点が特定された：

1. **`sequence_order`（`sequential` 結線順）と `EventTimeDAG`（Y座標ランク順）の乖離**:
   - `projectAnalysis` がカード集合不変だけで `preserveCardOrder = true` と判定し、`add_relation` や接続提案・連鎖補完により `EventTimeDAG` ランクが変わっても古い `sequence_order` と古い `sequential` エッジを維持していた。また `allOrderedCards` のソートが同一レーン時のみ `cardRow` を見る非推移的比較関数であり、TimSort で同一レーン順が崩れ得た。
   - さらに `computeEventRanks` が自動生成済みの古い `sequential` エッジまで `EventTimeDAG` へ再投入していたため、古い順序がランク計算自体に逆流していた。
2. **同一 `(lane, rank)` バケット内 sibling の上下逆転配置**:
   - `calculateVTALayout` が同一ランク内の複数ノード（例：同分帯のカードと受動客体ドット `◎`）に対し、時間軸と逆の Top-to-Bottom で `intraOffset` を加算していた。これにより先発ノードが上、後発ノードが下に配置され、`sequential` 線が逆行・`◎` 衝突迂回を起こしていた。加えて `parseTimeScore` が `17:45(11〜18秒)` 等の括弧付き秒表記を切り捨てていた。
3. **後段ステージでの `dependency` 同一レーン新設・再整流漏れ**:
   - `granularityRefinement` と `chainRepair` で統合後同一レーンに対する新規 `dependency` 追加を許容し、また `filterPostOutcomeScope` や `add_relation` 単独反復で `repairGeneratedLaneSequence` / `annotateNodeTopologyRules` の再適用が漏れていた。
4. **診断ログの観測盲点**:
   - `aiDiagnostics.ts` が結線・レイアウト幾何異常（逆行エッジ、飛び越し `sequential`、`missingRelations`、`detoured` 配線）を全く記録・抽出しておらず、また粒度反復の不採用試行が `graph.projection` を汚染し、`pipeline.completed` のイベント数が `ignored` イベントを含めていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- キャンバス上の手動ドラッグ配置・`applyConnectionRepair`・手動 `updateEdge` / `deleteEdge`（`sampleData` 等を含む）や `forceMergeLanes` 時の座標シフト契約を破壊しないこと。
- 自動生成時・反復最適化・自動接続・事後除外のすべての経路で、常に `sequence_order`（`sequential` 線）＝ `EventTimeDAG` ランク順 ＝ Bottom-to-Top 描画 Y 座標の3者一致を保証すること。
- 既存のテスト契約（手動スキーマにおける `edge` からのランク推論、`repairLaneConnections` の意味関係保護等）を維持すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1: レンダリング時の `edgeRouting` で逆行・飛び越し迂回を見栄え上だけ調整する**
  - *不採用理由*: 上下配置と `sequential` 結線の論理順自体が破綻しているため根本解決にならず、かえって因果方向（下→上）を誤認させる。
- **選択肢 2 (採用): 時刻秒パース・`projectAnalysis` / `repairGeneratedLaneSequence` / `computeEventRanks` による DAG 同期・同ランク Bottom-to-Top 配置を一貫適用し、配線幾何監査を `aiDiagnostics` へ統合する**

---

## 4. 決定事項 (Decision Outcome)

1. **括弧付き秒パースと `parseTimeScore` 共通化（`eventTimePoset.ts`, `layout.ts`）**:
   - `2024-01-02 17:45(11〜18秒)` / `17:44(56秒)` 等の秒精度を `parseTimeScore` で抽出し、`layout.ts` の重複定義を `eventTimePoset.ts` からの再エクスポートへ統合する。
2. **同一 `(lane, rank)` Bottom-to-Top 配置（`layout.ts`）**:
   - `laneRankMap` バケットを `(sequence_order, schemaIndex)` で時系列昇順に整列し、後発 sibling（`i > siblingIdx`）の高さを `intraOffset` として積算することで「過去＝下、未来＝上」を厳守する。さらに `auditVTALayoutGeometry` を新設する。
3. **`EventTimeDAG` と `sequence_order`・`sequential` エッジの一貫同期（`eventRanks.ts`, `eventAnalysis.ts`, `generatedLaneSequence.ts`, `granularityRefinement.ts`, `granularityScore.ts`, `chainRepair.ts`, `autoConnectionService.ts`）**:
   - `computeEventRanks` は `schema.analysis` 保有時に無印自動生成 `sequential` エッジ（`!id && !relationId && generated !== false`）を DAG へ再注入せず、`activeNodeIds` / `tieBreakScore` を `computeEventRowMap` と一致させる。
   - `projectAnalysis` は関係署名変化時や未配置レーン逆転時に `preserveCardOrder` を無効化し、レーン間スロット順を維持しつつ各レーン内を厳密弱順序 `(cardRow, cardSourceOrder, id)` で整列して `repairGeneratedLaneSequence(..., { preservePositions: true })` と `annotateNodeTopologyRules` を適用し、相対順が入れ替わったレーンのみ古い保存座標をリセットする。
   - `repairGeneratedLaneSequence` でも `schema.analysis` 保有時は `computeEventRowMap` を基準に再整列し、`granularityRefinement`・`chainRepair` では統合後同一レーンへの新規 `dependency` 追加を抑止する。
4. **配線幾何監査と診断パッケージ衛生向上（`client.ts`, `ScenarioInputSection.tsx`, `vtaStore.ts`, `aiDiagnostics.ts`, `eventAnalysis.ts`）**:
   - `auditProjectionWiring` と `layout.audit` により、最終投影・レイアウト上の逆行線・飛び越し順序線・`DAG` 順位逆転・未投影関係・直列迂回を `Anomalies` および遷移サマリへ記録する。
   - `refineGranularity` では不採用試行を `silentDebug` 化して採用時のみ `recordGraphProjectionDebug` を呼び、操作内訳・棄却理由をログへ出力する。`ScenarioInputSection.tsx` の完了イベント数等は `!e.ignored` で計上し、`traceEntityLineage` の連続重複 `graph.projection` を圧縮し、`SubjectPosetSummary` に `catalog_count` を併記する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 供述イベントの順位変動や同ランク内での客体ドット混在があっても、すべてのレーン内直列接続が下→上の直交直線で破綻なく描画される。
  - 将来同様の配線不整合が発生しても AI Diagnostics Package 単体から原因箇所（`BACKWARD_INTRA_LANE_EDGE`, `DAG_SEQUENCE_INVERSION`, `LAYOUT_DETOURED_SEQUENTIAL_EDGE` 等）を即座に特定できる。
- **トレードオフ・考慮事項**:
  - 手動ドラッグ配置や `applyConnectionRepair` / `updateEdge` / `deleteEdge` による意図的なキャンバス編集時は、`hasUnchangedCards && dagSignatureUnchanged` によりユーザー配置・手動エッジメタデータがそのまま保持される。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/features/vta/utils/eventTimePoset.ts`, `layout.ts`, `eventRanks.ts`, `generatedLaneSequence.ts`, `eventAnalysis.ts`, `chainRepair.ts`
  - `src/tools/vta/services/generation/granularityRefinement.ts`, `granularityScore.ts`, `autoConnectionService.ts`
  - `src/tools/vta/services/llm/client.ts`, `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`, `src/tools/vta/features/vta/store/vtaStore.ts`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `tests/vta/eventTimePoset.test.ts`, `src/tools/vta/features/vta/utils/eventRanks.test.ts`, `layout.test.ts`, `eventAnalysis.test.ts`, `src/tools/vta/services/generation/granularityRefinement.test.ts`, `tests/vta/aiDiagnostics.test.ts`
