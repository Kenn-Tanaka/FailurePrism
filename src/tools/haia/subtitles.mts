export interface SubtitleTrack {
  id: string;
  language: string;
  languageCode: string;
  generated: boolean;
}

export interface SubtitleList {
  videoId: string;
  title: string;
  author: string;
  authorUrl: string;
  tracks: SubtitleTrack[];
}

export function selectSubtitle(
  tracks: SubtitleTrack[],
  languageList = '',
  preference = 'generated',
): SubtitleTrack {
  if (!tracks.length) throw new Error('この動画には取得可能な字幕がありません。');
  const codes = languageList.toLowerCase().split(/[,;\s]+/).filter(Boolean);
  const prefer = preference.trim().toLowerCase();
  const groups = codes.length ?
    codes.map(code => tracks.filter(track => track.languageCode.toLowerCase() === code)) : [tracks];

  for (const group of groups) {
    if (!group.length) continue;
    if (prefer === 'first' || prefer === 'any') return group[0];
    const manual = group.find(track => !track.generated);
    if (prefer === 'manual_only') {
      if (manual) return manual;
      continue;
    }
    if (['manual', 'manually_created'].includes(prefer)) return manual ?? group[0];
    return group.find(track => track.generated) ?? group[0];
  }
  const available = tracks.map(track => `${track.languageCode} (${track.generated ? '自動' : '手動'})`);
  throw new Error(`条件に合う字幕がありません。取得可能な字幕: ${[...new Set(available)].join('、')}`);
}
