# ADR-0074: Poset逆転マージ防止・Stage 2 $K_{\text{pre}}$ 採点整合・人的死傷/被災当事者保護および2層フライトレコーダー・AI診断v2.0ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-23
- **対象コンポーネント**: VTA Engine (`granularityRefinement`, `granularityScore`, `subjectRanking`, `eventPrompts`, `client`, `autoConnectionService`), Diagnostics Infrastructure (`debugRecorder`, `aiDiagnostics`, `DebugRecordingControls`, `DebugLogsSection`)
- **関連ドキュメント・コミット**: [ADR-0007](./0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0009](./0009-structured-ai-diagnostics-and-log-cost-optimization.md), [ADR-0010](./0010-subject-poset-dag-and-canonical-inclusion.md), [ADR-0064](./0064-chain-review-relation-targets-acyclic-parent-hub-merge-and-semantic-pair-upgrade.md), [ADR-0072](./0072-deferred-final-phase-subject-others-consolidation.md), [開発ロードマップ](../ROADMAP.md) (`RM-VTA-01`〜`05`, `RM-LOG-01`〜`05`)

## 1. コンテキストと課題 (Context & Problem Statement)

2026-11-22 の羽田空港C滑走路衝突事故（海上保安庁機・日本航空機）の VTA 診断トレース検証において、パイプライン自体はエラー 0 件（`pipeline_status: "SUCCESS"`）で完走したにもかかわらず、以下の構造的歪みと観測上の死角が確認された。

1. **Poset 包含方向の逆転マージ（`RM-VTA-01`）**: Stage 2 粒度反復において、上位親組織を下位の個人子ノードへ統合する操作（`ORG_JAL -> B_PIC`）が素通りし、同親の別子ノード（`B_CA`）との包含整合性が損なわれていた。
2. **Stage 2 中間上限 $K_{\text{pre}}$ と `C1` 採点基準の不整合（`RM-VTA-02`）**: ADR-0072 により Stage 2 では $K_{\text{pre}}$ まで実名レーンを保持する設計とした一方、`computeMachineMetrics` とレビュープロンプトが最終上限 $K_{\text{post}}$ で `C1` を減点していたため、LLM が不要な `merge` を捻出する誘因が残っていた。
3. **人的死傷事象および被災当事者（`:affected`）のサイレント脱落・吸収（`RM-VTA-03`, `RM-VTA-04`, `RM-VTA-05`）**:
   - 衝突発生後の段落で記述された乗組員死亡確認等の損害結果が `post_outcome_exclusion` によって「事後調査ノード」と一括誤認されて削除されるリスクがあった（また除外タイミングが Stage 2 後だったため、削除対象イベントが Stage 2 スコアに影響していた）。
   - 最終周辺主体集約の Sub-step B1（Poset 葉ロールアップ）において、一次損失帰結（`:loss`）で被災した人間当事者（`:affected`、例: 死亡した `A_COP`・`A_CREW`）や保持兄弟（生存重傷の `A_PIC`）との帰結非対称・ソフト Merge Guard・高焦点直接変動保有が十分に考慮されず、上位組織（`ORG_JCG`）へ無言包摂されていた。
4. **正常完走時における「偽陰性（必要な事象・主体の欠落）」の診断不能性（`RM-LOG-01`〜`05`）**:
   - 従来の AI 診断パッケージ（ADR-0009）は「クラッシュ・検証エラーの特定」に特化しており、`post_outcome_exclusion` や `[整理]` で除外されたイベント一覧、未参照の重大損害段落、各主体の統合フェーズと Merge Guard 根拠が出力されていなかった。
   - また `debugRecorder` が初期値 `enabled: false` の単層バッファであったため、事前にデバッグ記録を ON にしていないと事後に AI 診断を出力できず、複数回実行時の `runId` 混線や UI ログ文字列への正規表現依存も残っていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **包含意味論と被災事実の厳守**: 非組織の下位主体（個人・機器）が上位組織を吸収してはならず、同一組織内でも生死・被災結果や直接変動関与が異なる当事者（例: 生存機長と死亡乗組員）を無言で一括りにしてはならない。
