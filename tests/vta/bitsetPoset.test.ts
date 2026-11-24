import { describe, it, expect } from 'vitest';
import {
  BitsetPoset,
  type PosetComparator,
  type PosetRelationResult,
} from '../../src/tools/vta/features/vta/utils/bitsetPoset';

/**
 * 参照実装（単純な全要素比較方式）:
 * ランダム化プロパティテストで BitsetPoset の結果と完全一致することを検証するために使用
 */
class NaiveReferencePoset<T, Id = string> {
  private items = new Map<Id, T>();
  private readonly compareFn: PosetComparator<T>;

  constructor(compareFn: PosetComparator<T>) {
    this.compareFn = compareFn;
  }

  public insert(item: T, id: Id): Id {
    if (this.items.has(id)) throw new Error('Duplicate ID');
    for (const [, existing] of this.items) {
      if (this.compareFn(item, existing) === 'eq') {
        throw new Error('Equivalent item');
      }
    }
    this.items.set(id, item);
    return id;
  }

  public remove(id: Id): boolean {
    return this.items.delete(id);
  }

  public get size(): number {
    return this.items.size;
  }

  public compare(idA: Id, idB: Id): PosetRelationResult {
    const a = this.items.get(idA);
    const b = this.items.get(idB);
    if (a === undefined || b === undefined) throw new Error('Invalid ID');
    if (idA === idB) return 'eq';
    return this.compareFn(a, b);
  }

  public lowerIds(id: Id): Id[] {
    const target = this.items.get(id);
    if (target === undefined) throw new Error('Invalid ID');
    const res: Id[] = [];
    for (const [otherId, other] of this.items) {
      if (otherId !== id && this.compareFn(other, target) === 'lt') {
        res.push(otherId);
      }
    }
    return res;
  }

  public upperIds(id: Id): Id[] {
    const target = this.items.get(id);
    if (target === undefined) throw new Error('Invalid ID');
    const res: Id[] = [];
    for (const [otherId, other] of this.items) {
      if (otherId !== id && this.compareFn(target, other) === 'lt') {
        res.push(otherId);
      }
    }
    return res;
  }

  public isCovered(lowerId: Id, upperId: Id): boolean {
    if (this.compare(lowerId, upperId) !== 'lt') return false;
    const uA = new Set(this.upperIds(lowerId));
    const lB = new Set(this.lowerIds(upperId));
    for (const mid of uA) {
      if (lB.has(mid)) return false;
    }
    return true;
  }
}

const numberCompare: PosetComparator<number> = (a, b) => {
  if (a === b) return 'eq';
  return a < b ? 'lt' : 'gt';
};

/** ビットマスクで表された部分集合の包含関係 (A ⊂ B <=> (A & ~B) === 0 && A !== B) */
const subsetMaskCompare: PosetComparator<number> = (a, b) => {
  if (a === b) return 'eq';
  if ((a & ~b) === 0) return 'lt'; // a ⊂ b
  if ((b & ~a) === 0) return 'gt'; // b ⊂ a
  return 'nc';
};

