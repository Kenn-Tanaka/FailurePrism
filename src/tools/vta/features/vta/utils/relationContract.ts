export const RELATION_CONTRACT_VERSION='relation-attributes-2';
import type { VTAEventRelation } from '../../../types/vta';
export class RelationContractError extends Error {
 readonly code='relation_attribute';
 constructor(public kind:string,public field:string,public actual:string,public expected:string){super(`[${kind}] ${field}: 受信=${actual.slice(0,60)}、許容=${expected}`);}
}
/** Endpoint meaning is shared by transport and saved-data validation. */
export function validateRelationEndpoints(r: Pick<VTAEventRelation,'kind'|'sourceEventId'|'targetEventId'|'sourceEntityId'|'targetEntityId'|'sourceEntityOrigin'|'targetEntityOrigin'>) {
 if(r.kind!=='before'&&(!r.sourceEntityId||!r.targetEntityId))throw new RelationContractError(r.kind,!r.sourceEntityId?'元主体':'先主体','-','イベントに割当済みの主体ID');
 const srcEnt=r.sourceEntityOrigin??r.sourceEntityId;
 const tgtEnt=r.targetEntityOrigin??r.targetEntityId;
 if(r.kind==='dependency'&&(r.sourceEventId===r.targetEventId||srcEnt===tgtEnt))throw new RelationContractError(r.kind,'依存端点',`${r.sourceEventId}/${r.sourceEntityId} → ${r.targetEventId}/${r.targetEntityId}`,'別イベント・別主体');
 if(r.kind==='before'&&r.sourceEventId===r.targetEventId)throw new RelationContractError(r.kind,'イベント端点',r.sourceEventId,'異なるイベントID');
}
/** Historical optional attributes remain optional when loading existing projects. */
export function validateStoredRelationAttributes(r: VTAEventRelation) {
 validateRelationEndpoints(r);
 if(r.kind==='dependency')return relationAttributes(r.kind,r.resource||'-',r.status??'-',r.receipt??'');
 if(r.resource!==undefined&&!['information','material','person','money','other','-'].includes(r.resource))throw new RelationContractError(r.kind,'リソース',r.resource,'information/material/person/money/other/-');
 if(r.status!==undefined&&!['occurred','omitted','unknown'].includes(r.status))throw new RelationContractError(r.kind,'実施状態',r.status,'occurred/omitted/unknown');
 if(r.receipt!==undefined&&!['confirmed','unconfirmed','na'].includes(r.receipt))throw new RelationContractError(r.kind,'受領確認',r.receipt,'confirmed/unconfirmed/na');
}
export function relationAttributes(kind:string,resource:string,status:string,receipt:string){
 const requireValue=(field:string,value:string,allowed:string[])=>{if(!allowed.includes(value))throw new RelationContractError(kind,field,value,allowed.join('/'));};
 requireValue('関係種別',kind,['before','dependency','transfer','impact','mutual','common']);
 requireValue('リソース',resource,['-','information','material','person','money','other']);
 if(kind==='dependency'){requireValue('リソース',resource,['-']);requireValue('実施状態',status,['-']);requireValue('受領確認',receipt,['na']);}
 else if(kind==='before'){
  requireValue('実施状態',status,['-','occurred','omitted','unknown']);
  requireValue('受領確認',receipt,['-','na','confirmed','unconfirmed']);
 }else{requireValue('実施状態',status,['occurred','omitted','unknown']);requireValue('受領確認',receipt,['confirmed','unconfirmed','na']);}
 return {resource:resource==='-'?undefined:resource,status:status==='-'?undefined:status as 'occurred'|'omitted'|'unknown',receipt:(receipt==='-'?'na':receipt) as 'confirmed'|'unconfirmed'|'na'};
}
export const RELATION_CONTRACT_PROMPT=`【関係属性契約 ${RELATION_CONTRACT_VERSION}】
以下の種別別属性指定を一般的な空欄・実施状態の説明より優先する。
種別 | 主体端点 | リソース | 実施状態 | 受領確認
before | 主体は省略可、イベント両端必須 | - | - | na
dependency | 別イベント・別主体の両端必須 | - | - | na
transfer/impact/mutual/common | イベントと割当済み主体の両端必須 | information/material/person/money/other、対象外は- | occurred/omitted/unknown | confirmed/unconfirmed/na
beforeは時間順だけで実施や受信を表さない。実施状態の3値はbeforeとdependencyには要求しない。dependencyのリソース列と実施状態列は情報・指示等が関わる前提であってもinformationやoccurred等を書かず必ず - とし、受領確認は対象外を示すnaとする（情報や物の授受そのものを表す場合はdependencyではなくtransferを使う）。confirmedは原文で受信・確認を裏付けられる場合だけ使う。commonは同一イベントの別主体に限り、受領確認はna。transferは実際のリソース区分を指定する。impact/mutualで受領概念がなければna。主体不明の関係は推定で補わず同じIDの整理reviewへ原文参照と理由を残す。イベントや帰結は削除しない。
- 関係ID列（第1列）は各行で一意なID（R1, R2, R3...）を付与すること（例のR1やR2をそのまま全行で使い回さないこと）。
例（列間はタブ）：
R1\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\tna
R2\tdependency\tE1\tA1\tE2\tA2\tp1,p2\t-\t-\tna
例のID・内容をコピーせず各行に一意なID（R1, R2...）および入力の実在IDを使う。`;
