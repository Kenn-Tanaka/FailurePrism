import { describe, expect, it } from 'vitest';
import {
  parseLedger,
  inspectLedger,
  applyLedgerRepair,
  ledgerRepairInput,
  normalizeRefTokens,
  cleanPunctuation,
  classificationInput,
  inspectClassifications,
} from './eventLedger';
import { ledgerFixture, ledgerSource } from './eventLedger.fixture';
import { sourceFromText, validateSavedAnalysis, projectAnalysis, reconcileAnalysis } from './eventAnalysis';
import { consolidateSubjects } from './subjectRanking';
import { relationAttributes } from './relationContract';

const source=sourceFromText(ledgerSource);
const docWith=(rows:string)=>parseLedger(ledgerFixture().replace('[共有カード]',rows+'\n[共有カード]'));
const before=(id:string,from='E1',to='E2',status='-',receipt='na')=>[id,'before',from,'-',to,'-','p1','-',status,receipt].join('\t');

describe('row-specific ledger validation',()=>{
 it('reports only the invalid dependency in the supplied-log reproduction and preserves normal rows',()=>{
  const doc=docWith([before('R1','E1','E2','occurred'), 'R2\tdependency\tE1\tA2\tE2\tA2\tp1\t-\t-\tna', before('R3','E1','E2','-','-')].join('\n'));
  const result=inspectLedger(doc,source);
  expect(result.issues.map(i=>i.row.id)).toEqual(['R2']);
  expect(result.issues[0]).toMatchObject({kind:'dependency',field:'依存端点'});
  const fixed=applyLedgerRepair(doc,result.issues,'[関係]\nR2\tdependency\tE1\tA1\tE2\tA2\tp1,p2\t-\t-\tna\n[完了]');
  expect(fixed.rows.find(r=>r.id==='R1')).toBe(doc.rows.find(r=>r.id==='R1'));
  expect(fixed.rows.find(r=>r.id==='R3')).toBe(doc.rows.find(r=>r.id==='R3'));
  const analysis=inspectLedger(fixed,source).analysis!;
  expect(analysis.relations).toHaveLength(3);
  expect(validateSavedAnalysis(analysis).relations).toHaveLength(3);
 });
 it('collects endpoint and attribute failures together without accusing the normal before',()=>{
  const result=inspectLedger(docWith([before('R1'),'R2\tdependency\tE1\tA2\tE2\tA2\tp1\t-\t-\tna','R3\tdependency\tE1\tA1\tE2\tA2\tp1\t-\toccurred\tna'].join('\n')),source);
  expect(result.issues.map(i=>i.row.id)).toEqual(['R2','R3']);
  expect(ledgerRepairInput(docWith(''),result.issues,source)).toContain('受信=occurred');
  expect(result.issues[1]).toMatchObject({field:'実施状態',actual:'occurred',expected:'-'});
 });
 it('attributes a temporal cycle to its two edges, excluding a parallel valid transfer',()=>{
  const result=inspectLedger(docWith([before('R1'),before('R2','E2','E1'),'R3\ttransfer\tE1\tA1\tE2\tA2\tp1\tinformation\toccurred\tunconfirmed'].join('\n')),source);
  expect(result.issues.map(i=>i.row.id)).toEqual(['R1','R2']);
 });
 it('detects dependency cycles without tagging unrelated before edges',()=>{
  const text=ledgerFixture().replace('A2:actor\tp2','A1:actor,A2:target\tp2');
  const doc=parseLedger(text.replace('[共有カード]',[before('R0'),'R1\tdependency\tE1\tA1\tE2\tA2\tp1\t-\t-\tna','R2\tdependency\tE2\tA1\tE1\tA2\tp2\t-\t-\tna','[共有カード]'].join('\n')));
  expect(inspectLedger(doc,source).issues.map(i=>i.row.id)).toEqual(['R1','R2']);
 });
 it('detects temporal inversion when a directed transfer/impact relation reverses an established before chain', () => {
  const result = inspectLedger(
    docWith([before('R1', 'E1', 'E2'), 'R2\ttransfer\tE2\tA2\tE1\tA1\tp1\tinformation\toccurred\tunconfirmed'].join('\n')),
    source
  );
  expect(result.issues.map((i) => i.row.id)).toEqual(['R2']);
  expect(result.issues[0]).toMatchObject({
    code: 'temporal_inversion',
    kind: 'transfer',
    field: '前後順序',
    actual: 'E2 → E1',
    expected: 'E1 → E2',
  });
  expect(ledgerRepairInput(docWith(''), result.issues, source)).toContain('temporal_inversion');
 });
 it.each(['-','na'])('accepts before N/A receipt %s without inferring occurrence',receipt=>{
  const result=inspectLedger(docWith(before('R1','E1','E2','-',receipt)),source);
  expect(result.issues).toEqual([]);
  expect(result.analysis?.relations[0]).toMatchObject({kind:'before',status:undefined,receipt:'na'});
 });
 it.each(['before','dependency','transfer','impact','mutual','common'])('keeps the common attribute validator usable for %s',kind=>{
  expect(()=>relationAttributes(kind,'-',kind==='before'||kind==='dependency'?'-':'unknown','na')).not.toThrow();
 });
 it('does not infer unknown transmission or receipt facts from missing attribute cells',()=>{
  expect(()=>relationAttributes('transfer','information','-','-')).toThrow('実施状態');
  expect(()=>relationAttributes('dependency','-','occurred','na')).toThrow('実施状態');
 });
});

describe('parseLedger robustness and classification fallback',()=>{
  it('infers section from header row when section title tag is omitted', () => {
    const text = 'ID\t判定\t理由\t原文参照\nE1\tnormal\t通常業務\tsource_1/p1\n[完了]';
    const doc = parseLedger(text, true);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]).toEqual({
      section: '判定',
      id: 'E1',
      cells: ['E1', 'normal', '通常業務', 'source_1/p1'],
      line: 2,
    });
  });

  it('uses defaultSection when both section title and header row are omitted', () => {
    const text = 'E1\tvariation\t異常検知\tsource_1/p1\n[完了]';
    const doc = parseLedger(text, { partial: true, defaultSection: '判定' });
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0].section).toBe('判定');
    expect(doc.rows[0].id).toBe('E1');
  });

  it('allows missing [完了] when allowMissingComplete is true or partial is true', () => {
    const text = 'ID\t判定\t理由\t原文参照\nE1\tnormal\t通常作業\tsource_1/p1\nE2\tvariation\t計画外の行動\tsource_1/p2';
    const doc = parseLedger(text, { partial: true, defaultSection: '判定', allowMissingComplete: true });
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[0].id).toBe('E1');
    expect(doc.rows[1].id).toBe('E2');
  });

  it('strips leading conversational preambles and markdown fences', () => {
    const text = '承知いたしました。以下に判定結果を出力します：\n```tsv\nID\t判定\t理由\t原文参照\nE1\tnormal\t通常作業\tsource_1/p1\n```';
    const doc = parseLedger(text, { partial: true, defaultSection: '判定', allowMissingComplete: true });
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0].id).toBe('E1');
    expect(doc.rows[0].section).toBe('判定');
  });

  it('strictly requires [完了] and all sections when partial is false', () => {
    const withoutComplete = ledgerFixture().replace('[完了]', '');
    expect(() => parseLedger(withoutComplete, false)).toThrow('台帳の[完了]がありません');
  });

  it('reproduces and parses realistic multi-row classification output without [判定] and [完了]', () => {
    const multiRowResponse = [
      'ID\t判定\t理由\t原文参照',
      'E1\tvariation\t大地震の発生は通常状態ではない\tsource_1/p15',
      'E2\tvariation\t地震発生に伴う特別な対策本部の設置\tsource_1/p16',
      'E3\tvariation\t地震被害状況確認のための特別な飛行\tsource_1/p17',
    ].join('\n');
    const doc = parseLedger(multiRowResponse, { partial: true, defaultSection: '判定', allowMissingComplete: true });
    expect(doc.rows).toHaveLength(3);
    expect(doc.rows.map((r) => r.id)).toEqual(['E1', 'E2', 'E3']);
    expect(doc.rows.every((r) => r.section === '判定')).toBe(true);
  });

  it('skips placeholder rows in empty sections (e.g., hyphen, none, n/a, or japanese none)', () => {
    const textWithPlaceholders = [
      '[主体]',
      'A1\t担当者\tperson',
      '[イベント]',
      'E1\t-\t作業開始\t説明\tA1:actor\tp1\trecorded',
      '[関係]',
      'R1\tbefore\tE1\t-\tE1\t-\tp1\t-\t-\tna',
      '[共有カード]',
      'ID\t主体\tイベント',
      '-\t-\t-',
      '[整理]',
      'B1\tbackground\tp1\t背景情報\t理由',
      '[表現]',
      'ID\t原文参照\t検知語句\t処理\tイベントID\t理由',
      '-\t-\t-\t-\t-\t-',
      'なし\tなし\tなし\tなし\tなし\tなし',
      'none\tnone\tnone\tnone\tnone\tnone',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(textWithPlaceholders);
    expect(doc.rows.some((r) => r.id === '-' || r.id === 'なし' || r.id === 'none')).toBe(false);
    expect(doc.rows.some((r) => r.section === '共有カード')).toBe(false);
    expect(doc.rows.some((r) => r.section === '表現')).toBe(false);
    expect(doc.rows.map((r) => r.id)).toEqual(['A1', 'E1', 'R1', 'B1']);
  });
});

