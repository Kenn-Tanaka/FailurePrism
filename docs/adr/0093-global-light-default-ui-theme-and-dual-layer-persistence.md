# ADR-0093: アプリ全体テーマ切替（ライト既定）と2層永続化（`localStorage` ＋ `.runtime/ui-preferences.json`）ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: Global CSS & Theme Store (`src/index.css`, `src/shared/theme/themeStore.ts`, `index.html`) / Shell (`TopTabBar.tsx`, `LauncherMenu.tsx`, `FailurePrismApp.tsx`) / VTA & TPDD Diagram Canvases / Local Server (`scripts/server.mjs`, `vite.config.ts`)
- **関連ドキュメント・コミット**: [ADR-0073](./0073-vta-ui-decluttering-and-deterministic-progress-feedback.md), [ADR-0091](./0091-native-win32-launcher-executable-config-and-embedded-prism-icon.md)

## 1. コンテキストと課題 (Context & Problem Statement)

従来、FailurePrism の共通シェル（`TopTabBar`・`LauncherMenu`）、`VTA-Editor`、および `LLM管理` は黒系背景（`slate-950` / `slate-900`）に明るい文字・ラインを描画するダーク配色固定であった一方、`TPDD-Editor` および `HAIA`（ならびに VTA の SVG エクスポート出力）は白・淡色背景に濃色文字・ラインを描画する明色ベースで構成されていた。

実務上の視認性・投影・明所利用の要請から、以下の要件を満たすアプリ全体のテーマ切替機構が必要となった。
1. **白・淡色背景＋暗色文字・ライン（ライト表示）を既定（デフォルト）**とし、ダーク表示とワンクリックで切り替えられること。
2. 変更したテーマ設定が**次回起動時にも確実に復元**されること（`FailurePrism.exe` / `start-all.bat` での再起動、ポート変更、`--select-browser` による使用ブラウザ変更、別タブ起動を含む）。
3. 混在していたダーク基準コンポーネント群とライト基準コンポーネント群の双方で、白文字ボタン（`bg-*-600 text-white`）の視認性や図面エッジのコントラストを損なわないこと。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **初回描画時のフラッシュ（FOUC）ゼロ**: 起動直後に一瞬暗い画面や白い画面がちらつかないよう、モジュール読込前に同期適用されること。
- **ブラウザ・オリジン横断の永続性**: `localStorage` はブラウザおよびポート（オリジン）単位で分離されるため、`FailurePrism.exe --web-port` や `--select-browser` 利用時でも設定を引き継げるサーバー側ファイル永続化を併用すること。
- **ランチャー設定ファイルとの非干渉・Vite 監視ループ回避**: `FailurePrism.exe` が管理する `failureprism.config.json` を上書き競合させず、かつ開発サーバーのファイル監視リロードを誘発しない `.runtime/ui-preferences.json` に分離保存すること。
- **図面視認性（WCAG コントラスト）**: VTA の時系列線・クロスレーン伝達線・双方向線・ブレイク線・接続点ドット・カード枠線が、明背景上で [svgExport.ts](../../src/tools/vta/features/vta/utils/svgExport.ts) と同等の高コントラスト濃色インクで描画されること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: VTA キャンバス領域のみを明色化し、周囲のパネル・メニューと `localStorage` のみで管理する**
  - 画面内で明暗が分断され、またブラウザ変更時やポート変更時に設定が引き継がれないため不採用。
- **選択肢2: Tailwind CSS v4 カラートークン再マッピング＋図面コンポーネント明暗パレット＋2層永続化（`localStorage` ＋ `/api/ui-preferences`）による全体テーマ切替（採用）**
  - ルートの `html[data-theme="light" | "dark"]` に連動して全ツール・モーダル・ポータルを統一し、`localStorage` による 0ms 同期復元と `.runtime/ui-preferences.json` によるブラウザ横断永続化を両立できる。

## 4. 決定事項 (Decision Outcome)

選択肢2を採用し、以下のアーキテクチャを実装する。

