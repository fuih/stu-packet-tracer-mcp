import { z } from "zod";
import { prepareDevice } from "../cli/engine.js";
import { fetchDeviceModel } from "../ipc/device-model.js";
import { bulkCliJs } from "../ipc/generator.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { ptError } from "../util/errors.js";
import { defineTool } from "./define.js";
import { checkPtReply } from "./pt-errors.js";

/**
 * The Script Engine accepts only single-line `enterCommand` payloads. To run
 * a configuration block (an OSPF stanza, a NAT pool, ACL list, ...) the
 * caller passes either an array of commands or a newline-delimited string.
 */
const InputSchema = z.object({
  device: z.string().min(1).describe("Router or switch name (e.g. 'R1', 'SW1')."),
  commands: z.union([
    z.array(z.string().min(1)).min(1),
    z.string().min(1),
  ]).describe(
    "CLI commands to send in sequence, as an array of lines (preferred) or a newline-separated string.",
  ),
  tail_chars: z.number().int().min(100).max(20_000).default(2_000)
    .describe("Maximum trailing console output characters to return."),
  dry_run: z.boolean().optional()
    .describe("Teach mode: if true (or STU_PT_TEACH_MODE=1), return the exact IOS commands instead of applying them to Packet Tracer."),
});

export const registerRunCliBulkTool = defineTool({
  name: "pt_run_cli_bulk",
  description: "Push a multi-line Cisco IOS configuration block (such as interfaces, routing, VLANs, or ACLs) to a router or switch. Automatically prepares the CLI, strips unsupported trunk encapsulation commands on 2960/3650 switches, and returns the command count and console output. Supports dry_run / Teach Mode to preview commands without applying them.",
  category: "CLI & Diagnostics",
  input: InputSchema,
  handler: async ({ device, commands, tail_chars, dry_run }, { bridge }) => {
    const commandBlock = Array.isArray(commands) ? commands.join("\n") : commands;
    const isTeachMode = dry_run === true || process.env.STU_PT_TEACH_MODE === "1";

    if (isTeachMode) {
      const lines = commandBlock.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const text = [
        `[Teach Mode — Dry Run] Commands NOT applied to ${device}.`,
        `Type these commands in ${device}'s CLI tab:`,
        "",
        ...lines.map(l => `  ${l}`),
      ].join("\n");
      return {
        text,
        structured: {
          device,
          dry_run: true,
          commandCount: lines.length,
          commands: lines,
        },
      };
    }

    const resolvedDevice = await resolveCanvasDevice(bridge, device);
    await prepareDevice(bridge, resolvedDevice);

    const className = await fetchDeviceModel(bridge, resolvedDevice);
    const shouldFilter = classRejectsEncapsulation(className);
    const { filtered, droppedCount, droppedSamples } = shouldFilter
      ? stripEncapsulationLines(commandBlock)
      : { filtered: commandBlock, droppedCount: 0, droppedSamples: [] as string[] };

    const js = bulkCliJs(resolvedDevice, filtered, tail_chars);
    const result = await bridge.sendAndWait(js, { timeoutMs: 60_000 });
    const err = checkPtReply(result, { device: resolvedDevice });
    if (err) return err;
    if (!result) {
      return {
        text: "(empty output)",
        structured: { device: resolvedDevice, count: 0, truncated: false, output: "" },
      };
    }

    const newlineIdx = result.indexOf("\n");
    if (!result.startsWith("BULK|") || newlineIdx === -1) {
      throw ptError("UNEXPECTED_REPLY", `Unexpected reply shape from PT bulk CLI: ${result.slice(0, 80)}`);
    }
    const header = result.slice(0, newlineIdx);
    const output = result.slice(newlineIdx + 1);
    const parts = header.split("|");
    const count = Number(parts[1] ?? "0");
    const truncated = parts[2] === "1";

    const filterNote =
      droppedCount > 0
        ? `Note: stripped ${droppedCount} 'switchport trunk encapsulation' line(s) — ` +
          `${className ?? "this switch"} only supports 802.1Q and rejects the command. ` +
          `Filtered: ${droppedSamples.join(" | ")}\n`
        : "";

    const banner =
      `Sent ${count} command(s) to ${resolvedDevice}${truncated ? " (output truncated to tail)" : ""}.\n` +
      filterNote +
      `--- output ---\n`;

    return {
      text: banner + (output.length > 0 ? output : "(empty output)"),
      structured: {
        device: resolvedDevice,
        count,
        truncated,
        droppedCount,
        droppedSamples,
        output,
      },
    };
  },
});

/**
 * Catalyst chassis whose PT 9 parser rejects
 * `switchport trunk encapsulation ...` with "% Invalid input":
 *
 *   - 2950 / 2950T / 2960 (legacy IOS): only 802.1Q, verb never exposed.
 *   - 3650 / IE-3400 / IE-9320 (IOS XE 16.x/17.x): real Cisco accepts the
 *     verb but PT's IOS XE parser drops it.
 *
 * 3560 (IOS 12.x multilayer) IS the only switch that accepts the command,
 * so we explicitly do NOT match it here.
 */
export function classRejectsEncapsulation(className: string | null): boolean {
  if (!className) return false;
  if (/3560/i.test(className)) return false;
  return /(2950|2960|3650|IE-3400|IE-9320)/i.test(className);
}

/**
 * Strip `switchport trunk encapsulation ...` lines from a CLI block.
 */
export function stripEncapsulationLines(block: string): {
  filtered: string;
  droppedCount: number;
  droppedSamples: string[];
} {
  const lines = block.split(/\r?\n/);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    if (/^\s*switchport\s+trunk\s+encapsulation\b/i.test(line)) {
      dropped.push(line.trim());
      continue;
    }
    kept.push(line);
  }
  return {
    filtered: kept.join("\n"),
    droppedCount: dropped.length,
    droppedSamples: dropped.slice(0, 3),
  };
}
