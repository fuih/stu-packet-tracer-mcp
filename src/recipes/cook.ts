/**
 * "Cook" a blueprint into the live canvas. The recipe walks the blueprint and
 * synthesises bridge operations in this order:
 *
 *   1) place every declared device that is not already on the canvas
 *   2) wire every declared link whose endpoints are not already linked
 *   3) hand off to the addressing recipe to assign IPs
 *   4) hand off to the routing recipe matching blueprint.routing
 *
 * Each step queries a fresh snapshot before acting, so re-running cook against
 * a partially built canvas is well-defined: it picks up where it left off.
 */

import type { Bridge } from "../bridge/http-bridge.js";
import { resolveModel } from "../catalog/devices.js";
import { captureSnapshot } from "../canvas/snapshot.js";
import {
  type LinkObservation,
  linkKey,
} from "../canvas/types.js";
import {
  addDevicesBatchJs,
  bulkCliJs,
  createLinksBatchJs,
  linksUpStatusBatchJs,
  saveRunningConfigsBatchJs,
  type AddDeviceArgs,
  type CreateLinkArgs,
} from "../ipc/generator.js";
import { linkRegistry } from "../canvas/link-registry.js";
import { resetCliCache } from "../cli/engine.js";
import { wrapInConfig } from "../ipc/cli-prologue.js";
import { waitForCliReadyAll } from "../ipc/cli-wait.js";
import { invalidateDeviceCache } from "../util/devices.js";
import {
  validateBlueprintReferences,
  withDefaults,
  type Blueprint,
} from "./blueprint.js";
import { applyAddressing, type AddressingReport } from "./addressing.js";
import { applyBgp, type BgpReport } from "./routing/bgp.js";
import { applyHsrp, type HsrpReport } from "./routing/hsrp.js";
import { applyOspf, type OspfReport } from "./routing/ospf.js";
import { applyEigrp, type EigrpReport } from "./routing/eigrp.js";
import { applyRip, type RipReport } from "./routing/rip.js";
import { applyStaticRouting, type StaticRoutingReport } from "./routing/static.js";
import { applySwitching, type SwitchingReport } from "./switching/apply.js";
import { applyServices, type ServicesReport } from "./services/apply.js";
import type { ServicesIntent } from "./services/intents.js";
import { applyWireless, type WirelessReport } from "./wireless/apply.js";
import type { WirelessIntent } from "./wireless/intents.js";
import { applyVoip, type VoipReport } from "./voip/apply.js";
import type { VoipIntent } from "./voip/intents.js";
import { applyIpv6, type Ipv6Report } from "./ipv6/apply.js";
import type { Ipv6Intent } from "./ipv6/intents.js";