describe('audit sections (表記 / 表現 / 仮判定)',()=>{
  const withExtra=(extra:string)=>parseLedger(ledgerFixture().replace('[完了]',extra+'\n[完了]'));
  const valid='[表記]\nA1\talias\t装置\t機器\tp1\t呼称の統一\n[表現]\nS1\tp1\t起動\tremoved\tE1\t原文の語を除いて行為だけを記述\n[仮判定]\nE1\tnormal\t通常の起動作業\tp1\nE2\tundetermined\t-\t-';
  it('stores checkable audit records and the provisional classification, and keeps them through save and load',()=>{
   const result=inspectLedger(withExtra(valid),source);
   expect(result.issues).toEqual([]);
   const analysis=result.analysis!;
   expect(analysis.normalizationAudit?.corrections[0]).toMatchObject({kind:'alias_unification',from:'装置',to:'機器',detectedBy:'llm'});
   expect(analysis.normalizationAudit?.subjectiveNotices[0]).toMatchObject({phrase:'起動',treatment:'evaluative_word_removed',eventIds:['E1']});
   expect(analysis.events.find(e=>e.id==='E1')?.preliminary).toMatchObject({value:'normal',sourceRefs:[{sourceId:'source_1',paragraphId:'p1'}]});
   expect(analysis.events.find(e=>e.id==='E1')?.classification).toBe('unclassified');
   const loaded=validateSavedAnalysis(JSON.parse(JSON.stringify(analysis)));
   expect(loaded.normalizationAudit).toEqual(analysis.normalizationAudit);
   expect(loaded.events.find(e=>e.id==='E2')?.preliminary).toMatchObject({value:'undetermined'});
  });
  it('safely discards invented or non-existent audit records with a warning without halting analysis',()=>{
   const result=inspectLedger(withExtra(valid.replace('A1\talias\t装置','A1\talias\t計器')),source);
   expect(result.issues).toEqual([]);
   expect(result.analysis).toBeDefined();
   expect(result.warnings?.some(w=>w.includes('表記 A1: 原文表記 "計器" が原文中に見つからないため、監査記録から除外しました。'))).toBe(true);
   expect(result.analysis?.normalizationAudit?.corrections).toHaveLength(0);

   const inventedPhrase=inspectLedger(withExtra(valid.replace('p1\t起動','p1\t誤って')),source);
   expect(inventedPhrase.issues).toEqual([]);
   expect(inventedPhrase.analysis).toBeDefined();
   expect(inventedPhrase.warnings?.some(w=>w.includes('表現 S1: 検知語句 "誤って" が原文中に見つからないため、監査記録から除外しました。'))).toBe(true);
   expect(inventedPhrase.analysis?.normalizationAudit?.subjectiveNotices).toHaveLength(0);
  });
  it('downgrades definite provisional classification without reference or reason to undetermined with a warning, while rejecting out-of-range or unknown IDs',()=>{
   const noRef=inspectLedger(withExtra('[仮判定]\nE1\tvariation\t理由\t-'),source);
   expect(noRef.issues).toEqual([]);
   expect(noRef.warnings?.some(w=>w.includes('仮判定 E1 (variation)'))).toBe(true);
   expect(noRef.analysis?.events.find(e=>e.id==='E1')?.preliminary).toMatchObject({value:'undetermined',reason:'',sourceRefs:[]});
   const normalDash=inspectLedger(withExtra('[仮判定]\nE1\tnormal\t-\t-'),source);
   expect(normalDash.issues).toEqual([]);
   expect(normalDash.warnings?.some(w=>w.includes('仮判定 E1 (normal)'))).toBe(true);
   expect(normalDash.analysis?.events.find(e=>e.id==='E1')?.preliminary).toMatchObject({value:'undetermined',reason:'',sourceRefs:[]});
   const outside=inspectLedger(withExtra('[仮判定]\nE1\tnormal\t理由\tp2'),source);
   expect(outside.issues.map(i=>i.row.id)).toEqual(['E1']);
   const unknown=inspectLedger(withExtra('[仮判定]\nE9\tnormal\t理由\tp1'),source);
   expect(unknown.issues.map(i=>i.row.id)).toEqual(['E9']);
  });
  it('normalizes placeholder unassigned actor tokens (-:actor, -:target:inferred) to unassigned (-) with a warning',()=>{
   const withPlaceholderActor=ledgerFixture().replace(
     'E2\t10:00\t停止\t装置が停止した\tA2:actor\tp2\trecorded',
     'E2\t10:00\t停止\t装置が停止した\tA2:actor\tp2\trecorded\nE3\t08:00\t地震発生\t地震が発生した\t-:actor\tp1\trecorded'
   );
   const result=inspectLedger(parseLedger(withPlaceholderActor),source);
   expect(result.issues).toEqual([]);
   expect(result.warnings?.some(w=>w.includes('イベント E3 の未割当主体表記 "-:actor"'))).toBe(true);
   expect(result.analysis?.unassignedEventIds).toContain('E3');
   expect(result.analysis?.participations.some(p=>p.eventId==='E3')).toBe(false);
  });
  it('includes malformed audit rows in a row-specific repair request and accepts the repaired row only',()=>{
   const doc=withExtra(valid.replace('A1\talias\t装置','A1\tinvalid_kind\t装置'));
   const result=inspectLedger(doc,source);
   expect(result.issues.map(i=>[i.row.section,i.row.id])).toEqual([['表記','A1']]);
   expect(ledgerRepairInput(doc,result.issues,source)).toContain('[p1]');
   const fixed=applyLedgerRepair(doc,result.issues,'[表記]\nA1\talias\t装置\t機器\tp1\t呼称の統一\n[完了]');
   expect(inspectLedger(fixed,source).analysis?.normalizationAudit?.corrections).toHaveLength(1);
  });
  it('drops an unusable saved audit entry without rejecting the project, and reads old data without audit',()=>{
   const analysis=inspectLedger(withExtra(valid),source).analysis!;
   const broken=JSON.parse(JSON.stringify(analysis));
   broken.normalizationAudit.corrections.push({id:'X',kind:'typo_fix',from:'a',to:'b',reason:'r',sourceRefs:[{sourceId:'source_1',paragraphId:'p99'}],detectedBy:'llm'});
   broken.events[0].preliminary={value:'variation',reason:'',sourceRefs:[]};
   const loaded=validateSavedAnalysis(broken);
   expect(loaded.normalizationAudit?.corrections.map(c=>c.id)).toEqual(['A1']);
   expect(loaded.events[0].preliminary).toBeUndefined();
   const old=JSON.parse(JSON.stringify(inspectLedger(parseLedger(ledgerFixture()),source).analysis!));
   expect(validateSavedAnalysis(old).normalizationAudit).toBeUndefined();
  });
});

