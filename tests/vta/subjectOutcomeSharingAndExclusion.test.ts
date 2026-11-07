import { describe, expect, it } from 'vitest';
import {
  consolidateSubjects,
  evaluateMergeGuard,
  isInfluentialSubject,
  rankSubjects,
} from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { inspectLedger, parseLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
import { projectAnalysis, sourceFromText } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { repairGeneratedLaneSequence } from '../../src/tools/vta/features/vta/utils/generatedLaneSequence';
import type { VTAAnalysisData, VTASchema } from '../../src/tools/vta/types/vta';

const buildAnalysisFromLedger = (ledgerText: string, sourceText: string): VTAAnalysisData => {
  const src = sourceFromText(sourceText);
  const res = inspectLedger(parseLedger(ledgerText), src);
  if (!res.analysis) {
    throw new Error(`Ledger parse failed: ${res.issues.map((i) => i.message).join(' / ')}`);
  }
  return res.analysis;
};

describe('ADR-0008: 主体の帰結共有度に基づく統合・独立制御および非影響主体のレーン除外', () => {
  describe('1. 航空機事故ドメインの検証', () => {
    it('風防ガラス脱落ケース: 被災（機長）と単独緊急着陸（副操縦士）で帰結・役割が非対称なため独立レーンを死守する', () => {
      const sourceText = [
        'p1 巡航中、左風防ガラスが脱落し、急激な減圧で機長の上半身が機外へ吸出され操縦不能・負傷した。',
        'p2 客室乗務員Aが操縦室へ駆け込み、機長の脚を保持して機内へ引き戻そうとした。',
        'p3 副操縦士が単独で緊急降下を開始し、最寄りの代替空港へ緊急着陸を宣言・成功させた。',
      ].join('\n');

      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CREW\tコックピットクルー\torganization\thigh\t-\tp1,p3',
        'A_CAPT\t機長\tperson\thigh\tA_CREW\tp1',
        'A_FO\t副操縦士\tperson\thigh\tA_CREW\tp3',
        'A_CA\t客室乗務員A\tperson\tmid\t-\tp2',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t07:30\t風防脱落・機長吸出\t風防が脱落し機長が機外へ吸出され操縦不能となった\tA_CAPT:actor\tp1\trecorded',
        'E2\t07:31\t機長保持\t客室乗務員Aが機長の脚を保持した\tA_CA:actor,A_CAPT:target\tp2\trecorded',
        'E3\t07:32\t単独操縦・緊急着陸\t副操縦士が単独操縦で緊急降下し緊急着陸を成功させた\tA_FO:actor\tp3\trecorded',
        '[帰結]',
        'O1\tidentified\tE1,E3\tp1,p3\t機長被災（第1帰結）と単独緊急着陸（第2帰結）',
        '[関係]',
        'R1\timpact\tE1\tA_CAPT\tE2\tA_CA\tp1,p2\t-\toccurred\tna',
        'R2\ttransfer\tE2\tA_CA\tE1\tA_CAPT\tp2\tperson\toccurred\tconfirmed',
        'R3\tdependency\tE1\tA_CAPT\tE3\tA_FO\tp1,p3\t-\t-\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildAnalysisFromLedger(ledger, sourceText);

      // E1 を variation（被災）、E3 を recovery（レジリエンス回復）として設定
      const ev1 = analysis.events.find((e) => e.id === 'E1')!;
      ev1.classification = 'variation';
      ev1.outcome_kind = 'loss';
      const ev3 = analysis.events.find((e) => e.id === 'E3')!;
      ev3.classification = 'normal';
      ev3.outcome_kind = 'recovery';

      // Merge Guard の評価: 機長と副操縦士の間で統合がブロックされること
      const guardResult = evaluateMergeGuard('A_CAPT', 'A_FO', analysis);
      expect(guardResult.allowed).toBe(false);
      expect(guardResult.reason).toContain('独立維持');

      // 機長と上位クルー（A_CREW）への統合を試みても、副操縦士との非対称性・依存介入により独立維持
      const ranking = rankSubjects(analysis, 3);
      const captRank = ranking.ranks.find((r) => r.entityId === 'A_CAPT')!;
      const foRank = ranking.ranks.find((r) => r.entityId === 'A_FO')!;

      // 機長と副操縦士の双方が「コックピットクルー」に統合されずに独立レーンとして死守される
      expect(captRank.retained).toBe(true);
      expect(foRank.retained).toBe(true);

      const consolidated = consolidateSubjects(analysis, 3);
      const entityNames = consolidated.entities.map((e) => e.name);
      expect(entityNames).toContain('機長');
      expect(entityNames).toContain('副操縦士');
    });

    it('共通墜落・滑走路衝突ケース: 機長と副操縦士が同一の帰結（衝突損失）を共有している場合は上位組織へ安全に統合される', () => {
      const sourceText = [
        'p1 機長と副操縦士はアプローチチェックリストを実施した。',
        'p2 機長が操縦を担当し、副操縦士が計器監視を行った。',
        'p3 滑走路手前で障害物と衝突し機体が損壊した。',
      ].join('\n');

      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CREW\tコックピットクルー\torganization\thigh\t-\tp1',
        'A_CAPT\t機長\tperson\tlow\tA_CREW\tp1,p2',
        'A_FO\t副操縦士\tperson\tlow\tA_CREW\tp1,p2',
        'A_ATC\t航空管制官\tperson\thigh\t-\tp1',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:40\t点検実施\tコックピットクルーが点検した\tA_CREW:actor\tp1\trecorded',
        'E2\t17:42\t進入操作\t機長が操縦し副操縦士が監視した\tA_CAPT:actor,A_FO:actor\tp2\trecorded',
        'E3\t17:45\t衝突損壊\t滑走路で衝突損壊した\tA_CREW:affected\tp3\trecorded',
        '[帰結]',
        'O1\tidentified\tE3\tp3\t共通の衝突損壊',
        '[関係]',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildAnalysisFromLedger(ledger, sourceText);
      const ev3 = analysis.events.find((e) => e.id === 'E3')!;
      ev3.classification = 'outcome';
      ev3.outcome_kind = 'loss';

      // 共通帰結のため統合可能
      const guardResult = evaluateMergeGuard('A_CAPT', 'A_FO', analysis);
      expect(guardResult.allowed).toBe(true);

      // 上限2レーンに絞り込んだ場合、機長と副操縦士が「コックピットクルー」に統合される
      const consolidated = consolidateSubjects(analysis, 2);
      const entityNames = consolidated.entities.map((e) => e.name);
      expect(entityNames).toContain('コックピットクルー');
      expect(entityNames).not.toContain('機長');
      expect(entityNames).not.toContain('副操縦士');
    });
  });

  describe('2. 品質トラブル・製造ドメインの検証', () => {
    it('製造作業員（異常混入）と品証検査員（水際検知・緊急停止）で独立レーンを死守する', () => {
      const sourceText = [
        'p1 製造ライン作業員が原料バルブを誤操作し異物がタンクへ混入した。',
        'p2 品質保証検査員がサンプリング検査で濁り異常を検知した。',
        'p3 品質保証検査員が製造ラインへ緊急停止を発令し、市場流出を水際で防止した。',
      ].join('\n');

      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_PLANT\t製造本部\torganization\thigh\t-\tp1',
        'A_WORKER\t製造ライン作業員\tperson\thigh\tA_PLANT\tp1',
        'A_QA\t品質保証検査員\tperson\thigh\tA_PLANT\tp2,p3',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E0\t09:00\t製造計画策定\t製造本部が製造計画を策定した\tA_PLANT:actor\tp1\trecorded',
        'E1\t10:00\t異物混入\t作業員が原料バルブを誤操作し異物混入した\tA_WORKER:actor\tp1\trecorded',
        'E2\t10:30\t濁り検知\t品証がサンプリング検査で濁りを検知した\tA_QA:actor\tp2\trecorded',
        'E3\t10:35\t緊急停止・流出阻止\t品証が製造ラインへ緊急停止を発令し流出を防止した\tA_QA:actor,A_WORKER:target\tp3\trecorded',
        '[帰結]',
        'O1\tidentified\tE1,E3\tp1,p3\tタンク内廃棄（第1帰結）と市場流出防止（第2帰結）',
        '[関係]',
        'R1\tdependency\tE1\tA_WORKER\tE2\tA_QA\tp1,p2\t-\t-\tna',
        'R2\timpact\tE3\tA_QA\tE1\tA_WORKER\tp3,p1\t-\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildAnalysisFromLedger(ledger, sourceText);
      const ev1 = analysis.events.find((e) => e.id === 'E1')!;
      ev1.classification = 'variation';
      ev1.outcome_kind = 'loss';
      const ev3 = analysis.events.find((e) => e.id === 'E3')!;
      ev3.classification = 'normal';
      ev3.outcome_kind = 'recovery';

      // 製造本部傘下であっても、異常発生 vs 水際阻止の非対称性・介入により統合ブロック
      const guardResult = evaluateMergeGuard('A_WORKER', 'A_QA', analysis);
      expect(guardResult.allowed).toBe(false);

      const consolidated = consolidateSubjects(analysis, 2);
      const entityNames = consolidated.entities.map((e) => e.name);
      expect(entityNames).toContain('製造ライン作業員');
      expect(entityNames).toContain('品質保証検査員');
    });
  });

  describe('3. サイバー攻撃・セキュリティドメインの検証', () => {
    it('IT運用保守（パッチ未適用で侵害）とSOC/CSIRT（検知・ネットワーク遮断）で独立レーンを死守する', () => {
      const sourceText = [
        'p1 IT運用チームがVPN機器の既知脆弱性パッチを未適用のまま運用していた。',
        'p2 攻撃者がVPNから侵入し、ADサーバーを暗号化した。',
        'p3 SOC監視チームが深夜に不審な横展開通信を検知し、全拠点ルーターを物理切断してクラウドへの感染拡大を阻止した。',
      ].join('\n');

      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_IT_DEPT\t情報システム部\torganization\thigh\t-\tp1',
        'A_OPS\tIT運用チーム\torganization\thigh\tA_IT_DEPT\tp1',
        'A_SOC\tSOC監視チーム\torganization\thigh\tA_IT_DEPT\tp3',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E0\t00:00\t基盤運用方針\t情シス部が運用方針を定めた\tA_IT_DEPT:actor\tp1\trecorded',
        'E1\t01:00\tパッチ未適用\tIT運用がパッチ未適用のまま運用していた\tA_OPS:actor\tp1\trecorded',
        'E2\t02:00\tサーバー暗号化\t攻撃者がADサーバーを暗号化した\tA_OPS:affected\tp2\trecorded',
        'E3\t03:00\t通信検知・物理切断\tSOCが通信を検知し物理切断して拡大を阻止した\tA_SOC:actor,A_OPS:target\tp3\trecorded',
        '[帰結]',
        'O1\tidentified\tE2,E3\tp2,p3\tオンプレ暗号化（損失）とクラウド保全（回復）',
        '[関係]',
        'R1\tdependency\tE1\tA_OPS\tE3\tA_SOC\tp1,p3\t-\t-\tna',
        'R2\timpact\tE3\tA_SOC\tE2\tA_OPS\tp3,p2\t-\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildAnalysisFromLedger(ledger, sourceText);
      const ev1 = analysis.events.find((e) => e.id === 'E1')!;
      ev1.classification = 'variation';
      const ev2 = analysis.events.find((e) => e.id === 'E2')!;
      ev2.classification = 'outcome';
      ev2.outcome_kind = 'loss';
      const ev3 = analysis.events.find((e) => e.id === 'E3')!;
      ev3.classification = 'normal';
      ev3.outcome_kind = 'recovery';

      // 情報システム部傘下であっても、被害側 vs 防衛切断側で統合ブロック
      const guardResult = evaluateMergeGuard('A_OPS', 'A_SOC', analysis);
      expect(guardResult.allowed).toBe(false);

      const consolidated = consolidateSubjects(analysis, 2);
      const entityNames = consolidated.entities.map((e) => e.name);
      expect(entityNames).toContain('IT運用チーム');
      expect(entityNames).toContain('SOC監視チーム');
    });
  });

  describe('4. 非影響主体の除外と防壁不作為の保護', () => {
    it('定常背景主体（変動要因も因果連鎖もない）は excludeNonInfluential オプションでレーンから除外され dispositions に退避される', () => {
      const sourceText = [
        'p1 報告者が作業を実施した。',
        'p2 無関係な警備員が巡回を実施した。',
        'p3 報告者が配管を破損させ流出事故が発生した。',
      ].join('\n');

      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t報告者\tperson\treporter\t-\tp1,p3',
        'A2\t警備員\tperson\tlow\t-\tp2',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t作業実施\t報告者が作業した\tA1:actor\tp1\trecorded',
        'E2\t09:30\t定常巡回\t警備員が巡回した\tA2:actor\tp2\trecorded',
        'E3\t10:00\t破損流出\t報告者が破損させた\tA1:actor\tp3\trecorded',
        '[帰結]',
        'O1\tidentified\tE3\tp3\t破損流出',
        '[関係]',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildAnalysisFromLedger(ledger, sourceText);
      const ev3 = analysis.events.find((e) => e.id === 'E3')!;
      ev3.classification = 'variation';

      // 警備員（A2）の影響度判定: 非影響
      const guard = isInfluentialSubject(analysis.entities.find((e) => e.id === 'A2')!, analysis);
      expect(guard.influential).toBe(false);

      // 上限1レーンで excludeNonInfluential: true を指定して集約
      const ranking = rankSubjects(analysis, 1, undefined, { excludeNonInfluential: true });
      const a2Rank = ranking.ranks.find((r) => r.entityId === 'A2')!;
      expect(a2Rank.excluded).toBe(true);

      const consolidated = consolidateSubjects(analysis, 1, undefined, undefined, { excludeNonInfluential: true });
      // 警備員はレーンから除外され、報告者のみとなる
      expect(consolidated.entities.map((e) => e.name)).toEqual(['報告者']);
      // 台帳（dispositions）に背景退避されていること
      expect(consolidated.dispositions?.some((d) => d.reason.includes('警備員'))).toBe(true);
    });

    it('不作為（見落とし・未検知・不実施）を持つ防壁主体は非影響とみなされず保護される', () => {
      const sourceText = [
        'p1 作業員がバルブを操作した。',
        'p2 検査員が圧力計の異常上昇を見落とした。',
        'p3 圧力超過でタンクが破裂した。',
      ].join('\n');

      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t作業員\tperson\thigh\t-\tp1',
        'A2\t検査員\tperson\tlow\t-\tp2',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\tバルブ操作\t作業員が操作した\tA1:actor\tp1\trecorded',
        'E2\t09:15\t圧力見落とし\t検査員が異常を見落とした\tA2:actor\tp2\trecorded',
        'E3\t09:30\t破裂事故\tタンクが破裂した\tA1:affected\tp3\trecorded',
        '[帰結]',
        'O1\tidentified\tE3\tp3\t破裂事故',
        '[関係]',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildAnalysisFromLedger(ledger, sourceText);
      const ev3 = analysis.events.find((e) => e.id === 'E3')!;
      ev3.classification = 'outcome';

      // 検査員（A2）は focus: low だが「見落とし」不作為を持つため影響主体として保護される
      const a2Entity = analysis.entities.find((e) => e.id === 'A2')!;
      const check = isInfluentialSubject(a2Entity, analysis);
      expect(check.influential).toBe(true);
      expect(check.reason).toContain('不作為');
    });
  });

  describe('5. その他の関係者レーンにおける直列時系列結線（sequential edge）の禁止', () => {
    it('「その他の関係者」レーン内のノード間には自動 sequential 時系列線が生成されない', () => {
      const schema: VTASchema = {
        lanes: ['その他の関係者'],
        nodes: [
          {
            id: 'node_1',
            lane: 'その他の関係者',
            time: '09:00',
            sequence_order: 0,
            type: 'normal',
            title: '第3機が待機',
            description: '無関係な第3機が待機した',
            measure_type: null,
          },
          {
            id: 'node_2',
            lane: 'その他の関係者',
            time: '09:10',
            sequence_order: 1,
            type: 'normal',
            title: '地上作業員が清掃',
            description: '地上作業員が工具を片付けた',
            measure_type: null,
          },
        ],
        edges: [],
      };

      const result = repairGeneratedLaneSequence(schema);
      // 「その他の関係者」レーン内では直列時系列線（sequential edge）が生成されない
      const sequentialEdges = result.schema.edges.filter(
        (e) => e.direction === 'sequential'
      );
      expect(sequentialEdges).toHaveLength(0);
      expect(result.addedEdges).toBe(0);
    });
  });
});
