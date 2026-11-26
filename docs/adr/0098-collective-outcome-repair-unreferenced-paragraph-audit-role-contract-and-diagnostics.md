# ADR-0098: 集合被災重複主体のPoset構造検知・未参照実質段落の連鎖点検統合・`:affected`／`:target` ロール契約精緻化・およびAI診断の投影指標分離ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: VTA Engine (`eventLedger.ts`, `fulltextLedger.ts`, `chainRepair.ts`, `chainRepairService.ts`, `autoConnectionService.ts`, `proposalContext.ts`, `contextSlicer.ts`, `eventAnalysis.ts`), LLM Prompts (`eventPrompts.ts`, `public/prompts.json`), AI Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0009](./0009-structured-ai-diagnostics-and-telemetry.md), [ADR-0075](./0075-unassigned-event-chain-repair-and-diagnostic-audit.md), [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md), [ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md), [ADR-0097](./0097-root-cohesion-info-loss-incomparable-parent-discovery-and-variation-visibility.md)

## 1. コンテキストと課題 (Context & Problem Statement)

複合インシデントシナリオ（`鹿沼駅事故`・`羽田空港滑走路衝突事故` 等）の一貫検証を通じて、上流の全文正規化・連鎖補完・AI診断の境界に以下の4点の課題が確認された。

1. **集合被災重複主体による既出下位主体の帰結欠落 (`D`)**:
   経緯段落で個別役割主体（例：`副操縦員A`、`機上整備員A`）が抽出されているにもかかわらず、被害段落の集合記述（「機長を除く5名が死亡」等）から帰結イベント専用の葉主体（例：`A機死亡乗組員5名`）が重複生成されると、既出の個別主体のレーンが帰結直前で途切れ、帰結到達性 $O(u)$ と因果連鎖が分断される。
2. **未参照実質段落の連鎖補完トリアージ漏れ (`E`)**:
   正規化プロンプトは全段落参照を指示しているが、長文資料で一部の実質段落が `[イベント]`・`[関係]`・`[整理]`・`[帰結]` のいずれからも未参照のまま残った場合、既存カード群が1連結成分であれば `autoConnectVTA` の事前トリアージ（`isAlreadyFullyConnected`）が Stage 2（`proposeChainRepair`）をスキップし、未参照段落の事象補完機会が失われていた。
3. **通常業務の派遣・配置対象への `:affected` 誤付与 (`F`)**:
   「下請会社が作業員を派遣した」等の定常手配イベントにおいて、被害を受けていない派遣対象作業員に `:affected` が付与されると、受動被災ロール重みや変動対称性の評価にノイズが混入する。
4. **AI診断における `variation:resilient` 極性欠落と投影イベント数の不可視 (`G`)**:
   `aiDiagnostics.ts` の Section 6（`Active Events Ledger`）で `variation:resilient` が単なる `'variation'` に潰れていたほか、`graph.projection` 遷移ログの `events` が有効イベント総数のみを記録していたため、主体未割当（`unassignedEventIds`）によりキャンバスへ投影されていないイベントとの差が一目で判別できなかった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **種別・語彙ヒューリスティクス非依存の形式構造モデル**: `kind === 'person'` の特別扱い、主体名の正規表現（「〜名」「死亡」等）、固定件数閾値を置かず、Poset 葉構造・関与集合・意味関係端点のみから集合被災重複候補を定義すること。
- **事実性と修復停止性の両立**: 既出の兄弟主体が実際には被災しておらず未登場人員のみが被災しているケースでも無限修復ループを起こさず、原文根拠がある場合のみ `:affected` を付与すること。
- **トークン予算内での網羅性担保**: `contextSlicer` が 25,000 文字上限で原文を抜粋する際にも未参照実質段落を優先保持し、`chainRepair` が判断保留段落を `[要確認]`（`unreferenced_paragraph`）として安全に記録できること。
- **既存プロンプト同期・診断互換性の維持**: `DEFAULT_PROMPT_CONFIG` と `public/prompts.json` の完全一致を維持し、既存の診断フォーマット互換性を壊さないこと。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 正規化プロンプトの注意書き追加のみで対応する**
  - プロンプト改善だけでは長文での注意分散（Lost in the Middle）による未参照段落や集合被災主体の散発的混入を決定論的に検知・自己修復できない。
- **選択肢2: 主体名パターンや `kind` 分岐で集合被災主体を強制削除・統合する**
  - 未登場の残余人員が実際に存在する場合や別立場の非被災兄弟がいる場合に事実を歪める恐れがあり、VTA設計原則（形式数理・構造モデル優先）にも反する。
- **選択肢3（採用）: Poset・関係グラフ構造によるソフト検証＋連鎖補完トリアージ統合＋ロール契約明確化＋AI診断精緻化の4層連携**
  - 台帳検証・連鎖補完・プロンプト契約・診断テレメトリの各責務に沿って非破壊かつ根拠駆動で解決する。

## 4. 決定事項 (Decision Outcome)

