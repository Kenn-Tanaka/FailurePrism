# ADR-0050: 親組織ハブ昇格統合・粒度反復の実質改善採択および帰結イベント仮判定除外ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-19
- **対象コンポーネント**: VTA Subject Consolidation (`subjectRanking.ts`), Granularity Refinement (`granularityRefinement.ts`), Preliminary Classification & Adoption (`client.ts`, `eventAnalysis.ts`, `evidenceNotes.ts`, `EventReviewPanel.tsx`, `ScenarioInputSection.tsx`), AI Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0001](file:///docs/adr/0001-two-stage-event-classification-and-batch-adoption.md), [ADR-0008](file:///docs/adr/0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0016](file:///docs/adr/0016-preliminary-classification-pipeline-separation.md), [ADR-0044](file:///docs/adr/0044-connection-proposal-prefilter-history-preservation-and-diagnostics-accuracy.md), [ADR-0048](file:///docs/adr/0048-resilience-outcome-separation-and-avoidcards-clearance.md)

## 1. コンテキストと課題 (Context & Problem Statement)

1. **親組織の「その他の関係者」落ちと Merge Guard 過剰発火によるレーン数膨張**:
   - 多数の構成員を含む組織（例: 除草薬散布作業班 `A_team` 配下に10名）では、個別作業員が上位スコアを占め、直接イベント数が少ない親組織 `A_team` が上位保持枠（`keepCount`）から漏れることがある。
   - 現行の [`rankSubjects`](file:///src/tools/vta/features/vta/utils/subjectRanking.ts) では親組織 `A_team` 自身が `subject_others` に統合されるため、親組織自身の直接関与（例: `E13`）が「その他の関係者」レーンに出現する一方、同親の超過兄弟が [`resolveParentTarget`](file:///src/tools/vta/features/vta/utils/subjectRanking.ts) の Rule 3 にフォールバックし、[`evaluateMergeGuard`](file:///src/tools/vta/features/vta/utils/subjectRanking.ts) の広範な全イベント履歴チェックにより情報伝達関係でも次々と `retainedIds` に追加され、`maxSubjects=6` に対して 10 レーン（`C1=0.33`）へ膨張していた。
2. **粒度反復の同点・無変化採択と構造ボトルネックの非伝達**:
   - [`refineGranularity`](file:///src/tools/vta/services/generation/granularityRefinement.ts) の初回 LLM レビュー（`!hasLLMScoreBaseline`）では `#0` の比較基準にも同じ `C2/C4/scenarioScore` を充てるため、可視エッジ・カード数・機械指標（`C1, C3, C5`）が一切改善しない `add_relation`（`before` 追加等で `edges: 58 -> 58`）でも `nextScore >= comparableBestScore`（同点）により `採用=はい` となり、余分な反復が発生していた。またプロンプトへ `C1`/`C3`/`C5` やレーン超過・カード過密情報が渡されていなかった。
3. **帰結イベントへの `variation` 仮判定付与と一括採用による帰結カード消失**:
   - [`populatePreliminaryClassifications`](file:///src/tools/vta/services/llm/client.ts) が同定済み帰結イベント（`analysis.outcome.eventIds`）を除外せず全イベントへ仮判定を行っていたため、損失帰結にも `preliminary: 'variation'` が付与され得た。これを [`batchAdoptPreliminary`](file:///src/tools/vta/features/vta/utils/eventAnalysis.ts) 等で一括採用すると `classification='variation'` に上書きされ、[`projectAnalysis`](file:///src/tools/vta/features/vta/utils/eventAnalysis.ts) の `hasExplicitNonOutcome` 判定が反転して帰結カードが変動要因カードへ書き換わる問題があった。また `aiDiagnostics.ts` から仮判定の種別内訳や帰結への混入を観測できなかった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- ADR-0008 が保護する真の非対称性・直接介入（風防脱落の機長 vs 副操縦士、製造 vs 品証、IT運用 vs CSIRT、`loss vs recovery`）および小規模検証フィクスチャ（`limit=2` での `subject_others` ドリルダウン等）を一切損なわないこと。
- ユーザーによる手動編集（帰結カードから通常/変動への明示的解除）は引き続き `reconcileAnalysis` により尊重すること。
- AI 診断パッケージの既存フォーマット互換性を維持しつつ、仮判定の内訳と異常検知を追跡可能にすること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1**: `maxSubjects` 超過時に `Rule 3` を全面廃止し、厳格に `effectiveLimit` で打ち切る。
  - 同一組織内に損失側とレジリエンス回復側が混在する場合（ADR-0008）まで `subject_others` 落ちを許容することになるため却下。
- **選択肢2（採用）**: 複数超過子主体を抱える上位親組織を統合ハブとして優先昇格しつつ、Merge Guard の `transfer`/`dependency` 検査を当該エッジ端点へ限定し、さらに真の非対称（`strictAsymmetry`）を持たない情報伝達のみによる `effectiveLimit` 超過を抑制する。粒度反復では厳密スコア上昇または図構造・機械指標の改善を要求し、帰結イベントを仮判定・一括採用の対象外とする。

## 4. 決定事項 (Decision Outcome)

1. **親組織ハブ昇格と Merge Guard 精密化 ([subjectRanking.ts](file:///src/tools/vta/features/vta/utils/subjectRanking.ts))**:
   - `promoteConsolidationHubs` を導入し、保持中の祖先を持たず超過側に `2` つ以上の非ブロック子孫を持つ上位親組織を、順位1位および優先主体・強制保持を傷つけない範囲で保持枠へ昇格（同親非優先子または非優先リーフと置換、または `subject_others` 回避枠へ昇格）し、子主体群を親組織レーンへ統合する。
   - `evaluateMergeGuard` の `transfer`/`dependency` 判定を「その関係自身の両端イベント」に限定するとともに、非回復の帰結イベントに誤付与された未確定 `preliminary: 'variation'` を除外する `isEffectiveVariationEvent` を導入。さらに `strictAsymmetry` フラグにより、真の非対称・直接介入のない兄弟のみで `effectiveLimit` を無制限に超えないよう制御する。
2. **粒度反復の実質改善ガードとボトルネック通知 ([granularityRefinement.ts](file:///src/tools/vta/services/generation/granularityRefinement.ts))**:
   - `#1`（`!hasLLMScoreBaseline`）では機械スコア増・可視カード数減・可視エッジ数増・厳密スコア改善のいずれかが伴わない同点変更を不採用とする。
   - `buildReviewUserPrompt` に現在のレーン数・カード数と `C1`/`C3`/`C5` および `merge`/`group`/`suppress` 改善指針を注入し、`GRANULARITY_REVIEW_SYSTEM_PROMPT` でも `add_relation` に順序のみの `before` ではなく意味関係を使うよう案内する。
3. **帰結イベントの仮判定・採用除外と診断観測性 ([eventAnalysis.ts](file:///src/tools/vta/features/vta/utils/eventAnalysis.ts), [client.ts](file:///src/tools/vta/services/llm/client.ts), UI, [aiDiagnostics.ts](file:///src/tools/vta/services/diagnostics/aiDiagnostics.ts))**:
   - 共通述語 `isIdentifiedOutcomeEvent` を追加し、`populatePreliminaryClassifications`、`batchAdoptPreliminary`、`adoptPreliminary`、`evidenceNotes`、および UI 仮判定カウント集計で同定済み帰結イベントを除外・保護する。
   - `populatePreliminaryClassifications` の記録データを `debugRecorder`（`preliminary.classification`）へ出力し、`aiDiagnostics.ts` の `pipeline_transitions` に内訳（`variation`, `normal`, `undetermined`, `outcome_excluded`）と `OUTCOME_PRELIMINARY_VARIATION` 異常検知を追加する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 多数の作業員が関与する組織事故において親組織が「その他の関係者」へ誤統合されず、配下の超過作業員を親組織レーンへ統合して `maxSubjects` 近傍の健全な `C1`/`C5` を維持できる。
  - エッジ・カード数無改善の `#1` 同点採択による無駄な `#2` 反復呼び出しを防止できる。
  - 帰結イベントが一括採用等で誤って変動要因カードへ書き換わる事故を防ぎ、診断ログから仮判定の内訳も直接確認可能になる。
- **トレードオフ・考慮事項**:
  - 帰結イベントをユーザーが意図的に通常/変動要因へ変更したい場合は、キャンバス／編集モーダル上で種別を直接変更する（`reconcileAnalysis` により `outcome.eventIds` から外れる）導線を用いる。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/services/generation/granularityRefinement.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/features/vta/utils/evidenceNotes.ts`
  - `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/components/control-panel/EventReviewPanel.tsx`
  - `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
