# LLM Gateway

Windows 向けの OpenAI 互換ローカルゲートウェイ（`llm-gateway.exe`）と、設定・起動・資格情報管理用 GUI（`MaintenanceTool.exe`）です。外部 Provider（OpenRouter、LM Studio、Ollama 等）への中継と、任意で GGUF による組み込み Embedding / Rerank を提供します。

## 初回起動（GUI のみで完結）

1. `MaintenanceTool.exe` を起動し、`Open Config...` で設定ファイルを選びます（無ければ新規作成の状態で始まります）。配布物の `config/llm-gateway.external-only.example.json` をコピーして `llm-gateway.json` として使うこともできます。
2. Providers & Routing タブで `+ OpenRouter Preset` 等を追加し、Credentials タブで対象行を選択して `New Key / Value` に入力し、`Save Key` で API キーを登録します（Windows 資格情報マネージャーに保存。設定ファイルには書かれません）。
3. Credentials 欄でクライアント用／管理用トークンを生成します（コピー後 30 秒でクリップボードを消去しますが、GUI を開いたままにする必要があります）。
4. `Save Config` で保存し、`Start` で起動します。状態バナーで未保存・保存済み・適用済みを確認できます。

CLI での起動: `llm-gateway.exe --config <path>`。ヘルス確認: `http://127.0.0.1:8765/health`。

## 診断

- ログ: 既定は `%LOCALAPPDATA%\LLM-Gateway\logs`。GUI のログ欄は最新 5000 行のみ表示します（表示上限でファイルは切り詰めませんが、日別ログは古いファイルを削除します。固定ログには自動ローテーションがありません）。
- 組み込みモデルが無い／壊れている場合でも外部 Provider は動作し、組み込みモデル宛のみ `503` になります（Health の `embedded` が `error`）。
- 設定の旧 v1.0 形式は読込時に変換され、保存時に上書き／別名保存を選べます（`CONFIG_COMPATIBILITY.md` 参照）。

## 資格情報の登録形式

Providerキーは`vendor|slot@サービス名`（例: `openrouter|default@CloudLLM`）で検索・登録します。Windows資格情報マネージャーで登録したUTF-16LEのパスワードと、GUIが保存するUTF-8の両方を読み込めます。誤った`サービス名/vendor|slot`形式は検索・登録・削除しません。自動移行もしません。Client/Adminトークンも`llm_gateway|default@CloudLLM` / `llm_gateway|admin@CloudLLM`が標準です。誤った形式で生成済みのトークンは、GUIから再登録し、クライアント側も更新してください。

## 資格情報の移行

API キーとトークンは Windows 資格情報マネージャー（ユーザー単位）に保存され、別 PC・別ユーザーへはコピーされません。新しい環境では GUI から再登録してください。

## 組み込み推論（任意）

GGUF モデル（例: bge-m3、bge-reranker-v2-m3）は同梱されません。各自で入手し、GUI の `Browse...` でパスを指定します。モデルごとのライセンスに従ってください。

## ビルドと配布

配置とパスの解決規則は[ファイル配置](FILE_LAYOUT.md)を参照してください。両EXEは同じフォルダに置きます。設定例は自動読込されません。

CMake 3.25以上とVisual Studio 2022 C++ x64 toolchainが必要です。リポジトリルートで実行します。依存は版とSHA-256を固定して取得します。

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
cmake --build build --config Release --target verify_imports
# 上記がすべて成功してから、bin内の両EXEが停止中であることを確認して実行
New-Item -ItemType Directory -Force bin | Out-Null
Copy-Item build/Release/llm-gateway.exe bin/ -Force
Copy-Item build/Release/MaintenanceTool.exe bin/ -Force
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

通常ビルドは`bin/`を更新しません。CIは同じ検証とコピーの後に配布を作成します。`package.ps1`自体はビルド・試験を実行せず、`bin/`のEXEと`build/_deps/`のライセンス全文を使用します。実設定を上書きする必要はありません。

許可リスト方式で`dist/`にZIPとZIP外の`SHA256SUMS.txt`を出力します。実設定・ログ・モデル・build・個人用引き継ぎ書は含みません。配布前にZIP内EXEのSHA-256と検証した成果物の一致を確認してください。ZIP展開先には`bin/`がなく、両EXEは直下です。

## ライセンス

本プロジェクトは MIT License（Copyright (c) 2026 HAIA Project、`LICENSE` 参照）で配布します。サードパーティの表示は `NOTICE.md` と `THIRD_PARTY_LICENSES/` を参照してください。
