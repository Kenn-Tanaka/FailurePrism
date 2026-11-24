import React, { useState, useRef, useEffect } from 'react';
import {
  Key,
  Cpu,
  RefreshCw,
  Eye,
  EyeOff,
  CheckCircle,
  AlertCircle,
  SlidersHorizontal,
  Timer,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { testGatewayConnection } from '../../services/llm/client';
import { ModelSelectorModal } from '../ModelSelectorModal';
import { MODEL_PRESETS } from '../../features/vta/data/modelCatalog';
import { useToolModelCatalog } from '../../../../shared/llm/useLLMRegistry';

export { MODEL_PRESETS };

export interface LLMConfigSectionProps {
  variant?: 'panel' | 'popover';
}

export const LLMConfigSection: React.FC<LLMConfigSectionProps> = ({ variant = 'panel' }) => {
  const { presetModels } = useToolModelCatalog('vta');
  const livePresets = [
    ...presetModels.map((entry) => ({
      id: entry.id,
      name: entry.isRecommended ? `${entry.name} (推奨)` : entry.name,
    })),
    { id: 'custom', name: '✏️ カスタムモデルIDを入力...' },
  ];

  const llmConfig = useVTAStore((state) => state.llmConfig);
  const setLLMConfig = useVTAStore((state) => state.setLLMConfig);
  const addLog = useVTAStore((state) => state.addLog);
  const setError = useVTAStore((state) => state.setError);
  const createAbortController = useVTAStore((state) => state.createAbortController);

  const [isExpanded, setIsExpanded] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);

  const [isCustomMode, setIsCustomMode] = useState(false);
  const [customModelText, setCustomModelText] = useState(llmConfig.selectedModel);
  const popoverContainerRef = useRef<HTMLDivElement>(null);

  const isPresetModel = livePresets.some(
    (preset) => preset.id === llmConfig.selectedModel && preset.id !== 'custom'
  );

  useEffect(() => {
    if (variant !== 'popover' || !isExpanded || typeof document === 'undefined') return;
    const handlePointerDown = (event: MouseEvent) => {
      if (isModelModalOpen) return;
      if (popoverContainerRef.current && !popoverContainerRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isModelModalOpen) {
        setIsExpanded(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [variant, isExpanded, isModelModalOpen]);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    setError(null);
    const controller = createAbortController();
    try {
      const res = await testGatewayConnection(llmConfig, controller.signal);
      setTestResult(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '接続テスト中に予期せぬエラーが発生しました。';
      setTestResult({ success: false, message: msg });
      addLog('error', `接続失敗: ${msg}`, 'LLM');
    } finally {
      setIsTesting(false);
    }
  };

  const handleModelSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'custom') {
      setIsCustomMode(true);
      setCustomModelText(llmConfig.selectedModel);
    } else {
      setIsCustomMode(false);
      setLLMConfig({ selectedModel: val });
      setTestResult(null);
    }
  };

  const handleCustomModelBlur = () => {
    if (customModelText.trim()) {
      setLLMConfig({ selectedModel: customModelText.trim() });
      setTestResult(null);
    }
    setIsCustomMode(false);
  };

  const shortModelLabel = llmConfig.selectedModel.split('/').pop() || llmConfig.selectedModel;

  const testResultBanner = testResult && (
    <div
      className={`flex items-start gap-1.5 p-2 rounded-lg text-[11px] leading-tight ${
        testResult.success
          ? 'bg-emerald-950/50 border border-emerald-800/60 text-emerald-300'
          : 'bg-rose-950/50 border border-rose-800/60 text-rose-300'
      }`}
    >
      {testResult.success ? (
        <CheckCircle className="w-3.5 h-3.5 shrink-0 text-emerald-400 mt-0.5" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400 mt-0.5" />
      )}
      <span>{testResult.message}</span>
    </div>
  );

  const settingsFields = (
    <div className="space-y-2.5 text-xs">
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">
          ローカルプロキシ / エンドポイント URL
        </label>
        <input
          type="text"
          value={llmConfig.baseUrl}
          onChange={(e) => setLLMConfig({ baseUrl: e.target.value })}
          placeholder="/v1 または http://localhost:8080/v1"
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono transition-colors"
        />
      </div>

      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span>Gateway Token (任意)</span>
          <button
            type="button"
            onClick={() => setShowToken(!showToken)}
            className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white cursor-pointer"
          >
            {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            <span>{showToken ? '隠す' : '表示'}</span>
          </button>
        </div>
        <div className="relative">
          <input
            type={showToken ? 'text' : 'password'}
            value={llmConfig.gatewayToken || ''}
            onChange={(e) => setLLMConfig({ gatewayToken: e.target.value })}
            placeholder="ローカルプロキシ認証トークン"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-7 pr-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono transition-colors"
          />
          <Key className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-2" />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span>推論モデル</span>
          <button
            type="button"
            onClick={() => setIsModelModalOpen(true)}
            className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 transition-colors font-medium cursor-pointer"
          >
            <SlidersHorizontal className="w-3 h-3" />
            <span>すべてのモデル一覧から選択</span>
          </button>
        </div>
        <select
          value={isCustomMode ? 'custom' : llmConfig.selectedModel}
          onChange={handleModelSelectChange}
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-sans transition-colors cursor-pointer"
        >
          {!isPresetModel && llmConfig.selectedModel !== 'custom' && (
            <option value={llmConfig.selectedModel}>選択中: {llmConfig.selectedModel}</option>
          )}
          {livePresets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        <p className="mt-1.5 text-[11px] text-slate-400 break-all">
          現在使用するモデル: <span className="font-mono text-cyan-300">{llmConfig.selectedModel}</span>
        </p>

        {isCustomMode && (
          <div className="mt-1.5">
            <input
              type="text"
              value={customModelText}
              onChange={(e) => setCustomModelText(e.target.value)}
              onBlur={handleCustomModelBlur}
              placeholder="例: openrouter/google/gemini-3.8-flash"
              className="w-full bg-slate-950 border border-cyan-800/80 rounded-lg px-2.5 py-1.5 text-xs text-cyan-300 focus:outline-none focus:border-cyan-400 font-mono transition-colors"
            />
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span className="flex items-center gap-1">
            <Timer className="w-3 h-3 text-slate-400" />
            無通信タイムアウト時間 (秒)
          </span>
          <span className="font-mono text-cyan-400 font-semibold">{llmConfig.timeoutSeconds || 180}s</span>
        </div>
        <input
          type="range"
          min="30"
          max="600"
          step="10"
          value={llmConfig.timeoutSeconds || 180}
          onChange={(e) => setLLMConfig({ timeoutSeconds: Number(e.target.value) })}
          className="w-full accent-cyan-500 cursor-pointer"
        />
      </div>

      <div>
        <label className="block text-[11px] text-slate-400 mb-1">
          推論強度 (Reasoning Effort)
        </label>
        <select
          value={llmConfig.reasoningEffort || 'auto'}
          onChange={(e) =>
            setLLMConfig({
              reasoningEffort: e.target.value as import('../../types/vta').LLMReasoningEffort,
            })
          }
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-sans transition-colors cursor-pointer"
        >
          <option value="auto">自動 (OpenRouter Claude系は low・他は既定)</option>
          <option value="low">低 (low - 高速・推論暴走防止)</option>
          <option value="medium">中 (medium)</option>
          <option value="high">高 (high)</option>
          <option value="minimal">最小 (minimal)</option>
          <option value="none">なし (none)</option>
        </select>
      </div>
    </div>
  );

  if (variant === 'popover') {
    return (
      <div ref={popoverContainerRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
          data-vta-focus-id="llm-config-trigger"
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer max-w-[200px] ${
            isExpanded
              ? 'bg-cyan-950/80 border-cyan-500 text-cyan-200'
              : 'bg-slate-900 hover:bg-slate-800 border-slate-700/80 text-slate-200 hover:text-white'
          }`}
          title={`AIモデル・LLM接続設定 (現在: ${llmConfig.selectedModel})`}
        >
          <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="truncate font-mono text-[11px]">{shortModelLabel}</span>
          {testResult && (
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                testResult.success ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
              title={testResult.message}
            />
          )}
          <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
        </button>

        {isExpanded && (
          <div className="absolute right-0 top-full mt-2 w-80 bg-slate-900/98 border border-slate-700 rounded-xl p-3.5 shadow-2xl z-50 space-y-3 select-text">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-100">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                <span>AIモデル・接続設定</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isTesting}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 rounded-md border border-slate-700 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 ${isTesting ? 'animate-spin' : ''}`} />
                  <span>{isTesting ? 'テスト中...' : '接続テスト'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsExpanded(false)}
                  className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded cursor-pointer"
                  title="閉じる"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {testResultBanner}
            {settingsFields}
          </div>
        )}

        <ModelSelectorModal
          isOpen={isModelModalOpen}
          selectedModel={llmConfig.selectedModel}
          onSelectModel={(modelId) => {
            setLLMConfig({ selectedModel: modelId });
            setIsCustomMode(false);
            setCustomModelText(modelId);
            setTestResult(null);
            addLog('info', `モデルを変更しました: ${modelId}`, 'CONFIG');
          }}
          onClose={() => setIsModelModalOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="p-2.5 bg-slate-900/90 rounded-xl border border-slate-800 space-y-2.5 shadow-md">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
          className="flex items-center gap-1.5 text-xs font-bold text-slate-300 hover:text-cyan-300 transition-colors cursor-pointer min-w-0 flex-1 text-left"
          title="クリックしてLLM接続設定を展開・折りたたみ"
        >
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}
          <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="shrink-0">LLM設定</span>
          <span
            className="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700/80 text-[10px] font-mono font-normal text-cyan-300 truncate max-w-[165px]"
            title={`現在使用するモデル: ${llmConfig.selectedModel}`}
          >
            {shortModelLabel}
          </span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isTesting}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 rounded-md border border-slate-700 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${isTesting ? 'animate-spin' : ''}`} />
            <span>{isTesting ? 'テスト中...' : '接続テスト'}</span>
          </button>
        </div>
      </div>

      {testResultBanner}

      {isExpanded && (
        <div className="pt-2 border-t border-slate-800/80 animate-in fade-in-50 duration-150">
          {settingsFields}
        </div>
      )}

      <ModelSelectorModal
        isOpen={isModelModalOpen}
        selectedModel={llmConfig.selectedModel}
        onSelectModel={(modelId) => {
          setLLMConfig({ selectedModel: modelId });
          setIsCustomMode(false);
          setCustomModelText(modelId);
          setTestResult(null);
          addLog('info', `モデルを変更しました: ${modelId}`, 'CONFIG');
        }}
        onClose={() => setIsModelModalOpen(false)}
      />
    </div>
  );
};
