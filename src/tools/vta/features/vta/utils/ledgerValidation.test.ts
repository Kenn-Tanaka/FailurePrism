import { describe, expect, it } from 'vitest';
import { parseLedger, inspectLedger, applyLedgerRepair, ledgerRepairInput, normalizeRefTokens } from './eventLedger';
import { ledgerFixture, ledgerSource } from './eventLedger.fixture';
import { sourceFromText, validateSavedAnalysis } from './eventAnalysis';
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
  it('rejects only the invented record: an original wording that is not in the cited paragraph',()=>{
   const result=inspectLedger(withExtra(valid.replace('A1\talias\t装置','A1\talias\t計器')),source);
   expect(result.analysis).toBeUndefined();
   expect(result.issues.map(i=>[i.row.section,i.row.id])).toEqual([['表記','A1']]);
   const inventedPhrase=inspectLedger(withExtra(valid.replace('p1\t起動','p1\t誤って')),source);
   expect(inventedPhrase.issues.map(i=>i.row.section)).toEqual(['表現']);
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
  it('includes audit rows in a row-specific repair request and accepts the repaired row only',()=>{
   const doc=withExtra(valid.replace('A1\talias\t装置','A1\talias\t計器'));
   const result=inspectLedger(doc,source);
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
