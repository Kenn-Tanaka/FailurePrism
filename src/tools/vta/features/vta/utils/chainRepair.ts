import {relationAttributes} from './relationContract';
import { repairGeneratedLaneSequence } from './generatedLaneSequence';
import { annotateNodeTopologyRules } from './nodeTopologyRules';
import type { VTASchema,VTASourceRef,VTAEventRelation } from '../../../types/vta';
import { validateSavedAnalysis,projectAnalysis } from './eventAnalysis';
import { dependencyProblem,isPrecedence,dependencyKey } from './eventOrder';
import { SubjectPoset } from './subjectPoset';
export const DELTA_COLUMNS={'追加主体':5,'追加イベント':7,'割当追加':6,'関係追加':12,'要確認':5} as const;
export type ChainRow={section:keyof typeof DELTA_COLUMNS;id:string;cells:string[];generation?:import('../../../types/vta').GenerationProvenance};
export type ChainIssue={section?:keyof typeof DELTA_COLUMNS;id?:string;raw:string;reason:string};

const TERMINAL_SECTIONS = new Set<keyof typeof DELTA_COLUMNS>(['割当追加', '関係追加', '要確認']);

/**
 * Normalizes a `[関係追加]` ID so it starts with `tmp_`, contains only safe ID chars,
 * and never collides with `usedIds`.
 */
function normalizeRelationId(rawId: string, usedIds: ReadonlySet<string>): string {
  const clean = rawId === '-' ? 'rel' : (rawId.replace(/[^A-Za-z0-9_-]/g, '') || 'rel');
  const base = clean === 'tmp_' ? 'tmp_rel' : (/^tmp_[A-Za-z0-9_-]+$/.test(clean) ? clean : `tmp_${clean}`);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  return candidate;
}

/**
 * Normalizes IDs for terminal delta sections (`関係追加`, `割当追加`, `要確認`) that are
 * never referenced by other rows, disambiguating intra-section collisions with suffixes.
 */
