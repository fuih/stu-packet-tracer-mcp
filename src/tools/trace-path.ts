import { z } from "zod";
import { tracePacketPathLive } from "../student/trace-path.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  from: z.string().min(1).describe("Source device name (e.g. 'PC-A', 'A')."),
  to: z.string().min(1).describe("Destination device name (e.g. 'PC-B', 'DC-SRV')."),
});

export const registerTracePathTool = defineTool({
  name: "pt_trace_path",
  description: "Simulate and trace BOTH the forward path (`from -> to`) and return path (`to -> from`) across L2 switches, PC gateways/masks, router interface states, and routing tables (`show ip route`). Answers 'Why can't A ping B?' by pinpointing the exact failing hop (e.g. missing return route or classful mask trap).",
  category: "Student Tools",
  input: InputSchema,
  handler: async ({ from, to }, { bridge }) => {
    const analysis = await tracePacketPathLive(bridge, from, to);

    return {
      text: analysis.markdown,
      structured: {
        fromDevice: analysis.fromDevice,
        fromIp: analysis.fromIp ?? null,
        toDevice: analysis.toDevice,
        toIp: analysis.toIp ?? null,
        bidirectionalOk: analysis.bidirectionalOk,
        verdict: analysis.verdict,
        fixSuggestion: analysis.fixSuggestion ?? null,
        forward: analysis.forward,
        reverse: analysis.reverse,
      },
    };
  },
});
