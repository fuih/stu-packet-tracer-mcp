import { z } from "zod";
import { listAliases, listModels } from "../catalog/devices.js";
import { defineTool } from "./define.js";

export const registerListDevicesTool = defineTool({
  name: "pt_list_devices",
  description: "List all Packet Tracer device models supported by stu-packet-tracer-mcp, along with their ports and shortcut aliases. Use this before calling pt_add_device to pick the exact model name or alias.",
  category: "Catalog & Status",
  offline: true,
  input: z.object({}),
  handler: async () => {
    const models = listModels();
    const aliases = listAliases();
    const lines: string[] = [];
    for (const m of models) {
      lines.push(`${m.displayName} [pt_type=${m.ptType}, category=${m.category}]`);
      const ports = m.ports.map(p => p.fullName).join(", ");
      lines.push(`  ports: ${ports}`);
    }
    lines.push("", "Aliases:");
    for (const [alias, target] of Object.entries(aliases)) {
      lines.push(`  ${alias} -> ${target}`);
    }
    return {
      text: lines.join("\n"),
      structured: {
        models: models.map(m => ({
          displayName: m.displayName,
          ptType: m.ptType,
          category: m.category,
          ports: m.ports.map(p => p.fullName),
        })),
        aliases,
      },
    };
  },
});
