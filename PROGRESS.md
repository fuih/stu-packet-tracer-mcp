# PROGRESS: stu-packet-tracer-mcp

## Current phase: 8 (Completed) -> Phase 9 (Starting)

## Checklist
- [x] P0 Bootstrap (Clone, rename, upstream attribution, baseline test suite)
- [x] P1 English + CI (Translation of all Spanish strings, check:english script, GitHub Actions CI)
- [x] P2 Bridge v1 (Correlation IDs, long-poll /v1/next, origin check, drop late results)
- [x] P3 CLI engine (Pagination --More--, eaten char fix, prompt/mode tracking)
- [x] P4 Tool layer (Strict schemas, did-you-mean device resolver, clean docs)
- [x] P5 Extension (English extension source in repo, docs/BUILD_EXTENSION.md; human `.pts` packaging step documented)
- [x] P6 CLI screenshots (Terminal SVG renderer, DejaVu Sans Mono, resvg-wasm PNG)
- [x] P7 Student features (Addressing table, ping matrix with ARP warm-up, lab checker, explain output, teach mode)
- [x] P8 Report export (pt_export_report -> MD, HTML, DOCX)
- [ ] P9 Docs & release prep (README, QUICKSTART, CLIENTS, TROUBLESHOOTING, REPORTS, release workflow)

## Log
### 2026-11-17 Phase 8 Lab Report Export
- Installed `docx` (`9.15.4`) for native Microsoft Word `.docx` report generation.
- Built report pipeline under `src/report/`:
  - `src/report/model.ts`: structured `LabReport` data model (metadata, topology PNG, addressing table, ping matrix, ordered sections with CLI & PC CMD captures).
  - `src/report/collect.ts`: live collector capturing workspace topology PNG, addressing table, optional ping matrix SVG+PNG, IOS CLI terminal captures, PC Command Prompt captures, and optional `.pkt` save.
  - `src/report/markdown.ts`: Markdown report referencing relative `captures/` images with fenced code fallbacks.
  - `src/report/html.ts`: single self-contained HTML report with inline CSS, inline vector SVGs, embedded base64 topology PNG, and `@media print` rules for clean browser PDF export.
  - `src/report/docx.ts`: native `.docx` generator with title block, styled shaded addressing table, PNG IHDR aspect-ratio sizing, embedded 2x PNG terminal & topology screenshots (monospace fallback when PNG unavailable), and `Page X of Y` footer.
- Registered `pt_export_report` (`src/tools/export-report.ts`) in `src/tools/index.ts` (67 total registered tools).
- Added 3 offline report export tests in `tests/report-export.test.ts` verifying Markdown, self-contained HTML, and real OOXML/ZIP `.docx` magic bytes (`50 4B 03 04`) with embedded PNG captures.
- Regenerated `docs/TOOLS.md` and verified via `bun run ci`: typecheck clean, English check clean, `docs/TOOLS.md` clean, **403 pass, 0 fail across 35 files**.
### 2026-11-17 Phase 7 Student Features (Fixes F8)
- Implemented 6 student-focused tools and core modules under `src/student/` (66 total registered tools):
  - `pt_addressing_table` (`src/student/addressing.ts`, `src/tools/addressing-table.ts`): single-round-trip live Device/Interface/IP/Mask/Gateway table exported as Markdown, CSV, and structured JSON.
  - `pt_ping_matrix` (`src/student/ping-matrix.ts`, `src/tools/ping-matrix.ts`): full mesh host ping matrix with automatic ARP warm-up ping first (F8 fix), failure diagnostics (missing gateway, unreachable, return route), and optional standalone SVG + PNG matrix table image.
  - `pt_check_lab` (`src/student/lab-check.ts`, `src/tools/check-lab.ts`): objective verifier supporting `ping`, `route`, `interface_up`, `config_contains`, and `vlan_exists` with pass/fail scorecards and CLI evidence.
  - `pt_explain_output` (`src/student/explain.ts`, `src/tools/explain-output.ts`, offline): rule-based plain-English explainer for `show ip route`, `show ip arp`, `show ip interface brief`, `show vlan brief`, and `show running-config`.
  - `pt_subnet_calc` (`src/student/subnet-calc.ts`, `src/tools/subnet-calc.ts`, offline): IPv4 subnet details + largest-first VLSM allocation planner reusing `src/canvas/subnetting.ts`.
  - `pt_lab_template` (`src/student/lab-templates.ts`, `src/tools/lab-template.ts`): 10 university networking lab templates (`static-routing`, `default-route`, `rip-v2`, `ospf-single-area`, `vlan-basic`, `inter-vlan-roas`, `dhcp`, `nat-pat`, `acl-standard`, `acl-extended`) with JSON examples in `examples/labs/`.
  - Teach Mode (`src/student/teach.ts`): off by default; when `STU_PT_TEACH_MODE=1` or `dry_run: true`, configuration and template tools output complete IOS commands and study steps without modifying the canvas.
