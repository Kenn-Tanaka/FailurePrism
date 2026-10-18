# ファイル配置と実行時パス

## リポジトリと生成物

以下の相対パスはリポジトリルート基準です。`build/Release/` はREADMEのVisual Studio Release手順の場合です。

```text
<repository>/
  .github/workflows/ci.yml       ビルド・試験・配布のCI
  cmake/                        依存取得、静的ランタイム、DLL検査
  config/                       秘密を含まない設定例（実設定ではない）
  include/gateway/, src/gateway/ Gatewayの宣言・実装
  include/maintenance/, src/maintenance/ GUIの宣言・実装
  tests/unit/, integration/, security/   自動試験
  scripts/package.ps1           許可リストによるZIP作成
  CMakeLists.txt                 ビルド定義
  README.md, FILE_LAYOUT.md, CONFIG_COMPATIBILITY.md
  LLM_Gateway_Requirements_definition_document.md
  LLM_GATEWAY_MAINTENANCE_TOOL_IMPLEMENTATION_SPEC_2.0.md
  NOTICE.md, LICENSE, AGENTS.md, CHANGELOG.md
  build/                        Git管理外の生成物
    Release/                    両EXE、テストEXE、プロジェクトのライブラリ
    _deps/                      依存ソースと依存ビルド成果物
    Testing/                    CTestの結果
  bin/                          Git管理外の配布準備用EXE（手動またはCIでコピー）
  dist/                         Git管理外のZIPとSHA256SUMS.txt
```

依存ライブラリの生成物は各依存ビルドディレクトリにも置かれます。通常ビルドは`bin/`を更新しません。`resources/`は現行のGit管理対象・必須実行資源ではありません。実設定、ログ、GGUF、個人用引き継ぎ資料は配布対象ではありません。

## ZIP展開後

ZIP内に版名の親フォルダはありません。専用の空フォルダへ展開してください。

```text
<展開先>/
  llm-gateway.exe
  MaintenanceTool.exe
  README.md
  FILE_LAYOUT.md
  CONFIG_COMPATIBILITY.md
  NOTICE.md
  LICENSE
  config/
    llm-gateway.example.json
    llm-gateway.external-only.example.json
  THIRD_PARTY_LICENSES/          静的リンクした依存のライセンス全文
```

両EXEは同じディレクトリに置きます。GUIは隣接する`llm-gateway.exe`だけを起動します。設定例は自動では読み込まれません。GGUF本体も同梱しません。`models/`は任意に利用者が作るディレクトリです。

`dist/LLM-Gateway-<Version>.zip`と`dist/SHA256SUMS.txt`は別ファイルです。ハッシュ一覧はZIP外にあり、収録ファイルの展開先相対パスとZIP自体のハッシュを含みます。配布スクリプトは`%TEMP%\LLM-Gateway-pkg\LLM-Gateway-<Version>`で組み立て、成功後も作業領域を残します。同じ版の再実行時にはその領域を再作成します。

## 設定選択

| 起動方法 | 選択順・不在時の動作 |
|---|---|
| Gatewayの明示`--config <path>` | 指定ファイルのみ。相対指定は呼出元の作業ディレクトリ基準。不在時は失敗し、別の設定へ切り替えない |
| Gateway Release・指定なし | `%LOCALAPPDATA%\LLM-Gateway\llm-gateway.json`。不在時は起動失敗。EXE隣接設定を自動探索しない |
| Gateway Debug・指定なし | 既存LOCALAPPDATA設定を優先。不在時だけ作業ディレクトリの`llm-gateway.json`。どちらもなければ起動失敗 |
| GUIの明示`--config <path>` | 存在する通常ファイルのみ。相対指定をGUIの作業ディレクトリから絶対化 |
| GUI・指定なし | 既存LOCALAPPDATA設定→EXEディレクトリの書込可能ACLを確認した既存隣接`llm-gateway.json`→LOCALAPPDATAを新規保存先に選択 |
| GUIのOpen Config | 既存ファイルまたは新規保存先を指定。新規設定はSaveするまで作成しない |

