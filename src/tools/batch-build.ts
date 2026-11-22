import { z } from "zod";
import { LAYOUT } from "../canvas/layout.js";
import { linkRegistry } from "../canvas/link-registry.js";
import { inferCable } from "../catalog/cables.js";
import { resolveModel } from "../catalog/devices.js";
import { resetCliCache } from "../cli/engine.js";
import { waitForCliReadyAll } from "../ipc/cli-wait.js";
import type { CableKind, DeviceCategory } from "../ipc/constants.js";
import {
  addDevicesBatchJs,
  addModuleJs,
  createLinksBatchJs,
  setEndpointDhcpJs,
  setEndpointsStaticIpBatchJs,
  type AddDeviceArgs,
  type CreateLinkArgs,
  type EndpointStaticIp,
} from "../ipc/generator.js";
import { clearCanvasJs } from "../ipc/sim.js";
import { isTeachModeEnabled } from "../student/teach.js";
import { invalidateDeviceCache } from "../util/devices.js";
import { ptError } from "../util/errors.js";
import { defineTool } from "./define.js";

const CableEnum = z.enum(["straight", "cross", "fiber", "console", "coaxial", "serial"]);

const DeviceSpecSchema = z.object({
  name: z.string().min(1).describe("Device name on the canvas (e.g. 'R1', 'SW1', 'PC1')."),
  model: z.string().min(1).describe("Packet Tracer model or alias (e.g. '2911', '2960-24TT', 'PC-PT')."),
  x: z.number().optional().describe("Optional logical X coordinate; auto-placed on a clean grid when omitted."),
  y: z.number().optional().describe("Optional logical Y coordinate; auto-placed on a clean grid when omitted."),
}).strict();

const ModuleSpecSchema = z.object({
  device: z.string().min(1).describe("Target device name (e.g. 'R1')."),
  slot: z.string().min(1).describe("Chassis slot path (e.g. '0/0/0' on 2911/1941, '0/1' on 2901/4321)."),
  model: z.string().min(1).describe("Hardware module model (e.g. 'HWIC-2T', 'NIM-2T')."),
}).strict();

const LinkSpecSchema = z.object({
  device_a: z.string().min(1).describe("First device name."),
  port_a: z.string().min(1).describe("Port name on device_a (e.g. 'GigabitEthernet0/0', 'FastEthernet0/1')."),
  device_b: z.string().min(1).describe("Second device name."),
  port_b: z.string().min(1).describe("Port name on device_b."),
  cable: CableEnum.optional().describe("Cable type; auto-inferred from port/device categories when omitted."),
}).strict();

const PcSpecSchema = z.object({
  device: z.string().min(1).describe("End-host device name (e.g. 'PC1', 'Server0')."),
  port: z.string().min(1).default("FastEthernet0").describe("Interface name (default 'FastEthernet0')."),
  ip: z.string().optional().describe("Static IPv4 address (ignored when dhcp=true)."),
  mask: z.string().optional().describe("Static IPv4 subnet mask (ignored when dhcp=true)."),
  gateway: z.string().optional().describe("Optional IPv4 default gateway."),
  dhcp: z.boolean().optional().describe("Set true to configure the host for DHCP instead of static IP."),
}).strict();

const InputSchema = z.object({
  clear_first: z.boolean().default(false)
    .describe("If true, wipe the canvas via File > New before placing devices."),
  devices: z.array(DeviceSpecSchema).default([])
    .describe("Devices to place in a single batched IPC call."),
  modules: z.array(ModuleSpecSchema).default([])
    .describe("Hardware modules to install after placing devices and before wiring links."),
  links: z.array(LinkSpecSchema).default([])
    .describe("Physical links to wire in a single batched IPC call."),
  pcs: z.array(PcSpecSchema).default([])
    .describe("End-host static IP or DHCP settings to apply."),
  wait_for_cli: z.boolean().default(true)
    .describe("If true (default), wait concurrently for all placed routers/switches to reach an IOS prompt."),
  dry_run: z.boolean().optional()
    .describe("Teach mode: preview the build plan without touching Packet Tracer."),
});

function defaultYForCategory(cat: DeviceCategory): number {
  switch (cat) {
    case "cloud": return LAYOUT.Y_CLOUD;
    case "router": return LAYOUT.Y_ROUTER;
    case "accesspoint": return LAYOUT.Y_AP;
    case "switch": return LAYOUT.Y_SWITCH;
    case "server": return LAYOUT.Y_SERVER;
    default: return LAYOUT.Y_ENDPOINT;
  }
}

function inferLinkCable(
  portA: string,
  portB: string,
  catA?: DeviceCategory,
  catB?: DeviceCategory,
): CableKind {
  if (/^serial/i.test(portA) || /^serial/i.test(portB)) return "serial";
  if (/console|rs[\s-]*232/i.test(portA) || /console|rs[\s-]*232/i.test(portB)) return "console";
  if (/coaxial/i.test(portA) || /coaxial/i.test(portB)) return "coaxial";
  if (catA && catB) return inferCable(catA, catB);
  return "straight";
}

