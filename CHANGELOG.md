# Changelog

All notable changes to **FailurePrism** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-10-18

### Added
- **Unified FailurePrism Workbench**:
  - Integrated **TPDD-Editor** (思考展開図エディタ / Thinking Process Deployment Diagram Editor), **VTA-Editor** (バリエーションツリー分析エディタ / Variation Tree Analysis Editor), and full-featured **LLM-Gateway v2.0.0** (`llm-gateway.exe` + `MaintenanceTool.exe`) into a single local workbench package.
  - Added startup Launcher Menu (`#menu`) and persistent global Top Tab Bar with live tool status badges (node counts, unsaved changes indicator, AI generation busy state, and open-in-new-tab buttons).
  - Implemented Keep-Alive DOM mounting so switching between Menu, TPDD-Editor, and VTA-Editor preserves canvas viewport, undo/redo history, and active SSE streaming sessions.
- **Auto-Plugin (File-Based Discovery) Architecture**:
  - Implemented automatic plugin discovery (`src/shell/toolLoader.ts`) via `import.meta.glob('../tools/*/manifest.tsx')`.
  - Documented the plugin specification and developer guide in `docs/PLUGIN_ARCHITECTURE.md`.
  - Configured automatic per-tool and vendor chunk splitting in `vite.config.ts`.
- **Full LLM-Gateway v2.0.0 Integration**:
  - Bundled `llm-gateway.exe` v2.0.0 (supporting OpenRouter, LM Studio, Ollama, SSE streaming, and embedded GGUF `/v1/embeddings` & `/v1/rerank`) and `MaintenanceTool.exe` (Windows Credential Manager GUI).
  - Added local Node.js reverse proxy server (`scripts/server.mjs`) forwarding `/v1/*` and `/health` to `127.0.0.1:8765` with strict path traversal protection.
  - Implemented in-memory Gateway Token synchronization across all mounted tools without persisting tokens to browser storage.
- **Packaging, Licensing & Documentation**:
  - Added unified build and packaging pipeline (`build.bat` / `scripts/build-package.ps1`) generating `FailurePrism_Release_v1.0.0.zip` and `SHA256SUMS.txt`.
  - Added root `LICENSE` (`Copyright (c) 2026 HAIA Project`, MIT License), `NOTICE.md`, and complete `THIRD_PARTY_LICENSES/` for both frontend and C++ gateway dependencies.
