/**
 * Uint32Array ビット行列（Bit Matrix）を用いた高速半順序集合（Poset）管理モジュール
 *
 * 特徴:
 * - 各スロットについて下位集合 `lower` と上位集合 `upper`（狭義半順序の推移閉包）を `Uint32Array` で保持
 * - `lower` と `upper` は有効スロット上で互いに転置関係
 * - 有効スロットを表す `active` ビットベクトルとフリーリストによる償却 O(1) 論理削除・スロット再利用
 * - 外部公開用オブジェクトIDと内部スロット番号の完全分離（削除済みIDの誤参照防止）
 * - 新規追加時の推移性を利用した比較処理の削減（ビットOR伝播と未解決ビット走査）
 * - ビットAND演算によるハッセ図（被覆関係）の高速導出と遅延キャッシュ
 */

export type PosetRelationResult = 'lt' | 'gt' | 'eq' | 'nc';

export type PosetComparator<T> = (a: T, b: T) => PosetRelationResult;

export type DuplicatePolicy = 'reject' | 'ignore' | 'treat_as_incomparable';

export interface BitsetPosetConfig<Id = string> {
  /** 初期スロット容量（32の倍数に切り上げ。既定値: 64） */
  initialCapacity?: number;
  /** 最大スロット容量上限（既定値: 65536） */
  maxCapacity?: number;
  /** メモリ使用量警告閾値 [byte]（既定値: 16MB） */
  memoryWarningBytes?: number;
  /** メモリ警告コールバック */
  onMemoryWarning?: (currentBytes: number, thresholdBytes: number) => void;
  /** 挿入時に推移性を利用した比較省略を行うか（既定値: true） */
  useTransitivePruning?: boolean;
  /** 同値（'eq'）オブジェクト検出時の扱い（既定値: 'reject'） */
  duplicatePolicy?: DuplicatePolicy;
  /** ID自動生成関数（省略時は連番文字列を生成） */
  idGenerator?: (sequenceNumber: number) => Id;
}

export interface HasseEdge<Id = string> {
  from: Id; // 下位 (covered)
  to: Id;   // 上位 (covering)
}

export interface PosetInvariantReport {
  valid: boolean;
  violations: string[];
}

export interface SerializedBitsetPoset<T, Id = string> {
  entries: Array<{ id: Id; item: T }>;
  edges: Array<[Id, Id]>;
  nextIdSeq: number;
}

export const DEFAULT_BITSET_POSET_CONFIG = {
  initialCapacity: 64,
  maxCapacity: 65536,
  memoryWarningBytes: 16 * 1024 * 1024,
  useTransitivePruning: true,
  duplicatePolicy: 'reject' as DuplicatePolicy,
} as const;

function roundUpTo32(n: number): number {
  const clamped = Math.max(32, Math.ceil(n));
  return (clamped + 31) & ~31;
}

export class BitsetPoset<T, Id = string> {
  private readonly compareFn: PosetComparator<T>;
  private readonly maxCapacity: number;
  private readonly memoryWarningBytes: number;
  private readonly onMemoryWarning?: (currentBytes: number, thresholdBytes: number) => void;
  private readonly duplicatePolicy: DuplicatePolicy;
  private readonly idGenerator: (seq: number) => Id;
  private useTransitivePruning: boolean;

  private slotCapacity: number;
  private wordCapacity: number;
  private allocatedSlots = 0;
  private activeCount = 0;
  private nextIdSeq = 1;

  /** 有効な内部スロットを示すビットベクトル */
  private active: Uint32Array;
  /** lower[slot]: そのスロットより厳密に下位 (x < slot) の全スロットのビットベクトル */
  private lower: Uint32Array[] = [];
  /** upper[slot]: そのスロットより厳密に上位 (slot < y) の全スロットのビットベクトル */
  private upper: Uint32Array[] = [];

  /** 論理削除されたスロット番号の再利用スタック */
  private freeSlots: number[] = [];

  /** 外部公開ID -> 内部スロット番号 */
  private idToSlot = new Map<Id, number>();
  /** 内部スロット番号 -> 外部公開ID */
  private slotToId: Array<Id | undefined> = [];
  /** 内部スロット番号 -> オブジェクト本体 */
  private slotToItem: Array<T | undefined> = [];
  /** 削除済み外部IDの集合（削除済みIDが再利用されないことを保証） */
  private retiredIds = new Set<Id>();

  /** 挿入時の作業用ビットベクトル（再確保回避用） */
  private scratchLower: Uint32Array;
  private scratchUpper: Uint32Array;
  private scratchVisited: Uint32Array;

  /** ハッセ図（直接被覆関係）の遅延評価キャッシュ */
  private hasseUpperCache: Map<Id, readonly Id[]> | null = null;
  private hasseLowerCache: Map<Id, readonly Id[]> | null = null;

  /** 性能計測用：比較関数の累計呼び出し回数 */
  private totalComparisons = 0;
  /** 挿入中リエントラント検知フラグ */
  private isInserting = false;

