# FailurePrism 開発ロードマップ (Development Roadmap)

| 項目 | 内容 |
| :--- | :--- |
| 最終更新日 | 2026-11-23 |
| 対象 | FailurePrism (VTA-Editor / TPDD-Editor / Diagnostics Infrastructure) |
| 関連文書 | [ADR 一覧](./adr/README.md)、[VTA-Editor 要件定義書](./vta/REQUIREMENTS.md)、[共通要件](./REQUIREMENTS.md) |

本書は、実事例の診断トレースや運用フィードバックから特定された未実装の改善課題・修正計画を優先度順に管理するロードマップである。各項目が実装・検証された際は、必要に応じて [ADR](./adr/README.md) へ設計決定を記録し、本書のステータスを更新する。

---

## 1. Phase 1: VTA パイプライン整合性・帰結および被災当事者保護の是正

2026-11-22 羽田空港C滑走路衝突事故トレース診断にて特定された、主体統合・目的関数採点・事後活動除外に関する構造的課題の修正計画。

| ID | 優先度 | ステータス | 課題・修正内容 | 主な対象ファイル |
| :--- | :---: | :---: | :--- | :--- |
| **RM-VTA-01** | **P1** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **Poset 包含方向の逆転マージ防止**<br>`applyRefinementOps` の `merge` 操作において、`currentPoset.isAncestor(targetId, intoId)` が真となる逆方向統合（上位親組織を下位の個人子ノードへ統合する操作、例: `ORG_JAL -> B_PIC`）で `explicitMerges` 登録が素通りする不具合を修正し、Poset 正準包含原則違反として棄却・警告記録する。 | `src/tools/vta/services/generation/granularityRefinement.ts` |
| **RM-VTA-02** | **P1** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **Stage 2 粒度反復における `C1` 採点基準とプロンプト上限の $K_{\text{pre}}$ 整合**<br>中間フェーズでは $K_{\text{pre}}$ 列まで実名保持する設計（ADR-0072）であるにもかかわらず、`computeMachineMetrics` とレビュープロンプトが最終上限 $K_{\text{post}}$ で `C1` を減点していた不整合を是正する。`cardBudgetMaxSubjects`（$K_{\text{post}}$ 基準の `C5` カード予算）とレーン評価上限（Stage 2 中は $K_{\text{pre}}$）を分離し、不要なレーン超過警告による不自然な `merge` 誘導を防ぐ。 | `src/tools/vta/services/generation/granularityScore.ts`<br>`src/tools/vta/services/generation/granularityRefinement.ts` |
| **RM-VTA-03** | **P1** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **人的死傷・下流損害結果の事後除外誤認防止と被災主体（`:affected`）の保護**<br>1. `collectPostOutcomeExcludedNodeIds` にて、帰結ノードから意味関係エッジで下流に派生する損害結果ノード、および人的被害・重大損害（死亡・重傷・負傷・損壊等を含み、調査委員会・処分・提言等の事後手続語でない事象）を `isResilientNode` と同様に `post_outcome` 除外から無条件保護する。<br>2. `OUTCOME_EXTRACTION_POLICY` にて、物理的衝突・破損とは別イベントとして人的死傷（死亡・重傷等）が抽出された場合は双方を `:loss` として `[帰結]` に列挙するよう明記する。<br>3. `subjectRanking.ts` の帰結関与保護を `role === 'actor'` 限定から拡張し、帰結イベントで `:affected` となった人間主体（`person`）および同一組織内で生死・被害が非対称な当事者を無条件の組織吸収から保護する。 | `src/tools/vta/services/generation/granularityScore.ts`<br>`src/tools/vta/services/llm/eventPrompts.ts`<br>`src/tools/vta/features/vta/utils/subjectRanking.ts` |
| **RM-VTA-04** | **P2** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **最終フェーズ Sub-step B1 におけるソフト Merge Guard 厳守と中核変動アクター保護**<br>`consolidatePeripheralSubjectsToOthers` の Sub-step B1（Poset 葉ロールアップ）において、`strictAsymmetry` だけでなく対象親および保持兄弟（例: `A_PIC` と `A_COP`）間のソフト Merge Guard（`!guard.allowed`）や `focus === 'high'` の直接変動保有アクターを停止条件とし、コックピット・現場の中核当事者が上位組織へ無言吸収されるのを防ぐ。 | `src/tools/vta/features/vta/utils/subjectRanking.ts` |
| **RM-VTA-05** | **P3** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **事後活動除外（`filterPostOutcomeScope`）の Stage 2 前倒し実行**<br>`shouldExcludePostOutcome` 有効時、事後調査ノードの除外を `refineGranularity` 完了後ではなく Stage 2 開始前に適用し、最終的に破棄される事後調査イベントが Stage 2 のプロンプトトークンや `C3`・`C5` スコアを歪める無駄を解消する。 | `src/tools/vta/services/llm/client.ts` |

