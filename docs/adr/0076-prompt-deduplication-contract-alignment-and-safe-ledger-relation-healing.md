# ADR-0076: 全ステージLLMプロンプトの重複解消・契約統一と台帳関係行の安全な決定論的自己治癒ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-23
- **Target Components**: VTA LLM Prompts (`relationContract`, `factualityPolicy`, `contextEvidencePolicy`, `eventPrompts`, `prompts`, `granularityRefinement`, `chainRepairService`, `client`, `autoConnectionService`), Ledger Validator (`eventLedger`)
- **Related Requirements / ADRs**: [ADR-0030](./0030-one-sided-relation-demotion-and-ai-diagnostics-observability.md), [ADR-0043](./0043-poset-transitivity-across-ledger-and-lane-relation-preservation.md), [ADR-0062](./0062-intra-lane-detour-channel-separation-poset-alias-resolution-and-relation-lineage.md), [ADR-0074](./0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md), [ADR-0075](./0075-unified-subject-retention-solver-suppress-retirement-and-unassigned-completeness.md), [開発ロードマップ](../ROADMAP.md) (`RM-PROMPT-01`〜`03`)

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港C滑走路衝突・炎上事故の AI 診断パッケージ v2.0（`extract_full_1795434819396_sq0l`）の診断および全ステージのプロンプト横断監査により、以下の課題が特定された。

1. **Stage 1 `[関係]` の定型フォーマット揺れによる修復 LLM 通信の発生（`RM-PROMPT-01`）**:
   - 初回 `ledger.validation` の全8件のエラーが、①同一イベント内 `transfer` の先イベントID重複省略による9列出力（`R19, R20, R22`）と、②同一主体間の前後前提に対する `dependency` 出力（`R02, R05, R37, R39, R42`）の2パターンのみに集中し、7,574文字の追加修復通信（+1回・約35秒）を発生させていた。
   - プロンプト監査の結果、`RELATION_CONTRACT_PROMPT` が約850文字の改行なし散文である上に `EVENT_PIPELINE_PROMPTS.normalization` 本文と重複しており、かつ Few-shot 例に同一イベント内 `transfer` の10列例が存在せず、また「VTAでは同一レーン内の前後カード間に自動で直列矢印が描画される」仕様が LLM に伝えられていなかったことが誘因と判明した。
2. **自然現象・発端背景の扱いにおけるプロンプト間の自己矛盾（`RM-PROMPT-02`）**:
   - `eventPrompts.ts` の「自然現象は直接影響先に割り当てる」と、`FACTUALITY_POLICY` / `CONTEXT_EVIDENCE_POLICY` / `SUBJECT_INFERENCE_POLICY` / `chainRepairService.ts` の「同一段落または直前段落の主語引き継ぎのみ許可」が矛盾しており、`p15`（地震発生）→ 直後段落 `p16`（海保が対策本部設置）のような構成で `E01` が未割当のまま残存していた。
3. **集合的な死傷・被災記述での主体分裂と Stage 2/3 スコープ記述のズレ（`RM-PROMPT-03`）**:
   - 経緯で `A_CREW_ENG`（整備員）・`A_CREW_COMM`（通信員）を個別抽出しながら、死傷段落の「その他の搭乗員4名が死亡」に引きずられて1イベントのみの `A_CREW_OTH` を別造し、実動した整備員・通信員から `:affected` が欠落して親組織へ吸収されていた。
   - また Stage 2 の `merge` 説明文に ADR-0074 の逆統合禁止・死傷者保護が未反映であり、`autoConnectVTA` 実行時の `proposeVTAConnections` が直後の `chain.repair` で扱う未割当 `[要確認]` を重複出力していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **入口（プロンプト）と出口（決定論ガード）の補完的分担**: 初回生成率と意味的一貫性はプロンプト整理で高めつつ、数学的に一意な形式揺れのみパーサーで 0ms 吸収する。
- **共有イベント上のクロスレーン修復機会の厳守**: 複数主体が関与する共有イベント（例：`E49(A_CAPT, B_CAPT) -> E57(A_CAPT)`）での同一主体 `dependency` は、別主体ペアへの誤記である可能性があるため無条件に `before` へ潰さず検証エラーを維持する。
- **ADR-0043 / ADR-0062 との整合維持**: 親組織統合により同一レーン非隣接となった意味関係エッジは、組織内サブ役割間の伝達・BREAK 設置候補として意図的に保護されており（6トラック競合回避配線済み）、削除しない。
- **`upsertPolicyBlock` の境界マーカー互換**: 既存の保存済みプロンプトとの冪等コンパイルおよび `public/prompts.json` との完全同期を維持する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A（パーサーのみで無条件自動変換 ＋ 同一レーン非隣接意味エッジ削除）**:
  - *却下理由*: 自己レビューにより、共有イベント上の誤記まで無条件で `before` に降格すると本来のクロスレーン接続が消失すること、また `laneConnections.ts` での非隣接意味エッジ削除は ADR-0043 / ADR-0062 に違反し BREAK 候補を破壊することが判明したため不採用。
