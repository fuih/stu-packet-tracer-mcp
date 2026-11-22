import { z } from "zod";
import { fetchDeviceModelsBatch } from "../ipc/device-model.js";
import { bulkCliBatchJs } from "../ipc/generator.js";
import { isTeachModeEnabled } from "../student/teach.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { defineTool } from "./define.js";
import { classRejectsEncapsulation, stripEncapsulationLines } from "./run-cli-bulk.js";

const TargetSchema = z.object({
  device: z.string().min(1).describe("Router or switch name (e.g. 'R1', 'SW1')."),
  commands: z.union([
    z.array(z.string().min(1)).min(1),
    z.string().min(1),
  ]).describe("CLI commands to push to this device."),
}).strict();

const InputSchema = z.object({
  targets: z.array(TargetSchema).min(1)
    .describe("List of devices and their Cisco IOS command blocks to apply in a single tool call."),
  save: z.boolean().default(false)
    .describe("If true, save running-config to startup-config (`write memory`) on all succeeded devices in the same batched call."),
  tail_chars: z.number().int().min(100).max(20_000).default(1_500)
    .describe("Maximum trailing console output characters to return per device."),
  dry_run: z.boolean().optional()
    .describe("Teach mode: preview all command blocks without modifying Packet Tracer."),
});

interface BatchCliDeviceResult {
  readonly device: string;
  readonly ok: boolean;
  readonly count: number;
  readonly droppedEncapCount: number;
  readonly output: string;
  readonly error?: string;
}

export const registerRunCliBatchTool = defineTool({
  name: "pt_run_cli_batch",
  description:
    "Push multi-line Cisco IOS configuration blocks to multiple routers and switches in a single batched IPC call (optionally saving startup-config with `write memory` in the same round-trip). Automatically dismisses boot dialogs, elevates to privileged EXEC, and strips unsupported trunk encapsulation lines on 2960/3650 switches.",
  category: "CLI & Diagnostics",
  input: InputSchema,
  handler: async ({ targets, save, tail_chars, dry_run }, { bridge }) => {
    if (isTeachModeEnabled(dry_run)) {
      const sections: string[] = [
        "[Teach Mode — Dry Run] Commands NOT applied to Packet Tracer.",
      ];
      for (const t of targets) {
        const lines = (Array.isArray(t.commands) ? t.commands.join("\n") : t.commands)
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(Boolean);
        sections.push("", `### ${t.device} (${lines.length} lines)`, ...lines.map(l => `  ${l}`));
      }
      return {
        text: sections.join("\n"),
        structured: {
          dry_run: true,
          targetCount: targets.length,
          save,
        },
      };
    }

    // 1. Resolve all device names (uses 5s cache -> 0 extra IPC calls on hit)
    const resolvedEntries: Array<{
      readonly index: number;
      readonly requested: string;
      readonly resolved?: string;
      readonly rawBlock: string;
      readonly error?: string;
    }> = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      const rawBlock = Array.isArray(target.commands)
        ? target.commands.join("\n")
        : target.commands;
      try {
        const resolved = await resolveCanvasDevice(bridge, target.device);
        resolvedEntries.push({ index: i, requested: target.device, resolved, rawBlock });
      } catch (err) {
        resolvedEntries.push({
          index: i,
          requested: target.device,
          rawBlock,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const validEntries = resolvedEntries.filter(e => e.resolved !== undefined);
    const modelMap = validEntries.length > 0
      ? await fetchDeviceModelsBatch(bridge, validEntries.map(e => e.resolved!))
      : new Map<string, string | null>();

    const batchItems: Array<{
      readonly entryIndex: number;
      readonly device: string;
      readonly commands: string[];
      readonly droppedEncapCount: number;
    }> = [];

    for (const entry of validEntries) {
      const devName = entry.resolved!;
      const model = modelMap.get(devName) ?? null;
      const shouldFilter = classRejectsEncapsulation(model);
      const { filtered, droppedCount } = shouldFilter
        ? stripEncapsulationLines(entry.rawBlock)
        : { filtered: entry.rawBlock, droppedCount: 0 };
      const lines = filtered.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      batchItems.push({
        entryIndex: entry.index,
        device: devName,
        commands: lines,
        droppedEncapCount: droppedCount,
      });
    }

    const resultByIndex = new Map<number, BatchCliDeviceResult>();
    for (const entry of resolvedEntries) {
      if (entry.error) {
        resultByIndex.set(entry.index, {
          device: entry.requested,
          ok: false,
          count: 0,
          droppedEncapCount: 0,
          output: "",
          error: entry.error,
        });
      }
    }

    let savedCount = 0;
    if (batchItems.length > 0) {
      const reply = await bridge.sendAndWait(
        bulkCliBatchJs(
          batchItems.map(b => ({ device: b.device, commands: b.commands })),
          { tailChars: tail_chars, save },
        ),
        { timeoutMs: Math.max(30_000, batchItems.length * 15_000) },
      );

      if (!reply || !reply.startsWith("[")) {
        for (const item of batchItems) {
          resultByIndex.set(item.entryIndex, {
            device: item.device,
            ok: false,
            count: 0,
            droppedEncapCount: item.droppedEncapCount,
            output: "",
            error: reply ?? "timeout",
          });
        }
      } else {
        try {
          const outcomes = JSON.parse(reply) as Array<{
            device: string;
            ok: boolean;
            count: number;
            saved?: boolean;
            output: string;
            error?: string;
          }>;
          for (let i = 0; i < batchItems.length; i++) {
            const item = batchItems[i]!;
            const out = outcomes[i];
            if (out?.saved) savedCount++;
            resultByIndex.set(item.entryIndex, {
              device: item.device,
              ok: !!out?.ok,
              count: out?.count ?? 0,
              droppedEncapCount: item.droppedEncapCount,
              output: out?.output ?? "",
              ...(out?.error ? { error: out.error } : {}),
            });
          }
        } catch {
          for (const item of batchItems) {
            resultByIndex.set(item.entryIndex, {
              device: item.device,
              ok: false,
              count: 0,
              droppedEncapCount: item.droppedEncapCount,
              output: "",
              error: `unexpected reply: ${reply.slice(0, 120)}`,
            });
          }
        }
      }
    }

    const results: BatchCliDeviceResult[] = [];
    for (let i = 0; i < targets.length; i++) {
      const r = resultByIndex.get(i);
      if (r) results.push(r);
    }

    const okTotal = results.filter(r => r.ok).length;
    const lines: string[] = [
      `Batch CLI complete: ${okTotal}/${results.length} device(s) succeeded${save ? ` (${savedCount} saved to NVRAM)` : ""}.`,
    ];
    for (const r of results) {
      lines.push(
        "",
        `=== ${r.device}: ${r.ok ? `OK (${r.count} cmd(s))` : `FAILED (${r.error ?? "error"})`}${r.droppedEncapCount > 0 ? ` [stripped ${r.droppedEncapCount} encap line(s)]` : ""} ===`,
      );
      if (r.output) lines.push(r.output);
    }

    return {
      text: lines.join("\n"),
      isError: okTotal === 0,
      structured: {
        succeeded: okTotal,
        total: results.length,
        savedCount,
        results,
      },
    };
  },
});
