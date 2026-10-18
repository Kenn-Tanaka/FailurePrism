# VTA-Editor 要件定義書

文書版1.0／2026-10-18／実装基準 `493c052`。共通の境界・記載ルール・非機能要件は[共通要件](../REQUIREMENTS.md)を適用する。本書は現行実装からの再構成であり、受入済みの宣言ではない。

## 1. 目的・対象業務

事故・不具合の経緯を、主体別レーンと時系列を持つバリエーションツリーとして可視化する。利用者が通常事象と変動事象を整理し、要因の排除・因果関係の遮断を対策として設定し、改善後フローと分析レポートを生成するまでを支援する。

想定利用者は事故調査担当者、安全・品質担当者、分析結果のレビュー担当者。AIの抽出・提案は人が確認する分析材料である。定量的な事故確率計算、対策の有効性証明、安全認証、事実認定は対象外である。

## 2. 業務フロー・ユースケース

| UC | フロー | 正常終了 | 代替・例外 |
| --- | --- | --- | --- |
| VT-UC01 | 経緯入力または文書読込→AI抽出→図の確認 | レーン・事象・関係線を持つ編集可能な図を得る | 不正応答・通信失敗を通知し、再実行や手動編集を可能にする |
| VT-UC02 | ノード・線の追加/修正→配置調整→補足記入 | 原資料に対応した分析図を作成する | 削除時は接続線を除き、履歴対象操作はUndoできる |
| VT-UC03 | 排除・遮断を手動設定、またはAI提案を選択適用 | 対策状態が図とデータへ反映される | 不明なノード・線への提案は適用しない |
| VT-UC04 | 対策反映後に再生成→改善後フロー・分析レポート確認 | 2種類のMarkdown結果を得る | 中止や失敗を通知。生成中/生成後の編集による陳腐化を区別する |
| VT-UC05 | JSON保存→読込、または起動時の下書き復元 | 経緯・図・生成済みレポートを再利用する | 不正データは拒否または補正通知。復元対象外項目は自動復元を保証しない |
| VT-UC06 | 出力設定→SVGダウンロード、結果のコピー | 図・補足または文章を他資料へ利用できる | JSONによる作業保存とは別の成果物として扱う |

初期表示にはサンプルを用意する。サンプル切替、JSON読込、AI抽出による図の置換では、未保存状態に応じた確認を行う。空の新規Projectを作成するTPDDと同一の業務フローとは定義しない。

## 3. 入力・取込要件

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| VT-I01 | 経緯テキストを直接入力・編集し、用意されたサンプルを選択できること | V1、V2 | 入力した経緯を抽出要求と保存データへ使用する |
| VT-I02 | ファイル選択とドラッグ＆ドロップで文書を取り込めること | V2、V3 | 対応形式を読み、ファイル名・種類・サイズ・抽出文字数またはエラーを表示する |
| VT-I03 | TXT/LOG/MD/MARKDOWNをテキストとして読み、UTF-8、Shift_JISの順に復号を試みること | V3 | 両文字コードの日本語資料を取り込める |
| VT-I04 | DOCX本文、XLSX/XLSの各シート、PDFのテキスト層から経緯用テキストを得ること | V3 | 表計算は見出し付きMarkdown表となり、複数シートを識別できる。PDFはページごとの文字を抽出する |
| VT-I05 | `.json`入力をProject/VTASchema読込へ振り分けること | V1、V2 | JSONを単なる経緯本文として扱わず、構造検証と読込結果を通知する |

DOCXの図表配置・書式やPDFの元レイアウトを完全再現する機能ではない。PDFの画像だけのページはOCR対象外。表計算はシート当たり見出しを除く最大1,500行、PDFは先頭60ページを処理し、省略を知らせる。VTA全体の入力ファイル容量・文字数について、TPDDと同じ10MiB上限があるとは定義しない。

## 4. 図編集・表示要件

