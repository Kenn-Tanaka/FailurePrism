# ADR-0057: 正規化フェーズにおけるイベント時間区間半順序（Interval Poset）構築と厳密時刻優先ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-20
- **Target Components**: `VTA Event Time Poset`, `VTA Event Ledger Normalization`
- **Related Requirements / ADRs**: [ADR-0034](file:///docs/adr/0034-row-cell-layout-and-matrix-event-time-dag.md), [ADR-0045](file:///docs/adr/0045-intra-lane-sequence-dag-alignment-and-wiring-diagnostics.md), [ADR-0051](file:///docs/adr/0051-cross-lane-backward-edge-audit-and-same-rank-alignment.md), [ADR-0056](file:///docs/adr/0056-gateway-retry-observability-cross-lane-geometry-trace-and-temporal-inversion-guard.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. **日付＋時刻不明ラベル（`"2024-01-02 -"` 等）に対する午前0時（`00:00:00`）の捏造と単一 `timeNodeId` への強制合流**:
   - 原文段落に `- 2024-01-02 時刻記録なし ...` と記載された事象（例: 16:43頃の電源車使用決定 `E7`、16:45頃の機長報告 `E8`、17:47衝突後の脱出 `E37` および死亡確認 `E38`）が、LLM によって `time: "2024-01-02 -"` として抽出されるケースがあった。
   - 従来の `parseTimeScore` は日付に続く時刻部 `HH:MM` を任意（`(?:...)?`）としていたため、`"2024-01-02 -"` の日付プレフィックスのみにマッチして `hour = 0, min = 0, sec = 0`（`2024-01-02 00:00:00`）の単一数値スコアを返していた。
   - さらに `buildEventTimeDAG` の同時刻 Union-Find マージ（`rawI === rawJ && scoreI === scoreJ`）が、直接の前後関係を持たない `E7, E8`（16:45頃）と `E37, E38`（17:47以降）をすべて1つの共有 `timeNodeId` に統合していた。
   - その結果、`E33 (17:47) ≺ E38` と `E8 ≺ E9 (17:25)` が同一の `timeNodeId` を介して短絡し、`E33 (17:47) ≺ {E7, E8, E37, E38} ≺ E9..E13 (17:25..17:32)` という深刻な時系列逆転が DAG に固定されていた。

2. **修飾語付き時刻（`"2024-01-02 17:48以降"` 等）の誤った同時統合と異種時間軸の混同**:
   - `"17:48以降"` や `"16:43ごろ"` のように幅を持つ時刻ラベルが複数イベントに付与された場合も、文字列表記と先頭数値スコアが一致するだけで同一 `timeNodeId` に潰されていた。
   - また、エポックミリ秒（日付付き）と日内秒（`HH:MM` のみ）・相対オフセット・フェーズキーワードを単一の数値として比較していたため、異種時間軸間で偽の順序が生成される余地があった。

3. **正規化フェーズでの時間半順序確定の欠如と根拠優先順位の逆転**:
   - `inspectLedger`（正規化フェーズ）では `eventTimeDAG` が構築されておらず、明示的な時刻区間と逆行する関係行に対するソフト修復検出も行われていなかった。
   - `buildEventTimeDAG` において、根拠の弱い「レーン内段落順（Priority 2）」が「明示的な時刻順（Priority 3）」より先に挿入されていたため、時刻不明ノードを介した段落順の推移閉包が明示時刻順をブロックする経路が存在していた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **厳密な区間半順序（Interval Poset）**: 時刻ラベルを単一の点（数値）ではなく時間軸（`axis`）付きの閉区間 `[lo, hi]` として表現し、同じ時間軸上で `A.hi < B.lo` が成り立つとき、かつそのときに限り `A ≺ B` とする厳密な半順序（非反射性・反対称性・推移性）を保証すること。
- **同時統合の厳格化**: 同一 `timeNodeId` への自動統合は、`ごろ`・`以降`・`以前`・`時刻記録なし`・秒範囲・時刻欠落などを含まない一点時刻（`exactPoint === true`）の一致に限定すること。
- **正規化フェーズでの半順序確定と根拠優先度**: 正規化フェーズ（`inspectLedger`）の完了時点で `ensureEventTimeDAG` により時間半順序を確定し、明示時刻に逆行する関係はソフト問題（`softIssues`）として修復を試みつつ、DAG 構築では「手動エッジ → 厳密な時刻区間順 → 先行関係 → レーン内段落順」の根拠優先度を徹底すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: `parseTimeScore` で時刻欠落日付を `null` にするだけの局所対処**
  - *問題点*: `"2024-01-01 16:11"` と `"2024-01-02 -"` の間に存在する確実な日付レベルの順序（1月1日 ≺ 1月2日）まで失われる。また、`"17:48以降"` 同士の誤統合や、段落順が時刻順をブロックする構造的欠陥が残る。
- **選択肢B: 時間軸付き区間半順序（`parseTimeInterval` / `compareTimeIntervals`）の導入と正規化フェーズでの `EventTimeDAG` 確定（採用）**
  - 日付のみ／`"2024-01-02 -"` をその日の1日区間 `[00:00:00.000, 23:59:59.999]`（`exactPoint: false`）として保持することで、前日イベントとの順序を維持しつつ同日内の時刻付きイベントとの偽順序や強制合流を防ぐ。
  - 隣接する秒範囲（例: `17:45(11〜18秒)` と `17:45(18〜25秒)`）は境界の18秒が重なるため厳密区間順序では `incomparable` とし、同一レーン内では段落順（`sourceOrder`）で自然に整列させる。
  - 関係と明示時刻の矛盾は `inspectLedger` の `softIssues`（`temporal_inversion`）として検出し、修復不能でも生成を止めず DAG 側で明示時刻を優先する。

---

## 4. 決定事項 (Decision Outcome)

1. **時間軸付き区間パーサー `parseTimeInterval` と厳密区間比較 `compareTimeIntervals` の新設**:
   - [eventTimePoset.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/eventTimePoset.ts) に `ParsedTimeInterval`（`axis: 'epoch' | 'clock' | 'relative' | 'phase'`, `lo`, `hi`, `exactPoint`）を定義。
   - `"2024-01-02 -"` や `"2024-01-02 時刻記録なし"` は `axis: 'epoch'`, `[2024-01-02 00:00:00.000, 2024-01-02 23:59:59.999]`, `exactPoint: false` に正規化する。
   - `parseTimeScore` は後方互換のため区間の `lo` を返すが、1日全体の区間（時刻部分を欠く日付文字列）に対しては `null` を返し、午前0時の捏造を廃止する。

2. **`buildEventTimeDAG` の同時統合条件と挿入優先順の是正**:
   - 自動 Union-Find 統合は `interval.exactPoint === true` かつ同一区間・同一表記のイベント対に限定する。
   - エッジ挿入順序を **Priority 0（`manualEdges`）→ Priority 1（先行関係 `before`/`dependency`/`impact`/`transfer`）→ Priority 2（厳密な時刻区間順序 `compareTimeIntervals(iU, iV) === 'before'`）→ Priority 3（同一レーン内 `sourceOrder`）** に再編し、推測的なレーン内段落順が時刻不明ノードを介して明示時刻順をブロックする経路を遮断する。

3. **正規化フェーズ（`inspectLedger`）での `EventTimeDAG` 確定とソフト時間逆行検査**:
   - [eventLedger.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/eventLedger.ts) の `inspectLedger` 末尾で、先行関係 `u → v` が厳密区間順序で `v ≺ u` と矛盾する場合、`warnings` に記録するとともに `softIssues`（`code: 'temporal_inversion'`, `field: '時刻整合'`）に追加して既存の台帳修復ループで修復を試み、修復不成立時にも `analysis.relations` から当該逆行関係を除外した上で `ensureEventTimeDAG(analysis)` を呼び出して時間半順序集合を確定する。

4. **DAG 署名バージョンタグ（`t2|`）の付与**:
   - `computeDAGSignatures` の `eventSignature` 先頭に `t2|` を付与し（`createManualAnalysis` の `relationSignature = ''` 規約は維持）、旧ロジックで誤統合されたキャッシュ済み JSON を読み込んだ際にも自動的に `EventTimeDAG` を再構築して時系列を修復する。

---

## 5. 結果と影響 (Consequences)

### メリット
- `"2024-01-02 -"` や `"17:48以降"` を複数含む長大事故調査報告書でも、無関係なイベント同士の強制合流や午前0時への巻き戻しが根絶され、日付間の前後関係・同日内の明示時刻・関係・段落順が矛盾なく半順序集合として整列する。
- 保存済みの既存プロジェクト JSON も、読み込み時に署名バージョン不一致によって自動的に正しい時系列へ修復される。

### トレードオフ・考慮事項
- `17:45(11〜18秒)` と `17:45(18〜25秒)` のように端点を共有する隣接区間は、区間順序単体では `incomparable` となるが、同一レーン上のイベントであれば Priority 3（段落順）により記述順どおり `11〜18秒 ≺ 18〜25秒` と順序付けられる。

### 影響ファイル
- [src/tools/vta/features/vta/utils/eventTimePoset.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/eventTimePoset.ts)
- [src/tools/vta/features/vta/utils/eventLedger.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/eventLedger.ts)
- [tests/vta/eventTimePoset.test.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/tests/vta/eventTimePoset.test.ts)
- [docs/adr/0057-interval-time-poset-and-normalization-phase-temporal-ordering.md](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/docs/adr/0057-interval-time-poset-and-normalization-phase-temporal-ordering.md)
- [docs/adr/README.md](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/docs/adr/README.md)
