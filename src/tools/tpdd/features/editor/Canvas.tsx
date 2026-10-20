import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { ThoughtNode } from '../../domain/schema';
import { screenToDiagramCoords } from '../../rendering/ctm';
import { EdgeComponent } from './EdgeComponent';
import { LevelsLayer } from './LevelsLayer';
import { NodeComponent } from './NodeComponent';

export interface CanvasProps {
  isActive?: boolean;
}

export const Canvas: React.FC<CanvasProps> = ({ isActive = true }) => {
  const { state, dispatch } = useApp();
  const { present: project } = state.history;
  const {
    activeDiagramId,
    selectedNodeId,
    selectedNodeIds,
    selectedEdgeId,
    edgeDraftSourceId,
    viewports,
    dragState,
    editingNodeId,
  } = state.ui;

  const currentDiagram = project.diagrams.find((d) => d.id === activeDiagramId) || project.diagrams[0];
  const viewport = viewports[activeDiagramId] || { panX: 100, panY: 100, zoom: 1 };

  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportGroupRef = useRef<SVGGElement | null>(null);

  // パン状態
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; initialPanX: number; initialPanY: number } | null>(null);
  const isSpacePressedRef = useRef(false);
  const isEditingCancelledRef = useRef(false);

  // ラバーバンド矩形選択状態 (図座標系)
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // ポート結線ドラッグ状態 (図座標系)
  const [portDragState, setPortDragState] = useState<{
    sourceNodeId: string;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Spaceキー状態追跡 & ショートカット (F2, 矢印キー移動, Esc)
  useEffect(() => {
    if (!isActive) {
      isSpacePressedRef.current = false;
      setIsPanning(false);
      setPortDragState(null);
      setSelectionBox(null);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      const isModalOpen = Boolean(document.querySelector('.fixed.inset-0.z-50'));
      if (isModalOpen) return;

      const isInputActive =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable;

      if (e.code === 'Space' && !e.repeat && !isInputActive) {
        isSpacePressedRef.current = true;
      }

      if (e.key === 'Escape') {
        if (edgeDraftSourceId) {
          dispatch({ type: 'SET_EDGE_DRAFT_SOURCE', sourceId: null });
        }
        if (dragState) {
          dispatch({ type: 'CANCEL_DRAG' });
        }
        if (portDragState) {
          setPortDragState(null);
        }
        if (selectionBox) {
          setSelectionBox(null);
        }
        if (editingNodeId) {
          dispatch({ type: 'SET_EDITING_NODE', nodeId: null });
        }
      }

      // F2キー: 選択ノードのインプレース編集開始
      if (e.key === 'F2' && !isInputActive && selectedNodeId) {
        e.preventDefault();
        dispatch({ type: 'SET_EDITING_NODE', nodeId: selectedNodeId });
      }

      // 矢印キーによるノード位置微調整 (1px / Shift+10px)
      if (
        !isInputActive &&
        selectedNodeIds.length > 0 &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;

        const targetNodes = currentDiagram.nodes.filter((n) => selectedNodeIds.includes(n.id));
        const positions = targetNodes.map((n) => ({
          id: n.id,
          x: Math.round(n.x + dx),
          y: Math.round(n.y + dy),
        }));
        dispatch({ type: 'UPDATE_NODES_POSITION', positions });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = false;
        setIsPanning(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    dispatch,
    edgeDraftSourceId,
    dragState,
    portDragState,
    selectionBox,
    editingNodeId,
    selectedNodeId,
    selectedNodeIds,
    currentDiagram.nodes,
    isActive,
  ]);

  // ホイールズーム (CTM座標系・非パッシブネイティブリスナー)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.min(4.0, Math.max(0.25, viewport.zoom * zoomFactor));

      const rect = svg.getBoundingClientRect();
      const mouseScreenX = e.clientX - rect.left;
      const mouseScreenY = e.clientY - rect.top;

      // カーソル位置の図座標を固定したままズームする
      const newPanX = mouseScreenX - ((mouseScreenX - viewport.panX) / viewport.zoom) * newZoom;
      const newPanY = mouseScreenY - ((mouseScreenY - viewport.panY) / viewport.zoom) * newZoom;

      dispatch({
        type: 'SET_VIEWPORT',
        diagramId: activeDiagramId,
        viewport: {
          panX: newPanX,
          panY: newPanY,
          zoom: newZoom,
        },
      });
    };

    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, [activeDiagramId, dispatch, viewport]);

  // キャンバス上のポインタダウン (パン開始、またはラバーバンド矩形選択開始)
  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // 中ボタン (button === 1) または Space+左クリックでパン開始
    if (e.button === 1 || (e.button === 0 && isSpacePressedRef.current)) {
      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        initialPanX: viewport.panX,
        initialPanY: viewport.panY,
      };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }

    // 左クリックで背景をクリックした場合はラバーバンド矩形選択を開始
    if (e.button === 0 && (e.target === svgRef.current || (e.target as Element).id === 'canvas-background')) {
      if (!e.shiftKey) {
        dispatch({ type: 'SELECT_NODE', nodeId: null });
        dispatch({ type: 'SELECT_EDGE', edgeId: null });
      }
      if (edgeDraftSourceId) {
        dispatch({ type: 'SET_EDGE_DRAFT_SOURCE', sourceId: null });
      }

      if (viewportGroupRef.current) {
        const pt = screenToDiagramCoords(viewportGroupRef.current, e.clientX, e.clientY);
        setSelectionBox({
          startX: pt.x,
          startY: pt.y,
          currentX: pt.x,
          currentY: pt.y,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    }
  };

  // ポインタ移動 (パン、ラバーバンド選択、ポート結線、ノードドラッグ)
  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (isPanning && panStartRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      dispatch({
        type: 'SET_VIEWPORT',
        diagramId: activeDiagramId,
        viewport: {
          ...viewport,
          panX: panStartRef.current.initialPanX + dx,
          panY: panStartRef.current.initialPanY + dy,
        },
      });
      return;
    }

    if (selectionBox && viewportGroupRef.current) {
      const pt = screenToDiagramCoords(viewportGroupRef.current, e.clientX, e.clientY);
      setSelectionBox((prev) => (prev ? { ...prev, currentX: pt.x, currentY: pt.y } : null));

      // 矩形内外判定による複数ノード選択
      const minX = Math.min(selectionBox.startX, pt.x);
      const maxX = Math.max(selectionBox.startX, pt.x);
      const minY = Math.min(selectionBox.startY, pt.y);
      const maxY = Math.max(selectionBox.startY, pt.y);

      const hitNodes = currentDiagram.nodes.filter(
        (n) => n.x + n.width >= minX && n.x <= maxX && n.y + n.height >= minY && n.y <= maxY
      );
      dispatch({ type: 'SELECT_NODES', nodeIds: hitNodes.map((n) => n.id) });
      return;
    }

    if (portDragState && viewportGroupRef.current) {
      const pt = screenToDiagramCoords(viewportGroupRef.current, e.clientX, e.clientY);
      setPortDragState((prev) => (prev ? { ...prev, currentX: pt.x, currentY: pt.y } : null));
      return;
    }

    if (dragState && viewportGroupRef.current) {
      // CTM逆行列による高精度座標変換
      const diagramPoint = screenToDiagramCoords(viewportGroupRef.current, e.clientX, e.clientY);
      dispatch({
        type: 'UPDATE_DRAG',
        currentX: diagramPoint.x - dragState.offsetX,
        currentY: diagramPoint.y - dragState.offsetY,
      });
    }
  };

  // ポインタアップ (パン確定、ラバーバンド確定、ポート結線確定、ノードドラッグ確定)
  const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        // no-op
      }
      return;
    }

    if (selectionBox) {
      setSelectionBox(null);
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        // no-op
      }
      return;
    }

    if (portDragState && viewportGroupRef.current) {
      const pt = screenToDiagramCoords(viewportGroupRef.current, e.clientX, e.clientY);
      // ドロップ先のノードを判定
      const targetNode = currentDiagram.nodes.find(
        (n) => pt.x >= n.x && pt.x <= n.x + n.width && pt.y >= n.y && pt.y <= n.y + n.height
      );
      if (targetNode && targetNode.id !== portDragState.sourceNodeId) {
        dispatch({
          type: 'ADD_EDGE',
          params: {
            sourceId: portDragState.sourceNodeId,
            targetId: targetNode.id,
            kind: 'decomposition',
          },
        });
      }
      setPortDragState(null);
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        // no-op
      }
      return;
    }

    if (dragState) {
      dispatch({ type: 'COMMIT_DRAG' });
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        // no-op
      }
    }
  };

  // ノード上でのポインタダウン (複数選択を考慮したドラッグ開始)
  const handleNodePointerDown = (e: React.PointerEvent<SVGGElement>, node: ThoughtNode) => {
    if (isSpacePressedRef.current || e.button !== 0) return;

    e.stopPropagation();
    if (!viewportGroupRef.current) return;

    // CTM逆行列からノード相対オフセットを算出
    const diagramPoint = screenToDiagramCoords(viewportGroupRef.current, e.clientX, e.clientY);
    const offsetX = diagramPoint.x - node.x;
    const offsetY = diagramPoint.y - node.y;

    // Shiftキー押下中の場合は複数選択トグル（クリック時）を優先しドラッグを開始しない
    if (e.shiftKey) {
      return;
    }

    // もし掴んだノードが既に選択ノード群に含まれているなら、全選択ノードを一括移動対象にする
    if (selectedNodeIds.includes(node.id) && selectedNodeIds.length > 1) {
      const selectedNodes = currentDiagram.nodes.filter((n) => selectedNodeIds.includes(n.id));
      const initialPositions = selectedNodes.map((n) => ({
        nodeId: n.id,
        initialX: n.x,
        initialY: n.y,
      }));
      dispatch({
        type: 'START_DRAG',
        dragState: {
          nodeId: node.id,
          offsetX,
          offsetY,
          currentX: node.x,
          currentY: node.y,
          initialPositions,
        },
      });
    } else {
      // 選択されていないノードをドラッグした場合は単一選択として開始
      if (!selectedNodeIds.includes(node.id)) {
        dispatch({ type: 'SELECT_NODE', nodeId: node.id });
      }
      dispatch({
        type: 'START_DRAG',
        dragState: {
          nodeId: node.id,
          offsetX,
          offsetY,
          currentX: node.x,
          currentY: node.y,
        },
      });
    }

    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  // ノードクリック (単一選択またはShift+クリックでの複数選択トグル、またはエッジ作成)
  const handleNodeClick = (e: React.MouseEvent, node: ThoughtNode) => {
    e.stopPropagation();

    if (edgeDraftSourceId) {
      if (edgeDraftSourceId === node.id) {
        // 自分自身をクリックした場合は解除
        dispatch({ type: 'SET_EDGE_DRAFT_SOURCE', sourceId: null });
        return;
      }
      // エッジ作成実行
      dispatch({
        type: 'ADD_EDGE',
        params: {
          sourceId: edgeDraftSourceId,
          targetId: node.id,
          kind: 'decomposition',
        },
      });
      return;
    }

    if (e.shiftKey) {
      dispatch({ type: 'SELECT_NODE', nodeId: node.id, multi: true });
    } else {
      dispatch({ type: 'SELECT_NODE', nodeId: node.id });
    }
  };

  // ノードダブルクリック (子図があれば遷移、なければインプレース編集開始)
  const handleNodeDoubleClick = (e: React.MouseEvent, node: ThoughtNode) => {
    e.stopPropagation();
    if (node.childDiagramId) {
      dispatch({ type: 'SET_ACTIVE_DIAGRAM', diagramId: node.childDiagramId });
    } else {
      dispatch({ type: 'SET_EDITING_NODE', nodeId: node.id });
    }
  };

  // ノードの接続ポートからのD&D結線開始
  const handleStartEdgeDrag = (e: React.PointerEvent<SVGCircleElement>, node: ThoughtNode) => {
    if (!viewportGroupRef.current || !svgRef.current) return;
    const pt = screenToDiagramCoords(viewportGroupRef.current, e.clientX, e.clientY);
    setPortDragState({
      sourceNodeId: node.id,
      currentX: pt.x,
      currentY: pt.y,
    });
    try {
      svgRef.current.setPointerCapture?.(e.pointerId);
    } catch {
      // no-op
    }
  };

  // エッジクリック
  const handleEdgeClick = (e: React.MouseEvent, edge: { id: string }) => {
    e.stopPropagation();
    dispatch({ type: 'SELECT_EDGE', edgeId: edge.id });
  };

  // ドラッグ中の一時座標を反映したノードマップ（エッジ追従用）
  const nodeMap = new Map<string, ThoughtNode>();
  for (const node of currentDiagram.nodes) {
    if (dragState) {
      if (dragState.initialPositions && dragState.initialPositions.length > 0) {
        const initPos = dragState.initialPositions.find((p) => p.nodeId === node.id);
        if (initPos) {
          const mainInitial = dragState.initialPositions.find((p) => p.nodeId === dragState.nodeId);
          const dx = dragState.currentX - (mainInitial ? mainInitial.initialX : dragState.currentX);
          const dy = dragState.currentY - (mainInitial ? mainInitial.initialY : dragState.currentY);
          nodeMap.set(node.id, {
            ...node,
            x: Math.round(initPos.initialX + dx),
            y: Math.round(initPos.initialY + dy),
          });
          continue;
        }
      } else if (dragState.nodeId === node.id) {
        nodeMap.set(node.id, {
          ...node,
          x: Math.round(dragState.currentX),
          y: Math.round(dragState.currentY),
        });
        continue;
      }
    }
    nodeMap.set(node.id, node);
  }

  // ビューポート外カリング範囲計算 (50ノード以上で自動有効化、マージン300px)
  const CULL_MARGIN = 300;
  const svgRect = svgRef.current?.getBoundingClientRect();
  const viewWidth = svgRect?.width || 1280;
  const viewHeight = svgRect?.height || 800;

  const visibleMinX = (-viewport.panX - CULL_MARGIN) / viewport.zoom;
  const visibleMaxX = (-viewport.panX + viewWidth + CULL_MARGIN) / viewport.zoom;
  const visibleMinY = (-viewport.panY - CULL_MARGIN) / viewport.zoom;
  const visibleMaxY = (-viewport.panY + viewHeight + CULL_MARGIN) / viewport.zoom;

  const enableCulling = currentDiagram.nodes.length >= 50;

  const isNodeVisible = (node: ThoughtNode) => {
    if (!enableCulling) return true;
    if (selectedNodeIds.includes(node.id) || dragState?.nodeId === node.id || editingNodeId === node.id) {
      return true;
    }
    return (
      node.x + node.width >= visibleMinX &&
      node.x <= visibleMaxX &&
      node.y + node.height >= visibleMinY &&
      node.y <= visibleMaxY
    );
  };

  return (
    <div className="relative flex-1 h-full overflow-hidden bg-slate-100 select-none">
      <svg
        ref={svgRef}
        className={`w-full h-full ${
          isPanning || isSpacePressedRef.current ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
        }`}
        onPointerDown={handleSvgPointerDown}
        onPointerMove={handleSvgPointerMove}
        onPointerUp={handleSvgPointerUp}
      >
        <defs>
          {/* グリッドパターン (20 SVG単位) */}
          <pattern id="grid-pattern" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" fill="#cbd5e1" />
          </pattern>

          {/* 各種エッジ矢印マーカー */}
          <marker id="arrow-decomposition" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
          </marker>
          <marker id="arrow-decomposition-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
          </marker>

          <marker id="arrow-dependency" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#0284c7" />
          </marker>
          <marker id="arrow-dependency-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
          </marker>

          <marker id="arrow-constraint" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#dc2626" />
          </marker>
          <marker id="arrow-constraint-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
          </marker>

          <marker id="arrow-reference" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#94a3b8" />
          </marker>
          <marker id="arrow-reference-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
          </marker>
        </defs>

        {/* 背景グリッド */}
        <rect id="canvas-background" width="100%" height="100%" fill="url(#grid-pattern)" />

        {/* ズーム & パン適用ビューポートグループ */}
        <g
          id="viewport-group"
          ref={viewportGroupRef}
          transform={`translate(${viewport.panX}, ${viewport.panY}) scale(${viewport.zoom})`}
        >
          {/* 抽象度列 */}
          <LevelsLayer levels={project.levels} />

          {/* エッジ一覧 */}
          <g className="edges-layer">
            {currentDiagram.edges.map((edge) => {
              const sNode = nodeMap.get(edge.sourceId);
              const tNode = nodeMap.get(edge.targetId);
              if (!sNode || !tNode) return null;

              // カリング: 始点・終点ともに画面外の場合はエッジ描画をスキップ
              if (!isNodeVisible(sNode) && !isNodeVisible(tNode)) {
                return null;
              }

              const isReversePair = currentDiagram.edges.some(
                (e) => e.sourceId === edge.targetId && e.targetId === edge.sourceId
              );

              return (
                <EdgeComponent
                  key={edge.id}
                  edge={edge}
                  sourceNode={sNode}
                  targetNode={tNode}
                  isSelected={selectedEdgeId === edge.id}
                  isReversePair={isReversePair}
                  onClick={handleEdgeClick}
                />
              );
            })}
          </g>

          {/* ノード一覧 */}
          <g className="nodes-layer">
            {currentDiagram.nodes.map((node) => {
              if (!isNodeVisible(node)) {
                return null;
              }
              let isDragging = false;
              let dragX: number | undefined = undefined;
              let dragY: number | undefined = undefined;

              if (dragState) {
                if (dragState.initialPositions && dragState.initialPositions.length > 0) {
                  const initPos = dragState.initialPositions.find((p) => p.nodeId === node.id);
                  if (initPos) {
                    const mainInitial = dragState.initialPositions.find((p) => p.nodeId === dragState.nodeId);
                    const dx = dragState.currentX - (mainInitial ? mainInitial.initialX : dragState.currentX);
                    const dy = dragState.currentY - (mainInitial ? mainInitial.initialY : dragState.currentY);
                    isDragging = true;
                    dragX = Math.round(initPos.initialX + dx);
                    dragY = Math.round(initPos.initialY + dy);
                  }
                } else if (dragState.nodeId === node.id) {
                  isDragging = true;
                  dragX = Math.round(dragState.currentX);
                  dragY = Math.round(dragState.currentY);
                }
              }

              const level = project.levels.find((l) => l.id === node.levelId);
              const kindDefinition = project.nodeKinds.find((k) => k.id === node.kindId);

              return (
                <NodeComponent
                  key={node.id}
                  node={node}
                  kindDefinition={kindDefinition}
                  levelLabel={level?.label}
                  isSelected={selectedNodeIds.includes(node.id)}
                  isDraftSource={edgeDraftSourceId === node.id}
                  isDragging={isDragging}
                  dragX={dragX}
                  dragY={dragY}
                  isEditing={editingNodeId === node.id}
                  onPointerDown={handleNodePointerDown}
                  onClick={handleNodeClick}
                  onDoubleClick={handleNodeDoubleClick}
                  onStartEdgeDrag={handleStartEdgeDrag}
                />
              );
            })}
          </g>

          {/* ポート結線ドラッグ中の一時エッジ線 */}
          {portDragState && (() => {
            const sNode = nodeMap.get(portDragState.sourceNodeId);
            if (!sNode) return null;
            const sx = sNode.x + sNode.width / 2;
            const sy = sNode.y + sNode.height / 2;
            const tx = portDragState.currentX;
            const ty = portDragState.currentY;
            const dx = (tx - sx) * 0.5;
            const pathD = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
            return (
              <g className="draft-edge-layer pointer-events-none">
                <path
                  d={pathD}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={2}
                  strokeDasharray="4,4"
                  markerEnd="url(#arrow-decomposition-selected)"
                />
              </g>
            );
          })()}

          {/* ラバーバンド矩形選択 */}
          {selectionBox && (
            <rect
              x={Math.min(selectionBox.startX, selectionBox.currentX)}
              y={Math.min(selectionBox.startY, selectionBox.currentY)}
              width={Math.abs(selectionBox.currentX - selectionBox.startX)}
              height={Math.abs(selectionBox.currentY - selectionBox.startY)}
              fill="rgba(37, 99, 235, 0.12)"
              stroke="#2563eb"
              strokeWidth={1.5}
              strokeDasharray="4,4"
              className="pointer-events-none"
            />
          )}
        </g>
      </svg>

      {/* インプレース編集用 HTMLオーバーレイ */}
      {(() => {
        if (!editingNodeId) return null;
        const editingNode = currentDiagram.nodes.find((n) => n.id === editingNodeId);
        if (!editingNode) return null;

        const left = editingNode.x * viewport.zoom + viewport.panX + 8 * viewport.zoom;
        const top = editingNode.y * viewport.zoom + viewport.panY + 28 * viewport.zoom;
        const width = Math.max(120, (editingNode.width - 16) * viewport.zoom);
        const height = Math.max(36, (editingNode.height - 34) * viewport.zoom);

        return (
          <div
            className="absolute z-30"
            style={{
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
            }}
          >
            <textarea
              autoFocus
              defaultValue={editingNode.label}
              className="w-full h-full p-1.5 border-2 border-blue-500 rounded bg-white shadow-xl resize-none outline-none font-sans text-slate-800 leading-tight"
              style={{ fontSize: `${Math.max(11, 13 * viewport.zoom)}px` }}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                if (isEditingCancelledRef.current) {
                  isEditingCancelledRef.current = false;
                  return;
                }
                const val = e.target.value.trim();
                if (val.length > 200) {
                  dispatch({
                    type: 'SET_NOTIFICATION',
                    notification: {
                      id: `inline-label-err-${Date.now()}`,
                      type: 'error',
                      message: `ラベルは200文字以内で入力してください（現在${val.length}文字）。`,
                    },
                  });
                  dispatch({ type: 'SET_EDITING_NODE', nodeId: null });
                  return;
                }
                if (val && val !== editingNode.label) {
                  dispatch({ type: 'UPDATE_NODE', nodeId: editingNode.id, patch: { label: val } });
                }
                dispatch({ type: 'SET_EDITING_NODE', nodeId: null });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  isEditingCancelledRef.current = true;
                  dispatch({ type: 'SET_EDITING_NODE', nodeId: null });
                }
              }}
            />
          </div>
        );
      })()}

      {/* 複数選択時の情報バッジ */}
      {selectedNodeIds.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-slate-800/90 text-white px-3.5 py-1.5 rounded-full shadow-lg text-xs font-medium flex items-center gap-2 z-20">
          <span className="w-2 h-2 rounded-full bg-blue-400"></span>
          <span>{selectedNodeIds.length} 個のノードを選択中（ドラッグで一括移動 / Deleteで一括削除）</span>
        </div>
      )}

      {/* 子図表示中の親ノード情報・パンくず */}
      {(() => {
        let parentInfo: { parentDiagId: string; parentDiagTitle: string; parentNodeLabel: string } | null = null;
        for (const d of project.diagrams) {
          for (const n of d.nodes) {
            if (n.childDiagramId === activeDiagramId) {
              parentInfo = {
                parentDiagId: d.id,
                parentDiagTitle: d.title,
                parentNodeLabel: n.label,
              };
              break;
            }
          }
          if (parentInfo) break;
        }

        if (!parentInfo) return null;

        return (
          <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-sm border border-slate-300 shadow-md rounded-lg p-2 text-xs flex items-center gap-2 z-10">
            <button
              onClick={() => dispatch({ type: 'SET_ACTIVE_DIAGRAM', diagramId: parentInfo!.parentDiagId })}
              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded flex items-center gap-1"
              title="親図へ戻る"
            >
              <span>← {parentInfo.parentDiagTitle}</span>
            </button>
            <span className="text-slate-400">/</span>
            <div className="flex items-center gap-1 text-slate-600">
              <span className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-bold">親ノード</span>
              <strong className="text-slate-800 truncate max-w-[200px]">{parentInfo.parentNodeLabel}</strong>
            </div>
          </div>
        );
      })()}

      {/* エッジ作成中通知バナー */}
      {edgeDraftSourceId && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-amber-500 text-white px-4 py-1.5 rounded-full shadow-lg text-sm font-medium flex items-center gap-2 animate-bounce z-20">
          <span>接続先のノードをクリックしてください（Escでキャンセル）</span>
          <button
            onClick={() => dispatch({ type: 'SET_EDGE_DRAFT_SOURCE', sourceId: null })}
            className="ml-2 hover:bg-amber-600 rounded px-1.5 py-0.5 text-xs font-bold"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};
