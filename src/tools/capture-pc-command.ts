import { z } from "zod";
import { enterCommandOffsetJs, readCliSliceJs } from "../cli/engine.js";
import { renderAndSaveTerminal } from "../render/save.js";
import type { ThemeName } from "../render/themes.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { ptError } from "../util/errors.js";
import { resolveOutputPath, slugify } from "../util/paths.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  device: z.string().min(1).describe("End-device name (PC, Laptop, or Server, e.g. 'PC0', 'A')."),
  command: z.string().min(1).describe("Command Prompt command (e.g. 'ping 192.168.2.10', 'ipconfig', 'ipconfig /all', 'tracert 10.0.0.2', 'arp -a')."),
  theme: z.enum(["pc-cmd", "dark", "pt-classic", "putty", "high-contrast"]).default("pc-cmd")
    .describe("Terminal theme (defaults to 'pc-cmd' for authentic Windows Command Prompt styling)."),
  format: z.enum(["svg", "png", "both"]).default("both")
    .describe("Output image format: svg, png, or both (default)."),
  output_path: z.string().optional()
    .describe("Optional output path. Relative paths resolve under STU_PT_OUTPUT_DIR (default ./stu-pt-output/)."),
  timeout_ms: z.number().int().min(2_000).max(90_000).optional()
    .describe("Optional timeout in milliseconds to wait for command completion."),
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isPcCommandDone(command: string, slice: string): boolean {
  const lower = command.trim().toLowerCase();
  if (lower.startsWith("ping ")) {
    return /Ping statistics for/i.test(slice) || /Approximate round trip times/i.test(slice);
  }
  if (lower.startsWith("tracert ")) {
    return /Trace complete\./i.test(slice) || /Trace terminated/i.test(slice);
  }
  return /[A-Za-z]:\\[^>]*>\s*$/.test(slice.trimEnd());
}

export function formatPcTranscript(command: string, rawSlice: string): string[] {
  const normalized = rawSlice.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = normalized.length > 0 ? normalized.split("\n") : [];

  // Ensure the command header looks like authentic Packet Tracer PC Command Prompt
  const hasPromptHeader = lines.length > 0 && /^[A-Za-z]:\\[^>]*>/.test(lines[0]!);
  if (!hasPromptHeader) {
    // Strip bare echoed command if PT echoed it without prompt
    if (lines.length > 0 && lines[0]!.trim().toLowerCase() === command.trim().toLowerCase()) {
      lines.shift();
    }
    lines.unshift(`C:\\>${command}`);
  }

  const lastLine = lines[lines.length - 1] ?? "";
  if (!/^[A-Za-z]:\\[^>]*>\s*$/.test(lastLine.trim())) {
    lines.push("", "C:\\>");
  }

  return lines;
}

export const registerCapturePcCommandTool = defineTool({
  name: "pt_capture_pc_command",
  description: "Run a Command Prompt command (`ping`, `ipconfig`, `tracert`, `arp -a`) on a Packet Tracer PC, Laptop, or Server and save a Windows Command Prompt-style screenshot (SVG and/or 2x PNG). Use this to capture host connectivity and IP evidence for lab reports.",
  category: "Captures & Visuals",
  input: InputSchema,
  handler: async ({ device, command, theme, format, output_path, timeout_ms }, { bridge }) => {
    const resolvedDevice = await resolveCanvasDevice(bridge, device);
    const lower = command.trim().toLowerCase();
    const defaultTimeout = lower.startsWith("tracert ")
      ? 45_000
      : lower.startsWith("ping ")
        ? 25_000
        : 5_000;
    const waitMs = timeout_ms ?? defaultTimeout;

    const initial = await bridge.sendAndWait(enterCommandOffsetJs(resolvedDevice, command), {
      timeoutMs: 10_000,
    });
    if (initial === null) {
      throw ptError("BRIDGE_TIMEOUT", `Timed out sending "${command}" to PC "${resolvedDevice}".`);
    }
    if (initial.startsWith("ERR:") || initial.startsWith("ERROR:")) {
      throw ptError("PC_CLI_ERROR", `Packet Tracer returned "${initial}" for "${resolvedDevice}".`);
    }

    const sep = initial.indexOf("|");
    const offset = sep >= 0 ? Number(initial.slice(0, sep)) : 0;
    let slice = sep >= 0 ? initial.slice(sep + 1) : initial;

    const deadline = Date.now() + waitMs;
    let stableReads = 0;
    let lastLen = slice.length;

    while (Date.now() < deadline) {
      if (isPcCommandDone(command, slice)) {
        if (slice.length === lastLen) {
          stableReads++;
          if (stableReads >= 2) break;
        } else {
          lastLen = slice.length;
          stableReads = 0;
        }
      }
      await sleep(350);
      const next = await bridge.sendAndWait(readCliSliceJs(resolvedDevice, offset), { timeoutMs: 8_000 });
      if (next !== null && !next.startsWith("ERR:") && !next.startsWith("ERROR:")) {
        if (next.length !== lastLen) {
          slice = next;
          lastLen = next.length;
          stableReads = 0;
        } else {
          slice = next;
          if (isPcCommandDone(command, slice) || (!lower.startsWith("ping ") && !lower.startsWith("tracert ") && slice.trim().length > 0)) {
            stableReads++;
            if (stableReads >= 2) break;
          }
        }
      }
    }

    const lines = formatPcTranscript(command, slice);
    const defaultSubpath = `captures/${slugify(resolvedDevice)}-${slugify(command)}`;
    const basePath = resolveOutputPath(output_path, defaultSubpath);

    const saved = await renderAndSaveTerminal(
      {
        title: `${resolvedDevice} — Command Prompt`,
        lines,
        theme: theme as ThemeName,
      },
      basePath,
      format,
    );

    const outLines = [
      `Captured PC Command Prompt on ${resolvedDevice}: \`${command}\` (theme: ${theme})`,
    ];
    if (saved.svgPath) outLines.push(`  SVG: ${saved.svgPath}`);
    if (saved.pngPath) outLines.push(`  PNG: ${saved.pngPath}`);
    if (saved.pngWarning) outLines.push(`  Note: ${saved.pngWarning}`);
    outLines.push(`--- output ---\n${lines.join("\n")}`);

    return {
      text: outLines.join("\n"),
      images: saved.pngBase64 ? [{ data: saved.pngBase64, mimeType: "image/png" }] : undefined,
      structured: {
        device: resolvedDevice,
        command,
        theme,
        format,
        svgPath: saved.svgPath ?? null,
        pngPath: saved.pngPath ?? null,
        output: lines.join("\n"),
      },
    };
  },
});
