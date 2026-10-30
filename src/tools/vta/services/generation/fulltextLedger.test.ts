import { describe, expect, it, vi } from 'vitest';
import { normalizeSource } from './fulltextLedger';
import { DEFAULT_PROMPT_CONFIG } from '../llm/prompts';
import { sourceFromText } from '../../features/vta/utils/eventAnalysis';
import { ledgerFixture, ledgerSource } from '../../features/vta/utils/eventLedger.fixture';

const config={baseUrl:'/v1',gatewayToken:'',selectedModel:'mock'};
const source=sourceFromText(ledgerSource);
const run=(call:Parameters<typeof normalizeSource>[6],log=vi.fn())=>normalizeSource(config,source,undefined,'',DEFAULT_PROMPT_CONFIG,crypto.randomUUID(),call,log);
const withRows=(rows:string)=>ledgerFixture().replace('[共有カード]',rows+'\n[共有カード]');
describe('bounded ledger repair',()=>{
 it('does not call the LLM again just to replace before N/A notation',async()=>{
  const call=vi.fn<Parameters<typeof normalizeSource>[6]>(async()=>withRows('R1\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\t-'));
  const log=vi.fn();const result=await run(call,log);
  expect(call).toHaveBeenCalledTimes(1);
  expect(result.relations[0]).toMatchObject({status:undefined,receipt:'na'});
  expect(log.mock.calls.some(c=>c[0]==='warn'&&c[1].includes('[台帳修復]'))).toBe(false);
 });
 it('repairs only the bad dependency while retaining normal before rows and outcome',async()=>{
  const normal='R1\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\tna';
  const initial=withRows(normal+'\nR2\tdependency\tE1\tA2\tE2\tA2\tp1\t-\t-\tna').replace('[完了]','[帰結]\nO1\tidentified\tE2\tp2\t停止による機能喪失\n[完了]');
  const replies=[initial,'[関係]\nR2\tdependency\tE1\tA1\tE2\tA2\tp1,p2\t-\t-\tna\n[完了]'];
  const call=vi.fn<Parameters<typeof normalizeSource>[6]>(async()=>replies.shift()!);
  const result=await run(call);
  expect(call).toHaveBeenCalledTimes(2);
  const repairInput=String(call.mock.calls[1][2]);
  expect(repairInput).toContain('関係/R2');expect(repairInput).not.toContain(normal);
  expect(result.outcome?.eventIds).toEqual(['E2']);expect(result.relations.map(r=>r.id)).toEqual(['R1','R2']);
 });
 it('stops oscillating attribute repairs rather than adding more retry calls',async()=>{
  const row=(status:string)=>`R1\tdependency\tE1\tA1\tE2\tA2\tp1\t-\t${status}\tna`;
  const replies=[withRows(row('occurred')),'[関係]\n'+row('unknown')+'\n[完了]','[関係]\n'+row('occurred')+'\n[完了]'];
  const call=vi.fn<Parameters<typeof normalizeSource>[6]>(async()=>replies.shift()!);
  await expect(run(call)).rejects.toThrow('修復内容が変わらない');expect(call).toHaveBeenCalledTimes(3);
 });
});
