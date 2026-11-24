# ADR-0037: VTAノード接続端子の入出力兼用4端子化および接続ラベルによる方向表現

## メタデータ
- **ステータス**: Accepted
- **決定日**: 2026-11-17
- **対象コンポーネント**: `VTACanvas.tsx`, `VTANode.tsx`, `VTAJunctionNode.tsx`, `VTAObjectJunctionNode.tsx`, `VTAEdge.tsx`, `edgeHandles.ts`, `edgeLabels.ts`, `layout.ts`, `vtaStore.ts`, `svgExport.ts`, `animatedSvgExport.ts`, `edgeRouting.test.ts`, `layout.test.ts`, `laneOrder.test.ts`, `VTANode.test.tsx`, `edgeLabels.test.ts`, `svgExport.test.ts`
- **関連要件 / ADR**: `docs/vta/REQUIREMENTS.md`, ADR-0014（ドット表示ノード接続幾何）

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. 従来の VTA ノード（`VTANode`, `VTAJunctionNode`, `VTAObjectJunctionNode`）は、上下に `top`（送信）・`bottom`（受信）、左右側面に `left-source` / `right-source`（高さ `38%`）と `left-target` / `right-target`（高さ `62%`）の計 6 端子を備えていた。
2. 左右辺それぞれに送信用・受信用の 2 ドットが表示されるため、カードの見た目が煩雑になり、手動ドラッグ接続時にも送信・受信ドットを取り違えやすい課題があった。
3. 視認性への改善効果を実機図面で評価するため、ノードの上下左右 4 端子を入出力兼用に統合した版を試作・反映する（視認性が向上しない場合は従来 6 端子方式へ差し戻す前提で `Proposed` とする）。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **`ConnectionMode.Loose` による入出力兼用接続**:
   - `@xyflow/react` の `connectionMode={ConnectionMode.Loose}` を有効化し、4 端子（`top`, `bottom`, `left`, `right`）すべてを `type="source"` として配置することで、どの端子間でも双方向のドラッグ開始・接続受付を可能にすること。
2. **VTA 因果フロー・配線幾何との整合**:
   - Canvas (`VTAEdge`), SVG 出力 (`svgExport.ts`), アニメーション SVG (`animatedSvgExport.ts`) は共通の `getEdgeAnchor` およびハンドルプレフィックス（`.split('-')[0]`）に依存しているため、ハンドル ID を `top` / `bottom` / `left` / `right` とし左右側面の高さを中央 `50%` (`CROSS_LANE_HANDLE_Y = 0.5`) へ統一すること。
   - 手動接続時の向き・位置割り当ては既存 `onConnect` の「同一レーンは `top -> bottom`、異レーンは `right <-> left`」正規化を引き継ぎ、接続方向ルールを崩さないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: 従来の 6 端子（左右 `0.38 / 0.62` 分離 + Strict 接続）を維持**
  - *長所*: 同一側辺で送受信が競合する場面で矢尻と出発線の重なりを避けられる。
  - *短所*: 左右に 2 点ずつ端子が表示され、UI が煩雑で水平接続が段差になりやすい。
- **選択肢B (試作反映): 4 端子入出力兼用（`ConnectionMode.Loose` + 左右 `50%` 中央配置）**
  - カード外周の端子数を 4 点に削減し、同一行の横方向配線を中央で一直線に揃えて視認性を検証する。

---

## 4. 決定事項 (Decision Outcome)

1. `VTACanvas.tsx` に `connectionMode={ConnectionMode.Loose}` を指定する。
2. `VTANode.tsx`, `VTAJunctionNode.tsx`, `VTAObjectJunctionNode.tsx` の端子を `bottom`, `top`, `left`, `right` の 4 個（すべて `type="source"`）へ統合する。
3. `edgeHandles.ts` に `CROSS_LANE_HANDLE_Y = 0.5` を定義し、`CROSS_LANE_SOURCE_HANDLE_Y` / `CROSS_LANE_TARGET_HANDLE_Y` を `0.5` に揃える。
4. `layout.ts` および `vtaStore.ts`（`onConnect`）が生成する異レーンハンドル名を `right` / `left` に統一する。
5. `edgeLabels.ts` を新設し、Canvas（`VTAEdge.tsx`）と SVG / アニメーション SVG 出力（`svgExport.ts` / `animatedSvgExport.ts`）の双方で、接続ラベルの外形自体を実向きに応じた矢印タグ形状（右向き / 左向き / 両向き / 同一レーン縦矢印 / 無向カプセル）として描画する。

---

## 5. 結果と影響 (Consequences)

### メリット
- カード側面ドットが各辺 1 個になり外観が簡潔化されるとともに、手動接続時に送信用・受信用ハンドルを選ぶ負担がなくなる。
- 同順位（同一 Y 位置）ノード間の水平接続が中央 `50%` 同士で一直線になる。
- ノード端の矢尻に加え線上の接続ラベル形状自体でも向きを判別でき、同一側辺での入出力集約時にも因果方向を即座に読み取れる。

### トレードオフ・確認ポイント
- 同一カードの同じ側辺に入力と出力の両方が接続された場合は、端点が中央一点に集まるが、線上の接続ラベル形状により伝達方向を補完判別する運用とする。
- 実機評価を経て視認性改善が確認されたため `Accepted` とし、`docs/vta/REQUIREMENTS.md` へ反映済み。