- **既存ハブ統合（ADR-0064）との両立**: 上位管理組織から現場組織ハブへの組織間統合（`organization -> organization`、例: `A_CAB_ORG -> A_TWR_ORG`）は引き続き非循環で許容する。
- **ゼロ事前設定での事後診断性とプライバシー/メモリ安全性**: ユーザーが事前にチェックボックスを ON にし忘れても直近実行の構造化 AI 診断を即座にコピーでき、かつ常時バッファには原文生テキスト・プロンプト全文・認証トークンを残さずメモリ上限（約 350KB）内に収めること。
- **トークン予算の維持**: 標準（`standard`）診断出力は従来どおりコンパクト（数千トークン以内）に保ちつつ、全イベント台帳が必要なケース向けに詳細監査（`deep`）プロファイルを提供する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A（部分対処）**: プロンプトの注意書き追加と `debugRecorder` の既定 `enabled: true`（全通信常時記録）のみで対処する。
  - *却下理由*: プロンプト指示のみでは決定論的 Sub-step B1 の葉ロールアップや `post_outcome_exclusion` の誤削除を防げず、また生プロンプト/応答を常時メモリ保持すると長大報告書で数 MB 以上のメモリ圧迫を招く。
- **選択肢 B（採用：パイプライン構造ガード ＋ 2層フライトレコーダー ＋ AI診断 v2.0）**:
  - Stage 2 / Stage 2.5 / `post_outcome_exclusion` の各境界に決定論的保護ルールを導入し、`debugRecorder` を「常時軽量 Tier 1 ＋ オプトイン詳細 Tier 2」の 2 層構造および `runId` スコープ管理へ刷新、AI 診断 v2.0 にサイレント除外監査と `standard` / `deep` プロファイルを導入する。

## 4. 決定事項 (Decision Outcome)

### 4.1 VTA パイプライン整合性・被災当事者保護（`RM-VTA-01`〜`05`）

1. **非組織子孫への逆転 Poset マージ禁止（`RM-VTA-01`）**:
   - `applyRefinementOps` の `merge` において、`currentPoset.isAncestor(targetId, intoId)` かつ `(intoEntity.kind !== 'organization' || targetEntity.kind === 'person')` の場合（例: `ORG_JAL -> B_PIC`）を `Poset逆方向統合不可` として確定棄却する（組織間の現場ハブ統合 ADR-0064 は維持）。
2. **Stage 2 における $K_{\text{pre}}$ `C1` 評価と $K_{\text{post}}$ カード予算の分離（`RM-VTA-02`）**:
   - `computeMachineMetrics(schema, maxSubjects, { cardBudgetMaxSubjects })` を導入し、Stage 2 中はレーン評価上限 `C1` を `preLimit` ($K_{\text{pre}}$) で採点する一方、`C5` のカード密度予算は最終上限 `maxSubjects` ($K_{\text{post}}$) に固定する。
3. **人的死傷・下流損害結果の事後除外保護と被災人間主体の保持（`RM-VTA-03`）**:
   - `collectPostOutcomeExcludedNodeIds` にて、帰結ノードから意味関係エッジで下流に到達する結果ノード、および人的被害・重大損害語（`死亡`, `重傷`, `負傷`, `大破`, `全損` 等を含み、調査委員会・勧告等の事後行政手続語を含まない事象）を `post_outcome` 除外から保護する。
   - `OUTCOME_EXTRACTION_POLICY` に、衝突・破損とは別イベントとして抽出された死亡・重傷等の重大被害事象も `:loss` として `[帰結]` に列挙する規則を明記する。
   - `consolidatePeripheralSubjectsToOthers` Sub-step B1 にて、`:loss` 帰結イベントで `:affected` となった非機器主体（`kind !== 'machine'`）を無言の親組織包摂から保護する。
4. **Sub-step B1 における完全 Merge Guard（対親・対保持兄弟）と高焦点直接変動アクター保護（`RM-VTA-04`）**:
   - Sub-step B1 の葉ロールアップにおいて、`strictAsymmetry` だけでなく対象親・吸収クラスタ・同一親配下の保持兄弟（例: `A_PIC` に対する `A_COP`）との全 Merge Guard（`!guard.allowed`）および `focus === 'high' | 'reporter'` の直接変動保有主体を停止条件とする。
