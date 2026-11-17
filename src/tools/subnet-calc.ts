import { z } from "zod";
import { calculateSubnet, calculateVlsm, formatSubnetMarkdown } from "../student/subnet-calc.js";
import { defineTool } from "./define.js";

const RequirementSchema = z.object({
  name: z.string().min(1).describe("Subnet label (e.g. 'Engineering LAN', 'WAN Link')."),
  hosts: z.number().int().min(1).max(16_777_214).describe("Number of usable host IP addresses required."),
});

const InputSchema = z.object({
  cidr: z.string().min(1).describe("IPv4 network in CIDR notation (e.g. '192.168.10.0/24') or plain IPv4 address when `mask` is supplied."),
  mask: z.string().optional().describe("Optional dotted-quad subnet mask (e.g. '255.255.255.192') if `cidr` omits `/prefix`."),
  vlsm_requirements: z.array(RequirementSchema).min(1).max(64).optional()
    .describe("Optional list of subnets with required host counts to compute a non-overlapping VLSM addressing plan."),
});

export const registerSubnetCalcTool = defineTool({
  name: "pt_subnet_calc",
  description: "Calculate IPv4 subnet details (network, broadcast, first/last usable host, subnet mask, OSPF/ACL wildcard mask) or generate a complete Variable Length Subnet Mask (VLSM) allocation plan offline. Use this before configuring router interfaces and labs.",
  category: "Student Tools",
  offline: true,
  input: InputSchema,
  handler: async ({ cidr, mask, vlsm_requirements }) => {
    if (vlsm_requirements && vlsm_requirements.length > 0) {
      const parent = calculateSubnet(cidr, mask);
      const plan = calculateVlsm(parent.cidr, vlsm_requirements);
      return {
        text: plan.markdown,
        structured: {
          mode: "vlsm",
          parentCidr: plan.parentCidr,
          allocations: plan.allocations,
          totalAllocatedAddresses: plan.totalAllocatedAddresses,
          remainingAddresses: plan.remainingAddresses,
        },
      };
    }

    const details = calculateSubnet(cidr, mask);
    return {
      text: formatSubnetMarkdown(details),
      structured: {
        mode: "single",
        ...details,
      },
    };
  },
});
