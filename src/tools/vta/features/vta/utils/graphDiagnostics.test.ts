import { expect,it } from 'vitest';
import type { VTASchema } from '../../../types/vta';
import { graphDiagnostics } from './graphDiagnostics';
const schema:VTASchema={lanes:['A','B','C','D'],nodes:['A','B','C','D'].map(id=>({id,lane:id,title:id,description:'',time:'',type:'normal',measure_type:null})),edges:[{source:'A',target:'B'},{source:'C',target:'D'}]};
it('detects two islands even when every lane has a connection',()=>{
 const d=graphDiagnostics(schema);expect(d.canonical).toHaveLength(2);expect(d.complete).toBe(false);
});
it('does not certify an empty graph or an unset analysis target',()=>{
 expect(graphDiagnostics({lanes:[],nodes:[],edges:[]}).complete).toBe(false);
 expect(graphDiagnostics({...schema,edges:[...schema.edges,{source:'B',target:'C'}]}).targetUnset).toBe(true);
});
