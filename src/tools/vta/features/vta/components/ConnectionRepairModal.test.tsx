import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionRepairModal } from './ConnectionRepairModal';
import { createConnectionRepairPlan } from '../utils/connectionRepairPlan';
import { calculateVTALayout } from '../utils/layout';
import type { VTASchema } from '../../../types/vta';

describe('ConnectionRepairModal', () => {
  it('shows removed annotations and gives the user an explicit apply control', () => {
    const schema: VTASchema = {
      lanes: ['担当'],
      nodes: ['a', 'b', 'c'].map((id, index) => ({ id, lane: '担当', title: id, time: '', description: '', type: 'normal', measure_type: null, position: { x: 100, y: 900 - index * 300 } })),
      edges: [{ source: 'a', target: 'c', label: '削除されるラベル', category: 'impact', is_break: true }],
    };
    const plan = createConnectionRepairPlan(schema, calculateVTALayout(schema).nodes);
    const html = renderToStaticMarkup(<ConnectionRepairModal plan={plan} onApply={() => {}} onClose={() => {}} />);
    expect(html).toContain('削除されるラベル');
    expect(html).toContain('物理的影響・波及');
    expect(html).toContain('BREAKあり');
    expect(html).toContain('他の線には引き継ぎません');
    expect(html).toContain('修正を適用');
    expect(html).not.toContain('disabled=""');
  });

  it('disables apply when repair is unnecessary or positions are ambiguous', () => {
    const plan = createConnectionRepairPlan({ lanes: [], nodes: [], edges: [] }, []);
    const render = (issues: string[]) => renderToStaticMarkup(<ConnectionRepairModal plan={{ ...plan, issues }} onApply={() => {}} onClose={() => {}} />);
    expect(render([])).toContain('修正は不要です');
    expect(render([])).toContain('disabled=""');
    expect(render(['上下が重なっています'])).toContain('上下が重なっています');
    expect(render(['上下が重なっています'])).toContain('disabled=""');
  });
});
