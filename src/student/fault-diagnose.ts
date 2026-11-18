import type { Bridge } from "../bridge/http-bridge.js";
import { captureSnapshot } from "../canvas/snapshot.js";
import { intToIp, ipToInt, parseCidr } from "../canvas/subnetting.js";
import type { CanvasSnapshot, DeviceObservation, PortObservation } from "../canvas/types.js";
import { runCli } from "../cli/engine.js";
import { bulkCliJs, setDevicePowerJs, setEndpointStaticIpJs } from "../ipc/generator.js";
import { runShowRunning } from "../sim/runner.js";
import { collectAddressingTable, maskToPrefix, type AddressingRow } from "./addressing.js";
import { isTeachModeEnabled } from "./teach.js";

export type DiagnoseMode = "hints" | "commands" | "autofix";
export type FaultCategory = "layer1" | "addressing" | "gateway" | "routing" | "vlan" | "dhcp";
export type FaultSeverity = "error" | "warning";

export interface LabFaultFix {
  readonly kind: "ios_cli" | "pc_ip" | "power_on";
  readonly device: string;
  readonly commands?: readonly string[];
  readonly pcConfig?: {
    readonly port: string;
    readonly ip: string;
    readonly mask: string;
    readonly gateway?: string;
  };
}

export type LabFaultCode =
  | "DEVICE_POWERED_OFF"
  | "ROUTER_INTERFACE_ADMIN_DOWN"
  | "ROUTER_UPLINK_UNADDRESSED"
  | "DUPLICATE_IP"
  | "WAN_PEER_SUBNET_MISMATCH"
  | "PC_UNADDRESSED"
  | "PC_CLASSFUL_MASK_TRAP"
  | "PC_MASK_MISMATCH_WITH_GATEWAY"
  | "PC_MISSING_GATEWAY"
  | "PC_WRONG_GATEWAY_SUBNET"
  | "PC_GATEWAY_IP_MISMATCH"
  | "STATIC_ROUTE_SELF_NEXT_HOP"
  | "ONE_WAY_ROUTING";

export interface LabFault {
  readonly id: string;
  readonly code: LabFaultCode;
  readonly category: FaultCategory;
  readonly severity: FaultSeverity;
  readonly devices: readonly string[];
  readonly symptom: string;
  readonly rootCause: string;
  readonly hint: string;
  readonly fixDescription: string;
  readonly fix?: LabFaultFix;
}

export interface DiagnoseInputState {
  readonly snapshot: CanvasSnapshot;
  readonly addressingRows: readonly AddressingRow[];
  readonly routerIntBrief?: Readonly<Record<string, string>>;
  readonly routerRunningConfig?: Readonly<Record<string, string>>;
  readonly routerRoutes?: Readonly<Record<string, string>>;
}

export interface ParsedRouteEntry {
  readonly code: string;
  readonly network: string;
  readonly prefix: number;
  readonly nextHop?: string;
  readonly exitInterface?: string;
}

const ROUTER_CATEGORIES = new Set(["router", "multilayerswitch"]);
const SWITCH_CATEGORIES = new Set(["switch", "hub", "bridge", "accesspoint"]);
const ENDPOINT_CATEGORIES = new Set(["pc", "server", "laptop"]);

export function isRouterDevice(dev: DeviceObservation): boolean {
  const cat = dev.category ?? "";
  return dev.className === "Router" || ROUTER_CATEGORIES.has(cat);
}

export function isL2TransitDevice(dev: DeviceObservation): boolean {
  const cat = dev.category ?? "";
  return (
    dev.className === "Switch" ||
    dev.className === "Hub" ||
    dev.className === "Bridge" ||
    SWITCH_CATEGORIES.has(cat)
  );
}

export function isEndpointDevice(dev: DeviceObservation): boolean {
  const cat = dev.category ?? "";
  const cls = dev.className.toLowerCase();
  return cls === "pc" || cls === "server" || cls === "laptop" || ENDPOINT_CATEGORIES.has(cat);
}

export function isIpInSubnet(ip: string, network: string, prefix: number): boolean {
  try {
    if (prefix === 0) return true;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return ((ipToInt(ip) & mask) >>> 0) === (ipToInt(network) >>> 0);
  } catch {
    return false;
  }
}

export function isValidIpv4(ip: string): boolean {
  try {
    ipToInt(ip);
    return ip !== "0.0.0.0" && ip !== "255.255.255.255";
  } catch {
    return false;
  }
}

function classfulPrefixOf(ip: string): number {
  const firstOctet = ipToInt(ip) >>> 24;
  if (firstOctet >= 1 && firstOctet <= 126) return 8;
  if (firstOctet >= 128 && firstOctet <= 191) return 16;
  return 24;
}

/**
 * Gather all IP-bearing interfaces of a router (physical ports from snapshot plus
 * virtual subinterfaces like `GigabitEthernet0/0.10` from `addressingRows`).
 */
