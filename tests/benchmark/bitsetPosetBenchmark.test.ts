import { describe, it, expect } from 'vitest';
import {
  BitsetPoset,
  type PosetComparator,
  type PosetRelationResult,
} from '../../src/tools/vta/features/vta/utils/bitsetPoset';

/**
 * 旧実装方式（Map<string, Set<string>> + DFS推移閉包キャッシュ）の再現クラス
 */
class LegacyMapSetPoset<T> {
  private items = new Map<string, T>();
  private parentsMap = new Map<string, Set<string>>();
  private childrenMap = new Map<string, Set<string>>();
  private ancestorsCache: Map<string, Set<string>> | null = null;
  private descendantsCache: Map<string, Set<string>> | null = null;
  public comparisonCount = 0;

  constructor(private readonly compareFn: PosetComparator<T>) {}

  public insert(item: T, id: string): void {
    const parents = new Set<string>();
    const children = new Set<string>();
    for (const [otherId, otherItem] of this.items) {
      this.comparisonCount++;
      const rel = this.compareFn(item, otherItem);
      if (rel === 'lt') {
        parents.add(otherId);
        this.childrenMap.get(otherId)!.add(id);
      } else if (rel === 'gt') {
        children.add(otherId);
        this.parentsMap.get(otherId)!.add(id);
      }
    }
    this.items.set(id, item);
    this.parentsMap.set(id, parents);
    this.childrenMap.set(id, children);
    this.ancestorsCache = null;
    this.descendantsCache = null;
  }

  public remove(id: string): boolean {
    if (!this.items.delete(id)) return false;
    this.parentsMap.delete(id);
    this.childrenMap.delete(id);
    for (const p of this.parentsMap.values()) p.delete(id);
    for (const c of this.childrenMap.values()) c.delete(id);
    this.ancestorsCache = null;
    this.descendantsCache = null;
    return true;
  }

  private ensureClosure(): void {
    if (this.ancestorsCache && this.descendantsCache) return;
    const anc = new Map<string, Set<string>>();
    const desc = new Map<string, Set<string>>();
    for (const node of this.items.keys()) {
      anc.set(node, new Set());
      desc.set(node, new Set());
    }
    for (const node of this.items.keys()) {
      const visited = new Set<string>(this.parentsMap.get(node) ?? []);
      const queue = Array.from(visited);
      let head = 0;
      while (head < queue.length) {
        const p = queue[head++];
        anc.get(node)!.add(p);
        desc.get(p)?.add(node);
        for (const gp of this.parentsMap.get(p) ?? []) {
          if (!visited.has(gp)) {
            visited.add(gp);
            queue.push(gp);
          }
        }
      }
    }
    this.ancestorsCache = anc;
    this.descendantsCache = desc;
  }

  public compare(idA: string, idB: string): PosetRelationResult {
    if (idA === idB) return 'eq';
    this.ensureClosure();
    if (this.ancestorsCache?.get(idA)?.has(idB)) return 'lt';
    if (this.descendantsCache?.get(idA)?.has(idB)) return 'gt';
    return 'nc';
  }

  public upperIds(id: string): string[] {
    this.ensureClosure();
    return Array.from(this.ancestorsCache?.get(id) ?? []);
  }

  public lowerIds(id: string): string[] {
    this.ensureClosure();
    return Array.from(this.descendantsCache?.get(id) ?? []);
  }
}

/**
 * 単純な全要素比較方式（クエリ時に関数を都度呼び出す）
 */
class NaiveAllPairsPoset<T> {
  private items = new Map<string, T>();
  public comparisonCount = 0;

  constructor(private readonly compareFn: PosetComparator<T>) {}

  public insert(item: T, id: string): void {
    for (const [, other] of this.items) {
      this.comparisonCount++;
      this.compareFn(item, other);
    }
    this.items.set(id, item);
  }

  public remove(id: string): boolean {
    return this.items.delete(id);
  }

  public compare(idA: string, idB: string): PosetRelationResult {
    if (idA === idB) return 'eq';
    const a = this.items.get(idA)!;
    const b = this.items.get(idB)!;
    this.comparisonCount++;
    return this.compareFn(a, b);
  }

  public upperIds(id: string): string[] {
    const target = this.items.get(id)!;
    const res: string[] = [];
    for (const [otherId, other] of this.items) {
      if (otherId !== id) {
        this.comparisonCount++;
        if (this.compareFn(target, other) === 'lt') res.push(otherId);
      }
    }
    return res;
  }
}

interface Point2D {
  x: number;
  y: number;
  payload: number[];
}

