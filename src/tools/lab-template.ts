import { z } from "zod";
import {
  applyLabTemplate,
  buildLabTemplate,
  formatLabTemplateMarkdown,
  LAB_TEMPLATE_IDS,
  type LabTemplateId,
} from "../student/lab-templates.js";
import { isTeachModeEnabled } from "../student/teach.js";
import { defineTool } from "./define.js";
import { requireConnectedBridge } from "./helpers.js";

const InputSchema = z.object({
  template: z.enum(LAB_TEMPLATE_IDS).describe(
    "University networking lab template: static-routing, default-route, rip-v2, ospf-single-area, vlan-basic, inter-vlan-roas, dhcp, nat-pat, acl-standard, or acl-extended.",
  ),
  lan_a: z.string().optional().describe("Optional LAN A subnet (e.g. '192.168.10.0/24')."),
  lan_b: z.string().optional().describe("Optional LAN B subnet (e.g. '192.168.20.0/24')."),
  transit: z.string().optional().describe("Optional router-to-router transit subnet (e.g. '10.0.0.0/30')."),
  router_prefix: z.string().min(1).max(12).optional().describe("Optional router naming prefix (default 'R' -> R1, R2)."),
  dry_run: z.boolean().optional().describe(
    "Teach mode: if true (or STU_PT_TEACH_MODE=1), return the full topology plan and Cisco IOS commands without touching Packet Tracer.",
  ),
});

export const registerLabTemplateTool = defineTool({
  name: "pt_lab_template",
  description: "Build or preview one of 10 classic university networking labs (`static-routing`, `default-route`, `rip-v2`, `ospf-single-area`, `vlan-basic`, `inter-vlan-roas`, `dhcp`, `nat-pat`, `acl-standard`, `acl-extended`) with custom subnets. Pass `dry_run: true` (or enable `STU_PT_TEACH_MODE=1`) to receive the complete step-by-step IOS commands as a study guide without modifying the canvas.",
  category: "Student Tools",
  offline: true, // Checked dynamically inside handler when applying live
  input: InputSchema,
  handler: async ({ template, lan_a, lan_b, transit, router_prefix, dry_run }, { bridge }) => {
    const spec = buildLabTemplate(template as LabTemplateId, {
      lanA: lan_a,
      lanB: lan_b,
      transit,
      routerPrefix: router_prefix,
    });

    const teachMode = isTeachModeEnabled(dry_run);
    if (teachMode) {
      return {
        text: formatLabTemplateMarkdown(spec, true),
        structured: {
          applied: false,
          teachMode: true,
          spec,
        },
      };
    }

    const blocked = requireConnectedBridge(bridge);
    if (blocked) return blocked;

    const stats = await applyLabTemplate(bridge, spec);
    const md = [
      formatLabTemplateMarkdown(spec, false),
      "",
      "## Live Build Summary",
      `- Devices placed: **${stats.devicesAdded}**`,
      `- Links cabled: **${stats.linksCreated}**`,
      `- End-hosts configured: **${stats.pcsConfigured}**`,
      `- IOS devices configured: **${stats.cliApplied}**`,
      "",
      "Tip: Run `pt_check_lab` with the returned `spec.objectives` to verify everything works!",
    ].join("\n");

    return {
      text: md,
      structured: {
        applied: true,
        teachMode: false,
        stats,
        spec,
      },
    };
  },
});
