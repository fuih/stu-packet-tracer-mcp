import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Bridge } from "../bridge/http-bridge.js";
import { enterCommandOffsetJs, readCliSliceJs, readConsoleScrollback, runCli } from "../cli/engine.js";
import { fileSaveAsNoPromptJs } from "../ipc/files.js";
import { workspaceImageBase64Js } from "../ipc/sim.js";
import { renderSvgToPng } from "../render/png.js";
import { renderAndSaveTerminal } from "../render/save.js";
import type { ThemeName } from "../render/themes.js";
import { collectAddressingTable } from "../student/addressing.js";
import { renderPingMatrixSvg, runPingMatrix } from "../student/ping-matrix.js";
import { formatPcTranscript } from "../tools/capture-pc-command.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { slugify } from "../util/paths.js";
import type {
  LabReport,
  ReportCaptureItem,
  ReportPingMatrixData,
  ReportSectionData,
  ReportSectionInput,
  ReportStudent,
  ReportTopologyImage,
} from "./model.js";

export interface CollectReportOptions {
  readonly title: string;
  readonly course?: string;
  readonly student?: ReportStudent;
  readonly outputDir: string;
  readonly include: {
    readonly topology_screenshot?: boolean;
    readonly addressing_table?: boolean;
    readonly ping_matrix?: boolean;
  };
  readonly defaultTheme?: ThemeName;
  readonly includeHistory?: boolean;
  readonly historyLines?: number;
  readonly sections: readonly ReportSectionInput[];
  readonly savePkt?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function capturePcSlice(bridge: Bridge, device: string, command: string): Promise<string[]> {
  const lower = command.trim().toLowerCase();
  const waitMs = lower.startsWith("tracert ") ? 40_000 : lower.startsWith("ping ") ? 22_000 : 4_000;
  const init = await bridge.sendAndWait(enterCommandOffsetJs(device, command), { timeoutMs: 10_000 });
  if (!init || init.startsWith("ERR:") || init.startsWith("ERROR:")) {
    return [`C:\\>${command}`, init ?? "(timeout)", "C:\\>"];
  }
  const sep = init.indexOf("|");
  const offset = sep >= 0 ? Number(init.slice(0, sep)) : 0;
  let slice = sep >= 0 ? init.slice(sep + 1) : init;

  const deadline = Date.now() + waitMs;
  let lastLen = slice.length;
  let stable = 0;

  while (Date.now() < deadline) {
    const done =
      (lower.startsWith("ping ") && /Ping statistics for/i.test(slice)) ||
      (lower.startsWith("tracert ") && /Trace complete\./i.test(slice)) ||
      (!lower.startsWith("ping ") && !lower.startsWith("tracert ") && slice.trim().length > 0);
    if (done) {
      if (slice.length === lastLen) {
        stable++;
        if (stable >= 2) break;
      } else {
        lastLen = slice.length;
        stable = 0;
      }
    }
    await sleep(350);
    const next = await bridge.sendAndWait(readCliSliceJs(device, offset), { timeoutMs: 8_000 });
    if (next && !next.startsWith("ERR:") && !next.startsWith("ERROR:")) {
      if (next.length !== lastLen) {
        slice = next;
        lastLen = next.length;
        stable = 0;
      } else {
        slice = next;
      }
    }
  }
  return formatPcTranscript(command, slice);
}

/**
 * Collect all requested live data (topology image, addressing table, ping
 * matrix, CLI/PC terminal screenshots, and optional .pkt save) from Packet
 * Tracer into a single LabReport model.
 */
export async function collectLabReport(
  bridge: Bridge,
  opts: CollectReportOptions,
): Promise<LabReport> {
  const capturesDir = path.join(opts.outputDir, "captures");
  mkdirSync(capturesDir, { recursive: true });

  const generatedAt = new Date().toISOString().slice(0, 10);
  const defaultTheme: ThemeName = opts.defaultTheme ?? "pt-classic";

  // 1. Topology screenshot
  let topology: ReportTopologyImage | undefined;
  if (opts.include.topology_screenshot !== false) {
    const reply = await bridge.sendAndWait(workspaceImageBase64Js("PNG"), { timeoutMs: 30_000 });
    if (reply && reply.startsWith("B64|")) {
      const pngBytes = new Uint8Array(Buffer.from(reply.slice(4), "base64"));
      if (pngBytes.length > 0) {
        const pngPath = path.join(capturesDir, "topology.png");
        writeFileSync(pngPath, pngBytes);
        topology = { pngPath, pngBytes };
      }
    }
  }

  // 2. Addressing table
  let addressing;
  if (opts.include.addressing_table !== false) {
    const tbl = await collectAddressingTable(bridge, { includeUnassigned: false });
    addressing = tbl.rows;
  }

  // 3. Ping matrix
  let pingMatrix: ReportPingMatrixData | undefined;
  if (opts.include.ping_matrix === true) {
    const res = await runPingMatrix(bridge, { warmup: true });
    const svg = renderPingMatrixSvg(res);
    const svgPath = path.join(capturesDir, "ping-matrix.svg");
    writeFileSync(svgPath, svg, "utf8");
    const raster = await renderSvgToPng(svg, 2);
    let pngPath: string | undefined;
    let pngBytes: Uint8Array | undefined;
    if (raster.png) {
      pngPath = path.join(capturesDir, "ping-matrix.png");
      writeFileSync(pngPath, raster.png);
      pngBytes = raster.png;
    }
    pingMatrix = {
      result: res,
      svg,
      svgPath,
      pngPath,
      pngBytes,
      pngWidth: raster.width,
      pngHeight: raster.height,
    };
  }

  // 4. Per-section CLI & PC captures
  const sections: ReportSectionData[] = [];
  const includeHistory = opts.includeHistory ?? true;
  const historyLines = opts.historyLines ?? 42;
  let capCounter = 0;

  for (const sec of opts.sections) {
    const secCaptures: ReportCaptureItem[] = [];

    for (const req of sec.captures ?? []) {
      const dev = await resolveCanvasDevice(bridge, req.device);
      const theme: ThemeName = req.theme ?? defaultTheme;
      for (const cmd of req.commands) {
        capCounter++;
        const cli = await runCli(bridge, dev, cmd);
        const prompt = cli.prompt || `${dev}#`;
        let lines: string[];
        if (includeHistory) {
          const cmdLineCount = (cli.output ? cli.output.split(/\r?\n/).length : 0) + 3;
          const targetLines = Math.min(120, Math.max(historyLines, cmdLineCount + 8));
          lines = await readConsoleScrollback(bridge, dev, targetLines, prompt);
        } else {
          lines = [
            `${prompt}${cmd}`,
            ...(cli.output ? cli.output.split(/\r?\n/) : []),
            prompt,
          ];
        }
        const stem = path.join(capturesDir, `${String(capCounter).padStart(2, "0")}-${slugify(dev)}-${slugify(cmd)}`);
        const saved = await renderAndSaveTerminal(
          { title: `${dev} - CLI`, lines, theme },
          stem,
          "both",
        );
        const pngBytes = saved.pngPath ? new Uint8Array(readFileSync(saved.pngPath)) : undefined;
        secCaptures.push({
          label: `${dev}: \`${cmd}\``,
          device: dev,
          command: cmd,
          text: lines.join("\n"),
          svg: saved.svg,
          svgPath: saved.svgPath,
          pngPath: saved.pngPath,
          pngBytes,
          pngWidth: saved.pngWidth,
          pngHeight: saved.pngHeight,
        });
      }
    }

    for (const pcReq of sec.pc_captures ?? []) {
      capCounter++;
      const dev = await resolveCanvasDevice(bridge, pcReq.device);
      const theme: ThemeName = pcReq.theme ?? "pc-cmd";
      const sliceLines = await capturePcSlice(bridge, dev, pcReq.command);
      const lines = includeHistory
        ? await readConsoleScrollback(bridge, dev, Math.min(120, Math.max(historyLines, sliceLines.length + 8)), "C:\\>")
        : sliceLines;
      const stem = path.join(capturesDir, `${String(capCounter).padStart(2, "0")}-${slugify(dev)}-${slugify(pcReq.command)}`);
      const saved = await renderAndSaveTerminal(
        { title: `${dev} — Command Prompt`, lines, theme },
        stem,
        "both",
      );
      const pngBytes = saved.pngPath ? new Uint8Array(readFileSync(saved.pngPath)) : undefined;
      secCaptures.push({
        label: `${dev} Command Prompt: \`${pcReq.command}\``,
        device: dev,
        command: pcReq.command,
        text: lines.join("\n"),
        svg: saved.svg,
        svgPath: saved.svgPath,
        pngPath: saved.pngPath,
        pngBytes,
        pngWidth: saved.pngWidth,
        pngHeight: saved.pngHeight,
      });
    }

    sections.push({
      heading: sec.heading,
      text: sec.text,
      captures: secCaptures,
    });
  }

  // 5. Optional .pkt save
  let savedPktPath: string | undefined;
  if (opts.savePkt) {
    const targetPkt = path.isAbsolute(opts.savePkt)
      ? opts.savePkt
      : path.join(opts.outputDir, opts.savePkt);
    const res = await bridge.sendAndWait(fileSaveAsNoPromptJs(targetPkt), { timeoutMs: 15_000 });
    if (res && !res.startsWith("ERR:") && !res.startsWith("ERROR:")) {
      savedPktPath = targetPkt;
    }
  }

  return {
    title: opts.title,
    course: opts.course,
    student: opts.student,
    generatedAt,
    outputDir: opts.outputDir,
    topology,
    addressing,
    pingMatrix,
    sections,
    savedPktPath,
  };
}
