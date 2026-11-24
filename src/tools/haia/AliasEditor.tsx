import { useEffect, useRef, useState } from 'react';
import { saveModels, type Installation } from './api';
import { parseHaiaModels } from './models.mjs';
import { button, field } from './styles';

interface Row {
  key: number;
  name: string;
  id: string;
  aliases: string;
  enabled: boolean;
}

export function AliasEditor({ installation, onSaved, onDirty }: {
  installation: Installation;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => installation.models?.models.map((model, key) => ({
    key, name: model.name, id: model.id, aliases: model.alias.join(', '), enabled: model.enabled,
  })) ?? []);
  const [defaultAlias, setDefaultAlias] = useState(installation.models?.defaultAlias ?? '');
  const [revision, setRevision] = useState(installation.revision);
  const [overwritingInvalid, setOverwritingInvalid] = useState(installation.models === null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nextKey = useRef(rows.length);
  const saved = useRef({ rows, defaultAlias });

  useEffect(() => { onDirty(dirty || saving); }, [dirty, saving, onDirty]);

  function update(key: number, patch: Partial<Row>) {
    setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row));
    setDirty(true);
  }

  async function save() {
    if (overwritingInvalid && !window.confirm('現在の models.json は読み込みエラー状態です。入力した内容で既存の models.json を上書きしますか？')) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const models = parseHaiaModels({
        defaultAlias,
        models: rows.map(row => ({
          name: row.name, id: row.id, alias: row.aliases.split(/[,;\s]+/).filter(Boolean), enabled: row.enabled,
        })),
      });
      const result = await saveModels(models, revision);
      setRevision(result.revision);
      setOverwritingInvalid(false);
      saved.current = { rows, defaultAlias };
      setDirty(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3">
      {overwritingInvalid && (
        <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          現在の models.json を読み込めないため空の表で表示しています。このまま保存すると元のファイル全体が上書きされます。
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium">既定 Alias
          <input className={field} value={defaultAlias} disabled={saving} onChange={e => { setDefaultAlias(e.target.value); setDirty(true); }} />
        </label>
        <button type="button" className={button} disabled={saving} onClick={() => {
          const key = nextKey.current++;
          setRows(current => [{ key, name: '', id: '', aliases: '', enabled: true }, ...current]);
          setDirty(true);
        }}>モデルを追加</button>
        <button type="button" className={button + ' border-indigo-500 text-indigo-800'} onClick={() => void save()}
          disabled={saving || !dirty}>対応表を保存</button>
        <button type="button" className={button} disabled={saving || !dirty} onClick={() => {
          setRows(saved.current.rows);
          setDefaultAlias(saved.current.defaultAlias);
          setDirty(false);
          setError('');
        }}>変更を取り消す</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      <div className="overflow-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="border-y border-slate-200 bg-slate-50">
            <tr>
              <th className="px-2 py-2">表示名</th>
              <th className="px-2 py-2">Gateway モデル ID</th>
              <th className="px-2 py-2">Alias（カンマ区切り）</th>
              <th className="px-2 py-2">有効</th>
              <th className="px-2 py-2"><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key} className="border-b border-slate-100">
                <td className="p-1"><input aria-label={'表示名 ' + (index + 1)} className={field + ' w-full min-w-48'} disabled={saving} value={row.name} onChange={e => update(row.key, { name: e.target.value })} /></td>
                <td className="p-1"><input aria-label={'モデル ID ' + (index + 1)} className={field + ' w-full min-w-48 font-mono'} disabled={saving} value={row.id} onChange={e => update(row.key, { id: e.target.value })} /></td>
                <td className="p-1"><input aria-label={'Alias ' + (index + 1)} className={field + ' w-full min-w-32 font-mono'} disabled={saving} value={row.aliases} onChange={e => update(row.key, { aliases: e.target.value })} /></td>
                <td className="px-3"><input type="checkbox" aria-label={'有効 ' + (index + 1)} disabled={saving} checked={row.enabled} onChange={e => update(row.key, { enabled: e.target.checked })} /></td>
                <td className="p-1"><button type="button" className={button + ' whitespace-nowrap'} disabled={saving} onClick={() => {
                  setRows(current => current.filter(candidate => candidate.key !== row.key));
                  setDirty(true);
                }}>削除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
