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
} from 'lucide-react';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { SAMPLE_SCENARIOS } from '../../features/vta/data/sampleData';
import { parseFileToScenarioText } from '../../features/vta/utils/fileIngestion';
import { classifyEventDraft, extractEventDraft } from '../../services/llm/client';
import { autoConnectVTA } from '../../services/generation/autoConnectionService';
import { projectAnalysis, batchAdoptPreliminary, type BatchAdoptMode } from '../../features/vta/utils/eventAnalysis';
import { calculateVTALayout } from '../../features/vta/utils/layout';
import { createPipelineSnapshot, upsertPipelineSnapshot } from '../../features/vta/utils/pipelineHistory';
import { EventReviewPanel } from './EventReviewPanel';

export const ScenarioInputSection: React.FC = () => {
  const scenarioText = useVTAStore((state) => state.scenarioText);
  const setScenarioText = useVTAStore((state) => state.setScenarioText);
  const selectedSampleId = useVTAStore((state) => state.selectedSampleId);
  const loadSample = useVTAStore((state) => state.loadSample);
  const isDirty = useVTAStore((state) => state.isDirty);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const setIsExtracting = useVTAStore((state) => state.setIsExtracting);
  const generationProgress = useVTAStore((state) => state.generationProgress);
  const resetGenerationProgress = useVTAStore((state) => state.resetGenerationProgress);
  const llmConfig = useVTAStore((state) => state.llmConfig);
  const setVTAData = useVTAStore((state) => state.setVTAData);
  const setError = useVTAStore((state) => state.setError);
  const addLog = useVTAStore((state) => state.addLog);
  const showToast = useVTAStore((state) => state.showToast);
  const importProjectJSON = useVTAStore((state) => state.importProjectJSON);
  const createAbortController = useVTAStore((state) => state.createAbortController);
  const cancelCurrentOperation = useVTAStore((state) => state.cancelCurrentOperation);
  const vtaData = useVTAStore((state) => state.vtaData);
  const subjectLimit = useVTAStore((state) => state.subjectLimit);
  const setSubjectLimit = useVTAStore((state) => state.setSubjectLimit);
  const excludePostOutcomeActivities = useVTAStore((state) => state.excludePostOutcomeActivities);
  const setExcludePostOutcomeActivities = useVTAStore((state) => state.setExcludePostOutcomeActivities);

  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isParsingFile, setIsParsingFile] = useState(false);
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

    if (file.name.endsWith('.json')) {
      if (isDirty) {
        const confirmDiscard = window.confirm(
          '現在のプロジェクトに変更が保存されていません。\n破棄して別のファイルを読み込みますか？\n（キャンセルして先に「プロジェクト保存」を行うことができます）'
        );
        if (!confirmDiscard) {
          return;
        }
      }
      try {
        const text = await file.text();
        const res = importProjectJSON(text);
        if (res.success) {
          setPendingSchema(null);
          addLog('success', `VTAプロジェクトファイル「${file.name}」を正常にインポートしました。`, 'PROJECT_IMPORT');
          setLoadedFileInfo({
            name: file.name,
            type: 'JSON',
            size: file.size,
            charCount: text.length,
          });
        } else {
          setError(`JSONのインポートに失敗しました: ${res.message}`);
          addLog('error', `インポート失敗: ${res.message}`, 'PROJECT_IMPORT');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'ファイルの読み込みに失敗しました。';
        setError(`ファイル読込エラー: ${msg}`);
      }
      return;
    }

    setIsParsingFile(true);
    setParsingProgress(null);
    setError(null);
    try {
      addLog('info', `ファイル「${file.name}」(${file.type || '未指定'}) の解析を開始します...`, 'FILE_PARSE');
      const result = await parseFileToScenarioText(file, (p) => {
        setParsingProgress(p.stage);
      });
      setScenarioText(result.text);
      setPendingSchema(null);
      setLoadedFileInfo({
        name: result.filename,
        type: result.fileType.toUpperCase(),
        size: result.sizeBytes,
        charCount: result.characterCount,
      });
      addLog(
        'success',
        `「${result.filename}」(${result.fileType.toUpperCase()}) の抽出完了: ${result.characterCount.toLocaleString()}文字をシナリオに入力しました。`,
        'FILE_PARSE'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'ファイル解析中にエラーが発生しました。';
      setError(`ファイル解析エラー: ${msg}`);
      addLog('error', `解析エラー「${file.name}」: ${msg}`, 'FILE_PARSE');
    } finally {
      setIsParsingFile(false);
      setParsingProgress(null);
    }
  };

  const handleExtractVTA = async () => {
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

    try {
      // ステップ 1: イベント・主体抽出と反復最適化 (refined-chain)
      const extractedSchema = await extractEventDraft(
        llmConfig,
        scenarioText,
        controller.signal,
        'refined-chain',
        subjectLimit,
        { excludePostOutcomeActivities }
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

      // ステップ 2: ノード自動接続（レーン間接続＋連鎖点検＋整流）の自動実行
      let finalSchema = extractedSchema;
      try {
        const connectResult = await autoConnectVTA(
          llmConfig,
          extractedSchema,
          controller.signal,
          (prog) => {
            const step = prog.stage === 'inter_lane' ? 2 : 3;
            useVTAStore.getState().setGenerationProgress({
              stepCurrent: step,
              stepTotal: 3,
              title: step === 2 ? '【2/3】レーン間接続の自動探索' : '【3/3】連鎖不足の補完と反映',
              detail: prog.message,
            });
          }
        );
        finalSchema = connectResult.schema;
        if (connectResult.warnings.length) {
          showToast('warn', connectResult.warnings.join('\n'));
        }
      } catch (connErr) {
        if (controller.signal.aborted) return;
        addLog(
          'warn',
          `[自動接続スキップ] 接続処理で警告が発生したため、抽出結果を直接反映します: ${
            connErr instanceof Error ? connErr.message : String(connErr)
          }`,
          '解析'
        );
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

      // Stage 3: ノード自動接続 (autoConnect) のスナップショットを生成
      const stage3Nodes = finalSchema.nodes.map((n) => ({
        ...n,
        type: (n.type === 'outcome' ? 'outcome' : 'normal') as import('../../types/vta').VTANodeType,
        variation_factor: undefined,
        measure_type: null,
      }));
      const stage3Snapshot = createPipelineSnapshot(
        'stage3_connect',
        2,
        'Stage 3: ノード自動接続 (autoConnect)',
        `レーン間伝達・前後連鎖エッジ ${finalSchema.edges.length}本の探索と補完`,
        '作業依存・資源移動・情報伝達および時系列連鎖をAIで自動探索し、完全な因果ネットワークを結線',
        {
          ...finalSchema,
          nodes: stage3Nodes,
        }
      );
      finalSchema = {
        ...finalSchema,
        pipelineHistory: upsertPipelineSnapshot(finalSchema.pipelineHistory, stage3Snapshot),
      };

      const layout = calculateVTALayout(finalSchema);
      useVTAStore.getState().commitVTAChange({
        schema: finalSchema,
        nodes: layout.nodes,
        edges: layout.edges,
        laneBounds: layout.laneBounds,
        preserveDerivedRemovals: true,
      });

      const eventCount = finalSchema.analysis?.events.length ?? 0;
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
        return;
      }
      if (useVTAStore.getState().currentProjectId !== currentProjectId) {
        return;
      }
      const message = err instanceof Error ? err.message : 'VTA図の抽出処理中にエラーが発生しました。';
      setError(message);
      showToast('error', `抽出結果を作成できませんでした: ${message}`);
      addLog('error', `[抽出失敗] ${message}`, '解析');
    } finally {
      if (useVTAStore.getState().currentProjectId === currentProjectId && useVTAStore.getState().activeRequestId === reqId) {
        setIsExtracting(false);
        resetGenerationProgress();
      }
    }
  };

  const handleClassify = async () => {
    const current = useVTAStore.getState();
    const analysis = current.vtaData.analysis;
    if (!analysis || !analysis.events.some((event) => event.classification === 'unclassified')) return;
    const projectId = current.currentProjectId;
    const schemaAtStart = current.vtaData;
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
      if (controller.signal.aborted || latest.currentProjectId !== projectId || latest.activeRequestId !== reqId
        || latest.vtaData !== schemaAtStart || latest.scenarioText !== scenarioAtStart) return;
      const schema = projectAnalysis(classified, latest.vtaData);
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
      latest.addLog('success', `イベント ${classified.events.length}件の変動判定を反映しました。`, '解析');
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
    const current = useVTAStore.getState();
    if (!current.vtaData.analysis) return;
    const { updatedAnalysis, totalCount, variationCount, normalCount } = batchAdoptPreliminary(
      current.vtaData.analysis,
      mode
    );
    if (totalCount === 0) return;
    const newSchema = projectAnalysis(updatedAnalysis, current.vtaData);
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
  };

  const outsideVariationPrelimCount =
    vtaData.analysis?.events.filter(
      (e) => e.classification === 'unclassified' && e.preliminary?.value === 'variation'
    ).length ?? 0;

  const outsideAllPrelimCount =
    vtaData.analysis?.events.filter(
      (e) =>
        e.classification === 'unclassified' &&
        (e.preliminary?.value === 'variation' || e.preliminary?.value === 'normal')
    ).length ?? 0;

  return (
    <section className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-3 shadow-md">
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

          <select
            value={selectedSampleId}
            onChange={(e) => {
              const newSampleId = e.target.value;
              if (newSampleId === selectedSampleId) return;
              if (isDirty) {
                const confirmed = window.confirm(
                  '現在の作業内容が破棄されますが、別のサンプルシナリオを読み込みますか？\n（未保存の変更内容は失われます）'
                );
                if (!confirmed) return;
              }
              loadSample(newSampleId);
              setPendingSchema(null);
              setLoadedFileInfo(null);
            }}
            className="bg-slate-950 border border-slate-700 text-slate-300 text-[11px] rounded-md px-2 py-1 focus:outline-none focus:border-cyan-500 max-w-[125px] truncate cursor-pointer"
          >
            {SAMPLE_SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
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
          onChange={(e) => { setScenarioText(e.target.value); setPendingSchema(null); }}
          placeholder="事故やトラブルのシナリオを時系列の文章で入力するか、ファイルをドラッグ＆ドロップしてください..."
          className="w-full bg-slate-950 border border-slate-700/80 rounded-lg p-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 leading-relaxed font-sans resize-y"
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-500 px-0.5">
        <span>💡 .txt / .md / .docx / .pdf / .xlsx を直接ドロップ可能</span>
        <span>{scenarioText.length.toLocaleString()} 文字</span>
      </div>

      <div className="space-y-2">
        {/* Post-Outcome Scope Exclusion Checkbox */}
        <div className="flex items-start gap-2.5 p-2 rounded-lg bg-slate-950/60 border border-slate-800 text-slate-300">
          <input
            type="checkbox"
            id="vta-exclude-post-outcome-checkbox"
            disabled={isExtracting}
            checked={excludePostOutcomeActivities}
            onChange={(e) => setExcludePostOutcomeActivities(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500 border-slate-700 bg-slate-900 cursor-pointer disabled:opacity-50"
          />
          <label htmlFor="vta-exclude-post-outcome-checkbox" className="text-xs cursor-pointer select-none space-y-0.5 flex-1">
            <div className="flex items-center gap-1.5 font-semibold text-slate-200">
              <span>帰結（事故発生）以後の調査・事後活動を除外</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950/90 border border-cyan-800/80 text-cyan-300 font-normal">
                推奨
              </span>
            </div>
            <p className="text-[10.5px] text-slate-400 leading-tight">
              事故調査委員会の発足や事後手続きを除外し、事故原因の連鎖に集中します（脱出退避や二次災害防止等は第二の帰結として保持）。
            </p>
          </label>
        </div>

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
            className="w-full py-2.5 px-3 rounded-lg text-xs font-bold bg-gradient-to-r from-cyan-600 via-sky-600 to-blue-600 hover:from-cyan-500 hover:via-sky-500 hover:to-blue-500 text-white flex items-center justify-center gap-2 transition-all shadow-md shadow-cyan-950/50 cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-cyan-200" />
            <span>⚡ VTAツリー自動生成</span>
          </button>
        )}
        {pendingSchema?.analysis && <div ref={reviewPanelRef} className="space-y-2" role="status">
          {!reviewingCurrent && <p className="rounded-lg border border-cyan-500 bg-cyan-950/70 px-3 py-2 text-xs font-semibold text-cyan-100">
            抽出完了：イベント {pendingSchema.analysis.events.length} 件・カード {pendingSchema.nodes.length} 件。確認して図へ反映してください。
          </p>}
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
          <EventReviewPanel schema={pendingSchema} autoConnect={!reviewingCurrent} onChange={setPendingSchema} onCancel={() => { setPendingSchema(null); setReviewingCurrent(false); setReviewBaseSchema(null); }}
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
                const layout = calculateVTALayout(pendingSchema, current.nodes);
                current.commitVTAChange({ schema: pendingSchema, nodes: layout.nodes, edges: layout.edges, laneBounds: layout.laneBounds });
              } else {
                setVTAData(pendingSchema);
                showToast('success', `イベント ${pendingSchema.analysis?.events.length ?? 0} 件をVTA図へ反映しました。`);
              }
              setPendingSchema(null);
              setReviewingCurrent(false);
              setReviewBaseSchema(null);
            }} />
        </div>}
        {!pendingSchema && !isExtracting && vtaData.analysis && (
          <button type="button" data-vta-focus-id="review-current-trigger" onClick={() => { setReviewingCurrent(true); setReviewBaseSchema(vtaData); setPendingSchema(structuredClone(vtaData)); }}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200">
            イベント・主体の割当を確認・編集
          </button>
        )}
        {!pendingSchema && !isExtracting && (outsideVariationPrelimCount > 0 || outsideAllPrelimCount > 0) && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-slate-700/80 bg-slate-900/60 p-2">
            <div className="text-[11px] text-slate-300 font-medium flex items-center justify-between">
              <span>⚡ 仮判定の図面一括反映</span>
              <span className="text-[10px] text-slate-400">Ctrl+Z で取消可</span>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {outsideVariationPrelimCount > 0 && (
                <button
                  type="button"
                  data-vta-focus-id="batch-adopt-variation-outside"
                  onClick={() => handleBatchAdoptOutside('variation_only')}
                  className="flex-1 min-w-[120px] rounded border border-amber-500/70 bg-amber-950/60 px-2 py-1.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-900 transition-colors"
                  title="未判定のイベントのうち、仮判定が変動要因となっているもののみをVTA図へ一括反映"
                >
                  変動要因のみ一括採用 ({outsideVariationPrelimCount}件)
                </button>
              )}
              {outsideAllPrelimCount > 0 && (
                <button
                  type="button"
                  data-vta-focus-id="batch-adopt-all-outside"
                  onClick={() => handleBatchAdoptOutside('all')}
                  className="flex-1 min-w-[120px] rounded border border-cyan-600/70 bg-cyan-950/60 px-2 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-900 transition-colors"
                  title="未判定のイベントのうち、仮判定（通常作業・変動要因）があるものをすべてVTA図へ一括反映"
                >
                  全仮判定を一括採用 ({outsideAllPrelimCount}件)
                </button>
              )}
            </div>
          </div>
        )}
        {!isExtracting && vtaData.analysis?.events.some((event) => event.classification === 'unclassified') && (
          <button type="button" data-vta-focus-id="classify-trigger" onClick={() => void handleClassify()}
            className="w-full rounded-lg border border-amber-500/70 bg-amber-950/50 px-3 py-2 text-xs font-semibold text-amber-200">
            確定したイベントの変動要因を判定
          </button>
        )}
      </div>
    </section>
  );
};
