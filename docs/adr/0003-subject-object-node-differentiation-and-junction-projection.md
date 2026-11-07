# ADR-0003: 作用主体（能動）と受動客体のノード分離およびジャンクション投影

- **ステータス**: Accepted
- **決定日**: 2026-11-03
- **対象コンポーネント**: VTA Data Schema / Node Geometry / SVG Export / Lane Management
- **関連要件**: `docs/vta/REQUIREMENTS.md` (主体・客体の識別とジャンクション表示)

---

## 1. コンテキストと課題 (Context & Problem Statement)

VTA図において、複数主体が関与する相互作用イベント（例: 管制塔が指示を出し、機長がそれを受領する、または機器が信号を送り装置が作動する）を表現する際、能動的に行為を行った主体（`actor`）と、その行為を受け取った受動的な対象・客体（`target`, `affected`, `intended_recipient` 等）が存在する。

従来は、この双方のレーンに対して同じサイズの長方形カード（260px幅）が並んで描画されていた。その結果：
1. 多数の主体間で頻繁に連絡や相互作用が行われる事故シナリオにおいて、レーン内が冗長なカードで溢れ返り、認知負荷が極めて高くなる。
2. 「どちらが能動的に行動を起こし、どちらが単に影響・指示を受けた側なのか」が直感的に判別しにくい。
3. 一方で、受動側のカードを完全に非表示・削除してしまうと、客体側のタイムラインの因果連鎖や証拠参照が失われてしまう。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **認知的明瞭性の向上**:
   能動主体のアクションと受動客体の受領・被作用を視覚的に一瞬で区別できること。
2. **図面スペースの節約**:
   客体ノードをコンパクト化し、レーン間の視覚的ノイズを劇的に減らすこと。
3. **データ台帳との完全な往復整合性**:
   図面上の表示形式（カード vs ドット）を切り替えても、イベント台帳（`analysis.participations`）の根拠や因果関係を一切欠損させないこと。
4. **SVGベクター出力との完全一致**:
   ブラウザ上のReact Flowキャンバスだけでなく、出力されるSVGベクター図面でも寸分違わぬ同一の幾何形状・ハンドル位置・矢印ルーティングを再現すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 受動客体のカードを完全に非表示にする（Presentation hidden）**
  - デメリット: 客体が関与していた事実が見えなくなり、タイムラインの整合性が損なわれる（不採用）。
- **選択肢2: カードの背景色やラベルだけで区別する**
  - デメリット: カードサイズが260pxのままであり、空間的混雑が解消されない（不採用）。
- **選択肢3: 受動客体を円形ジャンクション（24×24pxドット）に投影する（採用）**
  - `entity_role: 'subject' | 'object'` を導入。
  - 客体ノードを専用のジャンクションノード（`vtaObjectJunction`）として投影し、ホバー・ツールチップで詳細内容を確認可能にする。

---

## 4. 決定事項 (Decision Outcome)

1. **データモデルの拡張 (`VTANodeData`, `VTAParticipation`)**:
   - `entity_role: 'subject' | 'object'` をノードデータに追加。
   - `object_display_style?: 'dot' | 'card'` により、ノード単位での個別表示切り替えを可能に。
   - `reconcileAnalysis` において、ユーザーがノードの `entity_role` を変更した場合は台帳の `role: 'actor'` または `'target'` へ双方向同期。
2. **ノード幾何と投影ロジック (`nodeGeometry.ts`)**:
   - `projectDisplayNode`: 客体ノードかつドット表示条件を満たす場合、React Flowノードタイプを `vtaObjectJunction`（24×24px、角丸半径8pxの円形インジケーター）へ変換。
   - `getDisplayRect`: ドット化時も元のカード中心位置と矢印接続点（アンカー）の整合性を保ち、障害物回避ルーティング（`routingObstacles`）を適用。
3. **UIおよびSVG対応**:
   - 専用コンポーネント [`VTAObjectJunctionNode.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/components/VTAObjectJunctionNode.tsx) を作成。
   - [`LaneManagementPanel.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/components/control-panel/LaneManagementPanel.tsx) に「受動客体ノードの表示形式（● ドット表示／🗂 通常カード表示）」のグローバル切替スイッチを配置。
   - [`svgExport.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/svgExport.ts) において、同等の二重円SVGベクター要素を出力。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 大規模事例（管制・パイロット・地上車両など多数の主体が交差するシナリオ）において、図面の視認性が劇的に向上した。
  - 能動的な判断・行動のカードが際立ち、事故原因となる事象の連鎖を追跡しやすくなった。
- **影響ファイル**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/features/vta/utils/nodeGeometry.ts`
  - `src/tools/vta/features/vta/components/VTAObjectJunctionNode.tsx`
  - `src/tools/vta/components/control-panel/LaneManagementPanel.tsx`
  - `src/tools/vta/features/vta/utils/svgExport.ts`
  - `tests/vta/subjectObjectNode.test.tsx`
