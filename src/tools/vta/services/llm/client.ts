import {proposalContext} from '../generation/proposalContext';
import {CONTEXT_EVIDENCE_POLICY,SUBJECT_INFERENCE_POLICY} from './contextEvidencePolicy';
import {RELATION_CONTRACT_PROMPT} from '../../features/vta/utils/relationContract';
import {debugRecorder} from '../debugRecorder';
import { normalizeSource } from '../generation/fulltextLedger';
import { generationRegistry, fingerprint } from '../generation/registry';
import { dependencyCandidates, dependencyProblem, cardVisible } from '../../features/vta/utils/eventOrder';
import { validateSavedAnalysis } from '../../features/vta/utils/eventAnalysis';
import { LLMConfig, VTASchema, RegenerationResult, MeasuresProposalResult, VTAAnalysisData } from '../../types/vta';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { validateAndSanitizeVTASchema } from '../../features/vta/utils/schemaValidator';
import { repairGeneratedLaneSequence } from '../../features/vta/utils/generatedLaneSequence';
import { projectAnalysis, sourceFromText } from '../../features/vta/utils/eventAnalysis';
import { parseLedger, applyLedgerRepair, classificationInput, inspectClassifications, type LedgerDocument } from '../../features/vta/utils/eventLedger';
import { EVENT_PIPELINE_PROMPTS, SUBJECT_LANE_POLICY, SUBJECT_FOCUS_POLICY, OUTCOME_EXTRACTION_POLICY, AUDIT_SECTIONS_POLICY } from './eventPrompts';
import { FACTUALITY_POLICY } from './factualityPolicy';
import { sanitizeForPrompt } from './promptSanitizer';
import { scanGeneratedText } from '../../features/vta/utils/subjectiveExpressions';
import { refineGranularity } from '../generation/granularityRefinement';
import { formatNormalizationAuditMarkdown } from '../../components/control-panel/NormalizationAuditPanel';
import { consolidateSubjects, clampSubjectLimit, OTHER_ACTORS_ENTITY_NAME } from '../../features/vta/utils/subjectRanking';
import { parseConnectionProposalTSV, type ConnectionProposalResult } from '../../features/vta/utils/connectionProposals';
import {
  VTA_EXTRACTION_SYSTEM_PROMPT,
  VTA_REGENERATION_SYSTEM_PROMPT,
  VTA_PROPOSAL_SYSTEM_PROMPT,
  DEFAULT_PROMPT_CONFIG,
  buildExtractionUserPrompt,
  buildRegenerationUserPrompt,
  buildFlowGenerationUserPrompt,
  buildReportGenerationUserPrompt,
  buildProposalUserPrompt,
} from './prompts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Capture the effective policy with the prompts so repairs, cache and provenance agree. */
function captureEventPrompts() {
  const prompts=structuredClone(useVTAStore.getState().promptConfig);
  const normalization=prompts.version==='5.0.0'&&prompts.normalization?.systemPrompt&&prompts.normalization?.userPromptTemplate
    ? prompts.normalization : EVENT_PIPELINE_PROMPTS.normalization;
  prompts.normalization={...normalization,systemPrompt:normalization.systemPrompt.includes(SUBJECT_LANE_POLICY)
    ? normalization.systemPrompt : normalization.systemPrompt+'\n'+SUBJECT_LANE_POLICY};
  if(!prompts.normalization.systemPrompt.includes(FACTUALITY_POLICY)) prompts.normalization.systemPrompt+='\n'+FACTUALITY_POLICY;
  if(!prompts.normalization.systemPrompt.includes(SUBJECT_FOCUS_POLICY)) prompts.normalization.systemPrompt+='\n'+SUBJECT_FOCUS_POLICY;
  if(!prompts.normalization.systemPrompt.includes(OUTCOME_EXTRACTION_POLICY)) prompts.normalization.systemPrompt+='\n'+OUTCOME_EXTRACTION_POLICY;
  if(!prompts.normalization.systemPrompt.includes(AUDIT_SECTIONS_POLICY)) prompts.normalization.systemPrompt+='\n'+AUDIT_SECTIONS_POLICY;
  if(!prompts.normalization.systemPrompt.includes(CONTEXT_EVIDENCE_POLICY))prompts.normalization.systemPrompt+='\n'+CONTEXT_EVIDENCE_POLICY;
  if(!prompts.normalization.systemPrompt.includes(RELATION_CONTRACT_PROMPT)) {
    logTrace('info','[プロンプト契約] 保存済みの正規化プロンプトへ現行の関係属性契約を実行時に補足します。競合する属性指定には現行契約を優先します。設定原本は保持します。','解析');
    prompts.normalization.systemPrompt+='\n'+RELATION_CONTRACT_PROMPT;
  }
  prompts.normalization.systemPrompt=prompts.normalization.systemPrompt.replaceAll(SUBJECT_INFERENCE_POLICY,'').trimEnd()+'\n'+SUBJECT_INFERENCE_POLICY;
  const classification=prompts.version==='5.0.0'&&prompts.classification?.systemPrompt&&prompts.classification?.userPromptTemplate
    ? prompts.classification : EVENT_PIPELINE_PROMPTS.classification;
  prompts.classification={...classification,systemPrompt:classification.systemPrompt.includes(FACTUALITY_POLICY)
    ? classification.systemPrompt : classification.systemPrompt+'\n'+FACTUALITY_POLICY};
  return prompts;
}

