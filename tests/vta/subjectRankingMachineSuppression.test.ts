import { describe, expect, it } from 'vitest';
import {
  rankSubjects,
  consolidateSubjects,
  isActiveOrInteractiveMachine,
} from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { isPeripheralAggregateId } from '../../src/tools/vta/features/vta/utils/subjectCompositeForest';
import { sliceRelevantSourceParagraphs } from '../../src/tools/vta/services/generation/granularityRefinement';
import { sourceFromText } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import {
  inspectLedger,
  parseLedger,
  extractVariationFactorFromReason,
} from '../../src/tools/vta/features/vta/utils/eventLedger';
import { formatVariationFactor } from '../../src/tools/vta/features/vta/utils/normalizationAuditExport';
import type { VTAAnalysisData } from '../../src/tools/vta/types/vta';

const buildLedgerAnalysis = (ledgerText: string, sourceText: string): VTAAnalysisData => {
  const src = sourceFromText(sourceText);
  const res = inspectLedger(parseLedger(ledgerText), src);
  if (!res.analysis) {
    throw new Error(`Ledger parse failed: ${res.issues.map((i) => i.message).join(' / ')}`);
  }
  return res.analysis;
};

describe('ADR-0013: Machine Lane Suppression & Context Slicing', () => {
  it('prioritizes person and organization over machine entities even when machine has multiple actor events', () => {
    const sourceText = [
      'p1 機長Aがタワー管制官を呼び出した。',
      'p2 タワー管制官が進入許可を発出した。',
      'p3 滑走路監視支援機能が画面上で進入注意を発報した。',
      'p4 滑走路監視支援機能が警告音を出力した。',
      'p5 機長Bが着陸を継続し、滑走路上で衝突事故が発生した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t機長A\tperson\thigh\t-\tp1',
      'A2\tタワー管制官\tperson\thigh\t-\tp2',
      'A3\t滑走路監視支援機能\tmachine\thigh\t-\tp3,p4',
      'A4\t機長B\tperson\thigh\t-\tp5',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t17:45\t呼出\t機長Aがタワーを呼出\tA1:actor\tp1\trecorded',
      'E2\t17:46\t許可\tタワー管制官が進入許可\tA2:actor\tp2\trecorded',
      'E3\t17:46\t注意報知\t監視支援機能が注意発報\tA3:actor\tp3\trecorded',
      'E4\t17:47\t警報出力\t監視支援機能が警告音出力\tA3:actor\tp4\trecorded',
      'E5\t17:47\t衝突事故\t滑走路上で衝突事故発生\tA4:actor\tp5\trecorded',
      '[帰結]',
      'O1\tidentified\tE5\tp5\t衝突事故',
      '[関係]',
      'R1\tbefore\tE1\t-\tE2\t-\tp1,p2\t-\t-\tna',
      'R2\tbefore\tE2\t-\tE3\t-\tp2,p3\t-\t-\tna',
      'R3\tbefore\tE3\t-\tE4\t-\tp3,p4\t-\t-\tna',
      'R4\tbefore\tE4\t-\tE5\t-\tp4,p5\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const analysis = buildLedgerAnalysis(ledger, sourceText);
    // maxSubjects = 3 のとき、親組織がないため上位2件（A4, A2）が保持され、A3(machine)とA1がoverflowとなり、
    // A3(machine)はA2(person)より優先度が低いため保持枠に入らない
    const ranking = rankSubjects(analysis, 3);
    const retainedIds = ranking.ranks.filter((r) => r.retained).map((r) => r.entityId);

    expect(retainedIds).toContain('A4'); // 機長B (outcome-actor)
    expect(retainedIds).toContain('A2'); // タワー管制官 (person)
    expect(retainedIds).not.toContain('A3'); // 滑走路監視支援機能 (machine) は上位保持枠に入らない

    // A3はその他の関係者（内容アドレス cmp_agg_*）へマージされる
    const rA3 = ranking.ranks.find((r) => r.entityId === 'A3')!;
    expect(rA3.retained).toBe(false);
    expect(isPeripheralAggregateId(rA3.mergedInto)).toBe(true);

    const consolidated = consolidateSubjects(analysis, 3);
    const retainedLanes = consolidated.entities.map((e) => e.id);
    expect(retainedLanes).toContain('A4');
    expect(retainedLanes).toContain('A2');
    expect(retainedLanes).not.toContain('A3');
    expect(retainedLanes.some((id) => isPeripheralAggregateId(id))).toBe(true);
  });

  it('ADR-0033: promotes machine involved in human-machine mental model mismatch (mode confusion) to primary lane', () => {
    const sourceText = [
      'p1 機長Aがオートパイロットのモード選択ダイヤルを操作した。',
      'p2 オートパイロットが降下モードへ自動遷移した。',
      'p3 機長Aが水平維持モードと誤認して推力レバーを絞った。',
      'p4 第2操縦士が高度急低下を発見し警報を発した。',
      'p5 航空機が緊急上昇し危機を回避した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t機長A\tperson\thigh\t-\tp1',
      'A2\tオートパイロット\tmachine\thigh\t-\tp2',
      'A3\t第2操縦士\tperson\tmid\t-\tp4',
      'A4\t地上運航管理者\tperson\tlow\t-\tp1',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:00\tダイヤル操作\t機長Aがダイヤル操作\tA1:actor\tp1\trecorded',
      'E2\t10:01\tモード自動遷移\tオートパイロットが降下モードへ自動遷移\tA2:actor\tp2\trecorded',
      'E3\t10:02\tモード誤認操作\t機長Aが水平維持と誤認し推力低減\tA1:actor\tp3\trecorded',
      'E4\t10:03\t高度低下発見\t第2操縦士が高度急低下を発報\tA3:actor\tp4\trecorded',
      'E5\t10:04\t緊急上昇\t航空機が緊急上昇し危機回避\tA1:actor\tp5\trecorded',
      '[帰結]',
      'O1\tidentified\tE5\tp5\t緊急上昇回避',
      '[関係]',
      'R1\ttransfer\tE1\tA1\tE2\tA2\tp1,p2\tinformation\toccurred\tconfirmed',
      'R2\timpact\tE2\tA2\tE3\tA1\tp2,p3\tinformation\toccurred\tconfirmed',
      'R3\tbefore\tE3\t-\tE4\t-\tp3,p4\t-\t-\tna',
      'R4\tdependency\tE4\tA3\tE5\tA1\tp4,p5\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const analysis = buildLedgerAnalysis(ledger, sourceText);
    const apEntity = analysis.entities.find((e) => e.id === 'A2')!;
    expect(isActiveOrInteractiveMachine(apEntity, analysis)).toBe(true);

    // maxSubjects = 3 のとき、能動的対話装置（A2）は人間と同等に扱われ、主要レーンとして保持される
    const ranking = rankSubjects(analysis, 3);
    const retainedIds = ranking.ranks.filter((r) => r.retained).map((r) => r.entityId);
    expect(retainedIds).toContain('A1'); // 機長A
    expect(retainedIds).toContain('A2'); // オートパイロット (machine promoted!)
    expect(retainedIds).not.toContain('A4'); // 地上運航管理者 (low priority)

    const consolidated = consolidateSubjects(analysis, 3);
    const retainedLanes = consolidated.entities.map((e) => e.id);
    expect(retainedLanes).toContain('A1');
    expect(retainedLanes).toContain('A2');
    expect(retainedLanes).not.toContain('A4');
  });

  it('ADR-0033: promotes and preserves machine executing graceful degradation (system resilience) to prevent escalation', () => {
    const sourceText = [
      'p1 エンジン制御システムがセンサー断線を検知した。',
      'p2 エンジン制御システムが機能縮退モードへ自律移行し推力を制限した。',
      'p3 操縦士が縮退運転表示を確認し滑空進入を継続した。',
      'p4 航空機が滑走路へ安全停止を完了した。',
      'p5 地上管制官が待機車両を手配した。',
      'p6 航空会社運行管理者が関係各所へ連絡した。',
    ].join('\n');

    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t操縦士\tperson\thigh\t-\tp3',
      'A2\tエンジン制御システム\tmachine\thigh\t-\tp1,p2',
      'A3\t地上管制官\tperson\tlow\t-\tp5',
      'A4\t運行管理者\tperson\tlow\t-\tp6',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t12:00\tセンサー断線\tセンサー断線発生\tA2:actor\tp1\trecorded',
      'E2\t12:01\t機能縮退作動\t制御システムが機能縮退モードへ移行し安全推力維持\tA2:actor\tp2\trecorded',
      'E3\t12:02\t滑空進入\t操縦士が進入継続\tA1:actor\tp3\trecorded',
      'E4\t12:05\t安全停止\t安全停止完了\tA1:actor\tp4\trecorded',
      'E5\t12:06\t車両手配\t管制官が車両手配\tA3:actor\tp5\trecorded',
      'E6\t12:07\t報告連絡\t運行管理者が報告\tA4:actor\tp6\trecorded',
      '[帰結]',
      'O1\tidentified\tE4\tp4\t安全停止完了',
      '[関係]',
      'R1\timpact\tE1\tA2\tE2\tA2\tp1,p2\tother\toccurred\tconfirmed',
      'R2\timpact\tE2\tA2\tE3\tA1\tp2,p3\tinformation\toccurred\tconfirmed',
      'R3\tbefore\tE3\t-\tE4\t-\tp3,p4\t-\t-\tna',
      'R4\tbefore\tE4\t-\tE5\t-\tp4,p5\t-\t-\tna',
      'R5\tbefore\tE5\t-\tE6\t-\tp5,p6\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const analysis = buildLedgerAnalysis(ledger, sourceText);

    // E2にレジリエンス機能縮退の変動要因を付与
    const vf = extractVariationFactorFromReason('センサー故障に対する機能縮退（レジリエンス）により安全停止');
    expect(vf.polarity).toBe('resilient');
    expect(vf.category).toBe('response');
    expect(formatVariationFactor(vf)).toContain('【レジリエンス要因】 状態変化への応答 (レジリエンス対応/防護動作)');

    const e2 = analysis.events.find((e) => e.id === 'E2')!;
    e2.classification = 'variation';
    e2.variationFactor = vf;

    const ctrlEntity = analysis.entities.find((e) => e.id === 'A2')!;
    expect(isActiveOrInteractiveMachine(ctrlEntity, analysis)).toBe(true);

    const consolidated = consolidateSubjects(analysis, 3);
    const retainedLanes = consolidated.entities.map((e) => e.id);
    expect(retainedLanes).toContain('A1'); // 操縦士
    expect(retainedLanes).toContain('A2'); // エンジン制御システム (graceful degradation machine promoted!)
    expect(retainedLanes).not.toContain('A3'); // 地上管制官
    expect(retainedLanes).not.toContain('A4'); // 運行管理者
    expect(retainedLanes.some((id) => isPeripheralAggregateId(id))).toBe(true);
  });

  it('safely slices long source text into relevant paragraphs under maxChars limit', () => {
    // 20,000文字超のダミー長大ソース
    const paragraphs = [
      'p1 題目：東京国際空港における衝突事故調査報告書概要。',
      'p2 概要：令和6年1月2日に発生した事故の経緯と検証。',
      'p3 組織：関係各機関の体制と規程に関する詳細記述（事故と直接関係なし）。',
      ...Array.from({ length: 100 }, (_, i) => `p${i + 4} 背景規程および組織規定の詳細条文（第${i + 1}条）：` + '長大な説明テキスト。'.repeat(15)),
      'p200 機長Aが誘導路へ進入した。',
      'p201 機長Bが着陸を試み滑走路上で衝突した。',
    ];
    const longText = paragraphs.join('\n');
    const source = sourceFromText(longText);

    const lastP1 = source.paragraphs[source.paragraphs.length - 2].id;
    const lastP2 = source.paragraphs[source.paragraphs.length - 1].id;

    // イベントが p1, lastP1, lastP2 を参照している分析データ
    const analysis: VTAAnalysisData = {
      version: 5,
      unassignedEventIds: [],
      sources: [source],
      entities: [
        { id: 'A1', name: '機長A', kind: 'person' },
        { id: 'A2', name: '機長B', kind: 'person' },
      ],
      events: [
        {
          id: 'E1',
          time: '17:45',
          title: '進入',
          description: '誘導路へ進入',
          factIds: [],
          sourceRefs: [{ sourceId: source.id, paragraphId: lastP1 }],
          sourceOrder: 1,
          classification: 'normal',
        },
        {
          id: 'E2',
          time: '17:47',
          title: '衝突',
          description: '滑走路上で衝突',
          factIds: [],
          sourceRefs: [{ sourceId: source.id, paragraphId: lastP2 }],
          sourceOrder: 2,
          classification: 'variation',
        },
      ],
      participations: [
        { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] },
        { eventId: 'E2', entityId: 'A2', role: 'actor', factIds: [] },
      ],
      relations: [],
      cards: [],
      facts: [],
      outcome: {
        status: 'identified',
        eventIds: ['E2'],
        sourceRefs: [{ sourceId: source.id, paragraphId: lastP2 }],
        reason: '衝突事故',
      },
    };

    const sliced = sliceRelevantSourceParagraphs(source, analysis, 5000);
    expect(sliced.length).toBeLessThanOrEqual(5500); // 抜粋注記含む
    expect(sliced).toContain('[p1]'); // 冒頭題目
    expect(sliced).toContain(`[${lastP1}]`); // E1参照
    expect(sliced).toContain(`[${lastP2}]`); // E2参照
    expect(sliced).toContain('抜粋提示しています');
  });
});
