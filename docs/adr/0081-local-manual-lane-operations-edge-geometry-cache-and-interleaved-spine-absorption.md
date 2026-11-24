# ADR-0081: 手動レーン統合・分割の局所 $O(V+E)$ 化・エッジ配線ジオメトリ2段階キャッシュ・および統合レーン割り込み非隣接関係の縦スパイン吸収ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-24
- **対象コンポーネント**: VTA Engine (`subjectRanking`, `subjectGranularityProposals`, `presentation`, `eventAnalysis`, `graphDiagnostics`, `layout`) / VTA Store & UI (`vtaStore`, `VTAEdge`, `LaneManagementPanel`) / Diagnostics (`debugRecorder`, `aiDiagnostics`)
- **関連ドキュメント・コミット**: [ADR-0011](./0011-olap-subject-drilldown-rollup.md), [ADR-0072](./0072-deferred-final-phase-subject-others-consolidation.md), [ADR-0079](./0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md), [ADR-0080](./0080-inclusion-penalty-function-others-eligibility-gate-and-cascade-outcome-scope.md)

## 1. コンテキストと課題 (Context & Problem Statement)

大規模事故調査事例（69イベント・30主体・185エッジ規模）における手動レーン統合および日常の UI 操作（ホバー・ノード選択・ブレイク切替等）において、以下の性能ボトルネックおよび描画異常が確認された。

1. **手動レーン統合・分割時の UI フリーズと無関係レーンの勝手な再統合・分解**:
   - `applyLaneMergeProposal`・`applyForceMergeTransition`・`applyLaneSplitProposal` がいずれも旧来の大域ソルバー `consolidateSubjects` を呼び出していた。
   - `consolidateSubjects` は内部で `revertConsolidation` により ADR-0079/0080 の山登り法で確定済みの全レーン分割を一旦白紙化したうえ、最大 60,000 状態×2回の分枝限定探索（計12万状態）をメインスレッド同期で実行するため、数秒間の UI 固まりを引き起こすと同時に、ユーザーが触っていない高焦点主役（`機長A` や `タワー東` 等）まで上位組織へ強制統合し、逆に統合済み周辺レーンを再展開してしまっていた。
2. **日常操作（ホバー・選択・対策トグル・履歴記録）でのメインスレッド停滞**:
   - `VTAEdge` の配線キャッシュが `nodes` / `edges` の配列参照一致（`===`）のみをキーとしていたため、`VTACanvas` でホバーや選択状態が変化して配列参照が更新されるたびに、座標が 1px も動いていないにもかかわらず 4 パス衝突回避エッジルーター `resolveVTAEdgePaths`（$O(E^2 \cdot N)$）が毎回フル実行されていた。
   - `commitVTAChange` が呼び出し元で計算済みのレイアウトや座標不変の属性変更（`is_break` / `measure_type` 等）に対しても毎回 `calculateVTALayout` と `auditVTALayoutGeometry` を再実行していた。
   - Undo スナップショット・LocalStorage 下書き保存・Tier 1 Flight Recorder（`project.snapshot`）が、編集で不変な `pipelineHistory`（最大4ステージ分の完全コピー）や `fineGrainedBase`、重複 `analysis` を毎回シリアライズしていた。
3. **乗組員統合時の客体ドット縮小と `221px` クロスレーン逆行段差（`LAYOUT_BACKWARD_CROSS_LANE_EDGE`）**:
   - `detectGranularityProposals` の `vehicle_crew` 統合案が `suggestedKind: 'machine'` を付与していたため、有人乗組員を統合したレーンの受動イベントカードが `24px` 客体ドットに縮小された。さらに自動レイアウト状態で既存レーン側が統合前の仮 `position.y` を保持したまま新造統合レーンのみが新 `rankBaseY` で配置されたことで、同一イベントの横接続に大きな下向き段差が生じていた。また、`aiDiagnostics` の該当異常出力で `rel.sourceRefs` が `[object Object]` と文字列化されていた。
4. **統合レーン上の割り込み非隣接関係による垂直ステム重複（`LAYOUT_CLOSE_VERTICAL_EDGES`）**:
   - ADR-0079 の同一レーン関係吸収は `origSrc !== origTgt` のみを対象としていたため、同一元主体（`origSrc === origTgt`）の連続イベント間に統合で別主体のイベントが割り込んで非隣接化した際、冗長な迂回アークが残存し、隣接レーン間エッジの垂直ステム（Case 2b / Phase B）と `x` チャネルが重複していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **局所操作の不変性（Principle of Least Surprise）**: ユーザーが特定のレーン対を統合・分割した際、無関係な他レーンの統合・分離状態は一切変化してはならない。
- **即時 UI 応答性**: 手動統合・分割は $O(V + E)$（数十ミリ秒以内）、ホバー・選択変更・ブレイクトグルは数ミリ秒以内で応答する必要がある。
- **可逆性とデータ保全（DATA-002 / ADR-0011 互換）**: 手動統合後の OLAP ドリルダウン展開・再分割・Stage 3 自動接続関係（`proposal:*`）の保持、および単体テスト環境での同期下書き保存契約を完全に維持する必要がある。
- **分野非依存性**: 特定の事故種別語彙に依存せず、グラフ構造・半順序・幾何情報のみで判定する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1**: `consolidateSubjects` の探索上限 `MAX_SEARCH_STATES` を縮小し、`saveDraftBackup` を一律非同期デバウンス化する。
  - *却下理由*: 探索上限を下げても `revertConsolidation` による無関係レーンの統合状態破壊は防げず、また一律非同期化は同期保存を前提とするテスト契約を破壊する。
