import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Copy, Download, X, Check, AlertCircle, FileSpreadsheet, Code } from 'lucide-react';
import { useVTAStore } from '../store/vtaStore';
import {
  generateNormalizationAuditMarkdown,
  generateNormalizationAuditTSV,
  generateNormalizationAuditJSON,
  calculateSourceCoverage,
} from '../utils/normalizationAuditExport';

interface NormalizationAuditExportModalProps {
  isActive?: boolean;
}

export const NormalizationAuditExportModal: React.FC<NormalizationAuditExportModalProps> = ({
  isActive = true,
}) => {
  const isModalOpen = useVTAStore((state) => state.isNormalizationAuditExportModalOpen);
  const closeModal = useVTAStore((state) => state.closeNormalizationAuditExportModal);
  const targetAnalysis = useVTAStore((state) => state.normalizationAuditTargetAnalysis);
  const defaultAnalysis = useVTAStore((state) => state.vtaData.analysis);
  const activeAnalysis = targetAnalysis ?? defaultAnalysis;

  const [activeTab, setActiveTab] = useState<'md' | 'tsv' | 'json'>('md');
  const [includeAuditCheckboxes, setIncludeAuditCheckboxes] = useState(true);
  const [includeUnreferencedSection, setIncludeUnreferencedSection] = useState(true);
  const [includeFullCoverageMatrix, setIncludeFullCoverageMatrix] = useState(false);
  const [copied, setCopied] = useState(false);

  // Close on Escape key
  React.useEffect(() => {
    if (!isModalOpen || !isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, isActive, closeModal]);

  const coverage = useMemo(() => {
    if (!activeAnalysis) return null;
    return calculateSourceCoverage(activeAnalysis);
  }, [activeAnalysis]);

  const generatedContent = useMemo(() => {
    if (!activeAnalysis) return '';
    const options = {
      includeAuditCheckboxes,
      includeUnreferencedSection,
      includeFullCoverageMatrix,
      projectName: 'FailurePrism VTA分析プロジェクト',
    };

    if (activeTab === 'tsv') {
      return generateNormalizationAuditTSV(activeAnalysis, options);
    }
    if (activeTab === 'json') {
      return generateNormalizationAuditJSON(activeAnalysis);
    }
    return generateNormalizationAuditMarkdown(activeAnalysis, options);
  }, [
    activeAnalysis,
    activeTab,
    includeAuditCheckboxes,
    includeUnreferencedSection,
    includeFullCoverageMatrix,
  ]);

  const handleCopy = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(generatedContent);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      console.error('Failed to copy audit text:', err);
    }
  };

  const handleDownload = () => {
    const ext = activeTab === 'tsv' ? 'tsv' : activeTab === 'json' ? 'json' : 'md';
    const mime =
      activeTab === 'tsv'
        ? 'text/tab-separated-values;charset=utf-8;'
        : activeTab === 'json'
        ? 'application/json;charset=utf-8;'
        : 'text/markdown;charset=utf-8;';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `VTA_Normalization_Audit_${timestamp}.${ext}`;

    const blob = new Blob([generatedContent], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!isModalOpen || !isActive || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="normalization-audit-export-modal-title"
        className="bg-slate-900 border border-slate-700/90 rounded-2xl max-w-4xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-150 select-text"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-950/90 border border-cyan-800 text-cyan-400 shadow-inner">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3
                id="normalization-audit-export-modal-title"
                className="font-bold text-base text-slate-100 flex items-center gap-2"
              >
                正規化後データ 監査テキスト出力
              </h3>
              <p className="text-xs text-slate-400">
                AI正規化結果と原文の突合・証跡査閲・Excel共同点検用テキストのエクスポート
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Coverage Overview Banner */}
        {coverage && (
          <div className="px-6 py-2.5 bg-slate-950/50 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-4">
              <span className="text-slate-300">
                原文カバレッジ率:
                <strong
                  className={`ml-1.5 font-bold ${
                    coverage.coverageRate >= 90
                      ? 'text-emerald-400'
                      : coverage.coverageRate >= 70
                      ? 'text-cyan-400'
                      : 'text-amber-400'
                  }`}
                >
                  {coverage.coverageRate.toFixed(1)}%
                </strong>
              </span>
              <span className="text-slate-400 text-[11px]">
                (採用 {coverage.referencedBodyCount} / 本文全 {coverage.bodyParagraphsCount} 段落)
              </span>
              {coverage.unreferencedCount > 0 ? (
                <span className="px-2 py-0.5 rounded bg-amber-950/80 border border-amber-700/80 text-amber-300 text-[11px] font-semibold flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
                  未参照段落: {coverage.unreferencedCount} 件
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-700/80 text-emerald-300 text-[11px] font-semibold">
                  全本文採用済 (脱落ゼロ)
                </span>
              )}
            </div>

            <div className="text-[11px] text-slate-400">
              イベント {activeAnalysis?.events.length ?? 0} 件 · 主体 {activeAnalysis?.entities.length ?? 0} 者 · 関係 {activeAnalysis?.relations.length ?? 0} 件
            </div>
          </div>
        )}

        {/* Content Body */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1 text-xs text-slate-200">
          {/* Format Tabs & Options */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
            {/* Format Selection Tabs */}
            <div className="flex items-center gap-1.5 p-1 bg-slate-900 rounded-lg border border-slate-700/80">
              <button
                type="button"
                onClick={() => setActiveTab('md')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs transition-colors cursor-pointer ${
                  activeTab === 'md'
                    ? 'bg-cyan-600 text-white font-semibold shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Markdown (.md)</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('tsv')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs transition-colors cursor-pointer ${
                  activeTab === 'tsv'
                    ? 'bg-cyan-600 text-white font-semibold shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Excel用 TSV (.tsv)</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('json')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs transition-colors cursor-pointer ${
                  activeTab === 'json'
                    ? 'bg-cyan-600 text-white font-semibold shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Code className="w-3.5 h-3.5" />
                <span>監査JSON (.json)</span>
              </button>
            </div>

            {/* Checkbox Options */}
            {activeTab !== 'json' && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
                <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-100">
                  <input
                    type="checkbox"
                    checked={includeAuditCheckboxes}
                    onChange={(e) => setIncludeAuditCheckboxes(e.target.checked)}
                    className="rounded border-slate-700 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                  />
                  <span>監査チェック欄 ([ ] OK) 付与</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-100">
                  <input
                    type="checkbox"
                    checked={includeUnreferencedSection}
                    onChange={(e) => setIncludeUnreferencedSection(e.target.checked)}
                    className="rounded border-slate-700 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                  />
                  <span>未参照段落の警告一覧を含める</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-100">
                  <input
                    type="checkbox"
                    checked={includeFullCoverageMatrix}
                    onChange={(e) => setIncludeFullCoverageMatrix(e.target.checked)}
                    className="rounded border-slate-700 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                  />
                  <span>全段落対照マトリクスを含める</span>
                </label>
              </div>
            )}
          </div>

          {/* Preview Box */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>プレビュー（{generatedContent.length.toLocaleString()} 文字）</span>
              <span>
                {activeTab === 'md'
                  ? 'GitHub Flavored Markdown'
                  : activeTab === 'tsv'
                  ? 'タブ区切りテキスト (Excel貼付可)'
                  : 'JSON データ証跡'}
              </span>
            </div>
            <textarea
              readOnly
              value={generatedContent}
              className="w-full h-80 bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-slate-300 leading-relaxed focus:outline-none resize-none select-text"
            />
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-slate-950/70 border-t border-slate-800 flex items-center justify-between gap-3">
          <div className="text-[11px] text-slate-400">
            ※ 出力データはブラウザ内でローカル生成され、外部送信されません。
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 text-xs text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              閉じる
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-cyan-200 hover:text-white bg-slate-800 hover:bg-slate-750 border border-cyan-700/80 rounded-lg transition-colors cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>コピー完了！</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 text-cyan-400" />
                  <span>クリップボードにコピー</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-gradient-to-r from-cyan-600 to-sky-600 hover:from-cyan-500 hover:to-sky-500 rounded-lg shadow-md shadow-cyan-950/50 transition-all cursor-pointer"
            >
              <Download className="w-4 h-4 text-cyan-200" />
              <span>ファイルとしてダウンロード (.{activeTab})</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
