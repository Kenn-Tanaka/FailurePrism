# ADR-0028: 進捗表示ダイアログの背景ぼかし（backdrop-blur）撤廃とリアルタイム通信ログ可視化ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-09
- **対象コンポーネント**: VTA Progress Overlay (`GenerationProgressOverlay.tsx`), Test (`GenerationProgressOverlay.test.tsx`)
- **関連要件 / ADR**: [ADR-0027](file:///docs/adr/0027-relation-id-disambiguation-and-stream-progress-observability.md), [ADR-0015](file:///docs/adr/0015-llm-streaming-retry-and-prompt-architecture.md)

## 1. コンテキストと課題 (Context & Problem Statement)

VTA-Editor において、イベント抽出・変動要因判定・ノード自動接続・改善フロー再生成などの LLM 推論中に全画面表示される進捗ダイアログ（`GenerationProgressOverlay`）に関して、以下の運用上の課題が確認された：

1. **背景ぼかしによる通信ログの判読不能**:
   - オーバーレイラッパーに `backdrop-blur-md`（CSSの `backdrop-filter: blur(12px)`）および濃い遮光（`bg-slate-950/75`）が適用されていたため、背面の左サイドバーに常設されている「実行・通信ログ（`DebugLogsSection`）」の文字が激しくにじみ、ぼやけて判読不能になっていた。
2. **長大ストリーミング推論中の可観測性阻害**:
   - [ADR-0027](file:///docs/adr/0027-relation-id-disambiguation-and-stream-progress-observability.md) で SSE ストリーム受信中の進捗ログ（`累計 XXXX文字 (経過: XX秒, 速度: XX字/秒)`）を出力するようにしたにもかかわらず、ダイアログ表示中にそのログがぼやけて見えないため、ユーザーが「処理が順調に進んでいるのか」「フリーズしているのか」をリアルタイムに確認できないストレスが発生していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **通信・推論の可観測性（Observability）**: 長時間の AI 推論中であっても、ユーザーが通信ログや進捗状況をいつでも鮮明に目視できること。
- **誤操作防止（Modal Guard）の維持**: 推論中に背後のキャンバスや入力欄を誤クリック・キーボード操作して状態競合を起こさないための全面クリックブロッカー機能は維持すること。
- **中央集権的な視認性**: 背面のログ欄に視線を動かさずとも、中央の進捗ダイアログ自体で最新の通信・推論状況が把握できること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: ぼかし強度を弱める (`backdrop-blur-sm`)**
  - 文字の判読性は依然として損なわれ、等幅フォントの小さなログ（10px）は読めないままとなる。
- **選択肢2: 左パネル（ログ欄）のみオーバーレイの前面 (`z-[12001]`) に引き上げる**
  - 推論中に左パネルの入力欄や各種ボタンが押せてしまい、排他制御や状態競合のリスクが生じる。
- **選択肢3: オーバーレイの `backdrop-blur` を完全撤廃し、クリアな半透明に変更 ＋ ダイアログ内へ最新ログプレビューを組み込み（採用）**
  - `backdrop-blur-md` を削除し、ぼかしのない適度な半透明（`bg-slate-950/45`）に変更して背面のログを 100% くっきり読める状態にする。さらに、ダイアログ自体の下部にも最新の通信・実行ログ（1件）をリアルタイム表示する。

## 4. 決定事項 (Decision Outcome)

1. **背景ぼかしの完全撤廃 (`GenerationProgressOverlay.tsx`)**:
   - `data-vta-progress-overlay="true"` のラッパー要素から `backdrop-blur-md` を削除。
   - 遮光クラスを `bg-slate-950/75` から `bg-slate-950/45` に変更し、背後のテキスト（特に左パネルの実行・通信ログ）が一切にじまず、鮮明に読める状態を確保。
   - 背後要素へのクリック透過は引き続き防止（`fixed inset-0` による誤操作ガードは維持）。
2. **ダイアログ内部への最新リアルタイムログ表示 (`GenerationProgressOverlay.tsx`)**:
   - `useVTAStore` から `logs` を取得し、ステータスメッセージの下部に最新ログ（最新 1 件、タイムスタンプ・ステージタグ・ログメッセージ）をコンパクトにリアルタイム表示。
   - これにより、ダイアログから目を離さずに SSE 受信文字数や速度、処理の遷移が即座に確認可能。
3. **回帰テストの追加 (`GenerationProgressOverlay.test.tsx`)**:
   - オーバーレイに `backdrop-blur` が含まれていないこと、およびログ存在時に最新ログメッセージがダイアログ内に描画されることを検証するテストを追加。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 推論中であっても、背面の左パネルの通信ログ（ストリーム受信文字数、速度、警告等）がくっきりと鮮明に読める。
  - 中央のダイアログ内にも最新ログがリアルタイム反映されるため、視線を動かさずに推論進行状況を瞬時に把握できる。
  - 全面モーダルによる推論中の誤操作防止機能はそのまま保たれる。
- **トレードオフ・考慮事項**:
  - 背景のぼかしによる「すりガラス効果（Frosted Glass）」は無くなるが、実務分析ツールとしての実用性・可読性が大幅に向上する。
- **影響ファイル**:
  - `src/tools/vta/features/vta/components/GenerationProgressOverlay.tsx`
  - `src/tools/vta/features/vta/components/GenerationProgressOverlay.test.tsx`
