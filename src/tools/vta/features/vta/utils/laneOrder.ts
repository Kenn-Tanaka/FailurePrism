import type { VTAEntity } from '../../../types/vta';

export const OTHER_ACTORS_ENTITY_NAME = 'その他の関係者';

const OTHER_ACTORS_DUPLICATE_NAME_RE = /^その他の関係者\s*\(\d+\)$/;

/**
 * Deduplicates lane names while preserving first-seen order and dropping blanks.
 */
export function dedupeLanes(lanes: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const lane of lanes) {
    const normalized = lane?.trim();
    if (!lane || !normalized || seen.has(lane)) continue;
    seen.add(lane);
    result.push(lane);
  }
  return result;
}

/**
 * Identifies whether a lane represents the peripheral aggregate "その他の関係者" lane.
 * Avoids matching `entity.aggregate === true` alone because non-peripheral parent entities
 * (e.g., composite vehicles/organizations) may also carry `aggregate: true`.
 */
export function isOtherActorsLaneName(
  laneName: string,
  entities?: readonly VTAEntity[]
): boolean {
  const trimmed = laneName.trim();
  if (!trimmed) return false;
  if (trimmed === OTHER_ACTORS_ENTITY_NAME || OTHER_ACTORS_DUPLICATE_NAME_RE.test(trimmed)) {
    return true;
  }
  if (!entities?.length) return false;
  const matched = entities.find(
    (entity) => entity.name === laneName || entity.name.trim() === trimmed
  );
  if (!matched) return false;
  return (
    matched.id === 'subject_others' ||
    matched.id.startsWith('subject_others_') ||
    (matched.kind === 'other' && matched.aggregate === true)
  );
}

/**
 * Stably partitions lanes so "その他の関係者" lanes appear at the left edge (index 0).
 */
export function prioritizeOtherActorsLanes(
  lanes: readonly string[],
  entities?: readonly VTAEntity[]
): string[] {
  const uniqueLanes = dedupeLanes(lanes);
  const prioritized: string[] = [];
  const regular: string[] = [];
  for (const lane of uniqueLanes) {
    if (isOtherActorsLaneName(lane, entities)) {
      prioritized.push(lane);
    } else {
      regular.push(lane);
    }
  }
  return [...prioritized, ...regular];
}

/**
 * Merges candidate lanes onto an existing lane order:
 * - If `existingLanes` is empty, prioritizes "その他の関係者" at the left edge.
 * - If `existingLanes` is non-empty, preserves existing positions (including manual `moveLane` edits)
 *   while prepending newly introduced "その他の関係者" lanes to the left edge and appending other new lanes.
 */
export function mergeLaneOrderWithPriority(
  existingLanes: readonly string[],
  candidateLanes: readonly string[],
  entities?: readonly VTAEntity[]
): string[] {
  const base = dedupeLanes(existingLanes);
  const candidates = dedupeLanes(candidateLanes);
  if (base.length === 0) {
    return prioritizeOtherActorsLanes(candidates, entities);
  }
  const existingSet = new Set(base);
  const newPrioritized: string[] = [];
  const newRegular: string[] = [];
  for (const lane of candidates) {
    if (existingSet.has(lane)) continue;
    if (isOtherActorsLaneName(lane, entities)) {
      newPrioritized.push(lane);
    } else {
      newRegular.push(lane);
    }
  }
  return [...newPrioritized, ...base, ...newRegular];
}

/**
 * Builds lane order after merging `mergedOutNames` into `targetName`.
 * Keeps `targetName`'s existing position if already present; otherwise prepends a newly introduced
 * "その他の関係者" lane to index 0, or replaces the first merged-out lane in-place for regular targets.
 */
export function mergeLanesAfterConsolidation(
  existingLanes: readonly string[],
  mergedOutNames: ReadonlySet<string>,
  targetName: string,
  entities?: readonly VTAEntity[]
): string[] {
  const base = dedupeLanes(existingLanes);
  if (base.includes(targetName)) {
    return base.filter((lane) => lane === targetName || !mergedOutNames.has(lane));
  }
  if (isOtherActorsLaneName(targetName, entities)) {
    return dedupeLanes([targetName, ...base.filter((lane) => !mergedOutNames.has(lane))]);
  }
  const mapped = dedupeLanes(
    base.map((lane) => (mergedOutNames.has(lane) ? targetName : lane))
  ).filter((lane) => !mergedOutNames.has(lane) || lane === targetName);
  return mapped.includes(targetName)
    ? mapped
    : mergeLaneOrderWithPriority(mapped, [targetName], entities);
}

/**
 * Preserves existing lane order when applying a split proposal while expanding split sub-lanes
 * at the parent's slot and prioritizing any newly introduced "その他の関係者" lane at index 0.
 */
export function expandSplitLanesWithPriority(
  existingLanes: readonly string[],
  candidateLanes: readonly string[],
  parentEntityName: string,
  splitEntityNames: readonly string[],
  entities?: readonly VTAEntity[]
): string[] {
  const candidates = dedupeLanes(candidateLanes);
  const candidateSet = new Set(candidates);
  const existingSet = new Set(existingLanes);
  const survivingSplits = dedupeLanes(splitEntityNames).filter(
    (name) => candidateSet.has(name) && !existingSet.has(name)
  );
  const baseOrder: string[] = [];
  let splitsInserted = false;
  for (const lane of dedupeLanes(existingLanes)) {
    if (lane === parentEntityName) {
      if (candidateSet.has(lane)) {
        baseOrder.push(lane);
      }
      baseOrder.push(...survivingSplits);
      splitsInserted = true;
    } else if (candidateSet.has(lane)) {
      baseOrder.push(lane);
    }
  }
  if (!splitsInserted) {
    baseOrder.push(...survivingSplits);
  }
  return mergeLaneOrderWithPriority(baseOrder, candidates, entities);
}

/**
 * Selects the default primary lane (preferring the first non-"その他の関係者" lane).
 */
export function pickDefaultPrimaryLane(
  lanes: readonly string[],
  entities?: readonly VTAEntity[]
): string | undefined {
  return lanes.find((lane) => !isOtherActorsLaneName(lane, entities)) ?? lanes[0];
}