describe('paragraph reference normalization and self-healing', () => {
  it('normalizes bracketed, prefixed, uppercase, duplicate, and range references', () => {
    const multiParagraphSource = sourceFromText(
      Array.from({ length: 15 }, (_, i) => `段落${i + 1}の本文`).join('\n')
    );
    // [p1] -> p1
    expect(normalizeRefTokens('[p1]', multiParagraphSource)).toEqual(['p1']);
    // source_1/p2 -> p2
    expect(normalizeRefTokens('source_1/p2', multiParagraphSource)).toEqual(['p2']);
    // P3 -> p3
    expect(normalizeRefTokens('P3', multiParagraphSource)).toEqual(['p3']);
    // duplicates: p4,p4 -> p4
    expect(normalizeRefTokens('p4,p4,p4', multiParagraphSource)).toEqual(['p4']);
    // Japanese comma: p1、p2
    expect(normalizeRefTokens('p1、p2', multiParagraphSource)).toEqual(['p1', 'p2']);
    // range: p5-p8
    expect(normalizeRefTokens('p5-p8', multiParagraphSource)).toEqual(['p5', 'p6', 'p7', 'p8']);
    // range with Japanese tilde: p10〜p12
    expect(normalizeRefTokens('p10〜p12', multiParagraphSource)).toEqual(['p10', 'p11', 'p12']);
  });

  it('self-heals transposed columns in [整理] section with a warning', () => {
    // Standard: ID, kind, references, text, reason
    // Inverted 1: ID, kind, text, references, reason
    const invertedLedger = ledgerFixture().replace(
      'D1\texcluded\tp3\t文献見出し\t出来事ではない',
      'D1\texcluded\t事後調査の文献情報\tp1\t調査活動のため除外'
    );
    const result = inspectLedger(parseLedger(invertedLedger), source);
    expect(result.issues).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('整理 D1 の列順'))).toBe(true);
    expect(result.analysis?.dispositions?.find((d) => d.id === 'D1')).toMatchObject({
      kind: 'excluded',
      paragraphId: 'p1',
      text: '事後調査の文献情報',
      reason: '調査活動のため除外',
    });
  });

  it('provides effective paragraph range and fallback context when out-of-range paragraph is cited', () => {
    const longSource = sourceFromText(
      Array.from({ length: 78 }, (_, i) => `段落${i + 1}の本文内容`).join('\n')
    );
    // LLM cited non-existent p80
    const text = ledgerFixture().replace('p1\trecorded', 'p80\trecorded');
    const doc = parseLedger(text);
    const result = inspectLedger(doc, longSource);
    expect(result.issues[0].message).toContain('原文参照が存在しません');
    const repairPrompt = ledgerRepairInput(doc, result.issues, longSource);
    // Must inform LLM of the valid paragraph ID range (p1 ~ p78)
    expect(repairPrompt).toContain('p1 〜 p78（全78段落）');
    // Must include terminal paragraphs in context
    expect(repairPrompt).toContain('[p78]');
  });
});

describe('parseLedger resilience and self-healing (ADR-0024)', () => {
  it('auto-numbers missing ID in [帰結] (4 columns starting with status)', () => {
    const text = ledgerFixture().replace(
      '[完了]',
      '[帰結]\nID\t判定\tイベントID\t原文参照\t理由\nidentified\tE1\tp1\t機能喪失\n[完了]'
    );
    const doc = parseLedger(text);
    const outcomeRow = doc.rows.find((r) => r.section === '帰結');
    expect(outcomeRow).toBeDefined();
    expect(outcomeRow?.id).toMatch(/^out_\d+$/);
    expect(outcomeRow?.cells[1]).toBe('identified');
    expect(outcomeRow?.cells[2]).toBe('E1');
  });

  it('normalizes numeric ID and placeholder ID in terminal sections', () => {
    const text = ledgerFixture().replace(
      'D1\texcluded\tp3\t文献見出し\t出来事ではない',
      '1\texcluded\tp3\t文献見出し\t出来事ではない\n-\tbackground\tp1\t前提背景\t分析用'
    );
    const doc = parseLedger(text);
    const dRows = doc.rows.filter((r) => r.section === '整理');
    expect(dRows).toHaveLength(2);
    expect(dRows[0].id).toBe('D_1');
    expect(dRows[1].id).toMatch(/^D_\d+$/);
  });

  it('stitches together multi-line wrapped cells caused by embedded newlines', () => {
    const wrappedLedger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t担当者\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t起動\t担当者が装置を起動した途中で',
      '突発的な異常が発生した\tA1:actor\tp1\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(wrappedLedger);
    const eventRow = doc.rows.find((r) => r.id === 'E1');
    expect(eventRow).toBeDefined();
    expect(eventRow?.cells[3]).toContain('担当者が装置を起動した途中で 突発的な異常が発生した');
    expect(eventRow?.cells[4]).toBe('A1:actor');
    expect(eventRow?.cells[6]).toBe('recorded');
  });

  it('handles multi-space and markdown table delimiters gracefully', () => {
    const spaceLedger = [
      '[主体]',
      'ID    名称    種類',
      'A1    担当者    person',
      '[イベント]',
      'ID    時刻    見出し    内容    主体と役割    原文参照    区分',
      'E1    09:00    起動    装置を起動した    A1:actor    p1    recorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(spaceLedger);
    expect(doc.rows.map((r) => r.id)).toEqual(['A1', 'E1']);
  });

  it('provides rich contextual details in error message when ID is truly invalid', () => {
    const badLedger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t担当者\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      '???\t09:00\t起動\t装置を起動した\tA1:actor\tp1\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    expect(() => parseLedger(badLedger)).toThrowError(
      /台帳 6行目のIDが不正です（セクション=イベント、先頭セル="\?\?\?"）/
    );
  });

  it('auto-disambiguates duplicate relation IDs (e.g. R_dep repeated across multiple rows)', () => {
    const textWithDuplicateRelationIds = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t作業員\tperson',
      'A2\t指揮者\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t指示\t指揮者が指示した\tA2:actor\tp1\trecorded',
      'E2\t09:01\t着手\t作業員が着手した\tA1:actor\tp1\trecorded',
      'E3\t09:05\t報告\t作業員が報告した\tA1:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R_dep\tdependency\tE1\tA2\tE2\tA1\tp1\t-\t-\tna',
      'R_dep\tdependency\tE2\tA1\tE3\tA1\tp1,p2\t-\t-\tna',
      'R_dep\tdependency\tE1\tA2\tE3\tA1\tp2\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(textWithDuplicateRelationIds);
    const relRows = doc.rows.filter((r) => r.section === '関係');
    expect(relRows).toHaveLength(3);
    expect(relRows[0].id).toBe('R_dep');
    expect(relRows[1].id).toBe('R_dep_2');
    expect(relRows[2].id).toBe('R_dep_3');
  });

  it('auto-generates relation IDs when given as placeholder (-)', () => {
    const textWithPlaceholderRelId = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t作業員\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t作業1\t作業した\tA1:actor\tp1\trecorded',
      'E2\t09:05\t作業2\t作業した\tA1:actor\tp1\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      '-\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(textWithPlaceholderRelId);
    const relRow = doc.rows.find((r) => r.section === '関係');
    expect(relRow).toBeDefined();
    expect(relRow?.id).toMatch(/^R_\d+$/);
  });

  it('still throws error on duplicate IDs in foreign-keyed sections (主体 and イベント)', () => {
    const textWithDuplicateEventIds = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t作業員\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t作業1\t作業した\tA1:actor\tp1\trecorded',
      'E1\t09:05\t作業2\t作業した\tA1:actor\tp1\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    expect(() => parseLedger(textWithDuplicateEventIds)).toThrowError(
      '台帳のID イベント/E1 が重複しています。'
    );
  });
});

describe('one-sided placeholder endpoint self-healing in relations', () => {
  it('auto-completes single assigned subject when endpoint is unspecified (-)', () => {
    // E1 has A1 only, E2 has A2 only.
    // R1: from is '-' but E1 has only A1 -> auto-completes to A1
    const singleActorFixture = ledgerFixture().replace('A1:actor,A2:target', 'A1:actor');
    const text = singleActorFixture.replace(
      '[共有カード]',
      'R1\ttransfer\tE1\t-\tE2\tA2\tp1\tinformation\toccurred\tconfirmed\n[共有カード]'
    );
    const result = inspectLedger(parseLedger(text), source);
    expect(result.issues).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('関係 R1 (transfer) の元主体が未指定（-）のため'))).toBe(true);
    expect(result.analysis?.relations[0]).toMatchObject({
      id: 'R1',
      kind: 'transfer',
      sourceEntityId: 'A1',
      targetEntityId: 'A2',
    });
  });

  it('safely demotes to before when unspecified endpoint involves multi-actor event (reproducing R21)', () => {
    // E20 has multiple actors: A1, A2, OP. E22 has OP only.
    // R21 impact E20 - E22 OP -> source entity cannot be uniquely chosen -> auto-demotes to before
    const multiActorLedger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t作業員1\tperson',
      'A2\t作業員2\tperson',
      'OP\t運転士\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E20\t10:46\t触車事故\t作業員と列車が接触\tA1:actor,A2:actor,OP:affected\tp1\trecorded',
      'E22\t10:47\t非常停止\t運転士が非常制動手配\tOP:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R21\timpact\tE20\t-\tE22\tOP\tp1,p2\tother\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const result = inspectLedger(parseLedger(multiActorLedger), source);
    expect(result.issues).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('関係 R21 (impact: E20 → E22) の元主体が未特定のため、時系列前後関係 (before) に自動補正しました'))).toBe(true);
    expect(result.analysis?.relations[0]).toMatchObject({
      id: 'R21',
      kind: 'before',
      sourceEventId: 'E20',
      targetEventId: 'E22',
      sourceEntityId: undefined,
      targetEntityId: undefined,
      receipt: 'na',
    });
  });
});

