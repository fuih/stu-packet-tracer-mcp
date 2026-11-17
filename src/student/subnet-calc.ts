import {
  intToIp,
  ipToInt,
  parseCidr,
  prefixToMask,
  prefixToWildcard,
} from "../canvas/subnetting.js";
import { ptError } from "../util/errors.js";
import { maskToPrefix } from "./addressing.js";

export interface SubnetDetails {
  readonly cidr: string;
  readonly network: string;
  readonly broadcast: string;
  readonly mask: string;
  readonly wildcard: string;
  readonly prefix: number;
  readonly totalAddresses: number;
  readonly usableHosts: number;
  readonly firstHost: string;
  readonly lastHost: string;
  readonly addressClass: string;
  readonly isPrivate: boolean;
}

export interface VlsmRequirement {
  readonly name: string;
  readonly hosts: number;
}

export interface VlsmAllocation extends SubnetDetails {
  readonly name: string;
  readonly requestedHosts: number;
  readonly wastedHosts: number;
}

export interface VlsmPlan {
  readonly parentCidr: string;
  readonly allocations: readonly VlsmAllocation[];
  readonly totalAllocatedAddresses: number;
  readonly remainingAddresses: number;
  readonly markdown: string;
}

function classifyIpv4(ipInt: number): { addressClass: string; isPrivate: boolean } {
  const first = (ipInt >>> 24) & 0xff;
  const second = (ipInt >>> 16) & 0xff;
  const addressClass =
    first < 128 ? "A" :
    first < 192 ? "B" :
    first < 224 ? "C" :
    first < 240 ? "D (Multicast)" : "E (Experimental)";

  const isPrivate =
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);

  return { addressClass, isPrivate };
}

export function calculateSubnet(input: string, mask?: string): SubnetDetails {
  let cidr = input.trim();
  if (!cidr.includes("/")) {
    if (!mask) {
      throw ptError(
        "INVALID_SUBNET",
        `Expected CIDR notation like "192.168.1.0/24" or an IP with a subnet mask.`,
      );
    }
    const prefix = maskToPrefix(mask.trim());
    if (prefix === null) {
      throw ptError("INVALID_MASK", `Invalid subnet mask "${mask}".`);
    }
    cidr = `${cidr}/${prefix}`;
  }

  let parsed: { network: string; prefix: number };
  try {
    parsed = parseCidr(cidr);
  } catch (e) {
    throw ptError("INVALID_SUBNET", (e as Error).message);
  }

  const netInt = ipToInt(parsed.network);
  const totalAddresses = Math.pow(2, 32 - parsed.prefix);
  const broadcastInt = (netInt + totalAddresses - 1) >>> 0;

  let usableHosts: number;
  let firstHost: string;
  let lastHost: string;

  if (parsed.prefix === 32) {
    usableHosts = 1;
    firstHost = parsed.network;
    lastHost = parsed.network;
  } else if (parsed.prefix === 31) {
    // RFC 3021 point-to-point
    usableHosts = 2;
    firstHost = parsed.network;
    lastHost = intToIp(broadcastInt);
  } else {
    usableHosts = Math.max(0, totalAddresses - 2);
    firstHost = intToIp((netInt + 1) >>> 0);
    lastHost = intToIp((broadcastInt - 1) >>> 0);
  }

  const { addressClass, isPrivate } = classifyIpv4(netInt);

  return {
    cidr: `${parsed.network}/${parsed.prefix}`,
    network: parsed.network,
    broadcast: intToIp(broadcastInt),
    mask: prefixToMask(parsed.prefix),
    wildcard: prefixToWildcard(parsed.prefix),
    prefix: parsed.prefix,
    totalAddresses,
    usableHosts,
    firstHost,
    lastHost,
    addressClass,
    isPrivate,
  };
}

