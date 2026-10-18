import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, AlertCircle } from 'lucide-react';

interface CustomModelModalProps {
  isOpen: boolean;
  currentModelId: string;
  onCommit: (newModelId: string) => void;
  onClose: () => void;
}

/**
 * カスタムモデルID形式検証
 * 仕様書 8.4.2: <provider_id>/<upstream_model_id> 形式、制御文字禁止、1024文字以内
 */
export function validateCustomModelId(input: string): { valid: boolean; message?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, message: 'モデルIDを入力してください。' };
  }
  if (trimmed.length > 1024) {
    return { valid: false, message: 'モデルIDは1024文字以内である必要があります。' };
  }
  // 制御文字 (0x00 - 0x1f, 0x7f) の混入禁止
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { valid: false, message: 'モデルIDに制御文字を含めることはできません。' };
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex === -1) {
    return {
      valid: false,
      message: 'モデルIDは <provider_id>/<upstream_model_id> の形式（例: lmstudio/my-model）である必要があります。',
    };
  }

  const providerId = trimmed.slice(0, slashIndex).trim();
  const upstreamModelId = trimmed.slice(slashIndex + 1).trim();

  if (!providerId) {
    return { valid: false, message: 'プロバイダーID (最初のスラッシュの前) を入力してください。' };
  }
  if (!upstreamModelId) {
    return { valid: false, message: '上流モデルID (最初のスラッシュの後) を入力してください。' };
  }

  return { valid: true };
}

export const CustomModelModal: React.FC<CustomModelModalProps> = ({
  isOpen,
  currentModelId,
  onCommit,
  onClose,
}) => {
  const [inputVal, setInputVal] = useState(currentModelId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setInputVal(currentModelId);
      setErrorMessage(null);
    }
  }, [isOpen, currentModelId]);

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateCustomModelId(inputVal);
    if (!result.valid) {
      setErrorMessage(result.message || 'モデルIDの形式が不正です');
      return;
    }

    onCommit(inputVal.trim());
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-800">カスタムモデルIDの入力</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* フォーム */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div>
            <label className="text-slate-600 block mb-1 font-medium">Gateway モデルID</label>
            <input
              type="text"
              value={inputVal}
              onChange={(e) => {
                setInputVal(e.target.value);
                setErrorMessage(null);
              }}
              autoFocus
              placeholder="例: lmstudio/qwen2.5-coder-7b または openrouter/meta-llama/llama-3.3-70b-instruct"
              className="w-full p-2 border border-slate-300 rounded font-mono text-xs focus:outline-blue-500"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              形式: <code>&lt;provider_id&gt;/&lt;upstream_model_id&gt;</code>（2個目以降のスラッシュも許可されます）
            </p>
          </div>

          {errorMessage && (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded text-red-600 text-[11px] flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-100"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium flex items-center gap-1 shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              確定
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
