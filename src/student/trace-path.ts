import type { Bridge } from "../bridge/http-bridge.js";
import { captureSnapshot } from "../canvas/snapshot.js";
import { parseCidr } from "../canvas/subnetting.js";
import type { CanvasSnapshot, DeviceObservation, PortObservation } from "../canvas/types.js";
import { runCli } from "../cli/engine.js";
import { resolveCanvasDevice } from "../util/devices.js";
import { collectAddressingTable, maskToPrefix, type AddressingRow } from "./addressing.js";
import {
  findReachableRouterInterfaces,
  getRouterPortInventory,
  isEndpointDevice,
  isIpInSubnet,
  isRouterDevice,
  isValidIpv4,
  parseAdminDownInterfaces,
  parseShowIpRouteEntries,
  type DiagnoseInputState,
  type ParsedRouteEntry,
} from "./fault-diagnose.js";

export interface TraceHop {
  readonly step: number;
  readonly device: string;
  readonly action: string;
  readonly detail: string;
  readonly status: "ok" | "drop";
}

export interface OneWayTraceResult {
  readonly delivered: boolean;
  readonly hops: readonly TraceHop[];
  readonly dropDevice?: string;
  readonly dropReason?: string;
  readonly fixHint?: string;
}

export interface PacketPathAnalysis {
  readonly fromDevice: string;
  readonly fromIp?: string;
  readonly toDevice: string;
  readonly toIp?: string;
  readonly bidirectionalOk: boolean;
  readonly forward: OneWayTraceResult;
  readonly reverse: OneWayTraceResult;
  readonly verdict: string;
  readonly fixSuggestion?: string;
  readonly markdown: string;
}

interface HostAddressInfo {
  readonly device: DeviceObservation;
  readonly ip: string;
  readonly mask: string;
  readonly prefix: number;
  readonly gateway: string;
}

function resolveHostAddress(
  dev: DeviceObservation,
  rowsByDev: ReadonlyMap<string, readonly AddressingRow[]>,
): HostAddressInfo | null {
  const rows = rowsByDev.get(dev.name) ?? [];
  for (const r of rows) {
    if (!isValidIpv4(r.ip)) continue;
    const prefix = maskToPrefix(r.mask);
    if (prefix === null) continue;
    return {
      device: dev,
      ip: r.ip,
      mask: r.mask,
      prefix,
      gateway: r.gateway,
    };
  }
  for (const p of dev.ports) {
    if (!isValidIpv4(p.ip)) continue;
    const prefix = maskToPrefix(p.mask);
    if (prefix === null) continue;
    return {
      device: dev,
      ip: p.ip,
      mask: p.mask,
      prefix,
      gateway: "Not configured",
    };
  }
  return null;
}

function longestPrefixRouteMatch(
  entries: readonly ParsedRouteEntry[],
  destIp: string,
): ParsedRouteEntry | undefined {
  let best: ParsedRouteEntry | undefined;
  for (const entry of entries) {
    if (!isIpInSubnet(destIp, entry.network, entry.prefix)) continue;
    if (!best || entry.prefix > best.prefix) {
      best = entry;
    }
  }
  return best;
}