  constructor(
    compareFn: PosetComparator<T> = () => 'nc',
    config?: BitsetPosetConfig<Id>
  ) {
    this.compareFn = compareFn;
    this.maxCapacity = config?.maxCapacity ?? DEFAULT_BITSET_POSET_CONFIG.maxCapacity;
    this.memoryWarningBytes =
      config?.memoryWarningBytes ?? DEFAULT_BITSET_POSET_CONFIG.memoryWarningBytes;
    this.onMemoryWarning = config?.onMemoryWarning;
    this.useTransitivePruning =
      config?.useTransitivePruning ?? DEFAULT_BITSET_POSET_CONFIG.useTransitivePruning;
    this.duplicatePolicy =
      config?.duplicatePolicy ?? DEFAULT_BITSET_POSET_CONFIG.duplicatePolicy;
    this.idGenerator =
      config?.idGenerator ?? ((seq: number) => `obj_${seq}` as unknown as Id);

    const initCap = roundUpTo32(
      config?.initialCapacity ?? DEFAULT_BITSET_POSET_CONFIG.initialCapacity
    );
    if (initCap > this.maxCapacity) {
      throw new Error(
        `初期容量 (${initCap}) が最大容量 (${this.maxCapacity}) を超えています。`
      );
    }

    this.slotCapacity = initCap;
    this.wordCapacity = initCap >>> 5;
    this.active = new Uint32Array(this.wordCapacity);
    this.scratchLower = new Uint32Array(this.wordCapacity);
    this.scratchUpper = new Uint32Array(this.wordCapacity);
    this.scratchVisited = new Uint32Array(this.wordCapacity);
  }

  /**
   * 有効オブジェクト数を取得
   */
  public get size(): number {
    return this.activeCount;
  }

  /**
   * 有効オブジェクト数を返すメソッド（関数呼び出し形式との互換用）
   */
  public getSize(): number {
    return this.activeCount;
  }

  /**
   * 現在の確保済みスロット容量を取得
   */
  public get capacity(): number {
    return this.slotCapacity;
  }

  /**
   * 比較関数の累計呼び出し回数を取得
   */
  public get comparisonCount(): number {
    return this.totalComparisons;
  }

  /**
   * 比較関数の呼び出し回数カウンタをリセット
   */
  public resetComparisonCount(): void {
    this.totalComparisons = 0;
  }

  /**
   * 推移性による比較省略の有効・無効を切り替える
   */
  public setTransitivePruning(enabled: boolean): void {
    this.useTransitivePruning = enabled;
  }

  /**
   * 2つのビット行列と管理ビットベクトルの推定メモリ使用量 [byte] を取得
   * M = 8N * ceil(S / 32) (+ active ベクトル分)
   */
  public getMemoryUsageBytes(): number {
    const words = this.wordCapacity;
    const matrixBytes = 8 * this.allocatedSlots * words;
    const activeBytes = 4 * words;
    return matrixBytes + activeBytes;
  }

  /**
   * 指定したIDのオブジェクトが有効として存在するか判定
   */
  public has(id: Id): boolean {
    return this.idToSlot.has(id);
  }

  /**
   * 指定したIDのオブジェクトを取得（存在しない・削除済みの場合は undefined）
   */
  public get(id: Id): T | undefined {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return undefined;
    return this.slotToItem[slot];
  }

  /**
   * 現在有効なすべてのオブジェクトIDを配列として返す
   */
  public ids(): Id[] {
    const result: Id[] = [];
    const usedWords = (this.allocatedSlots + 31) >>> 5;
    for (let w = 0; w < usedWords; w++) {
      let bits = this.active[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const bitIdx = 31 - Math.clz32(lsb);
        const slot = (w << 5) + bitIdx;
        result.push(this.slotToId[slot]!);
        bits ^= lsb;
      }
    }
    return result;
  }

