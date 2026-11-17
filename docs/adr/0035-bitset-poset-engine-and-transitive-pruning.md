# ADR-0035: Uint32Arrayビット行列と推移性比較削減による半順序集合（BitsetPoset）管理エンジンの高速化

## メタデータ
- **ステータス**: Accepted
- **日付**: 2026-11-15
- **対象コンポーネント**: `bitsetPoset.ts`, `subjectPoset.ts`, `tests/vta/bitsetPoset.test.ts`, `tests/benchmark/bitsetPosetBenchmark.test.ts`
- **関連要件 / ADR**: ADR-0010 (SubjectPoset DAG), ADR-0011 (OLAP Drill-down / Roll-up), ADR-0034 (EventTimeDAG)

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. **従来の `Map<string, Set<string>>` 方式におけるメモリ・計算オーバーヘッド**:
   - `SubjectPoset`（ADR-0010）ではこれまで、各主体の直接の親子関係を `Map<string, Set<string>>` で保持し、推移的閉包を全ノードからのBFS/DFSによって `ancestorsCache` / `descendantsCache`（`Map<string, Set<string>>`）に構築していた。
   - この方式ではノードやエッジが追加されるたびにキャッシュ全体が無効化（`invalidateCache`）され、次回クエリ時に全頂点のグラフ探索と多数の `Set` インスタンス生成が発生していた。
2. **オブジェクト追加時の比較回数の増大**:
   - 比較関数によって半順序関係を判定・構築する場合、全既存オブジェクトと無条件に比較すると比較回数が $\frac{N(N-1)}{2}$ 回となり、比較関数のコストが大きい場合や要素数 $N$ が増加した場合にボトルネックとなる。
3. **削除とハッセ図（被覆関係）導出の効率化**:
   - オブジェクトの削除時にグラフ全体を再構築せず償却 $O(1)$ で論理削除・スロット再利用を行いつつ、削除済みIDの誤参照を防ぎ、さらに直接の上位・下位（ハッセ図の被覆関係）を高速に導出できる汎用的な半順序集合管理モジュールが求められた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **`Uint32Array` ビット行列による推移閉包の直接保持**:
   - 各内部スロットについて下位集合 `lower` と上位集合 `upper` を `Uint32Array` のビットベクトルとして保持し、互いに転置関係とすることで、2要素間の順序比較 `compare` を定数時間 $O(1)$、上位・下位集合の列挙を `Math.clz32` による高速ビット走査で実行できること。
2. **推移性を利用した比較処理の削減**:
   - 新規オブジェクト $X$ の追加時、$A < X$ が判明した時点で $A$ の下位集合（`lower[A] & active`）をビットOR演算で $X$ の下位集合へ伝播し、$X < B$ が判明した時点で $B$ の上位集合（`upper[B] & active`）を $X$ の上位集合へ伝播することで、既知となった要素との比較関数呼び出しを省略すること。
3. **論理削除と内部スロット再利用・ID分離**:
   - 有効スロットを示す `active` ビットベクトルとフリーリストにより償却 $O(1)$ の論理削除とスロット再利用を実現し、公開IDと内部スロット番号を分離して削除済みIDの誤参照や旧関係情報の混入を防止すること。
4. **ビットAND演算によるハッセ図（被覆関係）の導出**:
   - $A < B$ かつ $(\text{upper}[A] \mathbin{\&} \text{lower}[B] \mathbin{\&} \text{active}) = 0$ のビットAND判定により中間要素の有無を高速検査し、被覆関係を導出すること。
5. **ドメイン非依存の再利用性と既存インターフェースとの完全互換**:
   - ジェネリクスを用いた `BitsetPoset<T, Id>` としてドメイン処理から独立させつつ、`SubjectPoset` の既存公開APIを維持すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: 従来の `Map<Id, Set<Id>>` と変更時BFS/DFSキャッシュ再構築を継続**
  - *問題点*: オブジェクト生成負荷が高く、被覆関係判定や共通上位探索（LCA）で集合の積演算コストが大きい。
