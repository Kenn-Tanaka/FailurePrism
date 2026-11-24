# ADR-0047: VTA再最適化時の座標整合保護・共有上下ポート垂直スタブ免除およびLLM失敗遷移観測

- **ステータス**: Accepted
- **決定日**: 2026-11-18
- **対象コンポーネント**: VTA Layout & Store (`lanePositionShift.ts`, `layout.ts`, `laneConnections.ts`), AI Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0045](file:///docs/adr/0045-intra-lane-sequence-dag-alignment-and-wiring-diagnostics.md), [ADR-0046](file:///docs/adr/0046-cross-lane-wire-clearance-and-diagnostics-lineage.md)

## 1. コンテキストと課題 (Context & Problem Statement)
実機診断ログ（`2026-11-18T09:52:40.246Z`）の解析により、以下の3点が判明した。

1. **`[VTA最適化]` 後のレーン内座標逆転 (`card_36(y=50) -> card_37(y=8611)`)**: `refineGranularity` で主体統合や関係追加が行われてカード番号が再編成・ランク変動した直後、`shiftReactNodesForLaneChange` および `calculateVTALayout` が文字列 ID 一致のみで旧 `existingNodes` の Y 座標を引き継いでいたため、新規/再計算カード（最上段 `y=50`）と古い下段カード（`y=8611`）が混在し、直列順序線が逆行・全高迂回していた。
2. **垂直近接監査の偽陽性と重複直列線の残存 (`0px`)**: `avoidCards` による同一レーン飛び越し迂回線の上下共有ハンドル 12px 垂直スタブに対して、水平共有ハンドル（`isExemptSharedPortStub`）相当の免除が垂直側になく、`LAYOUT_CLOSE_VERTICAL_EDGES (0px)` が大量に報告されていた。また、`repairLaneConnections` が同隣接ペアに意味関係（`relation:*`）が既に存在する場合でも、未カスタマイズの既存自動 `sequential` 線を削除せず残していた。
3. **LLM タイムアウト遷移の観測不足**: `client.ts` が記録する `llm.failure`（`timedOut`, `elapsedMs`, `attempt`）が診断パッケージに反映されていなかった。

## 2. 決定理由の要因・制約 (Decision Drivers)
- 明示保存済みの手動ドラッグ座標（`schema.nodes[i].position`）や、構成・順序が変わっていないレーンの位置維持は壊さないこと。
- 本当に並列重複するクロスレーン縦線や未免除の2点重複線は厳密に検出すること。
- ユーザー手動キャンセル（`userCancelled: true`）を通信エラー遷移として誤記録しないこと。

## 3. 検討した選択肢 (Considered Options)
- **選択肢1**: `[VTA最適化]` 時に常に `forceRecompute: true` を強制する。
  - 手動調整済みで順序不変のレーン位置や DOM 高さキャッシュまで無差別に破棄するため、条件付きガードを採用。
- **選択肢2（採用）**: `shiftReactNodesForLaneChange` で `event_ids` 一致・クリア済み座標・レーン順序不変を検証し、`calculateVTALayout` でも未保存レーンでの BT 逆転を自動リセットする多層ガード、垂直共有ポート短スタブ免除、冗長自動 `sequential` 線整理、`llm.failure` 可視化を実施。

## 4. 決定事項 (Decision Outcome)
1. **再最適化・ランク変動時の座標整合保護**: `shiftReactNodesForLaneChange` に `sharesAnyEvent`・クリア済み `position` 検知・`detectReorderedLanes` を追加し、`calculateVTALayout` に未保存レーン限定の本番 Bottom-to-Top 単調性チェックを追加した。
2. **垂直共有ポートスタブ免除 (`isExemptSharedVerticalPortStub`)**: 4線分以上の同一レーン迂回線（`avoidCards`）で上下ハンドルを共有し直後に水平屈曲する垂直端スタブ（`<= max(120px, 1.5 * VERTICAL_GAP)`）のみを `countVerticalStemConflicts` と `auditVTALayoutGeometry` で免除した。
3. **隣接意味関係上の冗長 `sequential` 線整理 (`repairLaneConnections`)**: `semanticForwardPairs.has(key)` 成立時、未カスタマイズ（`!label && !is_break && generated !== false`）の自動直列重複線を除去する。
4. **`llm.failure` 診断出力 (`aiDiagnostics.ts`)**: 非キャンセル `llm.failure` を `pipeline_transitions` と `failure.source_hint` へ出力する。

## 5. 結果と影響 (Consequences)
- **メリット**:
  - `[VTA最適化]` でカード構成・時間ランクが変化しても上下逆転や極端な座標乖離が発生しない。
  - 同一レーン飛び越し迂回線の正常スタブによる誤検知がなくなり、真の垂直近接のみを正確に監査できる。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/lanePositionShift.ts`
  - `src/tools/vta/features/vta/utils/layout.ts`
  - `src/tools/vta/features/vta/utils/laneConnections.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/features/vta/utils/layout.test.ts`
  - `src/tools/vta/features/vta/utils/laneConnections.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
