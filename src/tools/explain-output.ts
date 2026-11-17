import { z } from "zod";
import { explainCliOutput } from "../student/explain.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  output: z.string().min(1).describe("Raw Cisco IOS CLI output to explain."),
  command: z.string().optional().describe(
    "Optional command hint (e.g. 'show ip route', 'show ip arp', 'show ip interface brief', 'show vlan brief', 'show running-config'). Auto-detected if omitted.",
  ),
});

export const registerExplainOutputTool = defineTool({
  name: "pt_explain_output",
  description: "Translate Cisco IOS command output (`show ip route`, `show ip arp`, `show ip interface brief`, `show vlan brief`, `show running-config`) into plain-English explanations line by line. Works completely offline as a study aid for understanding route codes, [AD/metric], ARP ages, and interface status.",
  category: "Student Tools",
  offline: true,
  input: InputSchema,
  handler: async ({ output, command }) => {
    const explained = explainCliOutput(output, command);
    return {
      text: explained.markdown,
      structured: {
        kind: explained.kind,
        summary: explained.summary,
        items: explained.items,
        tips: explained.tips,
      },
    };
  },
});
