import type { PosetRelation, SubjectPosetData, VTAEntity } from '../../../types/vta';
import {
  BitsetPoset,
  type BitsetPosetConfig,
  type HasseEdge,
  type PosetInvariantReport,
  type PosetRelationResult,
} from './bitsetPoset';

/**
 * 主体意味論的包含関係を半順序集合 (Poset: Partially Ordered Set) および
 * 有向非巡回グラフ (DAG: Directed Acyclic Graph) として保持・クエリするエンジン。
 *
 * 内部表現には `BitsetPoset`（`Uint32Array` による `lower` / `upper` 転置ビット行列と `active` ビットベクトル）を採用し、
 * - 商集合化 (同値類・表記ゆれの正準化)
 * - 反射律・反対称律 (非巡回)・推移律の数学的保証
 * - ビット行列参照による定数時間 O(1) 祖先・子孫・半順序比較クエリ
 * - ビットAND演算によるハッセ図（被覆関係）および LCA (最小共通上位主体) の高速探索
 * を実現する。
 */
export class SubjectPoset {
  private core: BitsetPoset<string, string>;
  private aliases = new Map<string, string>(); // alias / name -> canonicalId
  private lowerAliases = new Map<string, string>(); // lowercase -> canonicalId
  private relations: PosetRelation[] = [];
  private hasRawCycleCandidate = false;

  constructor(config?: BitsetPosetConfig<string>) {
    this.core = new BitsetPoset<string, string>(() => 'nc', config);
  }

  /**
   * 内部の BitsetPoset インスタンス（読み取り・診断・ベンチマーク用）
   */
  public getBitsetPoset(): BitsetPoset<string, string> {
    return this.core;
  }

  /**
   * シリアライズデータから SubjectPoset を復元
   */
  static fromData(data?: SubjectPosetData | null, config?: BitsetPosetConfig<string>): SubjectPoset {
    const poset = new SubjectPoset(config);
    if (!data) return poset;

    for (const node of data.nodes ?? []) {
      poset.addNode(node);
    }
    if (data.aliases) {
      for (const [alias, canonical] of Object.entries(data.aliases)) {
        poset.addAlias(alias, canonical);
      }
    }
    for (const rel of data.relations ?? []) {
      poset.addRawEdge(rel.childId, rel.parentId, rel.axis);
    }
    poset.removeCycles();
    poset.ensureClosure();
    return poset;
  }

  /**
   * サイクル検証を行わずに直接エッジを追加する (内部構築・修復用)
   */
  public addRawEdge(childId: string, parentId: string, axis?: PosetRelation['axis']): boolean {
    const c = childId.trim();
    const p = parentId.trim();
    if (!c || !p || c === p) return false;

    this.addNode(c);
    this.addNode(p);

    if (!this.relations.some((r) => r.childId === c && r.parentId === p)) {
      this.relations.push({ childId: c, parentId: p, ...(axis ? { axis } : {}) });
    }

    const ok = this.core.addOrderRelation(c, p);
    if (!ok) {
      this.hasRawCycleCandidate = true;
    }
    return true;
  }

