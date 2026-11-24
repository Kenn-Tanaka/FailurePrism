# ADR-0073: VTA UI整理（重複撤去・段階的開示・左パネル折りたたみ）と決定論的処理の進捗可視化基盤ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-22
- **対象コンポーネント**: VTA UI (`Header` / `ControlPanel` / `VTACanvas` / `ScenarioInputSection` / `LLMConfigSection` / `DebugLogsSection` / `SVGExportModal` / `NormalizationAuditExportModal`), Store (`vtaStore`), Shell Integration (`manifest.tsx`)
- **関連ドキュメント・コミット**: [ADR-0029](./0029-vta-panel-ux-simplification-and-workflow-navigation.md), [ADR-0072](./0072-deferred-final-phase-subject-others-consolidation.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

FailurePrism の VTA エディタは多段階 LLM パイプラインや高度な決定論的アルゴリズム（分枝限定法による主体統合最適化、時間半順序 DAG 構築、配線交差回避ルーティング、Animated SVG 合成等）を備える一方、UI 面で以下の問題が顕在化していた。

1. **上部バーとツールバーの過密・重複操作**
   - グローバルバー（`TopTabBar`）、ツールヘッダー（`Header`）、キャンバスツールバー（`VTACanvas`）が縦 3 段に重なり、常時 20 個以上の操作ボタンが露出していた。
   - `元に戻す / やり直す`、`AI対策提案`、`デバッグ記録` などが複数箇所に重複し、日常操作と再調整用メニュー（`BT自動整列`・`同一レーン整流`・`ノード自動接続` 等）が混在して操作意図が掴みづらかった。
2. **固定パネルによるキャンバス圧迫とワークフローの迷い**
   - 左パネル（420〜480px 固定）の上下を `LLM設定` と展開状態の `実行・通信ログ` が常時占有し、描画領域が狭まっていた。
   - VTA ツリー自動生成直後は全ノードが「未判定」のまま描画され、ステップ②で 3 つの似通った判定ボタンから選択する必要があり、直後の確認動線が分かりづらかった。
3. **重たい決定論的処理における無反応フリーズ問題**
   - レイアウト再計算・レーン統合/分割・JSON 読込・SVG/Animated SVG 出力などの同期 CPU 処理中、React の `setState` 直後に同期処理がメインスレッドを占有するため処理中スピナーが描画されず、完了まで画面が固まって見えていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **人間中心設計と 1 機能 1 配置**: 重複操作を廃し、「ファイル・出力＝ヘッダー」「工程進行＝左パネル」「図面操作＝キャンバスバー」へ責務を明確分離する。
- **メインスレッド譲歩による確実なペイント**: 処理中フラグを立てた後に描画フレームを 1 度ブラウザへ返してから同期処理を実行し、ユーザーへ即座に待機フィードバックを届ける。
- **100ms 未満の高速処理でのチラつき抑止**: 一瞬で終わる小規模図の操作で全画面暗転が点滅しないよう、軽量/中量タスクと重量タスクで表現を分離する。
- **既存テスト・同期ストア API の互換性維持**: `vtaStore` の既存同期メソッド（`recalculateLayout`・`forceMergeLanes`・`importProjectJSON` 等）のシグネチャや同期契約を破壊せず、単体テスト資産と `renderToStaticMarkup`（SSR 環境）安全性を維持する。

---

## 3. 検討した選択肢 (Considered Options)

### 選択肢 A: すべての決定論的処理を Web Worker へ全面移行する
- シリアライズ境界および `@xyflow/react` 計測状態・DOM 参照（SVG エクスポート）との不整合が大きく、大規模リファクタリングを要する。

### 選択肢 B: 描画フレーム譲歩ランナー（`runDeterministicUiTask`）＋ 2 段階進捗 UI ＋ Phase 1 UI 整理【採用】
- UI ハンドラ層に `requestAnimationFrame` + `setTimeout(0)` で確実にフレームを描画させる共通ランナーを導入し、既存ストアの同期 API を維持しつつマルチステップ進捗表示と再入防止を実現する。
- 中量タスク（`level: 'inline'`）にはコンポジタスレッド上の 100ms 遅延フェードインを組み合わせ、高速完了時の点滅ゼロと長時間処理時の確実な可視化を両立する。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 決定論的処理の処理中表示基盤（2 段階レベル設計）
1. **フレーム譲歩ランナー (`uiProgressRunner.ts`)**:
   - `runDeterministicUiTask` が `vtaStore.uiTaskProgress` をセットした直後に `yieldForPaint()` でペイントを完了させ、再入ガードと `finally` 確実解除を保証する。
2. **レベル 1（中量処理: `level: 'inline'`）**:
   - 自動整列、表示モード切替（詳細 ⇔ 見出しのみ）、レーン統合/分割/強制統合、サブレーン展開/集約、仮判定一括採用、プロジェクト保存、監査出力に適用。
   - 対象ボタンのスピナー表示に加え、`DeterministicProgressIndicator` がコンポジタ `animation-delay: 100ms` 付きの非暗転ステータスバッジをキャンバス上部に表示する。
3. **レベル 2（重量処理・I/O: `level: 'overlay'`）**:
   - プロジェクト JSON 読込（`importProjectJSONWithProgress` による 3 ステップ分割）、サンプル切替、下書き復元、PDF/Word/Excel 解析、静的/Animated SVG 生成（`SVGExportModal`）に適用。
   - ステップ数・進捗バー付きのオーバーレイを表示し、さらに `TopTabBar` のツール稼働バッジ（`manifest.tsx`）とヘッダー中央インジケータにも連動させる。

### 4.2 ヘッダー・ツールバー・左パネルの整理（Phase 1）
1. **ヘッダーと LLM 設定の集約**:
   - `LLMConfigSection` をヘッダー右上のコンパクトなモデル選択ピル＋ポップオーバーへ移設し、`Undo/Redo` はヘッダーに一本化した。
   - `SVG出力`・`正規化監査出力`・`AI診断コピー`・`デバッグ記録` を `[出力・診断 ▾]` ドロップダウンへ集約した。
2. **キャンバスツールバーの厳選**:
   - 13 個のボタン群を **`カード追加` / `自動整列` / `AI再調整 ▾` / `[詳細カード | 見出しのみ]`＋`表示設定` / `[レーン管理 | 補足メモ]`** の 5 グループへ削減し、専門用語（`BT自動整列`・`同一レーン整流`）を整理した。
3. **左ワークフローパネルの折りたたみと仮判定の既定反映**:
   - `ControlPanel` を `360〜400px` へスリム化かつアイコンレールへ折りたたみ可能にし、`DebugLogsSection` は既定 1 行折りたたみ（エラー発生時のみ自動展開）とした。
   - ステップ①の補助設定を `生成の詳細オプション` に格納し、`autoAdoptPreliminaryOnExtract`（既定 `true`）により抽出完了時点で仮判定を自動反映してステップ②を直感的な 1 クリック判定リストへ簡素化した。

---

## 5. 結果と影響 (Consequences)

### メリット
- ヘッダーおよびキャンバスツールバーの視覚密度と操作重複が大幅に減少し、折りたたみ対応により大図面でも VTA キャンバスを広く確保できる。
- 重たい決定論的処理や SVG/JSON 入出力でも確実にスピナー・ステップ進捗が表示され、無反応フリーズ感と連打による二重実行を防止できる。

### トレードオフ・考慮事項
- 1 つの単一同期ブロック内で数秒を要する単一関数（例: 巨大な `calculateVTALayout` 単体呼び出し）は開始前に描画を終えた「処理中」状態で待機するため、ステップ内部の細かい％進行が必要な場合は今後フェーズ分割ポイント（`yieldForPaint()`）を追加していくことで段階的に拡張できる。
- 右パネルの選択要素連動インライン編集（Phase 3）は本 ADR の範囲外とし、後続イテレーションで段階導入する。

### 影響ファイル
- 新規: [paintYield.ts](../../src/tools/vta/features/vta/utils/paintYield.ts), [uiProgressRunner.ts](../../src/tools/vta/features/vta/utils/uiProgressRunner.ts), [DeterministicProgressIndicator.tsx](../../src/tools/vta/features/vta/components/DeterministicProgressIndicator.tsx), [uiProgressAndDeclutter.test.tsx](../../tests/vta/uiProgressAndDeclutter.test.tsx)
- 更新: [vta.ts](../../src/tools/vta/types/vta.ts), [vtaStore.ts](../../src/tools/vta/features/vta/store/vtaStore.ts), [projectFileLoader.ts](../../src/tools/vta/features/vta/utils/projectFileLoader.ts), [manifest.tsx](../../src/tools/vta/manifest.tsx), [App.tsx](../../src/tools/vta/App.tsx), [Header.tsx](../../src/tools/vta/components/Header.tsx), [ControlPanel.tsx](../../src/tools/vta/components/ControlPanel.tsx), [LLMConfigSection.tsx](../../src/tools/vta/components/control-panel/LLMConfigSection.tsx), [DebugLogsSection.tsx](../../src/tools/vta/components/control-panel/DebugLogsSection.tsx), [ScenarioInputSection.tsx](../../src/tools/vta/components/control-panel/ScenarioInputSection.tsx), [VTACanvas.tsx](../../src/tools/vta/features/vta/components/VTACanvas.tsx), [SVGExportModal.tsx](../../src/tools/vta/features/vta/components/SVGExportModal.tsx), [NormalizationAuditExportModal.tsx](../../src/tools/vta/features/vta/components/NormalizationAuditExportModal.tsx)
