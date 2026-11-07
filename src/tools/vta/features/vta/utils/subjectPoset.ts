import type { PosetRelation, SubjectPosetData, VTAEntity } from '../../../types/vta';

/**
 * 主体意味論的包含関係を半順序集合 (Poset: Partially Ordered Set) および
 * 有向非巡回グラフ (DAG: Directed Acyclic Graph) として保持・クエリするエンジン。
 *
 * - 商集合化 (同値類・表記ゆれの正準化)
 * - 反射律・反対称律 (非巡回)・推移律の数学的保証
 * - 推移的閉包 (Transitive Closure) による定数時間 O(1) 祖先・子孫クエリ
 * - LCA (Lowest Common Ancestor: 最小共通上位主体) 探索
 */
export class SubjectPoset {
  private nodes = new Set<string>();
  private aliases = new Map<string, string>(); // alias / name -> canonicalId
  private parentsMap = new Map<string, Set<string>>(); // child -> direct parents
  private childrenMap = new Map<string, Set<string>>(); // parent -> direct children
  private relations: PosetRelation[] = [];

  // 推移的閉包キャッシュ (strict: 自身は含まない)
  private ancestorsCache: Map<string, Set<string>> | null = null;
  private descendantsCache: Map<string, Set<string>> | null = null;

  constructor() {}

  /**
   * シリアライズデータから SubjectPoset を復元
   */
  static fromData(data?: SubjectPosetData | null): SubjectPoset {
    const poset = new SubjectPoset();
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

    const parents = this.parentsMap.get(c) ?? new Set<string>();
    parents.add(p);
    this.parentsMap.set(c, parents);

    const children = this.childrenMap.get(p) ?? new Set<string>();
    children.add(c);
    this.childrenMap.set(p, children);

    this.relations.push({ childId: c, parentId: p, ...(axis ? { axis } : {}) });
    this.invalidateCache();
    return true;
  }

