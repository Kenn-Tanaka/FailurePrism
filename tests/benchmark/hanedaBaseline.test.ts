import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractEventDraft } from '../../src/tools/vta/services/llm/client';
import { autoConnectVTA } from '../../src/tools/vta/services/generation/autoConnectionService';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import type { LLMConfig, VTASchema } from '../../src/tools/vta/types/vta';

const isBenchmarkEnabled = process.env.RUN_HANEDA_BENCHMARK === '1';

describe.skipIf(!isBenchmarkEnabled)('羽田事故 実LLM再ベースライン計測 (Phase 0 Benchmark)', () => {
  const defaultFilePath = 'C:/Users/kenta/Dropbox/2026年/ソフトウェア開発/参照資料/羽田事故_20261025_141902.md';
  const filePath = process.env.HANEDA_SCENARIO_PATH || defaultFilePath;
  const iterations = process.env.BENCHMARK_ITERATIONS ? Math.max(1, Number(process.env.BENCHMARK_ITERATIONS)) : 3;

  const config: LLMConfig = {
    baseUrl: process.env.LLM_GATEWAY_URL || 'http://localhost:8765/v1',
    selectedModel: process.env.BENCHMARK_MODEL || 'openrouter/google/gemini-3.8-flash',
    gatewayToken: process.env.LLM_GATEWAY_TOKEN || '',
    maxRetries: 3,
    stream: true,
  };

  it(`羽田事故シナリオ (${iterations}回反復) の定量メトリクスを計測し記録する`, async () => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`シナリオファイルが見つかりません: ${filePath}`);
    }

    const scenarioText = fs.readFileSync(filePath, 'utf-8');
    const isOutcomeFirst = process.env.OUTCOME_FIRST === '1';
    console.log(`\n======================================================`);
    console.log(`[羽田事故 実LLMベンチマーク計測開始]`);
    console.log(`ファイル: ${filePath} (${scenarioText.length}文字)`);
    console.log(`モデル: ${config.selectedModel} | エンドポイント: ${config.baseUrl}`);
    console.log(`出力順序: ${isOutcomeFirst ? '帰結先行アンカリング順 (Phase B)' : '末尾帰結順 (Phase A / 従来)'}`);
    console.log(`試行回数: ${iterations}回`);
    console.log(`======================================================\n`);

    const runRecords: Array<{
      runIndex: number;
      latencyMs: number;
      eventCount: number;
      subjectCount: number;
      posetNodes: number;
      posetEdges: number;
      scores?: { S: number; C1: number; C2: number; C3: number; C4: number; C5: number };
      outcomeStatus: string;
      outcomeEvents: number;
      excludedPostOutcomeNodes: number;
      chainRepairCalls: number;
      chainRepairSubjectMismatchCount: number;
    }> = [];

    for (let i = 0; i < iterations; i++) {
      console.log(`>>> 試行 ${i + 1}/${iterations} 開始...`);
      useVTAStore.getState().createNewProjectId();
      const startTime = performance.now();

      let extractedSchema: VTASchema;
      try {
        extractedSchema = await extractEventDraft(
          config,
          scenarioText,
          undefined,
          'refined-chain',
          12,
          {
            excludePostOutcomeActivities: true,
            outcomeFirst: isOutcomeFirst,
          }
        );
      } catch (err) {
        const errElapsed = Math.round(performance.now() - startTime);
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`❌ 試行 ${i + 1} 抽出エラー (${errElapsed}ms):`, errMsg);
        runRecords.push({
          runIndex: i + 1,
          latencyMs: errElapsed,
          eventCount: 0,
          subjectCount: 0,
          posetNodes: 0,
          posetEdges: 0,
          outcomeStatus: `ERROR: ${errMsg.slice(0, 50)}`,
          outcomeEvents: 0,
          excludedPostOutcomeNodes: 0,
          chainRepairCalls: 0,
          chainRepairSubjectMismatchCount: 0,
        });
        continue;
      }

      const elapsed = Math.round(performance.now() - startTime);
      const analysis = extractedSchema.analysis!;
      const poset = analysis.subjectPoset;

      let addedChainConnections = 0;
      let subjectMismatches = 0;

      try {
        const connectResult = await autoConnectVTA(
          config,
          extractedSchema,
          undefined,
          (prog) => console.log(`   [接続進捗] ${prog.message}`)
        );
        addedChainConnections = connectResult.addedChainConnections;
        // 診断トレースから主体不整合棄却数を集計
        for (const warning of connectResult.warnings) {
          if (warning.includes('関係の主体がイベントに関与していません')) {
            subjectMismatches++;
          }
        }
      } catch (connErr) {
        console.warn(`   [接続警告] autoConnectVTA例外:`, connErr);
      }

      const latestRefinement = analysis.normalizationAudit?.iterations?.slice(-1)[0];
      const scores = latestRefinement ? {
        S: latestRefinement.score,
        C1: latestRefinement.metrics.c1,
        C2: latestRefinement.metrics.c2 ?? 0,
        C3: latestRefinement.metrics.c3,
        C4: latestRefinement.metrics.c4 ?? 0,
        C5: latestRefinement.metrics.c5,
      } : undefined;

      const record = {
        runIndex: i + 1,
        latencyMs: elapsed,
        eventCount: analysis.events.length,
        subjectCount: analysis.entities.length,
        posetNodes: poset?.nodes?.length ?? 0,
        posetEdges: poset?.relations?.length ?? 0,
        scores,
        outcomeStatus: analysis.outcome?.status ?? 'none',
        outcomeEvents: analysis.outcome?.eventIds?.length ?? 0,
        excludedPostOutcomeNodes: (analysis.dispositions ?? []).filter((d) => d.kind === 'excluded').length,
        chainRepairCalls: addedChainConnections,
        chainRepairSubjectMismatchCount: subjectMismatches,
      };

      runRecords.push(record);
      console.log(`✔ 試行 ${i + 1} 完了 (${elapsed}ms, イベント ${record.eventCount}件, 主体 ${record.subjectCount}件, Poset枝 ${record.posetEdges}本)`);
    }

    const resultsDir = path.resolve(__dirname, 'results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    const outputPath = path.join(resultsDir, `haneda_baseline_${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify({ config, runRecords }, null, 2), 'utf-8');

    console.log(`\n======================================================`);
    console.log(`[計測結果サマリー保存完了: ${outputPath}]`);
    console.log(`======================================================`);
    console.table(runRecords.map(r => ({
      Run: r.runIndex,
      '所要時間(秒)': (r.latencyMs / 1000).toFixed(1),
      'イベント': r.eventCount,
      '主体': r.subjectCount,
      'Poset枝数': r.posetEdges,
      'Sスコア': r.scores?.S?.toFixed(3) ?? '-',
      'C1': r.scores?.C1?.toFixed(2) ?? '-',
      'C3': r.scores?.C3?.toFixed(2) ?? '-',
      'C5': r.scores?.C5?.toFixed(2) ?? '-',
      '帰結ステータス': r.outcomeStatus,
      '主体不整合エラー': r.chainRepairSubjectMismatchCount,
    })));
  }, 600000); // 最大10分待機
});
