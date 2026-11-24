# ADR-0044: 接続提案の上流重複候補フィルタ・パイプライン履歴/新規置換境界・同尺度反復評価および診断カウント分離ポリシー

- **ステータス**: `Accepted`
- **決定日**: 2026-11-18
- **対象コンポーネント**: `src/tools/vta/services/llm/client.ts`, `src/tools/vta/services/llm/eventPrompts.ts`, `src/tools/vta/features/vta/utils/connectionProposals.ts`, `src/tools/vta/services/generation/autoConnectionService.ts`, `src/tools/vta/services/generation/granularityRefinement.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`, `src/tools/vta/features/vta/utils/pipelineHistory.ts`, `src/tools/vta/features/vta/store/vtaStore.ts`, `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`, `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- **関連ドキュメント・コミット**: [ADR-0009](file:///docs/adr/0009-vta-ai-diagnostics-package.md), [ADR-0010](file:///docs/adr/0010-subject-poset-dag-and-canonical-inclusion.md), [ADR-0021](file:///docs/adr/0021-vta-pipeline-history-snapshots-and-evolution-replay.md), [ADR-0025](file:///docs/adr/0025-ai-diagnostics-trace-hygiene-and-full-pipeline-observability.md), [ADR-0043](file:///docs/adr/0043-poset-transitivity-across-ledger-and-lane-relation-preservation.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

`pipeline_status: "SUCCESS"` となった VTA 生成ログの診断により、構造上・観測上の以下の複合欠陥が特定された：

1. **接続提案（`connection.proposal`）の大量棄却ブラックボックス**:
   - `validateSelectedConnectionProposals` は VTA の「1カードペア1意味関係」配線設計（`layout.ts` / `vtaStore.ts`）を守るため、`manualConflict` で既存の非 `association` 関係を持つカードペアへの重複追加を拒絶する。
   - それにもかかわらず、上流の `proposeVTAConnections`（`client.ts`）が `dependencyCandidates` から既接続カードペアを除外せず `[作業依存の優先点検候補]` として LLM に提示し、システムプロンプトにも重複回避契約がなかったため、25件の提案の大部分が後段の `autoConnectionService.ts` で無言棄却されていた。また `parseConnectionProposalTSV` 側は Poset / `mergedFrom` に未対応であった。
2. **`pipelineHistory` 消失と新規生成結果の旧図誤突合**:
   - `projectAnalysis`（`eventAnalysis.ts`）が `previous?.pipelineHistory` を保持せず落としていたため、`extractEventDraft` や `Stage 3/4` で付与したステージ履歴スナップショットが後続の投影や再調和のたびに消滅していた。
   - さらに `ScenarioInputSection.tsx` が新規生成結果を通常の `commitVTAChange` で適用していたため、直前図の `vtaData` との不要な `reconcileAnalysis`（旧 `presentation` 継承・同名カード/関係ID衝突）と冗長な2回目の `graph.projection` が発生していた。
3. **粒度反復（`granularity.refinement`）の異尺度比較とログ可視性不足**:
   - `#0` は機械評価（`C1, C3, C5`）のみであるのに対し、`#1` は LLM 自己評価（`C2, C4, シナリオ`）を加算したスコア同士で比較するため、機械指標が悪化しても `#1` が採用されやすかった。また `group` 操作の Poset 引渡し・`suppress` 後の共有線/順序線再整合・#1以降の指標ログ出力が不足していた。
4. **AI診断パッケージ（`aiDiagnostics.ts`）の計数誤認・Poset展開不足**:
   - `aiDiagnostics.ts` が `graph.projection` の `nodes.length` を `events: nodes` として出力したため、実際の 48イベントに対し `72` / `68` と矛盾していた。
   - `Subject Poset DAG` 展開が統合後の残存 `entities` のみを参照しており、親主体・被統合主体および `merged_into` が欠落していた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- VTA キャンバスの「1カードペア1意味関係」配線制約（直交配線・`C5` 複雑度計算・手動接続ガード）を破壊しないこと。
