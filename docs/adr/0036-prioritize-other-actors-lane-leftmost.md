# ADR-0036: 「その他の関係者」レーンのVTA図左端優先配置および列順変更に伴う座標シフト整合ポリシー

## メタデータ
- **ステータス**: Accepted
- **決定日**: 2026-11-17
- **対象コンポーネント**: `laneOrder.ts`, `lanePositionShift.ts`, `eventAnalysis.ts`, `schemaValidator.ts`, `subjectRanking.ts`, `laneConnections.ts`, `layout.ts`, `vtaStore.ts`, `EventReviewPanel.tsx`, `LaneManagementPanel.tsx`, `NodeEditorModal.tsx`, `ScenarioInputSection.tsx`
- **関連要件 / ADR**: VT-F11（スイムレーン左右順変更）, ADR-0008（主体独立・非影響除外）, ADR-0011（OLAP ドリルダウン・ロールアップ）

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. **末梢集約レーンの右端固定化と視認性課題**:
   - 従来の主体上限統合（`consolidateSubjects`）や部分再抽出（`restorePassage`）は、`consolidatedEntities` の配列末尾へ `「その他の関係者」（OTHER_ACTORS_ENTITY_NAME）` を追加し、`projectAnalysis`・`addLane`・`addNode`・`updateNode`・強制統合等も新規レーンを配列末尾（右端）へ追加していた。
   - この結果、主要アクター群の主因果フローを確認したい分析場面でも「その他の関係者」レーンが最右列へ追い出される、あるいは図ごとに末尾・中間へ散在する状態となっていた。
2. **`entity.aggregate` フラグの多義性**:
   - `subjectRanking.ts` 等では「その他の関係者」に `aggregate: true` を付与するが、テストデータ・機能拡張上は「Ａ機」等の複合機械・組織エンティティにも `aggregate: true` が使われる（`subjectGranularityProposals.test.ts`）。`aggregate` 単独で左端優先を判定すると、複合主体の誤配置を招く。
3. **先頭 (`index 0`) 挿入時の既存カード X 座標ズレ**:
   - 従来の新規レーン追加は配列末尾への追加であったため既存レーン `0..k-1` の列番号が変化しなかった。これに対し「その他の関係者」を先頭へ挿入すると既存全レーンの列番号が右へ `+1` ずれるため、`!forceRecompute` 時に保存済み `position.x` / `compact_position.x` や `existingNodes` の座標を参照する `calculateVTALayout` では既存カードが1列左（「その他の関係者」列）へ取り残される危険がある。
4. **`lanes[0]` を暗黙の主レーンとする UI・レイアウト前提**:
   - `NodeEditorModal`、`LaneManagementPanel`（強制統合元初期選択）、`layout.ts` の空レーンフォールバックが `lanes[0]` を参照しており、左端が「その他の関係者」になると既定選択・未指定ノードが「その他の関係者」へ吸い込まれる。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **生成・新規導入時の左端優先と `VT-F11` 手動並替の両立**:
   - 新規生成（`projectAnalysis` 初回投影）および新規出現時（`addLane` / `addNode` / `updateNode` / `restorePassage` / 分割・統合等）には「その他の関係者」レーンを先頭 (`index 0`) に優先配置しつつ、ユーザーが `moveLane` で移動した後や保存済み JSON（`declaredLanes` 保持）再読込時にはユーザー設定の列順を尊重すること。
2. **ランキング一覧順序と図上レーン列順の役割分離**:
   - `consolidateSubjects` が返す `consolidatedEntities` 配列（重要度スコア順トップ K → 末尾に集約主体）の順序および既存 `subjectRanking.test.ts` 契約を維持し、表示列順 `schema.lanes` のみで左端優先を実現すること。
3. **詳細・コンパクト両表示モードの座標整合**:
   - `schema.nodes[].position` / `compact_position`（正準空間）および `ReactFlow` の `nodes`（`visibleSchema` 表示空間）の双方について、レーン列インデックス変化分 `(newIdx - oldIdx) * VTA_LANE_WIDTH` を漏れなくシフトすること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: `consolidatedEntities` 自体で「その他の関係者」を先頭に生成する**
  - *問題点*: イベント・主体確認パネルのランキング表示順が崩れるほか、手動追加・分割・強制統合等の非ランキング経路を網羅できず、既存 `subjectRanking.test.ts` と競合する。
- **選択肢B: `moveLane` や再読込を含め常に `lanes[0]` へ強制固定する**
  - *問題点*: `VT-F11`（「左へ」「右へ」の並び替えを保存・再読込・SVG出力に反映する）と矛盾する。
