# ADR-0010: 主体意味論的包含関係の半順序集合（Poset / DAG）化および正準包含確定ポリシー

## メタデータ
- **ステータス**: Accepted
- **日付**: 2026-11-06
- **対象コンポーネント**: `subjectPoset.ts`, `eventLedger.ts`, `eventAnalysis.ts`, `subjectRanking.ts`, `chainRepair.ts`, `granularityRefinement.ts`, `VTAAnalysisData`, `VTASchema`
- **関連要件 / ADR**: ADR-0004 (正規化監査), ADR-0008 (帰結共有度・統合ブロック), ADR-0009 (構造化AI診断)

---

## 1. コンテキストと課題 (Context & Problem Statement)

### 1.1 背景
VTA（Variation Tree Analysis: 変動樹解析）における主体の分離・統合（Subject Separation & Consolidation）は、認知負荷を適正化（既定5、最大12レーン）しつつ事故の因果構造を正しく可視化するための根幹機能である。
FailurePrism ではこれまで、各主体が単一の親組織IDを持つ単木（`parentEntityId?: string`）として包含関係を保持してきた。

### 1.2 顕在化した課題
1. **多重包含（多親関係）の表現不能**:
   - 現実の事象では、「機長A」は「A機運航クルー（機能・チーム軸）」に包含されると同時に、「海上保安庁（組織・管理軸）」にも包含される。単一親木構造ではこの多次元の包含関係を表現できず、どちらか一方を切り捨てざるを得なかった。
2. **LLM推論のステップ間非一貫性（Inconsistency）**:
   - 後続ステージ（粒度反復や連鎖点検など）でLLMに都度主体の所属や包含を推論させると、ステップごとに包含の向きや深さが揺らぎ、推移律（$A \subset B \land B \subset C \implies A \subset C$）が破綻するリスクがあった。
3. **下流ステージにおける不当なリジェクト（直近課題）**:
   - 連鎖点検（Chain Repair）において、LLMが正当な細粒度主体（例: `A1`）を指定して時系列エッジを提案した際、上流で主体統合（例: `海保機` への集約）が行われていると、下流のバリデータが「関係の主体がイベントに関与していません」と誤判定し、正当な因果エッジ（羽田事故における降下シーケンス等）が丸ごと破棄される事態が発生した。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **数学的・意味論的厳密性**:
   - 包含関係は反射律・反対称律・推移律を満たす半順序集合（Poset）であり、有向非巡回グラフ（DAG）として決定論的に保持・クエリ可能であること。
2. **早期確定・凍結（Freeze Upstream）**:
   - LLMによる揺らぎを排除するため、包含関係は初期フェーズ（正規化・台帳抽出）で確定・凍結し、以降の下流フェーズは確定したDAGのグラフ探索に委ねること。
3. **完全な可逆性と透過的解決**:
   - 上位組織へ集約されても下位主体の関与事実を失わず、下位主体の指定を上位主体へ、または上位主体のイベントを下位主体へ透過的かつ安全に解決できること。
4. **既存データ・UIとの完全な後方互換性**:
   - 既存の `parentEntityId` を解釈可能とし、既存プロジェクトファイルやテストケースを破壊しないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: 現行の単木構造（`parentEntityId`）を維持し、LLMプロンプトの指示だけで頑張る**
  - *問題点*: 多重包含が表現できず、LLMの推論ゆらぎによるリジェクト問題を根本解決できない。
- **選択肢B: フルオントロジー（OWL / RDF / Triple Store）を導入する**
  - *問題点*: ブラウザ環境や軽量SPAアーキテクチャに対して過剰に重厚・複雑であり、バンドルサイズや保守コストが跳ね上がる。
- **選択肢C (採用): 軽量な半順序有向非巡回グラフ（`SubjectPoset` / DAG）エンジンの導入**
  - 表記ゆれ同値類 $\sim$ による商集合化、直接被覆関係のDAG化、推移的閉包（Transitive Closure）の定数時間 $O(1)$ クエリ、およびLCA探索を備えた自立型Posetエンジンを導入。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 `SubjectPoset` クラスの新設とデータモデル拡張
1. **データモデル**:
   - `VTAEntity`: `parentEntityIds?: string[]` を追加（従来の `parentEntityId?: string` も後方互換維持）。
   - `VTAAnalysisData`: `subjectPoset?: SubjectPosetData` を新設。
2. **`SubjectPoset` クラス**:
   - `isAncestor(ancestorId, descendantId): boolean`（包含判定）
   - `isDescendant(descendantId, ancestorId): boolean`
   - `getAncestors(id): Set<string>` / `getDescendants(id): Set<string>`
   - `findLCA(id1, id2): string | undefined`（最小共通上位組織の探索）
   - `resolveCanonical(raw): string | undefined`（別名から正準IDの解決）
   - Tarjan / DFS アルゴリズムによる閉路（サイクル）の自動検出と修復。

### 4.2 上流フェーズでの確定・凍結（Freeze Upstream）
1. **台帳パース時（`eventLedger.ts`）**:
   - `[主体]` 行の所属列において、単一親に加えてカンマ区切りの複数親（例: `A12,A10`）を許容。
   - パース時に `SubjectPoset` を生成し、循環や未定義親を決定論的にパージして `analysis.subjectPoset` に確定・凍結。

### 4.3 下流フェーズにおけるPoset準拠の透過的解決
1. **連鎖点検（`chainRepair.ts: applyChainDelta`）**:
   - 指定された主体IDが現在のイベント関与主体と直接一致しない場合でも、`subjectPoset.isDescendant` または `subjectPoset.isAncestor` が真であれば正当な包含主体への言及と見なして自動解決する。
   - `kind === 'before'`（時系列先行）の場合、主体端点はオプショナルであるため、関与が特定できない場合でも主体端点を `undefined`（`-`）に安全フォールバックして有益な時系列エッジを100%採用する。
2. **主体ランキング（`subjectRanking.ts`）**:
   - `resolveParentTarget` で `SubjectPoset` の上位祖先探索を用い、複数親がある場合は機体/チーム軸 $\to$ 組織軸の優先順位で決定論的にロールアップ先を決定する。
   - ADR-0008 の Merge Guard（帰結非対称性・介入防壁）と連動し、包含関係にあっても必要な分離を死守する。

---

## 5. 結果と影響 (Consequences)

### メリット
- **推論ゆらぎの撲滅**: ステップ間で包含関係が矛盾・破綻することが数学的にゼロになる。
- **因果エッジの救済**: 先ほど発生していた正当な時系列関係（離陸前・降下シーケンス）がリジェクトされず、確実にグラフへ反映される。
- **多次元包含の表現**: 機体チーム軸と組織管理軸の多重所属が自然に保持される。

### トレードオフ・考慮事項
- 複数親を持つ場合のロールアップ先選択において、明確な優先規則（機体/チーム軸を優先等）を維持する必要がある。

### 影響ファイル
- `src/tools/vta/features/vta/utils/subjectPoset.ts` (新規)
- `src/tools/vta/features/vta/utils/subjectPoset.test.ts` (新規)
- `src/tools/vta/types/vta.ts`
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/features/vta/utils/eventAnalysis.ts`
- `src/tools/vta/features/vta/utils/chainRepair.ts`
- `src/tools/vta/features/vta/utils/subjectRanking.ts`
- `src/tools/vta/services/generation/chainRepairService.ts`