describe('6-column event auto-completion and resilient audit phrase matching (ADR-0032)', () => {
  it('cleanPunctuation correctly strips Japanese and ASCII quotes, brackets, and whitespace', () => {
    expect(cleanPunctuation('「線路内に立入る場合の確認等」を実施しなかった')).toBe('線路内に立入る場合の確認等を実施しなかった');
    expect(cleanPunctuation('『報告書』 "test" （注記） 【重要】')).toBe('報告書test注記重要');
  });

  it('auto-completes missing 7th column (recorded) for 6-column event rows with a warning (reproducing E1)', () => {
    const sixColLedger = [
      '[主体]',
      'ID\t名称\t種類',
      'S_SUB\t下請会社\torganization',
      'S_HIJ\t作業員隊\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t当日朝\t作業員派遣\t下請会社が作業員を派遣した\tS_SUB:actor,S_HIJ:affected\tp1',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(sixColLedger);
    const result = inspectLedger(doc, source);
    expect(result.issues).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('イベント E1: 記録区分が省略されていたため、既定値 "recorded" を自動補完しました。'))).toBe(true);
    expect(result.analysis?.events[0]).toMatchObject({
      id: 'E1',
      recordKind: 'recorded',
    });
  });

  it('preserves 7-column requirement error when 6-column row already contains recordKind (shifted/missing earlier columns)', () => {
    const shiftedLedger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t担当者\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\t起動\t担当者が起動した\tA1:actor\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(shiftedLedger);
    const result = inspectLedger(doc, source);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].message).toContain('7列が必要です（現在6列）');
  });

  it('matches detection phrase in [表現] using punctuation normalization (Layer 1, reproducing M5)', () => {
    const customSource = sourceFromText('本来実施すべき「線路内に立入る場合の確認等」を実施しなかった。');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t作業員\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E12\t10:46\t確認未実施\t線路内立入手順を実施しなかった\tA1:actor\tp1\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[表現]',
      'ID\t原文参照\t検知語句\t処理\tイベントID\t理由',
      'M5\tp1\t線路内に立入る場合の確認等を実施しなかった\taction_only\tE12\t安全確認手順の未実施という客観的事実として記録',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(ledger);
    const result = inspectLedger(doc, customSource);
    expect(result.issues).toEqual([]);
    expect(result.analysis?.normalizationAudit?.subjectiveNotices).toHaveLength(1);
    expect(result.analysis?.normalizationAudit?.subjectiveNotices[0]).toMatchObject({
      id: 'M5',
      phrase: '線路内に立入る場合の確認等を実施しなかった',
      treatment: 'action_only',
      eventIds: ['E12'],
      sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
    });
  });

  it('auto-rebinds detection phrase in [表現] when cited in wrong paragraph but found in another (Layer 2)', () => {
    const customSource = sourceFromText('段落1の文言。\n本来実施すべき「安全確認」を実施しなかった。');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\t作業員\tperson',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:00\t作業\t作業実施\tA1:actor\tp2\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[表現]',
      'ID\t原文参照\t検知語句\t処理\tイベントID\t理由',
      'S1\tp1\t安全確認を実施しなかった\taction_only\tE1\t行為のみ記録',
      '[完了]',
    ].join('\n');
    const doc = parseLedger(ledger);
    const result = inspectLedger(doc, customSource);
    expect(result.issues).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('表現 S1: 検知語句 "安全確認を実施しなかった" の参照段落を p2 に自動補正しました。'))).toBe(true);
    expect(result.analysis?.normalizationAudit?.subjectiveNotices[0].sourceRefs).toEqual([
      { sourceId: 'source_1', paragraphId: 'p2' },
    ]);
  });
});

