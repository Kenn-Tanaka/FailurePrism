import React, { useState } from 'react';
import {
  CheckCircle,
  Copy,
  Code2,
  AlertTriangle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useVTAStore } from '../../features/vta/store/vtaStore';

export const ResultsSection: React.FC = () => {
  const activeTab = useVTAStore((state) => state.activeTab);
  const setActiveTab = useVTAStore((state) => state.setActiveTab);
  const regenerationResult = useVTAStore((state) => state.regenerationResult);
  const isReportOutdated = useVTAStore((state) => state.isReportOutdated);
  const vtaData = useVTAStore((state) => state.vtaData);

  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const handleCopy = (text: string, section: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  return (
    <section className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-3 shadow-md">
      {/* Outdated Notice Banner (DATA-004) */}
      {regenerationResult && isReportOutdated && (
        <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-amber-950/80 border border-amber-500/70 text-amber-200 text-xs shadow-sm animate-in fade-in">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-0.5">
            <p className="font-semibold text-amber-200">ツリー図・対策が変更されました</p>
            <p className="text-[11px] text-amber-300/90 leading-tight">
              表示中のレポートは変更前の状態に基づいています。最新の対策を反映するには「シナリオを再生成」を再実行してください。
            </p>
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex border-b border-slate-800 text-xs">
        <button
          type="button"
          onClick={() => setActiveTab('idealFlow')}
          className={`flex-1 py-1.5 text-center font-medium border-b-2 transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
            activeTab === 'idealFlow'
              ? 'border-emerald-400 text-emerald-300 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>改善された業務フロー</span>
          {regenerationResult && isReportOutdated && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title="再生成が必要" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('analysisReport')}
          className={`flex-1 py-1.5 text-center font-medium border-b-2 transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
            activeTab === 'analysisReport'
              ? 'border-cyan-400 text-cyan-300 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <span>分析・対策レポート</span>
          {regenerationResult && isReportOutdated && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title="再生成が必要" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('scenario')}
          className={`flex-1 py-1.5 text-center font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'scenario'
              ? 'border-purple-400 text-purple-300 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          JSONデータ
        </button>
      </div>

      {/* Tab Content */}
      <div className="min-h-[160px]">
        {activeTab === 'idealFlow' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>フェーズ1: 対策適用後の改善された業務フロー</span>
              {regenerationResult && (
                <button
                  type="button"
                  onClick={() => handleCopy(regenerationResult.idealFlow, 'ideal')}
                  className="flex items-center gap-1 text-slate-400 hover:text-white cursor-pointer"
                >
                  {copiedSection === 'ideal' ? (
                    <CheckCircle className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedSection === 'ideal' ? 'コピー完了' : 'コピー'}</span>
                </button>
              )}
            </div>

            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-xs text-slate-200 leading-relaxed max-h-[340px] overflow-y-auto font-sans [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-sky-300 [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-xs [&_h2]:font-bold [&_h2]:text-cyan-300 [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-amber-300 [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1.5 [&_li]:my-0.5 [&_strong]:text-white [&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-cyan-500 [&_blockquote]:pl-2 [&_blockquote]:italic [&_blockquote]:text-slate-400 [&_code]:bg-slate-900 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-cyan-300">
              {regenerationResult ? (
                <ReactMarkdown>{regenerationResult.idealFlow}</ReactMarkdown>
              ) : (
                <span className="text-slate-500 italic">
                  「シナリオを再生成」ボタンをクリックすると、対策が適用された改善後の業務フローがここに生成されます。
                </span>
              )}
            </div>
          </div>
        )}

        {activeTab === 'analysisReport' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>フェーズ2: 論理的分析・対策レポート</span>
              {regenerationResult && (
                <button
                  type="button"
                  onClick={() => handleCopy(regenerationResult.analysisReport, 'analysis')}
                  className="flex items-center gap-1 text-slate-400 hover:text-white cursor-pointer"
                >
                  {copiedSection === 'analysis' ? (
                    <CheckCircle className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedSection === 'analysis' ? 'コピー完了' : 'コピー'}</span>
                </button>
              )}
            </div>

            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-xs text-slate-200 leading-relaxed max-h-[340px] overflow-y-auto font-sans [&_h1]:text-sm [&_h1]:font-bold [&_h1]:text-sky-300 [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-xs [&_h2]:font-bold [&_h2]:text-cyan-300 [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-amber-300 [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1.5 [&_li]:my-0.5 [&_strong]:text-white [&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-cyan-500 [&_blockquote]:pl-2 [&_blockquote]:italic [&_blockquote]:text-slate-400 [&_code]:bg-slate-900 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-cyan-300">
              {regenerationResult ? (
                <ReactMarkdown>{regenerationResult.analysisReport}</ReactMarkdown>
              ) : (
                <span className="text-slate-500 italic">
                  「シナリオを再生成」ボタンをクリックすると、排除・ブレイクの意図を汲み取った詳細な分析レポートがここに生成されます。
                </span>
              )}
            </div>
          </div>
        )}

        {activeTab === 'scenario' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span className="flex items-center gap-1">
                <Code2 className="w-3.5 h-3.5 text-purple-400" />
                VTA Schema JSON
              </span>
              <button
                type="button"
                onClick={() => handleCopy(JSON.stringify(vtaData, null, 2), 'json')}
                className="flex items-center gap-1 text-slate-400 hover:text-white cursor-pointer"
              >
                {copiedSection === 'json' ? (
                  <CheckCircle className="w-3 h-3 text-emerald-400" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                <span>{copiedSection === 'json' ? 'コピー完了' : 'コピー'}</span>
              </button>
            </div>

            <pre className="p-3 bg-slate-950 rounded-lg border border-slate-800/80 text-[11px] text-slate-300 font-mono overflow-x-auto max-h-[300px]">
              {JSON.stringify(vtaData, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
};
