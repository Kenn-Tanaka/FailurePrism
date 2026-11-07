# Architecture Design Records (ADR) - FailurePrism

本ディレクトリには、FailurePrism（TPDD-Editor および VTA-Editor）の設計・実装における重要なアーキテクチャ上の決定事項（Architecture Design Records / Architecture Decision Records）が記録されています。

---

## ADRの目的と運用ルール

1. **目的**: 
   - 「なぜその構造・振る舞い・インターフェースを選択したのか」「どのような制約や代替案を検討したのか」という設計の背景と意思決定の経緯を将来の開発者・保守担当者・エージェントへ明確に伝達する。
2. **記載タイミング**:
   - データ構造・スキーマの変更、パイプラインステージの再編、GUI表示・幾何計算のポリシー変更、外部通信・LLMポリシーの改訂など、非自明なアーキテクチャ変更を行う際に作成または更新する。
3. **命名規則**:
   - `docs/adr/NNNN-<kebab-case-title>.md`（4桁連番＋簡潔な英語タイトル）
4. **ステータス定義**:
   - `Proposed`: 提案中・レビュー中
   - `Accepted`: 承認・実装完了
   - `Superseded by ADR-xxxx`: 後続の決定によって置き換えられた
   - `Deprecated`: 廃止された

---

## ADR 一覧

