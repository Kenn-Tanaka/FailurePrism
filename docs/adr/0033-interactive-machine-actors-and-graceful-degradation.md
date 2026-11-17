# ADR-0033: 能動的・対話的装置の主要主体（アクター）昇格およびレジリエンス機能縮退（Graceful Degradation）のVTAツリー統合ポリシー

## メタデータ
- **ステータス**: `Accepted`
- **決定日**: 2026-11-11
- **対象コンポーネント**: `src/tools/vta/features/vta/utils/subjectRanking.ts`, `src/tools/vta/features/vta/utils/eventLedger.ts`, `src/tools/vta/features/vta/utils/normalizationAuditExport.ts`, `src/tools/vta/services/generation/granularityScore.ts`, `src/tools/vta/services/llm/eventPrompts.ts`, `src/tools/vta/services/llm/prompts.ts`, `public/prompts.json`
- **関連要件 / ADR**: [ADR-0007](0007-exclude-post-outcome-activities-and-preserve-resilient-outcomes.md), [ADR-0008](0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0013](0013-machine-lane-suppression-and-refinement-context-slicing.md), [ADR-0031](0031-srk-and-three-failure-factors-variation-classification-and-countermeasure-alignment.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

現代の高度自動化・サイバーフィジカルシステム（航空機、鉄道運行、プラント制御、自動運転等）におけるインシデントでは、以下の2つの振る舞いが決定的な意味を持つ：

1. **人間-機械メンタルモデル不整合（Human-Machine Mental Model Mismatch / Mode Confusion / Automation Surprise）**:
   機械・自律制御装置の予期せぬモード遷移や自動介入と、それを操作・監視する人間（パイロット、管制官、運転士）の認識（メンタルモデル）との乖離が、人間の誤判断や誤操作を誘発し、インシデントをエスカレーションさせる。この場合、装置は単なる客体や支援ツールではなく、インシデントを能動的に推進・相互作用した「主要な主体（アクター）」である。
2. **システムレジリエンスと機能縮退（Graceful Degradation / 機能縮退）**:
   機器内部の異常や外乱が発生した際、Graceful degradation（機能縮退・フォールバック・フェイルセーフ・インターロック等）が自律的または協調的に作動し、破局的事故（損失帰結）を食い止めて安全停止・危機回避に導く場合がある。これはSafety-II（レジリエンス・エンジニアリング）の観点から事故原因分析・安全設計上極めて重要な「成功した防護動作」であり、VTA図において独立したレーンおよび変動要因（`polarity: 'resilient'`）として記録・保持されるべきである。

しかし従来のFailurePrismでは、ADR-0013において「受動的な警報表示器や支援機能が人間レーンを奪うことを防止する」ために、`kind === 'machine'` の主体を一律に低優先度（`kindWeight = 0`, 自律動作1件以下でスコア半減）として扱い、`maxSubjects`（レーン上限）超過時に機械が優先的に `subject_others` へ統合・隠蔽される設計となっていた。
さらに、Stage 1（台帳正規化）時点では最終的な変動要因分類（Stage 2）が未実行であるため、単純に `ev.classification === 'variation'` を参照するだけでは主体統合時に装置が救出されず、機能縮退によって事故が未然に防止された「損失ゼロ（ニアミス・完全回避）」のシナリオで帰結が `not_found` と判定されたり、事後調査除外フィルタ（`filterPostOutcomeScope`）で誤って枝刈りされる危険があった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **受動的警報ツール（ADR-0013）と能動的・対話的装置の厳密な弁別**:
   画面のポップアップや単なる警告音出力のような「一方向の受動的ツール」（ADR-0013の滑走路監視支援機能など）は引き続き人間レーンの下位・客体として抑制し、既存テストを100%保護する必要がある。
2. **多層シグナルによる早期判定（パイプライン順序ギャップの解消）**:
   Stage 1（`normalizeSource`）の段階でも、確定分類に依存せず、予備判定シグナル・人間との双方向因果ループ（非 `before` エッジ）・ドメイン意味論キーワードから能動的装置を高精度に識別できる必要がある。
3. **レジリエンス要因（機能縮退・防護動作）の第一級市民化**:
   機能縮退やフェイルセーフを `polarity: 'resilient'`（`category: 'response'`）として自己治癒・分類し、キャンバス上でのTeal色表示、監査帳票での明記、AI対策推薦（排除対象からの保護）、および事後調査除外からの完全保護を一貫して担保する。
4. **損失ゼロ（完全回避）シナリオでの帰結アンカー維持**:
   重大事故が機能縮退により未然に防がれた場合、その最終的な縮退安全停止・危機回避完了を `identified` のレジリエンス帰結（`outcome_kind: 'recovery'` または `'near_miss'`）として正しくアンカーする。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A: 全ての `machine` の抑制ペナルティを撤廃し、人間・組織と同一の重みで順位付けする**
  - *問題点*: ADR-0013で解決した「単なる支援警報画面や無線機が操縦士や管制官のレーンを奪う問題」が再発し、既存回帰テスト（`subjectRankingMachineSuppression.test.ts`）が破壊されるため不採用。
- **選択肢B: 変動要因（`variation`）を持つ装置のみを昇格させる**
  - *問題点*: Stage 1の台帳正規化直後（`consolidateSubjects` 実行時）には `ev.classification` がまだ `'unclassified'` であり、Stage 1での主体統合から装置が漏れてしまう。また、正常動作としてのモード自動遷移が人間の誤解を誘発したケース（装置自体には不具合がないモード混乱）を捉えられないため不採用。
- **選択肢C (採用): 多層シグナル（双方向因果ループ・意味論シグナル・変動/レジリエンスシグナル）に基づく能動的装置判定（`isActiveOrInteractiveMachine`）とプロンプト・抽出器・除外ガードの統合アーキテクチャ**
  - 受動的警報ツールは抑制（ADR-0013保護）しつつ、メンタルモデル不整合（モード混乱）や機能縮退を起こす装置のみを `kindWeight = 2` へ昇格・マージ保護する。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 能動的・対話的装置の判定関数 `isActiveOrInteractiveMachine` の導入

[`subjectRanking.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/subjectRanking.ts) に `isActiveOrInteractiveMachine(entity, analysis)` を実装。以下のいずれかを満たす `machine` 主体を能動的アクターと認定する：

1. **変動要因（故障）またはレジリエンス回復の保有**:
   `ev.classification === 'variation' || Boolean(ev.variationFactor) || ev.outcome_kind === 'recovery' || ev.preliminary?.value === 'variation'`
2. **ドメイン意味論シグナル**:
   イベントのタイトル・内容・変動理由に、自律制御・モード遷移・不整合・機能縮退・故障を示すキーワード（`ACTIVE_MACHINE_PATTERN`）が含まれる：
   `/(?:モード(?:遷移|移行|切替|不整合|誤認)|自律(?:制御|動作|介入)|自動(?:制御|操縦|ブレーキ|介入)|オートパイロット|インターロック|オーバーライド|フェイルセーフ|フェイルソフト|フォールバック|機能縮退|縮退(?:運転)?|Graceful\s*degradation|メンタルモデル|異常動作|暴走|誤作動|機器故障|システム障害)/i`
3. **他主体との双方向因果ループ（HMI相互作用・Mental Model Mismatch）**:
   他主体との間に `mutual` 関係を持つ、または他主体からの非 `before` 因果入力（`transfer` / `impact` / `dependency`）と他主体への因果出力の両方を持つ。
4. **変動要因または回復イベントとの直接的因果接続**:
   他者のエラーが装置動作を誘発した、または装置動作が他者のエラーや回復を誘発した接続端点となる。

### 4.2 主体順位付け（`rankSubjects`）および統合ガード（`evaluateMergeGuard`）の連携

- `isActiveOrInteractiveMachine` が `true` の装置：
  - `kindWeight` を `0` から `2`（`person` / `organization` と同等）へ昇格。
  - `penalizedMachine`（自律動作1件以下でのスコア半減）を免除。
  - `isInfluentialSubject` で「能動的自律制御・対話的因果またはレジリエンス機能縮退に関与」として影響主体認定。
  - `evaluateMergeGuard` において、相互確認・相互調整（`mutual`）や介入指示が存在する場合は他主体への安易な統合をブロックし独立レーンを死守。
- 受動的警報ツール（一方向の時系列接続のみで変動・機能縮退なし）：
  - 従来通り `kindWeight = 0` となり、人間・組織レーンを奪わない（ADR-0013を完全維持）。

### 4.3 機能縮退・レジリエンス要因の抽出パーサーおよびUI表示

- [`eventLedger.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/eventLedger.ts) の `extractVariationFactorFromReason`:
  - `isResilient` の検出パターンに `/機能縮退|縮退(?:運転)?|フェイルセーフ|フェイルソフト|フォールバック|Graceful\s*degradation|安全保護|インターロック作動|自律的(?:な)?安全停止/i` を追加。
  - `isResilient` が真の場合は内部故障の記述が含まれていても防護動作として `category: 'response'`, `polarity: 'resilient'` として自己治癒。
- [`normalizationAuditExport.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/features/vta/utils/normalizationAuditExport.ts):
  - `detail.category === 'response'` かつ `detail.polarity === 'resilient'` で認知レベル未設定の場合、`状態変化への応答 (レジリエンス対応/防護動作)` と明記。

### 4.4 事後調査除外フィルタ（`filterPostOutcomeScope`）および対策立案プロンプトの保護

- [`granularityScore.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/services/generation/granularityScore.ts):
  - 帰結以降であっても、ノードがレジリエンス要因（`polarity === 'resilient'`）または回復（`outcome_kind === 'recovery'`）を含む場合は事後調査活動とみなさず無条件に保護。
- [`eventPrompts.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/services/llm/eventPrompts.ts):
  - `SUBJECT_LANE_POLICY` に「メンタルモデル不整合および機能縮退（レジリエンス）における装置主体」抽出規約を明記。
  - `OUTCOME_EXTRACTION_POLICY` に機能縮退やフェイルセーフによる危機回避・安全停止時の帰結抽出規約を明記。
- [`prompts.ts`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/services/llm/prompts.ts) & [`public/prompts.json`](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/public/prompts.json):
  - AI対策提案において、レジリエンス要因（機能縮退・フェイルセーフ等の有効な防護動作）を排除対象に含めない保護指針を追加。

---

## 5. 結果と影響 (Consequences)

### メリット
- **高度自動化システムの因果忠実性向上**:
  モード混乱（Mode Confusion）やオートパイロットの予期せぬ動作と操縦士の認識ギャップが独立レーン間で可視化され、事故の本質的原因であるHMIメンタルモデル不整合が鮮明に分析可能となった。
- **Safety-II（レジリエンス）分析の実現**:
  不具合発生時に破局的被害を阻止したGraceful Degradation（機能縮退）やフェイルセーフ動作が、Tealカラーのレジリエンス要因としてVTA図上に正当に記録・保持され、AI対策推薦で誤って排除されることを防止。
- **後方互換性とADR-0013の完全保護**:
  受動的な支援機能や一方向アラーム（羽田事故の滑走路監視機能等）は引き続き人間・組織レーンを侵食せず、既存テストは100%パスする。

### 影響ファイル
- `src/tools/vta/features/vta/utils/subjectRanking.ts`
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/features/vta/utils/normalizationAuditExport.ts`
- `src/tools/vta/services/generation/granularityScore.ts`
- `src/tools/vta/services/llm/eventPrompts.ts`
- `src/tools/vta/services/llm/prompts.ts`
- `public/prompts.json`
- `tests/vta/subjectRankingMachineSuppression.test.ts`
- `docs/adr/0033-interactive-machine-actors-and-graceful-degradation.md`
- `docs/adr/README.md`
