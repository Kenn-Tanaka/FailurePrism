# Third-Party Notices (FailurePrism)

本ソフトウェア **FailurePrism**（TPDD-Editor / VTA-Editor / LLM-Gateway 統合パッケージ、`Copyright (c) 2026 HAIA Project`、MIT License。ルートの `LICENSE` 参照）は、以下のサードパーティ製オープンソースソフトウェアを利用・同梱しています。

サードパーティ製ソフトウェアのライセンス全文は、ルート直下の **`THIRD_PARTY_LICENSES/`**（配布パッケージ内にも同梱）に収録されています。

---

## 1. フロントエンド (`TPDD-Editor` / `VTA-Editor` / 統合シェル)

Web フロントエンド（`dist/`）にバンドルされる主なオープンソースパッケージおよびライセンス全文ファイル（`THIRD_PARTY_LICENSES/frontend/`）は以下の通りです。

| パッケージ名称 | ライセンス | 全文ファイル (`THIRD_PARTY_LICENSES/frontend/`) | 用途 |
|---|---|---|---|
| `react`, `react-dom` | MIT | `react-LICENSE`, `react-dom-LICENSE` | UI フレームワーク |
| `@xyflow/react` (`@xyflow/system`) | MIT | `xyflow-react-LICENSE`, `xyflow-system-LICENSE` | VTA グラフキャンバス描画 |
| `lucide-react` | ISC | `lucide-react-LICENSE` | アイコンコンポーネント |
| `zustand` | MIT | `zustand-LICENSE` | VTA 状態管理 |
| `zod` | MIT | `zod-LICENSE` | TPDD スキーマ検証 |
| `react-markdown` | MIT | `react-markdown-license` | Markdown レンダリング |
| `clsx`, `tailwind-merge` | MIT | `clsx-license`, `tailwind-merge-LICENSE.md` | CSS クラスユーティリティ |
| `tailwindcss` | MIT | `tailwindcss-LICENSE` | スタイリングフレームワーク |
| `pdfjs-dist` | Apache-2.0 | `pdfjs-dist-LICENSE` | PDF 文書テキスト抽出 |
| `mammoth` | BSD-2-Clause | `mammoth-LICENSE` | Word (`.docx`) 文書テキスト抽出 |
| `xlsx` (SheetJS CE) | Apache-2.0 | `xlsx-LICENSE` | Excel (`.xlsx`) スプレッドシート読み込み |

---

## 2. LLM-Gateway v2.0.0 (`gateway/llm-gateway.exe` / `gateway/MaintenanceTool.exe`)

C++ バイナリに静的リンクされているサードパーティライブラリのライセンス一覧です。各ライセンス全文は `THIRD_PARTY_LICENSES/gateway/`（および `gateway/THIRD_PARTY_LICENSES/`）に収録されています（詳細は `gateway/NOTICE.md` も参照してください）。

| 名称 | 版 | ライセンス | 全文ファイル (`THIRD_PARTY_LICENSES/gateway/`) |
|---|---|---|---|
| nlohmann/json | 3.11.3 | MIT | `nlohmann_json-LICENSE.MIT` |
| cpp-httplib | 0.18.3 | MIT | `httplib-LICENSE` |
| libcurl | 8.10.1 | curl license（MIT/X 系） | `curl-COPYING` |
| llama.cpp（ggml 含む） | b4200 | MIT | `llama-LICENSE` |
| wxWidgets | 3.2.6 | wxWindows Library Licence 3.1（バイナリ配布は独自条件で可） | `wxwidgets-licence.txt` |
| 〃 内蔵 libpng | wxWidgets 同梱 | libpng License | `wxwidgets-libpng-LICENSE` |
| 〃 内蔵 zlib | wxWidgets 同梱 | zlib License | `wxwidgets-zlib-LICENSE` |
| 〃 内蔵 PCRE | wxWidgets 同梱 | BSD（PCRE LICENCE） | `wxwidgets-pcre-LICENCE` |

