import { z } from "zod";
import { buildBootstrap } from "../bridge/bootstrap.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({});

export const registerBridgeStatusTool = defineTool({
  name: "pt_bridge_status",
  description: "Check whether the Packet Tracer bridge extension is connected and ready. Use this first before running lab commands or troubleshooting connection problems. Also prints the emergency paste-in bootstrap snippet if you do not have the .pts extension installed.",
  category: "Catalog & Status",
  offline: true,
  input: InputSchema,
  handler: async (_args, { bridge }) => {
    const s = bridge.status();
    const v1 = bridge.statusV1();
    const bootstrap = buildBootstrap(s.port);
    const lines = [
      `connected: ${s.connected}`,
      `agent:     ${v1.agent ?? "none"}`,
      `protocol:  v${v1.protocol}`,
      `version:   ${v1.version}`,
      `port:      ${s.port}`,
      `pending:   ${v1.pending}`,
      `queue:     ${s.queueLength}`,
      `lastSeen:  ${s.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : "never"}`,
      "",
      "Bootstrap fallback (paste into a PT webview editor if the Student MCP Bridge extension is not loaded):",
      "",
      bootstrap,
    ];
    return {
      text: lines.join("\n"),
      structured: {
        connected: s.connected,
        agent: v1.agent ?? null,
        protocol: v1.protocol,
        version: v1.version,
        port: s.port,
        pending: v1.pending,
        queueLength: s.queueLength,
        lastSeenAt: s.lastSeenAt,
      },
    };
  },
});
