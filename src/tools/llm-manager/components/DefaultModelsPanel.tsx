import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Info,
  Send,
} from 'lucide-react';
import {
  KNOWN_LLM_CONSUMER_TOOLS,
  ManagedLLMRegistryState,
  ManagedModelEntry,
  validateModelId,
} from '../../../shared/llm/modelTypes';

export interface DefaultModelsPanelProps {
  state: ManagedLLMRegistryState;
  discoveredIds: Set<string> | null;
  pingingModelId: string | null;
  onSetDefaultModel: (modelId: string, toolId?: string) => void;
  onPingModel: (modelId: string) => void;
}

interface ModelPickerRowProps {
  label: string;
  description: string;
  currentValue: string;
  models: ManagedModelEntry[];
  discoveredIds: Set<string> | null;
  pingingModelId: string | null;
  allowInherit?: boolean;
  inheritedModelId?: string;
  onSaveModelId: (modelId: string) => void;
  onPingModel: (modelId: string) => void;
}

const ModelPickerRow: React.FC<ModelPickerRowProps> = ({
  label,
  description,
  currentValue,
  models,
  discoveredIds,
  pingingModelId,
  allowInherit = false,
  inheritedModelId,
  onSaveModelId,
  onPingModel,
}) => {
  const [customDraft, setCustomDraft] = useState(currentValue);
  const [isCustomEditing, setIsCustomEditing] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const isInheriting = allowInherit && !currentValue;
  const effectiveModelId = isInheriting ? inheritedModelId || '' : currentValue;
  const isInCatalog = Boolean(effectiveModelId && models.some((m) => m.id === effectiveModelId));
  const isPresentInGateway =
    discoveredIds !== null && effectiveModelId ? discoveredIds.has(effectiveModelId) : null;

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setValidationError(null);
    if (val === '__inherit__') {
      setIsCustomEditing(false);
      onSaveModelId('');
      return;
    }
    if (val === '__custom__') {
      setCustomDraft(effectiveModelId);
      setIsCustomEditing(true);
      return;
    }
    setIsCustomEditing(false);
    onSaveModelId(val);
  };

  const handleCommitCustom = () => {
    const check = validateModelId(customDraft);
    if (!check.valid) {
      setValidationError(check.message || 'モデルIDが不正です。');
      return;
    }
    setValidationError(null);
    setIsCustomEditing(false);
    onSaveModelId(customDraft.trim());
  };

  const selectValue = isCustomEditing
    ? '__custom__'
    : isInheriting
    ? '__inherit__'
    : currentValue;

  return (
    <div className="p-3.5 rounded-xl bg-slate-950/75 border border-slate-800 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-bold text-slate-100">{label}</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">{description}</p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isPresentInGateway === true && (
            <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-950/80 text-emerald-300 border border-emerald-700/70 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              Gateway実在
            </span>
          )}
          {isPresentInGateway === false && (
            <span
              className="px-2 py-0.5 rounded-full text-[10px] bg-amber-950/80 text-amber-300 border border-amber-700/70 flex items-center gap-1"
              title="最後に取得したGatewayモデル一覧に見つかりませんでした"
            >
              <AlertTriangle className="w-3 h-3" />
              一覧未確認
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <select
          aria-label={label}
          value={selectValue}
          onChange={handleSelectChange}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-emerald-500 cursor-pointer"
        >
          {allowInherit && (
            <option value="__inherit__">
              共通デフォルトに従う ({inheritedModelId})
            </option>
          )}
          {!isInheriting && !isInCatalog && currentValue && (
            <option value={currentValue}>カスタム指定: {currentValue}</option>
          )}
          {models.some((m) => m.isRecommended) && models.some((m) => !m.isRecommended) ? (
            <>
              <optgroup label="⭐ 推奨モデル">
                {models
                  .filter((m) => m.isRecommended)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.id})
                    </option>
                  ))}
              </optgroup>
              <optgroup label="📦 カタログ登録モデル（推奨OFF）">
                {models
                  .filter((m) => !m.isRecommended)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.id})
                    </option>
                  ))}
              </optgroup>
            </>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id})
              </option>
            ))
          )}
          <option value="__custom__">✏️ カスタムモデルIDを直接入力...</option>
        </select>

        <button
          type="button"
          onClick={() => effectiveModelId && onPingModel(effectiveModelId)}
          disabled={!effectiveModelId || pingingModelId === effectiveModelId}
          className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-emerald-300 border border-slate-700 text-xs font-medium flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
          title="このモデルへ最小Pingリクエストを送信して疎通確認します"
        >
          <Send className={`w-3.5 h-3.5 ${pingingModelId === effectiveModelId ? 'animate-pulse' : ''}`} />
          <span>{pingingModelId === effectiveModelId ? '確認中...' : '疎通テスト'}</span>
        </button>
      </div>

      {isCustomEditing && (
        <div className="space-y-1.5 pt-1">
          <div className="flex gap-2">
            <input
              type="text"
              value={customDraft}
              onChange={(e) => {
                setCustomDraft(e.target.value);
                setValidationError(null);
              }}
              placeholder="例: openrouter/anthropic/claude-sonnet-4"
              className="flex-1 bg-slate-900 border border-emerald-700/80 rounded-lg px-2.5 py-1.5 text-xs font-mono text-emerald-200 focus:outline-none focus:border-emerald-400"
            />
            <button
              type="button"
              onClick={handleCommitCustom}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer"
            >
              確定
            </button>
            <button
              type="button"
              onClick={() => {
                setIsCustomEditing(false);
                setValidationError(null);
              }}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs cursor-pointer"
            >
              取消
            </button>
          </div>
          {validationError && (
            <p className="text-[11px] text-rose-300">{validationError}</p>
          )}
        </div>
      )}

      <div className="text-[11px] text-slate-400 flex items-center gap-1.5 break-all">
        <Activity className="w-3 h-3 text-slate-500 shrink-0" />
        <span>有効な既定モデル:</span>
        <code className="font-mono text-emerald-300">{effectiveModelId}</code>
        {isInheriting && (
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
            共通継承
          </span>
        )}
      </div>
    </div>
  );
};

