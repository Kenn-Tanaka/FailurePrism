# 思考展開図エディタ (TPDD) 仕様書サマリー

## 1. システム概要

設計分野ごとに定義したノード種別、抽象度列、ノード間関係、階層的な詳細図を編集するフロントエンド完結型の「思考展開図エディタ（Thinking Process Development Diagram Editor - TPDD）」である。

新規Projectでは機械設計、ソフトウェア設計、電子回路設計、カスタムからプリセットを選択できる。プリセットは種別と列の初期値をコピーするだけであり、その後は「設計体系」画面で名称、説明、パレット、順序を自由に変更できる。種別はノードが何を表すか、列は設計上の段階・観点と図上の配置先を表し、両者は独立している。

ProjectはschemaVersion 2の `.tpdd.json` として保存する。schemaVersion 1以前、旧format、旧自動保存データの移行・互換読込は提供しない。現在図はMicrosoft Officeでも利用可能な標準SVGまたはPNGとして出力できる。

LLM Gateway経由で、選択ノードの展開案・代替案および図レビューを実行できる。展開・代替案ではLLMにProject内IDや候補エッジを生成させず、候補内容と短い `kindRef` だけを受け取る。配置列と接続線はアプリが決定する。

## 2. アーキテクチャと技術スタック

- **Frontend**: React 18、TypeScript strict、Vite、Tailwind CSS、Lucide Icons
- **状態管理**: `useReducer` + Context。永続モデル `Project` とUI一時状態を分離し、50件のUndo/Redoを保持
- **データモデル**:
  - `Project.nodeKinds`: ユーザー定義の種別一覧。配列先頭が新規ノードの既定種別
  - `Project.levels`: ユーザー定義の列一覧。配列順が左から右の表示順
  - `ThoughtNode.kindId` / `levelId`: 独立した参照
  - 種別と列はlabelに加えてAI向けdescriptionを保持
- **設計体系UI**: 種別と列を管理し、参照を壊す削除は再割当てを伴う。分野プリセットは新規Project作成時の初期値としてだけ選択する
- **描画**: 自前の標準SVG直接描画。種別パレット、列順、自動整列、階層サブ図を共通Project定義から解決
- **データ検証**: Zodによるschema v2検証と、種別・列・図・ノード・エッジの参照整合性検証
- **自動保存 & 復旧**: IndexedDB（1秒debounce、最大10候補）。schema v2だけを復元対象とする
- **LLM Gateway連携**:
  - `/v1/chat/completions` を介した非ストリーム/SSE推論
  - Tokenのメモリ限定保持
  - AbortControllerによる中断とtimeout
  - 実行時のproject、revision、diagram、focus、target level、task、model文脈を固定して遅延応答の誤適用を防止

## 3. AI提案プロトコル

### 3.1 配置先

- **展開案**: フォーカス列の次の配列要素を既定とする。フォーカスが最終列なら同じ列を暫定選択する。
- **代替案**: フォーカスと同じ列を既定とする。
- どちらも実行前の共有selectで変更でき、確定した1列のlabelとdescriptionをLLMへ送る。
- 1回の提案に含まれる全候補を、その単一ターゲット列へ配置する。

### 3.2 種別

種別定義はリクエスト内だけ有効な `K1`、`K2` のような短い参照へ変換し、labelとdescriptionを添えてLLMへ送る。LLMは任意の `kindRef` を返す。存在しない、または欠落したkindRefを含む候補も結果一覧へ残し、ユーザーが候補単位で種別を選ぶまでその候補を採用不可とする。

### 3.3 接続線

LLM応答にはcandidateId、levelId、エッジを含めない。候補の一時IDは受信後にアプリが付与する。採用時の線は次のようにアプリが生成する。

- `expand`: focus → candidate の `decomposition`
- `alternatives`: focus → candidate の `reference`、ラベルは「代替」

候補間の依存・制約は説明または確認事項として保持し、必要な線は採用後にユーザーが追加する。

## 4. 主要受入条件

| ID | 区分 | 受入条件 |
|---|---|---|
| E01 | 編集 | Gateway停止中も基本編集・保存・SVG/PNG出力が可能 |
| E02 | 設計体系 | 種別・列を追加、編集、並べ替え、削除でき、削除後に未定義参照が残らない |
| E03 | プリセット | 4種類の新規Projectプリセットを選べ、作成後の定義を自由に変更できる |
| E04 | 表示 | Canvas、詳細UI、SVG出力が同じ動的種別ラベルとパレットを使う |
| P01 | 保存 | schema v2の保存・読込が完全に往復する |
| P02 | 非互換 | schema v1以前と未知版を明確に拒否し、移行分岐を持たない |
| P03 | 整合 | 未定義kindId、levelId、自己エッジ、同種重複エッジを拒否する |
| A01 | AI入力 | カスタム種別・列のlabelとdescription、単一ターゲット列を送信する |
| A02 | AI出力 | LLMが実ID・候補ID・配置列ID・候補エッジを生成しなくても候補を表示できる |
| A03 | AI救済 | 未知kindRefは応答全体を破棄せず、該当候補だけ手動修正できる |
| A04 | AI採用 | expand/alternativesごとの線をアプリが生成し、Project検証後に1回のUndo単位で採用する |
| A05 | 競合 | 推論後の編集、図切替、選択変更で別ノード・別列へ誤適用しない |
| S01 | 安全 | Tokenを永続化せず、AIテキストをHTMLとして実行しない |

## 5. Gateway接続先

既定接続先は `/v1` とし、VTA-Editorと同じWebサーバー中継を利用する。独自のloopback接続先はGateway設定から指定できる。