- **選択肢 B（採用：プロンプトの重複解消・構造化・ポリシー統一 ＋ 厳格5条件/単一主体限定の安全な台帳自己治癒）**:
  - 全ステージのプロンプトから重複・矛盾を除去して Few-shot と描画仕様を明示し、パーサー側は誤補完・情報消失リスクがゼロの条件（5条件すべてを満たす同一イベント9列補完、および両端とも単一同一主体のみが関与する `dependency` の `before` 降格）のみを自動補正する。

## 4. 決定事項 (Decision Outcome)

1. **正規化プロンプトの重複圧縮と `RELATION_CONTRACT_PROMPT` の構造化（`RM-PROMPT-01`）**:
   - `normalization` 本文の重複した属性散文を圧縮し、`RELATION_CONTRACT_PROMPT` を5項目の箇条書きに整理して SSOT 化する。
   - 「同一主体レーン内は自動で直列矢印が描画されるため、同一主体ID間では因果・前提があっても `dependency` を使わず `before`（両端 `-`）とする」仕様と、同一イベント内 `transfer` の10列正例（`R3\ttransfer\tE3\tA1\tE3\tA2\tp3\tinformation\toccurred\tconfirmed`）を追加する。
2. **台帳 `[関係]` 行の厳格ガード付き決定論的自己治癒（`RM-PROMPT-01`）**:
   - **同一イベント9列補完**: `cells.length === 9`、種別が `transfer | mutual | common | impact`、`cells[2]` が実在イベント `E`、`cells[3] !== cells[4]` がともに実在主体ID（非イベントID）、**両主体ともイベント `E` に `participatesViaPoset` で実際に関与**、かつ参照・属性3列がすべて有効な場合のみ `cells.splice(4, 0, cells[2])` で補完する。
   - **単一同一主体 `dependency` の `before` 降格**: `sourceEventId !== targetEventId` かつ `sourceEntityId === targetEntityId` であり、**元イベント・先イベントの双方の直接関与主体がその単一主体1件のみ**（かつ属性が有効）である場合に限り `before` へ自動補正する（共有イベント絡みは従来どおりエラー検知を維持）。
3. **前提背景・外乱自然現象の推定ルール統一と既出個別主体の優先再利用（`RM-PROMPT-02`, `RM-PROMPT-03`）**:
   - 当日の業務開始前の行為主体を伴わない前提災害・背景は `[整理] background` とし、外乱 `[イベント]` の自然現象は直後段落で直接被災・対応した明示主体への `affected:inferred`（両段落併記）を `FACTUALITY_POLICY`・`CONTEXT_EVIDENCE_POLICY`・`SUBJECT_INFERENCE_POLICY`・`chainRepairService.ts` の全4箇所で統一許可する。
   - `SUBJECT_FOCUS_POLICY`・`OUTCOME_EXTRACTION_POLICY` に、集合的な死傷・被災記述では原文の編成から確認できる既出の個別主体IDへ `:affected` を優先付与し、重複する集合主体を新設しない規則を明記する。
4. **Stage 2 / Stage 3 スコープ同期と配布設定の同期（`RM-PROMPT-03`）**:
   - `GRANULARITY_REVIEW_SYSTEM_PROMPT` の `merge` 制約（逆統合禁止・死傷被災者/厳格非対称ペア保護）と `シナリオ` 評価基準（レーン間接続重視）を明記し、`autoConnectVTA` 実行時は `followedByChainRepair: true` により接続提案での重複未割当 `[要確認]` 出力を抑止する。`public/prompts.json` を `DEFAULT_PROMPT_CONFIG` と完全同期する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 同一イベント9列 `transfer` や単一主体内 `dependency` による Stage 1 の追加修復 LLM 通信（1回約35秒）が削減され、プロンプト段階でも共有イベント絡みの同一主体 `dependency`・9列省略・集合死傷の主体分裂・自然現象の未割当放置が抑止される。
  - 共有イベント上のクロスレーン修復機会や ADR-0043 / ADR-0062 の組織内意味関係・BREAK 候補を一切損なわない。
- **トレードオフ・考慮事項**:
  - 複数主体が関与する共有イベントで同一主体 `dependency` が誤出力された場合は、情報消失を防ぐため引き続き対象行修復パスで解決する（プロンプト側の直列自動描画ルール明示により発生率自体を低減）。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/eventLedger.ts`, `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
  - `src/tools/vta/features/vta/utils/relationContract.ts`
  - `src/tools/vta/services/llm/factualityPolicy.ts`, `src/tools/vta/services/llm/contextEvidencePolicy.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`, `src/tools/vta/services/llm/prompts.ts`, `src/tools/vta/services/llm/prompts.test.ts`, `public/prompts.json`
  - `src/tools/vta/services/generation/granularityRefinement.ts`, `src/tools/vta/services/generation/chainRepairService.ts`, `src/tools/vta/services/generation/autoConnectionService.ts`, `src/tools/vta/services/llm/client.ts`
