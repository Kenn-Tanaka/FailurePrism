import {evidenceNotes} from '../utils/evidenceNotes';
import { visibleSchema } from '../utils/presentation';
import React, { useEffect, useRef, useState } from 'react';
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

interface SupplementaryNotesPanelProps {
  focusRequest?: { nodeId: string; sequence: number } | null;
}

export const SupplementaryNotesPanel: React.FC<SupplementaryNotesPanelProps> = ({ focusRequest = null }) => {
  const allData = useVTAStore((state) => state.vtaData);
  const vtaData = visibleSchema(allData);
  const compactView = useVTAStore((state) => state.compactView);
  const isNotesPanelOpen = useVTAStore((state) => state.isNotesPanelOpen);
  const setIsNotesPanelOpen = useVTAStore((state) => state.setIsNotesPanelOpen);
  const toggleNotesPanel = useVTAStore((state) => state.toggleNotesPanel);
  const updateNodeSupplementaryNote = useVTAStore((state) => state.updateNodeSupplementaryNote);
  const updateSupplementarySummary = useVTAStore((state) => state.updateSupplementarySummary);
  const addCustomNote = useVTAStore((state) => state.addCustomNote);
  const updateCustomNote = useVTAStore((state) => state.updateCustomNote);
  const deleteCustomNote = useVTAStore((state) => state.deleteCustomNote);
  const recordHistorySnapshot = useVTAStore((state) => state.recordHistorySnapshot);
  const openNodeEditor = useVTAStore((state) => state.openNodeEditor);
  const setNodeHidden = useVTAStore((state) => state.setNodeHidden);

  const { setCenter, getNode } = useReactFlow();

  const [activeTab, setActiveTab] = useState<'nodes' | 'summary' | 'custom'>('nodes');
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [newNoteContent, setNewNoteContent] = useState('');
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const noteCardRefs = useRef(new Map<string, HTMLDivElement>());
  const hasRecordedSinceFocusRef = useRef(false);

  const handleFieldFocus = () => {
    hasRecordedSinceFocusRef.current = false;
  };

  const ensureHistoryBeforeEdit = () => {
    if (!hasRecordedSinceFocusRef.current) {
      recordHistorySnapshot();
      hasRecordedSinceFocusRef.current = true;
    }
  };

  useEffect(() => {
    if (compactView) setActiveTab('nodes');
  }, [compactView]);

  useEffect(() => {
    if (isNotesPanelOpen && focusRequest) setActiveTab('nodes');
  }, [isNotesPanelOpen, focusRequest]);

  useEffect(() => {
    if (!isNotesPanelOpen || activeTab !== 'nodes' || !focusRequest) return;
    const container = scrollContainerRef.current;
    const card = noteCardRefs.current.get(focusRequest.nodeId);
    if (!container || !card) return;

    const containerBounds = container.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    const centeredOffset = Math.max(0, (container.clientHeight - cardBounds.height) / 2);
    const top = container.scrollTop + cardBounds.top - containerBounds.top - centeredOffset;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [focusRequest, isNotesPanelOpen, activeTab]);

  // Jump/focus node in React Flow
  const handleFocusNode = (nodeId: string) => {
    const node = getNode(nodeId);
    if (node) {
      setCenter(node.position.x + (node.measured?.width ?? 260) / 2,
        node.position.y + (node.measured?.height ?? 140) / 2, { zoom: 1.1, duration: 400 });
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

  const nodesWithDetailsCount = vtaData.nodes.filter(
    (n) => Boolean(n.description?.trim() || n.supplementary_note?.trim())
  ).length;
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
                {nodesWithDetailsCount + customNotesCount}件
              </span>
            </h3>
            <p className="text-[10px] text-slate-400">
              ノードの内容・補足と図上の表示設定
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
          ノード別内容・補足 ({nodesWithDetailsCount})
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
      <div ref={scrollContainerRef} className="flex-1 p-4 overflow-y-auto space-y-4 text-xs">
        {/* Tab 1: Node-by-Node Supplementary Notes */}
        {activeTab === 'nodes' && (
          <div className="space-y-3.5">
            <div className="text-[11px] text-slate-400 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800/80 flex items-start gap-2">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
              <span>
                ノードの内容と背景要因を確認できます。各ノードの図上表示もここで切り替えられます。補足説明の修正は<strong>再生成時に反映</strong>されます。
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
                const hasDetails = Boolean(node.description?.trim() || hasNote);

                return (
                  <div
                    key={node.id}
                    ref={(element) => {
                      if (element) noteCardRefs.current.set(node.id, element);
                      else noteCardRefs.current.delete(node.id);
                    }}
                    className={`p-3 rounded-xl border transition-all ${
                      hasDetails
                        ? 'bg-slate-950/80 border-slate-700/90 shadow-sm'
                        : 'bg-slate-950/40 border-slate-800/60 opacity-85'
                    } ${focusRequest?.nodeId === node.id ? 'ring-2 ring-cyan-400/70' : ''}`}
                  >
                    {/* Node Header info */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5 truncate max-w-[200px]">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                            node.type === 'outcome'
                              ? 'bg-rose-950 text-rose-300 border-rose-500/60'
                              : isVariation
                                ? 'bg-amber-950 text-amber-300 border-amber-500/60'
                                : 'bg-slate-800 text-slate-300 border-slate-700'
                          }`}
                        >
                          {node.type === 'outcome' ? '帰結' : isVariation ? '変動' : node.type === 'normal' ? '通常' : node.type === 'undetermined' ? '保留' : '未判定'}
                        </span>
                        <span className="text-[11px] font-medium text-slate-400 truncate">
                          [{node.lane}]
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleFocusNode(node.id)}
                        className="text-[10px] text-cyan-400 hover:text-cyan-300 bg-cyan-950/60 hover:bg-cyan-900/80 border border-cyan-800 px-2 py-0.5 rounded transition-colors cursor-pointer"
                        title={node.is_hidden ? 'VTA図上の接続点にフォーカス（カードは再表示しません）' : 'VTA図上のカードにフォーカス'}
                      >
                        図上表示
                      </button>
                    </div>

                    <h4 className="font-semibold text-xs text-slate-100 mb-1.5 leading-snug">
                      {node.title}
                    </h4>

                    <div className="mb-2 min-w-0 rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-2">
                      <span className="text-[10px] font-medium text-slate-400">発生タイミング</span>
                      <p className={`mt-1 text-[11px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${node.time?.trim() ? 'text-slate-200' : 'text-slate-500'}`}>
                        {node.time?.trim() ? node.time : '未設定'}
                      </p>
                    </div>

                    <div className="flex items-center justify-between gap-2 mb-2 text-[11px] text-slate-300">
                      {node.is_hidden ? (
                        <>
                          <span>● 図上は接続点{node.measure_type === 'elimination' ? '／排除指定あり' : ''}</span>
                          <button type="button" onClick={() => setNodeHidden(node.id, false)}
                            className="shrink-0 text-cyan-400 hover:text-cyan-300 cursor-pointer">カードを再表示</button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setNodeHidden(node.id, true)}
                          className="w-full rounded-lg border border-cyan-800 bg-cyan-950/50 px-2 py-1.5 text-cyan-300 hover:bg-cyan-900/70 cursor-pointer text-left">
                          図上では接続点として表示
                        </button>
                      )}
                    </div>

                    <div className="mb-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-medium text-slate-400">内容</span>
                        <button
                          type="button"
                          onClick={() => openNodeEditor(node)}
                          className="text-[10px] text-cyan-400 hover:text-cyan-300 cursor-pointer"
                          title="ノードの内容を編集"
                        >
                          内容を編集
                        </button>
                      </div>
                      <p className="text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap break-words bg-slate-900/80 border border-slate-800 rounded-lg px-2.5 py-2">
                        {node.description?.trim() || '内容は未記入です。'}
                        {evidenceNotes(allData,node.id).map((line,index)=><span key={index} className="mt-2 block text-xs text-amber-300">{line}</span>)}
                      </p>
                    </div>

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
                        onFocus={handleFieldFocus}
                        onChange={(e) => {
                          ensureHistoryBeforeEdit();
                          updateNodeSupplementaryNote(node.id, e.target.value);
                        }}
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
                onFocus={handleFieldFocus}
                onChange={(e) => {
                  ensureHistoryBeforeEdit();
                  updateSupplementarySummary(e.target.value);
                }}
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
                      onFocus={handleFieldFocus}
                      onChange={(e) => {
                        ensureHistoryBeforeEdit();
                        updateCustomNote(note.id, { title: e.target.value });
                      }}
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
                    onFocus={handleFieldFocus}
                    onChange={(e) => {
                      ensureHistoryBeforeEdit();
                      updateCustomNote(note.id, { content: e.target.value });
                    }}
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