function findDirectNeighborByIp(
  snapshot: CanvasSnapshot,
  fromRouterName: string,
  targetIp: string,
  addressingRows: readonly AddressingRow[],
  fallbackExitInterface?: string,
): { readonly router: DeviceObservation; readonly ingressPort: PortObservation; readonly egressPort: string } | null {
  const byName = new Map(snapshot.devices.map(d => [d.name, d]));
  for (const link of snapshot.links) {
    let localPort: string | undefined;
    let peerName: string | undefined;
    let peerPortName: string | undefined;
    if (link.aDevice === fromRouterName) {
      localPort = link.aPort;
      peerName = link.bDevice;
      peerPortName = link.bPort;
    } else if (link.bDevice === fromRouterName) {
      localPort = link.bPort;
      peerName = link.aDevice;
      peerPortName = link.aPort;
    }
    if (!localPort || !peerName || !peerPortName) continue;
    const peerDev = byName.get(peerName);
    if (!peerDev || !isRouterDevice(peerDev)) continue;
    const peerPorts = getRouterPortInventory(peerDev, addressingRows);
    const parentLower = peerPortName.toLowerCase();
    const peerPort = peerPorts.find(p =>
      p.ip === targetIp && (p.name.toLowerCase() === parentLower || p.name.toLowerCase().startsWith(`${parentLower}.`)),
    );
    if (peerPort) {
      return { router: peerDev, ingressPort: peerPort, egressPort: localPort };
    }
  }

  // Fallback when in-memory linkRegistry is empty (loaded .pkt or restarted server)
  if (snapshot.links.length === 0) {
    for (const dev of snapshot.devices) {
      if (!isRouterDevice(dev) || dev.name === fromRouterName) continue;
      const peerPort = getRouterPortInventory(dev, addressingRows).find(p => p.ip === targetIp);
      if (peerPort) {
        return {
          router: dev,
          ingressPort: peerPort,
          egressPort: fallbackExitInterface ?? peerPort.name,
        };
      }
    }
  }
  return null;
}

function isPortAdminDown(
  routerName: string,
  portName: string,
  state: DiagnoseInputState,
): boolean {
  const brief = state.routerIntBrief?.[routerName];
  if (!brief) return false;
  const downList = parseAdminDownInterfaces(brief);
  return downList.some(n => n.toLowerCase() === portName.toLowerCase());
}

