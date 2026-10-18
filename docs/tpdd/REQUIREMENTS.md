# TPDD-Editor 要件定義書

文書版1.0／2026-10-18／実装基準 `493c052`。共通の境界・記載ルール・非機能要件は[共通要件](../REQUIREMENTS.md)を適用する。本書は現行実装からの再構成であり、受入済みの宣言ではない。

## 1. 目的・対象業務

要求・機能・機構・構造などの設計思考を、抽象度列、ノード間関係、階層的な詳細図で整理する。利用者は手動で図を作成・修正し、AIの展開案・代替案・図レビューを判断材料として利用し、JSONで作業を保存し、SVG/PNGで成果を共有する。

想定利用者は設計担当者・要求整理担当者・レビュー担当者。設計の適合性判定、要求の承認、変更管理システムへの登録、自動的な設計確定は対象外である。

## 2. 業務フロー・ユースケース

| UC | フロー | 正常終了 | 代替・例外 |
| --- | --- | --- | --- |
| TP-UC01 | 新規作成→タイトル・列設定→ノード追加→関係線作成 | 構造化したルート図を編集できる | 入力上限・不正参照を通知し、不正変更を確定しない |
| TP-UC02 | ノード選択→詳細図作成→子図編集→ツリーで移動 | 親子階層を維持する | 子図を持つ要素の削除時は影響を確認する |
| TP-UC03 | 対象ノード選択→送信内容確認→AI実行→候補選択→採用 | 選択候補を1操作で追加する | 中止・不正応答・実行後編集による不整合では採用しない |
| TP-UC04 | JSON保存→別セッションで読込 | 検証済みのProjectを復元する | 形式不正は拒否。修正可能なデータは確認付き救出読込を選べる |
| TP-UC05 | 起動→自動保存候補確認→復元または削除 | 選択したスナップショットを復元する | 候補なし／保存領域利用不可でも通常編集を継続する |
| TP-UC06 | 表示図をSVG/PNG出力、または全図SVG出力 | 共有用ファイルをダウンロードする | 出力失敗は通知する。JSONの代用としては扱わない |

## 3. 画面・操作要件

上部ツールバー、左の図階層・モデル設定、中央SVGキャンバス、右の詳細/AIパネル、下部状態表示で構成する。プロジェクト設定・列設定・Gateway設定・モデル探索・復旧候補は専用画面で扱う。

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| TP-F01 | 空のルート図を持つ新規Projectを作成し、名称・説明を編集できること | T1、T3 | 新規作成でルート図1件・ノード0件となり、設定変更が保存対象へ反映される |
| TP-F02 | ノードを追加・編集・削除し、種別、状態、所属列、説明、タグ、参照リンクを保持すること | T1、T2、T3 | 各項目が図・詳細表示・JSONで一致する。不正値は通常編集で確定しない |
| TP-F03 | ノード削除時に接続エッジと紐づく詳細図を整合的に削除すること | T1、T3 | 削除後に参照切れがなく、Undoで復元できる |
| TP-F04 | 複数選択、範囲選択、単体・複数ドラッグ、インプレース編集を提供すること | T3 | 選択された要素だけを操作し、ドラッグを履歴へ確定できる |
| TP-F05 | 関係線を作成・種別変更・ラベル編集・削除できること | T1、T3 | 同じ図内の2ノードを接続し、自己接続・同方向同種重複を拒否する |
| TP-F06 | ズーム・パンを図ごとに保持し、座標変換して操作すること | T3 | ズームを変えてもポインタ位置と移動対象が一致する |
| TP-F07 | 列を追加・改名・並替え・削除でき、削除時に所属ノードを別列へ再割当てすること | T1、T3 | 列削除後に存在しないlevelIdが残らない |
| TP-F08 | ノードに詳細図を作成し、ツリーで切替・改名・削除できること | T1、T3 | 同じノードの既存詳細図を再利用し、削除後の表示先を有効な図にする |
| TP-F09 | 現在図を列に沿って自動配置できること | T3、T6 | ノード位置が更新され、1回のUndoで元の配置に戻る |
| TP-F10 | 最大50件のProject履歴に対してUndo/Redoできること | T1 | 新規確定編集でRedoを破棄し、子図作成取消後も有効な図を編集できる |

### キーボード・ポインタ操作

