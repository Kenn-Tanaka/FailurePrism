# ADR-0054: 混合帰結における一次損失デフォルト確定・代表種別再集計および幾何監査整理

- **Status**: `Accepted`
- **Date**: 2026-11-19
- **Target Components**: `VTA Event Ledger`, `VTA Analysis Projection`, `VTA AI Diagnostics`, `VTA Layout Engine`
- **Related Requirements / ADRs**: [ADR-0007](file:///docs/adr/0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0048](file:///docs/adr/0048-resilience-outcome-separation-and-avoidcards-clearance.md), [ADR-0053](file:///docs/adr/0053-vta-stream-idle-timeout-and-reasoning-effort-control.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. **損失ノードがグリーン（`recovery`）で描画される不具合**:
   - 2024年1月2日羽田空港事故解析ログ（`2026-11-19T11:24:44.739Z`, Claude Sonnet 5.5）において、帰結イベント群（`E34, E35, E53, E54, E55, E50:recovery, E52:recovery`）のうち、衝突・炎上等の一次的損害イベント（`E34〜E55`）までがグリーン（`outcome_kind: 'recovery'`）で描画される問題が観測された。
   - プロンプト指示（`OUTCOME_EXTRACTION_POLICY`）は「主要な事故損失イベントIDはそのまま（または :loss）、二次的脱出完了等の回復帰結のみ `:recovery` サフィックスを付与」と定めていた。
   - しかし台帳パーサー（`eventLedger.ts`）では、サフィックスなしのイベントIDは個別種別マップ（`outcomeKindsByEventId`）に登録されず `undefined` となり、集約代表種別が明示登録された `['recovery', 'recovery']` のみから `parsedOutcome.kind = 'recovery'` と算出されていた。
   - キャンバス投影時（`eventAnalysis.ts:projectAnalysis`）、各イベントの個別種別が存在しない場合に全体の代表種別（`'recovery'`）がフォールバック適用された結果、一次損失ノードまで全てグリーンで描画されていた。

2. **幾何監査 `LAYOUT_CLOSE_VERTICAL_EDGES (0px)` の観測**:
   - 同ログの幾何監査（`layout.audit`）において、`shared:E13:card_53:card_9`（同一イベント共有カード結合線）と `relation:R2`（情報伝達関係線）の平行垂直線が 0px で重なっているアノマリーが報告された。
   - パイプライン全体（71カード・69ノード）は正常完了（`SUCCESS`）していたが、同一カードペア間の複数エッジにおける幾何監査の振る舞いを検証し、安定性を担保する必要があった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **セマンティクス正確性の保証**: 衝突・大破・炎上などの一次損失イベントが赤（ローズ系）ではなく緑（回復系）で描画されるのは、事故原因分析ツールとして重大な認知誤認を引き起こす。
- **プロンプト契約との整合性**: プロンプト側で「一次損失はサフィックス省略可、回復のみ明示 `:recovery`」と指示している以上、パーサー側でサフィックス省略ノードを確実に一次損失（`loss`）として確定させなければならない。
- **後方互換性の維持**: 全イベントIDがサフィックスなしの旧来ケース（種別列なし）において、既存の振る舞い（`outcome.kind` 未設定）を破壊しないこと。
- **可観測性の強化**: AI診断パッケージ（`aiDiagnostics`）において、帰結イベントごとの確定種別（`event_kinds`）を可視化し、即座に診断できるようにすること。

---

## 3. 検討した選択肢 (Considered Options)

- **オプションA: プロンプトで全件サフィックス必須化**
  - LLMに「すべてのイベントIDに必ず `:loss` または `:recovery` を付けよ」と指示を厳格化する。
  - *問題点*: LLMが省略した場合に容易に再発する。決定論的なパーサー側での防護がないため脆弱。
- **オプションB: 台帳パーサー後処理による混合帰結デフォルト確定・再集計（採用）**
  - 全 `[帰結]` 行のパース完了後、少なくとも1つのイベントに明示種別（`:loss`, `:near_miss`, `:recovery` または行種別列）が存在する場合、サフィックスなしのIDをすべて `'loss'` として確定登録する。
  - 全確定種別に基づき、代表種別（`parsedOutcome.kind`）を再集計する（`loss` 優先、次いで `near_miss`, `recovery`）。

---

## 4. 決定事項 (Decision Outcome)

1. **`eventLedger.ts`: 混合帰結のサフィックスなしIDデフォルト `'loss'` 確定**:
   - `typed('帰結', ...)` ループ完了直後に以下の後処理を追加:
     ```ts
     if (parsedOutcome && parsedOutcome.status === 'identified' && parsedOutcome.eventIds.length > 0) {
       const hasAnyExplicitKind = parsedOutcome.eventIds.some((id) => Boolean(outcomeKindsByEventId.get(id)));
       if (hasAnyExplicitKind) {
         for (const id of parsedOutcome.eventIds) {
           if (!outcomeKindsByEventId.has(id)) {
             outcomeKindsByEventId.set(id, 'loss');
           }
         }
         const allKinds = parsedOutcome.eventIds
           .map((id) => outcomeKindsByEventId.get(id))
           .filter((k): k is VTAOutcomeKind => Boolean(k));
         if (allKinds.includes('loss')) parsedOutcome.kind = 'loss';
         else if (allKinds.includes('near_miss')) parsedOutcome.kind = 'near_miss';
         else if (allKinds.includes('recovery')) parsedOutcome.kind = 'recovery';
       }
     }
     ```
   - これにより、`ev.outcome_kind` にサフィックスなしのイベント（`E34〜E55`）は確実に `'loss'` が格納され、`projectAnalysis` で `outcome_kind: 'loss'`（赤/ローズ）として描画される。
   - 二次回復帰結（`E50, E52`）のみが `outcome_kind: 'recovery'`（緑/エメラルド）として描画される。
   - 全体代表種別（`analysis.outcome.kind`）も正しく `'loss'` に確定する。

2. **`aiDiagnostics.ts`: 帰結個別種別 `event_kinds` の可視化**:
   - `AIDiagnosticsMeta['outcome']` に `event_kinds?: string[]` を追加。
   - `analysis.events` から帰結イベントの `outcome_kind` を抽出し、`["E34:loss", "E35:loss", "E50:recovery"]` として診断メタデータおよび Markdown に出力。
   - 既存テストとの互換性（未設定時はフィールド自体を出力しない）を保持。

3. **幾何監査整理と回帰検証**:
   - `layout.test.ts` に同一カードペア間に共有カードエッジとクロスレーン関係エッジが共存する構成の回帰テストを追加し、幾何監査が正常に動作することを確認。

---

## 5. 結果と影響 (Consequences)

### メリット
- **正確な因果視覚表現**: 羽田事故のような大事故シナリオにおいて、衝突・大破・炎上イベントが正しく赤色（損失）で強調され、脱出完了のみが緑色（回復帰結）で区別される。
- **代表種別の整合性**: 一次損失が含まれる事故において、全体代表種別が誤って `recovery` にならず、正しく `loss` に集約される。
- **診断性の向上**: AI Diagnostics トレースで各帰結ノードの種別付与状況が一目で把握できる。

### トレードオフ・考慮事項
- 全イベントがサフィックスなしの単純ケース（旧来データ）では、`hasAnyExplicitKind` が `false` となり、従来どおり `outcome.kind` は未設定（ノード描画時にデフォルトの `loss` が適用）されるため、既存テスト・過去データへの副作用はゼロ。

### 影響ファイル
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
- `tests/vta/aiDiagnostics.test.ts`
- `src/tools/vta/features/vta/utils/layout.test.ts`
- `docs/adr/0054-per-event-outcome-kind-defaulting-and-mixed-outcome-audit.md`
- `docs/adr/README.md`
