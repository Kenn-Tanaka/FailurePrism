/**
 * Structured AI Diagnostics Builder for FailurePrism / VTA Editor
 * 
 * Condenses massive debug traces (350,000+ tokens / 1.5MB+) into a high-density,
 * structured diagnostic package (~3,000-5,000 tokens) tailored for external LLMs
 * (Claude, ChatGPT, Gemini, Antigravity) to pinpoint root causes in one shot.
 * 
 * Conforms to ADR-0009.
 */

import type { DebugEntry } from '../debugRecorder';
import type {
  VTAAnalysisData,
  VTAEntity,
  VTAEdgeData,
  VTANodeData,
  VTASchema,
  SubjectPosetData,
} from '../../types/vta';
import { SubjectPoset } from '../../features/vta/utils/subjectPoset';
import {
  auditProjectionWiring,
  sourceFromText,
  type ProjectionWiringAudit,
} from '../../features/vta/utils/eventAnalysis';
import type { LayoutGeometryAudit } from '../../features/vta/utils/layout';

export interface AIDiagnosticsMeta {
  version: string;
  timestamp: string;
  model?: string;
  contract?: string;
  pipeline_status: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  llm_calls?: number;
  total_llm_ms?: number;
  outcome?: {
    status: 'identified' | 'not_found' | 'uncertain' | string;
    kind?: string;
    event_ids?: string[];
    event_kinds?: string[];
  };
  scenario_meta?: {
    chars: number;
    paragraphs_count: number;
    snippet: string;
  };
}

export interface AIDiagnosticsFailure {
  phase: string;
  error_message: string;
  trigger_entity_id?: string;
  source_hint?: string;
}

export interface EntityLifecycleStep {
  step: string;
  time: string;
  state: 'CREATED' | 'MUTATED' | 'DROPPED' | 'ORPHANED_ERROR' | 'VALIDATED';
  held_ids?: string[];
  raw_snippet?: string;
  note?: string;
}

export interface EntityLineage {
  target_id: string;
  type: 'VTACard' | 'VTAEvent' | 'VTASubject' | 'VTARelation' | 'UNKNOWN';
  parents?: string[];
  poset_ancestors?: string[];
  resolved_to?: string;
  lifecycle: EntityLifecycleStep[];
}

export type DiagnosticsProfile = 'standard' | 'deep';

export interface SubjectHierarchySummary {
  id: string;
  name: string;
  kind?: string;
  focus?: string;
  score?: number;
  events?: {
    total: number;
    variation: number;
    outcome_roles?: string[];
  };
  parents: string[];
  ancestors: string[];
  merged_into?: string;
  excluded?: boolean;
  consolidation_stage?: string;
  merge_guard?: string;
}

export interface OutcomeEventDetailSummary {
  id: string;
  kind: string;
  time: string;
  title: string;
  participants: string[];
  refs: string[];
}

export interface PostOutcomeDroppedSummary {
  id: string;
  time: string;
  title: string;
  participants: string[];
  refs: string[];
  drop_rule: string;
}

export interface SuppressedCardSummary {
  id: string;
  lane: string;
  events: string[];
  reason: string;
}

export interface DispositionAuditSummary {
  id: string;
  kind: 'excluded' | 'review';
  refs: string[];
  summary: string;
  reason: string;
}

export interface UnassignedEventAuditSummary {
  id: string;
  time: string;
  title: string;
  refs: string[];
}

export interface SilentExclusionsAuditSummary {
  unassigned_events?: UnassignedEventAuditSummary[];
  post_outcome_dropped?: PostOutcomeDroppedSummary[];
  suppressed_cards?: SuppressedCardSummary[];
  ledger_dispositions?: DispositionAuditSummary[];
  unreferenced_paragraphs?: {
    count: number;
    paragraph_ids: string[];
    flagged_with_hazard_terms?: Array<{
      paragraph: string;
      matched_terms: string[];
      snippet: string;
    }>;
  };
}

export interface ActiveEventAuditSummary {
  id: string;
  time: string;
  title: string;
  participants: string[];
  classification: string;
  refs: string[];
}

export interface SubjectPosetSummary {
  node_count: number;
  catalog_count?: number;
  edge_count: number;
  hierarchies: SubjectHierarchySummary[];
}

export interface DiagnosticsAnomaly {
  id: string;
  stage: string;
  issue_type: string;
  target_id?: string;
  raw_llm_output?: string;
  parsed_object?: unknown;
  violation_detail: string;
  geometry?: Record<string, unknown>;
  evidence_paragraph?: {
    id: string;
    text: string;
  };
}

export interface PipelineTransitionSummary {
  phase: string;
  duration_ms?: number;
  counts?: {
    events?: number;
    cards?: number;
    nodes?: number;
    visible_nodes?: number;
    edges?: number;
    subjects?: number;
    issues?: number;
    variation?: number;
    normal?: number;
    undetermined?: number;
    outcome_excluded?: number;
  };
  score?: {
    S?: number;
    C1?: number;
    C2?: number;
    C3?: number;
    C4?: number;
    C5?: number;
    adopted?: boolean;
  };
  notes?: string;
}

export interface AIDiagnosticsPackage {
  meta: AIDiagnosticsMeta;
  profile?: DiagnosticsProfile;
  run_id?: string;
  failure?: AIDiagnosticsFailure;
  outcome_details?: OutcomeEventDetailSummary[];
  silent_exclusions?: SilentExclusionsAuditSummary;
  active_events_ledger?: ActiveEventAuditSummary[];
  subject_poset?: SubjectPosetSummary;
  entity_lineage: EntityLineage[];
  anomalies: DiagnosticsAnomaly[];
  pipeline_transitions: PipelineTransitionSummary[];
  contract_rules?: Record<string, string>;
}

/**
 * Finds the latest analysis or subject poset data recorded in debug entries.
 * Scans backward to merge latest poset/entities from graph.projection with latest analysis (including outcome) from ledger.validation.
 */
export function findLatestAnalysis(entries: DebugEntry[]): {
  analysis?: VTAAnalysisData;
  subjectPoset?: SubjectPosetData;
  entities?: VTAEntity[];
  subjectRanking?: VTAAnalysisData['subjectRanking'];
  presentation?: VTASchema['presentation'];
} {
  let foundAnalysis: VTAAnalysisData | undefined;
  let foundPoset: SubjectPosetData | undefined;
  let foundEntities: VTAEntity[] | undefined;
  let foundRanking: VTAAnalysisData['subjectRanking'] | undefined;
  let foundPresentation: VTASchema['presentation'] | undefined;

  for (let i = entries.length - 1; i >= 0; i--) {
    const d = entries[i].data as Record<string, unknown> | null;
    if (!d) continue;
    const nestedSchema =
      d.schema && typeof d.schema === 'object' ? (d.schema as Record<string, unknown>) : undefined;
    const candidateAnalysis =
      (d.analysis && typeof d.analysis === 'object' ? d.analysis : undefined) ??
      (nestedSchema?.analysis && typeof nestedSchema.analysis === 'object'
        ? nestedSchema.analysis
        : undefined);
    if (!foundAnalysis && candidateAnalysis) {
      foundAnalysis = candidateAnalysis as VTAAnalysisData;
    }
    if (!foundPresentation) {
      const candidatePres =
        (d.presentation && typeof d.presentation === 'object' ? d.presentation : undefined) ??
        (nestedSchema?.presentation && typeof nestedSchema.presentation === 'object'
          ? nestedSchema.presentation
          : undefined);
      if (candidatePres) {
        foundPresentation = candidatePres as VTASchema['presentation'];
      }
    }
    if (!foundPoset && d.subjectPoset && typeof d.subjectPoset === 'object') {
      foundPoset = d.subjectPoset as SubjectPosetData;
    }
    if (!foundEntities && Array.isArray(d.entities) && d.entities.length > 0) {
      foundEntities = d.entities as VTAEntity[];
    }
    if (!foundRanking) {
      const candidateRanking =
        (d.subjectRanking && typeof d.subjectRanking === 'object' ? d.subjectRanking : undefined) ??
        (entries[i].stage === 'subject.ranking' && d.ranking && typeof d.ranking === 'object' ? d.ranking : undefined);
      if (candidateRanking) {
        foundRanking = candidateRanking as VTAAnalysisData['subjectRanking'];
      }
    }
    if (foundAnalysis && foundPoset && foundEntities && foundRanking && foundPresentation) break;
  }

  return {
    analysis: foundAnalysis,
    subjectPoset: foundPoset ?? foundAnalysis?.subjectPoset,
    entities: foundEntities ?? foundAnalysis?.entities,
    subjectRanking: foundRanking ?? foundAnalysis?.subjectRanking,
    presentation: foundPresentation,
  };
}

function resolveEntityCatalogAndMerges(
  effectiveEntities: VTAEntity[],
  poset: SubjectPoset | undefined,
  subjectRanking?: VTAAnalysisData['subjectRanking']
): {
  catalog: VTAEntity[];
  mergedTargetByOrigin: Map<string, string>;
  excludedEntityIds: Set<string>;
} {
  const catalogMap = new Map<string, VTAEntity>();
  for (const orig of subjectRanking?.originalEntities ?? []) {
    catalogMap.set(orig.id, { ...orig });
  }
  for (const eff of effectiveEntities) {
    const prev = catalogMap.get(eff.id);
    if (prev) {
      const origParents = prev.parentEntityIds?.length
        ? prev.parentEntityIds
        : prev.parentEntityId
          ? [prev.parentEntityId]
          : undefined;
      catalogMap.set(eff.id, {
        ...eff,
        name: prev.name || eff.name,
        ...(origParents ? { parentEntityIds: origParents, parentEntityId: origParents[0] } : {}),
      });
    } else {
      catalogMap.set(eff.id, { ...eff });
    }
  }
  if (poset) {
    for (const nodeId of poset.toData().nodes) {
      if (!catalogMap.has(nodeId)) {
        catalogMap.set(nodeId, { id: nodeId, name: nodeId, kind: 'other' });
      }
    }
  }

  const mergedTargetByOrigin = new Map<string, string>();
  const excludedEntityIds = new Set<string>();
  for (const r of subjectRanking?.ranks ?? []) {
    if (r.excluded && !r.retained) {
      excludedEntityIds.add(r.entityId);
    }
    if (!r.retained && !r.excluded && r.mergedInto && r.mergedInto !== r.entityId) {
      mergedTargetByOrigin.set(r.entityId, r.mergedInto);
    }
  }
  for (const eff of effectiveEntities) {
    for (const mId of eff.mergedFrom ?? []) {
      if (mId !== eff.id) mergedTargetByOrigin.set(mId, eff.id);
    }
  }

  return {
    catalog: Array.from(catalogMap.values()),
    mergedTargetByOrigin,
    excludedEntityIds,
  };
}

/**
 * Splits scenario text into paragraph index map using identical segmentation as sourceFromText.
 * Supports P1, p1, 1, source_1/p1, etc.
 */
export function extractParagraphs(scenarioText?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!scenarioText) return map;

  const source = sourceFromText(scenarioText);
  source.paragraphs.forEach((p, idx) => {
    const num = idx + 1;
    const cleanText = p.text.slice(0, 500); // Limit paragraph snippet to 500 chars to protect token budget
    map.set(`P${num}`, cleanText);
    map.set(`p${num}`, cleanText);
    map.set(`${num}`, cleanText);
    map.set(`${source.id}/p${num}`, cleanText);
    map.set(`${source.id}/P${num}`, cleanText);
    map.set(p.id, cleanText);
    map.set(p.id.toLowerCase(), cleanText);
    map.set(p.id.toUpperCase(), cleanText);
  });

  return map;
}

function extractEvidenceParagraph(raw: string, paragraphs: Map<string, string>): { id: string; text: string } | undefined {
  const pMatches = Array.from(raw.matchAll(/\b(source_\d+\/[pP]\d+|[pP]\d+)\b/g)).map((m) => m[1]);
  if (!pMatches.length) return undefined;
  if (pMatches.length === 1) {
    const pId = pMatches[0];
    const pText = paragraphs.get(pId);
    return pText ? { id: pId, text: pText } : undefined;
  }
  const matchedPairs = pMatches.slice(0, 3).map((pId) => ({ id: pId, text: paragraphs.get(pId) })).filter((item): item is { id: string; text: string } => Boolean(item.text));
  if (!matchedPairs.length) return undefined;
  if (matchedPairs.length === 1) {
    return matchedPairs[0];
  }
  return {
    id: matchedPairs.map((m) => m.id).join(', '),
    text: matchedPairs.map((m) => `[${m.id}] ${m.text}`).join('\n\n'),
  };
}

/**
 * Extracts candidate entity IDs mentioned in error messages or anomalies.
 */
