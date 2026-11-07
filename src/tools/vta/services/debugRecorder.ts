/** Opt-in, memory-only diagnostics. Nothing is written or uploaded automatically. */
import { buildAIDiagnostics, formatAIDiagnosticsAsMarkdown, type AIDiagnosticsPackage } from './diagnostics/aiDiagnostics';

export const DEBUG_LIMITS = { entries: 500, totalChars: 10_000_000, entryChars: 1_000_000 };
export type DebugEntry = { time: string; sessionId: string; stage: string; data: unknown; truncated: boolean; originalChars: number };

export interface ExportTextOptions {
  compact?: boolean;
  deduplicate?: boolean;
  includeDiagnostics?: boolean;
  scenarioText?: string;
  lastError?: string;
}

export function createDebugRecorder(limits = DEBUG_LIMITS) {
  let entries: DebugEntry[] = [], size = 0;
  let state = { enabled: false, sessionId: '', count: 0, dropped: 0, truncated: 0 };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };

  const redact = (text: string, secrets: string[]) => {
    for (const secret of secrets.filter(s => s.trim().length > 0)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&](?:token|key|api_key|apiKey|access_token)=)[^&\s"]+/gi, '$1[REDACTED]');
  };

  const getEntries = () => [...entries];

  const exportAIDiagnostics = (scenarioText?: string, lastError?: string): string => {
    const pkg = buildAIDiagnostics({ entries, scenarioText, lastError });
    return formatAIDiagnosticsAsMarkdown(pkg);
  };

  const exportText = (options?: ExportTextOptions): string => {
    const {
      compact = false,
      deduplicate = false,
      includeDiagnostics = true,
      scenarioText,
      lastError,
    } = options ?? {};

    let processedEntries = entries;
    const sharedContext: Record<string, string> = {};

    // Find scenarioText from options or from recording.start
    let targetScenario = scenarioText;
    if (!targetScenario) {
      for (const e of entries) {
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
      // Process entries to replace duplicate scenario occurrences in requests
      processedEntries = entries.map((entry) => {
        if (entry.stage === 'llm.request' || entry.stage === 'recording.start') {
          try {
            const rawJson = JSON.stringify(entry.data);
            if (rawJson.includes(targetScenario)) {
              const deduplicatedJson = rawJson.split(targetScenario).join('[REF:sharedContext.scenario]');
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
    if (includeDiagnostics && entries.length > 0) {
      try {
        aiDiagnostics = buildAIDiagnostics({ entries, scenarioText: targetScenario, lastError });
      } catch {
        /* Diagnostics build must never fail export */
      }
    }

    const payload: {
      format: string;
      exportedAt: string;
      state: typeof state;
      limits: typeof limits;
      aiDiagnostics?: AIDiagnosticsPackage;
      sharedContext?: Record<string, string>;
      entries: DebugEntry[];
    } = {
      format: 'failureprism-vta-debug-1',
      exportedAt: new Date().toISOString(),
      state,
      limits,
      ...(aiDiagnostics ? { aiDiagnostics } : {}),
      ...(Object.keys(sharedContext).length > 0 ? { sharedContext } : {}),
      entries: processedEntries,
    };

    return JSON.stringify(payload, null, compact ? 0 : 2);
  };

  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    getEntries,
    setEnabled(enabled: boolean) {
      if (state.enabled === enabled) return;
      state = { ...state, enabled, sessionId: enabled ? crypto.randomUUID() : state.sessionId }; notify();
    },
    clear() { entries = []; size = 0; state = { ...state, sessionId: state.enabled ? crypto.randomUUID() : '', count: 0, dropped: 0, truncated: 0 }; notify(); },
    record(stage: string, data: () => unknown, sessionId?: string, secrets: string[] = []) {
      if (!state.enabled || sessionId !== undefined && sessionId !== state.sessionId) return;
      try {
        const json = JSON.stringify(data(), (key, value) => /^(authorization|gatewayToken|apiKey|api_key|access_token|password|secret)$/i.test(key) ? '[REDACTED]' : typeof value === 'string' ? redact(value, secrets) : value) ?? 'null';
        const safe = json, truncated = safe.length > limits.entryChars;
        const entry: DebugEntry = { time: new Date().toISOString(), sessionId: state.sessionId, stage, data: truncated ? { preview: safe.slice(0, limits.entryChars) } : JSON.parse(safe), truncated, originalChars: safe.length };
        const cost = JSON.stringify(entry).length;
        let dropped = state.dropped;
        while (entries.length && (entries.length >= limits.entries || size + cost > limits.totalChars)) { size -= JSON.stringify(entries.shift()!).length; dropped++; }
        if (cost > limits.totalChars) { state = { ...state, dropped: dropped + 1 }; notify(); return; }
        entries.push(entry); size += cost;
        state = { ...state, count: entries.length, dropped, truncated: state.truncated + Number(truncated) }; notify();
      } catch { /* Diagnostics must never interrupt the operation being diagnosed. */ }
    },
    exportText,
    exportAIDiagnostics,
  };
}

export const debugRecorder = createDebugRecorder();
