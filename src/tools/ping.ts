import { z } from "zod";
import { summarizePing } from "../sim/parsers.js";
import { runPing } from "../sim/runner.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  device: z.string().min(1).describe("Device originating the ping (PC, router, or switch name)."),
  target: z.string().min(1).describe("Destination IPv4 or IPv6 address (e.g. '192.168.1.1', '2001:DB8:1::1')."),
  timeout_ms: z.number().int().min(5_000).max(60_000).default(25_000)
    .describe("Timeout in milliseconds to wait for ping completion."),
});

export const registerPingTool = defineTool({
  name: "pt_ping",
  description: "Send ICMP echo requests from a PC, switch, or router to a target IP and return parsed metrics. Output includes sent, received, lost, and success rate percentages alongside the raw transcript. Note: the first ping in a lab often drops 1-2 packets while ARP table entries resolve.",
  category: "Simulation & Testing",
  input: InputSchema,
  handler: async ({ device, target, timeout_ms }, { bridge }) => {
    const resolvedDevice = await resolveCanvasDevice(bridge, device);
    const { raw, result } = await runPing(bridge, resolvedDevice, target, { timeoutMs: timeout_ms });
    const summary = summarizePing(result);
    const detail =
      `${summary}\n` +
      `source=${result.source}, sent=${result.sent}, received=${result.received}, lost=${result.lost}, successRate=${result.successRate}\n` +
      `--- raw ---\n${raw || "(no output captured)"}`;
    return {
      text: detail,
      structured: {
        device: resolvedDevice,
        summary,
        ...result,
      },
    };
  },
});
