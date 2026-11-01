import { describe, expect, it } from 'vitest';
import { parseLedger, inspectLedger, applyLedgerRepair, ledgerRepairInput } from './eventLedger';
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
  it('requires a reference and reason for a definite provisional classification, never guessing one',()=>{
   const noRef=inspectLedger(withExtra('[仮判定]\nE1\tvariation\t理由\t-'),source);
   expect(noRef.issues.map(i=>[i.row.section,i.row.id])).toEqual([['仮判定','E1']]);
   const outside=inspectLedger(withExtra('[仮判定]\nE1\tnormal\t理由\tp2'),source);
   expect(outside.issues.map(i=>i.row.id)).toEqual(['E1']);
   const unknown=inspectLedger(withExtra('[仮判定]\nE9\tnormal\t理由\tp1'),source);
   expect(unknown.issues.map(i=>i.row.id)).toEqual(['E9']);
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
