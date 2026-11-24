# ADR-0048: 緊急脱出・二次回復帰結のイベント別種別分離および avoidCards 水平離隔確保ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-18
- **対象コンポーネント**: VTA Ledger & Analysis (`eventLedger.ts`, `eventAnalysis.ts`, `variationFactor.ts`, `granularityScore.ts`), Prompts (`eventPrompts.ts`), UI & SVG (`VTANode.tsx`, `NodeEditorModal.tsx`, `svgExport.ts`), Edge Routing (`edgeRouting.ts`, `layout.ts`)
- **関連ドキュメント・コミット**: [ADR-0007](file:///docs/adr/0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0031](file:///docs/adr/0031-srk-and-three-failure-factors-variation-classification-and-countermeasure-alignment.md), [ADR-0046](file:///docs/adr/0046-cross-lane-wire-clearance-and-wiring-diagnostics.md)

## 1. コンテキストと課題 (Context & Problem Statement)
1. **脱出・回復帰結の損失誤表示**: 羽田空港事故等の複数帰結事例において、`[帰結]` に損失イベント（衝突・炎上）と二次的回復帰結（`Ｂ機全員脱出完了` 等）が同時に含まれる場合、従来の台帳は個別イベントの `outcome_kind` を表現できず、`projectAnalysis` も `analysis.outcome?.kind ?? ... ?? 'loss'` により全体代表値で全帰結カードを上書きしていたため、全員脱出完了まで赤色の「帰結: 損失発生」として表示されていた。また `batchAdoptPreliminary` / `adoptPreliminary` が `variationFactor` を生成せず、避難・救助文脈もレジリエンス判定パターンに含まれていなかった。
2. **`avoidCards` 迂回時の水平線 `0px` 重複 (`anomaly_2`)**: 中間障害物を避けて `avoidCards` が発動する複数エッジについて、`avoidCards` へ固定 `params.routeOffset` が渡され既配置水平帯を避けられなかったため、`relation:R12` と `relation:proposal:...` が同一 Y 座標（`0px`）で重なるケースが残存していた。

## 2. 決定理由の要因・制約 (Decision Drivers)
- 既存の4列／5列 `[帰結]` 台帳契約や保存データスキーマ（`VTAOutcomeKind = 'loss' | 'near_miss' | 'recovery'`）の後方互換性を壊さないこと。
- 脱出プロセス途中の救命・ドア開放判断は「変動: レジリエンス（ティール）」、全員脱出完了は「帰結: レジリエンス回復（緑）」として意味論的かつ視覚的に二層で明示すること。
- `eventLedger.ts` と `eventAnalysis.ts` の間で循環インポートを発生させないこと。

## 3. 検討した選択肢 (Considered Options)
- **選択肢1**: `[帰結]` から脱出系イベントをすべて除外し、`variation (resilient)` に一本化する。
  - 自動生成直後（仮判定採用前）に事後活動除外で脱出イベントが落ちるリスクがあり、終端の脱出完了も他カードに埋もれるため見送り。
- **選択肢2（採用：案A二層表現）**: 途中行動は `variation (resilient)`、終局の脱出完了は `outcome (outcome_kind: 'recovery')` としてイベント別に分離保持する。

## 4. 決定事項 (Decision Outcome)
1. **イベント別 `outcome_kind` 解析と優先順位逆転**: `[帰結]` の `イベントID` セルで `:recovery` / `:near_miss` / `:loss` サフィックス（および任意6列目・複数行統合時の個別保持）をサポートし、`projectAnalysis` で個別 `event.outcome_kind` を全体 `analysis.outcome?.kind` より優先適用する。
2. **レジリエンス抽出・採用補完の切り出し (`variationFactor.ts`)**: `extractVariationFactorFromReason` と否定誤爆ガード付き `isResilientReasonText` を独立モジュール化し、`batchAdoptPreliminary` / `adoptPreliminary` / `granularityScore.ts` で一貫利用する。
3. **UI・SVG ラベルの統一**: `recovery` の表示文言を「帰結: レジリエンス回復」（SVG `【帰結: 回復】`）とし、SVG 客体ドット・補足カード枠にも緑色系統を適用する。
4. **`avoidCards` 水平帯回避**: `avoidCards` に任意の `extraAvoidBands?: HorizontalBand[]` と拡張 Y 候補を追加し、`pickConflictAwareCorridorPath` から既配置水平線帯と `corridorOffsetY` を引き継ぐ。

## 5. 結果と影響 (Consequences)
- **メリット**:
  - 同一事故内で損失帰結（赤）と脱出回復帰結（緑）、および途中の安全判断（ティール）を明確に共存させられる。
  - `avoidCards` 発動時も含め平行水平線の `12px` 離隔が一貫して保たれる。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/variationFactor.ts`
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/components/control-panel/EventReviewPanel.tsx`
  - `src/tools/vta/services/generation/granularityScore.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `public/prompts.json`
  - `src/tools/vta/features/vta/components/VTANode.tsx`
  - `src/tools/vta/features/vta/components/NodeEditorModal.tsx`
  - `src/tools/vta/features/vta/utils/svgExport.ts`
  - `src/tools/vta/features/vta/utils/edgeRouting.ts`
  - `src/tools/vta/features/vta/utils/layout.ts`
