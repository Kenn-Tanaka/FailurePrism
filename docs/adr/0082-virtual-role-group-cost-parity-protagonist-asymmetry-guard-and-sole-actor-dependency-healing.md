# ADR-0082: 仮想ロールグループの列削減単位コスト等価化・非同質グループ構造罰金・および単独能動行為者 `dependency` の自己治癒ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-24
- **対象コンポーネント**: VTA Consolidation Engine (`laneConsolidationOptimizer`) / Ledger Validation (`eventLedger`) / Normalization Prompt (`eventPrompts`, `public/prompts.json`)
- **関連ドキュメント・コミット**: [ADR-0076](./0076-prompt-deduplication-contract-alignment-and-safe-ledger-relation-healing.md), [ADR-0079](./0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md), [ADR-0080](./0080-inclusion-penalty-function-others-eligibility-gate-and-cascade-outcome-scope.md)

## 1. コンテキストと課題 (Context & Problem Statement)

鉄道触車事故等の階層・役割が交錯する事例の診断トレース（`extract_full_1795493467607_9yqp`）において、以下の 2 つの構造・効率上の課題が確認された。

1. **指揮・監督主役と被指示作業員群の不適切な `role_group` 統合による主語ねじれ**:
   - 全主体中で最重要スコア（`0.9963`、関与14件・変動8件・単独の指示/受領イベント8件）を持つ現場監督主体（`G現場代理人`）と、その指示に従って作業し共に被災した作業員群（`H・I・J作業員`、関与6件・単独0件）に対し、LLM が被災結果の共有を理由に `role_group`（`触車被災者群（現場代理人・H・I・J）`, `cost = 0.38`）を提案し、山登り法がこれを採択してしまった。
   - その結果、単独の指示・権限委譲受領・接近警報受領イベントの主語がすべて「被災者群」に置き換わる意味歪みが発生した。
   - 発生メカニズムは 2 つあった：
     1. **凸コスト関数のイェンセンの不等式による過小評価**: 新規仮想グループ（`isVirtualGroup`）へ $k$ 主体を統合しても削減列数は $r = \max(1, k - 1)$ 列（$k=2$ なら 1 列のみ）であるにもかかわらず、移動コストを $c / k$ に分割してから凸関数 $\phi(x) = 0.35x + 0.95x^2$ に入力していたため、2乗項が圧縮され、単体 `poset_rollup`（`cost = 0.34`, $\phi(0.34) = 0.2288$）よりも 2 主体 `role_group`（`cost = 0.38`, $2\phi(0.19) = 0.2016$）の方が低負荷と逆転判定された。
     2. **非同質仮想グループへの構造罰金の不在**: ADR-0080 の `computeInclusionPenalty` は Poset の上下包含関係（`poset.isAncestor`）のみを検査していたため、Poset 上は兄弟関係にある監督者と作業員の合成グループに対して構造罰金が `0` となっていた。
2. **同一主体の `dependency` 出力による追加 LLM 修復ラウンドトリップ**:
   - 正規化プロンプトのアンカリング手順ステップ 4 の文言が「各イベントに割当済みの主体IDを端点として同一・異主体間の関係（`before/.../dependency`）を構成する」と読める表現になっており、同一主体の連続行動に `dependency` が出力される誘因となっていた。
   - さらに ADR-0076 の `dependency` → `before` 自己治癒が「両イベントとも関与1主体のみ」に限定されていたため、相手側が受動ロール（`target` / `affected`）のみで唯一の能動行為者（`actor`）が両端同一主体である明白な直列行動（`R22`, `R26`）まで LLM 再取得の対象となっていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **列削減単位あたりの凸コスト整合性**: 1 列削減をもたらす `role_group`（$k=2$）と 1 列削減をもたらす単体 `poset_rollup`（$k=1$）は、同じ申告コスト $c$ に対して厳密に同一の凸負荷 $\phi(c)$ を持たなければならない。
- **正当な並列ロール統合の保全**: 同行動メンバー（`B機客室乗務員 + B機乗客`）や同格・中規模の別持ち場担当（`C・D中継見張員` 等）の `role_group` は阻害せず、高焦点主役の単独判断・指揮連鎖が混同される非同質グループのみを分野非依存で抑止する。
- **異主体修復機会の維持**: 対等な複数被災者（ADR-0076 `R37`）や複数能動 `:actor` が同席する共有イベント（`R19`）では異主体依存への修復可能性を残し、唯一の能動 `:actor` が共通するケースのみを決定論的に自己治癒する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1**: `role_group` のメンバーあたりコストを単純に $c / \max(1, k - 1)$ とする。
  - *却下理由*: $k$ 個のメンバーすべてが移動元として加算されるため、$k=2$ のときに合計負荷が $2\phi(c)$ と2倍過大計上され、低コストの正当な `role_group` まで不利になる。
