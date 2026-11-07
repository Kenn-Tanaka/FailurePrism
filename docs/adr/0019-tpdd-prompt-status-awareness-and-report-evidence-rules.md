# ADR-0019: TPDD プロンプトのノード状態認識・祖先系譜の付与および要求レポート根拠規則の厳格化 (TPDD Prompt Status Awareness, Ancestry Context, and Report Evidence Rules)

- **ステータス**: Accepted
- **決定日**: 2026-11-07
- **対象コンポーネント**: TPDD Prompts (`src/tools/tpdd/services/llm/prompts.ts`), Requirement Scope (`src/tools/tpdd/domain/requirementScope.ts`), AI Schemas (`src/tools/tpdd/services/llm/aiSchemas.ts`), Requirement Report (`requirementReportDocument.ts`, `RequirementReportPanel.tsx`), AI Panel (`AiPanel.tsx`, `runAiTask.ts`, `RequestPreview.tsx`, `requestLimits.ts`)
- **関連要件 / ADR**: ADR-0018

---

## 1. コンテキストと課題 (Context & Problem Statement)

TPDD-Editor の LLM プロンプトと検証パイプラインのレビューにおいて、事実性と提案品質に関わる以下の4つの課題が特定された。

1. **展開・代替・図レビューにおけるノード状態（`status`）とタグの欠落（H1）**:
   - `buildChatMessages` が送るノード情報に `status`（`candidate` / `adopted` / `rejected`）が含まれていなかったため、ユーザーが却下（`rejected`）した案を前提に下位展開を提案したり、図レビューで却下済みの案を現行の矛盾として誤指摘したりする問題があった。
2. **要求レポート（説明文生成）への `rejected` ノード混入（H2）**:
   - `collectRequirementScope` が `status === 'rejected'` の子孫ノードや詳細図内ノードを除外せずに収集していたため、却下されたはずの設計案が要求レポートの分解経路や根拠一覧に含まれていた。
3. **`concretization`（具体化）節の根拠検証の甘さ（H4）**:
   - `validateRequirementReportResponse` において、`requirement` は起点ノード引用必須、`breakdown` と `realization` は分解エッジ引用必須であったのに対し、`concretization` は「任意のノードを1件以上引用していれば通過」となっており、詳細図に基づかない一般的な具体化記述が通過する余地があった。
4. **1-hop 展開時の上位要求系譜の欠落（M2）とエッジ種別定義の不足（M3）**:
   - 展開・代替タスクではフォーカスノードと 1-hop 近傍のみを送るため、2階層以上深いノードを展開する際に最上位の要求文脈が失われていた（`parentDiagramSummary` フィールドは定義のみで使われていなかった）。また、4種類のエッジ種別（`decomposition`, `dependency`, `constraint`, `reference`）の意味定義がシステムプロンプトに明記されていなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **設計判断（採用・候補・却下）の厳格な反映**: ユーザーが明示的に `rejected` としたノードを提案の前提や要求説明書の本文に混入させないこと。ただし、要求レポートでユーザーが `rejected` ノード自体を起点として明示選択した場合はその起点ノードを返すこと。
- **AGENTS.md の要求レポート検証規約の厳守**:
  - `validateRequirementReportResponse` において、構文的に有効な応答で全 statement が根拠規則により除外された場合は `valid: true`, `data: { sections: [] }`, `warnings`（1件以上）を返すこと。
  - `valid: false` は JSON/スキーマ不正、または元から文が0件で警告も0件の場合に限定すること。
- **永続ID非露出と決定論的文脈構築**: 上位要求の系譜（`ancestry`）は LLM による事前要約ではなく、グラフ構造から決定論的に抽出し、リクエスト内限定の参照記号（`A1`, `A2`...）に変換して渡すこと。

---

## 3. 検討した選択肢 (Considered Options)

- **`concretization` の根拠規則**:
  - *選択肢 A*: 分解エッジの終点ノード引用を必須とする（`breakdown` と重複しやすい）。
  - *選択肢 B*: 詳細図（`ownerNodeRef` を持つ図）に属するノード（`detailNodeRefs`）を1件以上根拠として引用することを必須とする（**採用**）。詳細図による具体化という TPDD の構造と明確に対応する。
