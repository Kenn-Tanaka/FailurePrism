# ADR-0092: 手動レーン強制統合・統合提案における未知Poset親主体の保守的発見と半順序保存ポリシー

- **ステータス**: Accepted（多段統合時の旧合成親アンラップは [ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md) により封緘複合森の入れ子 `Merge` および部分分離時の新規 $P'$ 再構築へ発展置換）
- **決定日**: 2026-11-26
- **対象コンポーネント**: VTA Engine (`subjectRanking.ts`, `vtaStore.ts`) / VTA Control Panel UI (`LaneManagementPanel.tsx`, `VTACanvas.tsx`, `EventReviewPanel.tsx`)
- **関連ドキュメント・コミット**: `AGENTS.md` (VTA Design Principles), [ADR-0081](./0081-local-manual-lane-operations-edge-geometry-cache-and-interleaved-spine-absorption.md), [ADR-0084](./0084-poset-antichain-pure-upper-hubs-and-man-machine-composite-subjects.md), [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md), [ADR-0090](./0090-split-parent-poset-antichain-guard-man-machine-fallback-and-gateway-connect-timeout.md)

## 1. コンテキストと課題 (Context & Problem Statement)

`ADR-0081` で導入された局所 $O(V+E)$ 手動レーン統合（`mergeEntitiesLocally`・`applyForceMergeTransition`・`applyLaneMergeProposal`）では、ユーザーがスイムレーン上の2つのレーン $S$ と $T$ を「レーンの強制統合」で統合した際、以下の4つの半順序集合（`SubjectPoset`）不変条件違反が発生していた。

1. **非比較（独立）な主体間への偽の親子辺 $S \prec T$ 注入と推移的汚染**:
   `mergeEntitiesLocally` が既存の統合先主体 $T$ に対して直接 `workingPoset.addRawEdge(S, T)` および `S.parentEntityIds` 上書きを実行していたため、本来は対等・無関係な主体同士（例：`副操縦士` と `機長`、あるいは別組織に属する `作業員X ≺ 下請会社` と `監督員Y ≺ 元請会社`）の統合で $S \prec T \prec \text{元請会社}$ という偽の包含関係が注入され、保存律 $\forall x, y \in V,\; x \preceq y \iff x \preceq' y$ が破壊されていた。
2. **新規親主体作成時の上位最小共通祖先 $\text{MCA}(S)$ への接続欠落および分裂親（`HG2c`）違反**:
   新規レーン作成時や `applyLaneMergeProposal` で分裂親（他に未統合のアクティブ子孫が残る 0イベント親 $H$）を再利用した場合、$H$ と未統合子孫 $u \prec H$ が同時にアクティブレーンとして並立し反鎖完全包摂条件（`HG2c`）に違反していた。また `subject_others` への段階的な追加統合時にも既存の $\text{MCA}$ 辺が再計算されず、後から統合した別組織主体が先行主体の親組織へ推移的に巻き込まれる余地があった。
3. **既存親子関係の逆転統合（上位親 → 下位子）**:
   既に $T \prec S$（$S$ が親組織、$T$ が個人）の包含関係が存在する組を「統合元: $S$、統合先: $T$」の順で選択した場合、親組織 $S$ が個人 $T$ の子として吸収され `removeCycles()` によって本来の半順序辺が破壊されるリスクがあった。
4. **多段手動統合・分割・再最適化時の合成 0イベント親ラッパー残留**:
   手動統合で生成した純粋 0イベント合成親（`merged_entity_*`）をさらに別レーンと多段統合したり、`splitEntitiesLocally` / `revertConsolidation` で分割・復元したりした際、解消済みの合成親 ID が `mergedFrom`・`ranks`・`subjectPoset` にゴーストとして残留し得た。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **半順序の厳密保存（Conservative Poset Extension）**:
  `AGENTS.md` の設計原則に従い、包含関係にない主体集合 $S$ の統合は必ず「未知の 0イベント上位親主体 $P$ の発見」としてモデル化し、既存の全主体間順序 $\forall x, y \in V,\; x \preceq y \iff x \preceq' y$ を厳密に保存すること。
- **反鎖完全包摂不変条件（`HG2c`）と人機分離（`ADR-0084`）の維持**:
  分裂親配下の部分統合では中間親 $P$（$s \prec P \prec H,\; P \parallel u$）を生成し、全子孫を完全包摂する場合のみ既存の 0イベント親ハブ $H$ を再利用すること。また `vehicle_crew` 統合案で同名の機械主体（例：`Ａ機`, `kind: 'machine'`）が並存する場合に `person ≺ machine` を注入しないこと。
- **局所 $O(V+E)$ 即時応答と UI 操作性の両立**:
  大域探索を呼ばず即座に完了する局所演算を維持しつつ、`LaneManagementPanel` 上で生成される親主体名（既定値 `「A・B」` または完全包摂 0イベント親名）をユーザーがその場で確認・編集できるようにすること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 既存の統合先レーン $T$ のみを残し、`SubjectPoset` には辺を追加せず `mergedFrom` だけ記録する**
  - OLAP ドリルダウン時や表示上、対等な主体 $S$ があたかも個人 $T$ の下部組織であるかのように「$T$（$S$）」と表示され、主体名と実態（複合グループ）の意味論が乖離するため不採用。