- 上流から `autoConnectVTA`・`commitVTAChange` まで `pipelineHistory` と新規生成結果をロスレスかつ旧図汚染なしで伝播させること。
- 監査パネル（`NormalizationAuditPanel.tsx`）の `#0` 機械評価表現（`C2/C4: -`）と互換を保ちつつ、反復採択の判定を公正な同尺度基準で行うこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1: `validateSelectedConnectionProposals` の `manualConflict` を緩和して多重辺を許可する**
  - *不採用理由*: 同一カードペアへの多重矢印が増殖し、`vtaStore` の手動結線制約・直交配線ラベル配置・`C5` 次数/交差モデルと不整合を起こす。
- **選択肢 2 (採用): 配線制約は維持した上で上流候補フィルタ・重複回避契約・Poset正規化を行い、履歴保持・`replaceProject` 境界・同尺度採択判定・診断カウント分離を一貫導入する**

---

## 4. 決定事項 (Decision Outcome)

1. **接続提案の上流最適化と Poset 正規化**:
   - `proposeVTAConnections`（`client.ts`）の優先点検候補から既接続／手動／BREAK エッジを持つカードペアを除外し、`compileConnectionProposalSystemPrompt`（`eventPrompts.ts`）に `CONNECTION_PROPOSAL_DEDUP_POLICY` を冪等注入する。
   - `connectionProposals.ts` で `resolveCardsForRelationEndpoint` による Poset / `mergedFrom` の正規化と `*EntityOrigin` 保持を行い、同一カード／同一解決先ペアを除外する。
   - `autoConnectionService.ts` で `connection-proposal.adoption` イベントを `debugRecorder` に記録する（通常除外で UI 警告トーストを乱発しない）。
2. **`pipelineHistory` 保持と新規生成の `replaceProject` 境界**:
   - `projectAnalysis` で `previous?.pipelineHistory` を継承し、Stage 1 スナップショット構築（`client.ts`）および履歴動的復元（`pipelineHistory.ts`）の仮投影には `{ silentDebug: true }` を指定する。
   - `commitVTAChange`（`vtaStore.ts`）に `replaceProject?: boolean` を新設し、`ScenarioInputSection.tsx` の新規生成完了時は旧図退避（`previousBackupSnapshot`）と履歴リセットを行いつつ `reconcileAnalysis` / 旧 `presentation` マージをスキップする。
3. **粒度反復の同尺度比較と構造維持（`granularityRefinement.ts`）**:
   - `iterations[0]` の機械スコアは不変のまま保持し、初回比較時（`!hasLLMScoreBaseline`）のみ現行図 `bestSchema` に同じ `c2, c4, scenarioScore` を当てた `comparableBestScore` と機械スコア退行ガードで採択を判定する。ログには `C1`〜`C5` 内訳を出力し、`group` への Poset 引渡しと `suppress` 後の再整合を実施する。
4. **AI診断パッケージ精度向上（`eventAnalysis.ts` / `aiDiagnostics.ts`）**:
   - `graph.projection` に `eventsCount`・`visibleNodeCount`・`subjectRanking` を記録し、診断遷移で `events` と `nodes` を分離する。
   - `resolveEntityCatalogAndMerges` により `subjectRanking.originalEntities`・残存主体・Poset ノードを統合して全主体と `merged_into` を展開し、`granularity.refinement` `#0`（`adopted: true`）・#1以降指標・`connection-proposal.adoption`・`chain-repair.validation` 内訳を出力する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 無駄な重複接続提案が減少し、採択/除外の明細や差分セクション別内訳を診断パッケージから一目で検証できるようになる。
  - Stage 1〜3 で構築した `pipelineHistory` や新規生成ツリーの属性が保存され、旧図の残存設定によって汚染されなくなる。
  - `#1` で機械指標が退行する構造変更を LLM の高い自己評価だけで誤採用する問題を抑止できる。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/services/llm/eventPrompts.ts`, `client.ts`
  - `src/tools/vta/features/vta/utils/connectionProposals.ts`, `eventAnalysis.ts`, `pipelineHistory.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts`, `granularityRefinement.ts`
  - `src/tools/vta/features/vta/store/vtaStore.ts`, `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `connectionProposals.test.ts`, `eventPipeline.test.ts`, `autoConnectionService.test.ts`, `granularityRefinement.test.ts`, `eventAnalysis.test.ts`, `vtaStore.test.ts`, `tests/vta/aiDiagnostics.test.ts`