画面は上部ヘッダー、経緯・接続設定・結果を扱うコントロールパネル、ReactFlowキャンバス、補足パネル、各種編集/出力モーダルで構成する。

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| VT-F01 | ノードを追加・編集・削除し、レーン、時刻、種別、タイトル、説明、補足を扱えること | V1、V4 | 編集内容が図・データ・保存ファイルへ反映され、削除ノードの接続線も除かれる |
| VT-F02 | 通常事象と変動事象を識別表示し、ノードの排除状態を切り替えられること | V1、V4 | typeとmeasure_typeに対応した表示となり、切替を取り消せる |
| VT-F03 | ノード間を接続し、線の方向・ラベル・分類・遮断状態を編集できること | V1、V4 | 自己接続・同じsource/targetの重複を作らず、編集結果を保存する |
| VT-F04 | 主体別レーンと時系列配置を持ち、過去を下、後の事象を上へ配置すること | V4、V5 | レーンと時系列順位を反映し、同一レーンとレーン間の関係線を描画する |
| VT-F05 | ノードの選択・移動、複数ノード移動、ズーム・パン・全体表示を提供すること | V1、V4 | 通常表示で移動した位置を保持し、移動操作をUndo/Redoできる |
| VT-F06 | 自動配置とコンパクト表示を提供すること | V1、V4、V5 | コンパクト表示では説明を省略し移動を無効化し、通常表示に戻すと保持した配置を利用できる |
| VT-F07 | 全体補足、ノード補足、任意のカスタム補足を編集できること | V1、V4 | 補足パネル・JSON・補足付きSVGに対応内容が反映される |
| VT-F08 | 図データについて最大30件のUndo/Redo履歴を持つこと | V1 | ノード・線・対策の確定編集を取り消せ、新規編集時にRedoを破棄する |
| VT-F09 | 未保存状態、処理中状態、エラー、操作ログを表示すること | V1、V2 | 変更後に未保存表示となり、離脱時の警告や通知を確認できる |

同一レーンの新規接続は時系列線、レーン間接続は一方向線として作成する。方向変更と関係分類は別属性である。レーン・時刻に関わる変更では再配置が発生し、通常の文章修正では手動位置を保持する。

### 操作と履歴範囲

| 操作 | 割当て・範囲 |
| --- | --- |
| JSON保存 / 読込 / SVG出力画面 | CtrlまたはCmd+S / O / E |
| Undo / Redo | CtrlまたはCmd+Z / Y、CtrlまたはCmd+Shift+Z。入力欄ではテキスト編集を優先 |
| ズーム | 0.1～2.5倍。ミニマップ・全体表示を利用 |
| Undo対象 | VTASchemaに対する履歴登録済み編集。経緯本文、接続設定、生成結果の完全な巻戻しではない |
| 補足本文の更新 | 変更・保存対象だが、独立したUndo履歴を積まない更新経路がある |
| 図全体置換/読込 | 履歴をリセットする。直前データの内部退避は通常Undoと別の仕組み |

非表示ツールへのキーボード操作は共通要件COM-03に従う。

## 5. データ要件

| データ | 主な属性・意味 |
| --- | --- |
| VTASchema | lanes、nodes、edges、任意のsupplementary_summary/custom_notes |
| ノード | id、lane、time、type、title、description、measure_type、任意のsequence_order/supplementary_note/position |
| ノード種別 | normal / variation |
| 対策状態 | elimination / null。図からの物理削除と「排除対策」は異なる |
| 線 | source、target、任意のis_break/direction/label/category |
| 線の方向 | sequential / unidirectional / bidirectional |
| 線の分類 | information / material / person / handover / impact / sequential / other |
| カスタム補足 | id、任意のnodeId、title、content |
| 再生成結果 | idealFlow、analysisReport、generatedAt、任意のsourceHash |
| AI対策提案 | summary、排除候補、遮断候補、generatedAt。各候補の参照・理由・推奨行動を保持 |

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| VT-D01 | 外部JSONとAI抽出結果を検証・正規化してから図にすること | V3、V6 | 基本構造を欠く入力を拒否し、修正可能な項目を補完して警告を出す |
| VT-D02 | ノードID重複、レーン不足、線の参照切れ・自己接続・重複を補正すること | V3 | IDの再採番、レーン補完、不正線除去の結果と警告を確認できる |
| VT-D03 | 表示座標を図データへ保持し、分析結果の比較では配置変更と分析内容変更を区別すること | V1、V5 | 座標だけの変更ではレポートを古いと判定せず、比較対象の経緯・分析内容変更では判定する |

VTAはTPDDの厳格なProjectスキーマと異なり、欠損属性の補完や不正要素の除外を行う。最大ノード数・線数・文章長について明示的な一律上限は確認できない。無制限の性能保証を意味しない。

## 6. 保存・復旧・出力要件

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| VT-P01 | 経緯・図・再生成結果をProject JSONとしてダウンロードできること | V1、V2 | version、savedAt、scenarioText、vtaData、regenerationResult、selectedModelを出力する |
| VT-P02 | 完全Projectと単独VTASchemaを読み込めること | V1、V3 | 完全Projectでは経緯・図・レポートを復元し、単独スキーマでは図を置換して既存の経緯を保持する |
| VT-P03 | 読込時に実行中AIを中止し、作業単位を切り替えること | V1 | 旧要求の遅延応答が読み込んだ図を上書きしない |
| VT-P04 | 下書きをブラウザ内へ保存し、起動時に候補の復元・破棄を選べること | V1、V2 | 非空図を含む下書きを提示し、復元時は経緯・図・レポートを読み戻す |
| VT-P05 | ファイル名・空レーン・補足・コンパクト化を指定してSVG出力できること | V4、V5 | 指定オプションに対応した単一SVGを生成し、日本語・XML特殊文字を保持する |
| VT-P06 | 改善後フローと分析レポートをMarkdown表示し、結果をコピーできること | V2 | 各タブを切り替えて閲覧し、対応する文章をコピーできる |

