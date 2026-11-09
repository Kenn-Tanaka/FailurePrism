# ADR-0025: AI診断トレースのノイズ除去・仮適用記録分離と全パイプライン観測性強化

## Status
Accepted

## Date
2026-11-09

## Target Components
- `src/tools/vta/features/vta/utils/eventAnalysis.ts` (`projectAnalysis`)
- `src/tools/vta/features/vta/utils/chainRepair.ts` (`applyChainDelta`, `validateChainRows`)
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts` (`buildAIDiagnostics`, `formatAIDiagnosticsAsMarkdown`)
- `tests/vta/aiDiagnostics.test.ts`

## Related Requirements / ADRs
- [ADR-0009: 構造化AI診断パッケージとログ分析コスト最適化アーキテクチャ](file:///docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md)
- [ADR-0012: 連鎖修復差分検証における既存関係サニタイズと巻き添えリジェクト防止ポリシー](file:///docs/adr/0012-chain-repair-delta-validation-and-relation-sanitization.md)
- [ADR-0016: 粒度反復方式における仮判定パイプラインの分離と段階的評価アーキテクチャ](file:///docs/adr/0016-preliminary-classification-pipeline-separation.md)
- [ADR-0021: VTA AI生成プロセスの実パイプライン履歴記録と完全変遷動的リプレイ](file:///docs/adr/0021-vta-pipeline-history-snapshots-and-evolution-replay.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

AI診断パッケージ（[ADR-0009](file:///docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md)）は、長大な事故報告書のパイプライン実行結果をコンパクトかつ高密度に構造化出力（YAML/Markdown）し、LLMエージェントおよび開発者が迅速に根本原因を特定できるように設計された。

しかし、長大報告書（羽田空港衝突事故シナリオ等）の正常完了（SUCCESS）時および複雑な修復を伴う実行時において、以下の課題が顕在化した：

1. **連鎖修復ドライランによる `graph.projection` 遷移ログの過剰記録（20回以上の重複遷移）**:
   - `chainRepair.ts:validateChainRows()` において、提案された候補行を1行ずつ評価する際、`applyChainDelta(schema, [...accepted, row], false)` を呼び出していた。
   - `applyChainDelta` 内部で `projectAnalysis()` が実行され、グローバルなデバッグレコーダー（`debugRecorder.record('graph.projection', ...)`）へ無条件に記録されていた。
   - 候補行が20行以上ある場合、確定前のドライラン試行がすべて `graph.projection` 遷移としてレコーダーに蓄積され、診断出力の `Pipeline State Transitions` が `graph.projection` の同一カウント（cards: 81, events: 81）で埋め尽くされ、真のパイプライン遷移（粒度反復、採用判定など）を埋没させていた。
2. **連続する同一状態遷移の非圧縮出力**:
   - UI再描画や複数回の同一イベント・カード数での投影遷移が連続した場合、診断ログが冗長化しトークン枠を浪費していた。
3. **後続ステージ（Stage 1b / Stage 3）および通信メトリクスの観測性欠落**:
   - Stage 1b（仮判定パイプライン、[ADR-0016](file:///docs/adr/0016-preliminary-classification-pipeline-separation.md)）の `preliminary.classification` や、Stage 3（因果連鎖接続提案・連鎖修復）の `connection.proposal`, `chain.repair`, `pipeline.completed` が状態遷移に記録されていなかった。
   - 接続提案の行バリデーション（`connection-proposal.validation`）でリジェクトされた無効行の警告が `anomalies` に反映されていなかった。
   - 状態遷移の `counts` に `edges`（関係数）が含まれておらず、ノード数だけでなくトポロジー（因果線の構築推移）が把握できなかった。
   - `Execution Meta` にLLM呼び出し回数（`llm_calls`）、累計API通信時間（`total_llm_ms`）、最終帰結情報（`outcome`）が欠落しており、正常終了時に「パイプライン全体の所要時間配分」や「帰結ノードの特定成否」が診断パッケージ単体で判定できなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **決定論的かつ汚染のないトレース記録**:
  連鎖修復等の候補評価（ドライラン）は本採用されるか不明な投機的計算であるため、本番のデバッグトレースや状態遷移ログを汚染してはならない。
- **診断パッケージの自己完結性（Self-sufficiency）**:
  エラー調査時だけでなく、正常完了（SUCCESS）時にも「意図した品質でグラフが構築されたか」「帰結は正しく特定されたか」「LLM通信にボトルネックはなかったか」を外部ログを開くことなく診断パッケージのみで判定できること。
- **LLMコンテキスト消費の極小化**:
  同一遷移が連続する場合はランレングス圧縮（Run-Length Compression: `(xN)`）を行い、情報量を落とさずにトークン数を最小限に抑えること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A: `aiDiagnostics.ts` 側でのみ同一遷移をフィルタリングする**:
  - `graph.projection` の重複を診断整形時に除去する。
  - *問題点*: デバッグレコーダーのインメモリバッファ自体はドライランの大量のエントリで汚染されたままであり、`traceEntityLineage` などのエンティティ追跡処理にも不要な計算負荷とノイズを与える。根本原因（ドライラン時のレコーダー記録）が解決されない。
- **選択肢 B: ドライラン分離フラグ（`silentDebug`）の導入 ＋ 診断時のランレングス圧縮 ＋ 全ステージ観測性強化（採用）**:
  - `projectAnalysis` に `options?: { silentDebug?: boolean }` を新設し、`applyChainDelta` の `permanent = false`（ドライラン）時は `silentDebug: true` を渡してデバッグ記録を抑止する。
  - 診断レコーダー整形器側で連続する同一遷移を `notes: "... (xN)"` としてランレングス圧縮する多層防御を敷く。
  - Stage 1b / Stage 3 の各ステージ遷移、`counts.edges`、LLM通信統計、帰結メタデータを診断出力に追加する。

---

## 4. 決定事項 (Decision Outcome)

選択肢 B を採用し、以下の設計を適用した。

### 1. `projectAnalysis` の `silentDebug` オプション新設
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`:
  ```typescript
  export function projectAnalysis(
    analysis: VTAAnalysisData,
    options?: { silentDebug?: boolean },
  ): VTAAnalysisData {
    // ...
    if (!options?.silentDebug) {
      debugRecorder.record('graph.projection', {
        step: 'graph.projection',
        status: 'SUCCESS',
        cardCount: cards.length,
        eventCount: totalEvents,
        // ...
      });
    }
    return analysis;
  }
  ```

