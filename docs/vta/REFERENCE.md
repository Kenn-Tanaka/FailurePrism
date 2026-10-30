# Variation Tree Analysis Editor & LLM Gateway リファレンスマニュアル

本ドキュメントは、「Variation Tree Analysis Editor」および内蔵「Lightweight LLM Gateway」の内部アーキテクチャ、データスキーマ、アルゴリズム、プロンプト定義、およびセキュリティ仕様を網羅した技術リファレンスです。

ノード位置編集の座標・ドラッグ・接続修正・SVG出力の詳細は[実装仕様書](NODE_POSITION_EDITING_SPEC.md)を参照。

---

## 第1部: Variation Tree Analysis Editor 仕様

### 1. VTA データスキーマ (`VTASchema`)

本システムが扱うバリエーションツリーの構造定義です。

```typescript
export interface VTASchema {
  lanes: string[];                 // 部門・当事者名（左から右への並び順）
  nodes: VTANodeData[];            // イベントの主体別表示カード
  edges: VTAEdgeData[];            // ノード間の接続関係・伝達線
  analysis?: VTAAnalysisData;      // 根拠・イベント・主体・関与・カード参照の正規データ
  presentation?: VTAPresentation; // 主体IDごとのauto/show/hide、カードIDごとの表示除外理由
  supplementary_summary?: string;  // 分析サマリー（全体背景・ヒューマンファクタ総括）
  custom_notes?: SupplementaryNoteItem[]; // 任意追加の補足メモ
}

export interface VTANodeData {
  id: string;                      // ノード固有ID (例: node_1)
  event_ids?: string[];            // カードが表示するイベントID
  lane: string;                    // 所属レーン名
  time: string;                    // 発生時刻・時系列表記 (例: "09:30", "前日", "2ヶ月前")
  type: 'normal' | 'variation' | 'unclassified' | 'undetermined';
  title: string;                   // カード見出し
  description: string;             // 詳細な状況説明
  measure_type: 'elimination' | null; // elimination: 排除ノード（○印）
  sequence_order?: number;         // 明示的な前後順位
  supplementary_note?: string;     // カード固有の補足説明（背景要因、心理状態等）
  position?: { x: number; y: number }; // カード基準の保存座標
  compact_position?: { x: number; y: number }; // 見出しのみ表示のカード基準座標
  is_hidden?: boolean;             // ユーザー指定により図上では接続点として表示
  hidden_card_height?: number;     // 非表示化時のカード高さ（中心の保存復元用）
}

export interface VTAEdgeData {
  source: string;                  // 接続元ノードID (過去・発信元)
  target: string;                  // 接続先ノードID (未来・受信先)
  is_break?: boolean;              // true: ブレイク対策（BREAKバッジ＋遮断線）
  direction?: 'sequential' | 'unidirectional' | 'bidirectional';
  label?: string;                  // 伝達内容ラベル
}
```

現行の抽出・変動判定の詳細は[テキスト変換・TSV台帳仕様](TEXT_LEDGER_SPEC.md)を参照。Projectは形式5.0、analysis.versionは5である。旧形式は拒否し、変換しない。

LLMは段落番号付き原文をTSV台帳へ変換する。イベントはsourceRefsで原文を直接参照し、recordKindで記録・主張・評価を区別する。事実一覧や引用文をLLMに生成させない。アプリはID・列数・列挙値・参照・描画整合性を確認し、時刻や出来事を原文から再解釈しない。新抽出のfacts／factIdsは空であり、後続機能はそれらを根拠の前提にしない。保存用のJSONはアプリが生成する。

正常な台帳行は保持し、不正行のIDだけを最大2回まで修復する。前回結果全体と入力全文は再送しない。修復の通信失敗後は同じ条件で再実行するとメモリに保持した台帳から再開する。全体の形式が不明、ID重複、完了記号欠落などは明示的に停止し、不完全な結果で図を置換しない。原文参照の存在は意味の正しさの保証ではなく、確認欄で原文を照合する。

analysis.cardsとnodesは全カードを保持し、presentationからvisibleSchemaが可視データを導出する。表示上の除外を実削除として編集用データへ書き戻さない。レーンのauto/show/hide、単独カードの整理、関係端点・手動編集の保護、保存・履歴・SVGについては従来の表示整理規則を維持する。分析には非表示対象を含む正規データと背景を使う。

