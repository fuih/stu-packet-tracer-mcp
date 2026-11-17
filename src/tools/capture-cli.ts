import path from "node:path";
import { z } from "zod";
import { runCli } from "../cli/engine.js";
import { renderAndSaveTerminal } from "../render/save.js";
import type { ThemeName } from "../render/themes.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { resolveOutputPath, slugify } from "../util/paths.js";
import { defineTool } from "./define.js";

const ThemeSchema = z.enum(["pt-classic", "dark", "putty", "high-contrast", "pc-cmd"]).default("pt-classic");
const FormatSchema = z.enum(["svg", "png", "both"]).default("both");

const AnnotationSchema = z.object({
  line: z.number().int().min(1).describe("1-based line number in the terminal output."),
  text: z.string().min(1).describe("Short callout annotation text for the right margin."),
});

const InputSchema = z.object({
  device: z.string().min(1).describe("Router or switch name (e.g. 'R1', 'SW1')."),
  commands: z.union([
    z.array(z.string().min(1)).min(1),
    z.string().min(1),
  ]).describe("One or more IOS commands to execute and capture (array or newline-separated string)."),
  theme: ThemeSchema.describe("Terminal color/chrome theme: pt-classic (default), dark, putty, high-contrast, or pc-cmd."),
  format: FormatSchema.describe("Output image format: svg, png, or both (default)."),
  output_path: z.string().optional().describe(
    "Optional output file path (single/combined) or directory (multiple commands). Relative paths resolve under STU_PT_OUTPUT_DIR (default ./stu-pt-output/).",
  ),
  include_prompt: z.boolean().default(true).describe("Include the `<prompt> <command>` header line inside the terminal image."),
  combine: z.boolean().default(false).describe("Combine all commands into a single terminal image instead of one image per command."),
  max_columns: z.number().int().min(40).max(200).default(100).describe("Column width at which long output lines wrap."),
  annotations: z.array(AnnotationSchema).optional().describe("Optional right-margin callout notes anchored to 1-based line numbers."),
});

function buildLines(
  prompt: string,
  command: string,
  output: string,
  includePrompt: boolean,
): string[] {
  const lines: string[] = [];
  if (includePrompt) {
    lines.push(`${prompt || "Router#"}${command}`);
  }
  if (output.length > 0) {
    lines.push(...output.split(/\r?\n/));
  }
  return lines;
}

export const registerCaptureCliTool = defineTool({
  name: "pt_capture_cli",
  description: "Run one or more Cisco IOS commands on a router or switch and save crisp terminal-style screenshots (SVG and/or 2x PNG) ready for university lab reports. Automatically clears pagination so full outputs are captured. Returns absolute file paths and the cleaned CLI text.",
  category: "Captures & Visuals",
  input: InputSchema,
  handler: async (
    { device, commands, theme, format, output_path, include_prompt, combine, max_columns, annotations },
    { bridge },
  ) => {
    const resolvedDevice = await resolveCanvasDevice(bridge, device);
    const cmdList = Array.isArray(commands)
      ? commands.map(c => c.trim()).filter(Boolean)
      : commands.split(/\r?\n/).map(c => c.trim()).filter(Boolean);

    const results: Array<{
      command: string;
      prompt: string;
      output: string;
      logs: readonly string[];
    }> = [];

    for (const cmd of cmdList) {
      const res = await runCli(bridge, resolvedDevice, cmd);
      results.push({
        command: cmd,
        prompt: res.prompt || `${resolvedDevice}#`,
        output: res.output,
        logs: res.logs,
      });
    }

    const captures: Array<{
      command: string;
      svgPath?: string;
      pngPath?: string;
      output: string;
      pngWarning?: string;
    }> = [];
    const images: Array<{ data: string; mimeType: string }> = [];

    if (combine || cmdList.length === 1) {
      const allLines: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (i > 0) allLines.push("");
        allLines.push(...buildLines(r.prompt, r.command, r.output, include_prompt));
      }
      const lastPrompt = results[results.length - 1]?.prompt || `${resolvedDevice}#`;
      if (include_prompt) {
        allLines.push(lastPrompt);
      }

      const defaultFile = `captures/${slugify(resolvedDevice)}-${slugify(cmdList.length === 1 ? cmdList[0]! : "cli-session")}`;
      const basePath = resolveOutputPath(output_path, defaultFile);

      const saved = await renderAndSaveTerminal(
        {
          title: `${resolvedDevice} - CLI`,
          lines: allLines,
          theme: theme as ThemeName,
          maxColumns: max_columns,
          annotations,
        },
        basePath,
        format,
      );

      captures.push({
        command: cmdList.join(" ; "),
        svgPath: saved.svgPath,
        pngPath: saved.pngPath,
        output: results.map(r => r.output).join("\n\n"),
        pngWarning: saved.pngWarning,
      });
      if (saved.pngBase64) {
        images.push({ data: saved.pngBase64, mimeType: "image/png" });
      }
    } else {
      const targetDir = output_path
        ? resolveOutputPath(output_path)
        : resolveOutputPath(undefined, "captures");

      for (const r of results) {
        const lines = buildLines(r.prompt, r.command, r.output, include_prompt);
        if (include_prompt) lines.push(r.prompt);

        const basePath = path.join(targetDir, `${slugify(resolvedDevice)}-${slugify(r.command)}`);
        const saved = await renderAndSaveTerminal(
          {
            title: `${resolvedDevice} - CLI`,
            lines,
            theme: theme as ThemeName,
            maxColumns: max_columns,
            annotations,
          },
          basePath,
          format,
        );

        captures.push({
          command: r.command,
          svgPath: saved.svgPath,
          pngPath: saved.pngPath,
          output: r.output,
          pngWarning: saved.pngWarning,
        });
        if (saved.pngBase64 && images.length < 4) {
          images.push({ data: saved.pngBase64, mimeType: "image/png" });
        }
      }
    }

    const summaryLines: string[] = [
      `Captured ${captures.length} terminal image(s) from ${resolvedDevice} (theme: ${theme}):`,
    ];
    for (const c of captures) {
      summaryLines.push(`\nCommand: ${c.command}`);
      if (c.svgPath) summaryLines.push(`  SVG: ${c.svgPath}`);
      if (c.pngPath) summaryLines.push(`  PNG: ${c.pngPath}`);
      if (c.pngWarning) summaryLines.push(`  Note: ${c.pngWarning}`);
      summaryLines.push(`--- output ---\n${c.output || "(empty)"}`);
    }

    return {
      text: summaryLines.join("\n"),
      images: images.length > 0 ? images : undefined,
      structured: {
        device: resolvedDevice,
        theme,
        format,
        captures,
      },
    };
  },
});
