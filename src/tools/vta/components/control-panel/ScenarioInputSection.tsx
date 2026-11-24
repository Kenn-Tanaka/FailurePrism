import { visibleSchema } from '../../features/vta/utils/presentation';
import React, { useState, useEffect, useRef } from 'react';
import type { VTASchema } from '../../types/vta';
import {
  BookOpen,
  Upload,
  FileCheck,
  FileUp,
  RefreshCw,
  Zap,
  StopCircle,
  Square,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  ClipboardCheck,
  Sliders,
  RotateCcw,
} from 'lucide-react';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { SAMPLE_SCENARIOS } from '../../features/vta/data/sampleData';
import { isProjectJsonFileName } from '../../features/vta/utils/fileIngestion';
import {
  confirmProjectReplacement,
  ingestScenarioDocumentFile,
} from '../../features/vta/utils/projectFileLoader';
import {
  runDeterministicUiTask,
  yieldForPaint,
  importProjectJsonWithOverlay,
  isUiActionBusy,
} from '../../features/vta/utils/uiProgressRunner';
import { classifyEventDraft, extractEventDraft } from '../../services/llm/client';
import { autoConnectVTA } from '../../services/generation/autoConnectionService';
import {
  captureFineGrainedBase,
  generateStructuralFallbackCandidates,
  searchOptimalLaneConsolidation,
} from '../../services/generation/laneConsolidationOptimizer';
import {
  projectAnalysis,
  batchAdoptPreliminary,
  isIdentifiedOutcomeEvent,
  setEventClassificationWithOutcomeSync,
  type BatchAdoptMode,
} from '../../features/vta/utils/eventAnalysis';
import { calculateVTALayout } from '../../features/vta/utils/layout';
import { debugRecorder } from '../../services/debugRecorder';
import { shiftReactNodesForLaneChange } from '../../features/vta/utils/lanePositionShift';
import { createPipelineSnapshot, upsertPipelineSnapshot } from '../../features/vta/utils/pipelineHistory';
import { resolveStaleResult, vtaContentFingerprint } from '../../features/vta/utils/staleResultGuard';
import { EventReviewPanel } from './EventReviewPanel';

