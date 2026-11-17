import { z } from "zod";
import { collectAddressingTable } from "../student/addressing.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  devices: z.array(z.string().min(1)).optional()
    .describe("Optional filter: only include these device names."),
  include_unassigned: z.boolean().default(false)
    .describe("Include ports that do not have an IPv4 address assigned."),
  format: z.enum(["markdown", "csv", "json"]).default("markdown")
    .describe("Preferred text output format (structuredContent always contains rows, markdown, and csv)."),
});

export const registerAddressingTableTool = defineTool({
  name: "pt_addressing_table",
  description: "Build the classic Device / Interface / IP Address / Subnet Mask / Default Gateway addressing table from the live Packet Tracer canvas. Use this to verify lab addressing or drop straight into a university lab report.",
  category: "Student Tools",
  input: InputSchema,
  handler: async ({ devices, include_unassigned, format }, { bridge }) => {
    const result = await collectAddressingTable(bridge, {
      devices,
      includeUnassigned: include_unassigned,
    });

    const text =
      format === "csv"
        ? result.csv
        : format === "json"
          ? JSON.stringify(result.rows, null, 2)
          : result.markdown;

    return {
      text,
      structured: {
        count: result.rows.length,
        rows: result.rows,
        markdown: result.markdown,
        csv: result.csv,
      },
    };
  },
});
