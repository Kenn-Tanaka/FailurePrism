import type {
  CognitiveBehaviorLevel,
  VariationCategory,
  VariationFactorDetail,
  VariationPolarity,
} from '../../../types/vta';

const EXPLICIT_RESILIENT_RE =
  /レジリエンス|リカバリー|好転|食い止めた|危機回避|防護|正常復帰|被害抑止|回避介入|機能縮退|縮退(?:運転)?|フェイルセーフ|フェイルソフト|フォールバック|Graceful\s*degradation|安全保護|インターロック作動|自律的(?:な)?安全停止|全員脱出|脱出完了|脱出成功/i;

const PROTECTIVE_RESILIENT_RE =
  /緊急脱出|脱出(?:を)?開始|避難誘導|乗客(?:を)?(?:救助|避難)|全員救出|生還|生存|安全確認の上|(?:機外|周囲|外部)?安全(?:を)?確認.*(?:開放|脱出)|被害(?:の)?拡大(?:を)?(?:防止|抑止)|二次災害(?:を)?(?:防止|抑止)|延焼(?:を)?(?:防止|抑止)/i;

const NEGATED_FAILURE_RE =
  /脱出でき(?:ず|なかった)|脱出に?失敗|救出でき(?:ず|なかった)|開放でき(?:ず|なかった)|(?:脱出|避難|誘導|救助).{0,8}(?:遅延|遅れ|困難|不可|失敗)|(?:安全確認|救助|防護).{0,12}(?:怠|省略|不十分|未実施)/i;

/**
 * Checks whether classification reason or event text describes positive resilience
 * (recovery, fail-safe, rescue, or safe evacuation) without failure-negation phrasing.
 */
export function isResilientReasonText(text: string): boolean {
  if (!text) return false;
  if (EXPLICIT_RESILIENT_RE.test(text)) return true;
  return PROTECTIVE_RESILIENT_RE.test(text) && !NEGATED_FAILURE_RE.test(text);
}

/**
 * 変動要因の理由テキストから分類カテゴリ・極性・行動レベルを自動抽出（自己治癒）する。
 * SRKモデル（Rasmussen）および失敗学三大要因（過信・無視・無知）に対応。
 */
export function extractVariationFactorFromReason(reason: string): VariationFactorDetail {
  const isResilient = isResilientReasonText(reason);
  const polarity: VariationPolarity = isResilient ? 'resilient' : 'negative';

  let category: VariationCategory = 'departure';
  if (isResilient) {
    category = 'response';
  } else if (/内部要因|装置(?:の)?(?:異常|故障)|部品(?:の)?(?:異常|故障)|ソフトウェア(?:の)?異常|ソフト異常|発作|急病|負傷/i.test(reason)) {
    category = 'internal';
  } else if (/外部要因|天候|突風|暴風|濃霧|落雷|外乱|外部インフラ|停電/i.test(reason)) {
    category = 'external';
  } else if (/先行|状態変化|応答/i.test(reason)) {
    category = 'response';
  } else if (/逸脱|人為|通常作業から|過信|無視|無知|スリップ|省略|軽視|近道|失念/i.test(reason)) {
    category = 'departure';
  }

  let cognitiveLevel: CognitiveBehaviorLevel | undefined = undefined;
  if (/過信|慢心|慣れ|熟練|Skill|スキル|スリップ/i.test(reason)) {
    cognitiveLevel = 'skill';
  } else if (/無視|軽視|省略|バイパス|Rule|ルール|規程|手順|近道/i.test(reason)) {
    cognitiveLevel = 'rule';
  } else if (/無知|未習得|知識不足|理解不足|Knowledge|ナレッジ|未知/i.test(reason)) {
    cognitiveLevel = 'knowledge';
  }

  return {
    category,
    polarity,
    cognitiveLevel,
    description: reason,
  };
}
