# AGENTS.md — Operational Guide for LLMs Using `stu-packet-tracer-mcp`

This guide is for you (the AI model) whenever a user asks you to build, inspect, diagnose, or document topologies in Cisco Packet Tracer 9 through this MCP server. Read it before calling tools to avoid rework.

## 1. Before Touching Anything

1. Call `pt_bridge_status` to confirm the bridge is connected to the Packet Tracer extension. If not, guide the user to load `extension/dist/stu-mcp-bridge.pts` (or use the paste-in bootstrap snippet returned by `pt_bridge_status`).
2. Call `pt_query_topology` to see what devices and links already exist on the canvas.
3. If the user provides a topology diagram (PDF, image, or sketch), summarize it in your own words before creating anything. Identify:
   - How many routers, switches, and endpoints exist.
   - Which LANs are **user LANs** (with PCs/servers).
   - Which LANs are **transit LANs** between routers (switch only, no PCs).
   - Which links are **internal LAN links** (GigabitEthernet) and which are **external WAN links** (Serial `/30` public links).
4. If the brief or diagram is ambiguous, **ask the user before guessing**. Building on a wrong assumption wastes more time than clarifying upfront.

## 2. Cabling Conventions

This is the most common source of topology errors. Follow these rules carefully:

| Link Type | Cable | Interfaces |
| --- | --- | --- |
| Router ↔ Switch (office LAN) | `straight` | `GigabitEthernet` ↔ `Gigabit`/`FastEthernet` |
| Switch ↔ PC / Server | `straight` | `Fast`/`GigabitEthernet` |
| Router ↔ Router over shared LAN switch | `straight` | `GigabitEthernet` (both via switch) |
| **Router ↔ Router over external public WAN** | **`serial`** | **`Serial0/1/0`** (requires `HWIC-2T`) |
| Switch ↔ Switch (trunk) | `cross` | `GigabitEthernet` |

**Rule of thumb:** if the lab brief mentions keywords such as "public network", "ISP", "public `/30`", "WAN", "public point-to-point", or shows red lightning-bolt lines between routers crossing an Internet cloud, use **`serial`**. Internal office segments use **`GigabitEthernet`**.

**Important:** ISR routers (`1941`, `2901`, `2911`, `ISR4321`, `ISR4331`) **ship with NO serial ports by default**. Before creating a serial link, call `pt_add_module` with `HWIC-2T` (or `NIM-2T` where requested) on each router. Skipping this step causes `pt_create_link` with `cable="serial"` to fail.

**Chassis slots validated by `pt_add_module`:**

| Model | Available Bays | Module Family |
| --- | --- | --- |
| `1841` | `0/0`, `0/1` | HWIC / WIC |
| `2811` | `0/0`, `0/1`, `0/2`, `0/3` | HWIC / WIC / NM |
| `1941` | `0/0`, `0/1` | EHWIC / HWIC / WIC |
| `2901` | `0/0`, `0/1`, `0/2`, `0/3` | EHWIC / HWIC / WIC |
| `2911` | `0/0`, `0/1`, `0/2`, `0/3` | EHWIC / HWIC / WIC |
| `ISR4321` | `0/1`, `1/0` | NIM / SM-X |
| `ISR4331` | `0/1`, `0/2`, `1/0` | NIM / SM-X |

**ISR4xxx note:** The 4000 series uses **NIM** (Network Interface Module) slots. Packet Tracer 9 accepts `HWIC-2T` inside NIM bays for compatibility, though academic briefs often specify `NIM-2T` — check the brief and match what it expects.

**Common module-slot mistakes:**
- Slot `0/0` on `ISR4321` / `ISR4331` is the built-in GE bay and rejects add-on modules. Use `0/1` (or `0/2` on `ISR4331`).
- Slot `0/2` on `1941` does not exist (`1941` only has `0/0`, `0/1`).
- Slot `0/3` on `1841` does not exist (`1841` only has `0/0`, `0/1`).

## 3. User LANs vs. Transit LANs

A frequent university lab pattern looks like this:

```text
LAN1, LAN2  -> office A user LANs (switch with attached PCs)
LAN3        -> transit segment between R1 and R2 (same building, switch only, NO PCs)
LAN4        -> transit segment between R3 and R4 (office B, NO PCs)
LAN5, LAN6  -> office B user LANs (switch with attached PCs)
```

The phrase "all LANs with the same addressing capacity" **refers to the subnet prefix** (for example all `/23` or all `/24`), NOT that every LAN has user workstations. If a LAN only sits between two routers and no hosts are listed on it, treat it as a transit segment (switch + links to the routers only).

## 4. Recommended Workflow for Multi-Router Topologies

```text
1. pt_plan_review              (mandatory pre-flight for >=3 routers or user diagrams)
2. pt_batch_build              (fastest: clear + place devices + add modules + wire links + set PCs + wait for CLI in 1 call)
   — or step-by-step: pt_clear_canvas -> pt_add_device -> pt_add_module -> pt_create_link
3. pt_auto_layout              (apply topology-aware layout across the canvas)
4. pt_run_cli_batch            (push IP / hostname / routing CLI to multiple devices in 1 call, with optional save: true)
   — or pt_run_cli_bulk / pt_apply_advanced_routing per device
5. pt_save_pkt                 (persist the lab file)
```

**Do not invent manual `x`/`y` coordinates.** `pt_auto_layout` arranges routers along a clear horizontal band, places switches beneath their parent router, places endpoints beneath their switch, and centers shared switches/clouds between connected routers.

## 5. Common Pitfalls to Avoid

