# ADR-0056: LLM Gateway一時エラー時の観測適正化・クロスレーン幾何トレーサビリティ強化および時間逆行ガード

- **Status**: `Accepted`
- **Date**: 2026-11-20
- **Target Components**: `VTA LLM Client`, `VTA AI Diagnostics`, `VTA Layout Geometry Audit`, `VTA Event Ledger`, `VTA Chain Repair`, `VTA Granularity Refinement & Score`
- **Related Requirements / ADRs**: [ADR-0009](file:///docs/adr/0009-vta-ai-diagnostics-package.md), [ADR-0043](file:///docs/adr/0043-layout-backward-cross-lane-edge-audit.md), [ADR-0052](file:///docs/adr/0052-llm-failure-diagnostics-and-stream-early-termination.md), [ADR-0053](file:///docs/adr/0053-vta-stream-idle-timeout-and-reasoning-effort-control.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. **HTTP 504 リトライ時のパイプライン FAILED 誤診断**:
   - `gemini-3.8-flash` 等のモデル実行時、初回通信で HTTP 504（Gateway timeout）が発生しても、`isRetryableGatewayError` による指数バックオフリトライで後続試行が成功し、最終的に `VTAツリー自動生成完了` まで到達していた。
   - しかし、`client.ts` の `!response.ok` 判定でリトライ前にもかかわらず無条件に `logTrace('error', ...)` を発行していたため、`aiDiagnostics.ts` の後方走査によって最後の `operation: error` が検出され、`pipeline_status: FAILED` と誤診断されていた。

2. **クロスレーン逆行エッジ（LAYOUT_BACKWARD_CROSS_LANE_EDGE）の原因特定困難**:
   - 診断パッケージにおいて、4px の微小ドロップ（R14, R17, proposal）や 951px の大規模ドロップ（R3）が報告されるが、ノードの中心座標（centerY）の差分しか出力されていなかった。
   - 端点ノードの実際の描画高さ（実測高さ `measuredHeight`、推定高さ `estimatedHeight`）、受動客体のドット表示判定（`isDot`）、および台帳上の生定義行（`raw_output`）が欠落しており、なぜその座標差が生じたのか（DOM測定ズレか、ランク・トポロジーの不整合か）をログ単体から特定できなかった。

3. **台帳パース時における有向関係の時間逆行スルー**:
   - LLM が確定済みの `before` 連鎖（例: A ≺ B）と逆向きの有向関係（例: B → A の `transfer` や `impact`（`status === 'occurred'`））を出力した場合、従来の `inspectLedger` は `before` 同士のサイクルのみを検査していたため、検証を通過していた。
   - その結果、後段の `buildEventTimeDAG` において「既に A ≺ B なので B ≺ A は追加不可」としてエッジが破棄され、時間順序が反映されないまま描画レイアウトに突入し、951px もの巨大な下向き逆行矢印として画面上に残存していた。

4. **連鎖補完点検（`chain.repair`）における関係追加 ID の過剰拒否と修復ループの Catch-22 デッドロック**:
   - `chainRepair.ts` の `applyChainDelta` において、他行から参照されない `[関係追加]` まで `!/^tmp_.../` または `known.has(r.id)` で即座に例外を投げており、後続の重複連番救済がデッドコード化していた。このため、`R15` のような正当な追加提案が `新規IDは一意なtmp_から始めてください` で棄却されていた。
   - さらに `chainRepairService.ts` の修復ループ（`repair > 0`）では `allowed.has(r.id)` で厳密一致を要求していたため、LLM が ID を `tmp_R15` や新規 `tmp_` ID に修正して返すと `修復対象外ID` として弾かれ、元のまま返すと命名エラーになる修復不能のデッドロック（Catch-22）が発生していた。

5. **粒度反復（`granularity.refinement`）における `suppress` 呼び出し順序バグによる共有エッジ破壊と `C3` 下落**:
   - `granularityRefinement.ts` の `applyRefinementOps` (L602-629) において、`suppress` 提案が `maintainPresentation` の不変条件（単独カードレーンかつ非保護）を事前検証せずに `suppressedCards` へ書き込まれ、直後に `maintainPresentation(connectSharedEvents(nextSchema))` が逆順で呼ばれていた。
   - 内側の `connectSharedEvents` が先に実行されて対象カードの `shared:...`（`meaning: 'association'`）レーン間共有エッジをスキップ（削除）した後、外側の `maintainPresentation` が複数カードレーンのカードを可視状態に復活させるため、可視カードに戻ったにもかかわらず共有エッジだけが消滅して連結成分数 `compCount` が悪化（例: `7 → 9`、`S = 0.693 → 0.690`）し、同一反復内の有効な `add_relation` や `group` まで巻き添えで不採用となっていた。
   - また `granularityScore.ts` の `variationReachability` がノード単位で計算されていたため、`group` で複数の到達済み変動イベントを1枚の共有カードに集約した際に到達率が低下する構造になっていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **観測性と健全性診断の正確性**: 一時的な Gateway 障害（HTTP 504）から正常にリトライ回復して完走した処理を、偽陰性（FAILED）として誤認・通知しないこと。
- **事実に基づく幾何トレーサビリティ**: 座標補正を推測で入れず、端点ノードの幾何メタデータ（実測・推定高さ、ドット表示、ランク、時刻、生台帳スニペット）を診断ログに完全展開し、確実な事実に基づいて診断・改修可能にすること。
- **上流での時間逆行ガード**: `before` 連鎖と逆行する有向関係は、レイアウト破綻を引き起こす前に台帳検証段階で早期検知し、LLM の行別修復（`ledgerRepairInput`）によって正規の向きへ自己修復させること。

---

## 3. 検討した選択肢 (Considered Options)

- **オプションA: レイアウト側で安易に 4px や 951px のドロップを補正する**
  - *問題点*: 4px の座標相殺はユーザーの手動移動座標維持ルール（`does not move a saved detailed coordinate...`）と衝突して既存テストが破綻する。また、951px の逆行は台帳の時間論理矛盾が原因であるため、幾何層での小手先の修正では根本解決にならない。
- **オプションB: Gateway 通信層でのログ適正化、診断パッケージへの幾何コンテキスト完全展開、および台帳層での時間逆行ガード（採用）**
  - Gateway リトライ中は `warn` に留め、全試行失敗時のみ `error` を発行する。また、パイプライン完了が記録されている場合は回復済みエラーで FAILED 判定しない。
  - `auditVTALayoutGeometry` および `aiDiagnostics` において、端点ノードの幾何情報（実測・推定高さ、ドット判定等）と台帳生スニペットを YAML 出力に完全展開する。
  - `inspectLedger` において、`before` 連鎖に対して有向な `transfer` / `impact`（`status === 'occurred'`）が逆行している場合、`temporal_inversion` として行別修復要求を出す。

---

## 4. 決定事項 (Decision Outcome)

1. **LLM Gateway 通信リトライの観測適正化**:
   - `client.ts`: `!response.ok` 時、`attempt < maxRetries && isRetryableGatewayError(...)` を満たす場合は `logTrace('warn', ...)` に留め、`logTrace('error', ...)` は最終試行失敗時のみ発行する。
   - `traceDebug('llm.http-error')` および `traceDebug('llm.failure')` に `willRetry` フラグを追加。
   - `aiDiagnostics.ts`: ログ内に `VTAツリー自動生成完了` が記録されている場合、完了より前に発生したエラーはリトライで克服された過去の一時的試行として扱い、`pipeline_status: SUCCESS` を維持する。

2. **クロスレーン逆行エッジの幾何トレーサビリティ強化**:
   - `layout.ts: auditVTALayoutGeometry`: `backwardCrossLaneEdges` に以下のメタデータを自動集約・付与する。
     - 始点・終点ノードの `id`, `lane`, `centerY`, `height`, `measuredHeight`, `estimatedHeight`, `isDot`, `title`, `time`, `eventId`
   - `aiDiagnostics.ts`: `LAYOUT_BACKWARD_CROSS_LANE_EDGE` のアノマリー詳細に上記幾何情報（`geometry`）を格納し、該当する台帳定義行（`raw_output`）を抽出して Markdown/YAML に完全整形出力する。

3. **`inspectLedger` による有向関係の時間逆行ガード (`temporal_inversion`)**:
   - `eventLedger.ts: inspectLedger`: `before` 連鎖の推移的閉包（`reaches`）を構築し、有向な `transfer` および `impact`（`status === 'occurred'`）について、`reaches(targetEventId, sourceEventId)`（ターゲットからソースへの先行パスが既に存在）を検査する。
   - 逆行が検出された場合、該当行に対して `code: 'temporal_inversion'`, `field: '前後順序'` の issue を発行し、LLM による行別修復（`ledgerRepairInput`）へ回す。
   - `before` 同士に循環（`temporal_cycle`）がある場合はまずそれを解消させるため、`beforeCycleIssues.length === 0` の条件下でのみ実行する。

4. **連鎖補完点検 (`chain.repair`) の関係追加 ID 自動正規化と修復ループの Catch-22 解消**:
   - `chainRepair.ts`: パース段階（`inspectChainDelta` / `parseChainDelta`）および検証・適用段階（`validateChainRows` / `applyChainDelta`）において、他行から参照されない `[関係追加]` 行の ID が `tmp_` で始まらない場合や既存ID・セクション内重複と衝突する場合でもエラーにせず、行自体の `id` / `cells[0]` を一意な `tmp_...`（例: `tmp_R15`, `tmp_R15_2`）へ自動正規化する。他方、イベント・主体参照と混ざるリスクを防ぐため、`applyChainDelta` 内の `[関係追加]` 解決マップは `[追加主体]` / `[追加イベント]` の `ids` マップと完全に分離する。
   - 末端3セクション（`割当追加`, `関係追加`, `要確認`）についても同一セクション内重複を自動連番化する。一方で他行から参照される `[追加主体]` / `[追加イベント]` は厳格な `tmp_`・一意性検査を維持する。
   - `chainRepairService.ts`: 修復ループ（`repair > 0`）の受け入れ判定および `unresolved` 解消判定（1対1マッチング）において、ID 命名違反からの `tmp_` 接頭辞付与・リネーム修復および `[要確認]` への移動を「修復対象外ID」とせず正当に受理・解消させる。

5. **粒度反復 (`granularity.refinement`) における `suppress` 事前ガード・共有エッジ再構築順序の是正・`group` 実反映チェックおよびイベント単位 `variationReachability`**:
   - `granularityRefinement.ts`: `applyRefinementOps` の `suppress` 適用時に、`!protectedIds.has(card.id)` かつ対象レーンのカード数が1枚のみ（`laneCardCounts.get(card.laneEntityId) === 1`）を満たすカードのみを受け入れる。さらに `connectSharedEvents(maintainPresentation(nextSchema))` の順序で実行し、`maintainPresentation` 通過後も `suppressedCards` に維持されたカードのみを `appliedOps` に記録することで、不適格な `suppress` による `shared:...` 共有エッジ破壊と空振り計上を完全に防止する。
   - `granularityRefinement.ts`: `group` 操作の適用時に、`allowManual = true` による手動要素保護を維持したまま `built.cards` に実際に該当共有カードが生成されたか（`canShareTiming` を満たして統合されたか）を確認してから `working.cards` 更新と `appliedOps` 記録を行う。あわせて `GRANULARITY_REVIEW_SYSTEM_PROMPT` の `group` 記述を実仕様（同時刻かつ `before` なし）に整合させる。
   - `eventAnalysis.ts`: `projectAnalysis` においても `connectSharedEvents(maintainPresentation(connectSharedEvents(schema)))` の順序とし、`maintainPresentation` によって自動復活したカードの共有イベントエッジが欠落しないようにする。
   - `granularityScore.ts`: `variationReachability` を可視ノード上のイベント単位で算出し、`group` によるカード集約で見かけ上の到達率が低下しないようにする。

---

## 5. 結果と影響 (Consequences)

### メリット
- **健全な稼働状態の正確な可視化**: 一時的な 504 タイムアウトから正常に回復したパイプラインが誤って FAILED 判定されなくなり、アラートの信頼性が向上する。
- **4px 微小ドロップの確実な原因究明**: 診断ログを見るだけで、端点ノードの DOM 実測高さ・推定高さ・ドット状態・centerY が一目瞭然となり、事実に基づいた安全な改善が可能になる。
- **951px 巨大逆行矢印の上流根絶**: 台帳パース段階で論理破綻した逆行関係が遮断され、LLM が正規の向きに修正してからプロジェクションへ進むため、図面の美観と論理的一貫性が大幅に向上する。

### トレードオフ・考慮事項
- `dependency` 関係は後続の `dependencyProblem` で専用の依存制約検証が行われるため、二重判定や既存テスト（`detects dependency cycles...`）との競合を避けるため、本ガードは `status === 'occurred'` の `transfer` / `impact` に限定して適用する。

### 影響ファイル
- `src/tools/vta/services/llm/client.ts`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `src/tools/vta/features/vta/utils/layout.ts`
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/features/vta/utils/chainRepair.ts`
- `src/tools/vta/services/generation/chainRepairService.ts`
- `src/tools/vta/services/generation/granularityRefinement.ts`
- `src/tools/vta/services/generation/granularityScore.ts`
- `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
- `src/tools/vta/features/vta/utils/chainRepair.test.ts`
- `src/tools/vta/services/generation/chainRepairService.test.ts`
- `src/tools/vta/services/generation/granularityRefinement.test.ts`
- `tests/vta/aiDiagnostics.test.ts`
- `src/tools/vta/services/llm/eventPipeline.test.ts`
- `docs/adr/README.md`
