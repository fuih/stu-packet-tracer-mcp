# MCP Client Configurations

Copy-paste configurations for popular AI clients.

> [!IMPORTANT]
> **Prefer `stdio` mode** whenever your client supports it — the client starts and stops the MCP server automatically, so you do not have to keep a separate terminal open. Use **HTTP mode** if you want to share a single running server across multiple clients or scripts.
>
> Only **one** instance of `stu-packet-tracer-mcp` can listen on bridge port `54321` at a time. Stop any other running instance before switching clients.

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
      "command": "bunx",
      "args": ["stu-packet-tracer-mcp", "--stdio"],
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

### Stdio (Recommended)

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

### Streamable HTTP

Start the server in a terminal first (`bunx stu-packet-tracer-mcp`), then configure:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "serverUrl": "http://127.0.0.1:39001/mcp"
    }
  }
}
```

---

## Cursor

Config file location: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).

### Stdio (Recommended)

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

### Streamable HTTP

Start `bunx stu-packet-tracer-mcp` first, then configure:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "url": "http://127.0.0.1:39001/mcp"
    }
  }
}
```

---

## VS Code (GitHub Copilot MCP)

Config file location: `.vscode/mcp.json` in your workspace (or VS Code User Settings).

### Stdio (Recommended)

```json
{
  "servers": {
    "stu-packet-tracer": {
      "type": "stdio",
      "command": "bunx",
      "args": ["stu-packet-tracer-mcp", "--stdio"]
    }
  }
}
```

### Streamable HTTP

Start `bunx stu-packet-tracer-mcp` first, then configure:

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

---

## Gemini CLI

Config file location: `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project).

### Stdio (Recommended)

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

### Streamable HTTP

Start `bunx stu-packet-tracer-mcp` first, then configure:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "httpUrl": "http://127.0.0.1:39001/mcp"
    }
  }
}
```

---

## Using a Standalone Compiled Binary

If you downloaded a prebuilt binary from GitHub Releases (no Bun install required), replace `"command"` and `"args"` with the binary path:

```json
{
  "mcpServers": {
    "stu-packet-tracer": {
      "command": "/path/to/stu-packet-tracer-mcp",
      "args": ["--stdio"]
    }
  }
}
```
