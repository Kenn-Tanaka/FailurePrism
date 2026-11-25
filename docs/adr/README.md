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
| [ADR-0010](file:///docs/adr/0010-subject-poset-dag-and-canonical-inclusion.md) | 主体意味論的包含関係の半順序集合（Poset / DAG：有向非巡回グラフ）化および正準包含確定ポリシー | `Accepted` | 2026-11-06 | 意味的等価な対象を同一視し、多重包含・推移律を保証する主体包含関係の有向非巡回グラフ（SubjectPoset: 半順序DAG）を初期確定し、下流の統合・連鎖点検で一貫利用して推論ゆらぎと過剰リジェクトを撲滅 |
| [ADR-0011](file:///docs/adr/0011-olap-drilldown-and-rollup-for-subject-poset.md) | 主体包含DAGに基づく多次元分析（OLAP）的ドリルダウン・ロールアップ（展開・集約）機能 | `Accepted` | 2026-11-06 | 台帳データを破壊することなく、Poset（半順序集合）包含関係に基づき親主体のレーンを子主体のサブレーンへ動的に展開（Drill-down）および集約（Roll-up）する可視化機能 |
| [ADR-0012](file:///docs/adr/0012-chain-repair-delta-validation-and-relation-sanitization.md) | 連鎖修復差分検証における既存関係サニタイズと巻き添えリジェクト防止ポリシー | `Accepted` | 2026-11-06 | 差分検証時に既存スキーマ内の不整合リレーションが新規提案（before関係等）を巻き添えリジェクトする問題を、既存関係の事前サニタイズとPoset再解決により撲滅 |
| [ADR-0013](file:///docs/adr/0013-machine-lane-suppression-and-refinement-context-slicing.md) | 機器主体のレーン化抑制・組織包含の抽出義務付けおよび粒度反復における原文コンテキストスライシング | `Accepted` | 2026-11-06 | 機器支援機能による人間レーン占有の防止、組織包含階層の義務付け、および長大テキスト時の粒度反復における504タイムアウト防止スライシングを実現 |
| [ADR-0014](file:///docs/adr/0014-junction-edge-routing-and-smooth-arrival.md) | ドット表示ノード（客体・接続点）への配線幾何と手前屈曲の解消ポリシー | `Accepted` | 2026-11-06 | ドット表示ノードへの接続時に生じていた手前30pxでの不自然な直角クランク・自己ノード障害物誤認を解消し、レーン境界からドット中央へ水平に美しく接続する配線刷新を実現 |
| [ADR-0015](file:///docs/adr/0015-llm-streaming-retry-and-prompt-architecture.md) | VTA LLM通信層のSSE（逐次ストリーミング）・指数バックオフ自動リトライおよびべき等プロンプト合成・文脈スライシングアーキテクチャ | `Accepted` | 2026-11-06 | 長大文書でのHTTP 504タイムアウトを防ぐSSE（Server-Sent Events：逐次受信ストリーミング）受信・指数バックオフ自動リトライ、マーカー置換によるべき等プロンプト合成、適応型文脈スライサー、および連鎖修復・粒度反復の構造ガードを実現 |
| [ADR-0016](file:///docs/adr/0016-preliminary-classification-pipeline-separation.md) | 粒度反復方式における仮判定パイプラインの分離と段階的評価アーキテクチャ | `Accepted` | 2026-11-07 | 長大報告書での初回トークン生成遅延（TTFT: Time to First Token）とHTTP 504タイムアウトを抑制するため、Stage 1a（骨格正規化）から仮判定を分離し、直後に確定イベントを軽量評価するStage 1b専用パスを新設 |
| [ADR-0017](file:///docs/adr/0017-outcome-first-anchoring-prompt-order.md) | アンカリング思考順序に整合した帰結先行セクション出力順序アーキテクチャ | `Accepted` | 2026-11-07 | 思考手順指示（アンカリング順）とTSV出力順序を一致させ、[帰結]を[主体]・[イベント]の前に先行出力させるオプトインアーキテクチャ（実機計測で2試行とも台帳修復に失敗したため既定オフとして実験保持。原因は未特定） |
| [ADR-0018](file:///docs/adr/0018-tpdd-llm-gateway-retry-and-shared-transport.md) | TPDD LLM通信層の共通部品化・指数バックオフ自動リトライおよびSSE（逐次ストリーミング）既定化 | `Accepted` | 2026-11-07 | SSE（Server-Sent Events：逐次ストリーミング）パーサーとリトライ制御を`src/shared/llm/`に共通化し、TPDDの`gatewayClient`に指数バックオフ再試行（Retry-After対応）と新規Projectでの`stream: true`既定化を導入 |
| [ADR-0019](file:///docs/adr/0019-tpdd-prompt-status-awareness-and-report-evidence-rules.md) | TPDD プロンプトのノード状態認識・祖先系譜の付与および要求レポート根拠規則の厳格化 | `Accepted` | 2026-11-07 | プロンプトへの`status`・`tags`・接続線定義・上位要求系譜（`ancestry`）の追加、要求レポートからの`rejected`ノード除外、および`concretization`節の詳細図ノード引用必須化を実現 |
| [ADR-0020](file:///docs/adr/0020-vta-relation-deduplication-and-revert-preservation.md) | VTA 粒度反復における関係ID重複防止・端点正規化および再最適化時の関係復元ポリシー | `Accepted` | 2026-11-07 | 粒度反復レビューでの関係ID衝突（`rel_ref_M1`等）の決定論的一意化、端点主体の統合レーン正規化、および`revertConsolidation`での逆解決フォールバックと自己治癒サニタイズにより「VTA最適化」時のクラッシュを撲滅 |
| [ADR-0021](file:///docs/adr/0021-vta-pipeline-history-snapshots-and-evolution-replay.md) | VTA AI生成プロセスの実パイプライン履歴記録と完全変遷動的リプレイ | `Accepted` | 2026-11-07（2026-11-20 追記） | 軽量スナップショット構造による各ステージ（初期抽出・粒度反復・自動接続・要因判定）の履歴保持、既存データからの19レーン完全復元、エッジ論理和バグ解消、スイムレーン背景同期およびキャンバスRead-Only保護を実現。追記：保存→読込・下書き復元で `pipelineHistory` を検証・保持（`sanitizePipelineHistory`） |
| [ADR-0022](file:///docs/adr/0022-pre-outcome-node-protection-and-refinement-lane-sequence-repair.md) | 帰結前事象の過剰除外防止とAI粒度反復時のレーン内時系列再整流 | `Accepted` | 2026-11-08 | 最終帰結の出現順（`maxOutcomeOrder`）以前の事象を事後調査除外から保護し、カード再採番時のID衝突防止・AI粒度反復後のレーン内時系列線再整流および主体統合時の明示的統合指定を実現 |
| [ADR-0023](file:///docs/adr/0023-ledger-prompt-disambiguation-and-preliminary-downgrade.md) | 台帳プロンプトにおける未割当主体・仮判定書式の明確化と仮判定格下げ・ポリシーブロック置換の是正 | `Accepted` | 2026-11-08 | `upsertPolicyBlock`の前方一致バグ修正による`omitPreliminary`時の`[仮判定]`完全除去、未割当主体（`-`）・仮判定記入例の明記（`event-ledger-15`）、および`-:actor`正規化と根拠欠落仮判定の`undetermined`格下げバックストップを導入 |
| [ADR-0024](file:///docs/adr/0024-ledger-parser-resilience-and-parse-error-diagnostics.md) | 台帳パーサーの構文耐性・自己治癒とパース失敗時診断トレーサビリティの強化 | `Accepted` | 2026-11-08 | 非参照終端セクション（`帰結`, `共有カード`, `整理`等）のID省略・記号補完、セル内改行の自動結合、マークダウン/スペース区切りフォールバック、およびパース失敗時の生行抜粋と診断トレーサビリティを実現 |
| [ADR-0025](file:///docs/adr/0025-ai-diagnostics-trace-hygiene-and-full-pipeline-observability.md) | AI診断トレースのノイズ除去・仮適用記録分離と全パイプライン観測性強化 | `Accepted` | 2026-11-09 | 連鎖修復ドライラン時の`silentDebug`分離による20件超の重複投影記録の撲滅、同一遷移のランレングス圧縮`(xN)`、およびStage 1b/3遷移・エッジ数・LLM通信メトリクス・帰結メタデータの診断パッケージ統合を実現 |
| [ADR-0026](file:///docs/adr/0026-card-preservation-for-cross-lane-sources-and-lane-terminals.md) | クロスレーン矢印始点およびレーン最上端ノードの通常カード表示維持ポリシー | `Accepted` | 2026-11-09 | 受動客体であっても、他レーンへの接続線（クロスレーン矢印）の始点ノードおよび各レーン最上部（時系列末尾）の終端ノードを自動ドット化から保護し通常カード表示を維持することで、因果起点と各アクターの結末の可読性を確保 |
| [ADR-0027](file:///docs/adr/0027-relation-id-disambiguation-and-stream-progress-observability.md) | 関係IDの自動重複解消・プロンプト一意化とSSEストリーム進捗可視化・誤謬リトライ警告是正 | `Accepted` | 2026-11-09 | 非参照関係IDの自動重複解消・プレースホルダ補完、契約プロンプトの一意ID指定、SSE受信中のリアルタイム進捗ログ（文字数・速度）、およびHTTP 200切断時の誤謬リトライ警告是正を実現 |
| [ADR-0028](file:///docs/adr/0028-progress-overlay-non-blurring-and-live-log-visibility.md) | 進捗表示ダイアログの背景ぼかし（backdrop-blur）撤廃とリアルタイム通信ログ可視化ポリシー | `Accepted` | 2026-11-09 | 進捗表示オーバーレイから全画面背景ぼかし（`backdrop-blur-md`）を完全撤廃し、背面の実行・通信ログを100%鮮明に可読化するとともに、ダイアログ内にも最新通信ログをリアルタイム表示 |
| [ADR-0029](file:///docs/adr/0029-workflow-aligned-ui-layout-and-step-navigation.md) | VTA分析ワークフローに沿った3ステップUIナビゲーション・常設通信ログおよびツールバー再編ポリシー | `Accepted` | 2026-11-09 | 左パネルを折りたたみ式LLM設定・3ステップワークフロータブ（①抽出→②検証→③対策）・下部常設通信ログの3ゾーンに再編し、ワイドレポート閲覧モーダルおよびキャンバスツールバー・ヘッダーの工程順整理を実現 |
| [ADR-0030](file:///docs/adr/0030-one-sided-relation-demotion-and-ai-diagnostics-observability.md) | 片側主体未指定関係の安全な格下げ・自己治癒とAI診断パッケージの観測性強化 | `Accepted` | 2026-11-09 | 複数主体関与事象からの波及関係で片側主体が未特定（`-`）の場合に単一主体の自動補完または`before`への安全な格下げを行い関係脱落を防止するとともに、AI診断パッケージの帰結保持・段落抽出・変異系譜追跡を実現 |
| [ADR-0031](file:///docs/adr/0031-srk-and-three-failure-factors-variation-classification-and-countermeasure-alignment.md) | SRK・失敗学三大要因による変動要因精緻化・正負色分け可視化と体系的対策推薦アーキテクチャ | `Accepted` | 2026-11-09 | 負の変動（Amber）と正の変動（Teal）のキャンバス色分け、通常逸脱への失敗学三大要因（過信/無視/無知）の適用、判定理由からの自動抽出パーサー、および工学的バリア指針に基づくAI対策推薦・レポート生成の体系的連携を実現 |
| [ADR-0032](file:///docs/adr/0032-resilient-event-columns-and-audit-phrase-matching.md) | イベント列欠落の安全補完と監査フレーズ照合の3層防御（記号正規化・段落間補正・非停止除外） | `Accepted` | 2026-11-10 | イベント末尾区分（`recorded`）省略時の安全自動補完ガード、および任意監査セクション（`[表現]`, `[表記]`）における記号正規化一致（`cleanPunctuation`）・段落間自動補正・非停止安全除外によるパイプライン耐障害性向上を実現 |
| [ADR-0033](file:///docs/adr/0033-interactive-machine-actors-and-graceful-degradation.md) | 能動的・対話的装置の主要主体昇格およびレジリエンス機能縮退（Graceful Degradation）のVTAツリー統合ポリシー | `Accepted` | 2026-11-11 | HMIメンタルモデル不整合（Mode Confusion）や自律介入・機能縮退に関与する装置を多層シグナル（双方向因果・意味論・レジリエンス）により主要主体へ昇格・マージ保護し、機能縮退を正の変動要因（Teal）として第一級市民化 |
| [ADR-0034](file:///docs/adr/0034-row-cell-layout-and-matrix-event-time-dag.md) | 行（Row）・セル（Cell）概念の導入と反対称2次元配列によるイベント時間半順序DAG（EventTimeDAG）および非破壊無視フラグアーキテクチャ | `Accepted` | 2026-11-14 | 旧スキーマ互換フォールバックの廃止、イベント非破壊無視フラグ（`ignored`）、追加順ユニークID採番、整数 `timeNodeId`（上限400）と反対称2次元配列 `matrix[u][v]`（`+1/+2`, `-1/-2`, `0`）による時間半順序DAG、および行（Row）・セル（Cell）レイアウトモデルを導入 |
| [ADR-0035](file:///docs/adr/0035-bitset-poset-engine-and-transitive-pruning.md) | Uint32Arrayビット行列と推移性比較削減による半順序集合（BitsetPoset）管理エンジンの高速化 | `Accepted` | 2026-11-15 | `Uint32Array` による `lower` / `upper` 転置ビット行列と `active` ビットベクトル、推移性ビットOR伝播による比較処理削減、償却 $O(1)$ 論理削除・スロット再利用、ビットANDによるハッセ図被覆導出を備えた汎用 `BitsetPoset` の導入と `SubjectPoset` の刷新 |
| [ADR-0036](file:///docs/adr/0036-prioritize-other-actors-lane-leftmost.md) | 「その他の関係者」レーンのVTA図左端優先配置および列順変更に伴う座標シフト整合ポリシー | `Accepted` | 2026-11-17 | 新規生成・追加・分割・統合時に「その他の関係者」レーンを左端 (`index 0`) へ優先配置しつつ手動 `moveLane` 配置・保存順を維持し、詳細・コンパクト両座標の `LANE_WIDTH` シフトおよび `lanes[0]` 既定前提補正を一貫統合 |
| [ADR-0037](file:///docs/adr/0037-dual-use-four-edge-handles.md) | VTAノード接続端子の入出力兼用4端子化および接続ラベルによる方向表現 | `Accepted` | 2026-11-17 | `ConnectionMode.Loose` による上下左右 4 端子（側面 `50%`）の入出力兼用化と、Canvas・SVG 共通の矢印形状接続ラベルによる方向明示を導入 |
| [ADR-0038](file:///docs/adr/0038-direct-horizontal-cross-lane-edges.md) | レーン跨ぎ同高さノード間の直接水平接続と多辺非重複ルーティング | `Accepted` | 2026-11-17 | ノード／他ラベル（BREAK含む）／水平線／回避可能な線同士の縦交差（案α）と非重複の場合に直接水平直線を採用（ラベルと線の重なりは許容）し、隣接・跨ぎの逆向き重複ペアも 2 パス解決で分離 |
| [ADR-0039](file:///docs/adr/0039-dot-junction-vertical-alignment-and-dom-dimension-guard.md) | ドット表示ノードの垂直中心整列および DOM 実測寸法ガード | `Accepted` | 2026-11-17 | 受動客体ドット（24px）の Y 座標二重オフセット解消、DOM `24×24` dimensions 上書き・ドラッグ逆投影の統一保護、未保存自動配置時の初回 DOM 高さ追従再整列により同ランク接続線の直線化を保証 |
| [ADR-0040](file:///docs/adr/0040-vertical-edge-label-shape-and-offset.md) | 縦線接続ラベルの上下方向スパイク形状化と交差回避垂直シフト | `Accepted` | 2026-11-17 | ホスト線分基準の方向解決（`Case 2b` 縦区間の `up`/`down` 化）、上下中央スパイク付き専用形状（補助アイコン省略）、および 3 パス解決による縦線ラベルのみの交差回避垂直シフトを導入 |
| [ADR-0041](file:///docs/adr/0041-tpdd-whole-project-proposal-report-generation.md) | TPDD 全体提案書・説明文生成機能の刷新と外部AI（Gemini / ChatGPT）連携構造化出力 | `Accepted` | 2026-11-17 | 起点ノード指定を廃止しプロジェクト全体（複数最上位要求・詳細図・プロジェクト説明）を対象化、文書形式プリセット（提案書・プレゼン構成・設計概要・カスタム）および Gemini / ChatGPT 連携用の作成指示ヘッダ・抽象度列別構造化台帳出力を導入 |
| [ADR-0042](file:///docs/adr/0042-shared-llm-registry-and-manager-plugin.md) | 共通LLMモデルレジストリ（配布シード連携）およびLLMモデル管理プラグインの導入 | `Accepted` | 2026-11-18 | `src/shared/llm/` による共通＋ツール別デフォルトLLMおよび推奨LLMカタログ一元管理、配布シード（`public/llm-models.json`）階層読込、および `src/tools/llm-manager/` プラグインによるGUI管理・Gateway取込・疎通テストを実現 |
| [ADR-0043](file:///docs/adr/0043-poset-transitivity-across-ledger-and-lane-relation-preservation.md) | 台帳検証・投影・再同期へのSubjectPoset推移性一貫適用と同一レーン内意味関係エッジ保護ポリシー | `Accepted` | 2026-11-18 | `inspectLedger`・`projectAnalysis`・`reconcileAnalysis`・`consolidateSubjects` への `SubjectPoset` 推移性一貫適用、`repairLaneConnections` での `relationId` 意味関係エッジおよび「その他の関係者」レーン保護、および診断トレース分類是正を実現 |
| [ADR-0044](file:///docs/adr/0044-connection-proposal-prefilter-history-preservation-and-diagnostics-accuracy.md) | 接続提案の上流重複候補フィルタ・パイプライン履歴/新規置換境界・同尺度反復評価および診断カウント分離ポリシー | `Accepted` | 2026-11-18 | 接続提案の既接続カードペア事前除外と Poset 正規化、`projectAnalysis` の `pipelineHistory` 保持と新規生成の `replaceProject` 境界、粒度反復の同尺度採択判定、および AI 診断の `events`/`nodes` 分離・Poset 全展開・採択内訳可視化を実現 |
| [ADR-0045](file:///docs/adr/0045-intra-lane-sequence-dag-alignment-and-wiring-diagnostics.md) | レーン内順序線とEventTimeDAGランクの完全同期・同ランクBottom-to-Top配置および配線幾何診断ポリシー | `Accepted` | 2026-11-18 | 括弧付き秒パース・同ランクsiblingのBottom-to-Top配置・`EventTimeDAG`と`sequence_order`/直列線の完全同期、および診断パッケージへの配線幾何監査（逆行・飛び越し・迂回・不採用投影分離・重複圧縮）を実現 |
| [ADR-0046](file:///docs/adr/0046-cross-lane-wire-clearance-and-diagnostics-lineage.md) | クロスレーン配線の離隔チャネル割当・水平バッジ非重複および診断リネージ厳格化ポリシー | `Accepted` | 2026-11-18 | Pass 1/Pass 2 共通の競合回避コリドー/チャネル探索、側面最小離隔18px化・水平線離隔12px/垂直線離隔14px統一、水平バッジXスタッガード、および `auditVTALayoutGeometry` 拡張と `traceEntityLineage` 厳密ID照合を実現 |
| [ADR-0047](file:///docs/adr/0047-reoptimize-layout-monotonicity-and-vertical-stub-exemption.md) | VTA再最適化時の座標整合保護・共有上下ポート垂直スタブ免除およびLLM失敗遷移観測 | `Accepted` | 2026-11-18 | `shiftReactNodesForLaneChange` と `calculateVTALayout` の BT 単調性保護による再最適化逆行解消、`isExemptSharedVerticalPortStub` 導入、`repairLaneConnections` の冗長直列線整理、および `llm.failure` 診断出力を実現 |
| [ADR-0048](file:///docs/adr/0048-resilience-outcome-separation-and-avoidcards-clearance.md) | 緊急脱出・二次回復帰結のイベント別種別分離および avoidCards 水平離隔確保ポリシー | `Accepted` | 2026-11-18 | `[帰結]` の個別 `:recovery` 指定と `projectAnalysis` 優先順位是正、`batchAdoptPreliminary` への `variationFactor` 自動補完・脱出語彙拡充、`帰結: レジリエンス回復` 表記統一、および `avoidCards` の水平帯回避による `0px` 重複解消を実現 |
| [ADR-0049](./0049-haia-workflow-plugin-and-model-aliases.md) | HAIA プラグインとモデル Alias | `Accepted` | 2026-11-19 | HAIA の XML 実行・Python 互換正規表現、逐次表示と無通信タイムアウト、厳密デコード対応ファイル入出力・字幕処理（`unknown_author` 互換）、タスク名変更と Alias 設定を統合 |
| [ADR-0050](./0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md) | 親組織ハブ昇格統合・粒度反復の実質改善採択および帰結イベント仮判定除外ポリシー | `Accepted` | 2026-11-19 | 多子孫を持つ親組織の受け皿昇格と Merge Guard 精密化、粒度反復の同点空振り抑止・構造指標プロンプト還元、および帰結イベントの仮判定・一括採用除外と診断内訳可視化を実現 |
| [ADR-0051](./0051-cross-lane-backward-edge-audit-and-same-rank-alignment.md) | クロスレーン逆行矢印（下方向接続）の幾何監査・時刻逆転提案抑止および同ランク垂直整列ポリシー | `Accepted` | 2026-11-19 | `auditVTALayoutGeometry` と AI 診断への `backwardCrossLaneEdges` 追加、`EventTimeDAG` による時刻逆転接続提案の拒否、および単一占有セルの同ランク・クロスレーン垂直整列を実現 |
| [ADR-0052](./0052-llm-failure-diagnostics-and-stream-early-termination.md) | LLM 失敗時の出力・推論トークン診断可視化および終端マーカーによる SSE ストリーム早期終了ポリシー | `Accepted` | 2026-11-19 | `sseParser` での推論デルタ計測と `llm.failure`／AI 診断への `finishReason`・本文長・推論長・末尾スニペット出力、および単独行 `[完了]` 確定時の SSE 早期終了を実現 |
| [ADR-0053](./0053-vta-stream-idle-timeout-and-reasoning-effort-control.md) | VTA SSE ストリーミングの無通信（アイドル）タイムアウト化および推論強度（`reasoning.effort`）制御ポリシー | `Accepted` | 2026-11-19 | Gateway・HAIA 仕様に合わせた SSE チャンク受信ごとの無通信タイムアウト化、OpenRouter Claude 系の `reasoning.effort` 制御（400 自動フォールバック付）、および推論中進捗ログ可視化を実現 |
| [ADR-0054](./0054-per-event-outcome-kind-defaulting-and-mixed-outcome-audit.md) | 混合帰結における一次損失デフォルト確定・代表種別再集計および幾何監査整理 | `Accepted` | 2026-11-19 | 混合帰結行パース時のサフィックスなしイベントIDの `loss` 確定フォールバック、代表種別（`outcome.kind`）の `loss` 優先再集計、AI 診断への `event_kinds` 出力、および同一カードペア複数エッジの幾何監査整理を実現 |
| [ADR-0055](./0055-outcome-classification-protection-and-manual-demotion.md) | AI変動要因判定からの帰結ノード保護および手動での帰結解除・未判定復帰ポリシー | `Accepted` | 2026-11-20 | 台帳パース時の帰結イベント `classification: 'outcome'` 初期化、AI 変動要因判定・UI未判定カウントからの帰結除外保護、`NodeEditorModal` / `EventReviewPanel` からの手動未判定復帰と `analysis.outcome` 代表種別再集計同期、および人為逸脱行動レベル保存漏れ修正を実現 |
| [ADR-0056](./0056-gateway-retry-observability-cross-lane-geometry-trace-and-temporal-inversion-guard.md) | LLM Gateway一時エラー時の観測適正化・クロスレーン幾何トレーサビリティ強化および時間逆行ガード | `Accepted` | 2026-11-20 | リトライ可能な一時Gateway障害（HTTP 504）のログ・診断成否判定の適正化、`LAYOUT_BACKWARD_CROSS_LANE_EDGE` への端点幾何詳細と生台帳スニペット展開、`before` 連鎖逆行有向関係の早期検知・修復、連鎖点検（`chain.repair`）の関係追加 ID 自動正規化と修復ループ Catch-22 解消、および粒度反復（`granularity.refinement`）の `suppress` 共有エッジ破壊防止とイベント単位 `variationReachability` を実現 |
| [ADR-0057](./0057-interval-time-poset-and-normalization-phase-temporal-ordering.md) | 正規化フェーズにおけるイベント時間区間半順序（Interval Poset）構築と厳密時刻優先ポリシー | `Accepted` | 2026-11-20 | 時刻ラベルの時間軸付き区間 `[lo, hi]` 正規化（`parseTimeInterval`）、`"2024-01-02 -"` 等の午前0時捏造と誤統合の根絶、正規化フェーズ（`inspectLedger`）での `EventTimeDAG` 確定とソフト時間逆行検査、`buildEventTimeDAG` の厳密時刻区間優先順位化、および `t2|` 署名による既存キャッシュ自動再構築を実現 |
| [ADR-0058](./0058-granularity-score-global-rank-crossing-and-causal-reachability.md) | 粒度評価スコア (granularityScore) のグローバル時間ランク交差判定・有向到達率併用および過密ペナルティ是正ポリシー | `Accepted` | 2026-11-20 | `computeEventRanks` による全レーン共通時間ランクでの交差判定、`maxDegree` の重複辺除外、`depthPenalty` の単一レーン内カード数化、および `C3` 変動到達率への有向因果エッジ（`meaning !== 'association'`）到達率併用により、長大シナリオでの正当な `add_relation` 自己否定を解消 |
| [ADR-0059](./0059-granularity-refinement-same-iteration-llm-score-cancellation.md) | 粒度反復の採否判定における LLM 主観スコアの同一反復内相殺ポリシー | `Accepted` | 2026-11-20 | LLM 主観スコア（C2/C4/シナリオ）はレビュー対象 `bestSchema` の評価であるため、全反復で同一反復の LLM スコアを比較の両側に適用（`hasLLMScoreBaseline` 廃止）。2回目以降の採否が LLM 採点の揺れではなく機械指標・トポロジー改善で決まるよう是正 |
| [ADR-0060](./0060-ledger-response-robustness-and-prompt-resolution.md) | TSV 台帳応答の頑健化（紛らわしいヘッダー・範囲外行の非致命化・台帳キャッシュ破棄・プロンプト解決の一元化） | `Accepted` | 2026-11-20 | `[判定]`⇔`[仮判定]` ヘッダーによる誤セクション切替の抑止、正規化台帳の `[判定]` 行・判定応答の範囲外行を警告付き除外（throw 廃止）、決定的検証エラー時のみ `pendingLedgers` 破棄、`captureEventPrompts` 解決済みプロンプトの一元使用、非ストリーム応答の `[完了]` 終端切り詰め |
| [ADR-0061](./0061-stale-ai-result-content-fingerprint-guard.md) | 長時間 AI 処理の結果採否ポリシー（内容指紋による編集検知と確認ダイアログ） | `Accepted` | 2026-11-20 | 座標を除く内容指紋（`computeVTADataHash`）で自動接続・再最適化・変動判定の実行中編集を検知し、適用/破棄を利用者が選択。計測由来の位置補正で `isDirty` を立てない、抽出中の本文 readOnly・ファイル解析中の抽出抑止、一回限り指示の採用後消費 |
| [ADR-0062](./0062-intra-lane-detour-channel-separation-poset-alias-resolution-and-relation-lineage.md) | 同一レーン非隣接迂回エッジの左右・外周チャネル分離・SubjectPoset外部エイリアス不動点解決および関係リネージ追跡強化ポリシー | `Accepted` | 2026-11-21 | `avoidCards` の左右選択・独立横マージン化と Pass 0 競合回避トラック探索による同一レーン飛び越し線の `0px` 重畳解消、`SubjectPoset.fromEntities` の外部エイリアス不動点解決による幽霊ノード混入防止、および AI 診断の `rel_ref_*`/`proposal:*`/`added_*` 2パス優先抽出と関係投影リネージ記録を実現 |
| [ADR-0063](./0063-granularity-machine-adoption-hub-exemption-and-parent-others-guard.md) | 粒度反復の機械指標採否正規化・ハブ次数計算是正および上位組織単独の「その他の関係者」落ち防止ポリシー | `Accepted` | 2026-11-21 | 粒度反復の採否判定から `scenarioScore` 混合による `C3` `0.4`倍圧縮歪みを除去し、`maxDegree` から直列骨格線・帰結収束を除外、0件親組織の `subject_others` 落ち防止および初回関係契約・`[REPAIRED]` 診断表示を実現 |
| [ADR-0064](./0064-chain-review-relation-targets-acyclic-parent-hub-merge-and-semantic-pair-upgrade.md) | 連鎖補完「要確認」の関係ID解決・上位組織逆転マージ非循環化および1対1意味関係アップグレード採用ポリシー | `Accepted` | 2026-11-21 | `[要確認]` の対象ID照合を関係ID・新規デルタ行IDへ拡張し、`SubjectPoset.fromEntities` 構築時除去辺の引き渡しと逆転マージ非循環化・ハブ昇格除外を実現、さらにユニーク無向カードペア数比較による1対1意味関係アップグレード採用を確立 |
| [ADR-0065](./0065-explicit-merge-slot-preservation-uncompressed-convergence-and-preliminary-ref-filtering.md) | 明示マージ元の保持枠除外・非圧縮機械スコア収束判定および仮判定部分範囲外参照救済ポリシー | `Accepted` | 2026-11-21 | 明示マージ元を上位枠配分前から除外して `subject_others` 不要押し出しを防止し、収束 `epsilon` 判定を `scenarioScore` 非圧縮 `machineDelta` へ一本化・Stage 2 履歴と同尺度表示、さらに仮判定の `inScopeRefs` 保持および Section 4 `excluded` 出力を追加 |
| [ADR-0066](./0066-avoidcards-vertical-clearance-soft-guard-parent-fallback-and-refinement-merge-persistence.md) | avoidCards 垂直離隔制御・ソフトガード親組織フォールバック・粒度反復明示統合永続化および事後除外前未割当保護 | `Accepted` | 2026-11-21 | `avoidCards` への `VerticalBand`・`sourceMargin`/`targetMargin` 転送とフォールバック導入、枠上限時のソフトガード親組織フォールバック、粒度反復での `explicitMerges` 永続化・トランザクション更新、`filterPostOutcomeScope` の帰結前未割当保護、および契約明文化・AI診断幾何可視化を実現 |
| [ADR-0067](./0067-scale-adaptive-c5-post-outcome-refinement-scope-and-llm-pass-efficiency.md) | スケール適応型C5認知負荷評価・事後活動除外スコープの粒度反復同期およびLLM反復通信効率化ポリシー | `Accepted` | 2026-11-22 | `computeComplexityBudgets` と漸近飽和 `softCap01` による大規模事例での `C5` 床張り解消・勾配維持、`mNextRawC3` 収束ガード、`collectPostOutcomeExcludedNodeIds` 共通化による事後ノードのレビュー除外、非投影差分時の `chain.repair` Pass 2 スキップ、仮判定80件均等チャンク化と `[完了]` 早期切断、相手側割当主体照合規則および `[参照関与]` リネージ注記を実現 |
| [ADR-0068](./0068-whack-a-mole-sibling-merge-guard-sole-others-unwrapping-and-suppress-hint-accuracy.md) | 明示マージ時の同親兄弟モグラ叩き昇格防止・親なし主体枠優先予約と単独「その他の関係者」根絶・およびsuppress対象ヒント精密化ポリシー | `Accepted` | 2026-11-22 | 明示マージ時の同親下位兄弟の追随統合と0関与組織の初期枠除外、親なし主体枠予約によるソフトMerge Guard横取り防止、1主体単独 `subject_others` の常時実名展開、`suppress` 可能単独カードIDの動的提示、および `機械S` 併記・診断 `outcome.kind` 補完を実現 |
| [ADR-0069](./0069-intentionally-unprojected-relation-diagnostics-review-disposition-persistence-and-ignored-unassigned-filtering.md) | 意図的非投影関係の診断一元化・自動接続「要確認」項目の監査証跡保存および ignored イベントの未割当除外統一ポリシー | `Accepted` | 2026-11-22 | 主体統合等で同一カード内に畳み込まれた関係を `isIntentionallyUnprojectedRelation` で一元除外して不要な `chain.repair` 全文LLM通信を抑止し、自動接続時の `[要確認]` 項目を `analysis.dispositions` へ重複排除保存、Stage 2 トリアージ理由の診断可視化および `ignored` イベントの未割当誤認防止を実現 |
| [ADR-0070](./0070-shared-handle-vertical-stem-clearance-auto-layout-recompute-and-subject-ranking-exclusion-persistence.md) | 共有ハンドル発クロスレーン垂直ステムの14px格子分離・自動レイアウト再計算同期および主体ランキング excluded 永続化ポリシー | `Accepted` | 2026-11-22 | `hitsVerticalBand` の厳密不等号化・禁止帯内スタブ脱出・外向き14px刻みチャネル優先＋Phase C探索により `18px` カード余白を維持したまま垂直ステム近接（12px）を解消し、自動レイアウト時の `forceRecompute`・DOM `edges` 同期、`readSubjectRanking` の `excluded`/`parentEntityIds` 保持および `chain.repair` 内訳拡充を実現 |
| [ADR-0071](./0071-penalty-based-subject-consolidation-and-gentle-lane-cap.md) | ペナルティ目的関数による宣言的主体レーン統合最適化および最大レーン数超過への緩やかな凸ペナルティポリシー | `Accepted` | 2026-11-22 | 手続き的ハブ置換連鎖をトポロジカル分枝限定法による単一ペナルティ目的関数最適化へ刷新し、最大レーン数超過への緩やかな凸ペナルティ・`C1` 曲線整合・0関与中間組織の除外と保持祖先推移解決・接続提案 `[完了]` 早期終了およびリトライ回復診断整備を実現 |
| [ADR-0072](./0072-deferred-final-phase-subject-others-consolidation.md) | 2段階主体上限（$K_{\text{pre}} / K_{\text{post}}$）による中間最適化からの `subject_others` 排除および最終フェーズ周辺主体集約ポリシー | `Accepted` | 2026-11-22 | 中間フェーズ（Stage 2 粒度反復・Stage 3 接続探索）から `subject_others` を完全排除して実名レーンを保持し、接続確定後の最終フェーズで非変動接続の周辺主体を決定論（またはゼロ追加通信の `[周辺主体候補]` AI提案＋決定論ハード保護ガード併用・最低2件ガード付）で集約、併せて `merge` 時 Poset Hasse 極小化と診断遷移可視化を実現 |
| [ADR-0073](./0073-vta-ui-decluttering-and-deterministic-progress-feedback.md) | VTA UI整理（重複撤去・段階的開示・左パネル折りたたみ）と決定論的処理の進捗可視化基盤ポリシー | `Accepted` | 2026-11-22 | フレーム譲歩ランナー（`runDeterministicUiTask`）による 2 段階進捗表示（100ms 遅延インライン・ステップ付きオーバーレイ）の導入、LLM 設定・出力診断・AI 再調整の集約と重複ボタン撤去、`ControlPanel` 折りたたみとログ既定折りたたみ、および生成時仮判定自動反映による操作直線化を実現 |
| [ADR-0074](./0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md) | Poset逆転マージ防止・Stage 2 $K_{\text{pre}}$ 採点整合・人的死傷/被災当事者保護および2層フライトレコーダー・AI診断v2.0ポリシー | `Accepted` | 2026-11-23 | 非組織子孫への逆転 Poset マージ棄却、Stage 2 `C1` の $K_{\text{pre}}$ 整合、人的死傷・下流損害結果の事後除外保護と `:loss` 被災当事者・兄弟 Merge Guard 保護、事後除外の Stage 2 前倒し、および常時軽量 Tier 1 フライトレコーダー・`runId` 分離・サイレント除外監査・`deep` プロファイルを備えた AI 診断 v2.0 を実現 |
| [ADR-0075](./0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md) | 主体統合エンジンの単一分枝限定ソルバーへの一本化・Stage 2 カード非表示(`suppress`)誘導の廃止および Stage 3 未割当イベント網羅検証ポリシー | `Accepted` | 2026-11-23 | 手続き的 Sub-step B1/B2 を廃止して `solveOptimalSubjectRetention` 単一ソルバーへ統合（兄弟厳格ガード・変動当事者保持と周辺組織 `subject_others` 大域比較）、Stage 2 の 1枚カード `suppress` 誘導廃止による幽霊レーンと余剰反復の根絶、および `chain.repair` 未割当網羅検証・陳腐化 `review_conn_*` 整理・診断 `unassigned_events` 出力を実現 |
| [ADR-0076](./0076-prompt-deduplication-contract-alignment-and-safe-ledger-relation-healing.md) | 全ステージLLMプロンプトの重複解消・契約統一と台帳関係行の安全な決定論的自己治癒ポリシー | `Accepted` | 2026-11-23 | 正規化プロンプトの重複圧縮・`RELATION_CONTRACT_PROMPT` 構造化（直列自動描画原則・同一イベント10列例）・前提背景/外乱自然現象の推定ルール4箇所統一・集合死傷での既出個別主体再利用・Stage 2/3 スコープ同期、および5条件ガード付き同一イベント9列補完・単一同一主体限定 `dependency`→`before` 自己治癒を実現 |
| [ADR-0077](./0077-homogeneous-clone-coalescing-stage2-merge-guards-and-alarm-recipient-assignment.md) | 同職種クローン兄弟の代表集約・Stage 2 明示マージ不変条件ガード・支援警報の提示先割当および法人逆転包含防止ポリシー | `Accepted` | 2026-11-23 | 上限超過時の同親・同職種ベース名・同一関与クローン兄弟の代表主体集約（`entity.name` 不変・異職種保護）、Stage 2 `merge` での厳格非対称・死傷個人・レジリエント主体の法人統合棄却ガード、非独立支援警報イベントの `intended_recipient` 割当と受動態不作為保持、および法人→現場班/個人の逆転包含ガードを実現 |
| [ADR-0078](./0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md) | 決定論的事故語彙判定の撤去とLLM構造化スコープ判定・0件親組織ハブ解禁・対称回復主体ガード是正ポリシー | `Accepted` | 2026-11-24 | 事故・損害語彙の正規表現を全面撤去し `[仮判定]`/`[判定]` の構造化トークン（`variation:resilient`・`outcome:*` 自動昇格・`post_outcome`）による分野非依存判定へ一本化、2子孫以上を持つ0件親組織ハブ解禁・共有回復主体の非対称誤判定修正・高焦点主役保護、`[要確認]` 対象ラベル保持および別組織間 Poset 境界明記を実現 |
| [ADR-0079](./0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md) | 主体上限なしの最細粒度VTA先行完成・LLM統合候補一括提案＋ビーム併用山登り法レーン削減および表示エッジ統合ポリシー | `Accepted` | 2026-11-24 | 主体数制限なしで最細粒度VTA（正規化・仮判定・自動接続・連鎖補完）を先に完成させて `fineGrainedBase` に内部保持し、1回のLLM統合候補・分離制約提案＋ビーム併用山登り法（0トークン・複合近傍対応）で高得点ビューを選択、併せて同一カード対の並列エッジ束ね（`bundledRelationIds`）と異主体同一レーン直列吸収を実現 |
| [ADR-0080](./0080-inclusion-penalty-function-others-eligibility-gate-and-cascade-outcome-scope.md) | 包含統合に対する構造罰金関数・`subject_others` 適格性ハードゲート・凸コスト目的関数および仮判定帰結スコープ精緻化ポリシー | `Accepted` | 2026-11-24 | 実働主役度（5軸スコア・能動/変動数）と主従逆転比に基づく包含構造罰金 $P_{\text{sub}}(X \to B)$ の下限エンベロープ＋1手凸コスト $\phi(c)$・探索/最終共通目的関数、`subject_others` 適格性ゲートと推移的巻き込み防止・直近親優先フォールバック、および途中事象の帰結誤昇格抑止・個別主体優先割当を実現 |
| [ADR-0081](./0081-local-manual-lane-operations-edge-geometry-cache-and-interleaved-spine-absorption.md) | 手動レーン統合・分割の局所 $O(V+E)$ 化・エッジ配線ジオメトリ2段階キャッシュ・および統合レーン割り込み非隣接関係の縦スパイン吸収ポリシー | `Accepted` | 2026-11-24 | 手動統合・強制統合・分割から12万状態大域ソルバーを排して他レーン不変の局所 $O(V+E)$ 演算と自動レイアウト行再整列（`vehicle_crew` 組織化含む）を実装し、ホバー/選択時の再配線を防ぐ2段階ジオメトリキャッシュ・重複レイアウト排除・履歴/Flight Recorder軽量化、および統合レーン非隣接関係の縦スパイン吸収と対称チャネル探索を実現 |
| [ADR-0082](./0082-virtual-role-group-cost-parity-protagonist-asymmetry-guard-and-sole-actor-dependency-healing.md) | 仮想ロールグループの列削減単位コスト等価化・非同質グループ構造罰金・および単独能動行為者 `dependency` の自己治癒ポリシー | `Accepted` | 2026-11-24 | `role_group` 仮想グループの凸負荷を逆関数 $\phi^{-1}$ で削減列数 $r=\max(1,k-1)$ 単位に厳密一致させ、単独指揮・変動連鎖を持つ高焦点主役と被指示作業員の混同を防ぐ非同質グループ罰金 $P_{\text{group}}$・プロンプト規律、ならびに正規化ステップ4明確化（`event-ledger-18`）と単独能動 `:actor` 同一主体 `dependency` の `before` 自己治癒を実現 |
| [ADR-0083](./0083-multi-axis-subject-poset-and-llm-guided-upper-subject-consolidation.md) | 正規化フェーズにおける多軸主体半順序集合（Multi-Axis Subject Poset）構築・LLM主導の上位主体統合選択（`[推奨統合]` / `[予備候補]`）・および多重親端点解決ポリシー | `Accepted` | 2026-11-24 | 全文正規化（`event-ledger-19`）で複数基準（雇用・現場編成・場所/機体・帰結）の多重親 Poset と非包含境界を確定し、統合フェーズで上位主体ハブ一覧の提示と `[推奨統合]` / `[予備候補]` による自然な統合軸選択・0イベント中間ハブの2段階統合・固定罰金簡素化・多重親 `mergedFrom` 優先端点解決および重複 `layout.audit` 解消を実現 |
| [ADR-0084](./0084-poset-antichain-pure-upper-hubs-and-man-machine-composite-subjects.md) | 半順序集合の反鎖（Antichain）完全包摂条件・構成員既出グループの純粋上位ハブ化・および人間-機械複合上位主体ポリシー | `Accepted` | 2026-11-24 | 構成員既出グループの純粋0イベント上位ハブ化と集合記述の個別展開（`event-ledger-20`）、0イベントハブの部分統合による親子並立を防ぐ反鎖完全包摂不変条件（`HG2c`）、`運転士A ≺ 運転士Aが操作する列車X`・`列車X ≺ 運転士Aが操作する列車X` のV字人間-機械複合上位主体（直接包含ガード・自動ハード分離解除・0イベント複合枠推奨統合許容）、および1カード周辺組織適格化を実現 |
| [ADR-0085](./0085-clean-initial-state-and-user-editable-subject-display-names.md) | VTA初期状態のクリア化（組み込みサンプル事例の撤去）と主体表示名のユーザー加筆修正ポリシー | `Accepted` | 2026-11-24 | 組み込みサンプル事例（`【事例1】`・`【IT/Web事例】`）を撤去して起動時を空スキーマ・空シナリオのクリーンな初期状態（`resetProject`・空キャンバス案内付き）へ統一し、スイムレーンヘッダーおよびレーン管理パネルから主体の表示名を加筆修正できる `applyLaneRenameTransition` / `renameLane`（座標・ID不変、Undo/Redo・キャッシュ再最適化連動）を導入 |
| [ADR-0086](./0086-llm-manager-external-catalog-import-and-bulk-model-operations.md) | LLMモデル管理における外部公開カタログ（OpenRouter等）一括取込・トークン隔離および一括削除ポリシー | `Accepted` | 2026-11-24 | 外部公開 `https://` カタログURL検証と共有 `gatewayToken` 非送信の `fetchExternalCatalogModels`、OpenRouterモデルIDへの `openrouter/` プレフィックス正規化、専用一括取込モーダル（`ModelImportModal`、既定 `推奨OFF/クイック切替OFF`）、および陳腐化モデルの選択・一括削除（`removeModelEntriesBulk`・既定モデル自動フェイルオーバー付）を導入 |
| [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md) | 未知のPoset親の保守的発見・主体の重みと距離に基づく連続統合コストモデル・受動被覆ハブ検知および回顧節/範囲時刻の `before` 半順序化ポリシー | `Accepted` | 2026-11-25 | 純粋Poset被覆判定（`computeDirectUncoveredEventIds`）による受動上位ハブの `softIssues` 修復と0直接イベントハブ化、既存半順序を破壊しない未知のPoset親の保守的発見（`discoverConservativeParent`）、5軸スコア $s(u)$・Poset距離 $\delta_{\text{poset}}$・関係重み $W(u,v)$ に基づく連続統合コストモデル、および回顧節・範囲時刻の明示 `before` 半順序化（`event-ledger-22`）を導入 |

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