describe('SubjectPoset transitivity across ledger validation, projection, consolidation, and reconciliation', () => {
  it('accepts parent/ancestor subjects in relation endpoints when child subjects participate (reproducing R5)', () => {
    const hanedaSource = sourceFromText(
      'タワー東はA機に「No.1, taxi to holding point C5」と指示した。\n副操縦員Aは復唱し、機長Aは「問題なしね」と応答してチェックリストを指示した。\n機長Aは非常脱出口から脱出した。\n管制所は空港事務所と消防へ通報した。'
    );
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'ORG_JCG\t海上保安庁\torganization\tmid\t-\t-',
      'ORG_A_CREW\tA機乗組員\torganization\thigh\tORG_JCG\tp2',
      'A1\t機長A\tperson\thigh\tORG_A_CREW\tp2',
      'A2\t副操縦員A\tperson\thigh\tORG_A_CREW\tp2',
      'C1\tタワー東\tperson\thigh\t-\tp1',
      'ORG_CAB\t東京飛行場管制所\torganization\tmid\t-\t-',
      'ORG_FIRE\t空港消防\torganization\tlow\t-\t-',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E23\t17:45\t走行指示\tタワー東がC5までの走行を指示した\tC1:actor\tp1\trecorded',
      'E25\t17:45\t指示復唱\t副操縦員Aが復唱し機長Aが確認した\tA1:actor,A2:confirmed_recipient\tp2\trecorded',
      'E43\t17:47\t火災通報\t管制所が消防等へ通報した\tORG_CAB:actor\tp4\trecorded',
      'E44\t-\t機長A脱出\t機長Aが脱出した\tA1:actor\tp3\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R5\ttransfer\tE23\tC1\tE25\tORG_A_CREW\tp1,p2\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const result = inspectLedger(parseLedger(ledger), hanedaSource);
    expect(result.issues).toEqual([]);
    expect(result.analysis).toBeDefined();

    // Downstream validation, projection (before consolidation), reconciliation, and consolidation all preserve R5
    const analysis = validateSavedAnalysis(result.analysis!);
    const preConsolidationSchema = projectAnalysis(analysis);
    const r5EdgePre = preConsolidationSchema.edges.find((e) => e.relationId === 'R5');
    expect(r5EdgePre).toBeDefined();
    expect(r5EdgePre?.source).toBe(preConsolidationSchema.nodes.find((n) => n.lane === 'タワー東' && n.event_ids?.includes('E23'))?.id);
    // Target resolves deterministically to A2 (confirmed_recipient) prior to lane consolidation
    expect(r5EdgePre?.target).toBe(preConsolidationSchema.nodes.find((n) => n.lane === '副操縦員A' && n.event_ids?.includes('E25'))?.id);

    const reconciled = reconcileAnalysis(preConsolidationSchema, preConsolidationSchema);
    expect(reconciled.analysis?.relations.some((r) => r.id === 'R5')).toBe(true);

    // Also succeeds when ORG_A_CREW is merged to subject_others while A1/A2 remain independent (limit=5)
    const consolidated = consolidateSubjects(analysis, 5);
    const consolidatedSchema = projectAnalysis(consolidated);
    expect(consolidatedSchema.edges.some((e) => e.relationId === 'R5')).toBe(true);
  });

  it('still rejects unrelated subject references like R17 (ORG_FIRE on E44) and same-subject dependencies like R21', () => {
    const hanedaSource = sourceFromText(
      '客室乗務員が使用不可と判断した。\n先任客室乗務員がドアを開放した。\n機長Aは脱出した。\n管制所が通報した。'
    );
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'ORG_B_CABIN\tB機客室乗務員\torganization\thigh\t-\tp1',
      'B3\t先任客室乗務員\tperson\thigh\tORG_B_CABIN\tp2',
      'A1\t機長A\tperson\thigh\t-\tp3',
      'ORG_CAB\t管制所\torganization\tmid\t-\t-',
      'ORG_FIRE\t消防\torganization\tlow\t-\t-',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E43\t17:47\t緊急通報\t管制所が通報した\tORG_CAB:actor\tp4\trecorded',
      'E44\t-\t機長A脱出\t機長Aが脱出した\tA1:actor\tp3\trecorded',
      'E47\t17:48\t出口不可判断\t客室乗務員が判断した\tORG_B_CABIN:actor\tp1\trecorded',
      'E48\t17:51\tドア開放\t先任客室乗務員が開放した\tB3:actor,ORG_B_CABIN:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R17\ttransfer\tE43\tORG_CAB\tE44\tORG_FIRE\tp4\tinformation\toccurred\tunconfirmed',
      'R21\tdependency\tE47\tORG_B_CABIN\tE48\tORG_B_CABIN\tp1,p2\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const result = inspectLedger(parseLedger(ledger), hanedaSource);
    expect(result.issues.map((i) => i.row.id)).toEqual(['R17', 'R21']);
  });

  it('parses per-event outcome_kind suffixes (:loss, :recovery, :near_miss) in [帰結] without breaking pure event IDs', () => {
    const src = sourceFromText('両機が衝突した。\n全員が機外へ脱出した。');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\tB機客室乗務員\torganization',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E36\t17:47\t衝突・炎上\t両機が衝突した\tA1:affected\tp1\trecorded',
      'E50\t18:05\t全員脱出完了\t全員が機外へ脱出した\tA1:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\tbefore\tE36\t-\tE50\t-\tp1,p2\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'out_1\tidentified\tE36:loss,E50:recovery\tp1,p2\t衝突損失と全員脱出による二次的回復帰結',
      '[完了]',
    ].join('\n');

    const result = inspectLedger(parseLedger(ledger), src);
    expect(result.issues).toEqual([]);
    expect(result.analysis?.outcome?.eventIds).toEqual(['E36', 'E50']);
    expect(result.analysis?.outcome?.kind).toBe('loss');
    expect(result.analysis?.events.find((e) => e.id === 'E36')?.outcome_kind).toBe('loss');
    expect(result.analysis?.events.find((e) => e.id === 'E50')?.outcome_kind).toBe('recovery');
  });

  it('defaults unsuffixed outcome events to "loss" and keeps representative kind as "loss" when mixed with :recovery (ADR-0054)', () => {
    const src = sourceFromText('A機とB機が衝突した。\nA機が炎上・大破した。\nB機全員が機外へ脱出した。');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\tB機客室乗務員\torganization',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E34\t17:47:20\t衝突\tA機とB機が衝突した\tA1:affected\tp1\trecorded',
      'E35\t17:47:25\t炎上・大破\tA機が炎上・大破した\tA1:affected\tp2\trecorded',
      'E50\t18:05:00\t全員脱出完了\t全員が機外へ脱出した\tA1:actor\tp3\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\tbefore\tE34\t-\tE35\t-\tp1,p2\t-\t-\tna',
      'R2\tbefore\tE35\t-\tE50\t-\tp2,p3\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'out_1\tidentified\tE34,E35,E50:recovery\tp1,p2,p3\t衝突・炎上による損失と全員脱出による回復',
      '[完了]',
    ].join('\n');

    const result = inspectLedger(parseLedger(ledger), src);
    expect(result.issues).toEqual([]);
    expect(result.analysis?.outcome?.eventIds).toEqual(['E34', 'E35', 'E50']);
    expect(result.analysis?.outcome?.kind).toBe('loss');
    expect(result.analysis?.events.find((e) => e.id === 'E34')?.outcome_kind).toBe('loss');
    expect(result.analysis?.events.find((e) => e.id === 'E35')?.outcome_kind).toBe('loss');
    expect(result.analysis?.events.find((e) => e.id === 'E50')?.outcome_kind).toBe('recovery');

    // Canvas projection verification: unsuffixed nodes must be 'loss' (red/rose), :recovery node must be 'recovery' (emerald/green)
    const projected = projectAnalysis(result.analysis!);
    const nodeE34 = projected.nodes.find((n) => n.event_ids?.includes('E34'));
    const nodeE35 = projected.nodes.find((n) => n.event_ids?.includes('E35'));
    const nodeE50 = projected.nodes.find((n) => n.event_ids?.includes('E50'));
    expect(nodeE34?.outcome_kind).toBe('loss');
    expect(nodeE35?.outcome_kind).toBe('loss');
    expect(nodeE50?.outcome_kind).toBe('recovery');
  });

  it('correctly handles multi-row [帰結] merge where row 1 has pure event ID and row 2 has :recovery (ADR-0054)', () => {
    const src = sourceFromText('A機とB機が衝突した。\nB機全員が機外へ脱出した。');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\tB機客室乗務員\torganization',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E34\t17:47:20\t衝突\tA機とB機が衝突した\tA1:affected\tp1\trecorded',
      'E50\t18:05:00\t全員脱出完了\t全員が機外へ脱出した\tA1:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\tbefore\tE34\t-\tE50\t-\tp1,p2\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'out_1\tidentified\tE34\tp1\t衝突・大破による損失',
      'out_2\tidentified\tE50:recovery\tp2\t全員脱出成功による回復帰結',
      '[完了]',
    ].join('\n');

    const result = inspectLedger(parseLedger(ledger), src);
    expect(result.issues).toEqual([]);
    expect((result.warnings ?? []).length).toBeGreaterThanOrEqual(1);
    expect(result.analysis?.outcome?.eventIds).toEqual(['E34', 'E50']);
    expect(result.analysis?.outcome?.kind).toBe('loss');
    expect(result.analysis?.events.find((e) => e.id === 'E34')?.outcome_kind).toBe('loss');
    expect(result.analysis?.events.find((e) => e.id === 'E50')?.outcome_kind).toBe('recovery');
  });

  it('preserves outcome.kind as undefined when all outcome events are unsuffixed without rowKind (backward compatibility)', () => {
    const src = sourceFromText('A機とB機が衝突した。');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類',
      'A1\tB機客室乗務員\torganization',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E34\t17:47:20\t衝突\tA機とB機が衝突した\tA1:affected\tp1\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'out_1\tidentified\tE34\tp1\t衝突',
      '[完了]',
    ].join('\n');

    const result = inspectLedger(parseLedger(ledger), src);
    expect(result.issues).toEqual([]);
    expect(result.analysis?.outcome?.eventIds).toEqual(['E34']);
    expect(result.analysis?.outcome?.kind).toBeUndefined();
    expect(result.analysis?.events.find((e) => e.id === 'E34')?.outcome_kind).toBeUndefined();

    // In projection, undefined outcome.kind falls back to 'loss' by default
    const projected = projectAnalysis(result.analysis!);
    expect(projected.nodes.find((n) => n.event_ids?.includes('E34'))?.outcome_kind).toBe('loss');
  });

  it('sets identified outcome events classification to "outcome" and protects them in classificationInput and inspectClassifications (ADR-0055)', () => {
    const src = sourceFromText(
      '機長Aが滑走路へ進入した。\n他の乗組員5名は現場で死亡が確認された。\n機長Aは非常脱出口から脱出した。'
    );
    const ledger = [
      '[主体]',
      'ID\t名称\t種類',
      'ACREW\tA機乗組員\torganization',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E10\t17:46\t滑走路進入\t機長Aが滑走路へ進入した\tACREW:actor\tp1\trecorded',
      'E27\t17:50\tA機乗組員死亡確認\t他の乗組員5名は現場で死亡が確認された\tACREW:affected\tp2\trecorded',
      'E26\t17:48\tA機機長脱出\t機長Aは非常脱出口から脱出した\tACREW:actor\tp3\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\tbefore\tE10\t-\tE26\t-\tp1,p3\t-\t-\tna',
      'R2\tbefore\tE26\t-\tE27\t-\tp3,p2\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'out_1\tidentified\tE27,E26:recovery\tp2,p3\t乗組員死亡の損失と機長脱出の回復',
      '[完了]',
    ].join('\n');

    const result = inspectLedger(parseLedger(ledger), src);
    expect(result.issues).toEqual([]);
    const analysis = result.analysis!;

    // 1. inspectLedger initializes identified outcome events as 'outcome', leaving normal/pending events 'unclassified'
    expect(analysis.events.find((e) => e.id === 'E10')?.classification).toBe('unclassified');
    expect(analysis.events.find((e) => e.id === 'E27')?.classification).toBe('outcome');
    expect(analysis.events.find((e) => e.id === 'E26')?.classification).toBe('outcome');

    // 2. classificationInput excludes outcome events (even for legacy data where classification was 'unclassified')
    const legacyLikeAnalysis = {
      ...analysis,
      events: analysis.events.map((e) => ({ ...e, classification: 'unclassified' as const })),
    };
    const promptInput = classificationInput(legacyLikeAnalysis);
    expect(promptInput).toContain('E10\t17:46\t滑走路進入');
    expect(promptInput).not.toContain('E27\t17:50\tA機乗組員死亡確認');
    expect(promptInput).not.toContain('E26\t17:48\tA機機長脱出');

    // 3. inspectClassifications ignores unexpected LLM classification rows for outcome events and never overwrites them
    const llmReply = parseLedger(
      [
        '[判定]',
        'E10\tvariation\t通常作業からの逸脱（無視/Ruleベース）：進入許可なく滑走路へ進入\tsource_1/p1',
        'E27\tvariation\t通常作業からの逸脱：死亡確認\tsource_1/p2',
        'E26\tvariation\tレジリエンス対応：非常脱出口から脱出\tsource_1/p3',
        '[完了]',
      ].join('\n'),
      true
    );
    const inspected = inspectClassifications(llmReply, legacyLikeAnalysis);
    expect(inspected.issues).toEqual([]);
    expect(inspected.analysis?.events.find((e) => e.id === 'E10')?.classification).toBe('variation');
    // E27 and E26 are protected and remain untouched (not overwritten to 'variation')
    expect(inspected.analysis?.events.find((e) => e.id === 'E27')?.classification).not.toBe('variation');
    expect(inspected.analysis?.events.find((e) => e.id === 'E26')?.classification).not.toBe('variation');

    const projected = projectAnalysis(inspected.analysis!);
    expect(projected.nodes.find((n) => n.event_ids?.includes('E10'))?.type).toBe('variation');
    expect(projected.nodes.find((n) => n.event_ids?.includes('E27'))?.type).toBe('outcome');
    expect(projected.nodes.find((n) => n.event_ids?.includes('E27'))?.outcome_kind).toBe('loss');
    expect(projected.nodes.find((n) => n.event_ids?.includes('E26'))?.type).toBe('outcome');
    expect(projected.nodes.find((n) => n.event_ids?.includes('E26'))?.outcome_kind).toBe('recovery');
  });
});

