# ADR-0083: 正規化フェーズにおける多軸主体半順序集合（Multi-Axis Subject Poset）構築・LLM主導の上位主体統合選択（`[推奨統合]` / `[予備候補]`）・および多重親端点解決ポリシー

- **Status**: Accepted
- **Date**: 2026-11-24
- **Target Components**:
  - `src/tools/vta/services/llm/eventPrompts.ts` / `public/prompts.json` (`event-ledger-19`)
  - `src/tools/vta/features/vta/utils/subjectPoset.ts` (`resolveCardsForRelationEndpoint`)
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts` / `src/tools/vta/types/vta.ts`
  - `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`
- **Related Requirements / ADRs**: ADR-0078, ADR-0079, ADR-0080, ADR-0081, ADR-0082

---

## 1. コンテキストと課題 (Context & Problem Statement)

診断トレース `extract_full_1795498924074_8pm4`（東武鉄道日光線新鹿沼駅構内 列車触車事故、目標上限 8 列）の分析および設計レビューから、主体の包含階層（Poset）とレーン統合における以下の本質的な課題が明らかになった。

1. **単一木（会社組織図）偏重による包含関係の取りこぼしと発注元への誤接続**:
   - 正規化フェーズではシナリオ全文を読み込んでいるにもかかわらず、従来のプロンプトが「所属・上位主体」を単一の会社・組織ツリーのように記述していたため、元請社名が不記載の外部作業班（`除草薬散布作業班`）が発注元（`東武鉄道株式会社`）の子に誤接続されたり、派遣作業員（`F作業員`）が持つ複数軸の上位関係（雇用元の `下請会社` と現場編成の `除草薬散布作業班`）や職能グループ（`中継見張員`）が十分に表現されなかった。
2. **半順序集合（Poset）本来の価値である「複数基準での上位主体保持」と「シナリオ上自然な統合軸のLLM選択」の未活用**:
   - 主体を木ではなく半順序集合（DAG）として扱う本質的な価値は、1つの下位主体が「雇用・組織軸（直接雇用／派遣元）」「現場編成・職能軸（作業班・中継見張員）」「活動場所・機体軸（機上乗務員／地上スタッフ）」「帰結・状況軸（生存・待避群／被災群）」など複数の基準で複数の上位主体を同時に持ち得る点にある。
   - 従来の統合フェーズでは候補を順不同な `[統合候補]` として列挙させ、TypeScript 側の手続き的ペナルティ項（例：`focus === 'high'` かつ `:loss :affected` を一律 `0.68` でブロックする `hasHighFocusLossAffected` 等）で制御しようとしていたため、親チーム `除草薬散布作業班` が残っている横にアドホックな `role_group`（`待避作業員・見張員`）が並立して 9 列で停止するなど、不自然なレーン構成やヒューリスティックの複雑化を招いていた。
3. **多重親Posetにおける関係端点の曖昧性と 0 イベント中間ハブの 2 段階統合制約**:
   - 下位主体 $x \prec Y_1, Y_2$ が一方の上位主体 $Y_1$ に統合された際、同一イベントに $Y_2$ も関与していると、`resolveCardsForRelationEndpoint` が一般の Poset 祖先判定により $Y_1, Y_2$ の両カードにマッチする問題があった。
   - また `applyCandidatesRaw` が直接イベントを持つ主体のみを統合元としてフィルタしていたため、0 イベント中間ハブ（例：`C,D -> 中継見張員` の後に `中継見張員 -> 除草薬散布作業班`）を経由する 2 段階ロールアップが適用できなかった。
4. **抽出完了時の重複 `layout.audit`**:
   - `ScenarioInputSection.tsx` が `commitVTAChange` 直前に手動で `layout.audit` を記録しており、`commitVTAChange` 内の記録と二重になっていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **コードの単純性維持とLLMの文脈判断力の活用**: TypeScript 側に場当たり的な罰金項を積み増すのではなく、全文を読む正規化フェーズと統合フェーズのプロンプト契約を明確化し、シナリオ上最も自然な束ね方を LLM に提案させる。
- **半順序集合（BitsetPoset / SubjectPoset）の多軸表現力の最大活用**: 既存のカンマ区切り多重親パースとビットセット推移閉包基盤をそのまま活かし、複数軸の上位主体を正規化時点で確定する。
- **構造的不変条件の厳守と後方互換性**: ピン留め・分離維持制約・0 アクター法人シェル逆転防止・配線時間順整合（`HG1`〜`HG4`）はシンプルかつ厳格に維持し、既存の `[統合候補]` TSV とも完全互換を保つ。

---

## 3. 検討した選択肢 (Considered Options)

### 選択肢 A: TypeScript 側にイベント非共有ペナルティや自動派生候補生成を追加する
- `computeInclusionPenalty` や候補生成に共有イベント率・自動バンドル生成ロジックを追加する案。
- **却下理由**: コードが複雑化するうえ、どの基準（雇用・現場班・機体・帰結）で束ねるのがシナリオの筋として自然かは表層カウントではなくシナリオ文脈の意味理解に依存するため。

### 選択肢 B（採用）: 正規化で多軸 Subject Poset を確定し、統合フェーズで LLM に `[推奨統合]` / `[予備候補]` を提案させ、TypeScript 側のペナルティを簡素化する
- 全文を走査する正規化プロンプト（`event-ledger-19`）で 4 軸（雇用・組織、現場編成・職能、活動場所・機体、帰結・状況）の多重親 Poset と非包含境界を確定させる。
- 統合フェーズで `[上位主体ハブと包摂可能な下位主体一覧]` を提示し、LLM にこのシナリオで最も自然な一貫統合セット `[推奨統合]` とさらに列数を絞る `[予備候補]` を提案させ、探索初期ビームへ直接シードする。

---

## 4. 決定事項 (Decision Outcome)

1. **正規化プロンプトの多軸 Subject Poset 対応（`event-ledger-19`）**:
   - `SUBJECT_FOCUS_POLICY` および `EXTRACTION_ANCHORING_POLICY` を更新し、`所属・上位主体` 列を複数基準（雇用・組織軸、現場編成・職能軸、活動場所・機体・空間軸、帰結・状況軸）で複数の上位主体 ID をカンマ区切り指定できる半順序集合（Poset）として定義した（2 名以上を束ねる直接イベント 0 件の上位枠も定義可、イベント割当は最細粒度の下位主体優先）。
   - 発注元・施設管理者と外部請負作業班（元請社名不記載時は作業班の `所属・上位主体` を `-` とする）、事業者と乗客などの契約・対向関係を包含関係と混同しない規則および末尾参考文献段落の `excluded` 整理を明記し、`public/prompts.json` と完全同期した。
2. **多重親 Poset における `mergedFrom` 優先端点解決（`subjectPoset.ts`）**:
   - `resolveCardsForRelationEndpoint` において、一般の `poset.isAncestor` / `isDescendant` フォールバックの前に `participations` の `mergedFrom` を照合し、実際に下位主体が統合された先の上位主体カードが存在する場合はそちらを一意に優先解決する。
3. **LLM 主導の `[推奨統合]` / `[予備候補]` 提案と探索ロジックの簡素化（`laneConsolidationOptimizer.ts`）**:
   - `buildLaneConsolidationUserPrompt` に全上位系譜と `[上位主体ハブと包摂可能な下位主体一覧]` を追加し、複数軸の上位主体を比較可能にした。
   - `LANE_CONSOLIDATION_SYSTEM_PROMPT` と `parseLaneConsolidationTSV` で `[推奨統合]`（`recommended: true`）・`[予備候補]`（`recommended: false`）を導入（従来の `[統合候補]` も互換維持）。
   - `computeInclusionPenalty` において、構造的逆転（アクティブ中間親の飛び越し・0 アクター法人シェルへの主従逆転・単独 `:loss :actor` 消失）がない限り LLM の明示的な `[推奨統合]` Poset 選択をペナルティ 0 で尊重しつつ、非推奨候補・フォールバックに対しては既存の主役・被災主体保護を維持する簡潔な規則に整理した。
   - `applyCandidatesRaw` で 0 イベント中間ハブや仮想グループをソースとする 2 段階推移統合をサポートし、`[推奨統合]` の段階適用軌跡を探索ビームへシードした。
4. **重複 `layout.audit` の解消（`ScenarioInputSection.tsx`）**:
   - `commitVTAChange` 直前の重複 `debugRecorder.record('layout.audit', ...)` 呼び出しを除去した。

---

## 5. 結果と影響 (Consequences)

### メリット
- 派遣作業員・中継見張員・機上乗務員・被災/待避群のように複数の基準で束ね得る主体について、正規化段階で豊かな多軸 Poset が構築され、統合段階でシナリオの因果連鎖に最も自然な上位主体が選ばれる。
- 親作業班レーンと重複するアドホックな `role_group` の乱立や発注元法人への誤包摂が防がれ、スライダー操作時にも中間職能ハブから親作業班への 2 段階ロールアップが 0 トークンで滑らかに機能する。
- 多重親を持つ下位主体が一方の親へ統合された後も、クロスレーン関係線が実際の統合先カードへ正確に配線される。

### トレードオフ・考慮事項
- 正規化段階で直接関与イベント 0 件の上位ハブが `[主体]` に含まれる場合があるが、`fineBase` のアクティブ列数計算および未使用ハブの `stage3_hc_prune` 自動除外により、採用された上位ハブ（2 名以上の下位主体が統合されたもの）のみがキャンバス上に実体化される。

### 影響ファイル
- `src/tools/vta/services/llm/eventPrompts.ts`
- `public/prompts.json`
- `src/tools/vta/features/vta/utils/subjectPoset.ts`
- `src/tools/vta/types/vta.ts`
- `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
- `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`
- `src/tools/vta/services/llm/prompts.test.ts`
- `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
- `tests/vta/bitsetPoset.test.ts`
- `docs/adr/0083-multi-axis-subject-poset-and-llm-guided-upper-subject-consolidation.md`
- `docs/adr/README.md`