  /**
   * VTAEntity 配列および表記ゆれ情報から SubjectPoset を初期構築
   */
  static fromEntities(
    entities: Array<Pick<VTAEntity, 'id' | 'name' | 'parentEntityId' | 'parentEntityIds'>>,
    aliases?: Record<string, string>,
    config?: BitsetPosetConfig<string>
  ): SubjectPoset {
    const poset = new SubjectPoset(config);

    // 1. ノード登録と名称エイリアス登録
    for (const ent of entities) {
      if (!ent.id) continue;
      poset.addNode(ent.id);
      if (ent.name) {
        poset.addAlias(ent.name, ent.id);
        poset.addAlias(ent.name.normalize('NFKC'), ent.id);
      }
    }

    // 2. 外部エイリアス登録
    if (aliases) {
      for (const [alias, canonical] of Object.entries(aliases)) {
        poset.addAlias(alias, canonical);
      }
    }

    // 3. エッジ登録 (parentEntityId および parentEntityIds)
    for (const ent of entities) {
      if (!ent.id) continue;
      const parents = new Set<string>();
      if (ent.parentEntityId && ent.parentEntityId !== '-') {
        parents.add(ent.parentEntityId);
      }
      if (Array.isArray(ent.parentEntityIds)) {
        for (const p of ent.parentEntityIds) {
          if (p && p !== '-') parents.add(p);
        }
      }

      for (const parentId of parents) {
        const canonicalParent = poset.resolveCanonical(parentId) ?? parentId;
        if (poset.hasNode(canonicalParent) && canonicalParent !== ent.id) {
          poset.addEdge(ent.id, canonicalParent);
        }
      }
    }

    // 4. 循環の除去と推移的閉包の確定
    poset.removeCycles();
    poset.ensureClosure();
    return poset;
  }

  public get size(): number {
    return this.core.size;
  }

  public hasNode(id: string): boolean {
    return this.core.has(id.trim());
  }

  public addNode(id: string): void {
    const clean = id.trim();
    if (!clean) return;
    if (!this.core.has(clean)) {
      this.core.insert(clean, clean);
      this.lowerAliases.set(clean.toLowerCase(), clean);
    }
  }

  public removeNode(id: string): boolean {
    const clean = id.trim();
    if (!this.core.has(clean)) return false;
    this.relations = this.relations.filter((r) => r.childId !== clean && r.parentId !== clean);
    this.lowerAliases.delete(clean.toLowerCase());
    for (const [alias, canonical] of this.aliases.entries()) {
      if (canonical === clean) {
        this.aliases.delete(alias);
        this.lowerAliases.delete(alias.toLowerCase());
      }
    }
    return this.core.remove(clean);
  }

  public addAlias(alias: string, canonicalId: string): void {
    const cleanAlias = alias.trim();
    const cleanCanonical = canonicalId.trim();
    if (!cleanAlias || !cleanCanonical) return;
    this.addNode(cleanCanonical);
    this.aliases.set(cleanAlias, cleanCanonical);
    this.lowerAliases.set(cleanAlias.toLowerCase(), cleanCanonical);
    const nfkc = cleanAlias.normalize('NFKC');
    if (nfkc !== cleanAlias) {
      this.aliases.set(nfkc, cleanCanonical);
      this.lowerAliases.set(nfkc.toLowerCase(), cleanCanonical);
    }
  }

  public addEdge(childId: string, parentId: string, axis?: PosetRelation['axis']): boolean {
    const c = childId.trim();
    const p = parentId.trim();
    if (!c || !p || c === p) return false;

    this.addNode(c);
    this.addNode(p);

    // BitsetPoset 上で反対称律検査とビットORによる推移閉包更新を実行
    if (!this.core.addOrderRelation(c, p)) {
      return false;
    }

    if (!this.relations.some((r) => r.childId === c && r.parentId === p)) {
      this.relations.push({ childId: c, parentId: p, ...(axis ? { axis } : {}) });
    }
    return true;
  }

  public getNodes(): string[] {
    return this.core.ids();
  }

  public getAliases(): Record<string, string> {
    return Object.fromEntries(this.aliases.entries());
  }

  public getRelations(): PosetRelation[] {
    return [...this.relations];
  }

  /**
   * 2つの主体間の半順序関係を O(1) で取得 ('lt' | 'gt' | 'eq' | 'nc')
   */
  public compare(idA: string, idB: string): PosetRelationResult {
    const a = this.resolveCanonical(idA) ?? idA.trim();
    const b = this.resolveCanonical(idB) ?? idB.trim();
    return this.core.compare(a, b);
  }

