import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import type { VTAAnalysisData, VTANormalizationAudit, VTASourceRef } from '../../types/vta';

const formatRefs = (refs: VTASourceRef[] | undefined): string =>
  (refs ?? []).map((r) => `${r.sourceId}/${r.paragraphId}`).join(', ') || '-';

const treatmentText = (t: string | undefined): string => {
  if (t === 'evaluative_word_removed') return '評価語を除去';
  if (t === 'kept_as_quoted_claim') return '供述（claim）として引用保持';
  if (t === 'action_only') return '客観的行為のみ記録';
  return '原文に存在（アプリ検知）';
};

const detectedByText = (d: 'app' | 'llm' | 'both'): string => {
  if (d === 'both') return 'アプリ＋AI';
  if (d === 'llm') return 'AI検知';
  return 'アプリ辞書';
};

const escMd = (s: string): string => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

export function formatNormalizationAuditMarkdown(audit: VTANormalizationAudit | undefined): string {
  if (!audit) return '';
  const hasCorrections = audit.corrections.length > 0;
  const hasNotices = audit.subjectiveNotices.length > 0;
  const hasIterations = (audit.iterations?.length ?? 0) > 0;
  if (!hasCorrections && !hasNotices && !hasIterations) return '';

  const lines: string[] = ['## 付録：入力正規化・主観表現点検・粒度評価の記録'];
  if (hasCorrections) {
    lines.push('', '### 1. 表記統一・誤字脱字の補正記録', '', '| ID | 種別 | 原文表記 | 統一・補正後 | 原文参照 | 理由 |', '|---|---|---|---|---|---|');
    for (const c of audit.corrections) {
      const kindLabel = c.kind === 'alias_unification' ? '表記統一' : '誤字・脱字補正';
      lines.push(`| ${escMd(c.id)} | ${kindLabel} | ${escMd(c.from)} | ${escMd(c.to)} | ${escMd(formatRefs(c.sourceRefs))} | ${escMd(c.reason)} |`);
    }
  }
  if (hasNotices) {
    lines.push('', '### 2. 原文の主観・評価表現の点検記録', '', '| ID | 検知語句 | 原文参照 | 関連イベント | 処理区分 | 検知元 |', '|---|---|---|---|---|---|');
    for (const n of audit.subjectiveNotices) {
      lines.push(
        `| ${escMd(n.id)} | ${escMd(n.phrase)} | ${escMd(formatRefs(n.sourceRefs))} | ${escMd(n.eventIds.join(', ') || '-')} | ${treatmentText(n.treatment)} | ${detectedByText(n.detectedBy)} |`
      );
    }
  }
  if (hasIterations && audit.iterations) {
    lines.push('', '### 3. 主体粒度・ツリー複雑度の反復評価履歴', '', '| 反復 | 総合スコア S | C1 主体適正 | C2 役割一貫 | C3 連鎖接続 | C4 境界妥当 | C5 認知負荷 | 採用 | 適用操作 |', '|---|---|---|---|---|---|---|---|---|');
    for (const it of audit.iterations) {
      lines.push(
        `| #${it.index} | ${it.score.toFixed(3)} | ${it.metrics.c1.toFixed(2)} | ${it.metrics.c2 !== undefined ? it.metrics.c2.toFixed(2) : '-'} | ${it.metrics.c3.toFixed(2)} | ${it.metrics.c4 !== undefined ? it.metrics.c4.toFixed(2) : '-'} | ${it.metrics.c5.toFixed(2)} | ${it.adopted ? '採用' : '不採用'} | ${escMd(it.operations.join(', ') || '初期状態')} |`
      );
    }
  }
  return lines.join('\n');
}

export function formatNormalizationAuditJSON(audit: VTANormalizationAudit | undefined): string {
  return JSON.stringify(audit ?? { version: 1, corrections: [], subjectiveNotices: [] }, null, 2);
}