| 操作 | 現行の割当て |
| --- | --- |
| Undo / Redo | CtrlまたはCmd+Z、CtrlまたはCmd+Y、CtrlまたはCmd+Shift+Z |
| 削除 | Delete / Backspace。子図がある場合は確認 |
| 編集開始 | 選択ノードでF2 |
| 位置微調整 | 矢印1px、Shift+矢印10px |
| 一時操作中止 | Escape |
| パン | 中ボタンドラッグ、Space+左ドラッグ |
| ズーム | ホイール。25%～400% |

IME入力中、入力欄編集中、対応モーダル表示中はキャンバス操作との競合を抑止する。非表示時はキー購読を停止する。TPDDにVTAと同じCtrl+S/O/Eがあるとは定義しない。

## 4. データ要件

### 4.1 保存モデル

| エンティティ | 主な属性・規則 |
| --- | --- |
| Project | format、schemaVersion、id、title、description、createdAt、updatedAt、rootDiagramId、levels、diagrams、aiPreferences |
| LevelDefinition | id、label、order。列の並び順を定義 |
| Diagram | id、title、nodes、edges。1つのルート図と親ノードから参照される詳細図 |
| ThoughtNode | id、label、kind、status、levelId、x/y、width/height、childDiagramId、meta、provenance |
| meta | description、tags、sourceLinks。リンクはHTTP/HTTPS URL |
| provenance | origin=manual/llm、createdAt、任意のmodelId/task/promptVersion/requestId |
| ThoughtEdge | id、sourceId、targetId、kind、label |
| aiPreferences | modelId、timeoutSeconds、temperature、stream |

ノード種別はrequirement/function/mechanism/structure/constraint/note。状態はdraft/candidate/adopted/rejected。線の種別はdecomposition/dependency/constraint/reference。列はノード種別とは別の属性であり、初期列は要求・機能・機構・構造の4列である。

| ID | データ整合性要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| TP-D01 | 図・ノード・エッジのIDを各種類についてProject全体で一意とし、参照先の存在を検証すること | T2 | 重複ID・未定義列・未定義ノードを含む通常読込を拒否する |
| TP-D02 | ルート図に親を持たせず、共有子図・孤立図・循環階層を拒否すること | T2 | 各不整合を作った入力で検証エラーを返す |
| TP-D03 | 位置・サイズ・入力長・件数をスキーマ範囲内に制限すること | T1、T2 | 境界値を受理し、境界超過を通常の確定操作・通常保存で拒否する |
| TP-D04 | 選択・viewport・ドラッグ・モーダル・Gateway Token・Undo履歴をProject JSONへ含めないこと | T1、T4 | 保存JSONを検査して永続モデルとの分離を確認する |

### 4.2 数値制約

| 対象 | 現行値 |
| --- | --- |
| Project/図/列/ノードの名称、エッジラベル | 最大200文字。主要名称は非空、エッジラベルは空可 |
| Project説明、ノード説明 | 最大10,000文字 |
| タグ | ノード当たり20件、各1～100文字 |
| リンク | ノード当たり20件、各最大2,048文字 |
| 列数 / 図数 | 1～12列 / 1～100図 |
| 1図内 | 最大500ノード・1,000エッジ |
| Project全体 | 最大5,000ノード・10,000エッジ |
| ノード座標 | x/yとも有限値、−1,000,000～1,000,000 |
| ノード寸法 | 幅120～1,000、高さ48～2,000 |
| JSON入力 | 最大10MiB（10×1024×1024バイト） |
| 履歴 / 復旧候補 | 最大50操作 / IndexedDB最大10スナップショット |

根拠はT2・T4。件数上限は性能保証ではなく検証境界である。文字長はJavaScript/Zodの文字列長による。

