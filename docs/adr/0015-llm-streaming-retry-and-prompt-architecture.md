# ADR-0015: VTA LLM通信層のSSEストリーミング・指数バックオフ自動リトライおよびべき等プロンプト合成・文脈スライシングアーキテクチャ

- **ステータス**: Accepted
- **決定日**: 2026-11-06
- **対象コンポーネント**: VTA LLM Client (`client.ts`), Event Prompts (`eventPrompts.ts`), Context Slicer (`contextSlicer.ts`), Proposal Context (`proposalContext.ts`), Granularity Refinement (`granularityRefinement.ts`), Chain Repair (`chainRepairService.ts`)
- **関連要件 / ADR**: ADR-0001, ADR-0009, ADR-0010, ADR-0012, ADR-0013

---

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港航空機衝突事故報告書（約28,500文字）などの長大インシデント文書に対する VTA 自動生成・粒度反復・連鎖点検パイプラインにおいて、以下の構造的課題が確認された。

1. **非ストリーミング通信による HTTP 504 (`upstream_timeout`) とリトライ機構の不在**:
   - `src/tools/vta/services/llm/client.ts` の `callLLMGateway` が非ストリーミング（`stream: false` 相当の一括 JSON 応答待ち）で実装されていたため、LLM 側の思考・生成が30〜36秒を超えると、クライアント設定のタイムアウト（180秒）に達する前であっても中継プロキシ・OpenRouter 等でアイドル通信切断（`HTTP 504 Gateway Timeout: Upstream provider read timed out.`）が発生していた。
   - また、一時的な `HTTP 429 / 502 / 503 / 504` やネットワーク瞬断に対する自動リトライが存在せず、1回のゲートウェイエラーでステージ全体が失敗・中断していた。
2. **プロンプトポリシー注入の非べき等性と指示 bloat（重複注入リスク）**:
   - `captureEventPrompts()` や `proposeVTAConnections()` 等で `systemPrompt.includes(POLICY_CONSTANT)` による文字列完全一致判定と末尾連結を行っていたため、保存済みカスタムプロンプトや旧バージョンのポリシー文面が含まれる場合に新旧ポリシーが二重注入され、LLM のアテンション分散（Lost in the Middle）を招いていた。
3. **正規化ステージ（Stage 1）の思考順序と抽出密度の乖離**:
   - 全文から8種類の TSV セクションを単一パスで出力させる際、思考順序（帰結アンカーの特定 $\to$ 主体と包含階層 Poset の構成 $\to$ 時系列イベントと主体割当 $\to$ 主体間・時系列関係）が明示されておらず、長大文書で主体の包含階層（`edge_count: 0`）や主体間関係（`C3 = 0.26`）が希薄化していた。
4. **下流ステージ（接続提案・連鎖点検・粒度反復）における文脈肥大化とフォーマットゆらぎ**:
   - `proposalContext.ts` が長大原文の全段落を無制限に展開していたため、接続提案・連鎖点検のプロンプトが肥大化していた。
   - また、`[全イベント]` テーブルに「現在どの主体が割り当てられているか（`assignedEntities`）」が表示されていなかったため、連鎖点検（Stage 3-B）で LLM が未割当主体を使った `[関係追加]` だけを出力し、`関係の主体がイベントに関与していません。` でリジェクトされる事象が頻発していた。
   - さらに粒度反復（Stage 2）の `[操作提案]` で LLM が `add_relation` の `content` をタブ区切り13列で展開した場合や、`before` 関係に未関与主体を指定した場合に破棄される問題があった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **長大文書（2.5万〜10万文字規模）でのゼロ・タイムアウト耐性**: プロキシ層の30〜60秒アイドルタイムアウトを根本から回避すること。
- **べき等かつ決定論的なプロンプト構成**: 何度コンパイルしても、また旧バージョンのポリシーを含む設定に対しても、常に最新1ブロックのポリシーのみが厳密に配置されること。
- **LLM の認知負荷低減と自己完結的な参照テーブル**: LLM が別セクションをクロス検索せずとも1行でイベントの割当主体を確認でき、原文も直接根拠と文脈窓に絞って供給すること。
- **既存テストスイートとの完全な後方互換性**: 既存のモックテスト（`Response` モック、簡易 JSON モック、固定エラースロー検証）を一切壊さないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1**: クライアント側のタイムアウト秒数延長とプロンプト末尾への注意書き追加のみで対処する。
  - *却下理由*: `HTTP 504` はクライアントではなく上流ゲートウェイの無通信タイマーで発生するため、タイムアウト秒数変更では解決しない。またプロンプトへの追記はさらなる bloat を招く。
