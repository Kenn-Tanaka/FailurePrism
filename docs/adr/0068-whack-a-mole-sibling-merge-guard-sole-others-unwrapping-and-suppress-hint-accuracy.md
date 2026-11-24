# ADR-0068: 明示マージ時の同親兄弟モグラ叩き昇格防止・親なし主体枠優先予約と単独「その他の関係者」根絶・およびsuppress対象ヒント精密化ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-22
- **対象コンポーネント**: VTA Engine (`subjectRanking`, `granularityRefinement`, `vtaStore`, `aiDiagnostics`)
- **関連ドキュメント・コミット**: ADR-0008, ADR-0050, ADR-0064, ADR-0065, ADR-0066, ADR-0067

## 1. コンテキストと課題 (Context & Problem Statement)

14主体・24イベント規模の鉄道触車事故報告書（`maxSubjects = 6`）における `refined-chain` 診断トレースで、以下の構造的不整合が確認された：

1. **明示 `merge` 時のモグラ叩き再昇格（Whack-a-Mole Promotion）**:
   粒度反復 `#1` で `merge:S_H->S_WORKGROUP`、`#2` で `merge:S_I->S_WORKGROUP` が連続採用されたにもかかわらず、`retainableCandidates` の上位スライスが空いた枠を埋めるために、同じ `S_WORKGROUP` 配下で次点にいた統合可能な兄弟（`S_I`）や直接関与0件の上位組織（`S_TOBU`）を `overflowPool` から順次引き上げて独立レーン化していた。
2. **ソフト Merge Guard による予約枠の横取りと「1社単独の『その他の関係者』」による上限超過（7レーン化）**:
   `keepCount = effectiveLimit - 1` で確保した `subject_others` 用の1枠を、親なし関与主体（`S_SUB`: 下請会社）より先にソフト Merge Guard（`!strictAsymmetry`）候補が `retainedIds.size < effectiveLimit` で消費してしまい、後続の `S_SUB` 1社だけが `subject_others` に包まれて7列目（`C1 = 0.83`）を形成していた。
3. **粒度反復プロンプトの `suppress` 指針と実装制約の乖離およびスコア表示尺度差**:
   `suppress` は仕様上「単独1枚カードのレーン（`laneCardCounts === 1`）」かつ非保護カードに限定されるが、`buildReviewUserPrompt` は対象カードIDを提示せず一律に `suppress` を促していた。また反復ログで `#0`（純機械スコア）と `#1`（改修前図面へのLLMシナリオ評価混合スコア）が並ぶことで採用時にスコアが低下したように見えるほか、サフィックスなし一次損失帰結で `meta.outcome.kind` が省略されていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **主体上限（`maxSubjects`）遵守と実名レーン優先**: 厳密非対称（ADR-0008 `strictAsymmetry`）がない限り合計レーン数を `maxSubjects` 以内に収め、1主体しか入らない無意味な `subject_others` ラッパーを作らないこと。
- **明示統合の一貫性**: ある作業員を親作業班へ明示統合した際、それより下位の同条件の作業員が入れ替わりで独立レーン化する逆転現象を起こさないこと。
- **既存テスト・Poset不変条件との完全互換**: 異組織主体の上位繰り上がり（ADR-0065）や0関与親組織のハブ昇格（ADR-0050）を維持すること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: 親ハブが保持された時点で `evaluateMergeGuard.allowed` な全子孫を順位に関わらず一律に親ハブへ強制統合する。
  - *却下理由*: 枠に余裕がある場面でも上位の主要役割主体（例: 見張員・現場代理人）まで親組織へ潰してしまい、ADR-0065 の期待動作と衝突する。
- **選択肢B（採用）**:
  1. `explicitMerges` で `sourceId -> targetId` が指定された場合、`targetId` の子孫であり `sourceId` より下位にランクされ `evaluateMergeGuard(sib, targetId).allowed` を満たす非優先兄弟のみを `targetId` へ追随統合し、また直接関与0件の非強制組織は初期スライスから外してハブ昇格判定（`overflowPool`）へ回す。
  2. `overflowCandidates` を2パスで解決し、親なし関与主体が存在する場合は1枠を予約した上でソフト Merge Guard を判定し、さらに `soleOthersEntries.length === 1` は常に実名主体へ展開する。
  3. `buildReviewUserPrompt` で実在する `suppress` 可能単独カードIDのみを提示し、反復ログ・再最適化履歴への `機械S` 併記および `aiDiagnostics` のデフォルト `kind: "loss"` 補完を行う。

## 4. 決定事項 (Decision Outcome)

選択肢Bを採用し、以下の変更を実施した：

1. **同親下位兄弟の追随統合・0参照組織の優先抑制・厳密非対称優先および2パス予約枠解決 (`subjectRanking.ts`)**:
   - 明示統合前の実保持集合（`baselineRetainedIds`）の外にいた統合可能な同親兄弟を `cascadedSiblingMergeById` で追随統合し、モグラ叩き昇格を抑止した。
   - イベント関与も関係端点参照も持たない純粋な包含定義用上位組織はハブ昇格時以外は優先枠を消費しないよう制御し、全関与主体が上限内に収まる場合は `excluded` とした。
   - `evaluateMergeGuard` でソフトブロック（情報 `transfer`・`dependency`）が厳密非対称（物理 `impact`・回復対立等）より先に早期 return して `strictAsymmetry` を隠蔽する順序依存を修正した。
   - `unparentedOthersCount > 0` のとき `reservedOthersSlot = 1` を確保してソフト Merge Guard の枠横取りを防ぎ、`soleOthersEntries.length === 1` は常に実名主体へ展開するようにした。
2. **実行可能な `suppress` 対象カードIDの動的提示 (`granularityRefinement.ts`)**:
   - `laneCardCounts === 1` かつ非保護・他レーン表示済みの単独カードが存在する場合のみそのIDを列挙し、存在しない場合は `group` と細粒度主体の `merge` を案内するよう改善した。
3. **純機械スコア推移の併記と診断帰結種別の補完 (`granularityRefinement.ts`, `vtaStore.ts`, `aiDiagnostics.ts`)**:
   - 反復ログに `機械S=prev→next` を併記し、`reoptimizeVTA` の Stage 2 説明文も機械スコア比較に統一した。
   - `buildAIDiagnostics` で `status === 'identified'` 時に `kind: analysis.outcome.kind ?? 'loss'` を補完した。

## 5. 結果と影響 (Consequences)

### メリット
- 多人数作業班＋下請会社＋鉄道会社の構成（14主体→上限6）で、初回から `除草作業班`・`B列車見張員`・`D中継見張員`・`G現場代理人`・`第1020列車運転士`・`下請会社` の実名6レーン（`C1 = 1.00`、`subject_others` 0件）へ確定的に収束し、不要なモグラ叩き反復や共有カードの過剰分散も同時に抑制される。

### トレードオフ・考慮事項
- 明示マージ元より上位にランクされている同親主体（例: 主要行為者である見張員）は自動追随統合されないため、主要な個別役割レーンは従来通り保持される。

### 影響ファイル
- `src/tools/vta/features/vta/utils/subjectRanking.ts`
- `src/tools/vta/features/vta/utils/subjectRanking.test.ts`
- `src/tools/vta/services/generation/granularityRefinement.ts`
- `src/tools/vta/services/generation/granularityRefinement.test.ts`
- `src/tools/vta/features/vta/store/vtaStore.ts`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `tests/vta/aiDiagnostics.test.ts`
- `docs/adr/0068-whack-a-mole-sibling-merge-guard-sole-others-unwrapping-and-suppress-hint-accuracy.md`
- `docs/adr/README.md`
