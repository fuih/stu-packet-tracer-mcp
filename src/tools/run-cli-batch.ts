import { z } from "zod";
import { prepareDevice } from "../cli/engine.js";
import { fetchDeviceModel } from "../ipc/device-model.js";
import { bulkCliJs, saveRunningConfigsBatchJs } from "../ipc/generator.js";
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
    .describe("If true, save running-config to startup-config (`write memory`) on all succeeded devices in one batched call."),
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
    "Push multi-line Cisco IOS configuration blocks to multiple routers and switches in a single MCP tool call (optionally saving startup-config with `write memory` across all devices in one batched call). Automatically prepares each CLI and strips unsupported trunk encapsulation lines on 2960/3650 switches.",
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

    const results: BatchCliDeviceResult[] = [];
    const succeededDevices: string[] = [];

    for (const target of targets) {
      const commandBlock = Array.isArray(target.commands)
        ? target.commands.join("\n")
        : target.commands;
      try {
        const resolvedDevice = await resolveCanvasDevice(bridge, target.device);
        await prepareDevice(bridge, resolvedDevice);

        const className = await fetchDeviceModel(bridge, resolvedDevice);
        const shouldFilter = classRejectsEncapsulation(className);
        const { filtered, droppedCount } = shouldFilter
          ? stripEncapsulationLines(commandBlock)
          : { filtered: commandBlock, droppedCount: 0 };

        const reply = await bridge.sendAndWait(bulkCliJs(resolvedDevice, filtered, tail_chars), {
          timeoutMs: 60_000,
        });
        if (!reply || reply.startsWith("ERR:") || reply.startsWith("ERROR:")) {
          results.push({
            device: resolvedDevice,
            ok: false,
            count: 0,
            droppedEncapCount: droppedCount,
            output: "",
            error: reply ?? "timeout",
          });
          continue;
        }

        const newlineIdx = reply.indexOf("\n");
        if (!reply.startsWith("BULK|") || newlineIdx === -1) {
          results.push({
            device: resolvedDevice,
            ok: false,
            count: 0,
            droppedEncapCount: droppedCount,
            output: reply.slice(0, 200),
            error: "unexpected reply shape",
          });
          continue;
        }

        const header = reply.slice(0, newlineIdx);
        const output = reply.slice(newlineIdx + 1);
        const count = Number(header.split("|")[1] ?? "0");
        results.push({
          device: resolvedDevice,
          ok: true,
          count,
          droppedEncapCount: droppedCount,
          output,
        });
        succeededDevices.push(resolvedDevice);
      } catch (err) {
        results.push({
          device: target.device,
          ok: false,
          count: 0,
          droppedEncapCount: 0,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let savedCount = 0;
    if (save && succeededDevices.length > 0) {
      const uniqueTargets = [...new Set(succeededDevices)];
      const saveReply = await bridge.sendAndWait(saveRunningConfigsBatchJs(uniqueTargets), {
        timeoutMs: Math.max(15_000, uniqueTargets.length * 4_000),
      });
      if (saveReply && saveReply.startsWith("[")) {
        try {
          const parsed = JSON.parse(saveReply) as Array<{ ok: boolean }>;
          savedCount = parsed.filter(p => p.ok).length;
        } catch {}
      }
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