5. **事後活動除外の Stage 2 前倒し（`RM-VTA-05`）**:
   - `extractEventDraft` において `shouldExcludePostOutcome` 有効時は `refineGranularity` の開始前に `filterPostOutcomeScope` を実行し、不要な事後調査ノードが Stage 2 トークンおよびスコアを歪めるのを防ぐ（Stage 2 後の安全ネットも維持）。

### 4.2 2層デバッグ記録基盤と AI 診断パッケージ v2.0（`RM-LOG-01`〜`05`）

1. **2層メモリ記録（Tier 1 常時軽量フライトレコーダー ＋ Tier 2 オプトイン詳細記録）（`RM-LOG-02`）**:
   - Tier 1（常時稼働、上限 240 件 / 約 350KB）は、原文全文・送信プロンプト本文・LLM 生応答本文を自動ストリップし、リクエストメタデータ・検証結果・型付き遷移・最終投影の構造化分析データのみをメモリ内リングバッファに保持する（永続保存・外部通信なし）。
   - これにより、事前に「デバッグログを記録する」を ON にしていなくても、生成完了後に即座に `📋 AI診断コピー` / `🔍 AI詳細監査コピー` が機能する。
2. **実行単位 `runId` スコープ分離と `standard` / `deep` プロファイル（`RM-LOG-05`）**:
   - `startRun` / `endRun` で各パイプライン実行に一意の `runId` を付与し、UI からの診断コピー時は既定で `scope: 'latest_run'` を抽出して過去実行との混線を防ぐ。
   - `profile: 'deep'` 指定時は `Active Events Ledger`（有効全イベントの時刻・分類・見出し・関与主体・参照段落）を追加出力する。
3. **帰結詳細・サイレント除外監査・未参照危険段落フラグ・主体統合トレース・型付きイベント（`RM-LOG-01`, `RM-LOG-03`, `RM-LOG-04`）**:
   - `outcome_details` と `Silent Exclusions & Unreferenced Paragraph Audit`（`post_outcome_dropped`, `suppressed_cards`, `ledger_dispositions`, および危険語を含む未参照段落 `flagged_with_hazard_terms`）を診断パッケージに追加する。
   - `Subject Poset DAG Hierarchy` に各主体の `kind`, `focus`, `score`, `events`, `consolidation_stage`, `merge_guard` を出力する。
   - 型付きイベント（`granularity.iteration`, `scope.post_outcome_excluded`）と `autoConnectVTA` 末尾の単一マイルストーン投影記録を導入し、中間 Sub-step B0/B1/B2 の重複投影ログを排除する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 組織から個人への逆転マージが根絶され、重大事故における死亡乗組員・重傷当事者・別イベント化された人的被害が事後除外や組織ロールアップで消失しなくなる。
  - 事前設定なしでいつでも事後に構造化 AI 診断（標準／詳細監査）を取得でき、「エラー 0 件だが重要事象・主体が図から消えている」ケースでも `Silent Exclusions`・`flagged_with_hazard_terms`・`consolidation_stage` から一目で原因箇所を特定できる。
- **トレードオフ・考慮事項**:
  - Tier 1 フライトレコーダーがブラウザタブのメモリを最大約 350KB 使用するが、リロードで消去され生プロンプトを含まないため実用上の負荷は無視できる。
  - 被災した人間主体（`:affected` on `:loss`）を保護するため、多数の個人死傷者が個別に `[主体]` 登録された事例ではレーン数が増える場合があるが、事故事実の正確性と生死非対称の明示を優先する。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`, `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/services/generation/granularityScore.ts`, `src/tools/vta/services/generation/granularityRefinement.ts`, `src/tools/vta/services/generation/autoConnectionService.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/services/debugRecorder.ts`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`, `src/tools/vta/components/control-panel/DebugLogsSection.tsx`, `src/tools/vta/components/control-panel/DebugRecordingControls.tsx`, `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/services/generation/granularityScore.test.ts`, `src/tools/vta/services/generation/granularityRefinement.test.ts`, `src/tools/vta/features/vta/utils/subjectRanking.test.ts`, `tests/vta/aiDiagnostics.test.ts`
