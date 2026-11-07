# ADR-0021: VTA AI生成プロセスの実パイプライン履歴記録と完全変遷動的リプレイ (VTA Pipeline History Snapshots and Complete Evolution Dynamic Replay)

- **ステータス**: Accepted
- **決定日**: 2026-11-07
- **対象コンポーネント**: VTA Pipeline History (`src/tools/vta/features/vta/utils/pipelineHistory.ts`), Animation Sequencer (`src/tools/vta/features/vta/utils/animationSequencer.ts`), VTA Canvas (`src/tools/vta/features/vta/components/VTACanvas.tsx`), SVG Export (`src/tools/vta/features/vta/utils/animatedSvgExport.ts`), VTA Generation Pipeline (`src/tools/vta/services/llm/client.ts`, `src/tools/vta/features/vta/store/vtaStore.ts`)
- **関連要件 / ADR**: ADR-0001, ADR-0003, ADR-0006, ADR-0008, ADR-0010, ADR-0011, ADR-0020

---

## 1. コンテキストと課題 (Context & Problem Statement)

VTAエディタには、ツリーの動的リプレイ機能（`causal_flow`: 事故時系列因果リプレイ、および `pipeline_evolution`: AI生成プロセス進化リプレイ）が実装されている（ADR-0006）。

しかし、羽田空港事故データ等の大規模インシデントにおいて「🧠 AI生成プロセス」モードを再生した際、**「画面上でVTA図の変遷が全く起きず、最初から完成図が表示されたまま静止しているように見える」** という重大な課題がユーザーより報告された。

### 根本原因の分析

1. **データ構造上の限界（中間状態の破棄と疑似シミュレーション）**:
   - AI推論パイプライン（全文正規化・抽出 $\rightarrow$ 粒度反復最適化 $\rightarrow$ ノード自動接続 $\rightarrow$ 変動要因判定）の実行時、各ステージの中間ツリースナップショットは保持されず、最終成果物（1つの `vtaData`）のみがメモリに残されていた。
   - そのため、リプレイ機能は完成ツリーに対して同一のカード群を表示したまま、CSS の opacity や drop-shadow のみでステージ進行を疑似表現しようとしていた。
2. **エッジ可視性判定の論理和バグ**:
   - `VTACanvas.tsx` のエッジ表示判定において、`animationStep.activeEdgeIds.includes(edgeId) || (animationStep.activeNodeIds.includes(e.source) && animationStep.activeNodeIds.includes(e.target))` と記述されていた。
   - Stage 1（抽出直後）や Stage 2（粒度最適化）では `activeEdgeIds: []`（エッジ非表示）が指定されていたが、全ノードが表示されているため右辺が常に真となり、**Stage 1 の時点からすべてのエッジが100%描画されていた**。その結果、Stage 3（ノード自動接続）でエッジが現れる変遷が完全に消失していた。
3. **ノードの未分類/変動要因判定の着色未反映**:
   - React Flow のノードコンポーネントは常に最新データの `type: 'variation'` や `outcome` を参照して描画されていたため、Stage 1〜3 でも既にノードが黄色や赤色で描画されており、色の変遷が知覚できなかった。
4. **スイムレーン背景との幾何的不整合**:
   - Stage 1 では細粒度主体が展開され、Stage 2 では主体が集約されるが、キャンバス背景のスイムレーン枠（`SwimlaneBackground`）が固定されていたため、動的なレーン数変化に対応できていなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **実パイプライン履歴の忠実な記録と復元**:
  - AI推論パイプラインの各段階におけるツリー構造（ノード、エッジ、レーン、判定状態）をスナップショットとして保持し、リプレイ時に忠実に切り替え表示すること。
- **データ肥大化と localStorage 容量制限の回避**:
  - `VTASchema` に含まれる長大な原文テキスト（約2.8万文字の `sources`）や監査ログを各ステージに丸ごと重複ネストすると、データ容量が爆発（$O(2^N)$）しストレージ上限を超過するため、軽量な描画スナップショット構造とすること。
- **既存データ（過去の保存ファイル）に対する 100% ロスレス復元**:
  - `pipelineHistory` が未記録の既存プロジェクト（羽田事故データ等）であっても、`analysis` 台帳に蓄積されている `subjectRanking.originalEntities`（19主体）、`participations.mergedFrom`、関係の来歴を利用して、既存の `revertConsolidation` により初期抽出ツリー（19レーン）から完成ツリーまでの4ステージを完全復元できること。
- **キャンバスの Read-Only 保護**:
  - スナップショット切り替え表示中に React Flow の内部寸法イベントが発火しても、本体ストアの座標や dirty フラグを誤上書きしないこと。
- **Animated SVG 出力（ゼロJavaScript）との完全整合**:
  - ブラウザやPowerPointスライドで再生される純粋CSS `@keyframes` 内蔵 Animated SVG においても、エッジ伸長と段階的カラーリングが同期すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 画面描画ロジックのみを修正するクイック修正（疑似シミュレーションの継続）**
  - *問題点*: エッジの非表示やグレースケール化は可能だが、Stage 1 での細粒度主体（19レーン）$\rightarrow$ Stage 2 での集約（7レーン）といった、AIパイプライン最大の価値である「主体の統合と客体化の変遷」を表現できない。
- **選択肢2: 各ステージの完全な `VTASchema`（原文・台帳含む）を配列で保存する**
  - *問題点*: 原文テキストや事実データが4重に複製され、ファイルサイズが数MB〜十数MBに膨れ上がり、`localStorage`（5MB制限）でクォータ超過エラーを引き起こす。