export function getRouterPortInventory(
  router: DeviceObservation,
  addressingRows: readonly AddressingRow[] = [],
): PortObservation[] {
  const seen = new Set(router.ports.map(p => p.name.toLowerCase()));
  const merged: PortObservation[] = [...router.ports];

  for (const row of addressingRows) {
    if (row.device !== router.name) continue;
    if (seen.has(row.interface.toLowerCase())) continue;
    seen.add(row.interface.toLowerCase());
    merged.push({
      name: row.interface,
      ip: row.ip,
      mask: row.mask,
      linked: router.ports.some(p =>
        row.interface.toLowerCase().startsWith(`${p.name.toLowerCase()}.`) && p.linked
      ),
    });
  }
  return merged;
}

/**
 * Find the gateway router interface(s) reachable across L2 switches/hubs from a starting device.
 * Also includes virtual Router-on-a-Stick subinterfaces attached to a reachable physical parent port.
 */
export function findReachableRouterInterfaces(
  snapshot: CanvasSnapshot,
  startDeviceName: string,
  addressingRows: readonly AddressingRow[] = [],
): Array<{ readonly router: DeviceObservation; readonly port: PortObservation }> {
  const byName = new Map(snapshot.devices.map(d => [d.name, d]));
  const adj = new Map<string, Array<{ neighbor: string; neighborPort: string }>>();

  for (const link of snapshot.links) {
    const listA = adj.get(link.aDevice) ?? [];
    listA.push({ neighbor: link.bDevice, neighborPort: link.bPort });
    adj.set(link.aDevice, listA);

    const listB = adj.get(link.bDevice) ?? [];
    listB.push({ neighbor: link.aDevice, neighborPort: link.aPort });
    adj.set(link.bDevice, listB);
  }

  const visited = new Set<string>([startDeviceName]);
  const queue: string[] = [startDeviceName];
  const results: Array<{ router: DeviceObservation; port: PortObservation }> = [];
  const seenKey = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adj.get(current) ?? [];
    for (const edge of neighbors) {
      const target = byName.get(edge.neighbor);
      if (!target) continue;

      if (isRouterDevice(target)) {
        const allPorts = getRouterPortInventory(target, addressingRows);
        const parentLower = edge.neighborPort.toLowerCase();
        for (const p of allPorts) {
          const pLower = p.name.toLowerCase();
          if (pLower !== parentLower && !pLower.startsWith(`${parentLower}.`)) continue;
          const key = `${target.name}:${p.name}`;
          if (!seenKey.has(key)) {
            seenKey.add(key);
            results.push({ router: target, port: p });
          }
        }
        continue;
      }

      if (isL2TransitDevice(target) && !visited.has(target.name)) {
        visited.add(target.name);
        queue.push(target.name);
      }
    }
  }

  return results;
}

/**
 * Parse Cisco IOS `show ip route` output into structured route entries (handling
 * classful parent lines such as `10.0.0.0/24 is subnetted`).
 */
export function parseShowIpRouteEntries(output: string): ParsedRouteEntry[] {
  if (!output) return [];
  const entries: ParsedRouteEntry[] = [];
  let parentPrefix: number | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Parent summary line, e.g. "10.0.0.0/24 is subnetted, 1 subnets"
    const subMatch = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\s+is\s+(?:variably\s+)?subnetted/i.exec(trimmed);
    if (subMatch) {
      parentPrefix = trimmed.toLowerCase().includes("variably") ? null : Number(subMatch[2]);
      continue;
    }

    // Route entry, e.g.:
    // C    10.0.0.0 is directly connected, FastEthernet0/0
    // S*   0.0.0.0/0 [1/0] via 50.0.0.2
    // O    192.168.1.0/24 [110/2] via 10.0.0.6, 00:00:57, GigabitEthernet0/1
    const routeMatch =
      /^([CSLRODB]\*?(?:\s+(?:IA|E1|E2|N1|N2|EX))?)\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?\s+(.*)$/.exec(trimmed);
    if (!routeMatch) continue;

    const code = routeMatch[1]!.trim();
    const network = routeMatch[2]!;
    let prefix = routeMatch[3] !== undefined ? Number(routeMatch[3]) : parentPrefix;
    const rest = routeMatch[4]!;

    if (prefix === null || prefix === undefined) {
      prefix = network === "0.0.0.0" ? 0 : classfulPrefixOf(network);
    }

    const viaMatch = /\bvia\s+(\d{1,3}(?:\.\d{1,3}){3})(?:,\s*[^,]+,\s*(\S+))?/i.exec(rest);
    const directMatch = /is directly connected,\s*(\S+)/i.exec(rest);

    entries.push({
      code,
      network,
      prefix,
      nextHop: viaMatch?.[1],
      exitInterface: directMatch?.[1] ?? viaMatch?.[2],
    });
  }

  return entries;
}

/**
 * Parse static `ip route <net> <mask> <nextHop>` lines from a router's running-config.
 */
export function parseStaticRoutesFromConfig(config: string): Array<{
  readonly network: string;
  readonly mask: string;
  readonly nextHop: string;
  readonly rawLine: string;
}> {
  const out: Array<{ network: string; mask: string; nextHop: string; rawLine: string }> = [];
  if (!config) return out;
  for (const line of config.split(/\r?\n/)) {
    const m = /^\s*ip\s+route\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/i.exec(line);
    if (m) {
      out.push({
        network: m[1]!,
        mask: m[2]!,
        nextHop: m[3]!,
        rawLine: line.trim(),
      });
    }
  }
  return out;
}

