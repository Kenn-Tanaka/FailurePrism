/**
 * Two-tier, memory-only VTA diagnostics recorder (RM-LOG-02 / RM-LOG-04 / RM-LOG-05).
 * - Tier 1 (Always-On Flight Recorder): Lightweight ring buffer (~350KB cap) storing only
 *   structured telemetry, exclusion ledgers, and metadata (never raw scenario/prompt bodies).
 *   Enables instant post-hoc AI Diagnostics export even when full debug recording was OFF.
 * - Tier 2 (Opt-In Full Recorder): Activated via `setEnabled(true)`, storing full prompts,
 *   raw LLM responses, and snapshots for deep JSON export.
 * Nothing is written to persistent storage or uploaded automatically.
 */
import {
  buildAIDiagnostics,
  formatAIDiagnosticsAsMarkdown,
  type AIDiagnosticsPackage,
  type DiagnosticsProfile,
} from './diagnostics/aiDiagnostics';

export const DEBUG_LIMITS = { entries: 500, totalChars: 10_000_000, entryChars: 1_000_000 };
export const FLIGHT_LIMITS = { entries: 220, totalChars: 350_000, entryChars: 80_000 };

export type DiagnosticsScope = 'latest_run' | 'all';

export type DebugEntry = {
  time: string;
  sessionId: string;
  runId?: string;
  stage: string;
  data: unknown;
  truncated: boolean;
  originalChars: number;
};

export interface DiagnosticEventMap {
  'pipeline.run_start': {
    runId: string;
    kind: string;
  };
  'pipeline.run_end': {
    runId: string;
    kind?: string;
    status: 'completed' | 'failed' | 'cancelled';
  };
  'granularity.iteration': {
    index: number;
    score: number;
    c1: number;
    c2?: number;
    c3: number;
    rawC3?: number;
    c4?: number;
    c5: number;
    scenarioScore?: number;
    preMaxSubjects: number;
    postMaxSubjects: number;
    adopted: boolean;
    appliedOps: string[];
    gateViolations?: string[];
    note: string;
  };
  'scope.post_outcome_excluded': {
    excludedNodesCount: number;
    excludedEventsCount: number;
    maxOutcomeOrder?: number;
    droppedEvents: Array<{
      id: string;
      time: string;
      title: string;
      participants: string[];
      refs: string[];
      dropRule: string;
    }>;
  };
  'subject.others_consolidation': {
    mode: string;
    preMaxSubjects?: number;
    postMaxSubjects?: number;
    rolledUpPosetEntityIds: string[];
    foldedEntityIds: string[];
    skippedReason?: string;
    visibleLanes?: number;
  };
}

export interface ExportAIDiagnosticsOptions {
  profile?: DiagnosticsProfile;
  scope?: DiagnosticsScope;
}

export interface ExportTextOptions {
  compact?: boolean;
  deduplicate?: boolean;
  includeDiagnostics?: boolean;
  scenarioText?: string;
  lastError?: string;
  profile?: DiagnosticsProfile;
  scope?: DiagnosticsScope;
}

function stripSourceBodiesFromAnalysis(analysis: unknown): unknown {
  if (!analysis || typeof analysis !== 'object') return analysis;
  const rec = analysis as Record<string, unknown>;
  const { fineGrainedBase: _omitFineBase, ...rest } = rec;
  if (!Array.isArray(rest.sources)) return rest;
  return {
    ...rest,
    sources: rest.sources.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const src = s as { id?: unknown; paragraphs?: unknown };
      return {
        id: src.id,
        text: '',
        paragraphs: Array.isArray(src.paragraphs)
          ? src.paragraphs.map((p) =>
              p && typeof p === 'object' ? { id: (p as { id?: unknown }).id, text: '' } : p
            )
          : [],
      };
    }),
  };
}

const FLIGHT_RECORDER_STAGES = new Set<string>([
  'pipeline.run_start',
  'pipeline.run_end',
  'recording.start',
  'project.snapshot',
  'llm.request',
  'llm.response',
  'llm.failure',
  'llm.http-error',
  'ledger.validation',
  'ledger.parse_error',
  'preliminary.classification',
  'granularity.iteration',
  'scope.post_outcome_excluded',
  'graph.projection',
  'subject.ranking',
  'subject.others_consolidation',
  'connection.proposal',
  'connection-proposal.validation',
  'chain-repair.triage',
  'chain-repair.validation',
  'variation.classification',
  'layout.audit',
  'operation',
]);

