# ADR-0061: 長時間 AI 処理の結果採否ポリシー（内容指紋による編集検知と確認ダイアログ）

- **Status**: `Accepted`
- **Date**: 2026-11-20
- **Target Components**: `VTA Store (autoConnectNodes / reoptimizeVTA)`, `ScenarioInputSection (handleClassify / handleExtractVTA)`
- **Related Requirements / ADRs**: [ADR-0028](./0028-progress-overlay-non-blurring-and-live-log-visibility.md), [ADR-0047](./0047-reoptimize-layout-monotonicity-and-vertical-stub-exemption.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

進捗オーバーレイはキャンバスを覆わないため（ADR-0028）、ユーザーは AI 処理の実行中でも図を編集できる。一方で、処理ごとに「実行中に図が変わったか」の扱いが揃っていなかった。

- **`autoConnectNodes` / `reoptimizeVTA`**：プロジェクトとリクエストIDしか確認していなかった。そのため、実行中に行った編集や Ctrl+Z が、結果のコミットで**黙って上書き**されていた。
- **`handleClassify`**：`vtaData` の参照（オブジェクトが同じか）で比較していた。しかし DOM 計測による衝突補正だけでも `vtaData` が新しいオブジェクトに置き換わり、しかも `isDirty` も立っていた。そのため、編集していないのに結果が**黙って破棄**されることがあった。
- **`handleExtractVTA`**：抽出中も本文欄を編集でき、ファイル解析中でも抽出を開始できた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- 数分かかる LLM 処理の結果を、誤った判定で捨てない。
- ユーザーの編集を、黙って上書きしない。
- 修正範囲を小さくする。`vtaData` を書き込む箇所（約15か所）すべてに手を入れることは避ける。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1：`vtaData` の参照で比較する**
  - 計測による補正でも「変わった」と判定され、結果を誤って捨てる。
- **選択肢2：ユーザー操作の箇所でだけ増える revision カウンタを追加する**
  - 正確だが、すべての書き込み箇所で増やし忘れないよう維持する必要がある。
- **選択肢3：座標を除いた内容の指紋（`computeVTADataHash`）で比較する（採用）**
  - 既存のレポート鮮度判定と同じ定義を使い回せる。計測による補正やドラッグは「変更なし」として扱われる。

## 4. 決定事項 (Decision Outcome)

1. **`staleResultGuard.ts`**
   - `vtaContentFingerprint`（座標を除いた意味的ハッシュ）と `resolveStaleResult` を新設する。
   - 指紋が一致すれば、そのまま適用する。
   - 不一致の場合は `confirm` で「結果を適用する（実行中の編集は Ctrl+Z で戻せる）／結果を破棄する」を選んでもらう。
   - 破棄した場合は、警告ログとトーストで通知する。
2. **`autoConnectNodes` / `reoptimizeVTA` / `handleClassify`**：いずれもこのガードで判定する。また、粒度反復の一度きりの指示は、結果を採用した後にだけ消費する（`extractEventDraft` も同様）。
3. **`handleClassify`**：実行中に本文が変更された場合は、通知した上で結果を破棄する。
4. **DOM 計測による衝突補正**（`onNodesChange` の寸法変更経路）：`isDirty` を立てない。
5. **抽出中の入力**：抽出中は本文欄を readOnly にする。ファイル解析中は抽出ボタンを無効にする。

## 5. 結果と影響 (Consequences)

### メリット
- 実行中の編集が黙って失われることも、結果が誤って破棄されることもなくなり、どちらの場合もユーザーが選べるようになる。
- 読み込み直後なのに「未保存」と表示される誤判定がなくなる。

### トレードオフ・考慮事項
- 座標だけの変更（ドラッグ）は、AI の結果を適用すると上書きされる。これは従来どおりの挙動であり、Ctrl+Z で戻せる。
- `confirm` はブロッキングなダイアログである。将来カスタムモーダルへ置き換えられるよう、`resolveStaleResult` は確認関数を引数で差し替えられる設計にしている。

### 影響ファイル
- [src/tools/vta/features/vta/utils/staleResultGuard.ts](../../src/tools/vta/features/vta/utils/staleResultGuard.ts)（新規）
- [src/tools/vta/features/vta/store/vtaStore.ts](../../src/tools/vta/features/vta/store/vtaStore.ts)
- [src/tools/vta/components/control-panel/ScenarioInputSection.tsx](../../src/tools/vta/components/control-panel/ScenarioInputSection.tsx)
- [src/tools/vta/services/llm/client.ts](../../src/tools/vta/services/llm/client.ts)
- [tests/vta/staleResultAndUndoIntegrity.test.ts](../../tests/vta/staleResultAndUndoIntegrity.test.ts)（新規）
- [docs/adr/README.md](./README.md)
