import type { Bridge } from "../bridge/http-bridge.js";
import { captureSnapshot } from "../canvas/snapshot.js";
import { intToIp, ipToInt } from "../canvas/subnetting.js";
import { bulkCliJs, setEndpointStaticIpJs } from "../ipc/generator.js";
import { runShowRunning } from "../sim/runner.js";
import { collectAddressingTable, maskToPrefix, type AddressingRow } from "./addressing.js";
import {
  isEndpointDevice,
  isRouterDevice,
  isValidIpv4,
  parseStaticRoutesFromConfig,
  type DiagnoseInputState,
  type LabFaultFix,
} from "./fault-diagnose.js";
import { isTeachModeEnabled } from "./teach.js";

export type BreakDifficulty = "easy" | "medium" | "hard";

export interface PlannedBrokenFault {
  readonly id: string;
  readonly difficulty: BreakDifficulty;
  readonly device: string;
  readonly studentSymptom: string;
  readonly faultSummary: string;
  readonly injectAction: LabFaultFix;
  readonly restoreAction: LabFaultFix;
}

export interface BreakLabResult {
  readonly difficulty: BreakDifficulty;
  readonly faultsPlanned: number;
  readonly faultsInjected: number;
  readonly dryRun: boolean;
  readonly revealSolutions: boolean;
  readonly faults: readonly PlannedBrokenFault[];
  readonly markdown: string;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shiftLastOctet(ip: string, delta: number): string {
  const n = ipToInt(ip);
  const last = n & 0xff;
  const next = last + delta <= 254 && last + delta >= 1 ? last + delta : (last === 250 ? 251 : 250);
  return intToIp(((n & 0xffffff00) | (next & 0xff)) >>> 0);
}

function shiftThirdOctet(ip: string, delta = 10): string {
  const n = ipToInt(ip);
  const third = (n >>> 16) & 0xff;
  const nextThird = (third + delta) & 0xff || 10;
  return intToIp(((n & 0xffff00ff) | (nextThird << 8)) >>> 0);
}

/**
 * Plan deterministic realistic lab faults to inject into a healthy topology so
 * students can practice troubleshooting without guessing blindly.
 */
export function planLabFaults(
  state: DiagnoseInputState,
  opts: {
    readonly count?: number;
    readonly difficulty?: BreakDifficulty;
    readonly seed?: number;
  } = {},
): PlannedBrokenFault[] {
  const count = Math.min(5, Math.max(1, opts.count ?? 2));
  const difficulty: BreakDifficulty = opts.difficulty ?? "medium";
  const rng = createMulberry32(opts.seed ?? 42);

  const candidates: PlannedBrokenFault[] = [];
  const { snapshot, addressingRows } = state;
  const devByName = new Map(snapshot.devices.map(d => [d.name, d]));
  const rowsByDev = new Map<string, AddressingRow[]>();
  for (const row of addressingRows) {
    const list = rowsByDev.get(row.device) ?? [];
    list.push(row);
    rowsByDev.set(row.device, list);
  }

  // Easy candidates: router interface shutdown + PC wrong gateway
  for (const dev of snapshot.devices) {
    if (!isRouterDevice(dev) || !dev.powered) continue;
    for (const port of dev.ports) {
      if (!port.linked || !isValidIpv4(port.ip)) continue;
      candidates.push({
        id: "TMP",
        difficulty: "easy",
        device: dev.name,
        studentSymptom: `Hosts or neighbors reachable through ${dev.name} have lost connectivity.`,
        faultSummary: `Shut down active interface ${port.name} (${port.ip}) on ${dev.name}.`,
        injectAction: {
          kind: "ios_cli",
          device: dev.name,
          commands: ["configure terminal", `interface ${port.name}`, "shutdown", "end"],
        },
        restoreAction: {
          kind: "ios_cli",
          device: dev.name,
          commands: ["configure terminal", `interface ${port.name}`, "no shutdown", "end"],
        },
      });
      break;
    }
  }

  for (const dev of snapshot.devices) {
    if (!isEndpointDevice(dev) || !dev.powered) continue;
    const row = (rowsByDev.get(dev.name) ?? []).find(r => isValidIpv4(r.ip) && isValidIpv4(r.gateway));
    if (!row) continue;

    const brokenGw = shiftLastOctet(row.gateway, 5);
    candidates.push({
      id: "TMP",
      difficulty: "easy",
      device: dev.name,
      studentSymptom: `${dev.name} cannot communicate with devices outside its local subnet.`,
      faultSummary: `Changed ${dev.name} Default Gateway from ${row.gateway} to unreachable IP ${brokenGw}.`,
      injectAction: {
        kind: "pc_ip",
        device: dev.name,
        pcConfig: { port: row.interface, ip: row.ip, mask: row.mask, gateway: brokenGw },
      },
      restoreAction: {
        kind: "pc_ip",
        device: dev.name,
        pcConfig: { port: row.interface, ip: row.ip, mask: row.mask, gateway: row.gateway },
      },
    });
  }

  // Medium candidates: PC classful mask trap + PC wrong subnet IP
  if (difficulty === "medium" || difficulty === "hard") {
    for (const dev of snapshot.devices) {
      if (!isEndpointDevice(dev) || !dev.powered) continue;
      const row = (rowsByDev.get(dev.name) ?? []).find(r => isValidIpv4(r.ip) && isValidIpv4(r.mask));
      if (!row) continue;

      const brokenMask = row.mask === "255.0.0.0" ? "255.255.255.0" : "255.0.0.0";
      const gw = isValidIpv4(row.gateway) ? row.gateway : undefined;
      candidates.push({
        id: "TMP",
        difficulty: "medium",
        device: dev.name,
        studentSymptom: `${dev.name} has an IP configured yet fails intermittent subnet or gateway checks.`,
        faultSummary: `Changed ${dev.name} subnet mask from ${row.mask} to ${brokenMask} (classful/prefix mismatch).`,
        injectAction: {
          kind: "pc_ip",
          device: dev.name,
          pcConfig: { port: row.interface, ip: row.ip, mask: brokenMask, gateway: gw },
        },
        restoreAction: {
          kind: "pc_ip",
          device: dev.name,
          pcConfig: { port: row.interface, ip: row.ip, mask: row.mask, gateway: gw },
        },
      });

      const wrongIp = shiftThirdOctet(row.ip, 10);
      candidates.push({
        id: "TMP",
        difficulty: "medium",
        device: dev.name,
        studentSymptom: `${dev.name} appears up at Layer 1 but fails even local gateway pings.`,
        faultSummary: `Moved ${dev.name} IP from ${row.ip} into mismatched subnet (${wrongIp}).`,
        injectAction: {
          kind: "pc_ip",
          device: dev.name,
          pcConfig: { port: row.interface, ip: wrongIp, mask: row.mask, gateway: gw },
        },
        restoreAction: {
          kind: "pc_ip",
          device: dev.name,
          pcConfig: { port: row.interface, ip: row.ip, mask: row.mask, gateway: gw },
        },
      });
    }
  }

  // Hard candidates: self-pointing static route & router WAN subnet mask mismatch
  if (difficulty === "hard") {
    for (const dev of snapshot.devices) {
      if (!isRouterDevice(dev) || !dev.powered) continue;

      const cfg = state.routerRunningConfig?.[dev.name];
      if (cfg) {
        const staticRoutes = parseStaticRoutesFromConfig(cfg);
        const firstRoute = staticRoutes[0];
        const selfIp = dev.ports.find(p => isValidIpv4(p.ip))?.ip;
        if (firstRoute && selfIp && firstRoute.nextHop !== selfIp) {
          candidates.push({
            id: "TMP",
            difficulty: "hard",
            device: dev.name,
            studentSymptom: `Remote subnets reached via ${dev.name} fail silently despite static routing entries.`,
            faultSummary: `Pointed static route \`ip route ${firstRoute.network} ${firstRoute.mask}\` on ${dev.name} to its own IP (${selfIp}) instead of ${firstRoute.nextHop}.`,
            injectAction: {
              kind: "ios_cli",
              device: dev.name,
              commands: [
                "configure terminal",
                `no ${firstRoute.rawLine}`,
                `ip route ${firstRoute.network} ${firstRoute.mask} ${selfIp}`,
                "end",
              ],
            },
            restoreAction: {
              kind: "ios_cli",
              device: dev.name,
              commands: [
                "configure terminal",
                `no ip route ${firstRoute.network} ${firstRoute.mask} ${selfIp}`,
                firstRoute.rawLine,
                "end",
              ],
            },
          });
        }
      }

      // Router-to-router WAN mask mismatch
      const wanLink = snapshot.links.find(l => {
        const other = l.aDevice === dev.name ? l.bDevice : l.bDevice === dev.name ? l.aDevice : undefined;
        if (!other) return false;
        const otherDev = devByName.get(other);
        return !!otherDev && isRouterDevice(otherDev);
      });
      if (wanLink) {
        const portName = wanLink.aDevice === dev.name ? wanLink.aPort : wanLink.bPort;
        const port = dev.ports.find(p => p.name === portName);
        if (port && isValidIpv4(port.ip) && maskToPrefix(port.mask) !== null) {
          const wrongMask = port.mask === "255.255.255.248" ? "255.255.255.252" : "255.255.255.248";
          candidates.push({
            id: "TMP",
            difficulty: "hard",
            device: dev.name,
            studentSymptom: `Routing adjacencies or transit traffic across a WAN link involving ${dev.name} are failing.`,
            faultSummary: `Changed ${dev.name}/${port.name} mask from ${port.mask} to ${wrongMask}, causing a WAN peer mask mismatch.`,
            injectAction: {
              kind: "ios_cli",
              device: dev.name,
              commands: [
                "configure terminal",
                `interface ${port.name}`,
                `ip address ${port.ip} ${wrongMask}`,
                "end",
              ],
            },
            restoreAction: {
              kind: "ios_cli",
              device: dev.name,
              commands: [
                "configure terminal",
                `interface ${port.name}`,
                `ip address ${port.ip} ${port.mask}`,
                "end",
              ],
            },
          });
        }
      }
    }
  }

  // Filter by difficulty preference first, then fall back to all candidates if needed
  const tierRank: Record<BreakDifficulty, number> = { easy: 1, medium: 2, hard: 3 };
  const exactPool = candidates.filter(c => c.difficulty === difficulty);
  const fallbackPool = candidates.filter(c => tierRank[c.difficulty] <= tierRank[difficulty]);

  const shuffle = <T,>(arr: T[]): T[] => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };

  const ordered = [...shuffle(exactPool), ...shuffle(fallbackPool), ...shuffle(candidates)];
  const selected: PlannedBrokenFault[] = [];
  const usedDevices = new Set<string>();

  for (const cand of ordered) {
    if (selected.length >= count) break;
    if (usedDevices.has(cand.device)) continue;
    usedDevices.add(cand.device);
    selected.push({ ...cand, id: `T${selected.length + 1}` });
  }

  // If fewer distinct devices than requested count, allow second fault on another aspect
  if (selected.length < count) {
    const usedKeys = new Set(selected.map(s => `${s.device}|${s.faultSummary}`));
    for (const cand of ordered) {
      if (selected.length >= count) break;
      const key = `${cand.device}|${cand.faultSummary}`;
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      selected.push({ ...cand, id: `T${selected.length + 1}` });
    }
  }

  return selected;
}

function formatRestoreSnippet(action: LabFaultFix): string {
  if (action.kind === "ios_cli" && action.commands) {
    return `${action.device}: \`${action.commands.join(" ; ")}\``;
  }
  if (action.kind === "pc_ip" && action.pcConfig) {
    const c = action.pcConfig;
    return `${action.device} (${c.port}): IP \`${c.ip}\`, Mask \`${c.mask}\`${c.gateway ? `, GW \`${c.gateway}\`` : ""}`;
  }
  return `Power on ${action.device}`;
}

export function formatBreakLabMarkdown(
  faults: readonly PlannedBrokenFault[],
  difficulty: BreakDifficulty,
  injectedCount: number,
  dryRun: boolean,
  revealSolutions: boolean,
): string {
  const lines: string[] = [
    `## Troubleshooting Challenge (${difficulty.toUpperCase()} — ${faults.length} ticket(s))`,
    "",
    dryRun
      ? "Mode: **Dry Run (Teach Mode)** — no faults were applied to Packet Tracer."
      : `Injected **${injectedCount}** fault(s) into the live workspace. Use CLI verification and \`pt_diagnose_faults\` / \`pt_check_lab\` to resolve every ticket!`,
    "",
    "### Reported Tickets",
    "",
  ];

  if (faults.length === 0) {
    lines.push("_No configurable devices with IPs were found to inject faults into._");
    return lines.join("\n");
  }

  for (const f of faults) {
    lines.push(`- **Ticket ${f.id}:** ${f.studentSymptom}`);
  }

  if (revealSolutions) {
    lines.push("", "### Answer Key & Restore Commands", "");
    for (const f of faults) {
      lines.push(`- **${f.id} (${f.device}) — ${f.difficulty}:** ${f.faultSummary}`);
      lines.push(`  - Restore: ${formatRestoreSnippet(f.restoreAction)}`);
    }
  } else {
    lines.push(
      "",
      "> Spoilers hidden! Try fixing the lab yourself, run `pt_ping_matrix` or `pt_diagnose_faults({ mode: \"hints\" })` to check progress, or re-run with `reveal_solutions: true`.",
    );
  }

  return lines.join("\n");
}