export async function proposeVTAConnections(config: LLMConfig, schema: VTASchema, signal?: AbortSignal, scopeCardIds?: string[]): Promise<ConnectionProposalResult> {
  if (!schema.analysis) throw new Error('イベント分析データがありません。先にイベント抽出を実行してください。');
  const analysis = schema.analysis;
  const visibleCards = analysis.cards.filter((card) => cardVisible(schema,card.id,card.laneEntityId)
    && (!scopeCardIds || scopeCardIds.includes(card.id)));
  updateProgress({
    isActive: true,
    mode: 'propose_connections',
    stage: 'preparing',
    stepCurrent: 1,
    stepTotal: 3,
    title: '【1/3】レーン構造と候補の解析',
    detail: `表示カード ${visibleCards.length}件と原文段落からレーン間接続の候補を整理しています。`,
    elapsedSeconds: 0,
  });
  const contextInput=proposalContext(schema,scopeCardIds);
  const refs=new Map(contextInput.sources.map(p=>[p.ref,new Set(p.eventIds)]));
  const paragraphs=contextInput.sources.map(p=>[p.ref,p.eventIds.join(','),p.purpose,p.text.replace(/[\t\r\n]+/g,' ')].join('\t'));
  const rawCandidates=dependencyCandidates(analysis).filter(c=>visibleCards.some(v=>v.laneEntityId===c.sourceEntityId&&v.eventIds.includes(c.sourceEventId))&&visibleCards.some(v=>v.laneEntityId===c.targetEntityId&&v.eventIds.includes(c.targetEventId)));
  let candidates = rawCandidates;
  if (scopeCardIds && scopeCardIds.length > 0) {
    const scopeSet = new Set(scopeCardIds);
    const inScope = (c: typeof rawCandidates[0]) =>
      visibleCards.some(v => scopeSet.has(v.id) && ((v.laneEntityId === c.sourceEntityId && v.eventIds.includes(c.sourceEventId)) || (v.laneEntityId === c.targetEntityId && v.eventIds.includes(c.targetEventId))));
    candidates = [...rawCandidates.filter(inScope), ...rawCandidates.filter(c => !inScope(c))];
  }
  const MAX_CANDIDATES = 500;
  if (candidates.length > MAX_CANDIDATES) {
    candidates = candidates.slice(0, MAX_CANDIDATES);
  }
  const ledger=[contextInput.text.slice(0,contextInput.text.indexOf('[原文]')),'[作業依存の優先点検候補（非隣接も根拠があれば可）]','sourceEventId\tsourceEntityId\ttargetEventId\ttargetEntityId',...candidates.map(c=>[c.sourceEventId,c.sourceEntityId,c.targetEventId,c.targetEntityId].join('\t')),'[接続専用の採用可能カード]',visibleCards.map(c=>c.id).join(',')||'-','未割当イベントへの接続には主体割当が必要。この接続専用形式では追加できないため、要確認へ対象イベントIDを記し、主体・不足イベントを含む点検へ回す。','[原文]','ref\teventIds\tpurpose\ttext',...paragraphs].join('\n');
  if (ledger.length > 180_000) throw new Error(`提案入力が上限（180,000文字）を超えました（${ledger.length}文字）。表示対象を絞ってください。`);
  const promptConfig = useVTAStore.getState().promptConfig;
  const configuredItem = promptConfig.connectionProposal ?? DEFAULT_PROMPT_CONFIG.connectionProposal!;
  let systemPrompt = configuredItem.systemPrompt;
  if (!systemPrompt.includes(FACTUALITY_POLICY)) systemPrompt += '\n' + FACTUALITY_POLICY;
  if (!systemPrompt.includes(CONTEXT_EVIDENCE_POLICY)) systemPrompt += '\n' + CONTEXT_EVIDENCE_POLICY;
  if (!systemPrompt.includes('【関係属性契約')) systemPrompt += '\n' + RELATION_CONTRACT_PROMPT;
  const item = { ...configuredItem, systemPrompt };
  const userPrompt = item.userPromptTemplate.replace('{ledger}', ledger);
  logTrace('info', `[接続提案] 入力 ${ledger.length}文字、表示カード ${visibleCards.length}件、原文段落 ${paragraphs.length}件。`, '提案');
  updateProgress({
    isActive: true,
    mode: 'propose_connections',
    stage: 'calling_llm',
    stepCurrent: 2,
    stepTotal: 3,
    title: '【2/3】レーン間接続のAI推論',
    detail: `モデル: ${config.selectedModel} でレーン間の因果関係・資源移動・作業依存を探索しています。`,
  });
  const { content } = await callLLMGateway(config, [{ role:'system', content:item.systemPrompt }, { role:'user', content:userPrompt }], 0.1, signal);
  let parsed = parseConnectionProposalTSV(content, schema, scopeCardIds, new Set(refs.keys()));
  logTrace(parsed.invalidRows.length ? 'warn' : 'info', `[接続提案/検証] 候補 ${parsed.proposals.length}件、要確認 ${parsed.reviews.length}件、不正行 ${parsed.invalidRows.length}件。${parsed.invalidRows.join(' / ')}`, '提案');
  for (let attempt=0; attempt<2 && parsed.invalidRows.length && !signal?.aborted; attempt++) {
    const invalidIds=parsed.invalidRows.map((line)=>line.split('\t')[0]?.trim()).filter((id)=>id&&id!=='応答に[完了]がありません。'&&id!=='応答に[接続提案]がありません。');
    const issueRows=parsed.invalidRows.filter((line)=>!line.startsWith('応答に['));
    if(!issueRows.length) break;
    const affectedEvents=new Set(issueRows.flatMap((row)=>{const cells=row.split('\t');return [cells[4],cells[6]];}));
    const context=paragraphs.filter((row)=>row.split('\t')[1].split(',').some((id)=>affectedEvents.has(id)));
    const allowed=ledger.slice(0,ledger.indexOf('[原文]'))+'[関連原文]\n'+context.join('\n');
    const repair=`次のTSV行だけを修正して返してください。IDは維持し、一覧にないIDを参照しないでください。根拠から関係を確定できなければ同じIDの[要確認]（ID・原文参照・理由）へ移してください。出力形式は通常と同じ表と[完了]です。\n${allowed}\n[修復対象]\n${issueRows.join('\n')}`;
    logTrace('warn', `[接続提案/修復] ${invalidIds.join(', ')} を再取得します（${attempt+1}/2）。`, '提案');
    updateProgress({
      stage: 'calling_llm',
      stepCurrent: 2,
      title: `【2/3】接続候補の修復確認 (${attempt + 1}/2)`,
      detail: '一部の提案行の形式・原文参照を再確認しています。',
    });
    try {
      const response=await callLLMGateway(config,[{role:'system',content:item.systemPrompt},{role:'user',content:repair}],0.1,signal);
      const repaired=parseConnectionProposalTSV(response.content,schema,scopeCardIds,new Set(context.map(row=>row.split('\t')[0])));
      if([...repaired.proposals,...repaired.reviews].some((row)=>!invalidIds.includes(row.id))) throw new Error('修復対象外の提案IDが返されました。');
      const repairedIds=new Set([...repaired.proposals,...repaired.reviews].map((p)=>p.id));
      const retainedInvalid=parsed.invalidRows.filter((line)=>!invalidIds.includes(line.split('\t')[0]?.trim()) || !repairedIds.has(line.split('\t')[0]?.trim()));
      const proposals=[...parsed.proposals,...repaired.proposals.filter((p)=>!parsed.proposals.some((old)=>old.id===p.id))];
      parsed={proposals,reviews:[...parsed.reviews,...repaired.reviews.filter((r)=>!parsed.reviews.some((old)=>old.id===r.id))],invalidRows:[...retainedInvalid,...repaired.invalidRows]};
      if(!repairedIds.size) { logTrace('warn','[接続提案/修復停止] 有効な修正が返されませんでした。正常候補を保持して確認画面へ戻ります。','提案'); break; }
    } catch(error) {
      if(signal?.aborted) throw error;
      parsed={...parsed,invalidRows:[...parsed.invalidRows,`修復通信に失敗: ${error instanceof Error?error.message:String(error)}`]}; break;
    }
  }
  updateProgress({
    stage: 'parsing',
    stepCurrent: 3,
    title: '【3/3】提案候補の検証・整形',
    detail: `正常候補 ${parsed.proposals.length}件・要確認 ${parsed.reviews.length}件を検証しました。`,
  });
  logTrace(parsed.invalidRows.length ? 'warn' : 'success', `[接続提案/確認待ち] 正常候補 ${parsed.proposals.length}件、要確認 ${parsed.reviews.length}件、未解決 ${parsed.invalidRows.length}件。`, '提案');
  for (const prop of parsed.proposals) {
    const hits = scanGeneratedText(prop.reason ?? '');
    if (hits.length) {
      logTrace('warn', `[表現点検] 接続提案 ${prop.id} の理由に評価表現（${[...new Set(hits.map((h) => h.phrase))].join('、')}）が含まれています。`, '提案');
    }
  }
  const generation={runId:crypto.randomUUID(),schemeId:'connection-proposal',schemeVersion:'2',ruleVersion:'adjacent-dependency-1',model:config.selectedModel,promptFingerprint:fingerprint(item.systemPrompt+userPrompt),inputFingerprint:fingerprint(ledger)};
  debugRecorder.record('connection-proposal.validation',()=>({generation,...parsed}),undefined,[config.gatewayToken??'']);
  return {...parsed,proposals:parsed.proposals.map(p=>({...p,generation}))};
}

function logTrace(type: 'info' | 'success' | 'warn' | 'error', message: string, stageTag?: string) {
  try {
    useVTAStore.getState().addLog(type, message, stageTag);
  } catch {}
}

function updateProgress(progress: Partial<import('../../types/vta').GenerationProgress>) {
  try {
    useVTAStore.getState().setGenerationProgress(progress);
  } catch {}
}

/**
 * Extracts and cleans JSON string from LLM response (handling thinking tags, markdown fences, whitespace, etc.)
 */
function extractJSONFromResponse(text: string): { jsonString: string; hasThinkTag: boolean } {
  const hasThinkTag = /<think>[\s\S]*?<\/think>/gi.test(text);
  // 1. Strip reasoning/thought tags like <think>...</think> from DeepSeek/Qwen models
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Try markdown code block extraction (look for ```json or ``` blocks)
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = cleaned.match(jsonBlockRegex);
  if (match && match[1]) {
    return { jsonString: match[1].trim(), hasThinkTag };
  }

  // 3. Look for outermost { ... }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return { jsonString: cleaned.substring(firstBrace, lastBrace + 1), hasThinkTag };
  }

  return { jsonString: cleaned, hasThinkTag };
}

async function callLedgerStage(stage: 'normalization' | 'classification', config: LLMConfig, text: string, signal?: AbortSignal, repair = false, configured = structuredClone(useVTAStore.getState().promptConfig)): Promise<string> {
  // Old custom JSON prompts do not describe the new transport contract.
  const prompt = configured.version === '5.0.0' && configured[stage]?.systemPrompt && configured[stage]?.userPromptTemplate
    ? configured[stage]! : EVENT_PIPELINE_PROMPTS[stage];
  const user = repair ? text : prompt.userPromptTemplate.replace(stage === 'normalization' ? '{sourceText}' : '{analysisText}', text);
  const { content } = await callLLMGateway(config, [{ role: 'system', content: prompt.systemPrompt }, { role: 'user', content: user }], 0.1, signal);
  return content;
}

