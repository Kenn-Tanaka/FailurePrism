# ADR-0009: 構造化AI診断パッケージとログ分析コスト最適化アーキテクチャ

- **ステータス**: Accepted
- **決定日**: 2026-11-05
- **対象コンポーネント**: VTA Engine / Debug Diagnostics / UI / LLM Client
- **関連ドキュメント・コミット**: [ADR-0004](file:///docs/adr/0004-normalization-audit-and-human-traceability.md), [ADR-0007](file:///docs/adr/0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0008](file:///docs/adr/0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [VTA 構造化AI診断実装設計書](file:///c:/Users/kenta/.gemini/antigravity/brain/5e6081a9-0239-4fe9-a4f9-ddb87815cec7/vta_structured_ai_diagnostics_implementation_plan.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

VTAエディタでは、長大な事故報告書（羽田空港衝突事故など、約2.8万文字・342段落）を解析する際、LLMとの複数回にわたる通信（初期抽出、台帳修復、粒度反復、レーン間接続探索、連鎖点検など）が発生する。
従来のデバッグログ（`FailurePrism-debug-*.json`）は、セッション内の全通信および中間データをフラットにダンプする設計となっていたため、以下の深刻な問題が発生していた：

1. **ファイルサイズと推定トークン数の爆発**:
   - 1回の実行で 1.5MB 〜 10MB（約 350,000 〜 450,000 トークン相当）の超巨大ファイルが生成される。
2. **分析コスト（LLM APIトークン課金・コンテキスト制限）の破綻**:
   - 障害発生時に原因調査のため外部LLM（Claude 3.5 Sonnet, Gemini 1.5 Pro, GPT-4o 等）に読み込ませようとしても、Claude等の200kコンテキスト上限を超過して投入不能となり、長大コンテキストモデルでも1回の質問で数百円〜1,000円超のAPIコストが発生する。
3. **推論精度（S/N比）の著しい低下**:
   - ログの90%以上が「毎回重複して送信される同一のシナリオ原文（約2.8万文字）」「不変のシステムプロンプト憲章」「ReactFlowの描画用UIプロパティ（座標、CSS等）」で占められており、LLMが真のエラー原因（数行のバリデーション不整合）を見落とす（Needle in a Haystack問題）。
4. **人間の認知負荷・調査コストの増大**:
   - 数万行のJSONファイルによりエディタがフリーズし、エンジニアがどこで何が破綻したのかを目視で探すのに多大な時間を浪費していた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **分析コスト（Token Cost & Cognitive Cost）の極小化**:
  単なる文字列圧縮（gzip等：LLMに直接投入できない）ではなく、LLMが即座に解釈できる最小トークン（約 2,000 〜 5,000 トークン）に情報を凝縮すること。
- **原因特定に必要な決定打情報の死守（構造化設計の徹底）**:
  単に表面的なエラーメッセージだけを抜き出すのではなく、以下の**真のデバッグ情報**を必ず構造化して提供すること：
  1. **エンティティの変遷履歴（Data Lineage）**: 異常対象（例: `card_61`）がどのフェーズで生成され、何を参照し、どこで参照先が消えたのかの追跡。
  2. **ピンポイントな原文証拠（Evidence Anchor）**: シナリオ全文ではなく、疑義のある行が参照した段落（例: `P12`）のテキストのみ。
  3. **生データ対比（Raw vs Parsed）**: LLMの生TSV行とパース後オブジェクトの対比。
  4. **フェーズ遷移（Pipeline Transitions）**: 各フェーズでのエンティティ数増減および粒度スコア推移。
- **非破壊性と後方互換性**:
  既存のパイプラインコードに侵襲的な改変を加えずに、純粋関数的に診断データを構築できること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: 単純な gzip / zip 圧縮保存**:
  - メリット: 実装が容易で、ファイルサイズは 1.5MB $\rightarrow$ 150KB に圧縮できる。
  - デメリット: 解凍すると元の 350,000 トークンに戻るため、LLM投入時のコンテキスト溢れや課金コストの低減には全く寄与しない。
- **選択肢B: 表面的なエラー要約のみの出力（1,000トークン以下）**:
  - メリット: トークン数は極小。
  - デメリット: 「card_61にイベントがない」といった表面現象しか伝わらず、パイプラインのどの処理でイベントが切り離されたのかが分からないため、LLMが誤診する。
- **選択肢C: 構造化AI診断パッケージ（Structured AI Diagnostics）＋生ログ参照化ハイブリッド（採用）**:
  - LLM投入専用の構造化サマリー（Markdown / YAML互換、約 3,000〜5,000 トークン）を生成・ワンクリックコピー可能とし、同時に生ログ側でもシナリオ・固定プロンプトの参照化（`[REF:...]`）とコンパクトJSONを適用して 1.5MB $\rightarrow$ 180KB に縮小する。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 構造化AI診断スキーマ（Structured Diagnostics Schema v1）の策定
`AIDiagnosticsPackage` 型を定義し、以下のセクションで構成する：
1. `meta`: 実行環境、モデル名、適用契約、シナリオ長（先頭150字スニペットと段落数）。
2. `failure`: 発生フェーズ、エラーメッセージ、トリガーとなったエンティティID。
3. `entity_lineage`: 異常対象エンティティのライフサイクル（CREATED $\rightarrow$ MUTATED $\rightarrow$ DROPPED $\rightarrow$ ORPHANED_ERROR）。
4. `anomalies`: バリデーション警告・除外レコードの生TSV行、パース後オブジェクト、違反理由、および**ピンポイントなエビデンス段落テキスト**。
5. `pipeline_transitions`: 各フェーズの所要時間、件数推移、粒度スコア推移。
6. `contract_rules`: 違反した契約ルールの抜粋。

### 4.2 純粋関数的診断ビルダー（`AIDiagnosticsBuilder`）の実装
`src/tools/vta/services/diagnostics/aiDiagnostics.ts` を新設し、`DebugEntry[]` と `scenarioText`、および最新エラー情報から上記スキーマを自動構築する。
- エラー文から正規表現（`/(card_[a-zA-Z0-9_]+|E\d+|A\d+|R\d+)/`）でエンティティIDを特定し、全ログエントリからそのIDの変遷を追跡。
- 該当段落番号（例: `P12`）を `scenarioText` から特定し、該当段落のみを抽出。
- フォーマッター `formatAIDiagnosticsAsMarkdown` により、Claude / ChatGPT / Gemini にそのままコピペできるMarkdownを出力。

### 4.3 生デバッグログの参照化（Deduplication by Reference）
`debugRecorder.exportText` に `deduplicate` オプションを導入：
- ヘッダーに `sharedContext: { scenarioSnippet, systemPrompts }` を配置。
- 各 `llm.request` 内の同一シナリオ・固定プロンプトを `"[REF:scenarioText]"` に置換。
- デバッグログ先頭に `aiDiagnostics` を自動埋め込み。

### 4.4 UI導線の強化
- `ScenarioInputSection.tsx` のエラーバナーに「📋 AI診断データをコピー」ボタンを設置。
- `DebugLogsSection.tsx` および `DebugRecordingControls.tsx` に「📋 AI診断コピー」ボタンおよび「軽量保存（約85%削減）」トグルを設置。

---

## 5. 結果と影響 (Consequences)

### メリット
- **トークン数 98.5% 削減**: 350,000 tokens $\rightarrow$ 3,000〜5,000 tokens。
- **Claude / GPT への即座投入**: 200k上限を一切気にせず、ワンクリックで貼り付け可能。
- **API分析コスト 99% 削減**: 1回数百円〜千円超から数円〜十数円へ激減。
- **原因特定精度の飛躍的向上**: エンティティ変遷とピンポイント段落エビデンスにより、LLMがパイプライン深層の不整合原因を1発で正確に特定可能。
- **生ログファイルサイズ 85% 削減**: 1.5MB $\rightarrow$ 180KB〜250KB。

### トレードオフ・考慮事項
- ログエクスポート時に `deduplicate: true` の場合、生JSONをスクリプト等で機械処理する際は `sharedContext` の参照を解決する必要がある（`formatAIDiagnosticsAsMarkdown` では自動展開）。生データが必要な用途のために、完全生ダンプ（Raw Dump）も選択可能とする。

### 影響を受けるファイル
- `docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md`（新規）
- `docs/adr/README.md`（更新）
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`（新規）
- `src/tools/vta/services/debugRecorder.ts`（更新）
- `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`（更新）
- `src/tools/vta/components/control-panel/DebugLogsSection.tsx`（更新）
- `src/tools/vta/components/control-panel/DebugRecordingControls.tsx`（更新）
- `tests/vta/aiDiagnostics.test.ts`（新規）
