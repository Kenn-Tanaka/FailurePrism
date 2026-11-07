import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildAnalysis,
  projectAnalysis,
  reconcileAnalysis,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import {
  shouldDisplayAsObjectJunction,
  projectDisplayNode,
} from '../../src/tools/vta/features/vta/utils/nodeGeometry';
import { VTAObjectJunctionNode } from '../../src/tools/vta/features/vta/components/VTAObjectJunctionNode';
import { LaneManagementPanel } from '../../src/tools/vta/components/control-panel/LaneManagementPanel';
import { generateVTASVG } from '../../src/tools/vta/features/vta/utils/svgExport';
import { ReactFlowProvider } from '@xyflow/react';
import type { VTAReactFlowNode, VTASchema } from '../../src/tools/vta/types/vta';

const prepareSharedEventScenario = () => {
  const source = sourceFromText('09:00 管制塔が機長へ離陸許可を出した。\n09:05 機長が復唱した。');
  const facts = validateFacts(
    {
      facts: [
        { id: 'f1', text: '管制塔が機長へ離陸許可を出した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 管制塔が機長へ離陸許可を出した。' }] },
        { id: 'f2', text: '機長が復唱した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 機長が復唱した。' }] },
      ],
    },
    [source]
  );
  const events = validateEvents(
    {
      events: [
        { id: 'e1', title: '離陸許可発出', description: '管制塔が機長へ離陸許可を出した', time: '09:00', factIds: ['f1'] },
        { id: 'e2', title: '復唱', description: '機長が復唱した', time: '09:05', factIds: ['f2'] },
      ],
    },
    facts
  );
  const parsed = validateParticipants(
    {
      entities: [
        { id: 'ent_tower', name: '管制塔', kind: 'person' },
        { id: 'ent_captain', name: '機長', kind: 'person' },
      ],
      participations: [
        // イベントe1は、管制塔が主体（actor）、機長が客体（target）
        { eventId: 'e1', entityId: 'ent_tower', role: 'actor', factIds: ['f1'] },
        { eventId: 'e1', entityId: 'ent_captain', role: 'target', factIds: ['f1'] },
        // イベントe2は機長が主体（actor）
        { eventId: 'e2', entityId: 'ent_captain', role: 'actor', factIds: ['f2'] },
      ],
      relations: [
        { id: 'r1', kind: 'transfer', sourceEventId: 'e1', sourceEntityId: 'ent_tower', targetEventId: 'e1', targetEntityId: 'ent_captain', factIds: ['f1'] },
      ],
      cardGroups: [],
    },
    events,
    facts
  );
  const analysis = buildAnalysis(source, facts, events, parsed);
  return projectAnalysis(analysis);
};

