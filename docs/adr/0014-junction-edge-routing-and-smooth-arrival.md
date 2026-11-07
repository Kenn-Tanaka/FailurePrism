# ADR-0014: ドット表示ノード（客体・接続点）への配線幾何と手前屈曲の解消ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-06
- **対象コンポーネント**: VTA Edge Routing, Node Geometry, Layout Calculation, SVG Export
- **関連ドキュメント・コミット**: [ADR-0002](file:///docs/adr/0002-outcome-node-card-preservation-for-passive-objects.md), [ADR-0003](file:///docs/adr/0003-subject-object-node-differentiation-and-junction-projection.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

受動客体ノードをドット（Junction / 24px点ノード）として縮約表示させた際、左側の他レーンから当該ドットノードへ接続する情報伝達・物理影響等のエッジラインが、**ドットの手前約30pxの何もない空間で直角に上（または下）へ曲がり、そこから右へ曲がってドットに進入する不自然なクランク（屈曲）**が発生していた（ユーザー添付のスクリーンショット参照）。

### 原因の究明
1. **カード幾何とアンカー計算の不当な引き継ぎ**:
   - `VTAEdge.tsx` において、`nodes` から幾何マップ（`rects`）を構築する際、`getDisplayRect` を通さずに生のノードサイズ（幅260px、高さ140px、`isHidden: false`）をそのまま使用していた。
   - その結果、ドット表示ノードであるにもかかわらず、幅260pxのカードの左端（かつての受信用ハンドル位置: カード上端から62%の位置）に接続しようとし、ドットの中心（50%, 50%）との間に高さのズレが生じていた。
2. **端点ノードの自己障害物誤認**:
   - `routingObstacles` において、`!rect.isHidden` のノードを障害物として登録するチェックが、端点除外チェック（`id === source || id === target`）より先に実行されていた。
   - その結果、ドットノード自身が「幅260pxの仮想障害物カード」として誤登録され、線がドットの中心へ向かおうとすると衝突と判定されて `avoidCards` による仮想カード迂回（手前30pxでのクランク）が強制発動していた。
3. **多レーン跨ぎ（Case 2c）ルーティングの固定オフセット**:
   - `corridorPath` の多レーン跨ぎ（Case 2c）において、ターゲット直前の垂直移動座標が `x2 = targetX - 30`（ターゲットの30px手前）に固定されていた。
   - ターゲットがカード（幅260px）であればカード左端の隙間で曲がるため自然に見えるが、ターゲットがレーン中央にあるドット（幅24px）の場合、レーン中央の間近まで水平に入り込んでから直前30pxで急激に折れ曲がることになり、著しく不自然な配線となっていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **美しく直感的な直角配線（Orthogonal Wiring）**:
  - ドット表示は視覚的混雑を解消するために導入された機能であり、接続ラインもドットに向けて水平にスムーズに進入しなければならない。
- **カードからドットへの非破壊的一貫性**:
  - ユーザーがドットとカードを切り替えた際、座標系やアンカー位置が正しく切り替わり、自己衝突や不要な迂回が発生しないこと。
- **WebキャンバスとSVGエクスポートの完全一致**:
  - React Flow 上の `VTAEdge.tsx` と `svgExport.ts` の両方で同一の幾何・配線アルゴリズムが動作すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A (React Flow の標準 step エッジへフォールバック)**:
  - 自前直角配線をやめ、ライブラリ組み込みの step エッジを使う。
  - *評価*: レーン間コリドーやカード横断禁止ルール（ADR-0003）を維持できず、他レーンのカードの下を線が突き抜けてしまうため却下。
- **選択肢B (幾何計算・自己除外・ドット進入ルーティングの包括的刷新 - 採用)**:
  - `getDisplayRect` によるドットノードの幅24px・高さ24px・`isHidden: true` の完全一貫化。
  - `routingObstacles` で端点ノード（source/target）を最優先で自己除外。
  - `getOrthogonalStepPath` において、ターゲットがドットの場合は手前30pxのクランクを廃止し、レーン境界付近で曲がってドットへ水平にまっすぐ進入するルーティングへ刷新。

---

## 4. 決定事項 (Decision Outcome)

1. **`nodeGeometry.ts` の完全防御**:
   - `getDisplayRect`: すでに `vtaObjectJunction` または `vtaJunction` に変換済みのノードが渡された場合でも二重オフセットを防ぐガードを追加。
   - `routingObstacles`: `if (id === source || id === target) return [];` を先頭に配置し、端点ノード自身が障害物リストへ混入して自己衝突を起こす不具合を根本撲滅。
2. **`VTAEdge.tsx` の表示矩形統一**:
   - `rects` 構築時に `getDisplayRect(node, defaultObjectDisplayStyle)` を適用。ドット表示ノードのアンカーを中心座標に一致させ、`targetIsJunction` フラグを正しく伝播。
3. **`layout.ts` のドット進入配線刷新**:
   - `OrthogonalStepPathParams` に `targetIsJunction`、`sourceIsJunction` を新設。
   - ドットがターゲットの場合、`x2` のクランク位置をドット直前30pxではなく、レーン境界（ドットから70〜120px手前）へ後退させ、ドットの手前では完全な水平直線で美しく進入させる。
   - 同一高さ・同一ランクのドット接続では余計なコリドー迂回を廃止し、水平直線（Case 2a）で直結。
4. **SVGエクスポートの完全同期**:
   - `svgExport.ts` においても同一パラメータを渡し、SVG画像でも同様にクランクのない滑らかな直線で出力。

---

## 5. 結果と影響 (Consequences)

### メリット
- ドット表示ノードへのレーン間接続において、手前でカクッと曲がる不自然なクランクが完全に消滅し、レーン境界からドット中央へ水平に美しく吸い込まれる直線接続が実現。
- 自己ノードが障害物とみなされて `avoidCards` が誤発動する根本バグが解消。
- WebキャンバスとSVGエクスポートで配線幾何が100%同一であることが保証。

### 影響ファイル
- `src/tools/vta/features/vta/utils/nodeGeometry.ts`
- `src/tools/vta/features/vta/utils/layout.ts`
- `src/tools/vta/features/vta/components/VTAEdge.tsx`
- `src/tools/vta/features/vta/utils/svgExport.ts`
- `tests/vta/junctionEdgeRouting.test.ts`