GUIは選択した設定の絶対パスをGatewayへ渡します。既存ファイルが不正な場合、別の設定へ黙ってfallbackしません。GUIが新規設定を作れることと、Gatewayが不在の設定で起動できることは別です。

## 実行時のデータ

| 対象 | 配置・解決規則 |
|---|---|
| Gatewayの作業ディレクトリ | CLIでは呼出元の作業ディレクトリを継承。GUI経由ではGateway EXEの親ディレクトリ |
| モデルの`path` | 相対パスはGatewayの作業ディレクトリ基準。設定JSONの場所を基準にしない。環境変数は展開しない。UNCは拒否 |
| `logging.dir` | 環境変数を展開し、相対パスはGatewayの作業ディレクトリ基準。既定は`%LOCALAPPDATA%\LLM-Gateway\logs`。必要なディレクトリを作成 |
| `logging.file` | 指定時はdirより優先。環境変数と相対パスの扱いは同じ。固定ファイルへ追記し、自動削除・ローテーションはしない |
| 日別ログ | `llm-gateway-YYYYMMDD.log`。起動・日付変更時に既存候補を名前降順で7件残す。当日ファイル作成前の整理なので一時的に8件となり得る。厳密な7日保持ではない |
| 設定保存の一時ファイル | 保存対象の親に`<設定名>.<乱数>.tmp`を作成し、Flush後に対象へ置換。通常の失敗時は削除。強制終了時は残留し得る。専用ACLはなく親から継承。自動バックアップはない |
| 資格情報 | Windows資格情報マネージャーのユーザー領域。Providerは`<vendor>|<slot>@<service_name>`。Client/Adminは`llm_gateway|default@<service_name>` / `llm_gateway|admin@<service_name>`。設定上の相対名には`@service_name`を付け、`@`を含む完全名はそのまま使用。`/`を含む名前は拒否 |

明示`--config`文字列はアプリ内では環境変数展開しません。PowerShellでは必要に応じて`$env:LOCALAPPDATA`等をシェル側で展開してください。未定義の`%変数%`をログパスへ指定した場合、Windowsの展開処理で未展開のまま残る可能性があります。

GUIのLogsは稼働中設定を優先し、停止中は選択中設定のログを表示します。参照先変更時に表示・Tail位置をリセットします。相対ログパスは隣接Gateway EXE基準です。別の作業ディレクトリから直接起動したGatewayへ再接続する場合、その実際の作業ディレクトリは取得できないため、絶対ログパスを使用してください。GUIで別設定を開くと編集用資格情報ストアも切り替わりますが、停止用資格情報は稼働中設定を保持します。

設定読込失敗時はstderrと既定の日別ログへ記録を試みます。ログ書込失敗時はstderrへ警告し、TEMPへの再試行はありません。CPU不適合・Mutex競合はログ初期化前なのでstderrのみです。

## 配置例

`C:\Apps\Gateway`に両EXE、`D:\Settings\gateway.json`に設定、設定内に`models/model.gguf`と`logs`がある場合:

- GUI経由: `C:\Apps\Gateway\models\model.gguf`と`C:\Apps\Gateway\logs`を参照。
- `D:\Work`からCLIでEXEと設定を絶対指定: `D:\Work\models\model.gguf`と`D:\Work\logs`を参照。
- `D:\Settings`は相対モデル・ログパスの基準にならない。

フォルダを移す場合もLOCALAPPDATAの設定・ログ、WinCred、絶対指定した外部GGUFは一緒に移動しません。Portableはインストーラー不要の意味です。

## 残る検証・改善事項

- 実フルサイズGGUFの推論品質、実Providerとの通信、Windows 10/11クリーン環境、長時間運用。
- GUIの対話操作を含む通し試験、UIタイマーの同期通信・ログI/Oの非同期化。
- 固定ログの容量管理、再起動失敗時の自動復旧、設定バックアップ。
- HTTP・推論を含むgateway_coreから小規模な共通ライブラリを分離する設計改善。

実装済みの自動試験と、上記の実環境・手動検証を区別してください。