export const registerBatchBuildTool = defineTool({
  name: "pt_batch_build",
  description:
    "High-speed single-turn topology builder: optionally clear the canvas, place multiple devices in one batched IPC call, install hardware modules, wire all links in one batched IPC call, configure PC/Server static IPs or DHCP, and wait concurrently for all routers/switches to boot. Dramatically faster than calling pt_add_device / pt_create_link / pt_set_pc one by one.",
  category: "Canvas Authoring",
  input: InputSchema,
  handler: async ({ clear_first, devices, modules, links, pcs, wait_for_cli, dry_run }, { bridge }) => {
    const categoryByName = new Map<string, DeviceCategory>();
    const rowCounters = new Map<number, number>();
    const deviceArgs: AddDeviceArgs[] = [];
    const iosBootTargets = new Set<string>();

    for (const dev of devices) {
      const resolved = resolveModel(dev.model);
      if (!resolved) {
        throw ptError(
          "UNKNOWN_MODEL",
          `Unknown model "${dev.model}" for device "${dev.name}".`,
          "Call pt_list_devices to check valid Packet Tracer models.",
        );
      }
      categoryByName.set(dev.name, resolved.category);
      const y = dev.y ?? defaultYForCategory(resolved.category);
      const slotIdx = rowCounters.get(y) ?? 0;
      const x = dev.x ?? (LAYOUT.X_START + slotIdx * LAYOUT.X_SPACING);
      rowCounters.set(y, slotIdx + 1);

      deviceArgs.push({
        name: dev.name,
        category: resolved.category,
        model: resolved.ptType,
        x,
        y,
      });
      if (resolved.category === "router" || resolved.category === "switch") {
        iosBootTargets.add(dev.name);
      }
    }

    const linkArgs: CreateLinkArgs[] = links.map(lnk => ({
      deviceA: lnk.device_a,
      portA: lnk.port_a,
      deviceB: lnk.device_b,
      portB: lnk.port_b,
      cable: lnk.cable ?? inferLinkCable(
        lnk.port_a,
        lnk.port_b,
        categoryByName.get(lnk.device_a),
        categoryByName.get(lnk.device_b),
      ),
    }));

    if (isTeachModeEnabled(dry_run)) {
      const summaryLines = [
        "[Teach Mode — Dry Run] Batch topology plan NOT applied to Packet Tracer.",
        `  clear_first: ${clear_first}`,
        `  devices (${deviceArgs.length}): ${deviceArgs.map(d => `${d.name}(${d.model})`).join(", ") || "none"}`,
        `  modules (${modules.length}): ${modules.map(m => `${m.device}[${m.slot}]=${m.model}`).join(", ") || "none"}`,
        `  links (${linkArgs.length}): ${linkArgs.map(l => `${l.deviceA}:${l.portA}<->${l.deviceB}:${l.portB}(${l.cable})`).join(", ") || "none"}`,
        `  pcs (${pcs.length}): ${pcs.map(p => p.dhcp ? `${p.device}=DHCP` : `${p.device}=${p.ip ?? "?"}`).join(", ") || "none"}`,
      ];
      return {
        text: summaryLines.join("\n"),
        structured: {
          dry_run: true,
          clear_first,
          devices: deviceArgs,
          modules,
          links: linkArgs,
          pcs,
        },
      };
    }

    if (clear_first) {
      const clearReply = await bridge.sendAndWait(clearCanvasJs(false), { timeoutMs: 15_000 });
      if (!clearReply || clearReply.startsWith("ERR") || !clearReply.startsWith("OK|true")) {
        throw ptError("CLEAR_FAILED", `Failed to clear canvas before batch build: ${clearReply ?? "timeout"}`);
      }
      linkRegistry.clear();
      resetCliCache();
      invalidateDeviceCache(bridge);
    }

    const placedDevices: string[] = [];
    const errors: string[] = [];

    if (deviceArgs.length > 0) {
      const reply = await bridge.sendAndWait(addDevicesBatchJs(deviceArgs), {
        timeoutMs: Math.max(20_000, deviceArgs.length * 4_000),
      });
      if (!reply) {
        throw ptError("BRIDGE_TIMEOUT", `Timed out placing ${deviceArgs.length} device(s) in batch.`);
      }
      let outcomes: Array<{ name: string; ok: boolean; error?: string }>;
      try {
        outcomes = JSON.parse(reply);
      } catch {
        throw ptError("UNEXPECTED_REPLY", `Unexpected batch addDevice reply: ${reply.slice(0, 120)}`);
      }
      for (const item of outcomes) {
        if (item.ok) {
          placedDevices.push(item.name);
          resetCliCache(item.name);
        } else {
          errors.push(`device ${item.name}: ${item.error ?? "failed"}`);
        }
      }
      invalidateDeviceCache(bridge);
    }

    const installedModules: string[] = [];
    for (const mod of modules) {
      const reply = await bridge.sendAndWait(addModuleJs(mod.device, mod.slot, mod.model), { timeoutMs: 15_000 });
      if (reply === "OK") {
        installedModules.push(`${mod.device}[${mod.slot}]=${mod.model}`);
        // Installing a module power-cycles the host; ensure CLI wait covers it
        iosBootTargets.add(mod.device);
        resetCliCache(mod.device);
      } else {
        errors.push(`module ${mod.device}[${mod.slot}]=${mod.model}: ${reply ?? "timeout"}`);
      }
    }

    const wiredLinks: string[] = [];
    if (linkArgs.length > 0) {
      const reply = await bridge.sendAndWait(createLinksBatchJs(linkArgs), {
        timeoutMs: Math.max(20_000, linkArgs.length * 3_000),
      });
      if (!reply) {
        throw ptError("BRIDGE_TIMEOUT", `Timed out cabling ${linkArgs.length} link(s) in batch.`);
      }
      let outcomes: Array<{ index: number; ok: boolean; error?: string }>;
      try {
        outcomes = JSON.parse(reply);
      } catch {
        throw ptError("UNEXPECTED_REPLY", `Unexpected batch createLink reply: ${reply.slice(0, 120)}`);
      }
      for (let i = 0; i < linkArgs.length; i++) {
        const lnk = linkArgs[i]!;
        const out = outcomes[i];
        const tag = `${lnk.deviceA}:${lnk.portA} <-> ${lnk.deviceB}:${lnk.portB}`;
        if (out?.ok) {
          linkRegistry.register(lnk.deviceA, lnk.portA, lnk.deviceB, lnk.portB);
          wiredLinks.push(tag);
        } else {
          errors.push(`link ${tag}: ${out?.error ?? "failed"}`);
        }
      }
    }

    const staticPcs: EndpointStaticIp[] = [];
    const dhcpPcs: string[] = [];
    for (const pc of pcs) {
      if (pc.dhcp) {
        dhcpPcs.push(pc.device);
      } else {
        if (!pc.ip || !pc.mask) {
          errors.push(`pc ${pc.device}: static config requires both ip and mask (or set dhcp: true)`);
          continue;
        }
        staticPcs.push({
          device: pc.device,
          port: pc.port,
          ip: pc.ip,
          mask: pc.mask,
          ...(pc.gateway ? { gateway: pc.gateway } : {}),
        });
      }
    }

    const configuredPcs: string[] = [];
    if (staticPcs.length > 0) {
      const reply = await bridge.sendAndWait(setEndpointsStaticIpBatchJs(staticPcs), {
        timeoutMs: Math.max(12_000, staticPcs.length * 3_000),
      });
      if (!reply) {
        errors.push(`batch static IP timed out (${staticPcs.length} host(s))`);
      } else {
        try {
          const outcomes = JSON.parse(reply) as Array<{ device: string; ok: boolean; error?: string }>;
          for (const item of outcomes) {
            if (item.ok) configuredPcs.push(item.device);
            else errors.push(`pc ${item.device}: ${item.error ?? "failed"}`);
          }
        } catch {
          errors.push(`unexpected batch static IP reply: ${reply.slice(0, 120)}`);
        }
      }
    }

    for (const devName of dhcpPcs) {
      const reply = await bridge.sendAndWait(setEndpointDhcpJs(devName), { timeoutMs: 10_000 });
      if (reply && (reply === "OK" || reply.startsWith("OK:"))) {
        configuredPcs.push(`${devName} (DHCP)`);
      } else {
        errors.push(`pc ${devName} DHCP: ${reply ?? "timeout"}`);
      }
    }

    let cliReadyCount = 0;
    if (wait_for_cli && iosBootTargets.size > 0) {
      const targets = [...iosBootTargets];
      await waitForCliReadyAll(bridge, targets);
      cliReadyCount = targets.length;
    }

    const lines = [
      `Batch build complete:`,
      `  devices placed:     ${placedDevices.length}/${deviceArgs.length}`,
      `  modules installed:  ${installedModules.length}/${modules.length}`,
      `  links wired:        ${wiredLinks.length}/${linkArgs.length}`,
      `  hosts configured:   ${configuredPcs.length}/${pcs.length}`,
      ...(wait_for_cli && iosBootTargets.size > 0 ? [`  IOS CLIs ready:     ${cliReadyCount}`] : []),
    ];
    if (errors.length > 0) {
      lines.push("", "Errors:");
      for (const e of errors) lines.push(`  - ${e}`);
    }

    return {
      text: lines.join("\n"),
      isError: errors.length > 0 && placedDevices.length === 0 && wiredLinks.length === 0 && configuredPcs.length === 0,
      structured: {
        placedDevices,
        installedModules,
        wiredLinks,
        configuredPcs,
        cliReadyCount,
        errors,
      },
    };
  },
});