export async function extractEventDraft(
  config: LLMConfig,
  scenarioText: string,
  signal?: AbortSignal,
  schemeId: 'event-chain' | 'fulltext-ledger' | 'refined-chain' = 'event-chain',
  maxSubjects?: number
): Promise<VTASchema> {
  const source = sourceFromText(scenarioText);
  if (!source.paragraphs.length) throw new Error('入力テキストが空です。');
  const effectiveMaxSubjects = clampSubjectLimit(maxSubjects ?? useVTAStore.getState().subjectLimit);
  updateProgress({ isActive: true, mode: 'extract', stepCurrent: 1, stepTotal: 3, stage: 'calling_llm', title: '【1/3】全文の正規化', detail: '個別イベント・主体・根拠を一括で整理しています。' });
  const stateInput = useVTAStore.getState().scenarioText;
  const fixedPrompts = captureEventPrompts();
  if (schemeId === 'event-chain' || schemeId === 'refined-chain') {
    const base = fixedPrompts.normalization ?? EVENT_PIPELINE_PROMPTS.normalization;
    fixedPrompts.normalization = {
      ...base,
      systemPrompt:
        base.systemPrompt +
        '\n全文から不具合に至る事象の連鎖を構成する。通常作業・未実施・主体間の関係を見落とさない。レーン間の依存・影響・リソース移動は非隣接でも原文の根拠があれば関係表に記す。同一レーンの中間イベントは飛び越さない。接続を増やす目的で事象の統合・複製・主体の除外を行わない。関係不明なら整理reviewとして根拠と不足を残す。',
    };
  }
  const fixedConfig = structuredClone(config);
  const projectId = useVTAStore.getState().currentProjectId ?? '';
  const schemeName = schemeId === 'event-chain' ? '事象連鎖方式' : schemeId === 'refined-chain' ? '粒度反復方式' : '全文正規化・TSV台帳方式';
  const registry = generationRegistry([
    {
      id: schemeId,
      version: '1',
      name: schemeName,
      analysisVersion: 5,
      supportsPassage: true,
      generate: (r) => normalizeSource(fixedConfig, r.source, r.signal, '', fixedPrompts, r.projectId, callLedgerStage, logTrace),
    },
  ]);
  const rawAnalysis = await registry.run(
    schemeId,
    { source, model: fixedConfig.selectedModel, prompt: JSON.stringify(fixedPrompts), projectId, signal },
    (a) => validateSavedAnalysis(a)
  );
  if (projectId !== (useVTAStore.getState().currentProjectId ?? '') || stateInput !== useVTAStore.getState().scenarioText) {
    throw new Error('入力またはプロジェクトが変更されたため応答を破棄しました。');
  }
  updateProgress({ stepCurrent: 2, stage: 'layouting', title: '【2/3】カードとレーンの整理', detail: schemeId === 'refined-chain' ? '主体粒度・接続構造・認知負荷の反復レビューを行っています。' : '主体の重要度判定・統合と冗長な表示カードの整理を行っています。' });
  let schema: VTASchema;
  if (schemeId === 'refined-chain') {
    const refSettings = useVTAStore.getState().refinementSettings;
    schema = await refineGranularity(
      fixedConfig,
      rawAnalysis,
      effectiveMaxSubjects,
      signal,
      callLLMGateway,
      logTrace,
      refSettings.maxIterations,
      refSettings.targetScore,
      refSettings.epsilon,
      refSettings.weights,
      refSettings.useOneTimeDirective ? refSettings.oneTimeDirective : undefined,
      refSettings.assumptions,
      refSettings.scope
    );
    if (refSettings.useOneTimeDirective) {
      useVTAStore.setState((s) => ({
        refinementSettings: {
          ...s.refinementSettings,
          useOneTimeDirective: false,
        },
      }));
    }
    if (projectId !== (useVTAStore.getState().currentProjectId ?? '') || stateInput !== useVTAStore.getState().scenarioText) {
      throw new Error('入力またはプロジェクトが変更されたため応答を破棄しました。');
    }
  } else {
    const analysis = consolidateSubjects(rawAnalysis, effectiveMaxSubjects, undefined, (msg) => logTrace('warn', `[主体統合] ${msg}`, '解析'));
    if (analysis.subjectRanking?.warning) {
      logTrace('warn', `[主体統合] ${analysis.subjectRanking.warning}`, '解析');
    }
    debugRecorder.record('subject.ranking', () => ({ maxSubjects: effectiveMaxSubjects, ranking: analysis.subjectRanking }), undefined, [config.gatewayToken ?? '']);
    schema = projectAnalysis(analysis);
  }
  const analysis = schema.analysis!;
  updateProgress({ stepCurrent: 3, stage: 'layouting', title: '【3/3】確認用の図を構築', detail: '整理後のカードを接続しています。' });
  const origSubjectCount = analysis.subjectRanking?.originalEntities.length ?? analysis.entities.length;
  const subjectTrace = origSubjectCount > analysis.entities.length
    ? `主体 ${analysis.entities.length}件（抽出 ${origSubjectCount}件・上限 ${effectiveMaxSubjects}件）`
    : `主体 ${analysis.entities.length}件`;
  logTrace('success', '[イベント抽出] イベント ' + analysis.events.length + '件、' + subjectTrace + '、全カード ' + analysis.cards.length + '件、表示除外 ' + Object.keys(schema.presentation?.suppressedCards ?? {}).length + '件、背景・除外・要確認 ' + (analysis.dispositions?.length ?? 0) + '件。変動判定は未実施です。', '解析');
  return schema;
}

