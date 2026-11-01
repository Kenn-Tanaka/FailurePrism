import type { GenerationOperationMode } from '../../../types/vta';

interface CapturedProgressFocus {
  element: HTMLElement | null;
  focusId: string | null;
  dialogLabelledBy: string | null;
}

let capturedFocus: CapturedProgressFocus | null = null;
let pendingRestoreTimer: ReturnType<typeof setTimeout> | null = null;

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

function checkOperable(
  el: Element | null | undefined,
  allowOverlay: boolean
): el is HTMLElement {
  if (!el || typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) {
    return false;
  }
  if (!el.isConnected) return false;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
    return false;
  }
  if (el.closest('[hidden], [aria-hidden="true"]')) {
    return false;
  }
  if (!allowOverlay && el.closest('[data-vta-progress-overlay="true"]')) {
    return false;
  }
  return true;
}

export function isOperableElement(el: Element | null | undefined): el is HTMLElement {
  return checkOperable(el, false);
}

export function getFocusableElements(container: ParentNode | null | undefined): HTMLElement[] {
  if (!container) return [];
  const allowOverlay =
    'closest' in container &&
    typeof container.closest === 'function' &&
    Boolean(container.closest('[data-vta-progress-overlay="true"]'));
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) =>
    checkOperable(el, allowOverlay)
  );
}

/**
 * Capture the currently focused element before an LLM operation begins.
 * Safe to call multiple times during operation startup; keeps the first valid pre-overlay target.
 */
export function capturePreProgressFocus(): void {
  if (typeof document === 'undefined') return;
  if (pendingRestoreTimer) {
    clearTimeout(pendingRestoreTimer);
    pendingRestoreTimer = null;
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active && active.closest('[data-vta-progress-overlay="true"]')) {
    return;
  }
  if (capturedFocus?.element && capturedFocus.element.isConnected && (!active || active === document.body)) {
    return;
  }
  if (active && active !== document.body) {
    capturedFocus = {
      element: active,
      focusId: active.getAttribute('data-vta-focus-id'),
      dialogLabelledBy: active.closest('[role="dialog"]')?.getAttribute('aria-labelledby') ?? null,
    };
  } else if (!capturedFocus) {
    const openDialogs = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"]:not([data-vta-progress-overlay="true"])')
    );
    const topDialog = openDialogs[openDialogs.length - 1] ?? null;
    capturedFocus = {
      element: null,
      focusId: null,
      dialogLabelledBy: topDialog?.getAttribute('aria-labelledby') ?? null,
    };
  }
}

export function clearPreProgressFocus(): void {
  if (pendingRestoreTimer) {
    clearTimeout(pendingRestoreTimer);
    pendingRestoreTimer = null;
  }
  capturedFocus = null;
}

function findPrimaryTarget(snapshot: CapturedProgressFocus | null): HTMLElement | null {
  if (!snapshot || typeof document === 'undefined') return null;
  if (isOperableElement(snapshot.element)) {
    return snapshot.element;
  }
  if (snapshot.focusId) {
    const byId = document.querySelector<HTMLElement>(`[data-vta-focus-id="${snapshot.focusId}"]`);
    if (isOperableElement(byId)) return byId;
  }
  return null;
}

