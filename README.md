# stu-packet-tracer-mcp

![Version](https://img.shields.io/badge/Version-0.1.0-orange?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active%20Development-yellow?style=flat-square)
[![Repo status](https://img.shields.io/badge/Repo%20status-WIP-yellow?style=flat-square)](https://www.repostatus.org/#wip)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

![Packet Tracer](https://img.shields.io/badge/Packet%20Tracer-9.0.0.0810-success?style=flat-square)
![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.2-black?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat-square&logo=typescript&logoColor=white)

![CI](https://img.shields.io/github/actions/workflow/status/fuih/stu-packet-tracer-mcp/ci.yml?style=flat-square&label=CI&branch=main)
![Tests](https://img.shields.io/badge/Tests-348%20passing-success?style=flat-square)
![MCP tools](https://img.shields.io/badge/MCP%20tools-57-blueviolet?style=flat-square)

A student-focused, English-first Model Context Protocol (MCP) server for driving **Cisco Packet Tracer 9.0** from AI agents and LLM clients. A custom webview extension hooks into Packet Tracer's editor and opens a local HTTP bridge; the MCP server then calls PT's native IPC API through it to build topologies, configure routers and switches, inspect network state, render terminal-style CLI screenshots, and export student lab reports.

> **Attribution & Origin:**
> `stu-packet-tracer-mcp` is a hard fork of [`packet-tracer-mcp`](https://github.com/Jcorderop02/packet-tracer-mcp) by Juan Cordero Pascual, licensed under the [MIT License](NOTICE.md). Maintained by [fuih](https://github.com/fuih) with student-centric features, English-first diagnostics, request-correlation reliability, and lab reporting tools.

---

## Table of Contents

- [Why stu-packet-tracer-mcp?](#why-stu-packet-tracer-mcp)
- [Philosophy: Canvas-First](#philosophy-canvas-first)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
  - [Connect an MCP Client](#connect-an-mcp-client)
  - [Build a Single Binary](#build-a-single-binary)
  - [Tests](#tests)
  - [End-to-End Walkthrough](#end-to-end-walkthrough)
- [Capabilities](#capabilities)
- [Bundled Recipes](#bundled-recipes)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [FAQ](#faq)
- [Project Layout](#project-layout)

---

## Why stu-packet-tracer-mcp?

Community projects for PT 6.x–8.x relied on JavaScript helpers shipped by signed third-party extensions. Packet Tracer 9.0 shut that door: App Meta Files (`.pta`) now require Cisco ECDSA cryptographic signatures. The sanctioned path is communicating with Packet Tracer's webview script engine from outside:

- A lightweight **`.pts` extension** runs inside PT's script environment, communicating with the MCP bridge.
- The MCP server calls **PT's native IPC API** directly: e.g.
  `ipc.appWindow().getActiveWorkspace().getLogicalWorkspace().addDevice(...)`
  or `getDevice(...).getCommandLine().enterCommand(...)`. No opaque third-party binary blobs.
- **English-first architecture**: All IPC labels, debug diagnostics, error messages, and documentation are strictly in English.
- **Student-friendly lab tooling**: Generates addressing tables, visual terminal screenshots (SVG/PNG), and exports complete lab reports in Markdown, HTML, and Word DOCX formats.

---

## Philosophy: Canvas-First

Other tools keep a "plan" object in memory, validate it, and finally push it to the simulator. `stu-packet-tracer-mcp` treats the live simulator as the single source of truth:

- **No abstract `TopologyPlan` in memory.** Whatever is on the canvas exists; the canvas is the plan.
- **Recipes inspect canvas state before mutating.** Run the same recipe twice on a partial canvas and it finishes missing connections rather than duplicating devices.
- **Live canvas validation.** Querying verifies real state (duplicate IPs, subnets, powered-off devices) directly in PT.
- **Snapshots and diffs.** Version control your network by diffing the live canvas against earlier dumps.

---

## Requirements

- Cisco Packet Tracer **9.0** (`9.0.0.0810`).
- [Bun](https://bun.sh) `>=1.2`. (Runs TypeScript natively).
- The `mcp-bridge.pts` extension loaded in Packet Tracer.

---

## Quick Start

```bash
git clone https://github.com/fuih/stu-packet-tracer-mcp.git
cd stu-packet-tracer-mcp
bun install
bun run start                  # Streamable HTTP on :39001 (default)
# or:
bun run src/index.ts --stdio   # Stdio transport for local MCP clients
```

In Packet Tracer 9:

1. Open `Extensions > Scripting > Configure PT Script Modules > Add` and select `extension/dist/mcp-bridge.pts`.
2. Mark the extension active.
3. Open the window from `Extensions > MCP Bridge` once per PT session.

To verify connection, call `pt_bridge_status`: it replies `connected: true` in under a second.

The MCP HTTP endpoint is:
```
http://127.0.0.1:39001/mcp
```

### Connect an MCP Client

<details>
<summary><strong>Claude Code</strong> (CLI)</summary>

```bash
claude mcp add --transport http stu-pt http://127.0.0.1:39001/mcp
```
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "url": "http://127.0.0.1:39001/mcp"
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor / VS Code / Antigravity</strong></summary>

Configure HTTP transport pointing to `http://127.0.0.1:39001/mcp`.
</details>

### Build a Single Binary

```bash
bun run build
./dist/stu-packet-tracer-mcp
```

### Tests

```bash
bun test
```

All 348 unit tests run offline without requiring Packet Tracer to be open.

### End-to-End Walkthrough

```text
1. pt_list_recipes                          # discover available lab recipes
2. pt_forecast recipe='chain' params={routers:3, pcsPerLan:2}
                                            # dry-run estimate, 0 mutations
3. pt_cook_topology recipe='chain'
       params={routers:3, pcsPerLan:2, routing:'ospf'}
                                            # builds and configures lab
4. pt_inspect_canvas                        # audit configuration & health
5. pt_explain_canvas                        # human-readable narrative
6. pt_save_snapshot name='chain-baseline'   # snapshot baseline
7. pt_run_cli device='R1' command='show ip route'
                                            # verify routing table
8. pt_diff_snapshots before='chain-baseline'
                                            # verify delta
9. pt_save_pkt path='/abs/path/lab.pkt'     # save as native .pkt
```

---

## Capabilities

`stu-packet-tracer-mcp` exposes **57 MCP tools** grouped by domain:

- **Bridge & Diagnostics**: `pt_bridge_status`, `pt_ping`, `pt_clear_canvas`.
- **Catalog & Discovery**: `pt_list_devices`, `pt_list_modules`, `pt_list_recipes`, `pt_list_snapshots`, `pt_get_device_details`.
- **Live Inspection**: `pt_query_topology`, `pt_inspect_canvas`, `pt_explain_canvas`, `pt_forecast`, `pt_generate_configs`, `pt_inspect_ports`, `pt_read_vlans`, `pt_read_acl`, `pt_show_bgp_routes`, `pt_read_project_metadata`.
- **Canvas Primitives**: `pt_add_device`, `pt_add_module`, `pt_create_link`, `pt_delete_device`, `pt_delete_link`, `pt_move_device`, `pt_auto_layout`, `pt_rename_device`, `pt_set_pc`, `pt_set_device_power`, `pt_add_canvas_annotation`, `pt_manage_clusters`, `pt_send_raw`.
- **Orchestration Recipes**: `pt_cook_topology`, `pt_mend_canvas`, `pt_plan_review`, `pt_apply_switching`, `pt_apply_services`, `pt_configure_server_dhcp`, `pt_configure_subinterface`, `pt_apply_advanced_routing`, `pt_apply_ipv6`, `pt_apply_voip`, `pt_apply_wireless`.
- **Snapshots**: `pt_save_snapshot`, `pt_load_snapshot`, `pt_diff_snapshots`.
- **File Persistence**: `pt_save_pkt`, `pt_open_pkt`, `pt_save_pkt_to_bytes`, `pt_open_pkt_from_bytes`.
- **CLI & Diagnostics**: `pt_run_cli`, `pt_run_cli_bulk`, `pt_show_running`.
- **Simulation**: `pt_simulation_mode`, `pt_simulation_play`, `pt_send_pdu`, `pt_traceroute`, `pt_screenshot`.

---

## Bundled Recipes

| Recipe | Description |
|--------|-------------|
| `chain` | N routers in series, each with a LAN of M PCs. |
| `star` | Central hub router with N spoke routers and LANs. |
| `branch_office` | Headquarters router with branch office router and LANs. |
| `campus_vlan` | Router-on-a-stick with 802.1Q subinterfaces, trunking, and VLANs. |
| `edge_nat` | Edge gateway router with PAT/NAT overload, DHCP, and upstream ISP. |
| `dual_isp` | Dual multihomed ISP topology with eBGP and HSRP redundancy. |
| `voip_lab` | Cisco CME voice lab with 7960 IP phones, voice VLAN, and DHCP option 150. |
| `ipv6_lab` | Dual-stack IPv4/IPv6 lab with OSPFv3 routing. |
| `wifi_lan` | Access Point and wireless client topology. |

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PACKETTRACER_MCP_HOST` | `127.0.0.1` | MCP HTTP host (`0.0.0.0` for LAN access). |
| `PACKETTRACER_MCP_PORT` | `39001` | MCP HTTP port (avoids PT native IPC on 39000). |
| `PACKETTRACER_BRIDGE_PORT` | `54321` | HTTP bridge port polled by PT extension. |
| `PACKET_TRACER_SNAPSHOT_DIR` | `./packet-tracer-snapshots` | Directory for snapshot files. |

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Architectural overview, bridge design, and IPC mechanics.
- [`docs/BOOTSTRAP.md`](docs/BOOTSTRAP.md) — Extension setup and bridge configuration.
- [`docs/COVERAGE.md`](docs/COVERAGE.md) — Test matrix and verified PT 9 behaviors.
- [`docs/TOOLS.md`](docs/TOOLS.md) — Comprehensive reference for all 57 MCP tools.
- [`docs/RECIPES.md`](docs/RECIPES.md) — Topology recipe catalog and parameters.
- [`NOTICE.md`](NOTICE.md) — Upstream attribution and licensing.
- [`LICENSE`](LICENSE) — MIT License.

---

## Project Layout

```
src/
  bridge/        HTTP bridge polled by Packet Tracer webview
  canvas/        Snapshot, inspection, diff, layout, and subnetting
  catalog/       Device models (54), aliases, modules, and cable types
  ipc/           String-in/string-out IPC builders for PT Script Engine
  recipes/       Blueprints, addressing, routing, switching, and topologies
  persistence/   Snapshot storage
  tools/         MCP tool definitions and registrations
  config.ts      Environment configuration
  server.ts      Lifecycle and server setup
  index.ts       CLI entrypoint
extension/       Packet Tracer webview extension (.pts)
docs/            Architecture, recipes, and developer guides
tests/           Unit test suite (offline)
```

---

## FAQ

<details>
<summary><b>Can I run this without Packet Tracer open?</b></summary>
Catalog queries, recipe forecasting, configuration generation, and unit tests run completely offline without Packet Tracer. Live topology building, CLI execution, and canvas inspection require Packet Tracer to be running with the bridge active.
</details>

<details>
<summary><b>Which Packet Tracer version is supported?</b></summary>
Targeted and verified against <strong>Cisco Packet Tracer 9.0.0.0810</strong>.
</details>