---

## 2. Phase 2: VTA 診断ログ・デバッグ記録基盤の改善 (Diagnostics & Observability v2.0)

エラー0件で完走したケース（`pipeline_status: "SUCCESS"`）における「必要な事象・主体のサイレント脱落（偽陰性）」を診断パッケージ単体で即座に特定できるようにするための、記録項目および記録アーキテクチャの刷新計画。

| ID | 優先度 | ステータス | 課題・修正内容 | 主な対象ファイル |
| :--- | :---: | :---: | :--- | :--- |
| **RM-LOG-01** | **P1** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **帰結詳細および「サイレント除外・未参照段落」監査サマリの診断パッケージ出力**<br>1. `Execution Meta` の `outcome` にイベントIDだけでなく `時刻・見出し・関与主体と役割(actor/affected)・参照段落` を出力する。<br>2. 新セクション `Excluded & Unreferenced Audit Summary` を追加し、① `post_outcome_exclusion` で除外された全イベントの `ID・時刻・見出し・主体・除外理由`、② `suppressedCards` の一覧、③ `[整理] excluded / review` 行の要約、④ どのイベントからも参照されなかった本文段落番号と要注意語（`死亡`, `重傷`, `負傷`, `破損`, `警報` 等）を含む未参照段落の警告フラグを出力する。 | `src/tools/vta/services/diagnostics/aiDiagnostics.ts` |
| **RM-LOG-02** | **P1** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **2層メモリ記録方式の導入（常時軽量フライトレコーダー ＋ オプトイン生通信記録）**<br>現行の `debugRecorder`（初期値 `enabled: false`）では事前に記録ONにしていないと異常発見後に AI 診断を出力できない問題を解消する。<br>- **Tier 1（常時ON・メモリ内リングバッファ、上限 ~350KB）**: 原文全文やプロンプト全文を含まない構造化イベント・帰結/除外台帳・主体統合理由・スコア推移・通信統計のみを直近実行分につき自動保持（外部送信・永続保存なし）。<br>- **Tier 2（オプトイン詳細記録）**: 従来どおりユーザー明示ON時にプロンプト全文・生LLM応答・中間完全スナップショットを記録する。 | `src/tools/vta/services/debugRecorder.ts`<br>`src/tools/vta/components/control-panel/DebugLogsSection.tsx`<br>`src/tools/vta/components/control-panel/DebugRecordingControls.tsx` |
| **RM-LOG-03** | **P2** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **主体統合・除外の意思決定根拠トレース（Subject Consolidation Decision Trace）**<br>Section 4（`Subject Poset DAG Hierarchy`）の各主体に、`kind`・`focus`・ランキングスコア・関与イベント内訳（総数・変動数・帰結ロール `actor`/`affected`）・統合が確定したフェーズ（`stage2_bnb` / `stage2_llm_merge` / `stage2.5_b0_prune` / `stage2.5_b1_poset` / `stage2.5_b2_others`）・`evaluateMergeGuard` の判定結果を付与する。 | `src/tools/vta/features/vta/utils/subjectRanking.ts`<br>`src/tools/vta/services/diagnostics/aiDiagnostics.ts` |
| **RM-LOG-04** | **P2** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **型付き構造化診断イベントへの移行と明示的マイルストーン投影記録**<br>1. UI表示用ログ文字列（`msg.includes('粒度反復')` 等）の正規表現逆パースを廃止し、型付きイベント（`granularity.iteration`, `scope.post_outcome_excluded` 等）を直接記録する。<br>2. `projectAnalysis` 内部での暗黙的な `graph.projection` 記録を見直し、確定マイルストーンでの明示記録（または内部ループの既定サイレント化）へ統一することで、`silentDebug` 指定漏れによる重複投影ノイズを構造的に根絶する。 | `src/tools/vta/services/debugRecorder.ts`<br>`src/tools/vta/features/vta/utils/eventAnalysis.ts`<br>`src/tools/vta/services/diagnostics/aiDiagnostics.ts` |
| **RM-LOG-05** | **P3** | `Completed` ([ADR-0074](./adr/0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md)) | **実行単位（`runId`）スコープ分離と診断出力プロファイル切り替え**<br>1. パイプライン実行（自動生成・再最適化・自動接続・変動判定）ごとに `runId` を付与し、複数回操作後に過去実行の遷移や通信回数が混線しないよう直近 `runId` 単位で診断抽出できるようにする。<br>2. 診断コピー時に `Standard（約3〜5kトークン：構造・異常・除外要約）` と `Deep Audit（約6〜10kトークン：採用全イベント見出し・ステージ間差分付き）` を選択可能にする。 | `src/tools/vta/services/debugRecorder.ts`<br>`src/tools/vta/services/diagnostics/aiDiagnostics.ts`<br>`src/tools/vta/components/control-panel/DebugRecordingControls.tsx` |

