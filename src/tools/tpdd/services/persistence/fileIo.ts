import { Project } from '../../domain/schema';
import { validateProject } from '../../domain/validation';

/**
 * Windowsファイル名の禁止文字および予約語をサニタイズ
 */
export function sanitizeFilename(name: string, fallback = 'tpdd-project'): string {
  if (!name || name.trim().length === 0) {
    return fallback;
  }
  // Windows禁止文字 \ / : * ? " < > | および 制御文字 (0x00 - 0x1f)
  let clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();

  // 予約語 (CON, PRN, AUX, NUL, COM1-9, LPT1-9) チェック
  const reservedRegex = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reservedRegex.test(clean)) {
    clean = `${clean}_file`;
  }

  // 末尾のピリオドや空白を削除
  clean = clean.replace(/[. ]+$/, '');

  return clean.length > 0 ? clean : fallback;
}

export interface SaveProjectResult {
  success: boolean;
  errorMessage?: string;
  validationErrors?: { path: string; message: string }[];
}

/**
 * ProjectをJSONファイル (.tpdd.json) としてダウンロード保存
 */
export function saveProjectToFile(
  project: Project,
  options?: { allowInvalidRescue?: boolean }
): SaveProjectResult {
  // 保存前に整合性チェック
  const validation = validateProject(project);
  if (!validation.valid && !options?.allowInvalidRescue) {
    console.warn('保存対象のプロジェクトに整合性エラーがあります:', validation.errors);
    return {
      success: false,
      errorMessage: validation.errors.map((e) => e.message).join(' / '),
      validationErrors: validation.errors,
    };
  }

  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const jsonString = JSON.stringify(project, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const filename = `${sanitizeFilename(project.title)}.tpdd.json`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    success: true,
    validationErrors: validation.valid ? undefined : validation.errors,
  };
}

export interface LoadProjectResult {
  success: boolean;
  project?: Project;
  errorMessage?: string;
  validationErrors?: { path: string; message: string }[];
}

/**
 * ファイルからJSON文字列を読み込んでProjectとして検証・パース
 */
export async function parseAndValidateProjectJson(
  file: File,
  options?: { allowInvalidRescue?: boolean }
): Promise<LoadProjectResult> {
  // サイズ上限チェック (10MiB)
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    return {
      success: false,
      errorMessage: `ファイルサイズ (${(file.size / 1024 / 1024).toFixed(1)}MB) が上限10MBを超えています`,
    };
  }

  try {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        success: false,
        errorMessage: 'JSON形式が正しくありません',
      };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return {
        success: false,
        errorMessage: '対応するデータ形式ではありません（オブジェクトではありません）',
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = parsed as any;
    const isSupportedFormat = obj.format === 'tpdd-project' || obj.format === 'thought-expansion-project';
    if (!isSupportedFormat || obj.schemaVersion !== 1) {
      return {
        success: false,
        errorMessage: '対応するデータ形式ではありません（formatまたはschemaVersionが一致しません）',
      };
    }

    const validation = validateProject(obj as Project);
    if (!validation.valid) {
      const canRescueStructure =
        Array.isArray(obj.diagrams) &&
        obj.diagrams.length > 0 &&
        Array.isArray(obj.levels) &&
        obj.levels.length > 0;
      if (options?.allowInvalidRescue && canRescueStructure) {
        return {
          success: true,
          project: obj as Project,
          errorMessage: 'データのスキーマまたは整合性検証に警告がありますが救出モードで読み込みました',
          validationErrors: validation.errors,
        };
      }
      return {
        success: false,
        project: canRescueStructure ? (obj as Project) : undefined,
        errorMessage: 'データのスキーマまたは整合性検証に失敗しました',
        validationErrors: validation.errors,
      };
    }

    return {
      success: true,
      project: obj as Project,
    };
  } catch (err) {
    return {
      success: false,
      errorMessage: `ファイル読み込み中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
