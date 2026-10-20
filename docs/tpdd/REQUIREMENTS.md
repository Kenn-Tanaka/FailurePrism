# TPDD-Editor 要件定義書

文書版2.0／2026-10-20。共通の境界・記載ルール・非機能要件は[共通要件](../REQUIREMENTS.md)を適用する。本書は開発中のschema v2を実装基準とし、schema v1以前とのデータ互換性は要件に含めない。

## 1. 目的・対象業務

設計分野ごとにユーザーが定義した種別と抽象度列を用いて、設計思考をノード間関係および階層的な詳細図として整理する。機械設計・ソフトウェア設計・電子回路設計のプリセットを出発点に、名称と意味をプロジェクト固有に変更できる。利用者は手動で図を作成・修正し、AIの展開案・代替案・図レビューを判断材料として利用し、JSONで作業を保存し、SVG/PNGで成果を共有する。

想定利用者は設計担当者・要求整理担当者・レビュー担当者。設計の適合性判定、要求の承認、変更管理システムへの登録、自動的な設計確定は対象外である。

## 2. 業務フロー・ユースケース

| UC | フロー | 正常終了 | 代替・例外 |
| --- | --- | --- | --- |
| TP-UC01 | 新規作成→分野プリセット選択→設計体系設定→ノード追加→関係線作成 | 構造化したルート図を編集できる | 入力上限・不正参照を通知し、不正変更を確定しない |
| TP-UC02 | ノード選択→詳細図作成→子図編集→ツリーで移動 | 親子階層を維持する | 子図を持つ要素の削除時は影響を確認する |
| TP-UC03 | 対象ノード選択→送信内容確認→AI実行→候補選択→採用 | 選択候補を1操作で追加する | 中止・不正応答・実行後編集による不整合では採用しない |
| TP-UC04 | JSON保存→別セッションで読込 | 検証済みのProjectを復元する | 形式・必須構造の不正は拒否。必須構造を満たし参照整合性だけが不正なデータは確認付き救出読込を選べる |
| TP-UC05 | 起動→自動保存候補確認→復元または削除 | 選択したスナップショットを復元する | 候補なし／保存領域利用不可でも通常編集を継続する |
| TP-UC06 | 表示図をSVG/PNG出力、または全図SVG出力 | 共有用ファイルをダウンロードする | 出力失敗は通知する。JSONの代用としては扱わない |

## 3. 画面・操作要件

上部ツールバー、左の図階層・モデル設定、中央SVGキャンバス、右の詳細/AIパネル、下部状態表示で構成する。プロジェクト設定・設計体系設定・Gateway設定・モデル探索・復旧候補は専用画面で扱う。設計体系設定では種別と抽象度列の役割を明確に分け、分野プリセットは新規Project作成時の初期値として選択する。

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| TP-F01 | 新規作成モーダルで分野プリセットを選び、空のルート図を持つ新規Projectを作成できること | T1、T3 | 新規作成で既定名称のルート図1件・ノード0件となり、選択したプリセットの種別・列定義がProjectへコピーされる。Projectの名称・説明は作成後のProject設定で編集する |
| TP-F02 | ノードを追加・編集・削除し、ユーザー定義種別、状態、所属列、説明、タグ、参照リンクを保持すること | T1、T2、T3 | 各項目が図・詳細表示・JSONで一致する。不正値は通常編集で確定しない |
| TP-F03 | ノード削除時に接続エッジと紐づく詳細図を整合的に削除すること | T1、T3 | 削除後に参照切れがなく、Undoで復元できる |
| TP-F04 | 複数選択、範囲選択、単体・複数ドラッグ、インプレース編集を提供すること | T3 | 選択された要素だけを操作し、ドラッグを履歴へ確定できる |
| TP-F05 | 関係線を作成・種別変更・ラベル編集・削除できること | T1、T3 | 同じ図内の2ノードを接続し、自己接続・同方向同種重複を拒否する |
| TP-F06 | ズーム・パンを図ごとに保持し、座標変換して操作すること | T3 | ズームを変えてもポインタ位置と移動対象が一致する |
| TP-F07 | 列の名前、AI向け説明、配列順を編集でき、追加・削除時の参照整合性を保つこと | T1、T2、T3 | 列削除時に所属ノードを再割当てし、存在しないlevelIdが残らない |
| TP-F08 | ノードに詳細図を作成し、ツリーで切替・改名・削除できること | T1、T3 | 同じノードの既存詳細図を再利用し、削除後の表示先を有効な図にする |
| TP-F09 | 現在図を列に沿って自動配置できること | T3、T6 | ノード位置が更新され、1回のUndoで元の配置に戻る |
| TP-F10 | 最大50件のProject履歴に対してUndo/Redoできること | T1 | 新規確定編集でRedoを破棄し、子図作成取消後も有効な図を編集できる |
| TP-F11 | 種別の名前、AI向け説明、パレット、配列順をユーザーが管理できること | T1、T2、T3 | 種別の追加・編集・並べ替え・削除を適用でき、配列先頭を新規ノードの既定種別とする。削除時は使用中ノードを別種別へ再割当てして未定義kindIdを残さない |
| TP-F12 | 機械設計・ソフトウェア設計・電子回路設計・カスタムを新規Projectのプリセットとして提供すること | T1、T3 | プリセット適用後も全定義を自由に編集でき、固定語彙を強制しない |
| TP-F13 | 種別と列の役割をUIで区別して説明すること | T3 | 種別を「ノードが何を表すか」、列を「設計上の段階・観点と図上の配置先」として説明する |

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
| Project | format、schemaVersion=2、id、title、description、createdAt、updatedAt、rootDiagramId、nodeKinds、levels、diagrams、aiPreferences |
| NodeKindDefinition | id、label、description、paletteKey。ノードの意味分類と表示を定義。配列順を表示順とし、先頭を新規ノードの既定種別とする |
| LevelDefinition | id、label、description。配置列の意味を定義し、配列順を左から右の表示順とする |
| Diagram | id、title、nodes、edges。1つのルート図と親ノードから参照される詳細図 |
| ThoughtNode | id、label、kindId、status、levelId、x/y、width/height、childDiagramId、meta、provenance |
| meta | description、tags、sourceLinks。リンクはHTTP/HTTPS URL |
| provenance | origin=manual/llm、createdAt、任意のmodelId/task/promptVersion/requestId |
| ThoughtEdge | id、sourceId、targetId、kind、label |
| aiPreferences | modelId、timeoutSeconds、temperature、stream |

