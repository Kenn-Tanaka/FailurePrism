import type {
  PosetRelation,
  SubjectPosetData,
  VTACardRef,
  VTAEntity,
  VTAParticipation,
} from '../../../types/vta';
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
  private pendingRemovedCycleEdges: PosetRelation[] = [];

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
    const { removedEdges } = poset.removeCycles();
    poset.pendingRemovedCycleEdges = removedEdges;
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

    // 2. 外部エイリアス登録（主体名称や多段表記ゆれを正準主体IDへ不動点解決し、主体外の用語や幽霊ノードの混入を防ぐ）
    if (aliases) {
      let pendingEntries = Object.entries(aliases).filter(([a, c]) => Boolean(a?.trim() && c?.trim()));
      while (pendingEntries.length > 0) {
        let progressed = false;
        const nextPending: Array<[string, string]> = [];
        for (const [alias, canonical] of pendingEntries) {
          const resolvedId = poset.resolveCanonical(canonical);
          if (resolvedId) {
            if (alias.trim() !== resolvedId) {
              poset.addAlias(alias, resolvedId);
            }
            progressed = true;
          } else {
            nextPending.push([alias, canonical]);
          }
        }
        if (!progressed) break;
        pendingEntries = nextPending;
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
          poset.addRawEdge(ent.id, canonicalParent);
        }
      }
    }

    // 4. 循環の除去と推移的閉包の確定（構築時に除去した辺は最初の removeCycles() で呼び出し元へ引き渡す）
    const { removedEdges } = poset.removeCycles();
    poset.pendingRemovedCycleEdges = removedEdges;
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
    const prior = this.pendingRemovedCycleEdges;
    this.pendingRemovedCycleEdges = [];
    if (!this.hasRawCycleCandidate) {
      return { removedEdges: prior };
    }

    const removedEdges: PosetRelation[] = [...prior];
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

/** Build a SubjectPoset from serialized poset data when available, otherwise from entities. */
export function createAnalysisPoset(
  entities: Array<Pick<VTAEntity, 'id' | 'name' | 'parentEntityId' | 'parentEntityIds'>>,
  rawPosetData?: SubjectPosetData | null
): SubjectPoset {
  return rawPosetData ? SubjectPoset.fromData(rawPosetData) : SubjectPoset.fromEntities(entities);
}

/**
 * Computes the direct uncovered event set E_dir(H) = E(H) \ (⋃_{d ≺ H} E(d)) for a subject H.
 */
export function computeDirectUncoveredEventIds(
  entityId: string,
  participations: readonly (Pick<VTAParticipation, 'eventId' | 'entityId'> & {
    role?: VTAParticipation['role'];
  })[],
  poset: SubjectPoset,
  activeEventIds?: ReadonlySet<string>,
  options?: { requireSubstantiveDescendantRole?: boolean }
): Set<string> {
  const canonicalH = poset.resolveCanonical(entityId) ?? entityId.trim();
  const ownEvents = new Set<string>();
  const descendantEvents = new Set<string>();

  for (const p of participations) {
    if (activeEventIds && !activeEventIds.has(p.eventId)) continue;
    const canonicalEnt = poset.resolveCanonical(p.entityId) ?? p.entityId.trim();
    if (canonicalEnt === canonicalH) {
      ownEvents.add(p.eventId);
    } else if (poset.isAncestor(canonicalH, canonicalEnt)) {
      if (
        options?.requireSubstantiveDescendantRole &&
        (p.role === 'target' || p.role === 'intended_recipient')
      ) {
        continue;
      }
      descendantEvents.add(p.eventId);
    }
  }

  const uncovered = new Set<string>();
  for (const evId of ownEvents) {
    if (!descendantEvents.has(evId)) {
      uncovered.add(evId);
    }
  }
  return uncovered;
}

export interface DiscoveredParentPosetResult {
  minimalCommonAncestors: string[];
  /** Average Hasse hop distance from members S to minimalCommonAncestors (Infinity when empty -> new root) */
  averageCommonAncestorDepth: number;
}

/**
 * Computes minimal common ancestors and average Poset hop distance for a candidate member set S
 * without mutating the poset.
 */
export function measureCommonAncestorDistance(
  poset: SubjectPoset,
  memberIds: readonly string[],
  excludeParentId?: string
): DiscoveredParentPosetResult {
  const members = Array.from(
    new Set(
      memberIds
        .map((id) => poset.resolveCanonical(id) ?? id.trim())
        .filter((id) => Boolean(id) && id !== excludeParentId && poset.hasNode(id))
    )
  );
  if (members.length === 0) {
    return { minimalCommonAncestors: [], averageCommonAncestorDepth: Infinity };
  }

  let commonAncestors: Set<string> | null = null;
  for (const m of members) {
    const ancs = poset.getAncestors(m, false);
    if (excludeParentId) ancs.delete(excludeParentId);
    if (commonAncestors === null) {
      commonAncestors = ancs;
    } else {
      for (const a of Array.from(commonAncestors)) {
        if (!ancs.has(a)) commonAncestors.delete(a);
      }
    }
  }

  const commonList = commonAncestors ? Array.from(commonAncestors) : [];
  if (commonList.length === 0) {
    return { minimalCommonAncestors: [], averageCommonAncestorDepth: Infinity };
  }

  const minimalCommonAncestors = commonList.filter(
    (a) => !commonList.some((b) => b !== a && poset.isAncestor(a, b))
  );
  const minSet = new Set(minimalCommonAncestors);

  // Shortest Hasse hop count from each member to any minimal common ancestor
  let totalDepth = 0;
  for (const m of members) {
    const dist = new Map<string, number>([[m, 0]]);
    const queue: string[] = [m];
    let foundDepth = 1;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = dist.get(cur)!;
      if (minSet.has(cur)) {
        foundDepth = d;
        break;
      }
      for (const p of poset.getHasseParents(cur)) {
        if (!dist.has(p)) {
          dist.set(p, d + 1);
          queue.push(p);
        }
      }
    }
    totalDepth += Math.max(1, foundDepth);
  }

  return {
    minimalCommonAncestors,
    averageCommonAncestorDepth: totalDepth / members.length,
  };
}

