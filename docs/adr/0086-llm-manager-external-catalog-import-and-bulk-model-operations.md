# ADR-0086: LLMモデル管理における外部公開カタログ（OpenRouter等）一括取込・トークン隔離および一括削除ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-24
- **対象コンポーネント**: `src/shared/llm/gatewayUrl.ts`, `src/shared/llm/modelTypes.ts`, `src/shared/llm/modelRegistry.ts`, `src/tools/llm-manager/`
- **関連要件 / ADR**: ADR-0042, `COM-N01`

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. VTA-Editor 内のモデル選択モーダル（`ModelSelectorModal`）ではエンドポイントから最新の利用可能モデル一覧を取得・絞り込み選択できる一方、共通管理プラグイン **LLMモデル管理（`llm-manager`）** は `isValidLoopbackUrl()` によりローカル loopback / `/v1` 以外の URL を一律拒否していたため、OpenRouter 公式公開カタログ（`https://openrouter.ai/api/v1/models`）等から直接最新モデル一覧を取得できなかった。
2. 従来の `GatewayDiscoveryPanel` は先頭100件までの表示と1件単位の `推奨追加`（常時 `isRecommended: true, isPreset: true`）しか持たず、OpenRouter の数百件のモデルからプロバイダ別に絞り込んで複数選択・一括登録する手段や、初期設定に残っている陳腐化モデルを複数選択して一括削除する手段が欠如していた。
3. また、取得したモデル一覧が揮発性のコンポーネント state にのみ保持され、リロードで消失する点や、OpenRouter 直接取得時のモデルID（例: `google/gemini-2.5-pro`）と LLM-Gateway 経由利用時のモデルID（例: `openrouter/google/gemini-2.5-pro`）のプレフィックス差異を吸収する必要があった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **秘密情報の厳格な隔離（COM-N01・SSRF防止）**:
   - 推論・疎通確認（`fetchGatewayModels` / `pingGatewayModel`）の loopback 制約は維持しつつ、外部カタログ取得では**共有 `gatewayToken` を外部ホストへ一切送信しない**こと、および外部URLは公開 `https://` のみ許可（平文 HTTP・プライベートIP・URL内認証情報・クエリ文字列を拒否）すること。
2. **VTA / TPDD の推奨欄・プリセット欄を汚染しない初期値設計**:
   - 大量モデルを一括取込する際の初期フラグは `isRecommended: false, isPreset: false` を既定とし、カタログへ取り込んだ上で必要なモデルのみ推奨ONへ昇格できる運用を可能とすること。
3. **LLM-Gateway 互換の ID 正規化**:
   - OpenRouter 公式APIから直接取得したモデルIDに対し、既定で `openrouter/` プレフィックスを自動付与（二重付与防止・任意OFF可）できるようにすること。
4. **陳腐化モデルの一括削除とレジストリ不変条件の保護**:
   - 最低1件保持不変条件（`models.length >= 1`）を守りつつ、既定モデルが削除対象に含まれた場合は残存モデルへ自動フェイルオーバーし、壊れた参照を残さないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: 既存の `isValidLoopbackUrl()` と `fetchGatewayModels()` の制限を撤廃し、任意の外部 URL へそのまま `connection`（`gatewayToken` 含む）を送る。
  - 誤操作時に内部 Gateway Token が外部ドメインへ漏洩するリスクがあり、既存の loopback セキュリティ境界（ADR-0042 / COM-N01）を損なうため不採用。
- **選択肢B (採用)**: ローカル Gateway 接続関数（`isValidLoopbackUrl` / `fetchGatewayModels`）はそのまま維持し、トークン非参照・公開 `https://` 検証付きの外部カタログ取得関数（`validateCatalogFetchUrl` / `fetchExternalCatalogModels`）、専用の一括取込モーダル（`ModelImportModal`）、および共通レジストリの一括登録・一括削除 API を新設する。

---

## 4. 決定事項 (Decision Outcome)

1. **外部カタログURL検証とトークン隔離取得の分離**:
   - `src/shared/llm/gatewayUrl.ts` に `validateCatalogFetchUrl()` を追加し、`/v1`・loopback HTTP(S)・公開 `https://` のみを許可（平文 HTTP 外部ホスト・プライベートIP帯・認証情報・クエリ・フラグメントを拒否）。
   - `src/tools/llm-manager/services/gatewayModels.ts` に `fetchExternalCatalogModels()`（共有 `gatewayToken` を一切参照・送信しない設計）、`loadVtaDiscoveredModelsCache()`（`vta_discovered_models` 連携）、および `localStorage` 取得キャッシュ（`failureprism_llm_discovered_models_v1`）を実装。
2. **Gatewayプレフィックス正規化と一括レジストリ操作 API**:
   - `src/shared/llm/modelTypes.ts` に `normalizeImportedModelId()` を追加し、`openrouter/` 等のプレフィックス付与と二重付与抑止を実現。
   - `src/shared/llm/modelRegistry.ts` に単一トランザクションで動作する `upsertModelEntriesBulk()`（`conflictStrategy: 'skip' | 'overwrite'`）、`removeModelEntriesBulk()`（最低1件保護＋削除された共通/ツール別既定モデルの自動修復）、および `updateModelEntriesFlagsBulk()` を追加。
3. **一括取込モーダル（`ModelImportModal`）とカタログ一括削除 UI**:
   - `ModelImportModal.tsx` を新設し、取得元切替（OpenRouter公式 / LLM-Gateway / カスタムHTTPS / VTAキャッシュ）、プロバイダ別タブ・検索・未登録フィルタ、全件段階表示、複数選択、初期フラグ（既定: `推奨OFF` / `クイック切替OFF` / `openrouter/` 付与ON）による一括取込を提供。
   - `RecommendedCatalogPanel.tsx` にカード別選択チェックボックス、「既定モデル以外を選択」ワンクリック補助、一括削除ボタン、および推奨ON/OFF一括切替バーを追加。`DefaultModelsPanel.tsx` の選択肢も推奨有無で `<optgroup>` 分類化。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - LLM-Gateway 未起動時や allowlist 調整前でも OpenRouter 公式カタログから最新モデル一覧を安全に検索・一括取込できる。
  - 初期シード内の陳腐化したモデルを「既定モデル以外を選択 → 一括削除」の2クリックで安全に整理できる。
- **トレードオフ・考慮事項**:
  - 数百件のモデルを取り込んだ場合でも UI が重くならないよう、一覧描画は段階的ページング（100〜120件単位＋全件表示）を採用している。
- **影響ファイル**:
  - `src/shared/llm/gatewayUrl.ts`, `src/shared/llm/modelTypes.ts`, `src/shared/llm/modelRegistry.ts`
  - `src/tools/llm-manager/services/gatewayModels.ts`, `src/tools/llm-manager/App.tsx`, `src/tools/llm-manager/manifest.tsx`
  - `src/tools/llm-manager/components/ModelImportModal.tsx`, `src/tools/llm-manager/components/RecommendedCatalogPanel.tsx`, `src/tools/llm-manager/components/GatewayDiscoveryPanel.tsx`, `src/tools/llm-manager/components/DefaultModelsPanel.tsx`
  - `tests/shared/llm/modelRegistry.test.ts`, `tests/llm-manager/llmManagerPlugin.test.tsx`