  /**
   * 新たなオブジェクトを追加し、割り当てられた公開IDを返す。
   * 比較関数で例外が発生した場合や同値重複エラーの場合は、内部状態を一切変更しない。
   */
  public insert(item: T, customId?: Id): Id {
    const targetId = this.allocatePublicId(customId);
    const usedWords = (this.allocatedSlots + 31) >>> 5;

    // リエントラント呼び出し（比較関数内で別インスタンス等を操作する場合）に備え、作業バッファを選択
    const useSharedScratch = !this.isInserting;
    this.isInserting = true;

    const xLower = useSharedScratch
      ? this.scratchLower
      : new Uint32Array(this.wordCapacity);
    const xUpper = useSharedScratch
      ? this.scratchUpper
      : new Uint32Array(this.wordCapacity);
    const visited = useSharedScratch
      ? this.scratchVisited
      : new Uint32Array(this.wordCapacity);

    if (useSharedScratch) {
      xLower.fill(0, 0, usedWords);
      xUpper.fill(0, 0, usedWords);
      visited.fill(0, 0, usedWords);
    }

    try {
      if (this.activeCount > 0) {
        if (this.useTransitivePruning) {
          this.computeRelationsWithPruning(item, usedWords, xLower, xUpper, visited);
        } else {
          this.computeRelationsDirect(item, usedWords, xLower, xUpper);
        }

        // 反対称律（非巡回）検査: 同一オブジェクトが上位と下位の双方に含まれてはならない
        for (let w = 0; w < usedWords; w++) {
          if ((xLower[w] & xUpper[w]) !== 0) {
            throw new Error(
              '半順序関係の反対称律・推移律に矛盾があります（同一要素が下位集合と上位集合の双方に含まれます）。'
            );
          }
        }
      }

      // 比較処理がすべて成功した後に初めて内部スロットを割り当て、状態を更新する
      const slot = this.acquireSlot();

      const slotLower = this.lower[slot];
      const slotUpper = this.upper[slot];
      slotLower.fill(0);
      slotUpper.fill(0);

      for (let w = 0; w < usedWords; w++) {
        slotLower[w] = xLower[w] & this.active[w];
        slotUpper[w] = xUpper[w] & this.active[w];
      }

      const slotWord = slot >>> 5;
      const slotMask = 1 << (slot & 31);

      // 既存オブジェクト側のビットベクトルを更新
      // 1. xLower に属するすべての a について upper[a] に slot を追加
      for (let w = 0; w < usedWords; w++) {
        let lowBits = slotLower[w];
        while (lowBits !== 0) {
          const lsb = lowBits & -lowBits;
          const a = (w << 5) + (31 - Math.clz32(lsb));
          this.upper[a][slotWord] |= slotMask;
          lowBits ^= lsb;
        }
      }

      // 2. xUpper に属するすべての b について lower[b] に slot を追加
      for (let w = 0; w < usedWords; w++) {
        let upBits = slotUpper[w];
        while (upBits !== 0) {
          const lsb = upBits & -upBits;
          const b = (w << 5) + (31 - Math.clz32(lsb));
          this.lower[b][slotWord] |= slotMask;
          upBits ^= lsb;
        }
      }

      // 有効ビットおよびIDマッピングを登録
      this.active[slotWord] |= slotMask;
      this.idToSlot.set(targetId, slot);
      this.slotToId[slot] = targetId;
      this.slotToItem[slot] = item;
      this.activeCount += 1;
      this.invalidateHasseCache();

      this.checkMemoryWarning();
      return targetId;
    } finally {
      if (useSharedScratch) {
        this.isInserting = false;
      }
    }
  }

  /**
   * 推移性を利用して比較回数を削減しながら新規オブジェクトの下位・上位集合を求める。
   * 高位ワードのMSB側と低位ワードのLSB側を交互に走査することで、
   * 昇順・降順・ランダム順のいずれの挿入パターンでも比較省略効果を最大化する。
   */
  private computeRelationsWithPruning(
    item: T,
    usedWords: number,
    xLower: Uint32Array,
    xUpper: Uint32Array,
    visited: Uint32Array
  ): void {
    let lowW = 0;
    let highW = usedWords - 1;
    let pickHigh = true;

    while (lowW <= highW) {
      let slot = -1;

      if (pickHigh) {
        while (highW >= lowW) {
          const unresolved =
            this.active[highW] & ~(visited[highW] | xLower[highW] | xUpper[highW]);
          if (unresolved !== 0) {
            const bitIdx = 31 - Math.clz32(unresolved);
            slot = (highW << 5) + bitIdx;
            break;
          }
          highW--;
        }
      } else {
        while (lowW <= highW) {
          const unresolved =
            this.active[lowW] & ~(visited[lowW] | xLower[lowW] | xUpper[lowW]);
          if (unresolved !== 0) {
            const lsb = unresolved & -unresolved;
            const bitIdx = 31 - Math.clz32(lsb);
            slot = (lowW << 5) + bitIdx;
            break;
          }
          lowW++;
        }
      }
      pickHigh = !pickHigh;

      if (slot < 0) break;

      const w = slot >>> 5;
      const mask = 1 << (slot & 31);
      visited[w] |= mask;

      const existingItem = this.slotToItem[slot]!;
      this.totalComparisons += 1;
      const rel = this.compareFn(item, existingItem);

      if (rel === 'eq') {
        this.handleEquivalentDetected(this.slotToId[slot]!);
      } else if (rel === 'gt') {
        // existingItem < item (slot は item の下位)
        xLower[w] |= mask;
        const aLower = this.lower[slot];
        for (let k = 0; k < usedWords; k++) {
          xLower[k] |= aLower[k] & this.active[k];
        }
      } else if (rel === 'lt') {
        // item < existingItem (slot は item の上位)
        xUpper[w] |= mask;
        const aUpper = this.upper[slot];
        for (let k = 0; k < usedWords; k++) {
          xUpper[k] |= aUpper[k] & this.active[k];
        }
      }
    }
  }

  /**
   * 推移性による省略を行わず、すべての有効オブジェクトと直接比較する方式
   */
  private computeRelationsDirect(
    item: T,
    usedWords: number,
    xLower: Uint32Array,
    xUpper: Uint32Array
  ): void {
    for (let w = 0; w < usedWords; w++) {
      let bits = this.active[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const bitIdx = 31 - Math.clz32(lsb);
        const slot = (w << 5) + bitIdx;
        bits ^= lsb;

        const existingItem = this.slotToItem[slot]!;
        this.totalComparisons += 1;
        const rel = this.compareFn(item, existingItem);

        if (rel === 'eq') {
          this.handleEquivalentDetected(this.slotToId[slot]!);
        } else if (rel === 'gt') {
          xLower[w] |= lsb;
        } else if (rel === 'lt') {
          xUpper[w] |= lsb;
        }
      }
    }
  }

