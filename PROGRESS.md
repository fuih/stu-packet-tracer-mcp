# PROGRESS: stu-packet-tracer-mcp

## Current phase: 2 (Completed) -> Phase 3 (Starting)

## Checklist
- [x] P0 Bootstrap (Clone, rename, upstream attribution, baseline test suite)
- [x] P1 English + CI (Translation of all Spanish strings, check:english script, GitHub Actions CI)
- [x] P2 Bridge v1 (Correlation IDs, long-poll /v1/next, origin check, drop late results)
- [ ] P3 CLI engine (Pagination --More--, eaten char fix, prompt/mode tracking)
- [ ] P4 Tool layer (Strict schemas, did-you-mean device resolver, clean docs)
- [ ] P5 Extension (English extension source in repo, docs/BUILD_EXTENSION.md)
- [ ] P6 CLI screenshots (Terminal SVG renderer, DejaVu Sans Mono, resvg-wasm PNG)
- [ ] P7 Student features (Addressing table, ping matrix with ARP warm-up, lab checker, explain output, teach mode)
- [ ] P8 Report export (pt_export_report -> MD, HTML, DOCX)
- [ ] P9 Docs & release prep (README, QUICKSTART, CLIENTS, TROUBLESHOOTING, release workflow)

## Log
### 2026-11-17 Phase 2 Bridge v1 (Fixes F1 & F2)
- Created `src/bridge/protocol.ts` defining `CommandEnvelope`, `ResultEnvelope`, and `BridgeV1Status`.
- Rebuilt `src/bridge/http-bridge.ts`:
  - Correlation IDs (`crypto.randomUUID()`) for every command; pending map tracks each request individually.
  - F1 fix: late responses arriving after timeout are logged and dropped — never delivered to subsequent callers.
  - Long-poll `GET /v1/next?wait=25000` resolves immediately when work arrives (returns 204 on timeout).
  - Strict single-flight execution serialization (Script Engine runs one command at a time).
  - Origin validation (`isAllowedOrigin`): rejects foreign browser origins with 403 while permitting PT (`pt-sm://`), `file://`, loopback, and missing origin.
  - Optional token authentication via `STU_PT_BRIDGE_TOKEN` env var (`X-Stu-Token` header).
  - Full backward compatibility maintained for legacy `/next`, `/result` (hex), `/ping`, `/status`.
- Updated `src/server.ts` branding to `stu-packet-tracer-mcp`.
- Added unit test suite `tests/bridge.test.ts` (9 tests covering long-poll latency, F1 late-result regression, x10 concurrent serialization, origin blocking, token auth, and legacy hex compatibility).
- Verified via `bun run ci`: typecheck clean, English check clean, **357 pass, 0 fail across 30 files**.

### 2026-11-17 Phase 1 English-only + CI Hygiene
- Translated all remaining Spanish strings, comments, and IPC labels in `src/` and `tests/`:
  - `src/index.ts`, `src/ipc/label.ts`, `src/ipc/generator.ts`, `src/canvas/layout.ts`, `src/canvas/snapshot.ts`
  - `src/catalog/router-slots.ts`, `src/ipc/device-model.ts`, `src/ipc/dhcp-server.ts`, `src/ipc/files.ts`, `src/ipc/sim.ts`
  - `src/recipes/cook.ts`, `src/recipes/switching/apply.ts`, `src/recipes/wireless/apply.ts`, `src/resources/index.ts`
  - `src/sim/runner.ts`, `src/tools/add-module.ts`, `src/tools/create-link.ts`, `src/tools/delete-link.ts`
  - `tests/layout.test.ts`, `tests/router-slots.test.ts`, `tests/switching-cli.test.ts`
- Unified documentation:
  - Replaced Spanish `README.md` with English version branded as `stu-packet-tracer-mcp`.
  - Removed redundant `README.en.md`.
- Implemented English-only CI enforcement:
  - Created `scripts/check-english.ts` and `scripts/english-allowlist.txt`.
  - Added `"check:english"` and `"ci"` scripts to `package.json`.
  - Added `.editorconfig` (LF, 2 spaces, UTF-8, trim trailing whitespace).
  - Updated `.github/workflows/ci.yml` matrix (ubuntu, windows, macos) with `bun run check:english`.
- Verified:
  - `bun run typecheck`: clean (0 errors)
  - `bun run check:english`: passed (100% clean)
  - `bun test`: **348 pass, 0 fail across 29 files**
- Committed as `feat: english-only codebase and CI hygiene (phase 1)` (`commit 2dd16aa`).

### 2026-11-17 Phase 0 Bootstrap
- Cloned upstream repository from `https://github.com/Jcorderop02/packet-tracer-mcp` into `/home/fuih/Projects/stu-packet-tracer-mcp`.
- Preserved full git history for proper attribution. Renamed remote `origin` -> `upstream`.
- Inspected repository vs npm package:
  - Git repo contains 29 test suites (`tests/`), helper scripts (`scripts/`), and comprehensive docs (`docs/`).
  - Confirmed: `extension/` only contains `dist/mcp-bridge.pts` (no source in git repo either). Our own English extension source will be authored in Phase 5.
- Renamed package in `package.json` to `stu-packet-tracer-mcp` v0.1.0, author `fuih`, binary `stu-packet-tracer-mcp`.
- Updated `server.json` for MCP registry (`io.github.fuih/stu-packet-tracer-mcp`).
- Created `NOTICE.md` and updated `LICENSE` with dual copyright (Juan Cordero Pascual and fuih).
- Installed dependencies with Bun and ran baseline checks:
  - `bun test`: **348 passed, 0 failed, 907 expect() calls across 29 test files**.
  - `bun run typecheck` (`tsc --noEmit`): **Clean (0 errors)**.

## Questions for reviewer
- (None at this time; Phase 0 completed smoothly according to plan).

## Decisions made
- Owner is `fuih`.
- Teach mode is off by default.
- PNG renderer will use `@resvg/resvg-wasm` with bundled DejaVu Sans Mono TTF files.