  /**
   * VTAEntity 配列および表記ゆれ情報から SubjectPoset を初期構築
   */
  static fromEntities(
    entities: Array<Pick<VTAEntity, 'id' | 'name' | 'parentEntityId' | 'parentEntityIds'>>,
    aliases?: Record<string, string>
  ): SubjectPoset {
    const poset = new SubjectPoset();

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

  public hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  public addNode(id: string): void {
    const clean = id.trim();
    if (!clean) return;
    if (!this.nodes.has(clean)) {
      this.nodes.add(clean);
      this.invalidateCache();
    }
  }

  public addAlias(alias: string, canonicalId: string): void {
    const cleanAlias = alias.trim();
    const cleanCanonical = canonicalId.trim();
    if (!cleanAlias || !cleanCanonical) return;
    this.addNode(cleanCanonical);
    this.aliases.set(cleanAlias, cleanCanonical);
    const nfkc = cleanAlias.normalize('NFKC');
    if (nfkc !== cleanAlias) {
      this.aliases.set(nfkc, cleanCanonical);
    }
  }

  public addEdge(childId: string, parentId: string, axis?: PosetRelation['axis']): boolean {
    const c = childId.trim();
    const p = parentId.trim();
    if (!c || !p || c === p) return false;

    this.addNode(c);
    this.addNode(p);

    const parents = this.parentsMap.get(c) ?? new Set<string>();
    if (parents.has(p)) return true; // 既存エッジ

    // 反対称律 (サイクル) チェック
    if (this.isDescendant(p, c)) {
      // p が既に c の子孫である場合、c -> p を足すとサイクルになる
      return false;
    }

    parents.add(p);
    this.parentsMap.set(c, parents);

    const children = this.childrenMap.get(p) ?? new Set<string>();
    children.add(c);
    this.childrenMap.set(p, children);

    this.relations.push({ childId: c, parentId: p, ...(axis ? { axis } : {}) });
    this.invalidateCache();
    return true;
  }

  public getNodes(): string[] {
    return Array.from(this.nodes);
  }

  public getAliases(): Record<string, string> {
    return Object.fromEntries(this.aliases.entries());
  }

  public getRelations(): PosetRelation[] {
    return [...this.relations];
  }

  public getImmediateParents(id: string): string[] {
    const c = this.resolveCanonical(id) ?? id;
    const parents = this.parentsMap.get(c);
    return parents ? Array.from(parents) : [];
  }

  public getImmediateChildren(id: string): string[] {
    const p = this.resolveCanonical(id) ?? id;
    const children = this.childrenMap.get(p);
    return children ? Array.from(children) : [];
  }

  /**
   * 推移的閉包 (Transitive Closure) を構築してキャッシュする
   */
  public ensureClosure(): void {
    if (this.ancestorsCache && this.descendantsCache) return;

    const ancestors = new Map<string, Set<string>>();
    const descendants = new Map<string, Set<string>>();

    for (const node of this.nodes) {
      ancestors.set(node, new Set());
      descendants.set(node, new Set());
    }

    // 全ノードに対して DFS で厳密祖先 (strict ancestors) を計算
    for (const node of this.nodes) {
      const visited = new Set<string>();
      const queue = Array.from(this.parentsMap.get(node) ?? []);
      while (queue.length > 0) {
        const p = queue.shift()!;
        if (!visited.has(p)) {
          visited.add(p);
          ancestors.get(node)!.add(p);
          descendants.get(p)?.add(node);
          for (const grandParent of this.parentsMap.get(p) ?? []) {
            if (!visited.has(grandParent)) {
              queue.push(grandParent);
            }
          }
        }
      }
    }

    this.ancestorsCache = ancestors;
    this.descendantsCache = descendants;
  }

  private invalidateCache(): void {
    this.ancestorsCache = null;
    this.descendantsCache = null;
  }

  /**
   * ancestorId が descendantId の上位包含主体（祖先）であるか判定 (推移律を含む)
   */
  public isAncestor(ancestorId: string, descendantId: string, strict = true): boolean {
    const a = this.resolveCanonical(ancestorId) ?? ancestorId;
    const d = this.resolveCanonical(descendantId) ?? descendantId;
    if (a === d) return !strict; // 反射律

    this.ensureClosure();
    return this.ancestorsCache?.get(d)?.has(a) ?? false;
  }

  /**
   * descendantId が ancestorId の下位構成主体（子孫）であるか判定
   */
  public isDescendant(descendantId: string, ancestorId: string, strict = true): boolean {
    return this.isAncestor(ancestorId, descendantId, strict);
  }

  /**
   * 指定主体の全上位包含主体（祖先集合）を取得
   */
  public getAncestors(id: string, includeSelf = false): Set<string> {
    const target = this.resolveCanonical(id) ?? id;
    this.ensureClosure();
    const result = new Set<string>(this.ancestorsCache?.get(target) ?? []);
    if (includeSelf && this.nodes.has(target)) {
      result.add(target);
    }
    return result;
  }

  /**
   * 指定主体の全下位構成主体（子孫集合）を取得
   */
  public getDescendants(id: string, includeSelf = false): Set<string> {
    const target = this.resolveCanonical(id) ?? id;
    this.ensureClosure();
    const result = new Set<string>(this.descendantsCache?.get(target) ?? []);
    if (includeSelf && this.nodes.has(target)) {
      result.add(target);
    }
    return result;
  }

  /**
   * 2つの主体の最小共通上位主体 (Lowest Common Ancestor: LCA) を探索
   */
  public findLCA(id1: string, id2: string): string | undefined {
    const a = this.resolveCanonical(id1) ?? id1;
    const b = this.resolveCanonical(id2) ?? id2;
    if (a === b) return a;

    const ancestorsA = this.getAncestors(a, true);
    const ancestorsB = this.getAncestors(b, true);

    const commonAncestors = Array.from(ancestorsA).filter((node) => ancestorsB.has(node));
    if (commonAncestors.length === 0) return undefined;
    if (commonAncestors.length === 1) return commonAncestors[0];

    // 極小元 (他の共通祖先の子孫であるもの) を探す
    this.ensureClosure();
    let lca = commonAncestors[0];
    for (const cand of commonAncestors) {
      if (this.isDescendant(cand, lca)) {
        lca = cand;
      }
    }
    return lca;
  }

  /**
   * 名称またはエイリアスから正準主体IDを解決
   */
  public resolveCanonical(rawIdOrName?: string): string | undefined {
    if (!rawIdOrName) return undefined;
    const clean = rawIdOrName.trim();
    if (!clean) return undefined;

    if (this.nodes.has(clean)) return clean;
    if (this.aliases.has(clean)) return this.aliases.get(clean);

    const nfkc = clean.normalize('NFKC');
    if (this.nodes.has(nfkc)) return nfkc;
    if (this.aliases.has(nfkc)) return this.aliases.get(nfkc);

    // 大文字小文字の柔軟なマッチング
    const lower = clean.toLowerCase();
    for (const node of this.nodes) {
      if (node.toLowerCase() === lower) return node;
    }
    for (const [alias, canonical] of this.aliases) {
      if (alias.toLowerCase() === lower) return canonical;
    }

    return undefined;
  }

  /**
   * 閉路 (サイクル) を検証
   */
  public validate(): { valid: boolean; cycles?: string[][] } {
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (node: string, path: string[]) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      for (const parent of this.parentsMap.get(node) ?? []) {
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

    for (const node of this.nodes) {
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
    const removedEdges: PosetRelation[] = [];
    let check = this.validate();

    while (!check.valid && check.cycles && check.cycles.length > 0) {
      const cycle = check.cycles[0];
      // サイクルの最後のエッジ (cycle[cycle.length - 2] -> cycle[cycle.length - 1]) を除去
      const child = cycle[cycle.length - 2];
      const parent = cycle[cycle.length - 1];

      this.parentsMap.get(child)?.delete(parent);
      this.childrenMap.get(parent)?.delete(child);
      this.relations = this.relations.filter(
        (r) => !(r.childId === child && r.parentId === parent)
      );
      removedEdges.push({ childId: child, parentId: parent });

      this.invalidateCache();
      check = this.validate();
    }

    return { removedEdges };
  }

  public toJSON(): SubjectPosetData {
    return {
      nodes: Array.from(this.nodes),
      aliases: Object.fromEntries(this.aliases.entries()),
      relations: [...this.relations],
    };
  }

  public toData(): SubjectPosetData {
    return this.toJSON();
  }
}
