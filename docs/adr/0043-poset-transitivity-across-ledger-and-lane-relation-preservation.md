# ADR-0043: 台帳検証・投影・再同期へのSubjectPoset推移性一貫適用と同一レーン内意味関係エッジ保護ポリシー

- **ステータス**: `Accepted`
- **決定日**: 2026-11-18
- **対象コンポーネント**: `src/tools/vta/features/vta/utils/subjectPoset.ts`, `src/tools/vta/features/vta/utils/eventLedger.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`, `src/tools/vta/features/vta/utils/subjectRanking.ts`, `src/tools/vta/features/vta/utils/presentation.ts`, `src/tools/vta/features/vta/utils/sharedEvents.ts`, `src/tools/vta/features/vta/utils/laneConnections.ts`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- **関連ドキュメント・コミット**: [ADR-0008](file:///docs/adr/0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0010](file:///docs/adr/0010-subject-poset-dag-and-canonical-inclusion.md), [ADR-0012](file:///docs/adr/0012-chain-repair-delta-validation-and-relation-sanitization.md), [ADR-0025](file:///docs/adr/0025-ai-diagnostics-trace-hygiene-and-full-pipeline-observability.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港航空機衝突事故シナリオの実行トレース（AI Diagnostics Package v1.0）の診断により、上流から下流にわたる以下の 3つの構造的不整合が特定された：

1. **台帳初期検証における `SubjectPoset` 推移性契約（ADR-0010）の不適用**:
   - 下流の `validateParticipants`（`eventAnalysis.ts`）・`applyChainDelta`（`chainRepair.ts`）・`applyRefinementOps`（`granularityRefinement.ts`）はすでに `SubjectPoset` の `isAncestor` / `isDescendant` を用いて包含推移性を許容している。
   - 一方で上流の `inspectLedger`（`eventLedger.ts`）は、`[主体]` 処理で構築した `SubjectPoset` を `[関係]` 検証へ引き渡さず `participations` の厳密一致のみを検査していたため、子主体（`A1`, `A2`）が参加するイベント `E25` に対し親主体 `ORG_A_CREW` を指定した関係 `R5` が `RelationContractError` で早期拒絶され、不要な台帳修復と細粒度主体（`A2`）への情報劣化を招いていた。
   - さらに、`projectAnalysis`・`reconcileAnalysis`・`connectSharedEvents`・`protectedCardIds`・`consolidateSubjects` にも厳密一致前提および `subjectPoset` / `*EntityOrigin` の照合漏れが残存していた。
2. **同一レーン内へ統合された意味論的関係エッジおよび「その他の関係者」レーンの誤削除**:
   - `repairLaneConnections`（`laneConnections.ts`）は `sourceLane === targetLane` のすべてのエッジを時系列 `sequential` 線候補または飛び越し／重複線として扱っていた。
   - 主体統合（例: `B3` → `ORG_B_CABIN`）によって同一レーン内に入った `relationId` 付き意味関係エッジ（`dependency` や `transfer` 等、ユーザー手動編集により `generated: false` となった線を含む）が、非隣接なら「飛び越し線」として削除され、隣接なら `direction: 'sequential'` へ上書きされる欠陥があった。
   - また、`isOtherActorsLaneName`（「その他の関係者」）レーンを `expected` 構築時にスキップしながら、エッジ検査ループでは `!orders.has(sourceLane)` しか見ていなかったため、同レーン内のエッジも誤って削除対象となっていた。
3. **AI 診断トレース（`aiDiagnostics.ts`）の操作ログ状態分類ノイズ**:
   - `traceEntityLineage` が `operation` ステージの `warn`（台帳修復通知）や `info` ログを `d.type === 'error'` と区別せず `ORPHANED_ERROR` として記録し、また共有イベントの複数所属カードのうち先頭 1枚しか記録していなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **パイプライン全体での ADR-0010 推移性契約の一貫保証**: 上流の台帳検証から統合・投影・キャンバス編集再同期まで同一の Poset 判定基準を共有すること。
- **関係種別契約・テスト不変条件の厳守**: `dependency` の同一主体禁止（`validateRelationEndpoints`）や無関係主体参照（`R17` 相当）の検知は従来どおり維持すること。
- **循環依存のない共通ヘルパー化**: `subjectPoset.ts` に共通解決関数を集約し、`eventLedger` / `eventAnalysis` / `presentation` / `sharedEvents` 間のロジック重複と循環 import を回避すること。
- **ユーザー編集済みエッジおよび統合レーン意味エッジの非破壊保護**: `generated: false` となった `relationId` 付きエッジや `subject_others` レーン内の接続を誤削除しないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1: `inspectLedger` のみで Poset 解決を局所追加する**
  - *課題*: 複数子主体が関与する親主体端点（例: `E25` の `A1`・`A2` に対する `ORG_A_CREW`）がそのまま通過した場合、下流の `projectAnalysis`・`reconcileAnalysis`・`consolidateSubjects` でエッジ描画欠落や再同期削除が発生する。
- **選択肢 2 (採用): `subjectPoset.ts` 共通ヘルパーによる全段一貫 Poset 解決 ＋ `laneConnections.ts` 意味エッジ・集約レーン保護 ＋ `aiDiagnostics.ts` ログ分類是正**
  - *利点*: 上流からキャンバス編集まで Poset 推移性を矛盾なく保証し、かつ主体統合後や連鎖補完後の意味関係エッジ消失を根絶できる。

---

## 4. 決定事項 (Decision Outcome)

1. **共通 Poset 解決ヘルパーの新設（`subjectPoset.ts`）**:
   - `createAnalysisPoset`, `participatesViaPoset`, `resolveCardsForRelationEndpoint`（直接一致を優先し、未一致時のみ `SubjectPoset` / `mergedFrom` / `*EntityOrigin` を用いて参加役割優先順で代表カードを解決）を追加。
2. **台帳検証・統合・投影・再同期への一貫適用**:
   - `inspectLedger`（`eventLedger.ts`）でサイクル除去後 Poset を構築し、`participatesViaPoset` で関係端点を検証。`ledgerRepairInput` に `dependency` 同一主体時の案内を追記。
   - `validateParticipants`（`eventAnalysis.ts`）で `sourceEntityOrigin` / `targetEntityOrigin` を Poset 照合対象に含め、`consolidateSubjects`（`subjectRanking.ts`）から `subjectPoset: base.subjectPoset` を引き渡す。
   - `projectAnalysis`・`reconcileAnalysis`（`eventAnalysis.ts`）、`connectSharedEvents`（`sharedEvents.ts`）、`protectedCardIds`（`presentation.ts`）に共通ヘルパーを適用。
3. **同一レーン意味エッジ・集約レーン保護（`laneConnections.ts`）**:
   - `Boolean(edge.relationId)` を持つ意味論的関係エッジ（`generated: false` への手動編集後を含む）および `isOtherActorsLaneName` レーン内の既存エッジを `repairLaneConnections` の削除・`sequential` 上書き対象から除外。順方向ペアをすでに `relationId` エッジがカバーする場合は重複する無印 `sequential` 線を追加しない。
4. **診断リネージ記録の精緻化（`aiDiagnostics.ts`）**:
   - `operation` ステップは `d.type === 'error' || d.type === 'warn'` のみ記録し、`error` のみ `ORPHANED_ERROR`、`warn` は `MUTATED` と分類。`graph.projection` の共有イベントは全所属カードを記録。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 親組織主体を含む正当な関係（`R5` 相当）が余分な台帳修復や単一主体への情報劣化を起こさずそのまま通過・投影・編集維持される。
  - 主体統合や連鎖補完で同一レーン内に配置された `dependency` / `transfer` / `impact` エッジおよび「その他の関係者」レーンのエッジが `repairLaneConnections` で消失しなくなる。
  - 診断パッケージで警告ログが誤って `ORPHANED_ERROR` 扱いされなくなる。
- **トレードオフ・考慮事項**:
  - 主体統合前に複数子主体カードへ対応する親主体関係を描画する場合は、役割優先順位で代表 1カードへ投影される（統合完了後は単一親カードへ 1:1 接続）。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/features/vta/utils/subjectPoset.ts`
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/features/vta/utils/presentation.ts`
  - `src/tools/vta/features/vta/utils/sharedEvents.ts`
  - `src/tools/vta/features/vta/utils/laneConnections.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
  - `src/tools/vta/features/vta/utils/laneConnections.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