function findFallbackTarget(
  snapshot: CapturedProgressFocus | null,
  mode: GenerationOperationMode | null
): HTMLElement | null {
  if (typeof document === 'undefined') return null;

  const queryOperable = (selector: string): HTMLElement | null => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
    return candidates.find(isOperableElement) ?? null;
  };

  // 1. If triggered inside a specific modal dialog that is still open, keep focus inside that dialog
  if (snapshot?.dialogLabelledBy) {
    const dialog = document.querySelector<HTMLElement>(
      `[role="dialog"][aria-labelledby="${snapshot.dialogLabelledBy}"]`
    );
    if (dialog && dialog.isConnected) {
      if (snapshot.focusId) {
        const triggerInDialog = dialog.querySelector<HTMLElement>(
          `[data-vta-focus-id="${snapshot.focusId}"]`
        );
        if (isOperableElement(triggerInDialog)) return triggerInDialog;
      }
      const focusable = getFocusableElements(dialog);
      if (focusable.length > 0) return focusable[0];
      if (isOperableElement(dialog)) return dialog;
    }
  }

  // 2. Mode-specific fallbacks
  const modeSelectors: Record<GenerationOperationMode, string[]> = {
    extract: [
      '[data-vta-focus-id="extract-trigger"]',
      '[data-vta-focus-id="review-confirm"]',
    ],
    classify: [
      '[data-vta-focus-id="classify-trigger"]',
      '[data-vta-focus-id="review-current-trigger"]',
      '[data-vta-focus-id="extract-trigger"]',
    ],
    restore_passage: [
      '[data-vta-focus-id^="restore-passage-"]',
      '[data-vta-focus-id="review-confirm"]',
      '[data-vta-focus-id="extract-trigger"]',
    ],
    propose_connections: [
      '[data-vta-focus-id="propose-connections-trigger"]',
      '[role="dialog"][aria-labelledby="connection-proposal-title"] input:not(:disabled)',
      '[role="dialog"][aria-labelledby="connection-proposal-title"] button:not(:disabled)',
      '[data-vta-focus-id="propose-connections-close"]',
    ],
    repair_chains: [
      '[data-vta-focus-id="repair-chains-trigger"]',
      '[role="dialog"][aria-labelledby="chain-repair-title"] input:not(:disabled)',
      '[role="dialog"][aria-labelledby="chain-repair-title"] button:not(:disabled)',
    ],
    propose_measures: [
      '[data-vta-focus-id="propose-measures-retry"]',
      '[data-vta-focus-id="propose-measures-trigger"]',
      '[role="dialog"][aria-labelledby="ai-measures-modal-title"] input:not(:disabled)',
      '[role="dialog"][aria-labelledby="ai-measures-modal-title"] button:not(:disabled)',
      '[data-vta-focus-id="propose-measures-close"]',
    ],
    regenerate: [
      '[data-vta-focus-id="regenerate-trigger"]',
      '[data-vta-focus-id="extract-trigger"]',
    ],
    auto_connect: [
      '[data-vta-focus-id="extract-trigger"]',
    ],
    reoptimize: [
      '[data-vta-focus-id="extract-trigger"]',
    ],
  };

  if (mode && modeSelectors[mode]) {
    for (const selector of modeSelectors[mode]) {
      const match = queryOperable(selector);
      if (match) return match;
    }
  }

  // 3. Any topmost open modal dialog
  const openDialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"]:not([data-vta-progress-overlay="true"])')
  );
  const topDialog = openDialogs[openDialogs.length - 1];
  if (topDialog) {
    const focusable = getFocusableElements(topDialog);
    if (focusable.length > 0) return focusable[0];
    if (isOperableElement(topDialog)) return topDialog;
  }

  // 4. General control panel fallback
  return (
    queryOperable('[data-vta-focus-id="extract-trigger"]') ??
    queryOperable('[data-vta-focus-id="regenerate-trigger"]')
  );
}

/**
 * Restore focus after the progress overlay closes.
 * Focuses the primary target immediately if operable; otherwise focuses the best available
 * fallback immediately and upgrades to the primary target on the next tick if an async
 * `finally` block re-enables or re-mounts the original trigger.
 */
export function restorePostProgressFocus(mode: GenerationOperationMode | null): void {
  if (typeof document === 'undefined') return;
  const snapshot = capturedFocus;
  capturedFocus = null;

  if (pendingRestoreTimer) {
    clearTimeout(pendingRestoreTimer);
    pendingRestoreTimer = null;
  }

  const primaryNow = findPrimaryTarget(snapshot);
  if (primaryNow) {
    primaryNow.focus();
    return;
  }

  const fallbackNow = findFallbackTarget(snapshot, mode);
  if (fallbackNow) {
    fallbackNow.focus();
  }

  const attemptUpgrade = () => {
    const currentActive = document.activeElement as HTMLElement | null;
    const userMovedFocusElsewhere =
      Boolean(currentActive) &&
      currentActive !== document.body &&
      currentActive !== fallbackNow &&
      !currentActive?.closest('[data-vta-progress-overlay="true"]');
    if (userMovedFocusElsewhere) return;

    const primaryLater = findPrimaryTarget(snapshot);
    if (primaryLater) {
      primaryLater.focus();
      return;
    }
    if (!currentActive || currentActive === document.body || !isOperableElement(currentActive)) {
      const fallbackLater = findFallbackTarget(snapshot, mode);
      if (fallbackLater) fallbackLater.focus();
    }
  };

  queueMicrotask(attemptUpgrade);
  pendingRestoreTimer = setTimeout(() => {
    pendingRestoreTimer = null;
    attemptUpgrade();
  }, 0);
}