interface Props {
  analysis: VTAAnalysisData;
}

export const NormalizationAuditPanel: React.FC<Props> = ({ analysis }) => {
  const audit = analysis.normalizationAudit;
  const [copiedFormat, setCopiedFormat] = useState<'md' | 'json' | null>(null);
  const openNormalizationAuditExportModal = useVTAStore((state) => state.openNormalizationAuditExportModal);

  if (!audit) {
    return (
      <details className="rounded border border-slate-700 bg-slate-900/70 p-2 text-xs text-slate-300">
        <summary className="cursor-pointer font-semibold text-slate-300">
          正規化・表現点検の記録（記録なし）
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-slate-400">
            記録なし（旧形式または記録未生成）
          </p>
          <button
            type="button"
            onClick={() => openNormalizationAuditExportModal(analysis)}
            className="rounded border border-cyan-700 bg-cyan-950/80 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-900 font-semibold flex items-center gap-1 cursor-pointer"
            title="正規化後の全事象・関係・背景・未参照段落の監査帳票を出力"
          >
            <FileText className="w-3 h-3 text-cyan-400" />
            <span>正規化監査全体帳票を出力 (Markdown/TSV)</span>
          </button>
        </div>
      </details>
    );
  }

  const aliasCount = audit.corrections.filter((c) => c.kind === 'alias_unification').length;
  const typoCount = audit.corrections.filter((c) => c.kind === 'typo_fix').length;
  const noticeCount = audit.subjectiveNotices.length;
  const iterCount = audit.iterations?.length ?? 0;
  const totalCount = audit.corrections.length + noticeCount + iterCount;

  const copyText = async (text: string, kind: 'md' | 'json') => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedFormat(kind);
        setTimeout(() => setCopiedFormat(null), 2000);
      }
    } catch {}
  };

  return (
    <details className="rounded border border-slate-700 bg-slate-900/70 p-2 text-xs text-slate-200" open={totalCount > 0}>
      <summary className="cursor-pointer font-semibold text-cyan-200">
        正規化・表現点検の記録（表記統一 {aliasCount}件・誤字補正 {typoCount}件・主観表現 {noticeCount}件{iterCount > 0 ? `・反復評価 ${iterCount}回` : ''}）
      </summary>
      <div className="mt-2 space-y-2.5">
        <p className="text-[11px] text-slate-400">
          原文は変更せず保持しています。表記ゆれの統一、誤字・脱字の補正、および原文に含まれる主観・評価表現の扱いを以下に記録しています（処理は停止しません）。
        </p>

        {audit.corrections.length > 0 ? (
          <div className="space-y-1">
            <div className="font-semibold text-[11px] text-slate-200">表記統一・誤字脱字の補正一覧（{audit.corrections.length}件）</div>
            <div className="max-h-36 overflow-y-auto space-y-1">
              {audit.corrections.map((c) => (
                <div key={c.id} className="rounded border border-slate-800 bg-slate-950/70 px-2 py-1 text-[11px] space-y-0.5">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-semibold text-slate-100">
                      <span className="mr-1.5 rounded bg-cyan-950 border border-cyan-700/70 px-1 py-0.2 text-[10px] text-cyan-200">
                        {c.kind === 'alias_unification' ? '表記統一' : '誤字補正'}
                      </span>
                      「{c.from}」 → 「{c.to}」
                    </span>
                    <span className="text-[10px] text-slate-400">参照: {formatRefs(c.sourceRefs)}</span>
                  </div>
                  <div className="text-[10px] text-slate-400">{c.reason}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-slate-400">表記統一・誤字脱字の補正記録はありません。</p>
        )}

        {audit.subjectiveNotices.length > 0 ? (
          <div className="space-y-1">
            <div className="font-semibold text-[11px] text-slate-200">原文の主観・評価表現の点検一覧（{audit.subjectiveNotices.length}件）</div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {audit.subjectiveNotices.map((n) => (
                <div key={n.id} className="rounded border border-slate-800 bg-slate-950/70 px-2 py-1 text-[11px] space-y-0.5">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-semibold text-amber-200">
                      語句：「{n.phrase}」
                      <span className="ml-1.5 rounded bg-slate-800 px-1 py-0.2 text-[10px] font-normal text-slate-300">
                        {detectedByText(n.detectedBy)}
                      </span>
                    </span>
                    <span className="text-[10px] text-slate-400">参照: {formatRefs(n.sourceRefs)}</span>
                  </div>
                  <div className="text-[10px] text-slate-300 flex flex-wrap gap-x-2">
                    <span>扱い: {treatmentText(n.treatment)}</span>
                    {n.eventIds.length > 0 && <span>関連イベント: {n.eventIds.join(', ')}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-slate-400">主観・評価表現の検知記録はありません。</p>
        )}

        {audit.iterations && audit.iterations.length > 0 && (
          <div className="space-y-1">
            <div className="font-semibold text-[11px] text-slate-200">粒度反復・複雑度評価の履歴（{audit.iterations.length}回）</div>
            <div className="max-h-36 overflow-y-auto space-y-1">
              {audit.iterations.map((it) => (
                <div key={it.index} className="rounded border border-slate-800 bg-slate-950/70 px-2 py-1 text-[11px] space-y-0.5">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-semibold text-slate-100">
                      反復 #{it.index} — 総合スコア S: {it.score.toFixed(3)}
                    </span>
                    <span className={it.adopted ? 'text-emerald-300 font-semibold text-[10px]' : 'text-amber-300 text-[10px]'}>
                      {it.adopted ? '採用' : '不採用（ゲート違反またはスコア低下）'}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 flex flex-wrap gap-x-2">
                    <span>C1(主体): {it.metrics.c1.toFixed(2)}</span>
                    {it.metrics.c2 !== undefined && <span>C2(役割): {it.metrics.c2.toFixed(2)}</span>}
                    <span>C3(連鎖): {it.metrics.c3.toFixed(2)}</span>
                    {it.metrics.c4 !== undefined && <span>C4(境界): {it.metrics.c4.toFixed(2)}</span>}
                    <span>C5(認知負荷): {it.metrics.c5.toFixed(2)}</span>
                  </div>
                  {it.operations.length > 0 && (
                    <div className="text-[10px] text-slate-300">操作: {it.operations.join(', ')}</div>
                  )}
                  {it.gateViolations.length > 0 && (
                    <div className="text-[10px] text-rose-300">ゲート違反: {it.gateViolations.join(' / ')}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800">
          <button
            type="button"
            onClick={() => openNormalizationAuditExportModal(analysis)}
            className="rounded border border-cyan-700 bg-cyan-950/80 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-900 font-semibold flex items-center gap-1 cursor-pointer"
            title="正規化後の全事象・関係・除外・未参照段落を網羅した監査帳票を出力"
          >
            <FileText className="w-3 h-3 text-cyan-400" />
            <span>正規化監査全体帳票を出力 (Markdown/TSV)</span>
          </button>
          {totalCount > 0 && (
            <>
              <button
                type="button"
                onClick={() => void copyText(formatNormalizationAuditMarkdown(audit), 'md')}
                className="rounded border border-slate-600 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-slate-700 cursor-pointer"
              >
                {copiedFormat === 'md' ? '差分Markdownをコピーしました' : '差分記録のみMarkdownコピー'}
              </button>
              <button
                type="button"
                onClick={() => void copyText(formatNormalizationAuditJSON(audit), 'json')}
                className="rounded border border-slate-600 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-slate-700 cursor-pointer"
              >
                {copiedFormat === 'json' ? 'JSONをコピーしました' : '差分記録のみJSONコピー'}
              </button>
            </>
          )}
        </div>
      </div>
    </details>
  );
};
