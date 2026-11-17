import { z } from "zod";
import { runShowRunning } from "../sim/runner.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { ptError } from "../util/errors.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  devices: z.array(z.string().min(1)).min(1).max(20)
    .describe("Routers or switches to inspect. Each device is queried separately."),
  section: z.string().optional()
    .describe("Optional `| section <pattern>` filter — e.g. 'interface GigabitEthernet0/0', 'router ospf', 'ipv6'."),
  tail_chars: z.number().int().min(1_000).max(50_000).default(20_000)
    .describe("Per-device maximum output length in characters."),
});

export const registerShowRunningTool = defineTool({
  name: "pt_show_running",
  description: "Capture `show running-config` (optionally filtered by `| section`) on one or more routers or switches. Automatically handles privileged mode entry and `--More--` pagination so complete configurations are returned. Use this to verify lab configs or compare changes.",
  category: "CLI & Diagnostics",
  input: InputSchema,
  handler: async ({ devices, section, tail_chars }, { bridge }) => {
    const blocks: string[] = [];
    const configs: Record<string, string> = {};
    const errors: string[] = [];

    for (const rawName of devices) {
      try {
        const device = await resolveCanvasDevice(bridge, rawName);
        const out = await runShowRunning(bridge, device, section, tail_chars);
        configs[device] = out;
        const header = section
          ? `=== ${device} :: show running-config | section ${section} ===`
          : `=== ${device} :: show running-config ===`;
        blocks.push(`${header}\n${out || "(empty)"}`);
      } catch (e) {
        errors.push(`${rawName}: ${(e as Error).message}`);
      }
    }

    if (blocks.length === 0) {
      throw ptError("SHOW_RUNNING_FAILED", `pt_show_running failed on every device:\n${errors.join("\n")}`);
    }

    const trailer = errors.length > 0 ? `\n\n--- errors ---\n${errors.join("\n")}` : "";
    return {
      text: blocks.join("\n\n") + trailer,
      structured: {
        section: section ?? null,
        configs,
        errors,
      },
    };
  },
});
