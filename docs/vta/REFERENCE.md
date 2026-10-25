# Variation Tree Analysis Editor & LLM Gateway リファレンスマニュアル

本ドキュメントは、「Variation Tree Analysis Editor」および内蔵「Lightweight LLM Gateway」の内部アーキテクチャ、データスキーマ、アルゴリズム、プロンプト定義、およびセキュリティ仕様を網羅した技術リファレンスです。

---

## 第1部: Variation Tree Analysis Editor 仕様

### 1. VTA データスキーマ (`VTASchema`)

本システムが扱うバリエーションツリーの構造定義です。

```typescript
export interface VTASchema {
  lanes: string[];                 // 部門・当事者名（左から右への並び順）
  nodes: VTANodeData[];            // 作業・変動要因カード
  edges: VTAEdgeData[];            // ノード間の接続関係・伝達線
  supplementary_summary?: string;  // 分析サマリー（全体背景・ヒューマンファクタ総括）
  custom_notes?: SupplementaryNoteItem[]; // 任意追加の補足メモ
}

export interface VTANodeData {
  id: string;                      // ノード固有ID (例: node_1)
  lane: string;                    // 所属レーン名
  time: string;                    // 発生時刻・時系列表記 (例: "09:30", "前日", "2ヶ月前")
  type: 'normal' | 'variation';    // normal: 通常作業（細枠線）, variation: 変動要因（太枠線）
  title: string;                   // カード見出し
  description: string;             // 詳細な状況説明
  measure_type: 'elimination' | null; // elimination: 排除ノード（○印）
  sequence_order?: number;         // 明示的な前後順位
  supplementary_note?: string;     // カード固有の補足説明（背景要因、心理状態等）
  position?: { x: number; y: number }; // カード基準の保存座標
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

### 2. 時系列レイアウトエンジン (`layout.ts`)

#### 2.1 時間ランク計算 (`computeTimeRanks`)
- **自然言語時刻パーサー (`parseTimeScore`)**:
  - 絶対時刻（`HH:MM`）を秒数に変換。
  - 相対時間（「X日前」「Xヶ月前」）を当日0時からの負の秒数に統一マッピング。
  - キーワード（「発端」「前日」「当日朝」「直前」「発生時」）を適切な時系列秒数にマッピング。
- **トポロジカルDAG制約**:
  - `target` のランクは、常に `source` のランク以上（`targetRank >= sourceRank + 1`）となるよう有向グラフの因果関係で補正。

#### 2.2 垂直Bottom-to-Top (BT) 座標配置
- 早期のランクほどキャンバス下部（大きなY座標）、後期の不具合事象ほどキャンバス上部（小さなY座標）に配置。
- 計算式: `y = maxRank * VERTICAL_STEP - rank * VERTICAL_STEP`
- レーン幅: `380px`、ノード幅: `260px`（レーン中央に水平センタリング配置）。

#### 2.3 5セグメント直交ステップ配線 (`getOrthogonalStepPath`)
レーン跨ぎのエッジ（Cross-lane）において、ノード同士が重ならず障害物を回避して直交する配線パスを幾何計算します。
- `Source (X, Y) ➔ 出力水平オフセット ➔ 回廊垂直Y ➔ 入力水平オフセット ➔ Target (X, Y)`
- 左右側面の端子は送信（source）をカード高さの38%、受信（target）を62%の位置に置く。送信端子は受信端子より上側になり、下方ノードから上方ノードへ向かうエッジで経路の交差を抑える。画面表示、レーン間経路計算、SVG出力は `utils/edgeHandles.ts` の共通定数を参照する。
- レーン内エッジは `top` / `bottom` ハンドル間を垂直直線で結線。

#### 2.4 見出しのみ表示と右側補足説明欄

`compactView` ではカード上の `description` を隠して見出しだけを表示し、右側補足説明欄を開いてノード別タブを表示する。同欄は各ノードの `description`（内容）と `supplementary_note`（補足説明）を別項目として扱い、両者を連結・複製して保存しない。内容の編集はノード編集画面で行い、補足説明は右側欄で編集する。

図上のノードをクリックすると右欄を開き、ノード別タブの対応カードをスクロール領域の中央付近に表示する。同じノードを再度クリックした場合も移動する。右欄の「図上表示」は従来どおり図のノードへ移動する。

#### 2.5 ユーザー指定のカード非表示と接続点

- `is_hidden === true` のカードを半径4pxの点として描画する。20px四方の操作領域を持つ `VTAJunctionNode` を使用し、既存ノードIDと全エッジを保持する。上下左右のハンドル座標を点の中心へ集約する。
- `nodeGeometry.ts` の `getDisplayRect` / `getEdgeAnchor` / `routingObstacles` を画面とSVGで共用する。カード座標はStoreに保持し、`projectDisplayNode` で画面用の点座標へ変換する。点の寸法通知・移動通知をStoreへ逆流させない。非表示化時の実測高さは `hidden_card_height` に保存し、ファイル読込時も点の中心を維持する。
- 通常表示の切替は既存配置を保持する。自動整列・コンパクト表示では点の必要高さを20pxとし、時系列順位とレーンは保持する。点のみのレーンも空レーンとして除外しない。
- 経路計算はレーン番号の差で隣接判定し、カード幅を前提に点を別レーンと誤判定しない。接続元・接続先以外の点は回避対象とする。接続先の点へ線を延ばし、矢印を点の手前に置いて重なりを避ける。元のエッジを統合・削除・追加しないため、分岐、連続する点、双方向、ラベル、BREAKも保持する。
- 通常表示のカード上と右側説明欄の各ノードに「図上では接続点として表示」ボタンを置く。右欄は図の拡大率に影響されず、コンパクト表示でも操作できる。編集画面のチェックまたは右欄の「カードを再表示」からも属性を変更する。点のクリックで右欄へ移動し、「図上表示」は点へフォーカスするだけで属性を変更しない。点はドラッグ・接続追加を無効とし、操作する場合はカードへ戻す。
- `start-all.ps1` は実際に配信する `index.html` のハッシュを起動URLに含め、既存ブラウザーの旧HTMLを再利用しない。`server.mjs` はHTMLへ `Cache-Control: no-store` を付ける。
- `sanitizeNode` / `validateAndSanitizeVTASchema` の `restorePresentation` は既定でfalseとし、AI抽出の表示属性を破棄する。ファイル・下書き復元ではtrueを指定し、真偽値trueのみを採用する。新規AI抽出で以前の非表示指定を類推して引き継がない。
- LLM用JSONから表示属性だけを除外し、ノード内容と接続は全件保持する。`computeVTADataHash` の分析内容比較には表示属性を含めない。変更は通常のUndo/Redo・自動保存に含める。

### 3. Word / PowerPoint 完全互換ベクターSVGエクスポート (`svgExport.ts`)

WordやPowerPointに貼り付けた際の表示欠落を防止するため、SVG 1.1 標準要素のみを使用します。
- `<foreignObject>` は一切使用せず、標準の `<rect>`, `<path>`, `<circle>`, `<text>`, `<tspan>` で構成。
- 日本語を含むテキストは、全角・半角文字数換算ベース（全角=2、半角=1）の精密な自動改行（Word Wrapping: `wrapTextLines`）アルゴリズムにより `<tspan>` として垂直展開。
- 特殊文字（`&`, `<`, `>`, `"`, `'`）の安全なXML実体参照エスケープ処理。
- 排除ノード（右上隅の `○` 印バッジ）およびブレイク（エッジ中央の赤色二重斜線＋`BREAK` バッジ）をベクター描画。
- 非表示カードは `<circle>` の接続点として出力し、全接続線を保持する。補足欄を含む場合は内容未記入の非表示ノードも列挙し、「図上は接続点」および排除指定の有無を記す。
- 右側補足説明欄を含むSVGでは、`description` または `supplementary_note` のあるノードを列挙し、内容と補足説明を区別して描画する。見出しのみのコンパクトSVGでも内容を右欄に保持する。補足欄を除外する選択時は、出力画面で文章が含まれないことを知らせる。

### 4. 外部プロンプト形式 (`public/prompts.json`)

アプリケーション起動時に `/prompts.json` を非同期フェッチし、LLMへの指示プロンプトを動的に差し替え可能です。
- `vtaExtraction`: シナリオテキストから VTA JSON を抽出するプロンプト。
  - プレースホルダー: `{{scenarioText}}`
- `scenarioRegeneration`: 排除ノード・ブレイク・補足説明から改善フローとレポートを生成するプロンプト。
  - プレースホルダー: `{{scenarioText}}`, `{{eliminatedNodes}}`, `{{brokenEdges}}`, `{{supplementaryNotesSummary}}`

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
