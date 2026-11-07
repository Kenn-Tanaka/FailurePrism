# ADR-0012: 連鎖修復差分検証における既存関係サニタイズと巻き添えリジェクト防止ポリシー (Chain Repair Delta Validation & Relation Sanitization Policy)

- **ステータス**: `Accepted`
- **決定日**: 2026-11-06
- **対象コンポーネント**: `src/tools/vta/features/vta/utils/chainRepair.ts`, `src/tools/vta/services/generation/granularityScore.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- **関連要件 / ADR**: ADR-0007 (事後活動除外), ADR-0008 (主体統合・除外), ADR-0010 (SubjectPoset DAG)

---

## 1. コンテキストと課題 (Context & Problem Statement)

長大インシデント（羽田空港航空機衝突事故等）の自動生成パイプライン実行時、AI診断パッケージ（ADR-0009）において以下の異常が検知された：

- LLM（Gemini 3.8 Flash）が Stage 2（連鎖不足点検・chainRepair）で提案した時系列関係（`before`、元主体・先主体は `-` 指定）や割当追加行（`tmp_as1`, `tmp_as2`、`tmp_R1`〜`tmp_R7`）が、すべて一様に `関係の主体がイベントに関与していません。` という同一のエラーで全件リジェクトされていた。
- しかし、提案された `tmp_R1`〜`tmp_R7` は `before` 関係であり主体指定は行われておらず（`-`）、単体として何ら誤りはなかった。
- 詳細なライフサイクルトレースと再現検証の結果、以下の根本原因が判明した：
  1. 上流パイプライン（主体統合 `consolidateSubjects`、事後活動除外 `filterPostOutcomeScope`）で主体の整理や関与の絞り込みが行われた際、既存リレーション群（`schema.analysis.relations`）の中に、現在の関与（`participations`）と端点主体が一致しない関係（孤立・不整合な既存関係）が残留することがあった。
  2. `validateChainRows` は各候補行 $r$ ごとに `applyChainDelta(schema, [...accepted, r])` を試行する。
  3. `applyChainDelta` は差分適用後にスキーマ全体の整合性を保証するため末尾で `validateSavedAnalysis(a)` を呼び出す。
  4. `validateSavedAnalysis` は新規追加された行だけでなく `a.relations`（既存リレーション全体）をループ検証するため、上流で潜伏していた既存リレーションの違反を検知して例外を投げていた。
  5. その結果、**新しく提案された差分行が完全に正当であるにもかかわらず、既存リレーションの違反の濡れ衣を着せられ、すべての差分行が巻き添えでリジェクト（全滅）する** という重大なパイプライン欠陥が生じていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **巻き添えリジェクトの撲滅**:
   - スキーマ内に事前に存在していたリレーションの微小な不整合が原因で、新規差分提案（時系列補完や割当）が全件破棄されることを絶対に防止しなければならない。
2. **新規差分行の厳格な検証の維持**:
   - 新規差分行自体にミスがある場合（存在しないイベントを参照している、割当のない主体を端点に指定している等）は、従来通り厳格に検知・拒絶（throw）されなければならない（`chainRepair.test.ts`、`unassignedConnections.test.ts` などの既存不変条件の死守）。
3. **上流パイプラインの二重防衛**:
   - 事後活動除外（`filterPostOutcomeScope`）の段階でも、イベント存在確認だけでなく、残存カード・関与ペアとの端点整合化を事前に実施し、下流へ不正な関係を持ち越さないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1**: `validateSavedAnalysis` の例外をすべて握りつぶして警告除外する
  - *問題点*: 新規提案行そのものが存在しないイベントや主体を参照している重大なミスまで見逃してしまい、不正なデータがツリーに混入する。
- **選択肢 2**: 差分行のみを単独検証する独立した軽量バリデータを新設する
  - *問題点*: 既存グラフとの循環検出（Cycle Detection）や作業依存制約（`dependencyProblem`）、カード生成の整合性を二重実装することになり、コード重複と保守性の悪化を招く。
- **選択肢 3 (採用)**: 既存関係（`originalRelationIds`）のみをサニタイズ・Poset再解決し、新規差分行は既存の厳格な `validateSavedAnalysis` で検証する
  - *利点*: 新規提案行の厳格な検証ロジックを1ミリも緩めることなく、上流から持ち越された既存関係の不整合のみをピンポイントで修復・除外して巻き添えリジェクトを完全に撲滅できる。

---

## 4. 決定事項 (Decision Outcome)

以下の多層的修正を採用・実装した：

1. **`applyChainDelta` における既存関係の事前サニタイズ（`chainRepair.ts`）**:
   - 差分適用前に `originalRelationIds = new Set(schema.analysis.relations.map((r) => r.id))` を記録。
   - `a.relations` のうち `originalRelationIds` に属する既存関係のみを対象として：
     - `before` 関係の場合：端点主体が現在の関与を満たさない場合は主体指定を安全に解除（未指定 `-` 化）。前後順序自体は保護する。
     - それ以外の関係の場合：端点主体を Poset（`subjectPoset`）およびマージ履歴（`mergedFrom`）を用いて再解決。それでも関与を満たさない孤立関係は安全に除外。
   - 新規追加関係（`added`）は除外せずそのまま保持し、後続の `validateSavedAnalysis(a)` の厳格な検査に委ねる。
2. **事後活動除外におけるリレーション端点の双方向整合化（`granularityScore.ts:filterPostOutcomeScope`）**:
   - イベントID（`nextEventIdSet`）の確認に加え、残存関与ペア集合（`partPairSet`）との整合性を検査。
   - 関与が消失した端点主体について、`before` 関係なら主体解除、非 `before` 関係なら除外を実施。
3. **`validateSavedAnalysis` のオプション警告ハンドラ拡張（`eventAnalysis.ts`）**:
   - `validateSavedAnalysis(raw, onOptionalWarning?: (message: string) => void)` シグネチャをサポートし、必要に応じて非致命的な関係不整合を警告として除外可能にした。

---

## 5. 結果と影響 (Consequences)

### メリット
- **連鎖補完（Stage 2）の完全自律化**:
  羽田事故シナリオのように多数の主体統合や事後活動除外が行われた長大レポートにおいても、LLMの時系列差分提案（`tmp_R1`〜`tmp_R7` や割当追加）が既存関係の巻き添えでリジェクトされることなく、正常にグラフに反映されるようになった。
- **既存テスト・不変条件との100%両立**:
  新規追加行の不備（存在しないイベントへの接続等）は正確に検知・拒絶され、全101テストファイル・623件のテストがすべて成功している。

### 影響ファイル
- `src/tools/vta/features/vta/utils/chainRepair.ts`
- `src/tools/vta/services/generation/granularityScore.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `tests/vta/chainRepairDiagnosticRepro.test.ts` (新規再現・検証テスト)
