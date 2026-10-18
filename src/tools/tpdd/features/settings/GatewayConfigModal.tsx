import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings, X, Check, Activity, AlertCircle, ShieldCheck } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { gatewayClient } from '../../services/llm/gatewayClient';
import { isValidLoopbackUrl, loadAppSettings, saveAppSettings } from '../../services/persistence/appStorage';

interface GatewayConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const GatewayConfigModal: React.FC<GatewayConfigModalProps> = ({ isOpen, onClose }) => {
  const { state, dispatch } = useApp();
  const { aiPreferences } = state.history.present;

  const [urlInput, setUrlInput] = useState('');
  const [authEnabled, setAuthEnabled] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(600);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [stream, setStream] = useState(true);

  // 接続テスト状態
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);

  // モーダルオープン時またはプロパティ変更時に初期状態を同期
  useEffect(() => {
    if (!isOpen) return;
    const currentSettings = loadAppSettings();
    setUrlInput(currentSettings.gatewayUrl);
    setAuthEnabled(currentSettings.gatewayAuthEnabled);
    setTokenInput(state.ui.gatewayToken);
    setTimeoutSec(aiPreferences.timeoutSeconds);
    setTemperature(aiPreferences.temperature);
    setStream(aiPreferences.stream);
    setTestStatus('idle');
    setTestMessage(null);
  }, [isOpen, aiPreferences, state.ui.gatewayToken]);

  // Escapeキーで閉じる
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // 接続テスト
  const handleTestConnection = async () => {
    const urlValidation = isValidLoopbackUrl(urlInput);
    if (!urlValidation.valid) {
      setTestStatus('error');
      setTestMessage(urlValidation.message || 'URLが不正です');
      return;
    }

    setTestStatus('testing');
    setTestMessage(null);

    try {
      const models = await gatewayClient.listModels({
        apiBaseUrl: urlInput,
        authEnabled,
        token: tokenInput,
      });

      setTestStatus('success');
      setTestMessage(`接続成功！ (${models.length} 件のモデルを検出しました)`);
    } catch (err: unknown) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // 保存・確定
  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();

    const urlValidation = isValidLoopbackUrl(urlInput);
    if (!urlValidation.valid) {
      alert(urlValidation.message || 'Gateway URLが不正です');
      return;
    }

    // タイムアウトとTemperatureのクランプ検証
    const clampedTimeout = Math.max(30, Math.min(1800, Number.isFinite(timeoutSec) ? timeoutSec : 600));
    const clampedTemp =
      temperature !== null && Number.isFinite(temperature)
        ? Math.max(0.0, Math.min(2.0, temperature))
        : null;

    // 非秘密設定をLocalStorageへ保存
    saveAppSettings({
      gatewayUrl: urlInput.trim(),
      gatewayAuthEnabled: authEnabled,
    });

    // Tokenはメモリ（AppContextステート）にのみ保持
    dispatch({ type: 'SET_GATEWAY_TOKEN', token: tokenInput.trim() });

    // ProjectのaiPreferencesを更新（履歴クリアや図リセットを行わない）
    dispatch({
      type: 'UPDATE_AI_PREFERENCES',
      patch: {
        timeoutSeconds: clampedTimeout,
        temperature: clampedTemp,
        stream,
      },
    });

    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-blue-600" />
            <h2 className="text-sm font-bold text-slate-800">LLM-Gateway 接続設定</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* フォーム */}
        <form onSubmit={handleSave} className="p-5 space-y-4 text-xs overflow-y-auto max-h-[75vh]">
          {/* Gateway URL */}
          <div>
            <label className="text-slate-700 block mb-1 font-semibold">Gateway API URL (基点)</label>
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="w-full p-2 border border-slate-300 rounded font-mono text-xs focus:outline-blue-500"
              placeholder="/v1"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              通常は <code>/v1</code> を使用します。別のローカルGatewayにはloopback URLを指定できます。
            </p>
          </div>

          {/* 認証切り替え & トークン */}
          <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={authEnabled}
                onChange={(e) => setAuthEnabled(e.target.checked)}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="font-semibold text-slate-700">Gateway Client 認証を使用する</span>
            </label>

            {authEnabled && (
              <div className="pt-1">
                <label className="text-slate-600 block mb-1 font-medium">Gateway Client Token</label>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Gateway Client Tokenを入力"
                  className="w-full p-2 border border-slate-300 rounded text-xs bg-white focus:outline-blue-500"
                />
                <div className="flex items-center gap-1 text-[10px] text-emerald-600 mt-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Tokenはブラウザのメモリ内のみに保持され、永続化・ログ出力されません</span>
                </div>
              </div>
            )}
          </div>

          {/* タイムアウト & 温度 & ストリーミング */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className="text-slate-600 block mb-1 font-medium">
                タイムアウト（秒: 30〜1800）
              </label>
              <input
                type="number"
                min={30}
                max={1800}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                className="w-full p-1.5 border border-slate-300 rounded"
              />
            </div>

            <div>
              <label className="text-slate-600 block mb-1 font-medium">
                温度 (Temperature: 0.0〜2.0)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={temperature ?? ''}
                  onChange={(e) =>
                    setTemperature(e.target.value === '' ? null : Number(e.target.value))
                  }
                  placeholder="未指定(null)"
                  className="w-full p-1.5 border border-slate-300 rounded"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-slate-700">ストリーミング (SSE) を有効にする</span>
            </label>
          </div>

          {/* 接続テスト実行ボタン & 結果 */}
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testStatus === 'testing'}
              className="px-3 py-1.5 border border-slate-300 hover:bg-slate-100 rounded text-slate-700 font-medium flex items-center gap-1.5"
            >
              <Activity className={`w-3.5 h-3.5 ${testStatus === 'testing' ? 'animate-spin text-blue-600' : ''}`} />
              <span>{testStatus === 'testing' ? 'テスト中...' : '接続テスト'}</span>
            </button>

            {testStatus === 'success' && (
              <span className="text-emerald-600 font-medium flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                {testMessage}
              </span>
            )}
            {testStatus === 'error' && (
              <span className="text-red-600 flex items-center gap-1 max-w-[260px] truncate" title={testMessage || ''}>
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {testMessage}
              </span>
            )}
          </div>

          {/* ボタン */}
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-100"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium flex items-center gap-1.5 shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              保存して閉じる
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