interface ExtraCliReport {
  readonly device: string;
  readonly label?: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface CookReport {
  readonly blueprint: string;
  readonly placedDevices: readonly string[];
  readonly skippedDevices: readonly { readonly name: string; readonly reason: string }[];
  readonly placedLinks: readonly string[];
  readonly skippedLinks: readonly { readonly link: string; readonly reason: string }[];
  readonly addressing: AddressingReport;
  readonly routing:
    | { kind: "static"; report: StaticRoutingReport }
    | { kind: "ospf"; report: OspfReport }
    | { kind: "eigrp"; report: EigrpReport }
    | { kind: "rip"; report: RipReport }
    | { kind: "none" };
  readonly switching?: SwitchingReport;
  readonly services?: ServicesReport;
  readonly wireless?: WirelessReport;
  readonly voip?: VoipReport;
  readonly bgp?: BgpReport;
  readonly hsrp?: HsrpReport;
  readonly ipv6?: Ipv6Report;
  readonly extraCli?: readonly ExtraCliReport[];
}

export async function cookBlueprint(bridge: Bridge, raw: Blueprint): Promise<CookReport> {
  const refs = validateBlueprintReferences(raw);
  if (refs.length > 0) throw new Error(`blueprint has invalid references:\n  - ${refs.join("\n  - ")}`);
  const blueprint = withDefaults(raw);

  let snap = await captureSnapshot(bridge);
  const placedDevices: string[] = [];
  const skippedDevices: { name: string; reason: string }[] = [];
  const toPlace: AddDeviceArgs[] = [];

  for (const dev of blueprint.devices) {
    if (snap.devices.find(d => d.name === dev.name)) {
      skippedDevices.push({ name: dev.name, reason: "already on canvas" });
      continue;
    }
    const resolved = resolveModel(dev.model);
    if (!resolved) {
      skippedDevices.push({ name: dev.name, reason: `unknown model '${dev.model}'` });
      continue;
    }
    toPlace.push({
      name: dev.name,
      category: resolved.category,
      model: resolved.ptType,
      x: dev.x,
      y: dev.y,
    });
  }

  if (toPlace.length > 0) {
    const reply = await bridge.sendAndWait(addDevicesBatchJs(toPlace), {
      timeoutMs: Math.max(20_000, toPlace.length * 4_000),
    });
    if (reply === null) throw new Error(`batch addDevice timed out (${toPlace.length} device(s))`);
    let outcomes: Array<{ name: string; ok: boolean; error?: string }>;
    try {
      outcomes = JSON.parse(reply);
    } catch {
      throw new Error(`Unexpected batch addDevice reply: ${reply.slice(0, 120)}`);
    }
    for (const item of outcomes) {
      if (item.ok) {
        placedDevices.push(item.name);
        resetCliCache(item.name);
      } else {
        skippedDevices.push({ name: item.name, reason: item.error ?? "addDevice failed" });
      }
    }
    invalidateDeviceCache(bridge);
  }

  const cliDevicesToWait: string[] = [];
  for (const dev of blueprint.devices) {
    const resolved = resolveModel(dev.model);
    if (!resolved || (resolved.category !== "router" && resolved.category !== "switch")) continue;
    if (!snap.devices.find(d => d.name === dev.name) && !placedDevices.includes(dev.name)) continue;
    cliDevicesToWait.push(dev.name);
  }
  if (cliDevicesToWait.length > 0) {
    await waitForCliReadyAll(bridge, cliDevicesToWait);
  }

  // Refresh snapshot before wiring so the link-presence test is accurate.
  snap = await captureSnapshot(bridge);
  const existingLinks = new Set(snap.links.map(linkKey));
  const placedLinks: string[] = [];
  const skippedLinks: { link: string; reason: string }[] = [];
  const linksToWire: Array<{ args: CreateLinkArgs; tag: string; key: string }> = [];

  for (const lnk of blueprint.links) {
    const candidate: LinkObservation = {
      aDevice: lnk.aDevice,
      aPort: lnk.aPort,
      bDevice: lnk.bDevice,
      bPort: lnk.bPort,
    };
    const key = linkKey(candidate);
    const tag = `${lnk.aDevice}/${lnk.aPort} <-> ${lnk.bDevice}/${lnk.bPort}`;
    if (existingLinks.has(key)) {
      skippedLinks.push({ link: tag, reason: "already wired" });
      continue;
    }
    if (!snap.devices.find(d => d.name === lnk.aDevice) || !snap.devices.find(d => d.name === lnk.bDevice)) {
      skippedLinks.push({ link: tag, reason: "endpoint missing on canvas" });
      continue;
    }
    linksToWire.push({
      args: {
        deviceA: lnk.aDevice,
        portA: lnk.aPort,
        deviceB: lnk.bDevice,
        portB: lnk.bPort,
        cable: lnk.cable,
      },
      tag,
      key,
    });
    existingLinks.add(key);
  }

  if (linksToWire.length > 0) {
    const reply = await bridge.sendAndWait(
      createLinksBatchJs(linksToWire.map(l => l.args)),
      { timeoutMs: Math.max(20_000, linksToWire.length * 3_000) },
    );
    if (reply === null) throw new Error(`batch createLink timed out (${linksToWire.length} link(s))`);
    let outcomes: Array<{ index: number; ok: boolean; error?: string }>;
    try {
      outcomes = JSON.parse(reply);
    } catch {
      throw new Error(`Unexpected batch createLink reply: ${reply.slice(0, 120)}`);
    }
    for (let i = 0; i < linksToWire.length; i++) {
      const entry = linksToWire[i]!;
      const res = outcomes[i];
      if (!res || !res.ok) {
        throw new Error(`createLink for ${entry.tag} failed: ${res?.error ?? "unknown error"}`);
      }
      // Keep registry coherent — PT 9 Link API is opaque
      // and captureSnapshot depends on the registry to know link pairs.
      linkRegistry.register(entry.args.deviceA, entry.args.portA, entry.args.deviceB, entry.args.portB);
      placedLinks.push(entry.tag);
    }
  }

  await waitForBlueprintLinks(bridge, blueprint.links);

  const addressing = await applyAddressing(bridge, blueprint);

  let routing: CookReport["routing"];
  switch (blueprint.routing) {
    case "ospf":
      routing = { kind: "ospf", report: await applyOspf(bridge, blueprint.addressing.ospfPid ?? 1) };
      break;
    case "eigrp":
      routing = { kind: "eigrp", report: await applyEigrp(bridge, blueprint.addressing.eigrpAsn ?? 1) };
      break;
    case "rip":
      routing = { kind: "rip", report: await applyRip(bridge, blueprint.addressing.ripVersion ?? 2) };
      break;
    case "static":
      routing = { kind: "static", report: await applyStaticRouting(bridge) };
      break;
    case "none":
    default:
      routing = { kind: "none" };
  }

  let switching: SwitchingReport | undefined;
  if (blueprint.switching && hasAnyIntent(blueprint.switching)) {
    switching = await applySwitching(bridge, blueprint.switching);
  }

  let services: ServicesReport | undefined;
  if (blueprint.services && hasAnyServiceIntent(blueprint.services)) {
    services = await applyServices(bridge, blueprint.services);
  }

  let wireless: WirelessReport | undefined;
  if (blueprint.wireless && hasAnyWirelessIntent(blueprint.wireless)) {
    wireless = await applyWireless(bridge, blueprint.wireless);
  }

  let voip: VoipReport | undefined;
  if (blueprint.voip && hasAnyVoipIntent(blueprint.voip)) {
    voip = await applyVoip(bridge, blueprint.voip);
  }

  let bgp: BgpReport | undefined;
  if (blueprint.advancedRouting?.bgp && blueprint.advancedRouting.bgp.length > 0) {
    bgp = await applyBgp(bridge, blueprint.advancedRouting.bgp);
  }

  let hsrp: HsrpReport | undefined;
  if (blueprint.advancedRouting?.hsrp && blueprint.advancedRouting.hsrp.length > 0) {
    hsrp = await applyHsrp(bridge, blueprint.advancedRouting.hsrp);
  }

  let ipv6: Ipv6Report | undefined;
  if (blueprint.ipv6 && hasAnyIpv6Intent(blueprint.ipv6)) {
    ipv6 = await applyIpv6(bridge, blueprint.ipv6);
  }

  let extraCli: ExtraCliReport[] | undefined;
  if (blueprint.extraCli && blueprint.extraCli.length > 0) {
    extraCli = [];
    for (const block of blueprint.extraCli) {
      try {
        const reply = await bridge.sendAndWait(
          bulkCliJs(
            block.device,
            wrapInConfig(block.commands),
          ),
          { timeoutMs: 60_000 },
        );
        if (reply === null) {
          extraCli.push({ device: block.device, ...(block.label ? { label: block.label } : {}), ok: false, error: "timed out" });
        } else if (reply.startsWith("ERR:") || reply.startsWith("ERROR:")) {
          extraCli.push({ device: block.device, ...(block.label ? { label: block.label } : {}), ok: false, error: reply });
        } else {
          extraCli.push({ device: block.device, ...(block.label ? { label: block.label } : {}), ok: true });
        }
      } catch (err) {
        extraCli.push({ device: block.device, ...(block.label ? { label: block.label } : {}), ok: false, error: (err as Error).message });
      }
    }
  }

  await persistAllConfigs(bridge, blueprint);

  return {
    blueprint: blueprint.name,
    placedDevices,
    skippedDevices,
    placedLinks,
    skippedLinks,
    addressing,
    routing,
    ...(switching ? { switching } : {}),
    ...(services ? { services } : {}),
    ...(wireless ? { wireless } : {}),
    ...(voip ? { voip } : {}),
    ...(bgp ? { bgp } : {}),
    ...(hsrp ? { hsrp } : {}),
    ...(ipv6 ? { ipv6 } : {}),
    ...(extraCli ? { extraCli } : {}),
  };
}

/**
 * After all phases (addressing, routing, switching, services, extraCli),
 * persist `running-config` → `startup-config` on each router/switch in the
 * blueprint. Essential: PT can reset the model (e.g. when installing a NIM
 * with `setPower(false)`, or across sessions even when the `.pkt` is saved),
 * and rebooting only reloads startup. Without this step, interfaces, OSPF,
 * NAT, ACLs, etc. are lost, reproducing the issues documented in
 * AGENTS.md / MCP_PACKET_TRACER.md.
 *
 * Switching already performs granular `write memory` per switch in `apply.ts`;
 * here we complete the rest (mainly routers) and give a second defensive
 * pass to switches.
 */
async function persistAllConfigs(bridge: Bridge, blueprint: Blueprint): Promise<void> {
  const targets: string[] = [];
  for (const dev of blueprint.devices) {
    const resolved = resolveModel(dev.model);
    if (!resolved) continue;
    if (resolved.category !== "router" && resolved.category !== "switch") continue;
    targets.push(dev.name);
  }
  if (targets.length === 0) return;

  const reply = await bridge.sendAndWait(saveRunningConfigsBatchJs(targets), {
    timeoutMs: Math.max(20_000, targets.length * 5_000),
  });
  if (reply === null) {
    throw new Error(`batch write memory timed out (${targets.length} device(s))`);
  }
  let outcomes: Array<{ device: string; ok: boolean; error?: string }>;
  try {
    outcomes = JSON.parse(reply);
  } catch {
    throw new Error(`Unexpected batch write memory reply: ${reply.slice(0, 120)}`);
  }
  for (const item of outcomes) {
    if (!item.ok && !(item.error && item.error.includes("not_found"))) {
      throw new Error(`failed to persist startup-config on ${item.device}: ${item.error ?? "unknown error"}`);
    }
  }
}

function hasAnyIntent(s: NonNullable<Blueprint["switching"]>): boolean {
  return (
    (s.vlans?.length ?? 0) > 0 ||
    (s.trunks?.length ?? 0) > 0 ||
    (s.portSecurity?.length ?? 0) > 0 ||
    (s.etherChannels?.length ?? 0) > 0
  );
}

function hasAnyServiceIntent(s: ServicesIntent): boolean {
  return (
    (s.acls?.length ?? 0) > 0 ||
    (s.nat?.length ?? 0) > 0 ||
    (s.dhcpPools?.length ?? 0) > 0 ||
    (s.dhcpRelays?.length ?? 0) > 0 ||
    (s.ntp?.length ?? 0) > 0 ||
    (s.syslog?.length ?? 0) > 0
  );
}

function hasAnyWirelessIntent(w: WirelessIntent): boolean {
  return (w.aps?.length ?? 0) > 0 || (w.clients?.length ?? 0) > 0;
}

function hasAnyVoipIntent(v: VoipIntent): boolean {
  return (
    (v.cme?.length ?? 0) > 0 ||
    (v.ephoneDns?.length ?? 0) > 0 ||
    (v.ephones?.length ?? 0) > 0 ||
    (v.voiceVlans?.length ?? 0) > 0
  );
}

function hasAnyIpv6Intent(v: Ipv6Intent): boolean {
  return (
    (v.interfaces?.length ?? 0) > 0 ||
    (v.ospf?.length ?? 0) > 0 ||
    (v.staticRoutes?.length ?? 0) > 0 ||
    (v.endpoints?.length ?? 0) > 0
  );
}

async function waitForBlueprintLinks(
  bridge: Bridge,
  links: readonly Blueprint["links"][number][],
  timeoutMs = 30_000,
): Promise<void> {
  if (links.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  let pending: string[] = [];
  const specs = links.map(lnk => ({
    deviceA: lnk.aDevice,
    portA: lnk.aPort,
    deviceB: lnk.bDevice,
    portB: lnk.bPort,
    tag: `${lnk.aDevice}/${lnk.aPort} <-> ${lnk.bDevice}/${lnk.bPort}`,
  }));

  while (Date.now() < deadline) {
    pending = [];
    const reply = await bridge.sendAndWait(
      linksUpStatusBatchJs(specs),
      { timeoutMs: 10_000 },
    );
    if (reply === null) {
      pending.push("batch link status timed out");
    } else {
      let statuses: string[] = [];
      try {
        statuses = JSON.parse(reply) as string[];
      } catch {
        statuses = [];
      }
      for (let i = 0; i < specs.length; i++) {
        const st = statuses[i];
        const tag = specs[i]!.tag;
        if (!st || st.startsWith("ERR")) {
          pending.push(`${tag} (status=${st ?? "missing"})`);
          continue;
        }
        if (!isLinkPresent(st)) {
          pending.push(`${tag} (${st})`);
        }
      }
    }
    if (pending.length === 0) return;
    await sleep(250);
  }

  throw new Error(`links not present after ${timeoutMs}ms:\n  - ${pending.join("\n  - ")}`);
}

function isLinkPresent(status: string): boolean {
  // Format: "a:link=1|port=...|proto=...;b:...". Cook only needs
  // wiring to be registered at both ends; real up/up
  // arrives after the `no shutdown` emitted by addressing.
  const sides = status.split(";");
  if (sides.length !== 2) return false;
  for (const side of sides) {
    const m = /link=(\d+)/.exec(side);
    if (!m || m[1] !== "1") return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function summarizeCook(r: CookReport): string {
  const lines: string[] = [];
  lines.push(`Cooked blueprint '${r.blueprint}'.`);
  lines.push(`  devices placed:  ${r.placedDevices.length}`);
  lines.push(`  devices skipped: ${r.skippedDevices.length}`);
  lines.push(`  links wired:     ${r.placedLinks.length}`);
  lines.push(`  links skipped:   ${r.skippedLinks.length}`);
  lines.push(`  routing:         ${r.routing.kind}`);
  if (r.skippedDevices.length > 0) {
    lines.push("", "Skipped devices:");
    for (const s of r.skippedDevices) lines.push(`  - ${s.name}: ${s.reason}`);
  }
  if (r.skippedLinks.length > 0) {
    lines.push("", "Skipped links:");
    for (const s of r.skippedLinks) lines.push(`  - ${s.link}: ${s.reason}`);
  }
  lines.push("", "Addressing actions: " + r.addressing.actions.length.toString());
  if (r.routing.kind === "static") {
    lines.push(`Static routes installed: ${r.routing.report.actions.length}`);
  } else if (r.routing.kind === "ospf") {
    lines.push(`OSPF announcements: ${r.routing.report.networks.size} router(s) under PID ${r.routing.report.pid}`);
  } else if (r.routing.kind === "eigrp") {
    lines.push(`EIGRP announcements: ${r.routing.report.networks.size} router(s) under ASN ${r.routing.report.asn}`);
  } else if (r.routing.kind === "rip") {
    lines.push(`RIP v${r.routing.report.version} announcements: ${r.routing.report.networks.size} router(s)`);
  }
  if (r.switching) {
    lines.push(`Switching actions: ${r.switching.actions.length}`);
  }
  if (r.services) {
    lines.push(`Service actions: ${r.services.actions.length}`);
  }
  if (r.wireless) {
    lines.push(`Wireless actions: ${r.wireless.actions.length}`);
  }
  if (r.voip) {
    lines.push(`VoIP actions: ${r.voip.actions.length}`);
  }
  if (r.bgp) {
    lines.push(`BGP processes: ${r.bgp.devices.size} router(s)`);
  }
  if (r.hsrp) {
    lines.push(`HSRP groups: ${[...r.hsrp.devices.values()].reduce((n, l) => n + l.length, 0)} interface(s) on ${r.hsrp.devices.size} router(s)`);
  }
  if (r.ipv6) {
    lines.push(`IPv6 actions: ${r.ipv6.actions.length}`);
  }
  if (r.extraCli && r.extraCli.length > 0) {
    const fails = r.extraCli.filter(e => !e.ok).length;
    lines.push(`Extra CLI blocks: ${r.extraCli.length} (${fails} failed)`);
    for (const e of r.extraCli.filter(e => !e.ok)) {
      lines.push(`  - ${e.device}${e.label ? ` (${e.label})` : ""}: ${e.error ?? "unknown error"}`);
    }
  }
  return lines.join("\n");
}
