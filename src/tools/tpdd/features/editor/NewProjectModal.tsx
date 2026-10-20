import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, X } from 'lucide-react';
import { ProjectPresetId } from '../../domain/commands';

interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (preset: ProjectPresetId) => void;
}

const PRESET_OPTIONS: Array<{
  id: ProjectPresetId;
  label: string;
  description: string;
}> = [
  {
    id: 'mechanical',
    label: '機械設計',
    description: '要求・機能・機構・構造を中心とした設計体系',
  },
  {
    id: 'software',
    label: 'ソフトウェア設計',
    description: '要求・責務・論理設計・コンポーネントを中心とした設計体系',
  },
  {
    id: 'electronics',
    label: '電子回路設計',
    description: '仕様・電気的機能・回路方式・部品を中心とした設計体系',
  },
  {
    id: 'custom',
    label: 'カスタム',
    description: '最小構成から種別と配置列を自由に定義',
  },
];

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [selectedPreset, setSelectedPreset] = useState<ProjectPresetId>('mechanical');

  useEffect(() => {
    if (isOpen) setSelectedPreset('mechanical');
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
            {PRESET_OPTIONS.map((preset) => {
              const selected = selectedPreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSelectedPreset(preset.id)}
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
            onClick={() => onCreate(selectedPreset)}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium shadow-sm"
          >
            この設定で作成
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
