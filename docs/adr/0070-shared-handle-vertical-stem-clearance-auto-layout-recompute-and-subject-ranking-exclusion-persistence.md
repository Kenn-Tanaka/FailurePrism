# ADR-0070: 共有ハンドル発クロスレーン垂直ステムの14px格子分離・自動レイアウト再計算同期および主体ランキング excluded 永続化ポリシー

- **Status**: Accepted
- **Date**: 2026-11-22
- **Target Components**: `src/tools/vta/features/vta/utils/edgeRouting.ts`, `src/tools/vta/features/vta/utils/layout.ts`, `src/tools/vta/features/vta/store/vtaStore.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- **Related Requirements / ADRs**: ADR-0051, ADR-0062, ADR-0066, ADR-0068, ADR-0069

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線新鹿沼駅構内触車事故の診断トレース（`2026-11-21T20:25:01.850Z`）において、以下の3点の課題が確認された。

1. **同一サイドハンドルから出る複数クロスレーン線の垂直ステム近接（`LAYOUT_CLOSE_VERTICAL_EDGES`: `coord_a=1980, coord_b=1992, gap_px=12`）**:
   - `pickConflictAwareCorridorPath` のチャネルオフセット配列に `-12` および `minSideStem=18` で `-12` と同一座標にクランプされる `-16` が含まれており、基準ステム `30px`（`x=1980`）と `18px`（`x=1992`）の間隔が `12px`（閾値 `EDGE_VERTICAL_CLEARANCE_X = 14px` 未満）となっていた。
   - `edgeRouting.ts` の `hitsVerticalBand` が等号込み（`>= band.minX && <= band.maxX`）で判定していたため、本来合法なちょうど `14px` 離隔のチャネル（`x=1966`）が誤ブロックされていた。
   - 同高さ迂回時（`avoidHorizontalBand` が `sourceY` を覆う状態）に始点・終点スタブが `extraAvoidVerticalBands` 内部に入ると、水平・垂直の双方に動けず `runSearch(true)` がデッドロックして `runSearch(false)`（垂直離隔無視）へ脱落していた。
   - さらに自動レイアウト状態で Stage 5（仮判定一括採用によるカード高さ変化）等の `commitVTAChange` が `forceRecompute: true` なしで呼ばれた際に古い `position.y` が固定され、DOM 寸法反映時も `relaid.edges` が更新されていなかった。
2. **`validateSavedAnalysis`（`readSubjectRanking`）における `excluded`・`parentEntityIds` 等の欠落**:
   - `rankSubjects` が付与した `excluded: true`（0関与上位組織 `S_TRAIN` 等）や `mergeBlockedReason`・`isInfluential`・複数親 `parentEntityIds` が `readSubjectRanking` でコピーされず消失し、診断パッケージ上で除外済み主体が未統合の保持主体に見えていた。
3. **`chain.repair` 診断ノートの差分内訳不足**:
   - `chain-repair.validation` の内訳ノートが `関係追加` と `要確認` のみを集計し、`追加主体`・`追加イベント`・`割当追加` の件数を表示していなかった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **カード外枠マージン不変条件（`>= 18px`）の維持**: 矢印マーカーおよび屈曲角がカード境界に接触しないよう、`minSideStem = 18` は引き下げないこと。
- **隣接レーン同高さ逆向き迂回の保護**: `avoidHorizontalBand` 自体を緩めて `120px` の隣接ギャップを水平直結させないこと。
- **手動・明示座標の保護**: `commitVTAChange` に `nodes` が明示指定されている場合やスキーマに保存座標がある場合は、既存座標を破壊しないこと。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A**: `minSideStem` を `16px` に下げ、両端 `95px` の水平セグメントを `avoidHorizontalBand` から免除する。
  - 却下理由：`18px` のカード外枠マージン契約に違反し、さらに隣接レーン（幅 `120px`）で `95 + 95 > 120` となって水平禁止帯を貫通破壊するため自己レビューで却下。
- **選択肢 B（採用）**: `minSideStem = 18` と `hitsAvoidBand` を厳格に維持したまま、外向き `14px` 等間隔チャネル `[0, 14, 28, 42, 56, 70, -12]` の優先探索、`hitsVerticalBand` の厳密不等号化、スタブ先端座標自体の禁止帯外シフト（上限 `0.45 * spanX`）、Phase C の直積探索、および `!nodes && !hasSavedPositions` 時の `forceRecompute: true` を導入する。

## 4. 決定事項 (Decision Outcome)

1. **`edgeRouting.ts` の垂直離隔厳密化とスタブ脱出**:
   - `hitsVerticalBand` を厳密不等号（`a[0] > band.minX + 0.01 && a[0] < band.maxX - 0.01`）に修正し、`extraBandXs` に合法境界 `[b.minX, b.maxX]` と `original` の中間座標を追加した。
   - `runSearch(true)` 開始時に `start` / `end` が `extraAvoidVerticalBands` 内にある場合、`[18, min(100, floor(spanX * 0.45))]` の範囲で最寄りの禁止帯境界へスタブ先端をシフトし、同高さ迂回時のデッドロックを解消した。
2. **`layout.ts` のチャネルオフセット整理と Phase C 同時探索**:
   - Case 2b オフセットを `[-16, 16, -30, 30]`、Phase B の `outOffsets` / `inOffsets` を `[0, 14, 28, 42, 56, 70, -12]` に整理し、単一軸探索で解消しない場合に `(corridorOffsetY, outChannelOffset)`＋終点ステムの Phase C 探索を実行するようにした。
3. **`vtaStore.ts` の自動レイアウト再計算同期**:
   - `commitVTAChange` で `!nodes && !hasSavedPositions` のとき `{ forceRecompute: true }` を渡し、`onNodesChange` の DOM 寸法再計算時に `edges: relaid.edges` も同期更新した。
4. **`eventAnalysis.ts` ＆ `aiDiagnostics.ts` のデータ保持と診断内訳拡充**:
   - `readSubjectRanking` で `excluded`・`mergeBlockedReason`・`isInfluential` および検証済み `parentEntityIds` を保持し、`aiDiagnostics.ts` の `chain.repair` 内訳ノートに非ゼロの `主体`・`イベント`・`割当` 件数を追加した。

## 5. 結果と影響 (Consequences)

### メリット
- 120px レーン間ギャップ内でカード境界から `>= 18px`、線間 `>= 14px` を満たす最大6本の外向き垂直トラックが衝突なく割り当てられ、共有ハンドル発の複数エッジでも `LAYOUT_CLOSE_VERTICAL_EDGES` が発生しない。
- `validateSavedAnalysis` 通過後も `S_TRAIN` 等の除外済み親組織が `excluded: true` として正確に保持・診断出力される。

### トレードオフ・考慮事項
- Phase C は Phase A/B で衝突が残ったエッジにのみ発動し、上位5×5＋終点走査（上限約30評価、衝突ゼロで即時終了）に制限しているため通常時の描画性能への影響は無視できる。

### 影響ファイル
- `src/tools/vta/features/vta/utils/edgeRouting.ts`
- `src/tools/vta/features/vta/utils/layout.ts`
- `src/tools/vta/features/vta/store/vtaStore.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `src/tools/vta/features/vta/utils/edgeRouting.test.ts`
- `src/tools/vta/features/vta/utils/subjectRanking.test.ts`
- `tests/vta/aiDiagnostics.test.ts`
