# ADR-0042: 共通LLMモデルレジストリ（配布シード連携）およびLLMモデル管理プラグインの導入

## メタデータ
- **ステータス**: Accepted
- **決定日**: 2026-11-18
- **対象コンポーネント**: `src/shared/llm/modelRegistry.ts`, `src/shared/llm/modelTypes.ts`, `src/shared/llm/defaultModels.ts`, `src/shared/llm/useLLMRegistry.ts`, `public/llm-models.json`, `src/tools/llm-manager/`, `src/tools/tpdd/`, `src/tools/vta/`, `src/main.tsx`
- **関連要件 / ADR**: ADR-0018, `docs/PLUGIN_ARCHITECTURE.md`, `docs/REQUIREMENTS.md`

---

## 1. コンテキストと課題 (Context & Problem Statement)

1. これまで **TPDD-Editor** と **VTA-Editor** は、新規利用時のデフォルト LLM（`openrouter/google/gemini-3.8-flash`）および推奨 LLM・クイック切替プリセット一覧を、それぞれのツール内部（`src/tools/tpdd/features/settings/modelCatalog.ts`, `src/tools/tpdd/domain/commands.ts`, `src/tools/vta/features/vta/data/modelCatalog.ts`, `src/tools/vta/features/vta/store/vtaStore.ts`）にハードコードで重複管理していた。
2. 利用環境や用途の変化に応じて「標準で使用するデフォルト LLM」や「推奨・プリセットとして提示するモデル群」を GUI から一元管理したいニーズがあり、さらに配布パッケージ単位で管理者・配布者が初期カタログを変更できる配布時シードファイル（`public/llm-models.json`）も求められた。
3. 一方で、FailurePrism のオートプラグイン規約（`docs/PLUGIN_ARCHITECTURE.md`）に基づき、管理ツール自体も `src/tools/<tool-id>/manifest.tsx` による独立プラグインとして実装しつつ、管理プラグインが存在しない構成でも TPDD・VTA 単体が安全に動作し続ける疎結合設計が必要であった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

1. **プラグイン間疎結合とオートプラグイン規約遵守**:
   - TPDD・VTA が新設プラグイン `src/tools/llm-manager/` を直接 `import` しないこと。共通コントラクト・永続化・既定フォールバックを `src/shared/llm/` に集約すること。
2. **共通デフォルト＋ツール別オーバーライド（2階層）**:
   - 全ツール共通の `defaultModelId` を基本としつつ、ツール別（`tpdd`, `vta` 等）に任意で個別の上書き `toolDefaultModelIds` を持てること。
3. **既存作業・保存済みプロジェクトの非破壊原則**:
   - デフォルト LLM の変更は「TPDD の新規プロジェクト作成時」および「VTA の次回起動・初期化時」に適用し、現在開いている編集セッションや保存済みプロジェクトファイル（`.tpdd.json`, VTA `.json`）のモデル指定は自動的に上書きしないこと。
4. **配布時シードファイル（`public/llm-models.json`）とユーザー設定の階層化**:
   - 組み込み定数（`BUILTIN_LLM_SEED`）→ 配布シード（`public/llm-models.json`）→ ブラウザ内ユーザー編集（`localStorage`）の優先順位とし、Zod スキーマ検証により不正ファイル時は安全にフォールバックすること。
5. **秘密情報の分離（COM-N01）**:
   - Gateway Token はメモリ内共有のみとし、`localStorage` およびエクスポート JSON に一切保存しないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: `src/tools/llm-manager/` 内にストアを持ち、TPDD / VTA から直接インポートする。
  - プラグイン削除時に TPDD / VTA のビルドが破損し、OCP・プラグイン独立性に反するため不採用。
- **選択肢B (採用)**: `src/shared/llm/` に共通レジストリ（`modelRegistry.ts`, `useLLMRegistry.ts`）と組み込みフォールバック（`defaultModels.ts`）を配置し、`src/tools/llm-manager/` を独立管理プラグインとして追加する。
  - TPDD・VTA は `src/shared/llm/` のみを参照するためプラグイン単体の着脱安全性を保ちつつ、推奨カタログ・プリセット・デフォルト設定のリアルタイム同期を実現できる。
