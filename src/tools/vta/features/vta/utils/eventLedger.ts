import {isSubjectInferred} from './subjectInference';
import {relationAttributes,RelationContractError,RELATION_CONTRACT_PROMPT,validateRelationEndpoints} from './relationContract';
import { dependencyProblem } from './eventOrder';
import type {
  VTAAnalysisData,
  VTAEvent,
  VTAEventRelation,
  VTAOutcomeKind,
  VTAParticipation,
  VTASource,
  VTASourceRef,
  VTASubjectiveNotice,
  VTATextCorrection,
} from '../../../types/vta';
import { buildAnalysis, isIdentifiedOutcomeEvent, promotePreliminaryOutcomes, validateParticipants } from './eventAnalysis';
import { scanGeneratedText } from './subjectiveExpressions';
import { participatesViaPoset, SubjectPoset } from './subjectPoset';
import { compareTimeIntervals, ensureEventTimeDAG, isPrecedenceRelation, parseTimeInterval } from './eventTimePoset';
import { extractVariationFactorFromReason } from './variationFactor';
export { extractVariationFactorFromReason };

export const LEDGER_HEADERS = {
  主体: ['ID', '名称', '種類', '報告焦点', '所属・上位主体', '焦点根拠'],
  イベント: ['ID', '時刻', '見出し', '内容', '主体と役割', '原文参照', '区分'],
  関係: ['ID', '種類', '元イベント', '元主体', '先イベント', '先主体', '原文参照', 'リソース', '実施状態', '受領確認'],
  共有カード: ['ID', '主体', 'イベント'],
  整理: ['ID', '区分', '原文参照', '要旨', '理由'],
  判定: ['ID', '判定', '理由', '原文参照'],
  帰結: ['ID', '判定', 'イベントID', '原文参照', '理由'],
  表記: ['ID', '種別', '原文表記', '統一後', '原文参照', '理由'],
  表現: ['ID', '原文参照', '検知語句', '処理', 'イベントID', '理由'],
  仮判定: ['イベントID', '判定', '理由', '原文参照'],
} as const;
const LEGACY_SUBJECT_HEADER = 'ID\t名称\t種類';
type Section = keyof typeof LEDGER_HEADERS;
export interface LedgerRow { section: Section; id: string; cells: string[]; line: number; }
export interface LedgerIssue { row: LedgerRow; message: string; code?:string; kind?:string; field?:string; actual?:string; expected?:string; }
export interface LedgerDocument { rows: LedgerRow[]; }
export interface ParseLedgerOptions {
  partial?: boolean;
  defaultSection?: Section;
  allowMissingComplete?: boolean;
}

const SECTION_ID_PREFIX: Record<Section, string> = {
  主体: 'A',
  イベント: 'E',
  関係: 'R',
  共有カード: 'G',
  整理: 'D',
  判定: 'E',
  帰結: 'out',
  表記: 'C',
  表現: 'S',
  仮判定: 'E',
};
const NON_REFERENCED_ID_SECTIONS = new Set<Section>(['関係', '帰結', '共有カード', '整理', '表記', '表現']);

const HEADER_TO_SECTION = new Map<string, Section>();
for (const [secName, headers] of Object.entries(LEDGER_HEADERS)) {
  HEADER_TO_SECTION.set(headers.join('\t'), secName as Section);
}
HEADER_TO_SECTION.set(LEGACY_SUBJECT_HEADER, '主体');
/**
 * Sections whose column headers differ only in the first cell. Inside an explicitly titled (or default)
 * section, the counterpart header is treated as a header of the current section instead of a section switch.
 */
const CONFUSABLE_HEADER_SECTIONS: Partial<Record<Section, Section>> = {
  判定: '仮判定',
  仮判定: '判定',
};

export function formatLedgerIssue(issue: LedgerIssue): string {
  const clean=(value:string)=>value.replace(/[\r\n\t\u0000-\u001f]+/g,' ').slice(0,100);
  const details=[issue.code,issue.kind,issue.field,issue.actual!==undefined?'受信='+clean(issue.actual):undefined,issue.expected?'許容='+clean(issue.expected):undefined].filter(Boolean).join(' / ');
  return `${issue.row.section}/${issue.row.id}: ${clean(issue.message)}${details?' ['+details+']':''}`;
}
const cell = (value: string) => value === '-' ? '' : value;
const list = (value: string) => value === '-' ? [] : value.split(',').map((id) => id.trim());
const isPlaceholderCell = (val: string) => {
  const v = val.trim().toLowerCase();
  return (
    !v ||
    /^[-—ー=*_|: ]+$/.test(v) ||
    v === 'なし' ||
    v === '(なし)' ||
    v === '（なし）' ||
    /^(?:該当|対象|記載|特に|該当する項目は)?.*(?:なし|ありません)$/.test(v) ||
    v === '無' ||
    v === 'none' ||
    v === 'n/a' ||
    v === 'na' ||
    v === 'null'
  );
};
const isPlaceholderRow = (cells: string[]) => cells.length > 0 && cells.every(isPlaceholderCell);
const validId = (value: string) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !Object.prototype.hasOwnProperty.call(Object.prototype, value);
const key = (row: LedgerRow) => `${row.section}/${row.id}`;