const cheapChainCompare: PosetComparator<number> = (a, b) => (a === b ? 'eq' : a < b ? 'lt' : 'gt');
const cheapAntichainCompare: PosetComparator<number> = (a, b) => (a === b ? 'eq' : 'nc');

/** 2次元座標支配順序（疎・密の制御用） */
const point2DCompare: PosetComparator<Point2D> = (a, b) => {
  if (a.x === b.x && a.y === b.y) return 'eq';
  if (a.x <= b.x && a.y <= b.y) return 'lt';
  if (a.x >= b.x && a.y >= b.y) return 'gt';
  return 'nc';
};

/** 計算コストが大きい比較関数（配列走査を伴う） */
const expensiveChainCompare: PosetComparator<Point2D> = (a, b) => {
  let acc = 0;
  for (let i = 0; i < a.payload.length; i++) {
    acc += (a.payload[i] ^ b.payload[i]) & 1;
  }
  if (acc < 0) return 'nc';
  if (a.x === b.x) return 'eq';
  return a.x < b.x ? 'lt' : 'gt';
};

describe('BitsetPoset 性能評価ベンチマーク', () => {
  it('構造別・規模別の比較ベンチマークを実行し、高速化効果を検証する', () => {
    const results: Array<Record<string, string | number>> = [];

    // 1. 規模別 (100, 1000, 5000, 10000) の全順序集合ベンチマーク
    for (const N of [100, 1000, 5000, 10000]) {
      const bitset = new BitsetPoset<number>(cheapChainCompare, { initialCapacity: 64 });
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        bitset.insert(i, `id_${i}`);
      }
      const insertMs = performance.now() - t0;

      const tQuery0 = performance.now();
      let ltCount = 0;
      for (let i = 0; i < 1000; i++) {
        const a = i % N;
        const b = (i * 7 + 3) % N;
        if (bitset.compare(`id_${a}`, `id_${b}`) === 'lt') ltCount++;
      }
      const compare1kMs = performance.now() - tQuery0;

      const tUpper0 = performance.now();
      for (let i = 0; i < 100; i++) {
        bitset.upperIds(`id_${i % N}`);
      }
      const upper100Ms = performance.now() - tUpper0;

      const tRem0 = performance.now();
      for (let i = 0; i < Math.min(100, N); i++) {
        bitset.remove(`id_${i}`);
      }
      const remove100Ms = performance.now() - tRem0;

      results.push({
        condition: `Chain (N=${N}, Pruned)`,
        insertMs: Number(insertMs.toFixed(2)),
        comparisons: bitset.comparisonCount,
        compare1kMs: Number(compare1kMs.toFixed(3)),
        upper100Ms: Number(upper100Ms.toFixed(3)),
        remove100Ms: Number(remove100Ms.toFixed(3)),
        memoryBytes: bitset.getMemoryUsageBytes(),
        ltCount,
      });
    }

    // 2. N=1000 における構造別（全順序・反鎖・疎なPoset・密なPoset）および方式別比較
    const N = 1000;

    // 疎なPoset: x は 0..999、y は (i % 50) * 20 + Math.floor(i / 50)
    const sparseItems: Point2D[] = Array.from({ length: N }, (_, i) => ({
      x: i,
      y: (i % 50) * 100 - Math.floor(i / 50),
      payload: [],
    }));

    // 密なPoset: x = i, y = i + (i % 5)
    const denseItems: Point2D[] = Array.from({ length: N }, (_, i) => ({
      x: i,
      y: i - (i % 4),
      payload: [],
    }));

    for (const [label, items] of [
      ['Sparse Poset (N=1000)', sparseItems],
      ['Dense Poset (N=1000)', denseItems],
    ] as const) {
      // BitsetPoset (Pruned)
      const bp = new BitsetPoset<Point2D>(point2DCompare);
      const tBp0 = performance.now();
      for (let i = 0; i < N; i++) bp.insert(items[i], `id_${i}`);
      const bpInsertMs = performance.now() - tBp0;

      const tBpQ = performance.now();
      for (let i = 0; i < 200; i++) bp.upperIds(`id_${i}`);
      const bpUpperMs = performance.now() - tBpQ;

      // LegacyMapSetPoset
      const legacy = new LegacyMapSetPoset<Point2D>(point2DCompare);
      const tLeg0 = performance.now();
      for (let i = 0; i < N; i++) legacy.insert(items[i], `id_${i}`);
      const legInsertMs = performance.now() - tLeg0;

      const tLegQ = performance.now();
      for (let i = 0; i < 200; i++) legacy.upperIds(`id_${i}`);
      const legUpperMs = performance.now() - tLegQ;

      // NaiveAllPairsPoset
      const naive = new NaiveAllPairsPoset<Point2D>(point2DCompare);
      const tNaive0 = performance.now();
      for (let i = 0; i < N; i++) naive.insert(items[i], `id_${i}`);
      const naiveInsertMs = performance.now() - tNaive0;

      const tNaiveQ = performance.now();
      for (let i = 0; i < 200; i++) naive.upperIds(`id_${i}`);
      const naiveUpperMs = performance.now() - tNaiveQ;

      results.push({
        condition: `${label} - BitsetPoset`,
        insertMs: Number(bpInsertMs.toFixed(2)),
        comparisons: bp.comparisonCount,
        upper200Ms: Number(bpUpperMs.toFixed(2)),
        memoryBytes: bp.getMemoryUsageBytes(),
      });
      results.push({
        condition: `${label} - LegacyMapSet`,
        insertMs: Number(legInsertMs.toFixed(2)),
        comparisons: legacy.comparisonCount,
        upper200Ms: Number(legUpperMs.toFixed(2)),
        memoryBytes: -1,
      });
      results.push({
        condition: `${label} - NaiveAllPairs`,
        insertMs: Number(naiveInsertMs.toFixed(2)),
        comparisons: naive.comparisonCount,
        upper200Ms: Number(naiveUpperMs.toFixed(2)),
        memoryBytes: -1,
      });
    }

    // 3. 反鎖 (Antichain, N=1000)
    {
      const ac = new BitsetPoset<number>(cheapAntichainCompare);
      const t0 = performance.now();
      for (let i = 0; i < N; i++) ac.insert(i, `id_${i}`);
      const acInsertMs = performance.now() - t0;
      results.push({
        condition: 'Antichain (N=1000)',
        insertMs: Number(acInsertMs.toFixed(2)),
        comparisons: ac.comparisonCount,
        memoryBytes: ac.getMemoryUsageBytes(),
      });
    }

    // 4. 比較関数のコストが大きい場合 (Expensive Comparator, N=500): Pruned vs Direct
    {
      const expN = 500;
      const payload = Array.from({ length: 128 }, (_, idx) => idx);
      // 決定論的シャッフル順
      const order = Array.from({ length: expN }, (_, idx) => (idx * 73) % expN);
      const expItems: Point2D[] = order.map((v) => ({ x: v, y: v, payload }));

      const pruned = new BitsetPoset<Point2D>(expensiveChainCompare, {
        useTransitivePruning: true,
      });
      const tP0 = performance.now();
      for (let i = 0; i < expN; i++) pruned.insert(expItems[i], `id_${i}`);
      const prunedMs = performance.now() - tP0;

      const direct = new BitsetPoset<Point2D>(expensiveChainCompare, {
        useTransitivePruning: false,
      });
      const tD0 = performance.now();
      for (let i = 0; i < expN; i++) direct.insert(expItems[i], `id_${i}`);
      const directMs = performance.now() - tD0;

      results.push({
        condition: 'Expensive Comparator (N=500, Pruned)',
        insertMs: Number(prunedMs.toFixed(2)),
        comparisons: pruned.comparisonCount,
      });
      results.push({
        condition: 'Expensive Comparator (N=500, Direct)',
        insertMs: Number(directMs.toFixed(2)),
        comparisons: direct.comparisonCount,
      });

      expect(pruned.comparisonCount).toBeLessThan(direct.comparisonCount);
    }

    // 5. 追加・削除の反復 (Churn: 500個維持しながら 1,000回 remove & insert)
    {
      const churnPoset = new BitsetPoset<number>(cheapChainCompare, { initialCapacity: 64 });
      for (let i = 0; i < 500; i++) {
        churnPoset.insert(i, `c_${i}`);
      }
      const capBeforeChurn = churnPoset.capacity;
      const tC0 = performance.now();
      for (let step = 0; step < 1000; step++) {
        const remIdx = step % 500;
        const oldId = step < 500 ? `c_${remIdx}` : `re_${step - 500}`;
        churnPoset.remove(oldId);
        churnPoset.insert(500 + step, `re_${step}`);
      }
      const churnMs = performance.now() - tC0;
      results.push({
        condition: 'Churn (500 active, 1000 remove+insert cycles)',
        churnMs: Number(churnMs.toFixed(2)),
        capBefore: capBeforeChurn,
        capAfter: churnPoset.capacity,
        memoryBytes: churnPoset.getMemoryUsageBytes(),
      });
      // スロット再利用により容量が膨張しないことを検証
      expect(churnPoset.capacity).toBe(capBeforeChurn);
    }

    console.table(results);
    expect(results.length).toBeGreaterThan(0);
  }, 60000);
});