- **選択肢2: `resolveForceMergePlan` による 3分岐 Poset 保存統合計画と `discoverConservativeParent` による未知親発見を採用する（採用）**
  - (1) 非比較な主体対 $A \parallel B$ は共通の 0イベント親主体 $P$（完全包摂する既存 0イベント親があればそれを自動再利用、なければ新規親 `merged_entity_*`）を生成して両者を $P$ の子として集約、(2) 既存の包含関係 $A \prec B$ / $B \prec A$ は選択順序によらず上位主体 $\max_{\preceq}(A, B)$ へ正規化ロールアップ、(3) `その他の関係者`（`subject_others`）は全構成員に対して `discoverConservativeParent` を再適用して左端配置と半順序保存を両立する。

## 4. 決定事項 (Decision Outcome)

選択肢2を採用し、以下のアーキテクチャを実装する。

1. **決定論的 Poset 保存統合計画（`resolveForceMergePlan` / `applyForceMergeTransition`）**:
   - **非比較なアクティブレーン同士（$S \parallel T$）**:
     - `originalEntities` 内に $\{S, T\}$ の双方を子孫に持ち、直接イベントを持たず、かつ $\{S, T\}$ 以外に未統合のアクティブ子孫を持たない極小の完全包摂 0イベント親ハブ $H$ が存在する場合、既定の親主体名を $H.\text{name}$ とし（名称未変更時は $H$ を再利用）統合する。
     - それ以外（無関係主体同士・異組織間・分裂親配下の部分統合）では、新規 0イベント親主体 $P$（`kind: 'organization'`, 既定名 `${leftLane}・${rightLane}`、第6引数 `customParentName` で任意指定可）を生成し、$S$ と $T$ の**両方**を $P$ へ統合する。
   - **既存の Poset 包含関係があるレーン同士（$S \prec T$ または $T \prec S$）**:
     - ユーザーの選択順序にかかわらず常に下位主体 $\min_{\preceq}(S, T)$ を上位主体 $\max_{\preceq}(S, T)$ へロールアップし、親子逆転と冗長なラッパー生成を防止する。
   - **周辺集約レーン（`その他の関係者` / `subject_others`）および新規レーン名指定**:
     - 左端（index `0`）配置規則およびノード X 座標シフトを維持したまま、`discoverConservativeParent` により既存半順序を保存して集約する。
2. **`mergeEntitiesLocally` における保守的 Poset 拡張と合成親アンラップ**:
   - `addRawEdge` による直接辺注入および破壊的な `removeCycles()`・子主体の `parentEntityId` 上書きを撤去した。
   - 統合対象または既存の合成ターゲット（`merged_entity_*` / `group_*` / `subject_others`）に純粋 0イベント合成親が含まれる場合、基底の構成主体集合 $M$ へフラット展開したうえで旧合成ノードを `workingPoset`・`ranks`・`mergedFrom` から除去し、`discoverConservativeParent(workingPoset, P.id, P.name, M, maximalChildren)` により $m \prec P$（$m \in M$）および $P \prec a$（$a \in \text{MCA}_V(M)$）を設定する。これにより任意の段階的統合列に対しても $\forall x, y \in V,\; x \preceq y \iff x \preceq' y$ が厳密に成り立つ。
3. **`applyLaneMergeProposal` における人機・分裂親保護（`vtaStore.ts`）**:
   - 提案の統合先名と同名の非祖先主体（例：`Ａ機` (`kind: 'machine'`)）がキャンバス上に存在する場合、`person ≺ machine` を作らず当該機械主体も構成員に含めた複合 `'organization'` 親主体を生成する。また分裂親である `origTarget` の直接流用を禁止し中間親を生成する。
4. **分割・復元時のクリーンアップと `LaneManagementPanel` UI**:
   - `revertConsolidation` および `splitEntitiesLocally` で解消済みの純粋 0イベント合成親を `entities` と `subjectPoset` の双方から除去し、部分分割後に残存する合成親には残余メンバーに対する `discoverConservativeParent` を再適用する。
   - `LaneManagementPanel` の「レーンの強制統合」セクションでは、非比較レーン対の選択時に「生成する親主体名:」入力欄（既定値プレフィル済み）を表示し、既存包含関係がある組では上位主体への集約案内を表示する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - どのレーン対をどの順序で手動強制統合・多段統合・分割しても、`SubjectPoset` の非反射律・反対称律・推移律および既存主体間の半順序保存則（$\forall x, y \in V,\; x \preceq y \iff x \preceq' y$）と反鎖完全包摂（`HG2c`）が数学的に保証される。
  - 異組織間の誤った推移的所属汚染や `person ≺ machine` 逆転、多段統合時の `merged_entity_*` ID 露出が根絶され、OLAP ドリルダウン・Undo/Redo・AI 再最適化と完全に整合する。
- **トレードオフ・考慮事項**:
  - 非比較な既存2レーン（例：`機長` と `副操縦士`）を統合した際の統合後レーン名は、一方の個人名ではなく新規親主体名（既定 `機長・副操縦士`、UI または引数で変更可）となる。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/components/control-panel/LaneManagementPanel.tsx`
  - `src/tools/vta/features/vta/components/VTACanvas.tsx`
  - `src/tools/vta/components/control-panel/EventReviewPanel.tsx`
  - `tests/vta/forceMergeLanes.test.tsx`
  - `docs/adr/0092-poset-preserving-manual-lane-force-merge-via-parent-discovery.md`
  - `docs/adr/README.md`