function compactForFlightRecorder(stage: string, raw: unknown): { skip?: boolean; value: unknown } {
  if (!FLIGHT_RECORDER_STAGES.has(stage)) {
    return { skip: true, value: null };
  }
  if (!raw || typeof raw !== 'object') {
    return { value: raw };
  }
  const obj = raw as Record<string, unknown>;
  if (stage === 'recording.start') {
    return {
      value: {
        projectId: obj.projectId,
      },
    };
  }
  if (stage === 'project.snapshot') {
    const schema = obj.schema && typeof obj.schema === 'object' ? (obj.schema as Record<string, unknown>) : undefined;
    const strippedAnalysis = schema ? stripSourceBodiesFromAnalysis(schema.analysis) : undefined;
    return {
      value: {
        projectId: obj.projectId,
        ...(schema
          ? {
              schema: {
                lanes: schema.lanes,
                nodes: schema.nodes,
                edges: schema.edges,
                presentation: schema.presentation,
                analysis: strippedAnalysis,
              },
              presentation: schema.presentation,
            }
          : {}),
      },
    };
  }
  if (stage === 'llm.request') {
    const messages = Array.isArray(obj.messages) ? obj.messages : undefined;
    return {
      value: {
        requestId: obj.requestId,
        model: obj.model,
        stream: obj.stream,
        messageCount: messages?.length,
      },
    };
  }
  if (stage === 'llm.response') {
    const content = typeof obj.content === 'string' ? obj.content : undefined;
    return {
      value: {
        requestId: obj.requestId,
        elapsedMs: obj.elapsedMs,
        contentLength: content !== undefined ? content.length : obj.contentLength,
        finishReason: obj.finishReason,
      },
    };
  }
  if ('analysis' in obj && obj.analysis && typeof obj.analysis === 'object') {
    return {
      value: {
        ...obj,
        analysis: stripSourceBodiesFromAnalysis(obj.analysis),
      },
    };
  }
  return { value: raw };
}

export function selectEntriesForDiagnostics(
  entries: DebugEntry[],
  scope: DiagnosticsScope = 'latest_run'
): DebugEntry[] {
  if (scope === 'all' || entries.length === 0) return entries;

  let latestRunId: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].runId) {
      latestRunId = entries[i].runId;
      break;
    }
  }
  if (!latestRunId) return entries;

  const firstIdx = entries.findIndex((e) => e.runId === latestRunId);
  if (firstIdx < 0) return entries;

  return entries.slice(firstIdx).filter((e) => !e.runId || e.runId === latestRunId);
}