ノード種別は固定enumではなくProject内の `NodeKindDefinition` を参照する。状態はdraft/candidate/adopted/rejected、線の種別はdecomposition/dependency/constraint/referenceとする。種別と列は独立属性であり、同名であることや1対1対応を前提にしない。プリセットは初期定義をコピーするだけであり、適用後の語彙を制限しない。

| ID | データ整合性要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| TP-D01 | 種別・列・図・ノード・エッジのIDを所定の範囲で一意とし、参照先の存在を検証すること | T2 | 重複ID、未定義kindId、未定義levelId、未定義ノードを含む通常読込を拒否する |
| TP-D02 | ルート図に親を持たせず、共有子図・孤立図・循環階層を拒否すること | T2 | 各不整合を作った入力で検証エラーを返す |
| TP-D03 | 位置・サイズ・入力長・件数をスキーマ範囲内に制限すること | T1、T2 | 境界値を受理し、境界超過を通常の確定操作・通常保存で拒否する |
| TP-D04 | 選択・viewport・ドラッグ・モーダル・Gateway Token・Undo履歴をProject JSONへ含めないこと | T1、T4 | 保存JSONを検査して永続モデルとの分離を確認する |
| TP-D05 | nodeKindsとlevelsを1件以上保持し、配列順を唯一の順序定義として扱うこと | T2 | 新規ノードのkindIdはnodeKinds先頭を参照し、描画・整列・AI文脈が同じ配列順を使用する |

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
| TP-P02 | format=`tpdd-project`かつschemaVersion=2だけを受け入れること | T2、T4 | schema v2を読め、schema v1以前・未知形式・未知版・破損JSONを明示的に拒否する。移行・自動変換は行わない |
| TP-P03 | schema v2の必須構造・型を満たし、参照整合性だけが不適合なファイルに確認付きの救出読込を提供すること | T3、T4 | UIが前提とするフィールド欠落や型不正はロードせず拒否する。参照整合性の不適合は通常読込失敗を明示し、利用者が確認した場合だけ警告付きで読込む。通常保存は修正完了まで拒否する |
| TP-P04 | 確定変更後1秒のdebounceでIndexedDBへ保存し、保存中・保存済み・失敗を表示すること | T1、T4 | 変更連続時に待機を延長し、保存拒否時は失敗状態となる |
| TP-P05 | 起動時に有効なschema v2復旧候補を新しい順で提示し、復元・削除できること | T4 | 選択したProjectを復元し、schema v1以前と不正スキーマを通常復旧候補から除外する |
| TP-P06 | 現在図SVG、現在図PNG、全図SVGをダウンロードできること | T3、T6 | 日本語・改行・特殊文字・負座標を含む図を出力できる。全図出力は各図のファイルを生成する |

