# ADR-0040: 縦線接続ラベルの上下方向スパイク形状化と交差回避垂直シフト

## メタデータ
- **ステータス**: Accepted
- **決定日**: 2026-11-17
- **対象コンポーネント**: `edgeLabels.ts`, `VTAEdge.tsx`, `svgExport.ts`, `layout.ts`, `edgeLabels.test.ts`, `VTAEdge.test.tsx`, `svgExport.test.ts`, `edgeRouting.test.ts`
- **関連要件 / ADR**: ADR-0037（4 端子入出力兼用化・接続ラベル方向表現）, ADR-0038（レーン跨ぎ同高さ水平直線・ラベル対線重なり許容）

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. ADR-0037 の段階では `resolveEdgeArrowOrientation` が `isCrossLane` フラグのみで左右向きを決定していたため、隣接レーン異高さクランク（`Case 2b`）の**垂直線分上**に乗るラベル（例: `作業依存`）も横向き矢印形状（`left` / `right`）で描画されていた。
2. また、垂直区間（`'up'` / `'down'` / `'vertical-both'`）も角丸カプセル＋小アイコン表現にとどまっており、水平線と縦線が交差した際、輪郭から「縦線所属の上下方向ラベル」か「横線所属の左右方向ラベル」かを直感的に判別しにくかった。
3. さらに、縦線ラベルが既定で線分中央（`50%`）に固定配置されるため、1 段飛ばしや同高さ水平線との交差高さにそのまま居座り、横線の情報ラベル等と視覚的に混同されやすかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **配置先線分（ホスト線分）の向きとの一致**:
   - 接続の意味（クロスレーン／レーン内）ではなく、ラベルが実際に載っている直交セグメント（水平線分／垂直線分）の向き・進行方向と一致した矢印形状を用いること。
2. **縦ラベルと横ラベルのシルエット差別化**:
   - 横ラベル（左右尖り五角・六角）に対し、縦ラベルは文字領域内の冗長アイコンを省き、左右をフラット／丸角としつつ上下中央に突き出した垂直スパイク（`▲` / `▼`）で方向を示すこと（Canvas CSS `clipPath` と SVG `<path>` で統一）。
3. **縦ライン上ラベルのみの非破壊シフト**:
   - 横ラインを無用に迂回させず（ADR-0038 方針を維持）、縦ライン上のラベルだけを同一垂直線分上で上下シフトして水平線交差・他バッジ・ノードを回避すること。交差がない通常時は中央（`50%`）を維持すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: 縦ラベルに補助アイコン（`↑`/`↓`）を残す＋交差有無を問わず常時 `35%` オフセット配置。
  - 小アイコンによる横幅増と非交差時の不均等配置が生じる。
- **選択肢B (採用)**: 外形上下スパイクのみで方向表現＋3 パス解決（Pass 3）による競合時垂直シフト。
  - 非交差時は中央維持で端正な外観を保ちつつ、交差・バッジ衝突・ノード接触がある場合のみ水平線・他バッジから垂直に明確退避する。

---

## 4. 決定事項 (Decision Outcome)

1. [`edgeLabels.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeLabels.ts) に [`findHostPathSegment`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeLabels.ts#L106) を追加し、`resolveEdgeArrowOrientation` が `(path, labelX, labelY)` を受け取った場合は垂直ホスト線分を `'up'` / `'down'` / `'vertical-both'` として解決する。
2. `'up'` / `'down'` / `'vertical-both'` に中央垂直スパイク（高さ `7px`、底辺 `16px`）付き `EDGE_LABEL_CLIP_PATHS` および SVG パスを定義し、内部の補助アイコンを廃止する。[`computeEdgeBadgeRects`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeLabels.ts#L334) はスパイク突出分を含めた占有矩形を算出する。
3. [`resolveVTAEdgePaths`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/layout.ts) を 3 パス化し、Pass 2 の横線判定が仮配置縦ラベルで誤迂回しないようにしたうえで、Pass 3 で縦線ラベルの `labelY` を水平交差線・確定バッジ・ノードを回避する位置へ移動する。
4. [`VTAEdge.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTAEdge.tsx) と [`svgExport.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/svgExport.ts) の双方がパス情報付きで方向解決を呼び出すよう統一する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 縦線（`作業依存` 等の `Case 2b` やレーン内接続）と横線（`情報` 等）が交差しても、ラベル位置が交差点から縦線側へ自動で離れ、かつ上下スパイク形状によって所属線と方向が一目瞭然となる。
  - 横線をまっすぐ維持しつつラベル同士の重なりも回避できる。
- **トレードオフ・考慮事項**:
  - 長さ `64px` 未満の極短垂直線分では移動余地が限られるため、Pass 2 側で固定バッジとして衝突考慮を残している。
  - `Case 2b` クロスレーン縦セグメントの `data-arrow-orientation` が実形状基準（`'up'` / `'down'`）に変化したのに合わせ、SVG・UI テスト期待値を更新した。
- **影響を受けるファイル・テスト**:
  - [`src/tools/vta/features/vta/utils/edgeLabels.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeLabels.ts)
  - [`src/tools/vta/features/vta/components/VTAEdge.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTAEdge.tsx)
  - [`src/tools/vta/features/vta/utils/svgExport.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/svgExport.ts)
  - [`src/tools/vta/features/vta/utils/layout.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/layout.ts)
  - [`src/tools/vta/features/vta/utils/edgeLabels.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeLabels.test.ts)
  - [`src/tools/vta/features/vta/components/VTAEdge.test.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTAEdge.test.tsx)
  - [`src/tools/vta/features/vta/utils/svgExport.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/svgExport.test.ts)
  - [`src/tools/vta/features/vta/utils/edgeRouting.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/edgeRouting.test.ts)
