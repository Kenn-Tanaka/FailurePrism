import type {
  VTAAnalysisData,
  VTAEvent,
  VTAEntity,
  VTAParticipation,
  VTAEventRelation,
  VTASourceDisposition,
  VTASource,
  VTASourceRef,
  VariationFactorDetail,
  VTAOutcomeKind,
  VTANodeType,
} from '../../../types/vta';

export interface AuditExportOptions {
  projectName?: string;
  scenarioTitle?: string;
  includeAuditCheckboxes?: boolean;
  includeUnreferencedSection?: boolean;
  includeFullCoverageMatrix?: boolean;
  includeInferenceWarnings?: boolean;
}

export interface ParagraphUsage {
  sourceId: string;
  paragraphId: string;
  text: string;
  pdfPage: number | null;
  usedByEvents: string[];
  usedByDispositions: string[];
  usedByCorrections: string[];
  usedByNotices: string[];
  isStructuralDelimiter: boolean;
  isUnreferenced: boolean;
}

export interface SourceCoverageStats {
  totalParagraphs: number;
  bodyParagraphsCount: number;
  referencedBodyCount: number;
  unreferencedCount: number;
  coverageRate: number; // 0 - 100 (%)
  usages: ParagraphUsage[];
  unreferencedUsages: ParagraphUsage[];
}

/**
 * Maps each paragraph ID (or "sourceId/paragraphId") to its corresponding PDF page number if detected
 */
