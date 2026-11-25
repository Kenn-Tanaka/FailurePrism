# ADR-0087: 未知のPoset親の保守的発見・主体の重みと距離に基づく連続統合コストモデル・受動被覆ハブ検知および回顧節/範囲時刻の `before` 半順序化ポリシー

- **Status**: Accepted
- **Date**: 2026-11-25
- **Target Components**:
  - `AGENTS.md`
  - `src/tools/vta/features/vta/utils/subjectPoset.ts`
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts` / `public/prompts.json` (`event-ledger-22`)
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
- **Related Requirements / ADRs**: ADR-0057, ADR-0079, ADR-0080, ADR-0082, ADR-0083, ADR-0084

---

## 1. コンテキストと課題 (Context & Problem Statement)

診断トレース `extract_full_1795543728897_8kxr`（東武鉄道日光線新鹿沼駅構内 列車触車事故、目標 8 列に対して 10 列で終了）の詳細診断から、以下の 3 つの構造的不整合が確認された。

1. **受動ロール（`:target`）のみを持つ上位ハブ `A5（除草薬散布作業班）` の独立レーン並立**:
   - 配下メンバー（`A6〜A13`）が抽出済みであるにもかかわらず、`E5`（`A7:actor, A5:target`）・`E8`（`A6:actor, A5:target`）・`E23`（`A6:actor, A5:target`）のように、下位メンバー自身が能動行動しているイベントの受動宛先として上位枠 `A5` が重複付与された。
   - その結果、`A5` が直接関与主体（`isZeroEventHub = false`）と判定され、個別班員レーンと横並びで共存する反鎖（Antichain）違反が生じた。
2. **回顧的・多視点セクションおよび範囲時刻（`10:45〜10:46頃`）における時間順序逆転と単独見出し段落の未参照**:
   - 事故発生（`E26: 10:46頃 静止および列車触車`）の記述後に続く「運転士の状況」節の事象（`E28: 10:45頃 減速`、`E29: 10:45〜10:46頃 待避完了判断`、`E30: 10:46頃 非常ブレーキ操作`）において、範囲時刻 `10:45〜10:46頃` と点時刻 `10:46頃` の区間重複や同一分イベント間で明示的な `[関係] before` が欠落した場合、原文出現順フォールバックにより触車後の行へ配置される問題があった。また単独見出し段落（`source_1/p62`）が未参照段落として残存した。
3. **アドホックな個別条件による周辺主体の統合不全と既存Poset親子関係の喪失**:
   - `buildSubjectOthersEligibilitySet` および `generateStructuralFallbackCandidates` が `isSingleCardSharedPriorOrg`（1カードかつ `organization` 限定）・`hasSubstantiveVarAction`・`isPassiveRecipient1Card` 等のアドホックな種別・枚数条件を積み重ねていたため、事前委託を含む2カードの周辺主体 `A2（北関東工務事務所）` が不適格となり、`A4（下請会社）` も単独では `HG2`（2主体以上必須）を満たせず両者が未統合のまま残存した。
   - また、既存の Poset 親子関係にない主体群（例：`A2 ≺ A1` とルート `A4`）を新規グループや `subject_others` に集約する際、既存の Poset 親子関係（`A2 ≺ A1`）を破壊せずに表現する形式モデルが未定義であった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **アドホックな意味付けの排除と形式数理モデルへの一本化**: 決定論的処理において `kind === 'organization'` や固定カード枚数閾値などの個別条件を増やすことを排し、グラフ構造上の「主体の重み」と「主体間の関係の重み・Poset距離」に基づく連続的モデルへ統一すること。
- **半順序の保存（未知のPoset親の保守的発見）**: Poset の親子関係にない主体群 $S$ を集約する際、既存の半順序関係（`A2 ≺ A1` 等）を上書き・破壊せず、保守的順序拡大（$\forall x, y \in V,\; x \preceq y \iff x \preceq' y$）を満たす「未知の 0 イベント上位親 $P$ の発見」として形式化すること。
- **時間半順序の意味理解の委譲**: 表記ゆれに脆弱な範囲時刻・相対時刻・回顧記述の正規表現パーサーを追加せず、原文時刻の忠実保持を維持したまま LLM による明示的 `[関係] before` エッジ出力を主手段とすること。

---

## 3. 検討した選択肢 (Considered Options)

### 選択肢 A: 台帳検査での受動 `:target` の決定論的削除・範囲時刻の正規表現パーサー追加・`isMinorPeripheralOrg` 条件の追加
- **却下理由**:
  - `E5（A7:actor, A5:target）` から `A5:target` を機械削除すると発出者 `A7` 以外の宛先情報が消失し意味が歪む。
  - 範囲時刻や相対表現の正規表現処理は表記ゆれに不安定である。
  - `isMinorPeripheralOrg` のような新たなアドホック条件の追加は保守性と一般性を損なう。

### 選択肢 B（採用）: 純粋Posetによる受動被覆ハブ検知＋未知の親の保守的発見（`discoverConservativeParent`）＋既存5軸スコアと距離に基づく連続コストモデル＋`before` 主導の時間半順序化
- 純粋 Poset 被覆判定で `softIssues` による LLM 自己修復を促しつつ、残存時もオプティマイザ側で 0 直接イベントハブ（`HG2c` 対象）として扱う。
- 親子関係にない主体の集約（`role_group`・`peripheral_others`）を `SubjectPoset` 上の保守的親発見として統一し、既存の `rankSubjects` 5 軸スコア $s(u)$・Poset 共通祖先距離 $\delta_{\text{poset}}(S)$・主体間関係重み $W(u, v)$ の連続関数で統合コストを算出する。
- 回顧節・範囲時刻・相対時刻の半順序化は `event-ledger-22` における明示的 `[関係] before` 出力へ一本化する。

---

## 4. 決定事項 (Decision Outcome)

1. **設計原則の明文化（`AGENTS.md`）**:
   - `VTA Design Principles` に、(1) 主体の重みと主体間関係重み・距離に基づく形式数理モデル、(2) 非親子主体の集約における既存半順序を保存する「未知の Poset 親の発見（保守的順序拡大）」、(3) 明示的 `[関係] before` を主手段・`[イベント]` 行整列を補助とする LLM 主導の時間半順序化の 3 原則を規定した。
2. **純粋 Poset 被覆判定による受動上位ハブのソフト修復と 0 イベントハブ化**:
   - `subjectPoset.ts` に `computeDirectUncoveredEventIds` を追加し、上位主体 $H$ の全関与が受動ロール（`target` / `intended_recipient`）のみであり、かつすべての関与イベントに厳密下位主体 $d \prec H$ が実質ロール（`actor` / `affected` / `confirmed_recipient`）で共同関与している場合（$E_{\text{dir}}(H) = \emptyset$）を純粋 Poset 構造のみで判定する。
   - `eventLedger.ts`（`inspectLedger`）は該当イベント行および関係行に `poset_ancestor_passive_target` の `softIssues` を発行し、`applyLedgerRepair` を通じて具体的な下位主体IDへの割当修正を促す。
   - 修復後も残存した場合に備え、`laneConsolidationOptimizer.ts`（`computePassivelyCoveredHubIds` / `remapPassivelyCoveredRelations`）は当該ハブを 0 直接イベントハブ（`isZeroEventHub = true`、`HG2c` 適用）として扱い、関係端点を共同関与下位主体（または `before`）へ安全に再配線する。
3. **回顧節・範囲時刻に対する明示的 `before` 半順序化と単独見出し段落の網羅（`event-ledger-22`）**:
   - `eventPrompts.ts` および `public/prompts.json` を `event-ledger-22` に更新し、原文出現順をベースラインに維持しつつ、帰結直後等に配置された回顧的・別視点サブセクションの帰結前イベント（`E28 -> E29 -> E26 -> E30` 等）、範囲時刻・相対時刻、同一分イベント間の順序を明示的 `[関係] before` エッジで確定させる規則、および単独見出し段落（`p62` 等）の隣接イベント参照または `[整理] excluded` 記録規則を追加した。
4. **未知の Poset 親の保守的発見と連続コストモデル（`subjectPoset.ts` / `laneConsolidationOptimizer.ts`）**:
   - `subjectPoset.ts` に `measureCommonAncestorDistance` および `discoverConservativeParent` を実装した。採用された新規親 $P$（`role_group` および `subject_others`）は $\forall s \in S,\; s \prec P$ および極小共通祖先 $A_{\min}(S)$ に対する $P \prec a$ を `projectedAnalysis.subjectPoset` へ追加し、`A2 ≺ A1` 等の既存半順序を一切破壊せず保守的拡大（$\forall x, y \in V,\; x \preceq y \iff x \preceq' y$）を保証する（`fineGrainedBase` は不変に保持）。
   - `buildSubjectOthersEligibilitySet` から `isSingleCardSharedPriorOrg`・`hasSubstantiveVarAction` 等のアドホック条件を撤廃し、位相・帰結アンカー不変条件（`high/reporter` 焦点保護、非受動機械の `:loss` 直接当事者 `:actor/:affected` 保護、単独帰結当事者保護、既存の統合可能 Poset 親および同一 0 イベントハブ配下の主役と直接結合するコホート下位主体の保護）に整理した。
   - `generateStructuralFallbackCandidates` から `isPassiveRecipient1Card`・`isRedundantLow1Card` および `0.35` 一括上限キャップを撤廃し、`rankSubjects` 5 軸スコア $s(u)$ に基づく個別連続コスト $c_{\text{disc}}(u)$ と Poset 距離 $\delta_{\text{poset}}(S)$・関係重み $W(u, v)$ による 2 主体ペアコスト、ならびに新規発見バケット開設時の削減列数単位コスト等価化（`isOpeningDiscoveredBucket`）へ統一した。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `8kxr` 事例において、受動被覆ハブ `A5（除草薬散布作業班）` の親子並立が解消され、`A2（北関東工務事務所）` と `A4（下請会社）` が `A2 ≺ A1` の Poset 関係を保ったまま「その他の関係者」へ集約されて目標どおり 8 列（`C1 = 1.0`）に収束する。
  - 主体の種類名やカード枚数閾値に依存しないため、ITシステム障害・医療・製造・交通などあらゆるドメインで一貫した数理的挙動が得られる。
  - `fineGrainedBase` を無傷で保持しつつ `analysis.subjectPoset` 上で発見された親の半順序関係が一貫して参照可能になる。
- **トレードオフ・考慮事項**:
  - `subject_others` はスイムレーン左端配置および `aggregate: true` による UI 互換性を維持するため、`projectedEntities` の非集約 `parentEntityIds` には含めず `analysis.subjectPoset` 側で包含エッジを保持する。
- **影響ファイル**:
  - `AGENTS.md`
  - `src/tools/vta/features/vta/utils/subjectPoset.ts`
  - `src/tools/vta/features/vta/utils/subjectPoset.test.ts`
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `src/tools/vta/services/llm/prompts.test.ts`
  - `public/prompts.json`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
  - `docs/adr/0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md`
  - `docs/adr/README.md`