describe('ADR-0076: 9-column same-event relation completion and single-subject dependency demotion', () => {
  it('auto-completes omitted targetEventId on 9-column same-event transfer when both entities participate, while rejecting uninvolved or cross-event 9-column rows', () => {
    const src = sourceFromText(
      [
        'タワー東はDFに着陸後の離陸決定を伝えた。',
        '機長Aはチェックリストを開始した。',
      ].join('\n')
    );
    const validLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'O_TWR\t東京飛行場管制所\torganization\thigh\t-\tp1',
      'TWR_E\tタワー東\tperson\thigh\tO_TWR\tp1',
      'DF\t出域調整席\tperson\tmid\tO_TWR\t-',
      'A_CAPT\t機長A\tperson\thigh\t-\tp2',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E29\t17:44\t決定伝達\tタワー東がDFに伝えた\tTWR_E:actor,DF:confirmed_recipient\tp1\trecorded',
      'E30\t17:45\t確認開始\t機長Aが確認を開始した\tA_CAPT:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      // 9-column same-event transfer omitting second E29 (reproducing R19/R20/R22)
      'R19\ttransfer\tE29\tTWR_E\tDF\tp1\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const ok = inspectLedger(parseLedger(validLedger), src);
    expect(ok.issues).toEqual([]);
    expect(ok.warnings?.some((w) => w.includes('R19') && w.includes('E29'))).toBe(true);
    expect(ok.analysis?.relations).toHaveLength(1);
    expect(ok.analysis?.relations[0]).toMatchObject({
      id: 'R19',
      kind: 'transfer',
      sourceEventId: 'E29',
      sourceEntityId: 'TWR_E',
      targetEventId: 'E29',
      targetEntityId: 'DF',
      resource: 'information',
      status: 'occurred',
      receipt: 'confirmed',
    });

    // Guard check: 9-column row where target entity A_CAPT does NOT participate in E29 must still fail validation
    const invalidUninvolved = validLedger.replace(
      'R19\ttransfer\tE29\tTWR_E\tDF\tp1\tinformation\toccurred\tconfirmed',
      'R19\ttransfer\tE29\tTWR_E\tA_CAPT\tp1\tinformation\toccurred\tconfirmed'
    );
    const rejected = inspectLedger(parseLedger(invalidUninvolved), src);
    expect(rejected.issues.map((i) => i.row.id)).toEqual(['R19']);
    expect(rejected.issues[0].message).toContain('10列が必要です');
  });

  it('auto-demotes same-entity dependency to before ONLY when both events solely involve that single entity, preserving error detection on shared multi-subject events', () => {
    const src = sourceFromText(
      [
        '海上保安庁が対策本部を設置した。',
        '海上保安庁が物資空輸を打診した。',
        '両機が衝突した。',
        '機長Aが機外へ脱出した。',
      ].join('\n')
    );
    const singleSubjectLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'O_JCG\t海上保安庁\torganization\thigh\t-\tp1',
      'A_CAPT\t機長A\tperson\thigh\tO_JCG\tp3,p4',
      'B_CAPT\t機長B\tperson\thigh\t-\tp3',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E02\t2024-01-01 16:11\t対策本部設置\t対策本部を設置した\tO_JCG:actor\tp1\trecorded',
      'E07\t2024-01-02 11:30\t空輸打診\t物資空輸を打診した\tO_JCG:actor\tp2\trecorded',
      'E49\t2024-01-02 17:47\t両機衝突\t両機が衝突した\tA_CAPT:affected,B_CAPT:affected\tp3\trecorded',
      'E57\t2024-01-02 17:48\t機長A脱出\t機長Aが脱出した\tA_CAPT:actor\tp4\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      // R02: both E02 and E07 solely have O_JCG -> safely demoted to `before` without an LLM repair call
      'R02\tdependency\tE02\tO_JCG\tE07\tO_JCG\tp1,p2\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const resSingle = inspectLedger(parseLedger(singleSubjectLedger), src);
    expect(resSingle.issues).toEqual([]);
    expect(resSingle.warnings?.some((w) => w.includes('R02') && w.includes('before'))).toBe(true);
    expect(resSingle.analysis?.relations[0]).toMatchObject({
      id: 'R02',
      kind: 'before',
      sourceEventId: 'E02',
      targetEventId: 'E07',
      sourceEntityId: undefined,
      targetEntityId: undefined,
    });

    // R37 on shared multi-subject event E49(A_CAPT, B_CAPT) -> E57(A_CAPT) MUST NOT be silently demoted,
    // because B_CAPT -> A_CAPT cross-lane repair opportunity could exist!
    const sharedEventLedger = singleSubjectLedger.replace(
      'R02\tdependency\tE02\tO_JCG\tE07\tO_JCG\tp1,p2\t-\t-\tna',
      'R37\tdependency\tE49\tA_CAPT\tE57\tA_CAPT\tp3,p4\t-\t-\tna'
    );
    const resShared = inspectLedger(parseLedger(sharedEventLedger), src);
    expect(resShared.issues.map((i) => i.row.id)).toEqual(['R37']);
    expect(resShared.issues[0]).toMatchObject({ kind: 'dependency', field: '依存端点' });

    // ADR-0082 (9yqp R22/R26): When both events have the EXACT SAME sole `:actor` and other participants are
    // purely passive (`:target` / `:affected`), safely demote to `before` without wasting an LLM repair call;
    // when another `:actor` co-participates (9yqp R19), still report an issue to preserve cross-actor repair!
    const soleActorSrc = sourceFromText(
      [
        '運転士は見張員の合図を確認して減速進入した。',
        '運転士は作業員が待避完了したと捉えた。',
        'B見張員はD見張員と進来を確認した。',
        'B見張員は待避合図を出した。',
      ].join('\n')
    );
    const soleActorLedger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'driver\t運転士\tperson\tmid\t-\tp1,p2',
      'lookout_b\tB見張員\tperson\thigh\t-\tp1,p3,p4',
      'relay_d\tD見張員\tperson\tmid\t-\tp3',
      'workers\t作業員\tperson\thigh\t-\tp2',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E24\t10:46\t合図確認進入\t運転士が合図を確認した\tdriver:actor,lookout_b:target\tp1\trecorded',
      'E25\t10:46\t待避完了認識\t運転士が待避完了と捉えた\tdriver:actor,workers:target\tp2\trecorded',
      'E19\t10:44\t進来確認\tB見張員とD見張員が確認した\tlookout_b:actor,relay_d:actor\tp3\trecorded',
      'E20\t10:45\t待避合図\tB見張員が合図した\tlookout_b:actor\tp4\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R22\tdependency\tE24\tdriver\tE25\tdriver\tp1,p2\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');
    const resSoleActor = inspectLedger(parseLedger(soleActorLedger), soleActorSrc);
    expect(resSoleActor.issues).toEqual([]);
    expect(resSoleActor.analysis?.relations[0]).toMatchObject({
      id: 'R22',
      kind: 'before',
      sourceEventId: 'E24',
      targetEventId: 'E25',
    });

    const coActorLedger = soleActorLedger.replace(
      'R22\tdependency\tE24\tdriver\tE25\tdriver\tp1,p2\t-\t-\tna',
      'R19\tdependency\tE19\tlookout_b\tE20\tlookout_b\tp3,p4\t-\t-\tna'
    );
    const resCoActor = inspectLedger(parseLedger(coActorLedger), soleActorSrc);
    expect(resCoActor.issues.map((i) => i.row.id)).toEqual(['R19']);
  });

  it('ignores inverted corporate-under-crew or corporate-under-person parent links with a warning while preserving holding-group parents (ADR-0077)', () => {
    const src = sourceFromText(
      [
        '東武グループの東武鉄道株式会社が除草作業を発注した。',
        '下請会社が除草作業班を編成し、A作業指揮者が指揮した。',
      ].join('\n')
    );
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'ORG_GRP\t東武グループ\torganization\tlow\t-\t-',
      'ORG_TOBU\t東武鉄道株式会社\torganization\tmid\tORG_GRP\tp1',
      'A_TEAM\t除草作業班\torganization\thigh\t-\tp2',
      'A_LEAD\tA作業指揮者\tperson\thigh\tA_TEAM\tp2',
      // Inverted parent 1: company under field crew (A_SUB -> A_TEAM)
      'A_SUB\t下請会社\torganization\tlow\tA_TEAM\t-',
      // Inverted parent 2: company under person (ORG_SUB2 -> A_LEAD)
      'ORG_SUB2\t協力業者\torganization\tlow\tA_LEAD\t-',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t08:00\t作業発注\t東武鉄道が発注した\tORG_TOBU:actor\tp1\trecorded',
      'E2\t09:00\t作業編成\t下請会社と作業班が準備した\tA_SUB:actor,A_TEAM:actor,A_LEAD:actor\tp2\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const res = inspectLedger(parseLedger(ledger), src);
    expect(res.issues).toEqual([]);
    const entities = res.analysis?.entities ?? [];
    const tobu = entities.find((e) => e.id === 'ORG_TOBU');
    const sub = entities.find((e) => e.id === 'A_SUB');
    const sub2 = entities.find((e) => e.id === 'ORG_SUB2');

    // Legitimate holding-group parent (`東武グループ`) is preserved
    expect(tobu?.parentEntityId).toBe('ORG_GRP');
    // Inverted parents (`下請会社 -> 除草作業班`, `協力業者 -> A作業指揮者`) are stripped with warnings
    expect(sub?.parentEntityId).toBeUndefined();
    expect(sub2?.parentEntityId).toBeUndefined();
    expect(res.warnings?.some((w) => w.includes('A_SUB') && w.includes('逆転包含'))).toBe(true);
    expect(res.warnings?.some((w) => w.includes('ORG_SUB2') && w.includes('逆転包含'))).toBe(true);
  });

  it('supports structured preliminary/classification tokens (variation:resilient, outcome:*, post_outcome) and downgrades evidence-less post_outcome safely (ADR-0078)', () => {
    const src = sourceFromText(
      [
        'バッチ処理で例外が発生した。',
        '担当者が手動フォールバックで被害拡大を抑止した。',
        '翌月に監査部会が事後レビューを実施した。',
        '根拠不足の事後項目が記録された。',
      ].join('\n')
    );
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'S_OPS\t運用担当\tperson\thigh\t-\tp1,p2',
      'S_AUD\t監査部会\torganization\tlow\t-\tp3,p4',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:00\t例外発生\tバッチ処理で例外が発生した\tS_OPS:affected\tp1\trecorded',
      'E2\t10:02\t手動フォールバック\t手動切替で拡大を抑止した\tS_OPS:actor\tp2\trecorded',
      'E3\t-\t事後レビュー\t翌月に事後レビューを実施した\tS_AUD:actor\tp3\trecorded',
      'E4\t-\t根拠なし項目\t記録された\tS_AUD:actor\tp4\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[帰結]',
      'O1\tidentified\tE1:loss\tp1\tバッチ例外による処理停止',
      '[仮判定]',
      'E2\tvariation:resilient\t手動フォールバックによる被害拡大抑止\tp2',
      'E3\tpost_outcome\t終息後の監査レビュー活動\tp3',
      // Missing reason/ref on post_outcome must downgrade to undetermined WITHOUT scope='post_outcome'
      'E4\tpost_outcome\t-\t-',
      '[完了]',
    ].join('\n');

    const res = inspectLedger(parseLedger(ledger), src);
    expect(res.issues).toEqual([]);
    const e2 = res.analysis?.events.find((e) => e.id === 'E2');
    const e3 = res.analysis?.events.find((e) => e.id === 'E3');
    const e4 = res.analysis?.events.find((e) => e.id === 'E4');
    expect(e2?.preliminary?.polarity).toBe('resilient');
    expect(e3?.preliminary?.scope).toBe('post_outcome');
    expect(e4?.preliminary?.value).toBe('undetermined');
    expect(e4?.preliminary?.scope).toBeUndefined();
  });

  it('rejects direct person<->machine Poset inclusion with a warning while preserving V-shaped man-machine composite upper subjects (ADR-0084)', () => {
    const src = sourceFromText(
      [
        '東武鉄道の第1020列車を運転士Aが運転していた。',
        '運転士Aが減速し、第1020列車が触車した。',
      ].join('\n')
    );
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'O_RAIL\t東武鉄道\torganization\thigh\t-\tp1',
      'U_TRAIN\t運転士Aが操作する第1020列車\torganization\thigh\tO_RAIL\tp1',
      // Invalid direct person->machine and machine->person edges alongside valid U_TRAIN
      'M_TRAIN\t第1020列車\tmachine\tmid\tP_DRV,U_TRAIN\t-',
      'P_DRV\t運転士A\tperson\tmid\tM_TRAIN,U_TRAIN\t-',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t10:45\t減速進入\t運転士Aが減速した\tP_DRV:actor\tp2\trecorded',
      'E2\t10:46\t触車\t第1020列車が触車した\tM_TRAIN:actor\tp2\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const res = inspectLedger(parseLedger(ledger), src);
    expect(res.issues).toEqual([]);
    const entities = res.analysis?.entities ?? [];
    const train = entities.find((e) => e.id === 'M_TRAIN');
    const drv = entities.find((e) => e.id === 'P_DRV');
    const unit = entities.find((e) => e.id === 'U_TRAIN');

    expect(train?.parentEntityIds).toEqual(['U_TRAIN']);
    expect(drv?.parentEntityIds).toEqual(['U_TRAIN']);
    expect(unit?.parentEntityIds).toEqual(['O_RAIL']);
    expect(res.warnings?.some((w) => w.includes('M_TRAIN') && w.includes('直接包含'))).toBe(true);
    expect(res.warnings?.some((w) => w.includes('P_DRV') && w.includes('直接包含'))).toBe(true);
  });

  it('emits repairable poset_ancestor_passive_target softIssues when a Poset hub has only passive target roles covered by acting subordinates (ADR-0087)', () => {
    const src = sourceFromText(
      [
        'G現場代理人が除草薬散布作業班に朝礼指示を行い、B列車見張員が了解した。',
        'A作業指揮者が除草薬散布作業班へ作業開始を連絡した。',
      ].join('\n')
    );
    const doc = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A5\t除草薬散布作業班\torganization\thigh\t-\tp1,p2',
        'A6\tA作業指揮者\tperson\thigh\tA5\tp2',
        'A7\tG現場代理人\tperson\thigh\tA5\tp1',
        'A8\tB列車見張員\tperson\thigh\tA5\tp1',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E5\t09:10\t朝礼指示\tG現場代理人が指示した\tA7:actor,A5:target\tp1\trecorded',
        'E6\t09:12\t配置了解\tB列車見張員が了解した\tA8:actor\tp1\trecorded',
        'E8\t09:30\t作業開始連絡\tA作業指揮者が連絡した\tA6:actor,A5:target\tp2\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\ttransfer\tE5\tA5\tE6\tA8\tp1\tinformation\toccurred\tconfirmed',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(doc, src);
    expect(res.issues).toEqual([]);
    expect(res.softIssues?.map((i) => i.row.id)).toEqual(['E5', 'R1', 'E8']);
    expect(res.softIssues?.every((i) => i.code === 'poset_ancestor_passive_target')).toBe(true);

    // Repairing E5, E8, and R1 to concrete subordinate IDs clears all softIssues
    const repairedDoc = applyLedgerRepair(
      doc,
      res.softIssues!,
      [
        '[イベント]',
        'E5\t09:10\t朝礼指示\tG現場代理人が指示した\tA7:actor,A8:confirmed_recipient\tp1\trecorded',
        'E8\t09:30\t作業開始連絡\tA作業指揮者が連絡した\tA6:actor,A7:confirmed_recipient\tp2\trecorded',
        '[関係]',
        'R1\ttransfer\tE5\tA7\tE6\tA8\tp1\tinformation\toccurred\tconfirmed',
        '[完了]',
      ].join('\n')
    );
    const repairedRes = inspectLedger(repairedDoc, src);
    expect(repairedRes.issues).toEqual([]);
    expect(repairedRes.softIssues).toBeUndefined();
  });

  it('flags isolated collective non-actor events on Poset parent hubs (xrrp E11/A4), protects causally connected corporate damage, and allows [整理] background demotion', () => {
    const src = sourceFromText(
      [
        '先行列車通過時の関係者配置図。',
        'G現場代理人が進行指示を出した。',
        'A作業指揮者が連絡し、B列車見張員が監視した。',
        '日本航空株式会社の機体が延焼損傷した。',
      ].join('\n')
    );

    const doc = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A4\t除草薬散布作業班\torganization\thigh\t-\tp2',
        'A5\tA作業指揮者\tperson\thigh\tA4\tp3',
        'A6\tG現場代理人\tperson\thigh\tA4\tp2',
        'A7\tB列車見張員\tperson\thigh\tA4\tp3',
        'JAL\t日本航空株式会社\torganization\thigh\t-\tp4',
        'B_CREW\t運航乗務員\torganization\thigh\tJAL\tp4',
        'B_CABIN\t客室乗務員\torganization\thigh\tJAL\tp4',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E11\t10:24頃\t先行列車通過\t先行列車通過時の配置状況\tA4:affected\tp1\trecorded',
        'E14\t10:42頃\t進行指示\tG現場代理人が進行指示を出した\tA6:actor,A5:target,A7:target\tp2\trecorded',
        'E15\t10:43頃\t監視実施\tA作業指揮者が連絡しB列車見張員が監視した\tA5:actor,A7:actor\tp3\trecorded',
        'E20\t17:58\t客室内延焼\t日本航空株式会社の機体が延焼損傷した\tJAL:affected\tp4\trecorded',
        'E21\t17:58\t乗員脱出\t運航乗務員と客室乗務員が脱出した\tB_CREW:actor,B_CABIN:actor\tp4\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\ttransfer\tE14\tA6\tE15\tA5\tp2,p3\tinformation\toccurred\tconfirmed',
        'R2\timpact\tE20\tJAL\tE21\tB_CREW\tp4\tother\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[仮判定]',
        'E11\tnormal\t定常の列車通過\tp1',
        'E14\tvariation\t進行指示\tp2',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(doc, src);
    expect(res.issues).toEqual([]);
    // E11 (isolated A4:affected on upper hub A4) is flagged, while causally connected E20 (JAL:affected) is protected
    expect(res.softIssues?.map((i) => i.row.id)).toEqual(['E11']);
    expect(res.softIssues?.[0].code).toBe('poset_ancestor_passive_target');
    expect(ledgerRepairInput(doc, res.softIssues!, src)).toContain('[整理]セクション');

    // Demoting unreferenced E11 to [整理] background clears the softIssue and removes stale [仮判定]/E11 cleanly
    const demotedDoc = applyLedgerRepair(
      doc,
      res.softIssues!,
      [
        '[整理]',
        'E11\tbackground\tp1\t先行列車通過時の関係者配置図\t配置図の見出しと図示のみで具体的な個別行動がないため',
        '[完了]',
      ].join('\n')
    );
    expect(demotedDoc.rows.some((r) => r.section === '仮判定' && r.id === 'E11')).toBe(false);
    expect(demotedDoc.rows.some((r) => r.section === '仮判定' && r.id === 'E14')).toBe(true);
    const demotedRes = inspectLedger(demotedDoc, src);
    expect(demotedRes.issues).toEqual([]);
    expect(demotedRes.softIssues).toBeUndefined();
    expect(demotedRes.analysis?.dispositions?.some((d) => d.id === 'E11' && d.kind === 'background')).toBe(true);
  });

  it('detects isolated collective outcome :affected subjects starving pre-outcome Poset siblings (bp8u A機死亡乗組員5名 vs 副操縦員A) and resolves cleanly on repair (ADR-0098)', async () => {
    const { findIsolatedOutcomeCollectiveMatches, findUnreferencedSubstantiveParagraphs } = await import('./eventLedger');
    const src = sourceFromText(
      [
        '## 1. 題目',
        '羽田空港滑走路衝突事故',
        'A機には機長A、副操縦員A、機上整備員Aほか計6名が搭乗していた。',
        '副操縦員AがC5停止位置指示を復唱し、機長Aが滑走路へ進入した。',
        'B機とA機が衝突し、機長Aが重傷、副操縦員A・機上整備員Aを含むA機乗組員5名が死亡した。',
        '管制塔の気象観測記録では視程良好であった。',
      ].join('\n\n')
    );

    const doc = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CREW_A\tJA722A搭乗員\torganization\thigh\t-\tp3',
        'A_CAPT_A\t機長A\tperson\thigh\tA_CREW_A\tp3',
        'A_FO_A\t副操縦員A\tperson\thigh\tA_CREW_A\tp3',
        'A_MECH_A\t機上整備員A\tperson\tmid\tA_CREW_A\tp3',
        'A_VICTIMS_A\tA機死亡乗組員5名\torganization\thigh\tA_CREW_A\tp5',
        'A_CAPT_B\t機長B\tperson\thigh\t-\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:43\t機内連絡確認\t機上整備員Aが機内連絡を確認した\tA_MECH_A:actor\tp3\trecorded',
        'E2\t17:45\t復唱と滑走路進入\t副操縦員Aが復唱し機長Aが滑走路へ進入した\tA_FO_A:actor,A_CAPT_A:actor\tp4\trecorded',
        'E3\t17:47\t両機衝突・乗組員死傷\tB機とA機が衝突し機長Aが重傷、乗組員5名が死亡した\tA_CAPT_B:actor,A_CAPT_A:affected,A_VICTIMS_A:affected\tp5\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\timpact\tE2\tA_CAPT_A\tE3\tA_CAPT_B\tp4,p5\tother\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[帰結]',
        'O1\tidentified\tE3:loss\tp5\t衝突による死傷',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(doc, src);
    expect(res.issues).toEqual([]);
    expect(res.softIssues?.map((i) => i.code)).toEqual(['isolated_outcome_collective_subject']);
    expect(res.softIssues?.[0].row.id).toBe('E3');
    expect(findIsolatedOutcomeCollectiveMatches(res.analysis!)).toEqual([
      {
        outcomeEventId: 'E3',
        collectiveEntityId: 'A_VICTIMS_A',
        parentEntityId: 'A_CREW_A',
        uncoveredSiblingIds: ['A_FO_A', 'A_MECH_A'],
      },
    ]);

    // Repair input automatically includes p3 (crew roster where A_FO_A / A_MECH_A are introduced) alongside p5!
    const repairPrompt = ledgerRepairInput(doc, res.softIssues!, src);
    expect(repairPrompt).toContain('[p3]');
    expect(repairPrompt).toContain('[p5]');

    // Unreferenced substantive paragraph check finds p6 while ignoring ## 1. 題目 (p1) and title line (p2)
    const unrefParas = findUnreferencedSubstantiveParagraphs(src, res.analysis!);
    expect(unrefParas.map((p) => p.id)).toEqual(['p6']);

    // Repairing E3 to assign :affected to A_FO_A & A_MECH_A alongside residual unextracted crew (A_VICTIMS_A) clears softIssues!
    const repairedDoc = applyLedgerRepair(
      doc,
      res.softIssues!,
      [
        '[イベント]',
        'E3\t17:47\t両機衝突・乗組員死傷\tB機とA機が衝突し機長Aが重傷、副操縦員A・整備員Aほか計5名が死亡した\tA_CAPT_B:actor,A_CAPT_A:affected,A_FO_A:affected,A_MECH_A:affected,A_VICTIMS_A:affected\tp5\trecorded',
        '[完了]',
      ].join('\n')
    );
    const repairedRes = inspectLedger(repairedDoc, src);
    expect(repairedRes.issues).toEqual([]);
    expect(repairedRes.softIssues).toBeUndefined();
  });
});