- **選択肢C (採用): `laneOrder.ts` + `lanePositionShift.ts` による表示列順の左端優先化・既存配置尊重・座標シフト統合**
  - 初回投影・新規レーン導入時にのみ左端へ挿入し、既に `lanes` に存在するユーザー並替済み位置は維持する。また列順変化を伴う全経路（`projectAnalysis`, `vtaStore` 各種操作, `EventReviewPanel` 経由）で座標シフトを一貫適用する。

---

## 4. 決定事項 (Decision Outcome)

1. **共通識別・配列ヘルパー `laneOrder.ts` の導入**:
   - `isOtherActorsLaneName`: 名称（`'その他の関係者'` / `'その他の関係者 (n)'`）、ID（`subject_others*`）、または `(kind === 'other' && aggregate === true)` によって「その他の関係者」レーンを厳密判定し、他種別の `aggregate: true` 主体を除外する。`laneConnections.ts` の同一レーン時系列線抑止判定にも統一適用する。
   - `mergeLaneOrderWithPriority` / `mergeLanesAfterConsolidation` / `expandSplitLanesWithPriority`: 初回および新規出現時のみ左端 (`index 0`) へ優先挿入し、既存配置および分割提案時の元レーン位置を尊重する。
   - `pickDefaultPrimaryLane`: 「その他の関係者」以外の先頭レーンを主レーン候補として返す。
2. **投影 (`projectAnalysis`) および検証 (`schemaValidator`) への統合**:
   - `projectAnalysis` に `options.preferredLanes` を設け、変更前の `previous.lanes` と出力 `allLanes` のインデックス差分から `position.x` / `compact_position.x` を自動シフトする（二重シフト防止）。
   - `validateAndSanitizeVTASchema` で `mergeLaneOrderWithPriority(declaredLanes, nodeLanes, declaredEntities)` を用い、保存済み順序を維持しつつ未宣言補完時は左端配置する。
3. **ストア・UI 操作での座標シフト (`lanePositionShift.ts`) と強制統合ヘルパー共通化**:
   - `shiftSchemaPositionsForLaneChange` / `shiftReactNodesForLaneChange` を導入し、`vtaStore`（`reoptimizeVTA`, `addLane`, `applyLaneMergeProposal`, `forceMergeLanes`, `applyLaneSplitProposal`, `addNode`, `updateNode`）および `ScenarioInputSection` / `EventReviewPanel` の全経路で列ズレを防止する。
   - `applyForceMergeTransition` を `subjectRanking.ts` へ共通化し、`vtaStore.forceMergeLanes` と `EventReviewPanel` の重複ロジックを統合する。
4. **`lanes[0]` 暗黙前提の解消**:
   - `LaneManagementPanel`（強制統合元初期値）、`NodeEditorModal`（新規カード既定レーン）、`layout.ts`（空レーンフォールバック）を `pickDefaultPrimaryLane` へ切り替える。

---

## 5. 結果と影響 (Consequences)

### メリット
- 自動生成・追加・分割・強制統合で「その他の関係者」レーンが常に左端に整列し、右側に主役アクター同士の因果フローが見通しよく並ぶ。
- ユーザーによる `moveLane` 並替・JSON 保存再読込・OLAP ドリルダウン・詳細/コンパクト両モードの手動座標が破壊されない。
- `aggregate: true` を持つ一般主体の誤配置や、`lanes[0]` 依存 UI による誤操作を防げる。

### トレードオフ・考慮事項
- `granularityScore.ts` の交差ペナルティ（C5）は `visible.lanes.indexOf` を用いているため、「その他の関係者」と他レーン間に交差線があるケースでは C5 スコアが従前とわずかに変わる場合がある。
- `consolidatedEntities` 配列はスコア末尾のまま維持するため、主体ランキング表の並び順（重要度降順→その他）と図の左端配置には意図的な役割差がある。

### 影響ファイル
- 新規: `src/tools/vta/features/vta/utils/laneOrder.ts`, `src/tools/vta/features/vta/utils/lanePositionShift.ts`, `tests/vta/otherActorsLanePriority.test.tsx`, `docs/adr/0036-prioritize-other-actors-lane-leftmost.md`
- 変更: `eventAnalysis.ts`, `schemaValidator.ts`, `subjectRanking.ts`, `laneConnections.ts`, `layout.ts`, `vtaStore.ts`, `EventReviewPanel.tsx`, `LaneManagementPanel.tsx`, `NodeEditorModal.tsx`, `ScenarioInputSection.tsx`, `unassignedEvents.ts`, `docs/adr/README.md`