/**
 * Conservatively extends `poset` with a newly discovered 0-event parent P over `memberIds`:
 *   1. Preserves all existing order relations on V (∀x,y ∈ V: x ≼ y ⇔ x ≼' y).
 *   2. Adds s ≺ P for all s ∈ S.
 *   3. Places P immediately beneath the minimal common ancestors of S (or as a new root if none).
 */
export function discoverConservativeParent(
  poset: SubjectPoset,
  parentId: string,
  parentName: string | undefined,
  memberIds: readonly string[]
): DiscoveredParentPosetResult {
  const cleanParentId = parentId.trim();
  const info = measureCommonAncestorDistance(poset, memberIds, cleanParentId);
  if (!cleanParentId) return info;

  poset.addNode(cleanParentId);
  if (parentName && parentName.trim() && !poset.resolveCanonical(parentName.trim())) {
    poset.addAlias(parentName.trim(), cleanParentId);
  }

  for (const rawMember of memberIds) {
    const m = poset.resolveCanonical(rawMember) ?? rawMember.trim();
    if (m && m !== cleanParentId) {
      poset.addEdge(m, cleanParentId);
    }
  }
  for (const anc of info.minimalCommonAncestors) {
    if (anc !== cleanParentId) {
      poset.addEdge(cleanParentId, anc);
    }
  }

  return info;
}

/** Check whether an entity participates in an event directly, via merge history, or via SubjectPoset transitivity. */
export function participatesViaPoset(
  participations: readonly Pick<VTAParticipation, 'eventId' | 'entityId' | 'mergedFrom'>[],
  poset: SubjectPoset,
  eventId: string,
  entityId: string
): boolean {
  return participations.some(
    (part) =>
      part.eventId === eventId &&
      (part.entityId === entityId ||
        part.mergedFrom?.some((m) => m.entityId === entityId) ||
        poset.isAncestor(part.entityId, entityId) ||
        poset.isDescendant(part.entityId, entityId))
  );
}

/**
 * Resolve candidate cards for a relation endpoint, falling back to SubjectPoset
 * transitivity / merge origin when the explicit endpoint has no direct card.
 */
export function resolveCardsForRelationEndpoint(
  cards: readonly VTACardRef[],
  participations: readonly Pick<VTAParticipation, 'eventId' | 'entityId' | 'role' | 'mergedFrom'>[],
  poset: SubjectPoset,
  eventId: string,
  entityId?: string,
  originEntityId?: string,
  endpointRole: 'source' | 'target' = 'source'
): VTACardRef[] {
  const direct = cards.filter((card) => card.eventIds.includes(eventId) && (!entityId || card.laneEntityId === entityId));
  if (!entityId || direct.length > 0) {
    return direct;
  }

  const probeIds = originEntityId && originEntityId !== entityId ? [entityId, originEntityId] : [entityId];
  const mergedFromMatches = cards.filter((card) => {
    if (!card.eventIds.includes(eventId)) return false;
    return probeIds.some(
      (probe) =>
        card.laneEntityId === probe ||
        participations.some(
          (p) =>
            p.eventId === eventId &&
            p.entityId === card.laneEntityId &&
            p.mergedFrom?.some((m) => m.entityId === probe)
        )
    );
  });
  const matches =
    mergedFromMatches.length > 0
      ? mergedFromMatches
      : cards.filter((card) => {
          if (!card.eventIds.includes(eventId)) return false;
          return probeIds.some(
            (probe) =>
              card.laneEntityId === probe ||
              poset.isAncestor(card.laneEntityId, probe) ||
              poset.isDescendant(card.laneEntityId, probe)
          );
        });
  if (matches.length <= 1) return matches;

  const roleOrder: VTAParticipation['role'][] =
    endpointRole === 'source'
      ? ['actor', 'confirmed_recipient', 'intended_recipient', 'target', 'affected']
      : ['confirmed_recipient', 'intended_recipient', 'target', 'affected', 'actor'];
  const roleRank = (card: VTACardRef): number => {
    const part = participations.find((p) => p.eventId === eventId && p.entityId === card.laneEntityId);
    const idx = part ? roleOrder.indexOf(part.role) : -1;
    return idx === -1 ? roleOrder.length : idx;
  };
  return [...matches].sort((a, b) => roleRank(a) - roleRank(b));
}
