import { useSyncExternalStore } from 'react';

export type UITheme = 'light' | 'dark';

export const DEFAULT_UI_THEME: UITheme = 'light';
export const UI_THEME_STORAGE_KEY = 'failureprism_ui_theme';

const memoryFallback = new Map<string, string>();

function readStoredThemeSync(): UITheme | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const val = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
      if (val === 'light' || val === 'dark') return val;
    }
  } catch {
    // Ignore storage access errors in restricted contexts
  }
  const mem = memoryFallback.get(UI_THEME_STORAGE_KEY);
  return mem === 'light' || mem === 'dark' ? mem : null;
}

function writeStoredThemeSync(theme: UITheme): void {
  memoryFallback.set(UI_THEME_STORAGE_KEY, theme);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
    }
  } catch {
    // Ignore storage quota / sandbox errors
  }
}

function applyThemeToDOM(theme: UITheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

let currentTheme: UITheme = readStoredThemeSync() ?? DEFAULT_UI_THEME;
let userChangedInSession = false;
const listeners = new Set<() => void>();

applyThemeToDOM(currentTheme);

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== UI_THEME_STORAGE_KEY) return;
    if (event.newValue === 'light' || event.newValue === 'dark') {
      if (currentTheme !== event.newValue) {
        currentTheme = event.newValue;
        applyThemeToDOM(currentTheme);
        emitChange();
      }
    }
  });
}

export function getUITheme(): UITheme {
  return currentTheme;
}

export function subscribeUITheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setUITheme(
  nextTheme: UITheme,
  options: { syncServer?: boolean; markUserInitiated?: boolean } = {}
): void {
  const normalized: UITheme = nextTheme === 'dark' ? 'dark' : 'light';
  const syncServer = options.syncServer ?? true;
  if (options.markUserInitiated ?? true) {
    userChangedInSession = true;
  }

  const changed = currentTheme !== normalized;
  currentTheme = normalized;
  writeStoredThemeSync(normalized);
  applyThemeToDOM(normalized);
  if (changed) {
    emitChange();
  }

  if (syncServer && typeof fetch === 'function') {
    void fetch('/api/ui-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: normalized }),
    }).catch(() => {
      // Static-only hosting or unit tests without server endpoint safely rely on localStorage
    });
  }
}

export function toggleUITheme(): UITheme {
  const next: UITheme = currentTheme === 'light' ? 'dark' : 'light';
  setUITheme(next);
  return next;
}

/**
 * Hydrates persisted UI theme from local server `.runtime/ui-preferences.json`
 * so theme selection persists even across port changes or browser changes (`--select-browser`).
 */
export async function hydrateUIThemeFromServer(): Promise<UITheme> {
  if (typeof fetch !== 'function') return currentTheme;
  try {
    const res = await fetch('/api/ui-preferences', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return currentTheme;
    const data = (await res.json()) as { theme?: unknown; persisted?: unknown };
    if (
      !userChangedInSession &&
      data?.persisted === true &&
      (data.theme === 'light' || data.theme === 'dark')
    ) {
      setUITheme(data.theme, { syncServer: false, markUserInitiated: false });
    } else if (!data?.persisted) {
      const localSaved = readStoredThemeSync();
      if (localSaved && (localSaved === 'light' || localSaved === 'dark')) {
        // Backfill server file if localStorage already has an explicit preference
        setUITheme(localSaved, { syncServer: true, markUserInitiated: false });
      }
    }
  } catch {
    // Ignore network errors when running in isolated static / test environments
  }
  return currentTheme;
}

export function useUITheme(): {
  theme: UITheme;
  isLight: boolean;
  setTheme: (theme: UITheme) => void;
  toggleTheme: () => UITheme;
} {
  const theme = useSyncExternalStore(subscribeUITheme, getUITheme, () => DEFAULT_UI_THEME);
  return {
    theme,
    isLight: theme === 'light',
    setTheme: (next: UITheme) => setUITheme(next),
    toggleTheme: toggleUITheme,
  };
}

export function resetUIThemeForTests(initialTheme: UITheme = DEFAULT_UI_THEME, clearStorage = true): void {
  userChangedInSession = false;
  if (clearStorage) {
    memoryFallback.delete(UI_THEME_STORAGE_KEY);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(UI_THEME_STORAGE_KEY);
      }
    } catch {
      // Ignore
    }
  }
  currentTheme = initialTheme;
  applyThemeToDOM(currentTheme);
  emitChange();
}
