import { ToolManifest } from './types';

export const RESERVED_TOOL_IDS = new Set(['menu', 'home']);
export const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export interface RawManifestModule {
  manifest?: ToolManifest;
  default?: ToolManifest;
}

export interface ToolRegistryResult {
  tools: ToolManifest[];
  toolMap: Map<string, ToolManifest>;
  errors: string[];
}

/**
 * マニフェストモジュール群から検証済みのツールレジストリを構築する純粋関数
 * - 単体テストから任意の仮想ツールマップを渡して検証可能
 */
export function createToolRegistry(
  modulesMap: Record<string, RawManifestModule>
): ToolRegistryResult {
  const validTools: ToolManifest[] = [];
  const toolMap = new Map<string, ToolManifest>();
  const errors: string[] = [];

  for (const [modulePath, mod] of Object.entries(modulesMap)) {
    const manifest = mod?.manifest ?? mod?.default;
    if (!manifest || typeof manifest !== 'object') {
      errors.push(`[ToolLoader] ${modulePath}: 'manifest' export is missing or invalid.`);
      continue;
    }

    const rawId = typeof manifest.id === 'string' ? manifest.id.trim().toLowerCase() : '';
    if (!rawId || !TOOL_ID_PATTERN.test(rawId)) {
      errors.push(
        `[ToolLoader] ${modulePath}: Invalid tool id '${manifest.id}'. Must match /^[a-z0-9][a-z0-9-_]*$/.`
      );
      continue;
    }

    if (RESERVED_TOOL_IDS.has(rawId)) {
      errors.push(
        `[ToolLoader] ${modulePath}: Tool id '${rawId}' is reserved by the shell ('menu', 'home').`
      );
      continue;
    }

    if (toolMap.has(rawId)) {
      errors.push(`[ToolLoader] ${modulePath}: Duplicate tool id '${rawId}' ignored.`);
      continue;
    }

    if (!manifest.title || !manifest.shortTitle || typeof manifest.component !== 'function') {
      errors.push(
        `[ToolLoader] ${modulePath}: Tool '${rawId}' is missing required fields (title, shortTitle, or component).`
      );
      continue;
    }

    const normalizedManifest: ToolManifest = {
      ...manifest,
      id: rawId,
    };

    validTools.push(normalizedManifest);
    toolMap.set(rawId, normalizedManifest);
  }

  validTools.sort((a, b) => {
    const orderA = a.order ?? 99;
    const orderB = b.order ?? 99;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.id.localeCompare(b.id);
  });

  return {
    tools: validTools,
    toolMap,
    errors,
  };
}

// Vite の import.meta.glob により src/tools/*/manifest.tsx を自動ディスカバリ
const discoveredModules = import.meta.glob<RawManifestModule>('../tools/*/manifest.tsx', {
  eager: true,
});

const defaultRegistry = createToolRegistry(discoveredModules);

if (defaultRegistry.errors.length > 0) {
  for (const err of defaultRegistry.errors) {
    console.warn(err);
  }
}

export const installedTools: ToolManifest[] = defaultRegistry.tools;
export const installedToolMap: Map<string, ToolManifest> = defaultRegistry.toolMap;
