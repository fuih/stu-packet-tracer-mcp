import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasmAssetPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };
import regularFontPath from "../../assets/fonts/DejaVuSansMono.ttf" with { type: "file" };
import boldFontPath from "../../assets/fonts/DejaVuSansMono-Bold.ttf" with { type: "file" };
import sansFontPath from "../../assets/fonts/DejaVuSans.ttf" with { type: "file" };

let initPromise: Promise<void> | null = null;
let cachedFonts: Uint8Array[] | null = null;

async function readAssetBytes(assetPath: string): Promise<Uint8Array> {
  const buf = await Bun.file(assetPath).arrayBuffer();
  return new Uint8Array(buf);
}

async function ensureInitialized(): Promise<Uint8Array[]> {
  if (!initPromise) {
    initPromise = (async () => {
      const wasmBytes = await readAssetBytes(wasmAssetPath);
      await initWasm(wasmBytes);
      const [regular, bold, sans] = await Promise.all([
        readAssetBytes(regularFontPath),
        readAssetBytes(boldFontPath),
        readAssetBytes(sansFontPath),
      ]);
      cachedFonts = [regular, bold, sans];
    })();
  }
  await initPromise;
  return cachedFonts!;
}

export interface RasterizeResult {
  readonly png: Uint8Array | null;
  readonly width?: number;
  readonly height?: number;
  readonly error?: string;
}

/**
 * Rasterize a terminal SVG string into a 2x retina-sharp PNG buffer using
 * `@resvg/resvg-wasm` and bundled DejaVu Sans Mono TTF fonts.
 *
 * Never throws on WASM/font errors — returns `{ png: null, error }` so callers
 * can gracefully fall back to SVG-only output.
 */
export async function renderSvgToPng(
  svg: string,
  zoom = 2,
): Promise<RasterizeResult> {
  try {
    const fontBuffers = await ensureInitialized();
    const resvg = new Resvg(svg, {
      fitTo: { mode: "zoom", value: zoom },
      font: {
        fontBuffers,
        defaultFontFamily: "DejaVu Sans Mono",
        monospaceFamily: "DejaVu Sans Mono",
        sansSerifFamily: "DejaVu Sans",
        loadSystemFonts: false,
      },
    });
    const rendered = resvg.render();
    const png = rendered.asPng();
    return {
      png,
      width: rendered.width,
      height: rendered.height,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stu-pt-mcp] PNG rasterization unavailable, falling back to SVG: ${msg}`);
    return { png: null, error: msg };
  }
}
