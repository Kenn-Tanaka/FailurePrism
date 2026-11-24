# ADR-0046: クロスレーン配線の離隔チャネル割当・水平バッジ非重複および診断リネージ厳格化ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-18
- **対象コンポーネント**: VTA Layout & Edge Routing (`edgeRouting.ts`, `layout.ts`), AI Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0038](file:///docs/adr/0038-direct-horizontal-cross-lane-edges.md), [ADR-0040](file:///docs/adr/0040-vertical-edge-label-shape-and-offset.md), [ADR-0045](file:///docs/adr/0045-intra-lane-sequence-dag-alignment-and-wiring-diagnostics.md)

## 1. コンテキストと課題 (Context & Problem Statement)
ADR-0045 により同一レーン内時系列線の整列は解消されたものの、レーン跨ぎ配線が密集する大規模図において以下の視覚・診断課題が残存していた。

1. **グローバル `routingOffset` の枯渇と Pass 1 無検査**: `routingOffset` が `crossLaneEdges` 全体の ID 辞書順に対して `-20..+20px` を等分していたため、30本規模のグラフでは隣接オフセット差が約 1〜2px となり、Case 2c の側面引き出しが最小値 `10px` に張り付いて隣接カード縁と干渉していた。また、Pass 1（異なる高さ・複数レーン横断）が既配置の線分・バッジを一切避けず、Pass 2 の `hasDetourHorizontalConflict` もしきい値が `<= 2px` と緩いため、複数の水平コリドー線・バッジ同士が正面衝突していた。
2. **水平バッジの固定中点配置**: Pass 3 は垂直線ラベルのみを Y 方向に逃がし、水平線ラベルは常に中点固定であったため、平行線間が近い場合にバッジ同士やノードとの重なりが解消されなかった。
3. **診断ログの盲点と誤マッチ**: `auditVTALayoutGeometry` がクロスレーン配線を監査対象外にしていたため重なりが `issues: 0` となり、`traceEntityLineage` は `rawText.includes(targetId)` の部分一致により関係 `R3` にイベント `E41`（説明文の `R3` ドア表記）を誤紐付けしていた。

## 2. 決定理由の要因・制約 (Decision Drivers)
- 単一エッジや競合のない水平直線では、既存の中点・基準座標（`getOrthogonalStepPath({ routeOffset: 0 })` 等）を完全に保持すること。
- Canvas (`VTAEdge.tsx`) と SVG エクスポート (`svgExport.ts`) が共有する `resolveVTAEdgePaths` のみで完結させ、描画負荷を増やさないこと。
- 診断ツール自身が誤ったエンティティ行や偽陰性の `issues: 0` を出力しないこと。

## 3. 検討した選択肢 (Considered Options)
- **選択肢1**: `routingOffset` の振幅だけを一律拡大する。
  - グラフ全体の位置関係を見ないため近接 ID 同士が別空間で無駄にずれ、同一コリドー内の衝突を防げないため却下。
- **選択肢2（採用）**: 4パス解決（Pass 0 レーン内縦幹 → Pass 1 競合回避コリドー／チャネル探索 → Pass 2 同高さ候補＋迂回探索 → Pass 3a 水平バッジ X スタッガード → Pass 3b 垂直バッジ Y シフト）および共通幾何監査・トークン境界 ID 照合への刷新。

## 4. 決定事項 (Decision Outcome)
1. **離隔定数と最小カード離隔**: `EDGE_VERTICAL_CLEARANCE_X = 14` を導入し、Case 2c 側面引き出し最小距離を `18px`（`spanX >= 90` 時、`routeOffset === 0` 時は従来通り `30px`）へ引き上げ、`hasDetourHorizontalConflict` を `EDGE_HORIZONTAL_CLEARANCE_Y = 12` 基準へ統一した。
2. **競合回避探索 (`pickConflictAwareCorridorPath`)**: Pass 1・Pass 2 共通で、`avoidCards` 適用後の最終セグメントとバッジ矩形に対し、ノード障害物・平行水平離隔・平行垂直離隔・水平バッジ衝突の重み付きスコアがゼロになるまで、コリドー Y トラック（ギャップ安全域内）およびチャネル X トラックを探索する。
3. **水平バッジ X 調整 (`resolveHorizontalLabelX`)**: 競合がない単一エッジは中点を維持しつつ、他バッジや障害物と衝突する場合のみホスト水平線分内で交差縦線・他バッジを避けた X 座標へスライドする。
4. **`auditVTALayoutGeometry` と `aiDiagnostics.ts` 拡張**: 平行水平近接・平行垂直近接・バッジ重複を監査結果と `layout.audit` 異常へ出力し、`traceEntityLineage` の台帳行照合を厳密 ID 一致優先・トークン境界判定へ修正した。

## 5. 結果と影響 (Consequences)
- **メリット**:
  - Pass 1・Pass 2 双方のクロスレーン配線とバッジが最小離隔距離（水平 `12px`、垂直 `14px`、側面カード余白 `18px`、バッジ非重複）を保って自動整列される。
  - `layout.audit` が実際のクロスレーン重なりを検知でき、`traceEntityLineage` の誤帰属が根絶される。
- **トレードオフ・考慮事項**:
  - 1コリドーギャップ（`90px`）内に4本以上の水平迂回線や非常に多数の平行線が集中した場合、候補探索は最小ペナルティのスロットを選択し、残余の近接は `layout.audit` に正確に記録される。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/edgeRouting.ts`
  - `src/tools/vta/features/vta/utils/layout.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/features/vta/utils/edgeRouting.test.ts`
  - `src/tools/vta/features/vta/utils/layout.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
