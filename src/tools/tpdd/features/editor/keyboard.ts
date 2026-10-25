export function isCanvasTextEntryTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) return true;
  if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return true;
  if (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) return true;
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && target.isContentEditable;
}