- Added 12 offline tests in `tests/student-features.test.ts`.
- Regenerated `docs/TOOLS.md` and verified via `bun run ci`: typecheck clean, English check clean, `docs/TOOLS.md` clean, **400 pass, 0 fail across 34 files**.
### 2026-11-17 Phase 6 Terminal-Style CLI Screenshots (Fixes F7)
- Bundled `DejaVuSansMono.ttf`, `DejaVuSansMono-Bold.ttf`, and Bitstream Vera/DejaVu `LICENSE` in `assets/fonts/` and added `assets` to `package.json` `files`.
- Installed `@resvg/resvg-wasm` (`2.6.2`) and added `src/types/assets.d.ts` for Bun asset embedding (`with { type: "file" }`).
- Created pure TypeScript zero-dependency terminal SVG renderer:
  - `src/render/themes.ts`: 5 themes — `pt-classic` (Packet Tracer CLI tab chrome with `Physical | Config | CLI | Attributes`), `dark`, `putty`, `high-contrast` (print-ready), and `pc-cmd` (Windows Command Prompt).
  - `src/render/highlight.ts`: priority-ordered Cisco IOS & PC CMD highlighting (prompts, route codes `C`/`L`/`S*`/`O`/`D`/`B`, `Reply from`, `Request timed out`, `% Invalid input`, `up`/`down` interface status).
  - `src/render/terminal-svg.ts`: XML escaping, `xml:space="preserve"`, hard column wrapping with `↪` continuation indicator, right-margin callout annotations, dynamic content sizing.
  - `src/render/png.ts`: lazy `@resvg/resvg-wasm` rasterizer at 2x zoom with bundled DejaVu Sans Mono fonts (`loadSystemFonts: false`) and graceful fallback to SVG-only if WASM init fails.
  - `src/render/save.ts`: shared SVG/PNG writer supporting `svg`, `png`, and `both`.
- Implemented and registered 3 new tools (60 total tools):
  - `pt_capture_cli` (`src/tools/capture-cli.ts`): executes IOS commands via CLI engine and saves terminal SVGs/PNGs (per-command or combined).
  - `pt_render_terminal` (`src/tools/render-terminal.ts`, offline): renders arbitrary terminal text into styled SVG/PNG.
  - `pt_capture_pc_command` (`src/tools/capture-pc-command.ts`): runs `ping`/`ipconfig`/`tracert`/`arp -a` on Packet Tracer PCs/Servers and renders with `pc-cmd` theme.
- Added 12 tests + 5 golden SVG snapshots (`test/golden/*.svg`, regenerable via `UPDATE_GOLDEN=1 bun test`) in `tests/render-terminal.test.ts` verifying all themes, XML escaping, wrapping, annotations, and real PNG magic bytes.
- Regenerated `docs/TOOLS.md` and verified via `bun run ci`: typecheck clean, English check clean, `docs/TOOLS.md` clean, **388 pass, 0 fail across 33 files**.
### 2026-11-17 Phase 5 English Packet Tracer Extension Source (Fixes F6)
- Authored clean English Script Module source under `extension/src/`:
  - `extension/src/main.js`: PT 9 Script Engine entry point (`runEnvelope` returning JSON `ResultEnvelope` via `evaluateJavaScriptAsync`, plus `runCode` and legacy `__mcpEval` compatibility).
  - `extension/src/index.html` & `extension/src/style.css`: offline dark-themed "Student MCP Bridge" UI with status dot, protocol pill, server URL, optional `X-Stu-Token` input, Start/Stop + Clear Log controls, last action indicator, and live scrolling log.
  - `extension/src/bridge.js`: auto-detects Bridge Protocol v1 (`/v1/status` -> `/v1/next?wait=25000` + JSON `/v1/result`) with seamless fallback to legacy `/next` polling and exponential reconnect backoff (`1s -> 2s -> 5s -> 10s`) without error spam.
  - `extension/src/manifest.json`: module metadata (`io.github.fuih.stu-mcp-bridge`).
