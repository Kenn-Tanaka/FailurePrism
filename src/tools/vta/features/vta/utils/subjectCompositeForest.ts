import type { VTAEntity, VTASubjectFocus } from '../../../types/vta';
import { SubjectPoset } from './subjectPoset';

export const LEGACY_SUBJECT_OTHERS_ID = 'subject_others';
export const COMPOSITE_ID_PREFIX = 'cmp_';
export const AGGREGATE_COMPOSITE_ID_PREFIX = 'cmp_agg_';

/**
 * Checks whether an entity ID represents a peripheral aggregate ("その他の関係者") node,
 * supporting both content-addressed `cmp_agg_*` IDs and legacy `subject_others` IDs.
 */
export function isPeripheralAggregateId(id: string | undefined | null): boolean {
  if (!id) return false;
  const trimmed = id.trim();
  return (
    trimmed === LEGACY_SUBJECT_OTHERS_ID ||
    trimmed.startsWith('subject_others_') ||
    trimmed.startsWith(AGGREGATE_COMPOSITE_ID_PREFIX)
  );
}

/**
 * Checks whether an entity object represents a peripheral aggregate ("その他の関係者") subject.
 */
export function isPeripheralAggregateEntity(
  entity: Pick<VTAEntity, 'id' | 'aggregate'> & { kind?: VTAEntity['kind'] } | undefined | null
): boolean {
  if (!entity) return false;
  if (isPeripheralAggregateId(entity.id)) return true;
  if (entity.aggregate === true) {
    return entity.kind === undefined || entity.kind === 'other';
  }
  return false;
}

/**
 * Checks whether an entity ID is a synthesized composite ID (`cmp_*`, `cmp_agg_*`, or legacy `group_*` / `merged_entity_*`).
 */
export function isCompositeEntityId(id: string | undefined | null): boolean {
  if (!id) return false;
  const trimmed = id.trim();
  return (
    trimmed.startsWith(COMPOSITE_ID_PREFIX) ||
    trimmed.startsWith('group_') ||
    trimmed.startsWith('merged_entity_') ||
    isPeripheralAggregateId(trimmed)
  );
}

/**
 * Deterministic 64-bit FNV-1a-inspired two-lane hash returning 12 lowercase hex chars.
 */
function hashContentKeyHex(key: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= ch ^ ((i & 0xff) << 8);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex1 = h1.toString(16).padStart(8, '0');
  const hex2 = (h2 & 0xffff).toString(16).padStart(4, '0');
  return `${hex1}${hex2}`;
}

export interface CompositeContentSpec {
  readonly mode: 'cmp' | 'agg';
  readonly coreEntityId?: string;
  readonly compositeOf: readonly string[];
}

export function buildCompositeContentKey(spec: CompositeContentSpec): string {
  const sortedChildren = [...spec.compositeOf].map((id) => id.trim()).filter(Boolean).sort();
  return `${spec.mode}|${spec.coreEntityId?.trim() ?? ''}|${sortedChildren.join(',')}`;
}

/**
 * Computes a deterministic content-addressed entity ID from direct children and structural role.
 * If `registry` is supplied, verifies collision-freedom and extends the hash suffix if needed.
 */
export function computeCompositeEntityId(
  spec: CompositeContentSpec,
  registry?: SubjectCompositeRegistry
): string {
  if (registry) {
    return registry.resolveId(spec);
  }
  const key = buildCompositeContentKey(spec);
  const prefix = spec.mode === 'agg' ? AGGREGATE_COMPOSITE_ID_PREFIX : COMPOSITE_ID_PREFIX;
  return `${prefix}${hashContentKeyHex(key)}`;
}

export interface CompositeForestNode {
  readonly id: string;
  readonly contentKey: string;
  readonly compositeOf: readonly string[]; // sorted direct child node IDs (k >= 2)
  readonly leafIds: readonly string[];     // sorted disjoint atomic leaf IDs in U
  readonly coreEntityId?: string;          // real Poset ancestor entity ID (if any)
  readonly aggregate?: true;               // true iff peripheral "その他の関係者"
  readonly displayName: string;            // presentation name (decoupled from internal ID)
  readonly kind: VTAEntity['kind'];
  readonly focus?: VTASubjectFocus;
  readonly stepSemanticCost: number;       // nominal semantic cost of forming this composite node
  readonly intrinsicConvexLoad: number;    // exact step convex load (r * phi(unit)) for this node
}

