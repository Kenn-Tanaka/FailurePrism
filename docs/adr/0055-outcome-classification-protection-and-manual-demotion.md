# ADR-0055: AI変動要因判定からの帰結ノード保護および手動での帰結解除・未判定復帰ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-20
- **Target Components**: `VTA Event Ledger`, `VTA Analysis Projection`, `VTA LLM Client`, `VTA Control Panel & Node Editor UI`
- **Related Requirements / ADRs**: [ADR-0001](file:///docs/adr/0001-two-stage-event-classification-and-batch-adoption.md), [ADR-0031](file:///docs/adr/0031-srk-and-three-failure-factors-variation-classification-and-countermeasure-alignment.md), [ADR-0050](file:///docs/adr/0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md), [ADR-0054](file:///docs/adr/0054-per-event-outcome-kind-defaulting-and-mixed-outcome-audit.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. **AI変動要因判定による帰結ノードの上書き暴走**:
   - VTA ツリー生成後に「確定したイベントの変動要因を判定」を実行すると、既に同定されている帰結ノード（例: 「A機乗組員死亡確認」「A機機長脱出」）が `⚠️ 変動要因`（人為逸脱・対策: 排除）や `🛡️ 変動: レジリエンス` に書き換わってしまう重大な不具合が発生した。
   - 原因は 5 層の連鎖によるものであった：
     1. 台帳パース時（`inspectLedger`）に帰結イベントの `classification` が `'unclassified'` のまま初期化されていた。
     2. UI（`ScenarioInputSection`, `ControlPanel`）が帰結イベントを未判定件数にカウントし、「変動要因を判定」ボタンを表示していた。
     3. `classifyEventDraft` および `classificationInput` が帰結イベントを未判定イベントとして LLM プロンプトに送信していた。
     4. `inspectClassifications` が LLM の誤判定（`variation`）で帰結イベントを上書きしていた。
     5. `projectAnalysis` 内の `hasExplicitNonOutcome` 条件により、イベント分類が `outcome` 以外になると帰結ノードの `type` が `variation` に強制変換されていた。

2. **誤って帰結ノードに分類されたイベントの手動解除不可**:
   - AI が誤って帰結に含めたノードを人間がレビューして「未判定（未分類）」に戻そうとしても、カード編集モーダル（`NodeEditorModal`）に「未判定」ボタンがなく、イベント一覧（`EventReviewPanel`）の分類変更も `analysis.outcome.eventIds` の除外と連動していなかった。

3. **副次的発見（自己レビューによるバグ検知）**:
   - `NodeEditorModal.tsx` の `handleSubmit` において、`variationCategory === 'departure'`（人為逸脱：過信/無視/無知）の `cognitiveLevel` が保存対象から漏れていた（`response` のみ保存されていた）。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **自動処理における帰結の不可侵性**: 事故の終局損失（死亡確認・衝突等）が AI の変動要因判定によって「排除すべき変動要因」へ化けることは、VTA の根本原則に反するため完全に防止する。
- **人間のアナリストによる修正自由度**: AI が誤って帰結に分類したイベントは、カード編集モーダルおよびイベント一覧パネルのいずれからも手動で「未判定（未分類）」「通常作業」「変動要因」へ解除・変更でき、かつ `analysis.outcome`（代表種別含む）と完全同期されなければならない。
- **後方互換性**: 過去に保存されたプロジェクト JSON（帰結イベントの `classification` が `'unclassified'` のままのもの）に対しても、AI 判定除外と UI 表示・手動解除が破綻なく動作すること。

---

## 3. 検討した選択肢 (Considered Options)

- **オプションA: 帰結ノードを一切編集・解除不可にする**
  - *問題点*: AI の抽出誤りで本来は中間イベントであるものが帰結に混入した場合、人間が修正できず分析の妥当性が損なわれる。
- **オプションB: AI 自動判定からの多層防護と、手動レビューによる帰結解除・同期の両立（採用）**
  - AI による自動判定パス（`classifyEventDraft`, `classificationInput`, `inspectClassifications`, `applyEventClassification`, `batchAdoptPreliminary`）では `isIdentifiedOutcomeEvent` で帰結イベントを厳格に保護・除外する。
  - 手動変更パス（`NodeEditorModal` / `EventReviewPanel` / `reconcileAnalysis`）では、帰結 ⇄ 未判定・通常・変動 の双方向遷移を可能にし、`analysis.outcome` のメンバーシップと代表種別（`loss` > `near_miss` > `recovery`）を自動同期する。

---

## 4. 決定事項 (Decision Outcome)

1. **台帳初期化と AI 変動要因判定の多層防護**:
   - `eventLedger.ts: inspectLedger`: 同定済み帰結イベント（`parsedOutcome.status === 'identified'` の `eventIds`）の初期 `classification` を `'outcome'` に設定する（`outcome_kind` の後方互換契約は維持）。
   - `eventLedger.ts: classificationInput` / `inspectClassifications`、`client.ts: classifyEventDraft`、`eventAnalysis.ts: applyEventClassification`: 未判定抽出から `isIdentifiedOutcomeEvent` および `ignored` イベントを除外。LLM が余分に帰結行を返した場合も静かに無視して保護する。
   - `eventAnalysis.ts: projectAnalysis`: `hasExplicitNonOutcome` 迂回を撤廃し、`analysis.outcome.eventIds` に属するイベントまたは `classification === 'outcome'` のカードは常に `type: 'outcome'` とする。

2. **手動での未判定復帰・帰結解除と代表種別再集計**:
   - `eventAnalysis.ts`: 共通純粋関数 `resolveRepresentativeOutcomeKind` および `setEventClassificationWithOutcomeSync` を導入。手動で帰結イベントを `unclassified` 等へ変更した際、`analysis.outcome.eventIds` からの除外、`outcome_kind` の削除、および残存帰結の代表種別再集計（全件解除時は `status: 'not_found'`）を一貫実行する。
   - `reconcileAnalysis`: 帰結ノードのタイトル・時刻編集だけでは `unclassified` にリセットしないよう保護しつつ、種別変更による帰結解除・昇格時は代表種別を再集計する。
   - `NodeEditorModal.tsx`: ノード種別に **「未判定(点線)」** ボタンを追加（2×2グリッド）。また帰結ノード選択時の排除対策 (`measure_type`) を自動クリアし、`departure` カテゴリでの `cognitiveLevel`（過信/無視/無知）保存漏れを修正。
   - `EventReviewPanel.tsx`: 分類ドロップダウンに `<option value="outcome">帰結</option>` を追加し、旧データ互換の表示値（`isIdentifiedOutcomeEvent ? 'outcome' : event.classification`）と `setEventClassificationWithOutcomeSync` による即時連動を実装。
   - `ScenarioInputSection.tsx` / `ControlPanel.tsx`: 未判定イベント件数・判定ボタン活性条件から帰結イベントおよび無視イベントを除外。

---

## 5. 結果と影響 (Consequences)

### メリット
- 「変動要因を判定」を実行しても、乗組員死亡確認などの帰結ノードが変動要因や排除対象へ書き換わる事故が完全に根絶される。
- 一般イベントがすべて判定済みであれば、帰結イベントが残っていても不要な「未判定」バッジや判定ボタンが表示されない。
- 誤って帰結とされたノードは、カード編集モーダルまたはイベント一覧からワン操作で「未判定（点線）」に戻し、一般イベントとして再判定できる。
- 人為逸脱（過信/無視/無知）の行動レベルがカード編集モーダルから正しく永続化される。

### トレードオフ・考慮事項
- 旧プロジェクト JSON で帰結イベントが `classification: 'unclassified'` のまま保存されていても、`isIdentifiedOutcomeEvent` による多重ガードと UI 表示補正によりそのまま安全に運用できる。

### 影響ファイル
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/services/llm/client.ts`
- `src/tools/vta/components/ControlPanel.tsx`
- `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`
- `src/tools/vta/components/control-panel/EventReviewPanel.tsx`
- `src/tools/vta/features/vta/components/NodeEditorModal.tsx`
- `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
- `src/tools/vta/services/llm/eventPipeline.test.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.test.ts`
- `docs/adr/0055-outcome-classification-protection-and-manual-demotion.md`
- `docs/adr/README.md`
