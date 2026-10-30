import {SAMPLE_SCENARIOS} from '../data/sampleData';
import {sourceFromText,projectAnalysis} from './eventAnalysis';
import {parseLedger,inspectLedger} from './eventLedger';
/** Minimal reconstruction of the reported 2026-10-29 debug trace, without transport metadata. */
export function wiringUnassignedFixture(){
 const source=sourceFromText(SAMPLE_SCENARIOS[0].scenarioText);
 const rows=[
  ['E1','-','設計変更','設計変更を実施','A1:actor','p1','recorded'],
  ['E2','-','連絡失念','設計変更内容の連絡を失念','A1:actor,A2:intended_recipient','p2','recorded'],
  ['E3','-','改訂未実施','作業手順書を改訂しなかった','A1:actor','p3','recorded'],
  ['E4','-','試験手順書作成','旧仕様で試験手順書を作成','A2:actor','p4','recorded'],
  ['E5','試験当日','結線作業の実施','旧作業手順書に従って結線作業を実施','A3:actor','p5','recorded'],
  ['E6','-','試験前確認','不整合に気付かず確認を完了','A2:actor','p6','recorded'],
  ['E7','-','通電試験での過電圧印加','通電試験時に過電圧が印加された','-','p7','recorded'],
  ['E8','-','搭載機器の破損事故','搭載機器が破損した','-','p7','recorded'],
 ];
 const text='[主体]\nA1\tサブシステム部門\torganization\nA2\tシステム部門\torganization\nA3\t作業員\tperson\n[イベント]\n'+rows.map(r=>r.join('\t')).join('\n')+'\n[関係]\nR1\tbefore\tE6\t-\tE7\t-\tp6,p7\t-\t-\tna\nR2\tbefore\tE7\t-\tE8\t-\tp7\t-\t-\tna\n[共有カード]\n[整理]\n[帰結]\nO1\tidentified\tE8\tp7\t機器破損が物的損失\n[完了]';
 const result=inspectLedger(parseLedger(text),source);if(!result.analysis)throw Error('Invalid fixture');
 return projectAnalysis(result.analysis);
}
