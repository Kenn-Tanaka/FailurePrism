import { describe, expect, it } from 'vitest';
import {
  clampSubjectLimit,
  consolidatePeripheralSubjectsToOthers,
  consolidateSubjects,
  derivePreConsolidationLimit,
  evaluateMergeGuard,
  rankSubjects,
  revertConsolidation,
} from './subjectRanking';
import { inspectLedger, parseLedger, classificationInput } from './eventLedger';
import { isPeripheralAggregateEntity, isPeripheralAggregateId } from './subjectCompositeForest';
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

    // Cross-subject dependency R1 between A5 and A6 (both merged into cmp_agg_* others) retains its original entity origins and stays valid
    const othersEnt = consolidated.entities.find((e) => isPeripheralAggregateEntity(e))!;
    expect(othersEnt.id).toMatch(/^cmp_agg_/);
    const r1 = consolidated.relations.find((r) => r.sourceEventId === 'E5' && r.targetEventId === 'E6')!;
    expect(r1).toBeDefined();
    expect(r1.sourceEntityId).toBe(othersEnt.id);
    expect(r1.targetEntityId).toBe(othersEnt.id);
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
        p.eventId === 'E5' && isPeripheralAggregateId(p.entityId)
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

    it('promotes multi-child organization parent (e.g. A_team) instead of dumping parent and workers to subject_others, and caps same-outcome sibling fan-out', () => {
      const source = [
        'p1 現場代理人Gが作業員B・C・D・E・F・H・I・Jと作業班で出勤した。',
        'p2 見張員Bが代理人Gへ列車接近を連絡した。',
        'p3 代理人G・見張員B・作業班が線路内へ進入した。',
        'p4 中継員Cが合図し、中継員D・作業員E・作業員Fが移動した。',
        'p5 作業員H・I・Jが用具を運搬した。',
        'p6 第1020列車運転士が進入し作業員4名が触車死亡した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_team\t除草薬散布作業班\torganization\tmid\t-\t-',
        'A_sub\t下請会社\torganization\tlow\t-\t-',
        'A_tobu\t東武鉄道株式会社\torganization\tmid\t-\t-',
        'A_driver\t第1020列車運転士\tperson\thigh\tA_tobu\tp6',
        'A_G\tG現場代理人\tperson\thigh\tA_team\tp1,p2,p3',
        'A_B\tB列車見張員\tperson\thigh\tA_team\tp2,p3',
        'A_A\tA作業指揮者\tperson\thigh\tA_team\tp1',
        'A_C\tC中継見張員\tperson\tmid\tA_team\tp4',
        'A_D\tD中継見張員\tperson\tmid\tA_team\tp4',
        'A_E\tE作業員\tperson\tmid\tA_team\tp4',
        'A_F\tF作業員\tperson\tmid\tA_team\tp4',
        'A_H\tH作業員\tperson\tlow\tA_team\tp5',
        'A_I\tI作業員\tperson\tlow\tA_team\tp5',
        'A_J\tJ作業員\tperson\tlow\tA_team\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t10:40\t作業前集合\tA指揮者とG代理人が作業前確認した\tA_A:actor,A_G:confirmed_recipient\tp1\trecorded',
        'E2\t10:41\t接近伝達\tB見張員がG代理人へ伝達した\tA_B:actor,A_G:confirmed_recipient\tp2\trecorded',
        'E3\t10:42\t線路内進入\tG代理人とB見張員と作業班が進入した\tA_G:actor,A_B:actor,A_team:actor\tp3\trecorded',
        'E4\t10:43\t中継合図\tC中継員がD中継員へ合図しE・Fが移動した\tA_C:actor,A_D:confirmed_recipient,A_E:actor,A_F:actor\tp4\trecorded',
        'E5\t10:44\t用具運搬\tH・I・J作業員が運搬した\tA_H:actor,A_I:actor,A_J:actor\tp5\trecorded',
        'E6\t10:45\t他作業\t下請会社が手続きした\tA_sub:actor\tp1\trecorded',
        'E7\t10:46\t列車触車\t運転士運転の列車に作業員が触車した\tA_driver:actor,A_E:affected,A_F:affected\tp6\trecorded',
        '[帰結]',
        'O1\tidentified\tE7\tp6\t作業員4名死亡',
        '[関係]',
        'R1\ttransfer\tE2\tA_B\tE3\tA_G\tp2,p3\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE4\tA_C\tE4\tA_D\tp4\tinformation\toccurred\tconfirmed',
        'R3\ttransfer\tE4\tA_D\tE4\tA_E\tp4\tinformation\toccurred\tconfirmed',
        'R4\tdependency\tE4\tA_E\tE7\tA_driver\tp4,p6\t-\t-\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildLedgerAnalysis(ledger, source);
      // Simulate E3 (normal intermediate) and E7 (loss outcome) preliminary variation tags
      analysis.events.find((e) => e.id === 'E3')!.preliminary = {
        value: 'variation',
        reason: '線路内進入',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }],
      };
      analysis.events.find((e) => e.id === 'E7')!.preliminary = {
        value: 'variation',
        reason: '触車死亡',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p6' }],
      };

      const consolidated = consolidateSubjects(analysis, 6);
      const ids = consolidated.entities.map((e) => e.id);
      // Parent A_team must stay retained as its own lane rather than falling into subject_others
      expect(ids).toContain('A_team');
      expect(consolidated.entities.length).toBeLessThanOrEqual(6);
      // Overflow team workers H/I/J should merge into A_team rather than subject_others
      const ranks = consolidated.subjectRanking?.ranks ?? [];
      for (const workerId of ['A_H', 'A_I', 'A_J']) {
        const entry = ranks.find((r) => r.entityId === workerId);
        expect(entry?.mergedInto).toBe('A_team');
      }
      // E3 (A_team participation) must not fall into subject_others
      const projected = projectAnalysis(consolidated);
      expect(
        projected.nodes.some((n) => n.lane === 'その他の関係者' && n.event_ids?.includes('E3'))
      ).toBe(false);
    });

    it('excludes 0-participation parent organization (e.g. A_JAL) instead of creating a phantom subject_others bucket, and keeps a sole named overflow entity when budget has a slot', () => {
      const source = [
        'p1 海保機長が報告した。',
        'p2 管制官が指示した。',
        'p3 日航機長が着陸した。',
        'p4 日航客室乗務員が避難誘導した。',
        'p5 日航訓練乗員が待機した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_JCG_CAPT\t機長A\tperson\thigh\t-\tp1',
        'A_ATC\t管制官\tperson\thigh\t-\tp2',
        'A_JAL\t日本航空\torganization\tmid\t-\t-',
        'A_CAPT_B\t機長B\tperson\thigh\tA_JAL\tp3',
        'A_CABIN_B\tB機客室乗務員\tperson\thigh\tA_JAL\tp4',
        'A_TRAINEE_B\t訓練乗員\tperson\tmid\tA_JAL\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:45\t報告\t海保機長が報告した\tA_JCG_CAPT:actor\tp1\trecorded',
        'E2\t17:46\t指示\t管制官が指示した\tA_ATC:actor\tp2\trecorded',
        'E3\t17:47\t着陸\t日航機長が着陸した\tA_CAPT_B:actor\tp3\trecorded',
        'E4\t17:48\t避難誘導\t日航客室乗務員が避難誘導した\tA_CABIN_B:actor\tp4\trecorded',
        'E5\t17:49\t待機\t日航訓練乗員が待機した\tA_TRAINEE_B:actor\tp5\trecorded',
        '[帰結]',
        'O1\tidentified\tE3\tp3\t着陸衝突',
        '[関係]',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const analysis = buildLedgerAnalysis(ledger, source);
      // With maxSubjects = 6 and 6 entities where A_JAL has 0 participations, no consolidation or subject_others is needed
      // Even with maxSubjects = 5 (5 active entities + 0-participation A_JAL), A_JAL must be excluded rather than merged into subject_others
      const consolidated5 = consolidateSubjects(analysis, 5);
      expect(consolidated5.entities.some((e) => e.id === 'subject_others')).toBe(false);
      expect(consolidated5.entities.map((e) => e.id)).toEqual(
        expect.arrayContaining(['A_JCG_CAPT', 'A_ATC', 'A_CAPT_B', 'A_CABIN_B', 'A_TRAINEE_B'])
      );
      const jalRank = consolidated5.subjectRanking?.ranks.find((r) => r.entityId === 'A_JAL');
      expect(jalRank?.mergedInto).toBeUndefined();
      expect(jalRank?.excluded).toBe(true);
      // Poset and originalEntities still retain A_JAL hierarchy
      expect(consolidated5.subjectRanking?.originalEntities.some((e) => e.id === 'A_JAL')).toBe(true);
      expect(consolidated5.subjectPoset?.nodes).toContain('A_JAL');
    });

    it('merges a parent organization into its descendant hub without creating parent cycles or displacing unrelated lanes (ADR-0064)', () => {
      const source = [
        'p1 海保機長が報告した。',
        'p2 日航機長が着陸した。',
        'p3 タワー管制官が指示した。',
        'p4 羽田調整席が連絡した。',
        'p5 空港事務所が方針を通達した。',
        'p6 空港消防が出動した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CAPT_A\t機長A\tperson\thigh\t-\tp1',
        'A_CAPT_B\t機長B\tperson\thigh\t-\tp2',
        'A_CAB_ORG\t空港事務所\torganization\tlow\t-\tp5',
        'A_TWR_ORG\t東京飛行場管制所\torganization\thigh\tA_CAB_ORG\tp3',
        'A_DF\t羽田調整席\tperson\tlow\tA_CAB_ORG\tp4',
        'A_FIRE\t空港消防\torganization\tmid\t-\tp6',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:45\t報告\t海保機長が報告した\tA_CAPT_A:actor\tp1\trecorded',
        'E2\t17:46\t通達\t空港事務所が方針を通達した\tA_CAB_ORG:actor\tp5\trecorded',
        'E3\t17:46\t連絡\t羽田調整席が連絡した\tA_DF:actor\tp4\trecorded',
        'E4\t17:47\t管制指示\tタワー管制官が指示した\tA_TWR_ORG:actor\tp3\trecorded',
        'E5\t17:48\t着陸衝突\t日航機長が着陸した\tA_CAPT_B:actor\tp2\trecorded',
        'E6\t17:49\t消防出動\t空港消防が出動した\tA_FIRE:actor\tp6\trecorded',
        '[帰結]',
        'O1\tidentified\tE5\tp2\t衝突',
        '[関係]',
        'R1\ttransfer\tE3\tA_DF\tE4\tA_TWR_ORG\tp3,p4\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE4\tA_TWR_ORG\tE5\tA_CAPT_B\tp2,p3\tinformation\toccurred\tconfirmed',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const consolidated = consolidateSubjects(base, 4, undefined, undefined, {
        explicitMerges: new Map([['A_CAB_ORG', 'A_TWR_ORG']]),
      });

      const retainedIds = consolidated.entities.map((e) => e.id);
      expect(retainedIds).toContain('A_TWR_ORG');
      expect(retainedIds).toContain('A_FIRE');
      expect(retainedIds).not.toContain('A_CAB_ORG');
      expect(retainedIds).not.toContain('subject_others');

      // Both A_CAB_ORG and its child A_DF merge transitively into A_TWR_ORG
      const ranks = consolidated.subjectRanking?.ranks ?? [];
      expect(ranks.find((r) => r.entityId === 'A_CAB_ORG')?.mergedInto).toBe('A_TWR_ORG');
      expect(ranks.find((r) => r.entityId === 'A_DF')?.mergedInto).toBe('A_TWR_ORG');

      // Consolidated A_TWR_ORG must not hold a self-looping parentEntityId / parentEntityIds
      const twrEnt = consolidated.entities.find((e) => e.id === 'A_TWR_ORG');
      expect(twrEnt?.parentEntityId).toBeUndefined();
      expect(twrEnt?.parentEntityIds).toBeUndefined();

      // Original entities & SubjectPoset preserve the acyclic A_TWR_ORG -> A_CAB_ORG relation
      const origCab = consolidated.subjectRanking?.originalEntities.find((e) => e.id === 'A_CAB_ORG');
      const origTwr = consolidated.subjectRanking?.originalEntities.find((e) => e.id === 'A_TWR_ORG');
      expect(origCab?.parentEntityId).toBeUndefined();
      expect(origTwr?.parentEntityId).toBe('A_CAB_ORG');
      expect(
        consolidated.subjectPoset?.relations.some(
          (r) => r.childId === 'A_CAB_ORG' && r.parentId === 'A_TWR_ORG'
        )
      ).toBe(false);

      const reverted = revertConsolidation(consolidated);
      expect(validateSavedAnalysis(reverted).entities.length).toBe(6);
    });

    it('excludes explicitMerges sources from consuming retention slots so all 6 slots hold named lanes instead of collapsing into subject_others (ADR-0065)', () => {
      const source = [
        'p1 東武鉄道工務事務所が散布計画を監督していた。',
        'p2 下請会社が除草作業を受注した。',
        'p3 A作業指揮者が指示を出した。',
        'p4 B列車見張員が見張りを開始した。',
        'p5 G現場代理人が確認した。',
        'p6 第1020列車運転士が接近を確認した。',
        'p7 除草薬散布作業班とH作業員が列車に触車し死亡した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CORP\t東武鉄道株式会社\torganization\tlow\t-\t-',
        'A_OFFICE\t東武鉄道北関東工務事務所\torganization\tmid\tA_CORP\tp1',
        'A_CONTRACTOR\t下請会社\torganization\tmid\t-\tp2',
        'A_CREW\t除草薬散布作業班\torganization\thigh\t-\tp7',
        'A_LEADER\tA作業指揮者\tperson\tmid\tA_CREW\tp3',
        'A_WATCH_B\tB列車見張員\tperson\thigh\tA_CREW\tp4',
        'A_REP_G\tG現場代理人\tperson\thigh\tA_CREW\tp5',
        'A_DRIVER\t第1020列車運転士\tperson\thigh\tA_CORP\tp6',
        'A_WORKER_H\tH作業員\tperson\thigh\tA_CREW\tp7',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t10:00\t計画監督\t工務事務所が計画を監督した\tA_OFFICE:actor\tp1\trecorded',
        'E2\t10:05\t作業受注\t下請会社が除草作業を受注した\tA_CONTRACTOR:actor\tp2\trecorded',
        'E3\t10:15\t指揮\tA作業指揮者が指示を出した\tA_LEADER:actor\tp3\trecorded',
        'E4\t10:20\t見張り1\tB列車見張員が見張りを開始した\tA_WATCH_B:actor\tp4\trecorded',
        'E5\t10:25\t見張り2\tB列車見張員が確認した\tA_WATCH_B:actor\tp4\trecorded',
        'E6\t10:30\t代理確認1\tG現場代理人が確認した\tA_REP_G:actor\tp5\trecorded',
        'E7\t10:35\t代理確認2\tG現場代理人が記録した\tA_REP_G:actor\tp5\trecorded',
        'E8\t10:45\t接近確認\t運転士が接近を確認した\tA_DRIVER:actor\tp6\trecorded',
        'E9\t10:46\t作業班触車\t作業班とH作業員が触車した\tA_CREW:affected,A_WORKER_H:actor\tp7\trecorded',
        '[帰結]',
        'O1\tidentified\tE9\tp7\t作業員死亡',
        '[関係]',
        'R1\ttransfer\tE4\tA_WATCH_B\tE6\tA_REP_G\tp4,p5\tinformation\toccurred\tconfirmed',
        'R2\timpact\tE8\tA_DRIVER\tE9\tA_WORKER_H\tp6,p7\tother\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const consolidated = consolidateSubjects(base, 6, undefined, undefined, {
        explicitMerges: new Map([['A_WORKER_H', 'A_CREW']]),
      });

      const retainedIds = consolidated.entities.map((e) => e.id);
      expect(retainedIds).toHaveLength(6);
      expect(retainedIds).toEqual(
        expect.arrayContaining(['A_CREW', 'A_WATCH_B', 'A_REP_G', 'A_DRIVER', 'A_OFFICE', 'A_CONTRACTOR'])
      );
      expect(retainedIds).not.toContain('A_WORKER_H');
      expect(retainedIds).not.toContain('subject_others');

      const ranks = consolidated.subjectRanking?.ranks ?? [];
      expect(ranks.find((r) => r.entityId === 'A_WORKER_H')?.mergedInto).toBe('A_CREW');
      expect(ranks.find((r) => r.entityId === 'A_CORP')?.excluded).toBe(true);
    });

    it('merges soft Merge Guard children (e.g. A_COMM_STA -> A_JCG) into retained parent instead of subject_others when budget is full', () => {
      const source = [
        'p1 報告者（機長A）は離陸確認を行った。',
        'p2 タワー東管制官は進入許可を発出した。',
        'p3 海上保安庁機が滑走路に進入し衝突炎上した。',
        'p4 機上整備員Aと海上保安庁が異常確認を相互調整した。',
        'p5 機上整備員Aが機材点検を実施した。',
        'p6 羽田通信が海上保安庁機へ交信伝達した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_CAP_A\t機長A\tperson\treporter\t-\tp1,p3',
        'A_TWR_E\tタワー東管制官\tperson\thigh\t-\tp2',
        'A_JCG\t海上保安庁\torganization\thigh\t-\tp3',
        'A_MECH_A\t機上整備員A\tperson\tmid\tA_JCG\tp4,p5',
        'A_COMM_STA\t羽田通信\torganization\tlow\tA_JCG\tp6',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:40\t離陸確認\t機長Aは離陸確認を行った\tA_CAP_A:actor\tp1\trecorded',
        'E2\t17:42\t機材点検\t機上整備員Aが機材点検を実施した\tA_MECH_A:actor\tp5\trecorded',
        'E3\t17:43\t相互調整\t機上整備員Aと海上保安庁が相互調整した\tA_MECH_A:actor,A_JCG:actor\tp4\trecorded',
        'E4\t17:44\t交信伝達\t羽田通信が海上保安庁機へ交信伝達した\tA_COMM_STA:actor\tp6\trecorded',
        'E5\t17:45\t進入許可\tタワー東管制官が許可した\tA_TWR_E:actor\tp2\trecorded',
        'E6\t17:46\t滑走路進入\t海上保安庁機が滑走路に進入した\tA_JCG:actor\tp3\trecorded',
        'E7\t17:47\t衝突炎上\t機長Aと海保機が衝突した\tA_CAP_A:affected,A_JCG:affected\tp3\trecorded',
        '[帰結]',
        'O1\tidentified\tE7\tp3\t衝突炎上',
        '[関係]',
        'R1\ttransfer\tE5\tA_TWR_E\tE7\tA_CAP_A\tp2,p3\tinformation\toccurred\tconfirmed',
        // Strict asymmetry (mutual) retains A_MECH_A in slot #4 (filling maxSubjects = 4)
        'R2\tmutual\tE3\tA_MECH_A\tE3\tA_JCG\tp4\tinformation\toccurred\tna',
        // Soft Merge Guard (transfer touching preliminary variation E6, non-person, non-recovery) for A_COMM_STA
        'R3\ttransfer\tE4\tA_COMM_STA\tE6\tA_JCG\tp3,p6\tinformation\toccurred\tconfirmed',
        '[仮判定]',
        'E6\tvariation\t滑走路進入\tp3',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const consolidated = consolidateSubjects(base, 4);
      const retainedIds = consolidated.entities.map((e) => e.id);
      expect(retainedIds).toEqual(expect.arrayContaining(['A_CAP_A', 'A_TWR_E', 'A_JCG', 'A_MECH_A']));
      expect(retainedIds).toHaveLength(4);
      expect(consolidated.entities.some((e) => e.id === 'subject_others')).toBe(false);
      const commRank = consolidated.subjectRanking?.ranks.find((r) => r.entityId === 'A_COMM_STA');
      expect(commRank?.mergedInto).toBe('A_JCG');
    });

    it('keeps chained explicitMerges sources excluded from retainedIds regardless of insertion order', () => {
      const source = [
        'p1 主体1が操作した。',
        'p2 主体2が指示した。',
        'p3 主体3が実施した。',
        'p4 組織Aが統括し事故となった。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_SUB_2\t担当2\tperson\thigh\tA_SUB_1\tp3',
        'A_SUB_1\t班1\torganization\thigh\tA_ORG\tp2',
        'A_ORG\t組織A\torganization\thigh\t-\tp4',
        'A_1\t主体1\tperson\thigh\t-\tp1',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t操作\t主体1が操作した\tA_1:actor\tp1\trecorded',
        'E2\t09:10\t指示\t主体2が指示した\tA_SUB_1:actor\tp2\trecorded',
        'E3\t09:20\t実施\t主体3が実施した\tA_SUB_2:actor\tp3\trecorded',
        'E4\t09:30\t統括\t組織Aが統括し事故となった\tA_ORG:affected\tp4\trecorded',
        '[帰結]',
        'O1\tidentified\tE4\tp4\t事故発生',
        '[関係]',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      // Reverse chain insertion order: A_SUB_2 -> A_SUB_1 appears before A_SUB_1 -> A_ORG
      const consolidated = consolidateSubjects(base, 4, undefined, undefined, {
        explicitMerges: new Map([
          ['A_SUB_2', 'A_SUB_1'],
          ['A_SUB_1', 'A_ORG'],
        ]),
      });
      const retainedIds = consolidated.entities.map((e) => e.id);
      expect(retainedIds).toEqual(expect.arrayContaining(['A_1', 'A_ORG']));
      expect(retainedIds).not.toContain('A_SUB_1');
      expect(retainedIds).not.toContain('A_SUB_2');
      const ranks = consolidated.subjectRanking?.ranks ?? [];
      expect(ranks.find((r) => r.entityId === 'A_SUB_1')?.mergedInto).toBe('A_ORG');
      expect(ranks.find((r) => r.entityId === 'A_SUB_2')?.mergedInto).toBe('A_ORG');
    });

    it('prevents Whack-a-Mole sibling re-promotion on explicit merge, reserves slot against soft Merge Guard, and never wraps a single entity in subject_others (ADR-0068)', () => {
      const source = [
        'p1 下請会社が除草薬散布業務を受注した。',
        'p2 除草作業班が作業準備を行い、B列車見張員・D中継見張員・G現場代理人を配置した。',
        'p3 B列車見張員が列車接近確認手順を開始した。',
        'p4 D中継見張員が合図中継位置についた。',
        'p5 G現場代理人が作業班へ散布開始を連絡した。',
        'p6 第1020列車運転士が新鹿沼駅構内へ進入した。',
        'p7 A作業指揮者・C中継見張員・E作業員・F作業員・H作業員・I作業員・J作業員が軌道内で作業し、列車と触車して4名が死亡した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'S_WORKGROUP\t除草作業班\torganization\thigh\t-\tp2,p7',
        'S_A\tA作業指揮者\tperson\tmid\tS_WORKGROUP\tp7',
        'S_B\tB列車見張員\tperson\thigh\tS_WORKGROUP\tp2,p3',
        'S_C\tC中継見張員\tperson\tmid\tS_WORKGROUP\tp7',
        'S_D\tD中継見張員\tperson\thigh\tS_WORKGROUP\tp2,p4',
        'S_G\tG現場代理人\tperson\tmid\tS_WORKGROUP\tp2,p5',
        'S_E\tE作業員\tperson\tmid\tS_WORKGROUP\tp7',
        'S_F\tF作業員\tperson\tmid\tS_WORKGROUP\tp7',
        'S_H\tH作業員\tperson\thigh\tS_WORKGROUP\tp7',
        'S_I\tI作業員\tperson\thigh\tS_WORKGROUP\tp7',
        'S_J\tJ作業員\tperson\tlow\tS_WORKGROUP\tp7',
        'S_SUB\t下請会社\torganization\tlow\t-\tp1',
        'S_TOBU\t東武鉄道株式会社\torganization\thigh\t-\tp6',
        'S_DRIVER\t第1020列車運転士\tperson\thigh\tS_TOBU\tp6',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t10:00\t業務受注\t下請会社が業務を受注した\tS_SUB:actor\tp1\trecorded',
        'E2\t10:15\t見張配置\tB列車見張員が配置についた\tS_B:actor\tp2,p3\trecorded',
        'E2b\t10:18\t接近監視\tB列車見張員が前方監視を行った\tS_B:actor\tp3\trecorded',
        'E3\t10:20\t中継配置\tD中継見張員が配置についた\tS_D:actor\tp2,p4\trecorded',
        'E4\t10:25\t散布連絡\tG現場代理人が作業班へ連絡した\tS_G:actor,S_WORKGROUP:confirmed_recipient\tp5\trecorded',
        'E4b\t10:35\t散布作業\tH作業員が軌道内で散布作業を行った\tS_H:actor\tp7\trecorded',
        'E5\t10:45\t列車進入\t第1020列車運転士が進入した\tS_DRIVER:actor\tp6\trecorded',
        'E6\t10:46\t触車死亡\t作業員らが列車と触車し死亡した\tS_DRIVER:actor,S_WORKGROUP:affected,S_A:affected,S_C:affected,S_E:affected,S_F:affected,S_H:affected,S_I:affected,S_J:affected\tp7\trecorded',
        '[帰結]',
        'O1\tidentified\tE6\tp7\t作業員4名死亡',
        '[関係]',
        'R0a\ttransfer\tE2\tS_B\tE3\tS_D\tp3,p4\tinformation\toccurred\tconfirmed',
        'R0b\ttransfer\tE3\tS_D\tE4\tS_G\tp4,p5\tinformation\toccurred\tconfirmed',
        // Soft Merge Guard on S_G -> S_WORKGROUP (informational transfer touching preliminary variation E4)
        'R1\ttransfer\tE4\tS_G\tE6\tS_WORKGROUP\tp5,p7\tinformation\toccurred\tconfirmed',
        'R2\timpact\tE5\tS_DRIVER\tE6\tS_WORKGROUP\tp6,p7\tother\toccurred\tna',
        '[仮判定]',
        'E4\tvariation\t見張り体制不備のまま散布連絡\tp5',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);

      // 1. Even before explicit merge (#0), soft Merge Guard on S_G yields to S_SUB's reserved slot so total lanes <= 6 and S_SUB keeps its real name
      const initial = consolidateSubjects(base, 6);
      expect(initial.entities).toHaveLength(6);
      expect(initial.entities.some((e) => e.id === 'subject_others')).toBe(false);
      expect(initial.entities.some((e) => e.id === 'S_SUB')).toBe(true);
      // 0-participation S_TOBU (even with focus: high) does not steal a primary slot
      expect(initial.entities.some((e) => e.id === 'S_TOBU')).toBe(false);

      // 2. When S_H -> S_WORKGROUP is explicitly merged (#1), lower-ranked mergeable sibling S_I cascades into S_WORKGROUP instead of popping up as a new lane
      const afterMergeH = consolidateSubjects(base, 6, undefined, undefined, {
        explicitMerges: new Map([['S_H', 'S_WORKGROUP']]),
      });
      const retainedIds = afterMergeH.entities.map((e) => e.id);
      expect(retainedIds).toHaveLength(6);
      expect(retainedIds).toEqual(
        expect.arrayContaining(['S_WORKGROUP', 'S_B', 'S_D', 'S_G', 'S_DRIVER', 'S_SUB'])
      );
      expect(retainedIds).not.toContain('S_H');
      expect(retainedIds).not.toContain('S_I');
      expect(retainedIds).not.toContain('S_TOBU');
      expect(retainedIds).not.toContain('subject_others');
      const ranks = afterMergeH.subjectRanking?.ranks ?? [];
      expect(ranks.find((r) => r.entityId === 'S_I')?.mergedInto).toBe('S_WORKGROUP');
      expect(ranks.find((r) => r.entityId === 'S_TOBU')?.excluded).toBe(true);

      // 3. Round-tripping through validateSavedAnalysis preserves excluded, mergeBlockedReason, isInfluential, and parentEntityIds (ADR-0070)
      const roundTripped = validateSavedAnalysis(JSON.parse(JSON.stringify(afterMergeH)));
      const savedRanks = roundTripped.subjectRanking?.ranks ?? [];
      expect(savedRanks.find((r) => r.entityId === 'S_TOBU')?.excluded).toBe(true);
      expect(savedRanks.find((r) => r.entityId === 'S_TOBU')?.retained).toBe(false);
    });

    it('rebalances over-represented Poset family to keep multiple independent organizations out of subject_others and resolves 2-level child merges transitively (ADR-0071)', () => {
      const source = [
        'p1 東武鉄道（北関東工務事務所等）が軌道内作業計画を承認・監督した。',
        'p2 下請会社が除草薬散布作業を受注し作業班を編成した。',
        'p3 A作業指揮者・C中継見張員・D中継見張員が作業打ち合わせを行った。',
        'p4 B列車見張員が見張り配置につき前方監視を開始した。',
        'p5 G現場代理人が進行状況を確認した。',
        'p6 作業員ら（E・F・H・I・J）およびF作業員が線路内で除草薬散布を実施した。',
        'p7 第1020列車運転士が接近し作業員らと触車して死亡事故が発生した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'S_WORK\t作業班\torganization\thigh\t-\tp2,p6',
        'A_LEAD\tA作業指揮者\tperson\tmid\tS_WORK\tp3',
        'A_LOOK_B\tB列車見張員\tperson\thigh\tS_WORK\tp4',
        'A_LOOK_C\tC中継見張員\tperson\tmid\tS_WORK\tp3',
        'A_LOOK_D\tD中継見張員\tperson\tmid\tS_WORK\tp3',
        'A_REP_G\tG現場代理人\tperson\thigh\tS_WORK\tp5',
        'A_W_EFHIJ\t作業員ら（E・F・H・I・J）\torganization\thigh\tS_WORK\tp6,p7',
        'A_W_F\tF作業員\tperson\tmid\tA_W_EFHIJ\tp6',
        'A_DRV\t第1020列車運転士\tperson\thigh\t-\tp7',
        'S_SUB\t下請会社\torganization\tmid\t-\tp2',
        'S_TOBU\t東武鉄道（北関東工務事務所等）\torganization\tmid\t-\tp1',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:30\t計画監督\t東武鉄道が計画を監督した\tS_TOBU:actor\tp1\trecorded',
        'E2\t09:45\t作業受注\t下請会社が作業班を編成した\tS_SUB:actor,S_WORK:confirmed_recipient\tp2\trecorded',
        'E3\t10:10\t打合せ\tA指揮者・C中継員・D中継員が確認した\tA_LEAD:actor,A_LOOK_C:actor,A_LOOK_D:actor\tp3\trecorded',
        'E4\t10:20\t見張り開始\tB見張員が見張りを開始した\tA_LOOK_B:actor\tp4\trecorded',
        'E5\t10:25\t見張り継続\tB見張員が監視を継続した\tA_LOOK_B:actor\tp4\trecorded',
        'E6\t10:30\t進行確認\tG現場代理人が確認した\tA_REP_G:actor\tp5\trecorded',
        'E7\t10:40\t散布実施\t作業員らとF作業員が散布した\tA_W_EFHIJ:actor,A_W_F:actor\tp6\trecorded',
        'E8\t10:46\t列車触車\t第1020列車運転士の列車と作業員らが触車した\tA_DRV:actor,A_W_EFHIJ:affected\tp7\trecorded',
        '[帰結]',
        'O1\tidentified\tE8\tp7\t作業員死亡',
        '[関係]',
        'R1\ttransfer\tE1\tS_TOBU\tE2\tS_SUB\tp1,p2\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE2\tS_SUB\tE3\tA_LEAD\tp2,p3\tinformation\toccurred\tconfirmed',
        'R3\timpact\tE8\tA_DRV\tE8\tA_W_EFHIJ\tp7\tother\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const consolidated = consolidateSubjects(base, 6);
      const retainedIds = consolidated.entities.map((e) => e.id);

      // All 6 lanes are real named actors/organizations (0 subject_others), including both S_TOBU and S_SUB
      expect(retainedIds).toHaveLength(6);
      expect(retainedIds).not.toContain('subject_others');
      expect(retainedIds).toEqual(
        expect.arrayContaining(['S_WORK', 'A_DRV', 'S_TOBU', 'S_SUB'])
      );
      // 2-level descendant A_W_F always resolves to a retained lane (either A_W_EFHIJ or S_WORK)
      const fRank = consolidated.subjectRanking?.ranks.find((r) => r.entityId === 'A_W_F');
      expect(fRank?.mergedInto).toBeDefined();
      expect(retainedIds).toContain(fRank!.mergedInto!);
    });

    it('gently expands to maxSubjects + 1 (7 lanes) when strict Merge Guards and substantive independent organizations make 6 lanes over-constrained, and excludes 0-event intermediate Poset orgs transitively (ADR-0071)', () => {
      const source = [
        'p1 東武鉄道が安全規程を指示した。',
        'p2 下請会社が現場要員を派遣した。',
        'p3 B見張員と作業班が相互確認した。',
        'p4 G代理人が負傷者救護のため人員移送を実施した。',
        'p5 作業員らが被災した。',
        'p6 運転士が非常制動を扱った。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'TOBU\t東武鉄道\torganization\thigh\t-\tp1',
        'TRAIN_1020\t第1020列車\torganization\tmid\tTOBU\t-',
        'DRIVER\t第1020列車運転士\tperson\thigh\tTRAIN_1020\tp6',
        'SUB_CO\t下請会社\torganization\thigh\t-\tp2',
        'S_WORK\t作業班\torganization\thigh\t-\tp3,p5',
        'A_LOOK_B\tB列車見張員\tperson\thigh\tS_WORK\tp3',
        'A_REP_G\tG現場代理人\tperson\thigh\tS_WORK\tp4',
        'A_WORKERS\t被災作業員ら\tperson\thigh\tS_WORK\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t安全指示\t東武鉄道と運転士が運行規程を相互確認した\tTOBU:actor,DRIVER:actor\tp1,p6\trecorded',
        'E2\t09:10\t要員派遣\t下請会社が要員を派遣した\tSUB_CO:actor\tp2\trecorded',
        'E3\t10:00\t相互確認\tB見張員と作業班が相互確認した\tA_LOOK_B:actor,S_WORK:actor\tp3\trecorded',
        'E4\t10:46\t触車被災\t運転士の列車と被災作業員らが触車した\tDRIVER:actor,A_WORKERS:affected\tp5,p6\trecorded',
        'E5\t10:48\t救護移送\tG代理人が作業班へ救護要員を移送した\tA_REP_G:actor,S_WORK:confirmed_recipient\tp4\trecorded',
        '[帰結]',
        'O1\tidentified\tE4:loss,E5:recovery\tp4,p5\t触車損失と救護回復',
        '[関係]',
        // Strict Merge Guards on DRIVER vs TOBU and all 3 S_WORK children -> 7 irreducible roles vs maxSubjects=6
        'R0\tmutual\tE1\tTOBU\tE1\tDRIVER\tp1,p6\tinformation\toccurred\tna',
        'R1\tmutual\tE3\tA_LOOK_B\tE3\tS_WORK\tp3\tinformation\toccurred\tna',
        'R2\ttransfer\tE5\tA_REP_G\tE5\tS_WORK\tp4\tperson\toccurred\tconfirmed',
        'R3\timpact\tE4\tDRIVER\tE4\tA_WORKERS\tp5,p6\tother\toccurred\tna',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const consolidated = consolidateSubjects(base, 6);
      const retainedIds = consolidated.entities.map((e) => e.id);

      // Gentle lane-overflow penalty allows 7 named lanes (+1 over maxSubjects=6) rather than violating strict Merge Guards or creating subject_others
      expect(retainedIds).toHaveLength(7);
      expect(retainedIds).not.toContain('subject_others');
      expect(retainedIds).toEqual(
        expect.arrayContaining(['TOBU', 'DRIVER', 'SUB_CO', 'S_WORK', 'A_LOOK_B', 'A_REP_G', 'A_WORKERS'])
      );

      // 0-participation intermediate Poset org TRAIN_1020 is excluded (not merged), while DRIVER's parent resolves transitively to TOBU
      const trainRank = consolidated.subjectRanking?.ranks.find((r) => r.entityId === 'TRAIN_1020');
      expect(trainRank?.excluded).toBe(true);
      expect(trainRank?.mergedInto).toBeUndefined();
      const driverEnt = consolidated.entities.find((e) => e.id === 'DRIVER');
      expect(driverEnt?.parentEntityId).toBe('TOBU');
    });

    it('implements 2-stage K_pre / K_post consolidation: forbids subject_others during intermediate Poset phase and deterministically folds non-variation peripheral subjects in final phase (ADR-0072)', () => {
      expect(derivePreConsolidationLimit(5)).toBe(8);
      expect(derivePreConsolidationLimit(6)).toBe(9);
      expect(derivePreConsolidationLimit(10)).toBe(12);
      expect(derivePreConsolidationLimit(6, 7)).toBe(7);
      expect(derivePreConsolidationLimit(6, 4)).toBe(6);

      const source = [
        'p1 東武鉄道北関東工務事務所が除草薬散布作業を発注した。',
        'p2 下請会社が業務を受注し除草薬散布作業班を手配した。',
        'p3 除草薬散布作業班が現場到着後に機材準備を実施した。',
        'p4 B列車見張員が列車見張り配置を離れた。',
        'p5 G現場代理人が安全確認を省略して線路内進入を指示した。',
        'p6 作業員（E・H・I・J）が線路内で散布作業を継続した。',
        'p7 第1020列車運転士の列車と作業員が触車し4名が死亡した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_TOBU\t東武鉄道株式会社\torganization\tmid\t-\t-',
        'A_TOBU_OF\t東武鉄道北関東工務事務所\torganization\tlow\tA_TOBU\tp1',
        'A_DRV\t第1020列車運転士\tperson\thigh\tA_TOBU\tp7',
        'A_SUB\t下請会社\torganization\tlow\t-\tp2',
        'A_CREW\t除草薬散布作業班\torganization\thigh\t-\tp3',
        'A_B\tB列車見張員\tperson\thigh\tA_CREW\tp4',
        'A_G\tG現場代理人\tperson\thigh\tA_CREW\tp5',
        'A_WRK\t作業員（E・H・I・J）\torganization\thigh\tA_CREW\tp6,p7',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t08:00\t業務発注\t工務事務所が散布作業を発注した\tA_TOBU_OF:actor\tp1\trecorded',
        'E2\t08:30\t業務受注\t下請会社が受注し作業班を手配した\tA_SUB:actor\tp2\trecorded',
        'E3\t10:00\t機材準備\t作業班が機材準備を実施した\tA_CREW:actor\tp3\trecorded',
        'E4\t10:40\t見張り離脱\tB見張員が見張り配置を離れた\tA_B:actor\tp4\trecorded',
        'E5\t10:42\t進入指示\tG代理人が安全確認を省略して指示した\tA_G:actor\tp5\trecorded',
        'E6\t10:44\t散布継続\t作業員が線路内で散布作業を継続した\tA_WRK:actor\tp6\trecorded',
        'E7\t10:46\t列車触車\t運転士の列車と作業員が触車し死亡した\tA_DRV:actor,A_WRK:affected\tp7\trecorded',
        '[帰結]',
        'O1\tidentified\tE7\tp7\t作業員4名死亡',
        '[関係]',
        'R1\ttransfer\tE1\tA_TOBU_OF\tE2\tA_SUB\tp1,p2\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE2\tA_SUB\tE3\tA_CREW\tp2,p3\tinformation\toccurred\tconfirmed',
        'R3\timpact\tE4\tA_B\tE6\tA_WRK\tp4,p6\tother\toccurred\tna',
        'R3b\tmutual\tE4\tA_B\tE3\tA_CREW\tp3,p4\tinformation\toccurred\tna',
        'R4\ttransfer\tE5\tA_G\tE6\tA_WRK\tp5,p6\tinformation\toccurred\tconfirmed',
        'R4b\tmutual\tE5\tA_G\tE3\tA_CREW\tp3,p5\tinformation\toccurred\tna',
        'R5\timpact\tE6\tA_WRK\tE7\tA_DRV\tp6,p7\tother\toccurred\tna',
        'R5b\timpact\tE3\tA_CREW\tE6\tA_WRK\tp3,p6\tother\toccurred\tna',
        '[仮判定]',
        'E4\tvariation\t見張り離脱\tp4',
        'E5\tvariation\t安全確認省略\tp5',
        'E6\tvariation\t退避せず作業継続\tp6',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const kPre = derivePreConsolidationLimit(6); // 9

      // Phase 1 (Stage 2 intermediate): allowSubjectOthers: false keeps A_TOBU_OF and A_SUB as real named lanes!
      const stage2Analysis = consolidateSubjects(base, kPre, undefined, undefined, {
        allowSubjectOthers: false,
        preConsolidationMaxSubjects: kPre,
      });
      const stage2Ids = stage2Analysis.entities.map((e) => e.id);
      expect(stage2Ids).not.toContain('subject_others');
      expect(stage2Ids).toEqual(
        expect.arrayContaining(['A_TOBU_OF', 'A_SUB', 'A_DRV', 'A_CREW', 'A_B', 'A_G', 'A_WRK'])
      );
      expect(stage2Analysis.subjectRanking?.preConsolidationMaxSubjects).toBe(kPre);

      // Phase 2 (Stage 3.5 final): 7 active lanes -> K_post = 6 folds A_TOBU_OF and A_SUB (non-variation connected) into subject_others
      const stage2Schema = projectAnalysis(stage2Analysis);
      const finalRes = consolidatePeripheralSubjectsToOthers(stage2Schema, 6, {
        othersConsolidationMode: 'deterministic',
      });
      expect(finalRes.foldedEntityIds).toEqual(['A_TOBU_OF', 'A_SUB']);
      expect(finalRes.schema.lanes[0]).toBe('その他の関係者');
      const finalEntityIds = finalRes.analysis.entities.map((e) => e.id);
      expect(finalEntityIds).toHaveLength(6);
      expect(finalEntityIds).toEqual(
        expect.arrayContaining(['A_DRV', 'A_CREW', 'A_B', 'A_G', 'A_WRK'])
      );
      expect(finalEntityIds.some((id) => isPeripheralAggregateId(id))).toBe(true);
      // Lossless round-trip back to all 8 original entities
      const reverted = revertConsolidation(finalRes.analysis);
      expect(reverted.entities).toHaveLength(8);
      expect(reverted.relations.find((r) => r.id === 'R1')?.sourceEntityId).toBe('A_TOBU_OF');
      expect(reverted.relations.find((r) => r.id === 'R2')?.sourceEntityId).toBe('A_SUB');

      // LLM-assisted mode: even if LLM erroneously suggests outcome actor A_DRV, Hard Protection blocks A_DRV!
      const llmAssistedRes = consolidatePeripheralSubjectsToOthers(stage2Schema, 6, {
        othersConsolidationMode: 'llm_assisted',
        llmPeripheralSectionPresent: true,
        llmPeripheralEntityIds: new Set(['A_DRV', 'A_SUB']),
      });
      expect(llmAssistedRes.foldedEntityIds).not.toContain('A_DRV');
      expect(llmAssistedRes.foldedEntityIds[0]).toBe('A_SUB');
      expect(llmAssistedRes.foldedEntityIds).toContain('A_TOBU_OF');
    });

    it('protects :affected human participants in :loss outcomes and enforces sibling/soft Merge Guards in Sub-step B1 so deceased crew are never silently rolled up into parent org (ADR-0074 / RM-VTA-03, RM-VTA-04)', () => {
      const source = [
        'p1 海上保安庁が運航管理体制を定めていた。',
        'p2 羽田通信がA機へ物資連絡を行った。',
        'p3 デリバリー管制官が出発経路を伝達した。',
        'p4 タワー東管制官がC5停止線までの走行を指示した。',
        'p5 機長Aと副操縦士Aが復唱し、機長Aが滑走路へ進入した。',
        'p6 B機機長が着陸滑走中にA機と衝突・炎上し、副操縦士AおよびA機搭乗乗組員4名が死亡、機長Aが重傷を負った。',
        'p7 空港消防が出動し消火活動を行った。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'ORG_JCG\t海上保安庁\torganization\tmid\t-\tp1',
        'A_PIC\t機長A\tperson\thigh\tORG_JCG\tp5,p6',
        'A_COP\t副操縦士A\tperson\thigh\tORG_JCG\tp5,p6',
        'A_CREW\tA機搭乗乗組員\tperson\tmid\tORG_JCG\tp6',
        'JCG_COMM\t羽田通信\torganization\tlow\tORG_JCG\tp2',
        'ORG_ATC\t東京飛行場管制所\torganization\tmid\t-\tp3,p4',
        'ATC_DELIV\tデリバリー管制官\tperson\tlow\tORG_ATC\tp3',
        'ATC_TWR_E\tタワー東管制官\tperson\thigh\tORG_ATC\tp4',
        'B_PIC\t機長B\tperson\thigh\t-\tp6',
        'ORG_FIRE\t空港消防\torganization\tlow\t-\tp7',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t16:45\t運航管理\t海上保安庁が運航管理体制を定めた\tORG_JCG:actor\tp1\trecorded',
        'E2\t17:00\t物資連絡\t羽田通信がA機へ物資連絡を行った\tJCG_COMM:actor,A_COP:confirmed_recipient\tp2\trecorded',
        'E3\t17:30\t出発経路伝達\tデリバリー管制官が伝達した\tATC_DELIV:actor,A_COP:confirmed_recipient\tp3\trecorded',
        'E4\t17:43\t走行指示\tタワー東管制官がC5停止線までを指示した\tATC_TWR_E:actor\tp4\trecorded',
        'E5\t17:45\t復唱と進入\t副操縦士Aが復唱し機長Aが滑走路へ進入した\tA_COP:actor,A_PIC:actor\tp5\trecorded',
        'E6\t17:47\t衝突・炎上と乗組員死亡\tB機とA機が衝突し副操縦士AとA機搭乗乗組員が死亡した\tB_PIC:actor,A_PIC:affected,A_COP:affected,A_CREW:affected\tp6\trecorded',
        'E7\t17:48\t消火出動\t空港消防が出動した\tORG_FIRE:actor\tp7\trecorded',
        '[帰結]',
        'O1\tidentified\tE6:loss\tp6\t衝突炎上・乗組員5名死亡',
        '[関係]',
        'R1\ttransfer\tE2\tJCG_COMM\tE5\tA_COP\tp2,p5\tinformation\toccurred\tconfirmed',
        'R2\ttransfer\tE3\tATC_DELIV\tE4\tATC_TWR_E\tp3,p4\tinformation\toccurred\tconfirmed',
        'R3\ttransfer\tE4\tATC_TWR_E\tE5\tA_COP\tp4,p5\tinformation\toccurred\tconfirmed',
        'R4\timpact\tE5\tA_PIC\tE6\tB_PIC\tp5,p6\tother\toccurred\tna',
        '[仮判定]',
        'E5\tvariation\t滑走路誤進入\tp5',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const kPre = derivePreConsolidationLimit(6); // 9
      const stage2 = consolidateSubjects(base, kPre, undefined, undefined, {
        allowSubjectOthers: false,
        preConsolidationMaxSubjects: kPre,
      });
      const stage2Schema = projectAnalysis(stage2);

      const finalRes = consolidatePeripheralSubjectsToOthers(stage2Schema, 6, {
        othersConsolidationMode: 'deterministic',
      });
      const finalEntityIds = finalRes.analysis.entities.map((e) => e.id);

      // 0-event container ORG_ATC is pruned in Stage 2 BnB (10 -> K_pre=9), JCG_COMM rolls up into ORG_JCG in Sub-step B1,
      // and peripheral ATC_DELIV + ORG_FIRE fold into subject_others in Sub-step B2
      const atcRank = finalRes.analysis.subjectRanking?.ranks.find((r) => r.entityId === 'ORG_ATC');
      expect(atcRank?.excluded).toBe(true);
      expect(atcRank?.consolidationStage).toBe('stage2_bnb');
      const delivRank = finalRes.analysis.subjectRanking?.ranks.find((r) => r.entityId === 'ATC_DELIV');
      expect(isPeripheralAggregateId(delivRank?.mergedInto)).toBe(true);
      expect(delivRank?.consolidationStage).toBe('stage2.5_b2_others');
      expect(finalRes.rolledUpPosetEntityIds).toContain('JCG_COMM');
      // Deceased :affected participants A_COP and A_CREW must NEVER be silently absorbed into ORG_JCG or subject_others!
      expect(finalRes.rolledUpPosetEntityIds).not.toContain('A_COP');
      expect(finalRes.rolledUpPosetEntityIds).not.toContain('A_CREW');
      expect(finalRes.foldedEntityIds).not.toContain('A_COP');
      expect(finalRes.foldedEntityIds).not.toContain('A_CREW');
      expect(finalEntityIds).toContain('A_COP');
      expect(finalEntityIds).toContain('A_CREW');

      // Consolidation stage metadata is recorded on merged subjects
      const commRank = finalRes.analysis.subjectRanking?.ranks.find((r) => r.entityId === 'JCG_COMM');
      expect(commRank?.consolidationStage).toBe('stage2.5_b1_poset');
    });

    it('unifies Final Phase into solveOptimalSubjectRetention so ORG_TOBU_OF + ORG_SUB fold into subject_others while preserving D_LOOK and F_WORK (ADR-0075)', () => {
      const source = [
        'p1 東武鉄道北関東工務事務所が散布作業を発注した。',
        'p2 下請会社が受注し、F作業員・H・I・J作業員を派遣手配した。',
        'p3 除草薬散布作業班が現場準備を行い、A作業指揮者・B列車見張員・D中継見張員・G現場代理人が配置についた。',
        'p4 B列車見張員とD中継見張員が移動調整を行い、D中継見張員が中継配置を離れた。',
        'p5 F作業員がA作業指揮者の介入指示のもと散布ホースを移動した。',
        'p6 第1020列車運転士の列車とG現場代理人・H・I・J作業員が触車し4名が死亡した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'ORG_TOBU\t東武鉄道株式会社\torganization\tmid\t-\t-',
        'ORG_TOBU_OF\t東武鉄道北関東工務事務所\torganization\tlow\tORG_TOBU\tp1',
        'ORG_SUB\t下請会社\torganization\tlow\t-\tp2',
        'TEAM_WORK\t除草薬散布作業班\torganization\thigh\t-\tp3',
        'A_LEAD\tA作業指揮者\tperson\thigh\tTEAM_WORK\tp3,p5',
        'B_LOOK\tB列車見張員\tperson\thigh\tTEAM_WORK\tp3,p4',
        'D_LOOK\tD中継見張員\tperson\tmid\tTEAM_WORK\tp3,p4',
        'G_REP\tG現場代理人\tperson\thigh\tTEAM_WORK\tp3,p6',
        'F_WORK\tF作業員\tperson\tmid\tTEAM_WORK\tp2,p5',
        'HIJ_WORK\tH・I・J作業員\tperson\thigh\tTEAM_WORK\tp2,p6',
        'D_TRAIN\t第1020列車運転士\tperson\thigh\tORG_TOBU\tp6',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E0\t08:00\t業務発注\t工務事務所が発注した\tORG_TOBU_OF:actor\tp1\trecorded',
        // Shared event E1 across ORG_SUB (low, 1-card) and F_WORK / HIJ_WORK with preliminary variation
        'E1\t08:30\t派遣手配\t下請会社がF作業員・HIJ作業員を手配した\tORG_SUB:actor,F_WORK:confirmed_recipient,HIJ_WORK:confirmed_recipient\tp2\trecorded',
        'E2\t10:00\t作業班準備\t作業班とA指揮者・G代理人が準備した\tTEAM_WORK:actor,A_LEAD:actor,G_REP:actor\tp3\trecorded',
        'E3\t10:35\t中継移動\tB見張員とD中継見張員が人員移動しDが配置を離れた\tB_LOOK:actor,D_LOOK:actor\tp4\trecorded',
        'E4\t10:40\tホース移動\tF作業員がA指揮者の指示でホースを移動した\tA_LEAD:actor,F_WORK:actor\tp5\trecorded',
        'E5\t10:46\t列車触車・死亡\t運転士の列車とG代理人・HIJ作業員が触車し死亡した\tD_TRAIN:actor,G_REP:affected,HIJ_WORK:affected\tp6\trecorded',
        '[帰結]',
        'O1\tidentified\tE5:loss\tp6\t4名触車死亡',
        '[関係]',
        'R0\ttransfer\tE0\tORG_TOBU_OF\tE2\tTEAM_WORK\tp1,p3\tinformation\toccurred\tconfirmed',
        // Strict person transfer guard between B_LOOK and D_LOOK
        'R1\ttransfer\tE3\tB_LOOK\tE3\tD_LOOK\tp4\tperson\toccurred\tconfirmed',
        // Soft dependency guard touching variation E4 between A_LEAD and F_WORK
        'R2\tdependency\tE2\tA_LEAD\tE4\tF_WORK\tp3,p5\t-\t-\tna',
        'R3\timpact\tE3\tD_LOOK\tE5\tG_REP\tp4,p6\tother\toccurred\tna',
        '[仮判定]',
        'E1\tvariation\t見張員不足の手配\tp2',
        'E3\tvariation\t中継見張配置離脱\tp4',
        'E4\tvariation\t退避確認前のホース移動\tp5',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      const stage2 = consolidateSubjects(base, 10, undefined, undefined, {
        allowSubjectOthers: false,
        preConsolidationMaxSubjects: 10,
      });
      const stage2Schema = projectAnalysis(stage2);

      const finalRes = consolidatePeripheralSubjectsToOthers(stage2Schema, 7, {
        othersConsolidationMode: 'deterministic',
      });
      const finalEntityIds = finalRes.analysis.entities.map((e) => e.id);

      // ORG_TOBU_OF and ORG_SUB fold cleanly into subject_others, while D_LOOK and F_WORK stay as independent named lanes!
      expect(finalRes.foldedEntityIds).toEqual(expect.arrayContaining(['ORG_TOBU_OF', 'ORG_SUB']));
      expect(finalRes.rolledUpPosetEntityIds).not.toContain('D_LOOK');
      expect(finalRes.rolledUpPosetEntityIds).not.toContain('F_WORK');
      expect(finalEntityIds).toEqual(
        expect.arrayContaining(['TEAM_WORK', 'A_LEAD', 'B_LOOK', 'D_LOOK', 'G_REP', 'F_WORK', 'HIJ_WORK', 'D_TRAIN'])
      );
      expect(finalEntityIds.some((id) => isPeripheralAggregateId(id))).toBe(true);
      // Merged entities never carry stale mergeBlockedReason
      for (const r of finalRes.analysis.subjectRanking?.ranks ?? []) {
        if (!r.retained) {
          expect(r.mergeBlockedReason).toBeUndefined();
        }
      }
    });

    it('coalesces identical-role homogeneous sibling clones (H作業員, I作業員, J作業員 -> H作業員) without mutating entity.name so key actors like D中継見張員 stay retained, while preserving distinct roles (ADR-0077)', () => {
      const source = [
        'p1 除草作業班のA作業指揮者・B列車見張員・D中継見張員・G現場代理人が準備した。',
        'p2 D中継見張員が配置を移動し、中継見張りが途切れた。',
        'p3 E作業員とF作業員が法面で補助作業を行った。',
        'p4 G現場代理人の指示でH作業員、I作業員、J作業員が線路内で散布を継続した。',
        'p5 第1020列車運転士の列車とG現場代理人・H作業員・I作業員・J作業員が触車し死亡した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_TEAM\t除草作業班\torganization\thigh\t-\tp1',
        'A1\tA作業指揮者\tperson\thigh\tA_TEAM\tp1',
        'A2\tB列車見張員\tperson\thigh\tA_TEAM\tp1',
        'A4\tD中継見張員\tperson\tmid\tA_TEAM\tp1,p2',
        'A5\tE作業員\tperson\tlow\tA_TEAM\tp3',
        'A6\tF作業員\tperson\tlow\tA_TEAM\tp3',
        'A7\tG現場代理人\tperson\thigh\tA_TEAM\tp1,p4,p5',
        'A8\tH作業員\tperson\thigh\tA_TEAM\tp4,p5',
        'A9\tI作業員\tperson\thigh\tA_TEAM\tp4,p5',
        'A10\tJ作業員\tperson\thigh\tA_TEAM\tp4,p5',
        'A_DRV\t第1020列車運転士\tperson\thigh\t-\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t10:00\t作業準備\tA指揮者・B見張員・G代理人が準備した\tA_TEAM:actor,A1:actor,A2:actor,A7:actor\tp1\trecorded',
        'E2\t10:35\t中継見張員離脱\tD中継見張員が配置を離れた\tA4:actor\tp2\trecorded',
        'E3\t10:38\t法面作業\tE作業員とF作業員が補助作業した\tA5:actor,A6:actor\tp3\trecorded',
        'E4\t10:42\t線路内散布\tG代理人とH・I・J作業員が散布を継続した\tA7:actor,A8:actor,A9:actor,A10:actor\tp4\trecorded',
        'E5\t10:46\t列車触車・4名死亡\t列車とG代理人・H・I・J作業員が触車し死亡した\tA_DRV:actor,A7:affected,A8:affected,A9:affected,A10:affected\tp5\trecorded',
        '[帰結]',
        'O1\tidentified\tE5:loss\tp5\t4名死亡',
        '[関係]',
        'R1\timpact\tE2\tA4\tE4\tA7\tp2,p4\tother\toccurred\tna',
        'R2\timpact\tE4\tA7\tE5\tA_DRV\tp4,p5\tother\toccurred\tna',
        '[仮判定]',
        'E2\tvariation\t中継配置離脱\tp2',
        'E4\tvariation\t退避せず作業継続\tp4',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      // 11 subjects consolidated to limit = 7: without clone coalescing, A8/A9/A10 eat 3 loss-protected slots and evict A4!
      const consolidated = consolidateSubjects(base, 7, undefined, undefined, {
        allowSubjectOthers: false,
        preConsolidationMaxSubjects: 7,
      });

      const retainedIds = consolidated.entities.map((e) => e.id);
      expect(retainedIds).toContain('A8');
      expect(retainedIds).not.toContain('A9');
      expect(retainedIds).not.toContain('A10');
      expect(retainedIds).toContain('A4');
      // Representative entity.name stays immutable (no string concatenation)
      const repEntity = consolidated.entities.find((e) => e.id === 'A8')!;
      expect(repEntity.name).toBe('H作業員');
      expect(repEntity.mergedFrom).toEqual(['A9', 'A10']);

      const reverted = revertConsolidation(consolidated);
      expect(reverted.entities).toHaveLength(11);

      // Distinct role base-names (機上整備員A vs 機上通信員A) must NEVER coalesce even when participations match
      const distinctSource = 'p1 管制所の管制官1が連絡した。\np2 海上保安庁の機上整備員Aと機上通信員Aが搭乗し衝突で被災した。';
      const distinctLedger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'ORG_JCG\t海上保安庁\torganization\thigh\t-\tp2',
        'M_MAINT\t機上整備員A\tperson\thigh\tORG_JCG\tp2',
        'M_COMM\t機上通信員A\tperson\thigh\tORG_JCG\tp2',
        'ORG_ATC\t管制所\torganization\tmid\t-\tp1',
        'P_OTHER1\t管制官1\tperson\tlow\tORG_ATC\tp1',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E0\t17:00\t事前連絡\t管制所と管制官1が連絡した\tORG_ATC:actor,P_OTHER1:actor\tp1\trecorded',
        'E1\t17:47\t衝突被災\t整備員Aと通信員Aが被災した\tORG_JCG:affected,M_MAINT:affected,M_COMM:affected\tp2\trecorded',
        '[帰結]',
        'O1\tidentified\tE1:loss\tp2\t衝突被災',
        '[関係]',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');
      const distinctRes = consolidateSubjects(buildLedgerAnalysis(distinctLedger, distinctSource), 4, undefined, undefined, {
        allowSubjectOthers: false,
      });
      const distinctIds = distinctRes.entities.map((e) => e.id);
      expect(distinctIds).toContain('M_MAINT');
      expect(distinctIds).toContain('M_COMM');
      expect(distinctRes.entities.find((e) => e.id === 'M_MAINT')?.mergedFrom).toBeUndefined();
    });

    it('enables 0-event multi-child Poset hub (A_JAL), avoids false strictAsymmetry among shared-recovery participants, and preserves high-focus protagonist A_TWR_E (ADR-0078)', () => {
      const source = [
        'p1 海上保安庁と機長A・副操縦員Aが連絡・走行した。',
        'p2 東京空港事務所のグラウンド東と出域調整席が調整し、タワー東管制官が離着陸許可・監視を実施した。',
        'p3 機長Bと訓練乗員が着陸進入し、滑走路上で機長A・副操縦員Aと衝突した。',
        'p4 先任CA(L1)・CA(R1)・CA(L4)・他CA・B機乗客が避難行動をとり全員脱出完了した。',
        'p5 空港消防が消火活動を実施した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_JCG\t海上保安庁\torganization\thigh\t-\tp1',
        'A_CAP\t機長A\tperson\thigh\tA_JCG\tp1,p3',
        'A_COP\t副操縦員A\tperson\thigh\tA_JCG\tp1,p3',
        // A_JAL has 0 direct events, serving as Poset parent of 7 JAL crew/passenger subjects
        'A_JAL\t日本航空株式会社\torganization\thigh\t-\tp3',
        'A_JAL_CAP\t機長B\tperson\thigh\tA_JAL\tp3,p4',
        'A_JAL_TRN\t訓練乗員B\tperson\thigh\tA_JAL\tp3,p4',
        'A_JAL_CA_L1\t先任客室乗務員L1\tperson\tmid\tA_JAL\tp4',
        'A_JAL_CA_R1\t客室乗務員R1\tperson\tmid\tA_JAL\tp4',
        'A_JAL_CA_L4\t客室乗務員L4\tperson\tmid\tA_JAL\tp4',
        'A_JAL_CA_OTH\t客室乗務員他\tperson\tlow\tA_JAL\tp4',
        'A_JAL_PAX\tB機乗客\tperson\tmid\tA_JAL\tp4',
        'A_CAB\t東京空港事務所\torganization\thigh\t-\tp2',
        'A_TWR_E\tタワー東管制官\tperson\thigh\tA_CAB\tp2',
        'A_GND_E\tグラウンド東管制官\tperson\tmid\tA_CAB\tp2',
        'A_DF\t出域調整席管制官\tperson\tlow\tA_CAB\tp2',
        'A_FIRE\t空港消防\torganization\tmid\t-\tp5',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t17:00\t運航連絡\t海保と機長A・副操縦員Aが確認した\tA_JCG:actor,A_CAP:actor,A_COP:actor\tp1\trecorded',
        'E2\t17:43\t管制調整\t空港事務所・GND・DFが調整しタワー東が許可を出した\tA_CAB:actor,A_GND_E:actor,A_DF:actor,A_TWR_E:actor\tp2\trecorded',
        'E3\t17:45\t滑走路監視不備\tタワー東管制官が滑走路占有を認識しなかった\tA_TWR_E:actor\tp2\trecorded',
        'E4\t17:47\t両機の衝突\t両機が衝突した\tA_CAP:affected,A_COP:affected,A_JAL_CAP:affected,A_JAL_TRN:affected\tp3\trecorded',
        'E5\t17:50\t客室避難判断\t客室乗務員と乗客が避難行動をとった\tA_JAL_CA_L1:actor,A_JAL_CA_R1:actor,A_JAL_CA_L4:actor,A_JAL_CA_OTH:actor,A_JAL_PAX:actor\tp4\trecorded',
        'E6\t17:58\t全員脱出完了\tB機全員が脱出完了した\tA_JAL_CAP:affected,A_JAL_TRN:affected,A_JAL_CA_L1:affected,A_JAL_CA_R1:affected,A_JAL_CA_L4:affected,A_JAL_CA_OTH:affected,A_JAL_PAX:affected\tp4\trecorded',
        'E7\t18:00\t消火活動\t空港消防が消火活動を実施した\tA_FIRE:actor\tp5\trecorded',
        '[帰結]',
        'O1\tidentified\tE4:loss,E6:recovery\tp3,p4\t衝突損壊と全員脱出完了',
        '[関係]',
        'R_MUT_JCG\tmutual\tE1\tA_CAP\tE1\tA_COP\tp1\tinformation\toccurred\tconfirmed',
        'R_IMP_JAL\timpact\tE4\tA_JAL_CAP\tE4\tA_JAL_TRN\tp3\tother\toccurred\tna',
        'R_TWR\ttransfer\tE2\tA_TWR_E\tE4\tA_JAL_CAP\tp2,p3\tinformation\toccurred\tconfirmed',
        '[仮判定]',
        'E1\tvariation\t滑走路進入認識ずれ\tp1',
        'E3\tvariation\t監視見落とし\tp2',
        'E5\tvariation:resilient\t緊急脱出の適応的遂行\tp4',
        '[共有カード]',
        '[整理]',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      // Co-evacuating JAL crew/passengers share E6:recovery -> must NOT trigger false strictAsymmetry!
      expect(evaluateMergeGuard('A_JAL_CA_R1', 'A_JAL_CA_OTH', base).allowed).toBe(true);
      expect(evaluateMergeGuard('A_JAL_CA_OTH', 'A_JAL_CAP', base).allowed).toBe(true);

      const consolidated = consolidateSubjects(base, 10, undefined, undefined, {
        allowSubjectOthers: false,
        preConsolidationMaxSubjects: 10,
      });
      const retainedIds = consolidated.entities.map((e) => e.id);

      // 0-event A_JAL hub activates to absorb lower-priority JAL cabin/pax leaves (<= 10 lanes total!),
      // and high-focus protagonist A_TWR_E stays retained as its own lane!
      expect(retainedIds).toContain('A_JAL');
      expect(retainedIds).toContain('A_TWR_E');
      expect(retainedIds.length).toBeLessThanOrEqual(10);
      const jalEntity = consolidated.entities.find((e) => e.id === 'A_JAL')!;
      expect((jalEntity.mergedFrom?.length ?? 0)).toBeGreaterThanOrEqual(2);
    });

    it('does not trigger false strictAsymmetry when a subject only appears passively (:target / :intended_recipient) on an adverse variation event (ADR-0089)', () => {
      const source = [
        'p1 B列車見張員が待避合図を発出したが、D中継見張員（intended_recipient）には届かなかった。',
        'p2 E作業員が自ら待避して安全を確保した。',
      ].join('\n');
      const ledger = [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A_TEAM\t作業班\torganization\thigh\t-\tp1',
        'A_LOOKOUT\tB列車見張員\tperson\thigh\tA_TEAM\tp1',
        'A_RELAY_D\tD中継見張員\tperson\tmid\tA_TEAM\tp1',
        'A_EVAC_E\tE作業員\tperson\tmid\tA_TEAM\tp2',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t10:45\t合図不達\tB列車見張員が合図したがD中継見張員に届かなかった\tA_LOOKOUT:actor,A_RELAY_D:intended_recipient\tp1\trecorded',
        'E2\t10:45\t自力待避\tE作業員が待避した\tA_EVAC_E:actor\tp2\trecorded',
        '[関係]',
        '[共有カード]',
        '[整理]',
        '[帰結]',
        'O1\tnot_found\t-\t-\t損失なし',
        '[仮判定]',
        'E1\tvariation\t合図不達\tp1',
        'E2\tvariation:resilient\t自力待避\tp2',
        '[完了]',
      ].join('\n');

      const base = buildLedgerAnalysis(ledger, source);
      // Active adverse actor A_LOOKOUT vs resilient evacuator A_EVAC_E remains strictly asymmetric
      const activeVsRes = evaluateMergeGuard('A_LOOKOUT', 'A_EVAC_E', base);
      expect(activeVsRes.allowed).toBe(false);
      expect(activeVsRes.strictAsymmetry).toBe(true);

      // Passive intended_recipient A_RELAY_D on E1 must NOT be flagged as pure-adverse against A_EVAC_E
      const passiveVsRes = evaluateMergeGuard('A_RELAY_D', 'A_EVAC_E', base);
      expect(passiveVsRes.allowed).toBe(true);
    });
  });
});
