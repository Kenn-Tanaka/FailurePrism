import React, { useState } from 'react';
import { Layers, Network, Bot, Trash2, Edit2, Check, CornerDownRight, Search, Settings } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { findDescendantDiagramIds } from '../../domain/commands';
import { getModelMetadata, MODEL_PRESETS } from '../settings/modelCatalog';
import { CustomModelModal } from '../settings/CustomModelModal';
import { ModelExploreModal } from '../settings/ModelExploreModal';
import { GatewayConfigModal } from '../settings/GatewayConfigModal';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { loadAppSettings } from '../../services/persistence/appStorage';

export const DiagramTree: React.FC = () => {
  const { state, dispatch } = useApp();
  const { present: project } = state.history;
  const { activeDiagramId } = state.ui;

  const [editingDiagId, setEditingDiagId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [isEditingProjectTitle, setIsEditingProjectTitle] = useState(false);
  const [projectTitleInput, setProjectTitleInput] = useState('');
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);

  // モーダル開閉状態
  const [isCustomModalOpen, setIsCustomModalOpen] = useState(false);
  const [isExploreModalOpen, setIsExploreModalOpen] = useState(false);
  const [isGatewayConfigOpen, setIsGatewayConfigOpen] = useState(false);

  // 親ノード情報マップ (childDiagramId -> { parentNodeLabel: string, parentDiagTitle: string })
  const parentNodeMap = new Map<string, { parentNodeLabel: string; parentDiagTitle: string }>();
  for (const diag of project.diagrams) {
    for (const node of diag.nodes) {
      if (node.childDiagramId) {
        parentNodeMap.set(node.childDiagramId, {
          parentNodeLabel: node.label,
          parentDiagTitle: diag.title,
        });
      }
    }
  }

  // 図の削除
  const handleDeleteDiagram = (e: React.MouseEvent, diagId: string) => {
    e.stopPropagation();
    if (diagId === project.rootDiagramId) {
      alert('ルート図は削除できません');
      return;
    }

    const descendants = findDescendantDiagramIds(project, diagId);
    const totalCount = 1 + descendants.length;
    const msg = `この図およびその子孫図 (${totalCount}件) をすべて削除しますか？\n親ノードの詳細図リンクも解除されます。`;

    if (confirm(msg)) {
      dispatch({ type: 'REMOVE_DIAGRAM', diagramId: diagId });
    }
  };

  // タイトル編集開始
  const handleStartEdit = (e: React.MouseEvent, diagId: string, currentTitle: string) => {
    e.stopPropagation();
    setEditingDiagId(diagId);
    setEditingTitle(currentTitle);
  };

  // タイトル編集確定
  const handleCommitEdit = (diagId: string) => {
    if (editingTitle.trim()) {
      dispatch({ type: 'UPDATE_DIAGRAM_TITLE', diagramId: diagId, title: editingTitle.trim() });
    }
    setEditingDiagId(null);
  };

  return (
    <aside className="w-64 bg-slate-50 border-r border-slate-200 flex flex-col h-full select-none">
      {/* プロジェクト情報 */}
      <div className="p-3 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
            プロジェクト
          </label>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setIsProjectSettingsOpen(true)}
              className="text-slate-400 hover:text-blue-600 p-0.5 rounded hover:bg-slate-100 transition-colors"
              title="プロジェクト詳細・説明文を編集"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => {
                if (isEditingProjectTitle) {
                  if (projectTitleInput.trim()) {
                    dispatch({ type: 'UPDATE_PROJECT_TITLE', title: projectTitleInput.trim() });
                  }
                  setIsEditingProjectTitle(false);
                } else {
                  setProjectTitleInput(project.title);
                  setIsEditingProjectTitle(true);
                }
              }}
              className="text-slate-400 hover:text-slate-700 p-0.5 rounded hover:bg-slate-100 transition-colors"
              title="タイトル変更"
            >
              {isEditingProjectTitle ? <Check className="w-3.5 h-3.5 text-blue-600" /> : <Edit2 className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {isEditingProjectTitle ? (
          <input
            type="text"
            value={projectTitleInput}
            onChange={(e) => setProjectTitleInput(e.target.value)}
            onBlur={() => {
              if (projectTitleInput.trim() && projectTitleInput.trim() !== project.title) {
                dispatch({ type: 'UPDATE_PROJECT_TITLE', title: projectTitleInput.trim() });
              }
              setIsEditingProjectTitle(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                if (projectTitleInput.trim() && projectTitleInput.trim() !== project.title) {
                  dispatch({ type: 'UPDATE_PROJECT_TITLE', title: projectTitleInput.trim() });
                }
                setIsEditingProjectTitle(false);
              } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                setProjectTitleInput(project.title);
                setIsEditingProjectTitle(false);
              }
            }}
            autoFocus
            className="w-full px-1.5 py-0.5 text-xs font-semibold border border-blue-400 rounded bg-white text-slate-800"
          />
        ) : (
          <div>
            <div
              className="font-semibold text-slate-800 text-sm truncate cursor-pointer hover:text-blue-600 transition-colors"
              title={`${project.title}\n（クリックしてプロジェクト設定を開く）`}
              onClick={() => setIsProjectSettingsOpen(true)}
            >
              {project.title}
            </div>
            {project.description ? (
              <p
                onClick={() => setIsProjectSettingsOpen(true)}
                className="text-[11px] text-slate-500 line-clamp-2 mt-1 leading-tight cursor-pointer hover:text-slate-700"
                title={project.description}
              >
                {project.description}
              </p>
            ) : (
              <button
                onClick={() => setIsProjectSettingsOpen(true)}
                className="text-[10px] text-blue-500 hover:underline mt-0.5 block"
              >
                + 説明・詳細を追加
              </button>
            )}
          </div>
        )}
      </div>

      {/* 図一覧ツリー */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex items-center justify-between text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
          <div className="flex items-center gap-1">
            <Layers className="w-3.5 h-3.5" />
            <span>図一覧 ({project.diagrams.length})</span>
          </div>
        </div>

        <div className="space-y-1">
          {project.diagrams.map((diag) => {
            const isActive = diag.id === activeDiagramId;
            const isRoot = diag.id === project.rootDiagramId;
            const isEditing = editingDiagId === diag.id;
            const parentInfo = parentNodeMap.get(diag.id);

            return (
              <div
                key={diag.id}
                onClick={() => dispatch({ type: 'SET_ACTIVE_DIAGRAM', diagramId: diag.id })}
                className={`w-full text-left p-2 rounded text-xs transition-colors cursor-pointer group border ${
                  isActive
                    ? 'bg-blue-50/80 border-blue-300 text-blue-900 font-medium shadow-sm'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100 hover:border-slate-300'
                } ${!isRoot ? 'ml-2' : ''}`}
              >
                {/* 親ノード案内 (子図の場合) */}
                {parentInfo && (
                  <div className="flex items-center gap-1 text-[10px] text-blue-600 font-normal truncate mb-1">
                    <CornerDownRight className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">親: {parentInfo.parentNodeLabel}</span>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 truncate flex-1 mr-1">
                    <Network className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-blue-600' : 'text-slate-400'}`} />

                    {isEditing ? (
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={() => handleCommitEdit(diag.id)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleCommitEdit(diag.id);
                          if (e.key === 'Escape' && !e.nativeEvent.isComposing) setEditingDiagId(null);
                        }}
                        autoFocus
                        className="px-1 py-0.5 text-xs border border-blue-400 rounded bg-white text-slate-800 w-full"
                      />
                    ) : (
                      <span className="truncate" title={diag.title}>{diag.title}</span>
                    )}

                    {isRoot && (
                      <span className="text-[9px] bg-slate-200 text-slate-600 px-1 rounded flex-shrink-0">
                        ルート
                      </span>
                    )}
                  </div>

                  {/* アクションボタン群 */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={(e) => handleStartEdit(e, diag.id, diag.title)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-blue-600 text-slate-400 rounded"
                      title="図の名称変更"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>

                    {!isRoot && (
                      <button
                        onClick={(e) => handleDeleteDiagram(e, diag.id)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-600 text-slate-400 rounded"
                        title="この図を削除 (子孫図も含む)"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 mt-1 flex justify-between">
                  <span>{diag.nodes.length} ノード</span>
                  <span>{diag.edges.length} エッジ</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 左ペイン下部: LLM設定 (仕様書 8.4.2) */}
      <div className="p-3 border-t border-slate-200 bg-white space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
            <Bot className="w-4 h-4 text-purple-600" />
            <span>LLM設定</span>
          </div>
          <button
            onClick={() => setIsGatewayConfigOpen(true)}
            className="p-1 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-100"
            title="Gateway接続設定 (URL, 認証Token, タイムアウト)"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 選択中モデルの表示名 */}
        {(() => {
          const meta = getModelMetadata(project.aiPreferences.modelId);
          return (
            <div className="bg-slate-50 p-2 rounded border border-slate-200 text-xs">
              <div className="font-semibold text-slate-800 truncate" title={meta.displayName}>
                {meta.displayName}
              </div>
              <div className="font-mono text-[10px] text-slate-500 truncate" title={project.aiPreferences.modelId}>
                {project.aiPreferences.modelId}
              </div>
            </div>
          );
        })()}

        {/* モデル選択ドロップダウン */}
        <div>
          <label className="text-[10px] text-slate-500 block mb-0.5">クイック切替</label>
          <select
            value={project.aiPreferences.modelId}
            onChange={(e) => {
              if (e.target.value === '__custom__') {
                setIsCustomModalOpen(true);
              } else {
                dispatch({ type: 'UPDATE_PROJECT_MODEL', modelId: e.target.value });
              }
            }}
            className="w-full p-1.5 text-xs border border-slate-300 rounded bg-white text-slate-700"
          >
            {/* プリセット一覧 */}
            {MODEL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}

            {/* プリセットに含まれていない現在選択中モデルの項目 */}
            {!MODEL_PRESETS.some((p) => p.id === project.aiPreferences.modelId) && (
              <option value={project.aiPreferences.modelId}>
                {getModelMetadata(project.aiPreferences.modelId).displayName} (選択中)
              </option>
            )}

            <option value="__custom__">✏️ カスタムモデルIDを入力...</option>
          </select>
        </div>

        {/* 詳細探索モーダルボタン */}
        <button
          onClick={() => setIsExploreModalOpen(true)}
          className="w-full py-1.5 px-2 bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-700 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition-colors shadow-sm"
        >
          <Search className="w-3.5 h-3.5" />
          <span>🔍 モデル詳細選択・探索</span>
        </button>

        <div className="text-[10px] text-slate-400 flex items-center justify-between pt-0.5">
          <span>タイムアウト: {project.aiPreferences.timeoutSeconds}s</span>
          <span>{project.aiPreferences.stream ? 'SSE有効' : '通常JSON'}</span>
        </div>
      </div>

      {/* カスタムモデルIDモーダル */}
      <CustomModelModal
        isOpen={isCustomModalOpen}
        currentModelId={project.aiPreferences.modelId}
        onCommit={(newModelId) => dispatch({ type: 'UPDATE_PROJECT_MODEL', modelId: newModelId })}
        onClose={() => setIsCustomModalOpen(false)}
      />

      {/* モデル詳細選択・探索モーダル */}
      <ModelExploreModal
        isOpen={isExploreModalOpen}
        currentModelId={project.aiPreferences.modelId}
        connection={{
          apiBaseUrl: loadAppSettings().gatewayUrl,
          authEnabled: loadAppSettings().gatewayAuthEnabled,
          token: state.ui.gatewayToken,
        }}
        onSelect={(newModelId) => dispatch({ type: 'UPDATE_PROJECT_MODEL', modelId: newModelId })}
        onClose={() => setIsExploreModalOpen(false)}
      />

      {/* Gateway接続設定モーダル */}
      <GatewayConfigModal
        isOpen={isGatewayConfigOpen}
        onClose={() => setIsGatewayConfigOpen(false)}
      />

      {/* プロジェクトメタ情報・説明設定モーダル */}
      <ProjectSettingsModal
        isOpen={isProjectSettingsOpen}
        onClose={() => setIsProjectSettingsOpen(false)}
      />
    </aside>
  );
};
