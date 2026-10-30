import {afterEach,it,expect,vi} from 'vitest';
import {callLLMGateway,extractEventDraft} from './client';
import {debugRecorder} from '../debugRecorder';
import {ledgerFixture,ledgerSource} from '../../features/vta/utils/eventLedger.fixture';
import {useVTAStore} from '../../features/vta/store/vtaStore';
const config={baseUrl:'/v1',selectedModel:'mock',gatewayToken:'gateway-private-token'};
afterEach(()=>{debugRecorder.setEnabled(false);debugRecorder.clear();vi.unstubAllGlobals();});
const response=(content:string)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
it('captures request, response, validated ledger and projected graph for diagnosis without auth credentials',async()=>{
 debugRecorder.setEnabled(true);useVTAStore.getState().createNewProjectId();
 vi.stubGlobal('fetch',vi.fn(async()=>response(ledgerFixture().replace('[共有カード]','R1\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\tna\n[共有カード]'))));
 await extractEventDraft(config,ledgerSource);
 const exported=debugRecorder.exportText(),stages=JSON.parse(exported).entries.map((e:{stage:string})=>e.stage);
 for(const stage of ['llm.request','llm.response','ledger.validation','graph.projection'])expect(stages).toContain(stage);
 expect(exported).toContain('09:00');expect(exported).toContain('sourceEventId');
 expect(exported).not.toContain(config.gatewayToken);expect(exported).not.toContain('Authorization');
});
it('does not retain a response arriving after the user turns recording OFF',async()=>{
 debugRecorder.setEnabled(true);
 let resolve!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));
 const pending=callLLMGateway(config,[{role:'user',content:'test'}]);
 debugRecorder.setEnabled(false);const count=debugRecorder.getSnapshot().count;
 resolve(response('late response'));await pending;
 expect(debugRecorder.getSnapshot().count).toBe(count);expect(debugRecorder.exportText()).not.toContain('late response');
});