自動保存のキーはブラウザタブのセッション単位であり、同一セッションの各編集で上書きする。「直近10操作の履歴保存」ではない。起動直後の完全未編集Projectだけを対象外とし、ノード総数0でも新規プリセット選択後または設計体系などの編集後は保存・復旧対象にする。自動保存とJSON保存は別の機能であり、JSONの更新を自動保存が代行しない。

## 6. AI支援・接続設定要件

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| TP-A01 | 選択ノードの展開案・代替案、現在図全体のレビューを実行できること | T5 | 展開/代替で未選択なら案内し、レビューはノード選択なしで実行できる |
| TP-A02 | 展開/代替は対象と1-hop近傍、レビューは現在図全体を送信範囲にすること | T5 | リクエストのノード・線が指定範囲と一致する。別の詳細図全体を無条件に送信しない |
| TP-A03 | 追加指示、送信内容、単一の配置先列を実行前に確認・変更できること | T5 | 展開案はフォーカスの次列（最終列では同じ列）、代替案はフォーカスと同じ列を既定とし、共有selectで変更した配置先のlabelとdescriptionをLLMへ送る |
| TP-A04 | LLMへ実IDを返させず、候補内容と一時的なkindRefだけを受け取ること | T5 | 展開・代替応答にcandidateId、levelId、edgeを要求せず、kindRefをProject内の種別へ解決する |
| TP-A05 | 候補を個別選択して一括採用し、接続線をアプリ側で決定すること | T5 | expandはfocusから候補へdecomposition、alternativesはfocusから候補へreference（ラベル「代替」）を生成し、1回のUndoで候補と線を取り消せる |
| TP-A06 | 採用ノードをcandidate状態で追加し、AI来歴と提案理由・前提・確認事項を保持すること | T5 | provenance.origin=llmとなり、利用者の採用判断後も自動でadoptedにはしない |
| TP-A07 | 実行開始時のprojectId、revision、対象図ID、focusNodeId、targetLevelId、task、modelIdを結果文脈として保持し、不一致なら採用を拒否すること | T1、T5 | 推論後に編集・Undo・図切替・選択変更があっても別ノードや別列へ誤適用しない |
| TP-A08 | 非ストリーム/SSEを選択でき、SSEの文字数進捗とキャンセルを提供すること | T5 | 分割UTF-8応答を連結し、キャンセル・タイムアウトを通知する |
| TP-A09 | モデル一覧取得・探索・検索・お気に入り・カスタムID入力を提供すること | T7 | GatewayのIDを失わず選択し、ProjectのmodelIdへ反映する |
| TP-A10 | Gateway URL、認証有効、メモリ内Token、温度、timeout、streamを設定できること | T4、T7 | `/v1`または許可loopback URLを検証し、設定値を適切な保存先へ反映する |
| TP-A11 | 種別・列の表示名と説明をAI文脈へ含め、短いリクエスト内参照へ変換すること | T5 | カスタム名称でもLLMが意味を判断でき、実際のProject IDを提案応答で生成する必要がない |
| TP-A12 | 未知または欠落したkindRefを候補単位で修正できること | T5 | 不明kindRefを含む候補を結果一覧へ残し、選択中の未解決候補だけ採用不可として種別選択を促す |
| TP-A13 | LLMに候補エッジを生成させないこと | T5 | 候補間の依存・制約は説明または確認事項として提示し、必要なエッジは採用後にユーザーが編集する |

初期AI設定はmodelId=`openrouter/google/gemini-3.8-flash`、timeout=600秒、temperature=0.2、stream=false。timeoutは30～1,800秒、温度は0～2またはnull。モデル一覧取得は30秒timeout、応答文字列長チェックは2×1024×1024。これは受信前のバイト制限ではない。

提案応答の必須構造は候補ノード1～10件とし、各候補で必須なのはラベルだけとする。summary、kindRef、説明、タグ、提案理由、前提、確認事項は安全な既定値を持つ。プロンプト上の希望件数は展開1～6、代替1～4とする。自動再問い合わせは行わず、不正JSONはエラー、未知kindRefは手動修正対象とする。レビュー指摘は最大30件、分類はmissing/conflict/ambiguity/verification、重要度はinfo/warningとする。

## 7. 制約・要確認事項

- schema v1以前のProject、旧拡張子・旧format、旧IndexedDBスナップショットの移行は提供しない。開発版データが必要な場合は旧版側で別途退避する。
- 起動直後の完全未編集Projectは自動保存しない。明示的な新規作成、全ノード削除後、名称・種別・列だけの変更後はノード0件でも復旧対象になる。
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
