# Changelog

All notable changes to `stu-packet-tracer-mcp` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-11-17

Initial student-focused release — independent hard fork of `packet-tracer-mcp` (originally by Juan Cordero Pascual).

### Added
- **Bridge Protocol v1** (`src/bridge/protocol.ts`, `src/bridge/http-bridge.ts`):
  - Per-request correlation IDs (`crypto.randomUUID()`) with strict single-flight serialization and late-result drop protection.
  - Long-poll `GET /v1/next?wait=25000` + JSON `POST /v1/result` with full backward compatibility for legacy `/next` + `/result`.
  - Loopback-only binding, browser `Origin` validation (HTTP 403 on foreign origins), and optional `STU_PT_BRIDGE_TOKEN` (`X-Stu-Token`).
- **Resilient Cisco IOS CLI Engine** (`src/cli/`):
  - Prompt & mode tracking (`user`, `privileged`, `config`, `config-if`, `config-subif`, `config-router`, `config-line`, `config-vlan`, `dhcp-config`, `rommon`, `dialog`).
  - Automatic `[yes/no]` initial configuration dialog dismissal, `--More--` pagination draining, eaten-character prevention, and Cisco syslog extraction.
- **Open-Source English PT 9 Extension Source** (`extension/src/` + `docs/BUILD_EXTENSION.md`):
  - Clean English "Student MCP Bridge" Script Module supporting Bridge v1 long-poll, legacy fallback, exponential reconnect backoff (`1s -> 2s -> 5s -> 10s`), and optional bridge token input.
- **Terminal-Style CLI & PC CMD Screenshots** (`src/render/`):
  - Pure TypeScript SVG renderer with 5 themes (`pt-classic`, `dark`, `putty`, `high-contrast`, `pc-cmd`), Cisco IOS & PC CMD syntax highlighting, wrapping, and right-margin callout annotations.
  - Embedded `@resvg/resvg-wasm` + bundled **DejaVu Sans Mono** TTF fonts for 2x PNG output without Chrome or system font dependencies.
  - New tools: `pt_capture_cli`, `pt_capture_pc_command`, `pt_render_terminal` (offline).
- **Student Workflow Tools** (`src/student/`):
  - `pt_addressing_table`: live Device/Interface/IP/Mask/Gateway table in Markdown, CSV, and JSON.
  - `pt_ping_matrix`: full-mesh connectivity matrix with automatic ARP warm-up, failure diagnostics, and optional SVG/PNG matrix image.
  - `pt_check_lab`: objective verifier (`ping`, `route`, `interface_up`, `config_contains`, `vlan_exists`) with pass/fail scorecard.
  - `pt_explain_output` (offline): plain-English explainer for `show ip route`, `show ip arp`, `show ip interface brief`, `show vlan brief`, and `show running-config`.
  - `pt_subnet_calc` (offline): IPv4 subnet calculator and largest-first VLSM allocation planner.
  - `pt_lab_template`: 10 built-in university networking labs (`examples/labs/*.json`).
  - Teach Mode (`STU_PT_TEACH_MODE=1` / `dry_run: true`, off by default).
- **Lab Report Export** (`src/report/`, `pt_export_report`):
  - One-command export to Microsoft Word (`.docx` with embedded 2x PNGs and shaded tables), single-file print-ready HTML (`@media print`), and Markdown.
- **Tool Layer & Quality Gates**:
  - Strict Zod schemas (`additionalProperties: false`) enforced across all 67 tools.
  - Fuzzy device matching with Levenshtein `<= 2` "Did you mean ...?" hints.
  - Auto-generated `docs/TOOLS.md` verified by `bun run check:tools`.
  - 100% English enforcement (`bun run check:english`) across source, tests, extension, and docs.
  - Cross-platform GitHub Actions CI (`ubuntu`, `windows`, `macos`) and tag-triggered standalone binary release workflow (`.github/workflows/release.yml`).
