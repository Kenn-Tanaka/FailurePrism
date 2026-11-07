# ADR-0006: VTAツリーの動的リプレイ可視化と純粋CSS内蔵Animated SVG出力

- **ステータス**: `Accepted`
- **決定日**: 2026-11-04
- **対象コンポーネント**: VTA UI / Canvas / Animation Sequencer / SVG Export Engine
- **関連ドキュメント・コミット**: [ADR-0001: 2段階イベント分類と仮判定一括採用](file:///docs/adr/0001-two-stage-event-classification-and-batch-adoption.md), [ADR-0003: 作用主体と受動客体のノード分離](file:///docs/adr/0003-subject-object-node-differentiation-and-junction-projection.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

バリエーションツリー分析（VTA）は、複数アクターの行動連鎖（時間経過軸: 下→上）と因果関係（矢印）が複雑に交差する有向非巡回グラフ（DAG）構造をとります。

このため、完成した静止図面だけでは以下の課題がありました：
1. **事故推移の把握の難しさ**: 「どのアクターのどのような行動が引き金となり、どのように他レーンに波及してインシデント・不具合に至ったか」の時系列順序を他者や経営層、調査委員会に説明・プレゼンテーションする際の認知的負担が大きい。
2. **AI推論プロセスの透明性**: AIによる自動生成（全文正規化 $\rightarrow$ 粒度反復最適化 $\rightarrow$ 自動接続 $\rightarrow$ 変動要因判定）がブラックボックスになりやすく、「ツールがどのようにVTA図を構築したか」の推論プロセスを評価・解説する可視化が求められていた。
3. **外部資料への埋め込み・共有の制約**: 動的なアニメーションをPowerPointスライドや報告書、Webブラウザへ共有する際、動画（MP4/WebM/GIF）ではベクター画像の鮮明さが損なわれファイルサイズが肥大化し、一方JavaScriptを含むSVGではセキュリティポリシーやOffice埋め込み環境でスクリプト実行が遮断されて静止してしまう。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **2つの独立した可視化目的の分離**:
  - **モード①【事故因果リプレイ (Causal Flow)】**: 事故の物理的時間と因果関係に沿った発生推移の可視化（事故調査報告・説明会用）。
  - **モード②【AI推論進化リプレイ (Pipeline Evolution)】**: AIの推論ステージ（正規化・最適化・自動接続・要因判定）推移の可視化（アルゴリズム解説・品質評価用）。
- **完全自律再生と外部スクリプト非依存 (Zero-Script, Zero-Dependency)**:
  - SVGファイル内に JavaScript（`<script>`）を一切含めず、純粋な宣言的 CSS `@keyframes` のみで無限ループ再生を実現する。
  - セキュリティ制限の厳しい社内PCやPowerPoint、ブラウザでもそのまま再生できること。
- **折れ線矢印の幾何的伸長アニメーション**:
  - `getOrthogonalStepPath` が生成する直角折れ線パスから幾何長 $L = \sum \sqrt{\Delta x^2 + \Delta y^2}$ を高精度に算出し、`stroke-dasharray: L; stroke-dashoffset: L;` による滑らかな伸長描画を行う。
- **観察のための静止ホールド期間 (Hold Period)**:
  - 全要素が出現・接続した後に、全体像をじっくり観察できる静止ホールド期間（標準4.0秒）を周期 $T$ の終盤に確保すること。
- **UIシームレス統合**:
  - キャンバス画面下部のフローティングバー（再生/一時停止、シークバー、再生速度切替、モード切替、SVG保存）と、SVG出力モーダル（静的/動的トグル、モード選択）の双方から直感的に操作できること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 動画形式（MP4 / WebM / GIF）へのエクスポート**
  - *問題点*: 画質がビットマップ化して拡大時にぼやけ、キャンバス解像度やファイルサイズが肥大化。ブラウザ側のエンコード負荷が高い。
- **選択肢2: SMIL（Synchronized Multimedia Integration Language）によるSVGアニメーション**
  - *問題点*: 一部ブラウザやビューアーでの互換性にばらつきがあり、将来的な非推奨リスクがある。
- **選択肢3: JavaScriptを内蔵した対話的SVG**
  - *問題点*: PowerPointのスライド挿入時やセキュリティ保護された環境でスクリプトの実行がブロックされ、静止画となってしまう。
- **選択肢4: 純粋CSS `@keyframes` を `<defs><style>` に内蔵した Animated SVG（採用）**
  - *利点*: スクリプト完全不要。100%ベクター品質。PowerPointや最新ブラウザでネイティブに自律ループ再生が可能。

---

## 4. 決定事項 (Decision Outcome)

以下のアーキテクチャにより、キャンバス上の動的プレビューと純粋CSS内蔵Animated SVG出力を実現しました：

```
[VTA Data Schema]
       │
       ├── Mode ①: Causal Flow (トポロジカル因果ソート + 時間軸)
       └── Mode ②: Pipeline Evolution (4段階推論ステージ)
       │
[animationSequencer.ts]
  ├── computeNodeRanks: 有向DAGトポロジカル順序計算
  ├── computeSVGPathLength: 折れ線幾何パス長 L 算出
  └── buildCausalFlowSequence / buildPipelineEvolutionSequence: タイムライン構築
       │
       ├─────────────────────────────────┬─────────────────────────────────┐
       ▼                                 ▼                                 ▼
[VTAAnimationPlayerBar.tsx]       [VTACanvas.tsx]                 [animatedSvgExport.ts]
  キャンバス下部フローティングバー       段階的フェードイン・発光表示        純粋CSS @keyframes 生成
  (再生/一時停止/シーク/速度)           (ReactFlow nodes/edges連動)       (Zero-Script SVGファイル出力)
```

1. **タイムライン同期の数理モデル**:
   CSSアニメーションの周期ループにおいて `animation-delay` は2周目以降にリセットされるため、すべてのノード・エッジの `animation-duration` を同一の全周期 $T$（例: 12.0秒）に統一。
   各要素の出現時刻 $t_{\mathrm{start}}$、完了時刻 $t_{\mathrm{in}}$、フェードアウト開始時刻 $t_{\mathrm{fade}}$ をパーセンテージ（`0% ~ p_start% ~ p_in% ~ 96% ~ 100%`）で配分することで、完全同期かつ位相ズレのない無限自律ループ再生を実現。
2. **視覚的強調（パルス発光）**:
   - 変動要因ノード: アンバー色パルスキーフレーム（`@keyframes vtaPulseAmber`）
   - 帰結ノード: ローズ色パルスキーフレーム（`@keyframes vtaPulseRose`）
3. **ヘッダーバナーへのモード表示**:
   出力されたSVGのタイトルに `【🎬 因果リプレイ】` または `【🎬 AI推論進化リプレイ】` を埋め込み、閲覧者が即座に目的を理解できるように設計。

---

## 5. 結果と影響 (Consequences)

### メリット
- **高いプレゼンテーション性**: 事故の発生・波及メカニズムが時間の流れに沿って動的に示されるため、報告書やスライドでの説明力が飛躍的に向上。
- **アルゴリズム推論の信頼性向上**: AIのツリー構築プロセスが可視化され、ソフトウェアの動作検証や品質評価が容易になった。
- **外部依存のない単一ベクターファイル**: 追加のプレイヤーや外部スクリプトを一切必要とせず、ダブルクリックやOfficeへのドラッグ＆ドロップでそのまま動作する。

### トレードオフ・考慮事項
- CSS `@keyframes` による線描画では、SVGパス要素の実長 $L$ が必要となるため、エクスポート時にベースSVGからパス幾何を逆算する解析処理（`extractEdgePathLengthsFromSVG`）を挟む設計を採用（ミリ秒オーダーで完了し性能問題なし）。

### 影響ファイル
- `src/tools/vta/features/vta/utils/animationSequencer.ts` (新規: シーケンス計算)
- `src/tools/vta/features/vta/utils/animatedSvgExport.ts` (新規: CSS埋め込み・ファイル保存)
- `src/tools/vta/features/vta/components/VTAAnimationPlayerBar.tsx` (新規: フローティング再生バー)
- `src/tools/vta/features/vta/utils/svgExport.ts` (エッジ要素の `<g id="..." class="vta-edge-group">` 化)
- `src/tools/vta/features/vta/store/vtaStore.ts` (アニメーション状態管理・エクスポートアクション)
- `src/tools/vta/features/vta/components/VTACanvas.tsx` (再生バー配置・ステップ連動スタイル)
- `src/tools/vta/features/vta/components/SVGExportModal.tsx` (Animated SVG出力設定UI)
- `src/tools/vta/components/Header.tsx` (動的リプレイ起動ボタン)
- `tests/vta/animationSequencer.test.ts` (シーケンサー単体テスト)
- `tests/vta/animatedSvgExport.test.ts` (Animated SVGエクスポート単体テスト)
