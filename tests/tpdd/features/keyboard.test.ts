import { describe, expect, it, vi } from 'vitest';
import { isCanvasTextEntryTarget } from '../../../src/tools/tpdd/features/editor/keyboard';

describe('Canvas keyboard input guards', () => {
  it('treats a focused select as a text-entry target', () => {
    class FakeSelect {}
    vi.stubGlobal('HTMLSelectElement', FakeSelect);
    try {
      expect(isCanvasTextEntryTarget(new FakeSelect() as unknown as EventTarget)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