export function createDebugRecorder(limits = DEBUG_LIMITS, flightLimits = FLIGHT_LIMITS) {
  let entries: DebugEntry[] = [];
  let size = 0;
  let flightEntries: DebugEntry[] = [];
  let flightSize = 0;
  let activeRunId: string | undefined;
  let activeRunKind: string | undefined;
  let flightSessionId: string = crypto.randomUUID();

  let state = {
    enabled: false,
    sessionId: '',
    count: 0,
    flightCount: 0,
    dropped: 0,
    flightDropped: 0,
    truncated: 0,
    activeRunId: undefined as string | undefined,
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const redact = (text: string, secrets: string[]) => {
    for (const secret of secrets.filter((s) => s.trim().length > 0)) {
      text = text.split(secret).join('[REDACTED]');
    }
    return text
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&](?:token|key|api_key|apiKey|access_token)=)[^&\s"]+/gi, '$1[REDACTED]');
  };

  const serializeSafe = (val: unknown, secrets: string[], entryCap: number) => {
    const json =
      JSON.stringify(val, (key, value) =>
        /^(authorization|gatewayToken|apiKey|api_key|access_token|password|secret)$/i.test(key)
          ? '[REDACTED]'
          : typeof value === 'string'
            ? redact(value, secrets)
            : value
      ) ?? 'null';
    const isTruncated = json.length > entryCap;
    return {
      data: isTruncated ? { preview: json.slice(0, entryCap) } : JSON.parse(json),
      truncated: isTruncated,
      originalChars: json.length,
    };
  };

  const getEntries = () => [...entries];
  const getFlightEntries = () => [...flightEntries];

  const getDiagnosticEntries = (options?: { scope?: DiagnosticsScope }): DebugEntry[] => {
    const base = entries.length > 0 ? entries : flightEntries;
    return [...selectEntriesForDiagnostics(base, options?.scope ?? 'latest_run')];
  };

  const exportAIDiagnostics = (
    scenarioText?: string,
    lastError?: string,
    options?: ExportAIDiagnosticsOptions
  ): string => {
    const targetEntries = getDiagnosticEntries({ scope: options?.scope ?? 'latest_run' });
    const pkg = buildAIDiagnostics({
      entries: targetEntries,
      scenarioText,
      lastError,
      profile: options?.profile ?? 'standard',
    });
    return formatAIDiagnosticsAsMarkdown(pkg);
  };

  const exportText = (options?: ExportTextOptions): string => {
    const {
      compact = false,
      deduplicate = false,
      includeDiagnostics = true,
      scenarioText,
      lastError,
      profile = 'standard',
      scope = 'latest_run',
    } = options ?? {};

    const baseEntries = entries.length > 0 ? entries : flightEntries;
    let processedEntries = baseEntries;
    const sharedContext: Record<string, string> = {};

    let targetScenario = scenarioText;
    if (!targetScenario) {
      for (const e of baseEntries) {
        if (e.stage === 'recording.start') {
          const d = e.data as { scenarioText?: string } | null;
          if (d?.scenarioText) {
            targetScenario = d.scenarioText;
            break;
          }
        }
      }
    }

    if (deduplicate && targetScenario && targetScenario.length > 200) {
      sharedContext.scenario = targetScenario;
      processedEntries = baseEntries.map((entry) => {
        if (entry.stage === 'llm.request' || entry.stage === 'recording.start') {
          try {
            const rawJson = JSON.stringify(entry.data);
            if (rawJson.includes(targetScenario)) {
              const deduplicatedJson = rawJson
                .split(targetScenario)
                .join('[REF:sharedContext.scenario]');
              return {
                ...entry,
                data: JSON.parse(deduplicatedJson),
              };
            }
          } catch {
            return entry;
          }
        }
        return entry;
      });
    }

    let aiDiagnostics: AIDiagnosticsPackage | undefined;
    const diagSource = selectEntriesForDiagnostics(baseEntries, scope);
    if (includeDiagnostics && diagSource.length > 0) {
      try {
        aiDiagnostics = buildAIDiagnostics({
          entries: diagSource,
          scenarioText: targetScenario,
          lastError,
          profile,
        });
      } catch {
        /* Diagnostics build must never fail export */
      }
    }

    const payload: {
      format: string;
      exportedAt: string;
      tier: 'full' | 'flight_recorder';
      state: typeof state;
      limits: typeof limits;
      aiDiagnostics?: AIDiagnosticsPackage;
      sharedContext?: Record<string, string>;
      entries: DebugEntry[];
    } = {
      format: 'failureprism-vta-debug-1',
      exportedAt: new Date().toISOString(),
      tier: entries.length > 0 ? 'full' : 'flight_recorder',
      state,
      limits,
      ...(aiDiagnostics ? { aiDiagnostics } : {}),
      ...(Object.keys(sharedContext).length > 0 ? { sharedContext } : {}),
      entries: processedEntries,
    };

    return JSON.stringify(payload, null, compact ? 0 : 2);
  };

  const recordInternal = (
    stage: string,
    data: () => unknown,
    sessionId?: string,
    secrets: string[] = []
  ) => {
    if (sessionId !== undefined && (!state.enabled || sessionId !== state.sessionId)) return;
    const wantsFlight =
      sessionId === undefined &&
      flightLimits.entries > 0 &&
      flightLimits.totalChars > 0 &&
      FLIGHT_RECORDER_STAGES.has(stage);
    if (!state.enabled && !wantsFlight) return;
    try {
      const rawValue = data();
      const nowIso = new Date().toISOString();
      let changed = false;

      // 1. Tier 1: Always-On Lightweight Flight Recorder
      const compacted = compactForFlightRecorder(stage, rawValue);
      if (!compacted.skip && flightLimits.entries > 0 && flightLimits.totalChars > 0) {
        const flightSafe = serializeSafe(compacted.value, secrets, flightLimits.entryChars);
        const fEntry: DebugEntry = {
          time: nowIso,
          sessionId: state.enabled && state.sessionId ? state.sessionId : flightSessionId,
          ...(activeRunId ? { runId: activeRunId } : {}),
          stage,
          data: flightSafe.data,
          truncated: flightSafe.truncated,
          originalChars: flightSafe.originalChars,
        };
        const fCost = JSON.stringify(fEntry).length;
        let flightDropped = state.flightDropped;
        if (fCost <= flightLimits.totalChars) {
          while (
            flightEntries.length &&
            (flightEntries.length >= flightLimits.entries || flightSize + fCost > flightLimits.totalChars)
          ) {
            flightSize -= JSON.stringify(flightEntries.shift()!).length;
            flightDropped++;
          }
          flightEntries.push(fEntry);
          flightSize += fCost;
          changed = true;
        }
        if (flightDropped !== state.flightDropped) {
          state = { ...state, flightDropped };
        }
      }

      // 2. Tier 2: Opt-In Full Debug Recorder
      if (state.enabled) {
        const fullSafe = serializeSafe(rawValue, secrets, limits.entryChars);
        const entry: DebugEntry = {
          time: nowIso,
          sessionId: state.sessionId,
          ...(activeRunId ? { runId: activeRunId } : {}),
          stage,
          data: fullSafe.data,
          truncated: fullSafe.truncated,
          originalChars: fullSafe.originalChars,
        };
        const cost = JSON.stringify(entry).length;
        let dropped = state.dropped;
        while (entries.length && (entries.length >= limits.entries || size + cost > limits.totalChars)) {
          size -= JSON.stringify(entries.shift()!).length;
          dropped++;
        }
        if (cost > limits.totalChars) {
          state = {
            ...state,
            flightCount: flightEntries.length,
            dropped: dropped + 1,
          };
          notify();
          return;
        }
        entries.push(entry);
        size += cost;
        state = {
          ...state,
          count: entries.length,
          flightCount: flightEntries.length,
          dropped,
          truncated: state.truncated + Number(fullSafe.truncated),
        };
        notify();
        return;
      }

      if (changed && state.flightCount !== flightEntries.length) {
        state = {
          ...state,
          flightCount: flightEntries.length,
        };
        notify();
      }
    } catch {
      /* Diagnostics must never interrupt the operation being diagnosed. */
    }
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    getEntries,
    getFlightEntries,
    getDiagnosticEntries,
    setEnabled(enabled: boolean) {
      if (state.enabled === enabled) return;
      state = {
        ...state,
        enabled,
        sessionId: enabled ? crypto.randomUUID() : state.sessionId,
      };
      notify();
    },
    clear() {
      entries = [];
      size = 0;
      flightEntries = [];
      flightSize = 0;
      activeRunId = undefined;
      activeRunKind = undefined;
      flightSessionId = crypto.randomUUID();
      state = {
        ...state,
        sessionId: state.enabled ? crypto.randomUUID() : '',
        count: 0,
        flightCount: 0,
        dropped: 0,
        flightDropped: 0,
        truncated: 0,
        activeRunId: undefined,
      };
      notify();
    },
    startRun(kind: string, secrets: string[] = []): string {
      const runId = `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      activeRunId = runId;
      activeRunKind = kind;
      state = { ...state, activeRunId: runId };
      recordInternal('pipeline.run_start', () => ({ runId, kind }), undefined, secrets);
      return runId;
    },
    endRun(
      runId?: string,
      status: 'completed' | 'failed' | 'cancelled' = 'completed',
      secrets: string[] = []
    ) {
      if (!activeRunId) return;
      if (runId && activeRunId !== runId) return;
      const closingId = activeRunId;
      const closingKind = activeRunKind;
      recordInternal(
        'pipeline.run_end',
        () => ({ runId: closingId, ...(closingKind ? { kind: closingKind } : {}), status }),
        undefined,
        secrets
      );
      activeRunId = undefined;
      activeRunKind = undefined;
      state = { ...state, activeRunId: undefined };
      notify();
    },
    record: recordInternal,
    recordEvent<K extends keyof DiagnosticEventMap>(
      stage: K,
      data: () => DiagnosticEventMap[K],
      secrets: string[] = []
    ) {
      recordInternal(stage, data, undefined, secrets);
    },
    exportText,
    exportAIDiagnostics,
  };
}

export const debugRecorder = createDebugRecorder();
