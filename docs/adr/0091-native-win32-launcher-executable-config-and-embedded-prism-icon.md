# ADR-0091: ネイティブWin32ランチャー（`FailurePrism.exe`）・設定ファイル連携・およびプリズムアイコン埋め込みポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: Native Launcher (`launcher/`), Packaging & Shell Scripts (`scripts/build-package.ps1`, `scripts/browser-helpers.ps1`, `scripts/generate-icon.ps1`), Web Entry (`index.html`, `public/favicon.svg`, `public/favicon.ico`)
- **関連ドキュメント・コミット**: [ADR-0029](./0029-failure-prism-plugin-architecture-and-gateway-integration.md)

## 1. コンテキストと課題 (Context & Problem Statement)

従来、FailurePrism 統合パッケージの起動はルート直下の `start-all.bat`（内部で `scripts/start-all.ps1` を呼び出し）によって提供されていたが、実運用において以下の課題があった。

1. **視認性・OS統合性の不足**:
   - `.bat` ファイルはエクスプローラー上で汎用歯車アイコンとして表示されるため他の補助スクリプト（`stop-all.bat`・`maintenance-tool.bat`）と区別しにくく、Windows 11 タスクバーへの直接ピン留めにも対応しない。
2. **起動時のコンソール表示と固定スリープ遅延**:
   - `powershell.exe` 起動に伴うコンソールウィンドウの表示に加え、Gateway (`:8765`) と Web Server (`:3000`) の起動待機に固定 `Start-Sleep`（計6秒）を用いていた。
3. **OS既定以外のブラウザ指定・専用ウィンドウ起動の柔軟性**:
   - 業務環境や検証用途において、OS既定ブラウザとは別の特定ブラウザ（Chrome / Edge / Firefox / Brave / ポータブル `.exe` 等）や Chromium `--app` 専用ウィンドウモード・プロファイル引数を、人間が直接編集しやすい設定ファイルまたはコマンドラインパラメータで柔軟に切り替えたい要件がある。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **アンチウイルス誤検知回避・外部ランタイム非依存・配布サイズの維持**:
  - `ps2exe` 等のスクリプト自己展開型ラッパーは Windows Defender / 企業 EDR の誤検知リスクが高く、Electron / Node SEA 同梱は 6MB 未満の軽量配布パッケージを十数倍に肥大化させるため不採用とする。
  - `llm-gateway.exe` / `MaintenanceTool.exe` と同じく MSVC 静的リンク（`/MT`）かつ `VerifyImports.cmake` の OS 標準許可 DLL のみに依存する C++20 ネイティブ Win32 バイナリとする。
- **GUI サブシステムと CLI 操作性・既存 `start-all.bat` / `stop-all.bat` との完全互換**:
  - ダブルクリック時はコンソール非表示（`SUBSYSTEM:WINDOWS` + エラー時 `MessageBoxW`）、ターミナル実行時は `AttachConsole(ATTACH_PARENT_PROCESS)` または標準出力パイプへ UTF-8 出力を行う。
  - 既存の `start-all.bat` / `stop-all.bat` / `select-browser.bat` も引き続き維持し、設定ファイルと `.runtime/processes.json` を相互互換とする。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1**: バッチ／PowerShell を `ps2exe` 等で `.exe` 化する。
  - 却下。EDR/AV 誤検知リスクが高く、`powershell.exe` 起動オーバーヘッドも解消されない。
- **選択肢2**: C++20 ネイティブ静的リンク Win32 実行ファイル `FailurePrism.exe`（マルチサイズ `.ico`・PerMonitorV2 マニフェスト埋め込み）を `launcher/` に構築し、ルート設定ファイル `failureprism.config.json`・CLI 引数・ブラウザ選択 GUI ダイアログ（`--select-browser`）および既存スクリプト互換連携を実装する。
  - **採用**。約 160KB の単一静的バイナリで高速ヘルスチェック起動・設定柔軟性・視覚的一貫性をすべて満たす。

## 4. 決定事項 (Decision Outcome)

1. **C++20 ネイティブ Win32 ランチャー `FailurePrism.exe` の導入（`launcher/`）**:
   - `StaticRuntime.cmake`（`/MT`・`/guard:cf`）および `VerifyImports.cmake` 準拠の `WIN32` ターゲットとしてビルドし、ルート直下（および `launcher/bin/FailurePrism.exe`）に配置する。
   - Winsock2 非ブロッキング接続と HTTP ヘルスチェック（`127.0.0.1:8765/health`・`127.0.0.1:3000/`、80ms 周期）により応答確認直後にブラウザを起動し、`BCrypt` SHA-256 による `?build=<12hex>` キャッシュバスター付与と `.runtime/processes.json` 記録を行う。
2. **ブラウザ解決優先順位と `failureprism.config.json` の導入**:
   - 優先順位を `CLI引数`（`--browser`, `--browser-path`, `--app`, `--browser-arg`, `--no-browser`, `--view`） ＞ `環境変数`（`FAILUREPRISM_BROWSER`） ＞ `failureprism.config.json` ＞ `.runtime/browser.json` ＞ `OS既定ブラウザ` と定める。
   - `--select-browser`（ネイティブ Win32 設定ダイアログ）、`--set-browser`、`--reset-browser`、`--list-browsers`、`--status`、`--stop`、`--dry-run-json` を提供し、`scripts/browser-helpers.ps1` とも設定を双方向同期することで既存の `start-all.bat` / `select-browser.bat` との互換性を維持する。
3. **マルチサイズ `.ico` アイコン埋め込みと Web Favicon 統一**:
   - `scripts/generate-icon.ps1` により `16, 24, 32, 48, 64, 128, 256px` の7階層 PNG フレームを持つ `failureprism.ico` を生成して `FailurePrism.exe` の `IDI_APPICON` と `VS_VERSION_INFO` に埋め込み、同時に `public/favicon.svg` / `public/favicon.ico` を `index.html` に設定してブラウザタブおよび `--app` モード時のタスクバーアイコンを統一する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - ユーザーはプリズムアイコン付きの `FailurePrism.exe` をダブルクリックするだけで黒いコンソール画面なしに高速起動でき、設定ファイル・CLI・GUIダイアログのいずれからでも任意のブラウザや `--app` モードを選択できる。
  - 既存の `start-all.bat` / `stop-all.bat` ワークフローもそのまま動作する。
- **トレードオフ・考慮事項**:
  - `launcher/` の C++ ソースを変更した場合は `.\build.bat -RebuildLauncher`（または `-RebuildGateway`）で `launcher/bin/FailurePrism.exe` を再生成する。
- **影響を受けるファイル・テスト**:
  - `launcher/CMakeLists.txt`, `launcher/src/main.cpp`, `launcher/src/mini_json.hpp`, `launcher/src/resource.rc`, `launcher/src/app.manifest`
  - `failureprism.config.default.json`, `scripts/generate-icon.ps1`, `scripts/browser-helpers.ps1`, `scripts/build-package.ps1`
  - `index.html`, `public/favicon.svg`, `public/favicon.ico`, `README.md`
  - `tests/shell/browserLauncher.test.ts`