function traceOneWay(
  state: DiagnoseInputState,
  srcDev: DeviceObservation,
  srcInfo: HostAddressInfo,
  dstDev: DeviceObservation,
  dstInfo: HostAddressInfo,
  rowsByDev: ReadonlyMap<string, readonly AddressingRow[]>,
): OneWayTraceResult {
  const hops: TraceHop[] = [];
  const { snapshot } = state;

  if (!srcDev.powered) {
    hops.push({
      step: 1,
      device: srcDev.name,
      action: "Dropped at source",
      detail: `${srcDev.name} is powered off.`,
      status: "drop",
    });
    return {
      delivered: false,
      hops,
      dropDevice: srcDev.name,
      dropReason: "SOURCE_POWERED_OFF",
      fixHint: `Power on ${srcDev.name} in the Physical tab.`,
    };
  }

  // Check if source considers destination local according to source mask
  const srcNet = parseCidr(`${srcInfo.ip}/${srcInfo.prefix}`);
  const srcThinksLocal = isIpInSubnet(dstInfo.ip, srcNet.network, srcInfo.prefix);

  if (srcThinksLocal) {
    // Verify destination also agrees it is in the same subnet (catch asymmetric /8 classful mask traps)
    const dstNet = parseCidr(`${dstInfo.ip}/${dstInfo.prefix}`);
    const dstAgrees = isIpInSubnet(srcInfo.ip, dstNet.network, dstInfo.prefix);
    if (!dstAgrees) {
      hops.push({
        step: 1,
        device: srcDev.name,
        action: "Send via L2 ARP",
        detail: `${srcDev.name} (${srcInfo.ip}/${srcInfo.prefix}) considers ${dstInfo.ip} local and sends ARP directly.`,
        status: "ok",
      });
      hops.push({
        step: 2,
        device: dstDev.name,
        action: "Asymmetric subnet drop",
        detail: `${dstDev.name} uses ${dstInfo.mask} (/${dstInfo.prefix}) and thinks ${srcInfo.ip} is remote.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: dstDev.name,
        dropReason: "SUBNET_MASK_MISMATCH",
        fixHint: `Align subnet masks on ${srcDev.name} (/${srcInfo.prefix}) and ${dstDev.name} (/${dstInfo.prefix}) — check for a classful /8 mask trap.`,
      };
    }

    if (!dstDev.powered) {
      hops.push({
        step: 1,
        device: dstDev.name,
        action: "Dropped at destination",
        detail: `${dstDev.name} is powered off.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: dstDev.name,
        dropReason: "DESTINATION_POWERED_OFF",
        fixHint: `Power on ${dstDev.name}.`,
      };
    }

    hops.push({
      step: 1,
      device: srcDev.name,
      action: "Direct L2 delivery",
      detail: `${srcDev.name} (${srcInfo.ip}/${srcInfo.prefix}) -> ${dstDev.name} (${dstInfo.ip}/${dstInfo.prefix}) on local LAN.`,
      status: "ok",
    });
    return { delivered: true, hops };
  }

  // Destination is remote: end-device must forward to Default Gateway, OR router routes directly
  let currentRouter: DeviceObservation | undefined;
  let stepNum = 1;

  if (isEndpointDevice(srcDev)) {
    const gwIp = srcInfo.gateway;
    if (!gwIp || gwIp === "Not configured" || gwIp === "0.0.0.0" || gwIp === "N/A") {
      hops.push({
        step: stepNum,
        device: srcDev.name,
        action: "Dropped at source",
        detail: `${dstInfo.ip} is outside ${srcNet.network}/${srcInfo.prefix}, but ${srcDev.name} has no Default Gateway configured.`,
        status: "drop",
      });
      const candidateGw = findReachableRouterInterfaces(snapshot, srcDev.name).find(r => isValidIpv4(r.port.ip));
      return {
        delivered: false,
        hops,
        dropDevice: srcDev.name,
        dropReason: "MISSING_DEFAULT_GATEWAY",
        fixHint: candidateGw
          ? `Configure Default Gateway ${candidateGw.port.ip} on ${srcDev.name}.`
          : `Configure the local router LAN IP as Default Gateway on ${srcDev.name}.`,
      };
    }

    if (!isIpInSubnet(gwIp, srcNet.network, srcInfo.prefix)) {
      hops.push({
        step: stepNum,
        device: srcDev.name,
        action: "Dropped at source",
        detail: `${srcDev.name} Default Gateway ${gwIp} is outside ${srcNet.network}/${srcInfo.prefix}.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: srcDev.name,
        dropReason: "GATEWAY_UNREACHABLE_SUBNET",
        fixHint: `Set ${srcDev.name}'s Default Gateway to a valid IP inside ${srcNet.network}/${srcInfo.prefix}.`,
      };
    }

    let candidates = findReachableRouterInterfaces(snapshot, srcDev.name, state.addressingRows);
    if (candidates.length === 0 && snapshot.links.length === 0) {
      // Fallback when linkRegistry is empty (loaded .pkt or restarted server): inspect all router IPs
      candidates = snapshot.devices
        .filter(isRouterDevice)
        .flatMap(router => getRouterPortInventory(router, state.addressingRows).map(port => ({ router, port })));
    }
    const matchingGw = candidates.find(c => c.port.ip === gwIp);
    if (!matchingGw) {
      const expectedGw = candidates.find(c => isValidIpv4(c.port.ip));
      hops.push({
        step: stepNum,
        device: srcDev.name,
        action: "ARP failed for gateway",
        detail: `${srcDev.name} ARP'd for gateway ${gwIp}, but no connected router owns ${gwIp}.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: srcDev.name,
        dropReason: "WRONG_DEFAULT_GATEWAY",
        fixHint: expectedGw
          ? `Change ${srcDev.name}'s Default Gateway from ${gwIp} to ${expectedGw.port.ip} (${expectedGw.router.name}/${expectedGw.port.name}).`
          : `Verify ${srcDev.name}'s Default Gateway IP matches the router LAN port.`,
      };
    }

    if (!matchingGw.router.powered || isPortAdminDown(matchingGw.router.name, matchingGw.port.name, state)) {
      hops.push({
        step: stepNum,
        device: matchingGw.router.name,
        action: "Dropped at gateway interface",
        detail: `${matchingGw.router.name}/${matchingGw.port.name} (${gwIp}) is powered off or administratively down.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: matchingGw.router.name,
        dropReason: "GATEWAY_INTERFACE_DOWN",
        fixHint: `Run \`no shutdown\` on ${matchingGw.router.name} interface ${matchingGw.port.name}.`,
      };
    }

    hops.push({
      step: stepNum++,
      device: srcDev.name,
      action: "Forward to gateway",
      detail: `${srcDev.name} (${srcInfo.ip}/${srcInfo.prefix}) -> ${matchingGw.router.name}/${matchingGw.port.name} (${gwIp})`,
      status: "ok",
    });
    currentRouter = matchingGw.router;
  } else if (isRouterDevice(srcDev)) {
    currentRouter = srcDev;
  }

  // Router-by-router L3 forwarding loop
  const visitedRouters = new Set<string>();
  const maxHops = 15;

  for (let i = 0; i < maxHops && currentRouter; i++) {
    if (visitedRouters.has(currentRouter.name)) {
      hops.push({
        step: stepNum,
        device: currentRouter.name,
        action: "Routing loop detected",
        detail: `Packet returned to ${currentRouter.name} — forwarding loop detected.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: currentRouter.name,
        dropReason: "ROUTING_LOOP",
        fixHint: `Inspect \`show ip route\` across routers for conflicting static or default routes.`,
      };
    }
    visitedRouters.add(currentRouter.name);

    // Check if dstDev is directly reachable on any active port or subinterface of currentRouter
    const directPort = getRouterPortInventory(currentRouter, state.addressingRows).find(p => {
      if (!isValidIpv4(p.ip)) return false;
      const pref = maskToPrefix(p.mask);
      if (pref === null) return false;
      const net = parseCidr(`${p.ip}/${pref}`);
      return isIpInSubnet(dstInfo.ip, net.network, pref);
    });

    if (directPort) {
      if (isPortAdminDown(currentRouter.name, directPort.name, state)) {
        hops.push({
          step: stepNum,
          device: currentRouter.name,
          action: "Egress interface down",
          detail: `${currentRouter.name}/${directPort.name} (LAN for ${dstInfo.ip}) is administratively down.`,
          status: "drop",
        });
        return {
          delivered: false,
          hops,
          dropDevice: currentRouter.name,
          dropReason: "EGRESS_INTERFACE_DOWN",
          fixHint: `Run \`no shutdown\` on ${currentRouter.name} interface ${directPort.name}.`,
        };
      }
      if (!dstDev.powered) {
        hops.push({
          step: stepNum,
          device: dstDev.name,
          action: "Destination powered off",
          detail: `${currentRouter.name}/${directPort.name} connected LAN host ${dstDev.name} (${dstInfo.ip}) is powered off.`,
          status: "drop",
        });
        return {
          delivered: false,
          hops,
          dropDevice: dstDev.name,
          dropReason: "DESTINATION_POWERED_OFF",
          fixHint: `Power on ${dstDev.name}.`,
        };
      }

      // Check destination mask matches router LAN mask
      const directPref = maskToPrefix(directPort.mask)!;
      if (isEndpointDevice(dstDev) && dstInfo.prefix !== directPref) {
        hops.push({
          step: stepNum,
          device: dstDev.name,
          action: "Mask mismatch at destination",
          detail: `${currentRouter.name}/${directPort.name} uses /${directPref}, while ${dstDev.name} uses /${dstInfo.prefix}.`,
          status: "drop",
        });
        return {
          delivered: false,
          hops,
          dropDevice: dstDev.name,
          dropReason: "DESTINATION_MASK_MISMATCH",
          fixHint: `Change ${dstDev.name}'s subnet mask from ${dstInfo.mask} to ${directPort.mask}.`,
        };
      }

      hops.push({
        step: stepNum++,
        device: currentRouter.name,
        action: "Deliver to destination LAN",
        detail: `${currentRouter.name} forwards out ${directPort.name} (${directPort.ip}) -> ${dstDev.name} (${dstInfo.ip}).`,
        status: "ok",
      });
      return { delivered: true, hops };
    }

    // Consult currentRouter's `show ip route` table
    const routeText = state.routerRoutes?.[currentRouter.name];
    if (!routeText) {
      hops.push({
        step: stepNum,
        device: currentRouter.name,
        action: "Routing table unavailable",
        detail: `No \`show ip route\` output captured for ${currentRouter.name}.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: currentRouter.name,
        dropReason: "MISSING_ROUTE_DATA",
      };
    }

    const entries = parseShowIpRouteEntries(routeText);
    const bestRoute = longestPrefixRouteMatch(entries, dstInfo.ip);

    if (!bestRoute) {
      const dstNet = parseCidr(`${dstInfo.ip}/${dstInfo.prefix}`);
      hops.push({
        step: stepNum,
        device: currentRouter.name,
        action: "Dropped (no route)",
        detail: `${currentRouter.name} has no routing table entry matching ${dstInfo.ip} (${dstNet.network}/${dstInfo.prefix}).`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: currentRouter.name,
        dropReason: "NO_ROUTE_TO_DESTINATION",
        fixHint: `Add a route on ${currentRouter.name} for \`${dstNet.network} ${dstInfo.mask}\` (via the next-hop router or dynamic routing announcement).`,
      };
    }

    if (!bestRoute.nextHop) {
      hops.push({
        step: stepNum,
        device: currentRouter.name,
        action: "Route uses exit interface only",
        detail: `${currentRouter.name} matched \`${bestRoute.code} ${bestRoute.network}/${bestRoute.prefix}\` with no next-hop IP.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: currentRouter.name,
        dropReason: "UNRESOLVABLE_EXIT_ROUTE",
      };
    }

    // Check self-pointing route trap
    const ownIps = new Set(getRouterPortInventory(currentRouter, state.addressingRows).map(p => p.ip).filter(isValidIpv4));
    if (ownIps.has(bestRoute.nextHop)) {
      hops.push({
        step: stepNum,
        device: currentRouter.name,
        action: "Dropped (self next-hop)",
        detail: `${currentRouter.name} matched ${bestRoute.network}/${bestRoute.prefix} via its own IP ${bestRoute.nextHop}.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: currentRouter.name,
        dropReason: "SELF_NEXT_HOP",
        fixHint: `Update the route on ${currentRouter.name} so next-hop points to the neighbor router instead of ${bestRoute.nextHop}.`,
      };
    }

    const peer = findDirectNeighborByIp(
      snapshot,
      currentRouter.name,
      bestRoute.nextHop,
      state.addressingRows,
      bestRoute.exitInterface,
    );
    if (!peer) {
      hops.push({
        step: stepNum,
        device: currentRouter.name,
        action: "Next-hop unreachable",
        detail: `${currentRouter.name} matched ${bestRoute.network}/${bestRoute.prefix} via ${bestRoute.nextHop}, which is not owned by a directly linked neighbor.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: currentRouter.name,
        dropReason: "UNREACHABLE_NEXT_HOP",
        fixHint: `Check the WAN interface subnet/IP or fix next-hop ${bestRoute.nextHop} on ${currentRouter.name}.`,
      };
    }

    if (isPortAdminDown(currentRouter.name, peer.egressPort, state)) {
      hops.push({
        step: stepNum,
        device: currentRouter.name,
        action: "Egress WAN interface down",
        detail: `${currentRouter.name}/${peer.egressPort} toward ${peer.router.name} is administratively down.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: currentRouter.name,
        dropReason: "WAN_INTERFACE_DOWN",
        fixHint: `Run \`no shutdown\` on ${currentRouter.name} interface ${peer.egressPort}.`,
      };
    }

    if (!peer.router.powered || isPortAdminDown(peer.router.name, peer.ingressPort.name, state)) {
      hops.push({
        step: stepNum,
        device: peer.router.name,
        action: "Peer router/interface down",
        detail: `${peer.router.name}/${peer.ingressPort.name} (${bestRoute.nextHop}) is powered off or shut down.`,
        status: "drop",
      });
      return {
        delivered: false,
        hops,
        dropDevice: peer.router.name,
        dropReason: "PEER_INTERFACE_DOWN",
        fixHint: `Power on ${peer.router.name} and run \`no shutdown\` on ${peer.ingressPort.name}.`,
      };
    }

    hops.push({
      step: stepNum++,
      device: currentRouter.name,
      action: `Route (${bestRoute.code} ${bestRoute.network}/${bestRoute.prefix})`,
      detail: `${currentRouter.name}/${peer.egressPort} -> ${peer.router.name}/${peer.ingressPort.name} (${bestRoute.nextHop})`,
      status: "ok",
    });

    // Ensure rowsByDev stays referenced if needed later
    void rowsByDev;
    currentRouter = peer.router;
  }

  return {
    delivered: false,
    hops,
    dropDevice: dstDev.name,
    dropReason: "TTL_EXCEEDED",
  };
}

function formatHopsMarkdown(title: string, trace: OneWayTraceResult): string[] {
  const lines = [`### ${title} ${trace.delivered ? "✅ Delivered" : "❌ Dropped"}`, ""];
  for (const h of trace.hops) {
    const icon = h.status === "ok" ? "➡️" : "🛑";
    lines.push(`${h.step}. ${icon} **${h.device}** — *${h.action}*: ${h.detail}`);
  }
  lines.push("");
  return lines;
}

/**
 * Simulate both forward (`from -> to`) and return (`to -> from`) packet paths across
 * L2 LANs and L3 router tables, pinpointing the exact hop where connectivity fails.
 */
export function analyzePacketPath(
  state: DiagnoseInputState,
  fromDeviceName: string,
  toDeviceName: string,
): PacketPathAnalysis {
  const { snapshot, addressingRows } = state;
  const srcDev = snapshot.devices.find(d => d.name.toLowerCase() === fromDeviceName.toLowerCase());
  const dstDev = snapshot.devices.find(d => d.name.toLowerCase() === toDeviceName.toLowerCase());

  if (!srcDev || !dstDev) {
    const missing = !srcDev ? fromDeviceName : toDeviceName;
    const errTrace: OneWayTraceResult = {
      delivered: false,
      hops: [{ step: 1, device: missing, action: "Device not found", detail: `"${missing}" is missing from snapshot.`, status: "drop" }],
      dropDevice: missing,
      dropReason: "DEVICE_NOT_FOUND",
    };
    return {
      fromDevice: fromDeviceName,
      toDevice: toDeviceName,
      bidirectionalOk: false,
      forward: errTrace,
      reverse: errTrace,
      verdict: `Cannot trace path: device "${missing}" was not found.`,
      markdown: `## Path Trace Error\n\nDevice \`${missing}\` was not found in the topology.`,
    };
  }

  const rowsByDev = new Map<string, AddressingRow[]>();
  for (const r of addressingRows) {
    const list = rowsByDev.get(r.device) ?? [];
    list.push(r);
    rowsByDev.set(r.device, list);
  }

  const srcInfo = resolveHostAddress(srcDev, rowsByDev);
  const dstInfo = resolveHostAddress(dstDev, rowsByDev);

  if (!srcInfo || !dstInfo) {
    const unaddressed = !srcInfo ? srcDev.name : dstDev.name;
    const errTrace: OneWayTraceResult = {
      delivered: false,
      hops: [{
        step: 1,
        device: unaddressed,
        action: "Unaddressed host",
        detail: `${unaddressed} has no IPv4 address assigned.`,
        status: "drop",
      }],
      dropDevice: unaddressed,
      dropReason: "HOST_UNADDRESSED",
      fixHint: `Assign an IP address, subnet mask, and default gateway to ${unaddressed}.`,
    };
    const verdict = `Path blocked: ${unaddressed} has no valid IPv4 address.`;
    return {
      fromDevice: srcDev.name,
      fromIp: srcInfo?.ip,
      toDevice: dstDev.name,
      toIp: dstInfo?.ip,
      bidirectionalOk: false,
      forward: errTrace,
      reverse: errTrace,
      verdict,
      fixSuggestion: errTrace.fixHint,
      markdown: `## Packet Path Trace: ${srcDev.name} ↔ ${dstDev.name}\n\n${verdict}`,
    };
  }

  const forward = traceOneWay(state, srcDev, srcInfo, dstDev, dstInfo, rowsByDev);
  const reverse = traceOneWay(state, dstDev, dstInfo, srcDev, srcInfo, rowsByDev);
  const bidirectionalOk = forward.delivered && reverse.delivered;

  let verdict: string;
  let fixSuggestion: string | undefined;

  if (bidirectionalOk) {
    verdict = `Both forward (${srcDev.name} → ${dstDev.name}) and return (${dstDev.name} → ${srcDev.name}) paths succeed cleanly.`;
  } else if (!forward.delivered) {
    verdict = `Forward packet dropped at **${forward.dropDevice}** (\`${forward.dropReason}\`).`;
    fixSuggestion = forward.fixHint;
  } else {
    verdict = `Forward packet reached **${dstDev.name}**, **but the reply dropped on the return path at ${reverse.dropDevice}** (\`${reverse.dropReason}\`).`;
    fixSuggestion = reverse.fixHint;
  }

  const mdLines = [
    `## Packet Path Trace: ${srcDev.name} (\`${srcInfo.ip}\`) ↔ ${dstDev.name} (\`${dstInfo.ip}\`)`,
    "",
    `**Verdict:** ${verdict}`,
    ...(fixSuggestion ? [`**Recommended Fix:** ${fixSuggestion}`] : []),
    "",
    ...formatHopsMarkdown(`Forward Path (${srcDev.name} → ${dstDev.name}):`, forward),
    ...formatHopsMarkdown(`Return Path (${dstDev.name} → ${srcDev.name}):`, reverse),
  ];

  return {
    fromDevice: srcDev.name,
    fromIp: srcInfo.ip,
    toDevice: dstDev.name,
    toIp: dstInfo.ip,
    bidirectionalOk,
    forward,
    reverse,
    verdict,
    fixSuggestion,
    markdown: mdLines.join("\n").trimEnd(),
  };
}

/**
 * Live runner collecting canvas snapshot, addressing, interface status, and router
 * routing tables from Packet Tracer before computing bidirectional path analysis.
 */
export async function tracePacketPathLive(
  bridge: Bridge,
  from: string,
  to: string,
): Promise<PacketPathAnalysis> {
  const fromResolved = await resolveCanvasDevice(bridge, from);
  const toResolved = await resolveCanvasDevice(bridge, to);

  const snapshot = await captureSnapshot(bridge);
  const tbl = await collectAddressingTable(bridge, { includeUnassigned: false });

  const routerIntBrief: Record<string, string> = {};
  const routerRoutes: Record<string, string> = {};

  for (const dev of snapshot.devices) {
    if (!isRouterDevice(dev) || !dev.powered) continue;
    const brief = await runCli(bridge, dev.name, "show ip interface brief").catch(() => null);
    if (brief?.output) routerIntBrief[dev.name] = brief.output;
    const routes = await runCli(bridge, dev.name, "show ip route").catch(() => null);
    if (routes?.output) routerRoutes[dev.name] = routes.output;
  }

  return analyzePacketPath(
    {
      snapshot,
      addressingRows: tbl.rows,
      routerIntBrief,
      routerRoutes,
    },
    fromResolved,
    toResolved,
  );
}