- **選択肢 2（採用）**: 閉形式逆関数 $\phi^{-1}$ により仮想グループ全体の合計凸負荷を $r \cdot \phi(c / r)$（$r = \max(1, k - 1)$）に厳密一致させたうえ、単独能動・変動イベント数と活動量非対称に基づく非同質グループ罰金 $P_{\text{group}}$ を下限エンベロープに組み込む。併せてプロンプト明確化と単独 `:actor` 自己治癒を導入する。

## 4. 決定事項 (Decision Outcome)

1. **仮想グループ（`isVirtualGroup`）の列削減単位コスト等価化**:
   - $\phi(x) = 0.35x + 0.95x^2$ の逆関数 $\phi^{-1}(y) = \frac{-0.35 + \sqrt{0.35^2 + 3.8y}}{1.9}$ を定義し、$k$ 主体の仮想グループ化（削減列数 $r = \max(1, k - 1)$）における各メンバーの基準移動コストを $s = \phi^{-1}\!\left(\frac{r}{k}\phi\!\left(\frac{c}{r}\right)\right)$ とする（$\sum_{i=1}^k \phi(s) = r \cdot \phi(c / r)$ を保証）。
2. **非同質仮想グループ構造罰金 $P_{\text{group}}(X \to G)$ とプロンプト規律**:
   - Poset 上下関係のない `isVirtualGroup` バケット $G$（$|M| \ge 2$）において、メンバー $X$ の他メンバー不在の単独関与イベント数 $n_{\text{solo}}$ および単独能動/変動イベント数 $n_{\text{soloActVar}}$ を算出し、`focus === 'reporter'`、または `(focus === 'high' && n_solo >= 4 && n_soloActVar >= 3)`、または `(n_solo >= 5 && n_soloActVar >= 3 && |E(X)| >= 2.5 * max(1, n_min))` を満たす場合にサリエンス・単独比率・規模非対称に応じた下限罰金（最大 `0.90`）を課す。併せて Poset 上位吸収側の $P_{\text{sub}}(X \to Y)$ でも高焦点の一次損失被災主体（`focus === 'high'` かつ `:loss` `:affected` の非機械主体）に下限 `0.68` を保証し、最終投影検証候補枠を上位 12 状態へ拡大する。
   - `LANE_CONSOLIDATION_SYSTEM_PROMPT` の `role_group` に、被災結果の共有のみを理由に単独の指揮・指示・判断イベントを多数持つ監督主体と被指示メンバーを束ねることを禁じる規律を明記する。
3. **正規化アンカリング手順の明確化（`event-ledger-18`）と単独 `:actor` 自己治癒**:
   - `EXTRACTION_ANCHORING_POLICY` ステップ 4 で、同一主体の前後関係は必ず両端 `-` の `before` とし、`dependency` は異なる主体 ID ペアに限ることを明記し、`public/prompts.json` と同期する。
   - `eventLedger.ts` のケース C を拡張し、両端イベントの唯一の `:actor` が当該同一主体であり、同席する他主体がすべて受動ロール（`target` / `affected` / `intended_recipient`）のみである場合も決定論的に `before` へ自己治癒する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 現場監督・責任者（`G現場代理人` 等）と被指示作業員群が不当に 1 レーンへ混同されなくなり、指揮・伝達・被災の因果構造が正確に保持される。
  - 同一主体の連続行動に対する `dependency` 誤出力が減少し、万一出力されても受動対象同席ケース（`R22`, `R26` 型）が 0 トークンで即時 `before` に自己治癒される。
- **トレードオフ・考慮事項**:
  - 複数の能動 `:actor` が同席する共有イベント間の同一主体 `dependency`（`R19` 型）は異主体依存への修復余地を残すため従来通り検証エラーとするが、プロンプト側のステップ 4 明確化により初回発生自体を抑止する。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `src/tools/vta/services/llm/prompts.test.ts`
  - `public/prompts.json`
