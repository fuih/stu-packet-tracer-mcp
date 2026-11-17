#!/usr/bin/env bun
/**
 * Tiny Streamable HTTP MCP client for quick local smoke tests.
 *
 * Usage:
 *   bun scripts/mcp-call.ts --list
 *   bun scripts/mcp-call.ts pt_bridge_status '{}'
 *   bun scripts/mcp-call.ts pt_run_cli '{"device":"R1","command":"show ip route"}'
 */

const URL_ = process.env.MCP_URL ?? "http://127.0.0.1:39001/mcp";
const H = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

const init = await fetch(URL_, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-call", version: "1.0.0" },
    },
  }),
});

if (!init.ok) {
  console.error(`Initialize failed: HTTP ${init.status} ${await init.text()}`);
  process.exit(1);
}

const sid = init.headers.get("mcp-session-id");
if (!sid) {
  console.error("Missing mcp-session-id header from server.");
  process.exit(1);
}

const [name, args = "{}"] = process.argv.slice(2);
if (!name) {
  console.error("Usage: bun scripts/mcp-call.ts <tool_name|--list> [json_args]");
  process.exit(1);
}

const method = name === "--list" ? "tools/list" : "tools/call";
const params = name === "--list" ? {} : { name, arguments: JSON.parse(args) };

const res = await fetch(URL_, {
  method: "POST",
  headers: { ...H, "mcp-session-id": sid },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
});

const raw = await res.text();
let printed = false;
for (const line of raw.split("\n")) {
  if (!line.startsWith("data: ")) continue;
  const d = JSON.parse(line.slice(6));
  if (d.result?.content) {
    for (const c of d.result.content) {
      if (c.text) {
        console.log(c.text);
        printed = true;
      }
    }
  } else {
    console.log(JSON.stringify(d.result ?? d.error, null, 2));
    printed = true;
  }
}

if (!printed && raw.trim()) {
  console.log(raw.trim());
}
