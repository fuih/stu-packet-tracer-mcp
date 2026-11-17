import { z } from "zod";
import { runLabCheck } from "../student/lab-check.js";
import { defineTool } from "./define.js";

const ObjectiveSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ping"),
    from: z.string().min(1).describe("Source device name (e.g. 'PC-A')."),
    to: z.string().min(1).describe("Destination device name or IP address."),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("route"),
    device: z.string().min(1).describe("Router name to check `show ip route` on."),
    prefix: z.string().min(1).describe("Expected route prefix (e.g. '192.168.2.0/24' or '0.0.0.0/0')."),
    next_hop: z.string().optional().describe("Optional expected next-hop IP address."),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("interface_up"),
    device: z.string().min(1).describe("Router or switch name."),
    interface: z.string().min(1).describe("Interface name (e.g. 'GigabitEthernet0/0')."),
    expected_ip: z.string().optional().describe("Optional expected IPv4 address."),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("config_contains"),
    device: z.string().min(1).describe("Router or switch name."),
    text: z.string().min(1).describe("Substring expected inside `show running-config`."),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("vlan_exists"),
    device: z.string().min(1).describe("Switch name."),
    vlan: z.number().int().min(1).max(4094).describe("Expected VLAN ID."),
    name: z.string().optional().describe("Optional expected VLAN name."),
    description: z.string().optional(),
  }),
]);

const InputSchema = z.object({
  objectives: z.array(ObjectiveSchema).min(1).max(50)
    .describe("List of lab grading objectives to verify (ping, route, interface_up, config_contains, vlan_exists)."),
});

export const registerCheckLabTool = defineTool({
  name: "pt_check_lab",
  description: "Verify a list of networking lab objectives (connectivity pings, routing table entries, up/up interfaces, running-config directives, and VLANs) against the live Packet Tracer topology. Returns a pass/fail scorecard with exact CLI evidence so students can self-check before submitting.",
  category: "Student Tools",
  input: InputSchema,
  handler: async ({ objectives }, { bridge }) => {
    const report = await runLabCheck(bridge, objectives);
    return {
      text: report.markdown,
      structured: {
        passed: report.passed,
        failed: report.failed,
        total: report.total,
        scorePercent: report.scorePercent,
        results: report.results,
      },
    };
  },
});