Project出力のversionは`1.0`。Gateway URL/Token、timeout、操作ログ、Undo履歴、未適用のAI対策提案はProject出力対象ではない。型定義にあるprojectNameやmeasuresProposalも、現行export処理の出力項目には含まれない。

下書きはlocalStorageの`vta_draft_autosave`という単一スロットに、savedAt、scenarioText、vtaData、regenerationResultを保存する。同一Originの別タブと保存先を共有するため、複数Projectの版管理ではない。復元候補はノードがある図に限られ、保存領域の容量不足・利用不可では保存を保証できない。

SVG設定の初期値は空レーンを含めない、補足を含める、コンパクト化する。VTAの直接出力機能としてPNG・PDF・DOCXを定義しない。

## 7. AI処理・接続設定要件

| ID | 要件 | 根拠 | 受入条件 |
| --- | --- | --- | --- |
| VT-A01 | 経緯からレーン・事象・因果関係・補足を構造化抽出すること | V2、V6 | 応答中のJSONを取り出して検証し、編集可能な図へ置換する |
| VT-A02 | 現在の図に対する排除・遮断の候補と理由を提案すること | V4、V6 | 対象ノード/線を確認でき、存在しない参照を適用対象にしない |
| VT-A03 | 利用者が選択した対策候補だけを一括適用できること | V1、V4 | 選択した排除・遮断が反映され、1回のUndoで適用を取り消せる |
| VT-A04 | 対策を踏まえた改善後フローと分析レポートを2段階で生成すること | V6 | 第1要求のフローと第2要求のレポートがそろって再生成結果となる |
| VT-A05 | レポート生成には元の経緯・VTA・分析観点を用いること | V6 | 第2要求の入力に第1要求の生成フローをそのまま事実として渡さない |
| VT-A06 | 生成開始時の分析内容と結果の対応を記録し、内容変更時に古い結果であることを示すこと | V1、V5、V6 | 生成中に比較対象の内容を変更しても、完了結果を最新と誤表示しない |
| VT-A07 | 処理段階・経過時間・ログを示し、キャンセル可能にすること | V1、V4、V6 | 中止で要求をabortし、処理中表示を解除する |
| VT-A08 | 要求ID・Project識別を利用し、古い要求の結果混入を防ぐこと | V1、V2、V4 | 新たな処理・読込後に旧要求が完了しても新しい作業を置換しない |
| VT-A09 | 接続先・Token・モデル・timeoutを設定し、接続テストできること | V2、V7 | 接続テストがchat/completionsへ要求し、成否を通知する |
| VT-A10 | モデル一覧取得・検索・分類・お気に入り・カスタムID入力を提供すること | V7 | 一覧から選んだIDを要求へ渡し、お気に入りと取得一覧を端末内で再利用する |
| VT-A11 | 外部プロンプト設定を読み込み、利用できない場合は組込設定を用いること | V2、V6 | 必須の抽出・再生成・対策提案プロンプトを確認し、任意のフロー/レポート設定を利用する |

既定値はbaseUrl=`/v1`、model=`openrouter/google/gemini-3.8-flash`、timeout=180秒。画面のtimeout設定範囲は30～600秒、接続テストは最大30秒。timeoutは各LLM要求に適用し、2段階再生成全体が180秒以内に終わる保証ではない。

VTAの推論は非ストリーム応答を利用する。GatewayのSSE対応をもってVTAにもストリーム本文表示があるとは定義しない。進捗表示は処理段階表示であり、モデル内部の完了率ではない。操作ログは最大150件。

## 8. 制約・仕様決定が必要な事項

- selectedModelはJSONに書き出されるが、現行のimport処理は接続設定へ適用しない。「保存時のモデルを含む作業環境の完全復元」を受入条件にする場合は実装修正が必要である。
- Project版番号は読み取るが、未知の版を厳密に拒否する互換性ポリシーは実装されていない。将来版との互換範囲は別途決定する。
- 補足本文更新は独立したUndo履歴を作らないため、「すべての編集が1操作単位で取り消せる」とは定義しない。
- 直前の図の内部退避・復元APIは存在するが、常設の利用者向け復元操作としては確認できない。通常のUndoや下書き復元と同一機能としない。
- 下書き保存失敗はコンソール警告となる経路がある。TPDD同様の保存中・保存失敗表示がすべての下書き更新にあるとは扱わない。
- JSONダウンロード開始後に未保存フラグを解除するため、実ファイルの保存完了や利用者のダウンロード取消までは追跡しない。
- sourceHashのない旧レポートは読込時に古いと断定しない。また、現行Hashはsequence_orderと線のcategoryを比較対象に含めない。これらだけの変更も陳腐化検知する要件とする場合は実装修正が必要である。
- AI分析の正確性、原資料の忠実性、長大資料の網羅性は構造検証だけでは保証できない。業務受入では人による照合が必要である。