export function detectTriggerEntityIds(errorMessage?: string, anomalies?: DiagnosticsAnomaly[]): string[] {
  const ids = new Set<string>();
  const entityRegex =
    /\b(card_[a-zA-Z0-9_-]+|card\d+|rel_ref_[a-zA-Z0-9_-]+|proposal:[a-zA-Z0-9_-]+|added_[a-zA-Z0-9_-]+|E\d+|A\d+|R\d+|X\d+|tmp_[a-zA-Z0-9_-]+)\b/g;

  if (errorMessage) {
    let match;
    while ((match = entityRegex.exec(errorMessage)) !== null) {
      ids.add(match[1]);
    }
  }

  if (anomalies) {
    const activeAnomalies = anomalies.filter((a) => a.issue_type !== 'LEDGER_WARNING');
    const unrepairedAnomalies = activeAnomalies.filter((a) => !a.violation_detail.startsWith('[REPAIRED] '));
    const repairedAnomalies = activeAnomalies.filter((a) => a.violation_detail.startsWith('[REPAIRED] '));
    // Prioritize unrepaired anomalies over [REPAIRED] ones so slice(0, 5) is never starved of active bugs.
    for (const tier of [unrepairedAnomalies, repairedAnomalies]) {
      // Pass 1: primary target_id of every anomaly in this tier.
      for (const a of tier) {
        if (a.target_id) ids.add(a.target_id);
      }
      // Pass 2: secondary entity/relation IDs referenced inside violation details (e.g. colliding partner edge).
      for (const a of tier) {
        let match;
        entityRegex.lastIndex = 0;
        while ((match = entityRegex.exec(a.violation_detail)) !== null) {
          ids.add(match[1]);
        }
      }
    }
  }

  return Array.from(ids);
}

function matchesEntityIdToken(text: string | undefined, targetId: string): boolean {
  if (!text || !targetId) return false;
  const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Traces the lifecycle of a target entity across all recorded debug entries,
 * including Subject Poset hierarchy and transitivity resolution (ADR-0010).
 */
export function traceEntityLineage(targetId: string, entries: DebugEntry[]): EntityLineage {
  const lifecycle: EntityLifecycleStep[] = [];
  let detectedType: EntityLineage['type'] = 'UNKNOWN';

  // Extract analysis / Poset data from debug entries
  const { analysis, subjectPoset: posetData, entities, subjectRanking } = findLatestAnalysis(entries);
  const effectiveEntities = entities ?? analysis?.entities ?? [];
  let poset: SubjectPoset | undefined;
  if (posetData) {
    poset = SubjectPoset.fromData(posetData);
  } else if (effectiveEntities.length > 0) {
    poset = SubjectPoset.fromEntities(effectiveEntities);
  }
  const { catalog: subjectCatalog, mergedTargetByOrigin } = resolveEntityCatalogAndMerges(
    effectiveEntities,
    poset,
    subjectRanking
  );

  if (targetId.startsWith('card_') || targetId.startsWith('card')) detectedType = 'VTACard';
  else if (/^E\d+$/.test(targetId) || analysis?.events?.some((e) => e.id === targetId)) detectedType = 'VTAEvent';
  else if (/^A\d+$/.test(targetId) || subjectCatalog.some((e) => e.id === targetId || e.name === targetId)) detectedType = 'VTASubject';
  else if (
    /^(R[0-9_a-zA-Z-]*|rel_ref_[a-zA-Z0-9_-]+|proposal:[a-zA-Z0-9_-]+|added_[a-zA-Z0-9_-]+|tmp_R)/.test(targetId) ||
    analysis?.relations?.some((r) => r.id === targetId)
  ) {
    detectedType = 'VTARelation';
  }

  let parents: string[] | undefined;
  let posetAncestors: string[] | undefined;
  let resolvedTo: string | undefined;

  if (detectedType === 'VTASubject') {
    const ent = subjectCatalog.find((e) => e.id === targetId || e.name === targetId);
    if (ent) {
      const p = ent.parentEntityIds?.length ? ent.parentEntityIds : (ent.parentEntityId ? [ent.parentEntityId] : []);
      if (p.length > 0) parents = p;
      if (poset) {
        const anc = poset.getAncestors(ent.id);
        if (anc.size > 0) posetAncestors = Array.from(anc);
      }
      const mergedIntoId = mergedTargetByOrigin.get(ent.id);
      if (mergedIntoId) {
        const mergedTarget = subjectCatalog.find((e) => e.id === mergedIntoId);
        resolvedTo = `${mergedIntoId} (${mergedTarget?.name ?? mergedIntoId})`;
      }
    }
  }

  const pushProjectionStep = (nextStep: EntityLifecycleStep) => {
    const last = lifecycle[lifecycle.length - 1];
    if (
      last &&
      last.step === 'graph.projection' &&
      last.state === nextStep.state &&
      last.note === nextStep.note &&
      JSON.stringify(last.held_ids) === JSON.stringify(nextStep.held_ids)
    ) {
      return;
    }
    lifecycle.push(nextStep);
  };

  let lastLedgerRowSignature: string | undefined;

  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const entry = entries[entryIdx];
    const d = entry.data as Record<string, unknown> | null;
    if (!d) continue;

    // 1. graph.projection
    if (entry.stage === 'graph.projection') {
      const cards = Array.isArray(d.cards) ? (d.cards as Array<{ id: string; eventIds?: string[]; laneEntityId?: string }>) : [];
      const card = cards.find((c) => c.id === targetId);
      if (card) {
        detectedType = 'VTACard';
        pushProjectionStep({
          step: 'graph.projection',
          time: entry.time,
          state: card.eventIds && card.eventIds.length > 0 ? 'VALIDATED' : 'ORPHANED_ERROR',
          held_ids: card.eventIds,
          note: `Card associated with lane '${card.laneEntityId}', holding events: [${card.eventIds?.join(', ')}]`,
        });
      }

      // Check if targetId is an event
      if (detectedType === 'VTAEvent') {
        const matchingCards = cards.filter((c) => c.eventIds?.includes(targetId));
        if (matchingCards.length > 0) {
          const summary = matchingCards
            .map((c) => `'${c.id}' on lane '${c.laneEntityId}'`)
            .join(', ');
          pushProjectionStep({
            step: 'graph.projection',
            time: entry.time,
            state: 'VALIDATED',
            note:
              matchingCards.length === 1
                ? `Event belongs to card ${summary}`
                : `Event belongs to cards [${summary}]`,
          });
        }
      }

      // Check if targetId is a relation
      const relations = Array.isArray(d.relations)
        ? (d.relations as Array<{
            id?: string;
            kind?: string;
            sourceEventId?: string;
            targetEventId?: string;
            sourceEntityId?: string;
            targetEntityId?: string;
            sourceEntityOrigin?: string;
            targetEntityOrigin?: string;
          }>)
        : [];
      const rel = relations.find((r) => r.id === targetId);
      if (rel) {
        detectedType = 'VTARelation';
        const srcEntText = rel.sourceEntityOrigin && rel.sourceEntityOrigin !== rel.sourceEntityId
          ? `${rel.sourceEntityId ?? '-'} (origin: ${rel.sourceEntityOrigin})`
          : (rel.sourceEntityId ?? '-');
        const tgtEntText = rel.targetEntityOrigin && rel.targetEntityOrigin !== rel.targetEntityId
          ? `${rel.targetEntityId ?? '-'} (origin: ${rel.targetEntityOrigin})`
          : (rel.targetEntityId ?? '-');
        const edges = Array.isArray(d.edges)
          ? (d.edges as Array<{ id?: string; relationId?: string; source?: string; target?: string }>)
          : [];
        const projEdge = edges.find((e) => e.relationId === targetId || e.id === `relation:${targetId}`);
        const edgeSuffix = projEdge ? ` -> edge(${projEdge.source} -> ${projEdge.target})` : '';
        pushProjectionStep({
          step: 'graph.projection',
          time: entry.time,
          state: 'VALIDATED',
          note: `Relation [${rel.kind ?? '-'}] ${rel.sourceEventId ?? '-'}/${srcEntText} -> ${rel.targetEventId ?? '-'}/${tgtEntText}${edgeSuffix}`,
        });
      }
    }

    // 2. ledger.validation
    if (entry.stage === 'ledger.validation') {
      const rows = Array.isArray(d.rows)
        ? (d.rows as Array<{ id?: string; section?: string; cells?: string[]; raw?: string; events?: string[] }>)
        : [];
      const row =
        rows.find((r) => r.id === targetId || (Array.isArray(r.cells) && r.cells[0]?.trim() === targetId)) ??
        rows.find((r) => {
          if (r.id) return false;
          const rawText = r.raw ?? '';
          const firstCell = rawText.split('\t')[0]?.trim();
          return firstCell === targetId;
        });
      if (row) {
        const rawText = row.raw ?? (Array.isArray(row.cells) ? row.cells.join('\t') : undefined);
        const rowSignature = `${row.section ?? ''}\u0000${rawText ?? ''}`;
        if (detectedType === 'UNKNOWN' && row.id === targetId && row.section) {
          if (row.section === 'イベント') detectedType = 'VTAEvent';
          else if (row.section === '主体') detectedType = 'VTASubject';
          else if (row.section === '関係') detectedType = 'VTARelation';
        }
        if (lastLedgerRowSignature === undefined || lastLedgerRowSignature !== rowSignature) {
          const isRepair = lastLedgerRowSignature !== undefined;
          const sectionTag = row.section ? ` [${row.section}]` : '';
          lifecycle.push({
            step: 'ledger.validation',
            time: entry.time,
            state: isRepair ? 'MUTATED' : 'CREATED',
            raw_snippet: rawText?.slice(0, 150),
            held_ids: row.events,
            note: isRepair
              ? `Repaired in ledger validation row${sectionTag}`
              : `Defined in ledger validation row${sectionTag}`,
          });
          lastLedgerRowSignature = rowSignature;
        }
      }
    }

    // 3. chain-repair.validation
    if (entry.stage === 'chain-repair.validation') {
      const issues = Array.isArray(d.issues) ? (d.issues as Array<{ id?: string; raw?: string; reason?: string }>) : [];
      const issue =
        issues.find((i) => i.id === targetId) ??
        issues.find(
          (i) =>
            matchesEntityIdToken(i.raw, targetId) ||
            matchesEntityIdToken(i.reason, targetId)
        );
      if (issue) {
        let note = `Chain repair issue: ${issue.reason}`;
        // If this issue is about a relation and Poset is available, add diagnostic hint
        if (detectedType === 'VTARelation' && poset && issue.raw) {
          const parts = issue.raw.split('\t');
          if (parts.length >= 6) {
            const srcSub = parts[3];
            const tgtSub = parts[5];
            const srcAnc = poset.getAncestors(srcSub);
            const tgtAnc = poset.getAncestors(tgtSub);
            if (srcAnc.size > 0 || tgtAnc.size > 0) {
              note += ` [Poset hint: ${srcSub} ancestors=[${Array.from(srcAnc).join(',')}], ${tgtSub} ancestors=[${Array.from(tgtAnc).join(',')}]]`;
            }
          }
        }
        lifecycle.push({
          step: 'chain-repair.validation',
          time: entry.time,
          state: 'MUTATED',
          raw_snippet: issue.raw?.slice(0, 150),
          note,
        });
      }
    }

    // 4. operation errors and repair warnings
    if (entry.stage === 'operation') {
      const msg = typeof d.message === 'string' ? d.message : '';
      if (matchesEntityIdToken(msg, targetId) && (d.type === 'error' || d.type === 'warn')) {
        let note = msg;
        if (d.type === 'warn' && msg.startsWith('[台帳修復]')) {
          const repairTargets = Array.from(
            msg.matchAll(/(?:主体|イベント|関係|共有カード|整理|帰結|表記|表現|仮判定)\/([A-Za-z0-9_-]+):/g),
            (m) => m[1]
          );
          if (repairTargets.length > 0 && !repairTargets.includes(targetId)) {
            note = `[参照関与] ${msg}`;
          }
        }
        lifecycle.push({
          step: 'operation',
          time: entry.time,
          state: d.type === 'error' ? 'ORPHANED_ERROR' : 'MUTATED',
          note,
        });
      }
    }
  }

  return {
    target_id: targetId,
    type: detectedType,
    parents,
    poset_ancestors: posetAncestors,
    resolved_to: resolvedTo,
    lifecycle,
  };
}

/**
 * Builds the structured AI diagnostics package from raw debug entries.
 */
