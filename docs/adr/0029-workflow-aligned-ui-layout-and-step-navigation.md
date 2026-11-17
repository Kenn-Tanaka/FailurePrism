# ADR-0029: VTA分析ワークフローに沿った3ステップUIナビゲーション・常設通信ログおよびツールバー再編ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-09
- **対象コンポーネント**: VTA Control Panel (`ControlPanel.tsx`, `LLMConfigSection.tsx`, `ScenarioInputSection.tsx`, `ResultsSection.tsx`), Canvas Toolbar (`VTACanvas.tsx`), Header (`Header.tsx`), Store (`vtaStore.ts`), Focus Management (`progressFocus.ts`)
- **関連要件 / ADR**: [ADR-0028](file:///docs/adr/0028-progress-overlay-non-blurring-and-live-log-visibility.md), [ADR-0001](file:///docs/adr/0001-two-stage-event-classification-and-batch-adoption.md)

## 1. コンテキストと課題 (Context & Problem Statement)

VTA-Editor の機能拡充に伴い、左パネル（`ControlPanel`）、キャンバスのトップツールバー（`VTACanvas`）、およびヘッダー（`Header`）に多数の操作要素が追加された結果、実際の分析業務の順序（① シナリオ入力・構造抽出 $\to$ ② 構造検証・変動要因判定 $\to$ ③ 対策設定・改善生成・レポート確認）と UI の配置に以下の乖離・課題が生じていた：

1. **左パネルの縦長スクロール肥大化と通信ログの画面外押し出し**:
   - 左パネル内に「LLM接続設定」「シナリオ入力・抽出」「イベント一覧・変動要因確認」「対策適用状況」「改善結果・レポート」「実行・通信ログ」の6セクションが単一スクロール領域に直列配置されていた。
   - 初回設定後は頻繁に触らない `LLMConfigSection` が最上部を大きく占有し、抽出後に最も使う検証セクションや最下部の `DebugLogsSection`（実行・通信ログ）が画面外へ押し出され、ADR-0028 で背景ぼかしを撤廃してもスクロール位置によってはログが見えない状態になっていた。
2. **抽出セクションと検証セクションの混在および優先順の逆転**:
   - `ScenarioInputSection` 内に「ステップ1（入力・抽出）」と「ステップ2（仮判定一括採用・AI変動要因判定・詳細検証）」が混在し、かつ一括採用ボタンよりも先に詳細パネル展開ボタン（`イベント一覧・変動要因を確認`）が並んでいたため、基本操作フロー（サマリ確認 $\to$ 仮判定一括採用 $\to$ 詳細調整）と逆転していた。
3. **キャンバス上部ツールバーの機能混在**:
   - 12個のボタン・トグルが「対策提案（後半工程）」「カード追加（手動編集）」「BT自動整列（レイアウト）」「ノード自動接続・VTA最適化（前半〜中盤の構造調整）」の順で混在しており、視線移動と機能探索の負荷が高かった。
4. **ヘッダー左端のデバッグ記録コントロール配置**:
   - `<DebugRecordingControls compact />` がアプリロゴ・タイトルの左側に配置されており、ヘッダーの視覚的階層を乱していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **分析ワークフローとの直観的一致**: ユーザーが迷わず「① シナリオ・抽出」$\to$「② 検証・要因判定」$\to$「③ 対策・改善生成」の順に作業を進められること。
- **通信ログの常時可視性**: どのワークフローステップを表示していても、左パネル下部に「実行・通信ログ（`DebugLogsSection`）」が常に画面内に固定表示されること。
- **内部状態の完全保持（非アンマウント）**: ステップタブを切り替えても、未確定のレビュー変更（`pendingSchema`）や読み込みファイル情報（`loadedFileInfo`）、パネル展開状態が一切失われないこと。
- **フォーカス復元（アクセシビリティ）の維持**: Step 1 の抽出完了時に Step 2 へ自動遷移した際、`progressFocus.ts` が `[hidden]` になった抽出ボタンの代わりに Step 2 の操作ボタンへ確実にフォーカスを移動できること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 単一縦スクロールを維持し、各セクションをアコーディオン化する**
  - 複数セクションを開くと再び縦スクロールが発生し、下部の通信ログが画面外へ押し出される問題が根本解決しない。
- **選択肢2: 改善結果・分析レポート（`ResultsSection`）を右サイドバー（`SupplementaryNotesPanel`）へ移設する**
  - 右サイドバーの幅（`w-88 xl:w-96` = 352〜384px）は左パネル（`w-[420px] lg:w-[480px]` = 420〜480px）より狭く、長文レポートの可読性がむしろ低下するほか、既存の右サイドパネル構成・テストとの整合性を損なう。
- **選択肢3: 左パネルを「上部：折りたたみ式LLM設定」「中央：3ステップワークフロータブ（`hidden`属性で状態保持）」「下部：常設通信ログ」の3ゾーンに分割し、レポートにはワイド拡大閲覧モーダルを追加 ＋ キャンバスツールバー・ヘッダーを工程順に再編（採用）**
  - スクロールなしでのステップ切り替えと通信ログの常時表示を両立し、長文レポートも `max-w-4xl` モーダルで快適に閲覧できる。

## 4. 決定事項 (Decision Outcome)

1. **左パネルの3ゾーン構造化と3ステップワークフローナビゲーション (`ControlPanel.tsx`, `vtaStore.ts`, `vta.ts`)**:
   - `VTAWorkflowStep = 'input' | 'review' | 'measures'` をストアに追加。
   - **上部ゾーン (`LLMConfigSection.tsx`)**: デフォルトで1行のコンパクトバー（モデル名バッジ＋ワンクリック「接続テスト」ボタン＋展開トグル）に折りたたみ、省スペース化。
   - **中央ゾーン (`ControlPanel.tsx`)**:
     - `① シナリオ・抽出`（イベント件数バッジ付き）
     - `② 検証・要因判定`（変動要因件数または仮判定件数バッジ付き）
     - `③ 対策・改善生成`（排除＋ブレイク対策件数バッジ付き）
     - 非アクティブなステップは React ツリーからアンマウントせず `hidden` 属性（および `className="hidden"`）で表示制御し、内部ステートを完全保持。
     - Step 1 で `VTA構造を抽出・正規化` が完了すると自動的に Step 2 (`'review'`) へ遷移し、AI対策提案モーダルで対策を適用すると自動的に Step 3 (`'measures'`) へ遷移。
   - **下部ゾーン (`DebugLogsSection.tsx`)**: ワークフローステップのスクロール領域外（左パネル最下部）に常時固定配置。
2. **Step 2（検証・要因判定）の操作順整理 (`ScenarioInputSection.tsx`)**:
   - 判定状況サマリバッジ（変動要因・通常作業・未判定・仮判定あり件数）を最上部に表示。
   - その直下に「仮判定の一括採用（変動のみ / 全件）」と「AI変動要因判定を実行」を配置し、続いて詳細確認・個別編集用の `EventReviewPanel` を配置。
3. **改善結果・分析レポートのワイド拡大モーダル (`ResultsSection.tsx`)**:
   - Step 3 内の `ResultsSection` ヘッダーに「拡大」ボタンを設け、`createPortal` による `max-w-4xl` のワイドリーダーモーダルで理想フロー・分析レポート・JSONスキーマを一覧・コピー可能に改善。
4. **キャンバストップツールバーの4クラスタ再編 (`VTACanvas.tsx`)**:
   - **[1. 履歴・手動編集]**: `Undo` / `Redo`、`＋ カード追加`
   - **[2. AI構造補完・対策提案]**: `ノード自動接続`、`VTA最適化`（＋設定）、`💡 AI対策提案`（クリック時に左パネルも Step 3 へ同期）
   - **[3. レイアウト・レーン整理]**: `BT自動整列`、`同一レーン整流`、`移動後に列中央へスナップ`、`レーン管理`
   - **[4. ビュー・補助パネル]**: `見出しのみ/詳細表示`、`全画面フィット`、`凡例`、`補足説明欄`
5. **ヘッダーの整理 (`Header.tsx`)**:
   - 左端をアプリロゴ・タイトルに統一し、`<DebugRecordingControls compact />` を右側アクション群の先頭へ移設。
   - 右側アクションを `[デバッグ記録]` | `[Undo/Redo]` | `[プロジェクト読込] [プロジェクト保存]` | `[動的リプレイ] [正規化監査出力] [SVG出力 (図+補足)]` | `[VTA利用ガイド]` の論理順に整列。
6. **進捗完了後のフォーカスフォールバック拡充 (`progressFocus.ts`)**:
   - `extract` モード完了時に Step 1 の `extract-trigger` が `[hidden]` となるため、Step 2 の `batch-adopt-variation-outside`、`batch-adopt-all-outside`、`classify-trigger`、`review-current-trigger` をフォールバックセレクタに追加。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - ユーザーが①〜③のタブに沿って迷わず分析・検証・対策生成を進められる。
  - 実行・通信ログが常に左パネル下部に表示され、推論中・操作中を問わずリアルタイムに状況を確認できる。
  - 長文の分析レポートや理想の業務フローをワイドモーダルで快適に精読できる。
- **トレードオフ・考慮事項**:
  - ステップ1とステップ2の表示がタブで切り替わるため、抽出完了時の自動遷移およびフォーカス移動を `progressFocus.ts` と連携して担保している。
- **影響ファイル**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/components/ControlPanel.tsx`
  - `src/tools/vta/components/control-panel/LLMConfigSection.tsx`
  - `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`
  - `src/tools/vta/components/control-panel/ResultsSection.tsx`
  - `src/tools/vta/features/vta/components/VTACanvas.tsx`
  - `src/tools/vta/components/Header.tsx`
  - `src/tools/vta/features/vta/utils/progressFocus.ts`
  - `src/tools/vta/features/vta/utils/progressFocus.test.ts`
  - `tests/vta/workflowUiLayout.test.tsx`