/** Reconsider only the cited passage, retaining all previously accepted events and citations. */
export async function restoreNormalizedPassage(config: LLMConfig, schema: VTASchema, dispositionId: string, signal?: AbortSignal): Promise<VTASchema> {
  const original = schema.analysis!;
  if(original.generation&&!['fulltext-ledger','event-chain','refined-chain'].includes(original.generation.schemeId)) throw new Error('元の生成方式は部分再抽出に対応していません。');
  const disposition = original.dispositions?.find((item) => item.id === dispositionId);
  const source = original.sources.find((item) => item.id === disposition?.sourceId);
  if (!disposition || !source) throw new Error('再整理対象がありません。');
  updateProgress({
    isActive: true,
    mode: 'restore_passage',
    stage: 'preparing',
    stepCurrent: 1,
    stepTotal: 3,
    title: '【1/3】対象記述の抽出',
    detail: '選択された未反映記述と周辺の抽出済みイベントを整理しています。',
    elapsedSeconds: 0,
  });
  const refs = disposition.sourceRefs ?? [disposition];
  const paragraphs = source.paragraphs.filter((part) => refs.some((ref) => ref.sourceId === source.id && ref.paragraphId === part.id));
  const known = original.events.filter((event) => event.sourceRefs?.some((ref) => paragraphs.some((part) => part.id === ref.paragraphId)))
    .map((event) => event.id + '\t' + event.title + '\t' + event.description.replace(/[\r\n\t]+/g, ' ')).join('\n');
  const context = '\n【再抽出の対象】\n' + sanitizeForPrompt(disposition.text ?? disposition.quote ?? '') + '\n【既に抽出済み：同じ出来事を再度出力しない】\n' + known;
  const fixedConfig=structuredClone(config),fixedPrompts=captureEventPrompts();
  const projectId=useVTAStore.getState().currentProjectId??'';
  updateProgress({
    isActive: true,
    mode: 'restore_passage',
    stage: 'calling_llm',
    stepCurrent: 2,
    stepTotal: 3,
    title: '【2/3】選択記述の再解析',
    detail: `モデル: ${config.selectedModel} で対象記述からイベント・主体を再抽出しています。`,
  });
  const registry=generationRegistry([{id:'fulltext-ledger',version:'1',name:'全文正規化・TSV台帳方式',analysisVersion:5,supportsPassage:true,generate:r=>normalizeSource(fixedConfig,r.source,r.signal,context,fixedPrompts,r.projectId,callLedgerStage,logTrace)}]);
  const result = await registry.run('fulltext-ledger',{source:{...source,paragraphs},model:config.selectedModel,prompt:JSON.stringify(fixedPrompts),projectId,signal},validateSavedAnalysis);
  if (!result.events.length) throw new Error('この記述からイベントは得られませんでした。元の記録は保持しています。');
  updateProgress({
    stage: 'layouting',
    stepCurrent: 3,
    title: '【3/3】既存図へのマージ',
    detail: '再抽出したイベントと主体を現在の図へ統合しています。',
  });
  const prefix = 'restored_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_';
  const entities = [...original.entities];
  const maxSubjects = clampSubjectLimit(original.subjectRanking?.maxSubjects ?? useVTAStore.getState().subjectLimit);
  const ensureOthersEntityId = () => {
    const existing = entities.find((item) => item.aggregate || item.name === OTHER_ACTORS_ENTITY_NAME);
    if (existing) return existing.id;
    let id = 'subject_others';
    let idx = 2;
    const ids = new Set(entities.map((e) => e.id));
    while (ids.has(id)) {
      id = `subject_others_${idx++}`;
    }
    entities.push({ id, name: OTHER_ACTORS_ENTITY_NAME, kind: 'other', aggregate: true });
    return id;
  };
  const entityIds = new Map<string, string>();
  const entityOriginIds = new Map<string, string>();
  const restoredRankingEntries = [...(original.subjectRanking?.ranks ?? [])];
  const restoredOriginalEntities = [...(original.subjectRanking?.originalEntities ?? [])];

  for (const entity of result.entities) {
    const known = entities.find((item) => item.name === entity.name && item.kind === entity.kind);
    if (known) {
      entityIds.set(entity.id, known.id);
      entityOriginIds.set(entity.id, known.id);
      continue;
    }
    if (entities.some((item) => item.name === entity.name)) {
      throw new Error('同名で種類が異なる主体があります。名称を確認してください。');
    }
    const origMatch = original.subjectRanking?.originalEntities.find((item) => item.name === entity.name && item.kind === entity.kind);
    if (origMatch) {
      const rankEntry = original.subjectRanking?.ranks.find((entry) => entry.entityId === origMatch.id);
      const targetId = (rankEntry?.mergedInto && entities.some((e) => e.id === rankEntry.mergedInto))
        ? rankEntry.mergedInto
        : (entities.some((e) => e.id === origMatch.id) ? origMatch.id : ensureOthersEntityId());
      entityIds.set(entity.id, targetId);
      entityOriginIds.set(entity.id, origMatch.id);
      continue;
    }
    const id = prefix + entity.id;
    const mappedParentId = entity.parentEntityId ? entityIds.get(entity.parentEntityId) : undefined;
    const canKeepNew = entities.length < maxSubjects;
    if (canKeepNew) {
      const created = { ...entity, id, ...(mappedParentId ? { parentEntityId: mappedParentId } : {}) };
      entities.push(created);
      entityIds.set(entity.id, id);
      entityOriginIds.set(entity.id, id);
      if (original.subjectRanking) {
        restoredOriginalEntities.push(created);
        restoredRankingEntries.push({
          entityId: id,
          rank: restoredRankingEntries.length + 1,
          score: 0,
          breakdown: { A: 0, O: 0, F: 0, C: 0, T: 0 },
          retained: true,
          reason: '部分再抽出による追加保持',
        });
      }
    } else {
      const parentTarget = mappedParentId && entities.some((e) => e.id === mappedParentId && !e.aggregate)
        ? mappedParentId
        : undefined;
      const targetId = parentTarget ?? ensureOthersEntityId();
      entityIds.set(entity.id, targetId);
      entityOriginIds.set(entity.id, id);
      if (original.subjectRanking) {
        const created = { ...entity, id, ...(mappedParentId ? { parentEntityId: mappedParentId } : {}) };
        restoredOriginalEntities.push(created);
        restoredRankingEntries.push({
          entityId: id,
          rank: restoredRankingEntries.length + 1,
          score: 0,
          breakdown: { A: 0, O: 0, F: 0, C: 0, T: 0 },
          retained: false,
          mergedInto: targetId,
          reason: '部分再抽出・上限超過のため統合',
        });
      }
    }
  }
  const events = result.events.map((event) => ({ ...event, id: prefix + event.id,
    sourceOrder: original.events.length + event.sourceOrder,
  }));
  const next: VTAAnalysisData = { ...original, entities, generationRuns:[...(original.generationRuns??[]),...result.generationRuns??[]],
    facts: original.facts,
    events: [...original.events, ...events],
    participations: [...original.participations, ...result.participations.map((part) => {
      const targetEntityId = entityIds.get(part.entityId)!;
      const originEntityId = entityOriginIds.get(part.entityId) ?? targetEntityId;
      return {
        ...part,
        eventId: prefix + part.eventId,
        entityId: targetEntityId,
        factIds: part.factIds.map((id) => prefix + id),
        ...(originEntityId !== targetEntityId ? { mergedFrom: [{ entityId: originEntityId, role: part.role }] } : {}),
      };
    })],
    relations: [...original.relations, ...result.relations.map((relation) => {
      const srcTarget = relation.sourceEntityId ? entityIds.get(relation.sourceEntityId) : undefined;
      const tgtTarget = relation.targetEntityId ? entityIds.get(relation.targetEntityId) : undefined;
      const srcOrigin = relation.sourceEntityId ? entityOriginIds.get(relation.sourceEntityId) : undefined;
      const tgtOrigin = relation.targetEntityId ? entityOriginIds.get(relation.targetEntityId) : undefined;
      return {
        ...relation,
        id: relation.id ? prefix + relation.id : undefined,
        sourceEventId: prefix + relation.sourceEventId,
        targetEventId: prefix + relation.targetEventId,
        sourceEntityId: srcTarget,
        targetEntityId: tgtTarget,
        ...(srcOrigin && srcOrigin !== srcTarget ? { sourceEntityOrigin: srcOrigin } : {}),
        ...(tgtOrigin && tgtOrigin !== tgtTarget ? { targetEntityOrigin: tgtOrigin } : {}),
        factIds: relation.factIds.map((id) => prefix + id),
      };
    })],
    cards: [...original.cards, ...result.cards.map((card) => ({ ...card, id: prefix + card.id, laneEntityId: entityIds.get(card.laneEntityId)!, eventIds: card.eventIds.map((id) => prefix + id) }))],
    unassignedEventIds: [...original.unassignedEventIds, ...result.unassignedEventIds.map((id) => prefix + id)],
    dispositions: [...(original.dispositions ?? []).filter((item) => item.id !== dispositionId), ...(result.dispositions ?? []).map((item) => ({ ...item, id: prefix + item.id }))],
    ...(original.subjectRanking ? {
      subjectRanking: {
        ...original.subjectRanking,
        ranks: restoredRankingEntries,
        originalEntities: restoredOriginalEntities,
      },
    } : {}),
    ...(original.normalizationAudit || result.normalizationAudit ? {
      normalizationAudit: {
        version: 1,
        corrections: [
          ...(original.normalizationAudit?.corrections ?? []),
          ...(result.normalizationAudit?.corrections ?? []).map((c) => ({ ...c, id: prefix + c.id })),
        ],
        subjectiveNotices: [
          ...(original.normalizationAudit?.subjectiveNotices ?? []),
          ...(result.normalizationAudit?.subjectiveNotices ?? []).map((n) => ({
            ...n,
            id: prefix + n.id,
            eventIds: n.eventIds.map((id) => prefix + id),
          })),
        ],
        ...(original.normalizationAudit?.iterations ? { iterations: original.normalizationAudit.iterations } : {}),
      },
    } : {}),
  };
  if(projectId!==(useVTAStore.getState().currentProjectId??'')) throw new Error('プロジェクトが変更されたため応答を破棄しました。');
  for(const r of result.relations.filter(r=>r.kind==='dependency')) { const mapped=next.relations.find(n=>n.sourceEventId===prefix+r.sourceEventId&&n.targetEventId===prefix+r.targetEventId); if(mapped){const issue=dependencyProblem(next,mapped,next.relations.filter(n=>n!==mapped));if(issue)throw new Error(issue);} }
  return projectAnalysis(next, schema);
}