- **選択肢B: 通常の2次元 `boolean[][]` または `number[][]` 配列**
  - *問題点*: 32要素ごとのビット並列論理演算（AND / OR / NOT）や `Math.clz32` による高速ビット走査が使えず、メモリ消費量も1要素あたり32倍以上となる。
- **選択肢C (採用): `Uint32Array` 転置ビット行列（`lower` / `upper`）＋ `active` ビットマスクによる `BitsetPoset<T, Id>` の導入**
  - 32ビット単位のビット論理演算により推移閉包伝播・被覆判定・LCA探索・論理削除マスクをすべて高速実行でき、メモリ消費量も $M = 8N \times \lceil S / 32 \rceil$ [byte] に抑えられる。

---

## 4. 決定事項 (Decision Outcome)

1. **汎用半順序集合モジュール `BitsetPoset<T, Id>` の新設（`src/tools/vta/features/vta/utils/bitsetPoset.ts`）**:
   - 内部表現として `active: Uint32Array`、`lower: Uint32Array[]`、`upper: Uint32Array[]` を保持。
   - 外部公開ID（`Id`）と内部スロット番号（`number`）を `idToSlot` / `slotToId` で分離し、削除済みIDは `retiredIds` で管理して再利用を禁止。
   - `insert` 時は高位ワードMSBと低位ワードLSBの双方向交互ビット走査とビットOR伝播により、昇順・降順・ランダム順のいずれでも推移性による比較省略を実現。例外発生時は内部状態を一切変更しない原子的更新を保証。
   - `remove` は `active` ビット解除と `freeSlots` への返却により償却 $O(1)$ で実行。スロット再利用時は全スロットから当該ビットをクリアして旧情報の混入を防止。
   - 大量削除後のメモリ再圧縮 `compact()`、属性更新 `update()`、ハッセ図被覆判定 `isCovered()` / `directLowerIds()` / `directUpperIds()` / `getHasseEdges()`、最小共通上位探索 `findLCA()`、および不変条件診断 `verifyInvariants()` を提供。
2. **`SubjectPoset` の内部エンジン刷新（`src/tools/vta/features/vta/utils/subjectPoset.ts`）**:
   - `SubjectPoset` の内部グラフ表現を `BitsetPoset<string, string>` に置き換え、既存の全メソッド（`fromData`, `fromEntities`, `isAncestor`, `isDescendant`, `getAncestors`, `getDescendants`, `getImmediateParents`, `getImmediateChildren`, `findLCA`, `validate`, `removeCycles` 等）の後方互換性を維持したまま高速化。

---

## 5. 結果と影響 (Consequences)

### メリット
- **高速な検索・集合演算**: 2要素間の半順序比較が $O(1)$ ビット参照となり、上位・下位集合取得、LCA探索、ハッセ図被覆判定が32ビット単位のワード演算と `Math.clz32` により大幅に高速化された。
- **比較関数呼び出し回数の大幅削減**: 全順序や密な半順序集合において、推移性ビットOR伝播により比較回数が劇的に削減される。
- **厳格なデータ整合性**: 非反射性・反対称性・転置整合性・推移律・削除済みID保護・例外安全性が `verifyInvariants()` と単体/ランダム化テストにより保証される。

### トレードオフ・考慮事項
- メモリ消費量は $M = 8N \times \lceil S / 32 \rceil$ [byte] と要素数に対して二次関数的に増加するため、上限容量（`maxCapacity`）およびメモリ警告閾値（`memoryWarningBytes`）を設定可能とし、大量削除後の `compact()` 機能を備える。

### 影響ファイル
- [src/tools/vta/features/vta/utils/bitsetPoset.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/bitsetPoset.ts)
- [src/tools/vta/features/vta/utils/subjectPoset.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/subjectPoset.ts)
- [docs/adr/README.md](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/docs/adr/README.md)
- [docs/vta/REFERENCE.md](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/docs/vta/REFERENCE.md)
- [tests/vta/bitsetPoset.test.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/tests/vta/bitsetPoset.test.ts)
- [tests/benchmark/bitsetPosetBenchmark.test.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/tests/benchmark/bitsetPosetBenchmark.test.ts)
