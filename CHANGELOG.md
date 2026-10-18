# Changelog

All notable changes to **FailurePrism** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## 2026-10-18 — TPDDのGateway接続経路をWeb中継に統一

- **変更対象**: FailurePrismのTPDD端末設定・設定画面・回帰テスト・接続手順、dist、展開済み配布物、ZIPとSHA256。
- **変更内容・理由**: VTAは同一オリジンの `/v1`、TPDDはブラウザーから8765への直接通信という差を解消。TPDD既定値を `/v1` に変更し、保存済み旧既定URLも読み込み時に移行。独自接続先、認証設定、お気に入りは保持。相対URLの許可は `/v1` と `/v1/` に限定。
- **検証結果**: 28ファイル187テスト成功、型検査・本番ビルド成功。旧設定移行・独自設定保持・URL検証・生成要求の中継先を回帰テスト。稼働GatewayのCORSプリフライトは204で正常。Web中継経由のGemini 3.8 Flash短文要求はHTTP 200（出力上限16トークンのため終了理由length）。配布ZIPのCRCとSHA256を確認。
- **限界**: ユーザーのブラウザーにおける直接通信失敗の詳細原因は未確認。実プロジェクトの展開案生成は未実施。画面再読み込み後の再確認が必要。

## 2026-10-18 — chat AliasとEditorデフォルトLLMの更新

- **変更対象**: FailurePrismのGateway標準・稼働設定、VTA/TPDDのモデル初期値・カタログ・お気に入り初期値、README・VTA導入手順、本番フロントエンドと配布ZIP。
- **変更内容・理由**: 利用者指定に合わせchatを `~anthropic/claude-haiku-latest`、両Editorのデフォルトを `openrouter/google/gemini-3.8-flash` に変更。TPDDの新規ダイアグラム生成側の初期値も更新。旧Claude 3.7のVTA推薦・入力例を新しいデフォルトへ置換。
- **検証結果**: FailurePrismの28テストファイル・184テスト成功。TypeScript型検査とVite本番ビルド成功。配布ZIPを更新しSHA256を再生成。実モデルへの生成リクエストは今回未実施。
- **互換性**: 保存済みプロジェクトのモデル指定・お気に入りは保持。既存プロジェクトで変更する場合はモデル選択が必要。資格情報は変更していない。

## 2026-10-18 — 稼働環境への資格情報修正版反映と実接続検証

- **変更対象**: FailurePrism展開先gatewayの両EXE・README・FILE_LAYOUT、両リポジトリのCHANGELOG。
- **変更内容・理由**: 利用者承認に基づき管理GUIを通常終了し、停止中のGatewayと管理GUIのEXEを検証済み版へ交換。既存設定を保持してGatewayとWebサーバーを起動した。
- **検証結果**: 展開先両EXEのビルド成果物とのバイト一致と設定ファイルの前後ハッシュ一致を確認。healthは200。Web中継経由のchat AliasへのPingで401が解消し、代わりに設定モデルのエンドポイント不在404を確認。公開モデル一覧に存在するanthropic/claude-haiku-5.5を要求に直接指定したPingはHTTP 200、応答1件（約1.5秒）で成功。実資格情報は再登録・変更せず利用できた。
- **残事項**: 設定のchat Aliasは旧モデルのまま保持。VTAの選択モデルまたはchat Aliasを利用可能なモデルへ変更する必要がある。実キー・応答の個人識別情報は履歴へ記録していない。

## 2026-10-18 — Gateway資格情報形式修正

- 変更対象: gatewayのCredentialStore実装・ヘッダー・認証テスト、README/FILE_LAYOUT、gateway/binの両EXE、release ZIPとSHA256SUMS、本履歴。
- 内容・理由: 既存のvendor|slot@サービス名形式へ統一し、誤ったサービス名/name形式は互換検索も行わない。Windows資格情報マネージャーのUTF-16LEパスワードを読込可能にして、既存登録の再登録を不要にした。Client/Adminの相対名も@サービス名形式とする。実資格情報の変更・移行・削除は行っていない。
- 検証: 同期元のReleaseビルド、CTest 7/7、DLL検査成功。ソースとbin/ZIP内EXEの一致を検証。実API接続テストと稼働中展開先の交換は、停止・再起動の確認回答待ち。
- 互換性: 誤形式で登録済みのキー/トークンは参照対象外。必要に応じて正規形式へ再登録すること。

## [1.0.0] - 2026-10-18

### Added
- **Unified FailurePrism Workbench**:
  - Integrated **TPDD-Editor** (思考展開図エディタ / Thinking Process Deployment Diagram Editor), **VTA-Editor** (バリエーションツリー分析エディタ / Variation Tree Analysis Editor), and full-featured **LLM-Gateway v2.0.0** (`llm-gateway.exe` + `MaintenanceTool.exe`) into a single local workbench package.
  - Added startup Launcher Menu (`#menu`) and persistent global Top Tab Bar with live tool status badges (node counts, unsaved changes indicator, AI generation busy state, and open-in-new-tab buttons).
  - Implemented Keep-Alive DOM mounting so switching between Menu, TPDD-Editor, and VTA-Editor preserves canvas viewport, undo/redo history, and active SSE streaming sessions.
- **Auto-Plugin (File-Based Discovery) Architecture**:
  - Implemented automatic plugin discovery (`src/shell/toolLoader.ts`) via `import.meta.glob('../tools/*/manifest.tsx')`.
  - Documented the plugin specification and developer guide in `docs/PLUGIN_ARCHITECTURE.md`.
  - Configured automatic per-tool and vendor chunk splitting in `vite.config.ts`.
- **Full LLM-Gateway v2.0.0 Integration**:
  - Bundled `llm-gateway.exe` v2.0.0 (supporting OpenRouter, LM Studio, Ollama, SSE streaming, and embedded GGUF `/v1/embeddings` & `/v1/rerank`) and `MaintenanceTool.exe` (Windows Credential Manager GUI).
  - Added local Node.js reverse proxy server (`scripts/server.mjs`) forwarding `/v1/*` and `/health` to `127.0.0.1:8765` with strict path traversal protection.
  - Implemented in-memory Gateway Token synchronization across all mounted tools without persisting tokens to browser storage.
- **Packaging, Licensing & Documentation**:
  - Added unified build and packaging pipeline (`build.bat` / `scripts/build-package.ps1`) generating `FailurePrism_Release_v1.0.0.zip` and `SHA256SUMS.txt`.
  - Added root `LICENSE` (`Copyright (c) 2026 HAIA Project`, MIT License), `NOTICE.md`, and complete `THIRD_PARTY_LICENSES/` for both frontend and C++ gateway dependencies.