### 2. 時系列レイアウトエンジン (`layout.ts`)

AI抽出時はTSV台帳のイベント順を使う。時刻不明・同時刻だけで自動的にイベントをまとめない。LLMが共有カード表で明示したグループだけを表示上まとめ、個別イベントIDを保持する。異なる時刻や前後関係があるグループは矛盾として修復する。原文の時刻表現の解釈・入力順の整理はLLMが担う。

`generatedLaneSequence.ts` は共通の `laneConnections.ts` を呼び、各レーンの隣接ペアを `sequential` エッジで接続し、飛び越し・重複エッジを除き、逆向きの隣接線を修正する。保存済み・手動編集済みの図には明示操作による接続修正を提供する。既存の複数イベントカードは「イベント・主体の割当を確認・編集」にある「共有カードから分割」から個別に分割できる。

#### 2.1 時間ランク計算 (`computeTimeRanks`)
- **自然言語時刻パーサー (`parseTimeScore`)**:
  - 絶対時刻（`HH:MM`）を秒数に変換。
  - 相対時間（「X日前」「Xヶ月前」）を当日0時からの負の秒数に統一マッピング。
  - キーワード（「発端」「前日」「当日朝」「直前」「発生時」）を適切な時系列秒数にマッピング。
- **トポロジカルDAG制約**:
  - 同一レーンの時系列線を優先して上下順の制約を採用し、循環を生じる制約を除く。採用した線では `targetRank >= sourceRank + 1` を満たすよう補正する。制約から除外した線も描画・保存する。これによりレーン間の循環があっても、修正したレーン内の隣接順を維持する。

#### 2.2 垂直Bottom-to-Top (BT) 座標配置
- 早期のランクほどキャンバス下部（大きなY座標）、後期の不具合事象ほどキャンバス上部（小さなY座標）に配置。
- 計算式: `y = maxRank * VERTICAL_STEP - rank * VERTICAL_STEP`
- レーン幅: `380px`、ノード幅: `260px`（レーン中央に水平センタリング配置）。

#### 2.3 5セグメント直交ステップ配線 (`getOrthogonalStepPath`)
レーン跨ぎのエッジ（Cross-lane）において、ノード同士が重ならず障害物を回避して直交する配線パスを幾何計算します。
- `Source (X, Y) ➔ 出力水平オフセット ➔ 回廊垂直Y ➔ 入力水平オフセット ➔ Target (X, Y)`
- 左右側面の端子は送信（source）をカード高さの38%、受信（target）を62%の位置に置く。送信端子は受信端子より上側になり、下方ノードから上方ノードへ向かうエッジで経路の交差を抑える。画面表示、レーン間経路計算、SVG出力は `utils/edgeHandles.ts` の共通定数を参照する。
- レーン内エッジは `top` / `bottom` ハンドル間を垂直直線で結線。

#### 2.4 レーン順序の変更

キャンバスのツールバーの「列順序」は `vtaData.lanes` を左から右に一覧表示し、各列を「左へ」「右へ」で隣接列と交換する。空列も移動できる。Store の `moveLane` は列順を入れ替え、保存済みまたは表示中の各カードの X 座標を移動列数 × `LANE_WIDTH` だけ平行移動する。Y 座標と列内の手動 X オフセットは維持する。その後 `calculateVTALayout` でレーン背景と接続端子・線を再計算し、確定結果を1件の履歴として保存する。ノードとエッジの識別子・内容・接続関係は変更しない。コンパクト表示とSVG出力は `lanes` の順序から再計算するため、変更後の列順に従う。意味情報を変えない配置操作なので、分析レポートの最新性ハッシュは変化しない。

#### 2.5 見出しのみ表示と右側補足説明欄

`compactView` ではカード上の `description` を隠して見出しだけを表示し、右側補足説明欄を開いてノード別タブを表示する。同欄は各ノードの `time`（発生タイミング）を見出しの下に元文字列のまま折り返して表示し、空欄なら「未設定」と示す。図上の時刻バッジは幅を制限した省略表示を維持する。`description`（内容）と `supplementary_note`（補足説明）は別項目として扱い、両者を連結・複製して保存しない。内容の編集はノード編集画面で行い、補足説明は右側欄で編集する。