- Wrote click-by-click packaging guide in `docs/BUILD_EXTENSION.md` for the human (`fuih`) to package `extension/dist/stu-mcp-bridge.pts` inside PT 9.
- Extended `scripts/check-english.ts` to scan `extension/src/` (`.js`, `.html`, `.css`, `.json`).
- Updated `src/bridge/bootstrap.ts` branding comment; legacy `.pts` and paste-in fallback remain intact.
- Verified via `bun run ci`: typecheck clean, English check clean (including `extension/src`), `docs/TOOLS.md` clean, **376 pass, 0 fail across 32 files**.
### 2026-11-17 Phase 4 Tool Layer Cleanup (Fixes F4 & F10)
- Created `src/util/errors.ts`: `PtError` class and `ptError(code, message, hint?)` factory for actionable English error reporting.
- Created `src/util/devices.ts`: Levenshtein distance helper + `resolveDeviceName` (exact -> case-insensitive -> Levenshtein <= 2 "Did you mean...?" suggestion) and `resolveCanvasDevice`.
- Created `src/util/paths.ts`: `resolveOutputPath` supporting `STU_PT_OUTPUT_DIR` (default `./stu-pt-output/`) returning absolute paths, plus `slugify`.
- Created `src/tools/define.ts`: `defineTool` wrapper (strict schemas, automatic bridge check unless `offline: true`, `PtError` -> `isError` conversion, `structuredContent`, stderr debug timing) + `installStrictToolWrapper` so all 57 registered tools enforce `.strict()` schemas (`additionalProperties: false`).
- Ported core tools (`pt_bridge_status`, `pt_list_devices`, `pt_run_cli`, `pt_run_cli_bulk`, `pt_show_running`, `pt_ping`, `pt_traceroute`, `pt_screenshot`) to `defineTool` with `structuredContent`, fuzzy device resolution, and §5.2 conventions (including `commands: string[] | string` and `dry_run` preview on `pt_run_cli_bulk`).
- Created `scripts/gen-tools-doc.ts` to auto-generate `docs/TOOLS.md` from the live tool registry, added `docs:tools` and `check:tools` scripts to `package.json`, and integrated `check:tools` into `bun run ci`.
- Added unit tests in `tests/tool-layer.test.ts` verifying strict schema rejection across all 57 tools, fuzzy device resolution, path utilities, and `defineTool`.
- Verified via `bun run ci`: typecheck clean, English check clean, `docs/TOOLS.md` verified up to date, **376 pass, 0 fail across 32 files**.
### 2026-11-17 Phase 3 Resilient CLI Engine (Fixes F3)
- Implemented `src/cli/prompt.ts`:
  - Cisco IOS prompt regex matching modes: `user` (`R1>`), `privileged` (`R1#`), `config` (`R1(config)#`), `config-if`, `config-subif`, `config-router`, `config-line`, `config-vlan`, `dhcp-config`, `cfg-voice`, `rommon`, and `dialog` (`[yes/no]:`, `[confirm]`).
- Implemented `src/cli/clean.ts`:
  - Strips ANSI escape sequences and IOS pager artifacts (`--More--`, `\x08` backspace-space sequences).
  - Strips echoed command line and trailing prompt.
  - Extracts Cisco syslog messages (`%LINK-5-CHANGED...`, `%SYS-5-CONFIG_I...`) into a separate `logs[]` array.
- Implemented `src/cli/engine.ts`:
  - `prepareDevice`: one-time per session per device preparation. Automatically dismisses `[yes/no]` initial configuration dialogs, lingering `--More--`, elevates to privileged mode (`enable`), and attempts `terminal length 0` (recording switches/routers that reject it).
  - `runCli`: pre-checks tail for lingering `--More--` and clears with `q` before dispatching so initial characters are never eaten. Sends command with starting offset, polls server-side slices non-blocking, automatically advances mid-output `--More--` pagination with Space, and waits for stable prompt across 2 reads. Returns structured `{ device, command, mode_before, mode_after, prompt, output, logs, raw }`.
  - `ensureMode`: guarantees device is in `privileged` or `config` mode before command execution.
- Wired `src/tools/run-cli.ts`, `src/sim/runner.ts` (`runShowRunning`, `runShowRunningInclude`), and `src/tools/run-cli-bulk.ts` to use `src/cli/engine.ts`.
- Created unit test suite `tests/cli-engine.test.ts` with real captured fixtures (`test/fixtures/cli/sample-running-config.txt`, `sample-more.txt`).
- Verified via `bun run ci`: typecheck clean, English check clean, **367 pass, 0 fail across 31 files**.
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
