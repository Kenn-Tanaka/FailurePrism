# FailurePrism Agent Instructions

## Verification Rules

- Before completing an implementation change, run `npm run typecheck` and `npm test`.
- Run `build.bat` for changes that affect packaging, build scripts, dependencies, or release artifacts. Do not use `-SkipTests` as a substitute for a successful test run.
- When changing dependencies, keep `package-lock.json` in sync and verify with `npm ci` in addition to the normal checks.

## TPDD Requirement Report Validation

- Treat a syntactically valid requirement-report response as valid even when every statement is discarded by evidence validation. Return `data: { sections: [] }` and one or more warnings in that case.
- Reserve `valid: false` for malformed response data or a syntactically valid response that contains no statements and produces no validation warnings.
- Preserve the evidence rules: a `requirement` statement must cite the selected root node; `breakdown` and `realization` statements must cite a decomposition edge; unknown or out-of-scope references must discard the statement with a warning.
- When changing `validateRequirementReportResponse`, update `tests/tpdd/services/requirementReport.test.ts`. Cover evidence-backed output, statement exclusion with warnings (including an empty resulting report), and malformed output.

## Architecture Design Records (ADR) Maintenance

- When introducing, modifying, or deprecating significant architectural decisions (e.g. data schema alterations, pipeline redesigns, visual representation/geometry policies, LLM factuality rules, or file ingestion constraints), record the architectural decision in `docs/adr/`.
- **File Naming**: Use `docs/adr/NNNN-<kebab-case-title>.md` with a 4-digit zero-padded incremental counter (e.g. `0006-....md`).
- **Index Registration**: Always register the new or modified ADR in `docs/adr/README.md` (update the ADR Index table with ID, title link, status, decision date, and concise summary).
- **ADR Structure**: Follow the established template:
  - Title and Metadata: `Status` (`Proposed` | `Accepted` | `Superseded by ADR-xxxx` | `Deprecated`), `Date` (`YYYY-MM-DD`), `Target Components`, `Related Requirements / ADRs`.
  - `1. コンテキストと課題 (Context & Problem Statement)`
  - `2. 決定理由の要因・制約 (Decision Drivers)`
  - `3. 検討した選択肢 (Considered Options)`
  - `4. 決定事項 (Decision Outcome)`
  - `5. 結果と影響 (Consequences: メリット, トレードオフ・考慮事項, 影響ファイル)`

## VTA Design Principles

- **Formal Mathematical Model Over Ad-Hoc Subject Semantics**:
  - Do not stack ad-hoc deterministic semantic rules, domain-specific heuristics, or brittle conditional flags (e.g., special-casing organization kinds or fixed card-count cutoffs) for subject classification, retention, or peripheral consolidation.
  - Base deterministic lane consolidation, retention, and peripheral folding on a unified formal mathematical model defined over graph-structural **subject weights** (participation/role weights, outcome proximity, focus prior, coupling centrality) and **inter-subject relation weights / distances**, alongside Poset and outcome structural invariants.
- **Consolidation of Unrelated Subjects as Discovery of an Unknown Poset Parent**:
  - When consolidating subjects $S$ that do not stand in an existing Poset parent-child relation, never destroy or overwrite existing Poset relations.
  - Model non-hierarchical grouping (including `role_group` and `subject_others`) as **conservative Poset extension (discovery of an unknown 0-event parent $P$)**: preserve all existing order relations ($\forall x, y \in V,\; x \preceq y \iff x \preceq' y$), add $s \prec P$ for every $s \in S$, place $P$ immediately beneath the minimal common ancestors of $S$ (or as a new root when $S$ has no common ancestors), and enforce 0-event hub antichain completeness (`HG2c`).
- **LLM-Driven Partial-Order Temporal Ordering**:
  - Do not add deterministic regex parsers or heuristics to interpret range timestamps, relative time expressions, or narrative flashbacks, which are fragile to phrasing variations.
  - Delegate partial-order temporal ordering for range, relative, and approximate timestamps—as well as retrospective/multi-perspective narrative sections—to the LLM's semantic understanding primarily via explicit `[関係] before` edges (with chronological `[イベント]` ordering as an auxiliary aid), while preserving the original time expressions verbatim.



