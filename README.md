# FailurePrism 統合パッケージ (TPDD-Editor + VTA-Editor + LLM-Gateway v2.0.0)

**FailurePrism** は、設計思考・構造展開を行う **TPDD-Editor（思考展開図エディタ）** と、事故・不具合の時系列要因分析を行う **VTA-Editor（バリエーションツリー分析エディタ）**、および両エディタ共通の推論基盤である **LLM-Gateway フル機能版 (v2.0.0)** を1つのパッケージに統合したワークベンチです。

---

## 1. 主な特徴

1. **起動時メニュー画面 & シームレスなタブ切替**:
   - ブラウザ起動時に **FailurePrism メニュー画面 (`#menu`)** が表示され、**TPDD-Editor** と **VTA-Editor** を選択できます。
   - **画面上部のアプリ内タブバー**（`メニュー` / `TPDD-Editor` / `VTA-Editor`）で、編集中の図面やUndo履歴、実行中のAI推論を保持したままワンクリックで切り替え可能です。
   - **ブラウザの別タブ起動・タブ切替**（`#tpdd` / `#vta`）にも完全対応しており、2つのブラウザタブや別ウィンドウで両エディタを並べて操作することもできます。
2. **フル機能版 LLM-Gateway (v2.0.0) 同梱**:
   - OpenAI互換ローカルゲートウェイ `llm-gateway.exe` (v2.0.0) と、GUI設定・資格情報管理ツール `MaintenanceTool.exe` を同梱。
   - 外部プロバイダ中継（OpenRouter, LM Studio, Ollama 等、SSEストリーミング完全対応）に加え、任意のGGUFモデル（`bge-m3`, `bge-reranker-v2-m3` 等）による**組み込み Embedding (`POST /v1/embeddings`) / Rerank (`POST /v1/rerank`)** にも対応しています。
   - APIキーや認証トークンは Windows 資格情報マネージャー（ユーザー領域）に安全に保管され、設定JSONやブラウザの永続ストレージには一切書かれません。
3. **オートプラグイン（ファイルベース・ディスカバリ）アーキテクチャ**:
   - 各ツールは `src/tools/<tool-id>/` 配下に独立して配置されており、新しいツールディレクトリと `manifest.tsx` を配置するだけで、既存ファイルを1行も変更せずにメニュー・上部タブバー・URLルーティング（`#<tool-id>`）・Gatewayトークン同期へ自動統合されます。

---

## 2. クイックスタート（起動と初期設定）

### 2.1 APIキーの登録・Gateway設定（初回のみ）
1. ルートフォルダの **`maintenance-tool.bat`**（または `gateway\MaintenanceTool.exe`）をダブルクリックして起動します。
2. **Providers & Routing** タブでプロバイダ（OpenRouter / LM Studio / Ollama）を確認し、クラウドLLMを利用する場合は **Credentials** タブで `openrouter | default` を選択して API キーを入力し、`Save Key` をクリックします。
3. 設定を変更した場合は `Save Config`（または `Save & Restart`）をクリックします。

### 2.2 アプリケーションの一括起動
1. ルートフォルダの **`FailurePrism.exe`**（専用プリズムアイコン付きネイティブランチャー、または従来互換の **`start-all.bat`**）をダブルクリックします。
   - コンソールウィンドウを表示せずバックグラウンドでポート `8765` の **LLM-Gateway v2.0.0** とポート `3000` の **FailurePrism Webサーバー** を起動・ヘルスチェックし、準備完了直後にブラウザで `http://127.0.0.1:3000/#menu` を開きます。
2. メニュー画面から **TPDD-Editor** または **VTA-Editor** を選択して利用を開始してください。
3. 終了する際は **`stop-all.bat`** をダブルクリックするか、`.\FailurePrism.exe --stop` を実行します。

### 2.3 起動ブラウザの変更・指定（任意）
OS既定のブラウザとは異なる特定のブラウザ（Chrome / Edge / Firefox / Brave / Vivaldi / 任意の `.exe` 等）で開きたい場合は、以下のいずれかで指定できます。

1. **GUIダイアログで選択・保存（推奨）**:
   ```powershell
   .\FailurePrism.exe --select-browser
   ```
   （または `select-browser.bat` をダブルクリックしても対話メニューから設定できます。）
2. **設定ファイル `failureprism.config.json` を直接編集**:
   ルート直下の `failureprism.config.json`（初回起動時に `failureprism.config.default.json` から自動生成）で常時使用するブラウザや `--app` 専用ウィンドウモードを指定できます。
   ```json
   {
     "schema_version": 1,
     "browser": {
       "mode": "browser",
       "target": "chrome",
       "executablePath": "",
       "appMode": true,
       "args": ["--profile-directory=Profile 1"],
       "startHash": "#menu"
     },
     "ports": {
       "web": 3000,
       "gateway": 8765
     }
   }
   ```