/**
 * Inject realistic troubleshooting faults into a live Packet Tracer topology for student exam practice.
 */
export async function breakLabLive(
  bridge: Bridge,
  opts: {
    readonly count?: number;
    readonly difficulty?: BreakDifficulty;
    readonly revealSolutions?: boolean;
    readonly dryRun?: boolean;
    readonly seed?: number;
  } = {},
): Promise<BreakLabResult> {
  const difficulty: BreakDifficulty = opts.difficulty ?? "medium";
  const revealSolutions = opts.revealSolutions ?? false;
  const dryRun = isTeachModeEnabled(opts.dryRun);

  const snapshot = await captureSnapshot(bridge);
  const tbl = await collectAddressingTable(bridge, { includeUnassigned: false });

  const routerRunningConfig: Record<string, string> = {};
  if (difficulty === "hard") {
    for (const dev of snapshot.devices) {
      if (!isRouterDevice(dev) || !dev.powered) continue;
      const cfg = await runShowRunning(bridge, dev.name).catch(() => null);
      if (cfg) routerRunningConfig[dev.name] = cfg;
    }
  }

  const faults = planLabFaults(
    {
      snapshot,
      addressingRows: tbl.rows,
      routerRunningConfig,
    },
    {
      count: opts.count ?? 2,
      difficulty,
      seed: opts.seed,
    },
  );

  let injectedCount = 0;
  if (!dryRun) {
    for (const fault of faults) {
      const action = fault.injectAction;
      if (action.kind === "ios_cli" && action.commands && action.commands.length > 0) {
        const res = await bridge.sendAndWait(bulkCliJs(action.device, action.commands.join("\n")), { timeoutMs: 20_000 });
        if (res && !res.startsWith("ERR:")) injectedCount++;
      } else if (action.kind === "pc_ip" && action.pcConfig) {
        const c = action.pcConfig;
        const res = await bridge.sendAndWait(
          setEndpointStaticIpJs({
            device: action.device,
            port: c.port,
            ip: c.ip,
            mask: c.mask,
            gateway: c.gateway,
          }),
          { timeoutMs: 12_000 },
        );
        if (res && !res.startsWith("ERR:")) injectedCount++;
      }
    }
  }

  return {
    difficulty,
    faultsPlanned: faults.length,
    faultsInjected: injectedCount,
    dryRun,
    revealSolutions,
    faults,
    markdown: formatBreakLabMarkdown(faults, difficulty, injectedCount, dryRun, revealSolutions),
  };
}
