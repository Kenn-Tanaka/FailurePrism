# ADR-0051: クロスレーン逆行矢印（下方向接続）の幾何監査・時刻逆転提案抑止および同ランク垂直整列ポリシー

- **Status**: `Accepted`
- **Date**: `2026-11-19`
- **Target Components**:
  - `src/tools/vta/features/vta/utils/layout.ts` (`LayoutGeometryAudit`, `auditVTALayoutGeometry`, `calculateVTALayout`)
  - `src/tools/vta/features/vta/utils/connectionProposals.ts` (`validateSelectedConnectionProposals`)
  - `src/tools/vta/services/generation/granularityRefinement.ts` (`applyRefinementOps` / `normalizeCandidateRelation`)
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts` (`recordGraphProjectionDebug`)
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts` (`buildAIDiagnostics`)
- **Related Requirements / ADRs**:
  - [ADR-0034](./0034-row-cell-layout-and-matrix-event-time-dag.md)
  - [ADR-0045](./0045-intra-lane-sequence-dag-alignment-and-wiring-diagnostics.md)
  - [ADR-0046](./0046-cross-lane-wire-clearance-and-diagnostics-lineage.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

VTA ツリー（Bottom-to-Top 時系列配置）において、本来は「下から上（過去→未来）」または「水平（同ランク）」に向かうべきレーン間接続（クロスレーン矢印）に、**上から下へ向かう逆行矢印（`sourceCenterY < targetCenterY`）** が発生する事象が実機診断ログ（`2026-11-19T08:27:55.888Z`）から観測された。調査により以下の 3 つの構造的要因が特定された。

1. **接続提案（`connection-proposal`）の時刻逆転未検査**:
   `validateSelectedConnectionProposals` は先行関係（`transfer` / `dependency`）の循環（cycle）は検査していたが、`EventTimeDAG` 上ですでに「`targetEventId` が `sourceEventId` より厳密に過去（`before`）」と確定している時刻逆転提案を拒否していなかった。
2. **同ランク内の片側複数スタックによる高低差**:
   `calculateVTALayout` では、同一 `(lane, rank)` に複数カードが積まれたセル（`siblings.length > 1`）と単一カードのセル（`siblings.length === 1`）が同じ `rank` に並んだ場合、単一カード側は一律にランク中央へ配置される。そのため、複数スタック側の上段カードから単一カードへ矢印を引くと下方向へのドロップが発生し、逆に複数スタック側の下段カードへ単一カードから矢印を引くと同様に下方向へのドロップが発生していた。
3. **配線幾何監査の盲点**:
   `auditVTALayoutGeometry` が `if (edge.data?.is_cross_lane) continue;` としてクロスレーンエッジの逆行検査を完全にスキップしていたため、下方向のクロスレーン矢印が発生しても `layout.audit` および AI 診断パッケージに異常として記録されなかった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **Bottom-to-Top 時系列規約の一貫性**: VTA 図では Y 軸上方向（小さい Y 座標）が未来を表すため、有向の先行・伝達関係は原則として下から上または水平でなければならない。
- **保存済み座標と隣接ランクの境界保護**: 手動配置された `savedPosition` や `existingFallback` 座標を自動整列で破壊せず、自動配置の同ランク整列も当該ランクの垂直スパン `[rankBaseY, rankBaseY + rankHeight - height]` 内に厳密にクランプして隣接ランクや同レーンカードと重ならないことを保証する。
- **既存テスト・両方向エッジとの互換性**: 双方向（`bidirectional`）および無向（`undirected`）の `common` 関係や、明示的に指定された非整合テスト用トポロジを不当に壊さず、有向クロスレーン逆行のみを正確に検知・抑止する。

## 3. 検討した選択肢 (Considered Options)

1. **Option A: 提案検証 + 同ランク垂直整列 + クロスレーン逆行監査の 3 層統合（採用）**
   - `validateSelectedConnectionProposals` で `EventTimeDAG` により `targetEventId` が `sourceEventId` より `before` と証明済みの有向提案を拒否する。
   - `calculateVTALayout` で単一占有セル（`siblings.length === 1`、未保存座標）の Y 座標を同ランク内スパンの範囲でクロスレーン相手と整合させる。
   - `auditVTALayoutGeometry` と `aiDiagnostics.ts` に `backwardCrossLaneEdges` / `LAYOUT_BACKWARD_CROSS_LANE_EDGE` を追加して可視化する。
2. **Option B: 同ランクセルの垂直整列のみ行い、提案検証と監査は追加しない**
   - 異なるランク間の時刻逆転提案（`target` が過去ランク、`source` が未来ランク）による下向き矢印を止められず、再発時のログ検知もできないため不採用。
3. **Option C: クロスレーン矢印の発生元・発生先に強制的に新ランクを割り当てる**
   - `EventTimeDAG` 上で同時・同ランクであるべき事象（例: 同一時刻内の伝達）を不必要に別ランクへ引き剥がし、図の縦長化と時間認識の歪みを招くため不採用。

## 4. 決定事項 (Decision Outcome)

Option A を採用し、以下の設計を決定した。

1. **`validateSelectedConnectionProposals` / `granularityRefinement` での時刻逆転・自己ループチェック (`connectionProposals.ts`, `granularityRefinement.ts`)**:
   - `isPrecedence(relation)` かつ `sourceEventId !== targetEventId` の提案・追加/変更操作について、`EventTimeDAG` により `compareEventTimeById(..., targetEventId, sourceEventId, timeDag) === 'before'` が成立する場合は厳密な時刻逆転として拒否する。粒度反復では同一イベント・同一主体の自己ループ追加も併せて拒否する。
2. **`calculateVTALayout` での同ランク・クロスレーン垂直整列とオーバーハング余白 (`layout.ts`)**:
   - `savedPosNodeIds` / `existingFallbackNodeIds` に含まれないノードを対象に、単一占有セル（`siblings.length === 1`）とスタック上下端カードとの半高さオーバーハング（`rankTopPad` / `rankBottomPad`）を `rankHeightMap` に事前加算し、スタック側 `intraOffset` へ反映した上で、単一セル整列およびスタックセルの余白内一体シフトを 2 パス実行する。
3. **クロスレーン逆行監査・折り畳み関係の診断除外 (`layout.ts`, `eventAnalysis.ts`, `aiDiagnostics.ts`)**:
   - `LayoutGeometryAudit` に `backwardCrossLaneEdges` を追加し、`is_cross_lane` かつ有向エッジで `tgtCenterY - srcCenterY > 2` のエッジを `dropPx` とともに記録する。
   - `recordGraphProjectionDebug` で主体統合による自己ループ・共有カード（`group`）内折り畳み・`omittedEdges` / `ignored` イベント関係を `missingRelations` から除外し、真の投影欠落のみを報告する。
   - `buildAIDiagnostics` で `LAYOUT_BACKWARD_CROSS_LANE_EDGE` 異常を出力し、`layout.audit` の遷移 `counts.issues` および `notes`（`クロスレーン逆行=N`）に集計する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 同一時刻・同ランク内の複数スタックに起因する不要な下向きクロスレーン矢印が水平または上向きに整列し、視認性が向上する。
  - 時刻・因果が既に確定しているイベントに対する逆行接続提案を検証段階で遮断できる。
  - 残存する下向きクロスレーン矢印を `layout.audit` と AI 診断パッケージで即座に特定できる。
- **トレードオフ・考慮事項**:
  - 単一ノードが同一ランク内で上限・下限の相反する制約を受ける場合は、当該ランクスパン内へのクランプが優先されるため、エッジ側の物理的制約を完全にゼロにできないケースは `backwardCrossLaneEdges` 監査として報告される。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/layout.ts`
  - `src/tools/vta/features/vta/utils/connectionProposals.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/features/vta/utils/layout.test.ts`
  - `src/tools/vta/features/vta/utils/connectionProposals.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