1. **既定テーマとゼロフラッシュ初期化（`index.html`, `src/shared/theme/themeStore.ts`）**:
   - 既定テーマを `'light'`（`DEFAULT_UI_THEME = 'light'`）とする。
   - `index.html` の `<head>` 内インラインスクリプトで `localStorage['failureprism_ui_theme']` を同期参照し、React マウント前に `document.documentElement.dataset.theme` および `color-scheme` を確定させる。
   - `window` の `storage` イベントを購読し、別タブで開いているツール間でもリアルタイムにテーマを同期する。
2. **2層永続化（`localStorage` ＋ `/api/ui-preferences`）**:
   - `scripts/server.mjs` および `vite.config.ts` に `GET / PUT /api/ui-preferences`（保存先: `.runtime/ui-preferences.json`）を追加する。
   - テーマ変更時は `localStorage` を即時更新すると同時に `PUT /api/ui-preferences` でディスクへ保存し、次回起動時は `FailurePrismApp` マウント時の `hydrateUIThemeFromServer()` によりポートやブラウザが変わっても前回のテーマを自動復元する。
3. **Tailwind CSS v4 スコープ別パレット制御（`src/index.css`）**:
   - ライト表示（`html:not([data-theme="dark"])`）では、`slate-50..950` および各アクセント色の淡色背景シェード（`950`–`800`）・文字シェード（`50`–`400`）を明背景用の白／淡スレート背景＋濃色インクトークンへ再マッピングし、中濃度の塗色（`500`–`700`）と `--color-white` は維持することで `bg-*-600 text-white` ボタンやポータルモーダルのコントラストを保つ。
   - 元々明色基準で実装されている `[data-tool-id="tpdd"]` および `[data-tool-id="haia"]` には、ライト表示時は標準パレットを維持し、ダーク表示（`html[data-theme="dark"]`）時にダークサーフェスへ適応させるスコープ規則を適用する。
4. **図面コンポーネントの高コントラスト明暗描画と UI トグル**:
   - `VTAEdge`・`VTANode`・`VTAJunctionNode`・`VTAObjectJunctionNode`・`SwimlaneBackground`・`StickyLaneHeaderBar`・`VTACanvas`（背景ドット・`MiniMap`）および TPDD の `Canvas`・`LevelsLayer`・`EdgeComponent` で `useUITheme()` を参照し、ライト表示時は濃色ライン（時系列 `#334155`、一方向 `#0284c7`、双方向 `#7c3aed`、遮断 `#e11d48`）と白基調カードで描画する。
   - 上部共通バー（`TopTabBar`）右端および VTA キャンバスの「表示設定」ポップオーバーの双方にテーマ切替コントロールを配置する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 初回起動時から白・淡色背景＋暗色文字・ラインの見やすい画面で起動し、好みに応じてダーク表示へ切り替えれば次回起動時（ブラウザ変更・ポート変更時を含む）も選択した背景で起動する。
  - 画面上の VTA 図面表示と SVG エクスポート出力の色彩トーンが一致し、編集時と出力時のギャップが解消される。
- **トレードオフ・考慮事項**:
  - 新規コンポーネント追加時は、`slate` 背景上の見出し文字には `text-white` ではなく `text-slate-50` / `text-slate-100` を用い、`text-white` は `bg-*-600` 等の濃い塗色ボタン上の白抜き文字に限定する規約を維持する。
- **影響を受けるファイル・テスト**:
  - `src/shared/theme/themeStore.ts`, `index.html`, `src/index.css`
  - `scripts/server.mjs`, `vite.config.ts`
  - `src/shell/FailurePrismApp.tsx`, `src/shell/TopTabBar.tsx`, `src/shell/LauncherMenu.tsx`
  - `src/tools/vta/features/vta/components/{VTACanvas,SwimlaneBackground,StickyLaneHeaderBar,VTANode,VTAEdge,VTAJunctionNode,VTAObjectJunctionNode}.tsx`
  - `src/tools/tpdd/features/editor/{Canvas,LevelsLayer,EdgeComponent}.tsx`
  - `tests/shell/uiTheme.test.tsx`