/**
 * Hash-consing table for content-addressed composite nodes across hill-climbing search states.
 * Guarantees 1-to-1 correspondence between structural content keys and internal composite IDs,
 * while allowing unreferenced search states to be garbage-collected naturally.
 */
export class SubjectCompositeRegistry {
  private readonly idByContentKey = new Map<string, string>();
  private readonly contentKeyById = new Map<string, string>();
  private readonly nodeById = new Map<string, CompositeForestNode>();

  public resolveId(spec: CompositeContentSpec): string {
    const contentKey = buildCompositeContentKey(spec);
    const existing = this.idByContentKey.get(contentKey);
    if (existing) return existing;

    const prefix = spec.mode === 'agg' ? AGGREGATE_COMPOSITE_ID_PREFIX : COMPOSITE_ID_PREFIX;
    const baseHash = hashContentKeyHex(contentKey);
    let candidateId = `${prefix}${baseHash}`;
    let salt = 1;
    while (this.contentKeyById.has(candidateId) && this.contentKeyById.get(candidateId) !== contentKey) {
      candidateId = `${prefix}${baseHash}_${salt++}`;
    }
    this.idByContentKey.set(contentKey, candidateId);
    this.contentKeyById.set(candidateId, contentKey);
    return candidateId;
  }

  public internNode(params: {
    mode: 'cmp' | 'agg';
    compositeOf: readonly string[];
    leafIds: readonly string[];
    coreEntityId?: string;
    displayName: string;
    kind: VTAEntity['kind'];
    focus?: VTASubjectFocus;
    stepSemanticCost: number;
    intrinsicConvexLoad: number;
  }): CompositeForestNode {
    const sortedChildren = Array.from(new Set(params.compositeOf.map((c) => c.trim()).filter(Boolean))).sort();
    if (sortedChildren.length < 2) {
      throw new Error(`Composite node requires at least 2 distinct child units (got ${sortedChildren.length}).`);
    }
    const sortedLeaves = Array.from(new Set(params.leafIds)).sort();
    const spec: CompositeContentSpec = {
      mode: params.mode,
      coreEntityId: params.coreEntityId,
      compositeOf: sortedChildren,
    };
    const contentKey = buildCompositeContentKey(spec);
    const id = this.resolveId(spec);
    const prev = this.nodeById.get(id);
    if (prev) {
      if (params.intrinsicConvexLoad < prev.intrinsicConvexLoad - 1e-9) {
        const updated: CompositeForestNode = {
          ...prev,
          stepSemanticCost: params.stepSemanticCost,
          intrinsicConvexLoad: params.intrinsicConvexLoad,
        };
        this.nodeById.set(id, updated);
        return updated;
      }
      return prev;
    }
    const created: CompositeForestNode = {
      id,
      contentKey,
      compositeOf: sortedChildren,
      leafIds: sortedLeaves,
      ...(params.coreEntityId ? { coreEntityId: params.coreEntityId } : {}),
      ...(params.mode === 'agg' ? { aggregate: true as const } : {}),
      displayName: params.displayName,
      kind: params.mode === 'agg' ? 'other' : params.kind,
      ...(params.focus ? { focus: params.focus } : {}),
      stepSemanticCost: params.stepSemanticCost,
      intrinsicConvexLoad: params.intrinsicConvexLoad,
    };
    this.nodeById.set(id, created);
    return created;
  }

  public getNode(id: string): CompositeForestNode | undefined {
    return this.nodeById.get(id);
  }
}

/**
 * Immutable laminar forest state over atomic participating entities `U`.
 * - Every node in the forest has at most ONE parent (`parentOf: Map<nodeId, parentId | null>`).
 * - Roots (`parentOf.get(id) === null`) represent the active lanes on the VTA diagram.
 * - By construction, no atomic entity `u ∈ U` can ever belong to more than one root lane.
 */
export interface CompositeForestState {
  readonly atomicIds: readonly string[];
  readonly atomicSet: ReadonlySet<string>;
  readonly parentOf: ReadonlyMap<string, string | null>;
  readonly composites: ReadonlyMap<string, CompositeForestNode>;
  readonly rootByCoreId: ReadonlyMap<string, string>;
  readonly aggregateRootId?: string;
  readonly nodeByCandidateId: ReadonlyMap<string, string>;
}

