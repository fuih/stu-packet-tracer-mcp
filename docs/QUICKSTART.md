# Quick Start Guide

Get `stu-packet-tracer-mcp` running with Cisco Packet Tracer 9 in under five minutes.

---

## Prerequisites

- **Cisco Packet Tracer 9** (9.0 or newer) installed on Windows, Linux, or macOS
- An MCP-compatible AI client (Claude Code, Claude Desktop, Antigravity, Cursor, VS Code, Gemini CLI, or Codex CLI)
- **Bun >= 1.2** *(only needed if running from source — prebuilt standalone binaries on [GitHub Releases](https://github.com/fuih/stu-packet-tracer-mcp/releases/latest) do not require Bun)*

---

## Step 1: Get & Start the MCP Server

### Option A: Prebuilt standalone binary (recommended — no Bun required)

1. Download **`stu-mcp-bridge.pts`** and the binary matching your OS from [GitHub Releases](https://github.com/fuih/stu-packet-tracer-mcp/releases/latest).
2. Run it in a terminal (for Streamable HTTP mode on `:39001`):

```bash
# Linux (x64)
chmod +x stu-packet-tracer-mcp-linux-x64
./stu-packet-tracer-mcp-linux-x64

# macOS (Apple Silicon)
chmod +x stu-packet-tracer-mcp-darwin-arm64
xattr -d com.apple.quarantine stu-packet-tracer-mcp-darwin-arm64  # if macOS prompts about unsigned binary
./stu-packet-tracer-mcp-darwin-arm64
```

```powershell
# Windows (PowerShell)
.\stu-packet-tracer-mcp-windows-x64.exe
```

### Option B: Run from source with Bun

Install Bun (`>= 1.2`) if not already installed:

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash
bun --version
```

```powershell
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
bun --version
```

Clone the repo, install dependencies, and start the server:

```bash
git clone https://github.com/fuih/stu-packet-tracer-mcp.git
cd stu-packet-tracer-mcp
bun install
bun start
```

> [!NOTE]
> The server binds two localhost-only ports:
> - **MCP HTTP endpoint:** `http://127.0.0.1:39001/mcp` *(chosen to avoid PT 9's native `:39000` IPC)*
> - **Packet Tracer Bridge:** `http://127.0.0.1:54321`
>
> If you prefer **stdio** mode (e.g., Claude Desktop), do **not** run `bun start` manually — your AI client starts the server automatically with `--stdio`. See [docs/CLIENTS.md](CLIENTS.md) for every client config.

---

## Step 2: Load & Start the Bridge Extension in Packet Tracer 9

1. Open **Cisco Packet Tracer 9**.
2. Open your `.pkt` lab (or start with a blank workspace).
3. Go to **Extensions -> Scripting -> Configure PT Script Modules...**
4. Click **Add** and select **`stu-mcp-bridge.pts`** (from [GitHub Releases](https://github.com/fuih/stu-packet-tracer-mcp/releases/latest) or `extension/dist/stu-mcp-bridge.pts` in a cloned repo; see [docs/BUILD_EXTENSION.md](BUILD_EXTENSION.md) if packaging from `extension/src/`).
5. Select **Student MCP Bridge** in the module list and click **Start** (or open **Extensions -> Scripting -> Student MCP Bridge**).
6. Confirm the header shows a green **Connected** pill and **V1** (and displays your AI agent name once a client initializes).

> [!NOTE]
> Need a quick test without loading a `.pts` file first? See the paste-in bootstrap fallback in [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md#8-emergency-paste-in-bootstrap).

---

## Step 3: Connect Your AI Client & Verify With `pt_bridge_status`

Configure your AI client using [docs/CLIENTS.md](CLIENTS.md) (for Claude Code, run `claude mcp add --transport http stu-packet-tracer http://127.0.0.1:39001/mcp`), then ask:

> "Run `pt_bridge_status` and tell me if Packet Tracer is connected."

Expected result:

- `connected: true`
- `protocol: v1`
- `port: 54321`

You can also run local diagnostics anytime:

```bash
bun run doctor   # or ./stu-packet-tracer-mcp --doctor
```

And you can test offline tools even without Packet Tracer open:

- `pt_subnet_calc` — calculate IPv4 subnets or a VLSM plan
- `pt_explain_output` — explain a pasted Cisco IOS `show ip route` or `show vlan brief` output
- `pt_render_terminal` — render sample CLI text into a styled SVG/PNG screenshot

---

## Optional Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MCP_HOST` / `STU_PT_MCP_HOST` | `127.0.0.1` | Host for HTTP MCP transport |
| `MCP_PORT` / `STU_PT_MCP_PORT` | `39001` | Port for HTTP MCP transport |
| `BRIDGE_PORT` / `STU_PT_BRIDGE_PORT` | `54321` | Localhost port polled by the PT 9 bridge extension |
| `STU_PT_OUTPUT_DIR` | `./stu-pt-output` | Folder where screenshots and lab reports are written |
| `STU_PT_TEACH_MODE` | *(unset / off)* | Set to `1` to return study guides and IOS commands without changing the canvas |
| `STU_PT_BRIDGE_TOKEN` | *(unset)* | Optional shared secret (`X-Stu-Token` header) for the local bridge |
| `STU_PT_DEBUG` | *(unset)* | Set to `1` to log per-tool execution timings to `stderr` |
