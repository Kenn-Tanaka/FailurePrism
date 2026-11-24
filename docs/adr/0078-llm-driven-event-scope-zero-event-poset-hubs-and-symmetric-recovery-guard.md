# ADR-0078: 決定論的事故語彙判定の撤去とLLM構造化スコープ判定・0件親組織ハブ解禁・対称回復主体ガード是正ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-24
- **対象コンポーネント**: VTA Engine (`granularityScore.ts`, `subjectRanking.ts`, `eventLedger.ts`, `eventAnalysis.ts`, `chainRepair.ts`, `client.ts`), LLM Prompts (`eventPrompts.ts`, `granularityRefinement.ts`, `public/prompts.json`), Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0008](./0008-subject-consolidation-outcome-asymmetry-policy.md), [ADR-0071](./0071-penalty-based-subject-consolidation-and-gentle-lane-cap.md), [ADR-0074](./0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md), [ADR-0075](./0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md), [ADR-0077](./0077-homogeneous-clone-coalescing-stage2-merge-guards-and-alarm-recipient-assignment.md), [ROADMAP.md](../ROADMAP.md) (`RM-VTA3-01`..`04`)

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0077 適用後の実事例 2 件（羽田空港衝突事故 `extract_full_1795446245999_bv3r`・東武日光線触車事故 `extract_full_1795446609952_gq53`）の診断およびアーキテクチャ自己レビューを通じ、以下の 4 つの課題が明らかになった。

1. **決定論的事故語彙正規表現（`CASUALTY_OR_SEVERE_DAMAGE_PATTERN` / `POST_INCIDENT_ADMIN_PATTERN`）によるドメイン結合と重要事象の誤除外**:
   `granularityScore.ts` の `collectPostOutcomeExcludedNodeIds` が、物理的な死傷・損壊語や事故調査語の正規表現によって「重要な結果事象か事後調査活動か」を決定論的に判定していた。そのため羽田トレースで `E70（客室内への延焼, 17:58ごろ, p116）` が正規表現から漏れて誤除外されたばかりでなく、ソフトウェア障害・製造品質不適合・業務プロセス不備など物理的死傷語を含まない一般 VTA 分野では、`sourceOrder > maxOutcomeOrder` の重要結果事象が網羅的に誤削除される構造的欠陥となっていた。
2. **直接イベント 0 件の親組織ハブ（`A_JAL`）の事前除外と `evaluateMergeGuard` の論理式バグによるレーン膨張・主役アクター（`A_TWR_E`）押し出し**:
   - LLM が子主体（乗員・乗客 7 主体）へ事象を直接割り当てた結果、親組織 `A_JAL` が関与 0 件としてソルバー実行前に `excludedIds` へ除外され、7 子主体すべてが統合先親を持たない孤立ルートとなって強制保持された（`可視列=12` / $K_{\text{post}}=7$）。
   - さらに `evaluateMergeGuard` Step 2 の `(srcVar && tgtRec) || (tgtVar && srcRec)` がレジリエンス変動を除外せず排他条件も確認していなかったため、`E69:recovery` を共有する対称な避難主体同士がすべて `strictAsymmetry: true` と誤判定されていた。
   - 加えて `subroleLoss` が `focus: 'high'` の主役変動アクター（`A_TWR_E: タワー東管制官`）も `focus: 'mid'` と同じ係数 `0.12 * val` で扱っていたため、列超過ペナルティ下で `A_TWR_E` が `A_CAB` に吸収された。
3. **`chain.repair` の `[要確認]` 項目における対象 ID・見出しの消失**:
   `chainRepair.ts` が `[要確認]` 行の `targets` 列（`E11`, `E19`）を破棄して `text: code`（`"review"`）のみを保存していたため、どの未割当イベント・関係が要確認なのか UI・診断の双方から判別不能となっていた。
4. **契約・委託関係にある別組織間での作業班 Poset 誤包含**:
   受託・下請側の現場作業班（`除草薬散布作業班`）の上位主体に発注元組織（`東武鉄道株式会社`）が指定され、受託側メンバー全員が発注元組織の子孫となっていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **ドメイン非依存性（Domain Generality）**: VTA は IT・製造・業務・医療・安全など全分野に適用されるため、事象の重要度・極性・事後メタ活動スコープの意味判定は LLM が担い、TypeScript は分野語彙に一切依存しない構造・位相・時系列不変条件のみを扱うべきである。
- **ゼロ追加 LLM 通信**: Step 1b（`preliminary.classification`）は既に全非帰結イベントに対して 1 パス実行されているため、4 列 TSV 形式を維持したまま判定トークンを構造化拡張することで通信回数を増やさずに実現できる。
- **Gate G4 安全性と根拠必須**: 未割当イベント（カード 0 枚）を `outcome.eventIds` へ昇格させると Stage 2 Gate G4 違反を起こすため関与主体を持つイベントに限定し、`post_outcome` 除外にも必ず段落照合済みの根拠を要求する。
- **空レーン・無意味改名の禁止**: 0 件親組織ハブは、実際に 2 件以上の関与子孫を統合して列数を削減する場合にのみ保持を認め、0〜1 件の場合は `excluded` とする。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A**: `CASUALTY_OR_SEVERE_DAMAGE_PATTERN` に `延焼` 等の語彙を追記して対症療法を行う。
  - *不採用理由*: 事故以外の VTA 分野（IT・製造・事務等）で機能せず、語彙いたちごっこと誤除外が永続する。
