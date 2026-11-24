import { describe, expect, it } from 'vitest';
import {
  applyEventClassification,
  auditProjectionWiring,
  batchAdoptPreliminary,
  buildAnalysis,
  isIdentifiedOutcomeEvent,
  projectAnalysis,
  reconcileAnalysis,
  recordGraphProjectionDebug,
  setEventClassificationWithOutcomeSync,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
} from './eventAnalysis';
import { debugRecorder } from '../../../services/debugRecorder';
import { auditVTALayoutGeometry, calculateVTALayout } from './layout';
import { validateAndSanitizeProjectFile } from './schemaValidator';
import { computeVTADataHash } from './hash';
import { extractReportAnalysisContext } from './reportContextExtractor';

const prepare = () => {
  const source = sourceFromText('09:00 担当者が装置を起動した。\n10:00 装置が停止した。');
  const facts = validateFacts({ facts: [
    { id: 'f1', text: '担当者が装置を起動した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 担当者が装置を起動した。' }] },
    { id: 'f2', text: '装置が停止した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '10:00 装置が停止した。' }] },
  ] }, [source]);
  const events = validateEvents({ events: [
    { id: 'e1', title: '起動', description: '装置を起動', time: '09:00', factIds: ['f1'] },
    { id: 'e2', title: '停止', description: '装置が停止', time: '10:00', factIds: ['f2'] },
  ] }, facts);
  return { source, facts, events };
};

