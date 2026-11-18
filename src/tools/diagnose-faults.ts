import { z } from "zod";
import { diagnoseAndFixLab } from "../student/fault-diagnose.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  mode: z.enum(["hints", "commands", "autofix"]).default("commands").describe(
    "'hints' gives study clues without spoiling commands; 'commands' explains root causes and exact fixes (default); 'autofix' applies deterministic fixes live.",
  ),
  devices: z.array(z.string().min(1)).optional().describe(
    "Optional subset of device names to diagnose (defaults to all devices in the topology).",
  ),
  deep_cli_check: z.boolean().default(true).describe(
    "Also inspect router CLI tables (`show ip interface brief`, `show ip route`, `show running-config`) to catch shutdown ports, self next-hops, and one-way routing.",
  ),
});

export const registerDiagnoseFaultsTool = defineTool({
  name: "pt_diagnose_faults",
  description: "Inspect a live Packet Tracer lab to detect common student networking mistakes (powered-off devices, shutdown interfaces, duplicate IPs, classful /8 mask traps, missing or wrong PC gateways, WAN subnet mismatches, self-pointing static routes, and one-way return routes). Supports study `hints`, full `commands`, or live `autofix`.",
  category: "Student Tools",
  input: InputSchema,
  handler: async ({ mode, devices, deep_cli_check }, { bridge }) => {
    const res = await diagnoseAndFixLab(bridge, {
      mode,
      devices,
      deepCliCheck: deep_cli_check,
    });

    return {
      text: res.markdown,
      structured: {
        mode: res.mode,
        faultCount: res.faults.length,
        appliedFixCount: res.appliedFixes.length,
        appliedFixes: res.appliedFixes,
        faults: res.faults,
      },
    };
  },
});
