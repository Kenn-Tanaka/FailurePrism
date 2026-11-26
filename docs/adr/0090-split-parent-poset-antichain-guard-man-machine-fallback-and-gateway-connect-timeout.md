# ADR-0090: 分裂親に対する保守的Poset反鎖保護・クリーン人機複合ハブの決定論統合・部分0イベント親配下の組織枝統合・およびGateway上流接続タイムアウト拡充ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: VTA Engine (`subjectPoset.ts`, `laneConsolidationOptimizer.ts`, `vta.ts`), LLM Client (`client.ts`), LLM Gateway Config (`llm-gateway.default.json`)
- **関連ドキュメント・コミット**: [ADR-0033](./0033-autonomous-machine-lane-retention-for-mode-confusion-and-resilience.md), [ADR-0080](./0080-inclusion-penalty-function-others-eligibility-gate-and-cascade-outcome-scope.md), [ADR-0082](./0082-virtual-role-group-cost-parity-protagonist-asymmetry-guard-and-sole-actor-dependency-healing.md), [ADR-0084](./0084-poset-antichain-pure-upper-hubs-and-man-machine-composite-subjects.md), [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md), [ADR-0089](./0089-two-stage-cohort-subgroup-consolidation-passive-guard-symmetry-and-post-loss-stop-scope.md)

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線新鹿沼駅構内事故トレース（`extract_full_1795615471463_g5g1`、6,990文字）および東京国際空港C滑走路海保機・日航機衝突炎上事故トレース（`extract_full_1795617032766_ov94`、28,530文字・60イベント・42主体Posetノード）のAI診断分析により、以下の4つの課題が確認された。

1. **LLM Gateway 上流TCP/TLS接続タイムアウト（`10,000ms`）による一時的 `502` と `poset_fallback` 退避（`g5g1`）**:
   - OpenRouter への TLS ハンドシェイク遅延時に `upstream_connect_ms = 10000` が連続発火して `lane_consolidation` が `AI候補=skip` へフォールバックしていた。
2. **`poset_fallback` 単独動作時における人間-機械0イベント複合ハブの分裂残留（`g5g1`）**:
   - 0イベント複合親 `A14（下り特急列車）` 配下の `A13（運転士K, focus: high, :loss :actor）` と `A15（100系車両, machine）` について、`AI候補=skip` 時に `recommendedPosetPairs` が空となるため、2主体バンドル候補の不生成および `P_sub` の `hasExclusiveOutcomeActor` 罰則（`0.65`）により統合が棄却され、運転士レーンと車両レーンに分裂していた。
3. **分裂親（外部に独立アクティブ子孫を残す親組織）の仮想 `role_group` 参加による偽Poset親子関係（Antichain違反：`ov94`）**:
   - `T1（タワー東, T1 ≺ A_ATC）` を独立レーンとして維持しつつ、残余カードを持つ `A_ATC（航空管制機関）` を `M3（group_周辺管制席_監視支援機能）` に統合した際、`discoverConservativeParent` が無条件に `A_ATC ≺ group_周辺管制席_監視支援機能` を張った結果、推移閉包 `T1 ≺ A_ATC ≺ group_周辺管制席_監視支援機能` が発生し、`T1` が隣接する周辺管制グループのPoset子として誤記録されていた。
4. **大規模報告（60イベント級）における `C2` 過小評価（`0.233`）と部分0イベント法人親配下の地上・本部組織枝の未統合（`ov94`）**:
   - ① `P_group` が `kind: 'machine'`（`A_AC_A: 海上保安庁機`）の単独物理イベントまで「非同質な人間監督者」と誤判定して `0.72` の罰則を課していた。
   - ② 多人数クルー内の `evaluateMergeGuard` 由来 `soft` 分離ペアがバケット内で二乗オーダー累積していた。
   - ③ `[推奨統合]` の `role_group` 内に含まれる1カード親（`A_ATC`）に対し、バケット全体が多数の `:actor` を持つにもかかわらず `isZeroActorShellInversion` が発火していた。
   - ④ 別サブコホート `A_JCG_TEAM（A機乗組員）` 配下の主人公 `A1, A2` が地上局 `A_JCG_HND` の `hasUnmergeablePersonDescById` をブロックし、さらに部分0イベント法人親 `A_JCG` 配下の非主人公組織枝（`A_JCG_HD`・`A_JCG_HND`）を Tier-2 で束ねる経路が欠けていたため、10列（目標7列）で停滞していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **保守的Poset拡大（$\forall x, y \in V,\; x \preceq y \iff x \preceq' y$）と反鎖性の厳密両立（`AGENTS.md`）**:
  - 既存Poset関係を一切破壊せず、かつ新親 $P$ の上位共通祖先配置（$P \prec \text{MCA}(S)$）を維持したまま、外部アクティブ子孫 $d \notin S$ への偽推移辺 $d \prec m \prec P$ を遮断する必要がある。
