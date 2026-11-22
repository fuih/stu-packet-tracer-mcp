# Changelog

All notable changes to `stu-packet-tracer-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-11-22

Initial student-focused release — independent hard fork of `packet-tracer-mcp` (originally by Juan Cordero Pascual).

### Added
- **Bridge Protocol v1** (`src/bridge/protocol.ts`, `src/bridge/http-bridge.ts`):
  - Per-request correlation IDs (`crypto.randomUUID()`) with strict single-flight serialization and late-result drop protection.
  - Long-poll `GET /v1/next?wait=25000` + JSON `POST /v1/result` with live MCP agent name tracking (`X-Stu-Agent`) and full backward compatibility for legacy `/next` + `/result`.
  - Loopback-only binding, browser `Origin` validation (HTTP 403 on foreign origins), and optional `STU_PT_BRIDGE_TOKEN` (`X-Stu-Token`).
- **Open-Source English PT 9 Extension & Live Lab Monitor** (`extension/src/` + `extension/dist/stu-mcp-bridge.pts`):
  - 100% offline dark cyber-telemetry monitor UI (`this-sm:` assets) showing live active `.pkt` workspace, `REALTIME` / `SIM PLAYING` state, router/switch/PC counts, link/power alerts, clickable `LIVE LAB NODES` inspector chips, and active AI agent name.
  - Built-in 1-click lab toolbar (`wr all`, `copy ips`, automatic `power on` alert) + collapsible `--url` / `--token` drawer + `pt-bridge>` CLI prompt (`:help`, `:wr`, `:ips`, `:power`, `:inspect <dev>`, `:filter`, `:ping`, `:status`).
  - Off-critical-path debounced telemetry polling (`800ms`) so rapid command bursts run unblocked.
- **High-Speed Batching & Performance Engine**:
  - `pt_batch_build`: optionally clear canvas, place devices, install hardware modules, wire links, configure static/DHCP endpoints, and boot-wait routers/switches concurrently in a single MCP tool call.
  - `pt_run_cli_batch`: push multi-line IOS configs across multiple routers/switches (with optional batched `write memory`) in one IPC round-trip.
  - Single-round-trip `pt_run_cli` fast path, batched `pt_auto_layout` (`moveDevicesBatchJs`), parallel wave `pt_ping_matrix` with smart ARP retry, and short-TTL device/model caches.
  - `--doctor` CLI diagnostic command (`bun run doctor` / `stu-packet-tracer-mcp --doctor`).
- **Resilient Cisco IOS CLI Engine** (`src/cli/`):
  - Prompt & mode tracking (`user`, `privileged`, `config`, `config-if`, `config-subif`, `config-router`, `config-line`, `config-vlan`, `dhcp-config`, `rommon`, `dialog`).
  - Automatic `[yes/no]` initial configuration dialog dismissal, `--More--` pagination draining, eaten-character prevention, ring-buffer anchored scrollback slicing, and Cisco syslog extraction.
- **Terminal-Style CLI & PC CMD Screenshots** (`src/render/`):
  - Pure TypeScript SVG renderer with 5 themes (`pt-classic`, `dark`, `putty`, `high-contrast`, `pc-cmd`), Cisco IOS & PC CMD syntax highlighting, wrapping, and right-margin callout annotations.
  - Embedded `@resvg/resvg-wasm` + bundled **DejaVu Sans Mono** TTF fonts for 2x PNG output without Chrome or system font dependencies.
  - Tools: `pt_capture_cli`, `pt_capture_pc_command`, `pt_render_terminal` (offline).
- **Student Workflow & Troubleshooting Tools** (`src/student/`):
  - `pt_addressing_table`: live Device/Interface/IP/Mask/Gateway table in Markdown, CSV, and JSON.
  - `pt_ping_matrix`: full-mesh parallel connectivity matrix with smart ARP warm-up, failure diagnostics, and optional SVG/PNG matrix image.
  - `pt_check_lab`: objective verifier (`ping`, `route`, `interface_up`, `config_contains`, `vlan_exists`) with pass/fail scorecard.
  - `pt_explain_output` (offline): plain-English explainer for `show ip route`, `show ip arp`, `show ip interface brief`, `show vlan brief`, and `show running-config`.
  - `pt_subnet_calc` (offline): IPv4 subnet calculator and largest-first VLSM allocation planner.
  - `pt_lab_template`: 10 built-in university networking labs (`examples/labs/*.json`).
  - `pt_diagnose_faults`: deep lab fault detector (`hints`, `commands`, `autofix` modes) catching powered-off devices, shutdown interfaces, duplicate IPs, classful `/8` mask traps, missing or mismatched gateways, self-pointing static routes, and one-way routing.
  - `pt_trace_path`: forward and return path analyzer pinpointing the exact hop and reason packets drop (including Router-on-a-Stick subinterfaces).
  - `pt_break_lab`: deterministic troubleshooting challenge generator (`easy`, `medium`, `hard`) injecting 1–5 realistic lab faults for exam practice.
  - Teach Mode (`STU_PT_TEACH_MODE=1` / `dry_run: true`, off by default).
- **Lab Report Export** (`src/report/`, `pt_export_report`):
  - One-command export to Microsoft Word (`.docx` with embedded 2x PNGs and shaded tables), single-file print-ready HTML (`@media print`), Markdown, and Before/After troubleshooting sections.
- **Tool Layer & Quality Gates**:
  - Strict Zod schemas (`additionalProperties: false`) enforced across all **72 tools**.
  - Fuzzy device matching with Levenshtein `<= 2` "Did you mean ...?" hints.
  - Auto-generated `docs/TOOLS.md` verified by `bun run check:tools`.
  - 100% English enforcement (`bun run check:english`) across source, tests, extension, `.github/`, and docs.
  - Cross-platform GitHub Actions CI (`ubuntu`, `windows`, `macos`) and tag-triggered standalone binary + `.pts` release workflow (`.github/workflows/release.yml`).
