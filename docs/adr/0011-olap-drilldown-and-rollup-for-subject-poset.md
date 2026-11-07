# ADR-0011: 主体包含DAGに基づくOLAP的ドリルダウン・ロールアップ（展開・集約）機能

- **ステータス**: Accepted
- **決定日**: 2026-11-06
- **対象コンポーネント**: VTA Engine / UI Presentation / Layout / State Management
- **関連要件 / ADR**: ADR-0008, ADR-0010, `src/tools/vta/features/vta/utils/subjectPoset.ts`, `src/tools/vta/features/vta/utils/presentation.ts`

---

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0010 により、主体の意味論的包含関係は半順序集合（Poset: Partially Ordered Set）および有向非巡回グラフ（DAG: Directed Acyclic Graph）として確定・凍結され、推移律が数学的に保証された。

しかし、実際のインシデント分析や実務のレビュー現場では、以下の相反する2つの視点が同時に求められる：
1. **マクロ視点（エグゼクティブ・サマリー）**:
   - レーン数を少なく抑え、主要な組織やアクター（例：「海上保安庁機」「羽田管制所」「日本航空機」）の単位で事象の流れを俯瞰したい。
2. **ミクロ視点（詳細因果分析・コックピット内インタラクション）**:
   - 特定の親組織の内部で、誰が（機長か、副操縦士か、地上整備員か）どのような判断や交信を行ったかを詳細なサブレーンに分解してトレースしたい。

従来は、レーンを統合（マージ）すると台帳やカードの割当が不可逆的に変更されるか、手動で統合・分離をやり直す必要があり、**「非破壊的に自由な粒度で展開（Drill-down）と集約（Roll-up）を行き来する」** ことができなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **非破壊性 (Non-destructiveness)**: 台帳（Ledger）やイベントの生データ、参加関係（Participations）を改変することなく、表示層（Presentation）だけで動的に切り替え可能であること。
- **Poset DAG との完全整合**: ADR-0010 で定義された推移律・包含関係をそのまま用い、親主体の直接の子（Immediate Children）または推移的子孫（Descendants）を決定論的に展開できること。
- **UIインタラクションの即応性**: キャンバス上のレーンヘッダーやレーン管理パネルから、ワンクリックで展開／折りたたみが可能であること。
- **レイアウトの自動再計算**: ドリルダウン時にレーン幅やノード位置が自動的に滑らかに再計算され、重なりが発生しないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A: 台帳レベルで主体を動的にマージ・アンドゥする**:
  - メリット: プレゼンテーション層の変更が少なくて済む。
  - デメリット: Undo/Redoスタックが汚染され、別操作と競合する。台帳の不可逆変更リスクが高い。
- **選択肢 B: プレゼンテーション層（VTAPresentation）に drilldownLanes フラグを持たせ、表示投影時に動的分配する (採用)**:
  - メリット: 生データは100%保持される。ワンクリックでミリ秒単位で展開・折りたたみが可能。OLAPキューブのような次元操作が実現。
  - デメリット: `visibleSchema` およびレイアウト計算でドリルダウン状態を考慮する必要がある。

---

## 4. 決定事項 (Decision Outcome)

**選択肢 B を採用する。**

### 1. データモデル (`VTAPresentation`) の拡張
`VTAPresentation` に `drilldownLanes?: Record<string, boolean>` を新設する。
- キー: エンティティID（例: `'A2'`）
- 値: `true` の場合、その主体はドリルダウン展開状態となり、直下の子主体（例: `'A1'` 機長, `'A3'` 副操縦士）のレーンが展開表示される。未指定または `false` の場合は親主体に集約（Roll-up）。

### 2. 表示投影 (`presentation.ts`) の動的ドリルダウン解決
`visibleSchema` において：
- ある主体 $P$ が展開されている場合：
  - $P$ の下位子主体 $C_i$ のレーンを動的に `lanes` に挿入。
  - カード/ノードのイベント参加主体を Poset で照合し、最も具体的な子主体 $C_i$ のレーンにカードを投影。
- 展開されていない親主体の場合：
  - 子主体のイベントは親主体 $P$ のレーンに集約表示（Roll-up）。

### 3. UI 操作（`LaneManagementPanel` & `VTACanvas`）
- レーンヘッダーおよびレーン管理パネルに、子主体を持つアクターに対して「📂 展開」「📁 集約」ボタンを表示。
- ユーザーの操作で `vtaStore.toggleLaneDrilldown(entityId)` を呼び出し、瞬時にビューを更新。

---

## 5. 結果と影響 (Consequences)

### メリット
- **経営層レビューと技術詳細分析のシームレスな両立**: 同一のVTAファイルで、マクロ概要（3レーン）とミクロ詳細（10レーン）を即座に切り替えてプレゼンテーション・検討可能。
- **安全な探究**: 生データを一切破壊しないため、ユーザーが安心して様々な粒度を試行できる。

### 影響ファイル
- `src/tools/vta/types/vta.ts`
- `src/tools/vta/features/vta/utils/presentation.ts`
- `src/tools/vta/features/vta/store/vtaStore.ts`
- `src/tools/vta/components/control-panel/LaneManagementPanel.tsx`
- `src/tools/vta/components/VTACanvas.tsx`
- `docs/adr/README.md`
