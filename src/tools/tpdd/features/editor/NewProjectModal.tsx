import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, X } from 'lucide-react';
import { ProjectPresetDefinition } from '../../domain/commands';
import { loadProjectPresets } from '../../domain/projectPresets';

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (preset: ProjectPresetDefinition) => void;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [presets, setPresets] = useState<ProjectPresetDefinition[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('mechanical');
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setWarning(undefined);
    loadProjectPresets().then((result) => {
      if (cancelled) return;
      setPresets(result.presets);
      setWarning(result.warning);
      setSelectedPresetId(result.presets.some((preset) => preset.id === 'mechanical')
        ? 'mechanical'
        : result.presets[0]?.id ?? '');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 id="new-project-title" className="text-sm font-bold text-slate-800">
              新規プロジェクト
            </h2>
            <p className="text-xs text-slate-500">設計分野に合う初期設定を選択してください</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded"
            aria-label="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {presets.map((preset) => {
              const selected = selectedPresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSelectedPresetId(preset.id)}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    selected
                      ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="text-xs text-slate-800">{preset.label}</strong>
                    {selected && <Check className="w-4 h-4 text-blue-600" />}
                  </span>
                  <span className="text-[11px] text-slate-500 leading-relaxed mt-1 block">
                    {preset.description}
                  </span>
                </button>
              );
            })}
          </div>

          {loading && <p className="text-xs text-slate-500">プリセットを読み込んでいます…</p>}
          {warning && (
            <div role="status" className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{warning}</span>
            </div>
          )}
          <div className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>作成すると現在編集中の内容は破棄されます。必要な場合は先に保存してください。</span>
          </div>
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 border border-slate-300 rounded text-xs text-slate-600 hover:bg-white"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => {
              const preset = presets.find((item) => item.id === selectedPresetId);
              if (preset) onCreate(preset);
            }}
            disabled={loading || !presets.some((preset) => preset.id === selectedPresetId)}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded text-xs font-medium shadow-sm"
          >
            この設定で作成
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
