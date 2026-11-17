import { z } from "zod";
import { runCli } from "../cli/engine.js";
import { requireConnectedBridge, textResult, errorResult } from "./helpers.js";
import type { ToolModule } from "./types.js";

const InputSchema = {
  device: z.string().min(1).describe("Router or switch name."),
  command: z.string().min(1).describe("CLI command, e.g. 'show ip interface brief'."),
  timeout_ms: z.number().int().min(500).max(60_000).optional().describe("Timeout in milliseconds."),
};

export const registerRunCliTool: ToolModule = ({ bridge, server }) => {
  server.tool(
    "pt_run_cli",
    "Send a CLI command to a router or switch and return the slice of console output produced by it. Automatically handles boot dialogs, privilege elevation, and pagination.",
    InputSchema,
    async ({ device, command, timeout_ms }) => {
      const blocked = requireConnectedBridge(bridge);
      if (blocked) return blocked;

      try {
        const res = await runCli(bridge, device, command, { timeoutMs: timeout_ms });
        let out = res.output;
        if (res.logs.length > 0) {
          out += `\n\n[Syslog events during command]\n` + res.logs.join("\n");
        }
        return textResult(out.length > 0 ? out : "(empty output)");
      } catch (e) {
        return errorResult((e as Error).message);
      }
    },
  );
};
