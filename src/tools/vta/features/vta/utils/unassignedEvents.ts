import type {VTASchema,VTAParticipation} from '../../../types/vta';
import {validateSavedAnalysis,projectAnalysis} from './eventAnalysis';
import {repairGeneratedLaneSequence} from './generatedLaneSequence';
export function assignUnassignedEvent(schema:VTASchema,eventId:string,entityId:string|undefined,role:VTAParticipation['role']):VTASchema {
 if(!schema.analysis)throw Error('分析データがありません');
 const a=structuredClone(schema.analysis),event=a.events.find(e=>e.id===eventId);
 if(!event||a.cards.some(c=>c.eventIds.includes(eventId)))throw Error('未割当イベントを選んでください');
 if(!entityId){entityId='unresolved_'+crypto.randomUUID();a.entities.push({id:entityId,name:event.title+'の主体（未特定・'+event.id+'）',kind:'other',resolution:'unresolved'});}
 if(!a.entities.some(e=>e.id===entityId))throw Error('主体がありません');
 a.participations.push({eventId,entityId,role,factIds:[],origin:'manual',evidenceBasis:'user',sourceRefs:event.sourceRefs,reason:'利用者が割当を明示指定'});
 a.cards.push({id:'card_'+crypto.randomUUID(),laneEntityId:entityId,eventIds:[eventId]});
 a.unassignedEventIds=a.events.filter(e=>!a.cards.some(c=>c.eventIds.includes(e.id))).map(e=>e.id);
 const projected=projectAnalysis(validateSavedAnalysis(a),schema);
 return repairGeneratedLaneSequence(projected).schema;
}
export function confirmProvisionalEntity(schema:VTASchema,entityId:string,name:string):VTASchema {
 if(!schema.analysis||!name.trim()||schema.analysis.entities.some(e=>e.id!==entityId&&e.name===name.trim()))throw Error('一意な主体名を入力してください');
 const a=structuredClone(schema.analysis),entity=a.entities.find(e=>e.id===entityId&&e.resolution==='unresolved');
 if(!entity)throw Error('未特定の主体ではありません');
 if(entity.name===name.trim())throw Error('特定できた主体の名称へ変更してください');
 const oldName=entity.name;entity.name=name.trim();delete entity.resolution;
 return projectAnalysis(validateSavedAnalysis(a),{...schema,lanes:schema.lanes.map(lane=>lane===oldName?entity.name:lane)});
}