/** Text framing only. Never guess columns, fix meaning, or discard an unrecognized line. */
export function parseLedger(text: string, partialOrOptions: boolean | ParseLedgerOptions = false): LedgerDocument {
  const options: ParseLedgerOptions = typeof partialOrOptions === 'boolean'
    ? { partial: partialOrOptions }
    : (partialOrOptions ?? {});
  const partial = !!options.partial;
  const allowMissingComplete = options.allowMissingComplete ?? partial;

  let cleaned = text.replace(/^\uFEFF/, '').trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    .replace(/^```(?:tsv|text)?\s*\n/i, '')
    .replace(/\n```$/, '').trim();

  // Strip leading conversational preamble lines if present before sections/headers/TSV rows
  const rawLines = cleaned.split(/\r?\n/);
  while (rawLines.length > 0) {
    const first = rawLines[0].trim();
    if (!first || first.startsWith('```')) {
      rawLines.shift();
      continue;
    }
    if (/^\[[^\]]+\]$/.test(first) || HEADER_TO_SECTION.has(first)) {
      break;
    }
    const firstCell = first.split('\t')[0].trim();
    if (first.includes('\t') && validId(firstCell)) {
      break;
    }
    if (
      /^(?:はい|承知|了解|以下[にが]|ご提示|提示された|お待たせ|ご指示)/.test(first) ||
      /(?:出力します|記載します|提示します|まとめました|ご覧ください|判定結果)[。:：]?$/.test(first) ||
      /(?:となります|です)[。:：]?$/.test(first)
    ) {
      rawLines.shift();
      continue;
    }
    break;
  }

  let section: Section | undefined;
  // Section fixed by an explicit [title] (or by the caller's defaultSection). A column header of the
  // confusable counterpart section must not silently move rows out of it (see CONFUSABLE_HEADER_SECTIONS).
  let anchoredSection: Section | undefined = options.defaultSection;
  const seenSections = new Set<string>();
  const seenRows = new Set<string>();
  const rows: LedgerRow[] = [];
  let completed = false;
  for (const [index, raw] of rawLines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    if (completed) throw new Error('台帳の完了記号の後にデータがあります。');
    if (line === '[完了]') { completed = true; continue; }
    const title = /^(?:#{1,6}\s*|\*{1,2})?\[\s*([^\]]+?)\s*\](?:\*{1,2})?$/.exec(line);
    if (title) {
      const secName = title[1].trim();
      if (!Object.hasOwn(LEDGER_HEADERS, secName)) throw new Error(`未知の台帳セクション: ${secName}`);
      section = secName as Section;
      anchoredSection = section;
      if (seenSections.has(section)) throw new Error(`台帳セクション ${section} が重複しています。`);
      seenSections.add(section);
      continue;
    }
    const headerSection = HEADER_TO_SECTION.get(line);
    if (headerSection && anchoredSection && (!section || section === anchoredSection) && CONFUSABLE_HEADER_SECTIONS[anchoredSection] === headerSection) {
      // e.g. "ID\t判定\t理由\t原文参照" written under [仮判定]: read it as the anchored section's header.
      if (!section) {
        section = anchoredSection;
        seenSections.add(section);
      }
      continue;
    }
    if (headerSection) {
      if (section !== headerSection) {
        section = headerSection;
        if (seenSections.has(section)) throw new Error(`台帳セクション ${section} が重複しています。`);
        seenSections.add(section);
      }
      continue;
    }
    if (!section) {
      if (options.defaultSection) {
        section = options.defaultSection;
        seenSections.add(section);
      } else {
        throw new Error(`台帳 ${index + 1}行目のセクションがありません。`);
      }
    }
    let cells = raw.includes('\t')
      ? raw.split('\t').map((value) => value.trim())
      : line.startsWith('|') && line.endsWith('|')
        ? line.slice(1, -1).split('|').map((v) => v.trim())
        : /\s{2,}/.test(line)
          ? line.split(/\s{2,}/).map((value) => value.trim())
          : [line];
    const stripMarkdown = (s: string) => s.replace(/^\*\*|\*\*$/g, '').trim();
    if (cells.map(stripMarkdown).join('\t') === LEDGER_HEADERS[section].join('\t')) continue;
    if (section === '主体' && cells.map(stripMarkdown).join('\t') === LEGACY_SUBJECT_HEADER) continue;
    if (isPlaceholderRow(cells)) continue;

    // 1. セル内改行による折り返し行の自動結合（直前行の末尾セルへ結合）
    const expectedCols = LEDGER_HEADERS[section].length;
    const prevRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
    if (
      !validId(cells[0]) &&
      prevRow &&
      prevRow.section === section &&
      prevRow.cells.length < expectedCols &&
      prevRow.cells.length + cells.length - 1 <= expectedCols
    ) {
      prevRow.cells[prevRow.cells.length - 1] = `${prevRow.cells[prevRow.cells.length - 1]} ${cells[0]}`.trim();
      for (let i = 1; i < cells.length; i++) {
        prevRow.cells.push(cells[i]);
      }
      continue;
    }

    let isAutoId = false;
    // 1. 省略された先頭ID列の補完（[帰結]の4列出力、[共有カード]の2列出力）
    if (section === '帰結' && cells.length === 4 && ['identified', 'not_found', 'uncertain'].includes(cells[0])) {
      cells = [`out_${index + 1}`, ...cells];
      isAutoId = true;
    } else if (section === '共有カード' && cells.length === 2 && validId(cells[0])) {
      cells = [`G_${index + 1}`, ...cells];
      isAutoId = true;
    }

    // 2. ID文字列の装飾・記号の正規化（[E1] -> E1, 1 -> D_1 / out_1, R1.1 -> R1_1）
    const cleanedId = cells[0].replace(/^[\[「『"'(\s]+|[\]」』"')：:\s]+$/g, '');
    if (validId(cleanedId)) {
      cells[0] = cleanedId;
    } else if (/^\d+$/.test(cleanedId)) {
      cells[0] = `${SECTION_ID_PREFIX[section]}_${cleanedId}`;
    } else if (/^[A-Za-z][A-Za-z0-9_.:/-]*$/.test(cleanedId)) {
      const sanitized = cleanedId.replace(/[^A-Za-z0-9_-]/g, '_');
      if (validId(sanitized)) cells[0] = sanitized;
    }

    // 3. 他から参照されないセクション（帰結・整理・共有カード・表記・表現）で先頭IDが - 等の場合は自動採番
    if (!validId(cells[0]) && cells.length >= 2 && NON_REFERENCED_ID_SECTIONS.has(section)) {
      if (isPlaceholderCell(cells[0]) && cells.length === expectedCols) {
        cells[0] = `${SECTION_ID_PREFIX[section]}_${index + 1}`;
      } else if (cells.length === expectedCols - 1) {
        cells = [`${SECTION_ID_PREFIX[section]}_${index + 1}`, ...cells];
      } else {
        cells[0] = `${SECTION_ID_PREFIX[section]}_${index + 1}`;
      }
      isAutoId = true;
    }

    if (!validId(cells[0])) {
      throw new Error(
        `台帳 ${index + 1}行目のIDが不正です（セクション=${section}、先頭セル="${cells[0].slice(0, 50)}"）。タブ区切りで出力してください。`
      );
    }

    if (isAutoId) {
      let rowId = cells[0];
      let counter = 1;
      while (seenRows.has(`${section}/${rowId}`)) {
        rowId = `${cells[0]}_${++counter}`;
      }
      cells[0] = rowId;
    }

    if (seenRows.has(`${section}/${cells[0]}`)) {
      if (NON_REFERENCED_ID_SECTIONS.has(section)) {
        let disambiguated = cells[0];
        let counter = 1;
        while (seenRows.has(`${section}/${disambiguated}`)) {
          disambiguated = `${cells[0]}_${++counter}`;
        }
        cells[0] = disambiguated;
      } else {
        throw new Error(`台帳のID ${section}/${cells[0]} が重複しています。`);
      }
    }

    const row = { section, id: cells[0], cells, line: index + 1 };
    seenRows.add(key(row));
    rows.push(row);
  }
  if (!completed && !allowMissingComplete) throw new Error('台帳の[完了]がありません。途中の応答は採用しません。');
  if (!partial && ['主体', 'イベント', '関係', '共有カード', '整理'].some((name) => !seenSections.has(name))) throw new Error('台帳の必須セクションが不足しています。空のセクションも明記してください。');
  return { rows };
}

export function readSourceRefs(raw: unknown, sources: VTASource[], required = true): VTASourceRef[] {
  if (!Array.isArray(raw) || (required && !raw.length)) throw new Error('原文参照が必要です。');
  const refs = raw.map((ref) => {
    if (!ref || typeof ref !== 'object' || typeof ref.sourceId !== 'string' || typeof ref.paragraphId !== 'string'
      || !sources.some((source) => source.id === ref.sourceId && source.paragraphs.some((part) => part.id === ref.paragraphId))) throw new Error('原文参照が存在しません。');
    return { sourceId: ref.sourceId, paragraphId: ref.paragraphId };
  });
  if (new Set(refs.map((ref) => `${ref.sourceId}/${ref.paragraphId}`)).size !== refs.length) throw new Error('原文参照が重複しています。');
  return refs;
}

export function normalizeRefTokens(value: string, source: VTASource): string[] {
  if (!value || value.trim() === '-') return [];
  const validIds = source.paragraphs.map((p) => p.id);
  const validSet = new Set(validIds);
  const lowerMap = new Map(validIds.map((id) => [id.toLowerCase(), id]));
  const tokens = value.split(/[,\u3001]+/).map((t) => t.trim()).filter(Boolean);
  const result: string[] = [];

  for (const rawToken of tokens) {
    let token = rawToken.replace(/^[\[「『"']+|[\]」』"']+$/g, '').trim();
    if (token.startsWith(source.id + '/')) {
      token = token.slice((source.id + '/').length).trim();
    }
    if (!token || token === '-') continue;

    // 範囲表記 (例: p10-p12, p10〜p12, p10~p12, p10–p12, p10—p12) の展開
    const rangeMatch = /^(p\d+)\s*[-~〜–—]\s*(p?\d+)$/i.exec(token);
    if (rangeMatch) {
      const startKey = rangeMatch[1].toLowerCase();
      const endRaw = rangeMatch[2].toLowerCase();
      const endKey = endRaw.startsWith('p') ? endRaw : `p${endRaw}`;
      const startId = lowerMap.get(startKey);
      const endId = lowerMap.get(endKey);
      if (startId && endId) {
        const startIdx = validIds.indexOf(startId);
        const endIdx = validIds.indexOf(endId);
        if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
          for (let i = startIdx; i <= endIdx; i++) {
            if (!result.includes(validIds[i])) result.push(validIds[i]);
          }
          continue;
        }
      }
    }

    // 大文字小文字の補正 (P10 -> p10) または有効な段落ID / 段落形式トークン
    if (validSet.has(token)) {
      if (!result.includes(token)) result.push(token);
    } else if (lowerMap.has(token.toLowerCase())) {
      const normalized = lowerMap.get(token.toLowerCase())!;
      if (!result.includes(normalized)) result.push(normalized);
    } else if (/^p\d+$/i.test(token)) {
      if (!result.includes(token)) result.push(token);
    }
  }

  return result;
}

function refsFromCell(value: string, source: VTASource, required = true) {
  const tokens = normalizeRefTokens(value, source);
  const finalTokens = tokens.length > 0 || !value || value.trim() === '-' ? tokens : list(value);
  return readSourceRefs(finalTokens.map((paragraphId) => ({ sourceId: source.id, paragraphId })), [source], required);
}

export const cleanPunctuation = (text: string): string =>
  text.replace(/[「」『』""''“”‘’（）()【】\[\]〔〕《》\s、。，．,\.]/g, '');

/** Only syntax, enums and references. Atomic events, identities, timing and relevance are LLM decisions. */
export function inspectLedger(doc: LedgerDocument, source: VTASource): { issues: LedgerIssue[]; softIssues?: LedgerIssue[]; warnings?: string[]; analysis?: VTAAnalysisData } {
  const issues: LedgerIssue[] = [];
  const warnings: string[] = [];
  const misplacedClassificationRows = doc.rows.filter((row) => row.section === '判定');
  if (misplacedClassificationRows.length) {
    // Classification is a later, separate stage. Discard the rows (non-fatal) instead of failing the whole ledger.
    warnings.push(`正規化台帳に変動判定行（${misplacedClassificationRows.map((row) => row.id).join(', ')}）が含まれていたため除外しました。`);
    doc = { ...doc, rows: doc.rows.filter((row) => row.section !== '判定') };
  }
  const entities: VTAAnalysisData['entities'] = [];
  const events: VTAEvent[] = [];
  const participations: VTAParticipation[] = [];
  const relations: VTAEventRelation[] = [];
  const groupRows:LedgerRow[]=[];
  const groups: Array<{ entityId: string; eventIds: string[] }> = [];
  const dispositions: NonNullable<VTAAnalysisData['dispositions']> = [];
  const declaredEntities = new Set(doc.rows.filter((row) => row.section === '主体').map((row) => row.id));
  const declaredEvents = new Set(doc.rows.filter((row) => row.section === 'イベント').map((row) => row.id));
  const validParagraphIds = new Set(source.paragraphs.map((p) => p.id));
  let ledgerPoset = SubjectPoset.fromEntities([]);
  const typed = (section: Section, read: (row: LedgerRow) => void) => {
    for (const row of doc.rows.filter((item) => item.section === section)) {
      try {
        if (
          section === 'イベント' &&
          row.cells.length === 6 &&
          !['recorded', 'claim', 'assessment'].includes(row.cells[5])
        ) {
          row.cells.push('recorded');
          warnings.push(`イベント ${row.id}: 記録区分が省略されていたため、既定値 "recorded" を自動補完しました。`);
        }
        if (
          section === '関係' &&
          row.cells.length === 9 &&
          ['transfer', 'mutual', 'common', 'impact'].includes(row.cells[1]) &&
          declaredEvents.has(row.cells[2]) &&
          declaredEntities.has(row.cells[3]) &&
          declaredEntities.has(row.cells[4]) &&
          row.cells[3] !== row.cells[4] &&
          !declaredEvents.has(row.cells[4]) &&
          participatesViaPoset(participations, ledgerPoset, row.cells[2], row.cells[3]) &&
          participatesViaPoset(participations, ledgerPoset, row.cells[2], row.cells[4]) &&
          normalizeRefTokens(row.cells[5], source).some((p) => validParagraphIds.has(p))
        ) {
          let validAttrs = false;
          try {
            relationAttributes(row.cells[1], row.cells[6], row.cells[7], row.cells[8]);
            validAttrs = true;
          } catch {
            validAttrs = false;
          }
          if (validAttrs) {
            row.cells.splice(4, 0, row.cells[2]);
            warnings.push(
              `関係 ${row.id} (${row.cells[1]}): 同一イベント内の先イベントIDが省略されていたため (${row.cells[2]}) を自動補完しました。`
            );
          }
        }
        const validCols = section === '主体'
          ? (row.cells.length === 3 || row.cells.length === LEDGER_HEADERS[section].length)
          : row.cells.length === LEDGER_HEADERS[section].length;
        if (!validCols) throw new Error(`${LEDGER_HEADERS[section].length}列が必要です（現在${row.cells.length}列）。セル内の改行・タブは禁止です。`);
        read(row);
      } catch (error) { issues.push({ row, message: error instanceof Error ? error.message : String(error), ...(error instanceof RelationContractError?{code:error.code,kind:error.kind,field:error.field,actual:error.actual,expected:error.expected}:{}) }); }
    }
  };
  const rawParents = new Map<string, string>();
  typed('主体', ({ cells }) => {
    const [id, name, kind, rawFocus, rawParent, rawRefs] = cells;
    if (!name || name === '-' || !['person', 'organization', 'machine', 'other'].includes(kind)) throw new Error('名称または主体の種類が不正です。');
    if (entities.some((entity) => entity.name === name)) throw new Error('同じ名称の主体が重複しています。');
    let focus: VTAAnalysisData['entities'][number]['focus'] = 'mid';
    let focusSourceRefs: VTASourceRef[] | undefined;
    if (cells.length === 6) {
      if (rawFocus && rawFocus !== '-') {
        if (['reporter', 'high', 'mid', 'low'].includes(rawFocus)) {
          focus = rawFocus as 'reporter' | 'high' | 'mid' | 'low';
        } else {
          warnings.push(`主体 ${id} の報告焦点 "${rawFocus}" が不正なため mid に補正しました。`);
        }
      }
      if (rawRefs && rawRefs !== '-') {
        const acceptedRefs: VTASourceRef[] = [];
        const seenRefIds = new Set<string>();
        for (const pid of list(rawRefs)) {
          if (!validParagraphIds.has(pid)) {
            warnings.push(`主体 ${id} の焦点根拠参照 "${pid}" が存在しないため無視しました。`);
            continue;
          }
          if (!seenRefIds.has(pid)) {
            seenRefIds.add(pid);
            acceptedRefs.push({ sourceId: source.id, paragraphId: pid });
          }
        }
        if (acceptedRefs.length) focusSourceRefs = acceptedRefs;
      }
      if ((focus === 'reporter' || focus === 'high') && (!focusSourceRefs || !focusSourceRefs.length)) {
        warnings.push(`主体 ${id} の報告焦点 (${focus}) に有効な焦点根拠がないため mid に補正しました。`);
        focus = 'mid';
      }
      if (rawParent && rawParent !== '-') {
        rawParents.set(id, rawParent);
      }
    }
    entities.push({
      id,
      name,
      kind: kind as 'person',
      ...(cells.length === 6 ? { focus } : {}),
      ...(focusSourceRefs?.length ? { focusSourceRefs } : {}),
    });
  });
  if (rawParents.size) {
    const entityById = new Map(entities.map((e) => [e.id, e]));
    const stripTrailingParen = (s: string): string =>
      s.trim().replace(/(?:[（(][^）)]*[）)])+$/u, '').trim();
    const corporateOrgSuffixRe = /(?:株式会社|有限会社|合同会社|会社|法人|業者|省|庁)$/u;
    const fieldCrewSuffixRe = /(?:作業班|班|クルー|乗務員|乗組員|搭乗員)$/u;
    for (const [id, rawParentStr] of rawParents) {
      const ent = entityById.get(id)!;
      const isCorporateOrg =
        ent.kind === 'organization' && corporateOrgSuffixRe.test(stripTrailingParen(ent.name));
      const parentIds = list(rawParentStr);
      const validParents: string[] = [];
      for (const parentId of parentIds) {
        if (parentId === id || !entityById.has(parentId)) {
          warnings.push(`主体 ${id} の所属・上位主体 "${parentId}" が不正なため無視しました。`);
          continue;
        }
        const parentEnt = entityById.get(parentId)!;
        if (
          isCorporateOrg &&
          (parentEnt.kind === 'person' || fieldCrewSuffixRe.test(stripTrailingParen(parentEnt.name)))
        ) {
          warnings.push(
            `主体 ${id}（${ent.name}）の所属・上位主体 "${parentId}"（${parentEnt.name}）は法人・官公庁に対する現場班または個人の逆転包含であるため無視しました。`
          );
          continue;
        }
        if (
          ((ent.kind === 'person' || ent.kind === 'organization') && parentEnt.kind === 'machine') ||
          (ent.kind === 'machine' && parentEnt.kind === 'person')
        ) {
          warnings.push(
            `主体 ${id}（${ent.name}:${ent.kind}）の所属・上位主体 "${parentId}"（${parentEnt.name}:${parentEnt.kind}）は人間・組織と機械の直接包含であるため無視しました（複合上位主体を介して束ねてください）。`
          );
          continue;
        }
        if (!validParents.includes(parentId)) {
          validParents.push(parentId);
        }
      }
      if (validParents.length > 0) {
        ent.parentEntityId = validParents[0];
        ent.parentEntityIds = validParents;
      }
    }

    // SubjectPoset によるサイクル検証と決定論的除去
    const poset = SubjectPoset.fromEntities(entities);
    const { removedEdges } = poset.removeCycles();
    if (removedEdges.length > 0) {
      for (const edge of removedEdges) {
        warnings.push(`主体 ${edge.childId} の所属・上位主体 (${edge.parentId}) が循環しているため無視しました。`);
        const ent = entityById.get(edge.childId);
        if (ent) {
          if (ent.parentEntityId === edge.parentId) {
            delete ent.parentEntityId;
          }
          if (ent.parentEntityIds) {
            ent.parentEntityIds = ent.parentEntityIds.filter((p) => p !== edge.parentId);
            if (!ent.parentEntityIds.length) delete ent.parentEntityIds;
            else if (!ent.parentEntityId) ent.parentEntityId = ent.parentEntityIds[0];
          }
        }
      }
    }
  }
  ledgerPoset = SubjectPoset.fromEntities(entities);
  typed('イベント', ({ cells: [id, time, title, description, actors, references, kind] }) => {
    if (!title || title === '-' || !['recorded', 'claim', 'assessment'].includes(kind)) throw new Error('見出しまたは記録区分が不正です。');
    const sourceRefs = refsFromCell(references, source);
    const validRoles = ['actor', 'target', 'affected', 'intended_recipient', 'confirmed_recipient'];
    const filteredActorTokens = list(actors).filter((value) => {
      const pair = value.split(':');
      if (
        pair[0] === '-' &&
        (pair.length === 2 || (pair.length === 3 && pair[2] === 'inferred')) &&
        validRoles.includes(pair[1])
      ) {
        warnings.push(`イベント ${id} の未割当主体表記 "${value}" を未割当（-）として正規化しました。`);
        return false;
      }
      return true;
    });
    const parts = filteredActorTokens.map((value) => {
      const pair = value.split(':');
      if ((pair.length !== 2 && !(pair.length===3&&pair[2]==='inferred')) || !declaredEntities.has(pair[0]) || !validRoles.includes(pair[1])) throw new Error('主体または役割が不正です。形式は主体ID:役割、主体を推定した割当だけ主体ID:役割:inferredです。');
      return { eventId: id, entityId: pair[0], role: pair[1] as 'actor', factIds: [],...(pair[2]==='inferred'?{inferred:true}:{}) };
    });
    if (new Set(parts.map((part) => part.entityId)).size !== parts.length) throw new Error('イベント内の主体が重複しています。');
    // The ledger order is supplied by the LLM; do not parse dates to invent an order.
    events.push({ id, title, description: cell(description), time: cell(time), sourceOrder: events.length, sourceRefs,
      recordKind: kind as 'recorded', factIds: [], classification: 'unclassified', origin: 'extraction' });
    participations.push(...parts);
  });
  typed('関係', (row) => {
    let [id, kind, sourceEventId, from, targetEventId, to, references, resource, status, receipt] = row.cells;
    let sourceEntityId = cell(from) || undefined;
    let targetEntityId = cell(to) || undefined;
    if(!['before','transfer','impact','mutual','common','dependency'].includes(kind))throw new RelationContractError(kind,'関係種別',kind,'before/transfer/impact/mutual/common/dependency');
    for(const [field,value] of [['元イベント',sourceEventId],['先イベント',targetEventId]])if(!declaredEvents.has(value))throw new RelationContractError(kind,field,value,'イベント表に存在するID');

    if (kind !== 'before') {
      // ケースA: 片側が未指定（-）で、該当イベントの関与主体が1件のみ存在する場合は決定論的に補完
      if (!sourceEntityId && declaredEvents.has(sourceEventId)) {
        const srcParts = participations.filter((p) => p.eventId === sourceEventId);
        if (srcParts.length === 1 && (!targetEntityId || srcParts[0].entityId !== targetEntityId || kind !== 'dependency')) {
          sourceEntityId = srcParts[0].entityId;
          from = sourceEntityId;
          row.cells[3] = from;
          warnings.push(`関係 ${id} (${kind}) の元主体が未指定（-）のため、イベント割当済みの主体 (${sourceEntityId}) を自動補完しました。`);
        }
      }
      if (!targetEntityId && declaredEvents.has(targetEventId)) {
        const tgtParts = participations.filter((p) => p.eventId === targetEventId);
        if (tgtParts.length === 1 && (!sourceEntityId || tgtParts[0].entityId !== sourceEntityId || kind !== 'dependency')) {
          targetEntityId = tgtParts[0].entityId;
          to = targetEntityId;
          row.cells[5] = to;
          warnings.push(`関係 ${id} (${kind}) の先主体が未指定（-）のため、イベント割当済みの主体 (${targetEntityId}) を自動補完しました。`);
        }
      }

      // ケースB: 片側のみ未指定（もう片方は指定済み）で複数主体等のため特定不能な場合、時系列前後関係 (before) に安全自動補正
      if ((Boolean(sourceEntityId) !== Boolean(targetEntityId)) && (kind === 'impact' || kind === 'dependency' || kind === 'transfer') && sourceEventId !== targetEventId) {
        const missingField = !sourceEntityId ? '元主体' : '先主体';
        warnings.push(`関係 ${id} (${kind}: ${sourceEventId} → ${targetEventId}) の${missingField}が未特定のため、時系列前後関係 (before) に自動補正しました。`);
        kind = 'before';
        sourceEntityId = undefined;
        targetEntityId = undefined;
        from = '-';
        to = '-';
        resource = '-';
        status = '-';
        receipt = 'na';
        row.cells = [id, kind, sourceEventId, from, targetEventId, to, references, resource, status, receipt];
      }

      // ケースC: 両端イベントともに同一の単一主体のみが関与する dependency、または両端とも唯一の能動行為者 (:actor) が
      // 当該同一主体のみで同席者がすべて受動ロール (target / affected / intended_recipient) のみの場合は、
      // 明白な同一主体の直列行動連鎖であるため before に安全自動補正
      if (
        kind === 'dependency' &&
        sourceEventId !== targetEventId &&
        sourceEntityId &&
        sourceEntityId === targetEntityId &&
        !issues.some(
          (issue) =>
            issue.row.section === 'イベント' &&
            (issue.row.id === sourceEventId || issue.row.id === targetEventId)
        )
      ) {
        const srcParts = participations.filter((p) => p.eventId === sourceEventId);
        const tgtParts = participations.filter((p) => p.eventId === targetEventId);
        let validDepAttrs = false;
        try {
          relationAttributes(kind, resource, status, receipt);
          validDepAttrs = true;
        } catch {
          validDepAttrs = false;
        }
        const srcActors = srcParts.filter((p) => p.role === 'actor');
        const tgtActors = tgtParts.filter((p) => p.role === 'actor');
        const isPassiveRole = (role: VTAParticipation['role']) =>
          role === 'target' || role === 'affected' || role === 'intended_recipient';
        const isSoleSharedParticipant =
          srcParts.length === 1 &&
          tgtParts.length === 1 &&
          srcParts[0].entityId === sourceEntityId &&
          tgtParts[0].entityId === targetEntityId;
        const isSoleSharedActiveActor =
          srcActors.length === 1 &&
          tgtActors.length === 1 &&
          srcActors[0].entityId === sourceEntityId &&
          tgtActors[0].entityId === targetEntityId &&
          srcParts.every((p) => p.entityId === sourceEntityId || isPassiveRole(p.role)) &&
          tgtParts.every((p) => p.entityId === targetEntityId || isPassiveRole(p.role));
        if (validDepAttrs && (isSoleSharedParticipant || isSoleSharedActiveActor)) {
          warnings.push(
            `関係 ${id} (dependency: ${sourceEventId}/${sourceEntityId} → ${targetEventId}/${targetEntityId}) は単一同一主体内の前後前提であるため、時系列前後関係 (before) に自動補正しました。`
          );
          kind = 'before';
          sourceEntityId = undefined;
          targetEntityId = undefined;
          from = '-';
          to = '-';
          resource = '-';
          status = '-';
          receipt = 'na';
          row.cells = [id, kind, sourceEventId, from, targetEventId, to, references, resource, status, receipt];
        }
      }
    }

    if (kind !== 'before' && (!sourceEntityId || !targetEntityId)) throw new RelationContractError(kind,!sourceEntityId?'元主体':'先主体',!sourceEntityId?from:to,'イベントに割当済みの主体ID');
    for(const end of [{eventId:sourceEventId,entityId:sourceEntityId,field:'元主体'},{eventId:targetEventId,entityId:targetEntityId,field:'先主体'}]) {
      if(end.entityId&&!issues.some(issue=>issue.row.section==='イベント'&&issue.row.id===end.eventId)&&!participatesViaPoset(participations,ledgerPoset,end.eventId,end.entityId))throw new RelationContractError(kind,end.field,end.entityId,`${end.eventId}に割当済みの主体ID`);
    }
    const attributes=relationAttributes(kind,resource,status,receipt);
    validateRelationEndpoints({kind:kind as VTAEventRelation['kind'],sourceEventId,targetEventId,sourceEntityId,targetEntityId});
    if(kind==='common'&&sourceEventId!==targetEventId)throw new RelationContractError(kind,'イベント端点',sourceEventId+' → '+targetEventId,'同一イベントID');
    relations.push({id,...attributes,kind:kind as VTAEventRelation['kind'],sourceEventId,targetEventId,sourceEntityId,targetEntityId,sourceRefs:refsFromCell(references,source),factIds:[]});
  });
  typed('共有カード', (row) => {
    const [,entityId,ids]=row.cells;
    const eventIds = list(ids);
    if (eventIds.length < 2 || new Set(eventIds).size !== eventIds.length || eventIds.some((id) => !issues.some((issue) => issue.row.section === 'イベント' && issue.row.id === id) && !participations.some((part) => part.eventId === id && part.entityId === entityId))) throw new Error('共有カードの主体・イベント参照が不正です。');
    groups.push({ entityId, eventIds });groupRows.push(row);
  });
  typed('整理', (row) => {
    let [id, kind, references, text, reason] = row.cells;
    const validRefs = normalizeRefTokens(references, source).filter((t) => validParagraphIds.has(t));
    if (!validRefs.length && references !== '-') {
      const altRef3 = normalizeRefTokens(text, source).filter((t) => validParagraphIds.has(t));
      const altRef4 = normalizeRefTokens(reason, source).filter((t) => validParagraphIds.has(t));
      if (altRef3.length > 0 && !altRef4.length) {
        warnings.push(`整理 ${id} の列順（原文参照と要旨）を自動補正しました。`);
        const actualText = references;
        references = text;
        text = actualText;
        row.cells = [id, kind, references, text, reason];
      } else if (altRef4.length > 0 && !altRef3.length) {
        warnings.push(`整理 ${id} の列順（原文参照と理由）を自動補正しました。`);
        const actualReason = references;
        references = reason;
        reason = actualReason;
        row.cells = [id, kind, references, text, reason];
      }
    }
    if (!['background', 'excluded', 'review'].includes(kind) || !cell(text) || !cell(reason)) throw new Error('整理区分・要旨・理由が必要です。');
    const sourceRefs = refsFromCell(references, source);
    dispositions.push({ id, kind: kind as 'background', sourceRefs, ...sourceRefs[0], text, quote: '', reason });
  });
  // Optional audit sections. Every claim must be checkable against the unmodified source text.
  const paragraphText = (refs: VTASourceRef[]) => refs.map((ref) => source.paragraphs.find((part) => part.id === ref.paragraphId)?.text ?? '').join('\n');
  const corrections: VTATextCorrection[] = [];
  const subjectiveNotices: VTASubjectiveNotice[] = [];
  typed('表記', ({ cells: [id, kind, from, to, references, reason] }) => {
    if (!['alias', 'typo'].includes(kind) || !cell(from) || !cell(to) || !cell(reason)) throw new Error('表記の種別（alias/typo）・原文表記・統一後・理由が必要です。');
    let sourceRefs: VTASourceRef[] = [];
    try {
      sourceRefs = refsFromCell(references, source, false);
    } catch {
      // fallback to cross-paragraph matching below
    }
    const directText = paragraphText(sourceRefs);
    const cleanFrom = cleanPunctuation(from);

    // Layer 1: 完全一致または記号正規化一致
    let isMatch = directText.includes(from) || (cleanFrom.length > 0 && cleanPunctuation(directText).includes(cleanFrom));

    // Layer 2: 参照段落にない場合、原文の他段落を走査して自動補正
    if (!isMatch) {
      const foundPart = source.paragraphs.find((p) => p.text.includes(from) || (cleanFrom.length > 0 && cleanPunctuation(p.text).includes(cleanFrom)));
      if (foundPart) {
        sourceRefs = [{ sourceId: source.id, paragraphId: foundPart.id }];
        warnings.push(`表記 ${id}: 原文表記 "${from}" の参照段落を ${foundPart.id} に自動補正しました。`);
        isMatch = true;
      }
    }

    // Layer 3: 原文全体にも見つからない場合は警告を記録して監査記録から安全に除外
    if (!isMatch) {
      warnings.push(`表記 ${id}: 原文表記 "${from}" が原文中に見つからないため、監査記録から除外しました。`);
      return;
    }

    corrections.push({ id, kind: kind === 'alias' ? 'alias_unification' : 'typo_fix', from, to, sourceRefs, reason, detectedBy: 'llm' });
  });
  typed('表現', ({ cells: [id, references, phrase, treatment, eventIds, reason] }) => {
    const treatments: Record<string, VTASubjectiveNotice['treatment']> = { removed: 'evaluative_word_removed', quoted: 'kept_as_quoted_claim', action_only: 'action_only' };
    if (!cell(phrase) || !Object.hasOwn(treatments, treatment) || !cell(reason)) throw new Error('表現の検知語句・処理（removed/quoted/action_only）・理由が必要です。');
    const ids = list(eventIds);
    if (ids.some((eventId) => !declaredEvents.has(eventId))) throw new Error('表現に関連するイベントIDが存在しません。');

    let sourceRefs: VTASourceRef[] = [];
    try {
      sourceRefs = refsFromCell(references, source, false);
    } catch {
      // fallback to cross-paragraph matching below
    }
    const directText = paragraphText(sourceRefs);
    const cleanPhrase = cleanPunctuation(phrase);

    // Layer 1: 完全一致または記号正規化一致
    let isMatch = directText.includes(phrase) || (cleanPhrase.length > 0 && cleanPunctuation(directText).includes(cleanPhrase));

    // Layer 2: 参照段落にない場合、原文の他段落を走査して自動補正
    if (!isMatch) {
      const foundPart = source.paragraphs.find((p) => p.text.includes(phrase) || (cleanPhrase.length > 0 && cleanPunctuation(p.text).includes(cleanPhrase)));
      if (foundPart) {
        sourceRefs = [{ sourceId: source.id, paragraphId: foundPart.id }];
        warnings.push(`表現 ${id}: 検知語句 "${phrase}" の参照段落を ${foundPart.id} に自動補正しました。`);
        isMatch = true;
      }
    }

    // Layer 3: 原文全体にも見つからない場合は警告を記録して監査記録から安全に除外
    if (!isMatch) {
      warnings.push(`表現 ${id}: 検知語句 "${phrase}" が原文中に見つからないため、監査記録から除外しました。`);
      return;
    }

    subjectiveNotices.push({ id, sourceRefs, phrase, treatment: treatments[treatment], eventIds: ids, detectedBy: 'llm' });
  });
  typed('仮判定', ({ cells: [eventId, value, reason, references] }) => {
    if (!declaredEvents.has(eventId)) throw new Error('仮判定のイベントIDが存在しません。');
    const parsedToken = parsePreliminaryDecisionToken(value);
    if (!parsedToken) {
      throw new Error(
        '仮判定は normal / variation / variation:resilient / outcome:loss / outcome:recovery / outcome:near_miss / post_outcome / undetermined のいずれかです。'
      );
    }
    const event = events.find((item) => item.id === eventId);
    const sourceRefs = list(references).length ? refsFromCell(references, source) : [];
    const trimmedReason = cell(reason);
    if (parsedToken.value !== 'undetermined' && (!sourceRefs.length || !trimmedReason)) {
      warnings.push(`仮判定 ${eventId} (${value}) に原文参照または理由がないため undetermined へ格下げしました。`);
      if (event) event.preliminary = { value: 'undetermined', reason: '', sourceRefs: [] };
      return;
    }
    if (event && sourceRefs.some((ref) => !event.sourceRefs?.some((own) => own.sourceId === ref.sourceId && own.paragraphId === ref.paragraphId))) throw new Error('仮判定の原文参照がイベントの範囲外です。');
    if (event) {
      event.preliminary = {
        ...parsedToken,
        reason: trimmedReason,
        sourceRefs,
      };
    }
  });
  const parseOutcomeEventToken = (
    rawToken: string,
    defaultKind?: VTAOutcomeKind
  ): { eventId: string; kind?: VTAOutcomeKind } => {
    const trimmed = rawToken.trim();
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(loss|near_miss|recovery)$/i.exec(trimmed);
    if (match) {
      return {
        eventId: match[1],
        kind: match[2].toLowerCase() as VTAOutcomeKind,
      };
    }
    return { eventId: trimmed, kind: defaultKind };
  };
  const outcomeKindsByEventId = new Map<string, VTAOutcomeKind>();
  const recordOutcomeKind = (eventId: string, kind: VTAOutcomeKind | undefined) => {
    if (!kind) return;
    const prev = outcomeKindsByEventId.get(eventId);
    if (prev === 'loss') return;
    if (prev === 'near_miss' && kind === 'recovery') return;
    outcomeKindsByEventId.set(eventId, kind);
  };
  let parsedOutcome: VTAAnalysisData['outcome'] | undefined;
  typed('帰結', (row) => {
    let [, status, ids, refs, reason, optionalKindCell] = row.cells;
    const trimmedRowKind = optionalKindCell?.trim().toLowerCase();
    const rowKind: VTAOutcomeKind | undefined =
      trimmedRowKind === 'loss' || trimmedRowKind === 'near_miss' || trimmedRowKind === 'recovery'
        ? (trimmedRowKind as VTAOutcomeKind)
        : undefined;
    const normTokens = list(ids).map((token) => parseOutcomeEventToken(token, rowKind));
    const normIds = normTokens.map((t) => t.eventId);
    const normRefs = normalizeRefTokens(refs, source);
    let parsedTokens = normTokens;
    if (
      normIds.some((id) => !declaredEvents.has(id) && validParagraphIds.has(id)) &&
      (normRefs.length === 0 ||
        list(refs).some((token) => declaredEvents.has(parseOutcomeEventToken(token).eventId)))
    ) {
      const swappedTokens = list(refs).map((token) => parseOutcomeEventToken(token, rowKind));
      const swappedIds = swappedTokens.map((t) => t.eventId);
      const swappedRefs = normalizeRefTokens(ids, source);
      if (swappedIds.every((id) => declaredEvents.has(id)) && swappedRefs.length > 0) {
        warnings.push(`帰結 ${row.id} の列順（イベントIDと原文参照）を自動補正しました。`);
        const tmp = ids;
        ids = refs;
        refs = tmp;
        row.cells[2] = ids;
        row.cells[3] = refs;
        parsedTokens = swappedTokens;
      }
    }

    const eventIds = [...new Set(parsedTokens.map((t) => t.eventId))];
    for (const token of parsedTokens) {
      recordOutcomeKind(token.eventId, token.kind);
    }
    if (
      !['identified', 'not_found', 'uncertain'].includes(status) ||
      !cell(reason) ||
      eventIds.some((id) => !events.some((e) => e.id === id) && !issues.some((issue) => issue.row.section === 'イベント' && issue.row.id === id)) ||
      (status === 'identified' && (!eventIds.length || refs === '-')) ||
      (status !== 'identified' && eventIds.length)
    ) {
      throw new Error('帰結の判定・イベント参照・根拠が不正です。');
    }
    const sourceRefs = refsFromCell(refs, source, status === 'identified');
    const resolveAggregateOutcomeKind = (evIds: string[]): VTAOutcomeKind | undefined => {
      const kinds = evIds
        .map((id) => outcomeKindsByEventId.get(id))
        .filter((k): k is VTAOutcomeKind => Boolean(k));
      if (!kinds.length) return rowKind;
      if (kinds.includes('loss')) return 'loss';
      if (kinds.includes('near_miss')) return 'near_miss';
      return 'recovery';
    };
    if (!parsedOutcome) {
      const aggKind = status === 'identified' ? resolveAggregateOutcomeKind(eventIds) : undefined;
      parsedOutcome = {
        status: status as NonNullable<VTAAnalysisData['outcome']>['status'],
        ...(aggKind ? { kind: aggKind } : {}),
        eventIds,
        sourceRefs,
        reason,
      };
    } else {
      warnings.push(`帰結の確認行 (${row.id}) が複数出力されたため、1件に統合しました。`);
      const statusPriority: Record<string, number> = { identified: 3, uncertain: 2, not_found: 1 };
      const curPrio = statusPriority[parsedOutcome.status] ?? 0;
      const newPrio = statusPriority[status] ?? 0;
      const targetStatus = newPrio > curPrio ? status : parsedOutcome.status;

      const mergedEventIds = [...new Set([...parsedOutcome.eventIds, ...eventIds])];
      const mergedRefsMap = new Map(
        [...parsedOutcome.sourceRefs, ...sourceRefs].map((r) => [`${r.sourceId}/${r.paragraphId}`, r])
      );
      const mergedReason =
        parsedOutcome.reason === reason
          ? reason
          : `${parsedOutcome.reason} / ${reason}`;
      const aggKind = targetStatus === 'identified'
        ? resolveAggregateOutcomeKind(mergedEventIds) ?? parsedOutcome.kind
        : undefined;

      parsedOutcome = {
        status: targetStatus as NonNullable<VTAAnalysisData['outcome']>['status'],
        ...(aggKind ? { kind: aggKind } : {}),
        eventIds: targetStatus === 'identified' ? mergedEventIds : [],
        sourceRefs: [...mergedRefsMap.values()],
        reason: mergedReason,
      };
    }
  });

  if (parsedOutcome && parsedOutcome.status === 'identified' && parsedOutcome.eventIds.length > 0) {
    const hasAnyExplicitKind = parsedOutcome.eventIds.some((id) => Boolean(outcomeKindsByEventId.get(id)));
    if (hasAnyExplicitKind) {
      for (const id of parsedOutcome.eventIds) {
        if (!outcomeKindsByEventId.has(id)) {
          outcomeKindsByEventId.set(id, 'loss');
        }
      }
      const allKinds = parsedOutcome.eventIds
        .map((id) => outcomeKindsByEventId.get(id))
        .filter((k): k is VTAOutcomeKind => Boolean(k));
      if (allKinds.includes('loss')) parsedOutcome.kind = 'loss';
      else if (allKinds.includes('near_miss')) parsedOutcome.kind = 'near_miss';
      else if (allKinds.includes('recovery')) parsedOutcome.kind = 'recovery';
    }
  }
  // Validate each checkable relation separately. Never attribute a thrown row error
  // to the whole table, or hide it behind another row's attribute failure.
  if(!issues.some(i=>i.row.section==='主体'||i.row.section==='イベント')) {
    for(const relation of [...relations]) {
      try { validateParticipants({entities,participations,relations:[relation],cardGroups:[]},events,[],false,undefined,[source]); }
      catch(error) {
        const row=doc.rows.find(row=>row.section==='関係'&&row.id===relation.id)!;
        issues.push({row,message:error instanceof Error?error.message:String(error),code:'relation_semantics'});
        relations.splice(relations.indexOf(relation),1);
      }
    }
  }
  const before=relations.filter(r=>r.kind==='before');
  const reaches=(from:string,to:string,seen=new Set<string>()):boolean=>from===to||!seen.has(from)&&(seen.add(from),before.filter(r=>r.sourceEventId===from).some(r=>reaches(r.targetEventId,to,seen)));
  const beforeCycleIssues: LedgerIssue[] = [];
  for(const r of before)if(reaches(r.targetEventId,r.sourceEventId)) {
    const row = doc.rows.find(row=>row.section==='関係'&&row.id===r.id);
    if (row) beforeCycleIssues.push({row,message:'イベントの前後関係が循環しています。',code:'temporal_cycle'});
  }
  issues.push(...beforeCycleIssues);

  // before 同士に循環がない正常な時間基盤のもとで、有向な transfer / impact (status === 'occurred') が
  // before 連鎖と逆行 (reaches(target, source)) していないかを検査する
  if (beforeCycleIssues.length === 0) {
    const directedRelations = relations.filter(
      (r) =>
        (r.kind === 'transfer' || r.kind === 'impact') &&
        r.status === 'occurred'
    );
    for (const r of directedRelations) {
      if (r.sourceEventId !== r.targetEventId && reaches(r.targetEventId, r.sourceEventId)) {
        const row = doc.rows.find((row) => row.section === '関係' && row.id === r.id);
        if (row && !issues.some((i) => i.row === row)) {
          issues.push({
            row,
            message: `関係 ${r.id} (${r.sourceEventId} → ${r.targetEventId}) が既存の前後関係 (before) の順序と逆行しています。`,
            code: 'temporal_inversion',
            kind: r.kind,
            field: '前後順序',
            actual: `${r.sourceEventId} → ${r.targetEventId}`,
            expected: `${r.targetEventId} → ${r.sourceEventId}`,
          });
        }
      }
    }
  }

  if(!issues.some(i=>i.code==='temporal_cycle'||i.row.section==='主体'||i.row.section==='イベント')){
   const grouped=new Map<string,LedgerRow>();
   for(const [index,group] of groups.entries()){
    const row=groupRows[index];
    if(group.eventIds.some(id=>!events.some(e=>e.id===id))||!entities.some(e=>e.id===group.entityId))continue;
    try{validateParticipants({entities,participations,relations,cardGroups:[group]},events,[],false,undefined,[source]);
     const pairs=group.eventIds.map(id=>id+'/'+group.entityId);
     const overlapping=pairs.flatMap(k=>grouped.has(k)?[grouped.get(k)!]:[]);
     if(overlapping.length){for(const other of new Set(overlapping))if(!issues.some(i=>i.row===other))issues.push({row:other,message:'同じイベントと主体が複数の表示グループに含まれます。',code:'group_constraint'});throw Error('同じイベントと主体が複数の表示グループに含まれます。');}
     pairs.forEach(k=>grouped.set(k,row));
    }catch(error){issues.push({row,message:error instanceof Error?error.message:String(error),code:'group_constraint'});}
   }
   const validGroups=groups.filter((_,index)=>!issues.some(issue=>issue.row===groupRows[index]));
   const parsed=validateParticipants({entities,participations,relations,cardGroups:validGroups},events,[],false,undefined,[source]);
   const partialAnalysis=buildAnalysis(source,[],events,parsed);
   for(const r of relations.filter(r=>r.kind==='dependency')) {
    const message=dependencyProblem(partialAnalysis,r,relations);
    if(message)issues.push({row:doc.rows.find(row=>row.section==='関係'&&row.id===r.id)!,message,code:'dependency_constraint',kind:r.kind,field:'依存端点'});
   }
  }
  if (issues.length) return { issues, ...(warnings.length ? { warnings } : {}) };
  // Graph invariants remain required for a usable editable project.
  {
    for (const ev of events) {
      const explicitKind = outcomeKindsByEventId.get(ev.id);
      if (explicitKind) {
        ev.outcome_kind = explicitKind;
      }
      if (parsedOutcome && parsedOutcome.status === 'identified' && parsedOutcome.eventIds.includes(ev.id)) {
        ev.classification = 'outcome';
      }
    }
    const parsed = validateParticipants({ entities, participations, relations, cardGroups: groups }, events, [], false, undefined, [source]);
    const aliasMap: Record<string, string> = {};
    for (const c of corrections) {
      if (c.kind === 'alias_unification' && c.to) {
        aliasMap[c.from] = c.to;
      }
    }
    const finalPoset = SubjectPoset.fromEntities(entities, aliasMap);
    const rawBuiltAnalysis: VTAAnalysisData = {
      ...buildAnalysis(source, [], events, parsed),
      dispositions,
      subjectPoset: finalPoset.toJSON(),
      outcome: parsedOutcome,
      ...(corrections.length || subjectiveNotices.length
        ? { normalizationAudit: { version: 1 as const, corrections, subjectiveNotices } }
        : {}),
    };
    const { analysis } = promotePreliminaryOutcomes(rawBuiltAnalysis);

    // Evaluative wording in generated event text and explicit-timestamp relation inversions are repairable soft issues.
    const softIssues: LedgerIssue[] = [];
    const eventTimeMap = new Map(events.map((e) => [e.id, { time: e.time, interval: parseTimeInterval(e.time) }]));
    const timeInvertedRelations = new Set<VTAEventRelation>();
    for (const r of relations.filter(isPrecedenceRelation)) {
      const srcInfo = eventTimeMap.get(r.sourceEventId);
      const tgtInfo = eventTimeMap.get(r.targetEventId);
      if (srcInfo?.interval && tgtInfo?.interval && compareTimeIntervals(srcInfo.interval, tgtInfo.interval) === 'after') {
        timeInvertedRelations.add(r);
        const row = doc.rows.find((item) => item.section === '関係' && item.id === r.id);
        const msg = `関係 ${r.id} (${r.sourceEventId} [${srcInfo.time}] → ${r.targetEventId} [${tgtInfo.time}]) がイベントの明示時刻区間と逆行しています。`;
        warnings.push(msg);
        if (row && !softIssues.some((i) => i.row === row)) {
          softIssues.push({
            row,
            message: msg,
            code: 'temporal_inversion',
            kind: r.kind,
            field: '時刻整合',
            actual: `${r.sourceEventId}(${srcInfo.time}) → ${r.targetEventId}(${tgtInfo.time})`,
            expected: `${r.targetEventId}(${tgtInfo.time}) → ${r.sourceEventId}(${srcInfo.time})`,
          });
        }
      }
    }
    if (timeInvertedRelations.size > 0) {
      const invertedKeys = new Set(
        [...timeInvertedRelations].map((r) => `${r.id ?? ''}:${r.kind}:${r.sourceEventId}->${r.targetEventId}`)
      );
      analysis.relations = analysis.relations.filter(
        (r) => !invertedKeys.has(`${r.id ?? ''}:${r.kind}:${r.sourceEventId}->${r.targetEventId}`)
      );
    }

    // 正規化フェーズにおいてイベント時間半順序集合 (EventTimeDAG) を確定する
    ensureEventTimeDAG(analysis);
    for (const row of doc.rows.filter((item) => item.section === 'イベント')) {
      const phrases = [...new Set(scanGeneratedText(`${row.cells[2]}\n${row.cells[3]}`, row.cells[6] as 'recorded').map((hit) => hit.phrase))];
      if (phrases.length) softIssues.push({ row, code: 'subjective_expression', field: '見出し・内容', actual: phrases.join('、'),
        message: '評価・過失認定の語が含まれています。評価語だけを除き、原文にない状況を補わず、確認できる行為だけを記述してください。供述は「」で発話として保持しclaimとします。' });
    }
    return issues.length?{issues,...(warnings.length?{warnings}:{})}:{issues,...(warnings.length?{warnings}:{}),...(softIssues.length?{softIssues}:{}),analysis};
  }
}

/** Replace requested IDs only. An uncertain relation may explicitly become a review disposition. */
export function applyLedgerRepair(doc: LedgerDocument, issues: LedgerIssue[], text: string): LedgerDocument {
  const sections = [...new Set(issues.map((i) => i.row.section))];
  const defaultSection = sections.length === 1 ? sections[0] : undefined;
  const replacements = parseLedger(text, { partial: true, defaultSection, allowMissingComplete: true }).rows;
  const allowed = new Set(issues.map((issue) => key(issue.row)));

  const outcomeIssues = issues.filter((i) => i.row.section === '帰結');
  const outcomeReplacements = replacements.filter((r) => r.section === '帰結');

  let matchedOutcomeReplacement: LedgerRow | undefined;
  let targetOutcomeKeyToKeep: string | undefined;

  const replacementKey = (row: LedgerRow) => {
    if (allowed.has(key(row))) return key(row);
    if (row.section === '整理' && row.cells.length === 5 && row.cells[1] === 'review'
      && row.cells[2] && row.cells[2] !== '-' && row.cells[3] && row.cells[3] !== '-' && row.cells[4] && row.cells[4] !== '-'
      && allowed.has(`関係/${row.id}`) && !doc.rows.some((old) => key(old) === key(row))) return `関係/${row.id}`;
    if (row.section === '帰結' && outcomeIssues.length > 0 && outcomeReplacements.length === 1 && !matchedOutcomeReplacement) {
      matchedOutcomeReplacement = row;
      targetOutcomeKeyToKeep = key(outcomeIssues[0].row);
      return targetOutcomeKeyToKeep;
    }
    return '';
  };

  const keys = replacements.map(replacementKey);
  const isOutcomeConsolidation = outcomeIssues.length > 1 && outcomeReplacements.length === 1;
  const isOutcomePruning = outcomeIssues.length > 0 && outcomeReplacements.length === 0 && doc.rows.some(r => r.section === '帰結' && !allowed.has(key(r)));
  const expectedSize = isOutcomeConsolidation
    ? allowed.size - (outcomeIssues.length - 1)
    : isOutcomePruning
    ? allowed.size - outcomeIssues.length
    : allowed.size;

  if (replacements.length !== expectedSize || keys.some((value) => !value) || new Set(keys).size !== replacements.length) {
    throw new Error('修復応答は指定した行IDを一度ずつ出力する必要があります。指定外の追加・削除・ID変更はできません。');
  }

  const byId = new Map(replacements.map((row) => [replacementKey(row), row]));
  const outcomeKeysToRemove = new Set<string>();
  if (isOutcomeConsolidation) {
    for (const oi of outcomeIssues.slice(1)) {
      outcomeKeysToRemove.add(key(oi.row));
    }
  } else if (isOutcomePruning) {
    for (const oi of outcomeIssues) {
      outcomeKeysToRemove.add(key(oi.row));
    }
  }

  return {
    rows: doc.rows
      .filter((row) => !outcomeKeysToRemove.has(key(row)))
      .map((row) => byId.get(key(row)) ?? row),
  };
}

const RESERVED_LEDGER_TAGS = [...Object.keys(LEDGER_HEADERS), '完了'];
const reservedTagRegex = new RegExp(`\\[(${RESERVED_LEDGER_TAGS.join('|')})\\]`, 'g');
function sanitizeLedgerPromptText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(reservedTagRegex, '［$1］')
    .replace(/`{3,}/g, (m) => '｀'.repeat(m.length));
}

/** Send offending rows, their source passages and a compact ID catalog, never the accepted text body. */
export function ledgerRepairInput(doc: LedgerDocument, issues: LedgerIssue[], source: VTASource): string {
  const ids = new Set<string>();
  const relatedEvents = new Set<string>();
  for (const { row } of issues) {
    const index = row.section === 'イベント' ? 5 : row.section === '関係' ? 6 : row.section === '整理' ? 2 : row.section === '帰結' ? 3
      : row.section === '表記' ? 4 : row.section === '表現' ? 1 : row.section === '仮判定' ? 3 : -1;
    if (index >= 0) normalizeRefTokens(row.cells[index] ?? '-', source).forEach((id) => ids.add(id));
    if (row.section === 'イベント' || row.section === '仮判定') relatedEvents.add(row.id);
    if (row.section === '表現') list(row.cells[4] ?? '-').forEach((id) => relatedEvents.add(id));
    if (row.section === '関係') [row.cells[2], row.cells[4]].filter(Boolean).forEach((id) => relatedEvents.add(id));
    if (row.section === '帰結') {
      list(row.cells[2] ?? '-')
        .map((id) => id.replace(/:(loss|near_miss|recovery)$/i, '').trim())
        .forEach((id) => relatedEvents.add(id));
    }
    if (row.section === '共有カード') list(row.cells[2] ?? '-').forEach((id) => relatedEvents.add(id));
    if (row.section === '主体') doc.rows.filter((item) => item.section === 'イベント' && list(item.cells[4] ?? '-').some((part) => part.split(':')[0] === row.id)).forEach((item) => relatedEvents.add(item.id));
  }
  const relatedRows = doc.rows.filter((row) => row.section === 'イベント' && relatedEvents.has(row.id));
  relatedRows.forEach((row) => normalizeRefTokens(row.cells[5] ?? '-', source).forEach((id) => ids.add(id)));
  // Missing references are not guessed. Without a usable reference show a small surrounding context.
  const paragraphs = source.paragraphs.filter((part) => ids.has(part.id));
  const fallbackParagraphs = source.paragraphs.length > 6
    ? [...new Map([...source.paragraphs.slice(0, 3), ...source.paragraphs.slice(-3)].map((p) => [p.id, p])).values()]
    : source.paragraphs.slice(0, 3);
  const context = paragraphs.length ? paragraphs : fallbackParagraphs;
  const catalog = doc.rows.filter((row) => row.section === '主体' || row.section === 'イベント').map((row) => row.section === '主体'
    ? `${row.id}\t${row.cells[1]}` : `${row.id}\t${row.cells[4]}`).join('\n');
  const targets = [...new Set(issues.map((issue) => issue.row.section))].map((section) => `[${section}]\n${LEDGER_HEADERS[section].join('\t')}\n${issues.filter((issue) => issue.row.section === section).map(({ row }) => row.cells.join('\t')).join('\n')}`).join('\n');
  const rangeInfo = source.paragraphs.length
    ? `\n【参照可能な段落IDの範囲】\n${source.paragraphs[0].id} 〜 ${source.paragraphs[source.paragraphs.length - 1].id}（全${source.paragraphs.length}段落）`
    : '';
  return `指定行の内容・列・参照だけを修正し、同じセクションとIDの行だけを返す。指定外の行や本文を再出力しない。修正不能でもIDを変更しない。dependencyで両端が同一主体になった場合は、別主体を指定するか、同一主体内の時間順としてbefore（両端主体 -）へ変更する。関係行の両端主体を原文から特定できない場合、主体を推測せず、事象間の時間推移として前後関係（before、両端主体 - ）とするか、関係自体が不明確な場合はその行だけ[整理]へ移し、同じID・review・原文参照・関係の要旨・特定できない理由の5列で返してよい。通常の関係行との重複出力は禁止。イベント行は保持する。末尾は[完了]。\n【参照可能なID（本文は保持済み）】\n${catalog}${rangeInfo}\n【関連イベントの時刻（変更禁止）】\n${relatedRows.map((row) => `${row.id}\t${row.cells[1]}`).join('\n')}\n【対象の原文】\n${context.map((part) => `[${part.id}] ${sanitizeLedgerPromptText(part.text)}`).join('\n')}\n【修復対象】\n${targets}\n【エラー】\n${issues.map(formatLedgerIssue).join('\n')}`;
}

export function eventSourceRefs(analysis: VTAAnalysisData, event: VTAEvent): VTASourceRef[] {
  const refs = event.sourceRefs ?? (analysis.facts ?? []).filter((fact) => (event.factIds ?? []).includes(fact.id)).flatMap((fact) => fact.evidence.map(({ sourceId, paragraphId }) => ({ sourceId, paragraphId })));
  return [...new Map(refs.map((ref) => [`${ref.sourceId}/${ref.paragraphId}`, ref])).values()];
}

export function parsePreliminaryDecisionToken(
  rawValue: string
): Pick<
  NonNullable<VTAEvent['preliminary']>,
  'value' | 'polarity' | 'scope' | 'promotedOutcomeKind'
> | null {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'normal') return { value: 'normal' };
  if (normalized === 'variation') return { value: 'variation' };
  if (normalized === 'variation:negative') return { value: 'variation', polarity: 'negative' };
  if (normalized === 'variation:resilient') return { value: 'variation', polarity: 'resilient' };
  if (
    normalized === 'outcome:loss' ||
    normalized === 'outcome:recovery' ||
    normalized === 'outcome:near_miss'
  ) {
    const kind = normalized.split(':')[1] as VTAOutcomeKind;
    return { value: 'variation', promotedOutcomeKind: kind };
  }
  if (normalized === 'post_outcome') {
    return { value: 'normal', scope: 'post_outcome' };
  }
  if (normalized === 'undetermined') return { value: 'undetermined' };
  return null;
}

export function preliminaryClassificationInput(
  events: VTAEvent[],
  source: VTASource,
  outcomeContext?: VTAAnalysisData['outcome'],
  allEvents?: readonly VTAEvent[]
): string {
  const clean = (text: string | undefined | null) => (text ? text.replace(/[\t\r\n]+/g, ' ') : '') || '-';
  const referencedParagraphIds = new Set<string>();
  for (const e of events) {
    if (e.sourceRefs) {
      for (const r of e.sourceRefs) {
        referencedParagraphIds.add(r.paragraphId);
      }
    }
  }

  const paragraphsToInclude = referencedParagraphIds.size > 0
    ? source.paragraphs.filter((p) => referencedParagraphIds.has(p.id))
    : source.paragraphs;

  const eventLines = events.map((e) => {
    const refs = e.sourceRefs?.map((r) => r.paragraphId).join(',') || '-';
    return [e.id, e.time || '-', e.title, e.description || '-', refs].map(clean).join('\t');
  });

  const outcomeSectionLines: string[] = [];
  if (outcomeContext?.status === 'identified' && outcomeContext.eventIds.length > 0) {
    const lookup = new Map((allEvents ?? events).map((ev) => [ev.id, ev]));
    const rows = outcomeContext.eventIds.map((id) => {
      const ev = lookup.get(id);
      const kind = ev?.outcome_kind ?? outcomeContext.kind ?? 'loss';
      return `- ${clean(id)} (${clean(kind)}, ${clean(ev?.time)}): ${clean(ev?.title)}`;
    });
    outcomeSectionLines.push('[既知の帰結イベント（参考・再出力不要）]', ...rows, '');
  }

  return [
    ...outcomeSectionLines,
    '[対象イベント]',
    'ID\t時刻\t見出し\t内容\t原文参照',
    ...eventLines,
    '',
    '[原文]',
    ...paragraphsToInclude.map((p) => `[${p.id}] ${sanitizeLedgerPromptText(p.text)}`),
  ].join('\n');
}

export function inspectPreliminaryClassifications(
  doc: LedgerDocument,
  events: VTAEvent[],
  source: VTASource
): { events: VTAEvent[]; issues: LedgerIssue[]; warnings?: string[] } {
  const issues: LedgerIssue[] = [];
  const warnings: string[] = [];
  const eventMap = new Map(events.map((e) => [e.id, { ...e }]));
  const preliminaryRows = doc.rows.filter((row) => row.section === '仮判定');

  for (const row of preliminaryRows) {
    try {
      const [eventId, value, reason, references] = row.cells;
      if (row.cells.length !== 4) {
        throw new Error(`仮判定は4列（イベントID、判定、理由、原文参照）が必要です（現在${row.cells.length}列）。`);
      }
      const event = eventMap.get(eventId);
      if (!event) {
        throw new Error(`仮判定のイベントID "${eventId}" が存在しません。`);
      }
      const parsedToken = parsePreliminaryDecisionToken(value);
      if (!parsedToken) {
        throw new Error(
          `仮判定は normal / variation / variation:resilient / outcome:loss / outcome:recovery / outcome:near_miss / post_outcome / undetermined のいずれかです（現在: "${value}"）。`
        );
      }
      const rawRefs = list(references);
      const sourceRefs = rawRefs.length ? refsFromCell(references, source) : [];
      const trimmedReason = cell(reason);

      if (parsedToken.value !== 'undetermined' && (!sourceRefs.length || !trimmedReason)) {
        warnings.push(`仮判定 ${eventId} (${value}) に原文参照または理由がないため undetermined へ格下げしました。`);
        event.preliminary = {
          value: 'undetermined',
          reason: '',
          sourceRefs: [],
        };
        continue;
      }
      let effectiveRefs = sourceRefs;
      if (event.sourceRefs?.length) {
        const inScopeRefs = sourceRefs.filter((ref) =>
          event.sourceRefs!.some((own) => own.sourceId === ref.sourceId && own.paragraphId === ref.paragraphId)
        );
        if (inScopeRefs.length === 0 && sourceRefs.length > 0) {
          throw new Error('仮判定の原文参照がイベントの範囲外です。');
        }
        if (inScopeRefs.length < sourceRefs.length) {
          warnings.push(`仮判定 ${eventId} の範囲外参照を除外し、イベント自身の参照段落のみを保持しました。`);
          effectiveRefs = inScopeRefs;
        }
      }

      event.preliminary = {
        ...parsedToken,
        reason: trimmedReason,
        sourceRefs: effectiveRefs,
      };
      // ADR-0001 準拠: event.classification は 'unclassified' を厳格に保持（outcome:* の帰結昇格は呼び出し元で一括反映）
    } catch (error) {
      issues.push({ row, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    events: events.map((e) => eventMap.get(e.id) ?? e),
    issues,
    ...(warnings.length ? { warnings } : {}),
  };
}

export function classificationInput(analysis: VTAAnalysisData): string {
  const pending = analysis.events.filter(
    (event) => !event.ignored && event.classification === 'unclassified' && !isIdentifiedOutcomeEvent(analysis, event)
  );
  const clean = (text: string | undefined | null) => (text ? text.replace(/[\t\r\n]+/g, ' ') : '') || '-';
  const paragraphs = new Set(pending.flatMap((event) => eventSourceRefs(analysis, event).map((ref) => `${ref.sourceId}/${ref.paragraphId}`)));
  const formatPart = (part: VTAParticipation) => {
    const entityName = analysis.entities.find((entity) => entity.id === part.entityId)?.name ?? part.entityId;
    const mergedNames = [...new Set((part.mergedFrom ?? [])
      .map((m) => analysis.subjectRanking?.originalEntities.find((e) => e.id === m.entityId)?.name ?? m.entityId)
      .filter((name) => name && name !== entityName))];
    const mergedText = mergedNames.length ? `（統合：${mergedNames.join('・')}）` : '';
    return entityName + ':' + part.role + mergedText + (isSubjectInferred(part) ? '（主体は推定）' : '');
  };
  const preliminaryLines = pending
    .filter((event) => event.preliminary)
    .map((event) => {
      const p = event.preliminary!;
      const pLabel = p.polarity === 'resilient' ? 'variation:resilient' : p.value;
      const refs = p.sourceRefs.map((r) => `${r.sourceId}/${r.paragraphId}`).join(',') || '-';
      return [event.id, pLabel, p.reason || '-', refs].map(clean).join('\t');
    });
  const preliminarySection = preliminaryLines.length
    ? '\n[仮判定参考（正規化時の仮判定。そのまま採用せず、確定イベント・主体・原文に基づき再判定すること）]\nイベントID\t仮判定\t理由\t原文参照\n' + preliminaryLines.join('\n')
    : '';
  return '[イベント]\nID\t時刻\t見出し\t内容\t区分\t主体と役割\t原文参照\n' + pending.map((event) => [event.id, event.time, event.title, event.description, event.recordKind ?? 'recorded', analysis.participations.filter((part) => event.id === part.eventId).map(formatPart).join(','), eventSourceRefs(analysis, event).map((ref) => `${ref.sourceId}/${ref.paragraphId}`).join(',')].map(clean).join('\t')).join('\n')
    + preliminarySection
    + '\n[原文]\n' + analysis.sources.flatMap((source) => source.paragraphs.filter((part) => paragraphs.has(`${source.id}/${part.id}`)).map((part) => `[${source.id}/${part.id}] ${sanitizeLedgerPromptText(part.text)}`)).join('\n')
    + '\n[背景・要確認]\n' + (analysis.dispositions ?? []).filter((item) => item.kind !== 'excluded').map((item) => clean(item.text ?? item.quote)).join('\n');
}

/**
 * Validates a classification ledger against the pending (unclassified, non-outcome) events.
 * - Rows of other sections or for out-of-scope / unknown event IDs are discarded with a warning (non-fatal).
 * - Pending events missing from the reply are padded with placeholder rows so that they become repair targets.
 * The normalized document is returned as `normalizedDoc`; the caller must use it for subsequent repairs.
 * The input document is not mutated.
 */
export function inspectClassifications(doc: LedgerDocument, analysis: VTAAnalysisData): { issues: LedgerIssue[]; analysis?: VTAAnalysisData; normalizedDoc: LedgerDocument; warnings?: string[] } {
  const warnings: string[] = [];
  const pending = analysis.events.filter(
    (event) => !event.ignored && event.classification === 'unclassified' && !isIdentifiedOutcomeEvent(analysis, event)
  );
  const pendingIds = new Set(pending.map((event) => event.id));
  const outcomeEventIdSet = new Set(
    analysis.events.filter((event) => isIdentifiedOutcomeEvent(analysis, event)).map((event) => event.id)
  );
  const foreignSectionRows = doc.rows.filter((row) => row.section !== '判定');
  if (foreignSectionRows.length) {
    warnings.push(`判定応答の指定外セクション行（${foreignSectionRows.map((row) => `${row.section}/${row.id}`).join(', ')}）を除外しました。`);
  }
  // Protect identified outcome events: silently ignore if the LLM unexpectedly emits a classification row for them.
  const sectionRows = doc.rows.filter((row) => row.section === '判定' && !outcomeEventIdSet.has(row.id));
  const outOfScopeRows = sectionRows.filter((row) => !pendingIds.has(row.id));
  if (outOfScopeRows.length) {
    warnings.push(`判定対象外のイベントID（${outOfScopeRows.map((row) => row.id).join(', ')}）の判定行を除外しました。`);
  }
  const rows = sectionRows.filter((row) => pendingIds.has(row.id));
  for (const event of pending) if (!rows.some((row) => row.id === event.id)) rows.push({ section: '判定', id: event.id, cells: [event.id, '-', '-', '-'], line: 0 });
  const normalizedDoc: LedgerDocument = { ...doc, rows };
  const results = new Map<string, VTAEvent>(); const issues: LedgerIssue[] = [];
  for (const row of rows) {
    try {
      const event = pending.find((event) => event.id === row.id)!;
      const [id, rawVal, reason, refs] = row.cells;
      const normalizedVal = rawVal?.trim().toLowerCase() ?? '';
      const validValues = ['normal', 'variation', 'variation:negative', 'variation:resilient', 'outcome', 'undetermined'];
      if (row.cells.length !== 4 || !validValues.includes(normalizedVal) || !cell(reason)) {
        throw new Error('判定は4列で判定値と理由が必要です。');
      }
      const canonicalClass: VTAEvent['classification'] =
        normalizedVal === 'variation:negative' || normalizedVal === 'variation:resilient'
          ? 'variation'
          : (normalizedVal as VTAEvent['classification']);
      const own = eventSourceRefs(analysis, event);
      const references = list(refs).map((id) => { const ref = own.find((ref) => `${ref.sourceId}/${ref.paragraphId}` === id); if (!ref) throw new Error('判定の原文参照がイベントの範囲外です。'); return ref; });
      if (canonicalClass !== 'undetermined' && !references.length) throw new Error('通常・変動の判定にはイベントの原文参照が必要です。');
      let variationFactor = event.variationFactor;
      if (canonicalClass === 'variation') {
        const baseFactor = extractVariationFactorFromReason(reason);
        if (normalizedVal === 'variation:resilient') {
          variationFactor = { ...baseFactor, polarity: 'resilient', category: 'response' };
        } else if (normalizedVal === 'variation:negative') {
          variationFactor = { ...baseFactor, polarity: 'negative' };
        } else {
          variationFactor = baseFactor;
        }
      }
      results.set(id, {
        ...event,
        classification: canonicalClass,
        classificationReason: reason,
        classificationSourceRefs: references,
        classificationFactIds: undefined,
        ...(variationFactor ? { variationFactor } : {}),
      });
    } catch (error) { issues.push({ row, message: error instanceof Error ? error.message : String(error) }); }
  }
  return {
    issues,
    normalizedDoc,
    ...(warnings.length ? { warnings } : {}),
    analysis: issues.length
      ? undefined
      : {
          ...analysis,
          events: analysis.events.map((event) => {
            if (isIdentifiedOutcomeEvent(analysis, event)) return event;
            return results.get(event.id) ?? event;
          }),
        },
  };
}