| 番号 | タイトル | ステータス | 決定日 | 概要 |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](file:///docs/adr/0001-two-stage-event-classification-and-batch-adoption.md) | 2段階イベント分類（正規化時仮判定）と仮判定一括採用・一括Undo | `Accepted` | 2026-11-04 | 事実性原則を守るため自動生成完了時は未判定とし、仮判定の一括採用（変動のみ/全件）および1ステップUndo（パネル内・キャンバス）を実現 |
| [ADR-0002](file:///docs/adr/0002-outcome-node-card-preservation-for-passive-objects.md) | 受動客体における帰結ノード（Outcome）の通常カード表示維持 | `Accepted` | 2026-11-04 | 被害・損失側レーンの客体ノードであっても、事故の終局を示す帰結ノードは自動ドット化を抑止しカード表示を維持 |
| [ADR-0003](file:///docs/adr/0003-subject-object-node-differentiation-and-junction-projection.md) | 作用主体（能動）と受動客体のノード分離およびジャンクション投影 | `Accepted` | 2026-11-03 | 共有イベントの受動客体を24pxドットに縮約投影し、レーン間の視覚的混雑を解消しつつ台帳整合性を維持 |
| [ADR-0004](file:///docs/adr/0004-normalization-audit-and-human-traceability.md) | 正規化処理の人間による監査可能性とテキスト帳票出力機能 | `Accepted` | 2026-11-03 | LLMによる呼称統一・誤字補正・過失語除去・未参照段落を人間が検証できる完全なテキスト帳票エクスポート機能 |
| [ADR-0005](file:///docs/adr/0005-extended-pdf-ingestion-for-large-incident-reports.md) | 長大事故調査報告書（250ページ対応）のPDF読み込み制限拡張 | `Accepted` | 2026-11-03 | 羽田空港事故等の長大報告書（150ページ超）を事前要約なしで直接読み込めるよう、メモリ安全性を確保しつつ250ページへ拡張 |
| [ADR-0006](file:///docs/adr/0006-vta-animation-and-animated-svg-export.md) | VTAツリーの動的リプレイ可視化と純粋CSS内蔵Animated SVG出力 | `Accepted` | 2026-11-04 | 事故因果フローとAI推論進化の2モードリプレイ、および外部スクリプト不要でPowerPointやブラウザで自律再生可能なAnimated SVG出力を実現 |
| [ADR-0007](file:///docs/adr/0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md) | 帰結以降の事後調査活動の自動除外と第二の帰結（レジリエンス・リカバリー）の保持 | `Accepted` | 2026-11-04 | 事故調査委員会等の事後プロセスを自動除外するUIトグルと多層防御、および事故直後の全員脱出等のレジリエンス行動を第2帰結として保持する仕組みを実現 |
| [ADR-0008](file:///docs/adr/0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md) | 主体の帰結共有度に基づく統合・独立制御および非影響主体のレーン除外ポリシー | `Accepted` | 2026-11-05 | 帰結非対称性（風防脱落、品証水際阻止、CSIRT遮断）における主体の統合ブロックと独立維持、およびインシデント非関与主体のレーン除外による擬似因果連鎖の撲滅 |
| [ADR-0009](file:///docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md) | 構造化AI診断パッケージとログ分析コスト最適化アーキテクチャ | `Accepted` | 2026-11-05 | ログ肥大化（35万トークン/1.5MB）に対し、データリネージ追跡・ピンポイント原文証拠・生データ対比を備えた約3,000トークンの構造化診断出力と生ログ参照化（85%削減）を実現 |
| [ADR-0010](file:///docs/adr/0010-subject-poset-dag-and-canonical-inclusion.md) | 主体意味論的包含関係の半順序集合（Poset / DAG）化および正準包含確定ポリシー | `Accepted` | 2026-11-06 | 意味的等価な対象を同一視し、多重包含・推移律を保証する半順序DAG（SubjectPoset）を初期確定し、下流の統合・連鎖点検で一貫利用して推論ゆらぎと過剰リジェクトを撲滅 |
| [ADR-0011](file:///docs/adr/0011-olap-drilldown-and-rollup-for-subject-poset.md) | 主体包含DAGに基づくOLAP的ドリルダウン・ロールアップ（展開・集約）機能 | `Accepted` | 2026-11-06 | 台帳データを破壊することなく、Poset包含関係に基づき親主体のレーンを子主体のサブレーンへ動的に展開（Drill-down）および集約（Roll-up）する可視化機能 |
| [ADR-0012](file:///docs/adr/0012-chain-repair-delta-validation-and-relation-sanitization.md) | 連鎖修復差分検証における既存関係サニタイズと巻き添えリジェクト防止ポリシー | `Accepted` | 2026-11-06 | 差分検証時に既存スキーマ内の不整合リレーションが新規提案（before関係等）を巻き添えリジェクトする問題を、既存関係の事前サニタイズとPoset再解決により撲滅 |
| [ADR-0013](file:///docs/adr/0013-machine-lane-suppression-and-refinement-context-slicing.md) | 機器主体のレーン化抑制・組織包含の抽出義務付けおよび粒度反復における原文コンテキストスライシング | `Accepted` | 2026-11-06 | 機器支援機能による人間レーン占有の防止、組織包含階層の義務付け、および長大テキスト時の粒度反復における504タイムアウト防止スライシングを実現 |
| [ADR-0014](file:///docs/adr/0014-junction-edge-routing-and-smooth-arrival.md) | ドット表示ノード（客体・接続点）への配線幾何と手前屈曲の解消ポリシー | `Accepted` | 2026-11-06 | ドット表示ノードへの接続時に生じていた手前30pxでの不自然な直角クランク・自己ノード障害物誤認を解消し、レーン境界からドット中央へ水平に美しく接続する配線刷新を実現 |
| [ADR-0015](file:///docs/adr/0015-llm-streaming-retry-and-prompt-architecture.md) | VTA LLM通信層のSSEストリーミング・指数バックオフ自動リトライおよびべき等プロンプト合成・文脈スライシングアーキテクチャ | `Accepted` | 2026-11-06 | 長大文書でのHTTP 504タイムアウトを防ぐSSEストリーミング受信・指数バックオフ自動リトライ、マーカー置換によるべき等プロンプト合成、適応型文脈スライサー、および連鎖修復・粒度反復の構造ガードを実現 |
| [ADR-0016](file:///docs/adr/0016-preliminary-classification-pipeline-separation.md) | 粒度反復方式における仮判定パイプラインの分離と段階的評価アーキテクチャ | `Accepted` | 2026-11-07 | 長大報告書での初回トークン遅延（TTFT）とHTTP 504タイムアウトを抑制するため、Stage 1a（骨格正規化）から仮判定を分離し、直後に確定イベントを軽量評価するStage 1b専用パスを新設 |
| [ADR-0017](file:///docs/adr/0017-outcome-first-anchoring-prompt-order.md) | アンカリング思考順序に整合した帰結先行セクション出力順序アーキテクチャ | `Accepted` | 2026-11-07 | 思考手順指示（アンカリング順）とTSV出力順序を一致させ、[帰結]を[主体]・[イベント]の前に先行出力させるオプトインアーキテクチャ（実機計測で2試行とも台帳修復に失敗したため既定オフとして実験保持。原因は未特定） |
| [ADR-0018](file:///docs/adr/0018-tpdd-llm-gateway-retry-and-shared-transport.md) | TPDD LLM通信層の共通部品化・指数バックオフ自動リトライおよびSSEストリーミング既定化 | `Accepted` | 2026-11-07 | SSEパーサーとリトライ制御を`src/shared/llm/`に共通化し、TPDDの`gatewayClient`に指数バックオフ再試行（Retry-After対応）と新規Projectでの`stream: true`既定化を導入 |
| [ADR-0019](file:///docs/adr/0019-tpdd-prompt-status-awareness-and-report-evidence-rules.md) | TPDD プロンプトのノード状態認識・祖先系譜の付与および要求レポート根拠規則の厳格化 | `Accepted` | 2026-11-07 | プロンプトへの`status`・`tags`・接続線定義・上位要求系譜（`ancestry`）の追加、要求レポートからの`rejected`ノード除外、および`concretization`節の詳細図ノード引用必須化を実現 |


---

## ADR テンプレート

新しいADRを作成する場合は以下のテンプレートを使用してください：

```markdown
# ADR-NNNN: [タイトル]

- **ステータス**: Proposed | Accepted | Superseded by ADR-xxxx | Deprecated
- **決定日**: YYYY-MM-DD
- **対象コンポーネント**: [例: VTA Engine / UI / LLM Gateway / Data Schema]
- **関連ドキュメント・コミット**: [リンク]

## 1. コンテキストと課題 (Context & Problem Statement)
[どのような問題があり、なぜアーキテクチャ上の決定が必要になったかの背景を記述]

## 2. 決定理由の要因・制約 (Decision Drivers)
- [制約事項や必須要件]
- [人間中心設計、事実性担保、パフォーマンス、互換性など]

## 3. 検討した選択肢 (Considered Options)
- 選択肢1: ...
- 選択肢2: ...

## 4. 決定事項 (Decision Outcome)
[採用した決定とアーキテクチャ構造を明確に記述]

## 5. 結果と影響 (Consequences)
- **メリット**: ...
- **トレードオフ・考慮事項**: ...
- **影響を受けるファイル・テスト**: ...
```
