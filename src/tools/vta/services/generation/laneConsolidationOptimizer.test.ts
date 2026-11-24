import { describe, expect, it } from 'vitest';
import {
  captureFineGrainedBase,
  generateStructuralFallbackCandidates,
  optimizeLaneConsolidation,
  parseLaneConsolidationTSV,
  searchOptimalLaneConsolidation,
} from './laneConsolidationOptimizer';
import { inspectLedger, parseLedger } from '../../features/vta/utils/eventLedger';
import {
  projectAnalysis,
  reconcileAnalysis,
  sourceFromText,
  validateSavedAnalysis,
} from '../../features/vta/utils/eventAnalysis';
import { graphDiagnostics } from '../../features/vta/utils/graphDiagnostics';
import { visibleSchema } from '../../features/vta/utils/presentation';
import type { LLMConfig } from '../../types/vta';

const dummyConfig: LLMConfig = {
  baseUrl: 'http://localhost:8765/v1',
  gatewayToken: '',
  selectedModel: 'test-model',
  timeoutSeconds: 30,
};

function buildFineAnalysis(ledgerText: string, sourceText: string) {
  const src = sourceFromText(sourceText);
  const res = inspectLedger(parseLedger(ledgerText), src);
  if (!res.analysis) {
    throw new Error(`Ledger parse failed: ${res.issues.map((i) => i.message).join(' / ')}`);
  }
  return res.analysis;
}

