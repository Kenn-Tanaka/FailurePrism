import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Columns3,
  Plus,
  Shapes,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { NodePaletteKey, TPDD_LIMITS } from '../../domain/schema';
import {
  getNodePalette,
  NODE_PALETTES,
  NODE_PALETTE_KEYS,
} from '../../rendering/nodeStyles';

interface DesignSystemModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type DesignTab = 'kinds' | 'levels';

const DEFINITION_DESCRIPTION_MAX_LENGTH = 2000;

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export const DesignSystemModal: React.FC<DesignSystemModalProps> = ({ isOpen, onClose }) => {
  const { state, dispatch } = useApp();
  const project = state.history.present;
  const { nodeKinds, levels } = project;

  const [activeTab, setActiveTab] = useState<DesignTab>('kinds');
  const [newKindName, setNewKindName] = useState('');
  const [newKindDescription, setNewKindDescription] = useState('');
  const [newKindPalette, setNewKindPalette] = useState<NodePaletteKey>('gray');
  const [newLevelName, setNewLevelName] = useState('');
  const [newLevelDescription, setNewLevelDescription] = useState('');
  const [deletingKindId, setDeletingKindId] = useState<string | null>(null);
  const [targetKindId, setTargetKindId] = useState('');
  const [deletingLevelId, setDeletingLevelId] = useState<string | null>(null);
  const [targetLevelId, setTargetLevelId] = useState('');

  const requestClose = React.useCallback(() => {
    // 既存定義の入力はonBlurで確定するため、アンマウント前に同期的に確定させる。
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setDeletingKindId(null);
    setDeletingLevelId(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, requestClose]);

  if (!isOpen) return null;

  const notifyValidationError = (message: string) => {
    dispatch({
      type: 'SET_NOTIFICATION',
      notification: {
        id: `design-definition-error-${Date.now()}`,
        type: 'error',
        message,
      },
    });
  };

  const handleAddKind = () => {
    const label = newKindName.trim();
    if (!label) return;
    if (nodeKinds.length >= TPDD_LIMITS.MAX_NODE_KINDS) {
      notifyValidationError(`内容の種別は最大${TPDD_LIMITS.MAX_NODE_KINDS}件までです。`);
      return;
    }
    if (label.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
      notifyValidationError(`種別名は${TPDD_LIMITS.LABEL_MAX_LENGTH}文字以内です。`);
      return;
    }
    if (newKindDescription.length > DEFINITION_DESCRIPTION_MAX_LENGTH) {
      notifyValidationError(`種別の説明は${DEFINITION_DESCRIPTION_MAX_LENGTH.toLocaleString()}文字以内です。`);
      return;
    }
    dispatch({
      type: 'ADD_NODE_KIND',
      label,
      description: newKindDescription,
      paletteKey: newKindPalette,
    });
    setNewKindName('');
    setNewKindDescription('');
  };

  const handleAddLevel = () => {
    const label = newLevelName.trim();
    if (!label) return;
    if (label.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
      notifyValidationError(`配置列名は${TPDD_LIMITS.LABEL_MAX_LENGTH}文字以内です。`);
      return;
    }
    if (newLevelDescription.length > DEFINITION_DESCRIPTION_MAX_LENGTH) {
      notifyValidationError(`配置列の説明は${DEFINITION_DESCRIPTION_MAX_LENGTH.toLocaleString()}文字以内です。`);
      return;
    }
    dispatch({
      type: 'ADD_LEVEL',
      label,
      description: newLevelDescription,
    });
    setNewLevelName('');
    setNewLevelDescription('');
  };

  const handleStartDeleteKind = (kindId: string) => {
    if (nodeKinds.length <= 1) return;
    const target = nodeKinds.find((kind) => kind.id !== kindId);
    setDeletingKindId(kindId);
    setTargetKindId(target?.id ?? '');
    setDeletingLevelId(null);
  };

  const handleStartDeleteLevel = (levelId: string) => {
    if (levels.length <= 1) return;
    const target = levels.find((level) => level.id !== levelId);
    setDeletingLevelId(levelId);
    setTargetLevelId(target?.id ?? '');
    setDeletingKindId(null);
  };

  const deletingKind = nodeKinds.find((kind) => kind.id === deletingKindId);
  const deletingLevel = levels.find((level) => level.id === deletingLevelId);

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="design-system-title"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 id="design-system-title" className="text-sm font-bold text-slate-800">設計体系</h2>
            <p className="text-xs text-slate-500">ノードの意味と、図上の配置段階を別々に定義します</p>
          </div>
          <button type="button" onClick={requestClose} className="text-slate-400 hover:text-slate-600 p-1 rounded" aria-label="閉じる">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 border-b border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setActiveTab('kinds')}
            className={`px-4 py-3 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 ${
              activeTab === 'kinds' ? 'border-blue-600 text-blue-700 bg-blue-50/40' : 'border-transparent text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Shapes className="w-4 h-4" /> 内容の種別
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('levels')}
            className={`px-4 py-3 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 ${
              activeTab === 'levels' ? 'border-blue-600 text-blue-700 bg-blue-50/40' : 'border-transparent text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Columns3 className="w-4 h-4" /> 配置列
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {activeTab === 'kinds' ? (
            <>
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-[11px] text-blue-900 leading-relaxed">
                <strong className="block text-xs mb-0.5">内容の種別（何を表すか）</strong>
                ノードの意味、表示色、AIによる分類に使用します。先頭の種別が手動で追加するノードの初期値です。
              </div>

              <div className="space-y-2">
                {nodeKinds.map((kind, index) => {
                  const palette = getNodePalette(kind.paletteKey);
                  return (
                    <div key={kind.id} className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-3.5 h-3.5 rounded-full border flex-shrink-0"
                          style={{ backgroundColor: palette.fill, borderColor: palette.stroke }}
                          aria-hidden="true"
                        />
                        <input
                          key={`${kind.id}-label-${kind.label}`}
                          type="text"
                          defaultValue={kind.label}
                          maxLength={TPDD_LIMITS.LABEL_MAX_LENGTH}
                          onBlur={(event) => {
                            const label = event.currentTarget.value.trim();
                            if (!label) {
                              event.currentTarget.value = kind.label;
                              notifyValidationError('種別名は空にできません。');
                            } else if (label !== kind.label) {
                              dispatch({ type: 'UPDATE_NODE_KIND', kindId: kind.id, patch: { label } });
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
                          }}
                          className="flex-1 px-2 py-1.5 text-xs font-medium border border-slate-300 rounded bg-white"
                          aria-label={`${index + 1}番目の種別名`}
                        />
                        <select
                          value={kind.paletteKey}
                          onChange={(event) => dispatch({
                            type: 'UPDATE_NODE_KIND',
                            kindId: kind.id,
                            patch: { paletteKey: event.target.value as NodePaletteKey },
                          })}
                          className="px-2 py-1.5 text-[11px] border border-slate-300 rounded bg-white"
                          aria-label={`${kind.label}の表示色`}
                        >
                          {NODE_PALETTE_KEYS.map((paletteKey) => (
                            <option key={paletteKey} value={paletteKey}>{NODE_PALETTES[paletteKey].label}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => dispatch({ type: 'REORDER_NODE_KINDS', nodeKinds: moveItem(nodeKinds, index, index - 1) })}
                            className="p-1 text-slate-500 hover:text-slate-800 disabled:text-slate-300"
                            title="上へ移動"
                          ><ArrowUp className="w-3.5 h-3.5" /></button>
                          <button
                            type="button"
                            disabled={index === nodeKinds.length - 1}
                            onClick={() => dispatch({ type: 'REORDER_NODE_KINDS', nodeKinds: moveItem(nodeKinds, index, index + 1) })}
                            className="p-1 text-slate-500 hover:text-slate-800 disabled:text-slate-300"
                            title="下へ移動"
                          ><ArrowDown className="w-3.5 h-3.5" /></button>
                        </div>
                        <button
                          type="button"
                          disabled={nodeKinds.length <= 1}
                          onClick={() => handleStartDeleteKind(kind.id)}
                          className="p-1 text-slate-400 hover:text-red-600 disabled:text-slate-200"
                          title="種別を削除"
                        ><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                      <textarea
                        key={`${kind.id}-description-${kind.description}`}
                        defaultValue={kind.description}
                        maxLength={DEFINITION_DESCRIPTION_MAX_LENGTH}
                        rows={2}
                        onBlur={(event) => {
                          if (event.currentTarget.value !== kind.description) {
                            dispatch({ type: 'UPDATE_NODE_KIND', kindId: kind.id, patch: { description: event.currentTarget.value } });
                          }
                        }}
                        placeholder="この種別に分類する内容を、AIにも分かるように説明"
                        className="w-full px-2 py-1.5 text-[11px] leading-relaxed border border-slate-300 rounded bg-white resize-y"
                        aria-label={`${kind.label}の説明`}
                      />
                    </div>
                  );
                })}
              </div>

              {deletingKindId && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg space-y-2.5">
                  <div className="flex items-center gap-1.5 text-red-700 text-xs font-bold">
                    <AlertTriangle className="w-4 h-4" />
                    <span>種別「{deletingKind?.label}」の削除確認</span>
                  </div>
                  <p className="text-[11px] text-red-600">この種別を使用している全図のノードを、次の種別へ変更します。</p>
                  <select value={targetKindId} onChange={(event) => setTargetKindId(event.target.value)} className="w-full p-1.5 text-xs border border-red-300 rounded bg-white">
                    {nodeKinds.filter((kind) => kind.id !== deletingKindId).map((kind) => (
                      <option key={kind.id} value={kind.id}>{kind.label}</option>
                    ))}
                  </select>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setDeletingKindId(null)} className="px-2.5 py-1 border border-slate-300 rounded text-[11px] bg-white">キャンセル</button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!deletingKindId || !targetKindId) return;
                        dispatch({ type: 'REMOVE_NODE_KIND', kindIdToRemove: deletingKindId, targetKindId });
                        setDeletingKindId(null);
                      }}
                      className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-medium"
                    >ノードを変更して削除</button>
                  </div>
                </div>
              )}

              <div className="p-3 border border-dashed border-slate-300 rounded-lg space-y-2">
                <strong className="text-xs text-slate-700">新しい種別</strong>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newKindName}
                    maxLength={TPDD_LIMITS.LABEL_MAX_LENGTH}
                    onChange={(event) => setNewKindName(event.target.value)}
                    placeholder="種別名"
                    className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                  />
                  <select
                    value={newKindPalette}
                    onChange={(event) => setNewKindPalette(event.target.value as NodePaletteKey)}
                    className="px-2 py-1.5 text-xs border border-slate-300 rounded bg-white"
                    aria-label="新しい種別の表示色"
                  >
                    {NODE_PALETTE_KEYS.map((paletteKey) => (
                      <option key={paletteKey} value={paletteKey}>{NODE_PALETTES[paletteKey].label}</option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={newKindDescription}
                  maxLength={DEFINITION_DESCRIPTION_MAX_LENGTH}
                  onChange={(event) => setNewKindDescription(event.target.value)}
                  rows={2}
                  placeholder="意味・判断基準（AIにも送信されます）"
                  className="w-full px-2.5 py-1.5 text-[11px] border border-slate-300 rounded resize-y"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleAddKind}
                    disabled={!newKindName.trim() || nodeKinds.length >= TPDD_LIMITS.MAX_NODE_KINDS}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-xs font-medium flex items-center gap-1"
                    title={nodeKinds.length >= TPDD_LIMITS.MAX_NODE_KINDS ? `最大${TPDD_LIMITS.MAX_NODE_KINDS}件です` : undefined}
                  >
                    <Plus className="w-3.5 h-3.5" /> 種別を追加
                  </button>
                </div>
                {nodeKinds.length >= TPDD_LIMITS.MAX_NODE_KINDS && (
                  <p className="text-[11px] text-amber-700 text-right">
                    内容の種別は最大{TPDD_LIMITS.MAX_NODE_KINDS}件です。
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-[11px] text-blue-900 leading-relaxed">
                <strong className="block text-xs mb-0.5">配置列（図上の位置・設計段階）</strong>
                ノードを図のどこに置くか、自動整列の左から右の順序、AI提案の配置先に使用します。
              </div>

              <div className="space-y-2">
                {levels.map((level, index) => (
                  <div key={level.id} className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-slate-400 w-5 text-center">{index + 1}</span>
                      <input
                        key={`${level.id}-label-${level.label}`}
                        type="text"
                        defaultValue={level.label}
                        maxLength={TPDD_LIMITS.LABEL_MAX_LENGTH}
                        onBlur={(event) => {
                          const label = event.currentTarget.value.trim();
                          if (!label) {
                            event.currentTarget.value = level.label;
                            notifyValidationError('配置列名は空にできません。');
                          } else if (label !== level.label) {
                            dispatch({ type: 'UPDATE_LEVEL', levelId: level.id, patch: { label } });
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
                        }}
                        className="flex-1 px-2 py-1.5 text-xs font-medium border border-slate-300 rounded bg-white"
                        aria-label={`${index + 1}番目の配置列名`}
                      />
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => dispatch({ type: 'REORDER_LEVELS', levels: moveItem(levels, index, index - 1) })}
                          className="p-1 text-slate-500 hover:text-slate-800 disabled:text-slate-300"
                          title="左へ移動"
                        ><ArrowUp className="w-3.5 h-3.5 -rotate-90" /></button>
                        <button
                          type="button"
                          disabled={index === levels.length - 1}
                          onClick={() => dispatch({ type: 'REORDER_LEVELS', levels: moveItem(levels, index, index + 1) })}
                          className="p-1 text-slate-500 hover:text-slate-800 disabled:text-slate-300"
                          title="右へ移動"
                        ><ArrowDown className="w-3.5 h-3.5 -rotate-90" /></button>
                      </div>
                      <button
                        type="button"
                        disabled={levels.length <= 1}
                        onClick={() => handleStartDeleteLevel(level.id)}
                        className="p-1 text-slate-400 hover:text-red-600 disabled:text-slate-200"
                        title="配置列を削除"
                      ><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                    <textarea
                      key={`${level.id}-description-${level.description}`}
                      defaultValue={level.description}
                      maxLength={DEFINITION_DESCRIPTION_MAX_LENGTH}
                      rows={2}
                      onBlur={(event) => {
                        if (event.currentTarget.value !== level.description) {
                          dispatch({ type: 'UPDATE_LEVEL', levelId: level.id, patch: { description: event.currentTarget.value } });
                        }
                      }}
                      placeholder="この列に配置する内容を、AIにも分かるように説明"
                      className="w-full px-2 py-1.5 text-[11px] leading-relaxed border border-slate-300 rounded bg-white resize-y"
                      aria-label={`${level.label}の説明`}
                    />
                  </div>
                ))}
              </div>

              {deletingLevelId && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg space-y-2.5">
                  <div className="flex items-center gap-1.5 text-red-700 text-xs font-bold">
                    <AlertTriangle className="w-4 h-4" />
                    <span>配置列「{deletingLevel?.label}」の削除確認</span>
                  </div>
                  <p className="text-[11px] text-red-600">この列に配置されている全図のノードを、次の列へ移動します。</p>
                  <select value={targetLevelId} onChange={(event) => setTargetLevelId(event.target.value)} className="w-full p-1.5 text-xs border border-red-300 rounded bg-white">
                    {levels.filter((level) => level.id !== deletingLevelId).map((level) => (
                      <option key={level.id} value={level.id}>{level.label}</option>
                    ))}
                  </select>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setDeletingLevelId(null)} className="px-2.5 py-1 border border-slate-300 rounded text-[11px] bg-white">キャンセル</button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!deletingLevelId || !targetLevelId) return;
                        dispatch({ type: 'REMOVE_LEVEL', levelIdToRemove: deletingLevelId, targetLevelId });
                        setDeletingLevelId(null);
                      }}
                      className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-medium"
                    >ノードを移動して削除</button>
                  </div>
                </div>
              )}

              {levels.length < TPDD_LIMITS.MAX_LEVELS && (
                <div className="p-3 border border-dashed border-slate-300 rounded-lg space-y-2">
                  <strong className="text-xs text-slate-700">新しい配置列</strong>
                  <input
                    type="text"
                    value={newLevelName}
                    maxLength={TPDD_LIMITS.LABEL_MAX_LENGTH}
                    onChange={(event) => setNewLevelName(event.target.value)}
                    placeholder="配置列名"
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                  />
                  <textarea
                    value={newLevelDescription}
                    maxLength={DEFINITION_DESCRIPTION_MAX_LENGTH}
                    onChange={(event) => setNewLevelDescription(event.target.value)}
                    rows={2}
                    placeholder="この列に配置する内容（AIにも送信されます）"
                    className="w-full px-2.5 py-1.5 text-[11px] border border-slate-300 rounded resize-y"
                  />
                  <div className="flex justify-end">
                    <button type="button" onClick={handleAddLevel} disabled={!newLevelName.trim()} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-xs font-medium flex items-center gap-1">
                      <Plus className="w-3.5 h-3.5" /> 配置列を追加
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <span className="text-[11px] text-slate-500">変更は即時反映され、元に戻す操作の対象になります。</span>
          <button type="button" onClick={requestClose} className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 rounded text-xs text-slate-700 font-medium">閉じる</button>
        </div>
      </div>
    </div>,
    document.body
  );
};