describe('Subject / Object Node Differentiation & Dot Display', () => {
  it('automatically projects entity_role as subject for actor and object for target', () => {
    const schema = prepareSharedEventScenario();

    const towerNode = schema.nodes.find((n) => n.lane === '管制塔' && n.event_ids?.includes('e1'));
    const captainObjectNode = schema.nodes.find((n) => n.lane === '機長' && n.event_ids?.includes('e1'));
    const captainActorNode = schema.nodes.find((n) => n.lane === '機長' && n.event_ids?.includes('e2'));

    expect(towerNode).toBeDefined();
    expect(captainObjectNode).toBeDefined();
    expect(captainActorNode).toBeDefined();

    // 管制塔のe1は能動主体（subject）
    expect(towerNode!.entity_role).toBe('subject');
    // 機長のe1は受動客体（object）
    expect(captainObjectNode!.entity_role).toBe('object');
    // 機長のe2は能動主体（subject）
    expect(captainActorNode!.entity_role).toBe('subject');
  });

  it('determines object junction display and projects to vtaObjectJunction node type', () => {
    const schema = prepareSharedEventScenario();
    const captainObjectNode = schema.nodes.find((n) => n.lane === '機長' && n.event_ids?.includes('e1'))!;

    // デフォルトではドット表示対象になる
    expect(shouldDisplayAsObjectJunction(captainObjectNode)).toBe(true);

    const reactFlowNode: VTAReactFlowNode = {
      id: captainObjectNode.id,
      type: 'vtaNode',
      position: { x: 300, y: 100 },
      data: {
        ...captainObjectNode,
        measuredHeight: 120,
      },
    };

    // projectDisplayNode により vtaObjectJunction に切り替わる
    const projected = projectDisplayNode(reactFlowNode);
    expect(projected.type).toBe('vtaObjectJunction');
    expect(projected.width).toBe(24);
    expect(projected.height).toBe(24);

    // 個別設定で 'card' が指定された場合は通常カードのまま
    const cardOverrideNode = { ...captainObjectNode, object_display_style: 'card' as const };
    expect(shouldDisplayAsObjectJunction(cardOverrideNode)).toBe(false);
    const reactFlowCardNode: VTAReactFlowNode = {
      ...reactFlowNode,
      data: { ...reactFlowNode.data, object_display_style: 'card' },
    };
    expect(projectDisplayNode(reactFlowCardNode).type).toBe('vtaNode');

    // グローバル設定 defaultObjectDisplayStyle: 'card' の場合も通常カードのまま
    expect(shouldDisplayAsObjectJunction(captainObjectNode, 'card')).toBe(false);
  });

  it('keeps outcome nodes as cards by default even when they are passive objects, unless explicitly set to dot', () => {
    const outcomeObjectNode = {
      id: 'node_outcome_obj',
      lane: '被災機',
      time: '18:00',
      title: '衝突・炎上',
      description: '滑走路上で他機と衝突した',
      type: 'outcome' as const,
      entity_role: 'object' as const,
      measure_type: null,
    };

    // 帰結ノードは受動客体であってもデフォルト（未指定時）はカード表示を維持
    expect(shouldDisplayAsObjectJunction(outcomeObjectNode)).toBe(false);

    const reactFlowNode: VTAReactFlowNode = {
      id: outcomeObjectNode.id,
      type: 'vtaNode',
      position: { x: 300, y: 200 },
      data: {
        ...outcomeObjectNode,
        measuredHeight: 140,
      },
    };

    const projectedDefault = projectDisplayNode(reactFlowNode);
    expect(projectedDefault.type).toBe('vtaNode');

    // ユーザーが明示的に dot を指定した場合はドット表示に切り替わる
    const explicitDotNode = { ...outcomeObjectNode, object_display_style: 'dot' as const };
    expect(shouldDisplayAsObjectJunction(explicitDotNode)).toBe(true);

    const reactFlowDotNode: VTAReactFlowNode = {
      ...reactFlowNode,
      data: { ...reactFlowNode.data, object_display_style: 'dot' },
    };
    const projectedDot = projectDisplayNode(reactFlowDotNode);
    expect(projectedDot.type).toBe('vtaObjectJunction');
    expect(projectedDot.width).toBe(24);
    expect(projectedDot.height).toBe(24);

    // 明示的に card を指定した場合はカード表示を維持
    const explicitCardNode = { ...outcomeObjectNode, object_display_style: 'card' as const };
    expect(shouldDisplayAsObjectJunction(explicitCardNode)).toBe(false);
  });

  it('syncs entity_role changes back to analysis participations via reconcileAnalysis', () => {
    const schema = prepareSharedEventScenario();
    const captainObjectNode = schema.nodes.find((n) => n.lane === '機長' && n.event_ids?.includes('e1'))!;

    // ユーザーが手動で客体から主体（能動）へ変更
    const updatedNodes = schema.nodes.map((n) =>
      n.id === captainObjectNode.id ? { ...n, entity_role: 'subject' as const } : n
    );
    const reconciled = reconcileAnalysis(schema, { ...schema, nodes: updatedNodes });

    const captainEntity = reconciled.analysis?.entities.find((e) => e.name === '機長');
    const part = reconciled.analysis?.participations.find(
      (p) => p.eventId === 'e1' && p.entityId === captainEntity!.id
    );
    expect(part?.role).toBe('actor');
  });

  it('renders object junction node markup with tooltips and styling', () => {
    const reactFlowNode: VTAReactFlowNode = {
      id: 'node_obj_1',
      type: 'vtaObjectJunction',
      position: { x: 200, y: 150 },
      data: {
        id: 'node_obj_1',
        lane: '機長',
        time: '09:00',
        title: '離陸許可受領',
        description: '管制塔から許可を受領',
        type: 'normal',
        entity_role: 'object',
        measure_type: null,
      },
    };

    const html = renderToStaticMarkup(
      <ReactFlowProvider>
        <VTAObjectJunctionNode
          id="node_obj_1"
          data={reactFlowNode.data}
          type="vtaObjectJunction"
          selected={false}
          zIndex={1}
          isConnectable={false}
          dragging={false}
          draggable={false}
          selectable={false}
          deletable={false}
          positionAbsoluteX={200}
          positionAbsoluteY={150}
        />
      </ReactFlowProvider>
    );

    expect(html).toContain('受動客体');
    expect(html).toContain('離陸許可受領');
    expect(html).toContain('border-cyan-400');
  });

  it('renders object-junction vector circle in SVG export', () => {
    const schema = prepareSharedEventScenario();
    const svg = generateVTASVG(schema, [], [], [], {
      scenarioText: 'テストシナリオ',
    });

    expect(svg).toContain('data-node-kind="object-junction"');
    expect(svg).toContain('【受動客体】');
  });

  it('renders object display style selector in LaneManagementPanel', () => {
    const schema = prepareSharedEventScenario();
    const html = renderToStaticMarkup(
      <LaneManagementPanel
        schema={schema}
        onAdd={() => true}
        onVisibility={() => {}}
        onSimplify={() => {}}
        onToggleObjectDisplayStyle={() => {}}
      />
    );

    expect(html).toContain('受動客体ノードの表示形式');
    expect(html).toContain('● ドット表示（標準）');
    expect(html).toContain('🗂 通常カード表示');
  });
});
