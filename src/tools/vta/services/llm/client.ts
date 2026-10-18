import { LLMConfig, VTASchema, RegenerationResult, MeasuresProposalResult } from '../../types/vta';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { validateAndSanitizeVTASchema } from '../../features/vta/utils/schemaValidator';
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

/**
 * Low-level API caller to Lightweight LLM Gateway (OpenAI Compatible)
 */
export async function callLLMGateway(
  config: LLMConfig,
  messages: ChatMessage[],
  temperature = 0.2,
  externalSignal?: AbortSignal
): Promise<{ content: string; latencyMs: number }> {
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
      logTrace('error', `[通信/エラー] HTTP ${response.status} (${elapsed}ms): ${errorBody}`, '通信');
      throw new Error(`LLM Gateway エラー (${response.status}): ${errorBody}`);
    }

    logTrace(
      'info',
      `[通信/応答] HTTP ${response.status} OK (${elapsed}ms) - レスポンスストリーム読み込み中...`,
      '通信'
    );

    const data = await response.json();

    if (userCancelled || (externalSignal && externalSignal.aborted)) {
      const cancelErr = new Error('USER_CANCELLED');
      cancelErr.name = 'UserCancelledError';
      throw cancelErr;
    }

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
    const sanitizedSchema = valRes.data;

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
      detail: `${parsed.lanes.length}レーン・${parsed.nodes.length}ノード・${parsed.edges.length}エッジのツリー図を表示しました (${totalElapsedSec}秒)`,
    });

    setTimeout(() => {
      useVTAStore.getState().resetGenerationProgress();
    }, 2500);

    return parsed as VTASchema;
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
  // Step 1/4: 準備 (Preparation)
  // ---------------------------------------------------------------------------
  updateProgress({
    isActive: true,
    mode: 'regenerate',
    stage: 'preparing',
    stepCurrent: 1,
    stepTotal: 4,
    title: '【生成 1/4】対策情報の集計・プロンプト準備',
    detail: `排除ノード: ${eliminationCount}件, ブレイク: ${breakCount}件, 補足説明: ${notesCount}件の対策情報を集計中...`,
    elapsedSeconds: 0,
  });

  logTrace(
    'info',
    `[生成 1/4 準備] 適用中の対策: 排除ノード ${eliminationCount}件, ブレイク ${breakCount}件, ノード補足説明 ${notesCount}件`,
    '生成'
  );

  // ---------------------------------------------------------------------------
  // Step 2/4: API呼び出し 1/2 - 改善された業務フローの生成 (Flow Generation)
  // ---------------------------------------------------------------------------
  updateProgress({
    stage: 'calling_llm',
    stepCurrent: 2,
    title: '【生成 2/4】改善業務フローを生成中 (LLM 1/2)',
    detail: `モデル: ${config.selectedModel} で対策適用後の業務フローを生成中...`,
  });

  logTrace(
    'info',
    `[生成 2/4 送信] モデル: ${config.selectedModel} へ改善業務フロー生成リクエストを送信 (1/2)`,
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
    `[生成 2/4 完了] 改善された業務フロー生成完了 (${cleanFlow.length}文字, ${flowLatency}ms)`,
    '生成'
  );

  // Check for cancellation between calls
  if (signal?.aborted) {
    const cancelErr = new Error('USER_CANCELLED');
    cancelErr.name = 'UserCancelledError';
    throw cancelErr;
  }

  // ---------------------------------------------------------------------------
  // Step 3/4: API呼び出し 2/2 - 分析・対策レポートの生成 (Report Generation)
  // Note: Improved flow text is intentionally NOT passed to avoid bias & circular reasoning
  // ---------------------------------------------------------------------------
  updateProgress({
    stage: 'calling_llm',
    stepCurrent: 3,
    title: '【生成 3/4】VTA対策策定ポイントに基づく分析レポート生成中 (LLM 2/2)',
    detail: `モデル: ${config.selectedModel} で排除ノード・ブレークに基づく8章構成の分析レポートを推論中...`,
  });

  logTrace(
    'info',
    `[生成 3/4 送信] モデル: ${config.selectedModel} へ分析・対策レポート生成リクエストを送信 (2/2)（※改善業務フローは除外し、事故シナリオとVTA対策策定ポイントから独立生成）`,
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

  // Strip thinking tags to obtain actual substantive output length
  const substantiveRaw = rawReportResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const substantiveRawLength = substantiveRaw.length;

  let cleanReport = cleanMarkdownResponse(rawReportResponse, 'analysisReport');

  // Failsafe: If cleanReport suffered catastrophic truncation (>50% drop compared to substantive output),
  // recover the substantive markdown directly to avoid discarding the user's report!
  if (substantiveRawLength > 1000 && cleanReport.length < substantiveRawLength * 0.5) {
    logTrace(
      'warn',
      `[生成 3/4 救済] レポート整形による過剰な削減（${substantiveRawLength}文字 -> ${cleanReport.length}文字）を検知したため、実質本文を直接採用しました。`,
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
      `[生成 3/4 失敗] LLMからの分析・対策レポート応答が極小または構造不完全です (実質受信: ${substantiveRawLength}文字, 整形後: ${reportTrimmed.length}文字, 見出し数: ${headingMatches.length})`,
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
    `[生成 3/4 完了] 分析・対策レポート生成完了 (${cleanReport.length}文字, 見出し ${headingMatches.length}章, ${reportLatency}ms)`,
    '生成'
  );

  // ---------------------------------------------------------------------------
  // Step 4/4: 整形と完了 (Completed)
  // ---------------------------------------------------------------------------
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
    stepCurrent: 4,
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

  logTrace(
    'info',
    `[対策提案 2/3 送信] モデル: ${config.selectedModel} へ対策推薦（排除ノード・ブレイク）リクエストを送信`,
    '通信'
  );

  const { content: rawResponse, latencyMs } = await callLLMGateway(config, messages, 0.2, signal);

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
