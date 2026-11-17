# ADR-0034: 行（Row）・セル（Cell）概念の導入と反対称2次元配列によるイベント時間半順序DAG（EventTimeDAG）および非破壊無視フラグアーキテクチャ

- **ステータス**: Accepted
- **決定日**: 2026-11-14
- **対象コンポーネント**: VTA Data Schema (`vta.ts`) / Event Time Poset Engine (`eventTimePoset.ts`) / Layout Engine (`layout.ts`, `eventRanks.ts`) / Event Analysis (`eventAnalysis.ts`, `granularityScore.ts`)
- **関連ドキュメント・コミット**: [ADR-0007](file:///docs/adr/0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0010](file:///docs/adr/0010-subject-poset-dag-and-canonical-inclusion.md), [ADR-0022](file:///docs/adr/0022-pre-outcome-node-protection-and-refinement-lane-sequence-repair.md)

## 1. コンテキストと課題 (Context & Problem Statement)

従来の VTA 実装では、イベントの発生順序やレイアウトに関して以下の構造的課題が存在していた：

1. **旧スキーマ互換コードによる複雑化**: `analysis` オブジェクトを持たない旧ノード配列直接指定のフォールバック処理（`layout.ts` 内の旧 `computeTimeRanks`）や旧 `VTAFact` 必須制約が残存し、時間順序計算が二重化していた。
2. **イベントの物理削除による履歴・推移関係の喪失**: 事後調査除外（`filterPostOutcomeScope`）やキャンバス上でのカード削除（`reconcileAnalysis`）時に、`analysis.events` からイベント自体を物理削除していたため、元のイベント記録や中間イベントを介した推移的な時間順序が失われていた。
3. **イベントIDと時間順序の混同**: イベント追加時に時間順序とイベントID採番が明確に分離されておらず、また同時発生事象を DAG 上で表現する際にイベントIDを直接頂点とすると循環（双方向エッジ）が生じる問題があった。
4. **「共有カード」概念の分かりにくさ**: 前後関係を示せない複数イベントを1枚のカードに結合する「共有カード」概念は直感的でなく、表計算シートのように「行（Row）」と「セル（Cell：レーンと行の交差領域）」として捉え、同一セル内に順序未確定の複数イベントが配置された際に行全体の高さを拡張するモデルが求められた。
5. **時間半順序の高速かつ双方向な判定**: `timeNodeId` を 0 以上の連番整数（上限 400）として表現し、2次元配列 `matrix[u][v]` の1回の参照だけで $u \prec v$ と $v \prec u$ の双方を即座に判定できるデータ構造が必要であった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **単純性と一貫性**: 旧スキーマ互換フォールバックを撤廃し、`EventTimeDAG` を唯一の時間半順序（Poset）情報源とする。
- **非破壊性（Non-destructive Exclusion）**: イベントの削除は一切行わず、`ignored?: boolean`（および `ignoreReason?: 'user' | 'post_outcome'`）によって分析・描画対象から除外する。
- **追加順イベントIDと時間ノードIDの分離**:
  - `event.id` は追加順で決まるユニークな連番ID（`E1, E2, ...`、`nextEventSeq` で管理）とし、時間的順序関係とは独立させる。
  - `event.timeNodeId` は $0 \le \text{timeNodeId} < 400$（`MAX_TIME_NODES = 400`）の整数とし、同時発生イベント間で同一の `timeNodeId` を共有可能とする。
- **反対称（歪対称）2次元配列による $O(1)$ 双方向順序判定**:
  - `matrix[u][v]` の単一要素参照のみで $u \prec v$（正値 `+1`, `+2`）、$v \prec u$（負値 `-1`, `-2`）、順序なし（`0`）を識別可能にする。
- **行（Row）とセル（Cell）による視覚レイアウト**:
  - 前後順序を示せないイベント群は VTA 図上で同じ「行（Row）」に配置し、レーンと行の交差部分を「セル（Cell）」として定義する。同一セルに複数イベントが配置された場合はセル内で縦積み（`INTRA_RANK_GAP`）し、その分だけ行全体の高さを動的に拡張する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 隣接リストによるイベントID直接DAG**
  - イベントIDをそのまま頂点とする有向グラフ。同時発生事象の表現でサイクルが生じやすく、任意の2イベント間の順序判定に毎回グラフ探索（BFS/DFS）が必要となる。
- **選択肢2: 0/1/2 の非負値のみの2次元到達可能性行列**
  - `matrix[u][v] > 0` で $u \prec v$ は分かるが、`matrix[u][v] === 0` のときに「$v \prec u$ なのか」「順序関係なし（incomparable）なのか」を `matrix[u][v]` の値単体から識別できず、`matrix[v][u]` の再参照が必要となる。
- **選択肢3（採用）: 整数 `timeNodeId` ($0 \le \text{id} < 400$) と反対称2次元配列 `matrix[u][v]` (`+1/+2`, `-1/-2`, `0`) による `EventTimeDAG` ＋ 行（Row）・セル（Cell）レイアウト**
  - 同時発生事象は同一の `timeNodeId` を共有し、異なる `timeNodeId` 間の半順序を反対称行列 `matrix[v][u] = -matrix[u][v]` で保持する。

## 4. 決定事項 (Decision Outcome)

1. **旧スキーマ読み込みフォールバックの廃止**:
   - `layout.ts` の `computeTimeRanks` から旧ノード配列直接計算ロジックを削除し、`computeEventRanks`（`EventTimeDAG` ベース）へ一本化した。
   - `VTAAnalysisData.facts` および `factIds` を任意フィールド化した。
2. **非破壊無視フラグ (`ignored`) の導入**:
   - `VTAEvent` に `ignored?: boolean` と `ignoreReason?: 'user' | 'post_outcome'` を追加した。
   - キャンバス上のカード削除（`reconcileAnalysis`）や事後活動除外（`filterPostOutcomeScope`）、レビューパネル操作（`setEventIgnored`）ではイベントを物理削除せず `ignored: true` を設定する。
3. **追加順ユニークイベントIDと `addEventToAnalysis`**:
   - `VTAAnalysisData.nextEventSeq` と `allocateNextEventId` により、イベント追加順でユニークなID（`E1, E2, ...`）を採番する。
   - `addEventToAnalysis` により、既存イベントの前・後・同時位置へ新しい時間ノードを挿入し、`EventTimeDAG` を更新する。
4. **反対称2次元配列 `EventTimeDAG` (`MAX_TIME_NODES = 400`)**:
   - `timeNodeId` を $0 \le \text{timeNodeId} < 400$ の整数とし、複数イベントでの共有を許容する。
   - `matrix[u][v]` の値定義（常に `matrix[v][u] === -matrix[u][v]`、`matrix[u][u] === 0`）：
     - `+1`: $u \prec v$（直接の先行関係 $u \to v$）
     - `+2`: $u \prec v$（推移的な先行関係 $u \to \dots \to v$）
     - `-1`: $v \prec u$（逆方向の直接先行関係 $v \to u$）
     - `-2`: $v \prec u$（逆方向の推移的先行関係 $v \to \dots \to u$）
     - `0`: $u$ と $v$ の間に前後関係なし（$u = v$ なら `'simultaneous'`、$u \neq v$ なら `'incomparable'`）
   - 専用検索関数 `compareEventTime`、`compareEventTimeById`、`isEventBefore`、`computeEventRowMap` を提供し、イベント間の時間半順序判定を一元化した。
5. **行（Row）とセル（Cell）レイアウト概念**:
   - `EventTimeDAG.computeNodeRowRanks()` により、前後順序を示せないイベント群に同一の行番号（`rowIndex`）を割り当てる。
   - `calculateVTALayout` において、レーンと行が交差する領域をセル（`LayoutCell`）、各行の領域を行境界（`LayoutRowBound`）として算出し、同一セル内に複数の順序未確定イベントが配置された場合は `INTRA_RANK_GAP` を挟んで縦積みし、行全体の高さを動的に拡張する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `matrix[u][v]` の1回の配列参照（$O(1)$）で `before` / `after` / `simultaneous` / `incomparable` の4状態すべてを即座に判定できる。
  - 中間イベントが `ignored: true` となっても、`EventTimeDAG` の推移的閉包（`+2` / `-2`）により前後の有効イベント間の時間順序が失われない。
  - 行（Row）とセル（Cell）の概念により、同時・順序未確定イベントの配置と行高計算が表計算モデルとして明確化された。
- **トレードオフ・考慮事項**:
  - `timeNodeId` の最大数は `MAX_TIME_NODES = 400`（行列サイズ最大 $400 \times 400 = 160,000$ 要素）に制限されるが、通常のVTA分析（数十〜百数十イベント、同時イベントは同一 `timeNodeId` を共有）では十分余裕があり、メモリ・計算量ともに極めて軽量である。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/features/vta/utils/eventTimePoset.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/features/vta/utils/eventRanks.ts`
  - `src/tools/vta/features/vta/utils/layout.ts`
  - `src/tools/vta/features/vta/utils/eventOrder.ts`
  - `src/tools/vta/services/generation/granularityScore.ts`
  - `src/tools/vta/components/control-panel/EventReviewPanel.tsx`
  - `tests/vta/eventTimePoset.test.ts`
  - `tests/vta/postOutcomeExclusion.test.ts`
