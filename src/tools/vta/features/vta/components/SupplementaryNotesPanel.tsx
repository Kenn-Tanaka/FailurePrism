import React, { useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  Plus,
  Trash2,
  Edit3,
  AlertTriangle,
  Activity,
  CheckCircle2,
  Sparkles,
  Info,
  Clock,
  Layers,
  Save,
} from 'lucide-react';
import { useVTAStore } from '../store/vtaStore';
import { useReactFlow } from '@xyflow/react';

export const SupplementaryNotesPanel: React.FC = () => {
  const vtaData = useVTAStore((state) => state.vtaData);
  const isNotesPanelOpen = useVTAStore((state) => state.isNotesPanelOpen);
  const setIsNotesPanelOpen = useVTAStore((state) => state.setIsNotesPanelOpen);
  const toggleNotesPanel = useVTAStore((state) => state.toggleNotesPanel);
  const updateNodeSupplementaryNote = useVTAStore((state) => state.updateNodeSupplementaryNote);
  const updateSupplementarySummary = useVTAStore((state) => state.updateSupplementarySummary);
  const addCustomNote = useVTAStore((state) => state.addCustomNote);
  const updateCustomNote = useVTAStore((state) => state.updateCustomNote);
  const deleteCustomNote = useVTAStore((state) => state.deleteCustomNote);
  const recordHistorySnapshot = useVTAStore((state) => state.recordHistorySnapshot);

  const { setCenter, getNode } = useReactFlow();

  const [activeTab, setActiveTab] = useState<'nodes' | 'summary' | 'custom'>('nodes');
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [newNoteContent, setNewNoteContent] = useState('');
  const [isAddingCustom, setIsAddingCustom] = useState(false);

  // Jump/focus node in React Flow
  const handleFocusNode = (nodeId: string) => {
    const node = getNode(nodeId);
    if (node) {
      setCenter(node.position.x + 130, node.position.y + 70, { zoom: 1.1, duration: 400 });
    }
  };

  const handleAddCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNoteTitle.trim()) return;
    addCustomNote(newNoteTitle.trim(), newNoteContent.trim());
    setNewNoteTitle('');
    setNewNoteContent('');
    setIsAddingCustom(false);
  };

  if (!isNotesPanelOpen) {
    return (
      <button
        type="button"
        onClick={toggleNotesPanel}
        className="absolute top-20 right-0 z-30 flex items-center gap-1.5 bg-slate-900/95 hover:bg-slate-800 text-cyan-400 hover:text-cyan-300 border-l border-y border-slate-700 px-3 py-2 rounded-l-xl shadow-2xl transition-all cursor-pointer group"
        title="ノード補足説明欄を展開"
      >
        <BookOpen className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform" />
        <span className="text-xs font-semibold text-slate-200">補足説明欄</span>
        <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
      </button>
    );
  }

  const nodesWithNotesCount = vtaData.nodes.filter((n) => Boolean(n.supplementary_note?.trim())).length;
  const customNotesCount = (vtaData.custom_notes || []).length;

  return (
    <aside className="w-88 xl:w-96 h-full bg-slate-900/95 border-l border-slate-800 flex flex-col z-30 shadow-2xl backdrop-blur shrink-0 transition-all">
      {/* Panel Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-950/60 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400">
            <BookOpen className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-slate-100 flex items-center gap-1.5">
              <span>ノード補足説明欄</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-slate-800 text-cyan-300 border border-slate-700">
                {nodesWithNotesCount + customNotesCount}件
              </span>
            </h3>
            <p className="text-[10px] text-slate-400">
              背景要因・ヒューマンファクタの加筆
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsNotesPanelOpen(false)}
          className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          title="補足説明欄を閉じる"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-950/40 text-xs px-2 shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab('nodes')}
          className={`flex-1 py-2 font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'nodes'
              ? 'border-cyan-400 text-cyan-300 bg-slate-900/40'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          ノード別要因 ({nodesWithNotesCount})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('summary')}
          className={`flex-1 py-2 font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'summary'
              ? 'border-cyan-400 text-cyan-300 bg-slate-900/40'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          全体総括
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('custom')}
          className={`flex-1 py-2 font-medium border-b-2 transition-colors cursor-pointer ${
            activeTab === 'custom'
              ? 'border-cyan-400 text-cyan-300 bg-slate-900/40'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          自由メモ ({customNotesCount})
        </button>
      </div>

      {/* Panel Scrollable Content */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4 text-xs">
        {/* Tab 1: Node-by-Node Supplementary Notes */}
        {activeTab === 'nodes' && (
          <div className="space-y-3.5">
            <div className="text-[11px] text-slate-400 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800/80 flex items-start gap-2">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
              <span>
                LLMが抽出した各ノードの背景要因です。自由に加筆・修正・削除できます。ここでの内容は<strong>再生成時に反映</strong>されます。
              </span>
            </div>

            {vtaData.nodes.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                ノードがありません。シナリオを読み込んでください。
              </div>
            ) : (
              vtaData.nodes.map((node, idx) => {
                const isVariation = node.type === 'variation';
                const hasNote = Boolean(node.supplementary_note?.trim());

                return (
                  <div
                    key={node.id}
                    className={`p-3 rounded-xl border transition-all ${
                      hasNote
                        ? 'bg-slate-950/80 border-slate-700/90 shadow-sm'
                        : 'bg-slate-950/40 border-slate-800/60 opacity-85'
                    }`}
                  >
                    {/* Node Header info */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5 truncate max-w-[200px]">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                            isVariation
                              ? 'bg-amber-950 text-amber-300 border-amber-500/60'
                              : 'bg-slate-800 text-slate-300 border-slate-700'
                          }`}
                        >
                          {isVariation ? '変動' : '通常'}
                        </span>
                        <span className="text-[11px] font-medium text-slate-400 truncate">
                          [{node.lane}]
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleFocusNode(node.id)}
                        className="text-[10px] text-cyan-400 hover:text-cyan-300 bg-cyan-950/60 hover:bg-cyan-900/80 border border-cyan-800 px-2 py-0.5 rounded transition-colors cursor-pointer"
                        title="VTA図上のカードにフォーカス"
                      >
                        図上表示
                      </button>
                    </div>

                    <h4 className="font-semibold text-xs text-slate-100 mb-1.5 leading-snug">
                      {node.title}
                    </h4>

                    {/* Supplementary Note Textarea */}
                    <div className="space-y-1">
                      <label className="text-[10px] font-medium text-slate-400 flex items-center justify-between">
                        <span>補足説明（背景・ヒューマンファクタ・設備状況）:</span>
                        {hasNote && (
                          <button
                            type="button"
                            onClick={() => {
                              recordHistorySnapshot();
                              updateNodeSupplementaryNote(node.id, '');
                            }}
                            className="text-slate-500 hover:text-rose-400 transition-colors cursor-pointer"
                            title="補足をクリア"
                          >
                            クリア
                          </button>
                        )}
                      </label>
                      <textarea
                        rows={3}
                        value={node.supplementary_note || ''}
                        onFocus={() => recordHistorySnapshot()}
                        onChange={(e) => updateNodeSupplementaryNote(node.id, e.target.value)}
                        placeholder="この作業や変動要因の背景にある心理的要因、組織課題、設備環境などを記入..."
                        className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-2.5 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500 text-[11px] leading-relaxed resize-y"
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Tab 2: Overall Summary */}
        {activeTab === 'summary' && (
          <div className="space-y-3">
            <div className="text-[11px] text-slate-400 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800/80 flex items-start gap-2">
              <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
              <span>
                事故・トラブル全体の背景要因や組織的コンテキストの総括です。
              </span>
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-slate-200">全体背景要因の総括</label>
              <textarea
                rows={8}
                value={vtaData.supplementary_summary || ''}
                onFocus={() => recordHistorySnapshot()}
                onChange={(e) => updateSupplementarySummary(e.target.value)}
                placeholder="シナリオ全体の背景（組織体制、納期圧力、コミュニケーション不全、過去の経緯など）を記入してください..."
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl p-3 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 text-xs leading-relaxed resize-y"
              />
            </div>
          </div>
        )}

        {/* Tab 3: Custom Free Notes */}
        {activeTab === 'custom' && (
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                独自の考察や調査メモを追加できます
              </span>
              {!isAddingCustom && (
                <button
                  type="button"
                  onClick={() => setIsAddingCustom(true)}
                  className="flex items-center gap-1 px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer shadow-sm"
                >
                  <Plus className="w-3 h-3" />
                  <span>メモ追加</span>
                </button>
              )}
            </div>

            {isAddingCustom && (
              <form onSubmit={handleAddCustomSubmit} className="p-3 bg-slate-950 border border-cyan-500/80 rounded-xl space-y-2.5 animate-in zoom-in-95 duration-100">
                <input
                  type="text"
                  required
                  placeholder="メモのタイトル（例: 設備経年劣化の記録）"
                  value={newNoteTitle}
                  onChange={(e) => setNewNoteTitle(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 placeholder-slate-500 text-xs focus:outline-none focus:border-cyan-500"
                  autoFocus
                />
                <textarea
                  rows={3}
                  placeholder="メモの詳細内容を記入..."
                  value={newNoteContent}
                  onChange={(e) => setNewNoteContent(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 placeholder-slate-500 text-xs focus:outline-none focus:border-cyan-500 resize-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsAddingCustom(false)}
                    className="px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold"
                  >
                    追加する
                  </button>
                </div>
              </form>
            )}

            {(vtaData.custom_notes || []).length === 0 && !isAddingCustom ? (
              <div className="text-center py-6 text-slate-500 text-xs">
                自由メモはありません。「メモ追加」ボタンから追加できます。
              </div>
            ) : (
              (vtaData.custom_notes || []).map((note) => (
                <div key={note.id} className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-1.5">
                  <div className="flex items-center justify-between">
                    <input
                      type="text"
                      value={note.title}
                      onFocus={() => recordHistorySnapshot()}
                      onChange={(e) => updateCustomNote(note.id, { title: e.target.value })}
                      className="font-semibold text-xs text-slate-200 bg-transparent border-b border-transparent hover:border-slate-700 focus:border-cyan-500 focus:outline-none px-1"
                    />
                    <button
                      type="button"
                      onClick={() => deleteCustomNote(note.id)}
                      className="text-slate-500 hover:text-rose-400 p-1 rounded"
                      title="メモを削除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <textarea
                    rows={2}
                    value={note.content}
                    onFocus={() => recordHistorySnapshot()}
                    onChange={(e) => updateCustomNote(note.id, { content: e.target.value })}
                    className="w-full bg-slate-900/60 border border-slate-800 rounded-lg p-2 text-[11px] text-slate-300 focus:outline-none focus:border-cyan-500 resize-y"
                  />
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/60 text-[10px] text-slate-400 flex items-center gap-1.5 shrink-0">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        <span>編集内容は自動保存され、シナリオ再生成に反映されます</span>
      </div>
    </aside>
  );
};
