# Variation Tree Analysis Editor - ビルダー利用マニュアル (Builder Manual)

本書は、**Variation Tree Analysis Editor** を異なるWindows環境やCI/CD環境でゼロからソースコードよりビルド・テスト・パッケージングするための「ユニバーサルビルダー」の利用マニュアルです。

---

## 1. ビルダーの概要と特徴

本ビルダー（`builder/build.ps1` および `build.bat`）は、異なる開発機やクリーンなWindows環境において、環境差分を自動吸収しながら本ソフトウェア一式をワンクリックで自動構築できる自己完結型ツールキットです。

### 主な特徴
1. **ハイブリッド自動判定**:
   - **Node.js 環境**: フロントエンド（React + TypeScript + Vite）の依存関係解決、ユニットテスト（vitest）、本番バンドルビルド（tsc + vite）を自動実行します。
   - **C++ コンパイル環境（g++ / MinGW）がある場合**: `vta-starter.exe` や `llm_test.exe` をソースから自動コンパイル（`-static` 静的リンク）。
   - **C++ コンパイル環境がない場合**: ビルダー同梱の検証済み静的リンクバイナリ（`builder/bin/`）を自動的に活用してパッケージングを完遂する「フォールバック機能」を標準装備。
2. **自動品質検証（テスト連携）**:
   - ビルド前に全自動テスト（現在27テスト）を実行し、テストが全件パスした場合にのみリリースパッケージを生成します。
3. **ワンクリック実行**:
   - Windowsコマンドプロンプトやエクスプローラーから `build.bat` をダブルクリックするだけで全行程が自動完了します。
4. **デュアルリリース出力**:
   - `Release/` フォルダ下に、一般利用者向けの**「本ソフト配布用zip」**と、別環境で再ビルド可能な**「ビルダー配布用zip」**の2つを同時に生成します。

---

## 2. 動作前提条件