  /**
   * 指定主体の直接の親主体を取得（明示登録エッジおよびハッセ被覆上位主体）
   */
  public getImmediateParents(id: string): string[] {
    const c = this.resolveCanonical(id) ?? id.trim();
    if (!this.core.has(c)) return [];
    const directSet = new Set<string>(this.core.directUpperIds(c));
    for (const rel of this.relations) {
      if (rel.childId === c && this.core.has(rel.parentId)) {
        directSet.add(rel.parentId);
      }
    }
    return Array.from(directSet);
  }

  /**
   * 指定主体の直接の子主体を取得（明示登録エッジおよびハッセ被覆下位主体）
   */
  public getImmediateChildren(id: string): string[] {
    const p = this.resolveCanonical(id) ?? id.trim();
    if (!this.core.has(p)) return [];
    const directSet = new Set<string>(this.core.directLowerIds(p));
    for (const rel of this.relations) {
      if (rel.parentId === p && this.core.has(rel.childId)) {
        directSet.add(rel.childId);
      }
    }
    return Array.from(directSet);
  }

  /**
   * ハッセ図における厳密な被覆関係（中間に他の主体が存在しない直接の上位主体）を取得
   */
  public getHasseParents(id: string): readonly string[] {
    const c = this.resolveCanonical(id) ?? id.trim();
    if (!this.core.has(c)) return [];
    return this.core.directUpperIds(c);
  }

  /**
   * ハッセ図における厳密な被覆関係（中間に他の主体が存在しない直接の下位主体）を取得
   */
  public getHasseChildren(id: string): readonly string[] {
    const p = this.resolveCanonical(id) ?? id.trim();
    if (!this.core.has(p)) return [];
    return this.core.directLowerIds(p);
  }

  /**
   * ハッセ図の全被覆エッジを取得
   */
  public getHasseEdges(): HasseEdge<string>[] {
    return this.core.getHasseEdges();
  }

  /**
   * BitsetPoset では挿入・エッジ追加時に常にビット行列上で推移的閉包が維持されるため no-op（後方互換メソッド）
   */
  public ensureClosure(): void {
    // BitsetPoset maintains transitive closure incrementally in Uint32Array bit matrices.
  }

  /**
   * ancestorId が descendantId の上位包含主体（祖先）であるか判定 (O(1) ビット行列参照)
   */
  public isAncestor(ancestorId: string, descendantId: string, strict = true): boolean {
    const a = this.resolveCanonical(ancestorId) ?? ancestorId.trim();
    const d = this.resolveCanonical(descendantId) ?? descendantId.trim();
    if (a === d) return !strict;
    if (!this.core.has(a) || !this.core.has(d)) return false;
    return this.core.compare(d, a) === 'lt';
  }

  /**
   * descendantId が ancestorId の下位構成主体（子孫）であるか判定 (O(1) ビット行列参照)
   */
  public isDescendant(descendantId: string, ancestorId: string, strict = true): boolean {
    return this.isAncestor(ancestorId, descendantId, strict);
  }

  /**
   * 指定主体の全上位包含主体（祖先集合）を取得
   */
  public getAncestors(id: string, includeSelf = false): Set<string> {
    const target = this.resolveCanonical(id) ?? id.trim();
    if (!this.core.has(target)) return new Set();
    const result = new Set<string>(this.core.upperIds(target));
    if (includeSelf) {
      result.add(target);
    }
    return result;
  }

  /**
   * 指定主体の全下位構成主体（子孫集合）を取得
   */
  public getDescendants(id: string, includeSelf = false): Set<string> {
    const target = this.resolveCanonical(id) ?? id.trim();
    if (!this.core.has(target)) return new Set();
    const result = new Set<string>(this.core.lowerIds(target));
    if (includeSelf) {
      result.add(target);
    }
    return result;
  }

  /**
   * 2つの主体の最小共通上位主体 (Lowest Common Ancestor: LCA) をビット演算で探索
   */
  public findLCA(id1: string, id2: string): string | undefined {
    const a = this.resolveCanonical(id1) ?? id1.trim();
    const b = this.resolveCanonical(id2) ?? id2.trim();
    if (!this.core.has(a) || !this.core.has(b)) return undefined;
    return this.core.findLCA(a, b);
  }