- **選択肢3: 軽量スナップショット構造（`VTAPipelineSnapshot`）の導入と、既存データからの動的ロスレス復元（採用）**
  - *利点*: 原文や重複台帳を排除し、描画・幾何計算に必要な要素（`lanes`, `nodes`, `edges`, `presentation`, `stats`）のみを保持。既存ファイルからも `revertConsolidation` と来歴メタデータにより 19レーンからの完全な変遷を動的再構成可能。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 軽量スナップショット型定義 (`VTAPipelineSnapshot`)

```typescript
export interface VTAPipelineSnapshot {
  id: VTAPipelineStageId | string;
  stageIndex: number;          // 0: 正規化抽出, 1: 粒度最適化, 2: 自動接続, 3: 変動判定
  title: string;               // e.g. 'Stage 1: 全文正規化 (初期抽出)'
  subtitle: string;            // e.g. 'イベント 42件、主体 19列'
  description: string;         // ステージの詳細な解説・アルゴリズム説明
  timestamp: string;           // ISO 8601
  lanes: string[];             // そのステージ時点のレーン一覧
  nodes: VTANodeData[];        // そのステージ時点のノード一覧
  edges: VTAEdgeData[];        // そのステージ時点のエッジ一覧
  presentation?: VTAPresentation;
  stats: {
    eventCount: number;
    nodeCount: number;
    laneCount: number;
    edgeCount: number;
    variationCount: number;
    outcomeCount: number;
  };
}
```

### 4.2 パイプライン実行箇所でのリアルタイムスナップショット記録

- **Stage 1 (全文正規化)**: `client.ts` の `extractEventDraft` 内で `normalizeSource` 直後。統合前の全細粒度主体を展開し、全ノードを未判定（白カード）、初期台帳関係のみで構築。
- **Stage 2 (粒度反復最適化)**: `refineGranularity` 直後。主体を上限数に集約し、客体ノードを分離。反復スコア推移（例: `S=0.507 → 0.619`）を記録。
- **Stage 3 (ノード自動接続)**: `ScenarioInputSection.tsx` の `autoConnectVTA` 直後（および `autoConnectNodes` 実行時）。レーン間伝達および連鎖補完エッジを結線。ノードは未判定（白カード）。
- **Stage 4 (変動要因判定・帰結確定)**: `classifyEventDraft` および `batchAdoptPreliminary` 直後。通常作業（白）・変動要因（黄/橙）・帰結（赤）の判定・確定と発光効果を適用。

### 4.3 既存データからの 19レーン完全ロスレス復元 (`resolvePipelineSnapshots`)

`pipelineHistory` を持たない既存データに対して、`vtaData.analysis.subjectRanking` と `revertConsolidation` を用いて、初期の19主体レーンから段階的に集約・結線・着色される実変遷ツリーを自動導出・提供。

### 4.4 キャンバス描画とスイムレーン背景の完全同期・Read-Only 保護

- `VTACanvas.tsx` において、`isAnimationPlayerOpen && animationStep?.snapshotLayout` が有効な場合、`displayNodes`, `displayEdges`, `displayLaneBounds` をスナップショットのレイアウト結果に切り替え。
- `onNodesChange` / `onEdgesChange` に `if (isAnimationPlayerOpen) return;` を設け、リプレイ再生中の寸法計測イベントによる本体データ書き換えを防止。
- ステージ切替時に `fitView` が滑らかにカメラを追従。

---

## 5. 結果と影響 (Consequences)

### メリット
- **AI生成プロセスの完全な可視化**: 事故調査官や分析者が「初期抽出（19レーン） $\rightarrow$ 認知負荷最適化（7レーン） $\rightarrow$ 因果ネットワーク結線 $\rightarrow$ 変動要因特定」というAIの思考・生成プロセスを手に取るように確認できる。
- **既存データでの即座の動作**: 羽田事故データなど既存の保存ファイルを開いた場合でも、追加のAI推論コスト（トークン消費や待機時間）なしで、過去の生成プロセスの実変遷が即座に美しく再生される。
- **エッジ描画バグの根絶**: エッジ可視性の論理和バグが解消され、因果リプレイ・推論リプレイともに正しい結線タイミングが保証される。
- **軽量・安全**: 原文データの重複を排除し、保存容量とメモリフットプリントを最小限に抑え、React Flow からの誤書き込みを防止。

### 影響ファイル
- `src/tools/vta/types/vta.ts` (型定義追加)
- `src/tools/vta/features/vta/utils/pipelineHistory.ts` (新規: スナップショット生成・復元)
- `src/tools/vta/features/vta/utils/animationSequencer.ts` (レイアウト付きステップ生成)
- `src/tools/vta/features/vta/components/VTACanvas.tsx` (スナップショット描画切替・ガード)
- `src/tools/vta/features/vta/utils/animatedSvgExport.ts` (CSS同期)
- `src/tools/vta/services/llm/client.ts` (Stage 1 / Stage 2 記録)
- `src/tools/vta/components/control-panel/ScenarioInputSection.tsx` (Stage 3 / Stage 4 記録)
- `src/tools/vta/features/vta/store/vtaStore.ts` (自動接続・再最適化時の履歴更新)
- `tests/vta/pipelineHistory.test.ts` (新規単体テスト)
- `tests/vta/animationSequencer.test.ts` (テスト拡充)
- `docs/adr/README.md` (ADR Index 更新)
