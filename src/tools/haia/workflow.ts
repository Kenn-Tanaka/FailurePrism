import { createModelResolver, type HaiaModels } from './models.mjs';
import { applyStringOp, bool, safeFilename, seconds, separator, splitLines, stringOp, type Attributes } from './stringOps';

type Metadata = Record<string, string>;
export interface StepResult { text: string; meta?: Metadata }
export type LocalStep = 'youtube_subtitle' | 'file_read' | 'file_write' | 'convert';

export interface ExecutionOptions {
  models: HaiaModels | null;
  selectedAlias?: string;
  tasks: Record<string, string>;
  temperature: number;
  timeout: number;
  signal: AbortSignal;
  generate: (request: {
    model: string; system: string; input: string; temperature: number; timeout: number;
  }, onChunk: (chunk: string) => void) => Promise<string>;
  local: (type: LocalStep, attributes: Attributes, input: string, filename: string) => Promise<StepResult>;
  onChunk: (chunk: string) => void;
  onLog: (text: string) => void;
}

const STEP_TYPES = new Map(Object.entries({
  for_each: 'foreach', 'for-each': 'foreach', loop: 'foreach',
  wait: 'sleep', delay: 'sleep',
  pass: 'passthrough', copy: 'passthrough', raw: 'passthrough',
  youtube_subtitles: 'youtube_subtitle', youtube_transcript: 'youtube_subtitle',
  text: 'string', str: 'string', string_op: 'string', text_op: 'string',
  sanitizer: 'sanitize', filename_sanitize: 'sanitize', sanitize_filename: 'sanitize',
}));

const elements = (parent: Element, tag: string) => Array.from(parent.childNodes)
  .filter((node): node is Element => node.nodeType === 1 && node.nodeName === tag);
const child = (parent: Element, tag: string) => elements(parent, tag)[0];

function elementText(element?: Element): string {
  let text = '';
  for (const node of Array.from(element?.childNodes ?? [])) {
    if (node.nodeType === 1) break;
    if (node.nodeType === 3 || node.nodeType === 4) text += node.nodeValue ?? '';
  }
  return text;
}

export function looksLikeWorkflow(source: string): boolean {
  return /^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)*<workflow(?=[\s/>])/i.test(source);
}

export function preparePrompt(source: string): string {
  return splitLines(source).filter(line => !/^\s*(\/\/|;)/.test(line)).join('\n').trim();
}

function resolveTask(ref: string, tasks: Record<string, string>): string {
  if (Object.hasOwn(tasks, ref)) return tasks[ref];
  const code = /^[A-Za-z0-9_]+/.exec(ref)?.[0];
  const candidates = Object.keys(tasks).filter(name =>
    code && (name === code || [' ', ':', '-'].some(separator => name.startsWith(code + separator))),
  );
  if (candidates.length === 1) return tasks[candidates[0]];
  if (candidates.length > 1) throw new Error('タスク参照「' + ref + '」が複数に一致します。');
  throw new Error('タスク参照「' + ref + '」が見つかりません。');
}

function systemPrompt(step: Element, attr: Attributes, tasks: Record<string, string>): string {
  const inline = elementText(child(step, 'system')).trim();
  const ref = attr.ref?.trim();
  const source = ref ? resolveTask(ref, tasks).trim() : '';
  if (!inline && !source) throw new Error('ref または system が必要です。');
  if (!inline || !source) return preparePrompt(inline || source);
  switch ((attr.system_merge || 'replace').trim().toLowerCase()) {
    case 'replace': return preparePrompt(inline);
    case 'append': return preparePrompt(source + '\n\n' + inline);
    case 'prepend': return preparePrompt(inline + '\n\n' + source);
    default: throw new Error('system_merge の指定が不正です。');
  }
}

export async function wait(seconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let remaining = seconds * 1000;
  while (remaining > 0) {
    const duration = Math.min(remaining, 2_147_483_647);
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, duration);
      signal.addEventListener('abort', stop, { once: true });
    });
    signal.throwIfAborted();
    remaining -= duration;
  }
}

function resultNode(doc: Document, step: Element): Element {
  const existing = child(step, 'result');
  if (existing) return existing;
  const result = doc.createElement('result');
  step.appendChild(result);
  return result;
}

function saveResult(doc: Document, step: Element, result: StepResult): void {
  const node = resultNode(doc, step);
  node.textContent = result.text;
  for (const [key, value] of Object.entries(result.meta ?? {})) node.setAttribute(key.toLowerCase(), value);
}

