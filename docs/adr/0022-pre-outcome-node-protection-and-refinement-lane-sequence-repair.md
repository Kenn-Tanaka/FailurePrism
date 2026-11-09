# ADR-0022: 帰結前事象の過剰除外防止とAI粒度反復時のレーン内時系列再整流 (Pre-Outcome Node Protection & Refinement Lane Sequence Repair)

- **ステータス**: `Accepted`
- **決定日**: 2026-11-08
- **対象コンポーネント**: Causal Slicing Engine (`granularityScore.ts`) / Graph Projection (`eventAnalysis.ts`) / Granularity Refinement (`granularityRefinement.ts`) / Presentation Maintenance (`presentation.ts`)
- **関連ドキュメント・コミット**: [ADR-0007: 帰結以降の事後調査活動の自動除外と第二の帰結の保持](file:///docs/adr/0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0008: 主体帰結共有と非影響主体除外ポリシー](file:///docs/adr/0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0009: 構造化AI診断パッケージと推論コスト最適化](file:///docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

実大規模インシデント（羽田空港C滑走路衝突炎上事故、28,530文字シナリオ）の構造化AI診断パッケージ（v1.0）において、以下の深刻なパイプライン不整合が観測された：

1. **事後活動除外の過剰プルーニング（81ノード → 8ノード、73件消失）**:
   - 粒度反復最適化（`granularity.refinement #2`）によりスコア S=0.684 を達成し 81 カードが正しく生成されていたにもかかわらず、その直後の `post_outcome_exclusion` において `[事後活動除外] 帰結以降の事後調査ノード 73件をVTAツリーから除外しました。` と記録され、全体の90%に及ぶノードが誤除外されてわずか8ノードのみが残存した。
2. **原因の連鎖メカニズム**:
   - `extractCausalScenario` は帰結ノード（`outcome`）から逆方向BFSで因果木を逆走する。未特定関係（`meaning: 'association'`）や異レーン間の未接続ノードは到達不能（`omittedNodes`）となる。
   - `filterPostOutcomeScope` が「逆走BFSで到達しなかった全ノード」を一律に「事後調査活動」とみなして除外していたため、衝突（17:47）より前（17:40〜17:46）に発生した正常・変動事象まで一掃されていた。
   - 加えて、`applyRefinementOps` でカード分割（`split`）や統合（`merge`）が行われた際、カードIDが再採番（`card_1..68` → `card_1..81`）されるが、`projectAnalysis` の `matchedPrevNodes` や `resolveCurrentNodeId` で旧IDの一致を最優先していたため、別事象の旧カード情報（キャンバス座標や旧エッジ端点）とID衝突を起こし、レーン内 `sequential` 時系列エッジが断線していた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **帰結前事象（Pre-Outcome Events）の完全保護**:
   - 事故帰結以前に発生した事象は、たとえ他レーンとの関係線が未接続であっても「事後調査活動」ではあり得ない。これらは分析対象として1件たりとも誤削除されてはならない。
2. **既存因果スライシング契約の維持**:
   - 粒度評価スコア `C3` やレビュープロンプト生成が依拠している `extractCausalScenario` の契約（`if (edge.meaning === 'association') continue;`）を改変せず、未特定関係の抽出契約を維持する。
3. **カード再採番時のID衝突・誤引き継ぎの防止**:
   - カード構成変更（`!preserveCardOrder`）時は、旧カードID（`card_k`）による安易な名前一致を排し、`lane` と `event_ids` の完全/部分一致によって同一ノードを厳格に特定する。
4. **手動編集の保護とAI反復時の自動整流の両立**:
   - ユーザーがキャンバス上で意図的に削除したエッジを不用意に復活させず、AI粒度反復（`applyRefinementOps`）のタイミングでのみ、レーン内 `sequential` エッジを整流再構築する。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: `extractCausalScenario` で `association` エッジも逆走探索対象に含める**
  - *問題点*: 粒度反復スコア `C3`（未特定関係のペナルティ）や、関係精緻化を促すLLMプロンプトの因果スライステキストが変質し、既存テスト（`causalScenarioSlicing.test.ts`）を破壊する。
- **選択肢2: タイムスタンプ文字列の比較による除外判定**
  - *問題点*: 「翌日」「直後」等の非定型時刻表現があり、文字列比較による判定は脆弱。
- **選択肢3: 帰結イベントの最大出現順（`maxOutcomeOrder`）を境界とする多層防御＋再採番安全化（採用）**
  - `analysis.events` の `sourceOrder`（報告書内での出現順序）を活用し、最終帰結イベントの最大出現順序 `maxOutcomeOrder = Math.max(...outcomeOrders)` を算出。
  - 全イベントが `<= maxOutcomeOrder` であるノード（帰結以前の事象）は無条件保護する。
  - `sourceOrder > maxOutcomeOrder` かつ逆走因果木に含まれないノードのみを事後調査活動として除外する。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 `filterPostOutcomeScope` の境界防御

```ts
// 最終帰結の最大出現順序（maxOutcomeOrder）を取得
const outcomeOrders = (schema.analysis?.events ?? [])
  .filter((e) => outcomeEventIds.has(e.id))
  .map((e) => e.sourceOrder ?? 0)
  .filter((order) => order > 0);
const maxOutcomeOrder = outcomeOrders.length > 0 ? Math.max(...outcomeOrders) : Infinity;

const keptNodeIds = new Set<string>();
for (const n of schema.nodes) {
  if (result.scenarioNodes.some((sn) => sn.id === n.id)) {
    keptNodeIds.add(n.id);
    continue;
  }
  const orders = (n.event_ids ?? [])
    .map((id) => eventById.get(id)?.sourceOrder)
    .filter((o): o is number => typeof o === 'number' && o > 0);
  // 帰結以前に発生したイベントからなるノードは無条件に保護
  if (orders.length > 0 && maxOutcomeOrder !== Infinity && orders.every((o) => o <= maxOutcomeOrder)) {
    keptNodeIds.add(n.id);
  }
}
```

### 4.2 `projectAnalysis` における再採番セーフティ

- `!preserveCardOrder` の場合：
  - `previousNode` の探索は `card.id` の一致を最優先せず、同一レーンかつ `event_ids` が合致するノードを優先照合。
  - `resolveCurrentNodeId` は `oldNode.lane` と `oldNode.event_ids` を用いて新カードIDへ解決。
  - `manualEdges` の引き継ぎ時、`direction === 'sequential'` のエッジが異レーン間に跨ってしまった場合は破棄し、擬似クロスレーン時系列線の混入を防止。
  - `previous.presentation.suppressedCards` のキーを新カードIDへリマップ。

### 4.3 `applyRefinementOps` での `repairGeneratedLaneSequence` 再整流

- `split` / `merge` / `group` によってカード構成が変更された場合、`repairGeneratedLaneSequence(nextSchema).schema` を明示的に実行し、各レーン内の全カード間の `sequential` エッジを整流再構築する（手動キャンバス編集時の `projectAnalysis` には影響を与えない）。
- `merge` 適用時に `explicitMerges`（`Map<sourceId, targetId>`）を収集し、`consolidateSubjects` に引き渡すことで、AIが指定した親主体への統合を確実に遂行する。

### 4.4 `maintainPresentation` のエンティティ整合化

- `presentation.lanes` のエントリを `schema.analysis.entities` に現存する主体IDのみにフィルタし、`merge` 等で消滅した主体IDの残留による `validatePresentation` の例外スローを防止。

---

## 5. 結果と影響 (Consequences)

### メリット
- **過剰プルーニングの根絶**: 羽田事故等の大規模シナリオにおいて、帰結前の正常・変動ノードが事後活動として誤除外される問題が解消（73ノードの誤消失がゼロに）。
- **レーン内時系列線の堅牢性**: AI粒度反復（`split`/`merge`/`group`）後も各レーン内の `sequential` チェーンが完全に維持される。
- **手動編集の非破壊性**: ユーザーが意図的に削除したエッジや手動配置の座標がAI再投影で破壊・復活しない。

### 影響ファイル
- `src/tools/vta/services/generation/granularityScore.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/services/generation/granularityRefinement.ts`
- `src/tools/vta/features/vta/utils/presentation.ts`
- `tests/vta/postOutcomeExclusion.test.ts`
- `tests/vta/optimizationPreservation.test.ts`
