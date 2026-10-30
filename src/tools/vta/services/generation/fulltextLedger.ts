import { RELATION_CONTRACT_VERSION } from '../../features/vta/utils/relationContract';
import { fingerprint } from './registry';
import {debugRecorder} from '../debugRecorder';
import type { LLMConfig, VTASource, PromptConfig, VTAAnalysisData } from '../../types/vta';
import { parseLedger, inspectLedger, applyLedgerRepair, ledgerRepairInput, formatLedgerIssue, type LedgerDocument } from '../../features/vta/utils/eventLedger';
type LedgerCall=(stage:'normalization'|'classification',config:LLMConfig,text:string,signal?:AbortSignal,repair?:boolean,prompts?:PromptConfig)=>Promise<string>;
type LedgerLog=(type:'info'|'success'|'warn'|'error',message:string,stage?:string)=>void;
// Keep accepted rows across a failed repair. A retry in this project can resume without another full pass.
const pendingLedgers = new Map<string, LedgerDocument>();
export async function normalizeSource(config: LLMConfig, source: VTASource, signal: AbortSignal|undefined, context: string, fixedPrompts: PromptConfig, projectId: string, callLedgerStage: LedgerCall, logTrace: LedgerLog): Promise<VTAAnalysisData> {
  const runId=crypto.randomUUID();
  const debugSession=debugRecorder.getSnapshot();
  let repairMs=0;
  logTrace('info',`[台帳検証] 実行=${runId} 契約=${RELATION_CONTRACT_VERSION} プロンプト=${fingerprint(JSON.stringify(fixedPrompts))} モデル=${config.selectedModel}`,'解析');
  const cacheKey = projectId + '\0' + config.baseUrl + '\0' + config.selectedModel + '\0' + source.text + '\0' + source.paragraphs.map((part) => part.id + ':' + part.text).join('\n') + '\0' + context + '\0fulltext-ledger/1/normalization\0' + JSON.stringify(fixedPrompts);
  if (signal?.aborted) throw new Error('USER_CANCELLED');
  let doc = pendingLedgers.get(cacheKey);
  if (!doc) {
    const text = await callLedgerStage('normalization', config, source.paragraphs.map((part) => '[' + part.id + '] ' + part.text).join('\n') + context, signal, false, fixedPrompts);
    doc = parseLedger(text);
    if (pendingLedgers.size >= 3) pendingLedgers.delete(pendingLedgers.keys().next().value!);
    pendingLedgers.set(cacheKey, doc);
  } else logTrace('info', '[台帳再開] 受信済みの行を保持し、修復から再開します。', '解析');
  let repairFailure = '';
  const rowContent=(value:LedgerDocument)=>JSON.stringify(value.rows.map(({section,id,cells})=>({section,id,cells})));
  const seen=new Set([rowContent(doc)]);
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (signal?.aborted) throw new Error('USER_CANCELLED');
    const result = inspectLedger(doc, source);
    if(debugSession.enabled)debugRecorder.record('ledger.validation',()=>({runId,attempt,rows:doc!.rows,issues:result.issues,analysis:result.analysis}),debugSession.sessionId,[config.gatewayToken??'']);
    if (result.analysis) {
      pendingLedgers.delete(cacheKey);
      logTrace('info',`[台帳検証/完了] 実行=${runId} 修復=${attempt}回 追加待ち=${repairMs}ms`,'解析');
      logTrace('success', '[全文正規化] TSV台帳の形式・ID・原文参照を確認しました。', '解析');
      const outcome=result.analysis.outcome;
      if(!outcome) logTrace('warn','[帰結/未確認] 帰結の抽出確認行がありません。損失イベントの有無と割当を確認してください。','解析');
      else if(outcome.status!=='identified') logTrace('warn','[帰結/要確認] '+outcome.reason,'解析');
      else { const hidden=outcome.eventIds.filter(id=>!result.analysis!.cards.some(c=>c.eventIds.includes(id))); logTrace(hidden.length?'warn':'info','[帰結/確認待ち] '+outcome.eventIds.join(', ')+(hidden.length?'（主体未割当で図上に出ない帰結：'+hidden.join(', ')+ '）':''),'解析'); }
      return result.analysis;
    }
    if (attempt === 2) { pendingLedgers.delete(cacheKey); throw new Error('台帳を修復できませんでした。次回は全文から再取得します。' + (repairFailure || result.issues.map(formatLedgerIssue).join('、'))); }
    const request = ledgerRepairInput(doc, result.issues, source);
    logTrace('warn', '[台帳修復] ' + result.issues.map(formatLedgerIssue).join('、') + ' 対象行だけを再取得します（' + (attempt + 1) + '/2、修復指示 ' + request.length + '文字）。', '解析');
    const started=Date.now();
    let reply: string;
    try { reply = await callLedgerStage('normalization', config, request, signal, true, fixedPrompts); }
    catch (error) {
      if (signal?.aborted) throw error;
      logTrace('warn', '[台帳保持] 修復通信は失敗しました。受信済みの行は保持しています。同じ入力・モデル・プロジェクトで再実行すると修復から再開します。', '解析');
      throw error;
    }
    repairMs+=Date.now()-started;
    try {
      const next = applyLedgerRepair(doc, result.issues, reply);
      if (seen.has(rowContent(next))) { pendingLedgers.delete(cacheKey); throw new Error('修復内容が変わらないため停止しました。次回は全文から再取得します。'); }
      seen.add(rowContent(next));doc = next; pendingLedgers.set(cacheKey, doc); repairFailure = '';
    }
    catch (error) { repairFailure = error instanceof Error ? error.message : String(error); if (repairFailure.includes('修復内容が変わらない')) throw error; logTrace('warn', '[台帳修復] ' + repairFailure + ' 正常な行は保持しました。', '解析'); }
  }
  throw new Error('台帳を構成できませんでした。');
}

