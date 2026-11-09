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
import type { VTAAnalysisData, VTAEntity, SubjectPosetData } from '../../types/vta';
import { SubjectPoset } from '../../features/vta/utils/subjectPoset';

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

export interface SubjectHierarchySummary {
  id: string;
  name: string;
  parents: string[];
  ancestors: string[];
  merged_into?: string;
}

export interface SubjectPosetSummary {
  node_count: number;
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
    edges?: number;
    subjects?: number;
    issues?: number;
  };
  score?: {
    S?: number;
    C1?: number;
    C3?: number;
    C5?: number;
    adopted?: boolean;
  };
  notes?: string;
}

export interface AIDiagnosticsPackage {
  meta: AIDiagnosticsMeta;
  failure?: AIDiagnosticsFailure;
  subject_poset?: SubjectPosetSummary;
  entity_lineage: EntityLineage[];
  anomalies: DiagnosticsAnomaly[];
  pipeline_transitions: PipelineTransitionSummary[];
  contract_rules?: Record<string, string>;
}

/**
 * Finds the latest analysis or subject poset data recorded in debug entries.
 */
export function findLatestAnalysis(entries: DebugEntry[]): {
  analysis?: VTAAnalysisData;
  subjectPoset?: SubjectPosetData;
  entities?: VTAEntity[];
} {
  for (let i = entries.length - 1; i >= 0; i--) {
    const d = entries[i].data as Record<string, unknown> | null;
    if (!d) continue;
    if (d.analysis && typeof d.analysis === 'object') {
      const a = d.analysis as VTAAnalysisData;
      return { analysis: a, subjectPoset: a.subjectPoset, entities: a.entities };
    }
    if (d.subjectPoset && typeof d.subjectPoset === 'object') {
      const sp = d.subjectPoset as SubjectPosetData;
      const ents = Array.isArray(d.entities) ? (d.entities as VTAEntity[]) : undefined;
      return { subjectPoset: sp, entities: ents };
    }
    if (Array.isArray(d.entities) && d.entities.length > 0) {
      return { entities: d.entities as VTAEntity[] };
    }
  }
  return {};
}

/**
 * Splits scenario text into paragraph index map.
 * Supports P1, P2, source_1/p1, etc.
 */
export function extractParagraphs(scenarioText?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!scenarioText) return map;

  const rawParagraphs = scenarioText
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  rawParagraphs.forEach((p, idx) => {
    const num = idx + 1;
    const cleanText = p.slice(0, 500); // Limit paragraph snippet to 500 chars to protect token budget
    map.set(`P${num}`, cleanText);
    map.set(`p${num}`, cleanText);
    map.set(`${num}`, cleanText);
    map.set(`source_1/p${num}`, cleanText);
    map.set(`source_1/P${num}`, cleanText);
  });

  return map;
}

/**
 * Extracts candidate entity IDs mentioned in error messages or anomalies.
 */
export function detectTriggerEntityIds(errorMessage?: string, anomalies?: DiagnosticsAnomaly[]): string[] {
  const ids = new Set<string>();
  const entityRegex = /\b(card_[a-zA-Z0-9_-]+|card\d+|E\d+|A\d+|R\d+|X\d+|tmp_[a-zA-Z0-9_-]+)\b/g;

  if (errorMessage) {
    let match;
    while ((match = entityRegex.exec(errorMessage)) !== null) {
      ids.add(match[1]);
    }
  }

  if (anomalies) {
    for (const a of anomalies) {
      if (a.issue_type === 'LEDGER_WARNING') continue;
      if (a.target_id) ids.add(a.target_id);
      let match;
      while ((match = entityRegex.exec(a.violation_detail)) !== null) {
        ids.add(match[1]);
      }
    }
  }

  return Array.from(ids);
}

/**
 * Traces the lifecycle of a target entity across all recorded debug entries,
 * including Subject Poset hierarchy and transitivity resolution (ADR-0010).
 */
