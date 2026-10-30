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
});