---

## 3. Phase 3: パイプライン責務重複の解消とアーキテクチャ単純化

2026-11-23 東武日光線新鹿沼駅構内事故の AI 診断 v2.0 トレース検証および自己レビューに基づき、複数ステージ間に分散していた主体統合・カード抑制・未割当補完の責務を一本化する構造単純化計画。

| ID | 優先度 | ステータス | 課題・修正内容 | 主な対象ファイル |
| :--- | :---: | :---: | :--- | :--- |
| **RM-ARCH-01** | **P1** | `Completed` ([ADR-0075](./adr/0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md)) | **主体統合エンジンの `solveOptimalSubjectRetention` 単一ソルバー化**<br>手続き的 Sub-step B1/B2 ループを撤去し、中間フェーズ（`allowOthers: false`）と最終フェーズ（`allowOthers: true`）を単一の分枝限定ペナルティ最適化器へ統合。保持兄弟間の `strictAsymmetry`（ADR-0008）・変動保有当事者保護・周辺組織 `subject_others` 集約を同一目的関数で大域比較する。 | `src/tools/vta/features/vta/utils/subjectRanking.ts` |
| **RM-ARCH-02** | **P1** | `Completed` ([ADR-0075](./adr/0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md)) | **Stage 2 における 1枚カード `suppress` 誘導の廃止**<br>1枚カードしか持たない周辺主体の整理を最終フェーズの主体集約へ一本化し、Stage 2 粒度反復からの新規 `suppressedCards` 生成を廃止して幽霊レーン（`entities` と `visibleSchema.lanes` の乖離）と余剰 LLM 反復を解消する。 | `src/tools/vta/services/generation/granularityRefinement.ts` |
| **RM-ARCH-03** | **P1** | `Completed` ([ADR-0075](./adr/0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md)) | **Stage 3 `chain.repair` 未割当網羅検証への一元化と診断 `unassigned_events` 出力**<br>`diag.unassigned` の各イベントに対し `[割当追加]` または `[要確認]` を必須とする完了条件を既存の `chain.repair` 修復ループへ統合し、解決後の陳腐化した `review_conn_*` 除去および AI 診断 `unassigned_events` 出力・表題段落除外を追加する。 | `src/tools/vta/services/generation/chainRepairService.ts`<br>`src/tools/vta/services/generation/autoConnectionService.ts`<br>`src/tools/vta/services/diagnostics/aiDiagnostics.ts` |

---

## 4. Phase 4: 全ステージLLMプロンプトの契約統一と台帳関係行の安全な自己治癒

2026-11-23 羽田空港C滑走路衝突事故 v2.0 再検証トレース診断およびプロンプト横断監査・自己レビューに基づく、プロンプト構造整理と安全な決定論的補正計画。

