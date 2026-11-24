import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Sparkles, X } from 'lucide-react';
import {
  classifyModel,
  KNOWN_LLM_CONSUMER_TOOLS,
  ManagedModelEntry,
  ModelProviderId,
  validateModelId,
} from '../../../shared/llm/modelTypes';

export interface ModelFormModalProps {
  isOpen: boolean;
  isActive: boolean;
  initialModel?: Partial<ManagedModelEntry> | null;
  mode: 'create' | 'edit';
  existingIds: string[];
  onSave: (
    entry: Omit<ManagedModelEntry, 'order'> & { order?: number },
    previousId?: string
  ) => void;
  onClose: () => void;
}

const PROVIDER_OPTIONS: Array<{ value: ModelProviderId; label: string }> = [
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'local', label: 'ローカルLLM (LM Studio / Ollama)' },
  { value: 'other', label: 'その他' },
];

export const ModelFormModal: React.FC<ModelFormModalProps> = ({
  isOpen,
  isActive,
  initialModel,
  mode,
  existingIds,
  onSave,
  onClose,
}) => {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ModelProviderId>('other');
  const [description, setDescription] = useState('');
  const [isRecommended, setIsRecommended] = useState(true);
  const [isPreset, setIsPreset] = useState(true);
  const [isReasoning, setIsReasoning] = useState(false);
  const [targetTools, setTargetTools] = useState<string[]>(['tpdd', 'vta']);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setId(initialModel?.id ?? '');
    setName(initialModel?.name ?? '');
    setProvider(initialModel?.provider ?? 'google');
    setDescription(initialModel?.description ?? '');
    setIsRecommended(initialModel?.isRecommended ?? true);
    setIsPreset(initialModel?.isPreset ?? true);
    setIsReasoning(initialModel?.isReasoning ?? false);
    setTargetTools(
      initialModel?.targetTools && initialModel.targetTools.length > 0
        ? [...initialModel.targetTools]
        : ['tpdd', 'vta']
    );
    setError(null);
  }, [isOpen, initialModel]);

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isActive, onClose]);

  if (!isOpen || !isActive || typeof document === 'undefined') {
    return null;
  }

  const handleAutoClassify = () => {
    const trimmedId = id.trim();
    if (!trimmedId) return;
    const classified = classifyModel(trimmedId, name.trim() || undefined);
    setProvider(classified.provider);
    if (!name.trim()) {
      setName(classified.name);
    }
    setIsReasoning(classified.isReasoning);
  };

  const toggleTargetTool = (toolId: string) => {
    setTargetTools((prev) =>
      prev.includes(toolId) ? prev.filter((item) => item !== toolId) : [...prev, toolId]
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedId = id.trim();
    const idCheck = validateModelId(trimmedId);
    if (!idCheck.valid) {
      setError(idCheck.message || 'モデルIDの形式が不正です。');
      return;
    }

    const previousId = mode === 'edit' ? initialModel?.id : undefined;
    if (existingIds.some((existing) => existing === trimmedId && existing !== previousId)) {
      setError(`モデルID「${trimmedId}」は既に登録されています。`);
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('表示名を入力してください。');
      return;
    }
    if (trimmedName.length > 200) {
      setError('表示名は200文字以内で入力してください。');
      return;
    }
    if (description.length > 2000) {
      setError('説明は2,000文字以内で入力してください。');
      return;
    }
    if (targetTools.length === 0) {
      setError('表示対象ツールを少なくとも1つ選択してください。');
      return;
    }

    onSave(
      {
        id: trimmedId,
        name: trimmedName,
        provider,
        description: description.trim(),
        isRecommended,
        isPreset,
        isReasoning,
        targetTools,
        ...(initialModel?.order !== undefined ? { order: initialModel.order } : {}),
      },
      previousId
    );
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="llm-model-form-title"
        className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden text-slate-100"
      >
        <div className="px-5 py-4 bg-slate-950/80 border-b border-slate-800 flex items-center justify-between">
          <h2 id="llm-model-form-title" className="text-sm font-bold text-white">
            {mode === 'edit' ? '登録モデルの編集' : '推奨モデルの登録'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg cursor-pointer"
            aria-label="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs max-h-[82vh] overflow-y-auto">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-semibold text-slate-300">
                Gateway モデル ID <span className="text-rose-400">*</span>
              </label>
              <button
                type="button"
                onClick={handleAutoClassify}
                className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
              >
                <Sparkles className="w-3 h-3" />
                <span>IDから属性を自動推定</span>
              </button>
            </div>
            <input
              type="text"
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setError(null);
              }}
              placeholder="例: openrouter/google/gemini-3.8-flash"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-emerald-200 focus:outline-none focus:border-emerald-500"
              autoFocus
            />
            <p className="mt-1 text-[11px] text-slate-400">
              <code>&lt;provider_id&gt;/&lt;upstream_model_id&gt;</code> 形式で入力してください。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-300 mb-1">
                表示名 <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder="例: Gemini 3.8 Flash"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1">プロバイダ分類</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ModelProviderId)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1">用途・説明文</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="モデルの特徴や用途（例: 高速で構造化出力が安定している）"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500 resize-y"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
              <div className="font-semibold text-slate-300 text-[11px]">表示対象ツール</div>
              {KNOWN_LLM_CONSUMER_TOOLS.map((tool) => (
                <label key={tool.id} className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={targetTools.includes(tool.id)}
                    onChange={() => toggleTargetTool(tool.id)}
                    className="rounded border-slate-700 bg-slate-900 text-emerald-500"
                  />
                  <span className="text-slate-200">{tool.label}</span>
                </label>
              ))}
            </div>

            <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
              <div className="font-semibold text-slate-300 text-[11px]">属性・表示フラグ</div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isRecommended}
                  onChange={(e) => setIsRecommended(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-emerald-500"
                />
                <span className="text-slate-200">推奨モデルとして強調表示</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isPreset}
                  onChange={(e) => setIsPreset(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-emerald-500"
                />
                <span className="text-slate-200">クイック切替プルダウンに含める</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isReasoning}
                  onChange={(e) => setIsReasoning(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-emerald-500"
                />
                <span className="text-slate-200">思考モデル（Reasoning）</span>
              </label>
            </div>
          </div>

          {error && (
            <div className="p-2.5 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-200 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1.5 cursor-pointer shadow-md"
            >
              <Check className="w-4 h-4" />
              <span>{mode === 'edit' ? '変更を保存' : '登録する'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
