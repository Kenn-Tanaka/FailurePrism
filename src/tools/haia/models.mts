export interface HaiaModel {
  name: string;
  id: string;
  alias: string[];
  enabled: boolean;
}

export interface HaiaModels {
  defaultAlias: string;
  models: HaiaModel[];
}

export const normalizeAlias = (alias: string) => alias.trim().toLowerCase();

export function parseHaiaModels(value: unknown): HaiaModels {
  if (!value || typeof value !== 'object') throw new Error('モデル設定が JSON オブジェクトではありません。');
  const config = value as Partial<HaiaModels>;
  if (!Array.isArray(config.models) || typeof config.defaultAlias !== 'string') {
    throw new Error('モデル設定に models と defaultAlias が必要です。');
  }

  const aliases = new Map<string, HaiaModel>();
  const models = config.models.map((model, index): HaiaModel => {
    if (!model || typeof model.name !== 'string' || !model.name.trim() ||
        typeof model.id !== 'string' || !/^[^/\s]+\/\S+$/.test(model.id.trim()) ||
        !Array.isArray(model.alias) || !model.alias.length ||
        (model.enabled !== undefined && typeof model.enabled !== 'boolean')) {
      throw new Error(`モデル ${index + 1} に表示名、Gateway モデル ID と Alias を入力してください。`);
    }
    const result: HaiaModel = {
      name: model.name.trim(), id: model.id.trim(), enabled: model.enabled !== false, alias: [],
    };
    for (const entry of model.alias) {
      const alias = typeof entry === 'string' ? normalizeAlias(entry) : '';
      if (!alias || /[\s/,;]/u.test(alias)) throw new Error(`無効な Alias（${result.name}）`);
      if (aliases.has(alias)) throw new Error(`Alias が重複しています（${alias}）`);
      aliases.set(alias, result);
      result.alias.push(alias);
    }
    return result;
  });

  const defaultAlias = normalizeAlias(config.defaultAlias);
  if (!aliases.get(defaultAlias)?.enabled) {
    throw new Error('既定 Alias に有効なモデルを指定してください。');
  }
  return { defaultAlias, models };
}

export function createModelResolver(config: HaiaModels) {
  const table = new Map(config.models.flatMap(model =>
    model.alias.map(alias => [alias, model] as const),
  ));
  const defaultModel = table.get(config.defaultAlias);
  return (requested: string | undefined) => {
    const requestedAlias = normalizeAlias(requested ?? '') || config.defaultAlias;
    const model = table.get(requestedAlias);
    if (model && !model.enabled) throw new Error(`Alias「${requestedAlias}」は無効です。`);
    if (model) return { requestedAlias, alias: requestedAlias, model };
    if (!defaultModel?.enabled) throw new Error('既定 LLM が設定されていません。');
    return { requestedAlias, alias: config.defaultAlias, model: defaultModel };
  };
}
