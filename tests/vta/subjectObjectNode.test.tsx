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
import { calculateVTALayout } from '../../src/tools/vta/features/vta/utils/layout';
import { annotateNodeTopologyRules } from '../../src/tools/vta/features/vta/utils/nodeTopologyRules';
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

  it('keeps nodes that are the source of an outgoing cross-lane arrow as cards (ADR-0026 Rule 1)', () => {
    const crossLaneSourceNode = {
      id: 'node_cross_src',
      lane: '空港消防',
      time: '18:10',
      title: '人員配置・引継ぎ',
      description: '機長Aの搬送・保護を指示',
      type: 'normal' as const,
      entity_role: 'object' as const,
      is_cross_lane_source: true,
      measure_type: null,
    };

    // 他レーンへの矢印の始点ノードは、受動客体であっても通常カード表示を維持する
    expect(shouldDisplayAsObjectJunction(crossLaneSourceNode)).toBe(false);

    // ユーザーが明示的に dot を指定した場合はオーバーライドしてドット化できる
    expect(shouldDisplayAsObjectJunction({ ...crossLaneSourceNode, object_display_style: 'dot' })).toBe(true);

    // 明示的に card を指定した場合は当然カード表示
    expect(shouldDisplayAsObjectJunction({ ...crossLaneSourceNode, object_display_style: 'card' })).toBe(false);
  });

  it('keeps the topmost (chronologically last) node in each lane as a card (ADR-0026 Rule 2)', () => {
    const laneTerminalNode = {
      id: 'node_lane_term',
      lane: '機長A',
      time: '18:20',
      title: '機長A保護・病院搬送',
      description: '救助され病院へ搬送された',
      type: 'normal' as const,
      entity_role: 'object' as const,
      is_lane_terminal: true,
      measure_type: null,
    };

    // レーンの最上部（時系列末尾）ノードは、受動客体であっても通常カード表示を維持する
    expect(shouldDisplayAsObjectJunction(laneTerminalNode)).toBe(false);

    // ユーザーが明示的に dot を指定した場合はオーバーライドしてドット化できる
    expect(shouldDisplayAsObjectJunction({ ...laneTerminalNode, object_display_style: 'dot' })).toBe(true);
  });

  it('correctly handles the user reported cross-lane connection scenario where both sides become cards', () => {
    // 空港消防レーン:
    //   - node_fire_discover: "機長A発見" (主体: 空港消防) -> actor -> カード
    //   - node_fire_handover: "人員配置・引継ぎ" (受動客体だが機長Aへクロスレーン矢印を送る始点) -> is_cross_lane_source: true -> カード!
    // 機長Aレーン:
    //   - node_capt_middle: "受領・一次保護" (受動客体、中間ノード) -> ドット
    //   - node_capt_final: "病院搬送完了" (受動客体だが機長Aレーンの最上部終端) -> is_lane_terminal: true -> カード!
    const schema: VTASchema = {
      lanes: ['機長A', '空港消防'],
      nodes: [
        {
          id: 'node_fire_discover',
          lane: '空港消防',
          time: '18:00',
          title: '機長A発見',
          description: '消防車両前で発見',
          type: 'normal',
          entity_role: 'subject',
          sequence_order: 0,
          measure_type: null,
        },
        {
          id: 'node_fire_handover',
          lane: '空港消防',
          time: '18:10',
          title: '人員管理・引継ぎ',
          description: '機長Aの保護・引継ぎ',
          type: 'normal',
          entity_role: 'object',
          sequence_order: 1,
          measure_type: null,
        },
        {
          id: 'node_capt_middle',
          lane: '機長A',
          time: '18:05',
          title: '一次保護受領',
          description: '保護された',
          type: 'normal',
          entity_role: 'object',
          sequence_order: 0,
          measure_type: null,
        },
        {
          id: 'node_capt_final',
          lane: '機長A',
          time: '18:15',
          title: '病院搬送完了',
          description: '救助完了',
          type: 'normal',
          entity_role: 'object',
          sequence_order: 1,
          measure_type: null,
        },
      ],
      edges: [
        // 空港消防内の時系列
        { id: 'e_fire_seq', source: 'node_fire_discover', target: 'node_fire_handover', direction: 'sequential', generated: true },
        // 機長A内の時系列
        { id: 'e_capt_seq', source: 'node_capt_middle', target: 'node_capt_final', direction: 'sequential', generated: true },
        // 空港消防(node_fire_handover)から機長A(node_capt_final)へのクロスレーン接続（人員管理/監督）
        {
          id: 'e_cross_handover',
          source: 'node_fire_handover',
          target: 'node_capt_final',
          direction: 'unidirectional',
          meaning: 'transfer',
          resource: 'person',
          label: '人員 (管理/監督)',
          generated: true,
        },
      ],
    };

    // 1. annotateNodeTopologyRules の検証
    const annotated = annotateNodeTopologyRules(schema);
    const fireHandover = annotated.nodes.find((n) => n.id === 'node_fire_handover')!;
    const captMiddle = annotated.nodes.find((n) => n.id === 'node_capt_middle')!;
    const captFinal = annotated.nodes.find((n) => n.id === 'node_capt_final')!;

    // node_fire_handover は他レーン（機長A）への矢印始点
    expect(fireHandover.is_cross_lane_source).toBe(true);
    expect(fireHandover.is_lane_terminal).toBe(true); // かつ空港消防レーンの最上部

    // node_capt_middle は中間の受動客体（クロスレーン始点でもなく、終端でもない）
    expect(captMiddle.is_cross_lane_source).toBe(false);
    expect(captMiddle.is_lane_terminal).toBe(false);

    // node_capt_final は機長Aレーンの最上部終端
    expect(captFinal.is_cross_lane_source).toBe(false);
    expect(captFinal.is_lane_terminal).toBe(true);

    // 2. shouldDisplayAsObjectJunction による表示形式の検証
    // クロスレーン矢印の始点 (node_fire_handover) はカード表示
    expect(shouldDisplayAsObjectJunction(fireHandover)).toBe(false);
    // 中間の受動客体 (node_capt_middle) はドット表示
    expect(shouldDisplayAsObjectJunction(captMiddle)).toBe(true);
    // レーン最上部終端 (node_capt_final) はカード表示
    expect(shouldDisplayAsObjectJunction(captFinal)).toBe(false);

    // 3. calculateVTALayout を通じた React Flow ノード投影の検証
    const layout = calculateVTALayout(schema);
    const layoutFireHandover = layout.nodes.find((n) => n.id === 'node_fire_handover')!;
    const layoutCaptMiddle = layout.nodes.find((n) => n.id === 'node_capt_middle')!;
    const layoutCaptFinal = layout.nodes.find((n) => n.id === 'node_capt_final')!;

    const projectedFire = projectDisplayNode(layoutFireHandover);
    const projectedCaptMiddle = projectDisplayNode(layoutCaptMiddle);
    const projectedCaptFinal = projectDisplayNode(layoutCaptFinal);

    // 矢印の始点（右側）はカード表示
    expect(projectedFire.type).toBe('vtaNode');
    // 中間ノードはドット表示（vtaObjectJunction, 24x24px）
    expect(projectedCaptMiddle.type).toBe('vtaObjectJunction');
    expect(projectedCaptMiddle.width).toBe(24);
    expect(projectedCaptMiddle.height).toBe(24);
    // レーン最上部終端（左側）はカード表示
    expect(projectedCaptFinal.type).toBe('vtaNode');

    // 矢印の両端（node_fire_handover と node_capt_final）がともにカード表示になることを確認！
    expect(projectedFire.type).not.toBe('vtaObjectJunction');
    expect(projectedCaptFinal.type).not.toBe('vtaObjectJunction');
  });
});
