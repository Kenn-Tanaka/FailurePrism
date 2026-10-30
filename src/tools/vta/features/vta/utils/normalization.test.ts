import { describe, expect, it } from 'vitest';
import { parseLedger, inspectLedger, applyLedgerRepair, ledgerRepairInput, classificationInput, inspectClassifications } from './eventLedger';
import { ledgerFixture, ledgerSource } from './eventLedger.fixture';
import { sourceFromText, projectAnalysis } from './eventAnalysis';
import { validateAndSanitizeProjectFile } from './schemaValidator';
const source = sourceFromText(ledgerSource);
const analyze = (text = ledgerFixture()) => inspectLedger(parseLedger(text), source);

describe('TSV event ledger', () => {
  it('allows only a requested uncertain relation to become a source-linked review without losing events', () => {
    const doc = parseLedger(ledgerFixture().replace('[共有カード]', 'R6\tmutual\tE1\t-\tE2\t-\tp1\tinformation\toccurred\tna\n[共有カード]'));
    const issues = inspectLedger(doc, source).issues;
    expect(issues.map((issue) => issue.row.id)).toEqual(['R6']);
    const repaired = applyLedgerRepair(doc, issues, '[整理]\nR6\treview\tp1\t相互確認の記述\t両端の主体を特定できない\n[完了]');
    const result = inspectLedger(repaired, source);
    expect(result.issues).toEqual([]);
    expect(result.analysis?.events).toHaveLength(2);
    expect(result.analysis?.dispositions).toContainEqual(expect.objectContaining({id:'R6',kind:'review'}));
    expect(() => applyLedgerRepair(doc, issues, '[整理]\nR6\texcluded\tp1\t削除\t不明\n[完了]')).toThrow('指定');
    expect(() => applyLedgerRepair(doc, issues, '[整理]\nR6\treview\tp1\t要確認\t不明\n[関係]\nR6\tbefore\tE1\t-\tE2\t-\tp1\t-\toccurred\tna\n[完了]')).toThrow('指定');
  });
  it('creates source-linked events without generated facts or quotation copies', () => {
    const result = analyze(); expect(result.issues).toEqual([]);
    const analysis = result.analysis!;
    expect(analysis.facts).toEqual([]); expect(analysis.events).toHaveLength(2);
    expect(analysis.events[0].sourceRefs).toEqual([{ sourceId: 'source_1', paragraphId: 'p1' }]);
    expect(analysis.dispositions![0].quote).toBe('');
    expect(analysis.participations).toHaveLength(3);
    expect(validateAndSanitizeProjectFile({ version: '5.0', vtaData: projectAnalysis(analysis) }).isValid).toBe(true);
    expect(validateAndSanitizeProjectFile({ version: '3.0', vtaData: projectAnalysis(analysis) }).isValid).toBe(false);
  });
  it('reports a malformed row without discarding the rest', () => {
    const doc = parseLedger(ledgerFixture().replace('E1\t09:00', 'E1\ttoo\tmany\t09:00'));
    const result = inspectLedger(doc, source);
    expect(result.issues.map((issue) => issue.row.id)).toEqual(['E1']);
    const original = parseLedger(ledgerFixture()).rows.find((row) => row.id === 'E1')!;
    const repaired = applyLedgerRepair(doc, result.issues, '[イベント]\n' + original.cells.join('\t') + '\n[完了]');
    expect(inspectLedger(repaired, source).analysis?.events).toHaveLength(2);
    expect(repaired.rows.find((row) => row.id === 'E2')).toBe(doc.rows.find((row) => row.id === 'E2'));
  });
  it('does not cascade a broken actor row into otherwise well-formed event rows', () => {
    const doc = parseLedger(ledgerFixture().replace('A1\t担当者\tperson', 'A1\t担当者\tbad'));
    expect(inspectLedger(doc, source).issues.map((issue) => issue.row.id)).toEqual(['A1']);
  });
  it.each(['p999', '-'])('rejects a missing source reference %s', (ref) => {
    expect(analyze(ledgerFixture().replace('p1\trecorded', ref + '\trecorded')).issues[0].row.id).toBe('E1');
  });
  it('preserves model timing text and order instead of reparsing dates from the source', () => {
    const text = ledgerFixture().replace('E1\t09:00', 'E1\t午前、詳細時刻不明');
    expect(analyze(text).analysis?.events[0].time).toBe('午前、詳細時刻不明');
  });
  it('does not automatically merge distinct events with unknown timing', () => {
    const text = ledgerFixture().replace('E1\t09:00', 'E1\t-').replace('E2\t10:00', 'E2\t-');
    const analysis = analyze(text).analysis!;
    expect(analysis.cards.filter((card) => card.laneEntityId === 'A2')).toHaveLength(2);
  });
  it('accepts an explicit unordered display group while retaining both event IDs', () => {
    const text = ledgerFixture().replace('E1\t09:00', 'E1\t-').replace('E2\t10:00', 'E2\t-').replace('[整理]', 'G1\tA2\tE1,E2\n[整理]');
    const analysis = analyze(text).analysis!;
    expect(analysis.events).toHaveLength(2); expect(analysis.cards.find((card) => card.laneEntityId === 'A2')?.eventIds).toEqual(['E1','E2']);
  });
  it('rejects groups containing distinct timings', () => {
    expect(analyze(ledgerFixture().replace('[整理]', 'G1\tA2\tE1,E2\n[整理]')).issues[0].row.id).toBe('G1');
  });
  it('requires both lane endpoints of a transfer', () => {
    const text = ledgerFixture().replace('[共有カード]', 'R1\ttransfer\tE1\t-\tE2\tA2\tp1\n[共有カード]');
    expect(analyze(text).issues[0].row.id).toBe('R1');
  });
  it('bounds repair context to referenced source passages without accepted event bodies', () => {
    const text = ledgerFixture().replace('A1:actor,A2:target', 'A1:invalid');
    const doc = parseLedger(text); const result = inspectLedger(doc, source);
    const input = ledgerRepairInput(doc, result.issues, source);
    expect(input).toContain('[p1]'); expect(input).not.toContain('[p2]');
    expect(input).not.toContain('装置が停止した'); expect(input).not.toContain('"facts"');
  });
  it('finds a group repair context through the participating event references', () => {
    const longSource = sourceFromText(Array.from({ length: 21 }, (_, i) => `段落${i + 1}`).join('\n'));
    const text = ledgerFixture().replace('p1\trecorded', 'p20\trecorded').replace('p2\trecorded', 'p21\trecorded').replace('[整理]', 'G1\tA2\tE1,E2\n[整理]');
    const doc = parseLedger(text); const result = inspectLedger(doc, longSource);
    const input = ledgerRepairInput(doc, result.issues, longSource);
    expect(input).toContain('[p20]'); expect(input).toContain('[p21]'); expect(input).not.toContain('[p1]');
    expect(input).toContain('E1\t09:00');
  });
  it('rejects a repair that changes IDs or adds unrelated rows', () => {
    const doc = parseLedger(ledgerFixture().replace('A1:actor', 'A1:bad')); const result = inspectLedger(doc, source);
    expect(() => applyLedgerRepair(doc, result.issues, '[イベント]\nE3\t-\tX\tX\t-\tp1\trecorded\n[完了]')).toThrow('指定');
    expect(() => applyLedgerRepair(doc, result.issues, ledgerFixture())).toThrow('指定');
  });
  it.each([
    ledgerFixture().replace('[完了]', ''),
    ledgerFixture().replace('[関係]', '[未知]'),
    ledgerFixture().replace('A2\t装置\tmachine', 'A1\t装置\tmachine'),
    ledgerFixture().replace('[完了]', '[完了]\n余計な行'),
    '{"events":[]}',
  ])('rejects incomplete or unframed data', (text) => expect(() => parseLedger(text)).toThrow());
  it('shows the original passages in classification input and validates direct-source classifications', () => {
    const analysis = analyze().analysis!;
    const input = classificationInput(analysis); expect(input).toContain('[source_1/p1]'); expect(input).not.toContain('factIds');
    const doc = parseLedger('[判定]\nID\t判定\t理由\t原文参照\nE1\tnormal\t記録された作業\tsource_1/p1\nE2\tundetermined\t根拠不足\t-\n[完了]', true);
    const result = inspectClassifications(doc, analysis);
    expect(result.analysis?.events[0].classification).toBe('normal');
    expect(result.analysis?.events[0].classificationSourceRefs).toEqual(analysis.events[0].sourceRefs);
  });
  it('retains valid classifications and creates repair targets for missing or out-of-scope references', () => {
    const analysis = analyze().analysis!;
    const doc = parseLedger('[判定]\nE1\tnormal\t作業\tsource_1/p2\n[完了]', true);
    expect(inspectClassifications(doc, analysis).issues.map((issue) => issue.row.id)).toEqual(['E1','E2']);
  });
  it('parses 6-column subject rows and falls back safely with warnings when auxiliary columns are invalid', () => {
    const sixCol = ledgerFixture()
      .replace('A1\t担当者\tperson', 'A1\t担当者\tperson\treporter\t-\tp1')
      .replace('A2\t装置\tmachine', 'A2\t装置\tmachine\tinvalid_focus\tA999\tp999');
    const result = inspectLedger(parseLedger(sixCol), source);
    expect(result.issues).toEqual([]);
    expect(result.warnings?.length).toBeGreaterThanOrEqual(2);
    const a1 = result.analysis?.entities.find((e) => e.id === 'A1');
    const a2 = result.analysis?.entities.find((e) => e.id === 'A2');
    expect(a1?.focus).toBe('reporter');
    expect(a1?.focusSourceRefs).toEqual([{ sourceId: 'source_1', paragraphId: 'p1' }]);
    expect(a2?.focus).toBe('mid');
    expect(a2?.parentEntityId).toBeUndefined();
    expect(a2?.focusSourceRefs).toBeUndefined();
  });
});