export function buildAIDiagnostics(options: {
  entries: DebugEntry[];
  scenarioText?: string;
  lastError?: string;
  profile?: DiagnosticsProfile;
}): AIDiagnosticsPackage {
  const { entries, scenarioText, lastError, profile = 'standard' } = options;
  const paragraphs = extractParagraphs(scenarioText);

  // 1. Meta Extraction & Latest Analysis
  const {
    analysis,
    subjectPoset: posetData,
    entities,
    subjectRanking,
    presentation,
  } = findLatestAnalysis(entries);
  let detectedRunId: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].runId) {
      detectedRunId = entries[i].runId;
      break;
    }
  }
  let model: string | undefined;
  let contract: string | undefined;
  let lastReqTime = '';
  let llmCalls = 0;
  let totalLlmMs = 0;

  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const entry = entries[entryIdx];
    const d = entry.data as Record<string, unknown> | null;
    if (!d) continue;
    if (entry.stage === 'llm.request') {
      if (typeof d.model === 'string') model = d.model;
      lastReqTime = entry.time;
      llmCalls++;
    }
    if (entry.stage === 'llm.response') {
      if (typeof d.elapsedMs === 'number' && Number.isFinite(d.elapsedMs)) {
        totalLlmMs += d.elapsedMs;
      }
    }
    if (entry.stage === 'recording.start') {
      // recording start
    }
  }

  // Check last operation error
  let failureError = lastError;
  let failurePhase = 'unknown';

  let completedIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const d = entry.data as Record<string, unknown> | null;
    if (entry.stage === 'operation' && typeof d?.message === 'string' && d.message.includes('VTAツリー自動生成完了')) {
      completedIdx = i;
      break;
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    if (completedIdx >= 0 && i < completedIdx) {
      // パイプライン完了前のエラーはリトライ等で回復済みとして無視
      break;
    }
    const entry = entries[i];
    const d = entry.data as Record<string, unknown> | null;
    if (entry.stage === 'operation' && d?.type === 'error' && typeof d.message === 'string') {
      if (!failureError) failureError = d.message;
      failurePhase = (d.stageTag as string) ?? entry.stage;
      break;
    }
  }

  const isFailed = Boolean(failureError);

  let outcomeMeta: AIDiagnosticsMeta['outcome'];
  if (analysis?.outcome) {
    const eventKinds = analysis.events
      ?.filter((e) => analysis.outcome?.eventIds?.includes(e.id) && e.outcome_kind)
      .map((e) => `${e.id}:${e.outcome_kind}`);
    outcomeMeta = {
      status: analysis.outcome.status,
      kind: analysis.outcome.status === 'identified' ? (analysis.outcome.kind ?? 'loss') : analysis.outcome.kind,
      event_ids: analysis.outcome.eventIds?.length ? analysis.outcome.eventIds : undefined,
      ...(eventKinds && eventKinds.length ? { event_kinds: eventKinds } : {}),
    };
  }

  const meta: AIDiagnosticsMeta = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    model: model ?? 'unknown',
    contract: contract ?? 'relation-attributes-2',
    pipeline_status: isFailed ? 'FAILED' : 'SUCCESS',
    llm_calls: llmCalls > 0 ? llmCalls : undefined,
    total_llm_ms: totalLlmMs > 0 ? totalLlmMs : undefined,
    outcome: outcomeMeta,
    scenario_meta: scenarioText
      ? {
          chars: scenarioText.length,
          paragraphs_count: paragraphs.size > 0 ? Math.floor(paragraphs.size / 5) : 0, // normalized count
          snippet: scenarioText.slice(0, 150).replace(/\s+/g, ' ') + '...',
        }
      : undefined,
  };

  // 2. Anomalies Extraction
  const anomalies: DiagnosticsAnomaly[] = [];
  let anomalyIdx = 1;

  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const entry = entries[entryIdx];
    const d = entry.data as Record<string, unknown> | null;
    if (!d) continue;

    // Check ledger validation issues
    if (entry.stage === 'ledger.validation') {
      const issues = Array.isArray(d.issues)
        ? (d.issues as Array<{
            id?: string;
            raw?: string;
            message?: string;
            rule?: string;
            code?: string;
            row?: { section?: string; id?: string; cells?: string[] };
          }>)
        : [];
      const currentRunId = typeof d.runId === 'string' ? d.runId : undefined;
      const repairedInLaterStep =
        issues.length > 0 &&
        entries.slice(entryIdx + 1).some((later) => {
          if (later.stage !== 'ledger.validation' || !later.data || typeof later.data !== 'object') return false;
          const ld = later.data as { runId?: unknown; issues?: unknown };
          if (currentRunId && typeof ld.runId === 'string' && ld.runId !== currentRunId) return false;
          return Array.isArray(ld.issues) && ld.issues.length === 0;
        });
      for (const iss of issues.slice(0, 10)) { // Limit to top 10 issues
        const raw = iss.raw ?? (Array.isArray(iss.row?.cells) ? iss.row!.cells.join('\t') : '');
        const targetId = iss.id ?? iss.row?.id;
        const issueType = iss.rule ?? iss.code ?? 'VALIDATION_ISSUE';
        const evidenceParagraph = raw ? extractEvidenceParagraph(raw, paragraphs) : undefined;
        const detail = iss.message ?? 'Unknown validation issue';

        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'ledger.validation',
          issue_type: issueType,
          target_id: targetId,
          raw_llm_output: raw || undefined,
          violation_detail: repairedInLaterStep ? `[REPAIRED] ${detail}` : detail,
          evidence_paragraph: evidenceParagraph,
        });
      }

      const warnings = Array.isArray(d.warnings) ? (d.warnings as string[]) : [];
      for (const w of warnings.slice(0, 5)) {
        const idMatch = w.match(/\b(E\d+|A\d+|R\d+|D\d+|O\d+)\b/);
        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'ledger.validation',
          issue_type: 'LEDGER_WARNING',
          target_id: idMatch ? idMatch[1] : undefined,
          violation_detail: w,
        });
      }
    }

    // Check ledger parse errors
    if (entry.stage === 'ledger.parse_error') {
      const rawText = typeof d.rawText === 'string' ? d.rawText : '';
      const errMsg = typeof d.error === 'string' ? d.error : 'Parse error';
      const lineMatch = /台帳\s*(\d+)行目/.exec(errMsg);
      let snippet = rawText.slice(0, 300);
      if (lineMatch) {
        const targetLine = parseInt(lineMatch[1], 10);
        const lines = rawText.split(/\r?\n/);
        const start = Math.max(0, targetLine - 3);
        const end = Math.min(lines.length, targetLine + 2);
        snippet = lines.slice(start, end).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
      }
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'ledger.validation',
        issue_type: 'LEDGER_PARSE_ERROR',
        raw_llm_output: snippet,
        violation_detail: errMsg,
      });
    }

    // Check chain repair issues
    if (entry.stage === 'chain-repair.validation') {
      const issues = Array.isArray(d.issues) ? (d.issues as Array<{ id?: string; raw?: string; reason?: string; section?: string }>) : [];
      for (const iss of issues.slice(0, 10)) {
        const raw = iss.raw ?? '';
        const evidenceParagraph = raw ? extractEvidenceParagraph(raw, paragraphs) : undefined;

        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'chain-repair.validation',
          issue_type: iss.section ?? 'CHAIN_REPAIR_ISSUE',
          target_id: iss.id,
          raw_llm_output: raw,
          violation_detail: iss.reason ?? 'Chain repair failure',
          evidence_paragraph: evidenceParagraph,
        });
      }
    }

    // Check connection proposal invalid rows
    if (entry.stage === 'connection-proposal.validation') {
      const invalidRows = Array.isArray(d.invalidRows) ? (d.invalidRows as string[]) : [];
      for (const inv of invalidRows.slice(0, 5)) {
        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'connection-proposal.validation',
          issue_type: 'CONNECTION_PROPOSAL_INVALID_ROW',
          raw_llm_output: inv,
          violation_detail: `接続提案の形式が不正です: ${inv}`,
        });
      }
    }

    // Check preliminary classification accidentally assigned to identified outcomes
    if (entry.stage === 'preliminary.classification') {
      const outcomePrelims = Array.isArray(d.outcomeWithPreliminary)
        ? (d.outcomeWithPreliminary as Array<{ id?: string; value?: string }>)
        : [];
      for (const item of outcomePrelims.slice(0, 5)) {
        if (item.id && item.value === 'variation') {
          anomalies.push({
            id: `anomaly_${anomalyIdx++}`,
            stage: 'preliminary.classification',
            issue_type: 'OUTCOME_PRELIMINARY_VARIATION',
            target_id: item.id,
            violation_detail: `帰結イベント ${item.id} に仮判定 variation が付与されています。`,
          });
        }
      }
    }

    // Check dropped audits
    if (entry.stage === 'audit.dropped') {
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'audit.dropped',
        issue_type: 'AUDIT_DROPPED',
        violation_detail: typeof d.reason === 'string' ? d.reason : JSON.stringify(d),
      });
    }
  }

  // Final projection & layout wiring anomaly audit (terminal graph state only)
  let latestProjectionEntry: DebugEntry | undefined;
  let latestLayoutAuditEntry: DebugEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!latestProjectionEntry && entries[i].stage === 'graph.projection') {
      latestProjectionEntry = entries[i];
    }
    if (!latestLayoutAuditEntry && entries[i].stage === 'layout.audit') {
      latestLayoutAuditEntry = entries[i];
    }
    if (latestProjectionEntry && latestLayoutAuditEntry) break;
  }

  const reportedBackwardPairs = new Set<string>();
  if (latestProjectionEntry?.data && typeof latestProjectionEntry.data === 'object') {
    const d = latestProjectionEntry.data as Record<string, unknown>;
    const missingRelations = Array.isArray(d.missingRelations)
      ? (d.missingRelations as Array<{
          id?: string;
          sourceEventId?: string;
          targetEventId?: string;
          sourceEntityId?: string;
          targetEntityId?: string;
        }>)
      : [];
    for (const mr of missingRelations.slice(0, 5)) {
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'graph.projection',
        issue_type: 'MISSING_RELATION_PROJECTION',
        target_id: mr.id ?? mr.sourceEventId,
        violation_detail: `関係 ${mr.id ?? '-'} (${mr.sourceEventId}/${mr.sourceEntityId ?? '-'} → ${mr.targetEventId}/${mr.targetEntityId ?? '-'}) が投影エッジに存在しません。`,
      });
    }

    let wiringAudit = d.wiringAudit as ProjectionWiringAudit | undefined;
    if (!wiringAudit && Array.isArray(d.nodes) && Array.isArray(d.edges)) {
      const nodeList = d.nodes as Partial<VTANodeData>[];
      const edgeList = d.edges as Partial<VTAEdgeData>[];
      if (
        nodeList.some((n) => n && typeof n.lane === 'string') &&
        edgeList.some((e) => e && typeof e.source === 'string' && typeof e.target === 'string')
      ) {
        wiringAudit = auditProjectionWiring({
          lanes: [],
          nodes: nodeList as VTANodeData[],
          edges: edgeList as VTAEdgeData[],
          presentation: d.presentation as VTASchema['presentation'],
        });
      }
    }

    if (wiringAudit) {
      for (const bw of (wiringAudit.backwardIntraLaneEdges ?? []).slice(0, 5)) {
        reportedBackwardPairs.add(`${bw.source}->${bw.target}`);
        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'graph.projection',
          issue_type: 'BACKWARD_INTRA_LANE_EDGE',
          target_id: bw.source,
          violation_detail: `同一レーン「${bw.lane}」内で順序逆行エッジが検出されました: ${bw.source} -> ${bw.target} (direction=${bw.direction})`,
        });
      }
      for (const sk of (wiringAudit.skipSequentialEdges ?? []).slice(0, 5)) {
        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'graph.projection',
          issue_type: 'INTRA_LANE_SKIP_SEQUENTIAL',
          target_id: sk.source,
          violation_detail: `同一レーン「${sk.lane}」内で中間カードを飛び越す順序線があります: ${sk.source} -> ${sk.target} (span=${sk.seqSpan})`,
        });
      }
      for (const inv of (wiringAudit.dagSequenceInversions ?? []).slice(0, 5)) {
        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'graph.projection',
          issue_type: 'DAG_SEQUENCE_INVERSION',
          target_id: inv.prevId,
          violation_detail: `同一レーン「${inv.lane}」で sequence_order と EventTimeDAG ランクが逆転しています: ${inv.prevId}(row=${inv.prevRow}) < ${inv.nextId}(row=${inv.nextRow})`,
        });
      }
      for (const badLane of (wiringAudit.invalidSequenceLanes ?? []).slice(0, 5)) {
        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'graph.projection',
          issue_type: 'INVALID_SEQUENCE_ORDER',
          violation_detail: `レーン「${badLane}」で sequence_order が欠落または重複しています。`,
        });
      }
    }
  }

  if (latestLayoutAuditEntry?.data && typeof latestLayoutAuditEntry.data === 'object') {
    const audit = latestLayoutAuditEntry.data as Partial<LayoutGeometryAudit>;
    for (const bw of (audit.backwardIntraLaneEdges ?? []).slice(0, 5)) {
      if (reportedBackwardPairs.has(`${bw.source}->${bw.target}`)) continue;
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'layout.audit',
        issue_type: 'LAYOUT_BACKWARD_INTRA_LANE_EDGE',
        target_id: bw.source,
        violation_detail: `レーン「${bw.lane}」の描画座標で上から下への逆行接続が発生しています: ${bw.source}(y=${bw.sourceY}) -> ${bw.target}(y=${bw.targetY})`,
      });
    }
    for (const bwc of (audit.backwardCrossLaneEdges ?? []).slice(0, 5)) {
      const relId = bwc.relationId;
      const rel = relId ? analysis?.relations?.find((r) => r.id === relId) : undefined;
      let rawLine: string | undefined;
      if (rel) {
        const formattedRefs = rel.sourceRefs?.length
          ? rel.sourceRefs
              .map((ref) =>
                typeof ref === 'string'
                  ? ref
                  : `${ref.sourceId}/${ref.paragraphId}`
              )
              .join(',')
          : '-';
        rawLine = `${rel.id}\t${rel.kind}\t${rel.sourceEventId}\t${rel.sourceEntityId ?? '-'}\t${rel.targetEventId}\t${rel.targetEntityId ?? '-'}\t${formattedRefs}\t${rel.resource ?? '-'}\t${rel.status ?? '-'}\t${rel.receipt ?? 'na'}`;
      }
      const geom: Record<string, unknown> = {
        drop_px: bwc.dropPx,
        source: {
          id: bwc.source,
          lane: bwc.sourceLane,
          centerY: bwc.sourceCenterY,
          ...(bwc.sourceHeight !== undefined ? { height: bwc.sourceHeight } : {}),
          ...(bwc.sourceMeasuredHeight !== undefined ? { measured_height: bwc.sourceMeasuredHeight } : {}),
          ...(bwc.sourceEstimatedHeight !== undefined ? { estimated_height: bwc.sourceEstimatedHeight } : {}),
          ...(bwc.sourceIsDot !== undefined ? { is_dot: bwc.sourceIsDot } : {}),
          ...(bwc.sourceTitle ? { title: bwc.sourceTitle } : {}),
          ...(bwc.sourceTime ? { time: bwc.sourceTime } : {}),
          ...(bwc.sourceEventId ? { event_id: bwc.sourceEventId } : {}),
        },
        target: {
          id: bwc.target,
          lane: bwc.targetLane,
          centerY: bwc.targetCenterY,
          ...(bwc.targetHeight !== undefined ? { height: bwc.targetHeight } : {}),
          ...(bwc.targetMeasuredHeight !== undefined ? { measured_height: bwc.targetMeasuredHeight } : {}),
          ...(bwc.targetEstimatedHeight !== undefined ? { estimated_height: bwc.targetEstimatedHeight } : {}),
          ...(bwc.targetIsDot !== undefined ? { is_dot: bwc.targetIsDot } : {}),
          ...(bwc.targetTitle ? { title: bwc.targetTitle } : {}),
          ...(bwc.targetTime ? { time: bwc.targetTime } : {}),
          ...(bwc.targetEventId ? { event_id: bwc.targetEventId } : {}),
        },
      };

      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'layout.audit',
        issue_type: 'LAYOUT_BACKWARD_CROSS_LANE_EDGE',
        target_id: relId ?? bwc.source,
        ...(rawLine ? { raw_llm_output: rawLine } : {}),
        violation_detail: `レーン間接続で下方向に向かう逆行矢印が発生しています: ${bwc.source} (${bwc.sourceLane}, centerY=${bwc.sourceCenterY}) -> ${bwc.target} (${bwc.targetLane}, centerY=${bwc.targetCenterY}, drop=${bwc.dropPx}px)`,
        geometry: geom,
      });
    }
    for (const dt of (audit.detouredIntraLaneEdges ?? []).filter((d) => !d.isSemantic).slice(0, 5)) {
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'layout.audit',
        issue_type: 'LAYOUT_DETOURED_SEQUENTIAL_EDGE',
        target_id: dt.source,
        violation_detail: `レーン「${dt.lane}」の直列順序線 ${dt.source} -> ${dt.target} が中間ノードを避けて迂回しています (${dt.pointsCount}点折れ)。`,
      });
    }
    for (const ov of (audit.overlappingIntraLanePairs ?? []).slice(0, 5)) {
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'layout.audit',
        issue_type: 'LAYOUT_VERTICAL_OVERLAP',
        target_id: ov.topNode,
        violation_detail: `レーン「${ov.lane}」内でノード ${ov.topNode} と ${ov.bottomNode} が上下に ${ov.overlapPx}px 重なっています。`,
      });
    }
    for (const ch of (audit.closeParallelHorizontalEdges ?? []).slice(0, 5)) {
      const hasGeom =
        ch.coordA !== undefined ||
        ch.coordB !== undefined ||
        ch.targetA !== undefined ||
        ch.sourceLaneA !== undefined;
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'layout.audit',
        issue_type: 'LAYOUT_CLOSE_HORIZONTAL_EDGES',
        target_id: ch.relationA ?? ch.sourceA,
        violation_detail: `平行水平線の離隔不足 (${ch.gapPx}px): ${ch.edgeA} と ${ch.edgeB}`,
        ...(hasGeom
          ? {
              geometry: {
                axis: 'y',
                gap_px: ch.gapPx,
                ...(ch.coordA !== undefined ? { coord_a: ch.coordA } : {}),
                ...(ch.coordB !== undefined ? { coord_b: ch.coordB } : {}),
                ...(ch.overlapMin !== undefined && ch.overlapMax !== undefined
                  ? { overlap_span: `[${ch.overlapMin}, ${ch.overlapMax}]` }
                  : {}),
                edge_a: {
                  id: ch.edgeA,
                  source: ch.sourceA,
                  ...(ch.targetA ? { target: ch.targetA } : {}),
                  ...(ch.sourceLaneA ? { source_lane: ch.sourceLaneA } : {}),
                  ...(ch.targetLaneA ? { target_lane: ch.targetLaneA } : {}),
                },
                edge_b: {
                  id: ch.edgeB,
                  source: ch.sourceB,
                  ...(ch.targetB ? { target: ch.targetB } : {}),
                  ...(ch.sourceLaneB ? { source_lane: ch.sourceLaneB } : {}),
                  ...(ch.targetLaneB ? { target_lane: ch.targetLaneB } : {}),
                },
              },
            }
          : {}),
      });
    }
    for (const cv of (audit.closeParallelVerticalEdges ?? []).slice(0, 5)) {
      const hasGeom =
        cv.coordA !== undefined ||
        cv.coordB !== undefined ||
        cv.targetA !== undefined ||
        cv.sourceLaneA !== undefined ||
        cv.sourceIsDotA !== undefined;
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'layout.audit',
        issue_type: 'LAYOUT_CLOSE_VERTICAL_EDGES',
        target_id: cv.relationA ?? cv.sourceA,
        violation_detail: `平行垂直線の離隔不足 (${cv.gapPx}px): ${cv.edgeA} と ${cv.edgeB}`,
        ...(hasGeom
          ? {
              geometry: {
                axis: 'x',
                gap_px: cv.gapPx,
                ...(cv.coordA !== undefined ? { coord_a: cv.coordA } : {}),
                ...(cv.coordB !== undefined ? { coord_b: cv.coordB } : {}),
                ...(cv.overlapMin !== undefined && cv.overlapMax !== undefined
                  ? { overlap_span: `[${cv.overlapMin}, ${cv.overlapMax}]` }
                  : {}),
                edge_a: {
                  id: cv.edgeA,
                  source: cv.sourceA,
                  ...(cv.targetA ? { target: cv.targetA } : {}),
                  ...(cv.sourceLaneA ? { source_lane: cv.sourceLaneA } : {}),
                  ...(cv.targetLaneA ? { target_lane: cv.targetLaneA } : {}),
                  ...(cv.sourceIsDotA !== undefined ? { source_is_dot: cv.sourceIsDotA } : {}),
                  ...(cv.targetIsDotA !== undefined ? { target_is_dot: cv.targetIsDotA } : {}),
                },
                edge_b: {
                  id: cv.edgeB,
                  source: cv.sourceB,
                  ...(cv.targetB ? { target: cv.targetB } : {}),
                  ...(cv.sourceLaneB ? { source_lane: cv.sourceLaneB } : {}),
                  ...(cv.targetLaneB ? { target_lane: cv.targetLaneB } : {}),
                  ...(cv.sourceIsDotB !== undefined ? { source_is_dot: cv.sourceIsDotB } : {}),
                  ...(cv.targetIsDotB !== undefined ? { target_is_dot: cv.targetIsDotB } : {}),
                },
              },
            }
          : {}),
      });
    }
    for (const bo of (audit.overlappingEdgeBadges ?? []).slice(0, 5)) {
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'layout.audit',
        issue_type: 'LAYOUT_OVERLAPPING_EDGE_BADGES',
        target_id: bo.relationA ?? bo.sourceA,
        violation_detail: `接続ラベルバッジが重複しています (${bo.overlapAreaPx}px²): ${bo.edgeA} と ${bo.edgeB}`,
      });
    }
  }

  // 3. Subject Poset Summary
  const effectiveEntities = entities ?? analysis?.entities ?? [];
  let poset: SubjectPoset | undefined;
  if (posetData) {
    poset = SubjectPoset.fromData(posetData);
  } else if (effectiveEntities.length > 0) {
    poset = SubjectPoset.fromEntities(effectiveEntities);
  }

  const { catalog: subjectCatalog, mergedTargetByOrigin, excludedEntityIds } = resolveEntityCatalogAndMerges(
    effectiveEntities,
    poset,
    subjectRanking
  );

  let subjectPosetSummary: SubjectPosetSummary | undefined;
  if (poset && subjectCatalog.length > 0) {
    const rankByEntityId = new Map((subjectRanking?.ranks ?? []).map((r) => [r.entityId, r]));
    const eventByIdForPoset = new Map((analysis?.events ?? []).map((e) => [e.id, e]));
    const outcomeIdSetForPoset = new Set(
      analysis?.outcome?.status === 'identified' ? (analysis.outcome.eventIds ?? []) : []
    );
    const allParts = analysis?.participations ?? [];

    const hierarchies: SubjectHierarchySummary[] = subjectCatalog.map((ent) => {
      const p = ent.parentEntityIds?.length ? ent.parentEntityIds : (ent.parentEntityId ? [ent.parentEntityId] : []);
      const a = poset.getAncestors(ent.id);
      const rankEntry = rankByEntityId.get(ent.id);

      // Compute original or direct event participation summary (RM-LOG-03)
      const entEventRoles = new Map<string, string>();
      for (const part of allParts) {
        if (eventByIdForPoset.get(part.eventId)?.ignored) continue;
        if (part.entityId === ent.id && !part.mergedFrom?.length) {
          entEventRoles.set(part.eventId, part.role);
        } else if (part.mergedFrom?.some((m) => m.entityId === ent.id)) {
          const origRole = part.mergedFrom.find((m) => m.entityId === ent.id)!.role;
          entEventRoles.set(part.eventId, origRole);
        } else if (part.entityId === ent.id) {
          entEventRoles.set(part.eventId, part.role);
        }
      }
      let varCount = 0;
      const outcomeRoles = new Set<string>();
      for (const [evId, role] of entEventRoles) {
        const ev = eventByIdForPoset.get(evId);
        if (
          ev?.classification === 'variation' ||
          Boolean(ev?.variationFactor) ||
          (ev?.classification === 'unclassified' && ev?.preliminary?.value === 'variation')
        ) {
          varCount++;
        }
        if (outcomeIdSetForPoset.has(evId)) {
          outcomeRoles.add(role);
        }
      }

      const hasDetailedMetadata = Boolean(rankEntry || ent.focus || entEventRoles.size > 0);
      return {
        id: ent.id,
        name: ent.name,
        ...(hasDetailedMetadata && ent.kind ? { kind: ent.kind } : {}),
        ...(ent.focus ? { focus: ent.focus } : {}),
        ...(typeof rankEntry?.score === 'number' ? { score: rankEntry.score } : {}),
        ...(entEventRoles.size > 0
          ? {
              events: {
                total: entEventRoles.size,
                variation: varCount,
                ...(outcomeRoles.size > 0 ? { outcome_roles: Array.from(outcomeRoles) } : {}),
              },
            }
          : {}),
        parents: p,
        ancestors: Array.from(a),
        merged_into: mergedTargetByOrigin.get(ent.id),
        ...(excludedEntityIds.has(ent.id) ? { excluded: true } : {}),
        ...(rankEntry?.consolidationStage ? { consolidation_stage: rankEntry.consolidationStage } : {}),
        ...(rankEntry?.mergeBlockedReason ? { merge_guard: rankEntry.mergeBlockedReason } : {}),
      };
    });

    const data = poset.toData();
    subjectPosetSummary = {
      node_count: data.nodes.length,
      ...(hierarchies.length !== data.nodes.length ? { catalog_count: hierarchies.length } : {}),
      edge_count: data.relations.length,
      hierarchies,
    };
  }

  // 4. Failure & Trigger Entity Lineage
  // 通信層の失敗（HTTP 5xx/タイムアウト等）や構文解析失敗（parseLedger）は特定エンティティに起因しないため、
  // 修復済みの過去の異常から無関係なIDを原因として帰属させない。
  const isTransportOrParseFailure = isFailed && Boolean(failureError)
    && (
      failurePhase === '通信' ||
      /HTTP\s*(?:408|429|5\d\d)|upstream_timeout|gateway_error|timed? ?out|ECONN|network/i.test(failureError!) ||
      /台帳\s*\d+行目のIDが不正です|台帳\s*\d+行目のセクションがありません|台帳の完了記号/i.test(failureError!)
    );

  if (isFailed && failureError && !anomalies.some((a) => a.issue_type === 'LEDGER_PARSE_ERROR')) {
    const lineMatch = /台帳\s*(\d+)行目/.exec(failureError);
    if (lineMatch) {
      anomalies.push({
        id: `anomaly_${anomalyIdx++}`,
        stage: 'ledger.validation',
        issue_type: 'LEDGER_PARSE_ERROR',
        violation_detail: failureError,
      });
    }
  }

  const triggerIds = isTransportOrParseFailure ? [] : detectTriggerEntityIds(failureError, anomalies);
  const entityLineage: EntityLineage[] = triggerIds.slice(0, 5).map((id) => traceEntityLineage(id, entries));

  let failure: AIDiagnosticsFailure | undefined;
  if (isFailed && failureError) {
    let latestTimeoutHint: string | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.stage !== 'llm.failure' || !e.data || typeof e.data !== 'object') continue;
      const fd = e.data as { timedOut?: unknown; userCancelled?: unknown; elapsedMs?: unknown; attempt?: unknown };
      if (fd.userCancelled) continue;
      if (fd.timedOut) {
        const elapsed = typeof fd.elapsedMs === 'number' ? Math.round(fd.elapsedMs) : undefined;
        const attempt = typeof fd.attempt === 'number' ? fd.attempt : undefined;
        latestTimeoutHint = `client.ts:callLLMGateway (timedOut${elapsed !== undefined ? ` after ${elapsed}ms` : ''}${attempt !== undefined ? `, attempt=${attempt}` : ''})`;
      }
      break;
    }
    failure = {
      phase: failurePhase,
      error_message: failureError,
      trigger_entity_id: triggerIds[0],
      source_hint: failureError.includes('カード')
        ? 'eventAnalysis.ts:457 (check empty events filter)'
        : latestTimeoutHint,
    };
  }

  // 5. Pipeline Transitions (with run-length compression for consecutive identical steps)
  const pipelineTransitions: PipelineTransitionSummary[] = [];

  const pushTransition = (item: PipelineTransitionSummary) => {
    const last = pipelineTransitions[pipelineTransitions.length - 1];
    const isSame =
      last &&
      last.phase === item.phase &&
      JSON.stringify(last.counts) === JSON.stringify(item.counts) &&
      JSON.stringify(last.score) === JSON.stringify(item.score) &&
      (last.notes ?? '').replace(/\s*\(x\d+\)$/, '') === (item.notes ?? '');

    if (isSame) {
      const baseNote = (last.notes ?? '').replace(/\s*\(x\d+\)$/, '');
      const match = (last.notes ?? '').match(/\(x(\d+)\)$/);
      const count = match ? parseInt(match[1], 10) + 1 : 2;
      last.notes = baseNote ? `${baseNote} (x${count})` : `(x${count})`;
      return;
    }
    pipelineTransitions.push(item);
  };

  const hasTypedGranularityIter = entries.some((e) => e.stage === 'granularity.iteration');
  const hasTypedPostOutcome = entries.some((e) => e.stage === 'scope.post_outcome_excluded');

  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const entry = entries[entryIdx];
    const d = entry.data as Record<string, unknown> | null;
    if (!d) continue;

    if (entry.stage === 'granularity.iteration') {
      pushTransition({
        phase: 'granularity.refinement',
        score: {
          S: typeof d.score === 'number' ? Number(d.score.toFixed(3)) : undefined,
          C1: typeof d.c1 === 'number' ? Number(d.c1.toFixed(2)) : undefined,
          ...(typeof d.c2 === 'number' ? { C2: Number(d.c2.toFixed(2)) } : {}),
          C3: typeof d.c3 === 'number' ? Number(d.c3.toFixed(2)) : undefined,
          ...(typeof d.c4 === 'number' ? { C4: Number(d.c4.toFixed(2)) } : {}),
          C5: typeof d.c5 === 'number' ? Number(d.c5.toFixed(2)) : undefined,
          adopted: Boolean(d.adopted),
        },
        notes: typeof d.note === 'string' ? d.note : undefined,
      });
    }

    if (entry.stage === 'scope.post_outcome_excluded') {
      const excludedNodes = typeof d.excludedNodesCount === 'number' ? d.excludedNodesCount : 0;
      const excludedEvents = typeof d.excludedEventsCount === 'number' ? d.excludedEventsCount : 0;
      const droppedIds = Array.isArray(d.droppedEvents)
        ? (d.droppedEvents as Array<{ id?: string }>).map((ev) => ev.id).filter(Boolean)
        : [];
      pushTransition({
        phase: 'post_outcome_exclusion',
        counts: { events: excludedEvents, nodes: excludedNodes },
        notes: `[事後活動除外] 帰結以降の事後調査ノード ${excludedNodes}件（イベント ${excludedEvents}件${droppedIds.length ? `: ${droppedIds.join(',')}` : ''}）をVTAツリーから除外しました。`,
      });
    }

    if (entry.stage === 'ledger.validation') {
      const rows = Array.isArray(d.rows) ? (d.rows as Array<{ section?: string }>) : undefined;
      const eventRowsCount = rows
        ? (rows.some((r) => typeof r?.section === 'string')
            ? rows.filter((r) => r?.section === 'イベント').length
            : rows.length)
        : undefined;
      pushTransition({
        phase: 'ledger.validation',
        counts: {
          events: eventRowsCount,
          issues: Array.isArray(d.issues) ? d.issues.length : undefined,
        },
      });
    }

    if (entry.stage === 'graph.projection') {
      const cards = Array.isArray(d.cards) ? d.cards.length : undefined;
      const nodes = Array.isArray(d.nodes) ? d.nodes.length : undefined;
      const visibleNodes = typeof d.visibleNodeCount === 'number' ? d.visibleNodeCount : undefined;
      const eventsCount = typeof d.eventsCount === 'number' ? d.eventsCount : undefined;
      const edgesCount = Array.isArray(d.edges) ? d.edges.length : undefined;
      const gen = d.generation;
      let genLabel: string | number = 'in-progress';
      if (typeof gen === 'number' || typeof gen === 'string') {
        genLabel = gen;
      } else if (gen && typeof gen === 'object') {
        const g = gen as { schemeId?: string; schemeVersion?: string; runId?: string };
        genLabel = g.schemeId
          ? (g.schemeVersion ? `${g.schemeId}@${g.schemeVersion}` : g.schemeId)
          : (g.runId ?? 'completed');
      }
      const missingCount = Array.isArray(d.missingRelations) ? d.missingRelations.length : 0;
      const wiring = d.wiringAudit as ProjectionWiringAudit | undefined;
      const wiringFlags: string[] = [];
      if (missingCount > 0) wiringFlags.push(`missing=${missingCount}`);
      if (wiring?.backwardIntraLaneEdges?.length) wiringFlags.push(`backward=${wiring.backwardIntraLaneEdges.length}`);
      if (wiring?.skipSequentialEdges?.length) wiringFlags.push(`skip_seq=${wiring.skipSequentialEdges.length}`);
      if (wiring?.dagSequenceInversions?.length) wiringFlags.push(`dag_inv=${wiring.dagSequenceInversions.length}`);
      const wiringSuffix = wiringFlags.length ? ` (${wiringFlags.join(', ')})` : '';
      pushTransition({
        phase: 'graph.projection',
        counts: {
          ...(eventsCount !== undefined ? { events: eventsCount } : {}),
          cards,
          nodes,
          ...(visibleNodes !== undefined ? { visible_nodes: visibleNodes } : {}),
          ...(edgesCount !== undefined ? { edges: edgesCount } : {}),
        },
        notes: `generation: ${genLabel}${wiringSuffix}`,
      });
    }

    if (entry.stage === 'layout.audit') {
      const audit = d as Partial<LayoutGeometryAudit>;
      const backward = audit.backwardIntraLaneEdges?.length ?? 0;
      const backwardCross = audit.backwardCrossLaneEdges?.length ?? 0;
      const detouredSeq = (audit.detouredIntraLaneEdges ?? []).filter((item) => !item.isSemantic).length;
      const detouredSem = (audit.detouredIntraLaneEdges ?? []).filter((item) => item.isSemantic).length;
      const nonAdj = audit.nonAdjacentIntraLaneEdges?.length ?? 0;
      const overlaps = audit.overlappingIntraLanePairs?.length ?? 0;
      const hClose = audit.closeParallelHorizontalEdges?.length ?? 0;
      const vClose = audit.closeParallelVerticalEdges?.length ?? 0;
      const badgeOv = audit.overlappingEdgeBadges?.length ?? 0;
      const issuesCount = backward + backwardCross + detouredSeq + overlaps + hClose + vClose + badgeOv;
      pushTransition({
        phase: 'layout.audit',
        counts: {
          issues: issuesCount,
        },
        notes: `配線幾何監査: 逆行=${backward}, クロスレーン逆行=${backwardCross}, 迂回直列=${detouredSeq}, 迂回意味=${detouredSem}, 非隣接同一レーン=${nonAdj}, 重なり=${overlaps}, 平行水平近接=${hClose}, 平行垂直近接=${vClose}, バッジ重複=${badgeOv}`,
      });
    }

    if (entry.stage === 'connection-proposal.validation') {
      const proposals = Array.isArray(d.proposals) ? d.proposals.length : undefined;
      const reviews = Array.isArray(d.reviews) ? d.reviews.length : undefined;
      const invalid = Array.isArray(d.invalidRows) ? d.invalidRows.length : 0;
      pushTransition({
        phase: 'connection.proposal',
        counts: {
          issues: invalid,
        },
        notes: `接続提案: 候補 ${proposals ?? 0}件、要確認 ${reviews ?? 0}件${invalid > 0 ? `、不正行 ${invalid}件` : ''}`,
      });
    }

    if (entry.stage === 'connection-proposal.adoption') {
      const adopted = typeof d.adoptedCount === 'number' ? d.adoptedCount : 0;
      const addCount = typeof d.addCount === 'number' ? d.addCount : 0;
      const refineCount = typeof d.refineCount === 'number' ? d.refineCount : 0;
      const rejected = typeof d.rejectedCount === 'number' ? d.rejectedCount : 0;
      const reviewsSaved = typeof d.reviewsSavedCount === 'number' ? d.reviewsSavedCount : 0;
      const adoptionNote = `採用 ${adopted}件 (add=${addCount}, refine=${refineCount}), 制約除外 ${rejected}件${reviewsSaved > 0 ? `, 要確認保存 ${reviewsSaved}件` : ''}`;
      const last = pipelineTransitions[pipelineTransitions.length - 1];
      if (last && last.phase === 'connection.proposal') {
        last.notes = `${last.notes ?? '接続提案'} / ${adoptionNote}`;
      } else {
        pushTransition({
          phase: 'connection.proposal',
          counts: { issues: 0 },
          notes: `接続提案採択: ${adoptionNote}`,
        });
      }
    }

    if (entry.stage === 'preliminary.classification') {
      const breakdown = d.breakdown && typeof d.breakdown === 'object'
        ? (d.breakdown as { variation?: unknown; normal?: unknown; undetermined?: unknown })
        : undefined;
      const eligibleCount = typeof d.eligibleCount === 'number' ? d.eligibleCount : undefined;
      const outcomeExcluded = typeof d.outcomeExcludedCount === 'number' ? d.outcomeExcludedCount : undefined;
      const outcomePrelims = Array.isArray(d.outcomeWithPreliminary) ? d.outcomeWithPreliminary : [];
      const outcomeVariationCount = outcomePrelims.filter(
        (item) => (item as { value?: string })?.value === 'variation'
      ).length;
      const counts: PipelineTransitionSummary['counts'] = {
        ...(eligibleCount !== undefined ? { events: eligibleCount } : {}),
        ...(typeof breakdown?.variation === 'number' ? { variation: breakdown.variation } : {}),
        ...(typeof breakdown?.normal === 'number' ? { normal: breakdown.normal } : {}),
        ...(typeof breakdown?.undetermined === 'number' ? { undetermined: breakdown.undetermined } : {}),
        ...(outcomeExcluded !== undefined && outcomeExcluded > 0 ? { outcome_excluded: outcomeExcluded } : {}),
        ...(outcomeVariationCount > 0 ? { issues: outcomeVariationCount } : {}),
      };
      const last = pipelineTransitions[pipelineTransitions.length - 1];
      if (last && last.phase === 'preliminary.classification') {
        last.counts = { ...last.counts, ...counts };
      } else {
        pushTransition({
          phase: 'preliminary.classification',
          counts,
        });
      }
    }

    if (entry.stage === 'chain-repair.triage') {
      const skipped = Boolean(d.skipped);
      const outcomeIdentified = d.outcomeIdentified !== false;
      const canonical = typeof d.canonicalComponents === 'number' ? d.canonicalComponents : 0;
      const unassigned = typeof d.unassignedCount === 'number' ? d.unassignedCount : 0;
      const missingRel = typeof d.missingRelationsCount === 'number' ? d.missingRelationsCount : 0;
      pushTransition({
        phase: 'chain.repair',
        counts: { issues: 0 },
        notes: skipped
          ? '連鎖補完点検: スキップ（完全連結・未割当0・未投影関係0）'
          : `連鎖補完トリアージ: 実行（成分=${canonical}, 未割当=${unassigned}, 未投影関係=${missingRel}${outcomeIdentified ? '' : ', 帰結未確定'}）`,
      });
    }

    if (entry.stage === 'chain-repair.validation') {
      const rows = Array.isArray(d.rows) ? (d.rows as Array<{ section?: string; cells?: string[] }>) : undefined;
      const issues = Array.isArray(d.issues) ? d.issues.length : undefined;
      const hasSectionBreakdown = Boolean(rows?.some((r) => typeof r?.section === 'string'));
      const breakdownNote = hasSectionBreakdown
        ? (() => {
            const relRows = rows!.filter((r) => r.section === '関係追加');
            const beforeCount = relRows.filter((r) => r.cells?.[1] === 'before').length;
            const semanticCount = relRows.length - beforeCount;
            const reviewCount = rows!.filter((r) => r.section === '要確認').length;
            const assignCount = rows!.filter((r) => r.section === '割当追加').length;
            const addEventCount = rows!.filter((r) => r.section === '追加イベント').length;
            const addSubjectCount = rows!.filter((r) => r.section === '追加主体').length;
            const extraParts: string[] = [];
            if (addSubjectCount > 0) extraParts.push(`主体=${addSubjectCount}`);
            if (addEventCount > 0) extraParts.push(`イベント=${addEventCount}`);
            if (assignCount > 0) extraParts.push(`割当=${assignCount}`);
            const extraPrefix = extraParts.length > 0 ? `${extraParts.join(', ')}, ` : '';
            return `（${extraPrefix}意味関係=${semanticCount}, before=${beforeCount}, 要確認=${reviewCount}）`;
          })()
        : '';
      const resultNote = `差分候補 ${rows?.length ?? 0}行${breakdownNote}、指摘 ${issues ?? 0}件`;
      const last = pipelineTransitions[pipelineTransitions.length - 1];
      if (last && last.phase === 'chain.repair' && last.notes?.startsWith('連鎖補完トリアージ:')) {
        last.counts = { issues };
        last.notes = `${last.notes} / ${resultNote}`;
      } else {
        pushTransition({
          phase: 'chain.repair',
          counts: {
            issues,
          },
          notes: `連鎖補完点検: ${resultNote}`,
        });
      }
    }

    if (entry.stage === 'lane.consolidation') {
      const fineLanes = typeof d.fineLaneCount === 'number' ? d.fineLaneCount : undefined;
      const targetK = typeof d.targetMaxSubjects === 'number' ? d.targetMaxSubjects : undefined;
      const finalLanes = typeof d.finalLaneCount === 'number' ? d.finalLaneCount : undefined;
      const llmCalled = Boolean(d.llmCalled);
      const llmCandCount = typeof d.llmCandidateCount === 'number' ? d.llmCandidateCount : 0;
      const evalStates = typeof d.evaluatedStates === 'number' ? d.evaluatedStates : undefined;
      const applied = Array.isArray(d.appliedCandidateIds) ? (d.appliedCandidateIds as string[]) : [];
      const appliedMoves = Array.isArray(d.appliedMovesSummary)
        ? (d.appliedMovesSummary as string[])
        : applied;
      const s = typeof d.score === 'number' ? d.score : undefined;
      const m = (d.metrics && typeof d.metrics === 'object' ? d.metrics : {}) as Record<string, number>;
      pushTransition({
        phase: 'lane.consolidation',
        counts: { issues: 0 },
        ...(s !== undefined
          ? {
              score: {
                S: s,
                C1: m.c1,
                C2: m.c2,
                C3: m.c3,
                C4: m.c4,
                C5: m.c5,
                adopted: true,
              },
            }
          : {}),
        notes: `山登りレーン統合: 最細粒度=${fineLanes ?? '?'}列→最終=${finalLanes ?? '?'}列 (目標=${targetK ?? '?'}), AI候補=${llmCalled ? llmCandCount : 'skip'}件, 探索=${evalStates ?? '?'}状態, 適用=${applied.length}件 [${appliedMoves.join(', ')}]`,
      });
    }

    if (entry.stage === 'subject.others_consolidation') {
      const mode = typeof d.mode === 'string' ? d.mode : 'deterministic';
      const preMax = typeof d.preMaxSubjects === 'number' ? d.preMaxSubjects : undefined;
      const postMax = typeof d.postMaxSubjects === 'number' ? d.postMaxSubjects : undefined;
      const rolledUp = Array.isArray(d.rolledUpPosetEntityIds)
        ? (d.rolledUpPosetEntityIds as string[])
        : [];
      const folded = Array.isArray(d.foldedEntityIds) ? (d.foldedEntityIds as string[]) : [];
      const skipped = typeof d.skippedReason === 'string' ? d.skippedReason : undefined;
      const visibleLanes = typeof d.visibleLanes === 'number' ? d.visibleLanes : undefined;
      const limitNote =
        preMax !== undefined && postMax !== undefined
          ? `K_pre=${preMax}→K_post=${postMax}`
          : postMax !== undefined
            ? `K_post=${postMax}`
            : '';
      const detailParts = [
        `mode=${mode}`,
        limitNote || undefined,
        rolledUp.length > 0 ? `Poset包摂=${rolledUp.length}件 [${rolledUp.join(',')}]` : undefined,
        folded.length > 0 ? `others集約=${folded.length}件 [${folded.join(',')}]` : 'others集約=0件',
        skipped ? `skip=${skipped}` : undefined,
        visibleLanes !== undefined ? `可視列=${visibleLanes}` : undefined,
      ].filter(Boolean);
      pushTransition({
        phase: 'subject.others_consolidation',
        counts: { issues: 0 },
        notes: `最終周辺主体集約: ${detailParts.join(', ')}`,
      });
    }

    if (entry.stage === 'operation') {
      const msg = typeof d.message === 'string' ? d.message : '';
      if (msg.includes('粒度反復')) {
        if (!hasTypedGranularityIter) {
          // Legacy fallback: extract score S, C1..C5 from operation log text
          const sMatch = msg.match(/S=([\d.]+)/);
          const c1Match = msg.match(/C1=([\d.]+)/);
          const c2Match = msg.match(/C2=([\d.]+)/);
          const c3Match = msg.match(/C3=([\d.]+)/);
          const c4Match = msg.match(/C4=([\d.]+)/);
          const c5Match = msg.match(/C5=([\d.]+)/);
          const isInitial = msg.includes('#0');
          pushTransition({
            phase: 'granularity.refinement',
            score: {
              S: sMatch ? parseFloat(sMatch[1]) : undefined,
              C1: c1Match ? parseFloat(c1Match[1]) : undefined,
              ...(c2Match ? { C2: parseFloat(c2Match[1]) } : {}),
              C3: c3Match ? parseFloat(c3Match[1]) : undefined,
              ...(c4Match ? { C4: parseFloat(c4Match[1]) } : {}),
              C5: c5Match ? parseFloat(c5Match[1]) : undefined,
              adopted: isInitial ? true : msg.includes('採用=はい'),
            },
            notes: msg,
          });
        }
      } else if (msg.includes('事後活動除外')) {
        if (!hasTypedPostOutcome) {
          pushTransition({
            phase: 'post_outcome_exclusion',
            notes: msg,
          });
        }
      } else if (msg.includes('仮判定完了') || msg.includes('仮判定パス') || msg.includes('仮判定フォールバック')) {
        pushTransition({
          phase: 'preliminary.classification',
          notes: msg,
        });
      } else if (msg.includes('仮判定一括採用') || msg.includes('変動判定を反映しました')) {
        pushTransition({
          phase: 'variation.classification',
          notes: msg,
        });
      } else if (msg.includes('VTAツリー自動生成完了')) {
        pushTransition({
          phase: 'pipeline.completed',
          notes: msg,
        });
      }
    }

    if (entry.stage === 'llm.failure' && !d.userCancelled) {
      const timedOut = Boolean(d.timedOut);
      const attempt = typeof d.attempt === 'number' ? d.attempt : undefined;
      const elapsedMs = typeof d.elapsedMs === 'number' ? Math.round(d.elapsedMs) : undefined;
      const status = typeof d.status === 'number' ? `HTTP ${d.status}` : undefined;
      const finishReason = typeof d.finishReason === 'string' && d.finishReason ? `finish=${d.finishReason}` : undefined;
      const contentLength = typeof d.contentLength === 'number' ? `content=${d.contentLength}字` : undefined;
      const reasoningLength = typeof d.reasoningLength === 'number' && d.reasoningLength > 0 ? `reasoning=${d.reasoningLength}字` : undefined;
      const contentTailRaw = typeof d.contentTail === 'string' ? d.contentTail.replace(/\s+/g, ' ').trim() : '';
      const contentTail = contentTailRaw ? `tail="${contentTailRaw.slice(-120)}"` : undefined;
      const errText = typeof d.error === 'string' ? d.error : 'Unknown LLM failure';
      const detailParts = [
        attempt !== undefined ? `attempt=${attempt}` : undefined,
        elapsedMs !== undefined ? `${elapsedMs}ms` : undefined,
        timedOut ? 'TIMEOUT' : undefined,
        status,
        finishReason,
        contentLength,
        reasoningLength,
        contentTail,
      ].filter(Boolean);
      const reqId = typeof d.requestId === 'string' ? d.requestId : undefined;
      const recoveredByRetry =
        Boolean(d.willRetry) &&
        Boolean(
          reqId &&
            entries
              .slice(entryIdx + 1)
              .some((later) => later.stage === 'llm.response' && (later.data as Record<string, unknown> | null)?.requestId === reqId)
        );
      pushTransition({
        phase: 'llm.failure',
        counts: { issues: recoveredByRetry ? 0 : 1 },
        notes: `${recoveredByRetry ? '[RECOVERED_RETRY] ' : ''}LLM通信失敗${detailParts.length ? ` (${detailParts.join(', ')})` : ''}: ${errText}`,
      });
    }
  }

  // 6. Outcome Details, Silent Exclusions Audit & Optional Deep Active Events Ledger
  const participationsByEvent = new Map<string, string[]>();
  for (const part of analysis?.participations ?? []) {
    const arr = participationsByEvent.get(part.eventId) ?? [];
    arr.push(`${part.entityId}:${part.role}`);
    participationsByEvent.set(part.eventId, arr);
  }

  const formatSourceRefs = (evRefs?: Array<{ sourceId: string; paragraphId: string }>): string[] =>
    Array.from(new Set((evRefs ?? []).map((r) => `${r.sourceId}/${r.paragraphId}`)));

  let outcomeDetails: OutcomeEventDetailSummary[] | undefined;
  if (analysis?.outcome?.eventIds?.length && analysis.events?.length) {
    const eventById = new Map(analysis.events.map((e) => [e.id, e]));
    const details: OutcomeEventDetailSummary[] = [];
    for (const eid of analysis.outcome.eventIds) {
      const ev = eventById.get(eid);
      if (!ev) continue;
      details.push({
        id: ev.id,
        kind: ev.outcome_kind ?? analysis.outcome.kind ?? 'loss',
        time: ev.time ?? '-',
        title: (ev.title || ev.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        participants: participationsByEvent.get(ev.id) ?? [],
        refs: formatSourceRefs(ev.sourceRefs),
      });
    }
    if (details.length > 0) {
      outcomeDetails = details;
    }
  }

  const droppedPostOutcomeMap = new Map<string, PostOutcomeDroppedSummary>();
  for (const entry of entries) {
    if (entry.stage !== 'scope.post_outcome_excluded' || !entry.data || typeof entry.data !== 'object') continue;
    const d = entry.data as {
      droppedEvents?: Array<{
        id?: string;
        time?: string;
        title?: string;
        participants?: string[];
        refs?: string[];
        dropRule?: string;
      }>;
    };
    for (const ev of d.droppedEvents ?? []) {
      if (!ev?.id) continue;
      droppedPostOutcomeMap.set(ev.id, {
        id: ev.id,
        time: ev.time ?? '-',
        title: (ev.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        participants: Array.isArray(ev.participants) ? ev.participants : [],
        refs: Array.isArray(ev.refs) ? ev.refs : [],
        drop_rule: ev.dropRule ?? 'post_outcome',
      });
    }
  }
  for (const ev of analysis?.events ?? []) {
    if (!ev.ignored || ev.ignoreReason !== 'post_outcome') continue;
    if (!droppedPostOutcomeMap.has(ev.id)) {
      droppedPostOutcomeMap.set(ev.id, {
        id: ev.id,
        time: ev.time ?? '-',
        title: (ev.title || ev.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        participants: participationsByEvent.get(ev.id) ?? [],
        refs: formatSourceRefs(ev.sourceRefs),
        drop_rule: ev.ignoreRule ?? 'post_outcome',
      });
    }
  }

  const maxAuditSlice = profile === 'deep' ? 30 : 8;
  const postOutcomeDropped = Array.from(droppedPostOutcomeMap.values()).slice(0, maxAuditSlice);

  const cardById = new Map((analysis?.cards ?? []).map((c) => [c.id, c]));
  const suppressedCardsRecord = presentation?.suppressedCards ?? {};
  const suppressedCards: SuppressedCardSummary[] = Object.entries(suppressedCardsRecord)
    .slice(0, maxAuditSlice)
    .map(([cardId, reason]) => {
      const cardRef = cardById.get(cardId);
      return {
        id: cardId,
        lane: cardRef?.laneEntityId ?? 'unknown',
        events: cardRef?.eventIds ?? [],
        reason: reason || 'suppressed',
      };
    });

  const hazardPriorityPattern = /死亡|亡くな|重傷|負傷|死傷|遺体|焼損|全損|炎上|大破|損壊|爆発|漏洩|衝突|墜落|脱線|転覆/;
  const rawDispositions = (analysis?.dispositions ?? []).filter(
    (disp) => (disp.kind === 'excluded' || disp.kind === 'review') && !disp.id.startsWith('disp_post_')
  );
  const sortedDispositions = [...rawDispositions].sort((a, b) => {
    const aHazard = hazardPriorityPattern.test(`${a.text ?? ''} ${a.reason ?? ''}`) ? 0 : 1;
    const bHazard = hazardPriorityPattern.test(`${b.text ?? ''} ${b.reason ?? ''}`) ? 0 : 1;
    return aHazard - bHazard;
  });
  const ledgerDispositions: DispositionAuditSummary[] = sortedDispositions
    .slice(0, profile === 'deep' ? 25 : 8)
    .map((disp) => ({
      id: disp.id,
      kind: disp.kind as 'excluded' | 'review',
      refs: formatSourceRefs(disp.sourceRefs),
      summary: (disp.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      reason: (disp.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
    }));

  let unreferencedParagraphs: SilentExclusionsAuditSummary['unreferenced_paragraphs'];
  if (scenarioText && scenarioText.trim().length > 0 && analysis?.events && analysis.events.length > 0) {
    const srcDoc = sourceFromText(scenarioText);
    const referencedIds = new Set<string>();
    const collectRefs = (refs?: Array<{ paragraphId: string }>) => {
      for (const r of refs ?? []) {
        if (r?.paragraphId) referencedIds.add(r.paragraphId.toLowerCase());
      }
    };
    for (const ev of analysis.events) {
      if (!ev.ignored) collectRefs(ev.sourceRefs);
    }
    for (const rel of analysis.relations ?? []) {
      collectRefs(rel.sourceRefs);
    }
    for (const disp of analysis.dispositions ?? []) {
      if (!disp.id.startsWith('disp_post_')) collectRefs(disp.sourceRefs);
    }
    collectRefs(analysis.outcome?.sourceRefs);

    const hazardTerms = ['死亡', '亡くな', '重傷', '負傷', '死傷', '遺体', '焼損', '全損', '大破', '炎上', '爆発', '衝突', '墜落', '沈没'];
    const unrefParas = srcDoc.paragraphs.filter((p, idx) => {
      const trimmed = p.text.trim();
      if (!trimmed) return false;
      if (/^[-=*_]{3,}$/.test(trimmed)) return false;
      if (/^#{1,6}\s+[^\n]+$/.test(trimmed) && trimmed.length <= 120 && !trimmed.includes('。')) return false;
      if (/^\*\*[^*\n。]{1,80}\*\*$/.test(trimmed)) return false;
      const prevText = idx > 0 ? srcDoc.paragraphs[idx - 1].text.trim() : '';
      if (idx <= 3 && /^#{1,6}\s*(?:\d+[.\s　]*)?(?:題目|件名|表題)\s*$/.test(prevText)) {
        return false;
      }
      return !referencedIds.has(p.id.toLowerCase());
    });

    if (unrefParas.length > 0) {
      const flagged = unrefParas
        .map((p) => {
          const matched = hazardTerms.filter((term) => p.text.includes(term));
          if (matched.length === 0) return null;
          return {
            paragraph: `${srcDoc.id}/${p.id}`,
            matched_terms: matched,
            snippet: p.text.replace(/\s+/g, ' ').trim().slice(0, 100),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      unreferencedParagraphs = {
        count: unrefParas.length,
        paragraph_ids: unrefParas.slice(0, profile === 'deep' ? 40 : 15).map((p) => `${srcDoc.id}/${p.id}`),
        ...(flagged.length > 0
          ? { flagged_with_hazard_terms: flagged.slice(0, profile === 'deep' ? 15 : 6) }
          : {}),
      };
    }
  }

  const unassignedIdSet = new Set(analysis?.unassignedEventIds ?? []);
  const unassignedEvents: UnassignedEventAuditSummary[] = (analysis?.events ?? [])
    .filter((ev) => !ev.ignored && unassignedIdSet.has(ev.id))
    .slice(0, maxAuditSlice)
    .map((ev) => ({
      id: ev.id,
      time: ev.time ?? '-',
      title: (ev.title || ev.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      refs: formatSourceRefs(ev.sourceRefs),
    }));

  const hasSilentExclusions =
    unassignedEvents.length > 0 ||
    postOutcomeDropped.length > 0 ||
    suppressedCards.length > 0 ||
    ledgerDispositions.length > 0 ||
    Boolean(unreferencedParagraphs);

  const silentExclusions: SilentExclusionsAuditSummary | undefined = hasSilentExclusions
    ? {
        ...(unassignedEvents.length > 0 ? { unassigned_events: unassignedEvents } : {}),
        ...(postOutcomeDropped.length > 0 ? { post_outcome_dropped: postOutcomeDropped } : {}),
        ...(suppressedCards.length > 0 ? { suppressed_cards: suppressedCards } : {}),
        ...(ledgerDispositions.length > 0 ? { ledger_dispositions: ledgerDispositions } : {}),
        ...(unreferencedParagraphs ? { unreferenced_paragraphs: unreferencedParagraphs } : {}),
      }
    : undefined;

  let activeEventsLedger: ActiveEventAuditSummary[] | undefined;
  if (profile === 'deep' && analysis?.events?.length) {
    activeEventsLedger = analysis.events
      .filter((ev) => !ev.ignored)
      .map((ev) => ({
        id: ev.id,
        time: ev.time ?? '-',
        title: (ev.title || ev.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        participants: participationsByEvent.get(ev.id) ?? [],
        classification: ev.outcome_kind
          ? `outcome:${ev.outcome_kind}`
          : ev.classification === 'variation' || Boolean(ev.variationFactor)
            ? 'variation'
            : ev.preliminary?.value ?? ev.classification ?? 'normal',
        refs: formatSourceRefs(ev.sourceRefs),
      }));
  }

  return {
    meta,
    ...(profile !== 'standard' ? { profile } : {}),
    ...(detectedRunId ? { run_id: detectedRunId } : {}),
    failure,
    ...(outcomeDetails ? { outcome_details: outcomeDetails } : {}),
    ...(silentExclusions ? { silent_exclusions: silentExclusions } : {}),
    ...(activeEventsLedger ? { active_events_ledger: activeEventsLedger } : {}),
    subject_poset: subjectPosetSummary,
    entity_lineage: entityLineage,
    anomalies: anomalies.slice(0, 15),
    pipeline_transitions: pipelineTransitions,
    contract_rules: {
      card_integrity: 'Cards projected to the canvas must contain at least 1 valid event in analysis.events.',
      post_outcome_exclusion: 'Events occurring after the terminal outcome are excluded when marked post_outcome by LLM preliminary classification (or when structurally unreachable and post-outcome without preliminary metadata); cards with 0 remaining events must be pruned.',
      evidence_validity: 'Every cited paragraph must physically contain the quoted phrase or entity action.',
      subject_poset_transitivity: 'Events and relations involving child subjects are transitively valid under their parent/ancestor subjects according to the canonical Subject Poset DAG (ADR-0010). Non-organization descendants must never absorb ancestor organizations.',
    },
  };
}

/**
 * Formats the AI diagnostics package into a crisp, readable Markdown/YAML document
 * ready to be pasted directly into Claude, ChatGPT, or Gemini.
 */
export function formatAIDiagnosticsAsMarkdown(pkg: AIDiagnosticsPackage): string {
  const lines: string[] = [];

  lines.push('# FailurePrism / VTA AI Diagnostics Package (v2.0)');
  lines.push('> **Prompt for AI Assistant**: Analyze this structured diagnostics trace. Pinpoint the root cause of the error or inconsistency, explain the pipeline mechanism that produced it, and provide the exact TypeScript fix.');
  lines.push('');

  // 1. Meta
  lines.push('## 1. Execution Meta');
  lines.push('```yaml');
  lines.push(`timestamp: "${pkg.meta.timestamp}"`);
  if (pkg.run_id) {
    lines.push(`run_id: "${pkg.run_id}"`);
  }
  if (pkg.profile) {
    lines.push(`profile: "${pkg.profile}"`);
  }
  lines.push(`model: "${pkg.meta.model ?? 'unknown'}"`);
  lines.push(`contract: "${pkg.meta.contract ?? 'relation-attributes-2'}"`);
  lines.push(`pipeline_status: "${pkg.meta.pipeline_status}"`);
  if (typeof pkg.meta.llm_calls === 'number') {
    lines.push(`llm_calls: ${pkg.meta.llm_calls}`);
  }
  if (typeof pkg.meta.total_llm_ms === 'number') {
    lines.push(`total_llm_ms: ${pkg.meta.total_llm_ms}`);
  }
  if (pkg.meta.outcome) {
    lines.push(`outcome:`);
    lines.push(`  status: "${pkg.meta.outcome.status}"`);
    if (pkg.meta.outcome.kind) {
      lines.push(`  kind: "${pkg.meta.outcome.kind}"`);
    }
    if (pkg.meta.outcome.event_ids && pkg.meta.outcome.event_ids.length > 0) {
      lines.push(`  event_ids: [${pkg.meta.outcome.event_ids.map((id) => `"${id}"`).join(', ')}]`);
    }
    if (pkg.meta.outcome.event_kinds && pkg.meta.outcome.event_kinds.length > 0) {
      lines.push(`  event_kinds: [${pkg.meta.outcome.event_kinds.map((k) => `"${k}"`).join(', ')}]`);
    }
  }
  if (pkg.outcome_details && pkg.outcome_details.length > 0) {
    lines.push(`outcome_details:`);
    for (const od of pkg.outcome_details) {
      lines.push(`  - id: "${od.id}"`);
      lines.push(`    kind: "${od.kind}"`);
      lines.push(`    time: "${od.time.replace(/"/g, '\\"')}"`);
      lines.push(`    title: "${od.title.replace(/"/g, '\\"')}"`);
      if (od.participants.length > 0) {
        lines.push(`    participants: [${od.participants.map((p) => `"${p}"`).join(', ')}]`);
      }
      if (od.refs.length > 0) {
        lines.push(`    refs: [${od.refs.map((r) => `"${r}"`).join(', ')}]`);
      }
    }
  }
  if (pkg.meta.scenario_meta) {
    lines.push(`scenario:`);
    lines.push(`  chars: ${pkg.meta.scenario_meta.chars}`);
    lines.push(`  snippet: "${pkg.meta.scenario_meta.snippet.replace(/"/g, '\\"')}"`);
  }
  lines.push('```');
  lines.push('');

  // 2. Failure Point
  if (pkg.failure) {
    lines.push('## 2. Failure Point');
    lines.push('```yaml');
    lines.push(`phase: "${pkg.failure.phase}"`);
    lines.push(`error_message: "${pkg.failure.error_message.replace(/"/g, '\\"')}"`);
    if (pkg.failure.trigger_entity_id) {
      lines.push(`trigger_entity_id: "${pkg.failure.trigger_entity_id}"`);
    }
    if (pkg.failure.source_hint) {
      lines.push(`source_hint: "${pkg.failure.source_hint}"`);
    }
    lines.push('```');
    lines.push('');
  }

  // 3. Entity Lineage
  if (pkg.entity_lineage.length > 0) {
    lines.push('## 3. Target Entity Lineage (Life-cycle Trace)');
    lines.push('```yaml');
    for (const ent of pkg.entity_lineage) {
      lines.push(`- target_id: "${ent.target_id}"`);
      lines.push(`  type: "${ent.type}"`);
      if (ent.parents && ent.parents.length > 0) {
        lines.push(`  parents: [${ent.parents.map((p) => `"${p}"`).join(', ')}]`);
      }
      if (ent.poset_ancestors && ent.poset_ancestors.length > 0) {
        lines.push(`  poset_ancestors: [${ent.poset_ancestors.map((a) => `"${a}"`).join(', ')}]`);
      }
      if (ent.resolved_to) {
        lines.push(`  resolved_to: "${ent.resolved_to.replace(/"/g, '\\"')}"`);
      }
      lines.push(`  lifecycle:`);
      for (const step of ent.lifecycle) {
        lines.push(`    - step: "${step.step}"`);
        lines.push(`      state: "${step.state}"`);
        if (step.held_ids && step.held_ids.length > 0) {
          lines.push(`      held_ids: [${step.held_ids.map((id) => `"${id}"`).join(', ')}]`);
        }
        if (step.raw_snippet) {
          lines.push(`      raw_snippet: "${step.raw_snippet.replace(/"/g, '\\"')}"`);
        }
        if (step.note) {
          lines.push(`      note: "${step.note.replace(/"/g, '\\"')}"`);
        }
      }
    }
    lines.push('```');
    lines.push('');
  }

  // 4. Subject Poset Hierarchy
  let secIdx = 4;
  if (pkg.subject_poset && pkg.subject_poset.hierarchies.length > 0) {
    lines.push(`## ${secIdx++}. Subject Poset DAG Hierarchy (Canonical Inclusion)`);
    lines.push('```yaml');
    lines.push(`node_count: ${pkg.subject_poset.node_count}`);
    if (typeof pkg.subject_poset.catalog_count === 'number') {
      lines.push(`catalog_count: ${pkg.subject_poset.catalog_count}`);
    }
    lines.push(`edge_count: ${pkg.subject_poset.edge_count}`);
    lines.push(`hierarchies:`);
    for (const h of pkg.subject_poset.hierarchies) {
      lines.push(`  - id: "${h.id}"`);
      lines.push(`    name: "${h.name.replace(/"/g, '\\"')}"`);
      if (h.kind) {
        lines.push(`    kind: "${h.kind}"`);
      }
      if (h.focus) {
        lines.push(`    focus: "${h.focus}"`);
      }
      if (typeof h.score === 'number') {
        lines.push(`    score: ${h.score}`);
      }
      if (h.events) {
        lines.push(`    events: ${JSON.stringify(h.events)}`);
      }
      if (h.parents.length > 0) {
        lines.push(`    parents: [${h.parents.map((p) => `"${p}"`).join(', ')}]`);
      }
      if (h.ancestors.length > 0) {
        lines.push(`    ancestors: [${h.ancestors.map((a) => `"${a}"`).join(', ')}]`);
      }
      if (h.merged_into) {
        lines.push(`    merged_into: "${h.merged_into}"`);
      }
      if (h.excluded) {
        lines.push(`    excluded: true`);
      }
      if (h.consolidation_stage) {
        lines.push(`    consolidation_stage: "${h.consolidation_stage}"`);
      }
      if (h.merge_guard) {
        lines.push(`    merge_guard: "${h.merge_guard.replace(/"/g, '\\"')}"`);
      }
    }
    lines.push('```');
    lines.push('');
  }

  // Silent Exclusions & Unreferenced Paragraph Audit
  if (pkg.silent_exclusions) {
    lines.push(`## ${secIdx++}. Silent Exclusions & Unreferenced Paragraph Audit`);
    lines.push('```yaml');
    const se = pkg.silent_exclusions;
    if (se.unassigned_events && se.unassigned_events.length > 0) {
      lines.push(`unassigned_events:`);
      for (const item of se.unassigned_events) {
        lines.push(`  - id: "${item.id}"`);
        lines.push(`    time: "${item.time.replace(/"/g, '\\"')}"`);
        lines.push(`    title: "${item.title.replace(/"/g, '\\"')}"`);
        if (item.refs.length > 0) {
          lines.push(`    refs: [${item.refs.map((r) => `"${r}"`).join(', ')}]`);
        }
      }
    }
    if (se.post_outcome_dropped && se.post_outcome_dropped.length > 0) {
      lines.push(`post_outcome_dropped:`);
      for (const item of se.post_outcome_dropped) {
        lines.push(`  - id: "${item.id}"`);
        lines.push(`    time: "${item.time.replace(/"/g, '\\"')}"`);
        lines.push(`    title: "${item.title.replace(/"/g, '\\"')}"`);
        if (item.participants.length > 0) {
          lines.push(`    participants: [${item.participants.map((p) => `"${p}"`).join(', ')}]`);
        }
        if (item.refs.length > 0) {
          lines.push(`    refs: [${item.refs.map((r) => `"${r}"`).join(', ')}]`);
        }
        lines.push(`    drop_rule: "${item.drop_rule.replace(/"/g, '\\"')}"`);
      }
    }
    if (se.suppressed_cards && se.suppressed_cards.length > 0) {
      lines.push(`suppressed_cards:`);
      for (const sc of se.suppressed_cards) {
        lines.push(`  - id: "${sc.id}"`);
        lines.push(`    lane: "${sc.lane}"`);
        lines.push(`    events: [${sc.events.map((e) => `"${e}"`).join(', ')}]`);
        lines.push(`    reason: "${sc.reason.replace(/"/g, '\\"')}"`);
      }
    }
    if (se.ledger_dispositions && se.ledger_dispositions.length > 0) {
      lines.push(`ledger_dispositions:`);
      for (const disp of se.ledger_dispositions) {
        lines.push(`  - id: "${disp.id}"`);
        lines.push(`    kind: "${disp.kind}"`);
        if (disp.refs.length > 0) {
          lines.push(`    refs: [${disp.refs.map((r) => `"${r}"`).join(', ')}]`);
        }
        lines.push(`    summary: "${disp.summary.replace(/"/g, '\\"')}"`);
        lines.push(`    reason: "${disp.reason.replace(/"/g, '\\"')}"`);
      }
    }
    if (se.unreferenced_paragraphs) {
      lines.push(`unreferenced_paragraphs:`);
      lines.push(`  count: ${se.unreferenced_paragraphs.count}`);
      lines.push(`  paragraph_ids: [${se.unreferenced_paragraphs.paragraph_ids.map((id) => `"${id}"`).join(', ')}]`);
      if (se.unreferenced_paragraphs.flagged_with_hazard_terms?.length) {
        lines.push(`  flagged_with_hazard_terms:`);
        for (const f of se.unreferenced_paragraphs.flagged_with_hazard_terms) {
          lines.push(`    - paragraph: "${f.paragraph}"`);
          lines.push(`      matched_terms: [${f.matched_terms.map((t) => `"${t}"`).join(', ')}]`);
          lines.push(`      snippet: "${f.snippet.replace(/"/g, '\\"')}"`);
        }
      }
    }
    lines.push('```');
    lines.push('');
  }

  // Deep Profile Active Events Ledger
  if (pkg.active_events_ledger && pkg.active_events_ledger.length > 0) {
    lines.push(`## ${secIdx++}. Active Events Ledger (${pkg.active_events_ledger.length} events)`);
    lines.push('```yaml');
    for (const ev of pkg.active_events_ledger) {
      lines.push(`- id: "${ev.id}"`);
      lines.push(`  time: "${ev.time.replace(/"/g, '\\"')}"`);
      lines.push(`  classification: "${ev.classification}"`);
      lines.push(`  title: "${ev.title.replace(/"/g, '\\"')}"`);
      if (ev.participants.length > 0) {
        lines.push(`  participants: [${ev.participants.map((p) => `"${p}"`).join(', ')}]`);
      }
      if (ev.refs.length > 0) {
        lines.push(`  refs: [${ev.refs.map((r) => `"${r}"`).join(', ')}]`);
      }
    }
    lines.push('```');
    lines.push('');
  }

  // Anomalies
  if (pkg.anomalies.length > 0) {
    lines.push(`## ${secIdx++}. Anomalies & Validation Issues (${pkg.anomalies.length} items)`);
    lines.push('```yaml');
    for (const an of pkg.anomalies) {
      lines.push(`- id: "${an.id}"`);
      lines.push(`  stage: "${an.stage}"`);
      lines.push(`  issue_type: "${an.issue_type}"`);
      if (an.target_id) lines.push(`  target_id: "${an.target_id}"`);
      if (an.raw_llm_output) lines.push(`  raw_output: "${an.raw_llm_output.replace(/"/g, '\\"')}"`);
      lines.push(`  violation: "${an.violation_detail.replace(/"/g, '\\"')}"`);
      if (an.geometry) {
        lines.push(`  geometry:`);
        if (an.geometry.drop_px !== undefined) lines.push(`    drop_px: ${an.geometry.drop_px}`);
        if (an.geometry.axis !== undefined) lines.push(`    axis: "${an.geometry.axis}"`);
        if (an.geometry.gap_px !== undefined) lines.push(`    gap_px: ${an.geometry.gap_px}`);
        if (an.geometry.coord_a !== undefined) lines.push(`    coord_a: ${an.geometry.coord_a}`);
        if (an.geometry.coord_b !== undefined) lines.push(`    coord_b: ${an.geometry.coord_b}`);
        if (an.geometry.overlap_span !== undefined) lines.push(`    overlap_span: "${an.geometry.overlap_span}"`);
        const s = an.geometry.source as Record<string, unknown> | undefined;
        if (s) {
          lines.push(`    source:`);
          lines.push(`      id: "${s.id}"`);
          lines.push(`      lane: "${s.lane}"`);
          lines.push(`      centerY: ${s.centerY}`);
          if (s.height !== undefined) lines.push(`      height: ${s.height}`);
          if (s.measured_height !== undefined) lines.push(`      measured_height: ${s.measured_height}`);
          if (s.estimated_height !== undefined) lines.push(`      estimated_height: ${s.estimated_height}`);
          if (s.is_dot !== undefined) lines.push(`      is_dot: ${s.is_dot}`);
          if (s.title) lines.push(`      title: "${String(s.title).replace(/"/g, '\\"')}"`);
          if (s.time) lines.push(`      time: "${String(s.time).replace(/"/g, '\\"')}"`);
          if (s.event_id) lines.push(`      event_id: "${String(s.event_id).replace(/"/g, '\\"')}"`);
        }
        const t = an.geometry.target as Record<string, unknown> | undefined;
        if (t) {
          lines.push(`    target:`);
          lines.push(`      id: "${t.id}"`);
          lines.push(`      lane: "${t.lane}"`);
          lines.push(`      centerY: ${t.centerY}`);
          if (t.height !== undefined) lines.push(`      height: ${t.height}`);
          if (t.measured_height !== undefined) lines.push(`      measured_height: ${t.measured_height}`);
          if (t.estimated_height !== undefined) lines.push(`      estimated_height: ${t.estimated_height}`);
          if (t.is_dot !== undefined) lines.push(`      is_dot: ${t.is_dot}`);
          if (t.title) lines.push(`      title: "${String(t.title).replace(/"/g, '\\"')}"`);
          if (t.time) lines.push(`      time: "${String(t.time).replace(/"/g, '\\"')}"`);
          if (t.event_id) lines.push(`      event_id: "${String(t.event_id).replace(/"/g, '\\"')}"`);
        }
        for (const edgeKey of ['edge_a', 'edge_b'] as const) {
          const e = an.geometry[edgeKey] as Record<string, unknown> | undefined;
          if (!e) continue;
          lines.push(`    ${edgeKey}:`);
          lines.push(`      id: "${e.id}"`);
          lines.push(`      source: "${e.source}"`);
          if (e.target !== undefined) lines.push(`      target: "${e.target}"`);
          if (e.source_lane !== undefined) lines.push(`      source_lane: "${String(e.source_lane).replace(/"/g, '\\"')}"`);
          if (e.target_lane !== undefined) lines.push(`      target_lane: "${String(e.target_lane).replace(/"/g, '\\"')}"`);
          if (e.source_is_dot !== undefined) lines.push(`      source_is_dot: ${e.source_is_dot}`);
          if (e.target_is_dot !== undefined) lines.push(`      target_is_dot: ${e.target_is_dot}`);
        }
      }
      if (an.evidence_paragraph) {
        lines.push(`  evidence_paragraph:`);
        lines.push(`    id: "${an.evidence_paragraph.id}"`);
        lines.push(`    text: "${an.evidence_paragraph.text.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
      }
    }
    lines.push('```');
    lines.push('');
  }

  // Pipeline Transitions
  if (pkg.pipeline_transitions.length > 0) {
    lines.push(`## ${secIdx++}. Pipeline State Transitions`);
    lines.push('```yaml');
    for (const pt of pkg.pipeline_transitions) {
      lines.push(`- phase: "${pt.phase}"`);
      if (pt.counts) {
        lines.push(`  counts: ${JSON.stringify(pt.counts)}`);
      }
      if (pt.score) {
        lines.push(`  score: ${JSON.stringify(pt.score)}`);
      }
      if (pt.notes) {
        lines.push(`  notes: "${pt.notes.replace(/"/g, '\\"')}"`);
      }
    }
    lines.push('```');
    lines.push('');
  }

  // Contract Rules
  if (pkg.contract_rules) {
    lines.push(`## ${secIdx++}. Active Contract Integrity Rules`);
    lines.push('```yaml');
    for (const [k, v] of Object.entries(pkg.contract_rules)) {
      lines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
    }
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}