図上のノードをクリックすると右欄を開き、ノード別タブの対応カードをスクロール領域の中央付近に表示する。同じノードを再度クリックした場合も移動する。右欄の「図上表示」は従来どおり図のノードへ移動する。カードのドラッグ位置は詳細表示で `position`、見出しのみ表示で `compact_position` として別々に保存する。表示を切り替えても各モードの配置を維持し、BT自動整列は表示中のモードだけを再計算する。

ツールバーの「移動後に列中央へスナップ」は初期状態で無効。チェックを入れると、両表示モードでドラッグ終了時に実際に移動したカード・接続点の可視中心を所属レーン中央へ合わせる。ドラッグ中は自由に移動でき、重なり調整で動いた周囲のノードは横方向にスナップしない。スナップ結果はそのドラッグと同じUndo履歴・保存座標に含める。設定値はブラウザーのローカルストレージ `vta_snap_to_lane_center` に保存し、プロジェクトファイルには含めない。設定の切替だけでは図を未保存にしない。

#### 2.6 ユーザー指定のカード非表示と接続点

- `is_hidden === true` のカードを半径4pxの点として描画する。20px四方の操作領域を持つ `VTAJunctionNode` を使用し、既存ノードIDと全エッジを保持する。上下左右のハンドル座標を点の中心へ集約する。
- `nodeGeometry.ts` の `getDisplayRect` / `getEdgeAnchor` / `routingObstacles` を画面とSVGで共用する。カード座標はStoreに保持し、`projectDisplayNode` で画面用の点座標へ変換する。点のドラッグ移動量は元カード座標へ変換し、点の寸法通知はカード寸法へ反映しない。非表示化時の実測高さは `hidden_card_height` に保存し、ファイル読込時も点の中心を維持する。
- 通常表示の切替は既存配置を保持する。自動整列・コンパクト表示では点の必要高さを20pxとし、時系列順位とレーンは保持する。点のみのレーンも空レーンとして除外しない。
- 経路計算はレーン番号の差で隣接判定し、カード幅を前提に点を別レーンと誤判定しない。接続元・接続先以外の点は回避対象とする。接続先の点へ線を延ばし、矢印を点の手前に置いて重なりを避ける。元のエッジを統合・削除・追加しないため、分岐、連続する点、双方向、ラベル、BREAKも保持する。
- 通常表示のカード上と右側説明欄の各ノードに「図上では接続点として表示」ボタンを置く。右欄は図の拡大率に影響されず、コンパクト表示でも操作できる。編集画面のチェックまたは右欄の「カードを再表示」からも属性を変更する。点のクリックで右欄へ移動し、「図上表示」は点へフォーカスするだけで属性を変更しない。点はドラッグ可能だが接続追加は無効とし、点の中心を基準にカードを再表示する。
- `start-all.ps1` は実際に配信する `index.html` のハッシュを起動URLに含め、既存ブラウザーの旧HTMLを再利用しない。`server.mjs` はHTMLへ `Cache-Control: no-store` を付ける。
- `sanitizeNode` / `validateAndSanitizeVTASchema` の `restorePresentation` は既定でfalseとし、AI抽出の表示属性を破棄する。ファイル・下書き復元ではtrueを指定し、真偽値trueのみを採用する。新規AI抽出で以前の非表示指定を類推して引き継がない。
- LLM用JSONから表示属性だけを除外し、ノード内容と接続は全件保持する。`computeVTADataHash` の分析内容比較には表示属性を含めない。変更は通常のUndo/Redo・自動保存に含める。

#### 2.7 明示操作による接続の自動修正

