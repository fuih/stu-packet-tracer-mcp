import { z } from "zod";
import { runCli } from "../cli/engine.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  device: z.string().min(1).describe("Router or switch name (e.g. 'R1', 'Switch_A')."),
  command: z.string().min(1).describe("Cisco IOS CLI command to execute (e.g. 'show ip interface brief', 'show ip route')."),
  timeout_ms: z.number().int().min(500).max(60_000).optional().describe("Command execution timeout in milliseconds."),
});

export const registerRunCliTool = defineTool({
  name: "pt_run_cli",
  description: "Execute a Cisco IOS CLI command on a router or switch and return its console output. Automatically handles initial configuration prompts, privilege elevation, and --More-- pagination without losing output. Syslog events emitted during command execution are separated into structured logs.",
  category: "CLI & Diagnostics",
  input: InputSchema,
  handler: async ({ device, command, timeout_ms }, { bridge }) => {
    const resolvedDevice = await resolveCanvasDevice(bridge, device);
    const res = await runCli(bridge, resolvedDevice, command, { timeoutMs: timeout_ms });
    let out = res.output;
    if (res.logs.length > 0) {
      out += `\n\n[Syslog events during command]\n` + res.logs.join("\n");
    }
    const text = out.length > 0 ? out : "(empty output)";
    return {
      text,
      structured: {
        device: res.device,
        command: res.command,
        mode_before: res.mode_before,
        mode_after: res.mode_after,
        prompt: res.prompt,
        output: res.output,
        logs: res.logs,
      },
    };
  },
});