export const ScenarioInputSection: React.FC = () => {
  const scenarioText = useVTAStore((state) => state.scenarioText);
  const setScenarioText = useVTAStore((state) => state.setScenarioText);
  const selectedSampleId = useVTAStore((state) => state.selectedSampleId);
  const currentProjectId = useVTAStore((state) => state.currentProjectId);
  const loadSample = useVTAStore((state) => state.loadSample);
  const resetProject = useVTAStore((state) => state.resetProject);
  const isDirty = useVTAStore((state) => state.isDirty);
  const isParsingFile = useVTAStore((state) => state.isParsingFile);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const setIsExtracting = useVTAStore((state) => state.setIsExtracting);
  const generationProgress = useVTAStore((state) => state.generationProgress);
  const resetGenerationProgress = useVTAStore((state) => state.resetGenerationProgress);
  const llmConfig = useVTAStore((state) => state.llmConfig);
  const setVTAData = useVTAStore((state) => state.setVTAData);
  const setError = useVTAStore((state) => state.setError);
  const addLog = useVTAStore((state) => state.addLog);
  const showToast = useVTAStore((state) => state.showToast);
  const createAbortController = useVTAStore((state) => state.createAbortController);
  const cancelCurrentOperation = useVTAStore((state) => state.cancelCurrentOperation);
  const vtaData = useVTAStore((state) => state.vtaData);
  const subjectLimit = useVTAStore((state) => state.subjectLimit);
  const setSubjectLimit = useVTAStore((state) => state.setSubjectLimit);
  const excludePostOutcomeActivities = useVTAStore((state) => state.excludePostOutcomeActivities);
  const setExcludePostOutcomeActivities = useVTAStore((state) => state.setExcludePostOutcomeActivities);
  const autoAdoptPreliminaryOnExtract = useVTAStore((state) => state.autoAdoptPreliminaryOnExtract);
  const setAutoAdoptPreliminaryOnExtract = useVTAStore((state) => state.setAutoAdoptPreliminaryOnExtract);
  const setIsOptimizationSettingsOpen = useVTAStore((state) => state.setIsOptimizationSettingsOpen);
  const uiTaskProgress = useVTAStore((state) => state.uiTaskProgress);
  const workflowStep = useVTAStore((state) => state.workflowStep);
  const setWorkflowStep = useVTAStore((state) => state.setWorkflowStep);

  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [parsingProgress, setParsingProgress] = useState<string | null>(null);
  const [loadedFileInfo, setLoadedFileInfo] = useState<{
    name: string;
    type: string;
    size: number;
    charCount: number;
  } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pendingSchema, setPendingSchema] = useState<VTASchema | null>(null);
  const [reviewingCurrent, setReviewingCurrent] = useState(false);
  const [reviewBaseSchema, setReviewBaseSchema] = useState<VTASchema | null>(null);
  const hasPendingReview = Boolean(pendingSchema?.analysis);
  const isCurrentReviewStale = reviewingCurrent && reviewBaseSchema !== null && vtaData !== reviewBaseSchema;

  const scenarioFileInputRef = useRef<HTMLInputElement>(null);
  const reviewPanelRef = useRef<HTMLDivElement>(null);
  const prevProjectIdRef = useRef(currentProjectId);

  useEffect(() => {
    if (prevProjectIdRef.current !== currentProjectId) {
      prevProjectIdRef.current = currentProjectId;
      setPendingSchema(null);
      setReviewingCurrent(false);
      setReviewBaseSchema(null);
      setLoadedFileInfo(null);
      setParsingProgress(null);
    }
  }, [currentProjectId]);

  useEffect(() => {
    if (hasPendingReview) reviewPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hasPendingReview]);

  // Live timer during VTA extraction
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (isExtracting) {
      setElapsedSeconds(0);
      interval = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setElapsedSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isExtracting]);

  const handleScenarioFile = async (file: File) => {
    if (!file) return;

    if (isProjectJsonFileName(file.name)) {
      const res = await importProjectJsonWithOverlay(file, (msg) => setError(msg));
      if (res.status === 'imported') {
        setPendingSchema(null);
        addLog('success', `VTAプロジェクトファイル「${file.name}」を正常にインポートしました。`, 'PROJECT_IMPORT');
        setLoadedFileInfo({
          name: file.name,
          type: 'JSON',
          size: file.size,
          charCount: res.text.length,
        });
      } else if (res.status === 'invalid') {
        addLog('error', `インポート失敗: ${res.message}`, 'PROJECT_IMPORT');
      }
      return;
    }

    await runDeterministicUiTask(
      {
        actionKey: 'file_ingest',
        level: 'overlay',
        title: `文書ファイル「${file.name}」を解析中...`,
        detail: 'シナリオテキストを抽出・整形しています...',
        stepCurrent: 1,
        stepTotal: 2,
      },
      async (updateStep) => {
        await ingestScenarioDocumentFile(file, {
          getState: () => useVTAStore.getState(),
          onProgress: (stage) => {
            setParsingProgress(stage);
            if (stage) {
              void updateStep({ stepCurrent: 2, detail: stage });
            }
          },
          onError: (msg) => setError(msg),
          onSuccess: (result) => {
            setPendingSchema(null);
            setLoadedFileInfo({
              name: result.filename,
              type: result.fileType.toUpperCase(),
              size: result.sizeBytes,
              charCount: result.characterCount,
            });
          },
          showToast,
          addLog,
        });
      }
    );
  };

  const handleExtractVTA = async () => {
    if (useVTAStore.getState().isParsingFile) {
      showToast('warn', 'ファイルの解析中です。完了してから実行してください。');
      return;
    }
    if (!scenarioText.trim()) {
      setError('事故シナリオテキストを入力してください。');
      return;
    }

    if (vtaData.nodes.length > 0 && isDirty) {
      const confirmOverwrite = window.confirm(
        '現在のキャンバスに未保存の編集内容があります。\nAIによるVTA構造抽出を実行して上書きしますか？\n（直前の作業は自動退避され、後から復旧できます）'
      );
      if (!confirmOverwrite) {
        return;
      }
    }

    const currentProjectId = useVTAStore.getState().currentProjectId;
    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    useVTAStore.getState().setActiveRequestId(reqId);

    const controller = createAbortController();
    setIsExtracting(true);
    setError(null);
    const diagRunId = debugRecorder.startRun('extract_full', [llmConfig.gatewayToken ?? '']);
    let diagRunStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

    try {
      // ステップ 1: 主体上限なしで最細粒度のイベント・主体・仮判定を抽出 (ADR-0079)
      const extractedSchema = await extractEventDraft(
        llmConfig,
        scenarioText,
        controller.signal,
        'refined-chain',
        subjectLimit,
        {
          excludePostOutcomeActivities,
          skipEarlyRefinement: true,
        }
      );
      if (
        controller.signal.aborted ||
        useVTAStore.getState().activeAbortController !== controller ||
        useVTAStore.getState().currentProjectId !== currentProjectId ||
        useVTAStore.getState().activeRequestId !== reqId
      ) {
        if (!controller.signal.aborted && useVTAStore.getState().currentProjectId === currentProjectId) {
          addLog('warn', '[抽出結果/採用せず] 別の操作が始まったため、受信した応答は現在の図に反映しませんでした。', '解析');
          showToast('warn', '別の操作が始まったため、抽出結果を反映しませんでした。');
        }
        return; // 中断または新しい操作による上書き防止 (REL-001)
      }

      // ステップ 2: 最細粒度のままVTA図を完成させ（レーン間接続＋連鎖補完）、LLM候補一括提案＋山登り法でレーン数を削減 (ADR-0079)
      let finalSchema = extractedSchema;
      let fineCompletedSnapshotSchema: VTASchema | undefined;
      const refSettingsNow = useVTAStore.getState().refinementSettings;
      try {
        const connectResult = await autoConnectVTA(
          llmConfig,
          extractedSchema,
          controller.signal,
          (prog) => {
            const step = prog.stage === 'inter_lane' || prog.stage === 'chain_repair' ? 2 : 3;
            const title =
              prog.stage === 'inter_lane'
                ? '【2/3】最細粒度VTAのレーン間接続探索'
                : prog.stage === 'chain_repair'
                  ? '【2/3】最細粒度VTAの連鎖補完と完成'
                  : '【3/3】統合候補の提案と山登りレーン削減';
            useVTAStore.getState().setGenerationProgress({
              stepCurrent: step,
              stepTotal: 3,
              title,
              detail: prog.message,
            });
          },
          {
            finalMaxSubjects: subjectLimit,
            useHillClimbingConsolidation: true,
            refinementWeights: refSettingsNow?.weights,
            oneTimeDirective: refSettingsNow?.useOneTimeDirective ? refSettingsNow.oneTimeDirective : undefined,
            assumptions: refSettingsNow?.assumptions,
            scope: refSettingsNow?.scope,
            pinnedEntityIds: refSettingsNow?.scope?.pinnedEntityIds,
          }
        );
        finalSchema = connectResult.schema;
        fineCompletedSnapshotSchema = connectResult.fineCompletedSchema;
        if (refSettingsNow?.useOneTimeDirective) {
          useVTAStore.setState((s) => ({
            refinementSettings: {
              ...s.refinementSettings,
              useOneTimeDirective: false,
            },
          }));
        }
        if (
          connectResult.fineLanesCount !== undefined &&
          connectResult.consolidatedLanesCount !== undefined &&
          connectResult.consolidatedLanesCount < connectResult.fineLanesCount
        ) {
          addLog(
            'info',
            `[山登りレーン統合] 最細粒度 ${connectResult.fineLanesCount}列 → ${connectResult.consolidatedLanesCount}列へ統合しました（内部に最細粒度VTAを保持）。`,
            '解析'
          );
        }
        if (connectResult.warnings.length) {
          showToast('warn', connectResult.warnings.join('\n'));
        }
      } catch (connErr) {
        if (controller.signal.aborted) return;
        addLog(
          'warn',
          `[自動接続スキップ] 接続処理で警告が発生したため、構造フォールバック山登り統合を適用します: ${
            connErr instanceof Error ? connErr.message : String(connErr)
          }`,
          '解析'
        );
        if (extractedSchema.analysis) {
          const fbBase = captureFineGrainedBase(extractedSchema.analysis);
          const pinnedSet = new Set(refSettingsNow?.scope?.pinnedEntityIds ?? []);
          const fbPool = generateStructuralFallbackCandidates(fbBase, extractedSchema.analysis, pinnedSet);
          finalSchema = searchOptimalLaneConsolidation(
            fbBase,
            extractedSchema.analysis,
            fbPool.candidates,
            fbPool.separationConstraints,
            {
              targetMaxSubjects: subjectLimit,
              weights: refSettingsNow?.weights,
              pinnedEntityIds: pinnedSet,
              previousSchema: extractedSchema,
            }
          ).bestSchema;
        }
      }

      if (
        controller.signal.aborted ||
        useVTAStore.getState().activeAbortController !== controller ||
        useVTAStore.getState().currentProjectId !== currentProjectId ||
        useVTAStore.getState().activeRequestId !== reqId
      ) {
        return;
      }

      // 中間確認をスキップし、完成したツリーをキャンバスへ直接描画 (SR-01)
      setReviewingCurrent(false);
      setReviewBaseSchema(null);
      setPendingSchema(null);

      // Stage 2 (最細粒度VTA完成) & Stage 3 (山登りレーン統合) のスナップショットを生成
      let nextHistory = extractedSchema.pipelineHistory;
      if (fineCompletedSnapshotSchema) {
        const fineNodes = fineCompletedSnapshotSchema.nodes.map((n) => ({
          ...n,
          type: (n.type === 'outcome' ? 'outcome' : 'normal') as import('../../types/vta').VTANodeType,
          variation_factor: undefined,
          measure_type: null,
        }));
        const fineSnapshot = createPipelineSnapshot(
          'stage2_fine_complete',
          1,
          'Stage 2: 最細粒度VTA完成 (統合前基底)',
          `最細粒度 ${visibleSchema(fineCompletedSnapshotSchema).lanes.length}列・接続 ${fineCompletedSnapshotSchema.edges.length}本`,
          '主体数制限なしでレーン間接続と連鎖補完を完了した内部保持用の最細粒度VTA図',
          {
            ...fineCompletedSnapshotSchema,
            nodes: fineNodes,
          }
        );
        nextHistory = upsertPipelineSnapshot(nextHistory, fineSnapshot);
      }

      const stage3Nodes = finalSchema.nodes.map((n) => ({
        ...n,
        type: (n.type === 'outcome' ? 'outcome' : 'normal') as import('../../types/vta').VTANodeType,
        variation_factor: undefined,
        measure_type: null,
      }));
      const hcScore = finalSchema.analysis?.laneConsolidation?.score;
      const stage3Snapshot = createPipelineSnapshot(
        'stage3_lane_consolidate',
        2,
        'Stage 3: 山登りレーン削減・接続統合',
        `表示レーン ${visibleSchema(finalSchema).lanes.length}列${hcScore !== undefined ? `（スコア S=${hcScore.toFixed(3)}）` : ''}`,
        'LLMが提案した統合候補群から山登り法で高得点のレーン構成を選択し、レーン間接続を表示統合した図',
        {
          ...finalSchema,
          nodes: stage3Nodes,
        }
      );
      finalSchema = {
        ...finalSchema,
        pipelineHistory: upsertPipelineSnapshot(nextHistory, stage3Snapshot),
      };

      // Stage 4: 自動仮判定反映が有効な場合は生成直後に変動要因・通常作業を配色反映 (ADR-0073)
      if (useVTAStore.getState().autoAdoptPreliminaryOnExtract && finalSchema.analysis) {
        const adopted = batchAdoptPreliminary(finalSchema.analysis, 'all');
        if (adopted.totalCount > 0) {
          const prevHistory = finalSchema.pipelineHistory;
          finalSchema = projectAnalysis(adopted.updatedAnalysis, finalSchema, { silentDebug: true });
          const stage4Snapshot = createPipelineSnapshot(
            'stage4_classify',
            3,
            'Stage 4: 変動要因判定・帰結確定',
            `仮判定自動反映（変動: ${adopted.variationCount}、通常: ${adopted.normalCount}）`,
            '抽出時に付与されたAI仮判定を初期状態としてVTA図へ反映',
            finalSchema
          );
          finalSchema = {
            ...finalSchema,
            pipelineHistory: upsertPipelineSnapshot(prevHistory, stage4Snapshot),
          };
        }
      }

      useVTAStore.getState().setGenerationProgress({
        stage: 'layouting',
        stepCurrent: 3,
        stepTotal: 3,
        title: '【最終処理】スイムレーン配置と配線を計算中',
        detail: 'ノード座標・交差回避ルートを計算しています...',
      });
      await yieldForPaint();

      const layout = calculateVTALayout(finalSchema);
      useVTAStore.getState().commitVTAChange({
        schema: finalSchema,
        nodes: layout.nodes,
        edges: layout.edges,
        laneBounds: layout.laneBounds,
        preserveDerivedRemovals: true,
        replaceProject: true,
      });
      useVTAStore.getState().setWorkflowStep('review');

      const eventCount = finalSchema.analysis?.events.filter((e) => !e.ignored).length ?? 0;
      const cardCount = visibleSchema(finalSchema).nodes.length;
      showToast('success', `VTAツリー自動生成が完了しました（イベント ${eventCount}件、カード ${cardCount}件）。`);
      addLog(
        'success',
        `[VTAツリー自動生成完了] イベント ${eventCount}件、カード ${cardCount}件をキャンバスに反映しました。`,
        '解析'
      );
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED' || controller.signal.aborted)
      ) {
        diagRunStatus = 'cancelled';
        return;
      }
      if (useVTAStore.getState().currentProjectId !== currentProjectId) {
        diagRunStatus = 'cancelled';
        return;
      }
      diagRunStatus = 'failed';
      const message = err instanceof Error ? err.message : 'VTA図の抽出処理中にエラーが発生しました。';
      setError(message);
      showToast('error', `抽出結果を作成できませんでした: ${message}`);
      addLog('error', `[抽出失敗] ${message}`, '解析');
    } finally {
      debugRecorder.endRun(diagRunId, diagRunStatus, [llmConfig.gatewayToken ?? '']);
      if (useVTAStore.getState().currentProjectId === currentProjectId && useVTAStore.getState().activeRequestId === reqId) {
        setIsExtracting(false);
        resetGenerationProgress();
      }
    }
  };

  const handleClassify = async () => {
    const current = useVTAStore.getState();
    const analysis = current.vtaData.analysis;
    if (
      !analysis ||
      !analysis.events.some(
        (event) => !event.ignored && event.classification === 'unclassified' && !isIdentifiedOutcomeEvent(analysis, event)
      )
    ) {
      return;
    }
    const projectId = current.currentProjectId;
    const startFingerprint = vtaContentFingerprint(current.vtaData);
    const scenarioAtStart = current.scenarioText;
    const reqId = `classify_${Date.now()}`;
    current.setActiveRequestId(reqId);
    const controller = current.createAbortController();
    setIsExtracting(true);
    setError(null);
    current.setGenerationProgress({
      isActive: true,
      mode: 'classify',
      stage: 'preparing',
      stepCurrent: 1,
      stepTotal: 3,
      title: '【1/3】抽出結果の整理',
      detail: '確定済みイベントを整理しています。',
    });
    try {
      const classified = await classifyEventDraft(llmConfig, analysis, controller.signal);
      const latest = useVTAStore.getState();
      if (controller.signal.aborted || latest.currentProjectId !== projectId || latest.activeRequestId !== reqId) return;
      if (latest.scenarioText !== scenarioAtStart) {
        latest.addLog('warn', '[変動判定/採用せず] 実行中に事故シナリオ本文が変更されたため、判定結果を反映しませんでした。', '解析');
        showToast('warn', '本文が変更されたため、変動判定の結果を反映しませんでした。');
        return;
      }
      if (resolveStaleResult(startFingerprint, latest.vtaData, '変動判定') === 'discard') {
        latest.addLog('warn', '[変動判定/採用せず] 実行中に図が編集されたため、利用者の選択により判定結果を破棄しました。', '解析');
        showToast('warn', '実行中の編集を保持し、変動判定の結果は破棄しました。');
        return;
      }
      const schema = projectAnalysis(classified, latest.vtaData, { silentDebug: true });
      const stage4Snapshot = createPipelineSnapshot(
        'stage4_classify',
        3,
        'Stage 4: 変動要因判定・帰結確定',
        `変動要因 ${schema.nodes.filter((n) => n.type === 'variation').length}件、帰結 ${schema.nodes.filter((n) => n.type === 'outcome').length}件`,
        '事故シナリオにおける通常作業（白）・変動要因（黄/橙）・不具合帰結（赤）の判定・確定',
        schema
      );
      schema.pipelineHistory = upsertPipelineSnapshot(latest.vtaData.pipelineHistory, stage4Snapshot);
      const layout = calculateVTALayout(schema, latest.nodes);
      latest.commitVTAChange({ schema, nodes: layout.nodes, edges: layout.edges, laneBounds: layout.laneBounds });
      const activeClassifiedCount = classified.events.filter((e) => !e.ignored).length;
      latest.addLog('success', `イベント ${activeClassifiedCount}件の変動判定を反映しました。`, '解析');
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : '変動判定に失敗しました。';
        setError(message);
        showToast('error', message);
        addLog('error', `[変動判定失敗] ${message}`, '解析');
      }
    } finally {
      if (useVTAStore.getState().currentProjectId === projectId && useVTAStore.getState().activeRequestId === reqId) {
        setIsExtracting(false);
        resetGenerationProgress();
      }
    }
  };

  const handleBatchAdoptOutside = (mode: BatchAdoptMode) => {
    void runDeterministicUiTask(
      {
        actionKey: 'batch_adopt',
        level: 'inline',
        title: '仮判定をVTA図へ一括反映中...',
      },
      () => {
        const current = useVTAStore.getState();
        if (!current.vtaData.analysis) return;
        const { updatedAnalysis, totalCount, variationCount, normalCount } = batchAdoptPreliminary(
          current.vtaData.analysis,
          mode
        );
        if (totalCount === 0) return;
        const newSchema = projectAnalysis(updatedAnalysis, current.vtaData, { silentDebug: true });
        const stage4Snapshot = createPipelineSnapshot(
          'stage4_classify',
          3,
          'Stage 4: 変動要因判定・帰結確定',
          `仮判定採用（変動: ${variationCount}、通常: ${normalCount}）`,
          '事故シナリオにおける通常作業（白）・変動要因（黄/橙）・不具合帰結（赤）の判定・確定',
          newSchema
        );
        newSchema.pipelineHistory = upsertPipelineSnapshot(current.vtaData.pipelineHistory, stage4Snapshot);
        const layout = calculateVTALayout(newSchema, current.nodes);
        current.commitVTAChange({
          schema: newSchema,
          nodes: layout.nodes,
          edges: layout.edges,
          laneBounds: layout.laneBounds,
        });
        const message =
          mode === 'variation_only'
            ? `変動要因の仮判定 ${variationCount}件をVTA図に反映しました（Ctrl+Zで取り消せます）。`
            : `すべての仮判定 ${totalCount}件（変動: ${variationCount}、通常: ${normalCount}）をVTA図に反映しました（Ctrl+Zで取り消せます）。`;
        current.addLog('info', `[仮判定一括採用] ${message}`, '解析');
        showToast('success', message);
      }
    );
  };

  const handleQuickEventClassification = (
    eventId: string,
    classification: 'normal' | 'variation'
  ) => {
    void runDeterministicUiTask(
      {
        actionKey: 'quick_classify',
        level: 'inline',
        title: 'イベント区分を更新中...',
      },
      () => {
        const current = useVTAStore.getState();
        if (!current.vtaData.analysis) return;
        const updated = setEventClassificationWithOutcomeSync(
          current.vtaData.analysis,
          eventId,
          classification,
          { clearReason: true }
        );
        const nextSchema = projectAnalysis(updated, current.vtaData, { silentDebug: true });
        const layout = calculateVTALayout(nextSchema, current.nodes);
        current.commitVTAChange({
          schema: nextSchema,
          nodes: layout.nodes,
          edges: layout.edges,
          laneBounds: layout.laneBounds,
        });
      }
    );
  };

  const activeEventsList = vtaData.analysis?.events.filter((e) => !e.ignored) ?? [];
  const outsideVariationPrelimCount =
    activeEventsList.filter(
      (e) =>
        e.classification === 'unclassified' &&
        e.preliminary?.value === 'variation' &&
        !isIdentifiedOutcomeEvent(vtaData.analysis, e)
    ).length;

  const outsideAllPrelimCount =
    activeEventsList.filter(
      (e) =>
        e.classification === 'unclassified' &&
        (e.preliminary?.value === 'variation' || e.preliminary?.value === 'normal') &&
        !isIdentifiedOutcomeEvent(vtaData.analysis, e)
    ).length;

  const totalEventsCount = activeEventsList.length;
  const variationEventsCount =
    activeEventsList.filter((e) => e.classification === 'variation').length;
  const normalEventsCount =
    activeEventsList.filter((e) => e.classification === 'normal').length;
  const unclassifiedEventsCount =
    activeEventsList.filter(
      (e) => e.classification === 'unclassified' && !isIdentifiedOutcomeEvent(vtaData.analysis, e)
    ).length;

  return (
    <>
      <section
        hidden={workflowStep !== 'input'}
        className={workflowStep === 'input' ? 'bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-3 shadow-md' : 'hidden'}
      >
        <input
          ref={scenarioFileInputRef}
          type="file"
          accept=".txt,.md,.markdown,.docx,.xlsx,.xls,.pdf,.log,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleScenarioFile(f);
            e.target.value = '';
          }}
          className="hidden"
        />

      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <BookOpen className="w-4 h-4 text-cyan-400" />
          <span>事故・トラブルシナリオ入力</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => scenarioFileInputRef.current?.click()}
            disabled={isParsingFile || isExtracting}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 hover:border-cyan-500/50 rounded-md text-[11px] flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
            title="ローカルファイル (.txt, .md, .docx, .pdf, .xlsx, .json) を読み込む"
          >
            <Upload className="w-3 h-3 text-cyan-400" />
            <span>ファイル読込</span>
          </button>

          {SAMPLE_SCENARIOS.length > 0 && (
            <select
              value={selectedSampleId}
              disabled={isUiActionBusy(uiTaskProgress, 'sample_load') || isExtracting}
              onChange={(e) => {
                const newSampleId = e.target.value;
                if (newSampleId === selectedSampleId) return;
                const confirmed = confirmProjectReplacement(
                  useVTAStore.getState(),
                  '別のサンプルシナリオを読み込みます'
                );
                if (!confirmed) return;
                void runDeterministicUiTask(
                  {
                    actionKey: 'sample_load',
                    level: 'overlay',
                    title: 'サンプルシナリオを読み込み中...',
                    detail: 'シナリオデータとスイムレーン配置を初期化しています...',
                    stepCurrent: 1,
                    stepTotal: 2,
                  },
                  async (updateStep) => {
                    await updateStep({
                      stepCurrent: 2,
                      detail: 'スイムレーン配置と配線経路を計算しています...',
                    });
                    loadSample(newSampleId);
                    setPendingSchema(null);
                    setLoadedFileInfo(null);
                  }
                );
              }}
              className="bg-slate-950 border border-slate-700 text-slate-300 text-[11px] rounded-md px-2 py-1 focus:outline-none focus:border-cyan-500 max-w-[125px] truncate cursor-pointer disabled:opacity-50"
            >
              {SAMPLE_SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}

          {(scenarioText.trim().length > 0 ||
            vtaData.nodes.length > 0 ||
            vtaData.lanes.length > 0 ||
            pendingSchema !== null) && (
            <button
              type="button"
              disabled={isParsingFile || isExtracting}
              onClick={() => {
                const confirmed = confirmProjectReplacement(
                  useVTAStore.getState(),
                  '現在のシナリオとVTA図をクリアして初期状態に戻します'
                );
                if (!confirmed) return;
                resetProject();
                setPendingSchema(null);
                setLoadedFileInfo(null);
              }}
              className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-700 rounded-md text-[11px] flex items-center gap-1 transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
              title="現在の入力内容とVTA図をクリアして初期状態に戻す"
            >
              <RotateCcw className="w-3 h-3 text-slate-400" />
              <span>クリア</span>
            </button>
          )}
        </div>
      </div>

      {loadedFileInfo && (
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-cyan-950/50 border border-cyan-800/60 rounded-lg text-[11px] text-cyan-300 animate-in fade-in-50">
          <div className="flex items-center gap-1.5 min-w-0">
            <FileCheck className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="px-1.5 py-0.2 bg-cyan-900/80 border border-cyan-700 text-cyan-200 text-[9px] font-mono font-bold rounded">
              {loadedFileInfo.type}
            </span>
            <span className="truncate font-medium text-slate-200" title={loadedFileInfo.name}>
              {loadedFileInfo.name}
            </span>
            <span className="text-slate-400 text-[10px] shrink-0">
              ({loadedFileInfo.charCount.toLocaleString()}文字)
            </span>
          </div>
          <button
            type="button"
            onClick={() => setLoadedFileInfo(null)}
            className="text-slate-400 hover:text-slate-200 ml-1.5 shrink-0 text-xs cursor-pointer"
            title="表示を解除"
          >
            ✕
          </button>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingFile(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDraggingFile(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDraggingFile(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleScenarioFile(f);
        }}
        className={`relative rounded-lg transition-all ${
          isDraggingFile
            ? 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-900 bg-cyan-950/20'
            : ''
        }`}
      >
        {isDraggingFile && (
          <div className="absolute inset-0 z-10 bg-slate-900/90 border-2 border-dashed border-cyan-400 rounded-lg flex flex-col items-center justify-center gap-2 pointer-events-none backdrop-blur-sm animate-in fade-in-50">
            <FileUp className="w-8 h-8 text-cyan-400 animate-bounce" />
            <p className="text-xs font-bold text-cyan-200">
              ファイルをここにドロップして読込
            </p>
            <p className="text-[10px] text-cyan-400 font-mono">
              .txt / .md / .docx / .pdf / .xlsx / .json
            </p>
          </div>
        )}

        {isParsingFile && (
          <div className="absolute inset-0 z-10 bg-slate-900/85 rounded-lg flex flex-col items-center justify-center gap-2 backdrop-blur-sm animate-in fade-in-50">
            <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin" />
            <p className="text-xs font-semibold text-cyan-200">
              ファイルを解析・テキスト変換中...
            </p>
            {parsingProgress && (
              <p className="text-[11px] font-mono text-cyan-300 animate-pulse">
                {parsingProgress}
              </p>
            )}
          </div>
        )}

        <div className="mb-1.5 space-y-1">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
            <label className="flex items-center gap-1.5">
              <span>主体の上限</span>
              <input
                type="number"
                min={2}
                max={12}
                data-vta-focus-id="subject-limit-input"
                aria-label="抽出する主体の最大数"
                value={subjectLimit}
                onChange={(e) => setSubjectLimit(Number(e.target.value))}
                className="w-14 bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200 text-center"
              />
              <span className="text-[11px] text-slate-400">個</span>
            </label>
          </div>
          <p className="text-[10px] text-slate-400">
            上限を超えた主体は所属先または「その他の関係者」へ統合され、イベントは削除されません
          </p>
        </div>
        <textarea
          rows={5}
          value={scenarioText}
          readOnly={isExtracting}
          aria-readonly={isExtracting}
          title={isExtracting ? 'AI処理中は本文を編集できません（中断すると編集できます）' : undefined}
          onChange={(e) => { if (useVTAStore.getState().isExtracting) return; setScenarioText(e.target.value); setPendingSchema(null); }}
          placeholder="事故やトラブルのシナリオを時系列の文章で入力するか、ファイルをドラッグ＆ドロップしてください..."
          className="w-full bg-slate-950 border border-slate-700/80 rounded-lg p-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 leading-relaxed font-sans resize-y"
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-500 px-0.5">
        <span>💡 .txt / .md / .docx / .pdf / .xlsx を直接ドロップ可能</span>
        <span>{scenarioText.length.toLocaleString()} 文字</span>
      </div>

      <div className="space-y-2">
        {/* Collapsible Advanced Generation Options */}
        <details className="rounded-lg bg-slate-950/60 border border-slate-800 px-2.5 py-2 text-xs text-slate-300">
          <summary className="cursor-pointer select-none font-semibold text-slate-300 hover:text-cyan-300 flex items-center justify-between text-[11px]">
            <span>生成の詳細オプション</span>
            <span className="text-[10px] font-normal text-slate-500">事後除外・仮判定自動反映・最適化設定</span>
          </summary>

          <div className="pt-2.5 mt-2 border-t border-slate-800/80 space-y-2">
            {/* Post-Outcome Scope Exclusion Checkbox */}
            <label htmlFor="vta-exclude-post-outcome-checkbox" className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                id="vta-exclude-post-outcome-checkbox"
                disabled={isExtracting}
                checked={excludePostOutcomeActivities}
                onChange={(e) => setExcludePostOutcomeActivities(e.target.checked)}
                className="mt-0.5 w-3.5 h-3.5 rounded text-cyan-500 focus:ring-cyan-500 border-slate-700 bg-slate-900 cursor-pointer disabled:opacity-50"
              />
              <span className="text-[11px] space-y-0.5 flex-1">
                <span className="flex items-center gap-1.5 font-semibold text-slate-200">
                  <span>帰結以後の調査・事後活動を除外</span>
                  <span className="text-[9px] px-1 py-0.2 rounded bg-cyan-950/90 border border-cyan-800/80 text-cyan-300 font-normal">推奨</span>
                </span>
                <span className="block text-[10px] text-slate-400 leading-tight">
                  事故調査等の事後手続きを除外し、原因連鎖に集中します。
                </span>
              </span>
            </label>

            {/* Auto-Adopt Preliminary Classifications Checkbox */}
            <label htmlFor="vta-auto-adopt-preliminary-checkbox" className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                id="vta-auto-adopt-preliminary-checkbox"
                disabled={isExtracting}
                checked={autoAdoptPreliminaryOnExtract}
                onChange={(e) => setAutoAdoptPreliminaryOnExtract(e.target.checked)}
                className="mt-0.5 w-3.5 h-3.5 rounded text-cyan-500 focus:ring-cyan-500 border-slate-700 bg-slate-900 cursor-pointer disabled:opacity-50"
              />
              <span className="text-[11px] space-y-0.5 flex-1">
                <span className="flex items-center gap-1.5 font-semibold text-slate-200">
                  <span>抽出完了時にAI仮判定を自動反映</span>
                  <span className="text-[9px] px-1 py-0.2 rounded bg-cyan-950/90 border border-cyan-800/80 text-cyan-300 font-normal">推奨</span>
                </span>
                <span className="block text-[10px] text-slate-400 leading-tight">
                  自動生成の直後から変動要因・通常作業を色分け表示します。
                </span>
              </span>
            </label>

            <button
              type="button"
              onClick={() => setIsOptimizationSettingsOpen(true)}
              className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-[11px] text-cyan-300 font-medium cursor-pointer transition-colors"
            >
              <Sliders className="w-3 h-3" />
              <span>最適化パラメータ・周辺主体集約の詳細設定...</span>
            </button>
          </div>
        </details>

        {isExtracting && (
          <div className="p-2.5 bg-cyan-950/70 border border-cyan-800/80 rounded-lg text-xs text-cyan-300 space-y-2 animate-in fade-in-50">
            <div className="flex items-center justify-between font-semibold">
              <span className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                <span>{generationProgress.title || 'AI推論中...'}</span>
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px]">{elapsedSeconds}秒経過</span>
                <button
                  type="button"
                  onClick={cancelCurrentOperation}
                  className="px-2 py-0.5 bg-rose-900/80 hover:bg-rose-800 text-rose-200 border border-rose-600/80 rounded text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer shadow-sm"
                  title="推論リクエストを即座に中断・キャンセル"
                >
                  <StopCircle className="w-3 h-3 text-rose-300" />
                  <span>中断</span>
                </button>
              </div>
            </div>
            <p className="text-[11px] text-slate-300 font-sans leading-tight">
              {generationProgress.detail}
            </p>
          </div>
        )}

        {isExtracting ? (
          <div className="flex gap-2">
            <div className="flex-1 py-2 px-3 rounded-lg text-xs font-bold bg-slate-800 text-slate-400 flex items-center justify-center gap-2 cursor-wait">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              <span>VTAツリーを自動生成中... ({elapsedSeconds}s)</span>
            </div>
            <button
              type="button"
              onClick={cancelCurrentOperation}
              className="py-2 px-3.5 rounded-lg text-xs font-bold bg-rose-900/80 hover:bg-rose-800 text-rose-200 border border-rose-700/80 flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-md shadow-rose-950/50"
              title="リクエストを中断"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>中断</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-vta-focus-id="extract-trigger"
            onClick={handleExtractVTA}
            disabled={isParsingFile}
            title={isParsingFile ? 'ファイルの解析が完了してから実行してください' : undefined}
            className="w-full py-2.5 px-3 rounded-lg text-xs font-bold bg-gradient-to-r from-cyan-600 via-sky-600 to-blue-600 hover:from-cyan-500 hover:via-sky-500 hover:to-blue-500 text-white flex items-center justify-center gap-2 transition-all shadow-md shadow-cyan-950/50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles className="w-4 h-4 text-cyan-200" />
            <span>⚡ VTAツリー自動生成</span>
          </button>
        )}

        {!isExtracting && vtaData.analysis && (
          <div className="pt-1 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>抽出済み（イベント {totalEventsCount}件）</span>
            </span>
            <button
              type="button"
              onClick={() => setWorkflowStep('review')}
              className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-semibold cursor-pointer transition-colors"
            >
              <span>② 検証・要因判定へ進む</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </section>

    <section
      hidden={workflowStep !== 'review'}
      className={workflowStep === 'review' ? 'bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-3 shadow-md' : 'hidden'}
    >
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <ClipboardCheck className="w-4 h-4 text-cyan-400" />
          <span>イベント・主体の検証と変動要因判定</span>
        </div>
        {vtaData.analysis && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
            全 {totalEventsCount}件
          </span>
        )}
      </div>

      {!vtaData.analysis ? (
        <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800 text-xs text-slate-400 space-y-2">
          <p>まだイベント・主体の抽出データがありません。先にステップ①でシナリオからVTAツリーを自動生成してください。</p>
          <button
            type="button"
            onClick={() => setWorkflowStep('input')}
            className="px-3 py-1.5 rounded-lg bg-cyan-900/60 hover:bg-cyan-800/80 border border-cyan-700 text-cyan-200 text-xs font-semibold cursor-pointer transition-colors"
          >
            ① シナリオ・抽出タブへ戻る
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Extraction & Classification Status Summary */}
          <div className="grid grid-cols-3 gap-2 text-center bg-slate-950/80 border border-slate-800 rounded-lg p-2 text-[11px]">
            <div>
              <span className="text-slate-400 block text-[10px]">変動要因</span>
              <span className="font-mono font-bold text-amber-300 text-sm">{variationEventsCount}</span>
              <span className="text-slate-500 text-[10px] ml-0.5">件</span>
            </div>
            <div className="border-x border-slate-800">
              <span className="text-slate-400 block text-[10px]">通常作業</span>
              <span className="font-mono font-bold text-slate-200 text-sm">{normalEventsCount}</span>
              <span className="text-slate-500 text-[10px] ml-0.5">件</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">未判定</span>
              <span className={`font-mono font-bold text-sm ${unclassifiedEventsCount > 0 ? 'text-cyan-300' : 'text-slate-500'}`}>
                {unclassifiedEventsCount}
              </span>
              <span className="text-slate-500 text-[10px] ml-0.5">件</span>
            </div>
          </div>

          {/* 1. Batch Adopt Preliminary Classifications (shown when unclassified preliminary items exist) */}
          {!pendingSchema && !isExtracting && (outsideVariationPrelimCount > 0 || outsideAllPrelimCount > 0) && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-cyan-700/60 bg-cyan-950/30 p-2.5">
              <div className="text-[11px] text-slate-200 font-semibold flex items-center justify-between">
                <span>⚡ 仮判定の図面一括反映</span>
                <span className="text-[10px] text-slate-400 font-normal">Ctrl+Z で取消可</span>
              </div>
              <p className="text-[10.5px] text-slate-400 leading-tight">
                抽出時のAI仮判定をワンクリックでVTA図へ採用できます。
              </p>
              <div className="flex gap-1.5 flex-wrap pt-0.5">
                {outsideVariationPrelimCount > 0 && (
                  <button
                    type="button"
                    disabled={isUiActionBusy(uiTaskProgress, 'batch_adopt')}
                    data-vta-focus-id="batch-adopt-variation-outside"
                    onClick={() => handleBatchAdoptOutside('variation_only')}
                    className="flex-1 min-w-[120px] rounded-md border border-amber-500/70 bg-amber-950/60 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-900 disabled:opacity-50 transition-colors cursor-pointer"
                    title="未判定のイベントのうち、仮判定が変動要因となっているもののみをVTA図へ一括反映"
                  >
                    変動要因のみ一括採用 ({outsideVariationPrelimCount}件)
                  </button>
                )}
                {outsideAllPrelimCount > 0 && (
                  <button
                    type="button"
                    disabled={isUiActionBusy(uiTaskProgress, 'batch_adopt')}
                    data-vta-focus-id="batch-adopt-all-outside"
                    onClick={() => handleBatchAdoptOutside('all')}
                    className="flex-1 min-w-[120px] rounded-md border border-cyan-600/70 bg-cyan-950/60 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-900 disabled:opacity-50 transition-colors cursor-pointer"
                    title="未判定のイベントのうち、仮判定（通常作業・変動要因）があるものをすべてVTA図へ一括反映"
                  >
                    全仮判定を一括採用 ({outsideAllPrelimCount}件)
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 2. AI Full Classification for Remaining Unclassified Events OR Quick Event Classification List */}
          {!isExtracting && unclassifiedEventsCount > 0 && (
            <button
              type="button"
              data-vta-focus-id="classify-trigger"
              onClick={() => void handleClassify()}
              className="w-full rounded-lg border border-amber-500/70 bg-amber-950/50 hover:bg-amber-900/60 px-3 py-2 text-xs font-semibold text-amber-200 transition-colors cursor-pointer"
            >
              確定したイベントの変動要因を判定 (未判定 {unclassifiedEventsCount}件)
            </button>
          )}

          {!pendingSchema && !isExtracting && unclassifiedEventsCount === 0 && totalEventsCount > 0 && (
            <div className="space-y-1.5 rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>全イベント判定済み（個別調整可）</span>
                </span>
                <span className="text-[10px] text-slate-400">クリックで通常/変動切替</span>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1 pr-0.5">
                {activeEventsList
                  .filter((ev) => !isIdentifiedOutcomeEvent(vtaData.analysis, ev))
                  .map((ev) => {
                    const isVar = ev.classification === 'variation';
                    const isNorm = ev.classification === 'normal';
                    const quickBusy = isUiActionBusy(uiTaskProgress, 'quick_classify');
                    return (
                      <div
                        key={ev.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/70 px-2 py-1 text-[11px]"
                      >
                        <div className="min-w-0 flex-1 truncate text-slate-200" title={ev.description || ev.title}>
                          {ev.time && <span className="text-slate-500 font-mono mr-1">[{ev.time}]</span>}
                          <span>{ev.title}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            disabled={quickBusy}
                            onClick={() => handleQuickEventClassification(ev.id, 'normal')}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium border cursor-pointer transition-colors ${
                              isNorm
                                ? 'bg-slate-700 border-slate-500 text-white'
                                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            通常
                          </button>
                          <button
                            type="button"
                            disabled={quickBusy}
                            onClick={() => handleQuickEventClassification(ev.id, 'variation')}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium border cursor-pointer transition-colors ${
                              isVar
                                ? 'bg-amber-900/90 border-amber-500 text-amber-200'
                                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-amber-300'
                            }`}
                          >
                            変動
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* 3. Event & Subject Assignment Review Panel */}
          {pendingSchema?.analysis && (
            <div ref={reviewPanelRef} className="space-y-2" role="status">
              {!reviewingCurrent && (
                <p className="rounded-lg border border-cyan-500 bg-cyan-950/70 px-3 py-2 text-xs font-semibold text-cyan-100">
                  抽出完了：イベント {pendingSchema.analysis.events.length} 件・カード {pendingSchema.nodes.length} 件。確認して図へ反映してください。
                </p>
              )}
              {isCurrentReviewStale && (
                <div role="alert" className="rounded-lg border border-amber-500/80 bg-amber-950/80 px-3 py-2 text-xs text-amber-200 space-y-1.5">
                  <p className="font-semibold">編集中にキャンバス側のVTA図が変更されました。そのまま反映するとキャンバス側の変更が上書きされます。</p>
                  <button
                    type="button"
                    onClick={() => {
                      const latest = useVTAStore.getState().vtaData;
                      setReviewBaseSchema(latest);
                      setPendingSchema(structuredClone(latest));
                    }}
                    className="rounded border border-amber-400 bg-amber-900/70 px-2.5 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-800 cursor-pointer"
                  >
                    最新の図を取り込み直す
                  </button>
                </div>
              )}
              <EventReviewPanel
                schema={pendingSchema}
                autoConnect={!reviewingCurrent}
                onChange={setPendingSchema}
                onCancel={() => {
                  setPendingSchema(null);
                  setReviewingCurrent(false);
                  setReviewBaseSchema(null);
                }}
                onConfirm={() => {
                  if (!reviewingCurrent && pendingSchema.analysis?.sources[0]?.text !== useVTAStore.getState().scenarioText) {
                    setError('入力テキストが変更されました。イベントを再抽出してください。');
                    setPendingSchema(null);
                    setReviewBaseSchema(null);
                    return;
                  }
                  if (reviewingCurrent) {
                    const current = useVTAStore.getState();
                    if (reviewBaseSchema !== null && current.vtaData !== reviewBaseSchema) {
                      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                        const proceed = window.confirm('編集中にキャンバス側のVTA図が変更されています。この内容で上書き反映しますか？');
                        if (!proceed) return;
                      }
                    }
                    const shiftedNodes = shiftReactNodesForLaneChange(
                      reviewBaseSchema ?? current.vtaData,
                      pendingSchema,
                      current.nodes
                    );
                    const layout = calculateVTALayout(pendingSchema, shiftedNodes);
                    current.commitVTAChange({ schema: pendingSchema, nodes: layout.nodes, edges: layout.edges, laneBounds: layout.laneBounds });
                  } else {
                    setVTAData(pendingSchema);
                    showToast('success', `イベント ${pendingSchema.analysis?.events.length ?? 0} 件をVTA図へ反映しました。`);
                  }
                  setPendingSchema(null);
                  setReviewingCurrent(false);
                  setReviewBaseSchema(null);
                }}
              />
            </div>
          )}

          {!pendingSchema && !isExtracting && (
            <button
              type="button"
              data-vta-focus-id="review-current-trigger"
              onClick={() => {
                setReviewingCurrent(true);
                setReviewBaseSchema(vtaData);
                setPendingSchema(structuredClone(vtaData));
              }}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition-colors cursor-pointer"
            >
              イベント・主体の割当を確認・編集
            </button>
          )}

          {/* 4. Next Step Navigation */}
          <div className="pt-2 border-t border-slate-800/80 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setWorkflowStep('measures')}
              className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 font-semibold cursor-pointer transition-colors"
            >
              <span>③ 対策・改善生成へ進む</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </section>
    </>
  );
};
