import path from "node:path";
import { z } from "zod";
import { readConsoleScrollback, runCli } from "../cli/engine.js";
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
  ]).optional().describe(
    "One or more IOS commands to execute and capture (array or newline-separated string). Omit to snapshot the current live CLI screen without running a new command.",
  ),
  theme: ThemeSchema.describe("Terminal color/chrome theme: pt-classic (default), dark, putty, high-contrast, or pc-cmd."),
  format: FormatSchema.describe("Output image format: svg, png, or both (default)."),
  output_path: z.string().optional().describe(
    "Optional output file path (single/combined) or directory (multiple commands). Relative paths resolve under STU_PT_OUTPUT_DIR (default ./stu-pt-output/).",
  ),
  include_prompt: z.boolean().default(true).describe("Include the `<prompt><command>` header line when `include_history` is false."),
  include_history: z.boolean().default(true).describe(
    "Include the real live Packet Tracer CLI scrollback history (previous commands, errors, boot/session lines) above the new output so screenshots look like an authentic live CLI window (default: true). Set to false for clean single-command output only.",
  ),
  history_lines: z.number().int().min(10).max(120).default(42).describe(
    "Number of visible scrollback lines when `include_history` is true (default: 42, matching a realistic Packet Tracer CLI window).",
  ),
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
  description: "Run one or more Cisco IOS commands on a router or switch (or snapshot its current live CLI screen) and save authentic Packet Tracer 9 CLI screenshots (SVG and/or 2x PNG). By default includes live console scrollback history (previous commands, errors, prompts) so captures are indistinguishable from real Packet Tracer screenshots.",
  category: "Captures & Visuals",
  input: InputSchema,
  handler: async (
    {
      device,
      commands,
      theme,
      format,
      output_path,
      include_prompt,
      include_history,
      history_lines,
      combine,
      max_columns,
      annotations,
    },
    { bridge },
  ) => {
    const resolvedDevice = await resolveCanvasDevice(bridge, device);
    const cmdList = !commands
      ? []
      : Array.isArray(commands)
        ? commands.map(c => c.trim()).filter(Boolean)
        : commands.split(/\r?\n/).map(c => c.trim()).filter(Boolean);

    const captures: Array<{
      command: string;
      svgPath?: string;
      pngPath?: string;
      output: string;
      pngWarning?: string;
    }> = [];
    const images: Array<{ data: string; mimeType: string }> = [];

    // Pure live CLI screen snapshot (no new commands requested)
    if (cmdList.length === 0) {
      const lines = await readConsoleScrollback(bridge, resolvedDevice, history_lines);
      const basePath = resolveOutputPath(output_path, `captures/${slugify(resolvedDevice)}-cli-screen`);
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
        command: "(live screen snapshot)",
        svgPath: saved.svgPath,
        pngPath: saved.pngPath,
        output: lines.join("\n"),
        pngWarning: saved.pngWarning,
      });
      if (saved.pngBase64) {
        images.push({ data: saved.pngBase64, mimeType: "image/png" });
      }
    } else if (combine || cmdList.length === 1) {
      const results: Array<{ command: string; prompt: string; output: string }> = [];
      for (const cmd of cmdList) {
        const res = await runCli(bridge, resolvedDevice, cmd);
        results.push({
          command: cmd,
          prompt: res.prompt || `${resolvedDevice}#`,
          output: res.output,
        });
      }

      const lastPrompt = results[results.length - 1]?.prompt || `${resolvedDevice}#`;
      let renderLines: string[];

      if (include_history) {
        const newCmdLineCount = results.reduce(
          (acc, r) => acc + (r.output ? r.output.split(/\r?\n/).length : 0) + 3,
          0,
        );
        const targetLines = Math.min(120, Math.max(history_lines, newCmdLineCount + 8));
        renderLines = await readConsoleScrollback(bridge, resolvedDevice, targetLines, lastPrompt);
      } else {
        renderLines = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          if (i > 0) renderLines.push("");
          renderLines.push(...buildLines(r.prompt, r.command, r.output, include_prompt));
        }
        if (include_prompt) renderLines.push(lastPrompt);
      }

      const defaultFile = `captures/${slugify(resolvedDevice)}-${slugify(cmdList.length === 1 ? cmdList[0]! : "cli-session")}`;
      const basePath = resolveOutputPath(output_path, defaultFile);

      const saved = await renderAndSaveTerminal(
        {
          title: `${resolvedDevice} - CLI`,
          lines: renderLines,
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

      // Execute and capture each command sequentially so each screenshot reflects
      // the authentic live scrollback right after that command completed.
      for (const cmd of cmdList) {
        const res = await runCli(bridge, resolvedDevice, cmd);
        const prompt = res.prompt || `${resolvedDevice}#`;

        let lines: string[];
        if (include_history) {
          const cmdLines = (res.output ? res.output.split(/\r?\n/).length : 0) + 3;
          const targetLines = Math.min(120, Math.max(history_lines, cmdLines + 8));
          lines = await readConsoleScrollback(bridge, resolvedDevice, targetLines, prompt);
        } else {
          lines = buildLines(prompt, cmd, res.output, include_prompt);
          if (include_prompt) lines.push(prompt);
        }

        const basePath = path.join(targetDir, `${slugify(resolvedDevice)}-${slugify(cmd)}`);
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
          command: cmd,
          svgPath: saved.svgPath,
          pngPath: saved.pngPath,
          output: res.output,
          pngWarning: saved.pngWarning,
        });
        if (saved.pngBase64 && images.length < 4) {
          images.push({ data: saved.pngBase64, mimeType: "image/png" });
        }
      }
    }

    const summaryLines: string[] = [
      `Captured ${captures.length} terminal image(s) from ${resolvedDevice} (theme: ${theme}, history: ${include_history ? "on" : "off"}):`,
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
        include_history,
        captures,
      },
    };
  },
});