3. **コマンドライン引数で永続保存 / その回のみ一時指定**:
   ```powershell
   # 常時使用するブラウザを設定ファイルへ保存
   .\FailurePrism.exe --set-browser chrome --app
   .\FailurePrism.exe --reset-browser

   # その回だけ一時的にブラウザ・初期画面を指定して起動（設定ファイルを上書きしない）
   .\FailurePrism.exe --browser msedge --app
   .\FailurePrism.exe --browser firefox --view vta
   .\FailurePrism.exe --browser-path "C:\PortableApps\Chrome\chrome.exe"
   .\FailurePrism.exe --no-browser

   # 検出ブラウザ一覧・稼働ステータスの確認・サービス停止
   .\FailurePrism.exe --list-browsers
   .\FailurePrism.exe --status
   .\FailurePrism.exe --stop
   ```
4. **環境変数で指定**: `FAILUREPRISM_BROWSER=chrome`（または実行ファイルのフルパス / `none`）を設定して起動します（既存の `start-all.bat` でも共通の設定が適用されます）。

---

## 3. 開発・テスト・パッケージビルド手順

### 3.1 開発コマンド
```bash
# 依存パッケージの導入
npm install

# 開発サーバー起動 (http://127.0.0.1:5173)
npm run dev

# TypeScript 型チェック
npm run typecheck

# 単体・結合テスト実行 (Vitest: TPDD + VTA + Shell)
npm test

# 本番ビルド (dist/ 出力)
npm run build
```

### 3.2 配布用ZIPパッケージの生成
```powershell
# テスト・フロントエンドビルド・Gatewayバイナリ検証・ZIP生成を一括実行
.\build.bat
# または
npm run package
```
実行完了後、`package.json` の `version` に対応する `release/FailurePrism_Release_v<version>.zip` および `release/SHA256SUMS.txt` が出力されます。

---

## 4. ドキュメント一覧

- **開発ロードマップ & 設計決定記録 (ADR)**:
  - [FailurePrism 開発ロードマップ (`docs/ROADMAP.md`)](./docs/ROADMAP.md)
  - [Architecture Design Records 一覧 (`docs/adr/README.md`)](./docs/adr/README.md)
- **システムアーキテクチャ & LLM連携仕様書**:
  - [TPDD & VTA アーキテクチャ・処理フロー・LLM連携仕様書 (`docs/TPDD_AND_VTA_ARCHITECTURE_GUIDE.md`)](./docs/TPDD_AND_VTA_ARCHITECTURE_GUIDE.md)
- **現行実装から再構成した要件定義書（2026-10-20）**:
  - [共通要件・システム境界](./docs/REQUIREMENTS.md)
  - [TPDD-Editor 要件定義書](./docs/tpdd/REQUIREMENTS.md)
  - [VTA-Editor 要件定義書](./docs/vta/REQUIREMENTS.md)
- **アーキテクチャ・プラグイン開発規約**:
  - [オートプラグイン・アーキテクチャ & プラグイン開発規約 (`docs/PLUGIN_ARCHITECTURE.md`)](./docs/PLUGIN_ARCHITECTURE.md)
- **TPDD-Editor ドキュメント**:
  - [TPDD クイックスタート (`docs/tpdd/QUICKSTART.md`)](./docs/tpdd/QUICKSTART.md)
  - [TPDD リファレンスマニュアル (`docs/tpdd/REFERENCE_MANUAL.md`)](./docs/tpdd/REFERENCE_MANUAL.md)
  - [TPDD 仕様書 (`docs/tpdd/SPECIFICATION.md`)](./docs/tpdd/SPECIFICATION.md)
- **VTA-Editor ドキュメント**:
  - [VTA クイックスタート (`docs/vta/QUICKSTART.md`)](./docs/vta/QUICKSTART.md)
  - [VTA リファレンスマニュアル (docs/vta/REFERENCE.md)](./docs/vta/REFERENCE.md)
  - [VTA テキスト台帳仕様書 (docs/vta/TEXT_LEDGER_SPEC.md)](./docs/vta/TEXT_LEDGER_SPEC.md)
  - [VTA インストール・運用マニュアル (`docs/vta/INSTALL_MANUAL.md`)](./docs/vta/INSTALL_MANUAL.md)
- [HAIA の使い方](./docs/haia/README.md)
- **LLM-Gateway v2.0.0 ドキュメント**:
  - [LLM-Gateway README (`gateway/README.md`)](./gateway/README.md)
  - [ファイル配置と実行時パス規則 (`gateway/FILE_LAYOUT.md`)](./gateway/FILE_LAYOUT.md)
  - [設定ファイルの互換読込 (`gateway/CONFIG_COMPATIBILITY.md`)](./gateway/CONFIG_COMPATIBILITY.md)

### デフォルトLLM

VTA-EditorとTPDD-Editorの新規利用時の初期デフォルトは `openrouter/google/gemini-3.8-flash` です（配布時シード [`public/llm-models.json`](./public/llm-models.json) または **LLMモデル管理プラグイン (`#llm-manager`)** から共通・ツール別デフォルトおよび推奨モデル一覧を変更できます）。Gatewayの `chat` AliasはOpenRouterの `~anthropic/claude-haiku-latest` を参照します。保存済みプロジェクトのモデル指定は保持されます。


### 統合版のGateway接続先（2026-10-18更新）

TPDD-Editorの既定接続先は `/v1` です。VTA-Editorと同じWebサーバー中継を利用します。旧既定値 `http://127.0.0.1:8765/v1` の保存設定は読み込み時に `/v1` として扱います。独自のポート・接続先は保持されます。上記の直接接続を既定とする記述は統合版ではこの節に置き換えます。


