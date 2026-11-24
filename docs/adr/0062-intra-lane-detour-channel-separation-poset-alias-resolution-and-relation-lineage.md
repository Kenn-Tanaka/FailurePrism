# ADR-0062: 同一レーン非隣接迂回エッジの左右・外周チャネル分離・SubjectPoset外部エイリアス不動点解決および関係リネージ追跡強化ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-21
- **Target Components**: `VTA Layout & Edge Routing`, `VTA Subject Poset`, `VTA AI Diagnostics`
- **Related Requirements / ADRs**: [ADR-0010](./0010-subject-poset-dag-and-semantic-inclusion-hierarchy.md), [ADR-0046](./0046-cross-lane-wire-clearance-and-diagnostics-lineage.md), [ADR-0047](./0047-reoptimize-layout-monotonicity-and-vertical-stub-exemption.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

長大シナリオ（羽田空港衝突事故・イベント63件、カード81件）の実機診断パッケージ（`2026-11-20T12:32:32.832Z`）の解析により、以下の3つの構造的課題が判明した。

1. **同一レーン内の複数の非隣接意味関係エッジにおける縦迂回幹の `0px` 完全重畳 (`LAYOUT_CLOSE_VERTICAL_EDGES`)**:
   - 細粒度主体（`A_CAPT_A` 機長A、`A_COPILOT_A` 副操縦員A 等）が親主体レーン（`A_CREW_A` A機乗組員）へ統合されると、初期台帳の `R20`（`dependency: E30/A_CAPT_A → E33/A_COPILOT_A`）や粒度反復 `#1` で追加された `rel_ref_M2` が、同一レーン `A_CREW_A` 上で中間カードを飛び越す非隣接意味関係エッジ（`is_cross_lane: false`）として投影される。
   - `resolveVTAEdgePaths` の Pass 0（`!isSide`）は既配置エッジとの競合検査を行わず、すべての同一レーンエッジに `routeOffset = 0` を与えていた。その結果、`avoidCards` が左右同コストのタイブレークで常に左側の同一座標 `x = card.x - 30` を選び、2本の長尺縦迂回幹が `gapPx = 0px`（基準 `EDGE_VERTICAL_CLEARANCE_X = 14px` 未満）で完全重畳していた。
2. **`SubjectPoset.fromEntities` における外部エイリアス（`[表記]`）からの幽霊ノード混入 (`node_count: 31` vs 実主体30件)**:
   - `eventLedger.ts` が `[表記]`（`alias_unification`、例: `海保 → 海上保安庁`）を `SubjectPoset.fromEntities(entities, aliasMap)` に渡した際、`poset.addAlias(alias, canonical)` が `canonical`（主体名称 `"海上保安庁"` や主体外の用語）を `resolveCanonical` で正準主体ID（`"A_JCG"`）へ解決せずに `addNode("海上保安庁")` していた。そのため `"海上保安庁"` という幽霊ノードが Poset に追加され、`resolveCanonical("海保")` が `"A_JCG"` ではなく `"海上保安庁"` を返していた。
3. **AI 診断パッケージ Section 3 (`Target Entity Lineage`) における生成関係IDの追跡漏れ**:
   - `detectTriggerEntityIds` の正規表現が `R\d+` のみにマッチし、粒度反復の `rel_ref_*`、自動接続提案の `proposal:*`、連鎖補完の `added_*` を抽出していなかった。また `traceEntityLineage` が `graph.projection` での関係の統合後主体端点・origin 主体・投影エッジを記録していなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **既存座標の100%保持（ゼロ副作用）**: 単一の同一レーン迂回エッジや通常の隣接直列2点線、および既存のクロスレーン配線（`options` 省略時の `avoidCards`）では、従来座標を1pxも変えないこと。
- **狭い同一ランク内カード間隔 (`INTRA_RANK_GAP = 30px`) とスイムレーン境界（片側余白 `60px`）の遵守**:
  - 垂直スタブ長を不用意に拡大（`44px` / `58px`）すると、`INTRA_RANK_GAP = 30px` で直上・直下カード内部へ突入して迂回が失敗する。
  - 横マージンを `60px` 以上に広げると、スイムレーン境界破線（`card.x - 60`, `card.x + NODE_WIDTH + 60`）と干渉する。
- **多段エイリアスの順序非依存解決と診断トークン予算の維持**:
  - `[表記]` で `JCG → 海保` が `海保 → 海上保安庁` より先に出現しても取りこぼさないこと。
  - `entityLineage`（先頭5枠）が1件目の異常の副次IDで埋め尽くされて2件目以降の異常の `target_id` が押し出されないこと、また連続する `graph.projection` で同一行が重複出力されないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: `avoidCards` の単一 `margin = 30 + offset` だけを大きく振って Pass 0 をずらす**
  - *問題点*: `margin` が垂直スタブ長と横迂回距離の両方に結合しているため、正の `offset` で `INTRA_RANK_GAP = 30px` の直上カードに突入し、また左側のみに偏って右側の空き空間（`card.x + NODE_WIDTH + 30`）を活用できない。
- **選択肢2: `avoidCards` に左右選択 (`detourSide`) と独立横マージン (`xMarginOffset`) を追加し、Pass 0 で競合回避トラック探索を行う（採用）**
  - 初回（左 `30px`）で競合がある場合のみ、右 `30px` → 左右外周 `46px`（`+16`） → 左右内周 `15px`（`-15`）の計6チャネル（カード縁から `>= 15px`、レーン境界から `>= 14px`）および安全なスタブ Y オフセット（`0`, `-14`, `+14`）を探索する。

---

## 4. 決定事項 (Decision Outcome)

1. **`avoidCards` の左右選択・独立横マージン対応 ([edgeRouting.ts](../../src/tools/vta/features/vta/utils/edgeRouting.ts))**:
   - オプション引数 `AvoidCardsOptions`（`detourSide?: 'left' | 'right'`, `xMarginOffset?: number`）を追加する。未指定時は従来の `margin = 30 + offset` を完全維持する。
   - `detourSide` 指定時は水平展開順序と微小方向バイアス（`0.5px`）により、同コストの左右迂回路から指定側を決定論的に選択する。
2. **Pass 0 同一レーン配線の競合回避トラック探索 ([layout.ts](../../src/tools/vta/features/vta/utils/layout.ts))**:
   - `resolveVTAEdgePaths` の Pass 0（`!isSide`）候補を垂直スパン `|sourceY - targetY|` 昇順で整列し、短いスパンが内側・長いスパンが外側を通るようにする。
   - `pickConflictAwareIntraLanePath` を導入し、直線（1線分）または初回（左 `30px`）で競合ゼロなら即確定、競合がある場合のみ `INTRA_LANE_DETOUR_TRACKS`（右 `30px`、左右 `46px`/`15px`、スタブオフセット `0`/`-14`/`+14`）から最小ペナルティのトラックを選択する。
3. **`SubjectPoset.fromEntities` の外部エイリアス不動点解決 ([subjectPoset.ts](../../src/tools/vta/features/vta/utils/subjectPoset.ts))**:
   - `aliases` の値（`canonical`）を `poset.resolveCanonical(canonical)` で解決できた場合のみ、その正準主体IDに対して `addAlias(alias, resolvedId)` を登録する不動点ループとする。これにより多段エイリアスを順序非依存で解決し、幽霊ノードや主体外用語の混入を防止する。
4. **AI 診断トリガー抽出の2パス優先度化と関係投影リネージ記録 ([aiDiagnostics.ts](../../src/tools/vta/services/diagnostics/aiDiagnostics.ts))**:
   - `detectTriggerEntityIds` の正規表現に `rel_ref_*`, `proposal:*`, `added_*` を追加し、第1パスで全異常の `target_id` を優先確保してから第2パスで `violation_detail` 内の関連IDを抽出する。
   - `traceEntityLineage` の `graph.projection` で `d.relations` から対象関係の統合後端点・origin 主体・投影エッジを `pushProjectionStep`（連続重複圧縮付き）で記録する。

---

## 5. 結果と影響 (Consequences)

### メリット
- 同一レーン内の複数の非隣接意味関係エッジ（`relation:R20` と `relation:rel_ref_M2` 等）が左右および外周・内周トラックへ自動分離され、`LAYOUT_CLOSE_VERTICAL_EDGES (0px)` が解消される。
- `SubjectPoset` に主体名称や主体外用語が幽霊ノードとして混入しなくなり、多段表記ゆれも正準主体IDへ推移解決される。
- 診断パッケージの Section 3 で、粒度反復・自動接続・連鎖補完が生成した関係IDと統合前後の端点変遷が欠落なく追跡できる。

### トレードオフ・考慮事項
- 同一レーンの同一Y区間に7本以上の非隣接飛び越し線が集中する極端な過密ケースでは、6チャネルの中で最小ペナルティのトラックが選ばれ、残余の近接は `layout.audit` に正確に報告される。

### 影響ファイル
- [src/tools/vta/features/vta/utils/edgeRouting.ts](../../src/tools/vta/features/vta/utils/edgeRouting.ts)
- [src/tools/vta/features/vta/utils/layout.ts](../../src/tools/vta/features/vta/utils/layout.ts)
- [src/tools/vta/features/vta/utils/subjectPoset.ts](../../src/tools/vta/features/vta/utils/subjectPoset.ts)
- [src/tools/vta/services/diagnostics/aiDiagnostics.ts](../../src/tools/vta/services/diagnostics/aiDiagnostics.ts)
- [src/tools/vta/features/vta/utils/edgeRouting.test.ts](../../src/tools/vta/features/vta/utils/edgeRouting.test.ts)
- [src/tools/vta/features/vta/utils/subjectPoset.test.ts](../../src/tools/vta/features/vta/utils/subjectPoset.test.ts)
- [tests/vta/aiDiagnostics.test.ts](../../tests/vta/aiDiagnostics.test.ts)
- [docs/adr/README.md](./README.md)