### 2. `chainRepair.ts` における仮適用ドライランの記録抑止
- `src/tools/vta/features/vta/utils/chainRepair.ts`:
  ```typescript
  export function applyChainDelta(
    schema: VTASchema,
    rows: ChainProposalRow[],
    permanent = false,
  ): ChainRepairDeltaResult {
    // ...
    const projected = projectAnalysis(clonedAnalysis, { silentDebug: !permanent });
    // ...
  }
  ```
  これにより、`validateChainRows` 等の候補行テストループ中に生成される大量の暫定プロジェクションがデバッグレコーダーに流入することを根本遮断した。

### 3. パイプライン状態遷移のランレングス圧縮
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`:
  連続する同一の `phase` かつ `counts`（cards, events, edges）の遷移は、別個の行として出力せず直前の遷移に集約し、`notes` に `(xN)` を追記する。
  ```yaml
  - phase: "graph.projection"
    counts: {"cards":81,"events":81,"edges":95}
    notes: "generation: refined-chain@1 (x3)"
  ```

### 4. Stage 1b / Stage 3 遷移および `counts.edges` の観測
- `preliminary.classification`（Stage 1b: 確定件数・未判定件数・除外件数）
- `connection.proposal`（Stage 3: 提案関係数、リジェクト数、採用行数）
- `chain.repair`（連鎖修復適用数）
- `pipeline.completed`（最終ノード・エッジ数）
- `counts` に `edges` を追加し、エッジトポロジーの増減推移を可視化。

### 5. `Execution Meta` への通信統計と帰結メタデータ付与
- `llm_calls`: パイプライン全体におけるLLM呼び出し回数（`llm.request` 記録から算出）
- `total_llm_ms`: LLM通信所要時間の合算値（ミリ秒）
- `outcome`: 終局帰結の判定結果（`status: identified | not_found | uncertain`、`kind`、`event_ids`）

---

## 5. 結果と影響 (Consequences)

### メリット
- **トレースログの清浄化**: 連鎖修復の試行回数に依存せず、デバッグレコーダーおよび診断パッケージの状態遷移ログが真のパイプライン変遷のみを保持するようになった。
- **品質診断の自律性**: SUCCESS 時の診断パッケージから「帰結特定」「エッジ接続数」「LLM消費回数・所要時間」「各ステージの異常警告」が即座に読解可能となり、手作業での生ログ追跡が不要になった。
- **トークン効率の大幅向上**: 重複遷移のランレングス圧縮により、状態遷移ブロックの行数が最大70%以上削減された。

### トレードオフ・考慮事項
- 既存のテストスイート等で `debugRecorder.getEntries()` の件数を直接ハードコードして検証しているテストがある場合、ドライランの件数減によりアサーションの調整が必要となる（本改訂に伴い `aiDiagnostics.test.ts` を網羅的に更新・追加済み）。

### 影響ファイル
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/features/vta/utils/chainRepair.ts`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `tests/vta/aiDiagnostics.test.ts`
- `docs/adr/0025-ai-diagnostics-trace-hygiene-and-full-pipeline-observability.md`
- `docs/adr/README.md`
