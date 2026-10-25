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
