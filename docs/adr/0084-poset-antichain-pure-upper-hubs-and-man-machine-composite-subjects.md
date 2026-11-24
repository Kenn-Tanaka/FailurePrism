# ADR-0084: 半順序集合の反鎖（Antichain）完全包摂条件・構成員既出グループの純粋上位ハブ化・および人間-機械複合上位主体ポリシー

- **Status**: Accepted
- **Date**: 2026-11-24
- **Target Components**:
  - `src/tools/vta/services/llm/eventPrompts.ts` / `public/prompts.json` (`event-ledger-20`)
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts` (`evaluateMergeGuard`)
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
- **Related Requirements / ADRs**: ADR-0008, ADR-0010, ADR-0033, ADR-0079, ADR-0080, ADR-0083

---

## 1. コンテキストと課題 (Context & Problem Statement)

診断トレース `extract_full_1795507157617_emhu`（東武鉄道日光線新鹿沼駅構内 列車触車事故、目標上限 7 列に対し 10 列で停止）の検証から、主体の包含関係とスイムレーン切り出しに関する 2 つの本質的な構造課題が判明した。

1. **構成員既出グループ（`除草薬散布作業班`）の独立レーン並立（反鎖違反）**:
   - 正規化プロンプトに「組織・班全体の事象のみ上位主体IDへ直接割り当て」という記述が残っていたため、構成員（A〜J の 10 名）がすべて下位主体として抽出されているにもかかわらず、「作業班へ指示した」「作業班が進入した」等の記述が上位主体 `A6（除草薬散布作業班）` へ直接・重複割当された。
   - さらに統合フェーズで配下 8 主体のうち 3 主体（C・D・E）だけが `A6` に部分統合され、残りの 5 主体（G・A・B・F・H・I・J）が独立レーンのまま残った結果、それらを包含するはずの `除草薬散布作業班` レーンが個別班員レーンと横並びで共存する集合論的矛盾（半順序集合の反鎖［Antichain］違反）が生じた。
2. **操縦者（`運転士`）と車両（`第1020列車`）の親子化による二重レーン残存と因果分断**:
   - 人間（`運転士A: person`）と機械・車両（`列車X: machine`）は本来互いに包含関係にない（`運転士A ≮ 列車X` かつ `列車X ≮ 運転士A`）にもかかわらず、正規化で `運転士 ≺ 第1020列車[machine]` と出力されたうえ、減速・制動操作が `運転士`、触車が `第1020列車` に分断された。
   - この状態では、逆転統合防止ガード・`evaluateMergeGuard` のハード分離・`hasExclusiveOutcomeActor` ペナルティが干渉し、1 つの連続した運行連鎖が 2 レーンに引き裂かれたまま統合不能となっていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **半順序集合（Poset）における反鎖（Antichain）の整合性**: 表示されるレーン間で親子包含の重複を起こさず、どの粒度でも互いに素な意味単位として読めること。
- **人間-機械系（Joint Cognitive System）の正確な表現**: 操縦者と機械の双方が事象を担う場合、無理に一方を他方の親にするのではなく、複合上位主体 `運転士Aが操作する列車X` を最小上界として置き、「2レーン分離（モード混乱・故障対立がある事例）」と「1レーン一体統合（一体運行の事例）」を単一の仕組みで扱えること。
- **コードの単純性と後方互換性**: 恣意的なペナルティ項を増やさず、純粋上位ハブの完全包摂不変条件（`HG2c`）とプロンプト契約で実現し、直接イベントを持つ法人本社や既存保存データを壊さないこと。

---

## 3. 検討した選択肢 (Considered Options)

### 選択肢 A: 機械主体を禁止して運転士へ強制付替し、すべての親主体への部分統合を一律禁止する
- **却下理由**: 物理的な車両接触をすべて生身の人間へ書き換える不自然さがあるほか、自律制御装置とのモード混乱事例との連続性が失われる。また直接イベントを持つ法人本社（例：`東武鉄道` 本社と現場 `運転士`）まで初期状態ごと不適格になる。

### 選択肢 B（採用）: 構成員既出グループの純粋上位ハブ化＋`HG2c` 完全包摂条件＋V字型の人間-機械複合上位主体を導入する
- 構成員が抽出済みの現場班・職能枠・人間機械複合枠を「直接割当イベント 0 件の純粋上位ハブ」とし、`isZeroEventHub` の実体化には配下の全アクティブ子孫の統合を必須（`HG2c`）とする。
- `運転士A`（`person`）と `列車X`（`machine`）は `運転士A ≺ 運転士Aが操作する列車X` かつ `列車X ≺ 運転士Aが操作する列車X` の V 字階層で構成する。

---

## 4. 決定事項 (Decision Outcome)

1. **正規化プロンプトの改訂（`event-ledger-21`）**:
   - 構成員が下位主体として抽出されている現場作業班・乗務員編成・職能グループ・人間機械複合枠は直接イベント 0 件の純粋上位ハブとして保持し、集合表現・受動態表現だけでなく一斉指示・全体合図の宛先（`:target` 等）にも上位枠IDを使わず既出の下位主体IDへ割り当てる（`relationContract.ts` および `contextEvidencePolicy.ts` に残っていた `（またはその上位組織ID）` も削除して完全統一）。
   - 操縦者（`person`）と車両・装置（`machine`）の双方が事象を担う場合は直接の親子指定を禁じ、複合上位主体 `運転士Aが操作する列車X`（`organization`/`other`、直接イベント 0 件）を介して束ねる契約を明記し、`public/prompts.json` と同期した。
2. **台帳検証・Stage 1 再結合・`evaluateMergeGuard` の更新**:
   - `eventLedger.ts`: `person/organization ≺ machine` および `machine ≺ person` の直接包含を警告付きで無視するガードを追加した。
   - `autoConnectionService.ts`: Stage 1/2 完了後の `completedFineBase` 再結合時に、`mergedPoset` から各主体の `parentEntityId` / `parentEntityIds` を復元し、0イベント上位ハブへの親リンク欠落を解消した。
   - `subjectRanking.ts`: `evaluateMergeGuard` が `entity.parentEntityIds` ではなく `SubjectPoset`（`analysis.subjectPoset` 優先）から共通の 0 イベント上位ハブを判定するよう更新し、自律制御異常・モード不整合（`ACTIVE_MACHINE_PATTERN`）を伴わない操作者–機械ペアに対して自動ハード分離を生成しないよう統一した。
3. **Poset 反鎖完全包摂条件（`HG2c`）とフォールバック部分統合の抑止**:
   - `laneConsolidationOptimizer.ts`:
     - `evaluateState` に `HG2c`（`isZeroEventHub` バケットは配下の全アクティブ Poset 子孫がそのバケットへ割り当てられている場合のみ有効）を導入し、さらに `generateStructuralFallbackCandidates` でも統合不能な主要 `person` 子孫が残る親グループへの単体 `person` フォールバック（`FB_*`）を生成しないようガードした。
     - `computeInclusionPenalty` において、統合先が 0 イベント純粋上位ハブ（`yEvs === 0`）かつ `[推奨統合]` である場合は `:loss :actor` 主体（`列車X` 等）の複合上位枠への統合をペナルティ 0 で許容した（直接イベントを持つ法人本社への統合には従来どおり `0.65` ペナルティを維持）。
     - `buildSubjectOthersEligibilitySet` で、他主体と共同関与する非帰結 1 カードの `mid` 焦点組織（事前派遣手配の下請会社等）を `subject_others` 適格とした。

---

## 5. 結果と影響 (Consequences)

### メリット
- `除草薬散布作業班` のような上位グループが一部のメンバーだけを吸収して他のメンバーと横並びになる反鎖違反が構造的に根絶される。
- `運転士A` と `列車X` が `運転士Aが操作する列車X` によって存在論的に正しく関係づけられ、一体運行事例では 1 本の連続レーンへ統合され、モード混乱事例では 2 レーン分離が維持される。

### トレードオフ・考慮事項
- 純粋上位ハブ（直接関与 0 件）は配下の全アクティブ下位主体を一括統合する場合にのみ実体化されるため、部分的な補助メンバーの束ねには中間職能ハブ（`中継見張員`・`待避作業員` 等）または `role_group` が用いられる。

### 影響ファイル
- `src/tools/vta/services/llm/eventPrompts.ts`
- `public/prompts.json`
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/features/vta/utils/subjectRanking.ts`
- `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
- `src/tools/vta/services/llm/prompts.test.ts`
- `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
- `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
- `docs/adr/0084-poset-antichain-pure-upper-hubs-and-man-machine-composite-subjects.md`
- `docs/adr/README.md`