  private handleEquivalentDetected(existingId: Id): void {
    if (this.duplicatePolicy === 'reject') {
      throw new Error(
        `同値なオブジェクト（既存ID: ${String(existingId)}）の重複登録は禁止されています。`
      );
    }
  }

  /**
   * 登録済みオブジェクトの半順序関係を明示的に追加する（lowerId < upperId）。
   * サイクルが発生する場合は false を返し、状態を変更しない。
   */
  public addOrderRelation(lowerId: Id, upperId: Id): boolean {
    const slotU = this.idToSlot.get(lowerId);
    const slotV = this.idToSlot.get(upperId);
    if (slotU === undefined || slotV === undefined) {
      throw new Error('指定されたオブジェクトIDは存在しないか削除済みです。');
    }
    if (slotU === slotV) return false;

    const uWord = slotU >>> 5;
    const uMask = 1 << (slotU & 31);
    const vWord = slotV >>> 5;
    const vMask = 1 << (slotV & 31);

    // 既に lowerId < upperId が成立している場合
    if ((this.upper[slotU][vWord] & vMask) !== 0) {
      return true;
    }

    // 逆向き upperId < lowerId が既に成立している場合は反対称律違反（サイクル）
    if ((this.lower[slotU][vWord] & vMask) !== 0) {
      return false;
    }

    const usedWords = (this.allocatedSlots + 31) >>> 5;

    // A = {slotU} ∪ (lower[slotU] & active)
    // D = {slotV} ∪ (upper[slotV] & active)
    const aBits = new Uint32Array(usedWords);
    const dBits = new Uint32Array(usedWords);
    for (let w = 0; w < usedWords; w++) {
      aBits[w] = this.lower[slotU][w] & this.active[w];
      dBits[w] = this.upper[slotV][w] & this.active[w];
    }
    aBits[uWord] |= uMask;
    dBits[vWord] |= vMask;

    // A の各要素の upper に D をビットOR、D の各要素の lower に A をビットOR
    for (let w = 0; w < usedWords; w++) {
      let bitsA = aBits[w];
      while (bitsA !== 0) {
        const lsb = bitsA & -bitsA;
        const a = (w << 5) + (31 - Math.clz32(lsb));
        const rowUpper = this.upper[a];
        for (let k = 0; k < usedWords; k++) {
          rowUpper[k] |= dBits[k];
        }
        bitsA ^= lsb;
      }

      let bitsD = dBits[w];
      while (bitsD !== 0) {
        const lsb = bitsD & -bitsD;
        const d = (w << 5) + (31 - Math.clz32(lsb));
        const rowLower = this.lower[d];
        for (let k = 0; k < usedWords; k++) {
          rowLower[k] |= aBits[k];
        }
        bitsD ^= lsb;
      }
    }

    this.invalidateHasseCache();
    return true;
  }

  /**
   * オブジェクトを論理削除する（償却 O(1)）。
   * 他のオブジェクトのビットベクトルは削除時点では更新せず、active ビットの解除のみで除外する。
   */
  public remove(id: Id): boolean {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return false;

    const w = slot >>> 5;
    const mask = 1 << (slot & 31);
    this.active[w] &= ~mask;

    this.idToSlot.delete(id);
    this.slotToId[slot] = undefined;
    this.slotToItem[slot] = undefined;
    this.retiredIds.add(id);
    this.freeSlots.push(slot);
    this.activeCount -= 1;
    this.invalidateHasseCache();
    return true;
  }

