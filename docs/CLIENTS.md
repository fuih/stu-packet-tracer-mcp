# MCP Client Configurations

Copy-paste configurations for popular AI clients.

> [!IMPORTANT]
> Only **one** instance of `stu-packet-tracer-mcp` can listen on bridge port `54321` at a time.
>
> - **Streamable HTTP mode** (`http://127.0.0.1:39001/mcp`): start the server yourself (`./stu-packet-tracer-mcp` or `bun start`) and connect one or more clients to `http://127.0.0.1:39001/mcp`.
> - **Stdio mode** (`--stdio`): the AI client spawns and stops the server automatically — stop any standalone terminal instance first so port `54321` is free.

Every stdio example below uses a downloaded binary path (`/absolute/path/to/stu-packet-tracer-mcp` — grab it from [GitHub Releases](https://github.com/fuih/stu-packet-tracer-mcp/releases/latest)). If you cloned the repo and run from source with Bun instead, swap `"command"` and `"args"` to:

```json
"command": "bun",
"args": ["run", "/absolute/path/to/stu-packet-tracer-mcp/src/index.ts", "--stdio"]
```

---

## Claude Code (CLI)

Start the server (`./stu-packet-tracer-mcp` or `bun start`), then run:

```bash
claude mcp add --transport http stu-packet-tracer http://127.0.0.1:39001/mcp
```

Verify inside Claude Code with `/mcp` — `stu-packet-tracer` should appear with all **72 tools**.

---

## Claude Desktop

Config file location:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

### Stdio (Recommended)

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "command": "/absolute/path/to/stu-packet-tracer-mcp",
      "args": ["--stdio"],
      "env": {
        "STU_PT_OUTPUT_DIR": "./stu-pt-output"
      }
    }
  }
}
```

*(Optional: add `"STU_PT_TEACH_MODE": "1"` inside `"env"` to enable study-only Teach Mode.)*

---

## Antigravity

Add to your Antigravity MCP configuration (`mcp_config.json`):

### Streamable HTTP

Start the server first (`./stu-packet-tracer-mcp` or `bun start`), then configure:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "serverUrl": "http://127.0.0.1:39001/mcp"
    }
  }
}
```

### Stdio

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "command": "/absolute/path/to/stu-packet-tracer-mcp",
      "args": ["--stdio"]
    }
  }
}
```

---

## Cursor

Config file location: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).

### Streamable HTTP

Start the server first, then configure:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "url": "http://127.0.0.1:39001/mcp"
    }
  }
}
```

### Stdio

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "command": "/absolute/path/to/stu-packet-tracer-mcp",
      "args": ["--stdio"]
    }
  }
}
```

---

## VS Code (GitHub Copilot / Continue / Cline)

Config file location: `.vscode/mcp.json` in your workspace (or VS Code User Settings).

### Streamable HTTP

Start the server first, then configure:

```json
{
  "servers": {
    "stu-packet-tracer": {
      "type": "http",
      "url": "http://127.0.0.1:39001/mcp"
    }
  }
}
```

### Stdio

```json
{
  "servers": {
    "stu-packet-tracer": {
      "type": "stdio",
      "command": "/absolute/path/to/stu-packet-tracer-mcp",
      "args": ["--stdio"]
    }
  }
}
```

---

## Gemini CLI

Config file location: `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project).

### Streamable HTTP

Start the server first, then configure:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "httpUrl": "http://127.0.0.1:39001/mcp"
    }
  }
}
```

### Stdio

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "command": "/absolute/path/to/stu-packet-tracer-mcp",
      "args": ["--stdio"]
    }
  }
}
```

---

## Codex CLI

Config file location: `~/.codex/config.toml`.

### Streamable HTTP

Start the server first, then configure:

```toml
[mcp_servers.stu-packet-tracer]
url = "http://127.0.0.1:39001/mcp"
```

### Stdio

```toml
[mcp_servers.stu-packet-tracer]
command = "/absolute/path/to/stu-packet-tracer-mcp"
args = ["--stdio"]
```
