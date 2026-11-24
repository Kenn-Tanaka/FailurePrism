# ADR-0069: 意図的非投影関係の診断一元化・自動接続「要確認」項目の監査証跡保存および ignored イベントの未割当除外統一ポリシー

- **Status**: Accepted
- **Date**: 2026-11-22
- **Target Components**: `src/tools/vta/features/vta/utils/graphDiagnostics.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`, `src/tools/vta/features/vta/utils/connectionProposals.ts`, `src/tools/vta/services/generation/autoConnectionService.ts`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`, `src/tools/vta/features/vta/utils/unassignedEvents.ts`, `src/tools/vta/components/control-panel/UnassignedEventsPanel.tsx`, `src/tools/vta/features/vta/components/ConnectionProposalModal.tsx`
- **Related Requirements / ADRs**: ADR-0010, ADR-0011, ADR-0050, ADR-0066, ADR-0067, ADR-0068

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線新鹿沼駅構内触車事故の自動生成診断トレース（`2026-11-21T17:24:28.010Z`）の解析および横断レビューにおいて、以下の3つの課題が確認された。

1. **`graphDiagnostics.missingRelations` と `isIntentionallyUnprojected` の判定乖離による不要な `chain.repair` LLM通信と完了判定の偽陰性**:
   - `consolidateSubjects` で細粒度主体（例：`A_LEAD`, `H_WORK`）を上位主体（`S_TEAM`）へ統合すると、ロスレス復元（`revertConsolidation`）およびドリルダウン（ADR-0011）のために `sourceEntityOrigin` / `targetEntityOrigin` を保持したまま両端が `S_TEAM` に書き換わる。
   - 同一イベント（またはグループ化された同一カード）内の統合メンバー間の関係は `source.id === target.id` に解決されるため、`projectAnalysis` は自己ループ線を生成せず、`recordGraphProjectionDebug` も正常な非投影と判定する。
   - しかし `graphDiagnostics.ts` は `r.kind !== 'before'` と `omittedEdges` しか除外していなかったため、カード内に畳み込まれた関係や `ignored` イベントの関係を `missingRelations` と誤判定し、`autoConnectVTA` の Stage 2 事前トリアージ（`isAlreadyFullyConnected`）を不成立にして約20〜25秒の不要な `proposeChainRepair` 全文LLM通信（`差分候補 0行`）を発火させていた。またトリアージの判定理由も診断ログに記録されていなかった。
2. **自動接続パイプラインにおける `connection.proposal` の `[要確認]` 項目のサイレント破棄**:
   - 手動の接続提案モーダルでは `result.reviews` を利用者に提示し、`chain.repair` では `[要確認]` 行を `analysis.dispositions`（`kind: 'review'`）へ保存するのに対し、`autoConnectVTA` では `proposalResult.reviews` を参照せず破棄していた。また `parseConnectionProposalTSV` の `[要確認]` パーサで空の原文参照セル（`sourceRefs.length === 0`）を弾いていなかった。
3. **`ignored` イベントの未割当フィルタ漏れ**:
   - `UnassignedEventsPanel.tsx`、`ConnectionProposalModal.tsx`、`unassignedEvents.ts`、および `graphDiagnostics.ts` において `!e.ignored` の除外が漏れており、帰結後除外（`post_outcome`）や利用者削除（`user`）でカードが剪定されたイベントが「未割当イベント」として誤表示されたり、`assignUnassignedEvent` 実行時に `analysis.unassignedEventIds` へ再混入する問題があった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **単一情報源（SSOT）と非循環モジュール構造**: 意図的非投影の判定ロジックを1箇所に集約しつつ、`eventAnalysis.ts` ⇔ `graphDiagnostics.ts` 間の循環 import を防ぐこと。
- **`validateDispositions` 契約との完全整合**: `validateSavedAnalysis` 内の厳格バリデーション（非空 `text`、一意 `id`、実在 `sourceRefs`）で例外を起こし、採択済みの有効接続を巻き添えでロールバックさせないこと。また再実行時に重複エントリを蓄積させないこと。
- **診断可能性の確保**: Stage 2（`chain.repair`）のスキップ／発火理由を `AIDiagnosticsPackage` の `Pipeline State Transitions` で即座に判別できること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A**: `consolidateSubjects` 時点で同一カードに帰着する関係を `analysis.relations` から物理削除する。
  - 却下理由：`revertConsolidation` による統合解除時に元の細粒度主体間の関係が失われ、ロスレス往復保証に違反する。
- **選択肢 B（採用）**: `graphDiagnostics.ts` に `isIntentionallyUnprojectedRelation` を実装して `eventAnalysis.ts` と共有し、`autoConnectVTA` で `[要確認]` の `dispositions` 永続化と `chain-repair.triage` 記録を追加し、全未割当判定で `ignored` イベントを除外する。

## 4. 決定事項 (Decision Outcome)

1. **意図的非投影関係の一元判定 (`graphDiagnostics.ts`, `eventAnalysis.ts`)**:
   - `isIntentionallyUnprojectedRelation` を `graphDiagnostics.ts` に定義・公開し、`before`・`omittedEdges`・欠損または `ignored` イベント・同一イベント同一主体・および解決先カードが `source.id === target.id` となる関係を意図的非投影として `missingRelations` から除外した。`recordGraphProjectionDebug` も同関数を呼び出すよう統一した。
2. **Stage 1 `[要確認]` の監査証跡保存と Stage 2 トリアージ記録 (`connectionProposals.ts`, `autoConnectionService.ts`, `aiDiagnostics.ts`)**:
   - `parseConnectionProposalTSV` の `[要確認]` 行で `!sourceRefs.length` を不正行として除外した。
   - `autoConnectVTA` で `proposalResult.reviews` を重複排除のうえ `analysis.dispositions`（`kind: 'review'`, `text: 'レーン間接続の要確認'`）へ保存し、`validProposals.length === 0` でも `reviews` が存在する場合は保存処理を実行するようにした。
   - `chain-repair.triage` ステージを `debugRecorder` に記録し、`aiDiagnostics.ts` でスキップ時・実行時の判定内訳と `要確認保存 N件` を出力するようにした。
3. **`ignored` イベントの未割当除外統一 (`graphDiagnostics.ts`, `unassignedEvents.ts`, `UnassignedEventsPanel.tsx`, `ConnectionProposalModal.tsx`)**:
   - 未割当イベントの抽出・検証・再計算のすべてで `!e.ignored` を徹底した。

## 5. 結果と影響 (Consequences)

### メリット
- 主体統合やカードグループ化を含む完全連結グラフで不要な `proposeChainRepair` 全文LLM通信が確実にスキップされ、自動生成時間を約20〜25秒短縮できるとともに、`graphDiagnostics.complete` が正しく `true` を返すようになる。
- 自動接続パイプラインでも AI が検出した判断保留事項（`[要確認]`）が `analysis.dispositions` に保全され、後から監査・確認できる。
- 帰結後除外イベントや削除済みイベントが未割当パネル・接続提案モーダルに誤表示されなくなる。

### トレードオフ・考慮事項
- 本当に端点カード解決に失敗している異常な関係（別カード間であるべきだが関与不整合等でエッジ化されなかった関係）は引き続き `missingRelations` として検出される。

### 影響ファイル
- `src/tools/vta/features/vta/utils/graphDiagnostics.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/features/vta/utils/connectionProposals.ts`
- `src/tools/vta/features/vta/utils/unassignedEvents.ts`
- `src/tools/vta/components/control-panel/UnassignedEventsPanel.tsx`
- `src/tools/vta/features/vta/components/ConnectionProposalModal.tsx`
- `src/tools/vta/services/generation/autoConnectionService.ts`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `src/tools/vta/services/generation/autoConnectionService.test.ts`
- `src/tools/vta/features/vta/utils/connectionProposals.test.ts`
- `tests/vta/aiDiagnostics.test.ts`
