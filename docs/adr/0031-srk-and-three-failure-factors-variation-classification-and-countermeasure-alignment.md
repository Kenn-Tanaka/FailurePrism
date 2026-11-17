# ADR-0031: SRK・失敗学三大要因による変動要因精緻化・正負色分け可視化と体系的対策推薦アーキテクチャ

- **ステータス**: Accepted
- **決定日**: 2026-11-09
- **対象コンポーネント**: VTA Engine (`VTANode.tsx`, `NodeEditorModal.tsx`, `eventLedger.ts`, `normalizationAuditExport.ts`, `svgExport.ts`, `animatedSvgExport.ts`), Prompts (`prompts.ts`, `eventPrompts.ts`, `prompts.json`)
- **関連ドキュメント・コミット**: [ADR-0001](file:///docs/adr/0001-two-stage-event-classification-and-batch-adoption.md), [ADR-0004](file:///docs/adr/0004-normalization-audit-and-human-traceability.md), [ADR-0006](file:///docs/adr/0006-vta-animation-and-animated-svg-export.md), [ADR-0007](file:///docs/adr/0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0016](file:///docs/adr/0016-preliminary-classification-pipeline-separation.md), [ADR-0030](file:///docs/adr/0030-one-sided-relation-demotion-and-ai-diagnostics-observability.md)

## 1. コンテキストと課題 (Context & Problem Statement)

バリエーションツリー分析（VTA）において、変動要因（variation: 通常からの逸脱・状態変化）は事故原因究明と再発防止策立案の中心概念である。しかし、従来のFailurePrismには以下の課題が存在した：

1. **変動要因の分類における認知モデルの欠落**:
   - 先行応答（`response`）に対してのみRasmussenのSRKモデル（Skill, Rule, Knowledge）が適用可能となっていたが、人為的行為による通常作業からの直接的逸脱（`departure`）に対しては認知レベルの構造化がなく、単なる「人為逸脱」として一括りにされていた。
   - 失敗学における三大要因（**過信・無視・無知**）はSRKモデルの各行動水準（過信 $\leftrightarrow$ Skill、無視 $\leftrightarrow$ Rule、無知 $\leftrightarrow$ Knowledge）と本質的に対応しているにもかかわらず、システム内で体系化されていなかった。
2. **正の変動（レジリエンス・リカバリー要因）と負の変動（不具合・エラー）の視覚的識別困難**:
   - Safety-II観点において、事故を未然に防いだり被害を最小限に食い止めた臨機応変なリカバリー行動（正の変動）は、事故を進展させた悪化要因（負の変動）と同等以上に重要である。
   - しかし、VTAキャンバス上ではどちらも暗色背景のカードとして描画され、一目で「何が悪因で、何がファインプレー（好転要因）か」を直感的に見分けることが困難であった。
3. **要因分類と対策推薦（Proposal / Report）の論理的断絶**:
   - 抽出・判定された変動要因がどのような行動レベル（Skill/過信、Rule/無視、Knowledge/無知）や内部・外部要因に起因するかと、AIが提案する再発防止策（排除ノード・ブレーク）との間に論理的な結びつきがなく、精神論（「注意を徹底する」等）を排除した工学的バリアの体系的提示が不十分であった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **人間中心設計と認知工学の統合**: 失敗学の三大要因（過信・無視・無知）とSRKモデルを融合し、作業者の心理を決めつける主観的ラベリングを排しつつ、要求された行動制御水準と物理的逸脱を客観的に構造化すること。
- **直感的な視覚認識性（一目瞭然の色分け）**: 負の要因（Amber/Orange系）と正の要因（Teal/Emerald系）をキャンバス・SVG・アニメーション全体で明確に色分けし、分析者の認知負荷を最小化すること。
- **工学的対策への直結**: 変動要因の原因類型に応じた適切なバリア（ポカヨケ、独立ダブルチェック、シミュレータ訓練、フェイルセーフ設計等）をAIが自動的に選定できるプロンプト体系を確立すること。
- **後方互換性と自動抽出（自己治癒）**: 既存の台帳パース形式を破壊せず、AIが出力した理由文から決定論的にカテゴリ・極性・行動レベルを自動抽出・補完すること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 手動編集モーダルでのみ三大要因と極性を選択可能にする**
  - 課題: LLM自動生成パイプラインでは属性が空のままとなり、分析者が全カードを手動で編集しない限り色分けや体系的対策が機能しない。
- **選択肢2: TSV台帳の列数を拡張して分類・極性を直接出力させる**
  - 課題: LLMのTSV出力列数を変更すると、長大資料での出力破綻や既存パーサー・テストの広範な修正リスクが生じる。
- **選択肢3: UI拡張＋判定理由文からの決定論的自動抽出＋AI対策推薦プロンプト体系化（採用）**
  - メリット: 4列TSV（ID、判定、理由、原文参照）の堅牢なプロトコルを維持したまま、理由文のキーワードから高精度に自動判定し、UIでの微調整およびStage 4での工学的対策提案までを一気通貫で連動できる。

## 4. 決定事項 (Decision Outcome)

### 4.1. VTA図上の正負色分け可視化仕様
キャンバスカード（`VTANode.tsx`）、SVGエクスポート（`svgExport.ts`）、およびアニメーション（`animatedSvgExport.ts`）において、以下の配色ルールを厳格に適用：

- **通常作業 (Normal)**:
  - 枠線: `border-slate-700` (細枠 1px) / 背景: `bg-slate-900/90` / ヘッダー: `bg-slate-800/60` / アイコン: `Activity`
- **負の変動 (Negative Variation)**:
  - 枠線: `border-2 border-amber-400` (太枠 2px、警告琥珀色)
  - 背景: `bg-gradient-to-b from-amber-950/30 via-slate-900/95 to-slate-900/95` (深色アンバーティント)
  - ヘッダー: `bg-amber-950/60 border-amber-700/60 text-amber-300` / アイコン: `AlertTriangle`
  - バッジ: `bg-amber-950/80 border-amber-800/70 text-amber-300`
- **正の変動 (Resilient Variation: レジリエンス・好転要因)**:
  - 枠線: `border-2 border-teal-400` (太枠 2px、青緑色)
  - 背景: `bg-gradient-to-b from-teal-950/40 via-slate-900/95 to-slate-900/95` (青緑ティント、`ring-teal-500/20`)
  - ヘッダー: `bg-teal-950/80 border-teal-700/60 text-teal-200` / アイコン: `ShieldCheck`
  - バッジ: `bg-teal-950/90 border-teal-700/80 text-teal-300 font-semibold`
  - アニメーションパルス: `@keyframes vtaPulseTeal`

### 4.2. 人為逸脱（通常作業からの逸脱）への三大要因（SRK）の適用
- **`NodeEditorModal.tsx`**:
  - `departure`（通常逸脱）選択時にも行動レベル選択UIを展開。
  - `過信(Skill)`、`無視(Rule)`、`無知(Knowledge)`、`その他` の4水準を選択可能にし、カード上にも `人為逸脱(skill)` / `人為逸脱(rule)` / `人為逸脱(knowledge)` と明示。
  - 極性選択を Amber（負の変動）vs Teal（正の変動）のワンクリックボタンに刷新。
- **`normalizationAuditExport.ts`**:
  - 監査レポートにおいて `通常作業からの逸脱 (人為的行為) (過信/Skillベース)` のように日本語体系名を完全出力。

### 4.3. Stage 1b / Stage 3 変動要因自動抽出パーサー（`eventLedger.ts`）
`inspectClassifications` において、`extractVariationFactorFromReason(reason)` を呼び出し、判定理由文から自動抽出・自己治癒：
- **極性判定 (`polarity`)**: 「レジリエンス、リカバリー、好転、食い止めた、危機回避、防護、正常復帰」等の語句から `resilient` / `negative` を判別。
- **カテゴリ判定 (`category`)**: 「内部要因・故障・異常」 $\to$ `internal`、「外部要因・天候・外乱」 $\to$ `external`、「先行・状態変化・応答」 $\to$ `response`、「逸脱・人為・過信・無視・無知」 $\to$ `departure`。
- **行動水準判定 (`cognitiveLevel`)**: 「過信・慢心・慣れ・熟練・Skill・スリップ」 $\to$ `skill`、「無視・軽視・省略・バイパス・Rule・手順」 $\to$ `rule`、「無知・未習得・知識不足・理解不足・Knowledge」 $\to$ `knowledge`。

### 4.4. Stage 4 AI対策推薦（Proposal）とレポート生成の工学的バリア体系化
`DEFAULT_PROMPT_CONFIG.proposal` および `reportGeneration` に以下の工学的バリア指針を統合：
1. **過信 / Skillベース**: 精神論（注意喚起）を禁止し、**治具のポカヨケ化、物理インターロック、センシング自動化、エラー耐性操作系**を提示。
2. **無視 / Ruleベース**: 再周知を排し、**独立した第三者ダブルチェック、承認ゲート、システム的進行遮断、手順簡素化**を提示。
3. **無知 / Knowledgeベース**: カンに頼らず、**異常時シミュレータ訓練、リアルタイム状態可視化・異常診断支援画面**を提示。
4. **内部要因**: **冗長系（多重化）、フェイルセーフ設計、予防保全周期短縮**を提示。
5. **外部要因**: **耐環境設計、早期検知アラート、事前退避・計画停止基準**を提示。

## 5. 結果と影響 (Consequences)

### メリット
- **視認性の飛躍的向上**: VTA図全体を一瞥しただけで、「事故を拡大させた負の連鎖（琥珀色）」と「食い止めようとしたレジリエンス（青緑色）」が直感的に判別可能となった。
- **失敗学と安全工学の直結**: 畑村失敗学（三大要因）とRasmussen認知工学（SRK）が融合し、人為的エラーの原因水準と打つべき工学的バリアが一対一で整合するようになった。
- **自動化と人間参加の両立**: AIによる自動抽出で即座にカードに属性が付与されつつ、ユーザーが`NodeEditorModal`で直感的に修正・検証できる。

### トレードオフ・考慮事項
- 理由文からの自動抽出はキーワードパターンに依存するが、正規表現の網羅性を高めるとともに、未特定時は安全にデフォルト（`departure` / `negative`）へ倒し、ユーザーの手動編集を可能とすることで頑健性を確保している。

### 影響を受けるファイル・テスト
- `src/tools/vta/features/vta/components/VTANode.tsx`
- `src/tools/vta/features/vta/components/NodeEditorModal.tsx`
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/features/vta/utils/normalizationAuditExport.ts`
- `src/tools/vta/features/vta/utils/svgExport.ts`
- `src/tools/vta/features/vta/utils/animationSequencer.ts`
- `src/tools/vta/features/vta/utils/animatedSvgExport.ts`
- `src/tools/vta/services/llm/eventPrompts.ts`
- `src/tools/vta/services/llm/prompts.ts`
- `public/prompts.json`
- `tests/vta/outcomeAndVariationFactors.test.ts`
- `src/tools/vta/features/vta/utils/normalization.test.ts`
- `tests/vta/normalizationAuditExport.test.ts`
- `src/tools/vta/services/llm/prompts.test.ts`
