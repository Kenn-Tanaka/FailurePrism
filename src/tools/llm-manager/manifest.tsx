import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useLLMRegistry } from '../../shared/llm/useLLMRegistry';
import { ToolComponentProps, ToolManifest } from '../../shell/types';
import { LLMManagerApp } from './App';

const LLMManagerRoot: React.FC<ToolComponentProps> = ({
  isActive,
  gatewayToken,
  onGatewayTokenChange,
  onStatusChange,
}) => {
  const { state } = useLLMRegistry();
  const [localToken, setLocalToken] = useState<string>(gatewayToken || '');
  const [isBusy, setIsBusy] = useState(false);

  const prevExternalTokenRef = useRef<string>(gatewayToken || '');
  const prevLocalTokenRef = useRef<string>(localToken);

  // シェル共通 Gateway Token との双方向同期
  useEffect(() => {
    const ext = gatewayToken || '';
    const loc = localToken;

    if (ext !== prevExternalTokenRef.current) {
      prevExternalTokenRef.current = ext;
      prevLocalTokenRef.current = ext;
      if (loc !== ext) {
        setLocalToken(ext);
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
  }, [gatewayToken, localToken, onGatewayTokenChange]);

  const recommendedCount = state.models.filter((m) => m.isRecommended).length;
  const shortDefaultModel = state.defaultModelId.split('/').pop() || state.defaultModelId;

  useEffect(() => {
    onStatusChange?.({
      badgeCount: recommendedCount,
      badgeTooltip: `推奨 ${recommendedCount}件`,
      isBusy,
      busyLabel: '通信中',
      metrics: [
        { label: '共通既定LLM', value: shortDefaultModel },
        { label: '推奨モデル数', value: `${recommendedCount} / ${state.models.length} 件` },
      ],
    });
  }, [recommendedCount, state.models.length, shortDefaultModel, isBusy, onStatusChange]);

  return (
    <LLMManagerApp
      isActive={isActive}
      gatewayToken={localToken}
      onGatewayTokenChange={setLocalToken}
      onBusyChange={setIsBusy}
    />
  );
};

export const manifest: ToolManifest = {
  id: 'llm-manager',
  title: 'LLMモデル管理',
  subtitle: 'Default & Recommended LLM Manager',
  shortTitle: 'LLM管理',
  description:
    'TPDD-Editor および VTA-Editor が新規作成・起動時に使用するデフォルトLLMと、モデル選択・クイック切替に表示される推奨LLMカタログを一元管理します。',
  features: [
    '共通およびツール別（TPDD / VTA）デフォルトLLMの設定・検証',
    'OpenRouter公式API・LLM-Gatewayからの最新モデル一覧取得と一括取込',
    '推奨モデル・プリセットの一括削除・推奨切替・表示順管理',
    '配布シード (public/llm-models.json) 連携とJSONエクスポート／インポート',
  ],
  icon: SlidersHorizontal,
  theme: { color: 'emerald' },
  order: 30,
  component: LLMManagerRoot,
};

export default manifest;