- **選択肢 2**: TPDD 側で実績のある `parseSseStream` を VTA `callLLMGateway` に統合して SSE ストリーミング通信を標準化し、指数バックオフ自動リトライ、マーカーベースのべき等プロンプトコンパイラ、共通コンテキストスライサー、および連鎖点検・粒度反復の構造ガードを一貫して導入する（**採用**）。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 SSE ストリーミング受信と指数バックオフ＋ジッター・Retry-After 自動リトライ (`client.ts`, `vta.ts`)
1. `callLLMGateway` のリクエストペイロードで `stream: config.stream !== false`（デフォルト `true`）を有効化し、`content-type: text/event-stream`（およびバッファリングされた `data:` 応答）を `parseSseStream` でリアルタイム受信する。これにより最初のトークン生成以降は常にパケットが流れ続け、上流ゲートウェイの `HTTP 504` を根絶する。
2. `HTTP 408 / 429 / 500 / 502 / 503 / 504` およびネットワーク層の一時エラー・ストリーム途中切断に対し、既定最大3回（`config.maxRetries ?? 3`）の自動リトライを実装する。レスポンスに `Retry-After` ヘッダ（秒数または HTTP-date 形式）が存在する場合は `parseRetryAfterMs` によりその待機時間を優先適用し、ない場合は指数バックオフ＋ジッター（`retryBaseDelayMs * 2^attempt * jitter`）で待機する。本番コード内にテスト環境判定分岐を持ち込まず、`LLMConfig.maxRetries` の注入のみで制御する。

### 4.2 べき等なプロンプトポリシー合成と4段階アンカリング思考順序 (`eventPrompts.ts`, `public/prompts.json`)
1. セクション見出しマーカー（`【...】`）をキーとして既存ブロックをインプレース置換する純粋関数 `upsertPolicyBlock` およびステージ別コンパイラ `compileNormalizationSystemPrompt`, `compileClassificationSystemPrompt`, `compileConnectionProposalSystemPrompt` を実装し、`includes()` による重複連結を廃止する。
2. 正規化プロンプトに `EXTRACTION_ANCHORING_POLICY`（Step 1: 帰結アンカーの特定 $\to$ Step 2: 主体と包含階層 Poset の構成 $\to$ Step 3: 時系列イベントと主体割当の抽出 $\to$ Step 4: 主体間・時系列関係の構成）を導入し、`public/prompts.json` と完全同期する。

### 4.3 適応型コンテキストスライサーと下流ステージのフォーマット耐性強化 (`contextSlicer.ts`, `proposalContext.ts`, `chainRepairService.ts`, `granularityRefinement.ts`)
1. `contextSlicer.ts` を新設し、粒度反復用の `sliceRelevantSourceParagraphs` と接続提案・連鎖点検用の `sliceProposalSourceRows`（直接参照段落 $\to$ 冒頭3段落 $\to$ 前後1段落の文脈窓の優先度で最大25,000文字にスライス）を共通化する。
2. `proposalContext.ts` の `[全イベント]` テーブルに `assignedEntities` 列（`entityId:role` 一覧）を追加し、`chainRepairService.ts` に「未割当主体を関係に使う場合は必ず `[割当追加]` を同時出力するアトミック規則＋Few-shot正例」および `graphDiagnostics` から生成した `[連結診断ヒント]` を付与する。
3. `granularityRefinement.ts` の `parseRefinementReviewTSV` で13列タブ展開された関係行や `|` / `/` 区切りを正規化し、`applyRefinementOps` で `before` 関係に未関与の主体IDが指定された場合に安全にクリアするガードを導入する。

### 4.4 パイプライン統合と差分推論・技術的負債解消 (`autoConnectionService.ts`, `client.ts`)
1. **決定論的整流の先行適用と事前トリアージ (`autoConnectionService.ts`)**:
   Stage 1（レーン間接続提案）直後に同一レーン内の時系列接続（`repairGeneratedLaneSequence`）を決定論的に先行整流し、`graphDiagnostics` による連結診断を実施。帰結ノードが確定しており全事象が既に完全連結（孤立成分なし・未割当なし）の場合は、Stage 2（`proposeChainRepair`）を安全にスキップする。
2. **ADR-0001 整合の事象分類 (Stage 4) 差分推論 (`classifyEventDraft`)**:
   事実性原則（ADR-0001）に従い、Stage 1 の `[仮判定]` を無確認で自動確定することはせず、利用者が個別確認または「仮判定の一括採用（変動のみ／全件）」で確定したイベント（`classification !== 'unclassified'`）を保持したまま、未判定イベント（`classification === 'unclassified'`）のみを差分で LLM に送信・マージする。
3. **未使用レガシー単発JSON抽出コードの削除 (`client.ts`)**:
   現行の TSV 台帳パイプライン移行後に未使用となっていた旧式の単発 JSON 抽出関数 `extractVTAFromScenario` を削除し、モジュール間の循環依存を排除して保守性を向上させる。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 長大報告書の分析時における `HTTP 504 upstream_timeout` が解消され、`Retry-After` ヘッダや指数バックオフにより一時的なレート制限・ゲートウェイ瞬断からも自動回復する。
  - プロンプトの重複注入が構造的に不可能となり、トークン消費量の削減と指示遵守率が向上する。
  - ADR-0001 の人間中心・事実性原則を守りつつ、確認済みイベントを除いた差分分類と完全連結時の修復スキップにより不要な通信を抑止できる。
- **トレードオフ・考慮事項**:
  - `LLMConfig` にオプション設定（`stream`, `maxRetries`, `retryBaseDelayMs`）が追加されたが、すべて省略可能であり既存の保存済み設定と完全互換である。
- **影響ファイル**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `src/tools/vta/services/llm/client.ts`
  - `public/prompts.json`
  - `src/tools/vta/services/generation/contextSlicer.ts`
  - `src/tools/vta/services/generation/proposalContext.ts`
  - `src/tools/vta/services/generation/granularityRefinement.ts`
  - `src/tools/vta/services/generation/chainRepairService.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts`
  - `tests/vta/llmArchitectureImprovements.test.ts`