- ツールバーの「接続を自動修正」は現在表示中のモードのノード位置から候補を作る。`getDisplayRect` で非表示カードを接続点へ変換し、同一レーンを下から上へ並べる。表示モード間で順序が異なる場合は、他方のモードの再配置も確認画面に表示し、接続と配置を一括で確定する。上下が重なる、位置が欠落・非有限、存在しないノードへの線がある場合は適用を止める。
- `laneConnections.ts` は不足する隣接線を追加し、飛び越し・重複・自己接続を削除する。正方向の既存線を優先し、なければ逆方向の隣接線を反転する。採用した線のラベル・分類・BREAKは維持する。新規線のBREAKはfalseとし、削除線の設定を転写しない。レーン間の線は保持する。
- `connectionRepairPlan.ts` は変更一覧と追加・削除・方向修正件数を返す。再読込、自動整列、コンパクト表示で同じ隣接順になることも検証する。`ConnectionRepairModal` に変更前後と削除する設定を示し、「修正を適用」で確定する。
- Store は確認時のスキーマ・表示座標と現在値を比較する。確認中に図が変わった場合は適用せず候補を更新する。確定は `commitVTAChange` で1件の履歴・自動保存・レポート最新性判定に反映する。配置とノード内容は保持する。修正不要の場合はデータ・履歴を変更しない。

#### 2.8 LLMによるレーン間接続提案

- キャンバスの「レーン間接続をAIに提案」は、analysis.sourcesの原文段落、確定済みイベント・主体・関与、表示カード、意味を持つ既存線をTSVで渡す。全カード対の列挙はせず、入力は180,000文字で上限とする。原文は参照段落単位で一度だけ付与する。
- `connectionProposal` プロンプトは組込既定を使用し、`public/prompts.json`から差し替えられる。応答は `[接続提案]` / `[要確認]` / `[完了]` のTSV。候補ごとに形式・イベント・主体・カード・原文参照を検証し、不正行だけ最大2回再取得する。正常候補は修復失敗後も保持する。
- 具体化対象のassociation線も実在IDとともに送る。修復にはイベント・関与・既存線と関連原文を付与し、根拠不足なら同じIDの要確認へ移せる。検証件数・不正行の理由・修復対象・確認待ち件数をログに残し、有効な修正が得られない場合は修復を停止する。
- 初期候補は未選択。根拠・理由を表示し、関係種別・リソース・状態・受領確認・採用理由を編集できる。意味情報のスナップショットまたはProject IDが変わった候補は適用できない。パン、ズーム、配置、列順だけでは失効しない。
- 選択集合に対して既存関係との重複と確定した伝達関係の循環を検査し、すべて有効な場合だけ適用する。共通イベント線の具体化は論理的なイベント・主体組を対象とし、派生する無向プレースホルダーの置換を手動削除記録にしない。適用は一つの履歴単位で、採用関係の由来・元の提案理由・採用理由・原文参照を分析データに保存する。
- 未適用候補はプロジェクトへ保存しない。外部プロンプト未設定時も組込プロンプトへフォールバックする。実LLMの意味判断品質はローカルテストでは保証せず、利用者が原文を確認する。

### 3. Word / PowerPoint 完全互換ベクターSVGエクスポート (`svgExport.ts`)

WordやPowerPointに貼り付けた際の表示欠落を防止するため、SVG 1.1 標準要素のみを使用します。
- `<foreignObject>` は一切使用せず、標準の `<rect>`, `<path>`, `<circle>`, `<text>`, `<tspan>` で構成。
- 日本語を含むテキストは、全角・半角文字数換算ベース（全角=2、半角=1）の精密な自動改行（Word Wrapping: `wrapTextLines`）アルゴリズムにより `<tspan>` として垂直展開。
- 特殊文字（`&`, `<`, `>`, `"`, `'`）の安全なXML実体参照エスケープ処理。
- 排除ノード（右上隅の `○` 印バッジ）およびブレイク（エッジ中央の赤色二重斜線＋`BREAK` バッジ）をベクター描画。
- 指定した表示モードの保存配置を使って出力する。空レーンを除外する場合は、列幅分のX移動だけを行い、列内の手動配置を維持する。非表示カードは `<circle>` の接続点として出力し、全接続線を保持する。補足欄を含む場合は内容未記入の非表示ノードも列挙し、「図上は接続点」および排除指定の有無を記す。
- 右側補足説明欄を含むSVGでは、`description` または `supplementary_note` のあるノードを列挙し、内容と補足説明を区別して描画する。見出しのみのコンパクトSVGでも内容を右欄に保持する。補足欄を除外する選択時は、出力画面で文章が含まれないことを知らせる。
- `includeHeader` は既定で有効。上部見出しは白地に濃色文字で描画し、出力画面のチェックを外した場合はタイトル・出力日時・件数バッジを含む上部見出し全体を省く。見出しの高さもSVG座標と画像全体の高さから除き、図と右側補足欄を上へ詰める。スイムレーン見出しと補足欄見出しは残す。