describe('evidence-backed event and actor model', () => {
  it('keeps long source lines addressable without discarding background sections', () => {
    const longLine = `- 2024-01-02 17:00 ${'装置を確認した。'.repeat(350)}`;
    const source = sourceFromText(`## 3. 事実\n### 3.1 時系列\n${longLine}\n- 2024-01-02 18:00 装置が停止した。\n### 3.2 付帯事実\n背景情報\n## 4. 評価`);
    expect(source.paragraphs.every((part) => part.text.length <= 2400)).toBe(true);
    expect(source.paragraphs.some((part) => part.text.includes('装置が停止した'))).toBe(true);
    expect(source.paragraphs.some((part) => part.text.includes('背景情報'))).toBe(true);
  });
  it('requires verbatim source quotes and event references', () => {
    const { source, facts } = prepare();
    expect(() => validateFacts({ facts: [{ id: 'x', text: '創作', kind: 'recorded',
      evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '原文にない' }] }] }, [source])).toThrow();
    expect(() => validateEvents({ events: [{ id: 'e', title: '出来事', factIds: ['unknown'] }] }, facts)).toThrow();
  });

  it('discards invalid optional relations only during LLM extraction', () => {
    const { facts, events } = prepare();
    const response = { entities: [{ id: 'machine', name: '装置', kind: 'machine' }],
      participations: [{ eventId: 'e1', entityId: 'machine', role: 'target', factIds: ['f1'] }],
      relations: [{ sourceEventId: 'e1', targetEventId: 'e2', kind: 'impact' }] };
    expect(() => validateParticipants(response, events, facts)).toThrow('関係の根拠');
    const warnings: string[] = [];
    const parsed = validateParticipants(response, events, facts, false, (warning) => warnings.push(warning));
    expect(parsed.participations).toHaveLength(1);
    expect(parsed.relations).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('shares one event across two lanes without inventing a communication edge', () => {
    const { source, facts, events } = prepare();
    const parsed = validateParticipants({ entities: [
      { id: 'person', name: '担当者', kind: 'person' }, { id: 'machine', name: '装置', kind: 'machine' },
    ], participations: [
      { eventId: 'e1', entityId: 'person', role: 'actor', factIds: ['f1'] },
      { eventId: 'e1', entityId: 'machine', role: 'target', factIds: ['f1'] },
      { eventId: 'e2', entityId: 'machine', role: 'actor', factIds: ['f2'] },
    ], relations: [], cardGroups: [] }, events, facts);
    const analysis = buildAnalysis(source, facts, events, parsed);
    const schema = projectAnalysis(analysis);
    expect(analysis.events).toHaveLength(2);
    expect(schema.nodes.filter((node) => node.event_ids?.includes('e1'))).toHaveLength(2);
    expect(schema.nodes.every((node) => node.type === 'unclassified')).toBe(true);
    expect(schema.edges.filter((edge) => schema.nodes.find((node) => node.id === edge.source)?.lane !==
      schema.nodes.find((node) => node.id === edge.target)?.lane)).toHaveLength(0);
    expect(extractReportAnalysisContext(schema).timelineSummary).toHaveLength(2);
    const edited = { ...schema, nodes: schema.nodes.map((node) => node.event_ids?.includes('e1') && node.lane === '担当者'
      ? { ...node, title: '手動修正' } : node) };
    const reconciled = reconcileAnalysis(schema, edited);
    expect(reconciled.nodes.filter((node) => node.event_ids?.includes('e1')).map((node) => node.title)).toEqual(['手動修正', '手動修正']);
    expect(reconciled.analysis?.events.find((event) => event.id === 'e1')?.origin).toBe('manual');
    const saved = validateAndSanitizeProjectFile({ version: '5.0', vtaData: reconciled, scenarioText: source.text });
    expect(saved.isValid).toBe(true);
    expect(saved.data?.vtaData.analysis?.events).toHaveLength(2);
    expect(validateAndSanitizeProjectFile({ version: '1.0', vtaData: reconciled }).isValid).toBe(false);
  });

  it('groups unordered events per actor, but keeps different explicit times separate', () => {
    const { source, facts, events } = prepare();
    const sameTime = events.map((event) => ({ ...event, time: '' }));
    const unknownSource = sourceFromText('担当者が装置を起動した。\n装置が停止した。');
    const unknownFacts = facts.map((fact) => ({ ...fact, evidence: fact.evidence.map((ref) => ({
      ...ref, quote: ref.quote.replace(/^\d{2}:\d{2} /, ''),
    })) }));
    const participantRaw = { entities: [{ id: 'machine', name: '装置', kind: 'machine' }], participations: [
      { eventId: 'e1', entityId: 'machine', role: 'actor', factIds: ['f1'] },
      { eventId: 'e2', entityId: 'machine', role: 'actor', factIds: ['f2'] },
    ], relations: [], cardGroups: [] };
    expect(buildAnalysis(unknownSource, unknownFacts, sameTime, validateParticipants(participantRaw, sameTime, unknownFacts)).cards[0].eventIds).toEqual(['e1', 'e2']);
    expect(buildAnalysis(source, facts, sameTime, validateParticipants(participantRaw, sameTime, facts)).cards).toHaveLength(2);
    expect(buildAnalysis(source, facts, events, validateParticipants(participantRaw, events, facts)).cards).toHaveLength(2);
    const grouped = buildAnalysis(unknownSource, unknownFacts, sameTime, validateParticipants(participantRaw, sameTime, unknownFacts));
    const groupedSchema = projectAnalysis(grouped);
    const split = { ...grouped, cards: [
      { ...grouped.cards[0], eventIds: ['e1'] },
      { id: 'second', laneEntityId: 'machine', eventIds: ['e2'] },
    ] };
    expect(projectAnalysis(split, groupedSchema).nodes.map((node) => node.sequence_order)).toEqual([0, 1]);
  });

  it('requires a supported classification and includes unassigned events in change detection', () => {
    const { source, facts, events } = prepare();
    const analysis = buildAnalysis(source, facts, events,
      validateParticipants({ entities: [], participations: [], relations: [], cardGroups: [] }, events, facts));
    expect(analysis.unassignedEventIds).toEqual(['e1', 'e2']);
    expect(() => applyEventClassification(analysis, { classifications: [
      { eventId: 'e1', value: 'variation', factIds: ['f2'] }, { eventId: 'e2', value: 'undetermined', factIds: [] },
    ] })).toThrow();
    const before = computeVTADataHash(projectAnalysis(analysis));
    const classified = applyEventClassification(analysis, { classifications: [
      { eventId: 'e1', value: 'variation', reason: '記録', factIds: ['f1'] },
      { eventId: 'e2', value: 'undetermined', reason: '不明', factIds: [] },
    ] });
    expect(computeVTADataHash(projectAnalysis(classified))).not.toBe(before);
    const committed = reconcileAnalysis(projectAnalysis(analysis), projectAnalysis(classified, projectAnalysis(analysis)));
    expect(committed.analysis?.events[0].classificationReason).toBe('記録');
    expect(committed.analysis?.events[0].classificationFactIds).toEqual(['f1']);
  });

  it('keeps the tower actions on separate cards when short evidence quotes omit their timestamps', () => {
    const entries = [
      ['2024-01-02 時刻記録なし（17:46:11以降）', 'タワー東は停止機に気付き、グラウンド東の様子をうかがった。'],
      ['2024-01-02 17:47 (12秒)', 'タワー東はＤＦからＢ機について問合せを受けた。'],
      ['2024-01-02 17:47 (22秒)', 'タワー東はＤ機に減速を指示し、Ｂ機を注視した。'],
      ['2024-01-02 17:47 (28秒)', 'タワー東はＢ機から炎が上がるのを見た。'],
      ['2024-01-02 17:47 (29秒)', 'ＤＦが再確認したが、タワー東は応答しなかった。'],
      ['2024-01-02 17:48 (10秒)', 'タワー東はＤ機に復行を指示し、交替管制官へ引き継いだ。'],
    ];
    const source = sourceFromText(entries.map(([time, text]) => `- ${time} ${text}`).join('\n'));
    const facts = validateFacts({ facts: entries.map(([, text], index) => ({
      id: `f${index + 1}`, text, kind: 'recorded', evidence: [
        { sourceId: source.id, paragraphId: `p${index + 1}`, quote: text },
      ],
    })) }, [source]);
    const events = validateEvents({ events: entries.map(([, text], index) => ({
      id: `e${index + 1}`, title: text, description: text, time: '', factIds: [`f${index + 1}`],
    })) }, facts, false, false, [source]);
    expect(events.map((event) => event.time)).toEqual(entries.map(([time]) => time));
    const raw = { entities: [{ id: 'tower', name: 'タワー東', kind: 'person' }],
      participations: events.map((event) => ({ eventId: event.id, entityId: 'tower', role: 'actor', factIds: event.factIds })),
      relations: [], cardGroups: [{ entityId: 'tower', eventIds: events.map((event) => event.id) }] };
    const warnings: string[] = [];
    const parsed = validateParticipants(raw, events, facts, false, (warning) => warnings.push(warning), [source]);
    expect(parsed.groups).toEqual([]);
    expect(warnings).toHaveLength(1);
    const schema = projectAnalysis(buildAnalysis(source, facts, events, parsed));
    expect(schema.nodes).toHaveLength(entries.length);
    expect(schema.nodes.every((node) => node.event_ids?.length === 1)).toBe(true);
    expect(schema.edges).toHaveLength(entries.length - 1);
    expect(validateAndSanitizeProjectFile({ version: '5.0', vtaData: schema, scenarioText: source.text }).isValid).toBe(true);

    // Rendering must enforce the same boundary even if an earlier stage generalised all event times.
    const generalised = events.map((event) => ({ ...event, time: '17時台' }));
    const grouped = validateParticipants(raw, generalised, facts);
    expect(buildAnalysis(source, facts, generalised, grouped).cards).toHaveLength(entries.length);
  });

  it('does not absorb unknown timing into a timed card or assign a paragraph time to a later action', () => {
    const source = sourceFromText('- 2024-01-02 17:48 (10秒) Ｄ機に復行を指示した。17:49:15に通信移管した。\n状況を確認した。');
    const facts = validateFacts({ facts: ['通信移管した。', '状況を確認した。'].map((quote, index) => ({
      id: `f${index + 1}`, text: quote, kind: 'recorded',
      evidence: [{ sourceId: source.id, paragraphId: `p${index + 1}`, quote }],
    })) }, [source]);
    const events = validateEvents({ events: facts.map((fact, index) => ({
      id: `e${index + 1}`, title: fact.text, description: fact.text, time: '', factIds: [fact.id],
    })) }, facts, false, false, [source]);
    expect(events.every((event) => event.time === '')).toBe(true);
    const parsed = validateParticipants({ entities: [{ id: 'tower', name: 'タワー東', kind: 'person' }],
      participations: events.map((event) => ({ eventId: event.id, entityId: 'tower', role: 'actor', factIds: event.factIds })),
    }, events, facts);
    expect(buildAnalysis(source, facts, events, parsed).cards).toHaveLength(2);
  });

  it('keeps different recorded dates separate even when the clock time is absent', () => {
    const source = sourceFromText('- 2024-01-29 灯火を検証した。\n- 2024-04-17 シミュレーターで検証した。');
    const facts = validateFacts({ facts: ['灯火を検証した。', 'シミュレーターで検証した。'].map((quote, index) => ({
      id: `f${index + 1}`, text: quote, kind: 'recorded',
      evidence: [{ sourceId: source.id, paragraphId: `p${index + 1}`, quote }],
    })) }, [source]);
    const events = validateEvents({ events: facts.map((fact, index) => ({
      id: `e${index + 1}`, title: fact.text, factIds: [fact.id], time: '',
    })) }, facts, false, false, [source]);
    expect(events.map((event) => event.time)).toEqual(['2024-01-29', '2024-04-17']);
    const parsed = validateParticipants({ entities: [{ id: 'a', name: '調査者', kind: 'person' }],
      participations: events.map((event) => ({ eventId: event.id, entityId: 'a', role: 'actor', factIds: event.factIds })),
    }, events, facts);
    expect(buildAnalysis(source, facts, events, parsed).cards).toHaveLength(2);
  });

  it('keeps manual actor corrections but lets users delete an evidence-derived edge', () => {
    const { source, facts, events } = prepare();
    const parsed = validateParticipants({ entities: [
      { id: 'person', name: '担当者', kind: 'person' }, { id: 'machine', name: '装置', kind: 'machine' },
    ], participations: [
      { eventId: 'e1', entityId: 'person', role: 'actor', factIds: ['f1'] },
      { eventId: 'e2', entityId: 'machine', role: 'actor', factIds: ['f2'] },
    ], relations: [{ sourceEventId: 'e1', targetEventId: 'e2', sourceEntityId: 'person',
      targetEntityId: 'machine', kind: 'impact', factIds: ['f1'] }], cardGroups: [] }, events, facts);
    const analysis = buildAnalysis(source, facts, events, parsed);
    const schema = projectAnalysis(analysis);
    expect(schema.edges).toHaveLength(1);
    const changed = reconcileAnalysis(schema, { ...schema, edges: [] });
    expect(changed.edges).toHaveLength(0);
    expect(changed.analysis?.relations).toHaveLength(0);
    const manuallyAssigned = { ...changed, analysis: { ...changed.analysis!, participations: [
      ...changed.analysis!.participations, { eventId: 'e1', entityId: 'machine', role: 'affected' as const,
        factIds: [], origin: 'manual' as const },
    ], cards: [...changed.analysis!.cards, { id: 'manual_card', laneEntityId: 'machine', eventIds: ['e1'] }] } };
    const projected = projectAnalysis(manuallyAssigned.analysis!, changed);
    expect(validateAndSanitizeProjectFile({ version: '5.0', vtaData: projected }).isValid).toBe(true);
  });

  it('preserves previous.pipelineHistory across projectAnalysis runs', () => {
    const { source, facts, events } = prepare();
    const parsed = validateParticipants(
      {
        entities: [
          { id: 'person', name: '担当者', kind: 'person' },
          { id: 'machine', name: '装置', kind: 'machine' },
        ],
        participations: [
          { eventId: 'e1', entityId: 'person', role: 'actor', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'machine', role: 'actor', factIds: ['f2'] },
        ],
        relations: [],
        cardGroups: [],
      },
      events,
      facts
    );
    const analysis = buildAnalysis(source, facts, events, parsed);
    const baseSchema = projectAnalysis(analysis);
    const withHistory = {
      ...baseSchema,
      pipelineHistory: [
        {
          id: 'stage1_normalize' as const,
          stageIndex: 0,
          title: 'Stage 1',
          subtitle: '',
          description: '',
          timestamp: '2026-11-18T00:00:00.000Z',
          lanes: baseSchema.lanes,
          nodes: baseSchema.nodes,
          edges: baseSchema.edges,
          stats: { eventCount: 2, nodeCount: 2, laneCount: 2, edgeCount: 0, variationCount: 0, outcomeCount: 0 },
        },
      ],
    };
    const reprojected = projectAnalysis(analysis, withHistory, { silentDebug: true });
    expect(reprojected.pipelineHistory).toHaveLength(1);
    expect(reprojected.pipelineHistory?.[0].id).toBe('stage1_normalize');
  });

  it('re-synchronizes sequence_order, sequential edges, and layout without backward or detoured wires when later relations reorder a lane (Haneda intra-lane regression)', () => {
    const source = sourceFromText(
      [
        '2024-01-02 17:45(02秒) A機がタワー東を呼び込んだ。',
        '2024-01-02 17:45(11〜18秒) タワー東はA機に「No.1, taxi to holding point C5」と指示した。',
        '2024-01-02 17:45(18〜25秒) A機は指示を復唱してC5へ向かった。',
        '後から実施した聞き取りで機長Aは指示内容を誤認していたと口述した。',
      ].join('\n')
    );
    const quotes = [
      'A機がタワー東を呼び込んだ。',
      'タワー東はA機に「No.1, taxi to holding point C5」と指示した。',
      'A機は指示を復唱してC5へ向かった。',
      '後から実施した聞き取りで機長Aは指示内容を誤認していたと口述した。',
    ];
    const facts = validateFacts(
      {
        facts: quotes.map((quote, i) => ({
          id: `f${i + 1}`,
          text: quote,
          kind: i === 3 ? 'claim' : 'recorded',
          evidence: [{ sourceId: source.id, paragraphId: `p${i + 1}`, quote }],
        })),
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'E1', title: 'A機呼込み', time: '2024-01-02 17:45(02秒)', factIds: ['f1'] },
          { id: 'E2', title: '待機指示発出', time: '2024-01-02 17:45(11〜18秒)', factIds: ['f2'] },
          { id: 'E3', title: '指示復唱および確認', time: '2024-01-02 17:45(18〜25秒)', factIds: ['f3'] },
          // E4 appears later in source (p4) and initially lacks explicit time or before-link,
          // then later Stage 2/3 adds before(E2 -> E4) and before(E4 -> E3).
          { id: 'E4', title: '管制指示内容供述', recordKind: 'claim', time: '', factIds: ['f4'] },
        ],
      },
      facts,
      false,
      false,
      [source]
    );
    const parsed = validateParticipants(
      {
        entities: [
          { id: 'A_AC', name: '海保A機乗組員', kind: 'person' },
          { id: 'TWR', name: 'タワー東', kind: 'person' },
        ],
        participations: [
          { eventId: 'E1', entityId: 'A_AC', role: 'actor', factIds: ['f1'] },
          { eventId: 'E2', entityId: 'TWR', role: 'actor', factIds: ['f2'] },
          { eventId: 'E2', entityId: 'A_AC', role: 'intended_recipient', factIds: ['f2'] },
          { eventId: 'E3', entityId: 'A_AC', role: 'actor', factIds: ['f3'] },
          { eventId: 'E4', entityId: 'A_AC', role: 'actor', factIds: ['f4'] },
        ],
        relations: [
          { id: 'R1', kind: 'transfer', sourceEventId: 'E2', sourceEntityId: 'TWR', targetEventId: 'E2', targetEntityId: 'A_AC', resource: 'information', status: 'occurred', receipt: 'confirmed', factIds: ['f2'] },
        ],
        cardGroups: [],
      },
      events,
      facts,
      false,
      undefined,
      [source]
    );

    const initialAnalysis = buildAnalysis(source, facts, events, parsed);
    const initialSchema = projectAnalysis(initialAnalysis);

    // Stage 3 adds chronological links placing E4 between E2 and E3 (previously E4 was at end of lane)
    const updatedAnalysis = {
      ...structuredClone(initialSchema.analysis!),
      relations: [
        ...initialSchema.analysis!.relations,
        { id: 'R_b1', kind: 'before' as const, sourceEventId: 'E2', targetEventId: 'E4', factIds: ['f2', 'f4'] },
        { id: 'R_b2', kind: 'before' as const, sourceEventId: 'E4', targetEventId: 'E3', factIds: ['f4', 'f3'] },
      ],
    };

    const reprojected = projectAnalysis(updatedAnalysis, initialSchema);
    const acNodes = reprojected.nodes
      .filter((n) => n.lane === '海保A機乗組員')
      .sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0));
    expect(acNodes.map((n) => n.event_ids?.[0])).toEqual(['E1', 'E2', 'E4', 'E3']);

    const layout = calculateVTALayout(reprojected);
    const geomAudit = auditVTALayoutGeometry(reprojected, layout);
    const wireAudit = auditProjectionWiring(reprojected);
    expect(wireAudit.backwardIntraLaneEdges).toEqual([]);
    expect(wireAudit.skipSequentialEdges).toEqual([]);
    expect(wireAudit.dagSequenceInversions).toEqual([]);
    expect(geomAudit.backwardIntraLaneEdges).toEqual([]);
    expect(geomAudit.detouredIntraLaneEdges).toEqual([]);
    expect(geomAudit.nonAdjacentIntraLaneEdges).toEqual([]);
    expect(geomAudit.overlappingIntraLanePairs).toEqual([]);
  });

  it('preserves per-event outcome_kind (recovery vs loss) and populates resilient variationFactor during batchAdoptPreliminary', () => {
    const src = sourceFromText('両機が衝突した。\n安全確認の上でドアを開放し脱出を開始した。\n乗員乗客全員が脱出した。');
    const facts = validateFacts({
      facts: [
        { id: 'f1', text: '両機が衝突した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p1', quote: '両機が衝突した。' }] },
        { id: 'f2', text: '安全確認の上でドアを開放し脱出を開始した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p2', quote: '安全確認の上でドアを開放し脱出を開始した。' }] },
        { id: 'f3', text: '乗員乗客全員が脱出した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p3', quote: '乗員乗客全員が脱出した。' }] },
      ],
    }, [src]);
    const baseEvents = validateEvents({
      events: [
        { id: 'E1', time: '17:47', title: '衝突', description: '両機が衝突した', factIds: ['f1'] },
        { id: 'E2', time: '17:50', title: 'ドア開放・脱出開始', description: '安全確認の上でドアを開放し脱出を開始した', factIds: ['f2'] },
        { id: 'E3', time: '18:05', title: '全員脱出完了', description: '全員脱出した', factIds: ['f3'] },
      ],
    }, facts);
    baseEvents[0].outcome_kind = 'loss';
    baseEvents[1].preliminary = {
      value: 'variation',
      reason: '乗客救助のため安全確認の上でドアを開放したレジリエンス発揮',
      sourceRefs: [{ sourceId: src.id, paragraphId: 'p2' }],
    };
    baseEvents[2].outcome_kind = 'recovery';

    const parsed = validateParticipants({
      entities: [{ id: 'A_CABIN', name: '客室乗務員', kind: 'organization' }],
      participations: [
        { eventId: 'E1', entityId: 'A_CABIN', role: 'affected', factIds: ['f1'] },
        { eventId: 'E2', entityId: 'A_CABIN', role: 'actor', factIds: ['f2'] },
        { eventId: 'E3', entityId: 'A_CABIN', role: 'actor', factIds: ['f3'] },
      ],
      relations: [
        { kind: 'before', sourceEventId: 'E1', targetEventId: 'E2', factIds: ['f1', 'f2'] },
        { kind: 'before', sourceEventId: 'E2', targetEventId: 'E3', factIds: ['f2', 'f3'] },
      ],
    }, baseEvents, facts);

    const analysis = {
      ...buildAnalysis(src, facts, baseEvents, parsed),
      outcome: {
        status: 'identified' as const,
        kind: 'loss' as const,
        eventIds: ['E1', 'E3'],
        sourceRefs: [{ sourceId: src.id, paragraphId: 'p1' }],
        reason: '衝突損失と全員脱出完了',
      },
    };
    const { updatedAnalysis } = batchAdoptPreliminary(analysis, 'variation_only');
    const e2After = updatedAnalysis.events.find((e) => e.id === 'E2');
    expect(e2After?.classification).toBe('variation');
    expect(e2After?.variationFactor?.polarity).toBe('resilient');

    const schema = projectAnalysis(updatedAnalysis);
    const n1 = schema.nodes.find((n) => n.event_ids?.includes('E1'));
    const n2 = schema.nodes.find((n) => n.event_ids?.includes('E2'));
    const n3 = schema.nodes.find((n) => n.event_ids?.includes('E3'));
    expect(n1?.type).toBe('outcome');
    expect(n1?.outcome_kind).toBe('loss');
    expect(n2?.type).toBe('variation');
    expect(n2?.variation_factor?.polarity).toBe('resilient');
    expect(n3?.type).toBe('outcome');
    expect(n3?.outcome_kind).toBe('recovery');
  });

  it('never overwrites identified outcome events when batchAdoptPreliminary runs even if preliminary is set to variation', () => {
    const src = sourceFromText('10:42 作業員が線路に進入した。\n10:46 列車に触車し4名死亡した。\n10:47 別乗務員が非常ブレーキを手配した。');
    const facts = validateFacts({
      facts: [
        { id: 'f1', text: '10:42 作業員が線路に進入した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p1', quote: '10:42 作業員が線路に進入した。' }] },
        { id: 'f2', text: '10:46 列車に触車し4名死亡した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p2', quote: '10:46 列車に触車し4名死亡した。' }] },
        { id: 'f3', text: '10:47 別乗務員が非常ブレーキを手配した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p3', quote: '10:47 別乗務員が非常ブレーキを手配した。' }] },
      ],
    }, [src]);
    const events = validateEvents({
      events: [
        { id: 'E1', time: '10:42', title: '線路進入', description: '作業員が線路に進入した', factIds: ['f1'] },
        { id: 'E2', time: '10:46', title: '列車触車・死亡', description: '列車に触車し4名死亡した', factIds: ['f2'] },
        { id: 'E3', time: '10:47', title: '緊急ブレーキ', description: '別乗務員が非常ブレーキを手配した', factIds: ['f3'] },
      ],
    }, facts);
    events[0].preliminary = { value: 'variation', reason: '進入手順逸脱', sourceRefs: [{ sourceId: src.id, paragraphId: 'p1' }] };
    events[1].preliminary = { value: 'variation', reason: '重大損失発生', sourceRefs: [{ sourceId: src.id, paragraphId: 'p2' }] };
    events[1].outcome_kind = 'loss';
    events[2].preliminary = { value: 'variation', reason: 'レジリエンス緊急手配', sourceRefs: [{ sourceId: src.id, paragraphId: 'p3' }] };
    events[2].outcome_kind = 'recovery';

    const parsed = validateParticipants({
      entities: [{ id: 'A1', name: '作業班', kind: 'organization' }],
      participations: [
        { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: ['f1'] },
        { eventId: 'E2', entityId: 'A1', role: 'affected', factIds: ['f2'] },
        { eventId: 'E3', entityId: 'A1', role: 'actor', factIds: ['f3'] },
      ],
      relations: [
        { kind: 'before', sourceEventId: 'E1', targetEventId: 'E2', factIds: ['f1', 'f2'] },
        { kind: 'before', sourceEventId: 'E2', targetEventId: 'E3', factIds: ['f2', 'f3'] },
      ],
      cardGroups: [],
    }, events, facts);

    const analysis = {
      ...buildAnalysis(src, facts, events, parsed),
      outcome: {
        status: 'identified' as const,
        kind: 'loss' as const,
        eventIds: ['E2', 'E3'],
        sourceRefs: [{ sourceId: src.id, paragraphId: 'p2' }],
        reason: '触車死亡と緊急手配',
      },
    };

    const { updatedAnalysis, variationCount } = batchAdoptPreliminary(analysis, 'all');
    expect(variationCount).toBe(1);
    expect(updatedAnalysis.events.find((e) => e.id === 'E1')?.classification).toBe('variation');
    expect(updatedAnalysis.events.find((e) => e.id === 'E2')?.classification).toBe('unclassified');
    expect(updatedAnalysis.events.find((e) => e.id === 'E3')?.classification).toBe('unclassified');

    const schema = projectAnalysis(updatedAnalysis);
    expect(schema.nodes.find((n) => n.event_ids?.includes('E2'))?.type).toBe('outcome');
    expect(schema.nodes.find((n) => n.event_ids?.includes('E3'))?.type).toBe('outcome');
    expect(schema.nodes.find((n) => n.event_ids?.includes('E1'))?.type).toBe('variation');
  });

  it('excludes self-collapsed and shared-card-folded relations from missingRelations in recordGraphProjectionDebug', () => {
    const src = sourceFromText('09:00 班員間で連絡した。\n09:00 班内で作業を引き継いだ。\n09:10 外部へ報告した。');
    const facts = validateFacts({
      facts: [
        { id: 'f1', text: '班員間で連絡した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p1', quote: '09:00 班員間で連絡した。' }] },
        { id: 'f2', text: '班内で作業を引き継いだ', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p2', quote: '09:00 班内で作業を引き継いだ。' }] },
        { id: 'f3', text: '外部へ報告した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p3', quote: '09:10 外部へ報告した。' }] },
      ],
    }, [src]);
    const events = validateEvents({
      events: [
        { id: 'E1', time: '09:00', title: '班員間連絡', description: '班員間で連絡した', factIds: ['f1'] },
        { id: 'E2', time: '09:00', title: '班内引継', description: '班内で作業を引き継いだ', factIds: ['f2'] },
        { id: 'E3', time: '09:10', title: '外部報告', description: '外部へ報告した', factIds: ['f3'] },
      ],
    }, facts);
    const parsed = validateParticipants({
      entities: [
        { id: 'A_TEAM', name: '作業班', kind: 'organization' },
        { id: 'A_EXT', name: '外部', kind: 'organization' },
      ],
      participations: [
        { eventId: 'E1', entityId: 'A_TEAM', role: 'actor', factIds: ['f1'] },
        { eventId: 'E2', entityId: 'A_TEAM', role: 'actor', factIds: ['f2'] },
        { eventId: 'E3', entityId: 'A_EXT', role: 'actor', factIds: ['f3'] },
      ],
      relations: [
        // 1. Self-loop collapsed by subject consolidation (same event, same consolidated entity)
        { id: 'R_SELF', kind: 'transfer', sourceEventId: 'E1', sourceEntityId: 'A_TEAM', sourceEntityOrigin: 'A_M1', targetEventId: 'E1', targetEntityId: 'A_TEAM', targetEntityOrigin: 'A_M2', resource: 'information', status: 'occurred', receipt: 'confirmed', factIds: ['f1'] },
        // 2. Folded into shared card (E1 and E2 grouped on A_TEAM)
        { id: 'R_GROUPED', kind: 'transfer', sourceEventId: 'E1', sourceEntityId: 'A_TEAM', targetEventId: 'E2', targetEntityId: 'A_TEAM', resource: 'information', status: 'occurred', receipt: 'confirmed', factIds: ['f1', 'f2'] },
      ],
      cardGroups: [{ entityId: 'A_TEAM', eventIds: ['E1', 'E2'] }],
    }, events, facts);

    const analysis = buildAnalysis(src, facts, events, parsed);
    // 3. Genuinely unprojected (target entity does not participate in E3 -> unresolved)
    analysis.relations.push({
      id: 'R_BROKEN',
      kind: 'transfer',
      sourceEventId: 'E2',
      sourceEntityId: 'A_TEAM',
      targetEventId: 'E3',
      targetEntityId: 'A_MISSING',
      resource: 'information',
      status: 'occurred',
      receipt: 'confirmed',
      factIds: ['f2', 'f3'],
      sourceRefs: [{ sourceId: src.id, paragraphId: 'p2' }],
    });
    const projected = projectAnalysis(analysis);

    debugRecorder.clear();
    debugRecorder.setEnabled(true);
    try {
      recordGraphProjectionDebug(projected);
      const entry = debugRecorder.getEntries().filter((e) => e.stage === 'graph.projection').slice(-1)[0];
      const missing = (entry?.data as { missingRelations?: Array<{ id?: string }> })?.missingRelations ?? [];
      expect(missing.map((m) => m.id)).toEqual(['R_BROKEN']);
    } finally {
      debugRecorder.setEnabled(false);
      debugRecorder.clear();
    }
  });

  it('allows manual demotion of a misclassified outcome event back to unclassified and re-aggregates remaining outcome kind (ADR-0055)', () => {
    const src = sourceFromText('17:47 衝突した。\n17:48 機長Aが脱出した。');
    const facts = validateFacts({
      facts: [
        { id: 'f1', text: '17:47 衝突した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p1', quote: '17:47 衝突した。' }] },
        { id: 'f2', text: '17:48 機長Aが脱出した', kind: 'recorded', evidence: [{ sourceId: src.id, paragraphId: 'p2', quote: '17:48 機長Aが脱出した。' }] },
      ],
    }, [src]);
    const events = validateEvents({
      events: [
        { id: 'E1', time: '17:47', title: '衝突', description: '衝突した', factIds: ['f1'] },
        { id: 'E2', time: '17:48', title: '機長A脱出', description: '機長Aが脱出した', factIds: ['f2'] },
      ],
    }, facts);
    events[0].classification = 'outcome';
    events[0].outcome_kind = 'loss';
    events[1].classification = 'outcome';
    events[1].outcome_kind = 'recovery';

    const parsed = validateParticipants({
      entities: [{ id: 'A1', name: 'A機乗組員', kind: 'organization' }],
      participations: [
        { eventId: 'E1', entityId: 'A1', role: 'affected', factIds: ['f1'] },
        { eventId: 'E2', entityId: 'A1', role: 'actor', factIds: ['f2'] },
      ],
      relations: [{ kind: 'before', sourceEventId: 'E1', targetEventId: 'E2', factIds: ['f1', 'f2'] }],
      cardGroups: [],
    }, events, facts);

    const analysis = {
      ...buildAnalysis(src, facts, events, parsed),
      outcome: {
        status: 'identified' as const,
        kind: 'loss' as const,
        eventIds: ['E1', 'E2'],
        sourceRefs: [{ sourceId: src.id, paragraphId: 'p1' }],
        reason: '衝突損失と脱出回復',
      },
    };

    // 1. Demote E1 (loss) back to unclassified via setEventClassificationWithOutcomeSync
    const afterDemoteE1 = setEventClassificationWithOutcomeSync(analysis, 'E1', 'unclassified', { clearReason: true });
    const e1 = afterDemoteE1.events.find((e) => e.id === 'E1')!;
    expect(e1.classification).toBe('unclassified');
    expect(e1.outcome_kind).toBeUndefined();
    expect(isIdentifiedOutcomeEvent(afterDemoteE1, e1)).toBe(false);
    // Remaining outcome is E2 (recovery), so representative kind updates to 'recovery'
    expect(afterDemoteE1.outcome?.status).toBe('identified');
    expect(afterDemoteE1.outcome?.eventIds).toEqual(['E2']);
    expect(afterDemoteE1.outcome?.kind).toBe('recovery');

    const proj1 = projectAnalysis(afterDemoteE1);
    expect(proj1.nodes.find((n) => n.event_ids?.includes('E1'))?.type).toBe('unclassified');
    expect(proj1.nodes.find((n) => n.event_ids?.includes('E2'))?.type).toBe('outcome');
    expect(proj1.nodes.find((n) => n.event_ids?.includes('E2'))?.outcome_kind).toBe('recovery');

    // 2. Demote remaining E2 back to unclassified via reconcileAnalysis (simulating NodeEditorModal save)
    const editedProj = {
      ...proj1,
      nodes: proj1.nodes.map((n) =>
        n.event_ids?.includes('E2') ? { ...n, type: 'unclassified' as const, outcome_kind: undefined } : n
      ),
    };
    const reconciled = reconcileAnalysis(proj1, editedProj);
    const e2 = reconciled.analysis?.events.find((e) => e.id === 'E2')!;
    expect(e2.classification).toBe('unclassified');
    expect(e2.outcome_kind).toBeUndefined();
    expect(reconciled.analysis?.outcome?.status).toBe('not_found');
    expect(reconciled.analysis?.outcome?.eventIds).toEqual([]);
    expect(reconciled.nodes.find((n) => n.event_ids?.includes('E2'))?.type).toBe('unclassified');

    // 3. Editing only title/time of an outcome node preserves outcome classification
    const projOriginal = projectAnalysis(analysis);
    const titleEdited = {
      ...projOriginal,
      nodes: projOriginal.nodes.map((n) =>
        n.event_ids?.includes('E1') ? { ...n, title: '滑走路上で衝突' } : n
      ),
    };
    const reconciledTitleEdit = reconcileAnalysis(projOriginal, titleEdited);
    expect(reconciledTitleEdit.analysis?.events.find((e) => e.id === 'E1')?.classification).toBe('outcome');
    expect(reconciledTitleEdit.nodes.find((n) => n.event_ids?.includes('E1'))?.type).toBe('outcome');
  });
});