| ID | 優先度 | ステータス | 課題・修正内容 | 主な対象ファイル |
| :--- | :---: | :---: | :--- | :--- |
| **RM-PROMPT-01** | **P1** | `Completed` ([ADR-0076](./adr/0076-prompt-deduplication-contract-alignment-and-safe-ledger-relation-healing.md)) | **関係属性契約の構造化・Few-shot 拡充と厳格ガード付き台帳自己治癒**<br>1. `normalization` 本文の重複散文を圧縮し、`RELATION_CONTRACT_PROMPT` に同一レーン直列自動描画原則と同一イベント `transfer` 10列正例を追加。<br>2. `eventLedger.ts` に5条件厳格ガード付きの同一イベント9列先イベントID補完と、両端とも単一同一主体のみ関与する `dependency` の `before` 自動降格（共有イベント保護付）を追加し、Stage 1 の余分な修復通信を削減する。 | `src/tools/vta/features/vta/utils/relationContract.ts`<br>`src/tools/vta/features/vta/utils/eventLedger.ts` |
| **RM-PROMPT-02** | **P2** | `Completed` ([ADR-0076](./adr/0076-prompt-deduplication-contract-alignment-and-safe-ledger-relation-healing.md)) | **前提背景と外乱自然現象の主体推定ルールの全ステージ統一**<br>業務開始前の行為主体を伴わない前提災害・背景は `[整理] background` とする基準を明記し、外乱 `[イベント]` の自然現象に対する直後段落の被災・対応主体への `affected:inferred` 割当を全ポリシーおよび `chain.repair` で統一許可する。 | `src/tools/vta/services/llm/factualityPolicy.ts`<br>`src/tools/vta/services/llm/contextEvidencePolicy.ts`<br>`src/tools/vta/services/llm/eventPrompts.ts`<br>`src/tools/vta/services/generation/chainRepairService.ts` |
| **RM-PROMPT-03** | **P2** | `Completed` ([ADR-0076](./adr/0076-prompt-deduplication-contract-alignment-and-safe-ledger-relation-healing.md)) | **集合的死傷記述での既出個別主体再利用と Stage 2/3 スコープ同期**<br>集合的な死傷・被災記述において既出の個別主体IDへ `:affected` を優先付与して重複集合主体の新設を抑止し、Stage 2 `merge`/シナリオ基準の ADR-0074 同期、`autoConnectVTA` 時の未割当 `review` 出力抑止、および `public/prompts.json` 同期を行う。 | `src/tools/vta/services/llm/eventPrompts.ts`<br>`src/tools/vta/services/generation/granularityRefinement.ts`<br>`src/tools/vta/services/llm/client.ts`<br>`src/tools/vta/services/generation/autoConnectionService.ts`<br>`public/prompts.json` |

---

## 5. Phase 5: クローン兄弟集約・Stage 2 統合ガード強制・支援警報割当および逆転包含防止

2026-11-23 羽田空港C滑走路衝突事故・東武日光線新鹿沼駅構内事故の ADR-0076 適用後 v2.0 トレース診断および自己レビューに基づく改善計画。