export async function classifyEventDraft(config: LLMConfig, analysis: VTAAnalysisData, signal?: AbortSignal): Promise<VTAAnalysisData> {
  if (!analysis.events.some((event) => event.classification === 'unclassified')) return analysis;
  updateProgress({
    isActive: true,
    mode: 'classify',
    stage: 'preparing',
    stepCurrent: 1,
    stepTotal: 3,
    title: '【1/3】抽出結果の整理',
    detail: '確認済みのイベントと原文根拠を整理しています。',
    elapsedSeconds: 0,
  });
  const input = classificationInput(analysis);
  updateProgress({
    isActive: true,
    mode: 'classify',
    stage: 'calling_llm',
    stepCurrent: 2,
    stepTotal: 3,
    title: '【2/3】変動要因の判定',
    detail: `モデル: ${config.selectedModel} で各イベントの通常作業・変動要因を判定しています。`,
  });
  const rawReply = await callLedgerStage('classification', config, input, signal);
  let doc: LedgerDocument;
  try {
    doc = parseLedger(rawReply, { partial: true, defaultSection: '判定', allowMissingComplete: true });
  } catch (error) {
    logTrace('warn', `[変動判定] 初回台帳パース警告: ${error instanceof Error ? error.message : String(error)}。修復処理を試みます。`, '解析');
    doc = { rows: [] };
  }
  for (let attempt = 0; attempt <= 2; attempt++) {
    const result = inspectClassifications(doc, analysis);
    if (result.analysis) {
      for (const ev of result.analysis.events) {
        if (ev.classificationReason) {
          const hits = scanGeneratedText(ev.classificationReason, ev.recordKind ?? 'recorded');
          if (hits.length) {
            logTrace('warn', `[表現点検] イベント ${ev.id} の判定理由に評価表現（${[...new Set(hits.map((h) => h.phrase))].join('、')}）が含まれています。`, '解析');
          }
        }
      }
      updateProgress({
        stage: 'layouting',
        stepCurrent: 3,
        title: '【3/3】VTAツリー図へ反映',
        detail: '判定結果をカードとスイムレーンに反映しています。',
      });
      return result.analysis;
    }
    if (attempt === 2) throw new Error('変動判定の台帳を検証できませんでした。');
    const targetIds = new Set(result.issues.map((issue) => issue.row.id));
    const context = classificationInput({ ...analysis, events: analysis.events.filter((event) => targetIds.has(event.id)) });
    const request = '次の判定行IDだけを修正し、[判定]、同じIDの4列TSV行、[完了]を返す。指定外の行を出力しない。\n' + context
      + '\n[修復対象]\n' + result.issues.map((issue) => issue.row.cells.join('\t') + '\nエラー: ' + issue.message).join('\n');
    updateProgress({
      stage: 'calling_llm',
      stepCurrent: 2,
      title: `【2/3】変動判定の修復確認 (${attempt + 1}/2)`,
      detail: '一部の判定行の形式・原文参照を再確認しています。',
    });
    const reply = await callLedgerStage('classification', config, request, signal, true);
    try {
      doc = applyLedgerRepair(doc, result.issues, reply);
    } catch (repairError) {
      logTrace('warn', `[変動判定] 修復台帳パース警告: ${repairError instanceof Error ? repairError.message : String(repairError)}`, '解析');
    }
  }
  throw new Error('変動判定を完了できませんでした。');
}

/**
 * Low-level API caller to Lightweight LLM Gateway (OpenAI Compatible)
 */
export async function callLLMGateway(
  config: LLMConfig,
  messages: ChatMessage[],
  temperature = 0.2,
  externalSignal?: AbortSignal
): Promise<{ content: string; latencyMs: number }> {
  const debugSession=debugRecorder.getSnapshot();
  const debugRequestId=crypto.randomUUID();
  const traceDebug=(stage:string,data:()=>unknown)=>{if(debugSession.enabled)debugRecorder.record(stage,()=>({requestId:debugRequestId,...data() as object}),debugSession.sessionId,[config.gatewayToken??'']);};
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutSec = config.timeoutSeconds && config.timeoutSeconds > 0 ? config.timeoutSeconds : 180;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.gatewayToken && config.gatewayToken.trim().length > 0) {
    headers['Authorization'] = `Bearer ${config.gatewayToken.trim()}`;
  }

  const payload = {
    model: config.selectedModel,
    messages,
    temperature,
  };
  traceDebug('llm.request',()=>({endpoint,model:config.selectedModel,messages,temperature,timeoutSec}));

  const totalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
  logTrace(
    'info',
    `[通信/送信] エンドポイント: ${endpoint} | モデル: ${config.selectedModel} (${messages.length}件のメッセージ, 約${totalChars}文字, タイムアウト: ${timeoutSec}秒)`,
    '通信'
  );
  const startTime = performance.now();

  const controller = new AbortController();
  let timedOut = false;
  let userCancelled = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSec * 1000);

  const onExternalAbort = () => {
    userCancelled = true;
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      const cancelErr = new Error('USER_CANCELLED');
      cancelErr.name = 'UserCancelledError';
      throw cancelErr;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const elapsed = Math.round(performance.now() - startTime);

    if (userCancelled || (externalSignal && externalSignal.aborted)) {
      const cancelErr = new Error('USER_CANCELLED');
      cancelErr.name = 'UserCancelledError';
      throw cancelErr;
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        errorBody = response.statusText;
      }
      traceDebug('llm.http-error',()=>({status:response.status,elapsedMs:elapsed,body:errorBody}));
      logTrace('error', `[通信/エラー] HTTP ${response.status} (${elapsed}ms): ${errorBody}`, '通信');
      throw new Error(`LLM Gateway エラー (${response.status}): ${errorBody}`);
    }

    logTrace(
      'info',
      `[通信/応答] HTTP ${response.status} OK (${elapsed}ms) - レスポンスストリーム読み込み中...`,
      '通信'
    );

    const data = await response.json();
    traceDebug('llm.response',()=>({status:response.status,elapsedMs:elapsed,response:data}));

    if (userCancelled || (externalSignal && externalSignal.aborted)) {
      const cancelErr = new Error('USER_CANCELLED');
      cancelErr.name = 'UserCancelledError';
      throw cancelErr;
    }

    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('LLMの出力上限に達しました。途中の結果は採用しません。出力上限の大きいモデルを選択してください。');
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logTrace('error', `[通信/エラー] LLMからの応答コンテンツ (choices[0].message.content) が空でした。`, '通信');
      throw new Error('LLMからの応答コンテンツが空でした。');
    }

    logTrace(
      'success',
      `[通信/完了] テキスト受信完了: ${content.length}文字 (所要時間: ${elapsed}ms)`,
      '通信'
    );
    return { content, latencyMs: elapsed };
  } catch (err: unknown) {
    const elapsed = Math.round(performance.now() - startTime);
    traceDebug('llm.failure',()=>({elapsedMs:elapsed,timedOut,userCancelled,error:err instanceof Error?err.message:String(err)}));

    if (userCancelled || (externalSignal && externalSignal.aborted)) {
      logTrace('warn', `[中断] ユーザー操作により通信が中断（キャンセル）されました (${elapsed}ms)`, '中断');
      const cancelErr = new Error('USER_CANCELLED');
      cancelErr.name = 'UserCancelledError';
      throw cancelErr;
    }

    if (timedOut) {
      logTrace('error', `[タイムアウト] 設定されたタイムアウト時間（${timeoutSec}秒）を超過しました。`, '通信');
      throw new Error(`LLM Gateway へのリクエストがタイムアウトしました (${timeoutSec}秒)。必要に応じて左側設定パネルでタイムアウト秒数を延長してください。`);
    }

    if (err instanceof Error) {
      if (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED') {
        throw err;
      }
      if (err.name === 'AbortError') {
        logTrace('warn', `[中断] 通信が中断されました (${elapsed}ms)`, '中断');
        const cancelErr = new Error('USER_CANCELLED');
        cancelErr.name = 'UserCancelledError';
        throw cancelErr;
      }
      if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
        logTrace('error', `[通信エラー] Gatewayに接続できませんでした (${elapsed}ms)`, '通信');
        throw new Error(
          `【接続エラー (Failed to fetch)】\n` +
          `LLM Gateway (${endpoint}) への通信に失敗しました。\n\n` +
          `考えられる原因と対策:\n` +
          `1. Lightweight LLM Gateway が起動していない (ポート 8765 で待機しているか確認)\n` +
          `2. Base URL の設定が誤っている (現在: ${config.baseUrl})`
        );
      }
      throw err;
    }
    logTrace('error', `[未知のエラー] ${String(err)}`, '通信');
    throw new Error(`LLM Gateway (${endpoint}) への接続に失敗しました。`);
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Lightweight connection tester
 */
export async function testGatewayConnection(
  config: LLMConfig,
  externalSignal?: AbortSignal
): Promise<{ success: boolean; latencyMs: number; message: string }> {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutSec = Math.min(config.timeoutSeconds && config.timeoutSeconds > 0 ? config.timeoutSeconds : 30, 30);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.gatewayToken && config.gatewayToken.trim().length > 0) {
    headers['Authorization'] = `Bearer ${config.gatewayToken.trim()}`;
  }

  const payload = {
    model: config.selectedModel,
    messages: [{ role: 'user', content: 'Ping' }],
    max_tokens: 5,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`接続テストがタイムアウトしました (${timeoutSec}秒経過)`));
  }, timeoutSec * 1000);

  if (externalSignal) {
    externalSignal.addEventListener('abort', () => {
      controller.abort(externalSignal.reason);
    });
  }

  logTrace('info', `[接続テスト] ${config.selectedModel} へ Ping 送信中... (${endpoint}, タイムアウト: ${timeoutSec}秒)`, 'テスト');
  const start = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const elapsed = Math.round(performance.now() - start);

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      logTrace('error', `[接続テスト失敗] HTTP ${response.status} (${elapsed}ms): ${errText}`, 'テスト');
      return {
        success: false,
        latencyMs: elapsed,
        message: `HTTP ${response.status}: ${errText}`,
      };
    }

    logTrace('success', `[接続テスト成功] HTTP 200 OK (${elapsed}ms)`, 'テスト');
    return {
      success: true,
      latencyMs: elapsed,
      message: `接続成功 (${elapsed} ms)`,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const elapsed = Math.round(performance.now() - start);
    const isAbort = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    const msg = isAbort
      ? (controller.signal.reason instanceof Error ? controller.signal.reason.message : `接続テストが中断またはタイムアウトしました (${timeoutSec}秒)`)
      : (err instanceof Error ? err.message : '接続できませんでした');

    logTrace('error', `[接続テスト例外] ${msg} (${elapsed}ms)`, 'テスト');
    return {
      success: false,
      latencyMs: elapsed,
      message: msg,
    };
  }
}

