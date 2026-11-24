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
以下の種別別属性・端点規則をすべての関係出力に優先適用する（全行必ず10列タブ区切り）。
種別 | 主体端点 | リソース | 実施状態 | 受領確認
before | 主体は常に -（イベント両端必須） | - | - | na
dependency | 別イベント・別主体の両端必須 | - | - | na
transfer/impact/mutual/common | イベントと割当済み主体の両端必須 | information/material/person/money/other、対象外は- | occurred/omitted/unknown | confirmed/unconfirmed/na
1. 同一主体レーン内の直列自動描画と before 原則: VTAでは同一主体レーン内のカード間は描画時に自動で下から上へ直列矢印が引かれる。したがって同一主体ID間（元主体ID === 先主体ID。共有イベントを含む場合や、組織内の別部署・複数乗務員を[主体]で同一主体IDにまとめた場合も同じ）では、強い前提・因果があっても dependency を絶対に使わず、両端主体を - とした before を使うこと（別主体間の前提関係なら異なる主体IDペアを指定する）。before に実施・受信の意味はなく、リソースと実施状態は -、受領確認は na とする。
2. dependency の異主体・属性固定: 後の作業が前の作業の成果物・完了・判断・状態を前提とすることが原文で裏付けられる別イベント・別主体間（元イベントID !== 先イベントID かつ 元主体ID !== 先主体ID）に限る。情報・指示等が関わる前提でもリソース列と実施状態列は必ず - とし、受領確認は na とする（情報・物・人員の授受そのものを表す場合は dependency ではなく transfer を使う）。
3. 同一イベント関係の10列厳守と受領確認: 同一イベント内の異なる主体間の伝達（transfer）・相互確認（mutual）・共通影響（common）・作用（impact）では、第3列（元イベント）と第5列（先イベント）の両方に同じイベントIDを必ず2回出力し、先イベントIDを省略して9列にしないこと。common は同一イベントの別主体に限り受領確認は na。confirmed は原文で受信・確認が裏付けられる場合のみ使い、送信のみ確認できる場合は unconfirmed、受領概念がなければ na とする。
4. 割当済み主体との一致: before 以外の元主体・先主体には、それぞれ元イベント・先イベントの「主体と役割」列に実際に割り当てた主体IDのみを指定し、元イベント側の受信者を別イベントの先主体に流用しない。複数主体イベントからの波及等で片側主体を1つに特定できない場合は両端主体を - とした before とし、関係自体が不確かな場合は推定で補わず同じIDの[整理] review へ原文参照と理由を残す。イベントや帰結は削除しない。
5. 一意IDの付与: 関係ID列（第1列）は各行で一意なID（R1, R2, R3...）を付与すること（例のIDを使い回さない）。
例（列間はタブ、必ず10列）：
R1\tbefore\tE1\t-\tE2\t-\tp1\t-\t-\tna
R2\tdependency\tE1\tA1\tE2\tA2\tp1,p2\t-\t-\tna
R3\ttransfer\tE3\tA1\tE3\tA2\tp3\tinformation\toccurred\tconfirmed
例のID・内容をコピーせず各行に一意なID（R1, R2...）および入力の実在IDを使う。`;