export function createInitialForestState(atomicIds: readonly string[]): CompositeForestState {
  const sorted = Array.from(new Set(atomicIds)).sort();
  const atomicSet = new Set(sorted);
  const parentOf = new Map<string, string | null>();
  const rootByCoreId = new Map<string, string>();
  for (const id of sorted) {
    parentOf.set(id, null);
    rootByCoreId.set(id, id);
  }
  return {
    atomicIds: sorted,
    atomicSet,
    parentOf,
    composites: new Map(),
    rootByCoreId,
    aggregateRootId: undefined,
    nodeByCandidateId: new Map(),
  };
}

export function isForestRoot(state: CompositeForestState, nodeId: string): boolean {
  return state.parentOf.has(nodeId) && state.parentOf.get(nodeId) === null;
}

export function findRootOfAtomic(state: CompositeForestState, atomicId: string): string {
  let cur: string | null | undefined = atomicId;
  let guard = 0;
  const maxDepth = state.parentOf.size + 2;
  while (cur) {
    const next = state.parentOf.get(cur);
    if (next === null || next === undefined) return cur;
    cur = next;
    if (++guard > maxDepth) {
      throw new Error(`Cycle detected in CompositeForestState.parentOf starting from ${atomicId}`);
    }
  }
  return atomicId;
}

export function getForestRootIds(state: CompositeForestState): string[] {
  const roots: string[] = [];
  for (const [nid, pid] of state.parentOf) {
    if (pid === null) roots.push(nid);
  }
  return roots.sort();
}

export function getNodeLeafIds(state: CompositeForestState, nodeId: string): readonly string[] {
  if (state.atomicSet.has(nodeId)) return [nodeId];
  const comp = state.composites.get(nodeId);
  if (!comp) return [];
  return comp.leafIds;
}

/**
 * Canonical Merkle signature of a forest state:
 * Because every composite node ID `cmp_*` is content-addressed over `(mode, coreEntityId, sorted direct children)`,
 * the sorted list of root IDs uniquely identifies the entire forest hierarchy!
 */
export function computeForestSignature(state: CompositeForestState): string {
  return getForestRootIds(state).join('|');
}

/**
 * Builds the flat `atomicEntityId -> rootBucketId` map from `state`.
 */
export function buildAtomicRootAssignment(state: CompositeForestState): Map<string, string> {
  const out = new Map<string, string>();
  for (const uid of state.atomicIds) {
    out.set(uid, findRootOfAtomic(state, uid));
  }
  return out;
}

/**
 * Verifies in O(|U|) that the forest induces an exact, disjoint partition of `U`:
 * 1) Every root subtree is acyclic and references only alive nodes.
 * 2) No node is reachable from two roots or twice within one root.
 * 3) Every `u ∈ U` appears in at least one root AND total leaf count equals `|U|`.
 */
export function assertAtomicPartitionInvariant(state: CompositeForestState): void {
  const visitedNodes = new Set<string>();
  const visitedLeaves = new Set<string>();
  let totalLeafOccurrences = 0;

  const walk = (nid: string) => {
    if (visitedNodes.has(nid)) {
      throw new Error(`Forest invariant violation: node "${nid}" is shared across multiple branches/lanes.`);
    }
    visitedNodes.add(nid);

    if (state.atomicSet.has(nid)) {
      totalLeafOccurrences++;
      if (visitedLeaves.has(nid)) {
        throw new Error(`Forest invariant violation: atomic entity "${nid}" appears in multiple lanes.`);
      }
      visitedLeaves.add(nid);
      return;
    }

    const comp = state.composites.get(nid);
    if (!comp) {
      throw new Error(`Forest invariant violation: unknown non-atomic node "${nid}".`);
    }
    if (comp.compositeOf.length < 2) {
      throw new Error(`Forest invariant violation: composite "${nid}" has fewer than 2 children.`);
    }
    for (const cid of comp.compositeOf) {
      if (state.parentOf.get(cid) !== nid) {
        throw new Error(
          `Forest invariant violation: child "${cid}" parentOf is "${String(state.parentOf.get(cid))}", expected "${nid}".`
        );
      }
      walk(cid);
    }
  };

  for (const [nid, pid] of state.parentOf) {
    if (pid === null) {
      walk(nid);
    }
  }

  if (totalLeafOccurrences !== state.atomicIds.length || visitedLeaves.size !== state.atomicIds.length) {
    const missing = state.atomicIds.filter((u) => !visitedLeaves.has(u));
    throw new Error(
      `Forest invariant violation: expected ${state.atomicIds.length} disjoint atomic leaves, got ${totalLeafOccurrences} (missing: ${missing.join(',')}).`
    );
  }
}

