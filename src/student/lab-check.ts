import type { Bridge } from "../bridge/http-bridge.js";
import { runCli } from "../cli/engine.js";
import { runPing, runShowRunning } from "../sim/runner.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { collectAddressingTable } from "./addressing.js";

export type LabObjective =
  | { readonly type: "ping"; readonly from: string; readonly to: string; readonly description?: string }
  | { readonly type: "route"; readonly device: string; readonly prefix: string; readonly next_hop?: string; readonly description?: string }
  | { readonly type: "interface_up"; readonly device: string; readonly interface: string; readonly expected_ip?: string; readonly description?: string }
  | { readonly type: "config_contains"; readonly device: string; readonly text: string; readonly description?: string }
  | { readonly type: "vlan_exists"; readonly device: string; readonly vlan: number; readonly name?: string; readonly description?: string };

export interface ObjectiveEvaluation {
  readonly objective: LabObjective;
  readonly passed: boolean;
  readonly label: string;
  readonly evidence: string;
}

export interface LabCheckReport {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly scorePercent: number;
  readonly results: readonly ObjectiveEvaluation[];
  readonly markdown: string;
}

export function checkRouteInOutput(
  output: string,
  prefix: string,
  nextHop?: string,
): { passed: boolean; evidence: string } {
  const lines = output.split(/\r?\n/);
  const matching = lines.filter(l => l.includes(prefix));
  if (matching.length === 0) {
    return { passed: false, evidence: `Prefix "${prefix}" not found in routing table.` };
  }
  if (nextHop) {
    const withHop = matching.find(l => l.includes(nextHop));
    if (!withHop) {
      return {
        passed: false,
        evidence: `Found "${prefix}" but not via "${nextHop}": ${matching[0]!.trim()}`,
      };
    }
    return { passed: true, evidence: withHop.trim() };
  }
  return { passed: true, evidence: matching[0]!.trim() };
}

export function checkInterfaceUpInOutput(
  output: string,
  iface: string,
  expectedIp?: string,
): { passed: boolean; evidence: string } {
  const norm = iface.toLowerCase();
  const lines = output.split(/\r?\n/);
  const match = lines.find(l => {
    const first = l.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return first === norm || first.startsWith(norm) || norm.startsWith(first);
  });
  if (!match) {
    return { passed: false, evidence: `Interface "${iface}" not found in \`show ip interface brief\`.` };
  }
  const cols = match.trim().split(/\s+/);
  const ip = cols[1] ?? "";
  // Status + protocol are the last two tokens (or "administratively down" + "down")
  const lowerLine = match.toLowerCase();
  const isUpUp = /\bup\s+up\s*$/i.test(match.trim());
  if (!isUpUp) {
    return { passed: false, evidence: `Interface is not up/up: ${match.trim()}` };
  }
  if (expectedIp && ip !== expectedIp && !lowerLine.includes(expectedIp.toLowerCase())) {
    return { passed: false, evidence: `Interface is up/up, but IP is "${ip}" instead of "${expectedIp}".` };
  }
  return { passed: true, evidence: match.trim() };
}

export function checkConfigContainsText(
  config: string,
  expected: string,
): { passed: boolean; evidence: string } {
  const idx = config.toLowerCase().indexOf(expected.toLowerCase());
  if (idx < 0) {
    return { passed: false, evidence: `Substring "${expected}" not found in running-config.` };
  }
  const lineStart = config.lastIndexOf("\n", idx) + 1;
  const lineEnd = config.indexOf("\n", idx);
  const snippet = config.slice(lineStart, lineEnd >= 0 ? lineEnd : undefined).trim();
  return { passed: true, evidence: `Matched config line: ${snippet}` };
}

export function checkVlanInOutput(
  output: string,
  vlanId: number,
  expectedName?: string,
): { passed: boolean; evidence: string } {
  const re = new RegExp(`^\\s*${vlanId}\\s+(\\S+)\\s+(active|act\\/lshut|suspended)`, "im");
  const match = output.match(re);
  if (!match) {
    return { passed: false, evidence: `VLAN ${vlanId} not found in \`show vlan brief\`.` };
  }
  const foundName = match[1] ?? "";
  if (expectedName && foundName.toLowerCase() !== expectedName.toLowerCase()) {
    return {
      passed: false,
      evidence: `VLAN ${vlanId} exists with name "${foundName}" (expected "${expectedName}").`,
    };
  }
  return { passed: true, evidence: match[0].trim() };
}

