import React, { useEffect, useRef } from 'react';
import { Network } from 'lucide-react';
import { ToolComponentProps, ToolManifest } from '../../shell/types';
import { AppProvider, useApp } from './app/AppContext';
import { AppContent as TPDDAppContent } from './app/App';

const TPDDToolInner: React.FC<ToolComponentProps> = ({
  isActive,
  gatewayToken,
  onGatewayTokenChange,
  onStatusChange,
}) => {
  const { state, dispatch } = useApp();
  const project = state.history.present;
  const diagramCount = project.diagrams.length;
  const nodeCount = project.diagrams.reduce((sum, d) => sum + d.nodes.length, 0);
  const localToken = state.ui.gatewayToken || '';

  const prevExternalTokenRef = useRef<string>(gatewayToken || '');
  const prevLocalTokenRef = useRef<string>(localToken);

  // シェル共通 Gateway Token との双方向同期（追加・更新・削除対応）
  useEffect(() => {
    const ext = gatewayToken || '';
    const loc = localToken;

    if (ext !== prevExternalTokenRef.current) {
      prevExternalTokenRef.current = ext;
      prevLocalTokenRef.current = ext;
      if (loc !== ext) {
        dispatch({ type: 'SET_GATEWAY_TOKEN', token: ext });
      }
      return;
    }

    if (loc !== prevLocalTokenRef.current) {
      prevLocalTokenRef.current = loc;
      prevExternalTokenRef.current = loc;
      if (ext !== loc) {
        onGatewayTokenChange(loc);
      }
    }
  }, [gatewayToken, localToken, dispatch, onGatewayTokenChange]);

  // タブバー・ランチャーメニューへのリアルタイム状態通知
  useEffect(() => {
    onStatusChange?.({
      badgeCount: nodeCount,
      badgeTooltip: `${diagramCount}図 / ${nodeCount}ノード`,
      metrics: [
        { label: '編集中の図', value: `${diagramCount} 図` },
        { label: 'ノード総数', value: `${nodeCount} 件` },
      ],
    });
  }, [diagramCount, nodeCount, onStatusChange]);

  return <TPDDAppContent isActive={isActive} />;
};

export const TPDDToolRoot: React.FC<ToolComponentProps> = (props) => {
  return (
    <AppProvider>
      <TPDDToolInner {...props} />
    </AppProvider>
  );
};

export const manifest: ToolManifest = {
  id: 'tpdd',
  title: '思考展開図エディタ',
  subtitle: 'Thinking Process Development Diagram',
  shortTitle: 'TPDD-Editor',
  description:
    '要求 → 機能 → 機構 → 構造の抽象度階層に沿って設計思考を構造化・視覚化し、階層的な詳細図（Sub-diagram）とAIによる展開案・代替案・レビュー支援を備えたエディタです。',
  features: [
    '抽象度列（要求・機能・機構・構造・制約）に沿った自動整列と階層化詳細図',
    'AIによる下位展開案・代替案のストリーミング提案と差分プレビュー採用',
    'IndexedDB自動バックアップ・JSON保存・高品質ベクターSVG出力',
  ],
  icon: Network,
  theme: { color: 'blue' },
  order: 10,
  component: TPDDToolRoot,
};

export default manifest;
