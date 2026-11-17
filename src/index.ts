#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.js";
import { startServer, startStdioServer, type RunningServer } from "./server.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  // Bun-only: we use `Bun.serve` and JSON import attributes that Node won't
  // parse the same way. Fail loud and early instead of crashing later with a
  // cryptic ReferenceError deep inside the bridge.
  if (typeof Bun === "undefined") {
    process.stderr.write(
      "[stu-pt-mcp] error: this server requires Bun (>=1.2). " +
      "Install it from https://bun.sh and run: bun run src/index.ts\n",
    );
    process.exit(1);
  }

  const cfg = loadConfig();
  const useStdio = args.includes("--stdio");

  // All log output MUST go to stderr. In stdio mode the stdout stream is the
  // JSON-RPC protocol channel — a single stray byte there breaks the client.
  // We keep the same convention in HTTP mode for consistency.
  const log = (msg: string) => process.stderr.write(`${msg}\n`);

  const running = useStdio
    ? await startStdioServer({ bridgePort: cfg.bridgePort })
    : await startServer(cfg);

  if (useStdio) {
    // Stdio: minimal output. The MCP client spawning us as a subprocess
    // logs stderr to a debug pane — keep it quiet unless something's wrong.
    log(`[stu-pt-mcp] stdio ready · bridge on :${cfg.bridgePort}`);
  } else {
    // HTTP: someone is running this interactively. Print a friendly banner.
    printBanner(cfg.mcpHost, cfg.mcpPort, cfg.bridgePort);
  }

  // Surface bridge connection transitions so the user knows whether the
  // bootstrap snippet is actually running inside PT. Without this they'd see
  // the banner and then complete silence even if the extension never connects.
  const bridgeWatcher = watchBridgeConnection(running, log);

  // Don't let an unhandled rejection or uncaught exception kill the process
  // silently — log it loudly. We keep the process alive: a single failed tool
  // call shouldn't take down the whole server.
  process.on("unhandledRejection", (reason) => {
    log(`[stu-pt-mcp] unhandled rejection: ${formatError(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    log(`[stu-pt-mcp] uncaught exception: ${formatError(err)}`);
  });

  const shutdown = async (signal: string) => {
    log(`\n[stu-pt-mcp] ${signal} received, shutting down…`);
    clearInterval(bridgeWatcher);
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Polls the bridge status every 2s and logs only the edges:
 *   disconnected → connected  ("PT extension connected")
 *   connected    → disconnected ("PT extension disconnected")
 * Polling itself stays silent — the PT webview hits /next every 500ms and
 * we don't want to spam stderr with one line per poll.
 */
function watchBridgeConnection(running: RunningServer, log: (msg: string) => void): NodeJS.Timeout {
  let wasConnected = false;
  const timer = setInterval(() => {
    const connected = running.bridge.status().connected;
    if (connected && !wasConnected) {
      log("[stu-pt-mcp] PT extension connected");
    } else if (!connected && wasConnected) {
      log("[stu-pt-mcp] PT extension disconnected");
    }
    wasConnected = connected;
  }, 2_000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function printHelp(): void {
  const text = [
    `stu-packet-tracer-mcp v${pkg.version}`,
    "Student-focused MCP server for Cisco Packet Tracer 9.",
    "",
    "Usage:",
    "  bunx stu-packet-tracer-mcp          Start in HTTP mode (Streamable HTTP)",
    "  bunx stu-packet-tracer-mcp --stdio  Start in stdio mode (Claude Desktop, etc.)",
    "",
    "Options:",
    "  --stdio          Speak JSON-RPC over stdin/stdout instead of HTTP",
    "  -v, --version    Print version and exit",
    "  -h, --help       Show this help message",
    "",
    "Environment variables:",
    "  MCP_HOST              HTTP transport host (default: 127.0.0.1)",
    "  MCP_PORT              MCP HTTP port (default: 39001)",
    "  BRIDGE_PORT           Internal bridge port to PT (default: 54321)",
    "  STU_PT_OUTPUT_DIR     Output directory for captures & reports (default: ./stu-pt-output)",
    "  STU_PT_TEACH_MODE     Set to 1 to force dry-run/explain-only study mode (default: off)",
    "  STU_PT_BRIDGE_TOKEN   Optional shared secret required via X-Stu-Token header",
    "  STU_PT_DEBUG          Set to 1 for per-tool timing logs on stderr",
    "",
    `Documentation: ${pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ?? ""}`,
    "",
  ].join("\n");
  process.stdout.write(text);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function printBanner(host: string, port: number, bridgePort: number): void {
  const author = (pkg.author ?? "").replace(/<[^>]*>/, "").trim();
  const repo = pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ?? "";
  const lines = [
    "",
    "  ╔══════════════════════════════════════════════════════════════════╗",
    `  ║  stu-packet-tracer-mcp  v${pkg.version.padEnd(40)}║`,
    "  ║  Student MCP server for Cisco Packet Tracer 9                    ║",
    "  ╠══════════════════════════════════════════════════════════════════╣",
    `  ║  Author     ${author.padEnd(53)}║`,
    `  ║  GitHub     ${repo.padEnd(53)}║`,
    `  ║  License    ${pkg.license.padEnd(53)}║`,
    "  ╚══════════════════════════════════════════════════════════════════╝",
    "",
    `  MCP      http://${host}:${port}/mcp`,
    `  Bridge   http://127.0.0.1:${bridgePort}   (waiting for PT extension polling)`,
    "",
    "  Press Ctrl+C to stop.",
    "",
  ];
  for (const line of lines) process.stderr.write(line + "\n");
}

main().catch((err) => {
  process.stderr.write(`[stu-pt-mcp] fatal error: ${formatError(err)}\n`);
  process.exit(1);
});
