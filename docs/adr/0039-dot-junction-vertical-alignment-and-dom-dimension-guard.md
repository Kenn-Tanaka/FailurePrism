# ADR-0039: ドット表示ノードの垂直中心整列および DOM 実測寸法ガード

## メタデータ
- **ステータス**: Accepted
- **決定日**: 2026-11-17
- **対象コンポーネント**: `nodeGeometry.ts`, `layout.ts`, `VTACanvas.tsx`, `vtaStore.ts`, `svgExport.ts`, `laneConnections.ts`, `connectionRepairPlan.ts`, `junctionEdgeRouting.test.ts`, `vtaStore.test.ts`
- **関連要件 / ADR**: ADR-0003（受動客体ジャンクション投影）, ADR-0014（ドット表示接続幾何）, ADR-0038（同高さ直接水平接続）

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. 受動客体ドット（`VTAObjectJunctionNode`: 24×24px）および非表示接続点（`VTAJunctionNode`: `is_hidden: true`, 20×20px）へ接続する同ランクの横線が、直線ではなくクランク状の迂回線として描かれる問題が発生していた。
2. 原因調査により以下の不整合が判明した：
   - [`layout.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/layout.ts) の `computedY` が `is_hidden` のみ元のカード上端オフセット `-(cardHeight - size) / 2` を相殺し、受動客体ドット（`isObjectDot`）で相殺が抜けていたため、`getDisplayRect` により二重に下方オフセット（高さ 140px 時 `+58px`）されていた。また `schema.analysis` なしの図では `is_hidden` の単独行中央寄せも行われず上へ `-60px` ズレていた。
   - [`VTACanvas.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTACanvas.tsx) と [`vtaStore.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/store/vtaStore.ts) が `dimensions` 除外・ドラッグ逆投影を `is_hidden` のみに限定していたため、`VTAObjectJunctionNode` の `24×24` 実 DOM 寸法でストア上のカード高さが上書きされていた。
   - 自動配置状態（`position` 未保存）での初回 DOM 実測による他カード高さ増減時に、同ランク内のドット中心が追従再整列されなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **単一座標不変条件の徹底**: ストア・`layout.Nodes` 上の `position` は通常カード・非表示ドット・受動客体ドットのいずれであっても「元カードサイズ (`cardHeightOf`) の左上」を表し、ドット投影後の視覚的中心が同ランクカードの中心と一致すること。
- **カード↔ドット間の可逆性**: 表示形式の切り替え・ドラッグ移動（詳細/見出しのみ）・保存/再読込のすべてで視覚中心が保持されること。
- **手動配置の非破壊**: 既にユーザー座標 (`node.position`) が保存されている図や、変更のない `dimensions` イベントで無断再配置・誤 `isDirty` を起こさないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: 受動客体ドットをカード座標基準から切り離し、`24×24` 固定サイズとして特別扱いする
  - 表示形式を `card` / `dot` で切り替えた際の座標復元と既存 `nodeGeometry.ts` 契約が複雑化する。
- **選択肢B (採用)**: 全ドット（`isDotProjectedNode`）に統一的なカード中心基準オフセット・DOM 寸法保護・ドラッグ逆投影・未保存時の実測高さ再整列を適用する
  - 非表示ドット（`is_hidden`）と受動客体ドット（`vtaObjectJunction`）の幾何モデルが完全に一致し、詳細・コンパクト・SVG 出力で誤差 `0px` の直線接続が得られる。

---

## 4. 決定事項 (Decision Outcome)

1. `nodeGeometry.ts` に `isDotProjectedNode` を新設し、ドット投影ノード（`is_hidden` および `shouldDisplayAsObjectJunction`）の保護対象判定を一元化する。
2. `layout.ts` の `calculateVTALayout` で `isDot` 全体に対し同ランク中央寄せ＋`-(cardHeightOf - dotSize) / 2` 相殺を適用し、`enforceLaneVerticalSpacing` 等にも `defaultObjectDisplayStyle` を伝播する。また共有ポート許容スタブ長をドット間チャネル（`LANE_WIDTH * 0.6`）まで拡張する。
3. `VTACanvas.tsx` と `vtaStore.ts` で全ドット投影ノードの `dimensions` 上書きをブロックし、詳細/コンパクト双方で `unprojectDraggedPosition` を適用する。
4. `vtaStore.ts` の `onNodesChange` で未保存自動配置中に有意（`>= 0.5px`）な DOM 高さ更新があった場合は `isDirty` を立てずに `calculateVTALayout` で同ランク整列を再同期し、`updateNode` で通常カードから受動客体ドットへ手動切替した場合も `estimateNodeHeight` 基準へ中心正規化する。

---

## 5. 結果と影響 (Consequences)

- **メリット**: 受動客体ドット・非表示ドットを端点とする同ランク接続線が、Canvas（詳細/コンパクト）および SVG でクランクなしの水平直線として一貫描画される。
- **トレードオフ・考慮事項**: 不具合修正前の古いプロジェクト JSON に保存された `node.position` がある場合は手動位置保護のため自動移動しないが、ツールバー「BT自動整列」1 回で即座に正しい水平位置へ再整列できる。
- **影響を受けるファイル・テスト**:
  - [`src/tools/vta/features/vta/utils/nodeGeometry.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/nodeGeometry.ts)
  - [`src/tools/vta/features/vta/utils/layout.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/layout.ts)
  - [`src/tools/vta/features/vta/components/VTACanvas.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTACanvas.tsx)
  - [`src/tools/vta/features/vta/store/vtaStore.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/store/vtaStore.ts)
  - [`src/tools/vta/features/vta/utils/svgExport.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/svgExport.ts)
  - [`src/tools/vta/features/vta/utils/laneConnections.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/laneConnections.ts)
  - [`src/tools/vta/features/vta/utils/connectionRepairPlan.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/connectionRepairPlan.ts)
  - [`tests/vta/junctionEdgeRouting.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/tests/vta/junctionEdgeRouting.test.ts)
  - [`src/tools/vta/features/vta/store/vtaStore.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/store/vtaStore.test.ts)
