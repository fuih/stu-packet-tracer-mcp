# stu-packet-tracer-mcp Tool Reference

> **Auto-generated file.** Do not edit manually — run `bun run docs:tools` to regenerate.

Total registered tools: **70**. All input schemas are strict (`additionalProperties: false`).

## Categories

- [Catalog & Status](#catalog-status) (5)
- [Student Tools](#student-tools) (9)
- [Captures & Visuals](#captures-visuals) (4)
- [Reports](#reports) (1)
- [CLI & Diagnostics](#cli-diagnostics) (4)
- [Simulation & Testing](#simulation-testing) (5)
- [Topology & Canvas](#topology-canvas) (13)
- [Inspection & Analysis](#inspection-analysis) (11)
- [Configuration & Recipes](#configuration-recipes) (10)
- [Files & Snapshots](#files-snapshots) (8)

## Catalog & Status

### `pt_bridge_status` *(offline)*

Check whether the Packet Tracer bridge extension is connected and ready. Use this first before running lab commands or troubleshooting connection problems. Also prints the emergency paste-in bootstrap snippet if you do not have the .pts extension installed.

_No parameters._

### `pt_list_devices` *(offline)*

List all Packet Tracer device models supported by stu-packet-tracer-mcp, along with their ports and shortcut aliases. Use this before calling pt_add_device to pick the exact model name or alias.

_No parameters._

### `pt_list_modules`

Enumerate hardware modules. Without `device`: PT's full catalog (filterable). With `device`: the modules physically installed in that chassis right now (slotPath → name).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filter` | string | No | Catalog mode: case-insensitive substring of the module name. Ignored in installed mode. (default: `""`) |
| `limit` | integer | No | Catalog mode: max rows. Ignored in installed mode. (default: `50`) |
| `device` | string | No | Installed mode: device name. When set, lists modules physically present in that chassis instead of the global catalog. |

### `pt_list_recipes`

Enumerate the topology recipes pt_cook_topology can build, with their parameter shape.

_No parameters._

### `pt_plan_review`

Validate a topology plan BEFORE touching the canvas. The LLM declares devices, links and LAN roles; the tool returns a structured review with errors (will definitely fail), warnings (likely wrong) and a human-readable summary. MANDATORY for any topology with ≥3 routers or whenever the user supplies a diagram. Present the output VERBATIM to the user and wait for confirmation before calling pt_add_device. This is the single biggest leverage to avoid the common mistakes (Gigabit on WAN exterior, PCs on transit LANs, ad-hoc layout).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `devices` | object[] | Yes | Every device you plan to create. |
| `links` | object[] | Yes | Every cable you plan to create. |
| `lans` | object[] | No | Optional but recommended: declare each LAN's role (user vs transit) and which endpoints belong to it. Lets the validator catch the common mistake of adding PCs to a transit segment. (default: `[]`) |
| `notes` | string | No | Free-form context: the brief, the user's intent, anything that would help a human reader confirm the plan. |

## Student Tools

### `pt_addressing_table`

Build the classic Device / Interface / IP Address / Subnet Mask / Default Gateway addressing table from the live Packet Tracer canvas. Use this to verify lab addressing or drop straight into a university lab report.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `devices` | string[] | No | Optional filter: only include these device names. |
| `include_unassigned` | boolean | No | Include ports that do not have an IPv4 address assigned. (default: `false`) |
| `format` | `"markdown"` \| `"csv"` \| `"json"` | No | Preferred text output format (structuredContent always contains rows, markdown, and csv). (default: `"markdown"`) |

### `pt_break_lab`

Turn any working Packet Tracer topology into a hands-on troubleshooting challenge by injecting 1–5 realistic networking faults (shutdown links, wrong gateways, classful /8 masks, broken static routes, WAN mismatches). Returns spoiler-free trouble tickets for student practice or CCNA exam prep.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `count` | integer | No | Number of realistic faults to inject (1 to 5). (default: `2`) |
| `difficulty` | `"easy"` \| `"medium"` \| `"hard"` | No | Difficulty level: 'easy' (shutdown port, wrong gateway), 'medium' (classful mask trap, wrong LAN subnet), or 'hard' (self next-hop static route, WAN mask mismatch). (default: `"medium"`) |
| `reveal_solutions` | boolean | No | Set true to include the answer key and exact restore commands; defaults to false so students get spoiler-free practice tickets. (default: `false`) |
| `dry_run` | boolean | No | Preview planned fault tickets without modifying Packet Tracer. (default: `false`) |
| `seed` | integer | No | Optional random seed for repeatable challenge generation. |

### `pt_check_lab`

Verify a list of networking lab objectives (connectivity pings, routing table entries, up/up interfaces, running-config directives, and VLANs) against the live Packet Tracer topology. Returns a pass/fail scorecard with exact CLI evidence so students can self-check before submitting.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `objectives` | object \| object \| object \| object \| object[] | Yes | List of lab grading objectives to verify (ping, route, interface_up, config_contains, vlan_exists). |

### `pt_diagnose_faults`

Inspect a live Packet Tracer lab to detect common student networking mistakes (powered-off devices, shutdown interfaces, duplicate IPs, classful /8 mask traps, missing or wrong PC gateways, WAN subnet mismatches, self-pointing static routes, and one-way return routes). Supports study `hints`, full `commands`, or live `autofix`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `"hints"` \| `"commands"` \| `"autofix"` | No | 'hints' gives study clues without spoiling commands; 'commands' explains root causes and exact fixes (default); 'autofix' applies deterministic fixes live. (default: `"commands"`) |
| `devices` | string[] | No | Optional subset of device names to diagnose (defaults to all devices in the topology). |
| `deep_cli_check` | boolean | No | Also inspect router CLI tables (`show ip interface brief`, `show ip route`, `show running-config`) to catch shutdown ports, self next-hops, and one-way routing. (default: `true`) |

### `pt_explain_output` *(offline)*

Translate Cisco IOS command output (`show ip route`, `show ip arp`, `show ip interface brief`, `show vlan brief`, `show running-config`) into plain-English explanations line by line. Works completely offline as a study aid for understanding route codes, [AD/metric], ARP ages, and interface status.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `output` | string | Yes | Raw Cisco IOS CLI output to explain. |
| `command` | string | No | Optional command hint (e.g. 'show ip route', 'show ip arp', 'show ip interface brief', 'show vlan brief', 'show running-config'). Auto-detected if omitted. |

### `pt_lab_template` *(offline)*

Build or preview one of 10 classic university networking labs (`static-routing`, `default-route`, `rip-v2`, `ospf-single-area`, `vlan-basic`, `inter-vlan-roas`, `dhcp`, `nat-pat`, `acl-standard`, `acl-extended`) with custom subnets. Pass `dry_run: true` (or enable `STU_PT_TEACH_MODE=1`) to receive the complete step-by-step IOS commands as a study guide without modifying the canvas.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `template` | `"static-routing"` \| `"default-route"` \| `"rip-v2"` \| `"ospf-single-area"` \| `"vlan-basic"` \| `"inter-vlan-roas"` \| `"dhcp"` \| `"nat-pat"` \| `"acl-standard"` \| `"acl-extended"` | Yes | University networking lab template: static-routing, default-route, rip-v2, ospf-single-area, vlan-basic, inter-vlan-roas, dhcp, nat-pat, acl-standard, or acl-extended. |
| `lan_a` | string | No | Optional LAN A subnet (e.g. '192.168.10.0/24'). |
| `lan_b` | string | No | Optional LAN B subnet (e.g. '192.168.20.0/24'). |
| `transit` | string | No | Optional router-to-router transit subnet (e.g. '10.0.0.0/30'). |
| `router_prefix` | string | No | Optional router naming prefix (default 'R' -> R1, R2). |
| `dry_run` | boolean | No | Teach mode: if true (or STU_PT_TEACH_MODE=1), return the full topology plan and Cisco IOS commands without touching Packet Tracer. |

### `pt_ping_matrix`

Test full mesh connectivity by pinging between every pair of hosts on the canvas (with automatic ARP warm-up first so initial drops don't cause false failures). Returns a pass/fail matrix with plain-English failure diagnostics and optional SVG/PNG table image.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `devices` | string[] | No | Optional list of hosts to include (e.g. ['PC0', 'PC1', 'Server0']). Omit to test all end-hosts on the canvas. |
| `warmup` | boolean | No | Run one warm-up ping first so ARP resolves before the graded test (recommended). (default: `true`) |
| `timeout_ms` | integer | No | Per-ping timeout in milliseconds. (default: `20000`) |
| `render_image` | boolean | No | Also save the ping matrix as an SVG + PNG image for lab reports. (default: `false`) |
| `output_path` | string | No | Optional output path when render_image is true (default ./stu-pt-output/captures/ping-matrix). |

### `pt_subnet_calc` *(offline)*

Calculate IPv4 subnet details (network, broadcast, first/last usable host, subnet mask, OSPF/ACL wildcard mask) or generate a complete Variable Length Subnet Mask (VLSM) allocation plan offline. Use this before configuring router interfaces and labs.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `cidr` | string | Yes | IPv4 network in CIDR notation (e.g. '192.168.10.0/24') or plain IPv4 address when `mask` is supplied. |
| `mask` | string | No | Optional dotted-quad subnet mask (e.g. '255.255.255.192') if `cidr` omits `/prefix`. |
| `vlsm_requirements` | object[] | No | Optional list of subnets with required host counts to compute a non-overlapping VLSM addressing plan. |

### `pt_trace_path`

Simulate and trace BOTH the forward path (`from -> to`) and return path (`to -> from`) across L2 switches, PC gateways/masks, router interface states, and routing tables (`show ip route`). Answers 'Why can't A ping B?' by pinpointing the exact failing hop (e.g. missing return route or classful mask trap).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | Yes | Source device name (e.g. 'PC-A', 'A'). |
| `to` | string | Yes | Destination device name (e.g. 'PC-B', 'DC-SRV'). |

## Captures & Visuals

### `pt_capture_cli`

Run one or more Cisco IOS commands on a router or switch (or snapshot its current live CLI screen) and save authentic Packet Tracer 9 CLI screenshots (SVG and/or 2x PNG). By default includes live console scrollback history (previous commands, errors, prompts) so captures are indistinguishable from real Packet Tracer screenshots.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Router or switch name (e.g. 'R1', 'SW1'). |
| `commands` | string[] \| string | No | One or more IOS commands to execute and capture (array or newline-separated string). Omit to snapshot the current live CLI screen without running a new command. |
| `theme` | `"pt-classic"` \| `"dark"` \| `"putty"` \| `"high-contrast"` \| `"pc-cmd"` | No | Terminal color/chrome theme: pt-classic (default), dark, putty, high-contrast, or pc-cmd. (default: `"pt-classic"`) |
| `format` | `"svg"` \| `"png"` \| `"both"` | No | Output image format: svg, png, or both (default). (default: `"both"`) |
| `output_path` | string | No | Optional output file path (single/combined) or directory (multiple commands). Relative paths resolve under STU_PT_OUTPUT_DIR (default ./stu-pt-output/). |
| `include_prompt` | boolean | No | Include the `<prompt><command>` header line when `include_history` is false. (default: `true`) |
| `include_history` | boolean | No | Include the real live Packet Tracer CLI scrollback history (previous commands, errors, boot/session lines) above the new output so screenshots look like an authentic live CLI window (default: true). Set to false for clean single-command output only. (default: `true`) |
| `history_lines` | integer | No | Number of visible scrollback lines when `include_history` is true (default: 42, matching a realistic Packet Tracer CLI window). (default: `42`) |
| `combine` | boolean | No | Combine all commands into a single terminal image instead of one image per command. (default: `false`) |
| `max_columns` | integer | No | Column width at which long output lines wrap. (default: `100`) |
| `annotations` | object[] | No | Optional right-margin callout notes anchored to 1-based line numbers. |

### `pt_capture_pc_command`

Run a Command Prompt command (`ping`, `ipconfig`, `tracert`, `arp -a`) on a Packet Tracer PC, Laptop, or Server (or snapshot its current Command Prompt screen) and save an authentic Packet Tracer 9 Desktop Command Prompt screenshot (SVG and/or 2x PNG). Includes real scrollback history by default.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | End-device name (PC, Laptop, or Server, e.g. 'PC0', 'A'). |
| `command` | string | No | Command Prompt command (e.g. 'ping 192.168.2.10', 'ipconfig', 'ipconfig /all', 'tracert 10.0.0.2', 'arp -a'). Omit to snapshot the current live Command Prompt screen. |
| `theme` | `"pc-cmd"` \| `"dark"` \| `"pt-classic"` \| `"putty"` \| `"high-contrast"` | No | Terminal theme (defaults to 'pc-cmd' for authentic Packet Tracer 9 Command Prompt styling). (default: `"pc-cmd"`) |
| `format` | `"svg"` \| `"png"` \| `"both"` | No | Output image format: svg, png, or both (default). (default: `"both"`) |
| `output_path` | string | No | Optional output path. Relative paths resolve under STU_PT_OUTPUT_DIR (default ./stu-pt-output/). |
| `include_history` | boolean | No | Include the real live Packet Tracer Command Prompt scrollback history (previous pings, failures, ipconfig outputs) above the new command (default: true). Set to false for clean single-command output only. (default: `true`) |
| `history_lines` | integer | No | Number of visible scrollback lines when `include_history` is true (default: 42). (default: `42`) |
| `timeout_ms` | integer | No | Optional timeout in milliseconds to wait for command completion. |

### `pt_render_terminal` *(offline)*

Render arbitrary CLI or Command Prompt text into a crisp terminal-window SVG and/or 2x PNG image offline (no live Packet Tracer connection needed). Use this to format saved outputs, PC ping transcripts, or custom annotated terminal snippets for reports.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | Yes | Window title bar label (e.g. 'R1 - CLI', 'PC0 - Command Prompt'). |
| `text` | string | Yes | Terminal output text to render (newlines preserved). |
| `theme` | `"pt-classic"` \| `"dark"` \| `"putty"` \| `"high-contrast"` \| `"pc-cmd"` | No | Terminal color/chrome theme: pt-classic (default), dark, putty, high-contrast, or pc-cmd. (default: `"pt-classic"`) |
| `format` | `"svg"` \| `"png"` \| `"both"` | No | Output image format: svg, png, or both (default). (default: `"both"`) |
| `output_path` | string | No | Optional output path. Relative paths resolve under STU_PT_OUTPUT_DIR (default ./stu-pt-output/). |
| `max_columns` | integer | No | Maximum character columns before wrapping long lines. (default: `100`) |
| `show_window_chrome` | boolean | No | Whether to draw the terminal window title bar and chrome. (default: `true`) |
| `annotations` | object[] | No | Optional right-margin callout notes anchored to 1-based line numbers. |

### `pt_screenshot`

Capture the Packet Tracer Logical workspace canvas as a PNG or JPG image. Use this to include a topology diagram in your lab report. Saves the image to disk and returns the absolute file path.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `format` | `"PNG"` \| `"JPG"` | No | Image format. PNG is lossless and recommended for lab reports. (default: `"PNG"`) |
| `output_path` | string | No | Output file path. Relative paths resolve against STU_PT_OUTPUT_DIR (default ./stu-pt-output/). |

## Reports

### `pt_export_report`

Collect live topology screenshots, addressing table, optional ping matrix, and terminal-style CLI/PC screenshots from Packet Tracer and export a polished university lab report in Microsoft Word (.docx), self-contained print-to-PDF HTML (.html), and/or Markdown (.md). Returns the absolute paths of all generated files.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | Yes | Report title (e.g. 'Workshop: Static & Default Routing'). |
| `student` | object | No | Optional student metadata printed on the title block. |
| `course` | string | No | Optional course name or code (e.g. 'Computer Networks — Lab 4'). |
| `format` | `"md"` \| `"html"` \| `"docx"`[] | No | Export formats to generate: 'docx' (Microsoft Word), 'html' (self-contained print-to-PDF), and/or 'md' (Markdown). (default: `["docx","md"]`) |
| `output_dir` | string | No | Directory where the report and captures/ folder will be written. Relative paths resolve under STU_PT_OUTPUT_DIR. |
| `default_theme` | `"pt-classic"` \| `"dark"` \| `"putty"` \| `"high-contrast"` \| `"pc-cmd"` | No | Default terminal screenshot theme for IOS CLI captures. (default: `"pt-classic"`) |
| `include_history` | boolean | No | Include live Packet Tracer console scrollback history in CLI and Command Prompt screenshots (default: true). (default: `true`) |
| `history_lines` | integer | No | Number of visible scrollback lines per screenshot when `include_history` is true (default: 42). (default: `42`) |
| `include` | object | No | Toggle automatic report sections gathered from the live Packet Tracer canvas. (default: `{"topology_screenshot":true,"addressing_table":true,"ping_matrix":false}`) |
| `sections` | object[] | No | Ordered lab sections containing prose answers, router/switch CLI screenshots, and PC Command Prompt captures. (default: `[]`) |
| `save_pkt` | string | No | Optional filename or path to also save the live Packet Tracer `.pkt` file alongside the report. |

## CLI & Diagnostics

### `pt_run_cli`

Execute a Cisco IOS CLI command on a router or switch and return its console output. Automatically handles initial configuration prompts, privilege elevation, and --More-- pagination without losing output. Syslog events emitted during command execution are separated into structured logs.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Router or switch name (e.g. 'R1', 'Switch_A'). |
| `command` | string | Yes | Cisco IOS CLI command to execute (e.g. 'show ip interface brief', 'show ip route'). |
| `timeout_ms` | integer | No | Command execution timeout in milliseconds. |

### `pt_run_cli_bulk`

Push a multi-line Cisco IOS configuration block (such as interfaces, routing, VLANs, or ACLs) to a router or switch. Automatically prepares the CLI, strips unsupported trunk encapsulation commands on 2960/3650 switches, and returns the command count and console output. Supports dry_run / Teach Mode to preview commands without applying them.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Router or switch name (e.g. 'R1', 'SW1'). |
| `commands` | string[] \| string | Yes | CLI commands to send in sequence, as an array of lines (preferred) or a newline-separated string. |
| `tail_chars` | integer | No | Maximum trailing console output characters to return. (default: `2000`) |
| `dry_run` | boolean | No | Teach mode: if true (or STU_PT_TEACH_MODE=1), return the exact IOS commands instead of applying them to Packet Tracer. |

### `pt_send_raw`

Escape hatch: ship arbitrary JS to PT's Script Engine. Useful when no specialised tool covers what you need yet — call e.g. 'return ipc.network().getDeviceCount();'. Prefer the typed tools when they exist.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | Yes | JS expression evaluated inside PT's Script Engine. Implicitly wrapped, so you can use 'return ...'. |
| `wait` | boolean | No | If true (default) wait for the return value; if false, fire-and-forget. |
| `timeout_ms` | integer | No |  |

### `pt_show_running`

Capture `show running-config` (optionally filtered by `| section`) on one or more routers or switches. Automatically handles privileged mode entry and `--More--` pagination so complete configurations are returned. Use this to verify lab configs or compare changes.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `devices` | string[] | Yes | Routers or switches to inspect. Each device is queried separately. |
| `section` | string | No | Optional `\| section <pattern>` filter — e.g. 'interface GigabitEthernet0/0', 'router ospf', 'ipv6'. |
| `tail_chars` | integer | No | Per-device maximum output length in characters. (default: `20000`) |

## Simulation & Testing

### `pt_ping`

Send ICMP echo requests from a PC, switch, or router to a target IP and return parsed metrics. Output includes sent, received, lost, and success rate percentages alongside the raw transcript. Note: the first ping in a lab often drops 1-2 packets while ARP table entries resolve.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Device originating the ping (PC, router, or switch name). |
| `target` | string | Yes | Destination IPv4 or IPv6 address (e.g. '192.168.1.1', '2001:DB8:1::1'). |
| `timeout_ms` | integer | No | Timeout in milliseconds to wait for ping completion. (default: `25000`) |

### `pt_send_pdu`

Originate a Simple PDU (ICMP echo) from one device to another via UserCreatedPDU.addSimplePdu. Returns the scenario index assigned to the PDU. Verified on PT 9 real (probe-fase8b 2026-04-29).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | string | Yes | Source device name (must be on the canvas). |
| `dest` | string | Yes | Destination device NAME — IPs are not accepted by UserCreatedPDU.addSimplePdu. |
| `fire` | boolean | No | If true, fire the PDU immediately after creating it (then delete it from the scenario list to leave no trace). If false, just queue it and leave it in the PDU list. (default: `true`) |
| `switch_to_simulation` | boolean | No | If true, switch PT to Simulation Mode before firing — required for the PDU to actually move. Set to false if the caller handles the mode toggle. (default: `true`) |

### `pt_simulation_mode`

Toggle PT between Realtime and Simulation modes via the RSSwitch widget. After switching to simulation, use pt_send_pdu to originate traffic and pt_simulation_play to advance.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `"simulation"` \| `"realtime"` | Yes | 'simulation' switches PT to Simulation Mode (event-by-event). 'realtime' switches back to Realtime. |

### `pt_simulation_play`

Trigger one of the SimulationPanel buttons (play/back/forward/reset). Caller must put PT in Simulation mode first via pt_simulation_mode — calling 'play' from Realtime is a no-op.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"play"` \| `"back"` \| `"forward"` \| `"reset"` | Yes | Simulation panel action: 'play' = auto-capture, 'forward' = single step forward, 'back' = step back, 'reset' = wipe captured events. |

### `pt_traceroute`

Trace the network path and intermediate hops from a device to a destination address. Dispatches appropriate command variants automatically for both PCs (tracert) and IOS routers (traceroute). Returns a structured list of hops with round-trip indicators and completion status.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Device originating the trace (PC or router). |
| `target` | string | Yes | Destination IPv4 or IPv6 address (e.g. '10.0.0.1'). |
| `timeout_ms` | integer | No | Timeout in milliseconds to wait for traceroute to complete. (default: `60000`) |

## Topology & Canvas

### `pt_add_canvas_annotation`

Decorate the canvas with a note, line, or circle (LogicalWorkspace.addNote/drawLine/drawCircle). Returns the new annotation's UUID.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"note"` \| `"line"` \| `"circle"` | Yes | Annotation primitive to draw. |
| `x` | number | Yes | note/circle: x; line: x1. |
| `y` | number | Yes | note/circle: y; line: y1. |
| `x2` | number | No | line: x2. |
| `y2` | number | No | line: y2. |
| `radius` | number | No | circle: radius (px). |
| `text` | string | No | note: text content. |
| `font_size` | integer | No | note: font size. (default: `12`) |
| `thickness` | integer | No | line/circle: stroke thickness. (default: `2`) |
| `r` | integer | No | RGB red. (default: `0`) |
| `g` | integer | No | RGB green. (default: `0`) |
| `b` | integer | No | RGB blue. (default: `0`) |
| `alpha` | integer | No | Alpha. (default: `255`) |

### `pt_add_device`

Place a single device in the active Logical workspace and rename it to the requested name. Coordinates are in PT's logical canvas units. Auto-placement policy when x/y are omitted: routers at y=100, accesspoints at y=175, switches at y=250, endpoints at y=400, servers at y=480, clouds at y=20; X advances 250 units per slot in the same row. The server reads the live canvas to pick the next free column for the device's category. To get a clean topology pass x/y for nothing — let the grid do the work, then call pt_auto_layout at the end if you want to re-align everything.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Final name to assign to the device, e.g. 'R1'. |
| `model` | string | Yes | PT model (e.g. '2911', 'PC-PT') or one of the aliases from pt_list_devices. |
| `x` | number | No | Logical-view X coordinate. Optional — when omitted, the server places the device on a clean grid based on its category (router=top row, switch=mid, endpoints=bottom). Recommended: leave x/y blank unless you have a specific reason to override placement; manual coordinates often produce ugly canvases. |
| `y` | number | No | Logical-view Y coordinate. Optional — see `x` for the auto-placement policy. |

### `pt_add_module`

Install a hardware module (NIM-2T, HWIC-2T, NIM-ES2-4, ...) into a router slot. Idempotent: if the slot already holds the requested module, returns success without touching the chassis.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Router name to install the module into. |
| `slot` | string | Yes | Slot path 'chassis/bay', e.g. '0/1'. |
| `module` | string | Yes | Module model, e.g. 'NIM-2T', 'HWIC-2T', 'NIM-ES2-4'. |

### `pt_auto_layout`

Re-grid the entire live canvas into a clean topology-aware layout. Reads every device, classifies it (router / switch / AP / endpoint / server / cloud), and assigns coordinates by category row plus column alignment with the parent device (switches column-aligned with their router, endpoints with their switch). Use this after the AI has built a topology with manual coordinates to make it look like a recipe-built lab. Idempotent: running it twice on the same canvas is a no-op.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `dryRun` | boolean | No | When true, return the planned moves without applying them. Useful for previewing the new layout before committing. |

### `pt_clear_canvas`

Wipe the entire PT canvas (File > New) via AppWindow.fileNew. DESTRUCTIVE: removes every device, link, note and PDU in the active workspace. Requires confirm=true. Returns the list of device names that existed before the wipe.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm` | boolean | Yes | Must be literally true. Forces the caller to acknowledge that this wipes the canvas. |
| `prompt_user` | boolean | No | If true, PT shows the 'save before new?' modal interactively. Default false skips the modal entirely (correct for scripted use). (default: `false`) |

### `pt_create_link`

Cable two existing devices together. Cable defaults to copper straight-through; use 'cross' for switch trunks, 'serial' for WAN P2P (requires HWIC-2T module on ISR routers — add it first with pt_add_module), 'fiber', 'console' or 'coaxial' as needed. Convention: 'straight' for LAN segments (router↔switch, switch↔PC); 'serial' for WAN exterior P2P between routers crossing a public/ISP network. SAFETY: refuses straight/cross between two routers without `confirm_internal_lan: true` to prevent the common mistake of cabling WAN exterior links with Ethernet.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device_a` | string | Yes |  |
| `port_a` | string | Yes | Full port name on device_a, e.g. 'GigabitEthernet0/0'. |
| `device_b` | string | Yes |  |
| `port_b` | string | Yes |  |
| `cable` | `"straight"` \| `"cross"` \| `"fiber"` \| `"console"` \| `"coaxial"` \| `"serial"` | No |  (default: `"straight"`) |
| `confirm_internal_lan` | boolean | No | Required forcing flag when both endpoints are routers and cable="straight" or "cross". Without it the call is REFUSED — the server assumes you may have intended a WAN serial link (the most common LLM mistake). Pass true only after confirming with the user that this is an internal Ethernet segment between two routers (e.g., a small inter-router LAN within the same office), not a WAN exterior point-to-point link. |

### `pt_delete_device`

Remove a device (and all of its links) from the active workspace. Self-verifies the deletion by re-snapshotting the topology.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Exact device name to remove. |

### `pt_delete_link`

Remove the cable attached to one specific device port. Use this when you need to re-cable without deleting either device.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Either endpoint device of the link. |
| `port` | string | Yes | Port on `device` whose link should be cut. |

### `pt_manage_clusters`

Inspect and prune logical clusters on the canvas. `list` returns the cluster tree; `remove` deletes a cluster by id; `uncluster` dissolves it while keeping its members. Note: programmatic cluster *creation* is not reachable from PT 9's IPC (requires UI selection).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"list"` \| `"remove"` \| `"uncluster"` | Yes | Operation to perform. |
| `cluster_id` | string | No | Cluster ID for remove/uncluster (from `list`). |
| `keep_contents` | boolean | No | On `remove`: keep child devices on the canvas (true) or delete them (false). (default: `true`) |

### `pt_move_device`

Reposition a device on the logical canvas via Device.moveToLocation(x, y).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Device to move. |
| `x` | number | Yes | New X coordinate on the logical canvas. |
| `y` | number | Yes | New Y coordinate on the logical canvas. |

### `pt_rename_device`

Rename a device. Refuses if the new name is already taken so you don't accidentally collapse two devices into one.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `old_name` | string | Yes | Current device name. |
| `new_name` | string | Yes | Desired new name. |

### `pt_set_device_power`

Toggle a device's power switch (Device.setPower). Idempotent: returns 'already' when the requested state is already in effect. After power-on the boot dialog is dismissed via skipBoot.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Device name on the live canvas. |
| `on` | boolean | Yes | Target power state: true=on, false=off. |

### `pt_set_pc`

Configure an endpoint (PC, laptop, server) for static IP or DHCP. In static mode you must pass ip+mask; gateway is optional.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Endpoint name. |
| `mode` | `"static"` \| `"dhcp"` | Yes | Addressing mode. |
| `port` | string | No | Port to configure for static mode. (default: `"FastEthernet0"`) |
| `ip` | string | No | IPv4 address; required when mode='static'. |
| `mask` | string | No | Subnet mask; required when mode='static'. |
| `gateway` | string | No | Default gateway; optional, static mode only. |

## Inspection & Analysis

### `pt_explain_canvas`

Render a human-readable narration of the live workspace: inventory counts, per-router subnets, dangling addresses. Read-only.

_No parameters._

### `pt_forecast`

Dry-run estimator. Build the blueprint for a recipe and report what it would allocate, without touching the live canvas.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | Yes | Recipe key, e.g. 'chain', 'star', 'branch_office'. |
| `params` | object | No | Recipe-specific parameters; see pt_list_recipes for shape. (default: `{}`) |

### `pt_generate_configs`

Offline generator. Builds a recipe blueprint and synthesises the IOS CLI each device would receive — without touching PT or the bridge. Useful for documentation, classroom material, or replicating the lab on real hardware. Endpoints (PCs, APs, phones) get human-readable notes instead of CLI.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | Yes | Recipe key (see pt_list_recipes). |
| `params` | object | No | Recipe-specific parameters. (default: `{}`) |
| `format` | `"summary"` \| `"json"` \| `"concat"` | No | summary: human report. json: structured devices array. concat: every device's IOS config back-to-back, banner-separated. (default: `"summary"`) |

### `pt_get_device_details`

Inspect a single device: model, type, power state, and live port-by-port snapshot (IP, mask, connection state).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Device name to inspect. |

### `pt_inspect_canvas`

Snapshot the live workspace and report duplicate IPs, unaddressed router uplinks, mismatched router-peer subnets, and similar findings. Read-only.

_No parameters._

### `pt_inspect_ports`

Live per-port status: link presence, isPortUp, isProtocolUp, MAC, IP/mask, wireless flag — read directly from the Port objects.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Device name on the live canvas. |
| `onlyLinked` | boolean | No | Filter to ports that have a link attached. (default: `false`) |

### `pt_query_topology`

Snapshot the live topology in Packet Tracer: returns name, model, classname and coordinates for every user-placed device.

_No parameters._

### `pt_read_acl`

Read the live ACLs of a router via AclProcess: per-ACL canonical commands as PT would render them in 'show running-config | section access-list'.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Router (or any device exposing AclProcess). |

### `pt_read_project_metadata`

Read NetworkFile metadata of the .pkt currently open in PT: description, file version, and the on-disk filename if it has been saved.

_No parameters._

### `pt_read_vlans`

Read the live VLAN database of a switch via VlanManager (id, name, default flag, MAC table size).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Switch name (or any device exposing a VlanManager process). |

### `pt_show_bgp_routes`

Run `show ip bgp` on a router and parse the BGP table into rows (status, network, next-hop, metric, localpref, weight, path). PT 9 has no BgpProcess JS API, so this is the only way to inspect live BGP state.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Router running BGP. |
| `vrf` | string | No | Optional VRF name. If unset, uses the global table. |

## Configuration & Recipes

### `pt_apply_advanced_routing`

Apply advanced routing intents (BGP, HSRP, IGP extras like passive-interface and default-information originate) to routers on the live canvas. Each block writes running→startup per device.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `bgp` | object[] | No | BGP intents per router (router bgp <asn> with neighbors/networks/redistribute). |
| `hsrp` | object[] | No | HSRP per-interface intents (standby <group> ip <vip> with priority/preempt). |
| `igpExtras` | object[] | No | Extra directives for existing OSPF/EIGRP/RIP processes (passive-interface, default-information originate). |

### `pt_apply_ipv6`

Configure dual-stack IPv6 on routers (unicast-routing, interface addresses, OSPFv3, static routes) and IPv6 hosts on PCs/laptops/servers.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `unicastRouting` | boolean | No | Emit `ipv6 unicast-routing` (default true) on every router with IPv6 intents. |
| `interfaces` | object[] | No |  |
| `ospf` | object[] | No |  |
| `staticRoutes` | object[] | No |  |
| `endpoints` | object[] | No | PC/Laptop/Server IPv6 host configuration via `ipv6config`. |

### `pt_apply_services`

Apply L3 services (ACLs, NAT, DHCP server/relay, NTP, Syslog) to the live canvas. Each block is grouped per device and pushed as one bulk per service.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `acls` | object[] | No | Standard / extended ACLs (optionally bound to interfaces). |
| `nat` | object[] | No | NAT roles, statics, pools and overload directives per device. |
| `dhcpPools` | object[] | No | DHCP server pools. |
| `dhcpRelays` | object[] | No | DHCP relay (helper-address) per interface. |
| `ntp` | object[] | No | NTP servers per device. |
| `syslog` | object[] | No | Syslog hosts and trap level per device. |

### `pt_apply_switching`

Apply L2 switching intents (VLANs, trunks, port-security, EtherChannel) to switches on the live canvas. Each helper groups CLI per device and pushes one bulk per switch.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `vlans` | object[] | No | VLAN definitions and access ports per switch. |
| `trunks` | object[] | No | Trunk port configuration per switch. |
| `portSecurity` | object[] | No | Port-security rules per switch. |
| `etherChannels` | object[] | No | EtherChannel groups per switch (>=2 ports each). |

### `pt_apply_voip`

Configure CME (telephony-service / ephone-dn / ephone) on a router and voice VLANs on an access switch through IOS CLI.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `cme` | object[] | No | CME (telephony-service) blocks per router. |
| `ephoneDns` | object[] | No | ephone-dn extensions to provision on a CME router. |
| `ephones` | object[] | No | ephone (phone) registrations referencing ephone-dn tags. |
| `voiceVlans` | object[] | No | Switchport voice/data VLAN configuration for IP Phone access ports. |

### `pt_apply_wireless`

Apply wireless SSID/security on APs and associate wireless clients through Packet Tracer's native WirelessServer/WirelessClient IPC processes.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `aps` | object[] | No | AP SSIDs/security to configure through PT native WirelessServer API. |
| `clients` | object[] | No | Wireless client associations to configure through PT native WirelessClient API. |

### `pt_configure_server_dhcp`

Configure DHCP service on a Server-PT device using the native IPC API (addPool + setNetworkMask/setDefaultRouter/setStartIp/setEndIp/setDnsServerIp/setMaxUsers + addExcludedAddress). LIMITS — confirmed dead-ends in PT 9.0 via prototype reflection: (a) TFTP server / DHCP option-150 has NO setter on Server-PT — pool exposes getTftpAddress but no setTftpAddress, no setOption*, no setBootFile, no setSiaddr; addNewPool's documented 8-arg signature returns Invalid arguments for arities 1..12. (b) Domain name has no setter (only getDomainName). (c) maxUsers and endIp are coupled: PT recalculates one when you set the other. If you pass both, ensure they're consistent (endIp - startIp + 1 == maxUsers); the tool applies maxUsers first then endIp, so endIp wins. If you need option-150 (typical for VoIP IP phones), DO NOT use this tool — tell the user to make the router the DHCP server instead, and call pt_apply_services with dhcpPools[].tftpServer set: that emits CLI `option 150 ip <ip>` inside the pool.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Server-PT device name (must already exist on canvas). |
| `port` | string | No | Port name where the DHCP service runs. Default: FastEthernet0. |
| `enable` | boolean | No | Toggle the DHCP service on/off. |
| `pools` | object[] | No | DHCP pools to create or update. Idempotent: if a pool with the same name exists, only its setters are reapplied. Network address is inferred by PT from startIp + subnetMask (no setter exposed). |
| `removePools` | string[] | No | Pool names to delete first. |
| `exclusions` | object[] | No | Excluded address ranges (port-wide, not per pool). |

### `pt_configure_subinterface`

Build router-on-a-stick: configure 802.1Q subinterfaces on a router's parent interface (one block per VLAN). Brings the parent up first, then emits 'encapsulation dot1Q <vlan> + ip address' per VLAN. Pair with a switch trunk (pt_apply_switching trunk) to complete the inter-VLAN routing setup.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | string | Yes | Router name on the live canvas. |
| `parent` | string | Yes | Full parent interface name (e.g. 'GigabitEthernet0/0'). Brought up with 'no shutdown' before subinterfaces are configured. |
| `subinterfaces` | object[] | Yes | One block per VLAN. Each generates 'interface <parent>.<vlan>' + 'encapsulation dot1Q <vlan>' + 'ip address ...'. |

### `pt_cook_topology`

Build a recipe's blueprint and apply it to the live workspace: places devices, wires links, addresses ports, configures routing. Idempotent against partial state.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | Yes | Recipe key (chain, star, branch_office). See pt_list_recipes. |
| `params` | object | No | Recipe-specific parameters. (default: `{}`) |

### `pt_mend_canvas`

Inspect the live workspace and apply safe, conservative repairs (e.g. powering on devices that have active links). Reports remaining issues that need a human decision.

_No parameters._

## Files & Snapshots

### `pt_diff_snapshots`

Compare two snapshots (or one snapshot vs the live canvas) and describe what changed: added/removed devices and links, changed IPs, masks, link state and power state.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `before` | string | Yes | Saved snapshot name, or 'live' to capture the canvas now. |
| `after` | string | No | Saved snapshot name, or 'live' (default) for the live canvas. (default: `"live"`) |

### `pt_list_snapshots`

List every persisted canvas snapshot, sorted from newest to oldest.

_No parameters._

### `pt_load_snapshot`

Load a saved snapshot and diff it against the live workspace. Reports added/removed/changed devices, ports, and links since the snapshot was taken.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Snapshot identifier to load and diff against the live canvas. |

### `pt_open_pkt`

Open a .pkt file into the active PT workspace via AppWindow.fileOpen. PT's native fileOpen MERGES the file with the existing canvas; pass replace=true (default) to wipe the canvas first via fileNew(false). PT 9 encrypts .pkt with per-file key derivation so the leading bytes are not a stable magic; validity is decided by FileOpenReturnValue=0 from PT. Returns deviceCount before/after.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Absolute path to a .pkt file readable by the Packet Tracer process. Pkz files are NOT supported. |
| `replace` | boolean | No | If true (default), the canvas is wiped via fileNew(false) before opening so the loaded file's devices fully replace the current canvas. If false, fileOpen MERGES the file into the live canvas (PT 9's native behavior). (default: `true`) |

### `pt_open_pkt_from_bytes`

Open a .pkt provided as base64 bytes (no permanent file required on disk). The server asks PT to write the bytes to a temp path inside its user folder via SystemFileManager.writeBinaryToFile, then triggers fileNew(false)+fileOpen and removes the temp. PT 9 encrypts .pkt with per-file key derivation so there is no stable magic to validate server-side; validity is decided by FileOpenReturnValue=0 from PT. Useful when bytes come from a remote source (DB, MCP client) and the server filesystem is not visible to PT.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `bytes_base64` | string | Yes | Base64-encoded contents of a .pkt file. PT 9 encrypts .pkt with a per-file key derivation, so there is no stable magic to validate server-side; the authoritative validity check is FileOpenReturnValue=0 after PT loads the blob. |
| `replace` | boolean | No | If true (default), the canvas is wiped via fileNew(false) before opening so the loaded file's devices fully replace the current canvas. If false, fileOpen MERGES into the live canvas (PT 9 native behavior). (default: `true`) |
| `max_bytes` | integer | No | Maximum decoded blob size to accept (bytes). Default 2 MB. The bridge transports the full base64 inline, so very large blobs strain the request payload; use pt_open_pkt(path) for large files instead. (default: `2000000`) |

### `pt_save_pkt`

Save the active PT canvas to a .pkt file at an absolute path via AppWindow.fileSaveAsNoPrompt. Returns the final size in bytes and a SHA-1 checksum for verification. Pkz format is intentionally not supported (PT 9 silently fails to write it).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Absolute filesystem path where the .pkt should be written. Parent directory is created if missing. Existing files are overwritten without confirmation. |
| `overwrite` | boolean | No | If false and the target file already exists, the tool fails before calling PT. Default true (matches fileSaveAsNoPrompt semantics). (default: `true`) |

### `pt_save_pkt_to_bytes`

Save the active PT canvas and return the .pkt as base64 bytes (no permanent file). PT writes to a temp path inside its own user folder via fileSaveAsNoPrompt, the server reads the bytes back chunked through SystemFileManager.getFileBinaryContents, then PT removes the temp. Useful when the server and PT do not share a filesystem (remote PT) or the caller wants the bytes in-memory.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `max_bytes` | integer | No | Maximum decoded file size to accept (bytes). Default 5 MB; raise for unusually large canvases. (default: `5000000`) |

### `pt_save_snapshot`

Capture the current live workspace and persist it to disk under the given name. Useful for diff/audit later.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Snapshot identifier; only letters, digits, dot, dash, underscore. |
