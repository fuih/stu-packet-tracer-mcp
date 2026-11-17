import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { workspaceImageBase64Js } from "../ipc/sim.js";
import { ptError } from "../util/errors.js";
import { resolveOutputPath } from "../util/paths.js";
import { defineTool } from "./define.js";
import { checkPtReply } from "./pt-errors.js";

const InputSchema = z.object({
  format: z.enum(["PNG", "JPG"]).default("PNG")
    .describe("Image format. PNG is lossless and recommended for lab reports."),
  output_path: z.string().optional()
    .describe("Output file path. Relative paths resolve against STU_PT_OUTPUT_DIR (default ./stu-pt-output/)."),
});

export const registerScreenshotTool = defineTool({
  name: "pt_screenshot",
  description: "Capture the Packet Tracer Logical workspace canvas as a PNG or JPG image. Use this to include a topology diagram in your lab report. Saves the image to disk and returns the absolute file path.",
  category: "Captures & Visuals",
  input: InputSchema,
  handler: async ({ format, output_path }, { bridge }) => {
    const reply = await bridge.sendAndWait(workspaceImageBase64Js(format), { timeoutMs: 30_000 });
    const err = checkPtReply(reply);
    if (err) return err;
    if (!reply || !reply.startsWith("B64|")) {
      throw ptError("UNEXPECTED_REPLY", `Unexpected reply from getWorkspaceImage: ${(reply ?? "<null>").slice(0, 80)}`);
    }
    const b64 = reply.slice("B64|".length);
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0) {
      throw ptError("EMPTY_IMAGE", "getWorkspaceImage returned empty bytes after base64 decode.");
    }

    const ext = format.toLowerCase();
    const ts = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
    const target = resolveOutputPath(output_path, `screenshots/pt-${ts}.${ext}`);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);

    return {
      text: `Saved ${format} screenshot (${buf.length} bytes) to ${target}`,
      structured: {
        path: target,
        format,
        bytes: buf.length,
      },
    };
  },
});
