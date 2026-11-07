# ADR-0020: VTA 粒度反復における関係ID重複防止・端点正規化および再最適化時の関係復元ポリシー (VTA Relation Deduplication, Endpoint Normalization, and Revert Preservation)

- **ステータス**: Accepted
- **決定日**: 2026-11-07
- **対象コンポーネント**: Granularity Refinement (`src/tools/vta/services/generation/granularityRefinement.ts`), Subject Ranking (`src/tools/vta/features/vta/utils/subjectRanking.ts`), Chain Repair (`src/tools/vta/features/vta/utils/chainRepair.ts`)
- **関連要件 / ADR**: ADR-0001, ADR-0010, ADR-0011, ADR-0015

---

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港事故データ（約28,530文字）を用いた実機計測およびツリー自動生成後の再最適化（キャンバス上の「VTA最適化」ボタン押下）において、以下の例外が発生して最適化パイプラインが停止する障害が確認された。

```text
[error] [VTA最適化失敗] 関係 のIDが重複しています。
```

### 顕在化した課題とメカニズム

1. **粒度反復（Stage 2）における関係IDの反復間衝突**:
   - `granularityRefinement.ts` の `applyRefinementOps` は、LLM が提案した `add_relation` に対して `relId = rel_ref_${op.id}`（LLMが出力した `M1`, `M2` などの行ID）を決定論的に割り当てていた。
   - LLM は反復（iteration）ごとに常に `M1`, `M2`... を出力するため、反復 #1 で `M1` が追加・採用された後、反復 #2 で再び `M1` が提案されると、同一の `rel_ref_M1` が `working.relations` に二重 push されていた。
   - また、ツリー自動生成済みのキャンバスに対して再度「VTA最適化」を実行した場合も、前回の `rel_ref_M1` と今回の `M1` が衝突していた。
2. **描画・反映ステージでの重複IDのサイレント・キャリーオーバー**:
   - `projectAnalysis` は関係IDの一意性検証（`rejectDuplicateIds`）を行わないため、重複IDを抱えた関係データがエラーを出すことなくキャンバス（`vtaData.analysis.relations`）に保存されていた。
   - その結果、後続の自動接続（`autoConnectionService`）で採択された正常候補が、内部検証エラーにより反映直前でサイレント破棄される二次障害も併発していた。
3. **統合後キャンバスに対する追加関係の `revertConsolidation` での消失**:
   - 粒度反復や接続提案で追加された関係は、統合後の主体（例: `A_CREW` や集約レーン `subject_others`）を端点として持っていた。
   - 再最適化時に `revertConsolidation` を実行すると、細粒度関与（`restoredParticipations`、例: `CAPT_A`）と端点が直接一致しない関係がすべて除外（continue）されて消失していた。
4. **`revertConsolidation` での厳格バリデーションによるクラッシュ**:
   - `revertConsolidation` の末尾で `validateParticipants` が呼ばれ、`rejectDuplicateIds(relations..., '関係')` により例外がスローされ、「VTA最適化」が停止していた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **決定論的一意性とべき等性**: 乱数（`Math.random()` や UUID）に依存せず、決定論的な連番サフィックス（`_2`, `_3`...）によってIDの一意性を保証し、同一内容（種別・端点）の完全重複関係は追加をスキップすること。
- **エッジ描画とスコアリングの整合**: LLM が細粒度主体を指定した場合でも、現在の統合主体（カード）へ正規化してエッジを確実に描画し、元の指定を `sourceEntityOrigin` / `targetEntityOrigin` に記録すること。
- **多層防御（Defense-in-Depth）と自己治癒**: 万が一過去のデータや外部ファイルに関係ID重複や統合後主体端点が含まれていても、`revertConsolidation` で細粒度主体へ安全に逆解決し、IDを一意サニタイズしてパイプラインの停止を防ぐこと。
- **後方互換性と全テストの維持**: 既存の全テストスイートおよびデータスキーマ契約を一切破壊しないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A: `add_relation` のIDに毎回ランダムな UUID を付与する**:
  - *問題点*: `projectAnalysis` や `presentation.omittedEdges` が関係IDを参照しており、最適化のたびにIDがランダムに変わると、ユーザーの手動編集や非表示設定、テストの再現性が失われる。
