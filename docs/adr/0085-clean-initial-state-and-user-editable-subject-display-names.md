# ADR-0085: VTA初期状態のクリア化（組み込みサンプル事例の撤去）と主体表示名のユーザー加筆修正ポリシー

- **Status**: Accepted
- **Date**: 2026-11-24
- **Target Components**: VTA Store (`vtaStore.ts`), Sample Data (`sampleData.ts`), Subject Ranking / Rename Transition (`subjectRanking.ts`), Canvas Lane Headers (`StickyLaneHeaderBar.tsx`, `SwimlaneBackground.tsx`, `VTACanvas.tsx`), Control Panels (`ScenarioInputSection.tsx`, `LaneManagementPanel.tsx`, `EventReviewPanel.tsx`)
- **Related Requirements / ADRs**: ADR-0073, ADR-0079, ADR-0083, ADR-0084

## 1. コンテキストと課題 (Context & Problem Statement)

1. **統合グループ・主体ラベルの表現調整ニーズ**:
   - ADR-0079〜0084 の多軸半順序集合（Subject Poset）およびビーム併用山登り法レーン統合により、同質メンバーや中間ハブ（例：「待避作業員」「中継見張員」「第1020列車編成」等）が自動的に適切な粒度へ統合されるようになった。
   - 一方で、自動付与された簡潔なグループ名（例：「待避作業員」）に対して、分析者・レビュー読者の理解を高めるために「法面待避作業員（E・F）」のように表示名を加筆・補足したいケースがあるが、従来は主体レーンの新規追加・順序入替・統合・分割のみで、既存主体の表示名だけを安全にリネームする手段が存在しなかった。
2. **起動時の組み込みサンプル事例によるノイズ**:
   - 従来の VTA エディタは起動直後に組み込みサンプル（`【事例1】衛星サブシステム設計変更・手順書改訂漏れ` および `【IT/Web事例】本番デプロイ時のDBマイグレーション障害`）を初期ロードしていたため、実案件の事故調査書やヒヤリハット報告を分析する際に毎回不要なサンプルデータが画面・入力欄を占有していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **構造・座標・Undo履歴の完全保全**: 主体の表示名変更によって内部エンティティID（`entity.id`）、Poset親子関係、イベント関与、関係エッジ、手動調整済みのカード座標（`position` / `compact_position`）が一切損なわれないこと。また `cloneSchemaForHistory` が参照共有する `fineGrainedBase` を破壊的変更せず Undo / Redo で完全に復元できること。
- **再最適化（スライダー変更）との整合**: 統合グループ名や個別主体名をユーザーが加筆修正した後、主体数上限の変更や `reoptimizeVTA`（キャッシュ済み候補による再探索）を実行しても、修正後の表示名が先祖返りしないこと。
- **即座に分析を開始できるクリーンな初期画面**: 起動時は空のシナリオ・空のキャンバスからクリーンに開始でき、空キャンバス上では次の操作（シナリオ入力 / ファイル読込 / JSON開く / カード追加）が簡潔に案内されること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: 表示レイヤ（`presentation`）にのみ別名マップ（`laneAliases`）を持たせる。
  - 却下理由: SVG出力・正規化監査レポート・AI再生成レポート・対策提案モーダル等で `entity.name` / `node.lane` と表示別名の二重解決が必要となり、出力間の名称不整合を招きやすい。
- **選択肢B（採用）**: エンティティID（`entity.id`）を不変に保ったまま、`lanes`・`nodes[].lane`・`analysis.entities`・`subjectRanking.originalEntities`・`fineGrainedBase.entities`（イミュータブル複製）・`laneConsolidation.candidates[].targetLabel` を一貫更新する純粋変換 `applyLaneRenameTransition` を導入し、製品初期状態を空スキーマへ統一する。

## 4. 決定事項 (Decision Outcome)

1. **組み込みサンプル事例の撤去とクリーン初期状態化**:
   - `src/tools/vta/features/vta/data/sampleData.ts` から `【事例1】` および `【IT/Web事例】` を撤去し、`SAMPLE_SCENARIOS = []` とする（単体テスト用のグラフ種データは `tests/helpers/vtaTestFixtures.ts` 等へ分離）。
   - `useVTAStore` の初期状態を `scenarioText: ''`、`vtaData: { lanes: [], nodes: [], edges: [] }`、`nodes: []`、`edges: []`、`laneBounds: []`、`isDirty: false` とし、作業内容を初期状態へ戻す `resetProject()` アクションと `ScenarioInputSection` の「クリア」ボタン、および `VTACanvas` の空キャンバス案内表示を導入する。
2. **主体表示名のインライン加筆修正機能（`applyLaneRenameTransition` / `renameLane`）**:
   - 空文字・既存の他レーン名との重複・通常主体の予約名「その他の関係者」への衝突を検証・拒否する（統合は明示的な「統合」操作に分離）。
   - `entity.id` と列インデックスを維持したまま `lanes`、`nodes`、`analysis.entities`、`subjectRanking.originalEntities`、`fineGrainedBase.entities`（新規オブジェクト複製）、`laneConsolidation.candidates`（`targetLabel`）、および `measuresProposal` のレーン名を一括更新し、`commitVTAChange` を通じて Undo / Redo と下書き保存に対応する。
   - キャンバス上部の固定ヘッダー（`StickyLaneHeaderBar`）およびスイムレーン背景ヘッダー（`SwimlaneBackground`）でのダブルクリック／鉛筆アイコンによる直接インライン編集と、`LaneManagementPanel`（右ドックおよび `EventReviewPanel` 内）での名称変更UIの双方を提供する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 自動統合された役割グループ名や専門用語を含む主体名を、分析者が図面上で直感的にわかりやすい表現へ加筆・洗練でき、SVG出力・監査レポート・改善レポートのすべてに一貫反映される。
  - アプリケーション起動直後から余分なサンプル情報のないクリアな状態で対象シナリオの読込・入力を開始できる。
- **トレードオフ・考慮事項**:
  - 既存の単体テストのうち初期サンプルデータの存在を前提としていたテスト群は、明示的なテストフィクスチャ（`seedVTAStoreWithFixture`）を呼び出す形へ移行した。
- **影響ファイル**:
  - `src/tools/vta/features/vta/data/sampleData.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/features/vta/components/StickyLaneHeaderBar.tsx`
  - `src/tools/vta/features/vta/components/SwimlaneBackground.tsx`
  - `src/tools/vta/features/vta/components/VTACanvas.tsx`
  - `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`
  - `src/tools/vta/components/control-panel/LaneManagementPanel.tsx`
  - `src/tools/vta/components/control-panel/EventReviewPanel.tsx`
  - `tests/helpers/vtaTestFixtures.ts`
  - `tests/vta/subjectRenameAndCleanInit.test.tsx`