describe('BitsetPoset (Uint32Array ビット行列による高速半順序集合管理)', () => {
  it('1. 空集合に対する操作が正しく動作する', () => {
    const poset = new BitsetPoset<number>(numberCompare);
    expect(poset.size).toBe(0);
    expect(poset.getSize()).toBe(0);
    expect(poset.ids()).toEqual([]);
    expect(poset.get('non_existent')).toBeUndefined();
    expect(poset.has('non_existent')).toBe(false);
    expect(poset.remove('non_existent')).toBe(false);
    expect(poset.getHasseEdges()).toEqual([]);
    expect(poset.verifyInvariants().valid).toBe(true);
  });

  it('2. オブジェクトの追加・取得・削除および基本クエリが動作する', () => {
    const poset = new BitsetPoset<number>(numberCompare);
    const id1 = poset.insert(10, 'n10');
    const id2 = poset.insert(20, 'n20');
    const id3 = poset.insert(30, 'n30');

    expect(poset.size).toBe(3);
    expect(poset.get(id1)).toBe(10);
    expect(poset.get(id2)).toBe(20);
    expect(poset.get(id3)).toBe(30);

    expect(poset.compare('n10', 'n20')).toBe('lt');
    expect(poset.compare('n20', 'n10')).toBe('gt');
    expect(poset.compare('n10', 'n10')).toBe('eq');
    expect(poset.compare('n10', 'n30')).toBe('lt');

    expect(poset.lowerIds('n30').sort()).toEqual(['n10', 'n20']);
    expect(poset.upperIds('n10').sort()).toEqual(['n20', 'n30']);

    // 中間要素 n20 を削除しても残存要素 n10 < n30 の関係は維持される
    expect(poset.remove('n20')).toBe(true);
    expect(poset.size).toBe(2);
    expect(poset.has('n20')).toBe(false);
    expect(poset.get('n20')).toBeUndefined();
    expect(poset.compare('n10', 'n30')).toBe('lt');
    expect(poset.lowerIds('n30')).toEqual(['n10']);
    expect(poset.upperIds('n10')).toEqual(['n30']);
    expect(poset.verifyInvariants().valid).toBe(true);
  });

  it('3. 全順序集合（昇順・降順・ランダム順）で推移性による比較削減と推移閉包が機能する', () => {
    // 昇順挿入: N=50 で比較回数が N-1 = 49 回に削減されることを確認
    const ascPoset = new BitsetPoset<number>(numberCompare);
    for (let i = 0; i < 50; i++) {
      ascPoset.insert(i, `v_${i}`);
    }
    expect(ascPoset.size).toBe(50);
    expect(ascPoset.comparisonCount).toBe(49); // 推移性により毎回1回の比較で完了
    expect(ascPoset.compare('v_0', 'v_49')).toBe('lt');
    expect(ascPoset.lowerIds('v_49')).toHaveLength(49);
    expect(ascPoset.upperIds('v_0')).toHaveLength(49);
    expect(ascPoset.verifyInvariants().valid).toBe(true);

    // 降順挿入: N=50 で比較回数が N-1 = 49 回に削減されることを確認
    const descPoset = new BitsetPoset<number>(numberCompare);
    for (let i = 49; i >= 0; i--) {
      descPoset.insert(i, `v_${i}`);
    }
    expect(descPoset.size).toBe(50);
    expect(descPoset.comparisonCount).toBe(49);
    expect(descPoset.compare('v_0', 'v_49')).toBe('lt');
    expect(descPoset.verifyInvariants().valid).toBe(true);
  });

  it('4. すべてのオブジェクトが相互に比較不能な集合（反鎖: Antichain）を扱える', () => {
    const antichain = new BitsetPoset<number>(() => 'nc');
    for (let i = 0; i < 40; i++) {
      antichain.insert(i, `a_${i}`);
    }
    expect(antichain.size).toBe(40);
    for (let i = 0; i < 40; i++) {
      expect(antichain.lowerIds(`a_${i}`)).toEqual([]);
      expect(antichain.upperIds(`a_${i}`)).toEqual([]);
      for (let j = 0; j < 40; j++) {
        expect(antichain.compare(`a_${i}`, `a_${j}`)).toBe(i === j ? 'eq' : 'nc');
      }
    }
    expect(antichain.getHasseEdges()).toEqual([]);
    expect(antichain.verifyInvariants().valid).toBe(true);
  });

  it('5. 複数の上位・下位オブジェクトを持つ半順序集合（非木構造DAG・束）を正しく管理する', () => {
    // 3ビットブール束: 000(0) < {001(1), 010(2), 100(4)} < {011(3), 101(5), 110(6)} < 111(7)
    const lattice = new BitsetPoset<number>(subsetMaskCompare);
    for (let mask = 0; mask < 8; mask++) {
      lattice.insert(mask, `m${mask}`);
    }

    // m3 (011) の下位は m0(000), m1(001), m2(010)
    expect(lattice.lowerIds('m3').sort()).toEqual(['m0', 'm1', 'm2']);
    // m3 (011) の直接下位（被覆）は m1(001), m2(010) の2つ（m0は推移的）
    expect([...lattice.directLowerIds('m3')].sort()).toEqual(['m1', 'm2']);
    // m1 (001) の直接上位（被覆）は m3(011), m5(101) の2つ
    expect([...lattice.directUpperIds('m1')].sort()).toEqual(['m3', 'm5']);

    // m1(001) と m2(010) は比較不能 ('nc') であり、LCA は m3(011)
    expect(lattice.compare('m1', 'm2')).toBe('nc');
    expect(lattice.findLCA('m1', 'm2')).toBe('m3');
    expect(lattice.verifyInvariants().valid).toBe(true);
  });

  it('6. 同値オブジェクト（eq）の登録方針が設定通り機能する', () => {
    const strictPoset = new BitsetPoset<number>((a, b) =>
      Math.floor(a / 10) === Math.floor(b / 10) ? 'eq' : a < b ? 'lt' : 'gt'
    );
    strictPoset.insert(12, 'first');
    expect(() => strictPoset.insert(15, 'second')).toThrow(/同値なオブジェクト/);
    expect(strictPoset.size).toBe(1);
    expect(strictPoset.has('second')).toBe(false);

    // treat_as_incomparable 指定時は比較不能として両方登録可能
    const relaxedPoset = new BitsetPoset<number>(
      (a, b) => (Math.floor(a / 10) === Math.floor(b / 10) ? 'eq' : a < b ? 'lt' : 'gt'),
      { duplicatePolicy: 'treat_as_incomparable' }
    );
    relaxedPoset.insert(12, 'first');
    relaxedPoset.insert(15, 'second');
    expect(relaxedPoset.size).toBe(2);
    expect(relaxedPoset.compare('first', 'second')).toBe('nc');
  });

  it('7 & 8. 推移律の維持と上位行列・下位行列の転置整合性が保証される', () => {
    const poset = new BitsetPoset<number>(() => 'nc');
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      poset.insert(0, id);
    }
    expect(poset.addOrderRelation('A', 'B')).toBe(true);
    expect(poset.addOrderRelation('B', 'C')).toBe(true);
    expect(poset.addOrderRelation('C', 'D')).toBe(true);
    expect(poset.addOrderRelation('B', 'E')).toBe(true);

    // A < B < C < D により A < D が成立
    expect(poset.compare('A', 'D')).toBe('lt');
    expect(poset.compare('D', 'A')).toBe('gt');
    // サイクル形成 D < A は拒否される
    expect(poset.addOrderRelation('D', 'A')).toBe(false);

    const report = poset.verifyInvariants();
    expect(report.valid).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('9 & 10. ビット境界（31, 32, 63, 64, 127, 128）および動的容量拡張が正しく動作する', () => {
    let warningCalled = false;
    const poset = new BitsetPoset<number>(numberCompare, {
      initialCapacity: 32,
      memoryWarningBytes: 128,
      onMemoryWarning: () => {
        warningCalled = true;
      },
    });
    expect(poset.capacity).toBe(32);

    // 0 から 130 まで 131 個挿入（32 -> 64 -> 128 -> 256 へ動的倍増拡張）
    for (let i = 0; i <= 130; i++) {
      poset.insert(i, `id_${i}`);
    }

    expect(poset.capacity).toBe(256);
    expect(warningCalled).toBe(true);

    // ビット境界 (31, 32, 63, 64, 127, 128) での順序と上下集合を検証
    const boundaries = [0, 30, 31, 32, 33, 62, 63, 64, 65, 126, 127, 128, 129, 130];
    for (let i = 0; i < boundaries.length; i++) {
      for (let j = i + 1; j < boundaries.length; j++) {
        const u = boundaries[i];
        const v = boundaries[j];
        expect(poset.compare(`id_${u}`, `id_${v}`)).toBe('lt');
        expect(poset.compare(`id_${v}`, `id_${u}`)).toBe('gt');
      }
      const b = boundaries[i];
      expect(poset.lowerIds(`id_${b}`)).toHaveLength(b);
      expect(poset.upperIds(`id_${b}`)).toHaveLength(130 - b);
    }

    expect(poset.verifyInvariants().valid).toBe(true);
  });

  it('11 & 12. 削除済みスロットの再利用・大量の追加削除反復・update・compact で旧関係情報が混入しない', () => {
    const poset = new BitsetPoset<number>(subsetMaskCompare, { initialCapacity: 32 });

    // 64個追加
    for (let i = 0; i < 64; i++) {
      poset.insert(i, `s_${i}`);
    }
    expect(poset.size).toBe(64);

    // 偶数インデックスの32個を論理削除
    for (let i = 0; i < 64; i += 2) {
      expect(poset.remove(`s_${i}`)).toBe(true);
    }
    expect(poset.size).toBe(32);

    // 削除されたスロットを再利用して、全く異なる関係を持つ32個を追加
    for (let i = 0; i < 32; i++) {
      // 偶数iは単独の上位ビット 1 << (6 + (i >> 1))（既存の 1..63 と比較不能）、奇数iはさらに | 63（既存の 1..63 の上位）
      const highBit = 1 << (6 + (i >> 1));
      const newMask = (i & 1) === 0 ? highBit : highBit | 63;
      poset.insert(newMask, `reused_${i}`);
    }
    expect(poset.size).toBe(64);
    expect(poset.capacity).toBe(64); // フリーリスト再利用のため容量拡張は発生しない

    // reused_0 は (1 << 10) なので、既存の奇数マスク s_1, s_3... とは比較不能 ('nc') でなければならない
    // （もし旧スロットの関係ビットが残存していれば誤って lt/gt になる）
    expect(poset.compare('reused_0', 's_1')).toBe('nc');
    expect(poset.compare('reused_0', 's_63')).toBe('nc');
    // reused_1 は (1 << 10) | 63 なので、既存の全奇数マスク s_1..s_63 を包含する ('gt')
    expect(poset.compare('reused_1', 's_1')).toBe('gt');
    expect(poset.compare('reused_1', 's_63')).toBe('gt');

    // 属性の更新 (update): reused_0 の値を 0（空集合 = 最小元）に変更
    expect(poset.update('reused_0', 0)).toBe(true);
    expect(poset.compare('reused_0', 's_1')).toBe('lt');
    expect(poset.compare('reused_0', 'reused_1')).toBe('lt');

    // 大量削除後に compact() を実行し、スロット容量が縮小しても全関係が維持されることを検証
    for (let i = 1; i < 32; i++) {
      poset.remove(`reused_${i}`);
    }
    for (let i = 3; i < 64; i += 2) {
      poset.remove(`s_${i}`);
    }
    expect(poset.size).toBe(2); // reused_0 と s_1 のみ残存
    poset.compact();
    expect(poset.capacity).toBe(32);
    expect(poset.compare('reused_0', 's_1')).toBe('lt');
    expect(poset.verifyInvariants().valid).toBe(true);
  });

  it('13. 無効なIDおよび削除済みIDへのアクセス・再利用が確実に拒否される', () => {
    const poset = new BitsetPoset<number>(numberCompare);
    poset.insert(1, 'id_A');
    poset.insert(2, 'id_B');
    poset.remove('id_A');

    // 削除済みIDによる検索は例外を送出
    expect(() => poset.compare('id_A', 'id_B')).toThrow();
    expect(() => poset.lowerIds('id_A')).toThrow();
    expect(() => poset.upperIds('id_A')).toThrow();
    expect(() => poset.directLowerIds('id_A')).toThrow();
    expect(() => poset.directUpperIds('id_A')).toThrow();
    expect(() => poset.isCovered('id_A', 'id_B')).toThrow();

    // 削除済みIDを新たなオブジェクトに再割り当てしようとしても拒否される
    expect(() => poset.insert(3, 'id_A')).toThrow(/削除済みID/);
    expect(poset.verifyInvariants().valid).toBe(true);
  });

  it('14. 関係判定関数で例外が発生した場合、不完全なオブジェクトや矛盾した関係情報が一切残らない', () => {
    let shouldThrow = false;
    const faultyCompare: PosetComparator<number> = (a, b) => {
      if (shouldThrow && b === 20) {
        throw new Error('Comparator failure during insertion');
      }
      return numberCompare(a, b);
    };

    const poset = new BitsetPoset<number>(faultyCompare);
    poset.insert(10, 'n10');
    poset.insert(20, 'n20');
    poset.insert(30, 'n30');

    shouldThrow = true;
    expect(() => poset.insert(25, 'n25')).toThrow('Comparator failure during insertion');

    // 失敗した n25 が登録されておらず、既存要素の不変条件も100%無傷であることを確認
    expect(poset.size).toBe(3);
    expect(poset.has('n25')).toBe(false);
    expect(poset.upperIds('n10').sort()).toEqual(['n20', 'n30']);
    expect(poset.lowerIds('n30').sort()).toEqual(['n10', 'n20']);
    expect(poset.verifyInvariants().valid).toBe(true);
  });

  it('15. ハッセ図および被覆関係（isCovered / directLowerIds / directUpperIds / getHasseEdges）が正当である', () => {
    const poset = new BitsetPoset<number>(numberCompare);
    poset.insert(1, 'n1');
    poset.insert(2, 'n2');
    poset.insert(3, 'n3');
    poset.insert(4, 'n4');

    // 全順序 1 < 2 < 3 < 4 のハッセ図は (1,2), (2,3), (3,4) の3辺のみ
    expect(poset.isCovered('n1', 'n2')).toBe(true);
    expect(poset.isCovered('n2', 'n3')).toBe(true);
    expect(poset.isCovered('n3', 'n4')).toBe(true);
    expect(poset.isCovered('n1', 'n3')).toBe(false);
    expect(poset.isCovered('n1', 'n4')).toBe(false);

    expect(poset.getHasseEdges()).toEqual([
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
      { from: 'n3', to: 'n4' },
    ]);

    // n2 を論理削除すると、n1 と n3 の間の中間有効要素が消えるため (n1, n3) が直接被覆関係になる
    poset.remove('n2');
    expect(poset.isCovered('n1', 'n3')).toBe(true);
    expect(poset.directUpperIds('n1')).toEqual(['n3']);
    expect(poset.directLowerIds('n3')).toEqual(['n1']);
  });

  it('16. ランダム化プロパティテスト: 集合の包含関係で単純な全要素比較方式と結果が完全一致する', () => {
    // 決定論的疑似乱数 (LCG)
    let seed = 123456789;
    const nextRand = () => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return seed;
    };

    const bitsetPoset = new BitsetPoset<number>(subsetMaskCompare, { initialCapacity: 32 });
    const naivePoset = new NaiveReferencePoset<number>(subsetMaskCompare);
    const activeIds: string[] = [];
    const usedMasks = new Set<number>();

    // 120ステップのランダム追加・削除を実行
    for (let step = 0; step < 120; step++) {
      const doRemove = activeIds.length > 15 && nextRand() % 4 === 0;
      if (doRemove) {
        const idx = nextRand() % activeIds.length;
        const targetId = activeIds.splice(idx, 1)[0];
        const mask = bitsetPoset.get(targetId)!;
        usedMasks.delete(mask);
        expect(bitsetPoset.remove(targetId)).toBe(true);
        expect(naivePoset.remove(targetId)).toBe(true);
      } else {
        // 12ビットのランダム部分集合マスクを生成（重複回避）
        let mask = nextRand() & 0xfff;
        while (usedMasks.has(mask)) {
          mask = nextRand() & 0xfff;
        }
        usedMasks.add(mask);
        const id = `item_${step}`;
        bitsetPoset.insert(mask, id);
        naivePoset.insert(mask, id);
        activeIds.push(id);
      }
    }

    expect(bitsetPoset.size).toBe(naivePoset.size);
    expect(bitsetPoset.verifyInvariants().valid).toBe(true);

    // すべての有効ペアについて compare, lowerIds, upperIds, isCovered が完全一致することを検証
    for (const idA of activeIds) {
      expect(bitsetPoset.lowerIds(idA).sort()).toEqual(naivePoset.lowerIds(idA).sort());
      expect(bitsetPoset.upperIds(idA).sort()).toEqual(naivePoset.upperIds(idA).sort());

      for (const idB of activeIds) {
        expect(bitsetPoset.compare(idA, idB)).toBe(naivePoset.compare(idA, idB));
        expect(bitsetPoset.isCovered(idA, idB)).toBe(naivePoset.isCovered(idA, idB));
      }
    }
  });

  it('12. 多重親 SubjectPoset において resolveCardsForRelationEndpoint が mergedFrom の実際の統合先カードを優先解決する', async () => {
    const { SubjectPoset, resolveCardsForRelationEndpoint } = await import(
      '../../src/tools/vta/features/vta/utils/subjectPoset'
    );
    // F作業員 belongs to BOTH A2 (作業班) and A3 (下請会社)
    const poset = SubjectPoset.fromEntities([
      { id: 'A2', name: '除草薬散布作業班' },
      { id: 'A3', name: '下請会社' },
      { id: 'F', name: 'F作業員', parentEntityIds: ['A2', 'A3'] },
    ]);
    expect(poset.isAncestor('A2', 'F')).toBe(true);
    expect(poset.isAncestor('A3', 'F')).toBe(true);

    // F was consolidated into A2 (recorded in mergedFrom), while A3 also has a card on E1
    const cards = [
      { id: 'card_A3', laneEntityId: 'A3', eventIds: ['E1'] },
      { id: 'card_A2', laneEntityId: 'A2', eventIds: ['E1'] },
    ];
    const participations = [
      { eventId: 'E1', entityId: 'A3', role: 'actor' as const },
      {
        eventId: 'E1',
        entityId: 'A2',
        role: 'target' as const,
        mergedFrom: [{ entityId: 'F', role: 'target' as const }],
      },
    ];

    const resolved = resolveCardsForRelationEndpoint(
      cards,
      participations,
      poset,
      'E1',
      'F',
      'F',
      'source'
    );
    // Without mergedFrom priority, A3 (:actor) would have outranked A2 (:target) via Poset ancestry!
    // With mergedFrom priority, only card_A2 (actual consolidation destination of F) is matched.
    expect(resolved.map((c) => c.id)).toEqual(['card_A2']);
  });
});