- **上位文脈の付与方式**:
  - *選択肢 A*: 親図全体を LLM で要約して `parentDiagramSummary` に入れる（非決定的であり通信回数とトークンが増える）。
  - *選択肢 B*: `collectAncestry` により、同一図内の分解親および上位図の所有ノード（`childDiagramId`）を最大5階層まで決定論的に遡り、`ancestry`（`A1`〜）として `<DATA>` に含める（**採用**）。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 プロンプトへの `status`・`tags`・エッジ種別定義・`ancestry` の追加 (`prompts.ts`)
1. `buildChatMessages` の各ノードに `status` と `tags` を追加し、システムプロンプトに `rejected` ノードの扱い規則と4種の接続線種別（`decomposition`, `dependency`, `constraint`, `reference`）の定義を追加する。
2. 展開・代替の出力契約 JSON に `"tags": ["短いタグ"]` を明記し、冗長な `data.task` およびシステムプロンプト内の `プロンプト版` 行を削除する（`PROMPT_VERSION` は `'2.1.0'` に更新し `provenance` 記録に維持）。
3. `collectAncestry` で収集した上位要求の系譜を `ancestry` として展開・代替タスクの `<DATA>` に含め、出力参照には使わない参考文脈であることを明記する。

### 4.2 要求レポートにおける `rejected` 除外と `concretization` 根拠検証 (`requirementScope.ts`, `aiSchemas.ts`)
1. `collectRequirementScope` において、起点以外の `status === 'rejected'` ノード（およびその下位部分木、ならびに詳細図内の `rejected` ノード）を除外し、除外件数を `excludedRejectedCount` として記録する。
2. `buildRequirementReportMarkdown` の要約節に、`excludedRejectedCount > 0` の場合「却下済みのノードN件は対象外としています。」を明記する。
3. `getDetailDiagramNodeRefs(scope)` を新設し、`validateRequirementReportResponse` にて `concretization` の statement が詳細図ノードを1件も引用していない場合は警告（`詳細図のノードを根拠に含まない具体化の説明を除外しました。`）を記録して除外する。

### 4.3 送信上限の共通化と AI 実行サービスの分離 (`requestLimits.ts`, `runAiTask.ts`)
1. `MAX_SCOPE_NODES = 200`、`MAX_SCOPE_EDGES = 400`、`MAX_REQUEST_BYTES = 1_000_000` および上限超過メッセージ（詳細図への分割案内を含む）を `requestLimits.ts` に一元化する。
2. `AiPanel.tsx` の実行処理（メッセージ構築・通信・JSON抽出・検証）を `runAiTask.ts` に分離し、コンポーネントの見通しとテスト容易性を向上させる。

---

## 5. 結果と影響 (Consequences)

### メリット
- **却下案の再提案・混入防止**: ユーザーが却下した候補が下位展開や要求説明書に紛れ込む問題が決定論的に解消された。
- **具体化節の事実性向上**: `concretization` が必ず詳細図のノードを根拠に持つようになり、抽象的な推測文の混入が防止された。
- **深い階層での展開精度向上**: `ancestry` により、サブ図や下位列のノードを展開する際にも最上位要求からの系譜が保持される。

### トレードオフ・考慮事項
- 詳細図を持たないプロジェクトで要求レポートを生成した場合、`concretization` 節は出力されなくなる（または検証で除外される）。これは「詳細図による具体化のみを `concretization` とする」設計意図どおりの挙動である。

### 影響ファイル
- `src/tools/tpdd/domain/requirementScope.ts`
- `src/tools/tpdd/services/llm/prompts.ts`
- `src/tools/tpdd/services/llm/aiSchemas.ts`
- `src/tools/tpdd/services/llm/requirementReportDocument.ts`
- `src/tools/tpdd/features/ai/requestLimits.ts`
- `src/tools/tpdd/features/ai/runAiTask.ts`
- `src/tools/tpdd/features/ai/RequestPreview.tsx`
- `src/tools/tpdd/features/ai/AiPanel.tsx`
- `src/tools/tpdd/features/ai/RequirementReportPanel.tsx`
- `tests/tpdd/features/aiProposal.test.ts`
- `tests/tpdd/domain/requirementScope.test.ts`
- `tests/tpdd/services/requirementReport.test.ts`
