/**
 * Yields execution briefly so the browser can paint pending React/DOM updates
 * (e.g., busy spinners or step progress overlays) before synchronous CPU work begins.
 */
export function yieldForPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
