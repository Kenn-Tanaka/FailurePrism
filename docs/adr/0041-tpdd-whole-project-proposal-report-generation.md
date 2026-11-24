# ADR-0041: TPDD 全体提案書・説明文生成機能の刷新と外部AI（Gemini / ChatGPT）連携構造化出力

## メタデータ
- **ステータス**: Accepted
- **決定日**: 2026-11-17
- **対象コンポーネント**: `requirementScope.ts`, `prompts.ts`, `aiSchemas.ts`, `requirementReportDocument.ts`, `RequirementReportPanel.tsx`, `AiPanel.tsx`, `requirementScope.test.ts`, `requirementReport.test.ts`
- **関連要件 / ADR**: ADR-0018, ADR-0019

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. 従来の TPDD-Editor の「説明文生成」機能は、ユーザが単一の「起点ノード」をドロップダウンで選択し、そのノードから下位の分解部分木のみを説明する仕様であった。
2. しかし実際の利用場面では、特定の 1 ノードだけでなく、TPDD-Editor で思考展開（設計）したシステム・プログラム・プロジェクトの**全体像**を提案書形式や任意の文書形式にまとめ、さらに **Gemini や ChatGPT に読み込ませてプレゼンテーション資料や提案書へ展開できるテキスト**を出力したいニーズが高まった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **起点ノード指定の廃止とプロジェクト全体の網羅**:
   - 起点ノードの手動選択を不要とし、ルート図から全有効図・詳細図にわたる設計内容およびプロジェクト詳細説明（`project.title`, `project.description`）を一括収集すること。
   - ただし、明示的に却下（`status === 'rejected'`）されたノード、却下ノードのみにぶら下がる下位部分木、および却下ノード所有の詳細図は引き続き除外すること。
2. **文書形式プリセットとユーザ指定フォーマットへの対応**:
   - 提案書・企画書形式（既定）、プレゼンテーション資料構成形式、システム・プログラム設計概要書形式、およびユーザ自由指定形式を選択・指示できること。
3. **Gemini / ChatGPT 連携最適化**:
   - 出力された Markdown をそのままコピー＆ペーストして外部 AI に渡すだけでプレゼン資料や提案書を作成できるよう、作成指示プロンプト枠（ON/OFF 可能）と、抽象度列（Level）別・図階層別・関係種別の構造化設計台帳を同梱すること。
4. **`AGENTS.md` の要求レポート検証規約の完全維持**:
   - `validateRequirementReportResponse` の根拠検証ルール（`requirement` の最上位要求引用、`breakdown`/`realization` の `decomposition` エッジ引用、`concretization` の詳細図ノード引用、構文有効時の全件除外は `valid: true, data: { sections: [] }, warnings`）を維持しつつ、複数最上位ノード（`rootNodeRefs`）に対応すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: LLM に自由形式の Markdown を直接出力させる（根拠検証 JSON を廃止する）。
  - 根拠のない創作や却下ノードの混入を機械的に排除できなくなり、`AGENTS.md` の検証規約にも反するため不採用。
- **選択肢B (採用)**: プロジェクト全体スコープ収集（`collectProjectReportScope`）＋複数最上位ノード対応の根拠検証 JSON＋外部 AI 連携用 Markdown 合成（`buildRequirementReportMarkdown`）。
  - 厳格な事実性・根拠検証と、Gemini / ChatGPT が扱いやすい構造化提案テキスト出力を両立できる。

---

## 4. 決定事項 (Decision Outcome)

1. [`requirementScope.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/domain/requirementScope.ts) に [`collectProjectReportScope`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/domain/requirementScope.ts#L319) を新設し、起点ノード指定なしでプロジェクト全体の非却下ノード・エッジ・詳細図・最上位ノード群（`rootNodeRefs`）・プロジェクト説明を収集する。
2. [`prompts.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/services/llm/prompts.ts) に `ReportDocumentFormat`（`proposal` / `presentation` / `design_overview` / `custom`）を導入し、形式別の論理構成指示とプロジェクト全体データを送信する。
3. [`aiSchemas.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/services/llm/aiSchemas.ts) の `RequirementReportValidationContext` を `rootNodeRefs`（複数最上位ノード集合）に対応させる。
4. [`requirementReportDocument.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/services/llm/requirementReportDocument.ts) で、Gemini / ChatGPT 向け作成指示ヘッダ、プロジェクト背景説明、文書形式別セクション見出し、および抽象度列（Level）別・関係別の構造化設計台帳を出力する。
5. [`RequirementReportPanel.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/features/ai/RequirementReportPanel.tsx) から起点ノード選択ドロップダウンを廃止し、文書形式選択・追加指示入力・外部 AI 指示プロンプト同梱トグルを配置する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 起点ノードを選ぶ手間なく、プロジェクト全体の思考展開結果をワンクリックで提案書・プレゼン構成案・設計概要書形式のテキストにまとめられる。
  - 出力 Markdown を Gemini や ChatGPT にそのまま貼り付けるだけで、根拠に忠実なプレゼンテーション資料や提案書を作成できる。
- **トレードオフ・考慮事項**:
  - プロジェクト全体を対象とするため、大規模プロジェクトで送信上限（200 ノード、400 エッジ、1MB）を超える場合は上限エラーメッセージを表示する。
- **影響を受けるファイル・テスト**:
  - [`src/tools/tpdd/domain/requirementScope.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/domain/requirementScope.ts)
  - [`src/tools/tpdd/services/llm/prompts.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/services/llm/prompts.ts)
  - [`src/tools/tpdd/services/llm/aiSchemas.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/services/llm/aiSchemas.ts)
  - [`src/tools/tpdd/services/llm/requirementReportDocument.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/services/llm/requirementReportDocument.ts)
  - [`src/tools/tpdd/features/ai/RequirementReportPanel.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/features/ai/RequirementReportPanel.tsx)
  - [`src/tools/tpdd/features/ai/AiPanel.tsx`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/tpdd/features/ai/AiPanel.tsx)
  - [`tests/tpdd/domain/requirementScope.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/tests/tpdd/domain/requirementScope.test.ts)
  - [`tests/tpdd/services/requirementReport.test.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/tests/tpdd/services/requirementReport.test.ts)
