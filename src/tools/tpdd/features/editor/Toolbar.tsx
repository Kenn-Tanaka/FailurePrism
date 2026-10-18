import React, { useRef, useState } from 'react';
import {
  Download,
  FilePlus,
  FolderOpen,
  Image,
  Camera,
  Layers,
  Redo2,
  Share2,
  Undo2,
  PlusCircle,
  LayoutGrid,
  Columns,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import {
  downloadSvg,
  downloadDiagramPng,
  exportAllDiagramsAsSvg,
  generateDiagramSvg,
} from '../../rendering/svgExport';
import { parseAndValidateProjectJson, saveProjectToFile } from '../../services/persistence/fileIo';
import { LevelsModal } from './LevelsModal';

export const Toolbar: React.FC = () => {
  const { state, dispatch } = useApp();
  const { present: project } = state.history;
  const { activeDiagramId, selectedNodeId, edgeDraftSourceId, viewports } = state.ui;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isLevelsModalOpen, setIsLevelsModalOpen] = useState(false);

  const currentDiagram = project.diagrams.find((d) => d.id === activeDiagramId) || project.diagrams[0];
  const viewport = viewports[activeDiagramId] || { panX: 100, panY: 100, zoom: 1 };

  // ノード追加
  const handleAddNode = () => {
    // 画面中央付近の図座標を算出
    const targetLevelId = project.levels[0]?.id || 'level-requirement';
    const centerX = (-viewport.panX + 400) / viewport.zoom;
    const centerY = (-viewport.panY + 300) / viewport.zoom;

    // ノードが重ならないよう少しずらす
    const offset = (currentDiagram.nodes.length % 5) * 20;

    dispatch({
      type: 'ADD_NODE',
      params: {
        label: '新規ノード',
        kind: 'requirement',
        status: 'draft',
        levelId: targetLevelId,
        x: Math.round(centerX + offset),
        y: Math.round(centerY + offset),
      },
    });
  };

  // エッジ作成モード切り替え
  const handleToggleEdgeMode = () => {
    if (edgeDraftSourceId) {
      dispatch({ type: 'SET_EDGE_DRAFT_SOURCE', sourceId: null });
    } else if (selectedNodeId) {
      dispatch({ type: 'SET_EDGE_DRAFT_SOURCE', sourceId: selectedNodeId });
    } else {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `edge-hint-${Date.now()}`,
          type: 'info',
          message: 'エッジを作成するには、まず始点となるノードを選択してください。',
        },
      });
    }
  };

  // 保存 (.thought.json)
  const handleSaveJson = () => {
    saveProjectToFile(project);
    dispatch({
      type: 'SET_NOTIFICATION',
      notification: {
        id: `save-ok-${Date.now()}`,
        type: 'success',
        message: `プロジェクト「${project.title}」をダウンロード保存しました。`,
      },
    });
  };

  // SVG出力
  const handleExportSvg = () => {
    const svgStr = generateDiagramSvg(currentDiagram, project.levels);
    const filename = `${project.title}_${currentDiagram.title}`;
    downloadSvg(svgStr, filename);
    dispatch({
      type: 'SET_NOTIFICATION',
      notification: {
        id: `svg-ok-${Date.now()}`,
        type: 'success',
        message: `図「${currentDiagram.title}」をSVG出力しました。`,
      },
    });
  };

  // PNG画像出力
  const handleExportPng = async () => {
    try {
      const filename = `${project.title}_${currentDiagram.title}`;
      await downloadDiagramPng(currentDiagram, project.levels, filename);
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `png-ok-${Date.now()}`,
          type: 'success',
          message: `図「${currentDiagram.title}」をPNG画像出力しました。`,
        },
      });
    } catch (e) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `png-err-${Date.now()}`,
          type: 'error',
          message: `PNG出力失敗: ${e instanceof Error ? e.message : '予期せぬエラー'}`,
        },
      });
    }
  };

  // 全図一括SVG出力
  const handleExportAllSvg = () => {
    exportAllDiagramsAsSvg(project.diagrams, project.levels, project.title);
    dispatch({
      type: 'SET_NOTIFICATION',
      notification: {
        id: `svg-all-ok-${Date.now()}`,
        type: 'success',
        message: `全 ${project.diagrams.length} 件の図面をSVG出力開始しました。`,
      },
    });
  };

  // ファイル読込
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const result = await parseAndValidateProjectJson(file);
    if (!result.success || !result.project) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `load-err-${Date.now()}`,
          type: 'error',
          message: `読み込み失敗: ${result.errorMessage || 'JSON形式が不正です'}`,
        },
      });
    } else {
      dispatch({ type: 'LOAD_PROJECT', project: result.project });
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `load-ok-${Date.now()}`,
          type: 'success',
          message: `プロジェクト「${result.project.title}」を読み込みました。`,
        },
      });
    }
    // inputリセット
    e.target.value = '';
  };

  const canUndo = state.history.past.length > 0;
  const canRedo = state.history.future.length > 0;

  return (
    <header className="h-12 bg-white border-b border-slate-200 px-4 flex items-center justify-between shadow-sm z-10 select-none">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.tpdd.json,.thought.json"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* 左側: ファイル操作 */}
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-2 mr-3 font-semibold text-slate-800 text-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-600 inline-block"></span>
          思考展開図エディタ (TPDD)
        </div>

        <button
          onClick={() => {
            if (confirm('現在の内容を破棄して新規プロジェクトを作成しますか？')) {
              dispatch({ type: 'NEW_PROJECT' });
            }
          }}
          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs flex items-center gap-1"
          title="新規作成"
        >
          <FilePlus className="w-4 h-4" />
          <span className="hidden sm:inline">新規</span>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs flex items-center gap-1"
          title="開く (.tpdd.json / .thought.json)"
        >
          <FolderOpen className="w-4 h-4" />
          <span className="hidden sm:inline">開く</span>
        </button>

        <button
          onClick={handleSaveJson}
          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs flex items-center gap-1"
          title="JSON保存 (.tpdd.json)"
        >
          <Download className="w-4 h-4" />
          <span className="hidden sm:inline">保存</span>
        </button>

        <button
          onClick={handleExportSvg}
          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs flex items-center gap-1"
          title="現在図をSVG出力"
        >
          <Image className="w-4 h-4" />
          <span className="hidden sm:inline">SVG</span>
        </button>

        <button
          onClick={handleExportPng}
          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs flex items-center gap-1"
          title="現在図をPNG画像出力"
        >
          <Camera className="w-4 h-4" />
          <span className="hidden sm:inline">PNG</span>
        </button>

        {project.diagrams.length > 1 && (
          <button
            onClick={handleExportAllSvg}
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs flex items-center gap-1"
            title={`全 ${project.diagrams.length} 件の図面を一括SVG出力`}
          >
            <Layers className="w-4 h-4" />
            <span className="hidden sm:inline">全図</span>
          </button>
        )}

        <div className="h-4 w-px bg-slate-200 mx-1" />

        {/* Undo / Redo */}
        <button
          onClick={() => dispatch({ type: 'UNDO' })}
          disabled={!canUndo}
          className={`p-1.5 rounded text-xs flex items-center gap-1 ${
            canUndo ? 'text-slate-700 hover:bg-slate-100' : 'text-slate-300 cursor-not-allowed'
          }`}
          title="元に戻す (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4" />
        </button>

        <button
          onClick={() => dispatch({ type: 'REDO' })}
          disabled={!canRedo}
          className={`p-1.5 rounded text-xs flex items-center gap-1 ${
            canRedo ? 'text-slate-700 hover:bg-slate-100' : 'text-slate-300 cursor-not-allowed'
          }`}
          title="やり直す (Ctrl+Y)"
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      {/* 中央: 編集コマンド */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleAddNode}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium flex items-center gap-1.5 shadow-sm transition-colors"
        >
          <PlusCircle className="w-4 h-4" />
          ノード追加
        </button>

        <button
          onClick={handleToggleEdgeMode}
          className={`px-3 py-1 rounded text-xs font-medium flex items-center gap-1.5 border transition-colors ${
            edgeDraftSourceId
              ? 'bg-amber-100 border-amber-400 text-amber-800'
              : 'bg-white border-slate-300 hover:bg-slate-50 text-slate-700'
          }`}
        >
          <Share2 className="w-4 h-4" />
          {edgeDraftSourceId ? 'エッジ作成中...' : 'エッジ作成'}
        </button>

        <div className="h-4 w-px bg-slate-200 mx-1" />

        {/* 自動レイアウト */}
        <button
          onClick={() => dispatch({ type: 'AUTO_LAYOUT' })}
          className="px-2.5 py-1 text-slate-700 hover:bg-slate-100 border border-slate-300 rounded text-xs flex items-center gap-1.5"
          title="抽象度列順・Y順でノードを自動整列 (Ctrl+Zで戻せます)"
        >
          <LayoutGrid className="w-4 h-4 text-slate-500" />
          自動レイアウト
        </button>

        {/* 抽象度列管理 */}
        <button
          onClick={() => setIsLevelsModalOpen(true)}
          className="px-2.5 py-1 text-slate-700 hover:bg-slate-100 border border-slate-300 rounded text-xs flex items-center gap-1.5"
          title="抽象度列の追加・編集・並び替え"
        >
          <Columns className="w-4 h-4 text-slate-500" />
          列の管理
        </button>
      </div>

      {/* 右側: 補助情報 */}
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-600">
          Rev: {state.history.revision}
        </span>
      </div>

      <LevelsModal
        isOpen={isLevelsModalOpen}
        onClose={() => setIsLevelsModalOpen(false)}
      />
    </header>
  );
};