- **初期起動時のシード読込方式**:
  - `src/main.tsx` で `FailurePrismApp` 動的インポート前にタイムアウト付き（500ms）で `preloadLLMModelSeed()` を実行し、`vtaStore` や `TPDD AppProvider` の同期初期化時点から `public/llm-models.json` の内容を参照可能とする（直接コンポーネントをマウントするテストや単体利用時は `FailurePrismApp` / `LLMManagerApp` 内の `loadLLMModelSeed()` が補完）。

---

## 4. 決定事項 (Decision Outcome)

1. **`src/shared/llm/` への共通モデルレジストリ新設**:
   - `modelTypes.ts` でモデル ID 検証（`validateModelId`）、モデル分類（`classifyModel`）、Zod スキーマ（`ManagedModelEntrySchema`, `LLMModelsSeedSchema`, `ManagedLLMRegistryStateSchema`）を共通定義。
   - `defaultModels.ts` と `public/llm-models.json` に統合カタログを定義し、自動テストで両者の同期を検証。
   - `modelRegistry.ts` で `localStorage`（`failureprism_llm_registry_v1`）・`public/llm-models.json`・`BUILTIN_LLM_SEED` の 3 層解決、クロスタブ `storage` イベント同期、JSON 入出力、初期リセットを提供。
   - `useLLMRegistry.ts` で React 18 `useSyncExternalStore` による参照安定なリアクティブ購読を提供。
2. **新規プラグイン `src/tools/llm-manager/` の追加**:
   - `manifest.tsx`（`id: 'llm-manager'`, `order: 30`, `theme: { color: 'emerald' }`）により自動ディスカバリへ統合。
   - 共通＆ツール別デフォルト設定、推奨・クイック切替カタログの CRUD／並替、`/v1/models` からの自動取込、Ping 疎通テスト、シード再読込／リセット／JSON I/O を提供。
3. **TPDD / VTA の接続**:
   - TPDD は `createNewProject()` の初期モデルを `getDefaultModelId('tpdd')` へ変更し、`DiagramTree`・`ModelExploreModal`・`AiPanel` が共通カタログを購読。
   - VTA は `vtaStore` の初期 `selectedModel` を `getDefaultModelId('vta')` へ変更し、`LLMConfigSection`・`ModelSelectorModal` が共通カタログを購読。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - TPDD・VTA のデフォルト LLM（共通／ツール別）と推奨モデル一覧をブラウザ上の GUI または配布時 `llm-models.json` から統一的に運用できる。
  - 重複していたモデル ID 検証・プロバイダ分類ロジックが `src/shared/llm/` に統合された。
- **トレードオフ・考慮事項**:
  - ユーザー編集値はブラウザ単位の `localStorage` に保存されるため、端末・ブラウザ間で共有する場合は JSON エクスポート／インポートまたは配布シード `public/llm-models.json` の更新を使用する。
  - `src/main.tsx` で 500ms 上限の非ブロッキングに近いシードプリロードを行うため、極端に遅延する環境では初回描画後（フォールバック状態）に `public/llm-models.json` が遅延反映される場合がある。
- **影響を受けるファイル・テスト**:
  - `public/llm-models.json`, `src/main.tsx`, `src/shell/FailurePrismApp.tsx`
  - `src/shared/llm/gatewayUrl.ts`, `src/shared/llm/modelTypes.ts`, `src/shared/llm/defaultModels.ts`, `src/shared/llm/modelRegistry.ts`, `src/shared/llm/useLLMRegistry.ts`
  - `src/tools/llm-manager/*`
  - `src/tools/tpdd/domain/commands.ts`, `src/tools/tpdd/features/settings/*`, `src/tools/tpdd/features/editor/DiagramTree.tsx`, `src/tools/tpdd/features/ai/AiPanel.tsx`, `src/tools/tpdd/services/persistence/appStorage.ts`
  - `src/tools/vta/features/vta/store/vtaStore.ts`, `src/tools/vta/features/vta/data/modelCatalog.ts`, `src/tools/vta/components/control-panel/LLMConfigSection.tsx`, `src/tools/vta/components/ModelSelectorModal.tsx`
  - `tests/shared/llm/modelRegistry.test.ts`, `tests/llm-manager/llmManagerPlugin.test.tsx`, `tests/shell/toolLoader.test.ts`