export function traceEntityLineage(targetId: string, entries: DebugEntry[]): EntityLineage {
  const lifecycle: EntityLifecycleStep[] = [];
  let detectedType: EntityLineage['type'] = 'UNKNOWN';

  // Extract analysis / Poset data from debug entries
  const { analysis, subjectPoset: posetData, entities } = findLatestAnalysis(entries);
  const effectiveEntities = entities ?? analysis?.entities ?? [];
  let poset: SubjectPoset | undefined;
  if (posetData) {
    poset = SubjectPoset.fromData(posetData);
  } else if (effectiveEntities.length > 0) {
    poset = SubjectPoset.fromEntities(effectiveEntities);
  }

  if (targetId.startsWith('card_') || targetId.startsWith('card')) detectedType = 'VTACard';
  else if (/^E\d+$/.test(targetId) || analysis?.events?.some((e) => e.id === targetId)) detectedType = 'VTAEvent';
  else if (/^A\d+$/.test(targetId) || effectiveEntities.some((e) => e.id === targetId || e.name === targetId)) detectedType = 'VTASubject';
  else if (/^(R[0-9_a-zA-Z-]*|tmp_R)/.test(targetId) || analysis?.relations?.some((r) => r.id === targetId)) detectedType = 'VTARelation';

  let parents: string[] | undefined;
  let posetAncestors: string[] | undefined;
  let resolvedTo: string | undefined;

  if (detectedType === 'VTASubject') {
    const ent = effectiveEntities.find((e) => e.id === targetId || e.name === targetId);
    if (ent) {
      const p = ent.parentEntityIds?.length ? ent.parentEntityIds : (ent.parentEntityId ? [ent.parentEntityId] : []);
      if (p.length > 0) parents = p;
      if (poset) {
        const anc = poset.getAncestors(ent.id);
        if (anc.size > 0) posetAncestors = Array.from(anc);
      }
      const mergedInto = effectiveEntities.find((e) => e.id !== ent.id && e.mergedFrom?.includes(ent.id));
      if (mergedInto) {
        resolvedTo = `${mergedInto.id} (${mergedInto.name})`;
      }
    }
  }

  for (const entry of entries) {
    const d = entry.data as Record<string, unknown> | null;
    if (!d) continue;

    // 1. graph.projection
    if (entry.stage === 'graph.projection') {
      const cards = Array.isArray(d.cards) ? (d.cards as Array<{ id: string; eventIds?: string[]; laneEntityId?: string }>) : [];
      const card = cards.find((c) => c.id === targetId);
      if (card) {
        detectedType = 'VTACard';
        lifecycle.push({
          step: 'graph.projection',
          time: entry.time,
          state: card.eventIds && card.eventIds.length > 0 ? 'VALIDATED' : 'ORPHANED_ERROR',
          held_ids: card.eventIds,
          note: `Card associated with lane '${card.laneEntityId}', holding events: [${card.eventIds?.join(', ')}]`,
        });
      }

      // Check if targetId is an event
      if (detectedType === 'VTAEvent') {
        const matchingCard = cards.find((c) => c.eventIds?.includes(targetId));
        if (matchingCard) {
          lifecycle.push({
            step: 'graph.projection',
            time: entry.time,
            state: 'VALIDATED',
            note: `Event belongs to card '${matchingCard.id}' on lane '${matchingCard.laneEntityId}'`,
          });
        }
      }
    }

    // 2. ledger.validation
    if (entry.stage === 'ledger.validation') {
      const rows = Array.isArray(d.rows)
        ? (d.rows as Array<{ id?: string; section?: string; cells?: string[]; raw?: string; events?: string[] }>)
        : [];
      const row = rows.find((r) => {
        const rawText = r.raw ?? (Array.isArray(r.cells) ? r.cells.join('\t') : '');
        return r.id === targetId || rawText.includes(targetId);
      });
      if (row) {
        const rawText = row.raw ?? (Array.isArray(row.cells) ? row.cells.join('\t') : undefined);
        if (detectedType === 'UNKNOWN' && row.id === targetId && row.section) {
          if (row.section === 'イベント') detectedType = 'VTAEvent';
          else if (row.section === '主体') detectedType = 'VTASubject';
          else if (row.section === '関係') detectedType = 'VTARelation';
        }
        lifecycle.push({
          step: 'ledger.validation',
          time: entry.time,
          state: 'CREATED',
          raw_snippet: rawText?.slice(0, 150),
          held_ids: row.events,
          note: `Defined in ledger validation row`,
        });
      }
    }

    // 3. chain-repair.validation
    if (entry.stage === 'chain-repair.validation') {
      const issues = Array.isArray(d.issues) ? (d.issues as Array<{ id?: string; raw?: string; reason?: string }>) : [];
      const issue = issues.find((i) => i.id === targetId || i.raw?.includes(targetId) || i.reason?.includes(targetId));
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

    // 4. operation errors
    if (entry.stage === 'operation') {
      const msg = typeof d.message === 'string' ? d.message : '';
      if (msg.includes(targetId)) {
        lifecycle.push({
          step: 'operation',
          time: entry.time,
          state: 'ORPHANED_ERROR',
          note: msg,
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
}): AIDiagnosticsPackage {
  const { entries, scenarioText, lastError } = options;
  const paragraphs = extractParagraphs(scenarioText);

  // 1. Meta Extraction & Latest Analysis
  const { analysis, subjectPoset: posetData, entities } = findLatestAnalysis(entries);
  let model: string | undefined;
  let contract: string | undefined;
  let lastReqTime = '';
  let llmCalls = 0;
  let totalLlmMs = 0;

  for (const entry of entries) {
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

  for (let i = entries.length - 1; i >= 0; i--) {
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
    outcomeMeta = {
      status: analysis.outcome.status,
      kind: analysis.outcome.kind,
      event_ids: analysis.outcome.eventIds?.length ? analysis.outcome.eventIds : undefined,
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

  for (const entry of entries) {
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
      for (const iss of issues.slice(0, 10)) { // Limit to top 10 issues
        const raw = iss.raw ?? (Array.isArray(iss.row?.cells) ? iss.row!.cells.join('\t') : '');
        const targetId = iss.id ?? iss.row?.id;
        const issueType = iss.rule ?? iss.code ?? 'VALIDATION_ISSUE';
        // Extract paragraph if cited
        const pMatch = raw.match(/\b(source_\d+\/[pP]\d+|[pP]\d+)\b/);
        const pId = pMatch ? pMatch[1] : undefined;
        const pText = pId ? paragraphs.get(pId) : undefined;

        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'ledger.validation',
          issue_type: issueType,
          target_id: targetId,
          raw_llm_output: raw || undefined,
          violation_detail: iss.message ?? 'Unknown validation issue',
          evidence_paragraph: pId && pText ? { id: pId, text: pText } : undefined,
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
        const pMatch = raw.match(/\b(source_\d+\/[pP]\d+|[pP]\d+)\b/);
        const pId = pMatch ? pMatch[1] : undefined;
        const pText = pId ? paragraphs.get(pId) : undefined;

        anomalies.push({
          id: `anomaly_${anomalyIdx++}`,
          stage: 'chain-repair.validation',
          issue_type: iss.section ?? 'CHAIN_REPAIR_ISSUE',
          target_id: iss.id,
          raw_llm_output: raw,
          violation_detail: iss.reason ?? 'Chain repair failure',
          evidence_paragraph: pId && pText ? { id: pId, text: pText } : undefined,
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

  // 3. Subject Poset Summary
  const effectiveEntities = entities ?? analysis?.entities ?? [];
  let poset: SubjectPoset | undefined;
  if (posetData) {
    poset = SubjectPoset.fromData(posetData);
  } else if (effectiveEntities.length > 0) {
    poset = SubjectPoset.fromEntities(effectiveEntities);
  }

  let subjectPosetSummary: SubjectPosetSummary | undefined;
  if (poset && effectiveEntities.length > 0) {
    const hierarchies: SubjectHierarchySummary[] = effectiveEntities.map((ent) => {
      const p = ent.parentEntityIds?.length ? ent.parentEntityIds : (ent.parentEntityId ? [ent.parentEntityId] : []);
      const a = poset.getAncestors(ent.id);
      const mergedInto = effectiveEntities.find((e) => e.id !== ent.id && e.mergedFrom?.includes(ent.id));
      return {
        id: ent.id,
        name: ent.name,
        parents: p,
        ancestors: Array.from(a),
        merged_into: mergedInto ? mergedInto.id : undefined,
      };
    });

    const data = poset.toData();
    subjectPosetSummary = {
      node_count: data.nodes.length,
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
    failure = {
      phase: failurePhase,
      error_message: failureError,
      trigger_entity_id: triggerIds[0],
      source_hint: failureError.includes('カード') ? 'eventAnalysis.ts:457 (check empty events filter)' : undefined,
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

  for (const entry of entries) {
    const d = entry.data as Record<string, unknown> | null;
    if (!d) continue;

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
      pushTransition({
        phase: 'graph.projection',
        counts: {
          cards,
          events: nodes,
          ...(edgesCount !== undefined ? { edges: edgesCount } : {}),
        },
        notes: `generation: ${genLabel}`,
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

    if (entry.stage === 'chain-repair.validation') {
      const rows = Array.isArray(d.rows) ? d.rows.length : undefined;
      const issues = Array.isArray(d.issues) ? d.issues.length : undefined;
      pushTransition({
        phase: 'chain.repair',
        counts: {
          issues,
        },
        notes: `連鎖補完点検: 差分候補 ${rows ?? 0}行、指摘 ${issues ?? 0}件`,
      });
    }

    if (entry.stage === 'operation') {
      const msg = typeof d.message === 'string' ? d.message : '';
      if (msg.includes('粒度反復')) {
        // extract score S, C1, etc.
        const sMatch = msg.match(/S=([\d.]+)/);
        const c1Match = msg.match(/C1=([\d.]+)/);
        const c3Match = msg.match(/C3=([\d.]+)/);
        const c5Match = msg.match(/C5=([\d.]+)/);
        pushTransition({
          phase: 'granularity.refinement',
          score: {
            S: sMatch ? parseFloat(sMatch[1]) : undefined,
            C1: c1Match ? parseFloat(c1Match[1]) : undefined,
            C3: c3Match ? parseFloat(c3Match[1]) : undefined,
            C5: c5Match ? parseFloat(c5Match[1]) : undefined,
            adopted: msg.includes('採用=はい'),
          },
          notes: msg,
        });
      } else if (msg.includes('事後活動除外')) {
        pushTransition({
          phase: 'post_outcome_exclusion',
          notes: msg,
        });
      } else if (msg.includes('仮判定完了') || msg.includes('仮判定パス') || msg.includes('仮判定フォールバック')) {
        pushTransition({
          phase: 'preliminary.classification',
          notes: msg,
        });
      } else if (msg.includes('VTAツリー自動生成完了')) {
        pushTransition({
          phase: 'pipeline.completed',
          notes: msg,
        });
      }
    }
  }

  return {
    meta,
    failure,
    subject_poset: subjectPosetSummary,
    entity_lineage: entityLineage,
    anomalies: anomalies.slice(0, 15),
    pipeline_transitions: pipelineTransitions,
    contract_rules: {
      card_integrity: 'Cards projected to the canvas must contain at least 1 valid event in analysis.events.',
      post_outcome_exclusion: 'Events occurring after the terminal outcome are excluded; cards with 0 remaining events must be pruned.',
      evidence_validity: 'Every cited paragraph must physically contain the quoted phrase or entity action.',
      subject_poset_transitivity: 'Events and relations involving child subjects are transitively valid under their parent/ancestor subjects according to the canonical Subject Poset DAG (ADR-0010).',
    },
  };
}

/**
 * Formats the AI diagnostics package into a crisp, readable Markdown/YAML document
 * ready to be pasted directly into Claude, ChatGPT, or Gemini.
 */
export function formatAIDiagnosticsAsMarkdown(pkg: AIDiagnosticsPackage): string {
  const lines: string[] = [];

  lines.push('# FailurePrism / VTA AI Diagnostics Package (v1.0)');
  lines.push('> **Prompt for AI Assistant**: Analyze this structured diagnostics trace. Pinpoint the root cause of the error or inconsistency, explain the pipeline mechanism that produced it, and provide the exact TypeScript fix.');
  lines.push('');

  // 1. Meta
  lines.push('## 1. Execution Meta');
  lines.push('```yaml');
  lines.push(`timestamp: "${pkg.meta.timestamp}"`);
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
    lines.push(`edge_count: ${pkg.subject_poset.edge_count}`);
    lines.push(`hierarchies:`);
    for (const h of pkg.subject_poset.hierarchies) {
      lines.push(`  - id: "${h.id}"`);
      lines.push(`    name: "${h.name.replace(/"/g, '\\"')}"`);
      if (h.parents.length > 0) {
        lines.push(`    parents: [${h.parents.map((p) => `"${p}"`).join(', ')}]`);
      }
      if (h.ancestors.length > 0) {
        lines.push(`    ancestors: [${h.ancestors.map((a) => `"${a}"`).join(', ')}]`);
      }
      if (h.merged_into) {
        lines.push(`    merged_into: "${h.merged_into}"`);
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
