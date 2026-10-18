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
- レーン内エッジは `top` / `bottom` ハンドル間を垂直直線で結線。

### 3. Word / PowerPoint 完全互換ベクターSVGエクスポート (`svgExport.ts`)

WordやPowerPointに貼り付けた際の表示欠落を防止するため、SVG 1.1 標準要素のみを使用します。
- `<foreignObject>` は一切使用せず、標準の `<rect>`, `<path>`, `<circle>`, `<text>`, `<tspan>` で構成。
- 日本語を含むテキストは、全角・半角文字数換算ベース（全角=2、半角=1）の精密な自動改行（Word Wrapping: `wrapTextLines`）アルゴリズムにより `<tspan>` として垂直展開。
- 特殊文字（`&`, `<`, `>`, `"`, `'`）の安全なXML実体参照エスケープ処理。
- 排除ノード（右上隅の `○` 印バッジ）およびブレイク（エッジ中央の赤色二重斜線＋`BREAK` バッジ）をベクター描画。

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