## 5. 保存・復旧・出力要件

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| TP-P01 | 検証済みProjectを`.tpdd.json`としてダウンロード保存すること | T4 | 日本語・階層・メタデータ・AI設定を保存して再読込できる。検証失敗は成功通知にしない |
| TP-P02 | format=`tpdd-project`または旧`thought-expansion-project`、schemaVersion=1を受け入れること | T2、T4 | 現行・旧形式のサンプルを読め、未知形式・未知版・破損JSONを拒否する |
| TP-P03 | 構造の一部が残る検証不適合ファイルに確認付きの救出読込を提供すること | T3、T4 | 通常読込失敗を明示し、利用者が確認した場合だけ警告付きで読込む。通常保存は修正完了まで拒否する |
| TP-P04 | 確定変更後1秒のdebounceでIndexedDBへ保存し、保存中・保存済み・失敗を表示すること | T1、T4 | 変更連続時に待機を延長し、保存拒否時は失敗状態となる |
| TP-P05 | 起動時に有効な復旧候補を新しい順で提示し、復元・削除できること | T4 | 選択したProjectを復元し、不正スキーマを通常復旧候補から除外する |
| TP-P06 | 現在図SVG、現在図PNG、全図SVGをダウンロードできること | T3、T6 | 日本語・改行・特殊文字・負座標を含む図を出力できる。全図出力は各図のファイルを生成する |

自動保存のキーはブラウザタブのセッション単位であり、同一セッションの各編集で上書きする。「直近10操作の履歴保存」ではない。ノード総数0のProjectは自動保存対象から外れる。自動保存とJSON保存は別の機能であり、JSONの更新を自動保存が代行しない。

## 6. AI支援・接続設定要件

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| TP-A01 | 選択ノードの展開案・代替案、現在図全体のレビューを実行できること | T5 | 展開/代替で未選択なら案内し、レビューはノード選択なしで実行できる |
| TP-A02 | 展開/代替は対象と1-hop近傍、レビューは現在図全体を送信範囲にすること | T5 | リクエストのノード・線が指定範囲と一致する。別の詳細図全体を無条件に送信しない |
| TP-A03 | 追加指示と送信内容プレビューを提供すること | T5 | 実行前に対象と要求内容を確認できる |
| TP-A04 | JSON応答の形式・列ID・候補参照・レビュー対象参照を検証すること | T5 | 不正JSONや存在しない参照を採用可能な結果にしない |
| TP-A05 | 候補を個別選択して一括採用し、未選択候補に依存する線を除外すること | T5 | 選択数・追加数・除外数が一致し、1回のUndoで採用を取り消せる |
| TP-A06 | 採用ノードをcandidate状態で追加し、AI来歴と提案理由・前提・確認事項を保持すること | T5 | provenance.origin=llmとなり、利用者の採用判断後も自動でadoptedにはしない |
| TP-A07 | 実行開始時revisionと対象図IDを記録し、不一致なら採用を拒否すること | T1、T5 | 推論後に編集・Undo・図切替した場合に整合性警告を示す |
| TP-A08 | 非ストリーム/SSEを選択でき、SSEの文字数進捗とキャンセルを提供すること | T5 | 分割UTF-8応答を連結し、キャンセル・タイムアウトを通知する |
| TP-A09 | モデル一覧取得・探索・検索・お気に入り・カスタムID入力を提供すること | T7 | GatewayのIDを失わず選択し、ProjectのmodelIdへ反映する |
| TP-A10 | Gateway URL、認証有効、メモリ内Token、温度、timeout、streamを設定できること | T4、T7 | `/v1`または許可loopback URLを検証し、設定値を適切な保存先へ反映する |

初期AI設定はmodelId=`openrouter/google/gemini-3.8-flash`、timeout=600秒、temperature=0.2、stream=false。timeoutは30～1,800秒、温度は0～2またはnull。モデル一覧取得は30秒timeout、応答文字列長チェックは2×1024×1024。これは受信前のバイト制限ではない。

応答スキーマの許容値は候補ノード1～10件、候補線最大20件、レビュー指摘最大30件。プロンプト上の希望件数（展開1～6、代替1～4、レビュー最大10）と検証上限を区別する。レビュー分類はmissing/conflict/ambiguity/verification、重要度はinfo/warning。

## 7. 制約・要確認事項

- 通常編集・保存の整合性検証と救出モードは別経路である。救出読込は任意の破損データの描画・修復成功を保証しない。`allowInvalidRescue`による救出保存はサービスAPIに存在するが、独立した通常UI機能としては定義しない。
- 空Projectを自動保存しないため、全ノード削除後の状態や名称・列だけの変更を確実に復旧する要件は、現行実装だけでは満たすと断定できない。
- 多人数共同編集、ブラウザタブ間の履歴同期、永続的な版管理はない。revisionはメモリ内の整合性用であり、監査用の保存版番号ではない。
- ノード数上限と「何ms以内に描画するか」は別である。旧文書の100ms等を正式な性能要件にするには測定条件の合意が必要。
- モデル名・お気に入り初期値は実装定数であり、プロバイダの提供状況は文書作成時に外部検証していない。