- **`ADR-0033` モード錯誤・自律介入機械の分離保護と `e07r` / `9yqp` / `b4k9` 回帰テストの完全維持**:
  - 人機0イベントハブ統合は `evaluateMergeGuard` が許容する非対立ペア（`!hasAutonomousConflict`）に厳密限定し、また `subject_others` 適格性ゲートは緩和せず名前付き `role_group` として組織枝を統合する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1**: `buildSubjectOthersEligibilitySet` を緩和してアクティブ上位組織（`A_JCG_HND` 等）を `subject_others` に送り、`discoverConservativeParent` の入力配列自体から分裂親を除去する。
  - 却下。① `ADR-0088` の Poset 子引きずり込み禁止と衝突し、かつ変動イベントを含む海保地上通信が「その他の関係者」に混入する。② 全メンバーが外部子孫を持つ場合に `discoverConservativeParent` の上位共通祖先辺まで消失する。
- **選択肢2**: `discoverConservativeParent` の上位共通祖先計算（全 `memberIds`）と下位辺付与対象（外部アクティブ子孫を持たない `incomingChildIds`）を分離し、`evaluateMergeGuard` 準拠のクリーン人機0イベントハブ統合、中間サブコホート境界認識、部分0イベント親配下の非主人公組織枝 Tier-2 合成、および `P_group` 機械除外・構造由来 `soft` 分離上限・`upstream_connect_ms: 30000` を導入する。
  - **採用**。数理不変条件と全既存テスト契約を100%保持したまま4課題を解消できる。

## 4. 決定事項 (Decision Outcome)

1. **Gateway 上流接続タイムアウト引き上げと再試行初期待機調整**:
   - `gateway/config/llm-gateway.default.json` の `timeouts.upstream_connect_ms` を `10000` → `30000`（30秒）へ拡充し、`client.ts` の既定 `maxRetries = 3` を維持したまま既定 `retryBaseDelayMs` を `1200` → `1800ms` とする。
2. **分裂親に対する保守的Poset拡大の反鎖保護（`discoverConservativeParent` & `parseLaneConsolidationTSV`）**:
   - `parseLaneConsolidationTSV` において、3主体以上の `role_group` が外部に未統合アクティブ子孫を残す分裂親 $Y$ を含む場合は `poset_rollup -> Y` への強制書き換えを抑止し、仮想 `role_group` を維持する（2主体の擬似ロールアップ `Trap M8` は従来どおり正規化）。
   - `discoverConservativeParent(poset, parentId, parentName, memberIds, incomingChildIds)` において、極小共通祖先 $\text{MCA}(S)$ は `memberIds` 全体から算出し（$\forall a \in \text{MCA}(S),\; P \prec a$）、下位辺 $s \prec P$ はバケット外に未統合アクティブ子孫を持たない $s \in S_{\text{closed}}$ のみに張る。併せて `keptAncs` から他の仮想 `role_group` を除外する。
3. **クリーン人間-機械0イベント複合ハブの決定論フォールバック統合**:
   - 0イベント親 $H$ の全アクティブ子孫が非 `pinned`・非 `reporter`・非 `:loss :affected` の `{person, machine}` 2主体であり、かつ `evaluateMergeGuard(person, machine).allowed === true`（`!hasAutonomousConflict`）を満たす場合、`poset_fallback` で2主体バンドル候補を生成し `computeInclusionPenalty` でも $P_{\text{sub}} = 0$ とする。
4. **中間サブコホート境界認識・Tier-2 非主人公組織枝統合・および `C2` 評価校正**:
   - `hasUnmergeablePersonDescById` において、別の非アクティブ複数子孫サブコホート $M$（$p \prec M \prec A$ かつ $|\text{desc}(M)| < |\text{desc}(A)|$）で分離された主人公は親組織 $A$ 直下の他枝のロールアップを阻害しない。
   - Tier-1 最良列数が `targetK` を超過する場合、部分0イベント親 $H$ 配下の非主人公・非 `:loss` 組織枝ペアに対しても数理コストモデルに基づく Tier-2 `SYN_COHORT_*` 候補を生成する。
   - `computeInclusionPenalty` で `kind === 'machine'` を人間監督者非同質罰則 `P_group` から除外し、`isZeroActorShellInversion` を実体殻ロールアップ（`bucketId === targetAncId`）または他メンバー `:actor` 総数0の仮想グループに限定、さらに `VTASeparationConstraint.origin` により構造由来 `soft` 分離罰則にバケット上限 `0.28` を設ける。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `g5g1` のように LLM 統合候補取得がスキップされた場合でも、対立のない人間-機械複合ハブが確実に1レーンへ統合され、一方で `ADR-0033` のモード錯誤事例では2レーン分離が厳格維持される。
  - `ov94` の大規模航空事故において、`T1（タワー東）` と `周辺管制席・監視支援機能` の偽親子関係が根絶され、海保地上・本部3主体が「その他の関係者」を汚染せず専用レーンへ統合され、`C2` スコアの不当な崩壊が解消される。
- **トレードオフ・考慮事項**:
  - 既に起動中の `llm-gateway.exe` インスタンスが存在する場合は、`stop-all.bat` → `start-all.bat` の再起動により更新後の `upstream_connect_ms: 30000` が読み込まれる。
- **影響を受けるファイル・テスト**:
  - `gateway/config/llm-gateway.default.json`
  - `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/features/vta/utils/subjectPoset.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
