import { z } from "zod";
import { summarizeTraceroute } from "../sim/parsers.js";
import { runTraceroute } from "../sim/runner.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  device: z.string().min(1).describe("Device originating the trace (PC or router)."),
  target: z.string().min(1).describe("Destination IPv4 or IPv6 address (e.g. '10.0.0.1')."),
  timeout_ms: z.number().int().min(15_000).max(120_000).default(60_000)
    .describe("Timeout in milliseconds to wait for traceroute to complete."),
});

export const registerTracerouteTool = defineTool({
  name: "pt_traceroute",
  description: "Trace the network path and intermediate hops from a device to a destination address. Dispatches appropriate command variants automatically for both PCs (tracert) and IOS routers (traceroute). Returns a structured list of hops with round-trip indicators and completion status.",
  category: "Simulation & Testing",
  input: InputSchema,
  handler: async ({ device, target, timeout_ms }, { bridge }) => {
    const resolvedDevice = await resolveCanvasDevice(bridge, device);
    const { raw, result } = await runTraceroute(bridge, resolvedDevice, target, { timeoutMs: timeout_ms });
    const summary = summarizeTraceroute(result);
    const detail =
      `${summary}\n` +
      `source=${result.source}, hops=${result.hops.length}, complete=${result.complete}\n` +
      `--- raw ---\n${raw || "(no output captured)"}`;
    return {
      text: detail,
      structured: {
        device: resolvedDevice,
        target,
        summary,
        hops: result.hops,
        complete: result.complete,
      },
    };
  },
});