- **Wiring R1 ↔ Internet with `GigabitEthernet`** when the brief specifies a public `/30` WAN link. Use `cable="serial"`.
- **Adding PCs to a router-to-router transit LAN** unless the brief explicitly shows endpoints there.
- **Inventing sequential `x`/`y` coordinates** (`100, 250, 400, 550...`) instead of letting `pt_add_device` / `pt_auto_layout` lay out the topology.
- **Ignoring the initial configuration dialog** on newly added ISRs (`Continue with configuration dialog? [yes/no]:`). Our CLI engine handles dismissing it automatically, or you can wait ~3 s after adding a router.
- **Mixing privileged and unprivileged commands in raw scripts** without ensuring `enable`. `pt_run_cli` and `pt_run_cli_bulk` track and enter privileged mode automatically.
- **Assuming `switchport trunk encapsulation dot1q` is universal across switch models:**
  - **`2950` / `2960`**: IOS rejects `switchport trunk encapsulation dot1q` because only 802.1Q is supported (`% Invalid input`). `pt_run_cli_bulk` detects these models and filters it automatically.
  - **`3560` / `3650` / `IE-3400` / `IE-9320` (multilayer)**: Cisco IOS requires `switchport trunk encapsulation dot1q` before `switchport mode trunk` on models that also support ISL (for example `3560-24PS`). Check model behavior carefully; do not blindly strip it everywhere.
  - **Routers (`2811`, `1941`, etc.) with subinterfaces**: use `encapsulation dot1Q <vlan>` under the subinterface (`pt_configure_subinterface`). The bulk switch filter leaves router subinterface commands untouched.
- **Forgetting `clock rate` on the DCE side of a serial link.** Without `clock rate 64000` (or another valid rate) on the DCE router interface, the serial link remains `down/down`. Check which side is DCE with `show controllers <interface>`.
- **Using a console cable for data.** `cable="console"` (rollover RS-232 ↔ RJ45) is only for out-of-band management connections, never LAN data traffic. Use `straight`.

## 6. Debugging When Something Fails

- `pt_query_topology` — inspect live devices and links.
- `pt_inspect_canvas` — inspect port attachment status.
- `pt_get_device_details` — inspect installed modules and exact interface names on a device.
- `pt_diagnose_faults` & `pt_trace_path` — inspect missing routes, shutdown interfaces, wrong PC gateways, and VLAN/trunk mismatches.
- `pt_screenshot` — capture a canvas overview to compare visually against the lab diagram.
- `pt_inspect_ports`, `pt_read_vlans`, `pt_read_acl`, `pt_show_bgp_routes` — targeted per-device inspection.

## 7. Detecting Silent Failures

Packet Tracer 9 may return no error even when an operation did not take effect. **Always verify**:

- After `pt_add_device`: confirm the device appears in `pt_query_topology`.
- After `pt_add_module`: confirm the module and new ports (such as `Serial0/1/0`, `Serial0/1/1`) appear in `pt_get_device_details`. If not, the slot was occupied or unsupported on that chassis.
- After `pt_create_link`: confirm BOTH endpoints report connected status in `pt_inspect_canvas`.
- After CLI changes: verify with `pt_show_running` or `pt_run_cli` (`show ip interface brief`):
  - Ensure commands ran in privileged/config mode (`enable` -> `configure terminal`).
  - Ensure `no shutdown` was applied on every active physical interface.

## 8. Patterns Never to Bypass

- **Do not bypass `pt_create_link`** using `pt_send_raw` just to avoid the `confirm_internal_lan` check between two routers.
- **Do not guess port names** that may not exist on the hardware model — check `pt_get_device_details` first.
- **Do not assume silent success** — verify state against the live canvas (`pt_query_topology`, `pt_show_running`).

## 9. Escape Hatches (Last Resort)

When a legitimate PT 9 operation has no dedicated high-level tool:

- `pt_send_raw` executes arbitrary JavaScript in PT's Script Engine. Useful for inspection, but fragile and unvalidated.
- `pt_run_cli` (single command) and `pt_run_cli_bulk` (multi-line block) both handle mode entry and prompt tracking automatically.
- `pt_save_snapshot` / `pt_load_snapshot` checkpoint canvas state during experiments (never a substitute for `pt_save_pkt`).

## 10. Known Packet Tracer 9 API Limitations

- **Wireless client ↔ AP association:** The JS API sets SSID/auth/keys cleanly, but programmatic wireless client association may not trigger cleanly (`count=0` on client).
- **Reactive events:** `registerObjectEvent` in PT 9 Script Engine is a stub that accepts names without firing callbacks; detection relies on polling.
- **DHCP Option 150 on Server-PT:** `DhcpPool` does not expose `setTftp` / `setOption` / `setBoot` via JS API. For VoIP IP Phones, put the DHCP pool with `option 150 ip <tftp>` on the CME router (`pt_apply_services` `dhcpPools[].tftpServer`), or set TFTP via the Server-PT GUI.
- **Undo/redo:** Not exposed via PT 9 JS API. Use `pt_save_snapshot` before major changes.
- **CME (`telephony-service`):** Stock 2900 routers require activating the `uck9` package (`license boot module c2900 technology-package uck9` + reload) before IOS accepts VoIP CME commands.

## 11. Pre-Completion Verification Checklist

1. `pt_query_topology` — are all expected devices present?
2. `pt_inspect_canvas` — are all links connected on both ends with the right cable types?
3. `pt_show_running` / `pt_addressing_table` — are hostnames, IPs, masks, gateways, and `no shutdown` applied accurately?
4. `pt_ping_matrix` / `pt_ping` — is end-to-end connectivity passing between hosts across all required subnets?
5. `pt_diagnose_faults` (check-only `mode: "hints"`) — zero critical connectivity or routing faults remaining?
6. `pt_save_pkt` — persist the final `.pkt` file if requested.