### 4. 外部プロンプト形式 (`public/prompts.json`)

外部設定はversion 5.0.0のnormalization（変数sourceText）とclassification（変数analysisText）を使う。TSVを返す契約であり、旧JSONプロンプトはこの抽出経路には使用しない。未設定・旧版の場合は組込の台帳プロンプトを使う。public/prompts.jsonはテストで上書きせず、組込設定との一致を照合する。

---

## 第2部: Lightweight LLM Gateway 1.3.1 リファレンス

※ LLM Gateway の完全な詳細技術仕様（Allowlist設定規則、HTTPヘッダ変換仕様、ストリーミングSSE実装、CORS検証等）は `tools/llm-gateway/REFERENCE.md` を参照してください。

### 1. Credential Convention (資格情報仕様)

資格情報は `service / username / password` で識別します。

```text
service  = credentials.service_name（既定: CloudLLM）
username = <normalized_vendor>|<slot>
password = Provider API Key
```

- Gateway Client Token の既定 username は `llm_gateway|default` です。
- vendor は trim・ASCII lowercase 化し、`google` は `gemini` へ正規化します。
- Windows では DPAPI（Windows 資格情報マネージャー）の `Generic Credential` として保存・取得します。
- プロバイダの API キーはフロントエンドやブラウザのメモリには一切送られず、ローカルプロキシ側で直接注入されます。

### 2. Gateway 構成設定 (`gateway.json`)

```json
{
  "listen": { "address": "127.0.0.1", "port": 8765 },
  "security": { "client_auth": false, "credential_name": "llm_gateway|default" },
  "credentials": { "service_name": "CloudLLM", "environment_fallback": false },
  "proxy": {
    "max_request_body_mb": 64,
    "connect_timeout_sec": 10,
    "read_timeout_sec": 600,
    "write_timeout_sec": 600
  },
  "model_cache": { "enabled": true, "ttl_sec": 3600 },
  "cors": {
    "enabled": true,
    "allowed_origins": ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"],
    "allowed_methods": ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
    "allowed_headers": ["Authorization", "Content-Type"],
    "max_age_sec": 600
  },
  "providers": {
    "openrouter": {
      "base_url": "https://openrouter.ai/api",
      "authentication": "bearer",
      "key_vendor": "openrouter",
      "key_slot": "default",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "openrouter/*" }]
    }
  },
  "logging": { "level": "info", "file": "llm-gateway.log" }
}
```

### 3. API エンドポイント

- `GET /v1/models`: 利用可能なモデル一覧を返却（キャッシュTTL: 3600秒）。
- `POST /v1/chat/completions`: OpenAI互換のチャット補完リクエスト。ストリーミング（SSE）対応。

---

## 第3部: セキュリティ & 運用

1. **APIキーのローカル保護**:
   - WebエディタのJavaScriptソースコードおよびブラウザストレージ内にプロバイダAPIキーを保持しません。
   - すべてローカルループバック（`127.0.0.1`）経由で `llm-gateway.exe` を通じて通信します。
2. **C++バイナリの完全静的リンク**:
   - `llm-gateway.exe`, `vta-starter.exe`, `llm_test.exe`, `llm-gateway-credential-manager.exe` は、MinGW/MSVCランタイムへの外部DLL依存を排除するため、`-static -static-libgcc -static-libstdc++` でビルドされています。


2026-10-29 時刻不明イベントの配置更新：analysisを持つ図では、レーン内のsequence_orderを共通の時間として扱わず、イベントIDを基準に全レーンの順位を決める。共通イベント・共有カードは同じ順位とし、明示されたbefore、impact、transferと接続の前後関係を優先する。関係がない候補はsourceOrder（入力記述順）で並べる。循環する追加制約と同一イベント間の線は時間差に変換しない。カード・接続点の中心を同じ高さへ揃え、発生時刻の文字列は補わない。保存済みの手動配置を持つ図はBT自動整列で再配置する。
# 作業依存と生成方式（2026-10-29実装）