### 4.1 Poset 葉・関係構造に基づく帰結単独出現主体の検知と修復 (`D`)
`eventLedger.ts` に純粋な構造判定関数 `findIsolatedOutcomeCollectiveMatches(analysis)` を導入する。以下の全条件を満たす主体 $u \in V$ を検知する：
1. **Poset 葉条件**: $\text{desc}(u) = \emptyset$。
2. **損失帰結 `:affected` 単独出現・意味関係ゼロ**: $E(u) \neq \emptyset$ かつ全関与が特定済み `:loss` 帰結イベントにおける `role = 'affected'` のみであり、`before` 以外の意味関係端点を持たない。
3. **共通直接親 $H$ 配下の帰結未到達な既出葉兄弟 $w$ の存在**: 共通の Hasse 親 $H \in \text{parents}(u)$ を持つ葉主体 $w \neq u$ が存在し、$E(w) \setminus E_{\text{outcome}} \neq \emptyset$（事前事象に関与）、$E(w) \cap E_{\text{outcome}} = \emptyset$（全帰結イベントに未関与）、かつ $w$ から帰結イベントへの直接の意味関係が存在しない。

検知時は：
- `inspectLedger` で対象帰結 `[イベント]` 行に `softIssue`（`code: 'isolated_outcome_collective_subject'`）を発行し、`ledgerRepairInput` に兄弟主体 $w$ の初出・焦点根拠段落も自動添付して、原文で被災が確認できる既出下位主体IDへの `:affected` 付与を促す（未登場残余人員がいる場合の併用、および非被災時の現状維持通過を許容）。
- `autoConnectionService.ts` の `isAlreadyFullyConnected` および `chainRepairService.ts` の `[連結診断ヒント]`（「帰結単独出現の重複候補主体」）にも連携し、後段の `[割当追加]` で救済可能とする。

### 4.2 未参照実質段落の網羅性点検と連鎖補完連携 (`E`)
- `eventLedger.ts` に `isSubstantiveSourceParagraph` / `findUnreferencedSubstantiveParagraphs` を共通実装し、`fulltextLedger.ts`・`aiDiagnostics.ts`・`proposalContext.ts`・`autoConnectionService.ts`・`chainRepairService.ts` の単一真実源（Single Source of Truth）へ統一する（危険語リストは `aiDiagnostics.ts` の診断強調表示専用として維持）。
- `contextSlicer.ts`（`sliceProposalSourceRows`）に Pass 2.5 を設け、25,000 文字スライス時にも未参照実質段落を近傍文脈段落より優先して保持する。
- `autoConnectionService.ts` の `chain-repair.triage` は `unreferencedParagraphCount > 0` の場合にスキップせず Stage 2 を起動し、`chainRepairService.ts` は `[原文]` に含まれる未参照実質段落IDを `[連結診断ヒント]` へ提示する。
- `chainRepair.ts` の `[要確認]` 検証を拡張し、`code = unreferenced_paragraph` の場合は `対象ID一覧 = -`（または段落ID）での段落単位レビュー登録を許容する。

### 4.3 正規化ロール契約（`:affected` vs `:target`）の明確化 (`F`, `event-ledger-25`)
- `SUBJECT_LANE_POLICY` および `EVENT_PIPELINE_PROMPTS.normalization.systemPrompt` を更新し（`EVENT_PIPELINE_PROMPT_VERSION = 'event-ledger-25'`）、`:affected` を被害・損傷・死傷・機能喪失・状態悪化（および回復・避難帰結の保護対象）に厳密限定し、人員派遣・配置・業務委託・通常指示の対象主体には必ず `:target`（伝達宛先は `:confirmed_recipient` / `:intended_recipient`）を使用する契約を明記する。`public/prompts.json` を完全同期する。

### 4.4 AI診断における `variation:resilient` 極性保持と投影イベント指標の分離 (`G`)
- `recordGraphProjectionDebug`（`eventAnalysis.ts`）および `aiDiagnostics.ts` の `graph.projection` 遷移集計に `projected_events`（キャンバス上のカードへ実際に投影された有効イベント数）と `unassigned_events`（`> 0` の場合）を追加し、有効イベント総数 `events` との差を即時判別可能にする。
- `aiDiagnostics.ts` の Section 6（`active_events_ledger`）において、`variationFactor.polarity === 'resilient'` または事前仮判定 `preliminary.polarity === 'resilient'` を保持して `'variation:resilient'` を出力する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 既出の個別主体が集合被災表現によって帰結から切り離される構造欠陥を、正規化のソフト修復と連鎖補完の双方で自動的に検知・解消できる。
  - 未参照の実質段落が存在する場合に連鎖補完が確実に起動し、事象追加または `[unreferenced_paragraph]` 要確認記録によってサイレントな段落脱落を防止できる。
  - 定常の人員派遣・配置イベントへの `:affected` 誤付与を抑止し、AI診断パッケージ単体でレジリエンス極性と未割当イベント内訳を正確に監査できる。
- **トレードオフ・考慮事項**:
  - 未参照実質段落が残存しているケースでは `chain-repair.triage` がスキップせず `proposeChainRepair` を1回以上実行するため、網羅性不足の台帳に対する Stage 2 LLM 呼び出し機会が増える（全段落参照済みの正常台帳では従来通りスキップされる）。
- **影響を受けるファイル・テスト**:
  - `.gitignore`
  - `src/tools/vta/features/vta/utils/eventLedger.ts` / `ledgerValidation.test.ts`
  - `src/tools/vta/services/generation/fulltextLedger.ts`
  - `src/tools/vta/features/vta/utils/chainRepair.ts`
  - `src/tools/vta/services/generation/contextSlicer.ts` / `proposalContext.ts`
  - `src/tools/vta/services/generation/chainRepairService.ts` / `chainRepairService.test.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts` / `autoConnectionService.test.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts` / `prompts.test.ts` / `public/prompts.json`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts` / `tests/vta/aiDiagnostics.test.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
