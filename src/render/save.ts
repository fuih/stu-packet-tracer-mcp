import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderSvgToPng } from "./png.js";
import { renderTerminalSvg, type TerminalRenderOptions } from "./terminal-svg.js";

export type OutputFormat = "svg" | "png" | "both";

export interface SavedCapture {
  readonly svg: string;
  readonly svgPath?: string;
  readonly pngPath?: string;
  readonly pngBase64?: string;
  readonly pngWidth?: number;
  readonly pngHeight?: number;
  readonly pngWarning?: string;
}

/**
 * Strip a trailing `.svg` or `.png` extension so we can append both cleanly.
 */
function stripImageExt(filePath: string): string {
  return filePath.replace(/\.(svg|png)$/i, "");
}

/**
 * Render terminal lines to SVG (and optionally PNG) and write them to disk.
 */
export async function renderAndSaveTerminal(
  opts: TerminalRenderOptions,
  baseOutputPath: string,
  format: OutputFormat = "both",
): Promise<SavedCapture> {
  const svg = renderTerminalSvg(opts);
  const stem = stripImageExt(baseOutputPath);
  mkdirSync(path.dirname(stem), { recursive: true });

  let svgPath: string | undefined;
  let pngPath: string | undefined;
  let pngBase64: string | undefined;
  let pngWidth: number | undefined;
  let pngHeight: number | undefined;
  let pngWarning: string | undefined;

  if (format === "svg" || format === "both") {
    svgPath = `${stem}.svg`;
    writeFileSync(svgPath, svg, "utf8");
  }

  if (format === "png" || format === "both") {
    const raster = await renderSvgToPng(svg, 2);
    if (raster.png) {
      pngPath = `${stem}.png`;
      writeFileSync(pngPath, raster.png);
      pngBase64 = Buffer.from(raster.png).toString("base64");
      pngWidth = raster.width;
      pngHeight = raster.height;
    } else {
      pngWarning = raster.error ?? "PNG rasterization failed";
      // Graceful fallback: write SVG even if caller only requested PNG
      if (!svgPath) {
        svgPath = `${stem}.svg`;
        writeFileSync(svgPath, svg, "utf8");
      }
    }
  }

  return {
    svg,
    svgPath,
    pngPath,
    pngBase64,
    pngWidth,
    pngHeight,
    pngWarning,
  };
}
