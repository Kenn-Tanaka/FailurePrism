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
1. ルートフォルダの **`start-all.bat`** をダブルクリックします。
   - ポート `8765` で **LLM-Gateway v2.0.0** が起動します。
   - ポート `3000` で **FailurePrism Webサーバー** が起動し、既定のブラウザで `http://127.0.0.1:3000/#menu` が開きます。
2. メニュー画面から **TPDD-Editor** または **VTA-Editor** を選択して利用を開始してください。
3. 終了する際は **`stop-all.bat`** をダブルクリックします。

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
実行完了後、`release/FailurePrism_Release_v1.0.0.zip` および `release/SHA256SUMS.txt` が出力されます。

---

## 4. ドキュメント一覧

- **アーキテクチャ・プラグイン開発規約**:
  - [オートプラグイン・アーキテクチャ & プラグイン開発規約 (`docs/PLUGIN_ARCHITECTURE.md`)](./docs/PLUGIN_ARCHITECTURE.md)
- **TPDD-Editor ドキュメント**:
  - [TPDD クイックスタート (`docs/tpdd/QUICKSTART.md`)](./docs/tpdd/QUICKSTART.md)
  - [TPDD リファレンスマニュアル (`docs/tpdd/REFERENCE_MANUAL.md`)](./docs/tpdd/REFERENCE_MANUAL.md)
  - [TPDD 仕様書 (`docs/tpdd/SPECIFICATION.md`)](./docs/tpdd/SPECIFICATION.md)
- **VTA-Editor ドキュメント**:
  - [VTA クイックスタート (`docs/vta/QUICKSTART.md`)](./docs/vta/QUICKSTART.md)
  - [VTA インストール・運用マニュアル (`docs/vta/INSTALL_MANUAL.md`)](./docs/vta/INSTALL_MANUAL.md)
- **LLM-Gateway v2.0.0 ドキュメント**:
  - [LLM-Gateway README (`gateway/README.md`)](./gateway/README.md)
  - [ファイル配置と実行時パス規則 (`gateway/FILE_LAYOUT.md`)](./gateway/FILE_LAYOUT.md)
  - [設定ファイルの互換読込 (`gateway/CONFIG_COMPATIBILITY.md`)](./gateway/CONFIG_COMPATIBILITY.md)
