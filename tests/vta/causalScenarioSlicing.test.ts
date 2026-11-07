import { describe, expect, it } from 'vitest';
import { extractCausalScenario } from '../../src/tools/vta/services/generation/granularityScore';
import { projectAnalysis, sourceFromText } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { inspectLedger, parseLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';

describe('Causal Scenario Slicing (extractCausalScenario)', () => {
  it('correctly extracts causal scenario backward from outcome and isolates omitted events', () => {
    const source = sourceFromText(
      '09:00 指令が指示した。\n09:01 機長が受領した。\n09:02 機長が進入した。\n09:02 他機が進入した。\n09:02:30 衝突した。\n08:50 警備員が見回りを実施した。'
    );
    const ledger = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t管制塔\tperson\thigh\t-\tp1',
        'A2\t海保機\tperson\thigh\t-\tp2',
        'A3\tJAL機\tperson\thigh\t-\tp4',
        'A4\t警備員\tperson\tlow\t-\tp6',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t指示発出\t滑走路手前待機指示\tA1:actor\tp1\trecorded',
        'E2\t09:01\t指示受領\t進入許可と誤認\tA2:actor\tp2\trecorded',
        'E3\t09:02\t滑走路進入\t進入した\tA2:actor\tp3\trecorded',
        'E4\t09:02\t着陸進入\t着陸滑走進入\tA3:actor\tp4\trecorded',
        'E5\t09:02:30\t衝突\t滑走路上で衝突\tA2:affected,A3:affected\tp5\trecorded',
        'E6\t08:50\t定時見回り\t異常なしと記録\tA4:actor\tp6\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\ttransfer\tE1\tA1\tE2\tA2\tp2\tinformation\toccurred\tna',
        'R2\tbefore\tE2\tA2\tE3\tA2\tp3\tother\toccurred\tna',
        'R3\timpact\tE3\tA2\tE5\tA2\tp5\tother\toccurred\tna',
        'R4\timpact\tE4\tA3\tE5\tA3\tp5\tother\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE5\tp5\t両機衝突による損失発生',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        'E5\tvariation\t衝突事故\tp5',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(ledger, source);
    expect(res.issues).toEqual([]);
    const schema = projectAnalysis(res.analysis!);

    const result = extractCausalScenario(schema);

    // E5 (衝突) から R3, R4, R2, R1 を逆走し、E1, E2, E3, E4, E5 がシナリオに含まれること
    const scenarioEventIds = result.scenarioNodes.flatMap((n) => n.event_ids ?? []);
    expect(scenarioEventIds).toContain('E1');
    expect(scenarioEventIds).toContain('E2');
    expect(scenarioEventIds).toContain('E3');
    expect(scenarioEventIds).toContain('E4');
    expect(scenarioEventIds).toContain('E5');

    // E6 (警備員の見回り) は接続されていないため omittedNodes に分離されること
    const omittedEventIds = result.omittedNodes.flatMap((n) => n.event_ids ?? []);
    expect(omittedEventIds).toContain('E6');
    expect(scenarioEventIds).not.toContain('E6');

    // 箇条書きテキストが出力されていること
    expect(result.scenarioText).toContain('衝突');
    expect(result.scenarioText).toContain('帰結: 損失発生');
    expect(result.omittedText).toContain('定時見回り');
  });

  it('labels near_miss and recovery correctly in causal scenario text', () => {
    const source = sourceFromText('09:00 警報が鳴った。\n09:01 手動停止ボタンを押して直前停止した。');
    const ledger = parseLedger(
      [
        '[主体]',
        'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
        'A1\t運転員\tperson\thigh\t-\tp1',
        '[イベント]',
        'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
        'E1\t09:00\t警報発報\t警報検知\tA1:actor\tp1\trecorded',
        'E2\t09:01\t手動停止\t直前停止に成功\tA1:actor\tp2\trecorded',
        '[関係]',
        'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
        'R1\tbefore\tE1\tA1\tE2\tA1\tp2\tother\toccurred\tna',
        '[共有カード]',
        'ID\t主体\tイベント',
        '[整理]',
        'ID\t区分\t原文参照\t要旨\t理由',
        '[帰結]',
        'ID\t判定\tイベントID\t原文参照\t理由',
        'O1\tidentified\tE2\tp2\t直前停止成功',
        '[仮判定]',
        'イベントID\t判定\t理由\t原文参照',
        '[完了]',
      ].join('\n')
    );

    const res = inspectLedger(ledger, source);
    // outcome.kind を near_miss に設定
    res.analysis!.outcome!.kind = 'near_miss';
    const schema = projectAnalysis(res.analysis!);

    const result = extractCausalScenario(schema);
    expect(result.scenarioText).toContain('帰結: 直前停止・ニアミス');
  });
});
