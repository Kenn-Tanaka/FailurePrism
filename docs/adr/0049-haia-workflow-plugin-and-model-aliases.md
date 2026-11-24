# ADR-0049: HAIA プラグインとモデル Alias

- **Status**: Accepted
- **Date**: 2026-11-19
- **Target Components**: `src/tools/haia/`、LLM-Gateway の上流プロキシ、`scripts/haia-loader.mjs`、FailurePrism の配布処理
- **Related Requirements / ADRs**: [ADR-0042](./0042-shared-llm-registry-and-manager-plugin.md)、[プラグイン規約](../PLUGIN_ARCHITECTURE.md)

## 1. コンテキストと課題 (Context & Problem Statement)

Haia056.py の文書処理、タスク、XML ワークフローを FailurePrism に統合する。配布済みのワークフローを維持しながら、モデル変更を Haia の設定だけで行えるようにする。

## 2. 決定理由の要因・制約 (Decision Drivers)

モデル接続は LLM-Gateway に統一する。ワークフローは Alias でモデルを指定し、未登録 Alias は Haia の既定モデルへ解決する。既存 XML は完成状態にかかわらず原文を維持する。音声合成、自動配役、再生、音声保存は後続の対象とする。

## 3. 検討した選択肢 (Considered Options)

FailurePrism 共通レジストリはツール横断の推奨モデルと既定値を扱う。HAIA は配布ワークフロー専用の Alias と利用者が編集できるインストールフォルダの JSON を必要とするため、独立した対応表を採用する。Pandoc、ファイル入出力、字幕取得はローカル Node API で扱う。

## 4. 決定事項 (Decision Outcome)

- マニフェストを `src/tools/haia/manifest.tsx` に置き、Vite の自動検出で `#haia` を登録する。
- `app/haia/models.json` は初回起動時に配布シードから作成する。既存ファイルは保持し、メンテナで保存した内容は Haia の再起動で読み込む。Gateway に送るモデル ID はこの対応表から解決する。
- XML のモデル指定はステップ、ワークフロー、画面、Haia の既定の順で選択する。未登録の指定は既定へ解決し、実行ログに残す。
- ワークフロー実行中は Python 版と同じく、ステップ ID のタグ付きで出力を逐次表示する。完了後もステップ結果を保持し、出力欄で最終出力に切り替えられる。文書保存には最終出力、XML 保存には `<result>` を含むワークフローを使う。
- Haia の LLM 通信では、リクエストを送るたびに無通信時間の計測を開始し、応答ヘッダーや本文のバイトを受信するたびに計測をリセットする。Gateway の上流ストリーミングも送受信の進捗を基準にタイムアウトを判定する。
- 既存タスクとプロンプトは原文を配布し、利用者のタスク変更は `tasks.local.json` に保存する。タスク名の変更は `PUT /api/haia/task` の `previousName` により 1 回の原子書き込みで反映し、配布 `tasks.json` に含まれないキーの削除時はトゥームストーンを残さない。`tasks.local.json` 内の不正型エントリは読み飛ばす。
- 文書と字幕のアダプターはそれぞれローカルの Pandoc と yt-dlp を利用する。字幕取得はプロキシなしで直接接続し、優先言語、字幕の種類の順に選ぶ。投稿者名が空のときの `SANITIZED_AUTHOR_NAME` は Python 版互換の `unknown_author` とする。
- `file_read` のエンコーディング指定は `utf_8` / `utf8sig` / `cp932` / `shift_jis` / `euc-jp` 等の別名を正規化し、`latin1` / `ascii` は WHATWG `windows-1252` へのフォールバックを避けてバイト範囲を厳密検証する（Shift_JIS 系・EUC-JP は読み込み専用とする）。文字列操作の正規表現は Unicode モード (`u`) を維持しつつ、文字クラス内外を区別して Python 固有エスケープ（`\:`・`\#`・`\A`・`\Z`・先頭インラインフラグ等）を事前変換する。

## 5. 結果と影響 (Consequences)

- **メリット**: ワークフローを編集せずモデルを切り替えられる。Haia を除いた構成でもシェルと Gateway を起動できる。
- **トレードオフ・考慮事項**: Pandoc 文書変換と YouTube 字幕にはローカル実行ファイルが必要。利用できる上流モデルは Gateway の設定に依存する。
- **影響を受けるファイル・テスト**: `src/tools/haia/`、`tests/haia/`、`gateway/src/gateway/external_proxy.cpp`、`gateway/tests/integration/health_test.cpp`、`scripts/server.mjs`、`scripts/build-package.ps1`、`vite.config.ts`。
