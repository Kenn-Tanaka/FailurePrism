import React, { useEffect, useRef } from 'react';
import { GitBranch } from 'lucide-react';
import { ToolComponentProps, ToolManifest } from '../../shell/types';
import { App as VTAApp } from './App';
import { useVTAStore } from './features/vta/store/vtaStore';

export const VTAToolRoot: React.FC<ToolComponentProps> = ({
  isActive,
  gatewayToken,
  onGatewayTokenChange,
  onStatusChange,
}) => {
  const vtaData = useVTAStore((s) => s.vtaData);
  const isDirty = useVTAStore((s) => s.isDirty);
  const isExtracting = useVTAStore((s) => s.isExtracting);
  const isRegenerating = useVTAStore((s) => s.isRegenerating);
  const isProposing = useVTAStore((s) => s.isProposing);
  const isParsingFile = useVTAStore((s) => s.isParsingFile);
  const uiTaskProgress = useVTAStore((s) => s.uiTaskProgress);
  const localToken = useVTAStore((s) => s.llmConfig.gatewayToken || '');
  const setLLMConfig = useVTAStore((s) => s.setLLMConfig);

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
        setLLMConfig({ gatewayToken: ext });
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
  }, [gatewayToken, localToken, setLLMConfig, onGatewayTokenChange]);

  const nodeCount = vtaData.nodes.length;
  const laneCount = vtaData.lanes.length;
  const isBusy =
    isExtracting ||
    isRegenerating ||
    isProposing ||
    isParsingFile ||
    Boolean(uiTaskProgress);
  const busyLabel = uiTaskProgress
    ? uiTaskProgress.title
    : isParsingFile
      ? '文書解析中'
      : isRegenerating
        ? 'レポート生成中'
        : isProposing
          ? '対策提案中'
          : '生成中';

  // タブバー・ランチャーメニューへのリアルタイム状態通知
  useEffect(() => {
    onStatusChange?.({
      badgeCount: nodeCount,
      badgeTooltip: `${laneCount}レーン / ${nodeCount}ノード`,
      isDirty,
      isBusy,
      busyLabel,
      metrics: [
        { label: 'レーン / ノード', value: `${laneCount} / ${nodeCount}` },
        ...(isDirty
          ? [{ label: '状態', value: '未保存の変更あり', highlight: 'amber' as const }]
          : []),
      ],
    });
  }, [nodeCount, laneCount, isDirty, isBusy, busyLabel, onStatusChange]);

  return <VTAApp isActive={isActive} />;
};

export const manifest: ToolManifest = {
  id: 'vta',
  title: 'バリエーションツリー解析エディタ',
  subtitle: 'Variation Tree Analysis Editor',
  shortTitle: 'VTA-Editor',
  description:
    '事故・不具合の調査報告書（PDF・Word・Excel・テキスト）からアクター別・時系列のバリエーションツリーを自動抽出し、排除（Elimination）・遮断（Break）対策と再発防止レポートを生成します。',
  features: [
    'PDF / Word (.docx) / Excel (.xlsx) / テキストからの事象ツリー自動抽出',
    'スイムレーン×時系列（BT）グラフ上の排除・遮断（バリア）対策シミュレーション',
    'AIによる対策候補の自動推奨・改善後業務フロー＆分析レポート自動生成',
  ],
  icon: GitBranch,
  theme: { color: 'indigo' },
  order: 20,
  component: VTAToolRoot,
};

export default manifest;