export function buildParagraphPageMap(sources: VTASource[] = []): Map<string, number | null> {
  const pageMap = new Map<string, number | null>();
  for (const source of sources) {
    let currentPage: number | null = null;
    for (const p of source.paragraphs) {
      const match = p.text.match(/### 【PDF ページ (\d+)(?:\/\d+)?】/);
      if (match) {
        currentPage = parseInt(match[1], 10);
      }
      pageMap.set(`${source.id}/${p.id}`, currentPage);
      pageMap.set(p.id, currentPage);
    }
  }
  return pageMap;
}

export function formatSourceRefWithPage(
  ref: VTASourceRef,
  pageMap: Map<string, number | null>
): string {
  const key = `${ref.sourceId}/${ref.paragraphId}`;
  const page = pageMap.get(key) ?? pageMap.get(ref.paragraphId);
  return page != null ? `${ref.sourceId}/${ref.paragraphId} [PDF P.${page}]` : `${ref.sourceId}/${ref.paragraphId}`;
}

export function formatSourceRefs(
  refs: VTASourceRef[] | undefined,
  pageMap: Map<string, number | null>
): string {
  if (!refs || refs.length === 0) return '-';
  return refs.map((r) => formatSourceRefWithPage(r, pageMap)).join(', ');
}

export function formatVariationFactor(detail?: VariationFactorDetail): string {
  if (!detail) return '-';
  const parts: string[] = [];

  const polLabel = detail.polarity === 'resilient' ? '【レジリエンス要因】' : '【負の要因】';
  parts.push(polLabel);

  if (detail.category === 'response') {
    const lvl =
      detail.cognitiveLevel === 'skill'
        ? 'Skillベース'
        : detail.cognitiveLevel === 'rule'
        ? 'Ruleベース'
        : detail.cognitiveLevel === 'knowledge'
        ? 'Knowledgeベース'
        : '行動レベル特定中';
    parts.push(`状態変化への応答 (${lvl})`);
  } else if (detail.category === 'internal') {
    parts.push('内部要因 (主体またはサブ部品の異常)');
  } else if (detail.category === 'departure') {
    parts.push('通常作業からの逸脱 (人為的行為)');
  } else if (detail.category === 'external') {
    parts.push('外部要因');
  }

  if (detail.description) {
    parts.push(detail.description);
  }

  return parts.join(' ');
}

export function formatOutcomeKind(kind?: VTAOutcomeKind): string {
  if (!kind) return '-';
  if (kind === 'loss') return '損失発生';
  if (kind === 'near_miss') return '直前停止';
  if (kind === 'recovery') return 'レジリエンス復帰';
  return kind;
}

export function formatEventClassification(
  classification: VTANodeType,
  outcome_kind?: VTAOutcomeKind
): string {
  if (classification === 'outcome') {
    const kind = formatOutcomeKind(outcome_kind);
    return `帰結ノード (${kind})`;
  }
  if (classification === 'variation') return '変動要因';
  if (classification === 'normal') return '通常作業';
  if (classification === 'undetermined') return '判定保留';
  return '未判定';
}

/**
 * Escapes characters for Markdown tables
 */
function escMd(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Escapes characters for TSV cells
 */
function escTsv(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * Analyzes which source paragraphs are referenced by events, dispositions, or normalization audit,
 * and identifies unreferenced/omitted paragraphs.
 */
export function calculateSourceCoverage(analysis: VTAAnalysisData): SourceCoverageStats {
  const sources = analysis.sources ?? [];
  const pageMap = buildParagraphPageMap(sources);

  const eventRefsByPara = new Map<string, string[]>();
  for (const e of analysis.events) {
    for (const ref of e.sourceRefs ?? []) {
      const k = `${ref.sourceId}/${ref.paragraphId}`;
      if (!eventRefsByPara.has(k)) eventRefsByPara.set(k, []);
      eventRefsByPara.get(k)!.push(e.id);
    }
  }

  const dispRefsByPara = new Map<string, string[]>();
  for (const d of analysis.dispositions ?? []) {
    for (const ref of d.sourceRefs ?? [d]) {
      const k = `${ref.sourceId}/${ref.paragraphId}`;
      if (!dispRefsByPara.has(k)) dispRefsByPara.set(k, []);
      dispRefsByPara.get(k)!.push(`${d.id}(${d.kind})`);
    }
  }

  const corrRefsByPara = new Map<string, string[]>();
  for (const c of analysis.normalizationAudit?.corrections ?? []) {
    for (const ref of c.sourceRefs) {
      const k = `${ref.sourceId}/${ref.paragraphId}`;
      if (!corrRefsByPara.has(k)) corrRefsByPara.set(k, []);
      corrRefsByPara.get(k)!.push(c.id);
    }
  }

  const noticeRefsByPara = new Map<string, string[]>();
  for (const n of analysis.normalizationAudit?.subjectiveNotices ?? []) {
    for (const ref of n.sourceRefs) {
      const k = `${ref.sourceId}/${ref.paragraphId}`;
      if (!noticeRefsByPara.has(k)) noticeRefsByPara.set(k, []);
      noticeRefsByPara.get(k)!.push(n.id);
    }
  }

  const usages: ParagraphUsage[] = [];
  let totalParagraphs = 0;
  let bodyParagraphsCount = 0;
  let referencedBodyCount = 0;

  for (const s of sources) {
    for (const p of s.paragraphs) {
      totalParagraphs++;
      const isDelim = /^### 【PDF ページ \d+(?:\/\d+)?】$/.test(p.text.trim()) || !p.text.trim();
      const k = `${s.id}/${p.id}`;

      const events = eventRefsByPara.get(k) ?? [];
      const disps = dispRefsByPara.get(k) ?? [];
      const corrs = corrRefsByPara.get(k) ?? [];
      const notices = noticeRefsByPara.get(k) ?? [];

      const isRef = events.length > 0 || disps.length > 0 || corrs.length > 0 || notices.length > 0;

      if (!isDelim) {
        bodyParagraphsCount++;
        if (isRef) referencedBodyCount++;
      }

      usages.push({
        sourceId: s.id,
        paragraphId: p.id,
        text: p.text,
        pdfPage: pageMap.get(k) ?? null,
        usedByEvents: events,
        usedByDispositions: disps,
        usedByCorrections: corrs,
        usedByNotices: notices,
        isStructuralDelimiter: isDelim,
        isUnreferenced: !isDelim && !isRef,
      });
    }
  }

  const unreferencedUsages = usages.filter((u) => u.isUnreferenced);
  const coverageRate = bodyParagraphsCount > 0 ? (referencedBodyCount / bodyParagraphsCount) * 100 : 100;

  return {
    totalParagraphs,
    bodyParagraphsCount,
    referencedBodyCount,
    unreferencedCount: unreferencedUsages.length,
    coverageRate,
    usages,
    unreferencedUsages,
  };
}

/**
 * Generates an exhaustive human-readable Markdown Audit Report from normalized VTA data
 */
export function generateNormalizationAuditMarkdown(
  analysis: VTAAnalysisData,
  options: AuditExportOptions = {}
): string {
  const {
    projectName = 'VTAプロジェクト',
    includeAuditCheckboxes = true,
    includeUnreferencedSection = true,
    includeFullCoverageMatrix = false,
    includeInferenceWarnings = true,
  } = options;

  const pageMap = buildParagraphPageMap(analysis.sources ?? []);
  const coverage = calculateSourceCoverage(analysis);
  const audit = analysis.normalizationAudit;

  const lines: string[] = [];

  // Header
  lines.push(`# VTA正規化処理 監査記録書（Normalization Audit Report）`);
  lines.push('');
  lines.push(`- **対象プロジェクト**: ${projectName}`);
  lines.push(`- **出力日時**: ${new Date().toLocaleString('ja-JP')}`);
  lines.push(`- **データ形式バージョン**: v${analysis.version}`);
  if (analysis.generation) {
    lines.push(`- **正規化方式**: ${analysis.generation.schemeId} (${analysis.generation.schemeVersion})`);
    lines.push(`- **推論モデル**: ${analysis.generation.model}`);
  }
  lines.push('');

  // 1. Executive Summary & Alerts
  lines.push(`## 1. 監査メタデータ・全体サマリー`);
  lines.push('');

  const normalEvents = analysis.events.filter((e) => e.classification === 'normal');
  const variationEvents = analysis.events.filter((e) => e.classification === 'variation');
  const outcomeEvents = analysis.events.filter((e) => e.classification === 'outcome');
  const otherEvents = analysis.events.filter(
    (e) => !['normal', 'variation', 'outcome'].includes(e.classification)
  );

  lines.push(`### 1.1 構造化実績サマリー`);
  lines.push(`- **総イベント数**: **${analysis.events.length}** 件`);
  lines.push(`  - 通常作業ノード: **${normalEvents.length}** 件`);
  lines.push(`  - 変動要因ノード: **${variationEvents.length}** 件`);
  lines.push(`  - 帰結ノード: **${outcomeEvents.length}** 件`);
  if (otherEvents.length > 0) {
    lines.push(`  - 未分類/保留: **${otherEvents.length}** 件`);
  }
  lines.push(`- **抽出主体数**: **${analysis.entities.length}** 者`);
  lines.push(`- **事象間関係数**: **${analysis.relations.length}** 件`);
  lines.push(`- **背景・除外判定数**: **${analysis.dispositions?.length ?? 0}** 件`);
  lines.push('');

  lines.push(`### 1.2 原文カバレッジ（網羅性）`);
  lines.push(`- **原文本文段落数**: ${coverage.bodyParagraphsCount} 段落 (全 ${coverage.totalParagraphs} 行)`);
  lines.push(`- **事象・背景等への採用**: ${coverage.referencedBodyCount} 段落`);
  lines.push(`- **未参照段落**: **${coverage.unreferencedCount}** 段落`);
  lines.push(`- **原文カバレッジ率**: **${coverage.coverageRate.toFixed(1)}%**`);
  lines.push('');

  // Highlight items: Inferred subjects / AI context inference
  const inferredParticipations = analysis.participations.filter(
    (p) => p.inferred || p.evidenceBasis === 'source-context'
  );
  const inferredEventIds = Array.from(new Set(inferredParticipations.map((p) => p.eventId)));

  if (includeInferenceWarnings) {
    lines.push(`### 1.3 要点検アラート`);
    if (inferredEventIds.length > 0) {
      lines.push(
        `- ⚠️ **AIによる文脈推論・主体の推定補完**: **${inferredEventIds.length}** 件のイベントに関与 (${inferredEventIds.join(
          ', '
        )})`
      );
    } else {
      lines.push(`- ✅ AIによる文脈推論（主体推定）の関与はありません。すべての主体は原文に直載されています。`);
    }

    const noticeCount = audit?.subjectiveNotices.length ?? 0;
    if (noticeCount > 0) {
      lines.push(`- 🔍 **原文の主観・評価表現の検知と処置**: **${noticeCount}** 件`);
    }

    const corrCount = audit?.corrections.length ?? 0;
    if (corrCount > 0) {
      lines.push(`- ✍️ **表記ゆれ統一・誤字脱字の補正**: **${corrCount}** 件`);
    }

    if (coverage.unreferencedCount > 0) {
      lines.push(`- ⚠️ **未参照段落（脱落懸念）**: **${coverage.unreferencedCount}** 段落が存在します。第3章を確認してください。`);
    }
    lines.push('');
  }

  // 2. Normalization Corrections & Subjective Notices
  lines.push(`## 2. 表記統一および主観・評価表現の処置記録`);
  lines.push('');

  if (audit && audit.corrections.length > 0) {
    lines.push(`### 2.1 表記ゆれ統一・誤字脱字の補正一覧（${audit.corrections.length}件）`);
    lines.push('');
    lines.push(
      `| ID | 区分 | 原文表記 | 統一・補正後 | 原文参照 | 補正理由 |${includeAuditCheckboxes ? ' 監査確認 |' : ''}`
    );
    lines.push(
      `|---|---|---|---|---|---|${includeAuditCheckboxes ? '---|' : ''}`
    );
    for (const c of audit.corrections) {
      const kindLabel = c.kind === 'alias_unification' ? '表記統一' : '誤字補正';
      lines.push(
        `| ${escMd(c.id)} | ${kindLabel} | ${escMd(c.from)} | ${escMd(c.to)} | ${escMd(
          formatSourceRefs(c.sourceRefs, pageMap)
        )} | ${escMd(c.reason)} |${includeAuditCheckboxes ? ' [ ] OK |' : ''}`
      );
    }
    lines.push('');
  } else {
    lines.push(`### 2.1 表記ゆれ統一・誤字脱字の補正一覧`);
    lines.push(`> 補正記録はありません（原文の表記がそのまま維持されています）。`);
    lines.push('');
  }

  if (audit && audit.subjectiveNotices.length > 0) {
    lines.push(`### 2.2 原文の主観・評価表現の検知と処置一覧（${audit.subjectiveNotices.length}件）`);
    lines.push('');
    lines.push(
      `| ID | 検知語句 | 処置区分 | 関連イベント | 原文参照 | 検知元 |${includeAuditCheckboxes ? ' 監査確認 |' : ''}`
    );
    lines.push(
      `|---|---|---|---|---|---|${includeAuditCheckboxes ? '---|' : ''}`
    );
    for (const n of audit.subjectiveNotices) {
      const treatmentLabel =
        n.treatment === 'evaluative_word_removed'
          ? '評価語を除去'
          : n.treatment === 'kept_as_quoted_claim'
          ? '供述引用として保持'
          : n.treatment === 'action_only'
          ? '客観的行為のみ記録'
          : '検知記録';
      const detectedLabel =
        n.detectedBy === 'both' ? 'アプリ＋AI' : n.detectedBy === 'llm' ? 'AI検知' : 'アプリ辞書';
      lines.push(
        `| ${escMd(n.id)} | ${escMd(n.phrase)} | ${treatmentLabel} | ${escMd(
          n.eventIds.join(', ') || '-'
        )} | ${escMd(formatSourceRefs(n.sourceRefs, pageMap))} | ${detectedLabel} |${
          includeAuditCheckboxes ? ' [ ] OK |' : ''
        }`
      );
    }
    lines.push('');
  } else {
    lines.push(`### 2.2 原文の主観・評価表現の検知と処置一覧`);
    lines.push(`> 原文に主観的・評価的表現の過剰な混入は検知されませんでした。`);
    lines.push('');
  }

  // 3. Unreferenced Paragraphs
  if (includeUnreferencedSection) {
    lines.push(`## 3. 【要点検】原文の未参照・脱落懸念段落一覧（${coverage.unreferencedCount}件）`);
    lines.push('');
    if (coverage.unreferencedCount > 0) {
      lines.push(`> 以下の段落は、イベント・背景・除外のいずれにも採用されていません。事故原因や重要時系列の脱落がないか確認してください。`);
      lines.push('');
      lines.push(
        `| 段落ID | PDF頁 | 原文抜粋（先頭80文字） | 監査確認（脱落有無） |`
      );
      lines.push(`|---|---|---|---|`);
      for (const u of coverage.unreferencedUsages) {
        const pageLabel = u.pdfPage != null ? `P.${u.pdfPage}` : '-';
        const snippet = u.text.length > 80 ? u.text.slice(0, 80) + '...' : u.text;
        lines.push(`| ${u.sourceId}/${u.paragraphId} | ${pageLabel} | ${escMd(snippet)} | [ ] 脱落なし（背景等で許容） |`);
      }
      lines.push('');
    } else {
      lines.push(`> ✅ すべての本文段落がいずれかのイベントまたは背景・除外判定へ紐付いています（未参照段落ゼロ）。`);
      lines.push('');
    }
  }

  // 4. Normalized Events Audit Sheet
  lines.push(`## 4. 正規化イベント台帳（Normalized Events Audit Sheet）`);
  lines.push('');
  lines.push(
    `| イベントID | 発生時刻 | 見出し | 内容詳細 | 区分 | 変動要因分類 / 帰結属性 | 関与主体と役割 | 原文参照 | 判定根拠 |${
      includeAuditCheckboxes ? ' 監査判定 |' : ''
    }`
  );
  lines.push(
    `|---|---|---|---|---|---|---|---|---|${includeAuditCheckboxes ? '---|' : ''}`
  );

  const entityMap = new Map<string, VTAEntity>(analysis.entities.map((ent) => [ent.id, ent]));

  for (const e of analysis.events) {
    const classificationLabel = formatEventClassification(e.classification, e.outcome_kind);
    let detailLabel = '-';
    if (e.classification === 'variation' && e.variationFactor) {
      detailLabel = formatVariationFactor(e.variationFactor);
    } else if (e.classification === 'outcome') {
      detailLabel = formatOutcomeKind(e.outcome_kind);
    }

    // Participants for this event
    const parts = analysis.participations.filter((p) => p.eventId === e.id);
    const participantLabels = parts.map((p) => {
      const entName = entityMap.get(p.entityId)?.name ?? p.entityId;
      const roleName =
        p.role === 'actor'
          ? '発生主体'
          : p.role === 'target'
          ? '対象(客体)'
          : p.role === 'affected'
          ? '影響先'
          : p.role === 'intended_recipient'
          ? '通知先'
          : p.role === 'confirmed_recipient'
          ? '受領先'
          : p.role;
      const inferredTag = p.inferred || p.evidenceBasis === 'source-context' ? '⚠️[推論]' : '';
      return `${entName} [${roleName}]${inferredTag}`;
    });

    const partsStr = participantLabels.join(', ') || '未割当';
    const refsStr = formatSourceRefs(e.sourceRefs, pageMap);
    const reasonStr = e.classificationReason || '-';

    lines.push(
      `| ${escMd(e.id)} | ${escMd(e.time || '-')} | ${escMd(e.title)} | ${escMd(e.description)} | ${escMd(
        classificationLabel
      )} | ${escMd(detailLabel)} | ${escMd(partsStr)} | ${escMd(refsStr)} | ${escMd(reasonStr)} |${
        includeAuditCheckboxes ? ' [ ] OK |' : ''
      }`
    );
  }
  lines.push('');

  // 5. Entities Audit Sheet
  lines.push(`## 5. 主体（当事者・関係組織・設備）の監査記録`);
  lines.push('');
  lines.push(
    `| 主体ID | 主体名称 | 種別 | 報告焦点度 | 採用・統合状態 | 根拠段落 |${
      includeAuditCheckboxes ? ' 監査確認 |' : ''
    }`
  );
  lines.push(`|---|---|---|---|---|---|${includeAuditCheckboxes ? '---|' : ''}`);

  for (const ent of analysis.entities) {
    const kindLabel =
      ent.kind === 'person' ? '人' : ent.kind === 'organization' ? '組織' : ent.kind === 'machine' ? '機械・設備' : 'その他';
    const focusLabel = ent.focus === 'reporter' ? '報告当事者' : ent.focus === 'high' ? '主要主体(高)' : ent.focus === 'mid' ? '中' : '低';
    const focusRefs = formatSourceRefs(ent.focusSourceRefs, pageMap);
    lines.push(
      `| ${escMd(ent.id)} | ${escMd(ent.name)} | ${kindLabel} | ${focusLabel} | レーン採用 | ${escMd(
        focusRefs
      )} |${includeAuditCheckboxes ? ' [ ] OK |' : ''}`
    );
  }
  lines.push('');

  // 6. Causal & Sequential Relations
  lines.push(`## 6. 事象間関係・因果連鎖の監査記録`);
  lines.push('');
  if (analysis.relations.length > 0) {
    lines.push(
      `| 関係ID | 種類 | 元事象 (イベント/主体) | 先事象 (イベント/主体) | 原文参照 | 状態・根拠 |${
        includeAuditCheckboxes ? ' 監査確認 |' : ''
      }`
    );
    lines.push(`|---|---|---|---|---|---|${includeAuditCheckboxes ? '---|' : ''}`);

    for (const r of analysis.relations) {
      const kindLabel =
        r.kind === 'before'
          ? '時間先行'
          : r.kind === 'dependency'
          ? '作業依存'
          : r.kind === 'transfer'
          ? '資源移動'
          : r.kind === 'impact'
          ? '影響関係'
          : r.kind === 'mutual'
          ? '相互関係'
          : '共通要因';
      const fromEnt = (r.sourceEntityId ? entityMap.get(r.sourceEntityId)?.name : undefined) ?? r.sourceEntityId ?? '-';
      const toEnt = (r.targetEntityId ? entityMap.get(r.targetEntityId)?.name : undefined) ?? r.targetEntityId ?? '-';
      const fromStr = `${r.sourceEventId} (${fromEnt})`;
      const toStr = `${r.targetEventId} (${toEnt})`;
      const refsStr = formatSourceRefs(r.sourceRefs, pageMap);
      const basisStr = r.explanation || r.evidenceBasis || '-';

      lines.push(
        `| ${escMd(r.id || '-')} | ${kindLabel} | ${escMd(fromStr)} | ${escMd(toStr)} | ${escMd(refsStr)} | ${escMd(
          basisStr
        )} |${includeAuditCheckboxes ? ' [ ] OK |' : ''}`
      );
    }
    lines.push('');
  } else {
    lines.push(`> 事象間関係（レーン間接続）は未設定です。`);
    lines.push('');
  }

  // 7. Dispositions (Background / Excluded / Review)
  lines.push(`## 7. 背景・除外・要確認事象（Dispositions）の監査記録`);
  lines.push('');
  if (analysis.dispositions && analysis.dispositions.length > 0) {
    lines.push(
      `| ID | 区分 | 原文記述抜粋 | 除外・保留理由 | 原文参照 |${
        includeAuditCheckboxes ? ' 監査判定（除外妥当性） |' : ''
      }`
    );
    lines.push(`|---|---|---|---|---|${includeAuditCheckboxes ? '---|' : ''}`);

    for (const d of analysis.dispositions) {
      const kindLabel = d.kind === 'background' ? '背景記述' : d.kind === 'excluded' ? '分析除外' : '要確認(保留)';
      const textVal = d.text || d.quote || '-';
      const refsStr = formatSourceRefs(d.sourceRefs ?? [d], pageMap);
      lines.push(
        `| ${escMd(d.id)} | ${kindLabel} | ${escMd(textVal)} | ${escMd(d.reason)} | ${escMd(refsStr)} |${
          includeAuditCheckboxes ? ' [ ] 妥当 |' : ''
        }`
      );
    }
    lines.push('');
  } else {
    lines.push(`> 背景・除外記録はありません。`);
    lines.push('');
  }

  // 8. Full Coverage Matrix (Optional)
  if (includeFullCoverageMatrix) {
    lines.push(`## 8. 原文パラグラフ対照マトリクス（Traceability Matrix）`);
    lines.push('');
    lines.push(`| 段落番号 | PDF頁 | 原文抜粋 | 採用先 | 状態 |`);
    lines.push(`|---|---|---|---|---|`);
    for (const u of coverage.usages) {
      if (u.isStructuralDelimiter) continue;
      const pageLabel = u.pdfPage != null ? `P.${u.pdfPage}` : '-';
      const targets: string[] = [];
      if (u.usedByEvents.length) targets.push(`イベント: ${u.usedByEvents.join(',')}`);
      if (u.usedByDispositions.length) targets.push(`除外/背景: ${u.usedByDispositions.join(',')}`);
      if (u.usedByCorrections.length) targets.push(`補正: ${u.usedByCorrections.join(',')}`);
      if (u.usedByNotices.length) targets.push(`主観: ${u.usedByNotices.join(',')}`);
      const targetStr = targets.join(' / ') || '-';
      const statusStr = u.isUnreferenced ? '⚠️ 未参照' : '採用済';
      const snippet = u.text.length > 50 ? u.text.slice(0, 50) + '...' : u.text;

      lines.push(
        `| ${u.sourceId}/${u.paragraphId} | ${pageLabel} | ${escMd(snippet)} | ${escMd(targetStr)} | ${statusStr} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generates an Excel-friendly TSV format for structured tabular auditing
 */
export function generateNormalizationAuditTSV(
  analysis: VTAAnalysisData,
  options: AuditExportOptions = {}
): string {
  const { projectName = 'VTAプロジェクト', includeFullCoverageMatrix = true } = options;

  const pageMap = buildParagraphPageMap(analysis.sources ?? []);
  const coverage = calculateSourceCoverage(analysis);
  const audit = analysis.normalizationAudit;
  const entityMap = new Map<string, VTAEntity>(analysis.entities.map((ent) => [ent.id, ent]));

  const lines: string[] = [];

  // [1. メタデータ]
  lines.push(`### 【1. 監査メタデータ】`);
  lines.push(`項目\t値`);
  lines.push(`プロジェクト名\t${escTsv(projectName)}`);
  lines.push(`出力日時\t${new Date().toLocaleString('ja-JP')}`);
  lines.push(`総イベント数\t${analysis.events.length}`);
  lines.push(`総主体数\t${analysis.entities.length}`);
  lines.push(`事象間関係数\t${analysis.relations.length}`);
  lines.push(`本文段落数\t${coverage.bodyParagraphsCount}`);
  lines.push(`未参照段落数\t${coverage.unreferencedCount}`);
  lines.push(`原文カバレッジ率\t${coverage.coverageRate.toFixed(1)}%`);
  lines.push('');

  // [2. 未参照段落]
  lines.push(`### 【2. 要点検_未参照段落一覧】`);
  lines.push(`段落ID\tPDF頁\t原文抜粋\t監査判定\t監査メモ`);
  if (coverage.unreferencedUsages.length > 0) {
    for (const u of coverage.unreferencedUsages) {
      lines.push(
        `${u.sourceId}/${u.paragraphId}\t${u.pdfPage != null ? u.pdfPage : '-'}\t${escTsv(
          u.text
        )}\t未監査\t`
      );
    }
  } else {
    lines.push(`なし\t-\t未参照段落はありません（網羅率100%）\tOK\t-`);
  }
  lines.push('');

  // [3. イベント台帳]
  lines.push(`### 【3. 正規化イベント台帳】`);
  lines.push(
    `イベントID\t時刻\t見出し\t内容詳細\t変動区分\t変動要因詳細/帰結種別\t関与主体と役割\t原文参照\t判定根拠\t監査判定\t監査指摘メモ\t確認者`
  );
  for (const e of analysis.events) {
    const classificationLabel = formatEventClassification(e.classification, e.outcome_kind);
    let detailLabel = '-';
    if (e.classification === 'variation' && e.variationFactor) {
      detailLabel = formatVariationFactor(e.variationFactor);
    } else if (e.classification === 'outcome') {
      detailLabel = formatOutcomeKind(e.outcome_kind);
    }

    const parts = analysis.participations.filter((p) => p.eventId === e.id);
    const participantLabels = parts.map((p) => {
      const entName = entityMap.get(p.entityId)?.name ?? p.entityId;
      const roleName =
        p.role === 'actor'
          ? '発生主体'
          : p.role === 'target'
          ? '対象(客体)'
          : p.role === 'affected'
          ? '影響先'
          : p.role === 'intended_recipient'
          ? '通知先'
          : p.role === 'confirmed_recipient'
          ? '受領先'
          : p.role;
      const inferredTag = p.inferred || p.evidenceBasis === 'source-context' ? '[推論]' : '';
      return `${entName}[${roleName}]${inferredTag}`;
    });

    lines.push(
      [
        escTsv(e.id),
        escTsv(e.time || '-'),
        escTsv(e.title),
        escTsv(e.description),
        escTsv(classificationLabel),
        escTsv(detailLabel),
        escTsv(participantLabels.join(', ') || '未割当'),
        escTsv(formatSourceRefs(e.sourceRefs, pageMap)),
        escTsv(e.classificationReason || '-'),
        '未監査',
        '',
        '',
      ].join('\t')
    );
  }
  lines.push('');

  // [4. 表記統一・主観表現]
  lines.push(`### 【4. 表記統一・誤字脱字補正】`);
  lines.push(`ID\t区分\t原文表記\t統一補正後\t原文参照\t理由\t監査判定`);
  if (audit && audit.corrections.length > 0) {
    for (const c of audit.corrections) {
      lines.push(
        [
          escTsv(c.id),
          c.kind === 'alias_unification' ? '表記統一' : '誤字補正',
          escTsv(c.from),
          escTsv(c.to),
          escTsv(formatSourceRefs(c.sourceRefs, pageMap)),
          escTsv(c.reason),
          '未監査',
        ].join('\t')
      );
    }
  } else {
    lines.push(`なし\t-\t-\t-\t-\t補正記録なし\t-`);
  }
  lines.push('');

  lines.push(`### 【5. 主観・評価表現の点検記録】`);
  lines.push(`ID\t検知語句\t処置区分\t関連イベント\t原文参照\t理由\t監査判定`);
  if (audit && audit.subjectiveNotices.length > 0) {
    for (const n of audit.subjectiveNotices) {
      const treatmentLabel =
        n.treatment === 'evaluative_word_removed'
          ? '評価語を除去'
          : n.treatment === 'kept_as_quoted_claim'
          ? '供述引用保持'
          : n.treatment === 'action_only'
          ? '客観的行為のみ'
          : '検知記録';
      lines.push(
        [
          escTsv(n.id),
          escTsv(n.phrase),
          treatmentLabel,
          escTsv(n.eventIds.join(', ') || '-'),
          escTsv(formatSourceRefs(n.sourceRefs, pageMap)),
          n.detectedBy,
          '未監査',
        ].join('\t')
      );
    }
  } else {
    lines.push(`なし\t-\t-\t-\t-\t主観表現の混入なし\t-`);
  }
  lines.push('');

  // [6. 主体一覧]
  lines.push(`### 【6. 主体一覧】`);
  lines.push(`主体ID\t名称\t種別\t焦点度\t採用区分\t根拠参照\t監査判定`);
  for (const ent of analysis.entities) {
    lines.push(
      [
        escTsv(ent.id),
        escTsv(ent.name),
        ent.kind,
        ent.focus || 'auto',
        'レーン採用',
        escTsv(formatSourceRefs(ent.focusSourceRefs, pageMap)),
        '未監査',
      ].join('\t')
    );
  }
  lines.push('');

  // [7. 事象間関係]
  lines.push(`### 【7. 事象間関係】`);
  lines.push(`関係ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\t根拠\t監査判定`);
  for (const r of analysis.relations) {
    const fromEnt = (r.sourceEntityId ? entityMap.get(r.sourceEntityId)?.name : undefined) ?? r.sourceEntityId ?? '-';
    const toEnt = (r.targetEntityId ? entityMap.get(r.targetEntityId)?.name : undefined) ?? r.targetEntityId ?? '-';
    lines.push(
      [
        escTsv(r.id || '-'),
        r.kind,
        escTsv(r.sourceEventId),
        escTsv(fromEnt),
        escTsv(r.targetEventId),
        escTsv(toEnt),
        escTsv(formatSourceRefs(r.sourceRefs, pageMap)),
        escTsv(r.explanation || r.evidenceBasis || '-'),
        '未監査',
      ].join('\t')
    );
  }
  lines.push('');

  // [8. 背景・除外]
  lines.push(`### 【8. 背景・除外・要確認】`);
  lines.push(`ID\t区分\t原文テキスト\t理由\t原文参照\t除外判定妥当性`);
  for (const d of analysis.dispositions ?? []) {
    lines.push(
      [
        escTsv(d.id),
        d.kind,
        escTsv(d.text || d.quote || '-'),
        escTsv(d.reason),
        escTsv(formatSourceRefs(d.sourceRefs ?? [d], pageMap)),
        '未監査',
      ].join('\t')
    );
  }
  lines.push('');

  // [9. 原文全段落マトリクス]
  if (includeFullCoverageMatrix) {
    lines.push(`### 【9. 原文全段落対照マトリクス】`);
    lines.push(`段落ID\tPDF頁\t原文抜粋\t採用先\t状態\t監査チェック`);
    for (const u of coverage.usages) {
      if (u.isStructuralDelimiter) continue;
      const targets: string[] = [];
      if (u.usedByEvents.length) targets.push(`イベント:${u.usedByEvents.join(',')}`);
      if (u.usedByDispositions.length) targets.push(`除外:${u.usedByDispositions.join(',')}`);
      if (u.usedByCorrections.length) targets.push(`補正:${u.usedByCorrections.join(',')}`);
      if (u.usedByNotices.length) targets.push(`主観:${u.usedByNotices.join(',')}`);
      lines.push(
        [
          `${u.sourceId}/${u.paragraphId}`,
          u.pdfPage != null ? u.pdfPage : '-',
          escTsv(u.text),
          targets.join('; ') || '-',
          u.isUnreferenced ? '未参照(要点検)' : '採用済',
          '',
        ].join('\t')
      );
    }
  }

  return lines.join('\n');
}

/**
 * Generates JSON formatted audit export
 */
export function generateNormalizationAuditJSON(analysis: VTAAnalysisData): string {
  const coverage = calculateSourceCoverage(analysis);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      coverage: {
        totalParagraphs: coverage.totalParagraphs,
        bodyParagraphsCount: coverage.bodyParagraphsCount,
        referencedBodyCount: coverage.referencedBodyCount,
        unreferencedCount: coverage.unreferencedCount,
        coverageRatePercent: coverage.coverageRate,
        unreferencedParagraphs: coverage.unreferencedUsages.map((u) => ({
          id: `${u.sourceId}/${u.paragraphId}`,
          pdfPage: u.pdfPage,
          text: u.text,
        })),
      },
      analysis,
    },
    null,
    2
  );
}