  /**
   * 登録済みオブジェクトの属性を更新し、半順序関係情報を適切に再構築する。
   * IDはそのまま維持され、比較関数で例外が発生した場合は元のオブジェクトと関係情報が完全に保持される。
   */
  public update(id: Id, newItem: T): boolean {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return false;

    const w = slot >>> 5;
    const mask = 1 << (slot & 31);
    const usedWords = (this.allocatedSlots + 31) >>> 5;

    // 自分自身を一時的にマスクした状態で新属性による下位・上位集合を計算
    const xLower = new Uint32Array(this.wordCapacity);
    const xUpper = new Uint32Array(this.wordCapacity);
    const visited = new Uint32Array(this.wordCapacity);
    visited[w] |= mask; // 自身との比較をスキップ

    this.active[w] &= ~mask;
    try {
      if (this.activeCount > 1) {
        if (this.useTransitivePruning) {
          this.computeRelationsWithPruning(newItem, usedWords, xLower, xUpper, visited);
        } else {
          this.computeRelationsDirect(newItem, usedWords, xLower, xUpper);
        }

        for (let word = 0; word < usedWords; word++) {
          let lowBits = xLower[word];
          while (lowBits !== 0) {
            const lsb = lowBits & -lowBits;
            const slotA = (word << 5) + (31 - Math.clz32(lsb));
            const rowLower = this.lower[slotA];
            for (let k = 0; k < usedWords; k++) {
              xLower[k] |= rowLower[k] & this.active[k];
            }
            lowBits ^= lsb;
          }

          let upBits = xUpper[word];
          while (upBits !== 0) {
            const lsb = upBits & -upBits;
            const slotB = (word << 5) + (31 - Math.clz32(lsb));
            const rowUpper = this.upper[slotB];
            for (let k = 0; k < usedWords; k++) {
              xUpper[k] |= rowUpper[k] & this.active[k];
            }
            upBits ^= lsb;
          }
        }

        for (let word = 0; word < usedWords; word++) {
          if ((xLower[word] & xUpper[word]) !== 0) {
            throw new Error(
              '更新後の属性で半順序関係の反対称律・推移律に矛盾が発生しました。'
            );
          }
        }
      }
    } catch (err) {
      // 例外発生時は active ビットを元に戻して無変更を保証
      this.active[w] |= mask;
      throw err;
    }

    // 旧関係ビットを全スロットからクリアし、新関係を設定
    const clearMask = ~mask;
    for (let i = 0; i < this.allocatedSlots; i++) {
      this.lower[i][w] &= clearMask;
      this.upper[i][w] &= clearMask;
    }

    const slotLower = this.lower[slot];
    const slotUpper = this.upper[slot];
    slotLower.fill(0);
    slotUpper.fill(0);

    for (let word = 0; word < usedWords; word++) {
      slotLower[word] = xLower[word] & this.active[word];
      slotUpper[word] = xUpper[word] & this.active[word];
    }

    for (let word = 0; word < usedWords; word++) {
      let lowBits = slotLower[word];
      while (lowBits !== 0) {
        const lsb = lowBits & -lowBits;
        const a = (word << 5) + (31 - Math.clz32(lsb));
        this.upper[a][w] |= mask;
        lowBits ^= lsb;
      }

      let upBits = slotUpper[word];
      while (upBits !== 0) {
        const lsb = upBits & -upBits;
        const b = (word << 5) + (31 - Math.clz32(lsb));
        this.lower[b][w] |= mask;
        upBits ^= lsb;
      }
    }

    this.active[w] |= mask;
    this.slotToItem[slot] = newItem;
    this.invalidateHasseCache();
    return true;
  }

  /**
   * 2つの登録済みオブジェクト間の半順序関係を O(1) で取得する。
   * - 'lt': idA < idB (idA は idB の下位)
   * - 'gt': idA > idB (idA は idB の上位)
   * - 'eq': idA === idB
   * - 'nc': 比較不能
   */
  public compare(idA: Id, idB: Id): PosetRelationResult {
    const slotA = this.idToSlot.get(idA);
    const slotB = this.idToSlot.get(idB);
    if (slotA === undefined || slotB === undefined) {
      throw new Error(
        `指定されたID（${String(idA)}, ${String(idB)}）は存在しないか既に削除されています。`
      );
    }
    if (slotA === slotB) return 'eq';

    const wB = slotB >>> 5;
    const maskB = 1 << (slotB & 31);

    if ((this.upper[slotA][wB] & maskB) !== 0) return 'lt';
    if ((this.lower[slotA][wB] & maskB) !== 0) return 'gt';
    return 'nc';
  }

