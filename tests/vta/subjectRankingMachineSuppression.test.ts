import { describe, expect, it } from 'vitest';
import { rankSubjects, consolidateSubjects } from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { sliceRelevantSourceParagraphs } from '../../src/tools/vta/services/generation/granularityRefinement';
import { sourceFromText } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { inspectLedger, parseLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
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

    // A3はその他の関係者へマージされる
    const rA3 = ranking.ranks.find((r) => r.entityId === 'A3')!;
    expect(rA3.retained).toBe(false);
    expect(rA3.mergedInto).toBe('subject_others');

    const consolidated = consolidateSubjects(analysis, 3);
    const retainedLanes = consolidated.entities.map((e) => e.id);
    expect(retainedLanes).toContain('A4');
    expect(retainedLanes).toContain('A2');
    expect(retainedLanes).not.toContain('A3');
    expect(retainedLanes).toContain('subject_others');
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
