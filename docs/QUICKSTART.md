# Quick Start Guide

Get `stu-packet-tracer-mcp` running with Cisco Packet Tracer 9 in under five minutes.

---

## Prerequisites

- **Cisco Packet Tracer 9** (9.0 or newer) installed on Windows, Linux, or macOS
- **Bun >= 1.2** runtime (used by `bunx` and `bun run`)
- An MCP-compatible AI client (Claude Desktop, Antigravity, Cursor, VS Code Copilot MCP, or Gemini CLI)

---

## Step 1: Install Bun

### Windows (PowerShell)

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Close and reopen PowerShell, then confirm:

```powershell
bun --version
```

### Linux / macOS

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

---

## Step 2: Run or Configure the MCP Server

### Option A: Stdio mode (recommended for most AI clients)

Your MCP client starts `stu-packet-tracer-mcp` automatically as a subprocess:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "command": "bunx",
      "args": ["stu-packet-tracer-mcp", "--stdio"]
    }
  }
}
```

See [docs/CLIENTS.md](CLIENTS.md) for exact file paths and configurations for Claude Desktop, Antigravity, Cursor, VS Code, and Gemini CLI.

### Option B: Standalone HTTP mode (for terminals or multiple clients)

Start the server manually:

```bash
bunx stu-packet-tracer-mcp
```

It binds two localhost-only ports:

- **MCP HTTP endpoint:** `http://127.0.0.1:39001/mcp`
- **Packet Tracer Bridge:** `http://127.0.0.1:54321`

> [!TIP]
> Running from a cloned repository? Replace `bunx stu-packet-tracer-mcp` with `bun run src/index.ts` inside the repo directory.

---

## Step 3: Load the Bridge Extension in Packet Tracer 9

1. Open **Cisco Packet Tracer 9**.
2. Open your `.pkt` lab (or start with a blank workspace).
3. Go to **Extensions -> Scripting -> Configure PT Script Modules...** (or press **Ctrl+Shift+U**).
4. Click **Add** and select `extension/dist/stu-mcp-bridge.pts` (see [docs/BUILD_EXTENSION.md](BUILD_EXTENSION.md) if you are building the `.pts` package from source in `extension/src/`).
5. Open **Extensions -> Scripting -> Student MCP Bridge**.
6. Verify the panel shows a green dot: **Connected · Bridge v1**.

> [!NOTE]
> Need a quick test without loading a `.pts` file first? See the paste-in bootstrap fallback in [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md#emergency-paste-in-bootstrap).

---

## Step 4: Verify With `pt_bridge_status`

In your AI client, ask:

> "Run `pt_bridge_status` and tell me if Packet Tracer is connected."

Expected result:

- `connected: true`
- `protocol: 1` (or `0` when using a legacy `.pts` extension)
- `bridge_port: 54321`

You can also test offline tools right away even without Packet Tracer open:

- `pt_subnet_calc` — calculate IPv4 subnets or a VLSM plan
- `pt_explain_output` — explain a pasted Cisco IOS `show ip route` or `show vlan brief` output
- `pt_render_terminal` — render sample CLI text into a styled SVG/PNG screenshot

---

## Optional Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MCP_HOST` | `127.0.0.1` | Host for HTTP MCP transport |
| `MCP_PORT` | `39001` | Port for HTTP MCP transport |
| `BRIDGE_PORT` | `54321` | Localhost port polled by the PT 9 bridge extension |
| `STU_PT_OUTPUT_DIR` | `./stu-pt-output` | Folder where screenshots and lab reports are written |
| `STU_PT_TEACH_MODE` | *(unset / off)* | Set to `1` to return study guides and IOS commands without changing the canvas |
| `STU_PT_BRIDGE_TOKEN` | *(unset)* | Optional shared secret (`X-Stu-Token` header) for the local bridge |
| `STU_PT_DEBUG` | *(unset)* | Set to `1` to log per-tool execution timings to `stderr` |