/**
 * Extracts VTA Schema from natural language scenario text
 */
export async function extractVTAFromScenario(
  config: LLMConfig,
  scenarioText: string,
  signal?: AbortSignal
): Promise<VTASchema> {
  const totalStartTime = performance.now();

  // Stage 1: Preparation & Prompt Construction
  updateProgress({
    isActive: true,
    mode: 'extract',
    stage: 'preparing',
    title: '【1/4 準備】プロンプト構築中',
    detail: `事故シナリオ（${scenarioText.length}文字）を解析し、指示プロンプトを構築しています...`,
    stepCurrent: 1,
    stepTotal: 4,
    elapsedSeconds: 0,
  });

  logTrace(
    'info',
    `[1/4 準備] シナリオ解析開始: ${scenarioText.length}文字の入力テキスト`,
    '準備'
  );

  const promptConfig = useVTAStore.getState().promptConfig;
  const messages: ChatMessage[] = [
    { role: 'system', content: promptConfig.extraction.systemPrompt },
    { role: 'user', content: buildExtractionUserPrompt(scenarioText, promptConfig) },
  ];

  const promptTotalChars = messages.reduce((acc, m) => acc + m.content.length, 0);
  logTrace(
    'info',
    `[1/4 準備] プロンプト構築完了: システムプロンプト + 指示プロンプト (合計 ${promptTotalChars}文字)`,
    '準備'
  );

  // Stage 2: Gateway Communication (LLM Inference)
  updateProgress({
    stage: 'calling_llm',
    stepCurrent: 2,
    title: '【2/4 推論】LLM Gateway通信中',
    detail: `モデル: ${config.selectedModel} でVTA構造（通常作業・変動要因・時間関係）を推論中...`,
  });

  const { content: rawResponse, latencyMs } = await callLLMGateway(config, messages, 0.2, signal);

  // Stage 3: JSON Parsing & Schema Validation
  updateProgress({
    stage: 'parsing',
    stepCurrent: 3,
    title: '【3/4 解析】JSONスキーマ解析中',
    detail: `HTTP 200 OK (${latencyMs}ms) - 思考タグ・マークダウン除去とVTA構造化データの検証中...`,
  });

  const { jsonString, hasThinkTag } = extractJSONFromResponse(rawResponse);
  if (hasThinkTag) {
    logTrace('info', `[3/4 解析] 推論思考タグ (<think>...</think>) を検出・サニタイズしました`, '解析');
  }

  logTrace('info', `[3/4 解析] JSON構文の検証およびVTAスキーマへのマッピングを実行中...`, '解析');

  try {
    let parsed = JSON.parse(jsonString) as any;

    // Handle nested wrapper object like { vta: { ... } } or { data: { ... } }
    if (parsed && typeof parsed === 'object') {
      if (parsed.vta && typeof parsed.vta === 'object' && (parsed.vta.nodes || parsed.vta.normal_sequence)) {
        parsed = parsed.vta;
      } else if (parsed.data && typeof parsed.data === 'object' && parsed.data.nodes) {
        parsed = parsed.data;
      }
    }

    // Convert sequence format if LLM generated normal_sequence / variation structure
    if (!Array.isArray(parsed.nodes) && Array.isArray(parsed.normal_sequence)) {
      const nodes: any[] = [];
      const edges: any[] = [];
      const laneName = '作業現場';

      parsed.normal_sequence.forEach((text: string, idx: number) => {
        const id = `node_seq_${idx + 1}`;
        nodes.push({
          id,
          lane: laneName,
          time: `ステップ ${idx + 1}`,
          type: 'normal',
          title: text,
          description: text,
          measure_type: null,
        });
        if (idx > 0) {
          edges.push({
            source: `node_seq_${idx}`,
            target: id,
            is_break: false,
          });
        }
      });

      if (parsed.variation && parsed.variation.resulting_action) {
        const varId = `node_var_1`;
        nodes.push({
          id: varId,
          lane: laneName,
          time: '異常発生時',
          type: 'variation',
          title: parsed.variation.deviation || '作業手順の逸脱',
          description: parsed.variation.resulting_action,
          measure_type: null,
        });
        if (nodes.length > 1) {
          edges.push({
            source: nodes[0].id,
            target: varId,
            is_break: false,
          });
        }
      }

      parsed = {
        lanes: [laneName],
        nodes,
        edges,
      };
    }

    // Validate and sanitize schema structure
    const valRes = validateAndSanitizeVTASchema(parsed);
    if (!valRes.isValid || !valRes.data) {
      throw new Error(`抽出データのスキーマ検証に失敗しました:\n${valRes.errors.join('\n')}`);
    }
    const repaired = repairGeneratedLaneSequence(valRes.data);
    const sanitizedSchema = repaired.schema;
    if (repaired.fallbackLanes.length > 0) {
      logTrace('warn', `[3/4 解析] sequence_order が不完全なレーンはノード配列の記述順を採用しました: ${repaired.fallbackLanes.join(', ')}`, '解析');
    }
    if (repaired.addedEdges || repaired.removedEdges || repaired.correctedDirections) {
      logTrace('warn', `[3/4 解析] 同一レーンの接続を補正しました: 隣接線を追加 ${repaired.addedEdges}本、飛び越し・重複線を除外 ${repaired.removedEdges}本、方向を補正 ${repaired.correctedDirections}本`, '解析');
    }

    const normalCount = sanitizedSchema.nodes.filter((n) => n.type === 'normal').length;
    const variationCount = sanitizedSchema.nodes.filter((n) => n.type === 'variation').length;
    const notesCount = sanitizedSchema.nodes.filter((n) => Boolean(n.supplementary_note?.trim())).length;

    logTrace(
      'success',
      `[3/4 解析成功] スイムレーン: ${sanitizedSchema.lanes.length}列 (${sanitizedSchema.lanes.join(', ')}) | ノード: ${sanitizedSchema.nodes.length}件 (通常: ${normalCount}, 変動: ${variationCount}) | エッジ: ${sanitizedSchema.edges.length}本 | 補足説明: ${notesCount}件`,
      '解析'
    );

    // Stage 4: Layout calculation
    updateProgress({
      stage: 'layouting',
      stepCurrent: 4,
      title: '【4/4 描画】BT自動階層レイアウト構築中',
      detail: `VTAの時間軸（下から上: BT）とスイムレーン配置を計算し、キャンバスへ反映しています...`,
    });

    logTrace('info', `[4/4 描画] 時系列階層レイアウト（BT: 下から上方向）を計算・描画反映中...`, '描画');

    const totalElapsedSec = ((performance.now() - totalStartTime) / 1000).toFixed(1);
    logTrace(
      'success',
      `[生成完了] VTA図の抽出・描画が完了しました！（合計所要時間: ${totalElapsedSec}秒）`,
      '完了'
    );

    updateProgress({
      stage: 'completed',
      title: '✔ VTA図の生成が完了しました',
      detail: `${sanitizedSchema.lanes.length}レーン・${sanitizedSchema.nodes.length}ノード・${sanitizedSchema.edges.length}エッジのツリー図を表示しました (${totalElapsedSec}秒)`,
    });

    setTimeout(() => {
      useVTAStore.getState().resetGenerationProgress();
    }, 2500);

    return sanitizedSchema;
  } catch (e: unknown) {
    if (e instanceof Error && (e.name === 'UserCancelledError' || e.message === 'USER_CANCELLED')) {
      updateProgress({
        isActive: false,
        stage: 'idle',
        title: '処理が中断されました',
        detail: 'ユーザーにより抽出処理が中断されました。',
      });
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    logTrace('error', `[3/4 解析エラー] ${msg}`, '解析');
    updateProgress({
      stage: 'error',
      title: '✖ VTA構造の解析に失敗しました',
      detail: msg,
    });
    throw new Error(
      `VTA JSONのパースに失敗しました: ${msg}\n\n受信データ:\n${rawResponse}`
    );
  }
}


/**
 * Clean and robustly extracts markdown text from LLM response.
 * Handles thought tags, markdown fences, accidental JSON wrapping, and conversational preambles.
 */
export function cleanMarkdownResponse(raw: string, fallbackField?: 'idealFlow' | 'analysisReport'): string {
  if (!raw || !raw.trim()) return '';

  // 1. Strip reasoning/thought tags like <think>...</think>
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Check if the ENTIRE response is wrapped inside a JSON string or an outer JSON code block
  // (e.g. {"idealFlow": "..."} or ```json\n{"idealFlow": "..."}\n```)
  // CRITICAL FIX: Do NOT trigger on an inner ```json code block inside markdown body text!
  const trimmed = text.trim();
  const isOuterJsonBlock = /^```json\r?\n\s*\{[\s\S]*\}\s*\r?\n```$/i.test(trimmed);
  const isDirectJsonObject = trimmed.startsWith('{') && trimmed.endsWith('}');

  if (isDirectJsonObject || isOuterJsonBlock) {
    try {
      const { jsonString } = extractJSONFromResponse(trimmed);
      const parsed = JSON.parse(jsonString);
      if (parsed && typeof parsed === 'object') {
        if (fallbackField === 'idealFlow') {
          const val = parsed.idealFlow || parsed.ideal_flow || parsed.improvedFlow || parsed.flow || parsed['改善された業務フロー'];
          if (val && typeof val === 'string' && val.trim().length > 10) return val.trim();
        } else if (fallbackField === 'analysisReport') {
          const val = parsed.analysisReport || parsed.analysis_report || parsed.report || parsed.analysis || parsed['分析レポート'];
          if (val && typeof val === 'string' && val.trim().length > 10) return val.trim();
        }
      }
    } catch {}
  }

  // 3. Strip conversational greetings at the beginning if present
  // Strips leading polite preamble lines until the first markdown element or code fence
  const stripPreambles = (str: string): string => {
    const lines = str.split(/\r?\n/);
    while (lines.length > 0) {
      const firstLine = lines[0].trim();
      if (!firstLine) {
        lines.shift();
        continue;
      }
      // If it starts with markdown structure (#, -, *, 1., >, `), stop stripping
      if (/^[#>\-*`]|^[0-9]+\./.test(firstLine)) {
        break;
      }
      // Check if it's a typical AI preamble line
      if (
        /^(?:はい|承知|了解|以下[にが]|ご提示|提示された|お待たせ|ご指示)/.test(firstLine) ||
        /(?:出力します|記載します|提示します|まとめました|ご覧ください)[。:：]?$/.test(firstLine) ||
        /(?:となります|です)[。:：]?$/.test(firstLine)
      ) {
        lines.shift();
        continue;
      }
      break;
    }
    return lines.join('\n').trim();
  };

  text = stripPreambles(text);

  // 4. Unwrap OUTER markdown code fences ONLY if the entire response is wrapped in a code fence.
  // CRITICAL FIX: Do NOT match an inner code block which would discard the surrounding analysis report text!
  const outerBlockRegex = /^```(?:markdown|md|text)?\r?\n([\s\S]*?)\r?\n```$/i;
  const outerMatch = text.match(outerBlockRegex);
  if (outerMatch && outerMatch[1]) {
    text = outerMatch[1].trim();
    // After unwrapping outer fence, strip any preamble that was inside the fence
    text = stripPreambles(text);
  }

  return text;
}



export async function regenerateScenario(
  config: LLMConfig,
  scenarioText: string,
  vtaData: VTASchema,
  signal?: AbortSignal
): Promise<RegenerationResult> {
  const totalStartTime = performance.now();

  const eliminationCount = vtaData.nodes.filter((n) => n.measure_type === 'elimination').length;
  const breakCount = vtaData.edges.filter((e) => e.is_break).length;
  const notesCount = vtaData.nodes.filter((n) => Boolean(n.supplementary_note?.trim())).length;

  const promptConfig = useVTAStore.getState().promptConfig;

  // ---------------------------------------------------------------------------
  // Step 1/3: 集計 (Preparation)
  // ---------------------------------------------------------------------------
  updateProgress({
    isActive: true,
    mode: 'regenerate',
    stage: 'preparing',
    stepCurrent: 1,
    stepTotal: 3,
    title: '【1/3】対策情報の集計・プロンプト準備',
    detail: `排除ノード: ${eliminationCount}件, ブレイク: ${breakCount}件, 補足説明: ${notesCount}件の対策情報を集計中...`,
    elapsedSeconds: 0,
  });

  logTrace(
    'info',
    `[生成 1/3 準備] 適用中の対策: 排除ノード ${eliminationCount}件, ブレイク ${breakCount}件, ノード補足説明 ${notesCount}件`,
    '生成'
  );

  // ---------------------------------------------------------------------------
  // Step 2/3 (1/2): 改善された業務フローの生成 (Flow Generation)
  // ---------------------------------------------------------------------------
  updateProgress({
    stage: 'calling_llm',
    stepCurrent: 2,
    title: '【2/3】改善業務フローを生成中 (LLM 1/2)',
    detail: `モデル: ${config.selectedModel} で対策適用後の業務フローを生成中...`,
  });

  logTrace(
    'info',
    `[生成 2/3 送信] モデル: ${config.selectedModel} へ改善業務フロー生成リクエストを送信 (1/2)`,
    '通信'
  );

  const flowSystemPrompt =
    promptConfig.flowGeneration?.systemPrompt ||
    DEFAULT_PROMPT_CONFIG.flowGeneration?.systemPrompt ||
    promptConfig.regeneration.systemPrompt;
  const flowUserPrompt = buildFlowGenerationUserPrompt(scenarioText, vtaData, promptConfig);

  const flowMessages: ChatMessage[] = [
    { role: 'system', content: flowSystemPrompt },
    { role: 'user', content: flowUserPrompt },
  ];

  const { content: rawFlowResponse, latencyMs: flowLatency } = await callLLMGateway(
    config,
    flowMessages,
    0.3,
    signal
  );

  const cleanFlow = cleanMarkdownResponse(rawFlowResponse, 'idealFlow') || '### 改善された業務フロー\n' + rawFlowResponse;

  logTrace(
    'success',
    `[生成 2/3 完了] 改善された業務フロー生成完了 (${cleanFlow.length}文字, ${flowLatency}ms)`,
    '生成'
  );

  // Check for cancellation between calls
  if (signal?.aborted) {
    const cancelErr = new Error('USER_CANCELLED');
    cancelErr.name = 'UserCancelledError';
    throw cancelErr;
  }

  // ---------------------------------------------------------------------------
  // Step 2/3 (2/2): 分析・対策レポートの生成 (Report Generation)
  // Note: Improved flow text is intentionally NOT passed to avoid bias & circular reasoning
  // ---------------------------------------------------------------------------
  updateProgress({
    stage: 'calling_llm',
    stepCurrent: 2,
    title: '【2/3】VTA対策策定ポイントに基づく分析レポート生成中 (LLM 2/2)',
    detail: `モデル: ${config.selectedModel} で排除ノード・ブレークに基づく8章構成の分析レポートを推論中...`,
  });

  logTrace(
    'info',
    `[生成 2/3 送信] モデル: ${config.selectedModel} へ分析・対策レポート生成リクエストを送信 (2/2)（※改善業務フローは除外し、事故シナリオとVTA対策策定ポイントから独立生成）`,
    '通信'
  );

  const reportSystemPrompt =
    promptConfig.reportGeneration?.systemPrompt ||
    DEFAULT_PROMPT_CONFIG.reportGeneration?.systemPrompt ||
    promptConfig.regeneration.systemPrompt;
  const reportUserPrompt = buildReportGenerationUserPrompt(
    scenarioText,
    vtaData,
    promptConfig
  );

  const reportMessages: ChatMessage[] = [
    { role: 'system', content: reportSystemPrompt },
    { role: 'user', content: reportUserPrompt },
  ];

  const { content: rawReportResponse, latencyMs: reportLatency } = await callLLMGateway(
    config,
    reportMessages,
    0.3,
    signal
  );

  // ---------------------------------------------------------------------------
  // Step 3/3: 整形と構造検証
  // ---------------------------------------------------------------------------
  updateProgress({
    stage: 'parsing',
    stepCurrent: 3,
    title: '【3/3】レポート構造の検証・整形',
    detail: '生成された業務フローと8章構成レポートを検証・整形しています...',
  });

  // Strip thinking tags to obtain actual substantive output length
  const substantiveRaw = rawReportResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const substantiveRawLength = substantiveRaw.length;

  let cleanReport = cleanMarkdownResponse(rawReportResponse, 'analysisReport');

  // Failsafe: If cleanReport suffered catastrophic truncation (>50% drop compared to substantive output),
  // recover the substantive markdown directly to avoid discarding the user's report!
  if (substantiveRawLength > 1000 && cleanReport.length < substantiveRawLength * 0.5) {
    logTrace(
      'warn',
      `[生成 3/3 救済] レポート整形による過剰な削減（${substantiveRawLength}文字 -> ${cleanReport.length}文字）を検知したため、実質本文を直接採用しました。`,
      '生成'
    );
    cleanReport = substantiveRaw;
  }

  // Verify and ensure report content exists, has adequate depth, and retains required structure (FUNC-002)
  const reportTrimmed = cleanReport ? cleanReport.trim() : '';
  const headingMatches = reportTrimmed.match(/^(?:#|##|###)\s+[^\r\n]+/gm) || [];
  const hasAnalysisContent = /エグゼクティブ・サマリー|原因分析|分析|防止可能性|再発防止|まとめ/i.test(reportTrimmed);

  // If report is suspiciously small (< 300 chars) or missing markdown section structure
  if (!reportTrimmed || reportTrimmed.length < 300 || (headingMatches.length < 2 && !hasAnalysisContent)) {
    logTrace(
      'error',
      `[生成 3/3 失敗] LLMからの分析・対策レポート応答が極小または構造不完全です (実質受信: ${substantiveRawLength}文字, 整形後: ${reportTrimmed.length}文字, 見出し数: ${headingMatches.length})`,
      '生成'
    );
    throw new Error(
      `LLMからの分析・対策レポートの応答が不十分でした（実質本文: ${reportTrimmed.length}文字, 見出し数: ${headingMatches.length}）。\n` +
      '8章構成のレポート本文が十分に生成されていないか、見出し構造が欠落しています。\n' +
      'モデルの出力上限（max_tokens）やプロンプト設定を確認の上、再生成を実行してください。'
    );
  }

  logTrace(
    'success',
    `[生成 3/3 完了] 分析・対策レポート生成完了 (${cleanReport.length}文字, 見出し ${headingMatches.length}章, ${reportLatency}ms)`,
    '生成'
  );

  const auditAppendix = formatNormalizationAuditMarkdown(vtaData.analysis?.normalizationAudit);
  if (auditAppendix && !cleanReport.includes('## 付録：入力正規化')) {
    cleanReport = `${cleanReport.trim()}\n\n---\n\n${auditAppendix}`;
  }

  const flowHits = scanGeneratedText(cleanFlow);
  if (flowHits.length) {
    logTrace('warn', `[表現点検] 生成された改善業務フローに評価表現（${[...new Set(flowHits.map((h) => h.phrase))].join('、')}）が含まれています。`, '生成');
  }
  const reportHits = scanGeneratedText(cleanReport);
  if (reportHits.length) {
    logTrace('warn', `[表現点検] 生成された分析レポートに評価表現（${[...new Set(reportHits.map((h) => h.phrase))].join('、')}）が含まれています。`, '生成');
  }

  const result: RegenerationResult = {
    idealFlow: cleanFlow,
    analysisReport: cleanReport,
    generatedAt: new Date().toLocaleTimeString(),
  };

  const totalElapsedSec = ((performance.now() - totalStartTime) / 1000).toFixed(1);
  logTrace(
    'success',
    `[生成完了] 業務フロー (${result.idealFlow.length}文字) および分析レポート (${result.analysisReport.length}文字) の生成が完了しました (合計 ${totalElapsedSec}秒)`,
    '生成'
  );

  updateProgress({
    stage: 'completed',
    stepCurrent: 3,
    title: '✔ 改善業務フロー・分析レポートの生成が完了しました',
    detail: `改善された業務フロー・分析レポートを更新しました (${totalElapsedSec}秒)`,
  });

  setTimeout(() => {
    useVTAStore.getState().resetGenerationProgress();
  }, 2500);

  return result;
}

/**
 * Recommends Elimination Nodes and Break barriers based on the VTA diagram structure
 */
export async function proposeMeasures(
  config: LLMConfig,
  scenarioText: string,
  vtaData: VTASchema,
  signal?: AbortSignal
): Promise<MeasuresProposalResult> {
  const totalStartTime = performance.now();

  const variationCount = vtaData.nodes.filter((n) => n.type === 'variation').length;
  const edgeCount = vtaData.edges.length;

  updateProgress({
    isActive: true,
    mode: 'propose_measures',
    stage: 'preparing',
    stepCurrent: 1,
    stepTotal: 3,
    title: '【1/3】変動要因と伝播経路の集計',
    detail: `変動要因ノード ${variationCount}件・接続エッジ ${edgeCount}本から対策対象を集計しています。`,
    elapsedSeconds: 0,
  });

  logTrace(
    'info',
    `[対策提案 1/3 準備] VTA図解析開始: 変動要因ノード ${variationCount}件, 接続エッジ ${edgeCount}本から対策候補を探索中...`,
    '提案'
  );

  const promptConfig = useVTAStore.getState().promptConfig;
  const messages: ChatMessage[] = [
    { role: 'system', content: promptConfig.proposal.systemPrompt },
    { role: 'user', content: buildProposalUserPrompt(scenarioText, vtaData, promptConfig) },
  ];

  updateProgress({
    isActive: true,
    mode: 'propose_measures',
    stage: 'calling_llm',
    stepCurrent: 2,
    stepTotal: 3,
    title: '【2/3】AI対策（排除・ブレイク）の推論',
    detail: `モデル: ${config.selectedModel} で根本原因の排除と伝播遮断（BREAK）ポイントを立案しています。`,
  });

  logTrace(
    'info',
    `[対策提案 2/3 送信] モデル: ${config.selectedModel} へ対策推薦（排除ノード・ブレイク）リクエストを送信`,
    '通信'
  );

  const { content: rawResponse, latencyMs } = await callLLMGateway(config, messages, 0.2, signal);

  updateProgress({
    stage: 'parsing',
    stepCurrent: 3,
    title: '【3/3】対策候補の検証・整形',
    detail: '受信した排除ノード推薦とブレイク推薦データを検証しています。',
  });

  logTrace(
    'info',
    `[対策提案 3/3 解析] HTTP 200 OK (${latencyMs}ms) - 排除ノードおよびブレイク候補のJSON解析中...`,
    '解析'
  );

  const { jsonString } = extractJSONFromResponse(rawResponse);

  try {
    const parsed = JSON.parse(jsonString);
    const eliminationProposals = Array.isArray(parsed.eliminationProposals)
      ? parsed.eliminationProposals
      : [];
    const breakProposals = Array.isArray(parsed.breakProposals)
      ? parsed.breakProposals
      : [];

    const result: MeasuresProposalResult = {
      summary: parsed.summary || 'AIによるVTA対策提案（排除ノード・ブレイク候補）が生成されました。',
      eliminationProposals,
      breakProposals,
      generatedAt: new Date().toLocaleTimeString(),
    };

    const proposalTexts = [
      result.summary,
      ...eliminationProposals.map((p: any) => `${p.reason ?? ''} ${p.recommendedAction ?? ''}`),
      ...breakProposals.map((p: any) => `${p.reason ?? ''} ${p.recommendedBarrier ?? ''}`),
    ].join('\n');
    const propHits = scanGeneratedText(proposalTexts);
    if (propHits.length) {
      logTrace('warn', `[表現点検] 対策提案テキストに評価表現（${[...new Set(propHits.map((h) => h.phrase))].join('、')}）が含まれています。`, '提案');
    }

    const totalElapsedSec = ((performance.now() - totalStartTime) / 1000).toFixed(1);
    logTrace(
      'success',
      `[対策提案 完了] 排除ノード候補 ${eliminationProposals.length}件, ブレイク候補 ${breakProposals.length}件の提案を生成完了 (${totalElapsedSec}秒)`,
      '提案'
    );

    return result;
  } catch (e: unknown) {
    if (e instanceof Error && (e.name === 'UserCancelledError' || e.message === 'USER_CANCELLED')) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    logTrace('error', `[対策提案 エラー] 提案JSONのパースに失敗しました: ${msg}`, '提案');
    throw new Error(`対策提案データの解析に失敗しました: ${msg}\n\n受信データ:\n${rawResponse}`);
  }
}