function objectiveLabel(obj: LabObjective): string {
  if (obj.description) return obj.description;
  switch (obj.type) {
    case "ping":
      return `Ping ${obj.from} → ${obj.to}`;
    case "route":
      return `Route ${obj.prefix}${obj.next_hop ? ` via ${obj.next_hop}` : ""} on ${obj.device}`;
    case "interface_up":
      return `Interface ${obj.interface} up/up on ${obj.device}${obj.expected_ip ? ` (${obj.expected_ip})` : ""}`;
    case "config_contains":
      return `Running-config on ${obj.device} contains "${obj.text}"`;
    case "vlan_exists":
      return `VLAN ${obj.vlan}${obj.name ? ` (${obj.name})` : ""} exists on ${obj.device}`;
  }
}

export function formatLabCheckMarkdown(results: readonly ObjectiveEvaluation[]): string {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 100;

  const lines = [
    `## Lab Verification Results: ${passed}/${total} passed (${pct}%)`,
    "",
    "| # | Status | Objective | Evidence |",
    "| --- | :---: | --- | --- |",
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const icon = r.passed ? "✅ PASS" : "❌ FAIL";
    const ev = r.evidence.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    lines.push(`| ${i + 1} | ${icon} | ${r.label} | \`${ev}\` |`);
  }
  return lines.join("\n");
}

export async function runLabCheck(
  bridge: Bridge,
  objectives: readonly LabObjective[],
): Promise<LabCheckReport> {
  const results: ObjectiveEvaluation[] = [];
  const routeCache = new Map<string, string>();
  const intBriefCache = new Map<string, string>();
  const runningCache = new Map<string, string>();
  const vlanCache = new Map<string, string>();
  let ipLookup: Map<string, string> | null = null;

  async function resolveTargetIp(target: string): Promise<string> {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target) || target.includes(":")) {
      return target;
    }
    if (!ipLookup) {
      ipLookup = new Map();
      const tbl = await collectAddressingTable(bridge);
      for (const r of tbl.rows) {
        if (r.ip !== "Unassigned" && !ipLookup.has(r.device.toLowerCase())) {
          ipLookup.set(r.device.toLowerCase(), r.ip);
        }
      }
    }
    return ipLookup.get(target.toLowerCase()) ?? target;
  }

  for (const obj of objectives) {
    const label = objectiveLabel(obj);
    try {
      if (obj.type === "ping") {
        const fromDev = await resolveCanvasDevice(bridge, obj.from);
        const targetIp = await resolveTargetIp(obj.to);
        // One warm-up ping for ARP, then actual ping
        await runPing(bridge, fromDev, targetIp, { timeoutMs: 12_000 }).catch(() => {});
        const { result } = await runPing(bridge, fromDev, targetIp, { timeoutMs: 20_000 });
        const ok = result.received > 0;
        results.push({
          objective: obj,
          passed: ok,
          label,
          evidence: `${result.received}/${result.sent || 4} replies (${result.successRate}%) to ${targetIp}`,
        });
      } else if (obj.type === "route") {
        const dev = await resolveCanvasDevice(bridge, obj.device);
        let out = routeCache.get(dev);
        if (out === undefined) {
          out = (await runCli(bridge, dev, "show ip route")).output;
          routeCache.set(dev, out);
        }
        const check = checkRouteInOutput(out, obj.prefix, obj.next_hop);
        results.push({ objective: obj, passed: check.passed, label, evidence: check.evidence });
      } else if (obj.type === "interface_up") {
        const dev = await resolveCanvasDevice(bridge, obj.device);
        let out = intBriefCache.get(dev);
        if (out === undefined) {
          out = (await runCli(bridge, dev, "show ip interface brief")).output;
          intBriefCache.set(dev, out);
        }
        const check = checkInterfaceUpInOutput(out, obj.interface, obj.expected_ip);
        results.push({ objective: obj, passed: check.passed, label, evidence: check.evidence });
      } else if (obj.type === "config_contains") {
        const dev = await resolveCanvasDevice(bridge, obj.device);
        let cfg = runningCache.get(dev);
        if (cfg === undefined) {
          cfg = await runShowRunning(bridge, dev);
          runningCache.set(dev, cfg);
        }
        const check = checkConfigContainsText(cfg, obj.text);
        results.push({ objective: obj, passed: check.passed, label, evidence: check.evidence });
      } else if (obj.type === "vlan_exists") {
        const dev = await resolveCanvasDevice(bridge, obj.device);
        let out = vlanCache.get(dev);
        if (out === undefined) {
          out = (await runCli(bridge, dev, "show vlan brief")).output;
          vlanCache.set(dev, out);
        }
        const check = checkVlanInOutput(out, obj.vlan, obj.name);
        results.push({ objective: obj, passed: check.passed, label, evidence: check.evidence });
      }
    } catch (err) {
      results.push({
        objective: obj,
        passed: false,
        label,
        evidence: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const failed = total - passed;
  const scorePercent = total > 0 ? Math.round((passed / total) * 100) : 100;

  return {
    passed,
    failed,
    total,
    scorePercent,
    results,
    markdown: formatLabCheckMarkdown(results),
  };
}
