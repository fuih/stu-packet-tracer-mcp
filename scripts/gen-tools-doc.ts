#!/usr/bin/env bun
/**
 * Generates `docs/TOOLS.md` automatically from the live MCP tool registry.
 *
 * Usage:
 *   bun run scripts/gen-tools-doc.ts          # write docs/TOOLS.md
 *   bun run scripts/gen-tools-doc.ts --check  # exit 1 if docs/TOOLS.md is out of date
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Bridge } from "../src/bridge/http-bridge.js";
import { getRegisteredTools, installStrictToolWrapper, type ToolDocEntry } from "../src/tools/define.js";
import { ALL_TOOLS } from "../src/tools/index.js";

interface JsonSchemaProp {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  anyOf?: JsonSchemaProp[];
  oneOf?: JsonSchemaProp[];
  items?: JsonSchemaProp;
}

interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
}

function formatType(prop: JsonSchemaProp): string {
  if (prop.enum && prop.enum.length > 0) {
    return prop.enum.map(v => `\`${JSON.stringify(v)}\``).join(" \\| ");
  }
  if (prop.anyOf && prop.anyOf.length > 0) {
    return prop.anyOf.map(formatType).join(" \\| ");
  }
  if (prop.oneOf && prop.oneOf.length > 0) {
    return prop.oneOf.map(formatType).join(" \\| ");
  }
  if (prop.type === "array" && prop.items) {
    return `${formatType(prop.items)}[]`;
  }
  if (Array.isArray(prop.type)) {
    return prop.type.join(" \\| ");
  }
  return prop.type ?? "any";
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderToolSection(tool: ToolDocEntry): string {
  const lines: string[] = [];
  const badge = tool.offline ? " *(offline)*" : "";
  lines.push(`### \`${tool.name}\`${badge}`);
  lines.push("");
  if (tool.description) {
    lines.push(tool.description.trim());
    lines.push("");
  }

  let jsonSchema: JsonSchemaObject = {};
  try {
    jsonSchema = z.toJSONSchema(tool.schema, { unrepresentable: "any" }) as JsonSchemaObject;
  } catch {
    jsonSchema = {};
  }

  const props = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);
  const propNames = Object.keys(props);

  if (propNames.length === 0) {
    lines.push("_No parameters._");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| Parameter | Type | Required | Description |");
  lines.push("| --- | --- | --- | --- |");
  for (const name of propNames) {
    const prop = props[name]!;
    const req = required.has(name) && prop.default === undefined ? "Yes" : "No";
    const typeStr = formatType(prop);
    const desc = escapeCell(prop.description ?? "");
    const defNote = prop.default !== undefined ? ` (default: \`${JSON.stringify(prop.default)}\`)` : "";
    lines.push(`| \`${name}\` | ${typeStr} | ${req} | ${desc}${defNote} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function generateDocs(): string {
  const server = new McpServer({ name: "stu-packet-tracer-mcp", version: "0.1.0" });
  const bridge = new Bridge(0);
  installStrictToolWrapper(server, bridge);
  for (const register of ALL_TOOLS) {
    register({ bridge, server });
  }

  const tools = getRegisteredTools(server);
  const byCategory = new Map<string, ToolDocEntry[]>();
  for (const t of tools) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }

  const categoryOrder = [
    "Catalog & Status",
    "Student Tools",
    "Captures & Visuals",
    "Reports",
    "CLI & Diagnostics",
    "Simulation & Testing",
    "Topology & Canvas",
    "Inspection & Analysis",
    "Configuration & Recipes",
    "Files & Snapshots",
    "General",
  ];

  const orderedCategories = [
    ...categoryOrder.filter(c => byCategory.has(c)),
    ...[...byCategory.keys()].filter(c => !categoryOrder.includes(c)).sort(),
  ];

  const out: string[] = [
    "# stu-packet-tracer-mcp Tool Reference",
    "",
    "> **Auto-generated file.** Do not edit manually — run `bun run docs:tools` to regenerate.",
    "",
    `Total registered tools: **${tools.length}**. All input schemas are strict (\`additionalProperties: false\`).`,
    "",
    "## Categories",
    "",
  ];

  for (const cat of orderedCategories) {
    const list = byCategory.get(cat)!;
    const anchor = cat.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    out.push(`- [${cat}](#${anchor}) (${list.length})`);
  }
  out.push("");

  for (const cat of orderedCategories) {
    const list = byCategory.get(cat)!.slice().sort((a, b) => a.name.localeCompare(b.name));
    out.push(`## ${cat}`);
    out.push("");
    for (const t of list) {
      out.push(renderToolSection(t));
    }
  }

  return out.join("\n").trimEnd() + "\n";
}

const outPath = path.resolve(import.meta.dir, "..", "docs", "TOOLS.md");
const generated = generateDocs();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  if (!existsSync(outPath)) {
    console.error("[gen-tools-doc] docs/TOOLS.md is missing. Run: bun run docs:tools");
    process.exit(1);
  }
  const existing = readFileSync(outPath, "utf8");
  if (existing !== generated) {
    console.error("[gen-tools-doc] docs/TOOLS.md is out of date. Run: bun run docs:tools");
    process.exit(1);
  }
  console.log("[gen-tools-doc] docs/TOOLS.md is up to date.");
} else {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, generated, "utf8");
  console.log(`[gen-tools-doc] Wrote ${outPath} (${generated.length} bytes)`);
}