| ツール / 環境 | 必須 / 任意 | 推奨バージョン | 備考 |
| :--- | :---: | :---: | :--- |
| **OS** | **必須** | Windows 10 / 11 (64-bit) | PowerShell 5.1以上標準搭載 |
| **Node.js** | **必須** | v18.0.0 以上 (LTS推奨) | [公式サイト](https://nodejs.org/) よりインストーラーで導入 |
| **npm** | **必須** | v9.0.0 以上 | Node.js に同梱されています |
| **MinGW-w64 (g++)** | *任意* | 11.0 以上 (13.2推奨) | C++バイナリのソース再コンパイルを行う場合のみ必要。未導入時は同梱バイナリを自動利用 |
| **CMake & Ninja** | *任意* | CMake 3.20+ | LLM Gateway 本体のフルソース再ビルドを行う場合のみ必要 |

> **Node.js さえ入っていれば、C++ コンパイラが未インストールのPCでも完全な配布パッケージが生成できます。**

---

## 3. 異なる環境でのビルド手順

### 手順 A: ビルダー配布用zipからのビルド（推奨）

1. 配布された **`vta-builder-package.zip`** を、ビルド対象のPCの任意のフォルダ（例: `C:\Dev\VTA_Builder`）に展開します。
2. フォルダ直下の **`build.bat`** をダブルクリックして実行します。
3. 画面の指示に従い、自動的に以下の処理が実行されます：
   - `[1/6]` Node.js / npm / コンパイラの診断
   - `[2/6]` フロントエンド依存関係の解決（`npm ci` / `npm install`）
   - `[3/6]` ユニットテストの実行（27 tests PASS）
   - `[4/6]` フロントエンド本番バンドルのビルド（`dist/` 出力）
   - `[5/6]` ネイティブバイナリの検証・コンパイル
   - `[6/6]` `Release/` ディレクトリへのzip生成
4. 処理が完了すると、`Release/` フォルダ内に以下の2つの成果物が生成されます：
   - **`vta-analysis-package.zip`**: 一般利用者へ配布する完成版ソフトウェアパッケージ
   - **`vta-builder-package.zip`**: さらに別の環境へ持ち運べるビルダーパッケージ

---

## 4. コマンドライン・詳細オプション

PowerShell またはコマンドプロンプトからオプション引数を渡して実行することも可能です。

### PowerShell での実行例:
```powershell
# 基本実行 (全工程自動実行)
powershell -ExecutionPolicy Bypass -File builder/build.ps1

# C++の再コンパイルをスキップし、同梱バイナリを使って高速ビルド
powershell -ExecutionPolicy Bypass -File builder/build.ps1 -SkipNative

# 自動テストをスキップして即座にパッケージング
powershell -ExecutionPolicy Bypass -File builder/build.ps1 -SkipTests

# npmモジュールを強制再インストール
powershell -ExecutionPolicy Bypass -File builder/build.ps1 -ForceInstall

# 出力先フォルダを明示的に指定
powershell -ExecutionPolicy Bypass -File builder/build.ps1 -OutputDir "D:\Deploy\Output"
```

### コマンドプロンプト (`build.bat`) での引数渡し:
```cmd
build.bat -SkipNative -SkipTests
```

---

## 5. 出力フォルダ（`Release/`）の構造

ビルドが完了すると、プロジェクトルート直下に `Release` フォルダが作成（または更新）されます。

```text
Release/
├── vta-analysis-package/      # 展開状態のアプリ配布物（ビルダーが更新）
├── vta-analysis-package.zip   # 【本ソフト配布用】Node.js不要・即座に使える完全スタンドアロン実行版
└── vta-builder-package.zip    # 【ビルダー配布用】別環境で本ソフトをビルド・改造できるソース＋ビルダー一式
```

`-OutputDir` を指定すると、このフォルダと2つのzipを指定先に出力します。一時的なビルダー梱包作業は `scratch/builder-staging/` で行います。

生成済みアプリ配布物のフロントエンドだけを更新するには、`npm run build` の後に `npm run package` を実行してください。既定の `Release/vta-analysis-package/` を更新して `Release/vta-analysis-package.zip` を生成します。初回は `build.bat -SkipNative` で一式を生成する必要があります。

### 各zipパッケージの違い
- **`vta-analysis-package.zip` (約19.5 MB)**:
  - エンドユーザー用。Node.jsやnpm、コンパイラを一切必要とせず、解凍して `start.bat` または `vta-starter.exe` をクリックするだけで即座に起動します。
- **`vta-builder-package.zip` (約25 MB)**:
  - 開発者・運用者・CI用。TypeScriptソースコード、C++ソースコード、テストスイート、ビルダー本体が同梱されており、展開したPC上で `build.bat` を叩けばいつでも本ソフトを再生成できます。

---

## 6. トラブルシューティング

### Q1. `Node.js がインストールされていません` と表示される
- **原因**: 実行環境に Node.js がインストールされていないか、PATH が通っていません。
- **対処**: [Node.js 公式サイト (LTS版)](https://nodejs.org/) よりインストーラーをダウンロードして導入し、コマンドプロンプトを開き直してください。

### Q2. PowerShell の実行ポリシーエラーが出る
- **原因**: Windowsの既定セキュリティにより `.ps1` の実行が制限されています。
- **対処**: 直接 `.ps1` を実行するのではなく、同梱の **`build.bat`** をダブルクリックして実行してください（自動的に `-ExecutionPolicy Bypass` を適用して実行されます）。

### Q3. オフライン環境（社内閉域網）でビルドしたい
- **対処**: 初回のみインターネット接続環境で `npm install` を実行し、生成された `node_modules` フォルダごとオフライン機にコピーして `build.bat` を実行してください。ビルダーは既存の `node_modules` を検出すると自動的に外部通信をスキップしてローカルビルドへ移行します。

---

## 7. 分析手法・ライセンス
- **分析手法**: バリエーションツリー分析（VTA: Variation Tree Analysis、ヒューマンファクタ分析手法）
- **ライセンス**: MIT License