## 8. 実装・試験トレーサビリティ

| 根拠 | 主なソース | 既存の確認用テスト |
| --- | --- | --- |
| T1 状態・変更・履歴 | [AppContext.tsx](../../src/tools/tpdd/app/AppContext.tsx)、[commands.ts](../../src/tools/tpdd/domain/commands.ts)、[history.ts](../../src/tools/tpdd/domain/history.ts) | [階層](../../tests/tpdd/domain/hierarchy.test.ts)、[子図Undo](../../tests/tpdd/features/undoSubDiagram.test.ts) |
| T2 スキーマ | [schema.ts](../../src/tools/tpdd/domain/schema.ts)、[validation.ts](../../src/tools/tpdd/domain/validation.ts) | [スキーマ](../../tests/tpdd/domain/schema.test.ts)、[検証一貫性](../../tests/tpdd/services/validationConsistency.test.tsx) |
| T3 編集UI | [App.tsx](../../src/tools/tpdd/app/App.tsx)、[Canvas.tsx](../../src/tools/tpdd/features/editor/Canvas.tsx)、[Toolbar.tsx](../../src/tools/tpdd/features/editor/Toolbar.tsx)、[DetailPanel.tsx](../../src/tools/tpdd/features/editor/DetailPanel.tsx)、[LevelsModal.tsx](../../src/tools/tpdd/features/editor/LevelsModal.tsx)、[DiagramTree.tsx](../../src/tools/tpdd/features/editor/DiagramTree.tsx) | [複数選択](../../tests/tpdd/features/multiSelectAndInteraction.test.ts)、[通知・キー](../../tests/tpdd/features/notificationAndKeyActions.test.ts) |
| T4 保存・復旧・端末設定 | [fileIo.ts](../../src/tools/tpdd/services/persistence/fileIo.ts)、[indexedDb.ts](../../src/tools/tpdd/services/persistence/indexedDb.ts)、[appStorage.ts](../../src/tools/tpdd/services/persistence/appStorage.ts)、[RecoveryModal.tsx](../../src/tools/tpdd/features/editor/RecoveryModal.tsx) | [ファイル](../../tests/tpdd/services/fileIo.test.ts)、[保存失敗](../../tests/tpdd/services/indexedDbAutoSave.test.ts) |
| T5 AI | [AiPanel.tsx](../../src/tools/tpdd/features/ai/AiPanel.tsx)、[prompts.ts](../../src/tools/tpdd/services/llm/prompts.ts)、[aiSchemas.ts](../../src/tools/tpdd/services/llm/aiSchemas.ts)、[proposalAdopter.ts](../../src/tools/tpdd/features/ai/proposalAdopter.ts)、[gatewayClient.ts](../../src/tools/tpdd/services/llm/gatewayClient.ts) | [AI提案](../../tests/tpdd/features/aiProposal.test.ts)、[Gateway](../../tests/tpdd/services/gatewayClient.test.ts)、[SSE](../../tests/tpdd/services/sseParser.test.ts) |
| T6 描画・出力 | [autoLayout.ts](../../src/tools/tpdd/rendering/autoLayout.ts)、[svgExport.ts](../../src/tools/tpdd/rendering/svgExport.ts) | [SVG](../../tests/tpdd/rendering/svgExport.test.ts)、[大規模図](../../tests/tpdd/rendering/largeDiagram.test.ts) |
| T7 接続・モデルUI | [GatewayConfigModal.tsx](../../src/tools/tpdd/features/settings/GatewayConfigModal.tsx)、[ModelExploreModal.tsx](../../src/tools/tpdd/features/settings/ModelExploreModal.tsx)、[CustomModelModal.tsx](../../src/tools/tpdd/features/settings/CustomModelModal.tsx) | 接続クライアントテストに加え、設定・探索操作の実ブラウザ確認が必要 |

代表的な業務受入はTP-UC01→02→03→04→06の連続操作、およびTP-UC05の再起動復旧とする。単体テストの存在だけを、この連続操作の合格判定に使わない。
