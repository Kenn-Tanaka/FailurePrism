# ADR-0027: 関係IDの自動重複解消・プロンプト一意化とSSEストリーム進捗可視化・誤謬リトライ警告是正

- **ステータス**: Accepted
- **決定日**: 2026-11-09
- **対象コンポーネント**: VTA Ledger Engine (`eventLedger.ts`, `relationContract.ts`), LLM Client (`client.ts`), Prompts (`eventPrompts.ts`, `public/prompts.json`), Tests (`ledgerValidation.test.ts`)
- **関連要件 / ADR**: [ADR-0015](file:///docs/adr/0015-llm-streaming-retry-and-prompt-architecture.md), [ADR-0024](file:///docs/adr/0024-ledger-parser-resilience-and-parse-error-diagnostics.md)

## 1. コンテキストと課題 (Context & Problem Statement)

Tailscale 経由でリモート PC 上のローカル LLM（LM Studio / `gemma-4-26b-a4b-it-qat@q4_k_xl`）に接続して「鹿沼駅事故.md」（6,990文字 / 16,880文字プロンプト）の全文正規化解析を実行した際、次の2つの重大な運用課題が発生した：

1. **関係ID重複による 4,215文字（約3,000トークン）出力の全体破棄**:
   - LM Studio 側で 102.5秒（29.23 tokens/s）かけて 2,998 トークンが正常に完走・ストリーミング受信完了したにもかかわらず、直後の `parseLedger` で次の致命的エラーが発生し、抽出結果が全破棄された：
     ```
     [抽出失敗] 台帳のID 関係/R_dep が重複しています。
     ```
   - 原因は、プロンプト契約 `【関係属性契約 relation-attributes-2】` の記入例が `R_before` および `R_dep` となっていたため、Gemma モデルがすべての `dependency` 関係行の第1列に同一ID `R_dep` を出力したことにある。
   - `[関係]` のIDは外部キーとして他セクションから一切参照されないエッジ識別子であるにもかかわらず、`parseLedger` が参照整合性エンティティ（主体・イベント）と同様に厳格な重複例外を投げ、正常な抽出結果全体を台無しにしていた。
2. **SSEストリーム受信中の進捗不可視と「一時的な通信エラー (HTTP 200)」という誤謬警告**:
   - `client.ts` の `for await (const chunk of parseSseStream(...))` 中に進捗ログが一切出ず、5分近く「レスポンスストリーム読み込み中...」のまま画面が静止し、推論進行中かフリーズかの判別がつかずユーザーが手動キャンセルせざるを得なかった。
   - また、途中でネットワークやトンネルが切断されてリトライに入った際、`lastHttpStatus` が 200（ヘッダー受信時のステータス）であったために三項演算子が `HTTP 200` を理由文字列として選択し、「一時的な通信エラー (HTTP 200)」という極めて誤認を招く警告ログを出力していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **抽出データの最大保全**: 数分間・数千トークンのLLM生成成果を、非参照セクション（関係）の単なるID被りという軽微な形式上の問題で全破棄しない。
- **事実性と参照整合性の厳守**: 他から参照される `主体` や `イベント` のIDは勝手に自動採番せず、厳格な重複チェックを維持する。
- **通信・推論の可観測性（Observability）**: ローカル・リモートLLMの長大ストリーミング中も生存確認・進捗（受信文字数・経過秒数・転送速度）がリアルタイムに把握でき、不用意なキャンセルを防ぐ。
- **診断ログの真実性**: HTTP 200 OK 受信後のストリーム切断時に「HTTP 200 がエラー」と誤認させず、真のエラー原因（ストリーム切断）を明瞭に表示する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: プロンプトの記入例修正のみ**
  - プロンプトを `R1`, `R2` に改訂しても、量子化の度合いやモデルの気まぐれで固定ID（`R_dep` や `rel_1`）を反復出力するリスクが残り、再び全破棄が発生する。
- **選択肢2: `parseLedger` で関係セクションの重複チェックを完全撤廃**
  - 重複IDのまま `VTASchema.relations` に格納されると、React Flow やグラフ描画レイヤーでキー重複警告や配線バグが発生する。
- **選択肢3: 非参照セクションへの `関係` 追加・自動採番解消 ＋ プロンプト一意化 ＋ ストリーム進捗ログ（採用）**
  - `NON_REFERENCED_ID_SECTIONS` に `'関係'` を追加。重複検出時は決定論的にサフィックス（`_2`, `_3`）を付与して一意化。プレースホルダ（`-`）の場合は `R_n` を自動採番。プロンプト例も一意ID指示に改定。さらにストリーム受信中の定期進捗ログとリトライ理由の正確化を同時適用。

## 4. 決定事項 (Decision Outcome)

1. **非参照セクションへの `関係` 追加と自動重複解消 (`eventLedger.ts`)**:
   - `NON_REFERENCED_ID_SECTIONS` に `'関係'` を追加（`['関係', '帰結', '共有カード', '整理', '表記', '表現']`）。
   - `parseLedger` において、`seenRows.has(`${section}/${cells[0]}`)` が真となった際、非参照セクションであれば `cells[0]` に `_2`, `_3`... を付与して決定論的に重複を自己治癒する。
   - `主体` および `イベント` は非参照セクションに含まれないため、これまで通り即座に重複エラーを投げて参照整合性を担保する。
2. **関係属性契約プロンプトの一意ID指示 (`relationContract.ts`, `public/prompts.json`)**:
   - `RELATION_CONTRACT_PROMPT` 内の記入例を `R_before` / `R_dep` から `R1` / `R2` へ変更。
   - 明示的な指示文 `関係ID列（第1列）は各行で一意なID（R1, R2, R3...）を付与すること（例のR1やR2をそのまま全行で使い回さないこと）` を追加。
3. **SSEストリーム受信中の定期進捗ログ (`client.ts`)**:
   - `parseSseStream` ループ内で 5秒経過かつ50文字以上進捗があるごとに、`[通信/ストリーム受信中] 累計 ${content.length}文字 (経過: ${elapsedSec}秒, 速度: 約${charsPerSec}字/秒)` をログ出力し、通信生存を可視化。
4. **リトライ理由フォーマットの正確化 (`client.ts`)**:
   - `lastHttpStatus >= 400` の場合のみ `HTTP ${lastHttpStatus}` を出力。
   - `lastHttpStatus === 200` でストリームが中断された場合は `ストリーム切断: ${err.message}` を出力し、誤解を招く「一時的な通信エラー (HTTP 200)」を撲滅。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - ローカル・リモートLLMが `R_dep` や `R_before` を重複出力しても、パーサー側で安全に `R_dep`, `R_dep_2` 等に一意化され、長時間の推論結果が確実に保持される。
  - ストリーミング受信中に受信文字数と速度がリアルタイムに可視化され、長時間推論時の心理的ハングアップ誤認が解消される。
  - リトライ警告が正確になり、通信障害の真の原因（ストリーム切断）が即座に把握できる。
- **トレードオフ・考慮事項**:
  - `関係` のIDが自動改変される場合があるが、他セクションから参照されないため下流パイプラインへの副作用は皆無である。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/features/vta/utils/relationContract.ts`
  - `src/tools/vta/services/llm/client.ts`
  - `public/prompts.json`
  - `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