- **選択肢 B（採用）**:
  1. `granularityScore.ts` から語彙正規表現を全面撤去し、既存の `[仮判定]`（および `[判定]`）トークンに `variation:resilient`・`outcome:loss|recovery|near_miss`・`post_outcome` を導入して LLM の構造化判定へ一本化する。
  2. `solveOptimalSubjectRetention`（Stage 2・Stage 3.5 共通）に 2 子孫以上を持つ 0 件親組織ハブの条件付き参入、真の非対称（`srcPureAdv && tgtRes`）判定、`focus: 'high'` 変動アクター優先重みを導入する。
  3. `chainRepair.ts` で `[要確認]` の対象 ID・見出しを保持し、`SUBJECT_FOCUS_POLICY` に委託・請負チームの発注元非包含ルールを分野横断表現で明記する。

## 4. 決定事項 (Decision Outcome)

### 4.1 LLM 構造化トークンによる意味・スコープ判定と語彙正規表現の全面撤去 (`vta.ts`, `eventLedger.ts`, `eventAnalysis.ts`, `client.ts`, `granularityScore.ts`)
- `[仮判定]` の判定値として `normal` / `variation` / `variation:negative` / `variation:resilient` / `outcome:loss` / `outcome:recovery` / `outcome:near_miss` / `post_outcome` / `undetermined` を受理し、Stage 4 `[判定]` でも `variation:resilient` / `variation:negative` を受理する。
- `promotePreliminaryOutcomes` により、関与主体を 1 件以上持つ `outcome:*` イベントを `analysis.outcome`（`classification: 'outcome'`）へ自動昇格し、代表種別を再集計する（未割当イベントは Gate G4 回避のためスコープ内 `variation` として保持）。
- `granularityScore.ts` から `CASUALTY_OR_SEVERE_DAMAGE_PATTERN`・`POST_INCIDENT_ADMIN_PATTERN`・`isCasualtyOrSevereDamageEvent` を完全削除する。イベント単位で `ev.preliminary` を検査し、`[仮判定]` 付与済み事象は LLM が根拠付きで `scope === 'post_outcome'` と判定した場合のみ事後活動として除外する（他判定はフェイルセーフ保持、`[仮判定]` 未付与事象は時系列・グラフ位相条件のみで判定）。

### 4.2 0 件親組織ハブの条件付き解禁・対称回復ガード是正・主役保護 (`subjectRanking.ts`, `granularityRefinement.ts`)
- `evaluateMergeGuard` Step 2 にて、`target` / `intended_recipient` 以外の役割で関与する回復帰結・レジリエンス変動を回復・抑止側（`Res`）へ分類し、一方が純粋な異常発生側（`Adv && !Res`）で他方が回復・抑止側（`Res`）である場合のみ `strictAsymmetry: true` とする。
- 上限超過時、直接関与 0 件でも 2 件以上の統合可能な関与子孫を持つ `organization` を `zeroEventHubIds` として Stage 2・Stage 3.5 の `solveOptimalSubjectRetention` に渡し、2 件以上の子孫が統合される場合（`clusters.get(i).length >= 3`）のみ保持を許可し、非保持時は上位親へ統合せずコスト `0` で `excludedIds` へ送る。
- `focus === 'high'` かつ直接変動を持つ `person` の `subroleLoss` を `0.28 * val` に引き上げて周辺下位主体を優先統合させる。Stage 3.5 の Poset 葉保護判定も `isEffectiveVariationEvent` に分離する。

### 4.3 `[要確認]` 対象ラベル保持・太字見出し除外・別組織間 Poset 境界 (`chainRepair.ts`, `autoConnectionService.ts`, `aiDiagnostics.ts`, `eventPrompts.ts`)
- `applyChainDelta` の `[要確認]` 変換にて、対象 ID とイベント見出し／主体名を解決して `対象: E11（...）` 形式で `text` に記録する。
- `aiDiagnostics.ts` の未参照段落監査で、単独の太字括弧見出し行（`**（...）**`）をスキップする。
- `SUBJECT_FOCUS_POLICY` にて、委託・請負・下請側のチームや担当者の上位主体に発注・委託元の別組織を指定しない規則を全分野共通表現で明記し、`public/prompts.json` と同期する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - IT・製造・業務・安全の全分野で、語彙辞書に依存せず重要帰結（`E70: 客室内への延焼` やデータ欠損等）の帰結昇格・保持と事後メタ活動の除外が一貫して機能する（追加 LLM 通信 0 回）。
  - 直接関与 0 件の上位法人ハブ（`A_JAL` 等）が複数子主体の受け皿として機能し、対称な避難乗員の誤ブロックが解消されることで、`タワー東管制官（A_TWR_E）` 等の高焦点主役アクターが確実に独立保持される。
  - `[要確認]` 項目の対象イベント・主体が UI および診断パッケージ上で即座に識別可能となる。
- **トレードオフ・考慮事項**:
  - `[仮判定]` を省略した生台帳（単体テスト等）のフォールバック時は、語彙を見ず時系列・グラフ位相のみで事後除外を判定する。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/features/vta/utils/eventLedger.ts` / `ledgerValidation.test.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/services/generation/granularityScore.ts` / `granularityScore.test.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts` / `subjectRanking.test.ts`
  - `src/tools/vta/services/generation/granularityRefinement.ts`
  - `src/tools/vta/features/vta/utils/chainRepair.ts` / `chainRepair.test.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts`, `aiDiagnostics.ts`, `eventPrompts.ts`, `public/prompts.json`