/**
 * Parse shutdown interface names from a router's `show ip interface brief` output.
 */
export function parseAdminDownInterfaces(intBrief: string): string[] {
  const down: string[] = [];
  if (!intBrief) return down;
  for (const line of intBrief.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/administratively\s+down/i.test(trimmed)) {
      const name = trimmed.split(/\s+/)[0];
      if (name) down.push(name);
    }
  }
  return down;
}

/**
 * Parse interfaces that contain `shutdown` inside their running-config block.
 */
function parseShutdownFromRunningConfig(config: string): Set<string> {
  const result = new Set<string>();
  if (!config) return result;
  let currentIface = "";
  for (const line of config.split(/\r?\n/)) {
    const ifaceMatch = /^\s*interface\s+(\S+)/i.exec(line);
    if (ifaceMatch) {
      currentIface = ifaceMatch[1]!;
      continue;
    }
    if (/^\s*!\s*$/.test(line)) {
      currentIface = "";
      continue;
    }
    if (currentIface && /^\s*shutdown\s*$/i.test(line)) {
      result.add(currentIface);
    }
  }
  return result;
}

function gatewayDisplayUnset(gw: string): boolean {
  const norm = gw.trim().toLowerCase();
  return !norm || norm === "not configured" || norm === "n/a" || norm === "0.0.0.0";
}

