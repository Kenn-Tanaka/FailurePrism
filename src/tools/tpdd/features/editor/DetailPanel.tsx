import React, { useState, useEffect } from 'react';
import { Trash2, ExternalLink, X, FolderPlus, ArrowRight } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { findDescendantDiagramIds } from '../../domain/commands';
import { EdgeKind, NodeKind, NodeStatus } from '../../domain/schema';
import { NODE_KIND_LABELS } from '../../rendering/svgExport';

export const DetailPanel: React.FC = () => {
  const { state, dispatch } = useApp();
  const { present: project } = state.history;
  const { activeDiagramId, selectedNodeId, selectedEdgeId } = state.ui;

  const currentDiagram = project.diagrams.find((d) => d.id === activeDiagramId) || project.diagrams[0];
  const selectedNode = currentDiagram.nodes.find((n) => n.id === selectedNodeId);
  const selectedEdge = currentDiagram.edges.find((e) => e.id === selectedEdgeId);

  // ローカル入力バッファ (IME composition対策)
  const [labelInput, setLabelInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [newTagInput, setNewTagInput] = useState('');
  const [newLinkInput, setNewLinkInput] = useState('');
  const [edgeLabelInput, setEdgeLabelInput] = useState('');

  useEffect(() => {
    if (selectedNode) {
      setLabelInput(selectedNode.label);
      setDescInput(selectedNode.meta.description);
    }
  }, [selectedNode?.id, selectedNode?.label, selectedNode?.meta.description]);

  useEffect(() => {
    if (selectedEdge) {
      setEdgeLabelInput(selectedEdge.label);
    }
  }, [selectedEdge?.id, selectedEdge?.label]);

  if (!selectedNode && !selectedEdge) {
    return (
      <div className="p-4 text-xs text-slate-400 text-center select-none">
        ノードまたはエッジを選択すると<br />詳細を編集できます
      </div>
    );
  }

  // エッジ詳細編集
  if (selectedEdge) {
    const sourceNode = currentDiagram.nodes.find((n) => n.id === selectedEdge.sourceId);
    const targetNode = currentDiagram.nodes.find((n) => n.id === selectedEdge.targetId);

    return (
      <div className="p-4 space-y-4 text-xs select-text">
        <div className="flex items-center justify-between border-b pb-2">
          <span className="font-bold text-slate-700">エッジの詳細</span>
          <button
            onClick={() => dispatch({ type: 'REMOVE_EDGE', edgeId: selectedEdge.id })}
            className="text-red-500 hover:text-red-700 flex items-center gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            削除
          </button>
        </div>

        <div>
          <span className="text-slate-500 block mb-1">接続関係</span>
          <div className="bg-slate-50 p-2 rounded border border-slate-200 text-slate-700">
            <div className="font-medium truncate">{sourceNode?.label || selectedEdge.sourceId}</div>
            <div className="text-slate-400 my-0.5">↓</div>
            <div className="font-medium truncate">{targetNode?.label || selectedEdge.targetId}</div>
          </div>
        </div>

        <div>
          <label className="text-slate-500 block mb-1">関係の種別</label>
          <select
            value={selectedEdge.kind}
            onChange={(e) =>
              dispatch({
                type: 'UPDATE_EDGE',
                edgeId: selectedEdge.id,
                patch: { kind: e.target.value as EdgeKind },
              })
            }
            className="w-full p-1.5 border border-slate-300 rounded bg-white"
          >
            <option value="decomposition">分解・具体化 (decomposition)</option>
            <option value="dependency">依存関係 (dependency)</option>
            <option value="constraint">制約条件 (constraint)</option>
            <option value="reference">参照・メモ (reference)</option>
          </select>
        </div>

        <div>
          <label className="text-slate-500 block mb-1">エッジラベル</label>
          <input
            type="text"
            value={edgeLabelInput}
            onChange={(e) => setEdgeLabelInput(e.target.value)}
            onBlur={() => {
              if (edgeLabelInput !== selectedEdge.label) {
                dispatch({
                  type: 'UPDATE_EDGE',
                  edgeId: selectedEdge.id,
                  patch: { label: edgeLabelInput.trim() },
                });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="w-full p-1.5 border border-slate-300 rounded"
            placeholder="関係の説明ラベル"
          />
        </div>
      </div>
    );
  }

  if (!selectedNode) return null;

  // ノード詳細編集
  const handleLabelCommit = () => {
    const trimmed = labelInput.trim();
    if (!trimmed) {
      setLabelInput(selectedNode.label);
      return;
    }
    if (trimmed !== selectedNode.label) {
      dispatch({
        type: 'UPDATE_NODE',
        nodeId: selectedNode.id,
        patch: { label: trimmed },
      });
    }
  };

  const handleDescCommit = () => {
    if (descInput !== selectedNode.meta.description) {
      dispatch({
        type: 'UPDATE_NODE',
        nodeId: selectedNode.id,
        patch: { meta: { ...selectedNode.meta, description: descInput } },
      });
    }
  };

  const handleAddTag = () => {
    const tag = newTagInput.trim();
    if (!tag || selectedNode.meta.tags.includes(tag)) return;
    dispatch({
      type: 'UPDATE_NODE',
      nodeId: selectedNode.id,
      patch: { meta: { ...selectedNode.meta, tags: [...selectedNode.meta.tags, tag] } },
    });
    setNewTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    dispatch({
      type: 'UPDATE_NODE',
      nodeId: selectedNode.id,
      patch: {
        meta: {
          ...selectedNode.meta,
          tags: selectedNode.meta.tags.filter((t) => t !== tagToRemove),
        },
      },
    });
  };

  const handleAddLink = () => {
    const url = newLinkInput.trim();
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `link-err-${Date.now()}`,
          type: 'warning',
          message: '参考リンクは http:// または https:// で始まる有効なURLを入力してください。',
        },
      });
      return;
    }
    dispatch({
      type: 'UPDATE_NODE',
      nodeId: selectedNode.id,
      patch: {
        meta: { ...selectedNode.meta, sourceLinks: [...selectedNode.meta.sourceLinks, url] },
      },
    });
    setNewLinkInput('');
  };

  const handleRemoveLink = (linkToRemove: string) => {
    dispatch({
      type: 'UPDATE_NODE',
      nodeId: selectedNode.id,
      patch: {
        meta: {
          ...selectedNode.meta,
          sourceLinks: selectedNode.meta.sourceLinks.filter((l) => l !== linkToRemove),
        },
      },
    });
  };

  // 詳細図削除・ノード削除のハンドリング
  const handleDeleteNode = () => {
    let confirmMsg = `ノード「${selectedNode.label}」を削除しますか？\n関連するエッジも削除されます。`;
    if (selectedNode.childDiagramId) {
      const descendants = findDescendantDiagramIds(project, selectedNode.childDiagramId);
      const totalSubDiagrams = 1 + descendants.length;
      confirmMsg = `ノード「${selectedNode.label}」を削除しますか？\nこのノードに紐づく詳細図 (${totalSubDiagrams}件) もすべて削除されます！`;
    }
    if (confirm(confirmMsg)) {
      dispatch({ type: 'REMOVE_NODE', nodeId: selectedNode.id });
    }
  };

  const handleSubDiagramAction = () => {
    if (selectedNode.childDiagramId) {
      // 既存の子図へ遷移
      dispatch({ type: 'SET_ACTIVE_DIAGRAM', diagramId: selectedNode.childDiagramId });
    } else {
      // 新規子図を作成して遷移
      dispatch({ type: 'CREATE_SUB_DIAGRAM', parentNodeId: selectedNode.id });
    }
  };

  return (
    <div className="p-4 space-y-4 text-xs select-text overflow-y-auto max-h-full">
      <div className="flex items-center justify-between border-b pb-2">
        <span className="font-bold text-slate-700">ノードの詳細</span>
        <button
          onClick={handleDeleteNode}
          className="text-red-500 hover:text-red-700 flex items-center gap-1"
        >
          <Trash2 className="w-3.5 h-3.5" />
          削除
        </button>
      </div>

      {/* サブ図（詳細図）アクション */}
      <div className="bg-blue-50/70 border border-blue-200/80 p-2.5 rounded-lg flex items-center justify-between">
        <div>
          <span className="font-semibold text-blue-900 block">
            {selectedNode.childDiagramId ? '詳細図が存在します' : '詳細図（サブ図）'}
          </span>
          <span className="text-[10px] text-blue-600">
            {selectedNode.childDiagramId ? 'このノードの内部展開図を開く' : 'このノードの階層を深掘りする'}
          </span>
        </div>
        <button
          onClick={handleSubDiagramAction}
          className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium flex items-center gap-1 shadow-sm transition-colors"
        >
          {selectedNode.childDiagramId ? (
            <>
              詳細図を開く
              <ArrowRight className="w-3.5 h-3.5" />
            </>
          ) : (
            <>
              <FolderPlus className="w-3.5 h-3.5" />
              詳細図を作成
            </>
          )}
        </button>
      </div>

      {/* ラベル */}
      <div>
        <label className="text-slate-500 block mb-1 font-medium">ラベル</label>
        <textarea
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          onBlur={handleLabelCommit}
          className="w-full p-1.5 border border-slate-300 rounded resize-y min-h-[48px] focus:outline-blue-500"
          placeholder="ノード名・思考項目"
        />
      </div>

      {/* 種別 & 状態 */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-slate-500 block mb-1">種別</label>
          <select
            value={selectedNode.kind}
            onChange={(e) =>
              dispatch({
                type: 'UPDATE_NODE',
                nodeId: selectedNode.id,
                patch: { kind: e.target.value as NodeKind },
              })
            }
            className="w-full p-1.5 border border-slate-300 rounded bg-white"
          >
            {(Object.keys(NODE_KIND_LABELS) as NodeKind[]).map((k) => (
              <option key={k} value={k}>
                {NODE_KIND_LABELS[k]} ({k})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-slate-500 block mb-1">状態</label>
          <select
            value={selectedNode.status}
            onChange={(e) =>
              dispatch({
                type: 'UPDATE_NODE',
                nodeId: selectedNode.id,
                patch: { status: e.target.value as NodeStatus },
              })
            }
            className="w-full p-1.5 border border-slate-300 rounded bg-white"
          >
            <option value="draft">下書き (draft)</option>
            <option value="candidate">候補 (candidate)</option>
            <option value="adopted">採用 (adopted)</option>
            <option value="rejected">却下 (rejected)</option>
          </select>
        </div>
      </div>

      {/* 抽象度列 */}
      <div>
        <label className="text-slate-500 block mb-1">抽象度列</label>
        <select
          value={selectedNode.levelId}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_NODE',
              nodeId: selectedNode.id,
              patch: { levelId: e.target.value },
            })
          }
          className="w-full p-1.5 border border-slate-300 rounded bg-white"
        >
          {project.levels.map((lvl) => (
            <option key={lvl.id} value={lvl.id}>
              {lvl.label} (列{lvl.order + 1})
            </option>
          ))}
        </select>
      </div>

      {/* 説明 */}
      <div>
        <label className="text-slate-500 block mb-1 font-medium">詳細説明</label>
        <textarea
          value={descInput}
          onChange={(e) => setDescInput(e.target.value)}
          onBlur={handleDescCommit}
          rows={4}
          className="w-full p-1.5 border border-slate-300 rounded resize-y focus:outline-blue-500"
          placeholder="要求の詳細、設計理由、制約事項など"
        />
      </div>

      {/* タグ */}
      <div>
        <label className="text-slate-500 block mb-1">タグ</label>
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selectedNode.meta.tags.map((tag) => (
            <span
              key={tag}
              className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full flex items-center gap-1 border border-slate-200"
            >
              #{tag}
              <button
                onClick={() => handleRemoveTag(tag)}
                className="hover:text-red-500 rounded-full"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={newTagInput}
            onChange={(e) => setNewTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                handleAddTag();
              }
            }}
            placeholder="新規タグ"
            className="flex-1 p-1 border border-slate-300 rounded"
          />
          <button
            onClick={handleAddTag}
            className="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded text-slate-700"
          >
            追加
          </button>
        </div>
      </div>

      {/* 参考リンク */}
      <div>
        <label className="text-slate-500 block mb-1">参考リンク (http/https)</label>
        <div className="space-y-1 mb-1.5">
          {selectedNode.meta.sourceLinks.map((link) => (
            <div
              key={link}
              className="flex items-center justify-between bg-slate-50 p-1.5 rounded border border-slate-200"
            >
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline truncate max-w-[180px] flex items-center gap-1"
                title={link}
              >
                <ExternalLink className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{link}</span>
              </a>
              <button
                onClick={() => handleRemoveLink(link)}
                className="text-slate-400 hover:text-red-500"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-1">
          <input
            type="url"
            value={newLinkInput}
            onChange={(e) => setNewLinkInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                handleAddLink();
              }
            }}
            placeholder="https://..."
            className="flex-1 p-1 border border-slate-300 rounded"
          />
          <button
            onClick={handleAddLink}
            className="px-2 py-1 bg-slate-200 hover:bg-slate-300 rounded text-slate-700"
          >
            追加
          </button>
        </div>
      </div>

      {/* 来歴情報 */}
      <div className="pt-2 border-t border-slate-100 text-[10px] text-slate-400">
        <div>作成元: {selectedNode.provenance.origin === 'llm' ? 'AI生成' : '手動'}</div>
        <div>作成日: {new Date(selectedNode.provenance.createdAt).toLocaleString()}</div>
        {selectedNode.provenance.modelId && (
          <div>モデル: {selectedNode.provenance.modelId}</div>
        )}
      </div>
    </div>
  );
};
