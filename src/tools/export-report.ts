import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { collectLabReport } from "../report/collect.js";
import { renderReportDocx } from "../report/docx.js";
import { renderReportHtml } from "../report/html.js";
import { renderReportMarkdown } from "../report/markdown.js";
import type { ThemeName } from "../render/themes.js";
import { resolveOutputPath, slugify } from "../util/paths.js";
import { defineTool } from "./define.js";

const ThemeEnum = z.enum(["pt-classic", "dark", "putty", "high-contrast", "pc-cmd"]);

const SectionSchema = z.object({
  heading: z.string().min(1).describe("Section heading (e.g. '6. Verify Routing Tables')."),
  text: z.string().optional().describe("Answer or explanation text (basic Markdown supported)."),
  captures: z.array(
    z.object({
      device: z.string().min(1).describe("Router or switch name."),
      commands: z.array(z.string().min(1)).min(1).describe("IOS commands to execute and capture."),
      theme: ThemeEnum.optional().describe("Optional override theme for these CLI captures."),
    }).strict(),
  ).optional().describe("IOS CLI command captures to include under this section."),
  pc_captures: z.array(
    z.object({
      device: z.string().min(1).describe("PC, Laptop, or Server name."),
      command: z.string().min(1).describe("PC Command Prompt command (e.g. 'ping 192.168.2.10', 'ipconfig')."),
      theme: ThemeEnum.optional().describe("Optional override theme (defaults to 'pc-cmd')."),
    }).strict(),
  ).optional().describe("End-host Command Prompt captures to include under this section."),
}).strict();

const InputSchema = z.object({
  title: z.string().min(1).describe("Report title (e.g. 'Workshop: Static & Default Routing')."),
  student: z.object({
    name: z.string().optional(),
    group: z.string().optional(),
    id: z.string().optional(),
  }).strict().optional().describe("Optional student metadata printed on the title block."),
  course: z.string().optional().describe("Optional course name or code (e.g. 'Computer Networks — Lab 4')."),
  format: z.array(z.enum(["md", "html", "docx"])).min(1).default(["docx", "md"])
    .describe("Export formats to generate: 'docx' (Microsoft Word), 'html' (self-contained print-to-PDF), and/or 'md' (Markdown)."),
  output_dir: z.string().optional()
    .describe("Directory where the report and captures/ folder will be written. Relative paths resolve under STU_PT_OUTPUT_DIR."),
  default_theme: ThemeEnum.default("pt-classic")
    .describe("Default terminal screenshot theme for IOS CLI captures."),
  include_history: z.boolean().default(true)
    .describe("Include live Packet Tracer console scrollback history in CLI and Command Prompt screenshots (default: true)."),
  history_lines: z.number().int().min(10).max(120).default(42)
    .describe("Number of visible scrollback lines per screenshot when `include_history` is true (default: 42)."),
  include: z.object({
    topology_screenshot: z.boolean().default(true).describe("Include a PNG screenshot of the Logical workspace canvas."),
    addressing_table: z.boolean().default(true).describe("Include the live Device/Interface/IP/Mask/Gateway table."),
    ping_matrix: z.boolean().default(false).describe("Run and include an all-hosts connectivity ping matrix."),
  }).strict().default({
    topology_screenshot: true,
    addressing_table: true,
    ping_matrix: false,
  }).describe("Toggle automatic report sections gathered from the live Packet Tracer canvas."),
  sections: z.array(SectionSchema).default([])
    .describe("Ordered lab sections containing prose answers, router/switch CLI screenshots, and PC Command Prompt captures."),
  save_pkt: z.string().optional()
    .describe("Optional filename or path to also save the live Packet Tracer `.pkt` file alongside the report."),
});

export const registerExportReportTool = defineTool({
  name: "pt_export_report",
  description: "Collect live topology screenshots, addressing table, optional ping matrix, and terminal-style CLI/PC screenshots from Packet Tracer and export a polished university lab report in Microsoft Word (.docx), self-contained print-to-PDF HTML (.html), and/or Markdown (.md). Returns the absolute paths of all generated files.",
  category: "Reports",
  input: InputSchema,
  handler: async (
    { title, student, course, format, output_dir, default_theme, include_history, history_lines, include, sections, save_pkt },
    { bridge },
  ) => {
    const slug = slugify(title, 48);
    const reportDir = resolveOutputPath(output_dir, `reports/${slug}`);
    mkdirSync(reportDir, { recursive: true });

    const report = await collectLabReport(bridge, {
      title,
      course,
      student,
      outputDir: reportDir,
      include,
      defaultTheme: default_theme as ThemeName,
      includeHistory: include_history,
      historyLines: history_lines,
      sections,
      savePkt: save_pkt,
    });

    const files: Record<string, string> = {};
    const wanted = new Set(format);

    if (wanted.has("md")) {
      const mdPath = path.join(reportDir, `${slug}.md`);
      writeFileSync(mdPath, renderReportMarkdown(report), "utf8");
      files.md = mdPath;
    }

    if (wanted.has("html")) {
      const htmlPath = path.join(reportDir, `${slug}.html`);
      writeFileSync(htmlPath, renderReportHtml(report), "utf8");
      files.html = htmlPath;
    }

    if (wanted.has("docx")) {
      const docxPath = path.join(reportDir, `${slug}.docx`);
      const docxBytes = await renderReportDocx(report);
      writeFileSync(docxPath, docxBytes);
      files.docx = docxPath;
    }

    const totalCaptures = report.sections.reduce((acc, s) => acc + s.captures.length, 0);
    const outLines = [
      `Exported lab report "${title}" to ${reportDir}:`,
      ...Object.entries(files).map(([fmt, p]) => `  - ${fmt.toUpperCase()}: ${p}`),
      report.topology ? `  - Topology PNG: ${report.topology.pngPath}` : "",
      report.savedPktPath ? `  - Saved .pkt: ${report.savedPktPath}` : "",
      `  - Addressing rows: ${report.addressing?.length ?? 0}`,
      `  - Terminal captures: ${totalCaptures}`,
    ].filter(Boolean);

    return {
      text: outLines.join("\n"),
      structured: {
        title,
        outputDir: reportDir,
        files,
        topologyPath: report.topology?.pngPath ?? null,
        savedPktPath: report.savedPktPath ?? null,
        addressingCount: report.addressing?.length ?? 0,
        captureCount: totalCaptures,
      },
    };
  },
});
