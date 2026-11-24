# ADR-0077: 同職種クローン兄弟の代表集約・Stage 2 明示マージ不変条件ガード・支援警報の提示先割当および法人逆転包含防止ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-23
- **対象コンポーネント**: VTA Engine (`subjectRanking.ts`, `granularityRefinement.ts`, `eventLedger.ts`), LLM Prompts (`eventPrompts.ts`, `factualityPolicy.ts`, `contextEvidencePolicy.ts`, `chainRepairService.ts`, `public/prompts.json`)
- **関連ドキュメント・コミット**: [ADR-0008](./0008-subject-consolidation-outcome-asymmetry-policy.md), [ADR-0074](./0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md), [ADR-0075](./0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md), [ADR-0076](./0076-prompt-deduplication-contract-alignment-and-safe-ledger-relation-healing.md), [ROADMAP.md](../ROADMAP.md) (`RM-VTA2-01`..`04`)

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0076 適用後の実事例 2 件（羽田空港C滑走路衝突事故 `extract_full_1795438034117_obdo` および東武日光線新鹿沼駅構内触車事故 `extract_full_1795438872923_huyv`）の v2.0 診断トレース検証と自己レビューにより、以下の 4 つの構造的課題が特定された。

1. **同一行動・同一被災のクローン兄弟による保持枠占有と中核当事者押し出し**:
   東武日光線トレースでは、原文全体を通じて個別行動・個別被災差が一切ない 3 名が `A8（H作業員）`・`A9（I作業員）`・`A10（J作業員）` として個別抽出された。ADR-0074 の死傷 `:affected` 保護が 3 名それぞれに独立適用された結果、$K_{\text{pre}} = 10$ のうち 3 枠を同一イベント列のクローンが占有し、変動要因を持つ `A4（D中継見張員）` が `A_TEAM` へ押し出された。
2. **Stage 2 明示 `merge` 操作におけるソルバー保護ガードのバイパス**:
   `subjectRanking.ts` の分枝限定ソルバーは厳格非対称（ADR-0008）・死傷個人・レジリエント主体を保護しているが、`granularityRefinement.ts` の `applyRefinementOps`（`op === 'merge'`）は `explicitMerges` に無検証で登録していた。そのため羽田トレースで `B_CA_L4（L4ドア独断開放のレジリエンス発揮CA） -> ORG_JAL（:loss 法人）` の統合が通過し、現場個人のレジリエンス行動が法人レーンへ埋没した。
3. **独立 `machine` 主体としない支援機能・警報表示イベントの未割当 Catch-22 と受動態不作為の脱落**:
   羽田トレースの `E33（滑走路占有監視注意喚起発動 / RIMCAS, p65）` は、`SUBJECT_LANE_POLICY` の「支援機能・警報画面は独立 `machine` 主体にしない」原則と、次段落 `p66` の「管制官は注意喚起を認識していなかった」記述が組み合わさることで、`machine` も `actor` も `confirmed_recipient` も付けられず `unassigned`（`review_conn_1`）に陥っていた。また東武トレースの `p56（中継見張員の配置が確認されていなかった）` が受動態記述のため `[整理] review` に落とされていた。
4. **契約関係にある別法人の誤包含および「法人 → 現場作業班/個人」の逆転包含**:
   東武トレースで `A_SUB（下請会社）` の上位主体に `A_TEAM（除草作業班）` が逆転指定され、Poset 上で法人が現場作業班の子ノードとなっていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **データ構造の不変性と可逆性の維持**: 主体の `entity.name` を動的に文字列連結・改変すると、`split` 操作・`reconcileAnalysis` レーン名照合・ドリルダウン表示（`${parent.name}（${childName}）`）が破綻するため、`entity.name` は不変のまま既存の `mergeTargetById` と `mergedFrom` に統一する必要がある。
- **異職種兄弟の誤統合防止**: 同じ親組織・同じ被災イベントを持つ兄弟であっても、`機上整備員A` と `機上通信員A` のような異なる職種・役割は独立維持しなければならない。
- **事実性（Factuality）の厳守**: 認識されなかった警報（`E33`）に `confirmed_recipient` や `actor` を付与することは事実捏造となるため、提示・宛先のみを表し `entity_role: 'object'` として描画される既存の `intended_recipient` ロールを活用する。
- **ホールディングス等の正当な上位組織名の保護**: 逆転包含ガードで `グループ`・`部`・`チーム` を一律禁止すると `東武鉄道株式会社 -> 東武グループ` 等の正当な企業グループ階層を誤って破棄するため、現場班・クルー接尾辞に限定する必要がある。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A**: クローン兄弟統合時に代表主体の `name` を `"H作業員・I作業員・J作業員"` へ書き換え、警報イベントには `machine` レーン新設を許可する。
  - *不採用理由*: `entity.name` 書き換えは `split`・ドリルダウン・推移閉包（代表主体がさらに親組織へ統合されるケース）と不整合を起こし、単発警報ごとの `machine` レーン乱立は `SUBJECT_LANE_POLICY` に反して主要人間レーンを圧迫する。
- **選択肢 B（採用）**:
  1. `entity.name` 不変のまま、上限超過時に同親・同職種ベース名・完全同一 `(eventId, role)` 関与・完全同一関係シグネチャを持つ 2 人目以降の `person` 葉を代表主体へ `mergeTargetById` で束ね（推移閉包対応）、Stage 1 プロンプトでも完全同行動メンバーの単一グループ抽出を明示する。
  2. `applyRefinementOps`（`merge`）に `strictAsymmetry`・`:loss` `:affected` 個人→組織・レジリエント個人→`:loss` 組織の棄却ガードを導入する（`person -> person` の対称統合は維持）。
  3. 独立 `machine` としない支援機能・警報表示イベントは監視先組織・担当者への `intended_recipient`（または `intended_recipient:inferred`）割当に統一し、受動態の明記された不作為も `[イベント]` として保持する。
  4. `eventLedger.ts` で法人・官公庁が現場班（`作業班|班|クルー|乗務員|乗組員|搭乗員`）または `person` を親指定する逆転包含のみを警告付きで無視する。