export async function runWorkflow(
  source: string,
  documentText: string,
  options: ExecutionOptions,
): Promise<{ text: string; xml: string }> {
  // Browser DOMParser does not fetch external entities. Reject declarations consistently across parsers.
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('DOCTYPE と ENTITY は使用できません。');
  const doc = new DOMParser().parseFromString(source.trim(), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement?.nodeName.toLowerCase() !== 'workflow') {
    throw new Error('ワークフロー XML を解析できません。ルート要素とタグの対応を確認してください。');
  }
  const modelFor = options.models ? createModelResolver(options.models) : undefined;

  async function execute(
    root: Element, inputText: string, depth: number, initialVars: Metadata = {}, stream = true,
  ): Promise<{ text: string; outputs: Map<string, string> }> {
    if (depth > 5) throw new Error('ワークフローのネストが深すぎます（最大5階層）。');
    const values = new Map(Object.entries({ DOCUMENT_X: inputText, ...initialVars }));
    const outputs = new Map<string, string>();
    const write = stream ? options.onChunk : undefined;
    const expand = (text: string) => text.replace(/\[\[([^\]]+)\]\]/g, (match, name: string) => {
      const key = name.trim();
      const value = values.get(key);
      if (value !== undefined) return value;
      if (/\.(KEY_VENDOR|KEY_SLOT)$/.test(key) && values.has(key.slice(0, key.lastIndexOf('.')))) {
        throw new Error('旧認証メタ情報「' + key + '」を修正してください。');
      }
      return match;
    });
    let last = '';

    for (const step of elements(root, 'step')) {
      options.signal.throwIfAborted();
      const attr = Object.fromEntries(Array.from(step.attributes, attribute => [attribute.name, attribute.value]));
      const id = attr.id?.trim() ?? '';
      const originalType = (attr.type || 'llm').trim().toLowerCase();
      const type = STEP_TYPES.get(originalType) ?? originalType;
      const label = id || type;
      options.onLog('実行中: ' + label);
      write?.(`<${label}>\n`);
      try {
        if (['model_name', 'model_id', 'key_slot'].some(key => Object.hasOwn(attr, key))) {
          throw new Error('旧モデル・認証属性を修正してください。モデルは alias で指定します。');
        }
        const input = expand(elementText(child(step, 'input')));
        const filename = expand(elementText(child(step, 'file_name')));
        let result: StepResult;
        switch (type) {
          case 'workflow': {
            const nested = child(step, 'workflow');
            if (!nested) throw new Error('子 workflow が必要です。');
            const nestedResult = await execute(nested.cloneNode(true) as Element, input, depth + 1, {}, false);
            for (const [key, value] of nestedResult.outputs) {
              values.set(id + '.' + key, value);
              outputs.set(key, value);
            }
            values.set(id + '.final', nestedResult.text);
            result = { text: nestedResult.text };
            break;
          }
          case 'foreach': {
            const nested = child(step, 'workflow');
            if (!nested) throw new Error('子 workflow が必要です。');
            if (!['line', 'lines'].includes((attr.source || 'lines').trim().toLowerCase())) {
              throw new Error('foreach の source は lines です。');
            }
            const variable = attr.item_var?.trim();
            if (variable && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
              throw new Error('item_var の名前が不正です。');
            }
            const trim = bool(attr.trim, true);
            const skipEmpty = bool(attr.skip_empty, true);
            const unique = bool(attr.unique);
            const lines = splitLines(input);
            const items = lines.map(line => trim ? line.trim() : line).filter(line => !skipEmpty || line !== '');
            const selectedItems = unique ? [...new Set(items)] : items;
            const joiner = separator(attr.separator);
            const continueOnError = bool(attr.continue_on_error);
            const delay = seconds(attr.delay || attr.interval || attr.sleep_between, 0);
            const errors: string[] = [];
            const texts: string[] = [];
            const records: Element[] = [];
            for (const [index, item] of selectedItems.entries()) {
              options.signal.throwIfAborted();
              const record = doc.createElement('item');
              record.setAttribute('index', String(index + 1));
              record.setAttribute('index0', String(index));
              record.setAttribute('value', item);
              records.push(record);
              const vars = {
                PARENT_DOCUMENT_X: inputText, ITEM: item, ITEM_INDEX: String(index + 1),
                ITEM_INDEX0: String(index), ITEM_COUNT: String(selectedItems.length),
                ...(variable ? { [variable]: item } : {}),
              };
              try {
                const itemResult = await execute(nested.cloneNode(true) as Element, item, depth + 1, vars, stream);
                texts.push(itemResult.text);
                record.setAttribute('ok', 'true');
                record.textContent = itemResult.text;
              } catch (error) {
                options.signal.throwIfAborted();
                if (!continueOnError) throw error;
                const message = error instanceof Error ? error.message : String(error);
                const itemError = '[' + (index + 1) + '/' + selectedItems.length + '] ' + item + ': ' + message;
                errors.push(itemError);
                record.setAttribute('ok', 'false');
                record.setAttribute('error', message);
                options.onLog(itemError);
              }
              if (index + 1 < selectedItems.length) await wait(delay, options.signal);
            }
            const text = texts.join(joiner);
            const meta = {
              COUNT: String(selectedItems.length), SKIPPED_COUNT: String(lines.length - selectedItems.length),
              OK_COUNT: String(texts.length), ERROR_COUNT: String(errors.length),
              RESULTS: text, ERRORS: errors.join(joiner), SEPARATOR: joiner,
            };
            result = { text, meta };
            saveResult(doc, step, {
              text,
              meta: {
                COUNT: meta.COUNT, SKIPPED_COUNT: meta.SKIPPED_COUNT, OK_COUNT: meta.OK_COUNT,
                ERROR_COUNT: meta.ERROR_COUNT, ERRORS: meta.ERRORS, CONTINUE_ON_ERROR: String(continueOnError),
              },
            });
            for (const record of records) resultNode(doc, step).appendChild(record);
            break;
          }
          case 'passthrough': result = { text: input }; break;
          case 'sleep': {
            const duration = seconds(attr.duration || attr.seconds || attr.time || input, 1);
            write?.(`[WAIT] ${duration} seconds`);
            await wait(duration, options.signal);
            result = { text: '' };
            break;
          }
          case 'string': case 'sanitize': {
            const text = type === 'string' ? applyStringOp(input, attr) : safeFilename(input);
            result = { text, meta: { CHARS: String([...text].length), ORIGINAL_CHARS: String([...input].length) } };
            if (type === 'string') {
              result.meta!.OP = stringOp(attr);
              result.meta!.LINES = String(splitLines(text).length);
            }
            break;
          }
          case 'file_read': case 'file_write': case 'convert': case 'youtube_subtitle':
            result = await options.local(type, attr, input, filename);
            if (type === 'youtube_subtitle') {
              await wait(seconds(attr.sleep_after || attr.delay_after, 0), options.signal);
            }
            break;
          case 'llm': {
            if (!modelFor) throw new Error('Alias の設定を確認してください。');
            const resolved = modelFor(attr.alias?.trim() || root.getAttribute('default_model_alias')?.trim() || options.selectedAlias);
            if (resolved.requestedAlias !== resolved.alias) {
              options.onLog('Alias「' + resolved.requestedAlias + '」が未登録のため「' + resolved.alias + '」を使用します（' + label + '）。');
            }
            const temperature = attr.temperature?.trim() ? Number(attr.temperature) : options.temperature;
            if (!Number.isFinite(temperature)) throw new Error('temperature の値が不正です。');
            const text = await options.generate({
              model: resolved.model.id, system: systemPrompt(step, attr, options.tasks), input, temperature,
              timeout: seconds(attr.timeout, options.timeout),
            }, write ?? (() => {}));
            result = { text, meta: { MODEL: resolved.model.name, MODEL_ID: resolved.model.id, MODEL_ALIAS: resolved.alias } };
            break;
          }
          default: throw new Error('未対応のステップ種別（' + type + '）。');
        }
        options.signal.throwIfAborted();
        last = result.text;
        values.set(id, result.text);
        outputs.set(id, result.text);
        for (const [key, value] of Object.entries(result.meta ?? {})) values.set(id + '.' + key, value);
        if (type !== 'foreach' && type !== 'sleep') {
          saveResult(doc, step, type === 'llm' ? { text: result.text } : result);
        }
        if (type !== 'llm' && type !== 'foreach' && result.text) write?.(result.text);
      } catch (error) {
        options.signal.throwIfAborted();
        throw new Error('ステップ「' + label + '」: ' + (error instanceof Error ? error.message : String(error)), { cause: error });
      } finally {
        if (!options.signal.aborted) write?.(`\n</${label}>\n`);
      }
    }
    return { text: values.get('final_output') ?? values.get('final') ?? last, outputs };
  }

  const result = await execute(doc.documentElement, documentText, 0);
  return { text: result.text, xml: new XMLSerializer().serializeToString(doc.documentElement) };
}
