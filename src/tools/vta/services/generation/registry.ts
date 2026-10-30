import type { GenerationProvenance, VTAAnalysisData, VTASource } from '../../types/vta';
import { CONNECTION_RULE_VERSION } from '../../features/vta/utils/eventOrder';
export interface GenerationRequest {
  source: VTASource; model: string; prompt: string; projectId: string;
  signal?: AbortSignal;
}
export interface GenerationScheme {
  id: string; version: string; name: string; analysisVersion: 5;
  supportsPassage: boolean;
  generate(request: GenerationRequest): Promise<VTAAnalysisData>;
}
const latestRuns=new Map<string,string>();
export function fingerprint(text: string): string {
  let h=2166136261; for(let i=0;i<text.length;i++) h=Math.imul(h^text.charCodeAt(i),16777619);
  return (h>>>0).toString(16);
}
/** Static registration, injected execution. No UI/store dependencies. */
export function generationRegistry(schemes:GenerationScheme[]) {
  const entries=new Map(schemes.map(s=>[s.id,s]));
  if(entries.size!==schemes.length) throw new Error('生成方式IDが重複しています。');
  return {
    async run(id:string,request:GenerationRequest,validate:(a:VTAAnalysisData)=>VTAAnalysisData) {
      if(request.signal?.aborted) throw new Error('USER_CANCELLED');
      const scheme=entries.get(id); if(!scheme) throw new Error('この生成方式は搭載されていません。');
      const snapshot=structuredClone({...request,signal:undefined});
      const runId=crypto.randomUUID();
      latestRuns.set(request.projectId,runId);
      const analysis=await scheme.generate({...snapshot,signal:request.signal});
      if(request.signal?.aborted) throw new Error('USER_CANCELLED');
      if(latestRuns.get(request.projectId)!==runId) throw new Error('新しい生成が開始されたため古い応答を破棄しました。');
      const checked=validate(analysis);
      const generation:GenerationProvenance={runId,schemeId:id,schemeVersion:scheme.version,ruleVersion:CONNECTION_RULE_VERSION,model:snapshot.model,promptFingerprint:fingerprint(snapshot.prompt),inputFingerprint:fingerprint(snapshot.source.text)};
      return {...checked,generation,generationRuns:[...(checked.generationRuns??[]),generation]};
    },
  };
}
