import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  capturePreProgressFocus,
  clearPreProgressFocus,
  getFocusableElements,
  isOperableElement,
  restorePostProgressFocus,
} from './progressFocus';
import type { GenerationOperationMode } from '../../../types/vta';

class MockElement {
  tagName = 'BUTTON';
  isConnected = true;
  disabled = false;
  tabIndex = 0;
  attributes = new Map<string, string>();
  parent: MockElement | null = null;
  children: MockElement[] = [];
  focus = vi.fn(() => {
    if (!this.disabled && this.isConnected) {
      (globalThis.document as unknown as { activeElement: MockElement | null }).activeElement = this;
    }
  });

  constructor(attrs: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(attrs)) {
      this.attributes.set(k, v);
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    if (name === 'disabled') return this.disabled || this.attributes.has('disabled');
    return this.attributes.has(name);
  }

  closest(selector: string): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (selector.includes('[data-vta-progress-overlay="true"]') && cur.getAttribute('data-vta-progress-overlay') === 'true') {
        return cur;
      }
      if (selector.includes('[hidden]') && cur.hasAttribute('hidden')) {
        return cur;
      }
      if (selector.includes('[aria-hidden="true"]') && cur.getAttribute('aria-hidden') === 'true') {
        return cur;
      }
      if (selector === '[role="dialog"]' && cur.getAttribute('role') === 'dialog') {
        return cur;
      }
      cur = cur.parent;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    return this.children.filter((c) => matchesSelector(c, selector));
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchesSelector(el: MockElement, selector: string): boolean {
  const focusIdMatch = selector.match(/^\[data-vta-focus-id="([^"]+)"\]$/);
  if (focusIdMatch) {
    return el.getAttribute('data-vta-focus-id') === focusIdMatch[1];
  }
  const focusPrefixMatch = selector.match(/^\[data-vta-focus-id\^="([^"]+)"\]$/);
  if (focusPrefixMatch) {
    return (el.getAttribute('data-vta-focus-id') ?? '').startsWith(focusPrefixMatch[1]);
  }
  const dialogLabelMatch = selector.match(/^\[role="dialog"\]\[aria-labelledby="([^"]+)"\]$/);
  if (dialogLabelMatch) {
    return el.getAttribute('role') === 'dialog' && el.getAttribute('aria-labelledby') === dialogLabelMatch[1];
  }
  if (selector.includes('button:not(:disabled)')) {
    return !el.disabled && !el.hasAttribute('disabled');
  }
  return false;
}

describe('progressFocus utility', () => {
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  let elements: MockElement[] = [];
  let bodyEl: MockElement;

  beforeEach(() => {
    elements = [];
    bodyEl = new MockElement();
    (globalThis as unknown as { HTMLElement: typeof MockElement }).HTMLElement = MockElement;
    (globalThis as unknown as { document: Record<string, unknown> }).document = {
      body: bodyEl,
      activeElement: bodyEl,
      querySelectorAll: (selector: string) => elements.filter((el) => matchesSelector(el, selector)),
      querySelector: (selector: string) => elements.find((el) => matchesSelector(el, selector)) ?? null,
    };
    clearPreProgressFocus();
  });

  afterEach(() => {
    clearPreProgressFocus();
    globalThis.document = originalDocument;
    globalThis.HTMLElement = originalHTMLElement;
  });

  it('restores focus directly to the original trigger element when it stays connected and enabled', () => {
    const trigger = new MockElement({ 'data-vta-focus-id': 'repair-chains-trigger' });
    elements.push(trigger);
    trigger.focus();

    capturePreProgressFocus();
    // Simulate progress overlay stealing focus
    const cancelBtn = new MockElement({ 'data-vta-progress-overlay': 'true' });
    cancelBtn.focus();

    restorePostProgressFocus('repair_chains');
    expect(document.activeElement).toBe(trigger);
  });

  it('upgrades focus to the original trigger on microtask when it is re-enabled in an async finally block', async () => {
    const dialog = new MockElement({ role: 'dialog', 'aria-labelledby': 'chain-repair-title' });
    const closeBtn = new MockElement();
    const trigger = new MockElement({ 'data-vta-focus-id': 'repair-chains-trigger' });
    trigger.parent = dialog;
    closeBtn.parent = dialog;
    dialog.children = [closeBtn, trigger];
    elements.push(dialog, closeBtn, trigger);

    trigger.focus();
    capturePreProgressFocus();

    // Trigger is temporarily disabled when cancelCurrentOperation runs synchronously
    trigger.disabled = true;
    (document as unknown as { activeElement: MockElement }).activeElement = bodyEl;

    restorePostProgressFocus('repair_chains');
    // Immediate fallback focuses closeBtn inside the dialog so activeElement is never left on body
    expect(document.activeElement).toBe(closeBtn);

    // Async finally block re-enables trigger
    trigger.disabled = false;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Focus automatically upgrades to the re-enabled trigger button
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to re-mounted trigger or mode-specific fallback across all 7 operation modes', () => {
    const modes: Array<{ mode: GenerationOperationMode; fallbackFocusId: string }> = [
      { mode: 'extract', fallbackFocusId: 'review-confirm' },
      { mode: 'classify', fallbackFocusId: 'review-current-trigger' },
      { mode: 'restore_passage', fallbackFocusId: 'restore-passage-d2' },
      { mode: 'propose_connections', fallbackFocusId: 'propose-connections-close' },
      { mode: 'repair_chains', fallbackFocusId: 'repair-chains-trigger' },
      { mode: 'propose_measures', fallbackFocusId: 'propose-measures-retry' },
      { mode: 'regenerate', fallbackFocusId: 'regenerate-trigger' },
    ];

    for (const { mode, fallbackFocusId } of modes) {
      elements = [];
      const oldTrigger = new MockElement({ 'data-vta-focus-id': `old-${mode}` });
      elements.push(oldTrigger);
      oldTrigger.focus();
      capturePreProgressFocus();

      // Unmount old trigger and mount new fallback control
      oldTrigger.isConnected = false;
      const fallback = new MockElement({ 'data-vta-focus-id': fallbackFocusId });
      elements.push(fallback);
      (document as unknown as { activeElement: MockElement }).activeElement = bodyEl;

      restorePostProgressFocus(mode);
      expect(document.activeElement).toBe(fallback);
    }
  });

  it('filters out disabled or hidden elements in isOperableElement and getFocusableElements', () => {
    const container = new MockElement();
    const enabledBtn = new MockElement();
    const disabledBtn = new MockElement();
    disabledBtn.disabled = true;
    const hiddenBtn = new MockElement({ hidden: 'true' });
    container.children = [enabledBtn, disabledBtn, hiddenBtn];

    expect(isOperableElement(enabledBtn as unknown as Element)).toBe(true);
    expect(isOperableElement(disabledBtn as unknown as Element)).toBe(false);
    expect(isOperableElement(hiddenBtn as unknown as Element)).toBe(false);
    expect(getFocusableElements(container as unknown as ParentNode)).toEqual([enabledBtn]);

    const overlayDialog = new MockElement({ 'data-vta-progress-overlay': 'true' });
    const cancelBtn = new MockElement({ 'data-vta-focus-id': 'progress-cancel' });
    cancelBtn.parent = overlayDialog;
    overlayDialog.children = [cancelBtn];
    expect(isOperableElement(cancelBtn as unknown as Element)).toBe(false);
    expect(getFocusableElements(overlayDialog as unknown as ParentNode)).toEqual([cancelBtn]);
  });
});