連鎖不足点検の継続実装：`inspectChainDelta`は正常行と不正行・未完了を区別する。`validateChainRows`が一時コピーで参照・構造を検証し、正常候補を保持する。サービスは意味上の点検最大2パスと対象行の形式修復を、単一の6呼出し予算内で実行する。修復で指定IDが省略されても未解決扱いを維持する。無進展・上限・通信失敗では正常候補を残し、キャンセルと古い図への応答は採用しない。候補の履歴は確認画面で表示し、採用関係のgenerationとanalysis.generationRunsへ実行来歴を保存する。

帰結確認の追加：正規化出力に任意の`[帰結]`セクション（ID・判定・イベントID・原文参照・理由の5列）を受け付ける。新しい指示では1行の出力を要求し、identified/not_found/uncertainを区別する。identifiedは実在するイベントIDと原文参照を必要とし、機器破損等を試験前確認へ置き換えない。主体不明でも帰結イベント自体は保持する。既存応答・既存5.0データに帰結確認がない場合は未確認とし、互換読込のためにイベントを消したり形式不正として拒否したりしない。帰結未確認は構造診断で完成扱いしない。原文に帰結があるかの意味判断はLLMと利用者が行い、アプリのキーワード判定では行わない。

確認画面に帰結候補の本文・割当状態を表示する。`analysis.outcome`へ判定・イベントID・原文参照・理由を保存し、意味上のハッシュへ含める。帰結が特定済みの場合、レポートの終点は帰結IDに対応するノードを使う。未割当で図に出ない帰結もレポート用の説明へ含め、別の終端ノードへ黙って置換しない。帰結未確認時はレポート用入力にも注意を付す。identifiedはLLMの候補報告であり、人手検証済みという意味ではない。

関係種別`dependency`は、別イベント・別主体の前提作業から依存作業への一方向関係である。正規化台帳の関係表は10列、接続提案表は13列を維持し、dependencyのリソース・実施状態は`-`、受領確認は`na`とする。内部データではresource/statusを未設定とする。図とSVGでは「作業依存」と一点鎖線で表示する。

`eventOrder.ts`が全イベントの共有カードグループ・前後関係・台帳順を用いて順序を求める。候補は各2主体の統合時系列で隣接する別イベントに限定する。初回台帳では今回のdependency全件を除いた順序で検証する。順序の循環やグループ内の矛盾がある対象レーンの候補は保留する。隣接条件は新規自動抽出・提案採用時に検証し、保存読込時には適用しない。中間イベントが追加されても保存済みの線を自動削除しない。

接続提案の入力には許可した方向付き候補、対象イベント・原文参照と周辺段落を渡す。送っていない原文参照は検証で拒否する。入力上限は180,000文字、作業依存候補上限は2,000件であり、超過時は利用者に対象を絞るよう表示する。採用時に関係IDをUUIDで発行し、応答内の提案IDとは分ける。削除した依存は`presentation.omittedDependencies`の意味キーでも記録する。

`services/generation/registry.ts`は方式登録・共通検証・実行ID・キャンセル・旧応答の破棄と生成来歴を扱う。現行`fulltext-ledger`方式の正規化・修復は`fulltextLedger.ts`に分離し、固定した設定と通信・ログ関数を受け取る。方式間の内部契約は`VTAAnalysisData`であり、LLM通信のJSON化は行わない。共通の確認・図への反映を維持する。追加方式は契約テストで差し替えを検証し、本番方式選択UIは将来追加する。

生成来歴`generation`と`generationRuns`、採用関係の`generation`は任意属性である。方式ID・版、接続ルール版、実行ID、モデル、入力・プロンプトの指紋を保存する。指紋は調査用であり、暗号学的な同一性証明やLLM結果の再現保証ではない。APIキーは保存しない。来歴なしは方式不明として読み込み、未搭載方式でも図は開けるが元方式による部分再抽出は行わない。旧形式変換は追加しない。