describe('laneConsolidationOptimizer (ADR-0079)', () => {
  it('parses [統合候補] and [分離維持ペア] TSV, resolves names/IDs, and rejects upward organization->person inversions', () => {
    const source = [
      'p1 製造本部とライン作業員・品証検査員が作業した。',
      'p2 外部発注元と運送業者が手配した。',
    ].join('\n');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'O_PLANT\t製造本部\torganization\thigh\t-\tp1',
      'A_WORK\tライン作業員\tperson\thigh\tO_PLANT\tp1',
      'A_QA\t品証検査員\tperson\thigh\tO_PLANT\tp1',
      'O_CLIENT\t外部発注元\torganization\tlow\t-\tp2',
      'O_CARRIER\t運送業者\torganization\tlow\t-\tp2',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t手配\t外部発注元と運送業者が手配した\tO_CLIENT:actor,O_CARRIER:actor\tp2\trecorded',
      'E2\t10:00\t加工と検査\t作業員と品証が作業した\tO_PLANT:actor,A_WORK:actor,A_QA:actor\tp1\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE2:near_miss\tp1\t検査で停止',
      '[完了]',
    ].join('\n');

    const analysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(analysis);

    const tsv = [
      '<think>推論プロセス</think>',
      '[統合候補]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M1\tperipheral_others\tO_CLIENT,運送業者\tsubject_others\tその他の関係者\tother\t0.05\t事前手配のみの周辺組織',
      'M2\trole_group\tA_WORK,A_QA\t-\t現場・検査チーム\torganization\t0.30\tテスト用役割グループ',
      // Invalid upward organization -> child person merge must be rejected
      'M_BAD\tposet_rollup\tO_PLANT\tA_WORK\t-\tperson\t0.10\t逆方向統合は不可',
      '[分離維持ペア]',
      '主体A\t主体B\t強さ\t理由',
      'A_WORK\t品証検査員\thard\t異常発生側と検知阻止側で非対称',
      '[完了]',
    ].join('\n');

    const parsed = parseLaneConsolidationTSV(tsv, fineBase);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({
      id: 'M1',
      kind: 'peripheral_others',
      sourceEntityIds: ['O_CLIENT', 'O_CARRIER'],
      targetEntityId: 'subject_others',
      semanticCost: 0.05,
    });
    expect(parsed.candidates[1]).toMatchObject({
      id: 'M2',
      kind: 'role_group',
      sourceEntityIds: ['A_WORK', 'A_QA'],
      targetLabel: '現場・検査チーム',
    });
    expect(parsed.invalidLines.some((l) => l.startsWith('M_BAD'))).toBe(true);
    expect(parsed.separationConstraints).toEqual([
      {
        entityA: 'A_WORK',
        entityB: 'A_QA',
        severity: 'hard',
        reason: '異常発生側と検知阻止側で非対称',
      },
    ]);
  });

  it('completes fine-grained VTA first, crosses 2-item plateaus via hill-climbing (yp2l reproduction), retains D中継見張員 over 0-variation E作業員, and preserves fineGrainedBase', async () => {
    const source = [
      'p1 下請会社がF作業員・H・I・J作業員を派遣した。',
      'p2 A作業指揮者が東武鉄道株式会社へ電話点呼を実施した。',
      'p3 除草作業班でG現場代理人がC中継見張員・D中継見張員へ移動を指示した。',
      'p4 D中継見張員が配置を移動し、無線連絡が不通となった。',
      'p5 B列車見張員とF作業員が発言を自粛し、G現場代理人が線路内立入りを指示した。',
      'p6 B列車見張員が待避合図を出しE作業員・F作業員が待避し、A作業指揮者も視認待避した。',
      'p7 第1020列車運転士の列車とG現場代理人・H・I・J作業員が触車し死亡した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'O1\t東武鉄道株式会社\torganization\tmid\t-\tp2',
      'O2\t第1020列車乗務員\torganization\tmid\tO1\t-',
      'O3\t除草作業班\torganization\thigh\t-\tp3',
      'O4\t下請会社\torganization\tlow\t-\tp1',
      'A_driver\t第1020列車運転士\tperson\tmid\tO2\tp7',
      'A_lead\tA作業指揮者\tperson\thigh\tO3\tp2,p6',
      'A_rep\tG現場代理人\tperson\thigh\tO3\tp3,p5,p7',
      'A_watch_B\tB列車見張員\tperson\thigh\tO3\tp5,p6',
      'A_watch_C\tC中継見張員\tperson\tmid\tO3\tp3',
      'A_watch_D\tD中継見張員\tperson\tmid\tO3\tp3,p4',
      'A_wrk_E\tE作業員\tperson\tmid\tO3\tp6',
      'A_wrk_F\tF作業員\tperson\tmid\tO3\tp1,p5,p6',
      'A_wrk_HIJ\tH・I・J作業員\tperson\thigh\tO3\tp1,p7',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t当日朝\t作業員派遣\t下請会社がF・HIJ作業員を派遣した\tO4:actor,A_wrk_F:target,A_wrk_HIJ:target\tp1\trecorded',
      'E2\t09:00頃\t電話点呼実施\tA指揮者が東武鉄道へ電話点呼した\tA_lead:actor,O1:target\tp2\trecorded',
      'E3\t09:15頃\t中継移動指示\tG代理人がC・D中継見張員へ指示した\tA_rep:actor,A_watch_C:target,A_watch_D:target,O3:target\tp3\trecorded',
      'E4\t10:15頃\t中継配置離脱・無線不通\tD中継見張員が移動し無線不通となった\tA_watch_D:actor,O3:actor\tp4\trecorded',
      'E5\t10:42頃\t立入り指示と発言自粛\tG代理人が指示しB見張員・F作業員が自粛した\tA_rep:actor,A_watch_B:actor,A_wrk_F:actor,O3:actor\tp5\trecorded',
      'E6\t10:44頃\t待避合図と一部待避\tB見張員が合図しE・F作業員とA指揮者が待避した\tA_watch_B:actor,A_wrk_E:actor,A_wrk_F:actor,A_lead:actor\tp6\trecorded',
      'E7\t10:46頃\t列車触車・死亡\t運転士の列車とG代理人・HIJ作業員が触車し死亡した\tA_driver:actor,A_rep:affected,A_wrk_HIJ:affected\tp7\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      // Refined same-event transfer edges (reproducing Stage 3 refine=5 in yp2l!)
      'R1\ttransfer\tE1\tO4\tE1\tA_wrk_F\tp1\tperson\toccurred\tconfirmed',
      'R2\ttransfer\tE2\tA_lead\tE2\tO1\tp2\tinformation\toccurred\tconfirmed',
      'R3\ttransfer\tE3\tA_rep\tE4\tA_watch_D\tp3,p4\tinformation\toccurred\tconfirmed',
      'R4\timpact\tE4\tA_watch_D\tE5\tA_rep\tp4,p5\tother\toccurred\tna',
      'R5\timpact\tE5\tA_rep\tE7\tA_driver\tp5,p7\tother\toccurred\tna',
      'R6\ttransfer\tE5\tA_watch_B\tE6\tA_watch_B\tp5,p6\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O_out\tidentified\tE7:loss\tp7\t作業員4名触車死亡',
      '[仮判定]',
      'E1\tvariation\t見張員不足の派遣\tp1',
      'E2\tvariation\t対面ではなく電話点呼\tp2',
      'E3\tvariation\t中継見張員移動指示\tp3',
      'E4\tvariation\t中継不在・無線不通\tp4',
      'E5\tvariation\t線路内立入り指示\tp5',
      'E6\tvariation:resilient\t待避合図による一部待避\tp6',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineSchema = projectAnalysis(fineAnalysis);

    let llmCalls = 0;
    const mockCaller = async () => {
      llmCalls++;
      return {
        latencyMs: 25,
        content: [
          '[統合候補]',
          'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
          // Single-entity peripheral moves (tests 2-move plateau crossing into subject_others!)
          'M1\tperipheral_others\tO4\tsubject_others\tその他の関係者\tother\t0.04\t派遣手配のみの周辺組織',
          'M2\tperipheral_others\tO1\tsubject_others\tその他の関係者\tother\t0.05\t受動点呼先のみの周辺組織',
          'M3\tposet_rollup\tA_watch_C\tO3\t-\torganization\t0.05\t受動関与1件のみの中継見張員',
          'M4\tposet_rollup\tA_wrk_E\tO3\t-\torganization\t0.06\t固有変動0件でB見張員と待避を共にした随伴作業員',
          'M5\tposet_rollup\tA_wrk_F\tO3\t-\torganization\t0.18\t発言自粛を含む作業員',
          'M6\tposet_rollup\tA_watch_D\tO3\t-\torganization\t0.55\t中継離脱・無線不通の中核当事者（高コスト）',
          '[分離維持ペア]',
          '主体A\t主体B\t強さ\t理由',
          'A_rep\tA_watch_B\thard\t立入り指示側と待避合図側で対立',
          'A_driver\tA_rep\thard\t列車運転側と線路内被災側で非対称',
          '[完了]',
        ].join('\n'),
      };
    };

    const optRes = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 8 }
    );

    expect(llmCalls).toBe(1);
    expect(optRes.fineLaneCount).toBe(12);
    expect(optRes.finalLaneCount).toBe(8);

    const visibleLanes = visibleSchema(optRes.schema).lanes;
    expect(visibleLanes[0]).toBe('その他の関係者');
    // O1 & O4 folded into subject_others; C & E rolled up into O3; D中継見張員 stays retained!
    expect(optRes.consolidation.laneAssignment['O4']).toBe('subject_others');
    expect(optRes.consolidation.laneAssignment['O1']).toBe('subject_others');
    expect(optRes.consolidation.laneAssignment['A_watch_C']).toBe('O3');
    expect(optRes.consolidation.laneAssignment['A_wrk_E']).toBe('O3');
    expect(optRes.consolidation.laneAssignment['A_watch_D']).toBe('A_watch_D');
    expect(visibleLanes).toContain('D中継見張員');

    // Internal fine-grained VTA is preserved 100% intact (all 13 entities including 0-event O2)!
    expect(optRes.analysis.fineGrainedBase?.entities).toHaveLength(13);
    expect(optRes.analysis.fineGrainedBase?.relations).toHaveLength(6);

    // Zero missing relation projections in diagnostics!
    const diag = graphDiagnostics(optRes.schema);
    expect(diag.missingRelations).toEqual([]);

    // Save/Load validation preserves fineGrainedBase & laneConsolidation
    const roundTripped = validateSavedAnalysis(JSON.parse(JSON.stringify(optRes.analysis)));
    expect(roundTripped.fineGrainedBase?.entities).toHaveLength(13);
    expect(roundTripped.laneConsolidation?.targetMaxSubjects).toBe(8);

    // Re-optimizing to a tighter target (7 lanes) with reuseCachedCandidatesOnly uses 0 LLM calls!
    const reOptRes = await optimizeLaneConsolidation(
      dummyConfig,
      optRes.schema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 7, reuseCachedCandidatesOnly: true }
    );
    expect(llmCalls).toBe(1); // Still 1 — zero extra LLM tokens!
    expect(reOptRes.finalLaneCount).toBe(7);
  });

  it('bundles parallel inter-lane edges on consolidated views (`bundledRelationIds`) and absorbs cross-entity intra-lane sequential edges cleanly', () => {
    const source = [
      'p1 作業班のC担当とD担当がそれぞれ管制官Bへ連絡した。',
      'p2 C担当がD担当へ引き継ぎ、その後D担当が確認を実施した。',
    ].join('\n');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'O_TEAM\t現場作業班\torganization\thigh\t-\tp1,p2',
      'A_C\tC担当\tperson\tlow\tO_TEAM\tp1,p2',
      'A_D\tD担当\tperson\tlow\tO_TEAM\tp1,p2',
      'A_B\t管制官B\tperson\thigh\t-\tp1',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:00\t一斉連絡\tC担当とD担当が作業開始した\tO_TEAM:actor,A_C:actor,A_D:actor\tp1\trecorded',
      'E2\t10:05\t連絡受領\t管制官Bが連絡を受領した\tA_B:actor\tp1\trecorded',
      'E3\t10:10\t引継ぎ完了\tD担当が確認を実施した\tA_D:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      // Two distinct fine-grained relations that collapse onto the exact same card pair when A_C & A_D merge into O_TEAM
      'R_CB\ttransfer\tE1\tA_C\tE2\tA_B\tp1\tinformation\toccurred\tconfirmed',
      'R_DB\ttransfer\tE1\tA_D\tE2\tA_B\tp1\tmaterial\toccurred\tconfirmed',
      // Cross-entity relation A_C(E1) -> A_D(E3) that collapses into the same sequential lane O_TEAM
      'R_CD\ttransfer\tE1\tA_C\tE3\tA_D\tp2\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE3:near_miss\tp2\t確認完了',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(fineAnalysis);
    const fallback = generateStructuralFallbackCandidates(fineBase, fineAnalysis);

    const searched = searchOptimalLaneConsolidation(
      fineBase,
      fineAnalysis,
      fallback.candidates,
      fallback.separationConstraints,
      { targetMaxSubjects: 2 }
    );

    const schema = searched.bestSchema;
    expect(visibleSchema(schema).lanes).toEqual(['現場作業班', '管制官B']);

    // R_CB and R_DB are bundled into ONE single visual edge between E1(O_TEAM) and E2(A_B)
    const e1Node = schema.nodes.find((n) => n.lane === '現場作業班' && n.event_ids?.includes('E1'))!;
    const e2Node = schema.nodes.find((n) => n.lane === '管制官B' && n.event_ids?.includes('E2'))!;
    const crossEdges = schema.edges.filter(
      (e) =>
        (e.source === e1Node.id && e.target === e2Node.id) ||
        (e.source === e2Node.id && e.target === e1Node.id)
    );
    expect(crossEdges).toHaveLength(1);
    expect(crossEdges[0].bundledRelationIds).toEqual(expect.arrayContaining(['R_CB', 'R_DB']));
    expect(crossEdges[0].label).toContain('情報');
    expect(crossEdges[0].label).toContain('物・資機材');

    // R_CD (collapsed cross-entity intra-lane relation) is absorbed into O_TEAM's sequential spine without bowing arc
    const intraSemanticEdges = schema.edges.filter((e) => e.relationId === 'R_CD');
    expect(intraSemanticEdges).toHaveLength(0);
    expect(graphDiagnostics(schema).missingRelations).toEqual([]);

    // Deleting the bundled cross-edge on canvas cleanly removes both bundled relations from analysis & fineGrainedBase
    const editedSchema = {
      ...schema,
      edges: schema.edges.filter((e) => e.id !== crossEdges[0].id),
    };
    const reconciled = reconcileAnalysis(schema, editedSchema);
    expect(reconciled.analysis?.relations.some((r) => r.id === 'R_CB' || r.id === 'R_DB')).toBe(false);
    expect(reconciled.analysis?.fineGrainedBase?.relations.some((r) => r.id === 'R_CB' || r.id === 'R_DB')).toBe(false);
  });

  it('prevents CAPT_B/JAL subject_others hijacking, enforces P_sub(X -> Y) inclusion penalty on protagonists, and allows peer role_group (e07r reproduction)', async () => {
    const source = [
      'p1 A機（機長A・副操縦員A・整備員A）とB機（機長B・運航乗務員・客室乗務員・乗客）の事象概要。',
      'p2 外部資材課が物資手配を行い、基地担当が確認した。',
      'p3 副操縦員Aが無線復唱し、機長Aが進入許可と認識して滑走路へ進入した。',
      'p4 副操縦員Aと機長Aがチェックリスト確認後、滑走路上で待機した。',
      'p5 B機運航乗務員が着陸進入・手動操縦切替・接地操作を連続実施した。',
      'p6 両機が衝突し、B機客室乗務員と乗客が非常脱出し、機長Bが操縦交代と最終脱出確認を行った。',
      'p7 B機客室内が延焼し、外部消防隊が対応した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'JCG\t海上保安庁\torganization\thigh\t-\tp1',
      'JCG_BASE\t羽田基地担当\torganization\tmid\tJCG\tp2',
      'A_CREW\tA機乗組員\torganization\thigh\tJCG\tp1',
      'CAPT_A\t機長A\tperson\thigh\tA_CREW\tp1,p3,p4',
      'COP_A\t副操縦員A\tperson\thigh\tA_CREW\tp1,p3,p4',
      'MECH_A\t機上整備員A\tperson\tlow\tA_CREW\tp1',
      'JAL\t日本航空株式会社\torganization\thigh\t-\tp1,p7',
      'B_FLT_CREW\tB機運航乗務員\torganization\thigh\tJAL\tp1,p5',
      'CAPT_B\t機長B\tperson\thigh\tB_FLT_CREW\tp1,p6',
      'B_CABIN_CREW\tB機客室乗務員\torganization\thigh\tJAL\tp1,p6',
      'B_PAX\tB機乗客\tperson\thigh\tJAL\tp1,p6',
      'EXT_SUPPLY\t外部資材課\torganization\tlow\t-\tp2',
      'ARFF\t空港消防\torganization\tmid\t-\tp7',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t15:00\t物資手配\t外部資材課が手配し基地担当が受領した\tEXT_SUPPLY:actor,JCG_BASE:confirmed_recipient,JCG:actor\tp2\trecorded',
      'E2\t17:27\t承認復唱\t副操縦員Aが復唱し整備員Aが同席した\tCOP_A:actor,MECH_A:target,A_CREW:actor\tp1,p3\trecorded',
      'E3\t17:45\t進入許可認識\t機長Aが進入許可と認識し副操縦員Aが走行操作した\tCAPT_A:actor,COP_A:actor\tp3\trecorded',
      'E4\t17:46\t滑走路進入・停止\t副操縦員Aと機長Aが滑走路上で停止した\tCOP_A:actor,CAPT_A:actor\tp4\trecorded',
      'E5\t17:44\tB機着陸進入\tB機運航乗務員が着陸許可を受領した\tB_FLT_CREW:actor\tp5\trecorded',
      'E6\t17:45\tB機手動操縦切替\tB機運航乗務員が手動操縦へ切り替えた\tB_FLT_CREW:actor\tp5\trecorded',
      'E7\t17:46\tB機進入継続\tB機運航乗務員が進入を継続した\tB_FLT_CREW:actor\tp5\trecorded',
      'E8\t17:47\tB機接地操作\tB機運航乗務員が接地・逆噴射操作を行った\tB_FLT_CREW:actor\tp5\trecorded',
      'E9\t17:47:27\t両機衝突\t両機が衝突した\tA_CREW:affected,CAPT_A:affected,B_FLT_CREW:affected\tp6\trecorded',
      'E10\t17:47:33\tB機操縦交代と脱出開始\t機長Bが操縦交代し客室乗務員・乗客が脱出開始した\tCAPT_B:actor,B_FLT_CREW:actor,B_CABIN_CREW:actor,B_PAX:actor\tp6\trecorded',
      'E11\t17:58\tB機全員脱出完了\t機長Bの最終確認により全員脱出した\tCAPT_B:actor,B_CABIN_CREW:actor,B_PAX:affected\tp6\trecorded',
      'E12\t17:58\tB機客室内延焼と消火\t客室内が延焼し空港消防が消火にあたった\tJAL:affected,ARFF:target\tp7\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE1\tEXT_SUPPLY\tE1\tJCG_BASE\tp2\tmaterial\toccurred\tconfirmed',
      'R2\ttransfer\tE2\tCOP_A\tE3\tCAPT_A\tp3\tinformation\toccurred\tconfirmed',
      'R3\timpact\tE4\tCOP_A\tE9\tB_FLT_CREW\tp4,p6\tother\toccurred\tna',
      'R4\ttransfer\tE10\tB_FLT_CREW\tE10\tCAPT_B\tp6\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O_out\tidentified\tE9:loss,E11:recovery,E12:loss\tp6,p7\t衝突・延焼と全員脱出完了',
      '[仮判定]',
      'E2\tvariation\t復唱確認の齟齬\tp3',
      'E3\tvariation\t進入許可認識\tp3',
      'E4\tvariation\t滑走路上停止\tp4',
      'E10\tvariation:resilient\t非常脱出誘導開始\tp6',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineSchema = projectAnalysis(fineAnalysis);

    const mockCaller = async () => ({
      latencyMs: 20,
      content: [
        '[統合候補]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        // Good subordinate & peer group merges:
        'M1\tposet_rollup\tJCG_BASE\tJCG\t-\torganization\t0.05\t基地受領担当を親組織へ統合',
        'M2\tposet_rollup\tMECH_A\tA_CREW\t-\torganization\t0.04\t同席のみの整備員を統合',
        'M3\trole_group\tB_CABIN_CREW,B_PAX\t-\tB機客室・乗客\tperson\t0.08\t客室脱出の同質ロール束ね',
        // Mixed peripheral_others bundle containing ineligible JAL (:loss affected & focus=high) alongside eligible EXT_SUPPLY & ARFF!
        'M4\tperipheral_others\tJAL,EXT_SUPPLY,ARFF\tsubject_others\tその他の関係者\tother\t0.06\t周辺組織の集約',
        // Trap 1: Attempted leapfrog CAPT_B -> JAL even at tiny LLM cost
        'M5\tposet_rollup\tCAPT_B\tJAL\t-\torganization\t0.05\t機長Bを法人へ直接統合（不適切）',
        // Trap 2: Under-priced protagonist merges X -> Y (should be blocked by P_sub(X -> Y)!)
        'M6\tposet_rollup\tCOP_A\tA_CREW\t-\torganization\t0.05\t過小評価された副操縦員Aの統合',
        'M7\tposet_rollup\tB_FLT_CREW\tJAL\t-\torganization\t0.05\t1イベント親法人への主従逆転統合',
        // Trap 3: Disguised role_group mixing child CAPT_A with ancestor A_CREW
        'M8\trole_group\tCAPT_A,A_CREW\t-\tA機操縦チーム\torganization\t0.05\t親子混在の擬似role_group',
        '[分離維持ペア]',
        '主体A\t主体B\t強さ\t理由',
        '[完了]',
      ].join('\n'),
    });

    const optRes = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );

    const assign = optRes.consolidation.laneAssignment;
    // 1. JAL and CAPT_B are NEVER hijacked into subject_others; EXT_SUPPLY & ARFF are salvaged into subject_others!
    expect(assign['JAL']).not.toBe('subject_others');
    expect(assign['CAPT_B']).not.toBe('subject_others');
    expect(assign['EXT_SUPPLY']).toBe('subject_others');
    expect(assign['ARFF']).toBe('subject_others');

    // 2. Peer role_group B_CABIN_CREW + B_PAX -> group_B機客室_乗客 succeeds cleanly!
    expect(assign['B_CABIN_CREW']).toBe(assign['B_PAX']);
    expect(visibleSchema(optRes.schema).lanes).toContain('B機客室・乗客');

    // 3. Inclusion penalty P_sub(X -> Y) protects CAPT_A, COP_A, and B_FLT_CREW despite 0.05 LLM cost traps!
    expect(assign['CAPT_A']).toBe('CAPT_A');
    expect(assign['COP_A']).toBe('COP_A');
    expect(assign['B_FLT_CREW']).toBe('B_FLT_CREW');

    // 4. C2 stays healthy (> 0.70) under convex per-move cost instead of collapsing to 0.24!
    expect(optRes.consolidation.metrics.c2).toBeGreaterThan(0.7);
  });

  it('rejects non-homogeneous supervisor+workers role_group M10 (9yqp reproduction) via virtual-group cost parity and P_group, keeping G現場代理人 distinct from H・I・J作業員', async () => {
    const source = [
      'p1 下請会社がF作業員とH・I・J作業員を派遣した。',
      'p2 A作業指揮者が東武鉄道と北関東工務事務所へ連絡し、G現場代理人へ指揮任務を委ねた。',
      'p3 G現場代理人が再打合せ未実施のまま踏切道移動・作業開始・立入指示を単独で出した。',
      'p4 B列車見張員がD中継見張員・C中継見張員と進来確認し、G現場代理人へ3分前伝達を行った。',
      'p5 B列車見張員の合図でE作業員・F作業員が待避し、A作業指揮者も待避した。',
      'p6 G現場代理人とH・I・J作業員が静止し、当該列車運転士の列車と触車して死亡した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'tobu\t東武鉄道株式会社\torganization\thigh\t-\tp2',
      'kitakanto\t東武鉄道北関東工務事務所\torganization\tmid\ttobu\tp2',
      'driver\t当該列車運転士\tperson\tmid\ttobu\tp6',
      'subcon\t下請会社\torganization\tmid\t-\tp1',
      'work_team\t除草薬散布作業班\torganization\thigh\t-\tp3',
      'leader_a\tA作業指揮者\tperson\thigh\twork_team\tp2,p5',
      'lookout_b\tB列車見張員\tperson\thigh\twork_team\tp4,p5',
      'relay_c\tC中継見張員\tperson\tmid\twork_team\tp4',
      'relay_d\tD中継見張員\tperson\tmid\twork_team\tp4',
      'worker_e\tE作業員\tperson\tmid\twork_team\tp5',
      'worker_f\tF作業員\tperson\tmid\twork_team\tp1,p5',
      'rep_g\tG現場代理人\tperson\thigh\twork_team\tp2,p3,p4,p6',
      'workers_hij\tH・I・J作業員\tperson\thigh\twork_team\tp1,p6',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t当日朝\t作業員派遣\t下請会社が派遣した\tsubcon:actor,worker_f:affected,workers_hij:affected\tp1\trecorded',
      'E2\t09:00頃\t電話点呼と事務所連絡\tA指揮者が連絡した\tleader_a:actor,tobu:target,kitakanto:target\tp2\trecorded',
      'E4\t09:00頃\t現場入り未報告\tA指揮者が未報告\tleader_a:actor,rep_g:target\tp2\trecorded',
      'E6\t朝礼時\t踏切道移動指示\tG代理人が移動指示した\trep_g:actor,work_team:target\tp3\trecorded',
      'E7\t10:15頃\t作業開始指示\tG代理人が開始指示した\trep_g:actor,work_team:target\tp3\trecorded',
      'E8\t10:15頃\t指揮任務委ね\tA指揮者がG代理人へ委ねた\tleader_a:actor,rep_g:target\tp2\trecorded',
      'E11\t10:30頃\t再打合せ未実施\tG代理人が未実施で継続した\trep_g:actor,work_team:actor\tp3\trecorded',
      'E12\t10:30頃\t立入確認未実施\tG代理人が未確認とした\trep_g:actor,work_team:actor\tp3\trecorded',
      'E13\t10:42頃\t3分前伝達\tB見張員がG代理人へ伝達した\tlookout_b:actor,rep_g:target\tp4\trecorded',
      'E14\t10:42頃\t線路内立入指示\tG代理人が立入指示した\trep_g:actor,lookout_b:actor,work_team:actor\tp3\trecorded',
      'E16\t10:42頃\t発言遠慮\tF作業員が遠慮した\tworker_f:actor\tp5\trecorded',
      'E19\t10:44頃\t進来確認・鳴動報告\tB見張員とC・D中継見張員が確認した\tlookout_b:actor,relay_c:actor,relay_d:actor\tp4\trecorded',
      'E20\t10:45頃\t待避合図・待避\tB見張員が合図しE・F作業員が待避した\tlookout_b:actor,worker_e:actor,worker_f:actor\tp5\trecorded',
      'E22\t10:46頃\t静止\tG代理人とHIJ作業員が静止した\trep_g:actor,workers_hij:actor\tp6\trecorded',
      'E26\t10:46頃\t列車触車\t運転士の列車と触車した\tdriver:actor,rep_g:affected,workers_hij:affected\tp6\trecorded',
      'E28\t-\t4名死亡確認\t死亡が確認された\trep_g:affected,workers_hij:affected\tp6\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE8\tleader_a\tE8\trep_g\tp2\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE13\tlookout_b\tE13\trep_g\tp4\tinformation\toccurred\tconfirmed',
      'R3\timpact\tE26\tdriver\tE26\trep_g\tp6\tother\toccurred\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O_out\tidentified\tE26:loss,E28:loss\tp6\t触車および4名死亡',
      '[仮判定]',
      'E4\tvariation\t未報告\tp2',
      'E6\tvariation\t移動指示\tp3',
      'E8\tvariation\t任務委ね\tp2',
      'E11\tvariation\t再打合せ未実施\tp3',
      'E12\tvariation\t立入確認未実施\tp3',
      'E14\tvariation\t立入指示\tp3',
      'E16\tvariation\t発言遠慮\tp5',
      'E20\tvariation:resilient\t待避合図\tp5',
      'E22\tvariation\t静止\tp6',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineSchema = projectAnalysis(fineAnalysis);

    const mockCaller = async () => ({
      latencyMs: 20,
      content: [
        '[統合候補]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M1\tposet_rollup\tkitakanto\ttobu\t-\torganization\t0.05\t工務事務所を本社へ統合',
        'M8\tposet_rollup\trelay_c,relay_d\twork_team\t-\torganization\t0.18\t中継見張員を作業班へ統合',
        'M9\tposet_rollup\tworker_e\twork_team\t-\torganization\t0.06\t随伴待避作業員を作業班へ統合',
        // Trap M10 from 9yqp: conflating site supervisor rep_g (8 solo command/variation events) with workers_hij!
        'M10\trole_group\trep_g,workers_hij\t-\t触車被災者群（現場代理人・H・I・J）\tperson\t0.38\t被災結果の共有による統合（不適切）',
        '[分離維持ペア]',
        '主体A\t主体B\t強さ\t理由',
        '[完了]',
      ].join('\n'),
    });

    const optRes = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );

    const assign = optRes.consolidation.laneAssignment;
    const lanes = visibleSchema(optRes.schema).lanes;

    // G現場代理人 (rep_g) and H・I・J作業員 (workers_hij) are NEVER merged into "触車被災者群"!
    expect(assign['rep_g']).toBe('rep_g');
    expect(assign['workers_hij']).toBe('workers_hij');
    expect(lanes).toContain('G現場代理人');
    expect(lanes).toContain('H・I・J作業員');
    expect(lanes).not.toContain('触車被災者群（現場代理人・H・I・J）');
  });

  it('supports multi-axis Poset DAG, LLM [推奨統合] natural upper-subject selection, and 2-stage 0-event hub rollup via [予備候補] (8pm4 resolution)', async () => {
    const { buildLaneConsolidationUserPrompt } = await import('./laneConsolidationOptimizer');
    const source = [
      'p1 東武鉄道日光線新鹿沼駅構内における除草薬散布作業中の列車触車事故。',
      'p2 北関東工務事務所が発注し、下請会社から派遣されたF作業員が除草薬散布作業班に参加した。',
      'p3 除草薬散布作業班（A作業指揮者、B列車見張員、C・D中継見張員、G現場代理人、E・F作業員、H・I・J作業員）が現場に入った。',
      'p4 C中継見張員とD中継見張員が中継見張配置についた。',
      'p5 E作業員とF作業員が法面で補助作業を行い、列車接近時に待避した。',
      'p6 G現場代理人が散布指示を出し、B列車見張員が接近合図を送ったがH・I・J作業員に伝わらなかった。',
      'p7 当該運転士が非常制動をかけたがG現場代理人とH・I・J作業員に列車が触車した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t東武鉄道株式会社\torganization\thigh\t-\tp1',
      'A14\t東武鉄道北関東工務事務所\torganization\tmid\tA1\t-',
      'A3\t下請会社\torganization\tlow\t-\t-',
      // A2 is an external contractor work team (NOT a child of A1!)
      'A2\t除草薬散布作業班\torganization\thigh\t-\tp1,p3',
      // 0-event intermediate role hub under A2
      'G_RELAY\t中継見張員\torganization\tmid\tA2\t-',
      'A4\tA作業指揮者\tperson\thigh\tA2\tp3',
      'A5\tB列車見張員\tperson\thigh\tA2\tp3,p6',
      'A6\tC中継見張員\tperson\tmid\tG_RELAY\t-',
      'A7\tD中継見張員\tperson\tmid\tG_RELAY\t-',
      'A8\tG現場代理人\tperson\thigh\tA2\tp3,p6,p7',
      'A9\tE作業員\tperson\tmid\tA2\t-',
      // Multi-parent Poset: F作業員 belongs to BOTH A3 (employment axis) and A2 (operational team axis)!
      'A10\tF作業員\tperson\tmid\tA3,A2\t-',
      'A11\tH・I・J作業員\tperson\thigh\tA2\tp3,p6,p7',
      'A13\t当該運転士\tperson\thigh\tA1\tp7',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t08:00\t発注と派遣契約\t工務事務所が発注し下請会社がF作業員を派遣手配した\tA1:actor,A14:actor,A3:target\tp2\trecorded',
      'E2\t09:00\t現場入場・点呼\t作業班が入場しA作業指揮者が点呼した\tA2:actor,A4:actor\tp3\trecorded',
      'E3\t10:00\t中継見張配置\tC中継見張員とD中継見張員が配置についた\tA6:actor,A7:actor\tp4\trecorded',
      'E4\t10:30\t法面作業と待避\tE作業員とF作業員が作業・待避した\tA9:actor,A10:actor\tp5\trecorded',
      'E5\t10:44\t散布指示\tG現場代理人がH・I・J作業員へ指示した\tA8:actor,A11:confirmed_recipient\tp6\trecorded',
      'E6\t10:45\t接近合図\tB列車見張員がD中継見張員へ合図を送った\tA5:actor,A7:intended_recipient\tp6\trecorded',
      'E7\t10:46\t非常制動と触車\t当該運転士が制動したがG現場代理人とH・I・J作業員が触車した\tA13:actor,A8:affected,A11:affected\tp7\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE1\tA14\tE1\tA3\tp2\tinformation\toccurred\tconfirmed',
      'R_cmd\ttransfer\tE2\tA4\tE3\tA6\tp3,p4\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE5\tA8\tE5\tA11\tp6\tinformation\toccurred\tconfirmed',
      'R3\ttransfer\tE6\tA5\tE6\tA7\tp6\tinformation\toccurred\tunconfirmed',
      'R4\timpact\tE6\tA5\tE7\tA13\tp6,p7\tother\toccurred\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE7:loss\tp7\t列車触車',
      '[仮判定]',
      'E3\tvariation\t中継見張の位置選定\tp4',
      'E5\tvariation\t見張り中断中の散布指示\tp6',
      'E6\tvariation\t接近合図の不達\tp6',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(fineAnalysis);
    const userPrompt = buildLaneConsolidationUserPrompt(fineBase, fineAnalysis, 8);
    expect(userPrompt).toContain('[上位主体ハブと包摂可能な下位主体一覧]');
    expect(userPrompt).toContain('G_RELAY\t中継見張員');
    expect(userPrompt).toContain('A3,A2');

    const fineSchema = projectAnalysis(fineAnalysis);
    let llmCalls = 0;
    const mockCaller = async () => {
      llmCalls++;
      return {
        latencyMs: 18,
        content: [
          '[推奨統合]',
          'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
          'M1\tposet_rollup\tA14\tA1\t-\torganization\t0.04\t社内事業所を東武鉄道へ統合',
          // Natural axis choice: F作業員 (A10) & E作業員 (A9) roll into A2 (on-site work team), NOT A3!
          'M2\tposet_rollup\tA9,A10\tA2\t-\torganization\t0.06\t補助・待避作業員を現場の除草薬散布作業班へ統合',
          // Natural 0-event role hub choice: C,D -> G_RELAY (中継見張員)
          'M3\tposet_rollup\tA6,A7\tG_RELAY\t-\torganization\t0.08\tC・D中継見張員を上位職能ハブ「中継見張員」へ統合',
          '[予備候補]',
          'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
          // 2nd-stage rollup of 0-event hub G_RELAY into parent A2 when tighter lane limit is requested!
          'M4\tposet_rollup\tG_RELAY\tA2\t-\torganization\t0.20\t列数上限がさらに小さい場合に中継見張員を作業班へ統合',
          '[分離維持ペア]',
          '主体A\t主体B\t強さ\t理由',
          'A8\tA11\thard\t現場指揮者と被指示作業員で役割が非対称なため',
          '[完了]',
        ].join('\n'),
      };
    };

    // 1) At targetMaxSubjects = 9, [推奨統合] selects A2 for F作業員 and materializes G_RELAY (中継見張員)
    const res9 = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 9 }
    );
    expect(llmCalls).toBe(1);
    const assign9 = res9.consolidation.laneAssignment;
    expect(assign9['A10']).toBe('A2'); // Operational team axis chosen over subcontractor A3
    expect(assign9['A6']).toBe('G_RELAY');
    expect(assign9['A7']).toBe('G_RELAY');
    expect(visibleSchema(res9.schema).lanes).toContain('中継見張員');
    expect(visibleSchema(res9.schema).lanes).toContain('除草薬散布作業班');

    // 2) Lowering slider to targetMaxSubjects = 8 with cached candidates executes 2-stage rollup G_RELAY -> A2 (0 LLM calls!)
    const res8 = await optimizeLaneConsolidation(
      dummyConfig,
      res9.schema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 8, reuseCachedCandidatesOnly: true }
    );
    expect(llmCalls).toBe(1);
    expect(res8.consolidation.laneAssignment['A6']).toBe('A2');
    expect(res8.consolidation.laneAssignment['A7']).toBe('A2');
    expect(visibleSchema(res8.schema).lanes).not.toContain('中継見張員');
    expect(visibleSchema(res8.schema).lanes).toHaveLength(8);
  });

  it('respects LLM [推奨統合] upper-subject bundling along outcome/cohort Poset axis even for high-focus :loss :affected subjects', async () => {
    const source = [
      'p1 作業指揮者Xが指示を出し、被災群（甲・乙）が被災し、待避群（丙・丁）が待避完了した。',
    ].join('\n');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'CMD\t作業指揮者X\tperson\thigh\t-\tp1',
      'HUB_VIC\t被災作業員群\torganization\thigh\t-\tp1',
      'HUB_SURV\t待避作業員群\torganization\tmid\t-\t-',
      'VIC_A\t作業員甲\tperson\thigh\tHUB_VIC\tp1',
      'VIC_B\t作業員乙\tperson\thigh\tHUB_VIC\tp1',
      'SURV_C\t作業員丙\tperson\tmid\tHUB_SURV\t-',
      'SURV_D\t作業員丁\tperson\tmid\tHUB_SURV\t-',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:00\t作業指示\t作業指揮者Xが全員に指示した\tCMD:actor,VIC_A:confirmed_recipient,VIC_B:confirmed_recipient,SURV_C:confirmed_recipient,SURV_D:confirmed_recipient\tp1\trecorded',
      'E2\t10:05\t退避完了\t丙・丁が待避した\tSURV_C:actor,SURV_D:actor\tp1\trecorded',
      'E3\t10:06\t被災発生\t甲・乙が被災した\tVIC_A:affected,VIC_B:affected\tp1\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE1\tCMD\tE2\tSURV_C\tp1\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE1\tCMD\tE3\tVIC_A\tp1\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE3:loss\tp1\t被災発生',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineSchema = projectAnalysis(fineAnalysis);
    const mockCaller = async () => ({
      latencyMs: 12,
      content: [
        '[推奨統合]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M1\tposet_rollup\tVIC_A,VIC_B\tHUB_VIC\t-\torganization\t0.06\t帰結軸で同一行動・同一被災の被災作業員群へ統合',
        'M2\tposet_rollup\tSURV_C,SURV_D\tHUB_SURV\t-\torganization\t0.05\t帰結軸で待避作業員群へ統合',
        '[予備候補]',
        '[分離維持ペア]',
        'CMD\tHUB_VIC\thard\t指示側と被災側の分離',
        '[完了]',
      ].join('\n'),
    });

    const res = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 3 }
    );
    expect(visibleSchema(res.schema).lanes).toEqual(['作業指揮者X', '被災作業員群', '待避作業員群']);
  });

  it('enforces Poset Antichain completeness (HG2c) on 0-event team hubs, unifies V-shaped man-machine composite subjects, and allows full team rollup at coarse limits (emhu resolution, ADR-0084)', async () => {
    const { buildSubjectOthersEligibilitySet } = await import('./laneConsolidationOptimizer');
    const source = [
      'p1 東武鉄道日光線新鹿沼駅構内における除草薬散布作業中の列車触車事故。',
      'p2 下請会社がF作業員・H・I・J作業員を派遣し、北関東工務事務所とA作業指揮者が点呼した。',
      'p3 A作業指揮者とG現場代理人がC・D中継見張員、E・F作業員、H・I・J作業員に指示した。',
      'p4 B列車見張員が合図しE・F作業員が待避した。',
      'p5 運転士が減速・待避完了判断を行い、第1020列車がG現場代理人・H・I・J作業員に触車し、運転士が非常停止手配を行った。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t東武鉄道\torganization\thigh\t-\tp1',
      'A2\t北関東工務事務所\torganization\tmid\tA1\t-',
      // V-shaped Man-Machine composite upper subject (0 direct events): A3 < U_TRAIN, A4 < U_TRAIN < A1
      'U_TRAIN\t運転士が操作する第1020列車\torganization\thigh\tA1\tp1,p5',
      'A3\t第1020列車\tmachine\tmid\tU_TRAIN\t-',
      'A4\t運転士\tperson\tmid\tU_TRAIN\t-',
      'A5\t下請会社\torganization\tmid\t-\t-',
      // Pure 0-event upper work-team hub (0 direct events!) + 0-event intermediate sub-role hubs
      'A6\t除草薬散布作業班\torganization\thigh\t-\tp1,p3',
      'G_RELAY\t中継見張員\torganization\tmid\tA6\t-',
      'G_EVAC\t待避作業員\torganization\tmid\tA6\t-',
      'A7\tG現場代理人\tperson\thigh\tA6\tp3,p5',
      'A8\tA作業指揮者\tperson\thigh\tA6\tp2,p3',
      'A9\tB列車見張員\tperson\thigh\tA6\tp4',
      'A10\tC中継見張員\tperson\tmid\tG_RELAY\t-',
      'A11\tD中継見張員\tperson\tmid\tG_RELAY\t-',
      'A12\tE作業員\tperson\tmid\tG_EVAC\t-',
      'A13\tF作業員\tperson\tmid\tA5,G_EVAC\t-',
      'A14\tH・I・J作業員\tperson\thigh\tA5,A6\tp2,p3,p5',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t08:00\t作業員派遣\t下請会社がF・HIJ作業員を派遣した\tA5:actor,A13:target,A14:target\tp2\trecorded',
      'E2\t09:00\t電話点呼\tA作業指揮者が東武鉄道・北関東工務事務所へ点呼した\tA8:actor,A1:target,A2:target\tp2\trecorded',
      'E3\t10:00\t配置・作業指示\tG現場代理人がC・D中継見張員とH・I・J作業員へ指示した\tA7:actor,A10:target,A11:target,A14:target\tp3\trecorded',
      'E4\t10:42\t待避合図と待避\tB列車見張員が合図しE・F作業員が待避した\tA9:actor,A12:actor,A13:actor\tp4\trecorded',
      'E5\t10:46\t減速・待避完了判断\t運転士が減速し待避完了と判断した\tA4:actor\tp5\trecorded',
      'E6\t10:46\t触車\t第1020列車がG現場代理人・H・I・J作業員に触車した\tA3:actor,A7:affected,A14:affected\tp5\trecorded',
      'E7\t10:46\t非常停止手配\t運転士が第1020列車に非常ブレーキをかけた\tA4:actor,A3:target\tp5\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE1\tA5\tE1\tA13\tp2\tperson\toccurred\tconfirmed',
      'R2\ttransfer\tE2\tA8\tE2\tA2\tp2\tinformation\toccurred\tconfirmed',
      'R3\ttransfer\tE3\tA7\tE3\tA11\tp3\tinformation\toccurred\tconfirmed',
      'R4\ttransfer\tE4\tA9\tE4\tA12\tp4\tinformation\toccurred\tconfirmed',
      'R5\timpact\tE5\tA4\tE6\tA3\tp5\tother\toccurred\tna',
      'R6\timpact\tE7\tA4\tE7\tA3\tp5\tother\toccurred\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE6:loss\tp5\t触車',
      '[仮判定]',
      'E1\tvariation\t見張員不足の派遣\tp2',
      'E3\tvariation\t中継移動指示\tp3',
      'E5\tvariation\t待避完了判断\tp5',
      'E7\tvariation:resilient\t非常停止手配\tp5',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(fineAnalysis);
    const eligibleOthers = buildSubjectOthersEligibilitySet(fineBase, fineAnalysis);
    // 1-card mid-focus organization A5 (whose single event E1 co-participates with A13, A14) is eligible for subject_others
    expect(eligibleOthers.has('A5')).toBe(true);

    const fineSchema = projectAnalysis(fineAnalysis);
    const mockCaller = async () => ({
      latencyMs: 15,
      content: [
        '[推奨統合]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M1\tposet_rollup\tA2\tA1\t-\torganization\t0.04\t工務事務所を東武鉄道へ統合',
        // Man-machine V-shaped Poset rollup: A3 (列車) + A4 (運転士) -> U_TRAIN (運転士が操作する第1020列車)
        'M2\tposet_rollup\tA3,A4\tU_TRAIN\t-\torganization\t0.05\t運転士と車両を複合上位主体へ一体統合',
        // Complete intermediate 0-event hub rollups (Antichain preserved!)
        'M3\tposet_rollup\tA10,A11\tG_RELAY\t-\torganization\t0.06\tC・D中継見張員を中継見張員ハブへ統合',
        'M4\tposet_rollup\tA12,A13\tG_EVAC\t-\torganization\t0.08\tE・F作業員を待避作業員ハブへ統合',
        '[予備候補]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        // Trap P_BAD: partial rollup of only C,D,E into 0-event parent A6 (除草薬散布作業班) while G,A,B,F,HIJ stay separate!
        'P_BAD\tposet_rollup\tA10,A11,A12\tA6\t-\torganization\t0.03\t部分統合による親子並立（HG2cで棄却されるべき）',
        'P1\trole_group\tG_RELAY,G_EVAC\t-\t中継見張員・待避作業員\torganization\t0.16\t補助メンバー群の束ね',
        'P2\trole_group\tA1,A5\t-\t東武鉄道・下請会社\torganization\t0.22\t事前手配・管理組織の束ね',
        // Coarse all-member rollup into A6 (only valid when ALL active descendants A7..A14 map to A6!)
        'P3\tposet_rollup\tA7,A8,A9,A10,A11,A12,A13,A14\tA6\t-\torganization\t0.42\t極小列数時に全班員を除草薬散布作業班へ全統合',
        '[分離維持ペア]',
        '主体A\t主体B\t強さ\t理由',
        'A7\tU_TRAIN\thard\t線路内被災側と列車側の分離',
        '[完了]',
      ].join('\n'),
    });

    const res7 = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );
    const assign7 = res7.consolidation.laneAssignment;
    const lanes7 = visibleSchema(res7.schema).lanes;

    // 1) Man-Machine composite lane unifies A3 (第1020列車) & A4 (運転士) despite R5/R6 impact & E6 :loss :actor!
    expect(assign7['A3']).toBe('U_TRAIN');
    expect(assign7['A4']).toBe('U_TRAIN');
    expect(lanes7).toContain('運転士が操作する第1020列車');
    expect(lanes7).not.toContain('第1020列車');
    expect(lanes7).not.toContain('運転士');

    // 2) HG2c strictly prevents A6 (除草薬散布作業班) from coexisting alongside its unmerged children A7, A8, A9, A14!
    expect(lanes7).not.toContain('除草薬散布作業班');
    expect(lanes7).toContain('G現場代理人');
    expect(lanes7).toContain('H・I・J作業員');
    expect(lanes7).toHaveLength(7);

    // 3) At coarse targetMaxSubjects = 3 (0 LLM calls), ALL A7..A14 roll up into A6 (除草薬散布作業班) cleanly!
    const res3 = await optimizeLaneConsolidation(
      dummyConfig,
      res7.schema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 3, reuseCachedCandidatesOnly: true }
    );
    const lanes3 = visibleSchema(res3.schema).lanes;
    expect(lanes3).toHaveLength(3);
    expect(lanes3).toContain('除草薬散布作業班');
    expect(lanes3).toContain('運転士が操作する第1020列車');
  });

  it('merges man-machine pair into 0-event hub even after buildFineGrainedWorkingAnalysis strips entity.parentEntityIds, and prevents FB_* partial person rollup (b4k9 reproduction)', async () => {
    const { buildFineGrainedWorkingAnalysis } = await import('./laneConsolidationOptimizer');
    const source = [
      'p1 下請会社がF・HIJ作業員を派遣し、北関東工務事務所へ点呼した。',
      'p2 A作業指揮者とG現場代理人が指示し、C・D中継見張員とE・F作業員が行動した。',
      'p3 当該運転士が減速進入し、当該列車がG現場代理人・H・I・J作業員に触車し、当該運転士が非常停止した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t東武鉄道\torganization\thigh\t-\tp1',
      'A2\t下請会社\torganization\tmid\t-\t-',
      'A3\t除草薬散布作業班\torganization\thigh\t-\tp2',
      'A4\tA作業指揮者\tperson\thigh\tA3\tp1,p2',
      'A6\tC中継見張員\tperson\tmid\tA3\t-',
      'A7\tD中継見張員\tperson\tmid\tA3\t-',
      'A8\tE作業員\tperson\tmid\tA3\t-',
      'A9\tF作業員\tperson\thigh\tA2,A3\tp1,p2',
      'A10\tG現場代理人\tperson\thigh\tA3\tp2,p3',
      'A11\tH・I・J作業員\tperson\thigh\tA2,A3\tp1,p3',
      'A12\t第1020列車編成\tother\thigh\tA1\tp3',
      'A13\t当該運転士\tperson\thigh\tA12\tp3',
      'A15\t当該列車（車両）\tmachine\thigh\tA12\tp3',
      'A16\t東武鉄道北関東工務事務所\torganization\tmid\tA1\t-',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t08:00\t派遣\t下請会社が派遣した\tA2:actor,A9:target,A11:target\tp1\trecorded',
      'E2\t09:00\t点呼\tA作業指揮者が点呼した\tA4:actor,A16:target\tp1\trecorded',
      // Even if A3 accidentally received a passive :target card, FB_* must NOT partially dump A6/A7 into A3!
      'E3\t09:30\t朝礼指示\tA作業指揮者が指示した\tA4:actor,A3:target,A6:actor,A7:actor\tp2\trecorded',
      'E4\t10:42\t作業員待避\tE・F作業員が待避した\tA8:actor,A9:actor\tp2\trecorded',
      'E5\t10:45\t進入指示\tG現場代理人がH・I・J作業員と進入した\tA10:actor,A11:actor\tp2\trecorded',
      'E6\t10:46\t減速進入\t当該運転士と当該列車が減速進入した\tA13:actor,A15:actor\tp3\trecorded',
      'E7\t10:46\t列車触車\t当該列車が触車した\tA15:actor,A10:affected,A11:affected\tp3\trecorded',
      'E8\t10:46\t異音感知・非常停止\t当該運転士が非常停止させた\tA13:actor,A15:target\tp3\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE1\tA2\tE1\tA9\tp1\tperson\toccurred\tconfirmed',
      'R2\ttransfer\tE2\tA4\tE2\tA16\tp1\tinformation\toccurred\tconfirmed',
      'R3\ttransfer\tE3\tA4\tE4\tA8\tp2\tinformation\toccurred\tconfirmed',
      'R4\ttransfer\tE3\tA7\tE5\tA10\tp2\tinformation\toccurred\tconfirmed',
      'R5\timpact\tE6\tA13\tE7\tA15\tp3\tother\toccurred\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE7:loss\tp3\t列車触車',
      '[仮判定]',
      'E1\tvariation\t派遣\tp1',
      'E5\tvariation\t進入指示\tp2',
      'E8\tvariation:resilient\t非常停止\tp3',
      '[完了]',
    ].join('\n');

    const rawAnalysis = buildFineAnalysis(ledger, source);
    const initialFineBase = captureFineGrainedBase(rawAnalysis);
    // Simulate Stage 1 working analysis (which strips parentEntityIds pointing to 0-event A1 and A12!)
    const stage1Working = buildFineGrainedWorkingAnalysis(rawAnalysis, initialFineBase);
    expect(stage1Working.entities.find((e) => e.id === 'A13')?.parentEntityIds).toBeUndefined();
    expect(stage1Working.entities.find((e) => e.id === 'A15')?.parentEntityIds).toBeUndefined();

    // Recombine entities with 0-event hubs A1 & A12 WITHOUT restoring parentEntityIds on A13/A15 (testing SubjectPoset resilience in evaluateMergeGuard!)
    const strippedCombinedAnalysis = {
      ...stage1Working,
      fineGrainedBase: {
        entities: [
          ...stage1Working.entities,
          ...initialFineBase.entities.filter((e) => !stage1Working.entities.some((w) => w.id === e.id)),
        ],
        participations: stage1Working.participations,
        relations: stage1Working.relations,
        cards: stage1Working.cards,
        subjectPoset: initialFineBase.subjectPoset,
      },
    };
    const workingSchema = projectAnalysis(strippedCombinedAnalysis);

    const mockCaller = async () => ({
      latencyMs: 12,
      content: [
        '[推奨統合]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M1\tposet_rollup\tA13,A15\tA12\t-\tother\t0.05\t運転士と車両を第1020列車編成へ統合',
        'M2\trole_group\tA6,A7\t-\t中継見張員（C・D）\tperson\t0.08\t中継見張員の統合',
        'M3\trole_group\tA8,A9\t-\t待避作業員（E・F）\tperson\t0.12\t待避作業員の統合',
        'M4\tperipheral_others\tA2,A16\tsubject_others\tその他の関係者\tother\t0.06\t周辺組織の集約',
        '[予備候補]',
        '[分離維持ペア]',
        '[完了]',
      ].join('\n'),
    });

    const optRes = await optimizeLaneConsolidation(
      dummyConfig,
      workingSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 8 }
    );
    const assign = optRes.consolidation.laneAssignment;
    const lanes = visibleSchema(optRes.schema).lanes;

    // 1) A13 & A15 cleanly unify into A12 (第1020列車編成) even when entity.parentEntityIds was stripped!
    expect(assign['A13']).toBe('A12');
    expect(assign['A15']).toBe('A12');
    expect(lanes).toContain('第1020列車編成');

    // 2) C & D stay in 中継見張員（C・D） instead of being hijacked into A3 by FB_*!
    expect(assign['A6']).not.toBe('A3');
    expect(assign['A7']).not.toBe('A3');
    expect(lanes).toContain('中継見張員（C・D）');
  });
});