| ID | 優先度 | ステータス | 課題・修正内容 | 主な対象ファイル |
| :--- | :---: | :---: | :--- | :--- |
| **RM-VTA2-01** | **P1** | `Completed` ([ADR-0077](./adr/0077-homogeneous-clone-coalescing-stage2-merge-guards-and-alarm-recipient-assignment.md)) | **同職種・完全同一関与クローン兄弟の代表集約とグループ抽出指針**<br>`entity.name` を不変に保ったまま、上限超過時に同親・同職種ベース名・同一 `(eventId, role)` 関与・同一関係シグネチャを持つ 2 人目以降の `person` 葉を代表主体へ `mergeTargetById` で束ね（異職種は保護）、中核変動当事者（`D中継見張員` 等）の押し出しを防ぐ。併せて Stage 1 で完全同行動メンバーの単一グループ抽出を明記する。 | `src/tools/vta/features/vta/utils/subjectRanking.ts`<br>`src/tools/vta/services/llm/eventPrompts.ts` |
| **RM-VTA2-02** | **P1** | `Completed` ([ADR-0077](./adr/0077-homogeneous-clone-coalescing-stage2-merge-guards-and-alarm-recipient-assignment.md)) | **Stage 2 明示 `merge` における厳格非対称・死傷個人・レジリエント主体保護ガード**<br>`applyRefinementOps`（`merge`）にて、`strictAsymmetry` 違反、`:loss` `:affected` 個人の組織統合、およびレジリエンス変動個人の `:loss` 法人統合（例: `B_CA_L4 -> ORG_JAL`）を決定論的に棄却する。 | `src/tools/vta/services/generation/granularityRefinement.ts` |
| **RM-VTA2-03** | **P2** | `Completed` ([ADR-0077](./adr/0077-homogeneous-clone-coalescing-stage2-merge-guards-and-alarm-recipient-assignment.md)) | **支援機能・警報表示イベントの `intended_recipient` 割当統一と受動態不作為の保持**<br>独立 `machine` 主体としない支援機能・警報表示イベント（`RIMCAS` 等）について、認識有無を推測せず監視先組織・担当者へ `intended_recipient`（または `intended_recipient:inferred`）を割り当てる規則を Stage 1・Stage 3 で統一し、受動態で記述された未実施も `[イベント]` として保持させる。 | `src/tools/vta/services/llm/eventPrompts.ts`<br>`src/tools/vta/services/llm/factualityPolicy.ts`<br>`src/tools/vta/services/llm/contextEvidencePolicy.ts`<br>`src/tools/vta/services/generation/chainRepairService.ts`<br>`public/prompts.json` |
| **RM-VTA2-04** | **P2** | `Completed` ([ADR-0077](./adr/0077-homogeneous-clone-coalescing-stage2-merge-guards-and-alarm-recipient-assignment.md)) | **別法人間の非包含明記および法人→現場班/個人の逆転包含ガード**<br>発注・受注や元請・下請等の別法人を包含関係で結ばない方針を明記し、`eventLedger.ts` で法人・官公庁が現場班または個人を親指定した逆転リンクを警告付きで無視する（`グループ` 等の正当な上位組織は保護）。 | `src/tools/vta/features/vta/utils/eventLedger.ts`<br>`src/tools/vta/services/llm/eventPrompts.ts` |

---

## 6. Phase 6: 決定論的語彙判定の撤去（LLM構造化スコープ判定への統一）と0件親組織ハブ・回復主体ガード是正

2026-11-24 ADR-0077 適用後 v2.0 トレース（羽田 `bv3r`・東武 `gq53`）の診断、ドメイン一般性に関する方針見直し、および自己レビューに基づく改善計画。

| ID | 優先度 | ステータス | 課題・修正内容 | 主な対象ファイル |
| :--- | :---: | :---: | :--- | :--- |
| **RM-VTA3-01** | **P1** | `Completed` ([ADR-0078](./adr/0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md)) | **決定論的事故語彙正規表現の全面撤去と `[仮判定]`/`[判定]` 構造化トークンへの統一**<br>`CASUALTY_OR_SEVERE_DAMAGE_PATTERN` / `POST_INCIDENT_ADMIN_PATTERN` を完全削除し、追加 LLM 通信 0 回のまま `[仮判定]` で `variation:resilient`・`outcome:loss\|recovery\|near_miss`（関与主体ありの場合 `analysis.outcome` へ自動昇格）・`post_outcome`（根拠必須）を受理して IT・製造・業務・安全の全分野で一貫したスコープ・極性判定を実現する。 | `src/tools/vta/types/vta.ts`<br>`src/tools/vta/features/vta/utils/eventLedger.ts`<br>`src/tools/vta/features/vta/utils/eventAnalysis.ts`<br>`src/tools/vta/services/llm/client.ts`<br>`src/tools/vta/services/generation/granularityScore.ts` |
| **RM-VTA3-02** | **P1** | `Completed` ([ADR-0078](./adr/0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md)) | **2子孫以上を持つ 0 件親組織ハブの解禁・共有回復主体の非対称誤判定修正・主役アクター保護**<br>1. `evaluateMergeGuard` Step 2 を `srcPureAdv && tgtRes` に厳密化し、回復帰結を共有する対称主体同士の `strictAsymmetry` 誤判定を解消する。<br>2. 上限超過時、2 件以上の関与子孫を持つ 0 件親組織（`A_JAL` 等）を Stage 2・3.5 ソルバーの候補ハブ（2子孫以上統合時のみ保持、非保持時は `excluded`）として解禁する。<br>3. `focus: 'high'` 変動アクター（`A_TWR_E` 等）の `subroleLoss` 引き上げおよび `:loss` `:affected` 個人のソフトガードを追加する。 | `src/tools/vta/features/vta/utils/subjectRanking.ts`<br>`src/tools/vta/services/generation/granularityRefinement.ts` |
| **RM-VTA3-03** | **P2** | `Completed` ([ADR-0078](./adr/0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md)) | **`chain.repair` `[要確認]` 項目の対象ID・見出し保持と太字括弧見出しの診断除外**<br>`applyChainDelta` で `[要確認]` の対象イベント/主体 ID と見出しを `対象: E11（...）` として保存し、`aiDiagnostics.ts` で単独の太字括弧見出し行を未参照段落監査からスキップする。 | `src/tools/vta/features/vta/utils/chainRepair.ts`<br>`src/tools/vta/services/generation/autoConnectionService.ts`<br>`src/tools/vta/services/diagnostics/aiDiagnostics.ts` |
| **RM-VTA3-04** | **P2** | `Completed` ([ADR-0078](./adr/0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md)) | **委託・請負チームの発注元別組織への誤所属防止（分野横断プロンプト同期）**<br>契約・委託関係にある別組織間で受託・請負側のチームや担当者を委託・発注元組織へ所属させない原則を全分野共通表現で明記し、`public/prompts.json` と同期する。 | `src/tools/vta/services/llm/eventPrompts.ts`<br>`public/prompts.json` |