  /**
   * 指定オブジェクトの全下位オブジェクトID（x < id）を取得する
   */
  public lowerIds(id: Id): Id[] {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) {
      throw new Error(`指定されたID（${String(id)}）は存在しないか既に削除されています。`);
    }
    return this.collectIdsFromBitset(this.lower[slot]);
  }

  /**
   * 指定オブジェクトの全上位オブジェクトID（id < y）を取得する
   */
  public upperIds(id: Id): Id[] {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) {
      throw new Error(`指定されたID（${String(id)}）は存在しないか既に削除されています。`);
    }
    return this.collectIdsFromBitset(this.upper[slot]);
  }

  /**
   * 2つのオブジェクト A, B について A < B の直接被覆関係（ハッセ図のエッジ）が成立するか判定する。
   * A < B であり、かつ (upper[A] & lower[B] & active) === 0 のとき true。
   */
  public isCovered(lowerId: Id, upperId: Id): boolean {
    const slotA = this.idToSlot.get(lowerId);
    const slotB = this.idToSlot.get(upperId);
    if (slotA === undefined || slotB === undefined) {
      throw new Error('指定されたオブジェクトIDは存在しないか既に削除されています。');
    }
    if (slotA === slotB) return false;

    const wB = slotB >>> 5;
    const maskB = 1 << (slotB & 31);
    if ((this.upper[slotA][wB] & maskB) === 0) {
      return false; // A < B でない
    }

    const usedWords = (this.allocatedSlots + 31) >>> 5;
    const uRow = this.upper[slotA];
    const lRow = this.lower[slotB];
    for (let w = 0; w < usedWords; w++) {
      if ((uRow[w] & lRow[w] & this.active[w]) !== 0) {
        return false; // 中間オブジェクト C (A < C < B) が存在する
      }
    }
    return true;
  }

  /**
   * 指定オブジェクトを直接被覆する上位オブジェクト群（ハッセ図における直接の親）を取得する
   */
  public directUpperIds(id: Id): readonly Id[] {
    if (!this.idToSlot.has(id)) {
      throw new Error(`指定されたID（${String(id)}）は存在しないか既に削除されています。`);
    }
    if (this.hasseUpperCache?.has(id)) {
      return this.hasseUpperCache.get(id)!;
    }

    const slotA = this.idToSlot.get(id)!;
    const usedWords = (this.allocatedSlots + 31) >>> 5;
    const uRow = this.upper[slotA];
    const direct: Id[] = [];

    for (let w = 0; w < usedWords; w++) {
      let bits = uRow[w] & this.active[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const slotB = (w << 5) + (31 - Math.clz32(lsb));
        bits ^= lsb;

        const lRow = this.lower[slotB];
        let hasIntermediate = false;
        for (let k = 0; k < usedWords; k++) {
          if ((uRow[k] & lRow[k] & this.active[k]) !== 0) {
            hasIntermediate = true;
            break;
          }
        }
        if (!hasIntermediate) {
          direct.push(this.slotToId[slotB]!);
        }
      }
    }

    if (!this.hasseUpperCache) {
      this.hasseUpperCache = new Map();
    }
    this.hasseUpperCache.set(id, direct);
    return direct;
  }

  /**
   * 指定オブジェクトが直接被覆する下位オブジェクト群（ハッセ図における直接の子）を取得する
   */
  public directLowerIds(id: Id): readonly Id[] {
    if (!this.idToSlot.has(id)) {
      throw new Error(`指定されたID（${String(id)}）は存在しないか既に削除されています。`);
    }
    if (this.hasseLowerCache?.has(id)) {
      return this.hasseLowerCache.get(id)!;
    }

    const slotB = this.idToSlot.get(id)!;
    const usedWords = (this.allocatedSlots + 31) >>> 5;
    const lRow = this.lower[slotB];
    const direct: Id[] = [];

    for (let w = 0; w < usedWords; w++) {
      let bits = lRow[w] & this.active[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const slotA = (w << 5) + (31 - Math.clz32(lsb));
        bits ^= lsb;

        const uRow = this.upper[slotA];
        let hasIntermediate = false;
        for (let k = 0; k < usedWords; k++) {
          if ((uRow[k] & lRow[k] & this.active[k]) !== 0) {
            hasIntermediate = true;
            break;
          }
        }
        if (!hasIntermediate) {
          direct.push(this.slotToId[slotA]!);
        }
      }
    }

    if (!this.hasseLowerCache) {
      this.hasseLowerCache = new Map();
    }
    this.hasseLowerCache.set(id, direct);
    return direct;
  }

  /**
   * ハッセ図（全被覆エッジ）を導出して返す
   */
  public getHasseEdges(): HasseEdge<Id>[] {
    const edges: HasseEdge<Id>[] = [];
    for (const id of this.ids()) {
      for (const upperId of this.directUpperIds(id)) {
        edges.push({ from: id, to: upperId });
      }
    }
    return edges;
  }

  /**
   * 2つのオブジェクトの最小共通上位オブジェクト（LCA / 極小上界群の先頭）をビット演算で探索する
   */
  public findLCA(idA: Id, idB: Id): Id | undefined {
    const slotA = this.idToSlot.get(idA);
    const slotB = this.idToSlot.get(idB);
    if (slotA === undefined || slotB === undefined) return undefined;
    if (slotA === slotB) return idA;

    const wA = slotA >>> 5;
    const mA = 1 << (slotA & 31);
    const wB = slotB >>> 5;
    const mB = 1 << (slotB & 31);

    if ((this.upper[slotA][wB] & mB) !== 0) return idB;
    if ((this.upper[slotB][wA] & mA) !== 0) return idA;

    const usedWords = (this.allocatedSlots + 31) >>> 5;
    const commonUpper = new Uint32Array(usedWords);
    let anyCommon = false;
    for (let w = 0; w < usedWords; w++) {
      const c = this.upper[slotA][w] & this.upper[slotB][w] & this.active[w];
      commonUpper[w] = c;
      if (c !== 0) anyCommon = true;
    }
    if (!anyCommon) return undefined;

    // 共通上界集合の中で、自身の下位に他の共通上界を持たない極小元（minimal upper bound）を返す
    for (let w = 0; w < usedWords; w++) {
      let bits = commonUpper[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const candSlot = (w << 5) + (31 - Math.clz32(lsb));
        bits ^= lsb;

        const candLower = this.lower[candSlot];
        let hasSmallerCommon = false;
        for (let k = 0; k < usedWords; k++) {
          if ((candLower[k] & commonUpper[k]) !== 0) {
            hasSmallerCommon = true;
            break;
          }
        }
        if (!hasSmallerCommon) {
          return this.slotToId[candSlot];
        }
      }
    }
    return undefined;
  }

  /**
   * 大量削除後に残存する未使用スロットを詰め、ビット行列のメモリを再圧縮する
   */
  public compact(): void {
    const oldAllocated = this.allocatedSlots;
    const usedWords = (oldAllocated + 31) >>> 5;

    // 旧スロット -> 新スロットの対応表を作成
    const oldToNew = new Int32Array(oldAllocated).fill(-1);
    const activeOldSlots: number[] = [];

    for (let w = 0; w < usedWords; w++) {
      let bits = this.active[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const oldSlot = (w << 5) + (31 - Math.clz32(lsb));
        oldToNew[oldSlot] = activeOldSlots.length;
        activeOldSlots.push(oldSlot);
        bits ^= lsb;
      }
    }

    const newCount = activeOldSlots.length;
    const newSlotCap = roundUpTo32(Math.max(32, newCount));
    const newWordCap = newSlotCap >>> 5;

    const newActive = new Uint32Array(newWordCap);
    const newLower: Uint32Array[] = new Array(newCount);
    const newUpper: Uint32Array[] = new Array(newCount);
    const newSlotToId: Array<Id | undefined> = new Array(newCount);
    const newSlotToItem: Array<T | undefined> = new Array(newCount);

    for (let newSlot = 0; newSlot < newCount; newSlot++) {
      const oldSlot = activeOldSlots[newSlot];
      const id = this.slotToId[oldSlot]!;
      newSlotToId[newSlot] = id;
      newSlotToItem[newSlot] = this.slotToItem[oldSlot];
      this.idToSlot.set(id, newSlot);
      newActive[newSlot >>> 5] |= 1 << (newSlot & 31);

      const lVec = new Uint32Array(newWordCap);
      const uVec = new Uint32Array(newWordCap);
      const oldL = this.lower[oldSlot];
      const oldU = this.upper[oldSlot];

      for (let w = 0; w < usedWords; w++) {
        let lBits = oldL[w] & this.active[w];
        while (lBits !== 0) {
          const lsb = lBits & -lBits;
          const targetOld = (w << 5) + (31 - Math.clz32(lsb));
          const targetNew = oldToNew[targetOld];
          if (targetNew >= 0) {
            lVec[targetNew >>> 5] |= 1 << (targetNew & 31);
          }
          lBits ^= lsb;
        }

        let uBits = oldU[w] & this.active[w];
        while (uBits !== 0) {
          const lsb = uBits & -uBits;
          const targetOld = (w << 5) + (31 - Math.clz32(lsb));
          const targetNew = oldToNew[targetOld];
          if (targetNew >= 0) {
            uVec[targetNew >>> 5] |= 1 << (targetNew & 31);
          }
          uBits ^= lsb;
        }
      }

      newLower[newSlot] = lVec;
      newUpper[newSlot] = uVec;
    }

    this.slotCapacity = newSlotCap;
    this.wordCapacity = newWordCap;
    this.allocatedSlots = newCount;
    this.active = newActive;
    this.lower = newLower;
    this.upper = newUpper;
    this.slotToId = newSlotToId;
    this.slotToItem = newSlotToItem;
    this.freeSlots = [];
    this.scratchLower = new Uint32Array(newWordCap);
    this.scratchUpper = new Uint32Array(newWordCap);
    this.scratchVisited = new Uint32Array(newWordCap);
    this.invalidateHasseCache();
  }

  /**
   * データ整合性（不変条件: invariants）を検証する診断機能
   */
  public verifyInvariants(): PosetInvariantReport {
    const violations: string[] = [];
    const usedWords = (this.allocatedSlots + 31) >>> 5;

    // 1. activeCount と idToSlot.size と active ビット数の一致
    let popCount = 0;
    const activeSlots: number[] = [];
    for (let w = 0; w < usedWords; w++) {
      let bits = this.active[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const slot = (w << 5) + (31 - Math.clz32(lsb));
        activeSlots.push(slot);
        popCount++;
        bits ^= lsb;
      }
    }
    if (popCount !== this.activeCount || this.idToSlot.size !== this.activeCount) {
      violations.push(
        `有効オブジェクト数の不整合: activeBits=${popCount}, activeCount=${this.activeCount}, idToSlot=${this.idToSlot.size}`
      );
    }

    // 2. 削除済みIDが idToSlot に残っていないこと
    for (const retired of this.retiredIds) {
      if (this.idToSlot.has(retired)) {
        violations.push(`削除済みID (${String(retired)}) が有効マップに残存しています。`);
      }
    }

    for (const s of activeSlots) {
      const wS = s >>> 5;
      const mS = 1 << (s & 31);

      // 3. 非反射性: 自身が lower / upper に含まれないこと
      if ((this.lower[s][wS] & mS) !== 0) {
        violations.push(`スロット ${s} の下位集合に自身が含まれています。`);
      }
      if ((this.upper[s][wS] & mS) !== 0) {
        violations.push(`スロット ${s} の上位集合に自身が含まれています。`);
      }

      // 4. 反対称性: 同一オブジェクトが上位と下位の双方に含まれないこと
      for (let w = 0; w < usedWords; w++) {
        if ((this.lower[s][w] & this.upper[s][w] & this.active[w]) !== 0) {
          violations.push(
            `スロット ${s} で同一オブジェクトが上位集合と下位集合の双方に含まれています。`
          );
        }
      }
    }

    // 5. 転置整合性 (lower[v] に u がある <=> upper[u] に v がある) および推移律
    for (const u of activeSlots) {
      const wU = u >>> 5;
      const mU = 1 << (u & 31);

      for (const v of activeSlots) {
        const wV = v >>> 5;
        const mV = 1 << (v & 31);

        const uInLowerV = (this.lower[v][wU] & mU) !== 0;
        const vInUpperU = (this.upper[u][wV] & mV) !== 0;
        if (uInLowerV !== vInUpperU) {
          violations.push(
            `転置不整合: lower[${v}][${u}]=${uInLowerV} !== upper[${u}][${v}]=${vInUpperU}`
          );
        }

        // 6. 推移律: u < v ならば upper[v] ⊆ upper[u] かつ lower[u] ⊆ lower[v]
        if (vInUpperU) {
          for (let w = 0; w < usedWords; w++) {
            const upV = this.upper[v][w] & this.active[w];
            if ((upV & ~this.upper[u][w]) !== 0) {
              violations.push(
                `推移律違反: ${u} < ${v} ですが upper[${v}] の一部が upper[${u}] に含まれていません。`
              );
              break;
            }
          }
        }
      }
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  private collectIdsFromBitset(row: Uint32Array): Id[] {
    const result: Id[] = [];
    const usedWords = (this.allocatedSlots + 31) >>> 5;
    for (let w = 0; w < usedWords; w++) {
      let bits = row[w] & this.active[w];
      while (bits !== 0) {
        const lsb = bits & -bits;
        const slot = (w << 5) + (31 - Math.clz32(lsb));
        result.push(this.slotToId[slot]!);
        bits ^= lsb;
      }
    }
    return result;
  }

  private allocatePublicId(customId?: Id): Id {
    if (customId !== undefined) {
      if (this.idToSlot.has(customId)) {
        throw new Error(`指定されたID（${String(customId)}）は既に使用されています。`);
      }
      if (this.retiredIds.has(customId)) {
        throw new Error(
          `指定されたID（${String(customId)}）は削除済みIDのため再利用できません。`
        );
      }
      return customId;
    }

    while (true) {
      const candidate = this.idGenerator(this.nextIdSeq++);
      if (!this.idToSlot.has(candidate) && !this.retiredIds.has(candidate)) {
        return candidate;
      }
    }
  }

  private acquireSlot(): number {
    if (this.freeSlots.length > 0) {
      const reusedSlot = this.freeSlots.pop()!;
      const w = reusedSlot >>> 5;
      const clearMask = ~(1 << (reusedSlot & 31));
      // 旧オブジェクトに関する関係情報が残存しないよう、全スロットの当該ビットを確実にクリアする
      for (let i = 0; i < this.allocatedSlots; i++) {
        this.lower[i][w] &= clearMask;
        this.upper[i][w] &= clearMask;
      }
      return reusedSlot;
    }

    const slot = this.allocatedSlots;
    if (slot >= this.slotCapacity) {
      this.growCapacity(slot + 1);
    }
    this.allocatedSlots += 1;
    this.lower[slot] = new Uint32Array(this.wordCapacity);
    this.upper[slot] = new Uint32Array(this.wordCapacity);
    return slot;
  }

  private growCapacity(minRequiredSlots: number): void {
    let nextCap = this.slotCapacity * 2;
    while (nextCap < minRequiredSlots) {
      nextCap *= 2;
    }
    if (nextCap > this.maxCapacity) {
      if (minRequiredSlots <= this.maxCapacity) {
        nextCap = roundUpTo32(this.maxCapacity);
      } else {
        throw new Error(
          `スロット容量が上限 (${this.maxCapacity}) を超えるため拡張できません。`
        );
      }
    }

    const nextWords = nextCap >>> 5;
    const nextActive = new Uint32Array(nextWords);
    nextActive.set(this.active);
    this.active = nextActive;

    for (let i = 0; i < this.allocatedSlots; i++) {
      const nextL = new Uint32Array(nextWords);
      nextL.set(this.lower[i]);
      this.lower[i] = nextL;

      const nextU = new Uint32Array(nextWords);
      nextU.set(this.upper[i]);
      this.upper[i] = nextU;
    }

    this.slotCapacity = nextCap;
    this.wordCapacity = nextWords;
    this.scratchLower = new Uint32Array(nextWords);
    this.scratchUpper = new Uint32Array(nextWords);
    this.scratchVisited = new Uint32Array(nextWords);
  }

  private invalidateHasseCache(): void {
    this.hasseUpperCache = null;
    this.hasseLowerCache = null;
  }

  private checkMemoryWarning(): void {
    if (!this.onMemoryWarning) return;
    const bytes = this.getMemoryUsageBytes();
    if (bytes >= this.memoryWarningBytes) {
      this.onMemoryWarning(bytes, this.memoryWarningBytes);
    }
  }
}
