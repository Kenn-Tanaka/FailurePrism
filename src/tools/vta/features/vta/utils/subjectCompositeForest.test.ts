import { describe, expect, it } from 'vitest';
import {
  assertAtomicPartitionInvariant,
  assertProjectedEntitiesPartition,
  buildAtomicRootAssignment,
  checkStrictPosetInclusion,
  computeCompositeEntityId,
  computeForestSignature,
  createInitialForestState,
  getForestRootIds,
  getNodeLeafIds,
  isCompositeEntityId,
  isPeripheralAggregateEntity,
  isPeripheralAggregateId,
  mergeForestRoots,
  resolveSourceTokenToRoot,
  SubjectCompositeRegistry,
  unmergeForestRoot,
} from './subjectCompositeForest';
import { SubjectPoset } from './subjectPoset';
import type { VTAEntity } from '../../../types/vta';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('subjectCompositeForest (ADR-0095)', () => {
  it('generates deterministic, order-independent content-addressed IDs and distinguishes sequential absorptions into real entities', () => {
    const registry = new SubjectCompositeRegistry();

    const idForward = computeCompositeEntityId(
      { mode: 'cmp', compositeOf: ['A_CAPT', 'A_PLANE'] },
      registry
    );
    const idReverse = computeCompositeEntityId(
      { mode: 'cmp', compositeOf: ['A_PLANE', 'A_CAPT'] },
      registry
    );
    expect(idForward).toBe(idReverse);
    expect(idForward).toMatch(/^cmp_[0-9a-f]{12}$/);
    expect(isCompositeEntityId(idForward)).toBe(true);
    expect(isPeripheralAggregateId(idForward)).toBe(false);

    // Absorbing C1 into T produces cmp_1 != T; subsequently absorbing C2 produces cmp_2 != cmp_1
    const step1Id = computeCompositeEntityId(
      { mode: 'cmp', coreEntityId: 'ORG_T', compositeOf: ['ORG_T', 'C1'] },
      registry
    );
    const step2Id = computeCompositeEntityId(
      { mode: 'cmp', coreEntityId: 'ORG_T', compositeOf: ['ORG_T', 'C1', 'C2'] },
      registry
    );
    expect(step1Id).not.toBe('ORG_T');
    expect(step2Id).not.toBe('ORG_T');
    expect(step2Id).not.toBe(step1Id);

    // Peripheral aggregate IDs use cmp_agg_* and satisfy aggregate predicates alongside legacy 'subject_others'
    const aggId = computeCompositeEntityId(
      { mode: 'agg', compositeOf: ['EXT_1', 'EXT_2'] },
      registry
    );
    expect(aggId).toMatch(/^cmp_agg_[0-9a-f]{12}$/);
    expect(isPeripheralAggregateId(aggId)).toBe(true);
    expect(isPeripheralAggregateId('subject_others')).toBe(true);
    expect(isPeripheralAggregateEntity({ id: aggId, aggregate: true })).toBe(true);
  });

  it('seals composite nodes against partial overlap or inner-node mutation and enforces strict Poset inclusion', () => {
    const entities: VTAEntity[] = [
      { id: 'ORG_HQ', name: '本社', kind: 'organization' },
      { id: 'P_CAPT', name: '機長', kind: 'person', parentEntityId: 'ORG_HQ' },
      { id: 'P_FO', name: '副操縦士', kind: 'person', parentEntityId: 'ORG_HQ' },
      { id: 'M_PLANE', name: '航空機', kind: 'machine' },
    ];
    const poset = SubjectPoset.fromEntities(entities);
    const registry = new SubjectCompositeRegistry();
    let state = createInitialForestState(['ORG_HQ', 'P_CAPT', 'P_FO', 'M_PLANE']);
    assertAtomicPartitionInvariant(state);

    // Strict Poset inclusion: P_CAPT ≺ ORG_HQ is allowed, M_PLANE -> P_CAPT (machine -> person) is rejected!
    expect(checkStrictPosetInclusion(state, ['P_CAPT'], 'ORG_HQ', poset)).toBe(true);
    expect(checkStrictPosetInclusion(state, ['M_PLANE'], 'P_CAPT', poset)).toBe(false);
    expect(checkStrictPosetInclusion(state, ['M_PLANE'], 'ORG_HQ', poset)).toBe(false);

    // Merge P_CAPT and P_FO into a sealed crew composite S_CREW
    const mCrew = mergeForestRoots(state, registry, ['P_CAPT', 'P_FO'], {
      mode: 'cmp',
      displayName: '運航乗務員',
      kind: 'organization',
      stepSemanticCost: 0.1,
      intrinsicConvexLoad: 0.05,
      candidateId: 'M_CREW',
    });
    expect(mCrew).not.toBeNull();
    state = mCrew!.state;
    assertAtomicPartitionInvariant(state);

    // Attempting to reference sealed inner leaf P_CAPT directly as a root MUST return null!
    expect(resolveSourceTokenToRoot(state, 'P_CAPT')).toBeNull();
    expect(
      mergeForestRoots(state, registry, ['P_CAPT', 'M_PLANE'], {
        mode: 'cmp',
        displayName: '不正重複統合',
        kind: 'organization',
        stepSemanticCost: 0.1,
        intrinsicConvexLoad: 0.05,
      })
    ).toBeNull();

    // Merging sealed S_CREW with M_PLANE into a higher human-machine system S_SYS succeeds cleanly as a nested tree!
    const crewRoot = resolveSourceTokenToRoot(state, 'M_CREW')!;
    expect(crewRoot).toBe(mCrew!.createdNode.id);
    const mSys = mergeForestRoots(state, registry, [crewRoot, 'M_PLANE'], {
      mode: 'cmp',
      displayName: '航空機運航システム',
      kind: 'organization',
      stepSemanticCost: 0.12,
      intrinsicConvexLoad: 0.06,
      candidateId: 'M_SYS',
    });
    expect(mSys).not.toBeNull();
    state = mSys!.state;
    assertAtomicPartitionInvariant(state);
    expect(getForestRootIds(state)).toEqual(['ORG_HQ', mSys!.createdNode.id].sort());

    // Unmerging S_SYS by 1 level restores S_CREW and M_PLANE intact without destroying S_CREW!
    const unmerged = unmergeForestRoot(state, mSys!.createdNode.id);
    expect(unmerged).not.toBeNull();
    assertAtomicPartitionInvariant(unmerged!.state);
    expect(getForestRootIds(unmerged!.state)).toEqual(['M_PLANE', 'ORG_HQ', crewRoot].sort());
  });

  it('guarantees zero multi-lane atomic duplication across 150 randomized Merge / Unmerge / P_prime rebuild sequences', () => {
    const atomicIds = Array.from({ length: 14 }, (_, i) => `U_${i + 1}`);

    for (let seed = 1; seed <= 150; seed++) {
      const rand = mulberry32(seed);
      const registry = new SubjectCompositeRegistry();
      let state = createInitialForestState(atomicIds);
      assertAtomicPartitionInvariant(state);

      for (let step = 0; step < 30; step++) {
        const roots = getForestRootIds(state);
        const opRoll = rand();

        if (opRoll < 0.6 && roots.length >= 2) {
          // Random Merge over 2..4 distinct current roots
          const shuffled = [...roots].sort(() => rand() - 0.5);
          const k = Math.min(roots.length, 2 + Math.floor(rand() * 3));
          const chosen = shuffled.slice(0, k);
          const isAgg = rand() < 0.2 && !state.aggregateRootId;
          const merged = mergeForestRoots(state, registry, chosen, {
            mode: isAgg ? 'agg' : 'cmp',
            displayName: isAgg ? 'その他の関係者' : `G_${seed}_${step}`,
            kind: isAgg ? 'other' : 'organization',
            stepSemanticCost: 0.1,
            intrinsicConvexLoad: 0.04,
          });
          expect(merged).not.toBeNull();
          state = merged!.state;
        } else if (opRoll < 0.85) {
          // Random Unmerge or Partial Split (Unmerge(P) + Merge(remaining -> P'))
          const compositeRoots = roots.filter((r) => state.composites.has(r));
          if (compositeRoots.length > 0) {
            const targetRoot = compositeRoots[Math.floor(rand() * compositeRoots.length)];
            const unmerged = unmergeForestRoot(state, targetRoot);
            expect(unmerged).not.toBeNull();
            state = unmerged!.state;
            if (unmerged!.restoredChildIds.length >= 3 && rand() < 0.7) {
              // Rebuild P' from all restored children except 1 split-out child
              const rem = unmerged!.restoredChildIds.slice(1);
              const rebuilt = mergeForestRoots(state, registry, rem, {
                mode: unmerged!.dissolvedNode.aggregate ? 'agg' : 'cmp',
                displayName: `${unmerged!.dissolvedNode.displayName}_prime`,
                kind: unmerged!.dissolvedNode.kind,
                stepSemanticCost: 0.08,
                intrinsicConvexLoad: 0.03,
              });
              expect(rebuilt).not.toBeNull();
              expect(rebuilt!.createdNode.id).not.toBe(targetRoot);
              state = rebuilt!.state;
            }
          }
        } else {
          // Adversarial invalid attempt: try merging a non-root inner node with a root -> MUST return null!
          const innerNodes = Array.from(state.parentOf.entries())
            .filter(([, pid]) => pid !== null)
            .map(([nid]) => nid);
          if (innerNodes.length > 0 && roots.length > 0) {
            const bad = mergeForestRoots(state, registry, [innerNodes[0], roots[0]], {
              mode: 'cmp',
              displayName: 'InvalidOverlap',
              kind: 'organization',
              stepSemanticCost: 0.1,
              intrinsicConvexLoad: 0.04,
            });
            expect(bad).toBeNull();
          }
        }

        // Verify forest invariant and projected entity partition invariant after EVERY step!
        assertAtomicPartitionInvariant(state);
        const currentRoots = getForestRootIds(state);
        const mockProjected: VTAEntity[] = currentRoots.map((rid) => {
          if (state.atomicSet.has(rid)) {
            return { id: rid, name: rid, kind: 'person' };
          }
          const comp = state.composites.get(rid)!;
          return {
            id: comp.id,
            name: comp.displayName,
            kind: comp.kind,
            ...(comp.aggregate ? { aggregate: true } : {}),
            compositeOf: [...comp.compositeOf],
            mergedFrom: [...comp.leafIds],
          };
        });
        assertProjectedEntitiesPartition(atomicIds, mockProjected);
        expect(computeForestSignature(state)).toBe(currentRoots.join('|'));
        expect(buildAtomicRootAssignment(state).size).toBe(atomicIds.length);
      }
    }
  });
});
