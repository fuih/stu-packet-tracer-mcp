import { z } from "zod";
import { captureSnapshot } from "../canvas/snapshot.js";
import { gridLayoutCanvas } from "../canvas/layout.js";
import { moveDevicesBatchJs } from "../ipc/generator.js";
import { errorResult, requireConnectedBridge, textResult } from "./helpers.js";
import type { ToolModule } from "./types.js";

const InputSchema = {
  dryRun: z.boolean().optional().describe(
    "When true, return the planned moves without applying them. Useful for " +
    "previewing the new layout before committing.",
  ),
};

const DESCRIPTION =
  "Re-grid the entire live canvas into a clean topology-aware layout. " +
  "Reads every device, classifies it (router / switch / AP / endpoint / " +
  "server / cloud), and assigns coordinates by category row plus column " +
  "alignment with the parent device (switches column-aligned with their " +
  "router, endpoints with their switch). Use this after the AI has built a " +
  "topology with manual coordinates to make it look like a recipe-built " +
  "lab. Idempotent: running it twice on the same canvas is a no-op.";

export const registerAutoLayoutTool: ToolModule = ({ bridge, server }) => {
  server.tool(
    "pt_auto_layout",
    DESCRIPTION,
    InputSchema,
    async ({ dryRun }) => {
      const blocked = requireConnectedBridge(bridge);
      if (blocked) return blocked;

      const snap = await captureSnapshot(bridge);
      const moves = gridLayoutCanvas(snap);

      if (moves.length === 0) {
        return textResult(`Layout already grid-aligned (${snap.devices.length} devices, 0 moves).`);
      }

      if (dryRun) {
        const lines = moves.map(m => `  ${m.name} -> (${m.x},${m.y})`);
        return textResult(`Planned ${moves.length} moves (dry-run):\n${lines.join("\n")}`);
      }

      const failures: string[] = [];
      const reply = await bridge.sendAndWait(moveDevicesBatchJs(moves), {
        timeoutMs: Math.max(10_000, moves.length * 1_500),
      });
      if (reply === null) {
        return errorResult(`Batch move timed out for ${moves.length} device(s).`);
      }
      try {
        const outcomes = JSON.parse(reply) as Array<{ name: string; ok: boolean; error?: string }>;
        for (const item of outcomes) {
          if (!item.ok) {
            failures.push(`${item.name}: ${item.error ?? "failed"}`);
          }
        }
      } catch {
        return errorResult(`Unexpected batch move reply: ${reply.slice(0, 120)}`);
      }

      if (failures.length > 0) {
        return errorResult(
          `Applied ${moves.length - failures.length}/${moves.length} moves. Failures:\n${failures.join("\n")}`,
        );
      }
      return textResult(`Re-gridded ${moves.length} device(s) across ${snap.devices.length} placed.`);
    },
  );
};