- **選択肢 2（採用）**: 手動統合・分割を局所 $O(V + E)$ 演算（`mergeEntitiesLocally` / `splitEntitiesLocally`）へ分離し、`VTAEdge` および `resolveVTAEdgePaths` にジオメトリ署名ベースの2段階キャッシュを導入、さらに履歴・スナップショットから不変の巨大フィールドを構造的に除外する。

## 4. 決定事項 (Decision Outcome)

1. **局所 $O(V + E)$ 手動統合・分割（`mergeEntitiesLocally` / `splitEntitiesLocally`）と OLAP ドリルダウン整合**:
   - `applyLaneMergeProposal` および `applyForceMergeTransition` を `foldEntitiesIntoTargets` ベースの `mergeEntitiesLocally` に切り替え、指定された統合元主体（およびその既統合サブ主体）のみをターゲット主体へ付け替え、他レーンのパーティションを完全保持する。
   - `applyLaneSplitProposal` を `splitEntitiesLocally` に切り替え、分割対象主体以外のマージ写像を保持したまま対象クラスタのみを $O(V + E)$ で部分展開する（空になった合成親コンテナは自動除去）。
   - `presentation.ts` の `visibleSchema` ドリルダウン解決で `participation.mergedFrom` も参照し、手動統合レーンのサブレーン展開を保証する。
   - `vehicle_crew` 統合提案の `suggestedKind` を `'organization'` に是正し、自動レイアウト状態（保存座標なし）での統合・分割時は `{ forceRecompute: true }` で全レーンの行 `Y` 座標を一斉再整列する。
2. **2段階エッジジオメトリキャッシュとストア更新・履歴保存の軽量化**:
   - `VTAEdge` の `getSharedEdgeLayout` に Level 1（$O(1)$ 参照一致）＋ Level 2（$O(N + E)$ ジオメトリ署名一致）の2段階キャッシュを導入し、`resolveVTAEdgePaths` 内にも署名キャッシュを設けることで、`auditVTALayoutGeometry` 後の初回描画およびホバー・選択変更時の再配線計算をゼロ化する。
   - `commitVTAChange` では呼び出し元が完全なレイアウトを渡し可視トポロジーが不変の場合の二重 `calculateVTALayout` を廃止し、抑制カードに影響しない `toggleNodeElimination` / `toggleEdgeBreak` / `toggleEdgeDirection` / `applyMeasuresProposal` では `skipLayout: true` を適用する。
   - `cloneSchemaForHistory` で `pipelineHistory`・`fineGrainedBase`・`sources` を参照共有とし、`vta_draft_autosave` からは `pipelineHistory` を除外（ブラウザ実稼働時のみ `250ms` デバウンス＋`pagehide`/`beforeunload`/`visibilitychange` 即時フラッシュ）、Flight Recorder `project.snapshot` では重複 `analysis` と `fineGrainedBase` を除外する。
3. **統合レーン割り込み非隣接関係の縦スパイン吸収と対称チャネル探索**:
   - 統合レーン上で他イベントの割り込みにより非隣接（`|seqIdxA - seqIdxB| > 1`）となった同一元主体の非 `dependency`・非 `omitted` 関係を `eventAnalysis.ts` / `graphDiagnostics.ts` で縦スパインへ吸収する（隣接カードの意味ラベルや未統合レーンの明示エッジは保持）。
   - `layout.ts` の `pickConflictAwareCorridorPath`（Case 2b / Phase B）の垂直チャネル探索オフセットを正負対称に拡張し、`aiDiagnostics.ts` の `rel.sourceRefs` を `sourceId/paragraphId` 形式で出力する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 手動レーン統合・強制統合・分割が他の主役レーンを巻き込まず即座（数〜数十ms）に完了し、乗組員統合後の `221px` 逆行段差や `0px` 垂直線重複も解消される。
  - キャンバス上のマウスホバー・カード選択・ブレイク切替による UI カクつきが根絶され、Undo 履歴のメモリ使用量とスナップショット記録コストが大幅に低減する。
- **トレードオフ・考慮事項**:
  - `vta_draft_autosave`（クラッシュ復旧用一時下書き）には `pipelineHistory` を含めないが、通常のプロジェクト JSON 保存（`exportProjectJSON`）およびメモリ上の `vtaData` には従来通り完全保持される。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/features/vta/utils/subjectGranularityProposals.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/features/vta/utils/presentation.ts`
  - `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/features/vta/components/VTAEdge.tsx`
  - `src/tools/vta/components/control-panel/LaneManagementPanel.tsx`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/features/vta/utils/graphDiagnostics.ts`
  - `src/tools/vta/features/vta/utils/layout.ts`
  - `src/tools/vta/services/debugRecorder.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/features/vta/store/manualLaneAndUiPerf.test.ts`
