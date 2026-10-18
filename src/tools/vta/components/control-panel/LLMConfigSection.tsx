import React, { useState } from 'react';
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
} from 'lucide-react';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { testGatewayConnection } from '../../services/llm/client';
import { ModelSelectorModal } from '../ModelSelectorModal';
import { MODEL_PRESETS } from '../../features/vta/data/modelCatalog';

export { MODEL_PRESETS };

export const LLMConfigSection: React.FC = () => {
  const llmConfig = useVTAStore((state) => state.llmConfig);
  const setLLMConfig = useVTAStore((state) => state.setLLMConfig);
  const addLog = useVTAStore((state) => state.addLog);
  const setError = useVTAStore((state) => state.setError);
  const createAbortController = useVTAStore((state) => state.createAbortController);

  const [showToken, setShowToken] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);

  const isInitialCustom = !MODEL_PRESETS.some(
    (p) => p.id === llmConfig.selectedModel && p.id !== 'custom'
  );
  const [isCustomMode, setIsCustomMode] = useState(isInitialCustom);
  const [customModelText, setCustomModelText] = useState(
    isInitialCustom ? llmConfig.selectedModel : ''
  );

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
    }
  };

  const handleCustomModelBlur = () => {
    if (customModelText.trim()) {
      setLLMConfig({ selectedModel: customModelText.trim() });
    }
  };

  return (
    <div className="p-3.5 bg-slate-900/90 rounded-xl border border-slate-800 space-y-3 shadow-md">
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
        <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-cyan-400" />
          LLM Gateway 接続設定
        </span>
        <button
          type="button"
          onClick={handleTestConnection}
          disabled={isTesting}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 rounded-md border border-slate-700 transition-colors disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${isTesting ? 'animate-spin' : ''}`} />
          <span>{isTesting ? 'テスト中...' : '接続テスト'}</span>
        </button>
      </div>

      {testResult && (
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
      )}

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
              className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white"
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
            {MODEL_PRESETS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

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
              タイムアウト時間 (秒)
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
      </div>

      <ModelSelectorModal
        isOpen={isModelModalOpen}
        selectedModel={llmConfig.selectedModel}
        onSelectModel={(modelId) => {
          setLLMConfig({ selectedModel: modelId });
          setIsCustomMode(false);
          setCustomModelText(modelId);
          addLog('info', `モデルを変更しました: ${modelId}`, 'CONFIG');
        }}
        onClose={() => setIsModelModalOpen(false)}
      />
    </div>
  );
};