export function formatSubnetMarkdown(d: SubnetDetails): string {
  return [
    `## Subnet Details: \`${d.cidr}\``,
    "",
    "| Property | Value |",
    "| --- | --- |",
    `| Network Address | \`${d.network}\` |`,
    `| Subnet Mask | \`${d.mask}\` (\`/${d.prefix}\`) |`,
    `| Wildcard Mask (OSPF/ACL) | \`${d.wildcard}\` |`,
    `| First Usable Host | \`${d.firstHost}\` |`,
    `| Last Usable Host | \`${d.lastHost}\` |`,
    `| Broadcast Address | \`${d.broadcast}\` |`,
    `| Usable Hosts | ${d.usableHosts} (${d.totalAddresses} total addresses) |`,
    `| Class / Scope | Class ${d.addressClass} (${d.isPrivate ? "Private RFC 1918" : "Public / Special"}) |`,
  ].join("\n");
}

function prefixForHosts(hosts: number): number {
  if (hosts < 1) throw ptError("INVALID_HOSTS", "Host requirement must be >= 1.");
  // Need hosts + 2 addresses (network + broadcast)
  const needed = hosts + 2;
  const hostBits = Math.ceil(Math.log2(needed));
  const prefix = 32 - Math.max(2, hostBits);
  if (prefix < 0) throw ptError("INVALID_HOSTS", `Host requirement ${hosts} exceeds IPv4 space.`);
  return prefix;
}

/**
 * Allocate Variable Length Subnet Mask (VLSM) subnets from a parent CIDR block.
 * Sorts requirements largest-first to eliminate fragmentation.
 */
export function calculateVlsm(
  parentCidr: string,
  requirements: readonly VlsmRequirement[],
): VlsmPlan {
  const parent = calculateSubnet(parentCidr);
  const parentStart = ipToInt(parent.network);
  const parentEnd = parentStart + parent.totalAddresses;

  const sorted = [...requirements].sort((a, b) => b.hosts - a.hosts);
  const allocations: VlsmAllocation[] = [];
  let cursor = parentStart;

  for (const req of sorted) {
    const prefix = prefixForHosts(req.hosts);
    const blockSize = Math.pow(2, 32 - prefix);

    // Align cursor to blockSize boundary
    const rem = cursor % blockSize;
    if (rem !== 0) {
      cursor += blockSize - rem;
    }

    if (cursor + blockSize > parentEnd) {
      throw ptError(
        "VLSM_OVERFLOW",
        `Parent block ${parent.cidr} cannot fit "${req.name}" (${req.hosts} hosts -> /${prefix}).`,
        "Use a larger parent network (smaller prefix) or reduce host counts.",
      );
    }

    const details = calculateSubnet(`${intToIp(cursor >>> 0)}/${prefix}`);
    allocations.push({
      ...details,
      name: req.name,
      requestedHosts: req.hosts,
      wastedHosts: details.usableHosts - req.hosts,
    });
    cursor += blockSize;
  }

  const totalAllocatedAddresses = allocations.reduce((sum, a) => sum + a.totalAddresses, 0);
  const remainingAddresses = parent.totalAddresses - totalAllocatedAddresses;

  const lines = [
    `## VLSM Allocation Plan for \`${parent.cidr}\``,
    "",
    "| Subnet Name | Needed | Allocated | Network / CIDR | Mask | Usable Range | Broadcast | Wildcard |",
    "| --- | ---: | ---: | --- | --- | --- | --- | --- |",
  ];
  for (const a of allocations) {
    lines.push(
      `| ${a.name} | ${a.requestedHosts} | ${a.usableHosts} | \`${a.cidr}\` | \`${a.mask}\` | \`${a.firstHost}\` – \`${a.lastHost}\` | \`${a.broadcast}\` | \`${a.wildcard}\` |`,
    );
  }
  lines.push("", `Remaining unallocated addresses: **${remainingAddresses}** of ${parent.totalAddresses}.`);

  return {
    parentCidr: parent.cidr,
    allocations,
    totalAllocatedAddresses,
    remainingAddresses,
    markdown: lines.join("\n"),
  };
}
