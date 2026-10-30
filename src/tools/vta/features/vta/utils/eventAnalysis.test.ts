import { describe, expect, it } from 'vitest';
import { applyEventClassification, buildAnalysis, projectAnalysis, reconcileAnalysis,
  sourceFromText, validateEvents, validateFacts, validateParticipants } from './eventAnalysis';
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
});