export const DefaultModelsPanel: React.FC<DefaultModelsPanelProps> = ({
  state,
  discoveredIds,
  pingingModelId,
  onSetDefaultModel,
  onPingModel,
}) => {
  return (
    <section
      aria-label="デフォルトLLM設定"
      className="rounded-2xl bg-slate-900/90 border border-slate-800 p-4 space-y-3.5 shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-emerald-950/90 border border-emerald-800 text-emerald-400">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">デフォルト LLM 設定</h2>
            <p className="text-[11px] text-slate-400">
              共通既定モデルと、ツール別の個別オーバーライドを設定します
            </p>
          </div>
        </div>
      </div>

      <ModelPickerRow
        label="共通デフォルト LLM"
        description="個別設定がない全ツールで使用される基準モデルです"
        currentValue={state.defaultModelId}
        models={state.models}
        discoveredIds={discoveredIds}
        pingingModelId={pingingModelId}
        onSaveModelId={(modelId) => onSetDefaultModel(modelId)}
        onPingModel={onPingModel}
      />

      <div className="space-y-2.5 pt-1">
        <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          ツール別オーバーライド（任意）
        </div>
        {KNOWN_LLM_CONSUMER_TOOLS.map((tool) => (
          <ModelPickerRow
            key={tool.id}
            label={`${tool.label} 用デフォルト`}
            description={`${tool.label} の初期モデルを共通設定と変えたい場合のみ指定します`}
            currentValue={state.toolDefaultModelIds[tool.id] || ''}
            inheritedModelId={state.defaultModelId}
            allowInherit
            models={state.models}
            discoveredIds={discoveredIds}
            pingingModelId={pingingModelId}
            onSaveModelId={(modelId) => onSetDefaultModel(modelId, tool.id)}
            onPingModel={onPingModel}
          />
        ))}
      </div>

      <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/90 text-[11px] text-slate-300 flex items-start gap-2 leading-relaxed">
        <Info className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <span>
          変更内容はブラウザに保存され、<strong>TPDD の新規プロジェクト作成時</strong>および
          <strong>VTA の次回起動・初期化時</strong>に適用されます。現在開いている図や保存済みプロジェクトファイルのモデル設定は上書きされません。
        </span>
      </div>
    </section>
  );
};