## 9. 実装・試験トレーサビリティ

| 根拠 | 主なソース | 既存の確認用テスト |
| --- | --- | --- |
| V1 状態・履歴・保存 | [vtaStore.ts](../../src/tools/vta/features/vta/store/vtaStore.ts)、[vta.ts](../../src/tools/vta/types/vta.ts) | [Store](../../src/tools/vta/features/vta/store/vtaStore.test.ts) |
| V2 画面・業務フロー | [App.tsx](../../src/tools/vta/App.tsx)、[Header.tsx](../../src/tools/vta/components/Header.tsx)、[ScenarioInputSection.tsx](../../src/tools/vta/components/control-panel/ScenarioInputSection.tsx)、[ResultsSection.tsx](../../src/tools/vta/components/control-panel/ResultsSection.tsx) | [非表示キー制御](../../tests/shell/vtaKeyboardGuard.test.tsx)。業務の連続操作は実ブラウザ確認が必要 |
| V3 取込・検証 | [fileIngestion.ts](../../src/tools/vta/features/vta/utils/fileIngestion.ts)、[schemaValidator.ts](../../src/tools/vta/features/vta/utils/schemaValidator.ts) | [文書取込](../../src/tools/vta/features/vta/utils/fileIngestion.test.ts)、[構造検証](../../src/tools/vta/features/vta/utils/schemaValidator.test.ts) |
| V4 キャンバス・編集UI | [VTACanvas.tsx](../../src/tools/vta/features/vta/components/VTACanvas.tsx)、[NodeEditorModal.tsx](../../src/tools/vta/features/vta/components/NodeEditorModal.tsx)、[EdgeEditorModal.tsx](../../src/tools/vta/features/vta/components/EdgeEditorModal.tsx)、[AIMeasuresProposalModal.tsx](../../src/tools/vta/features/vta/components/AIMeasuresProposalModal.tsx)、[SupplementaryNotesPanel.tsx](../../src/tools/vta/features/vta/components/SupplementaryNotesPanel.tsx)、[SVGExportModal.tsx](../../src/tools/vta/features/vta/components/SVGExportModal.tsx) | Store・キー制御テストに加え、ドラッグ・モーダル操作の実ブラウザ確認が必要 |
| V5 配置・出力・比較 | [layout.ts](../../src/tools/vta/features/vta/utils/layout.ts)、[edgeRouting.ts](../../src/tools/vta/features/vta/utils/edgeRouting.ts)、[svgExport.ts](../../src/tools/vta/features/vta/utils/svgExport.ts)、[hash.ts](../../src/tools/vta/features/vta/utils/hash.ts) | [配置](../../src/tools/vta/features/vta/utils/layout.test.ts)、[線経路](../../src/tools/vta/features/vta/utils/edgeRouting.test.ts)、[SVG](../../src/tools/vta/features/vta/utils/svgExport.test.ts)、[Hash](../../src/tools/vta/features/vta/utils/hash.test.ts) |
| V6 LLM・プロンプト | [client.ts](../../src/tools/vta/services/llm/client.ts)、[prompts.ts](../../src/tools/vta/services/llm/prompts.ts)、[reportContextExtractor.ts](../../src/tools/vta/features/vta/utils/reportContextExtractor.ts) | [LLM](../../src/tools/vta/services/llm/client.test.ts)、[プロンプト](../../src/tools/vta/services/llm/prompts.test.ts)、[文脈抽出](../../src/tools/vta/features/vta/utils/reportContextExtractor.test.ts) |
| V7 接続・モデル設定 | [LLMConfigSection.tsx](../../src/tools/vta/components/control-panel/LLMConfigSection.tsx)、[ModelSelectorModal.tsx](../../src/tools/vta/components/ModelSelectorModal.tsx)、[modelCatalog.ts](../../src/tools/vta/features/vta/data/modelCatalog.ts) | 接続クライアントテストに加え、探索・お気に入り・接続設定の実ブラウザ確認が必要 |

代表的な業務受入はVT-UC01→02→03→04→06→05の連続操作とする。AIには固定モック応答による機能確認と、原資料を用いた実Gatewayでの人手評価を分けて実施する。既存テストの存在は、すべての受入条件の検証済みを意味しない。