---

## 7. Phase 7: 最細粒度VTA先行完成・LLM統合候補一括提案＋山登り法レーン削減および表示エッジ統合

2026-11-24 詳細監査トレース（`yp2l`）診断およびパイプライン構造刷新（ADR-0079）に基づく実装項目。

| ID | 優先度 | ステータス | 課題・修正内容 | 主な対象ファイル |
| :--- | :---: | :---: | :--- | :--- |
| **RM-VTA4-01** | **P1** | `Completed` ([ADR-0079](./adr/0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md)) | **主体上限なしの最細粒度VTA先行完成と `fineGrainedBase` 内部保持**<br>早期 Stage 2 統合を廃止して最細粒度のままレーン間接続・連鎖補完を完了させ、`analysis.fineGrainedBase` として無損失保持・JSON永続化・手動編集同期（`reconcileAnalysis`）を行う。 | `src/tools/vta/types/vta.ts`<br>`src/tools/vta/features/vta/utils/eventAnalysis.ts`<br>`src/tools/vta/services/llm/client.ts`<br>`src/tools/vta/services/generation/autoConnectionService.ts` |
| **RM-VTA4-02** | **P1** | `Completed` ([ADR-0079](./adr/0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md)) | **LLM統合候補一括提案（1通信）＋ビーム併用山登り法オプティマイザ**<br>完成した最細粒度VTAから単体・バンドル・役割グループ・その他集約候補と分離維持ペアを1回のLLM通信で取得し、複合近傍付きビーム併用山登り法で多目的スコア最大の統合ビューを選択する（キャッシュ再探索時は0通信）。 | `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`<br>`src/tools/vta/components/control-panel/ScenarioInputSection.tsx`<br>`src/tools/vta/features/vta/store/vtaStore.ts` |
| **RM-VTA4-03** | **P1** | `Completed` ([ADR-0079](./adr/0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md)) | **レーン統合時の並列エッジ表示統合（`bundledRelationIds`）と同一レーン直列吸収**<br>統合後に同一表示カード対へ集約された複数関係を1本のエッジへ束ね、同一通常レーンへ畳み込まれた異主体間実施済み関係を直列線へ吸収して重複線・`MISSING_RELATION_PROJECTION`・ブレイク競合を根絶する。 | `src/tools/vta/features/vta/utils/eventAnalysis.ts`<br>`src/tools/vta/features/vta/utils/sharedEvents.ts`<br>`src/tools/vta/features/vta/utils/graphDiagnostics.ts` |
| **RM-VTA4-04** | **P2** | `Completed` ([ADR-0079](./adr/0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md)) | **正規化段階の呼称統一・終局 `:recovery` 境界明確化および診断遷移出力**<br>正規化プロンプトでの呼称揺れ統一と途中経過の適応行動（`variation:resilient`）対終局 `:recovery` の区別を明記し、`aiDiagnostics.ts` に `lane.consolidation` 遷移と長文見出し行除外を追加する。 | `src/tools/vta/services/llm/eventPrompts.ts`<br>`public/prompts.json`<br>`src/tools/vta/services/diagnostics/aiDiagnostics.ts` |