  /**
   * 名称またはエイリアスから正準主体IDを解決
   */
  public resolveCanonical(rawIdOrName?: string): string | undefined {
    if (!rawIdOrName) return undefined;
    const clean = rawIdOrName.trim();
    if (!clean) return undefined;

    if (this.core.has(clean)) return clean;
    if (this.aliases.has(clean)) return this.aliases.get(clean);

    const nfkc = clean.normalize('NFKC');
    if (this.core.has(nfkc)) return nfkc;
    if (this.aliases.has(nfkc)) return this.aliases.get(nfkc);

    const lower = clean.toLowerCase();
    const byLower = this.lowerAliases.get(lower);
    if (byLower && this.core.has(byLower)) return byLower;

    const nfkcLower = nfkc.toLowerCase();
    const byNfkcLower = this.lowerAliases.get(nfkcLower);
    if (byNfkcLower && this.core.has(byNfkcLower)) return byNfkcLower;

    return undefined;
  }

  /**
   * 閉路 (サイクル) を検証
   */
  public validate(): { valid: boolean; cycles?: string[][] } {
    if (!this.hasRawCycleCandidate) {
      return { valid: true };
    }

    const adj = new Map<string, string[]>();
    for (const rel of this.relations) {
      if (!this.core.has(rel.childId) || !this.core.has(rel.parentId)) continue;
      const list = adj.get(rel.childId) ?? [];
      if (!list.includes(rel.parentId)) list.push(rel.parentId);
      adj.set(rel.childId, list);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (node: string, path: string[]) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      for (const parent of adj.get(node) ?? []) {
        if (!visited.has(parent)) {
          dfs(parent, path);
        } else if (recStack.has(parent)) {
          const cycleStartIdx = path.indexOf(parent);
          if (cycleStartIdx >= 0) {
            cycles.push(path.slice(cycleStartIdx).concat(parent));
          }
        }
      }

      path.pop();
      recStack.delete(node);
    };

    for (const node of this.core.ids()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return {
      valid: cycles.length === 0,
      ...(cycles.length > 0 ? { cycles } : {}),
    };
  }

  /**
   * 検出されたサイクルエッジを決定論的に除去して DAG 化を保証する
   */
  public removeCycles(): { removedEdges: PosetRelation[] } {
    if (!this.hasRawCycleCandidate) {
      return { removedEdges: [] };
    }

    const removedEdges: PosetRelation[] = [];
    let check = this.validate();

    while (!check.valid && check.cycles && check.cycles.length > 0) {
      const cycle = check.cycles[0];
      const child = cycle[cycle.length - 2];
      const parent = cycle[cycle.length - 1];

      this.relations = this.relations.filter(
        (r) => !(r.childId === child && r.parentId === parent)
      );
      removedEdges.push({ childId: child, parentId: parent });
      check = this.validate();
    }

    this.hasRawCycleCandidate = false;
    this.rebuildBitsetFromRelations();
    return { removedEdges };
  }

  /**
   * ビット行列の不変条件（非反射・反対称・転置・推移律）を検証
   */
  public verifyInvariants(): PosetInvariantReport {
    return this.core.verifyInvariants();
  }

  private rebuildBitsetFromRelations(): void {
    const activeNodes = this.core.ids();
    const nextCore = new BitsetPoset<string, string>(() => 'nc');
    for (const node of activeNodes) {
      nextCore.insert(node, node);
    }
    for (const rel of this.relations) {
      if (nextCore.has(rel.childId) && nextCore.has(rel.parentId)) {
        nextCore.addOrderRelation(rel.childId, rel.parentId);
      }
    }
    this.core = nextCore;
  }

  public toJSON(): SubjectPosetData {
    return {
      nodes: this.core.ids(),
      aliases: Object.fromEntries(this.aliases.entries()),
      relations: [...this.relations],
    };
  }

  public toData(): SubjectPosetData {
    return this.toJSON();
  }
}
