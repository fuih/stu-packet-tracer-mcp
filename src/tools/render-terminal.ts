import { z } from "zod";
import { renderAndSaveTerminal } from "../render/save.js";
import type { ThemeName } from "../render/themes.js";
import { resolveOutputPath, slugify } from "../util/paths.js";
import { defineTool } from "./define.js";

const AnnotationSchema = z.object({
  line: z.number().int().min(1).describe("1-based line number in the text."),
  text: z.string().min(1).describe("Short callout annotation for the right margin."),
});

const InputSchema = z.object({
  title: z.string().min(1).describe("Window title bar label (e.g. 'R1 - CLI', 'PC0 - Command Prompt')."),
  text: z.string().min(1).describe("Terminal output text to render (newlines preserved)."),
  theme: z.enum(["pt-classic", "dark", "putty", "high-contrast", "pc-cmd"]).default("pt-classic")
    .describe("Terminal color/chrome theme: pt-classic (default), dark, putty, high-contrast, or pc-cmd."),
  format: z.enum(["svg", "png", "both"]).default("both")
    .describe("Output image format: svg, png, or both (default)."),
  output_path: z.string().optional()
    .describe("Optional output path. Relative paths resolve under STU_PT_OUTPUT_DIR (default ./stu-pt-output/)."),
  max_columns: z.number().int().min(40).max(200).default(100)
    .describe("Maximum character columns before wrapping long lines."),
  show_window_chrome: z.boolean().default(true)
    .describe("Whether to draw the terminal window title bar and chrome."),
  annotations: z.array(AnnotationSchema).optional()
    .describe("Optional right-margin callout notes anchored to 1-based line numbers."),
});

export const registerRenderTerminalTool = defineTool({
  name: "pt_render_terminal",
  description: "Render arbitrary CLI or Command Prompt text into a crisp terminal-window SVG and/or 2x PNG image offline (no live Packet Tracer connection needed). Use this to format saved outputs, PC ping transcripts, or custom annotated terminal snippets for reports.",
  category: "Captures & Visuals",
  offline: true,
  input: InputSchema,
  handler: async ({
    title,
    text,
    theme,
    format,
    output_path,
    max_columns,
    show_window_chrome,
    annotations,
  }) => {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const defaultSubpath = `captures/${slugify(title)}`;
    const basePath = resolveOutputPath(output_path, defaultSubpath);

    const saved = await renderAndSaveTerminal(
      {
        title,
        lines,
        theme: theme as ThemeName,
        maxColumns: max_columns,
        showWindowChrome: show_window_chrome,
        annotations,
      },
      basePath,
      format,
    );

    const outLines = [`Rendered terminal "${title}" (theme: ${theme}):`];
    if (saved.svgPath) outLines.push(`  SVG: ${saved.svgPath}`);
    if (saved.pngPath) outLines.push(`  PNG: ${saved.pngPath}`);
    if (saved.pngWarning) outLines.push(`  Note: ${saved.pngWarning}`);

    return {
      text: outLines.join("\n"),
      images: saved.pngBase64 ? [{ data: saved.pngBase64, mimeType: "image/png" }] : undefined,
      structured: {
        title,
        theme,
        format,
        svgPath: saved.svgPath ?? null,
        pngPath: saved.pngPath ?? null,
        pngWidth: saved.pngWidth ?? null,
        pngHeight: saved.pngHeight ?? null,
        pngWarning: saved.pngWarning ?? null,
      },
    };
  },
});