/**
 * Verifies post-projection entity partition completeness on a projected `entities` list:
 * Every participating atomic entity `u ∈ U` must appear in `entities` exactly once
 * (either as an unmerged atomic entity `e.id === u` with empty `mergedFrom`, or in `e.mergedFrom`).
 */
export function assertProjectedEntitiesPartition(
  atomicIds: readonly string[],
  projectedEntities: readonly VTAEntity[]
): void {
  const atomicSet = new Set(atomicIds);
  const seen = new Map<string, string>(); // atomicId -> hosting projected entity id

  for (const ent of projectedEntities) {
    const hosted = new Set<string>();
    if (atomicSet.has(ent.id)) {
      hosted.add(ent.id);
    }
    for (const m of ent.mergedFrom ?? []) {
      if (atomicSet.has(m)) {
        hosted.add(m);
      }
    }
    for (const uid of hosted) {
      const prevHost = seen.get(uid);
      if (prevHost && prevHost !== ent.id) {
        throw new Error(
          `Projected schema partition violation: atomic entity "${uid}" exists in both "${prevHost}" and "${ent.id}".`
        );
      }
      seen.set(uid, ent.id);
    }
  }

  if (seen.size !== atomicSet.size) {
    const missing = atomicIds.filter((u) => !seen.has(u));
    throw new Error(
      `Projected schema partition violation: missing atomic entities [${missing.join(', ')}].`
    );
  }
}

function recomputeRootIndices(
  atomicSet: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>,
  composites: ReadonlyMap<string, CompositeForestNode>
): { rootByCoreId: Map<string, string>; aggregateRootId?: string } {
  const rootByCoreId = new Map<string, string>();
  let aggregateRootId: string | undefined;
  for (const [nid, pid] of parentOf) {
    if (pid !== null) continue;
    if (atomicSet.has(nid)) {
      rootByCoreId.set(nid, nid);
      continue;
    }
    const comp = composites.get(nid);
    if (!comp) continue;
    if (comp.aggregate) {
      aggregateRootId = nid;
    } else if (comp.coreEntityId) {
      rootByCoreId.set(comp.coreEntityId, nid);
    }
  }
  return { rootByCoreId, aggregateRootId };
}

/**
 * Fundamental Transition 1: Merge(R_1, ..., R_k -> S)
 * Seals k >= 2 pairwise-distinct current roots into a new content-addressed composite root S.
 * Returns null if any unit is not a current root or if roots overlap.
 */
export function mergeForestRoots(
  state: CompositeForestState,
  registry: SubjectCompositeRegistry,
  rootIds: readonly string[],
  params: {
    mode: 'cmp' | 'agg';
    coreEntityId?: string;
    displayName: string;
    kind: VTAEntity['kind'];
    focus?: VTASubjectFocus;
    stepSemanticCost: number;
    intrinsicConvexLoad: number;
    candidateId?: string;
  }
): { state: CompositeForestState; createdNode: CompositeForestNode } | null {
  const uniqueRoots = Array.from(new Set(rootIds));
  if (uniqueRoots.length < 2 || uniqueRoots.length !== rootIds.length) {
    return null;
  }

  const leafUnion: string[] = [];
  const leafSeen = new Set<string>();
  for (const rid of uniqueRoots) {
    if (!isForestRoot(state, rid)) {
      return null;
    }
    for (const lid of getNodeLeafIds(state, rid)) {
      if (leafSeen.has(lid)) return null;
      leafSeen.add(lid);
      leafUnion.push(lid);
    }
  }

  const createdNode = registry.internNode({
    mode: params.mode,
    compositeOf: uniqueRoots,
    leafIds: leafUnion,
    coreEntityId: params.coreEntityId,
    displayName: params.displayName,
    kind: params.kind,
    focus: params.focus,
    stepSemanticCost: params.stepSemanticCost,
    intrinsicConvexLoad: params.intrinsicConvexLoad,
  });

  if (state.parentOf.has(createdNode.id)) {
    return null;
  }

  const nextParentOf = new Map(state.parentOf);
  for (const rid of uniqueRoots) {
    nextParentOf.set(rid, createdNode.id);
  }
  nextParentOf.set(createdNode.id, null);

  const nextComposites = new Map(state.composites);
  nextComposites.set(createdNode.id, createdNode);

  const nextCandMap = new Map(state.nodeByCandidateId);
  if (params.candidateId) {
    nextCandMap.set(params.candidateId, createdNode.id);
  }

  const { rootByCoreId, aggregateRootId } = recomputeRootIndices(
    state.atomicSet,
    nextParentOf,
    nextComposites
  );

  return {
    state: {
      atomicIds: state.atomicIds,
      atomicSet: state.atomicSet,
      parentOf: nextParentOf,
      composites: nextComposites,
      rootByCoreId,
      aggregateRootId,
      nodeByCandidateId: nextCandMap,
    },
    createdNode,
  };
}

