import { describe, expect, it } from 'vitest';
import {
  clampSubjectLimit,
  consolidateSubjects,
  rankSubjects,
  revertConsolidation,
} from './subjectRanking';
import { inspectLedger, parseLedger, classificationInput } from './eventLedger';
import { projectAnalysis, sourceFromText, validateSavedAnalysis } from './eventAnalysis';
import { evidenceNotes } from './evidenceNotes';

const buildLedgerAnalysis = (ledgerText: string, sourceText: string) => {
  const src = sourceFromText(sourceText);
  const res = inspectLedger(parseLedger(ledgerText), src);
  if (!res.analysis) {
    throw new Error(`Ledger parse failed: ${res.issues.map((i) => i.message).join(' / ')}`);
  }
  return res.analysis;
};

describe('subjectRanking - hybrid scoring, consolidation, and lossless round-trip', () => {
  it('clamps maxSubjects to [2, 12] and defaults non-finite values to 5', () => {
    expect(clampSubjectLimit(1)).toBe(2);
    expect(clampSubjectLimit(2)).toBe(2);
    expect(clampSubjectLimit(5)).toBe(5);
    expect(clampSubjectLimit(12)).toBe(12);
    expect(clampSubjectLimit(20)).toBe(12);
    expect(clampSubjectLimit(NaN)).toBe(5);
  });

  it('computes all 5 metrics (A, O, F, C, T) and redistributes O weight when outcome is not identified', () => {
    const sourceText = [
      '09:00 報告者（私）がライン点検を開始し、現場リーダーへ連絡した。',
      '09:30 現場リーダーが保守班へ確認を依頼した。',
      '10:00 報告者がバルブ操作を実施したところ漏洩事故が発生した。',
    ].join('\n');

    const ledgerWithOutcome = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t報告者（私）\tperson\treporter\t-\tp1,p3',
      'A2\t現場リーダー\tperson\thigh\t-\tp1,p2',
      'A3\t保守班\torganization\tlow\t-\tp2',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t09:00\tライン点検・連絡\t報告者がライン点検を開始し現場リーダーへ連絡した\tA1:actor,A2:confirmed_recipient\tp1\trecorded',
      'E2\t09:30\t確認依頼\t現場リーダーが保守班へ確認を依頼した\tA2:actor,A3:intended_recipient\tp2\trecorded',
      'E3\t10:00\t漏洩事故発生\t報告者がバルブ操作を実施し漏洩事故が発生した\tA1:actor\tp3\trecorded',
      '[帰結]',
      'O1\tidentified\tE3\tp3\t最終の漏洩事故',
      '[関係]',
      'R1\ttransfer\tE1\tA1\tE2\tA2\tp1,p2\tinformation\toccurred\tconfirmed',
      'R2\ttransfer\tE2\tA2\tE3\tA1\tp2,p3\tinformation\toccurred\tconfirmed',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const analysis = buildLedgerAnalysis(ledgerWithOutcome, sourceText);
    const ranking = rankSubjects(analysis, 5);
    const rA1 = ranking.ranks.find((r) => r.entityId === 'A1')!;
    const rA2 = ranking.ranks.find((r) => r.entityId === 'A2')!;
    const rA3 = ranking.ranks.find((r) => r.entityId === 'A3')!;

    // A1 has 2 actor events (max), participates in outcome E3 (d=0 -> O=1.0), reporter (F=1.0), spans E1..E3 (T=1.0)
    expect(rA1.breakdown.A).toBe(1);
    expect(rA1.breakdown.O).toBe(1);
    expect(rA1.breakdown.F).toBe(1);
    expect(rA1.breakdown.T).toBe(1);
    expect(rA1.priority).toBe('reporter');

    // A2 reaches E3 in 1 hop via R2 (d=1 -> O=0.5), connects to A1 and A3 (2 partners -> C=1.0)
    expect(rA2.breakdown.O).toBe(0.5);
    expect(rA2.breakdown.C).toBe(1);

    // A3 only participates in E2 (d=1 -> O=0.5), focus=low -> F=0
    expect(rA3.breakdown.F).toBe(0);

    // Without identified outcome, O becomes 0 and weights are redistributed proportionally
    const noOutcomeAnalysis = {
      ...analysis,
      outcome: { status: 'not_found' as const, eventIds: [], sourceRefs: [], reason: '帰結なし' },
    };
    const noOutcomeRanking = rankSubjects(noOutcomeAnalysis, 5);
    const rA2NoOut = noOutcomeRanking.ranks.find((r) => r.entityId === 'A2')!;
    expect(rA2NoOut.breakdown.O).toBe(0);
    // Since A2 has A=1.3/2.0=0.65, F=1, C=1, T=0.5, redistributed score should be (0.30*0.65 + 0.20*1 + 0.15*1 + 0.10*0.5) / 0.75 = 0.595 / 0.75 = 0.7933
    expect(rA2NoOut.score).toBeCloseTo(0.7933, 3);
  });

  it('applies priority retention for reporter and outcome-actor and penalizes machine with <= 1 actor event', () => {
    const sourceText = 'p1 報告者（私）が確認した。\np2 制御盤が表示した。\np3 作業員Bが操作し破損事故が発生した。';
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t報告者（私）\tperson\treporter\t-\tp1',
      'A2\t制御盤\tmachine\thigh\t-\tp2',
      'A3\t作業員B\tperson\tlow\t-\tp3',
      '[イベント]',
      'E1\t-\t確認\t報告者が確認した\tA1:target\tp1\trecorded',
      'E2\t-\t表示\t制御盤が表示した\tA2:actor\tp2\trecorded',
      'E3\t-\t破損事故\t作業員Bが操作し破損事故が発生した\tA3:actor\tp3\trecorded',
      '[帰結]',
      'O1\tidentified\tE3\tp3\t破損事故',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const analysis = buildLedgerAnalysis(ledger, sourceText);
    const ranking = rankSubjects(analysis, 2);
    expect(ranking.ranks[0].entityId).toBe('A1');
    expect(ranking.ranks[0].priority).toBe('reporter');
    expect(ranking.ranks[1].entityId).toBe('A3');
    expect(ranking.ranks[1].priority).toBe('outcome-actor');
    const machineRank = ranking.ranks.find((r) => r.entityId === 'A2')!;
    expect(machineRank.reason).toContain('自律動作1件以下の機器減点');
  });

  it('keeps all top N subjects when all overflow subjects merge into retained parent entities', () => {
    const sourceText = 'p1 報告者が連絡した。\np2 製造課が指示した。\np3 品質管理課が検査した。\np4 製造課の担当者Aが確認した。';
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t報告者（私）\tperson\treporter\t-\tp1',
      'A2\t製造課\torganization\thigh\t-\tp2',
      'A3\t品質管理課\torganization\thigh\t-\tp3',
      'A4\t製造課担当者A\tperson\tlow\tA2\tp4',
      '[イベント]',
      'E1\t09:00\t連絡\t報告者が連絡した\tA1:actor,A2:confirmed_recipient\tp1\trecorded',
      'E2\t09:10\t指示\t製造課が指示した\tA2:actor\tp2\trecorded',
      'E3\t09:20\t検査\t品質管理課が検査した\tA3:actor\tp3\trecorded',
      'E4\t09:30\t確認\t製造課担当者Aが確認した\tA4:actor\tp4\trecorded',
      '[関係]',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const analysis = buildLedgerAnalysis(ledger, sourceText);
    const consolidated = consolidateSubjects(analysis, 3);
    // Since A4 has parentEntityId A2 (which is in top 3), all 3 top subjects are kept and no "その他の関係者" is needed!
    expect(consolidated.entities.map((e) => e.id)).toEqual(['A1', 'A2', 'A3']);
    expect(consolidated.entities.some((e) => e.aggregate)).toBe(false);
    // E4 is now assigned to A2 with mergedFrom recording A4
    const e4Part = consolidated.participations.find((p) => p.eventId === 'E4')!;
    expect(e4Part.entityId).toBe('A2');
    expect(e4Part.mergedFrom).toEqual([{ entityId: 'A4', role: 'actor' }]);
    expect(consolidated.unassignedEventIds).toEqual([]);
  });

  it('creates "その他の関係者" within the maxSubjects budget when overflow subjects have no retained parent', () => {
    const sourceText = [
      'p1 報告者（私）が作業を開始した。',
      'p2 現場リーダーが指示を出した。',
      'p3 保守係が点検した。',
      'p4 品質係が記録した。',
      'p5 外部業者が搬入した。',
      'p6 警備員が開錠した。',
    ].join('\n');
    const ledger = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t報告者（私）\tperson\treporter\t-\tp1',
      'A2\t現場リーダー\tperson\thigh\t-\tp2',
      'A3\t保守係\torganization\thigh\t-\tp3',
      'A4\t品質係\torganization\tmid\t-\tp4',
      'A5\t外部業者\torganization\tlow\t-\tp5',
      'A6\t警備員\tperson\tlow\t-\tp6',
      '[イベント]',
      'E1\t09:00\t作業開始\t報告者が作業を開始した\tA1:actor\tp1\trecorded',
      'E2\t09:10\t指示\t現場リーダーが指示を出した\tA2:actor,A1:confirmed_recipient\tp2\trecorded',
      'E3\t09:20\t点検\t保守係が点検した\tA3:actor\tp3\trecorded',
      'E4\t09:30\t記録\t品質係が記録した\tA4:actor\tp4\trecorded',
      'E5\t09:40\t搬入\t外部業者が搬入した\tA5:actor\tp5\trecorded',
      'E6\t09:50\t開錠\t警備員が開錠した\tA6:actor\tp6\trecorded',
      '[関係]',
      'R1\tdependency\tE5\tA5\tE6\tA6\tp5,p6\t-\t-\tna',
      '[共有カード]',
      '[整理]',
      '[完了]',
    ].join('\n');

    const analysis = buildLedgerAnalysis(ledger, sourceText);
    const consolidated = consolidateSubjects(analysis, 4);

    // Total entities must be exactly 4: top 3 + "その他の関係者"
    expect(consolidated.entities).toHaveLength(4);
    expect(consolidated.entities.map((e) => e.name)).toEqual([
      '報告者（私）',
      '現場リーダー',
      '保守係',
      'その他の関係者',
    ]);
    expect(consolidated.unassignedEventIds).toEqual([]);

    // Cross-subject dependency R1 between A5 and A6 (both merged into subject_others) retains its original entity origins and stays valid
    const r1 = consolidated.relations.find((r) => r.sourceEventId === 'E5' && r.targetEventId === 'E6')!;
    expect(r1).toBeDefined();
    expect(r1.sourceEntityId).toBe('subject_others');
    expect(r1.targetEntityId).toBe('subject_others');
    expect(r1.sourceEntityOrigin).toBe('A5');
    expect(r1.targetEntityOrigin).toBe('A6');

    // Classification input includes merged subject names
    const classInput = classificationInput(consolidated);
    expect(classInput).toContain('その他の関係者:actor（統合：外部業者）');

    // Evidence notes include merged subject notes
    const projected = projectAnalysis(consolidated);
    const notes = evidenceNotes(projected);
    expect(notes.some((n) => n.includes('その他の関係者 へ統合：外部業者（actor）'))).toBe(true);

    // Lossless round-trip via revertConsolidation and re-consolidation with different N
    const reverted = revertConsolidation(consolidated);
    expect(reverted.entities).toHaveLength(6);
    expect(reverted.subjectRanking).toBeUndefined();
    expect(reverted.relations.find((r) => r.sourceEventId === 'E5')?.sourceEntityId).toBe('A5');

    const reconsolidated5 = consolidateSubjects(consolidated, 5);
    expect(reconsolidated5.entities).toHaveLength(5);
    expect(reconsolidated5.subjectRanking?.maxSubjects).toBe(5);

    // Saved analysis validation round-trip preserves subjectRanking and origins
    const validated = validateSavedAnalysis(JSON.parse(JSON.stringify(consolidated)));
    expect(validated.subjectRanking?.maxSubjects).toBe(4);
    expect(validated.subjectRanking?.originalEntities).toHaveLength(6);

    // Manual edits retention: user changes role on consolidated participation and adds a manual entity
    const edited = {
      ...consolidated,
      entities: [...consolidated.entities, { id: 'manual_user_ent', name: '手動追加主体', kind: 'other' as const }],
      participations: consolidated.participations.map((p) =>
        p.eventId === 'E5' && p.entityId === 'subject_others'
          ? { ...p, role: 'target' as const, origin: 'manual' as const }
          : p
      ),
    };
    const revertedManual = revertConsolidation(edited);
    // Manually added entity should be retained
    expect(revertedManual.entities.some((e) => e.id === 'manual_user_ent')).toBe(true);
    // Manually updated role on merged participation should be propagated to reverted fine-grained participation
    const revertedE5 = revertedManual.participations.find((p) => p.eventId === 'E5' && p.entityId === 'A5');
    expect(revertedE5?.role).toBe('target');
  });

  describe('Self-report evaluation fixtures (自己報告書3パターン検証)', () => {
    it('Case 1: 製造・設備保守の自己報告書（7主体 → デフォルト5主体で主要当事者が保持される）', () => {
      const source = [
        'p1 私（報告者・保守担当）はシフト引継ぎ時に前任作業者からポンプ異音の申し送りを受けた。',
        'p2 私は製造ライン長へ停止点検を打診したが、製造ライン長は生産継続を指示した。',
        'p3 私は予備部品倉庫係へシール材の在庫を照会した。',
        'p4 制御盤モニタが一時的な圧力上昇を表示し、監視カメラが記録した。',
        'p5 その後、私がバルブを絞った際にポンプシールが破損し漏洩が発生した。',
        'p6 発生後、私は品質保証部へ異常報告書を提出した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t私（保守担当）\tperson\treporter\t-\tp1,p2,p3,p5,p6',
        'A2\t前任作業者\tperson\tmid\t-\tp1',
        'A3\t製造ライン長\tperson\thigh\t-\tp2',
        'A4\t予備部品倉庫係\torganization\tlow\t-\tp3',
        'A5\t制御盤モニタ\tmachine\tlow\t-\tp4',
        'A6\t監視カメラ\tmachine\tlow\t-\tp4',
        'A7\t品質保証部\torganization\tmid\t-\tp6',
        '[イベント]',
        'E1\t08:30\t申し送り受領\t前任作業者からポンプ異音の申し送りを受けた\tA2:actor,A1:confirmed_recipient\tp1\trecorded',
        'E2\t09:00\t停止点検打診\t私が製造ライン長へ停止点検を打診した\tA1:actor,A3:confirmed_recipient\tp2\trecorded',
        'E3\t09:05\t生産継続指示\t製造ライン長が生産継続を指示した\tA3:actor,A1:confirmed_recipient\tp2\trecorded',
        'E4\t09:30\t在庫照会\t私が予備部品倉庫係へ在庫を照会した\tA1:actor,A4:confirmed_recipient\tp3\trecorded',
        'E5\t10:00\t圧力上昇表示\t制御盤モニタが圧力上昇を表示し監視カメラが記録した\tA5:actor,A6:actor\tp4\trecorded',
        'E6\t10:15\tシール破損・漏洩\t私がバルブを絞った際にポンプシールが破損し漏洩が発生した\tA1:actor\tp5\trecorded',
        'E7\t11:00\t異常報告提出\t私が品質保証部へ異常報告書を提出した\tA1:actor,A7:confirmed_recipient\tp6\trecorded',
        '[帰結]',
        'O1\tidentified\tE6\tp5\tポンプシール破損・漏洩',
        '[関係]',
        'R1\ttransfer\tE1\tA2\tE2\tA1\tp1,p2\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE2\tA1\tE3\tA3\tp2\tinformation\toccurred\tconfirmed',
        'R3\timpact\tE3\tA3\tE6\tA1\tp2,p5\t-\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildLedgerAnalysis(ledger, source);
      const consolidated = consolidateSubjects(analysis, 5);
      expect(consolidated.entities).toHaveLength(5);
      const retainedNames = consolidated.entities.map((e) => e.name);
      expect(retainedNames).toContain('私（保守担当）');
      expect(retainedNames).toContain('製造ライン長');
      expect(retainedNames).toContain('前任作業者');
      expect(retainedNames).toContain('その他の関係者');
      // Passive/single-event machines (制御盤モニタ, 監視カメラ) are merged into その他の関係者
      expect(retainedNames).not.toContain('監視カメラ');
      expect(consolidated.unassignedEventIds).toEqual([]);
    });

    it('Case 2: ソフトウェア運用の自己報告書（組織階層への統合）', () => {
      const source = [
        'p1 私（SRE担当）はデプロイ手順書に従って設定変更を実施した。',
        'p2 アプリ開発チームのレビュアーAがPRを承認した。',
        'p3 アプリ開発チームのメンバーBがビルドを実行した。',
        'p4 監視システムがエラー率上昇を検知し自動ロールバックを起動した。',
        'p5 CS窓口が顧客問い合わせを受付した。',
        'p6 インシデントコマンダーが全体復旧を宣言した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t私（SRE担当）\tperson\treporter\t-\tp1',
        'A2\tアプリ開発チーム\torganization\thigh\t-\tp2,p3',
        'A3\tレビュアーA\tperson\tlow\tA2\tp2',
        'A4\tメンバーB\tperson\tlow\tA2\tp3',
        'A5\t監視システム\tmachine\thigh\t-\tp4',
        'A6\tCS窓口\torganization\tmid\t-\tp5',
        'A7\tインシデントコマンダー\tperson\thigh\t-\tp6',
        '[イベント]',
        'E1\t14:00\t設定変更\t私が設定変更を実施した\tA1:actor\tp1\trecorded',
        'E2\t13:30\tPR承認\tレビュアーAがPRを承認した\tA3:actor,A2:affected\tp2\trecorded',
        'E3\t13:45\tビルド実行\tメンバーBがビルドを実行した\tA4:actor,A2:affected\tp3\trecorded',
        'E4\t14:05\t異常検知\t監視システムがエラー率上昇を検知した\tA5:actor\tp4\trecorded',
        'E5\t14:06\t自動ロールバック\t監視システムが自動ロールバックを起動した\tA5:actor,A1:confirmed_recipient\tp4\trecorded',
        'E6\t14:10\t問い合わせ受付\tCS窓口が問い合わせを受付した\tA6:actor\tp5\trecorded',
        'E7\t14:30\t復旧宣言\tインシデントコマンダーが復旧を宣言した\tA7:actor\tp6\trecorded',
        '[帰結]',
        'O1\tidentified\tE4\tp4\tエラー率上昇',
        '[関係]',
        'R1\timpact\tE1\tA1\tE4\tA5\tp1,p4\t-\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildLedgerAnalysis(ledger, source);
      // With limit=5, overflow A3 and A4 both have parentEntityId=A2 (retained), so all 5 top subjects are kept without needing "その他の関係者"!
      const consolidated = consolidateSubjects(analysis, 5);
      expect(consolidated.entities).toHaveLength(5);
      expect(consolidated.entities.map((e) => e.id)).toEqual(['A1', 'A2', 'A5', 'A6', 'A7']);
      expect(consolidated.subjectRanking?.ranks.slice(0, 5).map((r) => r.entityId)).toEqual(['A1', 'A5', 'A7', 'A2', 'A6']);
      expect(consolidated.entities.some((e) => e.aggregate)).toBe(false);
    });

    it('Case 3: 医療・看護ヒヤリハット自己報告書（帰結未特定時の重み再配分）', () => {
      const source = [
        'p1 私（担当看護師）は日勤リーダーから指示受けを行った。',
        'p2 薬剤部から病棟へ薬剤が払い出された。',
        'p3 先輩看護師とダブルチェックを行った際、患者名ラベルの類似に気づいた。',
        'p4 担当医師へ確認し、投与前に正しい薬剤へ差し替えた。',
        'p5 医療安全推進室へヒヤリハット報告を提出した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t私（担当看護師）\tperson\treporter\t-\tp1,p3,p4,p5',
        'A2\t日勤リーダー\tperson\tmid\t-\tp1',
        'A3\t薬剤部\torganization\tmid\t-\tp2',
        'A4\t先輩看護師\tperson\thigh\t-\tp3',
        'A5\t担当医師\tperson\thigh\t-\tp4',
        'A6\t医療安全推進室\torganization\tlow\t-\tp5',
        '[イベント]',
        'E1\t09:00\t指示受け\t日勤リーダーから指示受けを行った\tA2:actor,A1:confirmed_recipient\tp1\trecorded',
        'E2\t10:00\t薬剤払出\t薬剤部から薬剤が払い出された\tA3:actor,A1:confirmed_recipient\tp2\trecorded',
        'E3\t11:00\tダブルチェック\t先輩看護師とダブルチェックを行い類似に気づいた\tA1:actor,A4:actor\tp3\trecorded',
        'E4\t11:10\t医師確認・差替\t担当医師へ確認し正しい薬剤へ差し替えた\tA1:actor,A5:confirmed_recipient\tp4\trecorded',
        'E5\t15:00\t報告提出\t医療安全推進室へ報告を提出した\tA1:actor,A6:confirmed_recipient\tp5\trecorded',
        '[帰結]',
        'O1\tnot_found\t-\tp4\t投与前に差し替えたため実害なし',
        '[関係]',
        'R1\ttransfer\tE1\tA2\tE3\tA1\tp1,p3\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE2\tA3\tE3\tA1\tp2,p3\tmaterial\toccurred\tconfirmed',
        'R3\tmutual\tE3\tA1\tE3\tA4\tp3\tinformation\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildLedgerAnalysis(ledger, source);
      const consolidated = consolidateSubjects(analysis, 5);
      expect(consolidated.entities).toHaveLength(5);
      expect(consolidated.entities[0].name).toBe('私（担当看護師）');
      expect(consolidated.unassignedEventIds).toEqual([]);
    });
  });
});