- **選択肢 B: エラー時に単に try-catch で握りつぶす**:
  - *問題点*: 重複した関係やエッジがキャンバスに滞留し、画面上の描画乱れや接続線の多重描画を引き起こす。
- **選択肢 C (採用): 粒度反復での端点正規化＋決定論的一意化、および `revertConsolidation` での逆解決フォールバック＋自己治癒サニタイズ**:
  - 発生源（`applyRefinementOps` / `applyChainDelta`）で重複を未然に防ぎ、受入側（`revertConsolidation`）で完全な逆解決とサニタイズを多層配備する。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 粒度反復における関係の正規化と決定論的一意化 (`granularityRefinement.ts`)
1. **端点主体の正規化**: LLM が指定した主体IDを現在の統合済み関与（`working.participations`）に照合し、`mergedFrom` や `SubjectPoset` を介して統合後主体IDへ正規化する。細粒度主体の指定は `sourceEntityOrigin` / `targetEntityOrigin` に退避・保持する。
2. **整合性ガード**: 実在しないイベントIDの指定、および既存の `before` 関係と閉路（ループ）を作る逆向き関係を事前に検査して除外する。
3. **重複スキップと連番サフィックス**:
   - 同一の種別・端点イベント・端点主体を持つ関係がすでに存在する場合は、二重登録をスキップする。
   - 内容が異なるがIDが衝突している場合は、`rel_ref_${op.id}_2`, `rel_ref_${op.id}_3`... のように決定論的連番を付与する。

### 4.2 再集約復元における逆解決と自己治癒 (`subjectRanking.ts: revertConsolidation`)
1. **統合後主体から細粒度主体への逆解決**: `rel.sourceEntityOrigin` / `rel.targetEntityOrigin` が未設定で、統合後主体（親組織や `subject_others`）が直接指定されている関係について、`mergedFrom` および `SubjectPoset`（祖先・子孫関係）を探索して元の細粒度主体へ復元する。
2. **重複関係の統合サニタイズ**: 内容が完全一致する関係は1件に集約し、ID重複が存在する場合は `seenRelIds` に基づき `_2`, `_3`... の連番サフィックスを付与して一意化する。

### 4.3 連鎖修復における関係ID衝突防止 (`chainRepair.ts`)
1. `applyChainDelta` の `[関係追加]` において、既存の `a.relations` に同名IDが存在する場合は、決定論的連番サフィックス（`_2`, `_3`...）を付与して一意化する。

---

## 5. 結果と影響 (Consequences)

### メリット
- **「VTA最適化」のゼロ・クラッシュ達成**: 羽田事故データ等の長大インシデント報告書において、自動生成 $\to$ 手動編集 $\to$ 再最適化の往復サイクルを何度繰り返しても「関係 のIDが重複しています。」エラーが発生しなくなった。
- **自動接続提案の確実な反映**: Stage 2 粒度反復がクリーンな関係データを生成するため、後続の自動接続（Stage 3）が内部バリデーションでリジェクトされる二次被害が根絶された。
- **可視化とスコアリングの完全一致**: 粒度反復で追加された関係がカードに正しく投影され、エッジとして描画されるとともに、多目的スコア（C3 因果カバレッジ）に即座に反映されるようになった。

### トレードオフ・考慮事項
- 粒度反復の `applyRefinementOps` で `resolveEndpoint` や `createsBeforeCycle` のグラフ探索が追加されたが、イベント数数十〜数百件の規模ではマイクロ秒単位の処理時間であり、パフォーマンスへの影響は皆無である。

### 影響ファイル
- `src/tools/vta/services/generation/granularityRefinement.ts`
- `src/tools/vta/features/vta/utils/subjectRanking.ts`
- `src/tools/vta/features/vta/utils/chainRepair.ts`
- `tests/vta/relationDedupAndRevertPreservation.test.ts`
