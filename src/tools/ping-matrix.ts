import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renderSvgToPng } from "../render/png.js";
import { renderPingMatrixSvg, runPingMatrix } from "../student/ping-matrix.js";
import { resolveOutputPath } from "../util/paths.js";
import { defineTool } from "./define.js";

const InputSchema = z.object({
  devices: z.array(z.string().min(1)).optional()
    .describe("Optional list of hosts to include (e.g. ['PC0', 'PC1', 'Server0']). Omit to test all end-hosts on the canvas."),
  warmup: z.boolean().default(true)
    .describe("Run one warm-up ping first so ARP resolves before the graded test (recommended)."),
  timeout_ms: z.number().int().min(5_000).max(60_000).default(20_000)
    .describe("Per-ping timeout in milliseconds."),
  render_image: z.boolean().default(false)
    .describe("Also save the ping matrix as an SVG + PNG image for lab reports."),
  output_path: z.string().optional()
    .describe("Optional output path when render_image is true (default ./stu-pt-output/captures/ping-matrix)."),
});

export const registerPingMatrixTool = defineTool({
  name: "pt_ping_matrix",
  description: "Test full mesh connectivity by pinging between every pair of hosts on the canvas (with automatic ARP warm-up first so initial drops don't cause false failures). Returns a pass/fail matrix with plain-English failure diagnostics and optional SVG/PNG table image.",
  category: "Student Tools",
  input: InputSchema,
  handler: async ({ devices, warmup, timeout_ms, render_image, output_path }, { bridge }) => {
    const result = await runPingMatrix(bridge, {
      devices,
      warmup,
      timeoutMs: timeout_ms,
    });

    let svgPath: string | undefined;
    let pngPath: string | undefined;
    const images: Array<{ data: string; mimeType: string }> = [];

    if (render_image) {
      const svg = renderPingMatrixSvg(result);
      const stem = resolveOutputPath(output_path, "captures/ping-matrix").replace(/\.(svg|png)$/i, "");
      mkdirSync(path.dirname(stem), { recursive: true });
      svgPath = `${stem}.svg`;
      writeFileSync(svgPath, svg, "utf8");

      const raster = await renderSvgToPng(svg, 2);
      if (raster.png) {
        pngPath = `${stem}.png`;
        writeFileSync(pngPath, raster.png);
        images.push({ data: Buffer.from(raster.png).toString("base64"), mimeType: "image/png" });
      }
    }

    const lines = [
      `Ping Matrix: ${result.passed}/${result.total} pairs passed (${result.failed} failed).`,
      "",
      result.markdown,
    ];
    if (svgPath) lines.push("", `Matrix SVG: ${svgPath}`);
    if (pngPath) lines.push(`Matrix PNG: ${pngPath}`);

    return {
      text: lines.join("\n"),
      images: images.length > 0 ? images : undefined,
      structured: {
        passed: result.passed,
        failed: result.failed,
        total: result.total,
        hosts: result.hosts,
        cells: result.cells,
        svgPath: svgPath ?? null,
        pngPath: pngPath ?? null,
      },
    };
  },
});
