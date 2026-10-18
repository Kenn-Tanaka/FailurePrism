import React from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { useApp } from '../../app/AppContext';

export const StatusBar: React.FC = () => {
  const { state, dispatch, autoSaveStatus, lastAutoSavedTime } = useApp();
  const { present: project } = state.history;
  const { activeDiagramId, viewports } = state.ui;

  const currentDiagram = project.diagrams.find((d) => d.id === activeDiagramId) || project.diagrams[0];
  const viewport = viewports[activeDiagramId] || { panX: 100, panY: 100, zoom: 1 };

  // 全体表示 (外接範囲に合わせてパン・ズーム)
  const handleFitToContent = () => {
    if (currentDiagram.nodes.length === 0) {
      dispatch({
        type: 'SET_VIEWPORT',
        diagramId: activeDiagramId,
        viewport: { panX: 100, panY: 100, zoom: 1 },
      });
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of currentDiagram.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }

    const padding = 60;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;

    const canvasW = window.innerWidth - 256 - 320; // 左右サイドバーを除く概算幅
    const canvasH = window.innerHeight - 48 - 24; // ヘッダー・フッターを除く

    const scaleX = canvasW / contentW;
    const scaleY = canvasH / contentH;
    const zoom = Math.min(2.0, Math.max(0.25, Math.min(scaleX, scaleY)));

    const panX = (canvasW - (maxX - minX) * zoom) / 2 - minX * zoom;
    const panY = (canvasH - (maxY - minY) * zoom) / 2 - minY * zoom;

    dispatch({
      type: 'SET_VIEWPORT',
      diagramId: activeDiagramId,
      viewport: { panX, panY, zoom },
    });
  };

  const handleZoomIn = () => {
    const nextZoom = Math.min(4.0, viewport.zoom * 1.2);
    dispatch({
      type: 'SET_VIEWPORT',
      diagramId: activeDiagramId,
      viewport: { ...viewport, zoom: nextZoom },
    });
  };

  const handleZoomOut = () => {
    const nextZoom = Math.max(0.25, viewport.zoom / 1.2);
    dispatch({
      type: 'SET_VIEWPORT',
      diagramId: activeDiagramId,
      viewport: { ...viewport, zoom: nextZoom },
    });
  };

  return (
    <footer className="h-6 bg-slate-100 border-t border-slate-200 px-4 flex items-center justify-between text-[11px] text-slate-500 select-none z-10">
      <div className="flex items-center gap-4">
        <span>図: <strong className="text-slate-700">{currentDiagram.title}</strong></span>
        <span>ノード: {currentDiagram.nodes.length}</span>
        <span>エッジ: {currentDiagram.edges.length}</span>
      </div>

      {/* 自動保存ステータス */}
      <div className="text-[10px] text-slate-400 flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            state.history.present && autoSaveStatus === 'saving'
              ? 'bg-amber-400 animate-pulse'
              : autoSaveStatus === 'saved'
              ? 'bg-emerald-500'
              : autoSaveStatus === 'error'
              ? 'bg-red-500'
              : 'bg-slate-300'
          }`}
        />
        <span>
          {autoSaveStatus === 'saving'
            ? '自動保存中...'
            : autoSaveStatus === 'saved'
            ? `自動保存済み (${lastAutoSavedTime || ''})`
            : autoSaveStatus === 'error'
            ? '自動保存エラー'
            : '待機中'}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleZoomOut}
          className="hover:text-slate-800 p-0.5 rounded"
          title="ズームアウト"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>

        <span className="font-mono w-12 text-center">
          {Math.round(viewport.zoom * 100)}%
        </span>

        <button
          onClick={handleZoomIn}
          className="hover:text-slate-800 p-0.5 rounded"
          title="ズームイン"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={handleFitToContent}
          className="hover:text-slate-800 p-0.5 rounded flex items-center gap-0.5 ml-1"
          title="全体表示 (Fit to content)"
        >
          <Maximize2 className="w-3 h-3" />
          <span>全体</span>
        </button>
      </div>
    </footer>
  );
};
