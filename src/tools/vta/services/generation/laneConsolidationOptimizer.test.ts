import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  captureFineGrainedBase,
  generateStructuralFallbackCandidates,
  optimizeLaneConsolidation,
  parseLaneConsolidationTSV,
  searchOptimalLaneConsolidation,
} from './laneConsolidationOptimizer';
import {
  assertProjectedEntitiesPartition,
  isPeripheralAggregateId,
} from '../../features/vta/utils/subjectCompositeForest';
import { inspectLedger, parseLedger } from '../../features/vta/utils/eventLedger';
import {
  projectAnalysis,
  reconcileAnalysis,
  sourceFromText,
  validateSavedAnalysis,
} from '../../features/vta/utils/eventAnalysis';
import { graphDiagnostics } from '../../features/vta/utils/graphDiagnostics';
import { getDrilldownSubEntities, visibleSchema } from '../../features/vta/utils/presentation';
import { splitEntitiesLocally } from '../../features/vta/utils/subjectRanking';
import { SubjectPoset } from '../../features/vta/utils/subjectPoset';
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

function loadVtaTestScenarioText(fileName: string, minParagraphs: number, fallbackPrefix: string): string {
  const filePath = path.resolve(process.cwd(), 'vta-test-data', fileName);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return Array.from({ length: minParagraphs }, (_, i) => `${fallbackPrefix}第${i + 1}段落の記録。`).join('\n\n');
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
    // O1 & O4 folded into content-addressed cmp_agg_*; C & E rolled up into cmp_* (coreEntityId='O3'); D中継見張員 stays retained!
    const othersId = optRes.consolidation.laneAssignment['O4'];
    expect(isPeripheralAggregateId(othersId)).toBe(true);
    expect(othersId).toMatch(/^cmp_agg_/);
    expect(optRes.consolidation.laneAssignment['O1']).toBe(othersId);
    const o3CompId = optRes.consolidation.laneAssignment['O3'];
    expect(o3CompId).toMatch(/^cmp_/);
    expect(o3CompId).not.toBe('O3');
    expect(optRes.analysis.entities.find((e) => e.id === o3CompId)?.coreEntityId).toBe('O3');
    expect(optRes.consolidation.laneAssignment['A_watch_C']).toBe(o3CompId);
    expect(optRes.consolidation.laneAssignment['A_wrk_E']).toBe(o3CompId);
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
    // 1. JAL and CAPT_B are NEVER hijacked into peripheral others; EXT_SUPPLY & ARFF are salvaged into cmp_agg_*!
    expect(isPeripheralAggregateId(assign['JAL'])).toBe(false);
    expect(isPeripheralAggregateId(assign['CAPT_B'])).toBe(false);
    expect(isPeripheralAggregateId(assign['EXT_SUPPLY'])).toBe(true);
    expect(assign['ARFF']).toBe(assign['EXT_SUPPLY']);

    // 2. Peer role_group B_CABIN_CREW + B_PAX -> cmp_* succeeds cleanly!
    expect(assign['B_CABIN_CREW']).toBe(assign['B_PAX']);
    expect(assign['B_CABIN_CREW']).toMatch(/^cmp_/);
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
    const a2Comp9 = assign9['A2'];
    expect(a2Comp9).toMatch(/^cmp_/);
    expect(res9.analysis.entities.find((e) => e.id === a2Comp9)?.coreEntityId).toBe('A2');
    expect(assign9['A10']).toBe(a2Comp9); // Operational team axis chosen over subcontractor A3
    const gRelayComp9 = assign9['A6'];
    expect(gRelayComp9).toMatch(/^cmp_/);
    expect(res9.analysis.entities.find((e) => e.id === gRelayComp9)?.coreEntityId).toBe('G_RELAY');
    expect(assign9['A7']).toBe(gRelayComp9);
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
    const a2Comp8 = res8.consolidation.laneAssignment['A2'];
    expect(a2Comp8).toMatch(/^cmp_/);
    expect(a2Comp8).not.toBe(a2Comp9);
    expect(res8.consolidation.laneAssignment['A6']).toBe(a2Comp8);
    expect(res8.consolidation.laneAssignment['A7']).toBe(a2Comp8);
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
    const uTrainComp = assign7['A3'];
    expect(uTrainComp).toMatch(/^cmp_/);
    expect(res7.analysis.entities.find((e) => e.id === uTrainComp)?.coreEntityId).toBe('U_TRAIN');
    expect(assign7['A4']).toBe(uTrainComp);
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

    // 1) A13 & A15 cleanly unify into cmp_* (coreEntityId='A12', 第1020列車編成) even when entity.parentEntityIds was stripped!
    const a12Comp = assign['A13'];
    expect(a12Comp).toMatch(/^cmp_/);
    expect(optRes.analysis.entities.find((e) => e.id === a12Comp)?.coreEntityId).toBe('A12');
    expect(assign['A15']).toBe(a12Comp);
    expect(lanes).toContain('第1020列車編成');

    // 2) C & D stay in 中継見張員（C・D） instead of being hijacked into A3 by FB_*!
    expect(optRes.analysis.entities.find((e) => e.id === assign['A6'])?.coreEntityId).not.toBe('A3');
    expect(optRes.analysis.entities.find((e) => e.id === assign['A7'])?.coreEntityId).not.toBe('A3');
    expect(lanes).toContain('中継見張員（C・D）');
  });

  it('resolves 8kxr diagnostics: excludes passively covered team hub A5, consolidates A2+A4 via conservative parent discovery preserving A2 ≺ A1, and keeps flashback before ordering (ADR-0087)', async () => {
    const { buildSubjectOthersEligibilitySet } = await import('./laneConsolidationOptimizer');
    const { SubjectPoset } = await import('../../features/vta/utils/subjectPoset');
    const source = [
      'p1 東武鉄道日光線新鹿沼駅構内における除草薬散布作業中の列車触車事故（作業員4名死亡）。',
      'p2 北関東工務事務所が除草薬散布作業を委託し、当日朝に下請会社がF作業員およびH・I・J作業員を派遣した。',
      'p3 09:00頃、A作業指揮者が北関東工務事務所へ電話点呼を実施し、G現場代理人が朝礼指示を出した。',
      'p4 A作業指揮者が作業開始連絡・中継配置指示を行い、C中継見張員とD中継見張員が中継配置についた。',
      'p5 B列車見張員が待避合図を出し、E作業員とF作業員が待避した。',
      'p6 10:45頃、第1020列車運転士が減速し、10:45〜10:46頃に待避完了と判断した。',
      'p7 10:46頃、G現場代理人とH・I・J作業員が静止して第1020列車と触車し、運転士が非常ブレーキを操作したが4名の死亡が確認された。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t東武鉄道株式会社\torganization\tmid\t-\tp1',
      'A2\t北関東工務事務所\torganization\tmid\tA1\tp2,p3',
      'A15\t第1020列車乗務・運行単位\torganization\tmid\tA1\t-',
      'A3\t第1020列車運転士\tperson\tmid\tA15\tp6,p7',
      'A4\t下請会社\torganization\tlow\t-\tp2',
      'A5\t除草薬散布作業班\torganization\thigh\t-\tp1,p3',
      'A14\t中継見張員グループ\torganization\tlow\tA5\t-',
      'A6\tA作業指揮者\tperson\thigh\tA5\tp3,p4',
      'A7\tG現場代理人\tperson\thigh\tA5\tp3,p7',
      'A8\tB列車見張員\tperson\thigh\tA5\tp5',
      'A9\tC中継見張員\tperson\tmid\tA14,A5\tp4',
      'A10\tD中継見張員\tperson\tmid\tA14,A5\tp4',
      'A11\tE作業員\tperson\tmid\tA5\tp5',
      'A12\tF作業員\tperson\tmid\tA5\tp2,p5',
      'A13\tH・I・J作業員\torganization\thigh\tA5\tp2,p7',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E20\t事前\t除草薬散布作業委託\t北関東工務事務所が作業を委託した\tA2:actor\tp2\trecorded',
      'E1\t当日朝\t作業員派遣\t下請会社がF・HIJ作業員を派遣した\tA4:actor,A12:affected,A13:affected\tp2\trecorded',
      'E3\t09:00頃\t電話点呼実施\tA作業指揮者が北関東工務事務所へ電話点呼した\tA6:actor,A2:confirmed_recipient\tp3\trecorded',
      // Lingering passive :target participations on A5 (covered by acting children A7 / A6)
      'E5\t09:10頃\t朝礼指示\tG現場代理人が班員へ指示した\tA7:actor,A5:target\tp3\trecorded',
      'E8\t09:30頃\t作業開始連絡\tA作業指揮者が作業開始を連絡した\tA6:actor,A5:target\tp4\trecorded',
      'E12\t10:00頃\t中継配置\tC・D中継見張員が中継配置についた\tA9:actor,A10:actor\tp4\trecorded',
      'E23\t10:30頃\t再確認連絡\tA作業指揮者が連絡した\tA6:actor,A5:target\tp4\trecorded',
      'E24\t10:44頃\t待避合図と待避\tB列車見張員が合図しE・F作業員が待避した\tA8:actor,A11:actor,A12:actor\tp5\trecorded',
      // Source-order collision E26 followed by retrospective driver subsection E28 -> E29 -> E30
      'E26\t10:46頃\t静止および列車触車\tG現場代理人とH・I・J作業員が静止し列車と触車した\tA7:affected,A13:affected,A3:actor\tp7\trecorded',
      'E28\t10:45頃\t列車減速\t第1020列車運転士が減速した\tA3:actor\tp6\trecorded',
      'E29\t10:45〜10:46頃\t待避完了判断\t第1020列車運転士が待避完了と判断した\tA3:actor\tp6\trecorded',
      'E30\t10:46頃\t非常ブレーキ操作\t第1020列車運転士が非常ブレーキを操作した\tA3:actor\tp7\trecorded',
      'E31\t-\t死亡確認\t4名の死亡が確認された\tA7:affected,A13:affected\tp7\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE3\tA6\tE3\tA2\tp3\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE8\tA5\tE12\tA10\tp4\tinformation\toccurred\tconfirmed',
      'R3\ttransfer\tE24\tA8\tE24\tA11\tp5\tinformation\toccurred\tconfirmed',
      // Explicit before edges for flashback subsection & range timestamp (E28 -> E29 -> E26 -> E30 -> E31)
      'R_b1\tbefore\tE28\t-\tE29\t-\tp6\t-\t-\tna',
      'R_b2\tbefore\tE29\t-\tE26\t-\tp6,p7\t-\t-\tna',
      'R_b3\tbefore\tE26\t-\tE30\t-\tp7\t-\t-\tna',
      'R_b4\tbefore\tE30\t-\tE31\t-\tp7\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE26:loss,E31:loss\tp7\t列車触車による4名死亡',
      '[仮判定]',
      'E20\tvariation\t除草薬散布作業委託における安全管理条件\tp2',
      'E1\tvariation\t見張員不足の派遣\tp2',
      'E5\tvariation\t朝礼時の伝達不備\tp3',
      'E8\tvariation\t現場確認なしの開始連絡\tp4',
      'E24\tvariation:resilient\t待避合図による待避\tp5',
      'E29\tvariation\t待避完了判断\tp6',
      'E30\tvariation:resilient\t非常ブレーキ操作\tp7',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(fineAnalysis);
    const eligibleOthers = buildSubjectOthersEligibilitySet(fineBase, fineAnalysis);

    // A2 (2 cards incl. E20 variation) and A4 (1 card E1 variation) are both eligible; outcome actor A3 is protected
    expect(eligibleOthers.has('A2')).toBe(true);
    expect(eligibleOthers.has('A4')).toBe(true);
    expect(eligibleOthers.has('A3')).toBe(false);
    expect(eligibleOthers.has('A5')).toBe(false);

    const fineSchema = projectAnalysis(fineAnalysis);
    // Even if LLM only proposes C,D -> A14 and E,F -> 待避作業員 without mentioning A2/A4,
    // deterministic continuous-cost fallback discovers subject_others over {A4, A2}!
    const mockCaller = async () => ({
      latencyMs: 15,
      content: [
        '[推奨統合]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M1\tposet_rollup\tA9,A10\tA14\t-\torganization\t0.06\tC・D中継見張員を中継見張員グループへ統合',
        'M2\trole_group\tA11,A12\t-\t待避作業員（E・F作業員）\torganization\t0.08\tE・F作業員を待避作業員グループへ統合',
        '[予備候補]',
        '[分離維持ペア]',
        '主体A\t主体B\t強さ\t理由',
        'A7\tA13\thard\t現場代理人と被指示作業員で非対称',
        '[完了]',
      ].join('\n'),
    });

    const optRes = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 8 }
    );

    const assign = optRes.consolidation.laneAssignment;
    const lanes = visibleSchema(optRes.schema).lanes;

    // 1) Passively covered hub A5 is excluded from active fine lanes (11 active fine lanes -> 8 final lanes, C1 = 1.0)
    expect(optRes.fineLaneCount).toBe(11);
    expect(optRes.finalLaneCount).toBe(8);
    expect(optRes.consolidation.metrics.c1).toBe(1);
    expect(lanes).not.toContain('除草薬散布作業班');

    // 2) A2 and A4 consolidate into content-addressed cmp_agg_* ('その他の関係者') as leftmost lane
    const aggId = assign['A2'];
    expect(aggId).toMatch(/^cmp_agg_/);
    expect(assign['A4']).toBe(aggId);
    expect(lanes[0]).toBe('その他の関係者');
    expect(lanes).toContain('中継見張員グループ');
    expect(lanes).toContain('待避作業員（E・F作業員）');

    // 3) Conservative Poset extension registers both discovered parents in analysis.subjectPoset WITHOUT destroying A2 ≺ A1
    const projectedPoset = SubjectPoset.fromData(optRes.analysis.subjectPoset!);
    expect(projectedPoset.isAncestor(aggId, 'A2')).toBe(true);
    expect(projectedPoset.isAncestor(aggId, 'A4')).toBe(true);
    expect(projectedPoset.isAncestor('A1', 'A2')).toBe(true);
    expect(projectedPoset.isAncestor('A1', 'A4')).toBe(false);
    const evacGroupId = assign['A11'];
    expect(projectedPoset.isAncestor(evacGroupId, 'A11')).toBe(true);
    expect(projectedPoset.isAncestor(evacGroupId, 'A12')).toBe(true);
    expect(projectedPoset.isAncestor('A5', evacGroupId)).toBe(true);

    // 4) Fine-grained base stays completely pristine (15 entities) and remapped relation R2 projects cleanly with 0 missing relations
    expect(optRes.analysis.fineGrainedBase?.entities).toHaveLength(15);
    expect(graphDiagnostics(optRes.schema).missingRelations).toEqual([]);

    // 5) Pre-outcome flashback events E28 -> E29 -> E26 -> E30 -> E31 order strictly top-to-bottom in EventTimeDAG & lane sequence
    const { computeEventRowMap, ensureEventTimeDAG } = await import(
      '../../features/vta/utils/eventTimePoset'
    );
    const rowMap = computeEventRowMap(optRes.analysis, ensureEventTimeDAG(optRes.analysis));
    expect(rowMap.get('E28')!).toBeLessThan(rowMap.get('E29')!);
    expect(rowMap.get('E29')!).toBeLessThan(rowMap.get('E26')!);
    expect(rowMap.get('E26')!).toBeLessThan(rowMap.get('E30')!);
    expect(rowMap.get('E30')!).toBeLessThan(rowMap.get('E31')!);

    const driverEventSeq = optRes.schema.nodes
      .filter((n) => n.lane === '第1020列車運転士')
      .flatMap((n) => n.event_ids ?? []);
    expect(driverEventSeq).toEqual(['E28', 'E29', 'E26', 'E30']);
  });

  it('connects subsumed 0-event intermediate hubs in Poset, conserves additive convex load in 2-stage rollups, keeps excluded:true, and keeps OLAP drill-down & splitEntitiesLocally clean (xrrp reproduction)', async () => {
    const source = [
      'p1 除草薬散布作業班でG現場代理人が指示し、C・D中継見張員が中継し、E・F作業員が待避し、H・I・J作業員が被災した。',
    ].join('\n');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A4\t除草薬散布作業班\torganization\thigh\t-\tp1',
      'A8\t中継見張員\torganization\tmid\tA4\t-',
      'A11\t待避作業員\torganization\tmid\tA4\t-',
      'A6\tG現場代理人\tperson\thigh\tA4\tp1',
      'A9\tC中継見張員\tperson\tmid\tA8,A4\t-',
      'A10\tD中継見張員\tperson\tmid\tA8,A4\t-',
      'A12\tE作業員\tperson\tmid\tA11,A4\t-',
      'A13\tF作業員\tperson\tmid\tA11,A4\t-',
      'A14\tH・I・J作業員\tperson\thigh\tA4\tp1',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:15\t中継移動\tC・D中継見張員が移動した\tA9:actor,A10:actor\tp1\trecorded',
      'E2\t10:42\t立入指示\tG現場代理人がH・I・J作業員へ指示した\tA6:actor,A14:target\tp1\trecorded',
      'E3\t10:45\t待避実施\tE・F作業員が待避した\tA12:actor,A13:actor\tp1\trecorded',
      'E4\t10:46\t触車被災\tG現場代理人とH・I・J作業員が被災した\tA6:affected,A14:affected\tp1\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE2\tA6\tE3\tA12\tp1\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE4:loss\tp1\t触車被災',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(fineAnalysis);
    const candidates = [
      {
        id: 'M2',
        kind: 'poset_rollup' as const,
        sourceEntityIds: ['A9', 'A10'],
        targetEntityId: 'A8',
        targetKind: 'organization' as const,
        semanticCost: 0.08,
        reason: 'C・D中継見張員を中継見張員へ統合',
        origin: 'llm' as const,
        recommended: true,
      },
      {
        id: 'M3',
        kind: 'poset_rollup' as const,
        sourceEntityIds: ['A12', 'A13'],
        targetEntityId: 'A11',
        targetKind: 'organization' as const,
        semanticCost: 0.10,
        reason: 'E・F作業員を待避作業員へ統合',
        origin: 'llm' as const,
        recommended: true,
      },
      {
        id: 'P1',
        kind: 'role_group' as const,
        sourceEntityIds: ['A8', 'A11'],
        targetLabel: '中継見張・待避作業員群',
        targetKind: 'organization' as const,
        semanticCost: 0.28,
        reason: '補助作業員群の2段階統合',
        origin: 'llm' as const,
        recommended: false,
      },
    ];

    const searched = searchOptimalLaneConsolidation(fineBase, fineAnalysis, candidates, [], {
      targetMaxSubjects: 3,
    });
    const assign = searched.consolidation.laneAssignment;
    const groupId = assign['A9'];
    expect(groupId).toMatch(/^cmp_/);
    expect(assign['A10']).toBe(groupId);
    expect(assign['A12']).toBe(groupId);
    expect(assign['A13']).toBe(groupId);

    // 1) Subsumed 0-event hubs A8 & A11 are conservatively connected beneath groupId and below A4 in subjectPoset
    const poset = SubjectPoset.fromData(searched.bestSchema.analysis!.subjectPoset!);
    expect(poset.isAncestor(groupId, 'A8')).toBe(true);
    expect(poset.isAncestor(groupId, 'A11')).toBe(true);
    expect(poset.isAncestor('A4', groupId)).toBe(true);
    expect(poset.isAncestor('A8', 'A9')).toBe(true);
    expect(poset.isAncestor('A11', 'A12')).toBe(true);

    // 2) Unmaterialized 0-event hubs keep excluded: true (not mergedInto) so splitEntitiesLocally never resurrects 0-card lanes
    const rankA8 = searched.bestSchema.analysis!.subjectRanking?.ranks.find((r) => r.entityId === 'A8');
    const rankA11 = searched.bestSchema.analysis!.subjectRanking?.ranks.find((r) => r.entityId === 'A11');
    expect(rankA8?.excluded).toBe(true);
    expect(rankA8?.mergedInto).toBeUndefined();
    expect(rankA11?.excluded).toBe(true);
    expect(rankA11?.mergedInto).toBeUndefined();

    // 3) OLAP drill-down expands through excluded 0-event hubs A8 & A11 directly to participating leaves A9, A10, A12, A13
    const subEntities = getDrilldownSubEntities(groupId, searched.bestSchema.analysis!);
    expect(subEntities.map((s) => s.id).sort()).toEqual(['A10', 'A12', 'A13', 'A9']);

    // 4) Splitting A9 locally keeps A8/A11 excluded and never introduces empty 0-card ghost lanes
    const splitAnalysis = splitEntitiesLocally(searched.bestSchema.analysis!, groupId, ['A9'], 4);
    expect(splitAnalysis.entities.some((e) => e.id === 'A8' || e.id === 'A11')).toBe(false);
    expect(splitAnalysis.entities.some((e) => e.id === 'A9')).toBe(true);

    // 5) Pure partition (k-1)/k degree-of-freedom convex-load conservation: phi(0.08) + phi(0.10) + phi(0.28)
    const phi = (c: number) => 0.35 * c + 0.95 * c * c;
    const expectedLoad = phi(0.08) + phi(0.10) + phi(0.28);
    const expectedC2 = Number((1 / (1 + 0.55 * expectedLoad)).toFixed(4));
    expect(searched.consolidation.metrics.c2).toBeCloseTo(expectedC2, 4);
  });

  it('reaches targetMaxSubjects=7 from 12 fine lanes via 2nd-stage virtual subgroup consolidation without touching core protagonists, and expands virtual group references in parseLaneConsolidationTSV (7rnw reproduction, ADR-0089)', async () => {
    const source = [
      'p1 東武鉄道北関東工務事務所が委託し、下請会社がF作業員およびH・I・J作業員を派遣した。',
      'p2 A作業指揮者が点呼し、B列車見張員が見張り、C・D中継見張員が中継配置につき、E・F作業員が待避し、G現場代理人とH・I・J作業員が第1020列車（運転士操作）と触車した。',
    ].join('\n');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t東武鉄道\torganization\tmid\t-\t-',
      'A2\t東武鉄道北関東工務事務所\torganization\tmid\tA1\t-',
      'A3\t下請会社\torganization\tmid\t-\t-',
      'A4\t除草薬散布作業班\torganization\thigh\t-\tp2',
      'A5\tA作業指揮者\tperson\thigh\tA4\tp2',
      'A6\tB列車見張員\tperson\thigh\tA4\tp2',
      'A7\tC中継見張員\tperson\tmid\tA4\t-',
      'A8\tD中継見張員\tperson\tmid\tA4\t-',
      'A9\tE作業員\tperson\tmid\tA4\t-',
      'A10\tF作業員\tperson\tmid\tA3,A4\t-',
      'A11\tG現場代理人\tperson\thigh\tA4\tp2',
      'A12\tH・I・J作業員\tperson\thigh\tA3,A4\tp2',
      'A13\t第1020列車運転士が操作する第1020列車\torganization\thigh\tA1\tp2',
      'A14\t第1020列車運転士\tperson\thigh\tA13\tp2',
      'A15\t第1020列車\tmachine\thigh\tA13\tp2',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t事前\t作業委託\t北関東工務事務所が委託した\tA2:actor\tp1\trecorded',
      'E2\t当日朝\t作業員派遣\t下請会社が派遣した\tA3:actor,A10:target,A12:target\tp1\trecorded',
      'E3\t09:00\t点呼・配置指示\tA作業指揮者が点呼しG現場代理人が指示した\tA5:actor,A11:actor\tp2\trecorded',
      'E4\t10:15\t中継配置\tC・D中継見張員が配置についた\tA7:actor,A8:actor\tp2\trecorded',
      'E5\t10:45\t列車接近合図\tB列車見張員が合図したがD中継見張員に届かなかった\tA6:actor,A8:intended_recipient\tp2\trecorded',
      'E6\t10:45\t作業員待避\tE・F作業員が待避した\tA9:actor,A10:actor\tp2\trecorded',
      'E7\t10:46\t減速進入\t運転士と列車が進入した\tA14:actor,A15:actor\tp2\trecorded',
      'E8\t10:46\t列車触車\t第1020列車がG現場代理人・H・I・J作業員と触車した\tA15:actor,A11:affected,A12:affected\tp2\trecorded',
      'E9\t10:46\t異音感知・非常停止\t運転士が非常停止させた\tA14:actor,A15:target\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE3\tA5\tE4\tA7\tp2\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE5\tA6\tE6\tA9\tp2\tinformation\toccurred\tconfirmed',
      'R3\timpact\tE7\tA14\tE8\tA15\tp2\tother\toccurred\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE8:loss\tp2\t列車触車による死傷',
      '[仮判定]',
      'E2\tvariation\t派遣体制不備\tp1',
      'E5\tvariation\t合図不達\tp2',
      'E6\tvariation:resilient\t自力待避\tp2',
      'E9\tnormal\t規定通りの非常停止\tp2',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(fineAnalysis);
    const fineSchema = projectAnalysis(fineAnalysis);

    // A) Verify parseLaneConsolidationTSV expands virtual role_group references by label/ID and accumulates subgroup costs
    const parsedVirtualRef = parseLaneConsolidationTSV(
      [
        '[推奨統合]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M3\trole_group\tA7,A8\t-\t中継見張員\torganization\t0.12\tC・D統合',
        'M4\trole_group\tA9,A10\t-\t待避作業員\torganization\t0.14\tE・F統合',
        '[予備候補]',
        'P1\trole_group\t中継見張員,待避作業員\t-\t中継見張・待避作業員群\torganization\t0.20\t2段階統合',
        '[完了]',
      ].join('\n'),
      fineBase,
      fineAnalysis
    );
    const p1 = parsedVirtualRef.candidates.find((c) => c.id === 'P1');
    expect(p1).toBeDefined();
    // Sealed composite references M3 and M4 are preserved as direct child units (not flattened to leaves)
    expect(p1!.sourceEntityIds.sort()).toEqual(['M3', 'M4']);
    expect(p1!.semanticCost).toBeCloseTo(0.2, 3);

    // B) Even when LLM omits [予備候補] completely (as in 7rnw), synthesized 2nd-stage cohort candidate reaches 7 lanes (C1 = 1.0)
    const mockCaller7rnw = async () => ({
      latencyMs: 12,
      content: [
        '[推奨統合]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M1\tposet_rollup\tA14,A15\tA13\t-\torganization\t0.08\t運転士と車両の統合',
        'M2\tperipheral_others\tA2,A3\tsubject_others\tその他の関係者\tother\t0.10\t周辺組織の集約',
        'M3\trole_group\tA7,A8\t-\t中継見張員\torganization\t0.12\t中継見張員の統合',
        'M4\trole_group\tA9,A10\t-\t待避作業員\torganization\t0.14\t待避作業員の統合',
        '[予備候補]',
        '[分離維持ペア]',
        '主体A\t主体B\t強さ\t理由',
        'A11\tA12\thard\t現場代理人と被指示作業員で非対称',
        '[完了]',
      ].join('\n'),
    });

    const opt7 = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller7rnw,
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );
    expect(opt7.fineLaneCount).toBe(12);
    expect(opt7.finalLaneCount).toBe(7);
    expect(opt7.consolidation.metrics.c1).toBe(1);

    const assign7 = opt7.consolidation.laneAssignment;
    // Auxiliary subgroup members {A7, A8, A9, A10} unify into a single 2nd-stage cohort group beneath A4
    const auxBucket = assign7['A7'];
    expect(auxBucket).toMatch(/^cmp_/);
    expect(assign7['A8']).toBe(auxBucket);
    expect(assign7['A9']).toBe(auxBucket);
    expect(assign7['A10']).toBe(auxBucket);
    const projectedPoset7 = SubjectPoset.fromData(opt7.analysis.subjectPoset!);
    expect(projectedPoset7.isAncestor('A4', auxBucket)).toBe(true);

    // Core protagonists {A5, A6, A11, A12} and train composite (coreEntityId='A13') remain independent lanes!
    expect(assign7['A5']).toBe('A5');
    expect(assign7['A6']).toBe('A6');
    expect(assign7['A11']).toBe('A11');
    expect(assign7['A12']).toBe('A12');
    const a13Comp = assign7['A14'];
    expect(a13Comp).toMatch(/^cmp_/);
    expect(opt7.analysis.entities.find((e) => e.id === a13Comp)?.coreEntityId).toBe('A13');
    expect(assign7['A15']).toBe(a13Comp);

    // C) At targetMaxSubjects=8, positive incremental convex load prevents unnecessary 8 -> 7 over-consolidation
    const opt8 = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCaller7rnw,
      undefined,
      undefined,
      { targetMaxSubjects: 8 }
    );
    expect(opt8.finalLaneCount).toBe(8);
    expect(opt8.consolidation.laneAssignment['A7']).not.toBe(opt8.consolidation.laneAssignment['A9']);
    expect(opt7.consolidation.metrics.c2).toBeLessThan(opt8.consolidation.metrics.c2);
  });

  it('unifies clean man-machine 0-event composite hubs on poset_fallback when LLM is skipped (g5g1 reproduction) while preserving ADR-0033 autonomous mode-confusion separation', async () => {
    const source = [
      'p1 運転士Kは100系車両を運転し、現場手前で汽笛吹鳴・非常ブレーキ操作を行ったが列車触車に至った。',
      'p2 現場代理人Gと作業員H・I・Jが被災した。',
    ].join('\n');

    const ledgerClean = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A3\t除草薬散布作業班\torganization\thigh\t-\tp2',
      'A5\t現場代理人G\tperson\thigh\tA3\tp2',
      'A11\t作業員H・I・J\tperson\thigh\tA3\tp2',
      'A14\t下り特急列車\torganization\tmid\t-\tp1',
      'A13\t運転士K\tperson\thigh\tA14\tp1',
      'A15\t100系車両\tmachine\tlow\tA14\tp1',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E19\t10:40\t除草作業継続\t現場代理人Gが指示し作業員H・I・Jが作業した\tA5:actor,A11:actor\tp2\trecorded',
      'E20\t10:45\t警笛吹鳴\t運転士Kが警笛を吹鳴し100系車両を減速させた\tA13:actor,A15:target\tp1\trecorded',
      'E21\t10:46\t非常制動\t運転士Kが非常ブレーキを操作した\tA13:actor,A15:target\tp1\trecorded',
      'E25\t10:46頃\t列車触車\t運転士Kの列車が現場代理人Gらに触車した\tA13:actor,A5:affected,A11:affected\tp1,p2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R0\tbefore\tE19\t-\tE25\t-\tp2\t-\t-\t-',
      'R1\tbefore\tE20\t-\tE21\t-\tp1\t-\t-\t-',
      'R2\timpact\tE21\tA13\tE25\tA5\tp1,p2\tother\toccurred\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE25:loss\tp1,p2\t列車触車',
      '[仮判定]',
      'E20\tvariation:resilient\t警笛吹鳴\tp1',
      'E21\tvariation:resilient\t非常制動\tp1',
      '[完了]',
    ].join('\n');

    const cleanAnalysis = buildFineAnalysis(ledgerClean, source);
    const cleanSchema = projectAnalysis(cleanAnalysis);

    // Simulate Gateway 502 failure so optimizer falls back strictly to poset_fallback
    const failingCaller = async () => {
      throw new Error('LLM Gateway error (502): upstream connect failed');
    };

    const optClean = await optimizeLaneConsolidation(
      dummyConfig,
      cleanSchema,
      failingCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 3 }
    );
    expect(optClean.llmCalled).toBe(false);
    const a14Comp = optClean.consolidation.laneAssignment['A13'];
    expect(a14Comp).toMatch(/^cmp_/);
    expect(optClean.analysis.entities.find((e) => e.id === a14Comp)?.coreEntityId).toBe('A14');
    expect(optClean.consolidation.laneAssignment['A15']).toBe(a14Comp);
    expect(optClean.finalLaneCount).toBe(3);

    // ADR-0033 Mode Confusion check: if the machine exhibits autonomous mode conflict, fallback MUST keep pilot & machine separate
    const sourceConflict = [
      'p1 運転士Kが操作中、100系車両の自動制御システムがモード誤遷移を起こし減速介入を解除した。',
      'p2 現場代理人Gが被災した。',
    ].join('\n');
    const ledgerConflict = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A5\t現場代理人G\tperson\thigh\t-\tp2',
      'A14\t下り特急列車\torganization\tmid\t-\tp1',
      'A13\t運転士K\tperson\thigh\tA14\tp1',
      'A15\t100系車両\tmachine\tmid\tA14\tp1',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:45\t手動制動入力\t運転士Kが制動入力した\tA13:actor\tp1\trecorded',
      'E2\t10:45\t自動制御モード誤遷移\t100系車両の自動制御モードが誤遷移した\tA15:actor\tp1\trecorded',
      'E3\t10:46\t列車触車\t触車が発生した\tA13:actor,A5:affected\tp1,p2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE1\tA13\tE2\tA15\tp1\tinformation\toccurred\tconfirmed',
      'R2\timpact\tE2\tA15\tE3\tA5\tp1,p2\tother\toccurred\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE3:loss\tp1,p2\t列車触車',
      '[仮判定]',
      'E2\tvariation\t自動制御モード誤遷移\tp1',
      '[完了]',
    ].join('\n');

    const conflictAnalysis = buildFineAnalysis(ledgerConflict, sourceConflict);
    const conflictSchema = projectAnalysis(conflictAnalysis);
    const optConflict = await optimizeLaneConsolidation(
      dummyConfig,
      conflictSchema,
      failingCaller,
      undefined,
      undefined,
      { targetMaxSubjects: 2 }
    );
    expect(optConflict.consolidation.laneAssignment['A13']).not.toBe(
      optConflict.consolidation.laneAssignment['A15']
    );
  });

  it('prevents split-parent Poset antichain pollution, exempts machines from P_group, and consolidates subordinate corporate branches (ov94 Haneda reproduction)', async () => {
    const source = [
      'p1 海上保安庁本庁対策本部が物資輸送を指示し、第三管区海上保安本部羽田航空基地が計画策定、羽田通信が無線連絡を行った。',
      'p2 A機乗組員の機長Aと副操縦員Aが交信・走行し、整備員A1・通信員A2と海上保安庁機（機体）が滑走路上で衝突・炎上した。',
      'p3 B機運航乗務員と日本航空機が着陸・衝突し、客室乗務員B1・B2と乗客が非常脱出した。',
      'p4 航空管制機関のタワー東が交信し、グランド東・タワー西・滑走路占有監視支援機能が監視業務を行った。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A_JCG\t海上保安庁\torganization\tmid\t-\tp1',
      'A_JCG_HD\t海上保安庁本庁対策本部\torganization\tlow\tA_JCG\tp1',
      'A_JCG_HND\t第三管区海上保安本部羽田航空基地\torganization\tmid\tA_JCG\tp1',
      'A_JCG_COMM\t羽田通信\torganization\tmid\tA_JCG_HND\tp1',
      'A_JCG_TEAM\tA機乗組員\torganization\thigh\tA_JCG_HND\tp2',
      'A1\t機長A\tperson\thigh\tA_JCG_TEAM,A_JCG_HND\tp2',
      'A2\t副操縦員A\tperson\thigh\tA_JCG_TEAM,A_JCG_HND\tp2',
      'A3\t整備員A1\tperson\tmid\tA_JCG_TEAM\tp2',
      'A4\t通信員A2\tperson\tmid\tA_JCG_TEAM\tp2',
      'A_AC_A\t海上保安庁機\tmachine\thigh\tA_JCG_HND\tp2',
      'A_JAL\t日本航空株式会社\torganization\tmid\t-\tp3',
      'B_CREW\tB機運航乗務員\torganization\thigh\tA_JAL\tp3',
      'A_AC_B\t日本航空機\tmachine\thigh\tA_JAL\tp3',
      'C1\t客室乗務員B1\tperson\tmid\tA_JAL\tp3',
      'C2\t客室乗務員B2\tperson\tmid\tA_JAL\tp3',
      'P_PAX\tB機乗客\tperson\tmid\tA_JAL\tp3',
      'A_ATC\t航空管制機関\torganization\tmid\t-\tp4',
      'T1\tタワー東\tperson\thigh\tA_ATC\tp4',
      'T2\tグランド東\tperson\tmid\tA_ATC\tp4',
      'T3\tタワー西\tperson\tlow\tA_ATC\tp4',
      'A_TWR_SYS\t滑走路占有監視支援機能\tmachine\thigh\tA_ATC\tp4',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E0\t14:00\t管制業務規定運用\t航空管制機関が規定に基づき監視支援体制を運用していた\tA_ATC:actor\tp4\trecorded',
      'E1\t15:00\t輸送指示\t本庁対策本部が羽田航空基地へ指示した\tA_JCG_HD:actor,A_JCG_HND:confirmed_recipient\tp1\trecorded',
      'E2\t16:00\t基地計画策定\t羽田航空基地が運航計画を策定した\tA_JCG_HND:actor\tp1\trecorded',
      'E3\t17:10\t電源車連絡\t羽田通信が機長Aへ無線連絡した\tA_JCG_COMM:actor,A1:confirmed_recipient\tp1,p2\trecorded',
      'E4\t17:43\t地上走行許可\tグランド東が副操縦員Aへ走行指示した\tT2:actor,A2:confirmed_recipient\tp2,p4\trecorded',
      'E5\t17:44\t着陸許可\tタワー東がB機運航乗務員へ着陸許可を出した\tT1:actor,B_CREW:confirmed_recipient\tp3,p4\trecorded',
      'E6\t17:45\t停止位置復唱\tタワー東と副操縦員Aが交信し機長Aが進入許可と誤認した\tT1:actor,A2:actor,A1:actor\tp2,p4\trecorded',
      'E7\t17:45\t滑走路進入\t機長Aと副操縦員Aが海上保安庁機を滑走路へ進入させた\tA1:actor,A2:actor,A_AC_A:actor,A3:target,A4:target\tp2\trecorded',
      'E8\t17:46\t注意喚起表示\t滑走路占有監視支援機能が注意表示を作動させた\tA_TWR_SYS:actor,T3:target\tp4\trecorded',
      'E9\t17:46\t滑走路上停止継続\t海上保安庁機が滑走路上で停止継続した\tA1:actor,A_AC_A:actor\tp2\trecorded',
      'E10\t17:47\t機体損壊・炎上\t海上保安庁機と日本航空機が衝突・炎上した\tA_AC_A:actor,A_AC_B:actor,B_CREW:affected,A1:affected,A3:affected,A4:affected\tp2,p3\trecorded',
      'E11\t17:48\t機体停止保持\t海上保安庁機が滑走路脇で炎上停止し機長Aが脱出した\tA_AC_A:actor,A1:actor\tp2\trecorded',
      'E12\t17:50\t非常脱出誘導\t客室乗務員B1・B2が乗客へ脱出を指示・誘導した\tC1:actor,C2:actor,P_PAX:actor,A_AC_B:target\tp3\trecorded',
      'E12b\t17:58\t全員脱出完了\t客室乗務員と乗客の全員脱出が完了した\tC1:actor,C2:actor,P_PAX:affected\tp3\trecorded',
      'E13\t17:55\t無線呼びかけ不達\t羽田通信がA機へ呼びかけたが応答がなかった\tA_JCG_COMM:actor\tp1\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R0\tdependency\tE0\tA_ATC\tE8\tA_TWR_SYS\tp4\t-\t-\tna',
      'R1\ttransfer\tE1\tA_JCG_HD\tE2\tA_JCG_HND\tp1\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE3\tA_JCG_COMM\tE6\tA1\tp1,p2\tinformation\toccurred\tconfirmed',
      'R3\ttransfer\tE4\tT2\tE6\tA2\tp2,p4\tinformation\toccurred\tconfirmed',
      'R4\ttransfer\tE5\tT1\tE10\tB_CREW\tp3,p4\tinformation\toccurred\tconfirmed',
      'R5\timpact\tE9\tA_AC_A\tE10\tA_AC_B\tp2,p3\tother\toccurred\tna',
      'R6\ttransfer\tE12\tC1\tE12\tC2\tp3\tinformation\toccurred\tconfirmed',
      'R7\ttransfer\tE12\tC2\tE12\tP_PAX\tp3\tinformation\toccurred\tconfirmed',
      'R8\tbefore\tE12\t-\tE12b\t-\tp3\t-\t-\t-',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE10:loss,E12b:recovery\tp2,p3\t両機衝突炎上とB機全員脱出',
      '[仮判定]',
      'E3\tvariation\t電源車不可連絡\tp1',
      'E6\tvariation\t進入許可誤認\tp2',
      'E7\tvariation\t滑走路誤進入\tp2',
      'E8\tvariation\t注意喚起見落とし\tp4',
      'E9\tvariation\t滑走路上停止継続\tp2',
      'E12\tvariation:resilient\t非常脱出誘導\tp3',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineSchema = projectAnalysis(fineAnalysis);

    const mockCallerOv94 = async () => ({
      latencyMs: 35,
      content: [
        '[推奨統合]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        'M1\trole_group\tC1,C2,P_PAX\t-\tB機客室乗務員・乗客\tperson\t0.10\t客室非常脱出の同質グループ',
        'M2\trole_group\tB_CREW,A_AC_B\t-\tB機運航乗務員・機体\torganization\t0.06\tB機運航と機体の一体化',
        'M3\trole_group\tT2,T3,A_ATC,A_TWR_SYS\t-\t周辺管制席・監視支援機能\torganization\t0.12\tタワー東以外の周辺管制・監視機能',
        'M4\trole_group\tA3,A4,A_AC_A\t-\tA機同乗員・機体\torganization\t0.10\t機長・副操縦員以外の同乗員と機体',
        '[予備候補]',
        'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
        '[分離維持ペア]',
        '主体A\t主体B\t強さ\t理由',
        'A1\tA2\thard\t機長と副操縦員の認識差異を分離維持',
        'T1\tA1\thard\t管制官と機長を分離維持',
        '[完了]',
      ].join('\n'),
    });

    const optRes = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      mockCallerOv94,
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );

    const assign = optRes.consolidation.laneAssignment;
    const projectedPoset = SubjectPoset.fromData(optRes.analysis.subjectPoset!);

    // 1. Split-parent antichain protection: T1 (タワー東) remains independent and NEVER inherits M3 (cmp_*) as an ancestor!
    const m3Bucket = assign['T2'];
    expect(m3Bucket).toMatch(/^cmp_/);
    expect(assign['T1']).toBe('T1');
    expect(projectedPoset.isAncestor(m3Bucket, 'T1')).toBe(false);
    expect(projectedPoset.isAncestor(m3Bucket, 'T2')).toBe(true);
    const t1Entity = optRes.analysis.entities.find((e) => e.id === 'T1');
    expect(t1Entity?.parentEntityIds ?? []).not.toContain(m3Bucket);

    // 2. Subordinate JCG ground/HQ branches {A_JCG_HD, A_JCG_HND, A_JCG_COMM} consolidate cleanly without touching A1/A2 or polluting peripheral others!
    expect(assign['A1']).toBe('A1');
    expect(assign['A2']).toBe('A2');
    expect(assign['A_JCG_COMM']).toBe(assign['A_JCG_HND']);
    expect(assign['A_JCG_HD']).toBe(assign['A_JCG_HND']);
    expect(isPeripheralAggregateId(assign['A_JCG_HND'])).toBe(false);
    expect(projectedPoset.isAncestor(assign['A_JCG_HND'], 'A1')).toBe(false);
    expect(optRes.finalLaneCount).toBeLessThanOrEqual(8);

    // 3. Machine A_AC_A in M4 does not suffer supervisor P_group penalty & M3 avoids false shell-inversion penalty -> C2 recovers from 0.23 to ~0.59!
    expect(assign['A_AC_A']).toBe(assign['A3']);
    expect(optRes.consolidation.metrics.c2).toBeGreaterThan(0.55);
  });

  it('resolves lf15 Haneda diagnostics via pure partition objective: covers collective casualty hub A5, peels protagonist A14 from ATC bundle, groups auxiliary crew A8..A10, and permits shared-adverse co-pilots A24+A25 (ADR-0094)', async () => {
    const { evaluateMergeGuard } = await import('../../features/vta/utils/subjectRanking');
    const source = [
      'p1 海上保安庁本庁対策本部が輸送を指示し、羽田航空基地と羽田通信が運航支援を行った。',
      'p2 JA722A搭乗員（機長A、副操縦員A、機上整備員A、機上通信員A、機上探索レーダー員A・航空員A）がJA722A（A機）で走行・滑走路進入し、死傷した。',
      'p3 東京飛行場管制所（タワー）のタワー東が多数の交信・着陸許可を行い、グラウンド東・タワー西・デリバリー・グラウンド国際・滑走路占有監視支援機能および東京進入管制所（DF・AFS）が管制業務を行った。',
      'p4 日本航空のJA13XJ運航乗務員（機長B・訓練乗員）とJA13XJ（B機）・機長Bらが運航するJA13XJが着陸・衝突し、JA13XJ客室乗務員（先任・L1）とJA13XJ乗客が非常脱出した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t海上保安庁\torganization\tmid\t-\tp1',
      'A2\t羽田航空基地\torganization\tmid\tA1\tp1',
      'A4\t本庁対策本部\torganization\tlow\tA1\tp1',
      'A38\t通信士A（羽田通信）\tperson\tmid\tA2\tp1',
      'A5\tJA722A搭乗員\torganization\thigh\tA1\tp2',
      'A6\t機長A\tperson\thigh\tA5\tp2',
      'A7\t副操縦員A\tperson\thigh\tA5\tp2',
      'A8\t機上整備員A\tperson\tmid\tA5\tp2',
      'A9\t機上通信員A\tperson\tmid\tA5\tp2',
      'A10\t機上探索レーダー員A・航空員A\torganization\tlow\tA5\tp2',
      'A11\tJA722A（A機）\tmachine\thigh\t-\tp2',
      'A13\t東京飛行場管制所（タワー）\torganization\thigh\t-\tp3',
      'A14\tタワー東\tperson\thigh\tA13\tp3',
      'A15\tグラウンド東\tperson\tmid\tA13\tp3',
      'A16\tタワー西\tperson\tlow\tA13\tp3',
      'A17\tデリバリー\tperson\tlow\tA13\tp3',
      'A18\tグラウンド国際\tperson\tlow\tA13\tp3',
      'A43\t滑走路占有監視支援機能\tmachine\tmid\tA13\tp3',
      'A19\t東京進入管制所\torganization\tmid\t-\tp3',
      'A20\t羽田出域調整席（DF）\tperson\tmid\tA19\tp3',
      'A21\t羽田捜索調整席南（AFS）\tperson\tlow\tA19\tp3',
      'A22\t日本航空\torganization\tmid\t-\tp4',
      'A23\tJA13XJ運航乗務員\torganization\thigh\tA22\tp4',
      'A24\t機長B\tperson\thigh\tA23\tp4',
      'A25\t訓練乗員\tperson\thigh\tA23\tp4',
      'A27\tJA13XJ客室乗務員\torganization\thigh\tA22\tp4',
      'A28\t先任客室乗務員\tperson\tmid\tA27\tp4',
      'A35\tJA13XJ乗客\torganization\thigh\t-\tp4',
      'A36\tJA13XJ（B機）\tmachine\thigh\t-\tp4',
      'A37\t機長Bらが運航するJA13XJ\tother\thigh\tA22\tp4',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E0\t16:00\tタワー管制運用\t東京飛行場管制所が監視支援運用規定を適用していた\tA13:actor\tp3\trecorded',
      'E1\t16:30\t物資輸送指示\t本庁対策本部が羽田航空基地へ輸送指示した\tA4:actor,A2:confirmed_recipient\tp1\trecorded',
      'E2\t17:00\t運航計画連絡\t羽田航空基地と羽田通信が機長Aへ連絡した\tA2:actor,A38:actor,A6:confirmed_recipient\tp1,p2\trecorded',
      'E3\t17:15\t管制承認伝達\tデリバリーが副操縦員Aへ承認伝達した\tA17:actor,A7:confirmed_recipient\tp2,p3\trecorded',
      'E4\t17:30\t地上走行指示\tグラウンド国際・グラウンド東が副操縦員Aへ走行指示した\tA18:actor,A15:actor,A7:confirmed_recipient\tp2,p3\trecorded',
      'E5\t17:35\t進入管制移管\tDFとAFSがタワー東へB機情報を移管した\tA20:actor,A21:actor,A14:confirmed_recipient\tp3\trecorded',
      'E6\t17:40\tC滑走路順序調整\tタワー東が離着陸順序を調整した\tA14:actor\tp3\trecorded',
      'E7\t17:42\t進入継続指示\tタワー東が機長B・訓練乗員へ進入継続を指示した\tA14:actor,A24:confirmed_recipient,A25:confirmed_recipient\tp3,p4\trecorded',
      'E8\t17:43\t無線連絡受信\t羽田通信がA機と交信し機上通信員A・機上整備員Aが確認した\tA38:actor,A9:actor,A8:actor,A6:confirmed_recipient\tp1,p2\trecorded',
      'E9\t17:44\tB機着陸許可\tタワー東がB機へ34R着陸許可を発出した\tA14:actor,A24:confirmed_recipient,A25:confirmed_recipient\tp3,p4\trecorded',
      'E10\t17:44\t離陸機間隔監視\tタワー東が先行機間隔を監視した\tA14:actor\tp3\trecorded',
      'E11\t17:45\tC5停止位置指示\tタワー東がA機へC5停止位置までの走行を指示した\tA14:actor,A7:confirmed_recipient\tp2,p3\trecorded',
      'E12\t17:45\t停止位置復唱と誤認\t副操縦員Aが復唱しタワー東が受領、機長Aが進入許可と誤認した\tA7:actor,A14:confirmed_recipient,A6:actor\tp2,p3\trecorded',
      'E13\t17:45\t滑走路進入・整備員確認\t機長Aと副操縦員AがJA722Aを進入させ機上整備員Aが外部確認した\tA6:actor,A7:actor,A11:actor,A8:actor\tp2\trecorded',
      'E14\t17:46\t注意喚起表示\t滑走路占有監視支援機能が作動しタワー西・タワー東に表示された\tA43:actor,A16:target,A14:intended_recipient\tp3\trecorded',
      'E15\t17:46\t滑走路上停止継続\t機長A・副操縦員A・機上整備員A・機上通信員Aが滑走路上で待機継続した\tA6:actor,A7:actor,A8:actor,A9:actor,A11:actor\tp2\trecorded',
      'E37\t17:47\tA機視認遅れ・着陸操作継続\t機長Bと訓練乗員がA機を視認できずJA13XJの着陸操作を継続した\tA24:actor,A25:actor,A36:actor\tp4\trecorded',
      'E35\t17:47\t両機衝突・火災発生\tJA13XJとJA722Aが衝突し火災が発生した\tA36:actor,A11:target,A5:affected\tp2,p4\trecorded',
      'E41\t17:48\tA機搭乗員死傷確定\tA機搭乗員5名が死傷した\tA6:affected,A7:affected,A8:affected,A9:affected,A10:affected\tp2\trecorded',
      'E44\t17:50\t客室非常脱出誘導\tJA13XJ客室乗務員と先任客室乗務員が乗客を誘導した\tA27:actor,A28:actor,A35:actor\tp4\trecorded',
      'E45\t17:58\tB機全員脱出完了\t機長B・客室乗務員・乗客の全員脱出が完了した\tA24:actor,A27:affected,A35:affected\tp4\trecorded',
      'E46\t17:58\tB機客室内延焼・焼損\tJA13XJ機体が焼損した\tA36:affected,A37:affected,A35:affected\tp4\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\ttransfer\tE1\tA4\tE2\tA2\tp1\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE5\tA20\tE6\tA14\tp3\tinformation\toccurred\tconfirmed',
      'R3\ttransfer\tE11\tA14\tE12\tA7\tp2,p3\tinformation\toccurred\tconfirmed',
      'R4\timpact\tE15\tA11\tE35\tA36\tp2,p4\tother\toccurred\tna',
      'R5\timpact\tE35\tA5\tE41\tA6\tp2\tother\toccurred\tna',
      'R6\timpact\tE37\tA24\tE35\tA36\tp4\tother\toccurred\tna',
      'R7\tbefore\tE44\t-\tE45\t-\tp4\t-\t-\t-',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE35:loss,E41:loss,E45:recovery,E46:loss\tp2,p4\t両機衝突・死傷とB機脱出・焼損',
      '[仮判定]',
      'E12\tvariation\t停止位置指示の進入許可誤認\tp2',
      'E13\tvariation\t滑走路誤進入\tp2',
      'E14\tvariation\t注意喚起表示見落とし\tp3',
      'E15\tvariation\t滑走路上停止継続\tp2',
      'E37\tvariation\t滑走路上A機未視認のまま着陸継続\tp4',
      'E44\tvariation:resilient\t客室非常脱出誘導\tp4',
      '[完了]',
    ].join('\n');

    const fineAnalysis = buildFineAnalysis(ledger, source);
    const fineBase = captureFineGrainedBase(fineAnalysis);
    const fineSchema = projectAnalysis(fineAnalysis);

    // 1. Merge guard verification: shared adverse event E37 between co-pilots A24 & A25 is NOT asymmetric;
    //    same-cohort pilot A24 (recovery) vs airframe A36 (loss) is soft-guarded, not hard-blocked!
    const guardCoPilots = evaluateMergeGuard('A24', 'A25', fineAnalysis);
    expect(guardCoPilots.allowed).toBe(true);
    expect(guardCoPilots.strictAsymmetry).toBeUndefined();
    const guardPilotMachine = evaluateMergeGuard('A24', 'A36', fineAnalysis);
    expect(guardPilotMachine.strictAsymmetry).toBe(false);
    expect(guardPilotMachine.reason).toBeTruthy();

    // 2. Reproduction of lf15 LLM TSV (including M1 bundling A14+A15..A18+A43 -> A13, P1 bundling A5+A11, and virtual group reference in [分離維持ペア])
    const llmTsv = [
      '[推奨統合]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M1\tposet_rollup\tA14,A15,A16,A17,A18,A43\tA13\t-\torganization\t0.14\tタワー各席と監視支援機能をタワーへ統合',
      'M2\trole_group\tA13,A20,A21\t-\t航空管制機関\torganization\t0.16\tタワーと進入管制席を航空管制機関へ統合',
      'M3\tposet_rollup\tA28\tA27\t-\torganization\t0.05\t先任客室乗務員を客室乗務員へ統合',
      'M4\tposet_rollup\tA38,A4\tA2\t-\torganization\t0.08\t羽田通信・本庁対策本部を羽田航空基地へ統合',
      'M5\trole_group\tA36,A37\t-\tJA13XJ（B機・運航機体）\tmachine\t0.06\tB機機体と複合機体表現を統合',
      'M6\tposet_rollup\tA24,A25\tA23\t-\torganization\t0.12\t機長Bと訓練乗員をJA13XJ運航乗務員へ統合',
      '[予備候補]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'P1\trole_group\tA5,A11\t-\tJA722A（A機・搭乗員）\torganization\t0.12\tA機搭乗員とA機機体の統合',
      'P2\trole_group\tA23,M5\t-\tJA13XJ運航乗務員・機体\torganization\t0.18\tB機運航乗務員とB機機体の統合',
      'P3\trole_group\tA27,A35\t-\tJA13XJ客室乗務員・乗客\torganization\t0.20\tB機客室脱出グループの統合',
      '[分離維持ペア]',
      '主体A\t主体B\t強さ\t理由',
      'A6\tA7\thard\t機長Aと副操縦員Aの認識差異を分離維持',
      'A14\tA6\thard\tタワー東と機長Aを分離維持',
      'M2\tM5\thard\t航空管制機関とB機機体を分離維持',
      '[完了]',
    ].join('\n');

    const parsed = parseLaneConsolidationTSV(llmTsv, fineBase, fineAnalysis);
    expect(parsed.invalidLines).toEqual([]);

    const optRes = await optimizeLaneConsolidation(
      dummyConfig,
      fineSchema,
      async () => ({ latencyMs: 30, content: llmTsv }),
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );
    const assign = optRes.consolidation.laneAssignment;
    const lanes = visibleSchema(optRes.schema).lanes;

    // 3. Collective hub A5 is canonically covered (excluded: true), preventing P1(A5, A11) parent-child coexistence alongside A6..A10!
    expect(assign['A5']).toBeUndefined();
    const rankA5 = optRes.analysis.subjectRanking?.ranks.find((r) => r.entityId === 'A5');
    expect(rankA5?.excluded).toBe(true);
    expect(lanes).not.toContain('JA722A搭乗員');
    expect(lanes).not.toContain('JA722A（A機・搭乗員）');

    // 4. Primary ATC protagonist A14 (タワー東) is peeled & retained independently while A15..A18, A43, A20, A21 fold into 航空管制機関!
    expect(assign['A14']).toBe('A14');
    expect(lanes).toContain('タワー東');
    expect(assign['A15']).toBe(assign['A20']);
    expect(assign['A43']).toBe(assign['A20']);

    // 5. Core JA722A pilots A6 & A7 stay independent while auxiliary crew {A8, A9, A10} (including 1-card A10) unify into a cohort subgroup!
    expect(assign['A6']).toBe('A6');
    expect(assign['A7']).toBe('A7');
    expect(assign['A8']).toBe(assign['A9']);
    expect(assign['A9']).toBe(assign['A10']);
    expect(assign['A8']).not.toBe('A6');

    // 6. Co-pilots A24 & A25 consolidate cleanly and total lanes converge from 25 fine lanes down to <= 9 (vs 14 in lf15)!
    expect(assign['A24']).toBe(assign['A25']);
    expect(optRes.fineLaneCount).toBe(25);
    expect(optRes.finalLaneCount).toBeLessThanOrEqual(9);
    expect(graphDiagnostics(optRes.schema).missingRelations).toEqual([]);

    // 7. Pure partition objective is path-invariant under candidate pool reversal!
    const fallback = generateStructuralFallbackCandidates(fineBase, fineAnalysis);
    const fullCands = [...parsed.candidates, ...fallback.candidates];
    const fullSeps = [...fallback.separationConstraints, ...parsed.separationConstraints];
    const fwd = searchOptimalLaneConsolidation(fineBase, fineAnalysis, fullCands, fullSeps, {
      targetMaxSubjects: 7,
    });
    const rev = searchOptimalLaneConsolidation(fineBase, fineAnalysis, [...fullCands].reverse(), fullSeps, {
      targetMaxSubjects: 7,
    });
    expect(rev.consolidation.score).toBe(fwd.consolidation.score);
    expect(rev.consolidation.metrics.c2).toBe(fwd.consolidation.metrics.c2);
  });

  it('verifies Stage 1 forest invariants on vta-test-data/鹿沼駅事故.md and vta-test-data/羽田事故_20261025_141902.md (0u9b nested M3,M4->M5, bp8u M8 machine->person rejection & A_JAL non-inversion, ADR-0095)', async () => {
    // 1) Real scenario file #1: vta-test-data/鹿沼駅事故.md (0u9b nested composite tree M3, M4 -> M5)
    const kanumaText = loadVtaTestScenarioText('鹿沼駅事故.md', 30, '鹿沼駅シナリオ');
    const kanumaSource = sourceFromText(kanumaText);
    expect(kanumaSource.paragraphs.length).toBeGreaterThan(20);
    const kp1 = kanumaSource.paragraphs[0].id;
    const kp2 = kanumaSource.paragraphs[1].id;
    const kp3 = kanumaSource.paragraphs[2].id;
    const kp4 = kanumaSource.paragraphs[3].id;

    const kanumaLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      `A1\t東武鉄道株式会社\torganization\tmid\t-\t${kp1}`,
      `A2\t北関東工務事務所\torganization\tlow\tA1\t${kp1}`,
      `A3\t下請会社\torganization\tlow\t-\t${kp2}`,
      `A4\t除草薬散布作業班\torganization\thigh\t-\t${kp2}`,
      `A5\tA作業指揮者\tperson\thigh\tA4\t${kp2}`,
      `A6\tB列車見張員\tperson\thigh\tA4\t${kp3}`,
      `A7\tC中継見張員\tperson\tmid\tA4\t${kp3}`,
      `A8\tD中継見張員\tperson\tmid\tA4\t${kp3}`,
      `A9\tE作業員\tperson\tmid\tA4\t${kp3}`,
      `A10\tF作業員\tperson\tmid\tA3,A4\t${kp3}`,
      `A11\tG現場代理人\tperson\thigh\tA4\t${kp4}`,
      `A12\tH・I・J作業員\tperson\thigh\tA3,A4\t${kp4}`,
      `A13\t第1020列車編成\torganization\thigh\tA1\t${kp4}`,
      `A14\t第1020列車運転士\tperson\thigh\tA13\t${kp4}`,
      `A15\t第1020列車車両\tmachine\thigh\tA13\t${kp4}`,
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      `E1\t事前\t作業委託\t北関東工務事務所が委託した\tA2:actor\t${kp1}\trecorded`,
      `E2\t当日朝\t作業員派遣\t下請会社が派遣した\tA3:actor,A10:target,A12:target\t${kp2}\trecorded`,
      `E3\t09:00\t点呼実施\tA作業指揮者が点呼した\tA5:actor,A11:actor\t${kp2}\trecorded`,
      `E4\t10:15\t中継見張配置\tC・D中継見張員が配置についた\tA7:actor,A8:actor\t${kp3}\trecorded`,
      `E5\t10:45\t接近合図と待避\tB見張員が合図しE・F作業員が待避した\tA6:actor,A9:actor,A10:actor\t${kp3}\trecorded`,
      `E6\t10:46\t列車触車\t運転士・車両がG代理人・HIJ作業員と触車した\tA14:actor,A15:actor,A11:affected,A12:affected\t${kp4}\trecorded`,
      '[関係]',
      `R1\ttransfer\tE3\tA5\tE4\tA7\t${kp2},${kp3}\tinformation\toccurred\tconfirmed`,
      `R2\ttransfer\tE5\tA6\tE6\tA11\t${kp3},${kp4}\tinformation\toccurred\tunconfirmed`,
      '[共有カード]',
      '[整理]',
      '[帰結]',
      `O1\tidentified\tE6:loss\t${kp4}\t列車触車による4名死亡`,
      '[完了]',
    ].join('\n');

    const kanumaAnalysis = inspectLedger(parseLedger(kanumaLedger), kanumaSource).analysis!;
    const kanumaOpt = await optimizeLaneConsolidation(
      dummyConfig,
      projectAnalysis(kanumaAnalysis),
      async () => ({
        latencyMs: 10,
        content: [
          '[推奨統合]',
          'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
          'M1\tposet_rollup\tA14,A15\tA13\t-\torganization\t0.06\t運転士と車両を列車編成へ統合',
          'M2\tperipheral_others\tA2,A3\tsubject_others\tその他の関係者\tother\t0.08\t周辺組織の集約',
          'M3\trole_group\tA7,A8\t-\t中継見張員\torganization\t0.10\tC・D中継見張員の統合',
          'M4\trole_group\tA9,A10\t-\t待避作業員\torganization\t0.12\tE・F作業員の統合',
          '[予備候補]',
          'M5\trole_group\tM3,M4\t-\t補助作業員群\torganization\t0.18\t中継・待避サブグループの入れ子統合',
          '[分離維持ペア]',
          'A11\tA12\thard\t現場代理人と作業員を分離維持',
          '[完了]',
        ].join('\n'),
      }),
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );

    const kComposites = kanumaOpt.consolidation.composites ?? {};
    const m5RootId = kanumaOpt.consolidation.laneAssignment['A7'];
    expect(m5RootId).toMatch(/^cmp_/);
    expect(kanumaOpt.consolidation.laneAssignment['A9']).toBe(m5RootId);
    const m5Record = kComposites[m5RootId];
    expect(m5Record).toBeDefined();
    expect(m5Record.compositeOf).toHaveLength(2);
    // M3 and M4 remain sealed nested child composites inside M5 (never flattened or destroyed!)
    for (const childCompId of m5Record.compositeOf) {
      expect(childCompId).toMatch(/^cmp_/);
      expect(kComposites[childCompId]).toBeDefined();
    }
    assertProjectedEntitiesPartition(
      ['A2', 'A3', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A14', 'A15'],
      kanumaOpt.analysis.entities
    );

    // 2) Real scenario file #2: vta-test-data/羽田事故_20261025_141902.md (bp8u M8 machine->person rejection & A_JAL non-inversion)
    const hanedaText = loadVtaTestScenarioText('羽田事故_20261025_141902.md', 60, '羽田空港シナリオ');
    const hanedaSource = sourceFromText(hanedaText);
    expect(hanedaSource.paragraphs.length).toBeGreaterThan(50);
    const hp1 = hanedaSource.paragraphs[0].id;
    const hp2 = hanedaSource.paragraphs[1].id;
    const hp3 = hanedaSource.paragraphs[2].id;

    const hanedaLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      `A_JCG\t海上保安庁\torganization\tmid\t-\t${hp1}`,
      `A_CAPT_A\t機長A\tperson\thigh\tA_JCG\t${hp1}`,
      `A_JA722A\tJA722A（A機）\tmachine\thigh\tA_JCG\t${hp1}`,
      // 0-event corporate root covering all B-aircraft subjects
      `A_JAL\t日本航空株式会社\torganization\tmid\t-\t${hp2}`,
      `A_CAPT_B\t機長B\tperson\thigh\tA_JAL\t${hp2}`,
      `A_CABIN_B\tB機客室乗務員\tperson\tmid\tA_JAL\t${hp3}`,
      `A_JA13XJ\tJA13XJ（B機）\tmachine\thigh\tA_JAL\t${hp2}`,
      `A_TWR_E\tタワー東\tperson\thigh\t-\t${hp1}`,
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      `E1\t17:45\t滑走路進入\t機長AがJA722Aで滑走路へ進入した\tA_CAPT_A:actor,A_JA722A:actor,A_TWR_E:target\t${hp1}\trecorded`,
      `E2\t17:47\t着陸衝突\t機長BのJA13XJとJA722Aが衝突した\tA_CAPT_B:actor,A_JA13XJ:actor,A_JA722A:affected,A_CAPT_A:affected\t${hp2}\trecorded`,
      `E3\t17:55\t非常脱出完了\t機長Bと客室乗務員が脱出し機体が焼損した\tA_CAPT_B:actor,A_CABIN_B:actor,A_JA13XJ:affected\t${hp3}\trecorded`,
      '[関係]',
      `R1\timpact\tE1\tA_JA722A\tE2\tA_JA13XJ\t${hp1},${hp2}\tother\toccurred\tna`,
      '[共有カード]',
      '[整理]',
      '[帰結]',
      `O1\tidentified\tE2:loss,E3:recovery\t${hp2},${hp3}\t衝突と全員脱出`,
      '[完了]',
    ].join('\n');

    const hanedaAnalysis = inspectLedger(parseLedger(hanedaLedger), hanedaSource).analysis!;
    const hanedaFineBase = captureFineGrainedBase(hanedaAnalysis);

    const bp8uTsv = [
      '[推奨統合]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      // Illegal machine -> person absorption M8 from bp8u MUST be rejected!
      'M8\tobject_absorb\tA_JA722A\tA_CAPT_A\t-\tperson\t0.05\t機体を機長個人へ吸収（不正）',
      // Valid human-machine composite system S for A-aircraft
      'M_SYS_A\trole_group\tA_CAPT_A,A_JA722A\t-\tA機運航システム\torganization\t0.08\t機長AとA機からなる人間・機械システム',
      // Valid B-aircraft composite group covering all active descendants of 0-event A_JAL
      'M_SYS_B\trole_group\tA_CAPT_B,A_CABIN_B,A_JA13XJ\t-\tB機全体システム\torganization\t0.10\tB機クルーと機体の複合システム',
      '[完了]',
    ].join('\n');

    const parsedBp8u = parseLaneConsolidationTSV(bp8uTsv, hanedaFineBase, hanedaAnalysis);
    expect(parsedBp8u.invalidLines.some((l) => l.startsWith('M8\t'))).toBe(true);
    expect(parsedBp8u.candidates.some((c) => c.id === 'M8')).toBe(false);

    const hanedaOpt = searchOptimalLaneConsolidation(
      hanedaFineBase,
      hanedaAnalysis,
      parsedBp8u.candidates,
      parsedBp8u.separationConstraints,
      { targetMaxSubjects: 3 }
    );
    const sBId = hanedaOpt.consolidation.laneAssignment['A_CAPT_B'];
    expect(sBId).toMatch(/^cmp_/);
    const hPoset = SubjectPoset.fromData(hanedaOpt.bestSchema.analysis!.subjectPoset!);
    // Full-cover 0-event corporate root A_JAL sits ABOVE M_SYS_B (M_SYS_B ≺ A_JAL), NEVER inverted below it!
    expect(hPoset.isAncestor('A_JAL', sBId)).toBe(true);
    expect(hPoset.isAncestor(sBId, 'A_JAL')).toBe(false);
    assertProjectedEntitiesPartition(
      ['A_CAPT_A', 'A_JA722A', 'A_CAPT_B', 'A_CABIN_B', 'A_JA13XJ', 'A_TWR_E'],
      hanedaOpt.bestSchema.analysis!.entities
    );

    // 3) Live Antigravity Flash TSV verification on vta-test-data/鹿沼駅事故.md
    const flashKanumaTsv = [
      '[推奨統合]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M1\tposet_rollup\tA14,A15\tA13\t-\torganization\t0.08\t運転士と車両間にモード混乱や機器故障の対立がなく複合上位主体の列車編成へ全統合できるため',
      'M2\tperipheral_others\tA2,A3\tsubject_others\tその他の関係者\tother\t0.06\t事前の作業委託・点呼対応や作業員派遣のみを担う周辺組織であるため',
      'M3\trole_group\tA7,A8\t-\t中継見張員\torganization\t0.10\t同一場面で並列・同質の中継見張役割を担うC・D中継見張員を束ねるため',
      'M4\trole_group\tA9,A10\t-\t待避作業員\torganization\t0.10\t現場で列車接近時に待避行動をとった一般作業員E・Fを同質ロールとして束ねるため',
      '[予備候補]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M5\trole_group\tA7,A8,A9,A10\t-\t中継見張員・待避作業員\torganization\t0.22\t目標7レーンへの圧縮時に親作業班への部分統合を避けつつ補助班員群を1レーンへまとめるため',
      'M6\trole_group\tA6,A7,A8\t-\t見張員（列車・中継）\torganization\t0.32\t列数上限が厳しい場合にB列車見張員とC・D中継見張員を見張機能としてまとめるため',
      'M7\tposet_rollup\tA5,A6,A7,A8,A9,A10,A11,A12\tA4\t-\torganization\t0.62\t列数上限が極端に小さい場合に除草薬散布作業班の全アクティブメンバーを上位枠へ一括統合するため',
      '[分離維持ペア]',
      '主体A\t主体B\t強さ\t理由',
      'A11\tA14\thard\t触車被災側と列車運転側で帰結・責任境界が非対称なため',
      'A12\tA14\thard\t触車被災作業員と列車運転士で役割・帰結が非対称なため',
      'A11\tA12\thard\t単独の立入指示・判断を担う現場代理人側と指示を受ける被災作業員側で事象の主語が歪むため',
      'A5\tA11\thard\t任務を委譲し自ら待避した作業指揮者側と作業を引き継ぎ立入指示・触車した現場代理人側で責任境界が異なるため',
      'A6\tA11\thard\t列車到着3分前を伝達・待避合図した見張側と意見を述べさせず立入指示した指揮側で伝達・判断対立があるため',
      'A6\tA14\thard\t列車停止手配未実施の見張側と接近了解合図を確認し進入・非常停止した運転士側で安全確認責任が分かれるため',
      'A9\tA12\tsoft\t待避に成功した作業員側と触車被災した作業員側で最終帰結が異なるため',
      '[完了]',
    ].join('\n');

    const parsedFlashKanuma = parseLaneConsolidationTSV(
      flashKanumaTsv,
      captureFineGrainedBase(kanumaAnalysis),
      kanumaAnalysis
    );
    expect(parsedFlashKanuma.invalidLines).toEqual([]);
    const flashKanumaOpt = await optimizeLaneConsolidation(
      dummyConfig,
      projectAnalysis(kanumaAnalysis),
      async () => ({ latencyMs: 12, content: flashKanumaTsv }),
      undefined,
      undefined,
      { targetMaxSubjects: 7 }
    );
    expect(flashKanumaOpt.finalLaneCount).toBe(7);
    // Exact Root Cover seals M3 and M4 inside M5 without splitting M3 (so M6=[A6,A7,A8] cannot partially split M3 or drag external roots!)
    const fkRoot7 = flashKanumaOpt.consolidation.laneAssignment['A7'];
    expect(flashKanumaOpt.consolidation.laneAssignment['A9']).toBe(fkRoot7);
    expect(flashKanumaOpt.consolidation.composites?.[fkRoot7]?.compositeOf).toHaveLength(2);
    assertProjectedEntitiesPartition(
      ['A2', 'A3', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A14', 'A15'],
      flashKanumaOpt.analysis.entities
    );
  });

  it('verifies Stage 2 continuous intra-bucket dominance P_sub^eff, peripheral Poset branch/root folding (HG2d), and live Antigravity Flash TSV on vta-test-data/羽田事故_20261025_141902.md (ADR-0096)', async () => {
    const { buildSubjectOthersEligibilitySet } = await import('./laneConsolidationOptimizer');
    const hanedaText = loadVtaTestScenarioText('羽田事故_20261025_141902.md', 60, '羽田空港シナリオ');
    const hanedaSource = sourceFromText(hanedaText);
    const p1 = hanedaSource.paragraphs[0].id;
    const p2 = hanedaSource.paragraphs[1].id;
    const p3 = hanedaSource.paragraphs[2].id;
    const p4 = hanedaSource.paragraphs[3].id;

    // 1) Full 21-entity Haneda scenario matching the live Antigravity Flash evaluation (`tsv-haneda`)
    const fullHanedaLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      `A_JCG\t海上保安庁\torganization\tmid\t-\t${p1}`,
      `A_HND_BASE\t羽田航空基地\torganization\tlow\tA_JCG\t${p1}`,
      `A_HND_COMM\t羽田通信\torganization\tlow\tA_HND_BASE\t${p1}`,
      `A_CREW_A\tJA722A搭乗員\torganization\thigh\tA_JCG\t${p2}`,
      `A_CAPT_A\t機長A\tperson\thigh\tA_CREW_A\t${p2}`,
      `A_FO_A\t副操縦員A\tperson\thigh\tA_CREW_A\t${p2}`,
      `A_MECH_A\t機上整備員A\tperson\tmid\tA_CREW_A\t${p2}`,
      `A_COMM_A\t機上通信員A\tperson\tmid\tA_CREW_A\t${p2}`,
      `A_JA722A\tJA722A（A機）\tmachine\thigh\tA_JCG\t${p2}`,
      `A_ATC\t東京飛行場管制所\torganization\tmid\t-\t${p3}`,
      `A_TWR_E\tタワー東\tperson\thigh\tA_ATC\t${p3}`,
      `A_GND_E\tグラウンド東\tperson\tlow\tA_ATC\t${p3}`,
      `A_DELIV\tデリバリー\tperson\tlow\tA_ATC\t${p3}`,
      `A_SYS\t滑走路占有監視支援機能\tmachine\tmid\tA_ATC\t${p3}`,
      `A_JAL\t日本航空株式会社\torganization\tmid\t-\t${p4}`,
      `A_CAPT_B\t機長B\tperson\thigh\tA_JAL\t${p4}`,
      `A_PF_B\t訓練乗員B\tperson\thigh\tA_JAL\t${p4}`,
      `A_CABIN_B\tB機客室乗務員\torganization\thigh\tA_JAL\t${p4}`,
      `A_PAX_B\tB機乗客\torganization\tmid\tA_JAL\t${p4}`,
      `A_JA13XJ\tJA13XJ（B機）\tmachine\thigh\tA_JAL\t${p4}`,
      `A_FIRE\t空港消防\torganization\tlow\t-\t${p4}`,
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      `E0\t16:00\t監視支援規定運用\t東京飛行場管制所が規定を運用していた\tA_ATC:actor\t${p3}\trecorded`,
      `E1\t16:45\t物資輸送計画支援\t羽田航空基地がA機運航を支援した\tA_HND_BASE:actor,A_CAPT_A:confirmed_recipient\t${p1},${p2}\trecorded`,
      `E2\t17:15\t管制承認伝達\tデリバリーが副操縦員Aへ承認を伝達した\tA_DELIV:actor,A_FO_A:confirmed_recipient\t${p2},${p3}\trecorded`,
      `E3\t17:30\t地上走行指示\tグラウンド東が副操縦員Aへ地上走行を指示した\tA_GND_E:actor,A_FO_A:confirmed_recipient\t${p2},${p3}\trecorded`,
      `E4\t17:42\t進入継続指示\tタワー東が機長B・訓練乗員Bへ進入継続を指示した\tA_TWR_E:actor,A_CAPT_B:confirmed_recipient,A_PF_B:confirmed_recipient\t${p3},${p4}\trecorded`,
      `E5\t17:43\t無線連絡受信\t羽田通信がA機と交信し通信員A・整備員Aが確認した\tA_HND_COMM:actor,A_COMM_A:actor,A_MECH_A:actor\t${p1},${p2}\trecorded`,
      `E6\t17:44\t34R着陸許可\tタワー東がB機へ着陸許可を発出した\tA_TWR_E:actor,A_CAPT_B:confirmed_recipient,A_PF_B:confirmed_recipient\t${p3},${p4}\trecorded`,
      `E7\t17:44\t離陸機間隔監視\tタワー東が先行離陸機との間隔を監視した\tA_TWR_E:actor\t${p3}\trecorded`,
      `E8\t17:45\tC5停止位置指示\tタワー東がA機へC5停止位置までの走行を指示した\tA_TWR_E:actor,A_FO_A:confirmed_recipient\t${p2},${p3}\trecorded`,
      `E9\t17:45\t復唱と進入許可誤認\t副操縦員Aが復唱しタワー東が受領、機長Aが進入許可と誤認した\tA_FO_A:actor,A_TWR_E:confirmed_recipient,A_CAPT_A:actor\t${p2},${p3}\trecorded`,
      `E10\t17:45\t滑走路進入\t機長Aと副操縦員AがJA722Aを滑走路へ進入させた\tA_CAPT_A:actor,A_FO_A:actor,A_JA722A:actor\t${p2}\trecorded`,
      `E11\t17:46\t注意喚起表示と未視認\t監視支援機能が注意喚起を表示したがタワー東が視認しなかった\tA_SYS:actor,A_TWR_E:intended_recipient\t${p3}\trecorded`,
      `E12\t17:46\t滑走路上停止継続\t機長AらがJA722Aで滑走路上に停止継続した\tA_CAPT_A:actor,A_JA722A:actor\t${p2}\trecorded`,
      `E13\t17:47\t着陸操作継続\t機長Bと訓練乗員BがJA13XJの着陸操作を継続した\tA_CAPT_B:actor,A_PF_B:actor,A_JA13XJ:actor\t${p4}\trecorded`,
      `E14\t17:47\t衝突・炎上と搭乗員死傷\tJA13XJとJA722Aが衝突しA機搭乗員が死傷した\tA_JA13XJ:actor,A_JA722A:affected,A_CAPT_A:affected,A_FO_A:affected,A_MECH_A:affected,A_COMM_A:affected\t${p2},${p4}\trecorded`,
      `E15\t17:48\tB機減速不能・滑走路逸脱停止\t管制席が事故を視認しB機が滑走路脇で停止した\tA_TWR_E:actor,A_JA13XJ:actor\t${p3},${p4}\trecorded`,
      `E16\t17:50\t客室非常脱出誘導\tB機客室乗務員が乗客を非常脱出誘導した\tA_CABIN_B:actor,A_PAX_B:actor\t${p4}\trecorded`,
      `E17\t17:58\t全員脱出完了と消火・焼損\t機長Bの最終確認で全員脱出し空港消防が出動したが機体が焼損した\tA_CAPT_B:actor,A_PAX_B:affected,A_JA13XJ:affected,A_FIRE:target\t${p4}\trecorded`,
      '[関係]',
      `R1\ttransfer\tE1\tA_HND_BASE\tE9\tA_CAPT_A\t${p1},${p2}\tinformation\toccurred\tconfirmed`,
      `R2\ttransfer\tE8\tA_TWR_E\tE9\tA_FO_A\t${p2},${p3}\tinformation\toccurred\tconfirmed`,
      `R3\timpact\tE12\tA_JA722A\tE14\tA_JA13XJ\t${p2},${p4}\tother\toccurred\tna`,
      `R4\timpact\tE13\tA_CAPT_B\tE14\tA_JA13XJ\t${p4}\tother\toccurred\tna`,
      `R5\tbefore\tE16\t-\tE17\t-\t${p4}\t-\t-\t-`,
      '[共有カード]',
      '[整理]',
      '[帰結]',
      `O1\tidentified\tE14:loss,E17:recovery\t${p2},${p4}\t両機衝突・死傷とB機全員脱出`,
      '[仮判定]',
      `E9\tvariation\t停止位置指示の進入許可誤認\t${p2}`,
      `E10\tvariation\t滑走路誤進入\t${p2}`,
      `E11\tvariation\t注意喚起表示見落とし\t${p3}`,
      `E12\tvariation\t滑走路上停止継続\t${p2}`,
      `E13\tvariation\tA機未視認のまま着陸継続\t${p4}`,
      `E16\tvariation:resilient\t客室非常脱出誘導\t${p4}`,
      '[完了]',
    ].join('\n');

    const fullHanedaAnalysis = inspectLedger(parseLedger(fullHanedaLedger), hanedaSource).analysis!;
    const fullHanedaFineBase = captureFineGrainedBase(fullHanedaAnalysis);
    const eligibleOthers = buildSubjectOthersEligibilitySet(fullHanedaFineBase, fullHanedaAnalysis);

    // Stage 2B check: pure peripheral JCG shore branch {A_HND_BASE, A_HND_COMM} (separated from A_CREW_A) + A_FIRE are ALL eligible,
    // whereas A_GND_E / A_DELIV under active operational parent A_ATC (which also parents protagonist A_TWR_E) are excluded from others!
    expect(eligibleOthers.has('A_HND_BASE')).toBe(true);
    expect(eligibleOthers.has('A_HND_COMM')).toBe(true);
    expect(eligibleOthers.has('A_FIRE')).toBe(true);
    expect(eligibleOthers.has('A_GND_E')).toBe(false);
    expect(eligibleOthers.has('A_DELIV')).toBe(false);

    const flashHanedaTsv = [
      '[推奨統合]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M1\trole_group\tA_CAPT_A,A_FO_A,A_MECH_A,A_COMM_A,A_JA722A\t-\tJA722A（A機・搭乗員）\torganization\t0.26\t機長Aらの指示誤認に基づく滑走路進入・衝突事象であり搭乗員とA機間に機器故障対立がなく一体表現できるため',
      'M2\trole_group\tA_GND_E,A_DELIV\t-\t他管制席（地上・デリバリー）\torganization\t0.08\t滑走路進入前の定常的な地上走行指示・承認伝達を担う同質管制席を束ねるため',
      'M3\trole_group\tA_CAPT_B,A_PF_B,A_JA13XJ\t-\tJA13XJ（B機・運航乗務員）\torganization\t0.26\t同一操縦室での進入・着陸操作から衝突後の停止・脱出対応までB機と運航乗務員を一体として整理するため',
      'M4\tperipheral_others\tA_HND_BASE,A_HND_COMM,A_FIRE\tsubject_others\tその他の関係者\tother\t0.08\t事前の運航支援・無線連絡および事後の消火出動を担う周辺主体を集約するため',
      '[予備候補]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M5\tperipheral_others\tA_HND_BASE,A_HND_COMM,A_GND_E,A_DELIV,A_FIRE\tsubject_others\tその他の関係者\tother\t0.11\t目標8レーンへ厳密に絞る場合に定常的な事前管制2席も周辺関係者枠へまとめて集約するため',
      'M6\tposet_rollup\tA_CAPT_A,A_FO_A,A_MECH_A,A_COMM_A\tA_CREW_A\t-\torganization\t0.24\tA機機体レーンを独立維持する場合に搭乗員4者を純粋上位枠JA722A搭乗員へ全統合するため',
      'M7\trole_group\tA_CAPT_B,A_PF_B\t-\tB機運航乗務員\torganization\t0.15\tB機機体（衝突後の系統損傷・焼損）を独立維持しつつ機長Bと訓練乗員Bのみを束ねるため',
      'M8\trole_group\tA_MECH_A,A_COMM_A\t-\tA機整備・通信員\torganization\t0.10\t機長A・副操縦員Aを個別維持する場合に操縦以外のA機後方搭乗員のみを同質ロールとして束ねるため',
      'M9\tposet_rollup\tA_TWR_E,A_GND_E,A_DELIV,A_SYS\tA_ATC\t-\torganization\t0.48\t列数上限が極端に小さい場合に管制側の全下位主体を東京飛行場管制所へ一括統合するため',
      '[分離維持ペア]',
      '主体A\t主体B\t強さ\t理由',
      'A_CAPT_A\tA_TWR_E\thard\t指示誤認により滑走路へ誤進入した機長A側と進入を認識できず監視を見落としたタワー東側で伝達・認識責任が非対称なため',
      'A_FO_A\tA_TWR_E\thard\t正しくC5停止位置を復唱した副操縦員A側とA機進入を見落とした管制側で責任境界が異なるため',
      'A_TWR_E\tA_SYS\thard\t占有重複の注意喚起を表示した監視支援システムと表示を見落としたタワー東側で検知・監視機能が非対称なため',
      'A_CAPT_A\tA_CAPT_B\thard\t滑走路上に誤進入・停止したA機側と着陸許可下で進入・脱出指揮したB機側で因果立場と帰結が非対称なため',
      'A_JA722A\tA_JA13XJ\thard\t衝突されたA機側と着陸進入して衝突・炎上したB機側で衝突当事者の境界が対立するため',
      'A_CABIN_B\tA_PAX_B\tsoft\t非常脱出を判断・誘導した客室乗務員側と誘導を受けて脱出した乗客側で指揮・受動の役割が異なるため',
      'A_JA13XJ\tA_CAPT_B\tsoft\t衝突後にブレーキ・系統故障と焼損を生じた機体側と非常脱出を指揮した機長B側で事後挙動が分かれるため',
      '[完了]',
    ].join('\n');

    const parsedFlashHaneda = parseLaneConsolidationTSV(
      flashHanedaTsv,
      fullHanedaFineBase,
      fullHanedaAnalysis
    );
    expect(parsedFlashHaneda.invalidLines).toEqual([]);
    const m4Parsed = parsedFlashHaneda.candidates.find((c) => c.id === 'M4');
    expect(m4Parsed?.sourceEntityIds).toEqual(['A_HND_BASE', 'A_HND_COMM', 'A_FIRE']);

    const flashHanedaOpt = await optimizeLaneConsolidation(
      dummyConfig,
      projectAnalysis(fullHanedaAnalysis),
      async () => ({ latencyMs: 18, content: flashHanedaTsv }),
      undefined,
      undefined,
      { targetMaxSubjects: 8 }
    );

    const hAssign = flashHanedaOpt.consolidation.laneAssignment;
    const hAggId = hAssign['A_FIRE'];
    expect(hAggId).toMatch(/^cmp_agg_/);
    // Entire peripheral branch {A_HND_BASE, A_HND_COMM} + A_FIRE folds cleanly into cmp_agg_*
    expect(hAssign['A_HND_BASE']).toBe(hAggId);
    expect(hAssign['A_HND_COMM']).toBe(hAggId);
    // Protagonist タワー東 stays independent of A_SYS and A_ATC, and B-aircraft cohorts do not collapse into 1 lane
    expect(hAssign['A_TWR_E']).toBe('A_TWR_E');
    expect(hAssign['A_TWR_E']).not.toBe(hAssign['A_SYS']);
    expect(hAssign['A_CAPT_B']).not.toBe(hAssign['A_CABIN_B']);
    expect(flashHanedaOpt.fineLaneCount).toBe(18);
    expect(flashHanedaOpt.finalLaneCount).toBeLessThanOrEqual(10);
    expect(graphDiagnostics(flashHanedaOpt.schema).missingRelations).toEqual([]);
    assertProjectedEntitiesPartition(
      [
        'A_HND_BASE',
        'A_HND_COMM',
        'A_CAPT_A',
        'A_FO_A',
        'A_MECH_A',
        'A_COMM_A',
        'A_JA722A',
        'A_ATC',
        'A_TWR_E',
        'A_GND_E',
        'A_DELIV',
        'A_SYS',
        'A_CAPT_B',
        'A_PF_B',
        'A_CABIN_B',
        'A_PAX_B',
        'A_JA13XJ',
        'A_FIRE',
      ],
      flashHanedaOpt.analysis.entities
    );

    // 2) Stage 2A & 2B structural edge cases:
    //    (a) Over-broad [推奨統合] poset_rollup into a 0-event hub (A_ATC_ZERO) protects solo protagonist A_TWR_E via d(X, B)
    //        and peels {A_GND_E, A_DELIV} into a distinct composite P' beneath A_ATC_ZERO (preserving HG2c)!
    //    (b) Sealed 0-event peripheral hub cmp(A_TMA_DIV: A_DF+A_AFS) folds as a nested composite child into cmp_agg_* alongside A_FIRE,
    //        while HG2d rejects partial A_DF + A_FIRE without A_AFS!
    const zeroHubLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      `A_ATC_ZERO\t東京飛行場管制所\torganization\thigh\t-\t${p3}`,
      `A_TWR_E\tタワー東\tperson\thigh\tA_ATC_ZERO\t${p3}`,
      `A_GND_E\tグラウンド東\tperson\tlow\tA_ATC_ZERO\t${p3}`,
      `A_DELIV\tデリバリー\tperson\tlow\tA_ATC_ZERO\t${p3}`,
      `A_TMA_DIV\t東京進入管制所\torganization\tmid\t-\t${p3}`,
      `A_DF\t羽田出域調整席\tperson\tlow\tA_TMA_DIV\t${p3}`,
      `A_AFS\t羽田捜索調整席\tperson\tlow\tA_TMA_DIV\t${p3}`,
      `A_CAPT_A\t機長A\tperson\thigh\t-\t${p2}`,
      `A_CAPT_B\t機長B\tperson\thigh\t-\t${p4}`,
      `A_FIRE\t空港消防\torganization\tlow\t-\t${p4}`,
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      `E1\t17:15\t承認伝達\tデリバリーが機長Aへ伝達した\tA_DELIV:actor,A_CAPT_A:confirmed_recipient\t${p2},${p3}\trecorded`,
      `E2\t17:30\t地上走行指示\tグラウンド東が機長Aへ指示した\tA_GND_E:actor,A_CAPT_A:confirmed_recipient\t${p2},${p3}\trecorded`,
      `E3\t17:35\t進入移管\tDFとAFSがタワー東へ移管した\tA_DF:actor,A_AFS:actor,A_TWR_E:confirmed_recipient\t${p3}\trecorded`,
      `E4\t17:40\t離着陸順序調整\tタワー東が順序調整した\tA_TWR_E:actor\t${p3}\trecorded`,
      `E5\t17:42\t進入継続指示\tタワー東が機長Bへ指示した\tA_TWR_E:actor,A_CAPT_B:confirmed_recipient\t${p3},${p4}\trecorded`,
      `E6\t17:44\t着陸許可\tタワー東が機長Bへ着陸許可を出した\tA_TWR_E:actor,A_CAPT_B:confirmed_recipient\t${p3},${p4}\trecorded`,
      `E7\t17:45\t停止位置指示\tタワー東が機長Aへ停止位置を指示した\tA_TWR_E:actor,A_CAPT_A:confirmed_recipient\t${p2},${p3}\trecorded`,
      `E8\t17:46\t滑走路監視見落とし\tタワー東が滑走路上のA機を見落とした\tA_TWR_E:actor\t${p3}\trecorded`,
      `E9\t17:47\t衝突と消火出動\t機長B機と機長A機が衝突し空港消防が出動した\tA_CAPT_B:actor,A_CAPT_A:affected,A_FIRE:target\t${p2},${p4}\trecorded`,
      '[関係]',
      `R1\ttransfer\tE3\tA_DF\tE4\tA_TWR_E\t${p3}\tinformation\toccurred\tconfirmed`,
      `R2\timpact\tE8\tA_TWR_E\tE9\tA_CAPT_A\t${p2},${p3},${p4}\tother\toccurred\tna`,
      '[共有カード]',
      '[整理]',
      '[帰結]',
      `O1\tidentified\tE9:loss\t${p2},${p4}\t衝突発生`,
      '[仮判定]',
      `E8\tvariation\t滑走路監視見落とし\t${p3}`,
      '[完了]',
    ].join('\n');

    const zeroHubAnalysis = inspectLedger(parseLedger(zeroHubLedger), hanedaSource).analysis!;
    const zeroHubFineBase = captureFineGrainedBase(zeroHubAnalysis);
    const zeroHubTsv = [
      '[推奨統合]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      // Over-broad recommended rollup into 0-event hub A_ATC_ZERO: d(A_TWR_E, B) > 0 must protect A_TWR_E and peel P'!
      'M_ATC_ALL\tposet_rollup\tA_TWR_E,A_GND_E,A_DELIV\tA_ATC_ZERO\t-\torganization\t0.14\tタワー各席の統合',
      // 0-event peripheral hub rollup for 東京進入管制所
      'M_TMA\tposet_rollup\tA_DF,A_AFS\tA_TMA_DIV\t-\torganization\t0.06\t進入管制2席の統合',
      '[予備候補]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      // Partial peripheral attempt (A_DF + A_FIRE without A_AFS) MUST be rejected by HG2d-3!
      'M_BAD_PARTIAL_OTHERS\tperipheral_others\tA_DF,A_FIRE\tsubject_others\tその他の関係者\tother\t0.04\t部分的な周辺統合（HG2d違反）',
      // Valid root-level peripheral folding of sealed A_TMA_DIV + A_FIRE into cmp_agg_*
      'M_TMA_OTHERS\tperipheral_others\tA_TMA_DIV,A_FIRE\tsubject_others\tその他の関係者\tother\t0.08\t東京進入管制所と空港消防の周辺集約',
      '[分離維持ペア]',
      '主体A\t主体B\t強さ\t理由',
      'A_CAPT_A\tA_CAPT_B\thard\t衝突当事者の分離',
      'A_TWR_E\tA_CAPT_A\thard\t管制とA機の分離',
      '[完了]',
    ].join('\n');

    const parsedZero = parseLaneConsolidationTSV(zeroHubTsv, zeroHubFineBase, zeroHubAnalysis);
    const zeroOpt = searchOptimalLaneConsolidation(
      zeroHubFineBase,
      zeroHubAnalysis,
      parsedZero.candidates,
      parsedZero.separationConstraints,
      { targetMaxSubjects: 5 }
    );

    const zAssign = zeroOpt.consolidation.laneAssignment;
    // (a) Protagonist A_TWR_E stays independent while {A_GND_E, A_DELIV} form P' = 東京飛行場管制所（タワー東を除く） beneath A_ATC_ZERO!
    expect(zAssign['A_TWR_E']).toBe('A_TWR_E');
    const pPrimeId = zAssign['A_GND_E'];
    expect(pPrimeId).toMatch(/^cmp_/);
    expect(zAssign['A_DELIV']).toBe(pPrimeId);
    const pPrimeEnt = zeroOpt.bestSchema.analysis!.entities.find((e) => e.id === pPrimeId);
    expect(pPrimeEnt?.name).toBe('東京飛行場管制所（タワー東を除く）');
    expect(pPrimeEnt?.coreEntityId).toBeUndefined();
    const zPoset = SubjectPoset.fromData(zeroOpt.bestSchema.analysis!.subjectPoset!);
    expect(zPoset.isAncestor('A_ATC_ZERO', pPrimeId)).toBe(true);
    expect(zPoset.isAncestor(pPrimeId, 'A_TWR_E')).toBe(false);

    // (b) Sealed composite root cmp(A_TMA_DIV) + A_FIRE fold into cmp_agg_* as a nested composite tree!
    const zAggId = zAssign['A_FIRE'];
    expect(zAggId).toMatch(/^cmp_agg_/);
    expect(zAssign['A_DF']).toBe(zAggId);
    expect(zAssign['A_AFS']).toBe(zAggId);
    const zComposites = zeroOpt.consolidation.composites ?? {};
    const aggRecord = zComposites[zAggId];
    expect(aggRecord).toBeDefined();
    // cmp_agg_* contains ['A_FIRE', cmp_tma], preserving cmp_tma (coreEntityId: 'A_TMA_DIV') as a sealed nested child!
    expect(aggRecord.compositeOf).toHaveLength(2);
    const nestedTmaId = aggRecord.compositeOf.find((cid) => cid !== 'A_FIRE')!;
    expect(nestedTmaId).toMatch(/^cmp_/);
    expect(zComposites[nestedTmaId]?.coreEntityId).toBe('A_TMA_DIV');
    expect(zeroOpt.finalLaneCount).toBe(5);
    assertProjectedEntitiesPartition(
      ['A_TWR_E', 'A_GND_E', 'A_DELIV', 'A_DF', 'A_AFS', 'A_CAPT_A', 'A_CAPT_B', 'A_FIRE'],
      zeroOpt.bestSchema.analysis!.entities
    );
  });

  it('verifies Stage 3 root cohesion info-loss envelope L_info(R), incomparable root-pair parent discovery SYN_COUPLED_*, and causal variation visibility penalty on vta-test-data scenarios (ADR-0097)', async () => {
    const hanedaSource = sourceFromText(loadVtaTestScenarioText('羽田事故_20261025_141902.md', 60, '羽田空港シナリオ'));
    const hp1 = hanedaSource.paragraphs[0].id;
    const hp2 = hanedaSource.paragraphs[1].id;
    const hp3 = hanedaSource.paragraphs[2].id;
    const hp4 = hanedaSource.paragraphs[3].id;

    // 1) B-2 & B-1 ③ on Haneda:
    //    - Prevents under-priced M_ALL_B (crushing disjoint cockpit + cabin + passenger + aircraft cohorts into 1 lane) via L_info(R)
    //    - Discovers incomparable ATC joint parent (`SYN_COUPLED_*`) unifying 東京飛行場管制所 auxiliary seats and 東京進入管制所 (DF+AFS)
    //      via direct handoff relation R_ATC even when LLM omits M2!
    const stage3HanedaLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      `A_CAPT_A\t機長A\tperson\thigh\t-\t${hp2}`,
      `A_JA722A\tJA722A（A機）\tmachine\thigh\t-\t${hp2}`,
      `A_ATC\t東京飛行場管制所\torganization\tmid\t-\t${hp3}`,
      `A_TWR_E\tタワー東\tperson\thigh\tA_ATC\t${hp3}`,
      `A_GND_E\tグラウンド東\tperson\tlow\tA_ATC\t${hp3}`,
      `A_DELIV\tデリバリー\tperson\tlow\tA_ATC\t${hp3}`,
      `A_TMA_DIV\t東京進入管制所\torganization\tmid\t-\t${hp3}`,
      `A_DF\t羽田出域調整席\tperson\tlow\tA_TMA_DIV\t${hp3}`,
      `A_AFS\t羽田捜索調整席\tperson\tlow\tA_TMA_DIV\t${hp3}`,
      `A_JAL\t日本航空株式会社\torganization\tmid\t-\t${hp4}`,
      `A_CAPT_B\t機長B\tperson\thigh\tA_JAL\t${hp4}`,
      `A_PF_B\t訓練乗員B\tperson\thigh\tA_JAL\t${hp4}`,
      `A_CABIN_B\tB機客室乗務員\torganization\thigh\tA_JAL\t${hp4}`,
      `A_PAX_B\tB機乗客\torganization\thigh\tA_JAL\t${hp4}`,
      `A_JA13XJ\tJA13XJ（B機）\tmachine\thigh\tA_JAL\t${hp4}`,
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      `E0\t16:00\t管制規定適用\t東京飛行場管制所が規定を適用していた\tA_ATC:actor\t${hp3}\trecorded`,
      `E1\t17:15\t承認・地上指示\tデリバリーとグラウンド東が交信調整した\tA_DELIV:actor,A_GND_E:actor\t${hp3}\trecorded`,
      `E2\t17:35\t進入管制移管調整\tグラウンド東からの連絡を受けDFとAFSが進入移管調整した\tA_DF:actor,A_AFS:actor,A_GND_E:confirmed_recipient\t${hp3}\trecorded`,
      `E3a\t17:40\tC滑走路順序調整\tタワー東が離着陸順序を調整した\tA_TWR_E:actor\t${hp3}\trecorded`,
      `E3b\t17:42\t進入継続指示\tタワー東が機長Bへ進入継続を指示した\tA_TWR_E:actor,A_CAPT_B:confirmed_recipient\t${hp3},${hp4}\trecorded`,
      `E3\t17:44\t34R着陸許可\tタワー東が機長Bへ着陸許可を発出した\tA_TWR_E:actor,A_CAPT_B:confirmed_recipient\t${hp3},${hp4}\trecorded`,
      `E3c\t17:45\tC5停止位置指示\tタワー東が機長AへC5停止位置を指示した\tA_TWR_E:actor,A_CAPT_A:confirmed_recipient\t${hp2},${hp3}\trecorded`,
      `E4\t17:45\t誤進入・滑走路上停止\t機長AがJA722Aで滑走路へ進入・停止した\tA_CAPT_A:actor,A_JA722A:actor\t${hp2}\trecorded`,
      `E5\t17:46\tタワー監視見落とし\tタワー東が滑走路占有を見落とした\tA_TWR_E:actor\t${hp3}\trecorded`,
      `E6\t17:47\tB機着陸継続\t機長Bと訓練乗員BがJA13XJの着陸を継続した\tA_CAPT_B:actor,A_PF_B:actor,A_JA13XJ:actor\t${hp4}\trecorded`,
      `E7\t17:47\t両機衝突・機体炎上\tJA13XJとJA722Aが衝突し機長Aが負傷した\tA_JA13XJ:actor,A_JA722A:affected,A_CAPT_A:affected\t${hp2},${hp4}\trecorded`,
      `E8\t17:50\t客室非常脱出誘導\tB機客室乗務員が乗客を非常脱出誘導した\tA_CABIN_B:actor,A_PAX_B:actor\t${hp4}\trecorded`,
      `E9\t17:58\t全員脱出完了\t客室乗務員と乗客が脱出完了した\tA_CABIN_B:actor,A_PAX_B:affected\t${hp4}\trecorded`,
      '[関係]',
      `R_ATC\ttransfer\tE1\tA_GND_E\tE2\tA_DF\t${hp3}\tinformation\toccurred\tconfirmed`,
      `R_IMP1\timpact\tE4\tA_JA722A\tE7\tA_JA13XJ\t${hp2},${hp4}\tother\toccurred\tna`,
      `R_IMP2\timpact\tE6\tA_CAPT_B\tE7\tA_JA13XJ\t${hp4}\tother\toccurred\tna`,
      `R_BEF\tbefore\tE8\t-\tE9\t-\t${hp4}\t-\t-\t-`,
      '[共有カード]',
      '[整理]',
      '[帰結]',
      `O1\tidentified\tE7:loss,E9:recovery\t${hp2},${hp4}\t衝突炎上と全員脱出`,
      '[仮判定]',
      `E4\tvariation\t滑走路誤進入\t${hp2}`,
      `E5\tvariation\t監視見落とし\t${hp3}`,
      `E6\tvariation\t未視認着陸継続\t${hp4}`,
      `E8\tvariation:resilient\t非常脱出誘導\t${hp4}`,
      '[完了]',
    ].join('\n');

    const s3Analysis = inspectLedger(parseLedger(stage3HanedaLedger), hanedaSource).analysis!;
    const s3Tsv = [
      '[推奨統合]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M_A\trole_group\tA_CAPT_A,A_JA722A\t-\tJA722A（A機・機長）\torganization\t0.10\tA機と機長の一体統合',
      // Under-priced 5-entity B-aircraft crush across disjoint cockpit & cabin cohorts (must be penalized by L_info(R)!)
      'M_ALL_B\trole_group\tA_CAPT_B,A_PF_B,A_CABIN_B,A_PAX_B,A_JA13XJ\t-\t日本航空516便（B機全体）\torganization\t0.18\tB機全主体の1列圧縮',
      '[予備候補]',
      'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
      'M_ATC_ALL\tposet_rollup\tA_TWR_E,A_GND_E,A_DELIV\tA_ATC\t-\torganization\t0.36\t飛行場管制所の全席統合（タワー東はピーリング分離）',
      'M_B_FLT\trole_group\tA_CAPT_B,A_PF_B,A_JA13XJ\t-\tJA13XJ（B機・運航乗務員）\torganization\t0.12\tB機操縦室と機体の統合',
      'M_B_CAB\trole_group\tA_CABIN_B,A_PAX_B\t-\tB機客室乗務員・乗客\torganization\t0.10\t客室脱出グループの統合',
      '[分離維持ペア]',
      '主体A\t主体B\t強さ\t理由',
      'A_TWR_E\tA_CAPT_A\thard\t管制とA機の分離',
      '[完了]',
    ].join('\n');

    const s3Opt = await optimizeLaneConsolidation(
      dummyConfig,
      projectAnalysis(s3Analysis),
      async () => ({ latencyMs: 12, content: s3Tsv }),
      undefined,
      undefined,
      { targetMaxSubjects: 5 }
    );
    const s3Assign = s3Opt.consolidation.laneAssignment;
    // B-2: B-aircraft splits cleanly into cohesive flight-deck (M_B_FLT) and cabin (M_B_CAB) lanes instead of M_ALL_B 1-lane crush!
    expect(s3Assign['A_CAPT_B']).toBe(s3Assign['A_PF_B']);
    expect(s3Assign['A_CABIN_B']).toBe(s3Assign['A_PAX_B']);
    expect(s3Assign['A_CAPT_B']).not.toBe(s3Assign['A_CABIN_B']);
    // B-1 ③: Incomparable auxiliary ATC divisions {A_ATC, A_GND_E, A_DELIV} and {A_DF, A_AFS} unify via SYN_COUPLED_* while A_TWR_E stays separate!
    expect(s3Assign['A_TWR_E']).toBe('A_TWR_E');
    expect(s3Assign['A_GND_E']).toBe(s3Assign['A_DF']);
    expect(s3Assign['A_AFS']).toBe(s3Assign['A_DF']);
    expect(isPeripheralAggregateId(s3Assign['A_DF'])).toBe(false);
    expect(s3Opt.finalLaneCount).toBe(5);

    // 2) Item C on Kanuma: Protects sole actor of a standalone causal adverse variation from stranding exclusively inside cmp_agg_*
    const kanumaSource = sourceFromText(loadVtaTestScenarioText('鹿沼駅事故.md', 30, '鹿沼駅シナリオ'));
    const kp1 = kanumaSource.paragraphs[0].id;
    const kp2 = kanumaSource.paragraphs[1].id;
    const kp3 = kanumaSource.paragraphs[2].id;

    const varVisLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      `O_SUB\t警備請負会社\torganization\tmid\t-\t${kp1}`,
      `O_CLIENT\t発注管理課\torganization\tlow\t-\t${kp1}`,
      `O_VENDOR\t資材納入業者\torganization\tlow\t-\t${kp1}`,
      `A_LEAD\t現場代理人G\tperson\thigh\t-\t${kp2}`,
      `A_DRV\t列車運転士\tperson\thigh\t-\t${kp3}`,
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      `E1\t08:00\t資材納品\t発注管理課と資材納入業者が納品手続きを行った\tO_CLIENT:actor,O_VENDOR:target\t${kp1}\trecorded`,
      // Sole-participant adverse variation causally linked to E3 -> E4:loss!
      `E2\t08:30\t見張員減員編成決定\t警備請負会社が単独で見張員を減員編成した\tO_SUB:actor\t${kp1}\trecorded`,
      `E3\t10:42\t線路内立入指示\t現場代理人Gが立入指示した\tA_LEAD:actor\t${kp2}\trecorded`,
      `E4\t10:46\t列車触車\t運転士の列車が現場代理人Gに触車した\tA_DRV:actor,A_LEAD:affected\t${kp3}\trecorded`,
      '[関係]',
      `R1\timpact\tE2\tO_SUB\tE3\tA_LEAD\t${kp1},${kp2}\tother\toccurred\tna`,
      `R2\timpact\tE3\tA_LEAD\tE4\tA_DRV\t${kp2},${kp3}\tother\toccurred\tna`,
      '[共有カード]',
      '[整理]',
      '[帰結]',
      `O1\tidentified\tE4:loss\t${kp3}\t触車発生`,
      '[仮判定]',
      `E2\tvariation\t見張員減員編成\t${kp1}`,
      `E3\tvariation\t線路内立入指示\t${kp2}`,
      '[完了]',
    ].join('\n');

    const varVisAnalysis = inspectLedger(parseLedger(varVisLedger), kanumaSource).analysis!;
    const varVisOpt = await optimizeLaneConsolidation(
      dummyConfig,
      projectAnalysis(varVisAnalysis),
      async () => ({
        latencyMs: 10,
        content: [
          '[統合候補]',
          'ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由',
          'M_TRAP\tperipheral_others\tO_SUB,O_CLIENT\tsubject_others\tその他の関係者\tother\t0.04\t因果変動主体を含む集約',
          'M_CLEAN\tperipheral_others\tO_CLIENT,O_VENDOR\tsubject_others\tその他の関係者\tother\t0.05\t純粋周辺組織の集約',
          '[分離維持ペア]',
          'A_LEAD\tA_DRV\thard\t被災側と列車側の分離',
          '[完了]',
        ].join('\n'),
      }),
      undefined,
      undefined,
      { targetMaxSubjects: 4 }
    );
    const vAssign = varVisOpt.consolidation.laneAssignment;
    // O_CLIENT + O_VENDOR fold into cmp_agg_* while causal variation initiator O_SUB stays on its own named lane!
    expect(isPeripheralAggregateId(vAssign['O_CLIENT'])).toBe(true);
    expect(vAssign['O_VENDOR']).toBe(vAssign['O_CLIENT']);
    expect(vAssign['O_SUB']).toBe('O_SUB');
  });
});
