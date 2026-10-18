# Contributing to FailurePrism

**FailurePrism** へのコントリビューション（バグ報告、機能改善、新規分析ツールのプラグイン追加など）を歓迎します。

---

## 1. 開発環境のセットアップ

### 必須要件
- **Node.js**: v20 以上推奨（v18+ 対応）
- **OS**: Windows 10 / 11 (64-bit) ※同梱の `llm-gateway.exe` / `MaintenanceTool.exe` を実行する場合

### セットアップ手順
```bash
# リポジトリのクローン
git clone <repository-url>
cd FailurePrism

# 依存パッケージのインストール
npm install

# 開発サーバーの起動 (http://127.0.0.1:5173)
npm run dev
```

---

## 2. 品質チェック・テストコマンド

Pull Request を作成する前に、以下のコマンドがすべてエラーなく通過することを確認してください。

```bash
# 1. TypeScript の型チェック
npm run typecheck

# 2. 自動単体・結合テスト (Vitest)
npm test

# 3. 本番ビルド検証
npm run build
```

新しい npm パッケージを追加した場合は、以下を実行してサードパーティライセンス一覧を更新してください。

```bash
npm run licenses:update
```

---

## 3. 新しい分析ツール（プラグイン）の追加方法

FailurePrism は **オートプラグイン（ファイルベース・ディスカバリ）アーキテクチャ** を採用しています。

1. `src/tools/<tool-id>/` ディレクトリを作成します（`<tool-id>` は `/^[a-z0-9][a-z0-9-_]*$/`、`'menu'` と `'home'` は予約語のため使用不可）。
2. `src/tools/<tool-id>/manifest.tsx` を作成し、`ToolManifest` 型のオブジェクトをエクスポートします。
3. 既存のシェルコード（`src/shell/`）を編集する必要はありません。詳細な規約・ライフサイクルルール（`isActive === false` 時のグローバルイベント遮断など）は **[docs/PLUGIN_ARCHITECTURE.md](./docs/PLUGIN_ARCHITECTURE.md)** を参照してください。

---

## 4. Pull Request のガイドライン

- **1つの PR につき 1つの目的**: バグ修正・リファクタリング・新機能追加は可能な限り分けて提出してください。
- **テストの追加**: ドメインロジックやストア、ユーティリティ関数を変更・追加した場合は、対応する `.test.ts` を追加・更新してください。
- **セキュリティの遵守**: API キーや認証トークンをコード、設定ファイル、または `localStorage` / `sessionStorage` に保存する変更は行わないでください。
