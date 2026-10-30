import { it,expect } from 'vitest';
import { generationRegistry,type GenerationScheme } from './registry';
import { inspectLedger,parseLedger } from '../../features/vta/utils/eventLedger';
import { ledgerFixture,ledgerSource } from '../../features/vta/utils/eventLedger.fixture';
import { sourceFromText,validateSavedAnalysis,projectAnalysis } from '../../features/vta/utils/eventAnalysis';
const source=sourceFromText(ledgerSource);
const data=()=>inspectLedger(parseLedger(ledgerFixture()),source).analysis!;
const request={source,model:'test',prompt:'test',projectId:'registry-test'};
it('registers a second test scheme through shared validation, projection and saved provenance',async()=>{
 const scheme:GenerationScheme={id:'test-other',version:'1',name:'test',analysisVersion:5,supportsPassage:false,generate:async()=>data()};
 const result=await generationRegistry([scheme]).run(scheme.id,request,validateSavedAnalysis);
 expect(projectAnalysis(result).analysis?.events).toHaveLength(2);
 expect(validateSavedAnalysis(JSON.parse(JSON.stringify(result))).generation?.schemeId).toBe('test-other');
 expect(validateSavedAnalysis(data()).generation).toBeUndefined();
});
it('discards cancelled and superseded results before adopting them',async()=>{
 let finish!:(value:ReturnType<typeof data>)=>void;
 const scheme:GenerationScheme={id:'test',version:'1',name:'test',analysisVersion:5,supportsPassage:false,generate:()=>new Promise(resolve=>{finish=resolve;})};
 const registry=generationRegistry([scheme]); const first=registry.run('test',request,validateSavedAnalysis); const oldFinish=finish;
 const second=registry.run('test',request,validateSavedAnalysis); finish(data());await second;oldFinish(data());
 await expect(first).rejects.toThrow('古い応答');
 const controller=new AbortController();const pending=registry.run('test',{...request,signal:controller.signal},validateSavedAnalysis);controller.abort();finish(data());
 await expect(pending).rejects.toThrow('USER_CANCELLED');
});