function normalizeTerminalRowId(
  section: keyof typeof DELTA_COLUMNS,
  rawId: string,
  usedInSection: ReadonlySet<string>
): string {
  if (section === '関係追加') {
    return normalizeRelationId(rawId, usedInSection);
  }
  const base = rawId === '-' ? (section === '割当追加' ? 'assign' : 'review') : rawId;
  let candidate = base;
  let suffix = 2;
  while (usedInSection.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  return candidate;
}

function parseChainDeltaCore(text: string, strict: boolean): { rows: ChainRow[]; issues: ChainIssue[]; complete: boolean } {
  let section: keyof typeof DELTA_COLUMNS | undefined;
  let done = false;
  const rows: ChainRow[] = [];
  const issues: ChainIssue[] = [];
  const sections = new Set<string>();
  const usedBySection = new Map<keyof typeof DELTA_COLUMNS, Set<string>>();

  const fail = (issue: ChainIssue, strictMsg = issue.reason) => {
    if (strict) throw Error(strictMsg);
    issues.push(issue);
  };

  for (const raw of text.trim().replace(/^```[^\n]*\n|\n```$/g, '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (done) {
      fail({ raw, reason: '完了後にデータがあります' });
      continue;
    }
    if (raw.trim() === '[完了]') {
      done = true;
      continue;
    }
    const match = /^\[(.+)\]$/.exec(raw.trim());
    if (match) {
      if (!Object.hasOwn(DELTA_COLUMNS, match[1]) || sections.has(match[1])) {
        fail({ raw, reason: '未知または重複セクション' });
        section = undefined;
      } else {
        section = match[1] as keyof typeof DELTA_COLUMNS;
        sections.add(section);
      }
      continue;
    }
    const cells = raw.split('\t').map((x) => x.trim());
    if (section && cells[0] === 'ID') continue;
    if (!section) {
      fail({ raw, reason: '列数・空欄・ID重複・セクションを確認してください' }, 'セクションがありません');
      continue;
    }
    if (cells.length !== DELTA_COLUMNS[section] || cells.some((x) => !x)) {
      fail({ section, id: cells[0], raw, reason: '列数・空欄・ID重複・セクションを確認してください' }, '列数・空欄・ID重複を確認してください');
      continue;
    }
    let usedIds = usedBySection.get(section);
    if (!usedIds) {
      usedIds = new Set<string>();
      usedBySection.set(section, usedIds);
    }
    let rowId = cells[0];
    if (TERMINAL_SECTIONS.has(section)) {
      rowId = normalizeTerminalRowId(section, rowId, usedIds);
      cells[0] = rowId;
    } else if (usedIds.has(rowId)) {
      fail({ section, id: rowId, raw, reason: '列数・空欄・ID重複・セクションを確認してください' }, '列数・空欄・ID重複を確認してください');
      continue;
    }
    usedIds.add(rowId);
    rows.push({ section, id: rowId, cells });
  }

  const complete = done && sections.size === 5 && !issues.some((i) => !i.section);
  if (!done || sections.size !== 5) {
    fail({ raw: '', reason: '全5セクションと[完了]が必要です' });
  }
  return { rows, issues, complete };
}

export function selectChainDependencies(rows:ChainRow[],selected:string[]):string[]{
 const chosen=new Set(selected);let changed=true;
 while(changed){changed=false;for(const r of rows.filter(x=>chosen.has(x.section+'/'+x.id))){
  const add=(row:ChainRow|undefined)=>{if(row&&!chosen.has(row.section+'/'+row.id)){chosen.add(row.section+'/'+row.id);changed=true;}};
  const object=(id:string)=>rows.find(x=>x.id===id&&(x.section==='追加主体'||x.section==='追加イベント'));
  if(r.section==='割当追加'){add(object(r.cells[1]));add(object(r.cells[2]));}
  if(r.section==='関係追加')for(const [event,entity] of [[r.cells[2],r.cells[3]],[r.cells[4],r.cells[5]]]){
   add(object(event));add(object(entity));add(rows.find(x=>x.section==='割当追加'&&x.cells[1]===event&&x.cells[2]===entity));
  }
  if(r.section==='要確認'){
   const rawTargets=r.cells[1]==='-'?[]:r.cells[1].split(',').map((s)=>s.trim()).filter(Boolean);
   for(const t of rawTargets){
    add(rows.find(x=>x.section!=='要確認'&&(x.id===t||x.id===`tmp_${t}`)));
   }
  }
 }}return [...chosen];
}
export function inspectChainDelta(text:string):{rows:ChainRow[];issues:ChainIssue[];complete:boolean}{
 return parseChainDeltaCore(text, false);
}
export function validateChainRows(schema:VTASchema,rows:ChainRow[]){
 const accepted:ChainRow[]=[],issues:ChainIssue[]=[];
 const usedIds = new Set<string>(
   schema.analysis
     ? [...schema.analysis.events, ...schema.analysis.entities, ...schema.analysis.relations].flatMap((x) => (x.id ? [x.id] : []))
     : []
 );
 for(const section of Object.keys(DELTA_COLUMNS) as Array<keyof typeof DELTA_COLUMNS>)for(const row of rows.filter(r=>r.section===section)){
  const candidateRow: ChainRow = section === '関係追加' && schema.analysis
    ? (() => {
        const nextId = normalizeRelationId(row.id, usedIds);
        return nextId === row.id && row.cells[0] === nextId
          ? row
          : { ...row, id: nextId, cells: [nextId, ...row.cells.slice(1)] };
      })()
    : row;
  try{
   applyChainDelta(schema,[...accepted,candidateRow]);
   usedIds.add(candidateRow.id);
   accepted.push(candidateRow);
  }catch(e){
   issues.push({section:candidateRow.section,id:candidateRow.id,raw:candidateRow.cells.join('\t'),reason:e instanceof Error?e.message:String(e)});
  }
 }
 return {rows:accepted,issues};
}
export function parseChainDelta(text:string):ChainRow[]{
 return parseChainDeltaCore(text, true).rows;
}
/** Stable temporary IDs in preview; persistent IDs allocated only at adoption. */
export function applyChainDelta(schema:VTASchema,rows:ChainRow[],permanent=false):VTASchema{
 if(!schema.analysis)throw Error('分析データがありません');const a=structuredClone(schema.analysis),known=new Set([...a.events,...a.entities,...a.relations].flatMap(x=>x.id?[x.id]:[]));
 const ids=new Map<string,string>();for(const r of rows.filter(r=>['追加主体','追加イベント'].includes(r.section))){if(!/^tmp_[A-Za-z0-9_-]+$/.test(r.id)||known.has(r.id)||ids.has(r.id))throw Error('新規IDは一意なtmp_から始めてください');ids.set(r.id,permanent?'added_'+crypto.randomUUID():r.id);}
 const usedRelationIds = new Set<string>([...known, ...ids.keys(), ...ids.values()]);
 const relationIdByRow = new Map<ChainRow, string>();
 for (const r of rows.filter((r) => r.section === '関係追加')) {
  const previewId = normalizeRelationId(r.id, usedRelationIds);
  usedRelationIds.add(previewId);
  relationIdByRow.set(r, permanent ? 'added_' + crypto.randomUUID() : previewId);
 }
 const id=(v:string)=>ids.get(v)??v, list=(v:string)=>v==='-'?[]:v.split(',').map((s)=>s.trim()).filter(Boolean);
 const refs=(v:string):VTASourceRef[]=>{const result=list(v).map(x=>{const parts=x.split('/');if(parts.length!==2||!a.sources.some(s=>s.id===parts[0]&&s.paragraphs.some(p=>p.id===parts[1])))throw Error('原文参照が不正です');return {sourceId:parts[0],paragraphId:parts[1]};});if(!result.length)throw Error('根拠が必要です');return result;};
 for(const r of rows.filter(r=>r.section==='追加主体')){const [,name,kind,evidence]=r.cells;refs(evidence);if(!['person','organization','machine','other'].includes(kind)||a.entities.some(e=>e.name===name))throw Error('主体の種類または既存主体との同一性を確認してください');a.entities.push({id:id(r.id),name,kind:kind as 'person'});}
 for(const r of rows.filter(r=>r.section==='追加イベント')){const [,time,title,description,evidence,kind]=r.cells;if(!['recorded','claim','assessment'].includes(kind))throw Error('記録区分が不正です');a.events.push({id:id(r.id),time:time==='-'?'':time,title,description,sourceRefs:refs(evidence),recordKind:kind as 'recorded',factIds:[],classification:'unclassified',sourceOrder:a.events.length,origin:'extraction'});}
 for(const r of rows.filter(r=>r.section==='割当追加')){const [,event,entity,role,evidence,inference]=r.cells;if(!['inferred','-'].includes(inference))throw Error('主体の推定表示はinferredまたは-です');refs(evidence);if(a.participations.some(p=>p.eventId===id(event)&&p.entityId===id(entity)))throw Error('既存の割当です');a.participations.push({eventId:id(event),entityId:id(entity),role:role as 'actor',factIds:[],...(inference==='inferred'?{inferred:true}:{}),generation:r.generation});a.cards.push({id:permanent?'card_'+crypto.randomUUID():'preview_'+r.id,laneEntityId:id(entity),eventIds:[id(event)]});}
 const poset=a.subjectPoset?SubjectPoset.fromData(a.subjectPoset):SubjectPoset.fromEntities(a.entities);
 const resolveEntityEndpoint=(eventId:string,rawEntity:string,isBefore:boolean):string|undefined=>{
  if(!rawEntity||rawEntity==='-')return undefined;
  const target=id(rawEntity);
  if(a.participations.some((p)=>p.eventId===eventId&&p.entityId===target))return target;
  const mergedMatch=a.participations.find((p)=>p.eventId===eventId&&p.mergedFrom?.some((m)=>m.entityId===target));
  if(mergedMatch)return mergedMatch.entityId;
  const posetMatch=a.participations.find((p)=>p.eventId===eventId&&(poset.isAncestor(p.entityId,target)||poset.isDescendant(p.entityId,target)));
  if(posetMatch)return posetMatch.entityId;
  if(isBefore)return undefined;
  const eventParts=a.participations.filter((p)=>p.eventId===eventId);
  if(eventParts.length===1)return eventParts[0].entityId;
  return target;
 };
 const added:VTAEventRelation[]=[];
 for(const r of rows.filter(r=>r.section==='関係追加')){const [,kind,from,fromEntity,to,toEntity,evidence,resource,status,receipt,basis,reason]=r.cells;if(!['before','dependency','transfer','impact','mutual','common'].includes(kind)||!['recorded','source-assessment','source-context'].includes(basis))throw Error('関係種別または根拠区分が不正です');
  const attributes=relationAttributes(kind,resource,status,receipt);
  const resolvedFrom=resolveEntityEndpoint(id(from),fromEntity,kind==='before');
  const resolvedTo=resolveEntityEndpoint(id(to),toEntity,kind==='before');
  let relId=relationIdByRow.get(r)??id(r.id);
  if(a.relations.some(x=>x.id===relId)){
   let suffix=2;
   while(a.relations.some(x=>x.id===`${relId}_${suffix}`))suffix++;
   relId=`${relId}_${suffix}`;
  }
  const rel:VTAEventRelation={id:relId,generation:r.generation,kind:kind as 'before',sourceEventId:id(from),targetEventId:id(to),sourceEntityId:resolvedFrom,targetEntityId:resolvedTo,sourceRefs:refs(evidence),factIds:[],explanation:reason,evidenceBasis:basis as 'recorded',proposalId:r.id,proposalReason:reason,adoptionReason:reason,provenance:'llm-proposal',...attributes};
  if(kind!=='before'&&(!rel.sourceEntityId||!rel.targetEntityId))throw Error('主体端点が必要です');
  if(a.relations.some(x=>x.kind===rel.kind&&x.sourceEventId===rel.sourceEventId&&x.targetEventId===rel.targetEventId&&x.sourceEntityId===rel.sourceEntityId&&x.targetEntityId===rel.targetEntityId))throw Error('既存関係と重複しています');
  if(rel.kind==='common'&&rel.sourceEventId!==rel.targetEventId)throw Error('共通影響は同一イベントを指定してください');
  if(rel.kind==='dependency'&&schema.presentation?.omittedDependencies?.includes(dependencyKey(rel)))throw Error('削除済みの作業依存です');a.relations.push(rel);added.push(rel);
 }
 for(const rel of added){if(rel.kind==='dependency'&&rel.sourceEntityId&&rel.sourceEntityId===rel.targetEntityId)throw Error('同一統合レーン内のイベント間には作業依存ではなく before を使用してください');const problem=dependencyProblem(a,rel,a.relations);if(problem)throw Error(problem);if(isPrecedence(rel)){const q=[rel.targetEventId],seen=new Set<string>();while(q.length){const n=q.pop()!;if(n===rel.sourceEventId)throw Error('追加関係で時間循環が発生します');if(seen.has(n))continue;seen.add(n);q.push(...a.relations.filter(x=>x!==rel&&isPrecedence(x)&&x.sourceEventId===n).map(x=>x.targetEventId));}}}
 const validReviewTargetIds = new Set<string>([
  ...a.events.map((e) => e.id),
  ...a.entities.map((e) => e.id),
  ...(a.subjectRanking?.originalEntities.map((e) => e.id) ?? []),
  ...(a.subjectPoset?.nodes ?? []),
  ...a.relations.flatMap((rel) => (rel.id ? [rel.id] : [])),
  ...a.cards.map((c) => c.id),
  ...(a.dispositions?.map((d) => d.id) ?? []),
  ...schema.edges.flatMap((edge) => (edge.id ? [edge.id] : [])),
  ...rows.filter((r) => r.section !== '要確認').map((r) => r.id),
 ]);
 const validParagraphTargetIds = new Set<string>(
  a.sources.flatMap((s) => s.paragraphs.flatMap((p) => [p.id, `${s.id}/${p.id}`]))
 );
 for(const r of rows.filter(r=>r.section==='要確認')){
  const [,targets,evidence,code,reason]=r.cells;
  const sourceRefs=refs(evidence);
  const targetList=list(targets);
  const isUnrefParaReview = code.trim().toLowerCase() === 'unreferenced_paragraph';
  const hasValidTargets = isUnrefParaReview
   ? targetList.every((t) => validReviewTargetIds.has(id(t)) || validReviewTargetIds.has(`tmp_${t}`) || validParagraphTargetIds.has(t))
   : targetList.length > 0 && targetList.every((t) => validReviewTargetIds.has(id(t)) || validReviewTargetIds.has(`tmp_${t}`));
  if(!hasValidTargets)throw Error('要確認の対象がありません');
  const targetLabels=targetList.map((t)=>{
   const resolved=id(t);
   const ev=a.events.find((e)=>e.id===resolved);
   if(ev)return ev.title?`${resolved}（${ev.title}）`:resolved;
   const ent=a.entities.find((e)=>e.id===resolved)??a.subjectRanking?.originalEntities.find((e)=>e.id===resolved);
   if(ent)return ent.name?`${resolved}（${ent.name}）`:resolved;
   return resolved;
  });
  const codePrefix=code&&code!=='-'&&code.trim().toLowerCase()!=='review'?`[${code.trim()}] `:'';
  const summaryBody = targetLabels.length > 0
   ? `対象: ${targetLabels.join(', ')}`
   : `対象段落: ${sourceRefs.map((ref) => `${ref.sourceId}/${ref.paragraphId}`).join(', ')}`;
  const summaryText=`${codePrefix}${summaryBody}`;
  a.dispositions=[...(a.dispositions??[]),{id:permanent?'review_'+crypto.randomUUID():'review_'+r.id,kind:'review',sourceRefs,...sourceRefs[0],quote:'',text:summaryText,reason}];
 }
 if(permanent){const runs=new Map((a.generationRuns??[]).map(r=>[r.runId,r]));for(const row of rows)if(row.generation)runs.set(row.generation.runId,row.generation);a.generationRuns=[...runs.values()];}
 a.unassignedEventIds=a.events.filter(e=>!e.ignored&&!a.cards.some(c=>c.eventIds.includes(e.id))).map(e=>e.id);
 const originalRelationIds = new Set(schema.analysis.relations.map((r) => r.id));
 const participatesInEvent = (eventId: string, entityId: string | undefined): boolean => {
  if (!entityId || entityId === '-') return true;
  return a.participations.some((p) =>
   p.eventId === eventId && (
    p.entityId === entityId ||
    p.mergedFrom?.some((m) => m.entityId === entityId) ||
    poset.isAncestor(p.entityId, entityId) ||
    poset.isDescendant(p.entityId, entityId)
   )
  );
 };
 a.relations = a.relations.filter((rel) => {
  if (!originalRelationIds.has(rel.id)) return true;
  if (rel.kind === 'before') {
   if (rel.sourceEntityId && !participatesInEvent(rel.sourceEventId, rel.sourceEntityId)) {
    delete rel.sourceEntityId;
   }
   if (rel.targetEntityId && !participatesInEvent(rel.targetEventId, rel.targetEntityId)) {
    delete rel.targetEntityId;
   }
   return true;
  }
  if (rel.sourceEntityId && !participatesInEvent(rel.sourceEventId, rel.sourceEntityId)) {
   rel.sourceEntityId = resolveEntityEndpoint(rel.sourceEventId, rel.sourceEntityId, false);
  }
  if (rel.targetEntityId && !participatesInEvent(rel.targetEventId, rel.targetEntityId)) {
   rel.targetEntityId = resolveEntityEndpoint(rel.targetEventId, rel.targetEntityId, false);
  }
  return participatesInEvent(rel.sourceEventId, rel.sourceEntityId) &&
         participatesInEvent(rel.targetEventId, rel.targetEntityId);
 });
 const checked=validateSavedAnalysis(a);const projected=projectAnalysis(checked,schema,{silentDebug:!permanent});const repaired=repairGeneratedLaneSequence(projected,{preservePositions:true}).schema;return annotateNodeTopologyRules({...repaired,analysis:checked});
}
