/**
 * Apply L2 switching intents to a live canvas. Each helper is independent so
 * it can be invoked from a dedicated tool, but `applySwitching` glues them
 * for the cook step in topology recipes.
 *
 * Every helper:
 *   - groups its CLI per switch (one bulk per device),
 *   - wraps the body in enable + configure terminal,
 *   - dispatches via the bridge,
 *   - reports per-switch success/failure to the caller.
 */

import type { Bridge } from "../../bridge/http-bridge.js";
import {
  bulkCliJs,
  saveRunningConfigJs,
  setAccessPortNativeJs,
} from "../../ipc/generator.js";
import {
  etherChannelCli,
  portSecurityCli,
  trunkPortCli,
  vlanCreateCli,
  wrapInConfig,
} from "./cli.js";
import type {
  EtherChannelIntent,
  PortSecurityIntent,
  SwitchingIntent,
  TrunkIntent,
  VlanIntent,
} from "./intents.js";

export interface SwitchAction {
  readonly switch: string;
  readonly kind: "vlans" | "trunks" | "port-security" | "etherchannel";
  readonly cli: string;
}

export interface SwitchingReport {
  readonly actions: readonly SwitchAction[];
  readonly skipped: readonly { readonly reason: string; readonly target: string }[];
}

function groupBySwitch<T extends { switch: string }>(items: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const list = m.get(it.switch) ?? [];
    list.push(it);
    m.set(it.switch, list);
  }
  return m;
}

async function pushBulk(bridge: Bridge, device: string, body: string): Promise<void> {
  const reply = await bridge.sendAndWait(bulkCliJs(device, wrapInConfig(body)), { timeoutMs: 60_000 });
  if (reply === null) throw new Error(`switch CLI on ${device} timed out`);
  if (reply.startsWith("ERR:") || reply.startsWith("ERROR:")) {
    throw new Error(`switch CLI on ${device} rejected: ${reply}`);
  }
}

async function pushNative(bridge: Bridge, device: string, label: string, expr: string): Promise<string> {
  const reply = await bridge.sendAndWait(expr, { timeoutMs: 8_000 });
  if (reply === null) throw new Error(`${label} on ${device} timed out`);
  if (reply.startsWith("ERR:") || reply.startsWith("ERROR:")) {
    throw new Error(`${label} on ${device} rejected: ${reply}`);
  }
  return reply;
}

/**
 * Persists running→startup. Essential after native or CLI mutations
 * because PT can reset the model (e.g. when installing a NIM with
 * setPower(false)), reapplying only the startup-config and discarding
 * anything applied only in RAM.
 */
async function saveStartup(bridge: Bridge, device: string): Promise<void> {
  const reply = await bridge.sendAndWait(saveRunningConfigJs(device), { timeoutMs: 15_000 });
  if (reply === null) throw new Error(`write memory on ${device} timed out`);
  if (reply.startsWith("ERR:")) throw new Error(`write memory on ${device} rejected: ${reply}`);
}

/**
 * VLAN database creation stays on CLI: `vlan <id>` / `name <n>` is a
 * batched two-liner that has no measurable cost vs. a hypothetical native
 * VlanDb mutator (and the native surface for VLAN names is unverified).
 *
 * Per-port access assignment uses the native API (`setAccessPort` +
 * `setAccessVlan`), one IPC call per port. Verified in
 * `scripts/probe-switching-native.ts`.
 */
export async function applyVlans(bridge: Bridge, vlans: readonly VlanIntent[]): Promise<SwitchAction[]> {
  const out: SwitchAction[] = [];
  for (const [sw, list] of groupBySwitch(vlans)) {
    const dbBody = list.map(vlanCreateCli).join("\n");
    await pushBulk(bridge, sw, dbBody);
    out.push({ switch: sw, kind: "vlans", cli: dbBody });

    for (const v of list) {
      for (const port of v.accessPorts ?? []) {
        await pushNative(bridge, sw, `vlan ${v.id} access on ${port}`, setAccessPortNativeJs(sw, port, v.id));
      }
    }
    await saveStartup(bridge, sw);
  }
  return out;
}

/**
 * Trunks via CLI: `interface X / switchport mode trunk / switchport trunk
 * allowed vlan ... / switchport trunk native vlan N`. A single CLI run
 * per switch (all interfaces concatenated), wrapped in
 * `enable + configure terminal + end`.
 *
 * **Why CLI instead of native API**: the probe
 * `scripts/probe-3650-trunk-rendering.ts` (2026-05-01) discovered that the
 * native API exposes the methods but breaks running-config rendering:
 *  - `addTrunkVlans(start,end)` persists state but does NOT emit the line
 *    `switchport trunk allowed vlan X,Y` — VLAN pruning is lost in
 *    the .pkt and in any CLI export.
 *  - `setAdminOpMode(2)` DOES emit `switchport mode trunk` but requires
 *    per-model detection (integer values differ between classic IOS/XE).
 * The CLI path is uniform across 2960/3560/3650/IE-3400 and produces all 3
 * lines (`mode trunk` + `allowed vlan` + `native vlan`) in running-config,
 * which is the contract observable by downstream tooling.
 */
export async function applyTrunks(bridge: Bridge, trunks: readonly TrunkIntent[]): Promise<SwitchAction[]> {
  const out: SwitchAction[] = [];
  for (const [sw, list] of groupBySwitch(trunks)) {
    const body = list.map(trunkPortCli).join("\n");
    await pushBulk(bridge, sw, body);
    await saveStartup(bridge, sw);
    out.push({ switch: sw, kind: "trunks", cli: body });
  }
  return out;
}

export async function applyPortSecurity(
  bridge: Bridge,
  rules: readonly PortSecurityIntent[],
): Promise<SwitchAction[]> {
  const out: SwitchAction[] = [];
  for (const [sw, list] of groupBySwitch(rules)) {
    const body = list.map(portSecurityCli).join("\n");
    await pushBulk(bridge, sw, body);
    await saveStartup(bridge, sw);
    out.push({ switch: sw, kind: "port-security", cli: body });
  }
  return out;
}

export async function applyEtherChannels(
  bridge: Bridge,
  channels: readonly EtherChannelIntent[],
): Promise<SwitchAction[]> {
  const out: SwitchAction[] = [];
  for (const [sw, list] of groupBySwitch(channels)) {
    const body = list.map(etherChannelCli).join("\n");
    await pushBulk(bridge, sw, body);
    await saveStartup(bridge, sw);
    out.push({ switch: sw, kind: "etherchannel", cli: body });
  }
  return out;
}

export async function applySwitching(bridge: Bridge, s: SwitchingIntent): Promise<SwitchingReport> {
  const actions: SwitchAction[] = [];
  if (s.vlans && s.vlans.length > 0)            actions.push(...await applyVlans(bridge, s.vlans));
  if (s.trunks && s.trunks.length > 0)          actions.push(...await applyTrunks(bridge, s.trunks));
  if (s.portSecurity && s.portSecurity.length > 0) actions.push(...await applyPortSecurity(bridge, s.portSecurity));
  if (s.etherChannels && s.etherChannels.length > 0) actions.push(...await applyEtherChannels(bridge, s.etherChannels));
  return { actions, skipped: [] };
}

export function summarizeSwitching(r: SwitchingReport): string {
  if (r.actions.length === 0) return "No switching actions applied.";
  const counts = new Map<string, number>();
  for (const a of r.actions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(", ");
  return `Applied switching actions: ${parts}.`;
}
