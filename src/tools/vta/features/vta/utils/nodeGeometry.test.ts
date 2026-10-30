import { describe, expect, it } from 'vitest';
import type { VTAReactFlowNode } from '../../../types/vta';
import { getDisplayRect, projectDisplayNode, unprojectDraggedPosition } from './nodeGeometry';

describe('nodeGeometry hidden node projection', () => {
  it('keeps hidden cards draggable and projects them at the card center', () => {
    const node = {
      id: 'hidden', type: 'vtaNode', position: { x: 100, y: 200 }, measured: { width: 260, height: 100 },
      data: { id: 'hidden', lane: 'A', time: '', title: 'hidden', description: '', type: 'normal', measure_type: null, is_hidden: true, measuredHeight: 100 },
    } as VTAReactFlowNode;
    const projected = projectDisplayNode(node);
    expect(projected.draggable).toBeUndefined();
    expect(projected.position).toEqual({ x: 220, y: 240 });
    expect(getDisplayRect(node)).toEqual({ x: 220, y: 240, width: 20, height: 20, isHidden: true });
  });

  it('converts the absolute projected position using the drag-start delta', () => {
    const raw = { id: 'n', type: 'vtaNode', position: { x: 100, y: 200 }, data: { is_hidden: true } } as VTAReactFlowNode;
    const projected = { ...raw, position: { x: 220, y: 240 } };
    expect(unprojectDraggedPosition(raw, projected, { x: 250, y: 280 })).toEqual({ x: 130, y: 240 });
  });
});
