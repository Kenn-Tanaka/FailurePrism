# ADR-0038: レーン跨ぎ同高さノード間の直接水平接続と多辺非重複ルーティング

## メタデータ
- **ステータス**: Accepted
- **決定日**: 2026-11-17
- **対象コンポーネント**: `edgeRouting.ts`, `edgeLabels.ts`, `layout.ts`, `VTAEdge.tsx`, `svgExport.ts`, `animatedSvgExport.ts`, `edgeRouting.test.ts`, `VTAEdge.test.tsx`
- **関連要件 / ADR**: ADR-0014（ドット表示ノード接続幾何）, ADR-0037（4 端子入出力兼用化・接続ラベル方向表現）

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. ADR-0037 でノード側面の接続端子を高さ `50%` に一本化したことで、隣接レーンの同高さノード間（`Case 2a`）はクランクのない直線で結ばれるようになった。
2. 一方で 2 レーン以上を跨ぐ接続線（multi-lane spanning）では、中間レーンに障害物カードも干渉する他線もない場合であっても [`corridorPath`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/layout.ts) の `Case 2c` により常に上下段間（`corridorY`）を迂回する 5 セグメント線になっており、視認性に改善余地があった。
3. また、同高さノード間に独立した逆向きの 2 本（例: `A → C` と `C → A`、属性・分類・BREAK 設定が異なるケース）が存在する場合、両方が無条件に直結されると線・矢印ラベル・BREAK バッジが重畳する問題があった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **ノードおよび接続ラベルの視覚的非干渉**:
   - 直線本体（`WIRE_NODE_CLEARANCE_Y = 4px`）だけでなく、線中央の接続ラベル（通常高さ `24px`、BREAK 時・SVG 2 段配置を含む [`computeEdgeBadgeRects`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeLabels.ts) の矩形）も中間ノードへ重ならないこと。
2. **他接続線・接続ラベル間の非重複と「ラベル対線」重なりの許容**:
   - 他接続線の水平線分および接続ラベル・BREAK バッジ同士の重畳（`badge vs badge`）とノード・ドット上へのラベル重なりは禁止しつつ、同じノード側面 `50%` 端子から別段へ伸びる短い折返し前スタブ（共有ポート分岐）と、**接続ラベルと接続線との重なり（`badge vs wire` / `wire vs badge`）は許容**すること。
   - 垂直線分との `+` 字直交交差については、**案α**（水平線重畳・ラベル同士の衝突は禁止し、垂直線分とは「迂回によって線同士の `+` 字交差数を実際に低減できる場合」のみ迂回し、通し縦時系列線のように迂回しても交差が残る場合は直線を維持。ラベルと垂直線の重なりは許容）を採用すること。
3. **逆向き独立 2 本の分離（データ保持と非重複の分離）**:
   - 独立した 2 本（`label`, `category`, `is_break`, `meaning`, `relationId` が独立）は意味・整合診断上 `bidirectional` 1 本へ無条件統合できないため、隣接 `Case 2a` とレーン跨ぎの双方で 1 本目（短スパン・低 ID 優先）を直線、2 本目を迂回（`avoidHorizontalBand` による退避保証付き）とすること。
4. **決定論性と Canvas / SVG 一貫性**:
   - 描画順に依存せず Canvas (`VTAEdge.tsx`)・SVG (`svgExport.ts`)・アニメーション SVG (`animatedSvgExport.ts`) で完全に同一の経路を生成すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: 垂直線との `+` 字交差も厳格禁止（案β）＋跨ぎのみ判定**
  - 中間レーンの通し縦線 1 本と直交するだけで無意味な 5 セグメント迂回が増え、また隣接逆向きペアの重なりを解消できない。
- **選択肢B (採用): 2 パス決定論リゾルバ `resolveVTAEdgePaths` ＋ 案α ＋ バッジ余白判定 ＋ 隣接重複含む 5 セグメント退避**
  - Pass 1（垂直線・異高さ線）を先に確定し、Pass 2（同高さ横接続：隣接＋跨ぎ）をスパン昇順・ID 昇順で貪欲に直結判定する。直結不可時は `forceCorridorDetour`＋`avoidHorizontalBand` により確実にコリドー迂回へ逃がす。

---

## 4. 決定事項 (Decision Outcome)

1. `edgeLabels.ts` に `computeEdgeBadgeRects` を追加し、Canvas/SVG 双方のバッジ占有矩形（BREAK 二段含む）を統一算出する。
2. `edgeRouting.ts` に水平帯検査（`horizontalBandBlocked`）、線分矩形判定、および迂回経路探索が disallowed 水平帯へ戻らないための `avoidHorizontalBand` 制約を追加する。`avoidCards` は多折れ迂回の始端・終端スタブ（特に `targetMargin` によるドット `110px` 水平進入）を `avoidHorizontalBand` 違反として誤検出しないよう内部橋渡し区間のみを検査する。
3. `layout.ts` の `corridorPath` / `getOrthogonalStepPath` を同高さ多レーン直結＋狭小チャネル比例スケール対応に拡張し、全図面一括の 2 パス配線解決関数 `resolveVTAEdgePaths` を導入する。線とラベルの重なりは `hasStraightHorizontalConflict` / `hasDetourHorizontalConflict` / `countVerticalCrossings` の抑止対象から外し、ラベル同士・水平線同士・回避可能な線同士の縦交差に判定を限定する。
4. `VTAEdge.tsx`（WeakMap キャッシュ付き共有解決）および `svgExport.ts` の双方が `resolveVTAEdgePaths` を共通利用するよう統合する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 2 レーン以上離れた同高さノード間でも、障害物・競合線・回避可能交差がなければ簡潔な直線で結ばれ、図面の視認性が大幅に向上する。
  - 接続ラベルや BREAK バッジが中間カードや他ラベルに被るケース、および同高さ逆向き 2 本（隣接・跨ぎ両方）の完全重複が自動で回避される。
  - Canvas と静的 SVG / アニメーション SVG の配線形状が完全に一致する。
- **トレードオフ・考慮事項**:
  - 隣接 `Case 2a` でも同高さの独立 2 本が重畳する場合、2 本目は上段コリドー（5 セグメント迂回）を取る。
  - 独立 2 本をデータ上の 1 本の `bidirectional` へ変換したい手動操作導線（`onConnect` 確認ダイアログ等）は別検討事項としてスコープ外に留める。
- **影響を受けるファイル・テスト**:
  - [`src/tools/vta/features/vta/utils/edgeLabels.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeLabels.ts)
  - [`src/tools/vta/features/vta/utils/edgeRouting.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeRouting.ts)
  - [`src/tools/vta/features/vta/utils/layout.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/layout.ts)
  - [`src/tools/vta/features/vta/components/VTAEdge.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTAEdge.tsx)
  - [`src/tools/vta/features/vta/utils/svgExport.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/svgExport.ts)
  - [`src/tools/vta/features/vta/utils/edgeRouting.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeRouting.test.ts)
  - [`src/tools/vta/features/vta/components/VTAEdge.test.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTAEdge.test.tsx)
  - [`tests/vta/junctionEdgeRouting.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/tests/vta/junctionEdgeRouting.test.ts)