## 4. 決定事項 (Decision Outcome)

### 4.1 同職種・完全同一関与クローン兄弟の代表主体集約 (`subjectRanking.ts`, `eventPrompts.ts`)
- `rankSubjects` にて `baseEntities.length > limit` の際、`person`（非 `reporter`・非強制保持・子ノードなし・同一の非空 Poset 親集合）のうち、前後識別子（`H/I/J`, `1/2/3` 等）を除いた職種ベース名（`extractRoleBaseName`）・全 `(eventId, role)` 関与・全関係シグネチャが完全一致し `evaluateMergeGuard` を満たす 2 人目以降を、1 人目の代表主体へ `mergeTargetById` で束ねる（代表主体が除外された場合は同様に除外し、代表主体が親組織へ統合された場合は推移閉包で親組織へ解決する）。
- `SUBJECT_FOCUS_POLICY` に `【重要：同一役割・同一行動の複数メンバーのグループ抽出】` を追加し、個別差のない複数メンバーは最初から単一グループ主体として抽出する指針を明記する。

### 4.2 Stage 2 明示 `merge` の不変条件ガード (`granularityRefinement.ts`)
- `applyRefinementOps` の `op.op === 'merge'` にて、以下のいずれかに該当する統合を棄却しトレース警告を記録する：
  1. 統合先クラスタとの間で `evaluateMergeGuard(...).strictAsymmetry === true` となる場合。
  2. `:loss` 帰結イベントに `:affected` で関与する `person` を `organization` へ統合する場合。
  3. レジリエンス変動（`polarity === 'resilient'` または `isResilientReasonText`）を持つ `person` を、`:loss` 帰結を持つ `organization` へ統合する場合（`B_CA_LEAD -> B_CA_OTH` のような対称な `person -> person` 統合は引き続き許可）。

### 4.3 支援機能・警報表示イベントの `intended_recipient` 割当と受動態不作為の保持 (`eventPrompts.ts`, `factualityPolicy.ts`, `contextEvidencePolicy.ts`, `chainRepairService.ts`)
- 独立 `machine` 主体としない支援機能・警報画面・監視表示の作動・表示イベントは、認識有無や能動操作を推測せず、同一段落または前後段落で示された設置・監視先の組織・担当者へ `intended_recipient`（または `intended_recipient:inferred`、前後段落も参照併記）を割り当てる契約を Stage 1（`SUBJECT_LANE_POLICY`, `FACTUALITY_POLICY`, `CONTEXT_EVIDENCE_POLICY`, `SUBJECT_INFERENCE_POLICY`）および Stage 3（`chainRepairService.ts`）に統一導入する。
- `FACTUALITY_POLICY` 規則 4 に、受動態（「〜が確認されていなかった」等）で明記された未実施・不在も `[整理] review` へ落とさず `[イベント]` として抽出する旨を明記する。

### 4.4 別法人の非包含および法人逆転包含ガード (`eventLedger.ts`, `eventPrompts.ts`)
- `SUBJECT_FOCUS_POLICY` に、発注元・受注先や元請・下請等の別法人同士を包含関係で結ばない原則および法人の親に現場作業班・個人を指定しない原則を明記する。
- `inspectLedger` の親解決処理にて、法人・官公庁接尾辞（`/(?:株式会社|有限会社|合同会社|会社|法人|業者|省|庁)$/u`）を持つ `organization` が `person` または現場班接尾辞（`/(?:作業班|班|クルー|乗務員|乗組員|搭乗員)$/u`、`グループ`・`部`・`チーム` は対象外）を上位主体に指定した場合、警告を出力して当該逆転親リンクを無視する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 同職種・完全同行動の被災者クローンが上限枠を食い潰さなくなり、`D中継見張員` のような重要変動アクターが保持される一方、`機上整備員A` と `機上通信員A` のような異職種当事者は確実に独立保護される。
  - Stage 2 LLM が提案する過剰な法人ロールアップから死傷個人・現場レジリエンス発揮者（`B_CA_L4` 等）が決定論的に保護される。
  - 認識されなかった警報表示（`RIMCAS` 等）が事実性を損なわず監視先レーン上に `intended_recipient`（客体提示ロール）として配置され、未割当孤立（`review_conn_*`）が解消される。
  - `下請会社 -> 除草作業班` のような Poset 逆転包含が Stage 1 パース時点で安全に除去される。
- **トレードオフ・考慮事項**:
  - 職種ベース名抽出は前後英数字識別子を持つ同職種表記を対象とするため、完全に異なる固有名（識別子なし）の同職種メンバーはプロンプト側のグループ抽出指針と通常のペナルティソルバーで処理される。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/features/vta/utils/subjectRanking.ts` / `subjectRanking.test.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`（`validateParticipants` における `VTAEntity.mergedFrom` の保持）
  - `src/tools/vta/services/generation/granularityRefinement.ts` / `granularityRefinement.test.ts`
  - `src/tools/vta/features/vta/utils/eventLedger.ts` / `ledgerValidation.test.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`, `factualityPolicy.ts`, `contextEvidencePolicy.ts`, `chainRepairService.ts`, `public/prompts.json`