/**
 * Fundamental Transition 2: Unmerge(S)
 * Dissolves a root composite node S by one level, restoring its direct children `S.compositeOf` as roots
 * and releasing S from the active forest state.
 */
export function unmergeForestRoot(
  state: CompositeForestState,
  compositeRootId: string
): { state: CompositeForestState; restoredChildIds: readonly string[]; dissolvedNode: CompositeForestNode } | null {
  if (!isForestRoot(state, compositeRootId)) return null;
  const dissolvedNode = state.composites.get(compositeRootId);
  if (!dissolvedNode) return null;

  const nextParentOf = new Map(state.parentOf);
  nextParentOf.delete(compositeRootId);
  for (const cid of dissolvedNode.compositeOf) {
    nextParentOf.set(cid, null);
  }

  const nextComposites = new Map(state.composites);
  nextComposites.delete(compositeRootId);

  const nextCandMap = new Map<string, string>();
  for (const [candId, nid] of state.nodeByCandidateId) {
    if (nid !== compositeRootId) {
      nextCandMap.set(candId, nid);
    }
  }

  const { rootByCoreId, aggregateRootId } = recomputeRootIndices(
    state.atomicSet,
    nextParentOf,
    nextComposites
  );

  return {
    state: {
      atomicIds: state.atomicIds,
      atomicSet: state.atomicSet,
      parentOf: nextParentOf,
      composites: nextComposites,
      rootByCoreId,
      aggregateRootId,
      nodeByCandidateId: nextCandMap,
    },
    restoredChildIds: dissolvedNode.compositeOf,
    dissolvedNode,
  };
}

/**
 * Resolves a candidate's source reference token (`atomicId`, `candidateId`, or `coreEntityId`)
 * to its exact current root in `state`.
 * Returns `null` if the referenced entity/group is already sealed INSIDE a larger composite!
 */
export function resolveSourceTokenToRoot(
  state: CompositeForestState,
  token: string
): string | null {
  const byCand = state.nodeByCandidateId.get(token);
  if (byCand !== undefined) {
    return isForestRoot(state, byCand) ? byCand : null;
  }
  const byCore = state.rootByCoreId.get(token);
  if (byCore !== undefined) {
    return isForestRoot(state, byCore) ? byCore : null;
  }
  if (state.parentOf.has(token)) {
    return isForestRoot(state, token) ? token : null;
  }
  return null;
}

/**
 * Validates Poset inclusion for absorbing `sourceRootIds` into an existing real entity `targetEntityId`:
 * Every leaf `u` of every source root MUST strictly satisfy `u ≺ targetEntityId` (`poset.isAncestor(targetEntityId, u)`).
 */
export function checkStrictPosetInclusion(
  state: CompositeForestState,
  sourceRootIds: readonly string[],
  targetEntityId: string,
  poset: SubjectPoset
): boolean {
  if (!poset.hasNode(targetEntityId)) return false;
  for (const rid of sourceRootIds) {
    const leaves = getNodeLeafIds(state, rid);
    if (leaves.length === 0) return false;
    for (const lid of leaves) {
      if (lid === targetEntityId || !poset.isAncestor(targetEntityId, lid)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Returns composite nodes of `state` sorted in bottom-up topological order (children strictly before parents).
 */
export function getTopologicalCompositesBottomUp(state: CompositeForestState): CompositeForestNode[] {
  const result: CompositeForestNode[] = [];
  const visited = new Set<string>();
  const visit = (nid: string) => {
    if (visited.has(nid) || state.atomicSet.has(nid)) return;
    visited.add(nid);
    const comp = state.composites.get(nid);
    if (!comp) return;
    for (const cid of comp.compositeOf) {
      visit(cid);
    }
    result.push(comp);
  };
  for (const rootId of getForestRootIds(state)) {
    visit(rootId);
  }
  return result;
}
