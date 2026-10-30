import { LEDGER_HEADERS } from './eventLedger';
/** Small evidence-backed example shared by transport and persistence regression tests. */
export const ledgerSource = '09:00 担当者が装置を起動した。\n10:00 装置が停止した。\n参考文献';
export function ledgerFixture() {
  return '[主体]\n' + LEDGER_HEADERS.主体.join('\t') + '\nA1\t担当者\tperson\nA2\t装置\tmachine\n[イベント]\n'
    + LEDGER_HEADERS.イベント.join('\t') + '\nE1\t09:00\t起動\t担当者が装置を起動した\tA1:actor,A2:target\tp1\trecorded\nE2\t10:00\t停止\t装置が停止した\tA2:actor\tp2\trecorded\n[関係]\n'
    + LEDGER_HEADERS.関係.join('\t') + '\n[共有カード]\n' + LEDGER_HEADERS.共有カード.join('\t') + '\n[整理]\n'
    + LEDGER_HEADERS.整理.join('\t') + '\nD1\texcluded\tp3\t文献見出し\t出来事ではない\n[完了]';
}