function doesRouteTableCover(entries: readonly ParsedRouteEntry[], targetNet: string, targetPrefix: number): boolean {
  for (const entry of entries) {
    if (entry.network === "0.0.0.0" && entry.prefix === 0) return true;
    if (entry.prefix <= targetPrefix && isIpInSubnet(targetNet, entry.network, entry.prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Deterministic, offline-testable lab fault detector analyzing topology, L2 links,
 * end-host addressing/masks/gateways, router interface state, static routes, and return paths.
 */
export function analyzeLabFaults(state: DiagnoseInputState): LabFault[] {
  const faults: LabFault[] = [];
  const { snapshot, addressingRows } = state;
  const rowsByDev = new Map<string, AddressingRow[]>();

  for (const row of addressingRows) {
    const list = rowsByDev.get(row.device) ?? [];
    list.push(row);
    rowsByDev.set(row.device, list);
  }

  let nextId = 1;
  const pushFault = (f: Omit<LabFault, "id">) => {
    faults.push({ id: `F${nextId++}`, ...f });
  };

  // 1) Powered-off devices with wired links
  for (const dev of snapshot.devices) {
    if (dev.powered) continue;
    const wiredCount = dev.ports.filter(p => p.linked).length;
    if (wiredCount === 0) continue;
    pushFault({
      code: "DEVICE_POWERED_OFF",
      category: "layer1",
      severity: "error",
      devices: [dev.name],
      symptom: `${dev.name} has ${wiredCount} active link(s) with zero traffic flow because power is off.`,
      rootCause: `${dev.name} is powered off in Packet Tracer.`,
      hint: `Click ${dev.name} -> Physical tab and flip the power switch on.`,
      fixDescription: `Power on ${dev.name}.`,
      fix: { kind: "power_on", device: dev.name },
    });
  }

  // 2) Duplicate IPs across all interfaces
  const claimsByIp = new Map<string, Array<{ device: string; iface: string }>>();
  for (const row of addressingRows) {
    if (!isValidIpv4(row.ip)) continue;
    const list = claimsByIp.get(row.ip) ?? [];
    list.push({ device: row.device, iface: row.interface });
    claimsByIp.set(row.ip, list);
  }
  for (const [ip, claims] of claimsByIp) {
    if (claims.length < 2) continue;
    const where = claims.map(c => `${c.device}/${c.iface}`).join(", ");
    pushFault({
      code: "DUPLICATE_IP",
      category: "addressing",
      severity: "error",
      devices: [...new Set(claims.map(c => c.device))],
      symptom: `IP conflict detected for ${ip} across multiple ports (${where}).`,
      rootCause: `Two or more interfaces share the identical IPv4 address ${ip}.`,
      hint: `Compare IPs on ${where} and re-address the duplicate interface so every host has a unique IP.`,
      fixDescription: `Assign a unique unused IP in the subnet to one of: ${where}.`,
    });
  }

  // 3) Router interfaces administratively down (via show ip int brief or running-config)
  for (const dev of snapshot.devices) {
    if (!isRouterDevice(dev)) continue;
    const brief = state.routerIntBrief?.[dev.name] ?? "";
    const runCfg = state.routerRunningConfig?.[dev.name] ?? "";
    const adminDownNames = new Set<string>(parseAdminDownInterfaces(brief));
    for (const iface of parseShutdownFromRunningConfig(runCfg)) {
      adminDownNames.add(iface);
    }

    for (const ifaceName of adminDownNames) {
      const portObj = dev.ports.find(
        p => p.name.toLowerCase() === ifaceName.toLowerCase() || ifaceName.toLowerCase().startsWith(p.name.toLowerCase()),
      );
      // Only flag interfaces that are either wired or carrying an IP address
      const isWiredOrAddressed = portObj ? portObj.linked || isValidIpv4(portObj.ip) : true;
      if (!isWiredOrAddressed) continue;
      if (portObj && !portObj.linked && !isValidIpv4(portObj.ip)) continue;

      pushFault({
        code: "ROUTER_INTERFACE_ADMIN_DOWN",
        category: "layer1",
        severity: "error",
        devices: [dev.name],
        symptom: `${dev.name} interface ${ifaceName} shows "administratively down / down" and passes no traffic.`,
        rootCause: `Interface ${ifaceName} on ${dev.name} is shut down (missing \`no shutdown\`).`,
        hint: `Run \`show ip interface brief\` on ${dev.name} and check Status/Protocol on ${ifaceName}.`,
        fixDescription: `Enter interface ${ifaceName} on ${dev.name} and run \`no shutdown\`.`,
        fix: {
          kind: "ios_cli",
          device: dev.name,
          commands: ["configure terminal", `interface ${ifaceName}`, "no shutdown", "end"],
        },
      });
    }
  }

  // 4) Router-to-router WAN peer subnet mismatch
  const devByName = new Map(snapshot.devices.map(d => [d.name, d]));
  const checkedWanPairs = new Set<string>();
  for (const link of snapshot.links) {
    const devA = devByName.get(link.aDevice);
    const devB = devByName.get(link.bDevice);
    if (!devA || !devB || !isRouterDevice(devA) || !isRouterDevice(devB)) continue;
    const portA = devA.ports.find(p => p.name === link.aPort);
    const portB = devB.ports.find(p => p.name === link.bPort);
    if (!portA || !portB || !isValidIpv4(portA.ip) || !isValidIpv4(portB.ip)) continue;
    const prefA = maskToPrefix(portA.mask);
    const prefB = maskToPrefix(portB.mask);
    if (prefA === null || prefB === null) continue;

    const netA = parseCidr(`${portA.ip}/${prefA}`);
    const netB = parseCidr(`${portB.ip}/${prefB}`);
    if (netA.network === netB.network && prefA === prefB) continue;

    const key = [`${devA.name}:${portA.name}`, `${devB.name}:${portB.name}`].sort().join("|");
    if (checkedWanPairs.has(key)) continue;
    checkedWanPairs.add(key);

    const peerIpInt = ((ipToInt(netA.network) + (ipToInt(portA.ip) === ipToInt(netA.network) + 1 ? 2 : 1)) >>> 0);
    const suggestedIp = intToIp(peerIpInt);

    pushFault({
      code: "WAN_PEER_SUBNET_MISMATCH",
      category: "addressing",
      severity: "error",
      devices: [devA.name, devB.name],
      symptom: `Link ${devA.name}/${portA.name} <-> ${devB.name}/${portB.name} drops packets between peers.`,
      rootCause:
        `${devA.name}/${portA.name} (${portA.ip}/${prefA}) and ${devB.name}/${portB.name} (${portB.ip}/${prefB}) belong to different subnets or use mismatched masks.`,
      hint: `Compare IP addresses and subnet masks on both ends of the link between ${devA.name} and ${devB.name}.`,
      fixDescription: `Align ${devB.name}/${portB.name} to match ${devA.name}/${portA.name}'s subnet (${suggestedIp} ${portA.mask}).`,
      fix: {
        kind: "ios_cli",
        device: devB.name,
        commands: [
          "configure terminal",
          `interface ${portB.name}`,
          `ip address ${suggestedIp} ${portA.mask}`,
          "no shutdown",
          "end",
        ],
      },
    });
  }

  // 5) End-device addressing, classful mask trap, and default gateway checks
  for (const dev of snapshot.devices) {
    if (!isEndpointDevice(dev)) continue;
    const wiredPorts = dev.ports.filter(p => p.linked);
    if (wiredPorts.length === 0) continue;

    const pcRows = (rowsByDev.get(dev.name) ?? []).filter(r => isValidIpv4(r.ip));
    const reachableRouters = findReachableRouterInterfaces(snapshot, dev.name, addressingRows);
    const validGateways = reachableRouters.filter(r => isValidIpv4(r.port.ip) && maskToPrefix(r.port.mask) !== null);
    const primaryRow = pcRows[0];
    // For Router-on-a-Stick / multi-VLAN trunks, prefer the reachable subinterface matching the host IP or gateway subnet.
    const lanGateway =
      (primaryRow
        ? validGateways.find(r => {
            const pPref = maskToPrefix(r.port.mask);
            if (pPref === null) return false;
            const pNet = parseCidr(`${r.port.ip}/${pPref}`);
            return isIpInSubnet(primaryRow.ip, pNet.network, pPref);
          }) ??
          validGateways.find(r => r.port.ip === primaryRow.gateway)
        : undefined) ??
      validGateways[0];

    if (pcRows.length === 0) {
      const firstPort = wiredPorts[0]!;
      pushFault({
        code: "PC_UNADDRESSED",
        category: "addressing",
        severity: "warning",
        devices: [dev.name],
        symptom: `${dev.name} is wired (${firstPort.name}) yet has no IPv4 address.`,
        rootCause: `Neither a static IP nor a successful DHCP lease is configured on ${dev.name}/${firstPort.name}.`,
        hint: `Check Desktop -> IP Configuration on ${dev.name} (verify static settings or DHCP reachability).`,
        fixDescription: lanGateway
          ? `Configure an unused IP on ${dev.name} inside ${lanGateway.port.ip}'s subnet with gateway ${lanGateway.port.ip}.`
          : `Assign an IPv4 address, subnet mask, and default gateway to ${dev.name}.`,
      });
      continue;
    }

    for (const row of pcRows) {
      const pcPrefix = maskToPrefix(row.mask);
      if (pcPrefix === null) continue;

      if (lanGateway) {
        const gwIp = lanGateway.port.ip;
        const gwMask = lanGateway.port.mask;
        const gwPrefix = maskToPrefix(gwMask)!;
        const gwNet = parseCidr(`${gwIp}/${gwPrefix}`);

        // Check mask mismatch / classful mask trap
        if (pcPrefix !== gwPrefix && isIpInSubnet(row.ip, gwNet.network, gwPrefix)) {
          const classDefault = classfulPrefixOf(row.ip);
          const isClassfulTrap = pcPrefix === classDefault && gwPrefix > classDefault;
          const fixedGw = !gatewayDisplayUnset(row.gateway) && isIpInSubnet(row.gateway, gwNet.network, gwPrefix)
            ? row.gateway
            : gwIp;

          pushFault({
            code: isClassfulTrap ? "PC_CLASSFUL_MASK_TRAP" : "PC_MASK_MISMATCH_WITH_GATEWAY",
            category: "addressing",
            severity: "error",
            devices: [dev.name, lanGateway.router.name],
            symptom: `${dev.name} (${row.ip}/${pcPrefix}) fails to communicate properly across subnets.`,
            rootCause: isClassfulTrap
              ? `Packet Tracer auto-filled the classful mask ${row.mask} (/${pcPrefix}) on ${dev.name}, while router ${lanGateway.router.name}/${lanGateway.port.name} uses ${gwMask} (/${gwPrefix}).`
              : `${dev.name} uses mask ${row.mask} (/${pcPrefix}), whereas router ${lanGateway.router.name}/${lanGateway.port.name} uses ${gwMask} (/${gwPrefix}).`,
            hint: `Compare the Subnet Mask on ${dev.name} against the mask configured on ${lanGateway.router.name}/${lanGateway.port.name}.`,
            fixDescription: `Update ${dev.name}/${row.interface} subnet mask from ${row.mask} to ${gwMask}.`,
            fix: {
              kind: "pc_ip",
              device: dev.name,
              pcConfig: { port: row.interface, ip: row.ip, mask: gwMask, gateway: fixedGw },
            },
          });
        } else if (!isIpInSubnet(row.ip, gwNet.network, gwPrefix)) {
          // PC IP itself is in a wrong subnet relative to its LAN router
          const hostOffset = (ipToInt(gwIp) & 0xff) === 1 ? 10 : 2;
          const suggestedIp = intToIp((ipToInt(gwNet.network) + hostOffset) >>> 0);
          pushFault({
            code: "PC_WRONG_GATEWAY_SUBNET",
            category: "addressing",
            severity: "error",
            devices: [dev.name, lanGateway.router.name],
            symptom: `${dev.name} (${row.ip}/${pcPrefix}) cannot reach its local gateway ${lanGateway.router.name} (${gwIp}/${gwPrefix}).`,
            rootCause: `${dev.name}'s IP address ${row.ip} does not belong to LAN subnet ${gwNet.network}/${gwPrefix}.`,
            hint: `Verify ${dev.name}'s IP address matches the ${gwNet.network}/${gwPrefix} LAN on ${lanGateway.router.name}/${lanGateway.port.name}.`,
            fixDescription: `Re-address ${dev.name}/${row.interface} into ${gwNet.network}/${gwPrefix} (e.g., ${suggestedIp} ${gwMask}, gateway ${gwIp}).`,
            fix: {
              kind: "pc_ip",
              device: dev.name,
              pcConfig: { port: row.interface, ip: suggestedIp, mask: gwMask, gateway: gwIp },
            },
          });
          continue;
        }
      }

      // Gateway checks
      if (gatewayDisplayUnset(row.gateway)) {
        pushFault({
          code: "PC_MISSING_GATEWAY",
          category: "gateway",
          severity: "error",
          devices: lanGateway ? [dev.name, lanGateway.router.name] : [dev.name],
          symptom: `${dev.name} can ping local LAN hosts, yet remote subnets time out completely.`,
          rootCause: `${dev.name}/${row.interface} has no Default Gateway configured.`,
          hint: `Run \`ipconfig\` on ${dev.name} and inspect the Default Gateway field.`,
          fixDescription: lanGateway
            ? `Set ${dev.name}'s Default Gateway to ${lanGateway.port.ip} (${lanGateway.router.name}/${lanGateway.port.name}).`
            : `Set ${dev.name}'s Default Gateway to its local router LAN IP.`,
          fix: lanGateway
            ? {
                kind: "pc_ip",
                device: dev.name,
                pcConfig: { port: row.interface, ip: row.ip, mask: row.mask, gateway: lanGateway.port.ip },
              }
            : undefined,
        });
      } else if (isValidIpv4(row.gateway)) {
        const pcNet = parseCidr(`${row.ip}/${pcPrefix}`);
        if (!isIpInSubnet(row.gateway, pcNet.network, pcPrefix)) {
          const targetGw = lanGateway ? lanGateway.port.ip : undefined;
          pushFault({
            code: "PC_WRONG_GATEWAY_SUBNET",
            category: "gateway",
            severity: "error",
            devices: lanGateway ? [dev.name, lanGateway.router.name] : [dev.name],
            symptom: `${dev.name} cannot route traffic off its local LAN.`,
            rootCause: `${dev.name}'s gateway ${row.gateway} is outside its local subnet ${pcNet.network}/${pcPrefix}.`,
            hint: `Check whether ${dev.name}'s Default Gateway shares the same network prefix as ${row.ip}/${pcPrefix}.`,
            fixDescription: targetGw
              ? `Change ${dev.name}'s Default Gateway from ${row.gateway} to ${targetGw}.`
              : `Change ${dev.name}'s Default Gateway to an IP inside ${pcNet.network}/${pcPrefix}.`,
            fix: targetGw
              ? {
                  kind: "pc_ip",
                  device: dev.name,
                  pcConfig: { port: row.interface, ip: row.ip, mask: row.mask, gateway: targetGw },
                }
              : undefined,
          });
        } else if (
          lanGateway &&
          row.gateway !== lanGateway.port.ip &&
          !reachableRouters.some(r => r.port.ip === row.gateway)
        ) {
          pushFault({
            code: "PC_GATEWAY_IP_MISMATCH",
            category: "gateway",
            severity: "error",
            devices: [dev.name, lanGateway.router.name],
            symptom: `${dev.name} sends off-subnet traffic to ${row.gateway}, which no connected router owns.`,
            rootCause:
              `${dev.name} points its Default Gateway at ${row.gateway}, whereas ${lanGateway.router.name}/${lanGateway.port.name} uses ${lanGateway.port.ip}.`,
            hint: `Run \`ipconfig\` on ${dev.name} and compare Default Gateway against ${lanGateway.router.name}/${lanGateway.port.name}.`,
            fixDescription: `Update ${dev.name}'s Default Gateway from ${row.gateway} to ${lanGateway.port.ip}.`,
            fix: {
              kind: "pc_ip",
              device: dev.name,
              pcConfig: { port: row.interface, ip: row.ip, mask: row.mask, gateway: lanGateway.port.ip },
            },
          });
        }
      }
    }
  }

  // 6) Self-pointing static route (`ip route ... <own-interface-ip>`)
  for (const dev of snapshot.devices) {
    if (!isRouterDevice(dev)) continue;
    const cfg = state.routerRunningConfig?.[dev.name];
    if (!cfg) continue;

    const ownIps = new Set(dev.ports.map(p => p.ip).filter(isValidIpv4));
    const staticRoutes = parseStaticRoutesFromConfig(cfg);
    for (const sr of staticRoutes) {
      if (!ownIps.has(sr.nextHop)) continue;
      // Try to identify the remote neighbor router's IP sharing a link with ownPort
      const selfPort = dev.ports.find(p => p.ip === sr.nextHop);
      let suggestedPeerIp: string | undefined;
      if (selfPort) {
        const peerLink = snapshot.links.find(
          l =>
            (l.aDevice === dev.name && l.aPort === selfPort.name) ||
            (l.bDevice === dev.name && l.bPort === selfPort.name),
        );
        if (peerLink) {
          const peerName = peerLink.aDevice === dev.name ? peerLink.bDevice : peerLink.aDevice;
          const peerPortName = peerLink.aDevice === dev.name ? peerLink.bPort : peerLink.aPort;
          const peerDev = devByName.get(peerName);
          const peerIp = peerDev?.ports.find(p => p.name === peerPortName)?.ip;
          if (peerIp && isValidIpv4(peerIp)) suggestedPeerIp = peerIp;
        }
      }

      pushFault({
        code: "STATIC_ROUTE_SELF_NEXT_HOP",
        category: "routing",
        severity: "error",
        devices: [dev.name],
        symptom: `Traffic on ${dev.name} for ${sr.network} fails even though a static route exists.`,
        rootCause:
          `Static route \`${sr.rawLine}\` uses ${dev.name}'s own IP (${sr.nextHop}) as next-hop instead of the neighbor router's IP.`,
        hint: `Inspect \`ip route\` lines in ${dev.name}'s running-config — the next-hop IP must belong to the NEXT router, not ${dev.name} itself.`,
        fixDescription: suggestedPeerIp
          ? `Replace \`${sr.rawLine}\` on ${dev.name} with next-hop ${suggestedPeerIp}.`
          : `Replace \`${sr.rawLine}\` on ${dev.name} with the neighboring router's transit IP.`,
        fix: suggestedPeerIp
          ? {
              kind: "ios_cli",
              device: dev.name,
              commands: [
                "configure terminal",
                `no ${sr.rawLine}`,
                `ip route ${sr.network} ${sr.mask} ${suggestedPeerIp}`,
                "end",
              ],
            }
          : undefined,
      });
    }
  }

  // 7) One-way routing check across router LAN subnets
  if (state.routerRoutes) {
    const routerInfos: Array<{
      router: DeviceObservation;
      entries: ParsedRouteEntry[];
      lanSubnets: Array<{ network: string; prefix: number; mask: string }>;
    }> = [];

    for (const dev of snapshot.devices) {
      if (!isRouterDevice(dev)) continue;
      const routeOut = state.routerRoutes[dev.name];
      if (!routeOut) continue;
      const entries = parseShowIpRouteEntries(routeOut);

      // Determine LAN subnets attached to switches/PCs on this router
      const lanSubnets: Array<{ network: string; prefix: number; mask: string }> = [];
      for (const link of snapshot.links) {
        let portName: string | undefined;
        let peerName: string | undefined;
        if (link.aDevice === dev.name) {
          portName = link.aPort;
          peerName = link.bDevice;
        } else if (link.bDevice === dev.name) {
          portName = link.bPort;
          peerName = link.aDevice;
        }
        if (!portName || !peerName) continue;
        const peerDev = devByName.get(peerName);
        if (!peerDev || isRouterDevice(peerDev)) continue;
        const portObj = dev.ports.find(p => p.name === portName);
        if (!portObj || !isValidIpv4(portObj.ip)) continue;
        const pref = maskToPrefix(portObj.mask);
        if (pref === null) continue;
        const parsed = parseCidr(`${portObj.ip}/${pref}`);
        lanSubnets.push({ network: parsed.network, prefix: pref, mask: portObj.mask });
      }

      routerInfos.push({ router: dev, entries, lanSubnets });
    }

    const reportedOneWay = new Set<string>();
    for (const infoA of routerInfos) {
      for (const infoB of routerInfos) {
        if (infoA.router.name === infoB.router.name) continue;
        for (const lanB of infoB.lanSubnets) {
          if (!doesRouteTableCover(infoA.entries, lanB.network, lanB.prefix)) continue;
          for (const lanA of infoA.lanSubnets) {
            if (doesRouteTableCover(infoB.entries, lanA.network, lanA.prefix)) continue;
            const key = `${infoB.router.name}->${lanA.network}/${lanA.prefix}`;
            if (reportedOneWay.has(key)) continue;
            reportedOneWay.add(key);

            // Find an exit neighbor IP on infoB facing infoA or another router if directly connected
            const directLink = snapshot.links.find(
              l =>
                (l.aDevice === infoB.router.name && l.bDevice === infoA.router.name) ||
                (l.bDevice === infoB.router.name && l.aDevice === infoA.router.name),
            );
            let nextHopIp: string | undefined;
            if (directLink) {
              const peerPortName = directLink.aDevice === infoA.router.name ? directLink.aPort : directLink.bPort;
              const pIp = infoA.router.ports.find(p => p.name === peerPortName)?.ip;
              if (pIp && isValidIpv4(pIp)) nextHopIp = pIp;
            }

            pushFault({
              code: "ONE_WAY_ROUTING",
              category: "routing",
              severity: "error",
              devices: [infoB.router.name, infoA.router.name],
              symptom: `${infoA.router.name}'s LAN (${lanA.network}/${lanA.prefix}) can reach ${infoB.router.name}'s LAN (${lanB.network}/${lanB.prefix}), yet pings fail because replies cannot return.`,
              rootCause: `${infoB.router.name} has no route back to ${lanA.network}/${lanA.prefix} (and no default route).`,
              hint: `Run \`show ip route\` on ${infoB.router.name} and check if network ${lanA.network}/${lanA.prefix} appears.`,
              fixDescription: nextHopIp
                ? `Add return route on ${infoB.router.name}: \`ip route ${lanA.network} ${lanA.mask} ${nextHopIp}\`.`
                : `Add a return route (or dynamic routing announcement) for ${lanA.network}/${lanA.prefix} on ${infoB.router.name}.`,
              fix: nextHopIp
                ? {
                    kind: "ios_cli",
                    device: infoB.router.name,
                    commands: [
                      "configure terminal",
                      `ip route ${lanA.network} ${lanA.mask} ${nextHopIp}`,
                      "end",
                    ],
                  }
                : undefined,
            });
          }
        }
      }
    }
  }

  return faults;
}

export function formatDiagnosisMarkdown(
  faults: readonly LabFault[],
  mode: DiagnoseMode,
  appliedFixes: readonly string[] = [],
): string {
  if (faults.length === 0) {
    return [
      "## Lab Fault Diagnosis: Clean (0 faults found)",
      "",
      "No L1, addressing, gateway, or routing faults were detected across the checked devices.",
    ].join("\n");
  }

  const header =
    mode === "hints"
      ? `## Lab Fault Diagnosis — Study Hints (${faults.length} issue(s) found)`
      : mode === "autofix"
        ? `## Lab Fault Diagnosis & Auto-Fix (${faults.length} issue(s) found, ${appliedFixes.length} fixed)`
        : `## Lab Fault Diagnosis (${faults.length} issue(s) found)`;

  const lines: string[] = [header, ""];

  if (mode === "autofix" && appliedFixes.length > 0) {
    lines.push("### Applied Fixes", "");
    for (const item of appliedFixes) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  for (const fault of faults) {
    const badge = fault.severity === "error" ? "❌" : "⚠️";
    lines.push(`### ${badge} ${fault.id}: ${fault.code} (${fault.devices.join(", ")})`);
    lines.push(`- **Symptom:** ${fault.symptom}`);
    if (mode === "hints") {
      lines.push(`- **Hint:** ${fault.hint}`);
    } else {
      lines.push(`- **Root Cause:** ${fault.rootCause}`);
      lines.push(`- **Suggested Fix:** ${fault.fixDescription}`);
      if (fault.fix?.kind === "ios_cli" && fault.fix.commands) {
        lines.push("```ios");
        for (const cmd of fault.fix.commands) {
          lines.push(cmd);
        }
        lines.push("```");
      } else if (fault.fix?.kind === "pc_ip" && fault.fix.pcConfig) {
        const c = fault.fix.pcConfig;
        lines.push(
          `  - Set \`${fault.fix.device}\` (${c.port}): IP \`${c.ip}\`, Mask \`${c.mask}\`${c.gateway ? `, Gateway \`${c.gateway}\`` : ""}.`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export interface DiagnoseRunResult {
  readonly mode: DiagnoseMode;
  readonly faults: readonly LabFault[];
  readonly appliedFixes: readonly string[];
  readonly markdown: string;
}

/**
 * Capture live topology + router CLI state from Packet Tracer, diagnose lab faults,
 * and optionally apply safe fixes (`mode === "autofix"`).
 */
export async function diagnoseAndFixLab(
  bridge: Bridge,
  opts: {
    readonly mode?: DiagnoseMode;
    readonly devices?: readonly string[];
    readonly deepCliCheck?: boolean;
  } = {},
): Promise<DiagnoseRunResult> {
  const mode: DiagnoseMode = opts.mode ?? "commands";
  const snapshot = await captureSnapshot(bridge);
  const tbl = await collectAddressingTable(bridge, { includeUnassigned: false });

  const filterSet = opts.devices && opts.devices.length > 0
    ? new Set(opts.devices.map(n => n.toLowerCase()))
    : null;

  const routerIntBrief: Record<string, string> = {};
  const routerRunningConfig: Record<string, string> = {};
  const routerRoutes: Record<string, string> = {};

  if (opts.deepCliCheck !== false) {
    for (const dev of snapshot.devices) {
      if (!isRouterDevice(dev) || !dev.powered) continue;
      if (filterSet && !filterSet.has(dev.name.toLowerCase())) continue;

      const briefRes = await runCli(bridge, dev.name, "show ip interface brief").catch(() => null);
      if (briefRes?.output) routerIntBrief[dev.name] = briefRes.output;

      const routeRes = await runCli(bridge, dev.name, "show ip route").catch(() => null);
      if (routeRes?.output) routerRoutes[dev.name] = routeRes.output;

      const runRes = await runShowRunning(bridge, dev.name).catch(() => null);
      if (runRes) routerRunningConfig[dev.name] = runRes;
    }
  }

  const allFaults = analyzeLabFaults({
    snapshot,
    addressingRows: tbl.rows,
    routerIntBrief,
    routerRunningConfig,
    routerRoutes,
  });

  const faults = filterSet
    ? allFaults.filter(f => f.devices.some(d => filterSet.has(d.toLowerCase())))
    : allFaults;

  const appliedFixes: string[] = [];
  if (mode === "autofix" && !isTeachModeEnabled()) {
    for (const fault of faults) {
      if (!fault.fix) continue;
      const fix = fault.fix;
      if (fix.kind === "power_on") {
        const res = await bridge.sendAndWait(setDevicePowerJs(fix.device, true), { timeoutMs: 25_000 });
        if (res && !res.startsWith("ERR:")) {
          appliedFixes.push(`${fault.id}: Powered on ${fix.device}`);
        }
      } else if (fix.kind === "pc_ip" && fix.pcConfig) {
        const c = fix.pcConfig;
        const res = await bridge.sendAndWait(
          setEndpointStaticIpJs({
            device: fix.device,
            port: c.port,
            ip: c.ip,
            mask: c.mask,
            gateway: c.gateway,
          }),
          { timeoutMs: 12_000 },
        );
        if (res && !res.startsWith("ERR:")) {
          appliedFixes.push(`${fault.id}: Updated ${fix.device} (${c.ip}/${c.mask}, gw ${c.gateway ?? "none"})`);
        }
      } else if (fix.kind === "ios_cli" && fix.commands && fix.commands.length > 0) {
        const res = await bridge.sendAndWait(bulkCliJs(fix.device, fix.commands.join("\n")), { timeoutMs: 20_000 });
        if (res && !res.startsWith("ERR:")) {
          appliedFixes.push(`${fault.id}: Applied IOS CLI fix on ${fix.device}`);
        }
      }
    }
  }

  const effectiveMode: DiagnoseMode = mode === "autofix" && isTeachModeEnabled() ? "commands" : mode;

  return {
    mode: effectiveMode,
    faults,
    appliedFixes,
    markdown: formatDiagnosisMarkdown(faults, effectiveMode, appliedFixes),
  };
}
