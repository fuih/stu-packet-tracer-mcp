import type { Bridge } from "../bridge/http-bridge.js";
import { linkRegistry } from "../canvas/link-registry.js";
import { resolveModel } from "../catalog/devices.js";
import { waitForCliReadyAll } from "../ipc/cli-wait.js";
import {
  addDevicesBatchJs,
  bulkCliJs,
  createLinksBatchJs,
  setEndpointsStaticIpBatchJs,
  type AddDeviceArgs,
} from "../ipc/generator.js";
import { prepareDevice, resetCliCache } from "../cli/engine.js";
import { invalidateDeviceCache } from "../util/devices.js";
import { ptError } from "../util/errors.js";
import type { LabObjective } from "./lab-check.js";
import { formatTeachGuide, type TeachStep } from "./teach.js";

export const LAB_TEMPLATE_IDS = [
  "static-routing",
  "default-route",
  "rip-v2",
  "ospf-single-area",
  "vlan-basic",
  "inter-vlan-roas",
  "dhcp",
  "nat-pat",
  "acl-standard",
  "acl-extended",
] as const;

export type LabTemplateId = (typeof LAB_TEMPLATE_IDS)[number];

export interface TemplateDevice {
  readonly name: string;
  readonly model: string;
  readonly ptType: string;
  readonly x: number;
  readonly y: number;
}

export interface TemplateLink {
  readonly from: string;
  readonly fromPort: string;
  readonly to: string;
  readonly toPort: string;
  readonly cable: "straight" | "cross" | "serial";
}

export interface TemplatePcConfig {
  readonly name: string;
  readonly ip: string;
  readonly mask: string;
  readonly gateway: string;
}

export interface LabTemplateSpec {
  readonly id: LabTemplateId;
  readonly title: string;
  readonly summary: string;
  readonly learningObjectives: readonly string[];
  readonly devices: readonly TemplateDevice[];
  readonly links: readonly TemplateLink[];
  readonly pcs: readonly TemplatePcConfig[];
  readonly cliSteps: readonly TeachStep[];
  readonly objectives: readonly LabObjective[];
}

export interface LabTemplateParams {
  readonly lanA?: string;
  readonly lanB?: string;
  readonly transit?: string;
  readonly routerPrefix?: string;
}

function octetBase(cidrOrBase: string | undefined, fallback: string): string {
  const raw = (cidrOrBase ?? fallback).split("/")[0] ?? fallback;
  const parts = raw.split(".");
  if (parts.length < 3) return fallback.split(".").slice(0, 3).join(".");
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

export function buildLabTemplate(
  id: LabTemplateId,
  params: LabTemplateParams = {},
): LabTemplateSpec {
  const a = octetBase(params.lanA, "192.168.1.0");
  const b = octetBase(params.lanB, "192.168.2.0");
  const t = octetBase(params.transit, "10.0.0.0");
  const r = params.routerPrefix ?? "R";
  const r1 = `${r}1`;
  const r2 = `${r}2`;

  switch (id) {
    case "static-routing":
      return {
        id,
        title: "Static Routing Between Two LANs",
        summary: `Two routers (${r1}, ${r2}) connected over a point-to-point link (${t}.0/30) routing between LAN A (${a}.0/24) and LAN B (${b}.0/24) via static routes.`,
        learningObjectives: [
          "Configure router LAN and WAN interfaces with IPv4 addresses and `no shutdown`",
          "Configure bidirectional static routes (`ip route`) between remote subnets",
          "Verify routing tables and end-to-end PC connectivity",
        ],
        devices: [
          { name: "PC-A", model: "PC-PT", ptType: "PC-PT", x: 100, y: 260 },
          { name: "SW-A", model: "2960-24TT", ptType: "2960-24TT", x: 240, y: 260 },
          { name: r1, model: "2911", ptType: "2911", x: 380, y: 180 },
          { name: r2, model: "2911", ptType: "2911", x: 600, y: 180 },
          { name: "SW-B", model: "2960-24TT", ptType: "2960-24TT", x: 740, y: 260 },
          { name: "PC-B", model: "PC-PT", ptType: "PC-PT", x: 880, y: 260 },
        ],
        links: [
          { from: "PC-A", fromPort: "FastEthernet0", to: "SW-A", toPort: "FastEthernet0/1", cable: "straight" },
          { from: "SW-A", fromPort: "GigabitEthernet0/1", to: r1, toPort: "GigabitEthernet0/0", cable: "straight" },
          { from: r1, fromPort: "GigabitEthernet0/1", to: r2, toPort: "GigabitEthernet0/1", cable: "cross" },
          { from: r2, fromPort: "GigabitEthernet0/0", to: "SW-B", toPort: "GigabitEthernet0/1", cable: "straight" },
          { from: "SW-B", fromPort: "FastEthernet0/1", to: "PC-B", toPort: "FastEthernet0", cable: "straight" },
        ],
        pcs: [
          { name: "PC-A", ip: `${a}.10`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "PC-B", ip: `${b}.10`, mask: "255.255.255.0", gateway: `${b}.1` },
        ],
        cliSteps: [
          {
            device: r1,
            summary: "Configure LAN, transit link, and static route to LAN B",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.1 255.255.255.252`,
              " no shutdown",
              "exit",
              `ip route ${b}.0 255.255.255.0 ${t}.2`,
              "end",
              "write memory",
            ],
          },
          {
            device: r2,
            summary: "Configure LAN, transit link, and static route to LAN A",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r2}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${b}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.2 255.255.255.252`,
              " no shutdown",
              "exit",
              `ip route ${a}.0 255.255.255.0 ${t}.1`,
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "route", device: r1, prefix: `${b}.0/24`, next_hop: `${t}.2` },
          { type: "route", device: r2, prefix: `${a}.0/24`, next_hop: `${t}.1` },
          { type: "ping", from: "PC-A", to: "PC-B" },
        ],
      };

    case "default-route":
      return {
        id,
        title: "Stub Router Default Route (`0.0.0.0/0`)",
        summary: `Stub branch router (${r1}) forwarding all unknown traffic via a default route to headquarters router (${r2}).`,
        learningObjectives: [
          "Configure a default static route (`ip route 0.0.0.0 0.0.0.0`) on a stub router",
          "Observe `S* 0.0.0.0/0` and Gateway of last resort in `show ip route`",
        ],
        devices: [
          { name: "PC-A", model: "PC-PT", ptType: "PC-PT", x: 100, y: 240 },
          { name: r1, model: "2911", ptType: "2911", x: 320, y: 180 },
          { name: r2, model: "2911", ptType: "2911", x: 560, y: 180 },
          { name: "Server-HQ", model: "Server-PT", ptType: "Server-PT", x: 780, y: 240 },
        ],
        links: [
          { from: "PC-A", fromPort: "FastEthernet0", to: r1, toPort: "GigabitEthernet0/0", cable: "cross" },
          { from: r1, fromPort: "GigabitEthernet0/1", to: r2, toPort: "GigabitEthernet0/1", cable: "cross" },
          { from: r2, fromPort: "GigabitEthernet0/0", to: "Server-HQ", toPort: "FastEthernet0", cable: "cross" },
        ],
        pcs: [
          { name: "PC-A", ip: `${a}.10`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "Server-HQ", ip: `${b}.100`, mask: "255.255.255.0", gateway: `${b}.1` },
        ],
        cliSteps: [
          {
            device: r1,
            summary: "Configure stub router with default route to HQ",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.1 255.255.255.252`,
              " no shutdown",
              "exit",
              `ip route 0.0.0.0 0.0.0.0 ${t}.2`,
              "end",
              "write memory",
            ],
          },
          {
            device: r2,
            summary: "Configure HQ router with return route to branch LAN",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r2}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${b}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.2 255.255.255.252`,
              " no shutdown",
              "exit",
              `ip route ${a}.0 255.255.255.0 ${t}.1`,
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "route", device: r1, prefix: "0.0.0.0/0", next_hop: `${t}.2` },
          { type: "ping", from: "PC-A", to: "Server-HQ" },
        ],
      };

    case "rip-v2":
      return {
        id,
        title: "Dynamic Routing with RIPv2",
        summary: `Two routers running RIP version 2 with \`no auto-summary\` exchanging LAN prefixes automatically.`,
        learningObjectives: [
          "Enable RIPv2 (`version 2`, `no auto-summary`) and advertise classless networks",
          "Configure `passive-interface` on LAN ports",
          "Verify `R` routes in `show ip route`",
        ],
        devices: [
          { name: "PC-A", model: "PC-PT", ptType: "PC-PT", x: 100, y: 240 },
          { name: r1, model: "2911", ptType: "2911", x: 320, y: 180 },
          { name: r2, model: "2911", ptType: "2911", x: 560, y: 180 },
          { name: "PC-B", model: "PC-PT", ptType: "PC-PT", x: 780, y: 240 },
        ],
        links: [
          { from: "PC-A", fromPort: "FastEthernet0", to: r1, toPort: "GigabitEthernet0/0", cable: "cross" },
          { from: r1, fromPort: "GigabitEthernet0/1", to: r2, toPort: "GigabitEthernet0/1", cable: "cross" },
          { from: r2, fromPort: "GigabitEthernet0/0", to: "PC-B", toPort: "FastEthernet0", cable: "cross" },
        ],
        pcs: [
          { name: "PC-A", ip: `${a}.10`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "PC-B", ip: `${b}.10`, mask: "255.255.255.0", gateway: `${b}.1` },
        ],
        cliSteps: [
          {
            device: r1,
            summary: "Configure interfaces and RIPv2",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.1 255.255.255.252`,
              " no shutdown",
              "router rip",
              " version 2",
              " no auto-summary",
              ` network ${a}.0`,
              ` network ${t}.0`,
              " passive-interface GigabitEthernet0/0",
              "end",
              "write memory",
            ],
          },
          {
            device: r2,
            summary: "Configure interfaces and RIPv2",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r2}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${b}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.2 255.255.255.252`,
              " no shutdown",
              "router rip",
              " version 2",
              " no auto-summary",
              ` network ${b}.0`,
              ` network ${t}.0`,
              " passive-interface GigabitEthernet0/0",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "config_contains", device: r1, text: "version 2" },
          { type: "route", device: r1, prefix: `${b}.0/24` },
          { type: "ping", from: "PC-A", to: "PC-B" },
        ],
      };

    case "ospf-single-area":
      return {
        id,
        title: "Single-Area OSPFv2 (Area 0)",
        summary: `Two routers forming an OSPF Area 0 neighbor adjacency using router-IDs and wildcard masks.`,
        learningObjectives: [
          "Configure `router ospf 1` with explicit `router-id` and wildcard `network` statements",
          "Suppress OSPF hellos on LAN interfaces via `passive-interface`",
          "Verify OSPF neighbor adjacency (`show ip ospf neighbor`) and `O` routes",
        ],
        devices: [
          { name: "PC-A", model: "PC-PT", ptType: "PC-PT", x: 100, y: 240 },
          { name: r1, model: "2911", ptType: "2911", x: 320, y: 180 },
          { name: r2, model: "2911", ptType: "2911", x: 560, y: 180 },
          { name: "PC-B", model: "PC-PT", ptType: "PC-PT", x: 780, y: 240 },
        ],
        links: [
          { from: "PC-A", fromPort: "FastEthernet0", to: r1, toPort: "GigabitEthernet0/0", cable: "cross" },
          { from: r1, fromPort: "GigabitEthernet0/1", to: r2, toPort: "GigabitEthernet0/1", cable: "cross" },
          { from: r2, fromPort: "GigabitEthernet0/0", to: "PC-B", toPort: "FastEthernet0", cable: "cross" },
        ],
        pcs: [
          { name: "PC-A", ip: `${a}.10`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "PC-B", ip: `${b}.10`, mask: "255.255.255.0", gateway: `${b}.1` },
        ],
        cliSteps: [
          {
            device: r1,
            summary: "Configure interfaces and OSPF Area 0",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.1 255.255.255.252`,
              " no shutdown",
              "router ospf 1",
              " router-id 1.1.1.1",
              ` network ${a}.0 0.0.0.255 area 0`,
              ` network ${t}.0 0.0.0.3 area 0`,
              " passive-interface GigabitEthernet0/0",
              "end",
              "write memory",
            ],
          },
          {
            device: r2,
            summary: "Configure interfaces and OSPF Area 0",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r2}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${b}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${t}.2 255.255.255.252`,
              " no shutdown",
              "router ospf 1",
              " router-id 2.2.2.2",
              ` network ${b}.0 0.0.0.255 area 0`,
              ` network ${t}.0 0.0.0.3 area 0`,
              " passive-interface GigabitEthernet0/0",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "config_contains", device: r1, text: "router ospf 1" },
          { type: "route", device: r1, prefix: `${b}.0/24` },
          { type: "ping", from: "PC-A", to: "PC-B" },
        ],
      };

    case "vlan-basic":
      return {
        id,
        title: "Basic VLAN Segmentation Across Two Switches",
        summary: "Create VLAN 10 (Students) and VLAN 20 (Faculty) on two Catalyst 2960 switches linked by an 802.1Q trunk.",
        learningObjectives: [
          "Create named VLANs and assign access ports",
          "Configure an 802.1Q trunk between switches",
          "Verify same-VLAN hosts communicate while different VLANs stay isolated",
        ],
        devices: [
          { name: "PC-S1", model: "PC-PT", ptType: "PC-PT", x: 100, y: 180 },
          { name: "PC-F1", model: "PC-PT", ptType: "PC-PT", x: 100, y: 320 },
          { name: "SW1", model: "2960-24TT", ptType: "2960-24TT", x: 300, y: 240 },
          { name: "SW2", model: "2960-24TT", ptType: "2960-24TT", x: 540, y: 240 },
          { name: "PC-S2", model: "PC-PT", ptType: "PC-PT", x: 740, y: 180 },
          { name: "PC-F2", model: "PC-PT", ptType: "PC-PT", x: 740, y: 320 },
        ],
        links: [
          { from: "PC-S1", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/1", cable: "straight" },
          { from: "PC-F1", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/2", cable: "straight" },
          { from: "SW1", fromPort: "GigabitEthernet0/1", to: "SW2", toPort: "GigabitEthernet0/1", cable: "cross" },
          { from: "PC-S2", fromPort: "FastEthernet0", to: "SW2", toPort: "FastEthernet0/1", cable: "straight" },
          { from: "PC-F2", fromPort: "FastEthernet0", to: "SW2", toPort: "FastEthernet0/2", cable: "straight" },
        ],
        pcs: [
          { name: "PC-S1", ip: "192.168.10.11", mask: "255.255.255.0", gateway: "192.168.10.1" },
          { name: "PC-S2", ip: "192.168.10.12", mask: "255.255.255.0", gateway: "192.168.10.1" },
          { name: "PC-F1", ip: "192.168.20.11", mask: "255.255.255.0", gateway: "192.168.20.1" },
          { name: "PC-F2", ip: "192.168.20.12", mask: "255.255.255.0", gateway: "192.168.20.1" },
        ],
        cliSteps: [
          {
            device: "SW1",
            summary: "Create VLANs 10 & 20, assign access ports, configure trunk on Gi0/1",
            commands: [
              "enable",
              "configure terminal",
              "hostname SW1",
              "vlan 10",
              " name STUDENTS",
              "vlan 20",
              " name FACULTY",
              "interface FastEthernet0/1",
              " switchport mode access",
              " switchport access vlan 10",
              "interface FastEthernet0/2",
              " switchport mode access",
              " switchport access vlan 20",
              "interface GigabitEthernet0/1",
              " switchport mode trunk",
              " switchport trunk allowed vlan 10,20",
              "end",
              "write memory",
            ],
          },
          {
            device: "SW2",
            summary: "Mirror VLANs 10 & 20, access ports, and trunk on Gi0/1",
            commands: [
              "enable",
              "configure terminal",
              "hostname SW2",
              "vlan 10",
              " name STUDENTS",
              "vlan 20",
              " name FACULTY",
              "interface FastEthernet0/1",
              " switchport mode access",
              " switchport access vlan 10",
              "interface FastEthernet0/2",
              " switchport mode access",
              " switchport access vlan 20",
              "interface GigabitEthernet0/1",
              " switchport mode trunk",
              " switchport trunk allowed vlan 10,20",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "vlan_exists", device: "SW1", vlan: 10, name: "STUDENTS" },
          { type: "vlan_exists", device: "SW2", vlan: 20, name: "FACULTY" },
          { type: "ping", from: "PC-S1", to: "PC-S2" },
          { type: "ping", from: "PC-F1", to: "PC-F2" },
        ],
      };

    case "inter-vlan-roas":
      return {
        id,
        title: "Inter-VLAN Routing (Router-on-a-Stick)",
        summary: "Route between VLAN 10 and VLAN 20 using 802.1Q subinterfaces (`Gi0/0.10`, `Gi0/0.20`) on a single router link.",
        learningObjectives: [
          "Configure switch trunk port to the router",
          "Create 802.1Q subinterfaces with matching VLAN tags on the router",
          "Verify cross-VLAN ping from VLAN 10 to VLAN 20",
        ],
        devices: [
          { name: r1, model: "2911", ptType: "2911", x: 420, y: 120 },
          { name: "SW1", model: "2960-24TT", ptType: "2960-24TT", x: 420, y: 260 },
          { name: "PC-10", model: "PC-PT", ptType: "PC-PT", x: 240, y: 380 },
          { name: "PC-20", model: "PC-PT", ptType: "PC-PT", x: 600, y: 380 },
        ],
        links: [
          { from: r1, fromPort: "GigabitEthernet0/0", to: "SW1", toPort: "GigabitEthernet0/1", cable: "straight" },
          { from: "PC-10", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/1", cable: "straight" },
          { from: "PC-20", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/2", cable: "straight" },
        ],
        pcs: [
          { name: "PC-10", ip: "192.168.10.10", mask: "255.255.255.0", gateway: "192.168.10.1" },
          { name: "PC-20", ip: "192.168.20.10", mask: "255.255.255.0", gateway: "192.168.20.1" },
        ],
        cliSteps: [
          {
            device: "SW1",
            summary: "Create VLANs 10 & 20, assign access ports, trunk uplink to router",
            commands: [
              "enable",
              "configure terminal",
              "hostname SW1",
              "vlan 10",
              " name SALES",
              "vlan 20",
              " name ENGINEERING",
              "interface FastEthernet0/1",
              " switchport mode access",
              " switchport access vlan 10",
              "interface FastEthernet0/2",
              " switchport mode access",
              " switchport access vlan 20",
              "interface GigabitEthernet0/1",
              " switchport mode trunk",
              " switchport trunk allowed vlan 10,20",
              "end",
              "write memory",
            ],
          },
          {
            device: r1,
            summary: "Bring up Gi0/0 and create dot1Q subinterfaces .10 and .20",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              " no shutdown",
              "interface GigabitEthernet0/0.10",
              " encapsulation dot1Q 10",
              " ip address 192.168.10.1 255.255.255.0",
              "interface GigabitEthernet0/0.20",
              " encapsulation dot1Q 20",
              " ip address 192.168.20.1 255.255.255.0",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "vlan_exists", device: "SW1", vlan: 10 },
          { type: "vlan_exists", device: "SW1", vlan: 20 },
          { type: "config_contains", device: r1, text: "encapsulation dot1Q 10" },
          { type: "ping", from: "PC-10", to: "PC-20" },
        ],
      };

    case "dhcp":
      return {
        id,
        title: "Cisco IOS DHCP Server Lab",
        summary: `Configure ${r1} as an IOS DHCP server with excluded static addresses, default-router, and DNS server options.`,
        learningObjectives: [
          "Reserve static addresses using `ip dhcp excluded-address`",
          "Create a DHCP pool with `network`, `default-router`, and `dns-server`",
          "Verify client leases via `show ip dhcp binding`",
        ],
        devices: [
          { name: r1, model: "2911", ptType: "2911", x: 360, y: 140 },
          { name: "SW1", model: "2960-24TT", ptType: "2960-24TT", x: 360, y: 260 },
          { name: "PC1", model: "PC-PT", ptType: "PC-PT", x: 220, y: 380 },
          { name: "PC2", model: "PC-PT", ptType: "PC-PT", x: 500, y: 380 },
        ],
        links: [
          { from: r1, fromPort: "GigabitEthernet0/0", to: "SW1", toPort: "GigabitEthernet0/1", cable: "straight" },
          { from: "PC1", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/1", cable: "straight" },
          { from: "PC2", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/2", cable: "straight" },
        ],
        pcs: [],
        cliSteps: [
          {
            device: r1,
            summary: "Configure LAN interface and IOS DHCP pool",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " no shutdown",
              "exit",
              `ip dhcp excluded-address ${a}.1 ${a}.10`,
              "ip dhcp pool LAN_POOL",
              ` network ${a}.0 255.255.255.0`,
              ` default-router ${a}.1`,
              " dns-server 8.8.8.8",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "interface_up", device: r1, interface: "GigabitEthernet0/0", expected_ip: `${a}.1` },
          { type: "config_contains", device: r1, text: "ip dhcp pool LAN_POOL" },
        ],
      };

    case "nat-pat":
      return {
        id,
        title: "NAT Overload (PAT) to ISP",
        summary: `Translate private LAN hosts (${a}.0/24) to the edge router's outside public interface using PAT (\`overload\`).`,
        learningObjectives: [
          "Mark `ip nat inside` and `ip nat outside` interfaces",
          "Match private source traffic with an ACL and bind `ip nat inside source list 1 interface Gi0/1 overload`",
          "Verify translations in `show ip nat translations`",
        ],
        devices: [
          { name: "PC-LAN", model: "PC-PT", ptType: "PC-PT", x: 100, y: 240 },
          { name: r1, model: "2911", ptType: "2911", x: 340, y: 180 },
          { name: "ISP", model: "2911", ptType: "2911", x: 580, y: 180 },
          { name: "WebServer", model: "Server-PT", ptType: "Server-PT", x: 800, y: 240 },
        ],
        links: [
          { from: "PC-LAN", fromPort: "FastEthernet0", to: r1, toPort: "GigabitEthernet0/0", cable: "cross" },
          { from: r1, fromPort: "GigabitEthernet0/1", to: "ISP", toPort: "GigabitEthernet0/1", cable: "cross" },
          { from: "ISP", fromPort: "GigabitEthernet0/0", to: "WebServer", toPort: "FastEthernet0", cable: "cross" },
        ],
        pcs: [
          { name: "PC-LAN", ip: `${a}.10`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "WebServer", ip: "203.0.113.10", mask: "255.255.255.0", gateway: "203.0.113.1" },
        ],
        cliSteps: [
          {
            device: r1,
            summary: "Configure inside/outside interfaces, default route, and PAT overload",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " ip nat inside",
              " no shutdown",
              "interface GigabitEthernet0/1",
              " ip address 198.51.100.2 255.255.255.252",
              " ip nat outside",
              " no shutdown",
              "exit",
              `access-list 1 permit ${a}.0 0.0.0.255`,
              "ip nat inside source list 1 interface GigabitEthernet0/1 overload",
              "ip route 0.0.0.0 0.0.0.0 198.51.100.1",
              "end",
              "write memory",
            ],
          },
          {
            device: "ISP",
            summary: "Configure ISP transit and public web server LAN (no private route needed!)",
            commands: [
              "enable",
              "configure terminal",
              "hostname ISP",
              "no ip domain-lookup",
              "interface GigabitEthernet0/1",
              " ip address 198.51.100.1 255.255.255.252",
              " no shutdown",
              "interface GigabitEthernet0/0",
              " ip address 203.0.113.1 255.255.255.0",
              " no shutdown",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "config_contains", device: r1, text: "ip nat inside source list 1" },
          { type: "ping", from: "PC-LAN", to: "WebServer" },
        ],
      };

    case "acl-standard":
      return {
        id,
        title: "Standard IPv4 Access Control List (ACL)",
        summary: `Block a specific host (${a}.10) from reaching the server subnet (${b}.0/24) while permitting all other LAN hosts.`,
        learningObjectives: [
          "Write a standard numbered ACL (1–99) denying one host and permitting the rest",
          "Apply standard ACLs close to the destination (`ip access-group 10 out`)",
          "Verify hit counts using `show access-lists`",
        ],
        devices: [
          { name: "PC-Denied", model: "PC-PT", ptType: "PC-PT", x: 100, y: 180 },
          { name: "PC-Allowed", model: "PC-PT", ptType: "PC-PT", x: 100, y: 320 },
          { name: "SW1", model: "2960-24TT", ptType: "2960-24TT", x: 260, y: 240 },
          { name: r1, model: "2911", ptType: "2911", x: 460, y: 240 },
          { name: "Server1", model: "Server-PT", ptType: "Server-PT", x: 680, y: 240 },
        ],
        links: [
          { from: "PC-Denied", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/1", cable: "straight" },
          { from: "PC-Allowed", fromPort: "FastEthernet0", to: "SW1", toPort: "FastEthernet0/2", cable: "straight" },
          { from: "SW1", fromPort: "GigabitEthernet0/1", to: r1, toPort: "GigabitEthernet0/0", cable: "straight" },
          { from: r1, fromPort: "GigabitEthernet0/1", to: "Server1", toPort: "FastEthernet0", cable: "cross" },
        ],
        pcs: [
          { name: "PC-Denied", ip: `${a}.10`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "PC-Allowed", ip: `${a}.11`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "Server1", ip: `${b}.10`, mask: "255.255.255.0", gateway: `${b}.1` },
        ],
        cliSteps: [
          {
            device: r1,
            summary: "Configure interfaces and apply Standard ACL 10 outbound on server interface",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${b}.1 255.255.255.0`,
              " ip access-group 10 out",
              " no shutdown",
              "exit",
              `access-list 10 deny host ${a}.10`,
              "access-list 10 permit any",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "config_contains", device: r1, text: "ip access-group 10 out" },
          { type: "ping", from: "PC-Allowed", to: "Server1" },
        ],
      };

    case "acl-extended":
      return {
        id,
        title: "Extended Named IPv4 ACL (HTTP/ICMP Filtering)",
        summary: `Permit HTTP (TCP/80) to Server1 while blocking ICMP ping from ${a}.10, applied closest to the source inbound.`,
        learningObjectives: [
          "Author an extended named ACL (`ip access-list extended`) matching protocol, source, destination, and TCP port",
          "Apply extended ACLs closest to the source (`in` on LAN gateway interface)",
        ],
        devices: [
          { name: "PC1", model: "PC-PT", ptType: "PC-PT", x: 140, y: 240 },
          { name: r1, model: "2911", ptType: "2911", x: 380, y: 240 },
          { name: "WebServer", model: "Server-PT", ptType: "Server-PT", x: 620, y: 240 },
        ],
        links: [
          { from: "PC1", fromPort: "FastEthernet0", to: r1, toPort: "GigabitEthernet0/0", cable: "cross" },
          { from: r1, fromPort: "GigabitEthernet0/1", to: "WebServer", toPort: "FastEthernet0", cable: "cross" },
        ],
        pcs: [
          { name: "PC1", ip: `${a}.10`, mask: "255.255.255.0", gateway: `${a}.1` },
          { name: "WebServer", ip: `${b}.10`, mask: "255.255.255.0", gateway: `${b}.1` },
        ],
        cliSteps: [
          {
            device: r1,
            summary: "Configure interfaces and Extended Named ACL FILTER_LAN inbound on Gi0/0",
            commands: [
              "enable",
              "configure terminal",
              `hostname ${r1}`,
              "no ip domain-lookup",
              "ip access-list extended FILTER_LAN",
              ` permit tcp ${a}.0 0.0.0.255 host ${b}.10 eq 80`,
              ` deny icmp host ${a}.10 host ${b}.10`,
              " permit ip any any",
              "interface GigabitEthernet0/0",
              ` ip address ${a}.1 255.255.255.0`,
              " ip access-group FILTER_LAN in",
              " no shutdown",
              "interface GigabitEthernet0/1",
              ` ip address ${b}.1 255.255.255.0`,
              " no shutdown",
              "end",
              "write memory",
            ],
          },
        ],
        objectives: [
          { type: "config_contains", device: r1, text: "ip access-list extended FILTER_LAN" },
          { type: "interface_up", device: r1, interface: "GigabitEthernet0/0", expected_ip: `${a}.1` },
        ],
      };
  }
}

export function formatLabTemplateMarkdown(spec: LabTemplateSpec, teachMode: boolean): string {
  const lines: string[] = [
    `# Lab Template: ${spec.title} (\`${spec.id}\`)`,
    "",
    spec.summary,
    "",
    "## Learning Objectives",
    ...spec.learningObjectives.map(o => `- ${o}`),
    "",
    "## Topology Devices",
    "| Device | Model | Coordinates |",
    "| --- | --- | --- |",
    ...spec.devices.map(d => `| ${d.name} | ${d.model} | (${d.x}, ${d.y}) |`),
    "",
    "## Cabling Plan",
    "| From | Port | To | Port | Cable |",
    "| --- | --- | --- | --- | --- |",
    ...spec.links.map(l => `| ${l.from} | ${l.fromPort} | ${l.to} | ${l.toPort} | ${l.cable} |`),
  ];

  if (spec.pcs.length > 0) {
    lines.push(
      "",
      "## Host Addressing",
      "| Host | IP Address | Subnet Mask | Default Gateway |",
      "| --- | --- | --- | --- |",
      ...spec.pcs.map(p => `| ${p.name} | ${p.ip} | ${p.mask} | ${p.gateway} |`),
    );
  }

  if (teachMode) {
    lines.push("", formatTeachGuide(spec.title, spec.cliSteps));
  }

  return lines.join("\n");
}

/**
 * Apply a LabTemplateSpec directly to a live Packet Tracer canvas.
 */
export async function applyLabTemplate(
  bridge: Bridge,
  spec: LabTemplateSpec,
): Promise<{ devicesAdded: number; linksCreated: number; pcsConfigured: number; cliApplied: number }> {
  let devicesAdded = 0;
  let linksCreated = 0;
  let pcsConfigured = 0;
  let cliApplied = 0;

  const deviceArgs: AddDeviceArgs[] = [];
  const iosDevices: string[] = [];
  for (const d of spec.devices) {
    const resolved = resolveModel(d.model);
    if (!resolved) {
      throw ptError("UNKNOWN_MODEL", `Unknown device model "${d.model}" in template "${spec.id}".`);
    }
    deviceArgs.push({
      name: d.name,
      category: resolved.category,
      model: resolved.ptType,
      x: d.x,
      y: d.y,
    });
    if (resolved.category === "router" || resolved.category === "switch") {
      iosDevices.push(d.name);
    }
  }

  if (deviceArgs.length > 0) {
    const res = await bridge.sendAndWait(addDevicesBatchJs(deviceArgs), {
      timeoutMs: Math.max(15_000, deviceArgs.length * 4_000),
    });
    if (!res) {
      throw ptError("TEMPLATE_APPLY_FAILED", `Batch device placement timed out for template "${spec.id}".`);
    }
    let outcomes: Array<{ name: string; ok: boolean; error?: string }>;
    try {
      outcomes = JSON.parse(res);
    } catch {
      throw ptError("TEMPLATE_APPLY_FAILED", `Unexpected batch addDevice reply: ${res.slice(0, 120)}`);
    }
    for (const item of outcomes) {
      if (!item.ok) {
        throw ptError("TEMPLATE_APPLY_FAILED", `Failed adding device "${item.name}": ${item.error ?? "unknown error"}`);
      }
      resetCliCache(item.name);
      devicesAdded++;
    }
    invalidateDeviceCache(bridge);
  }

  if (spec.links.length > 0) {
    const linkArgs = spec.links.map(l => ({
      deviceA: l.from,
      portA: l.fromPort,
      deviceB: l.to,
      portB: l.toPort,
      cable: l.cable,
    }));
    const res = await bridge.sendAndWait(createLinksBatchJs(linkArgs), {
      timeoutMs: Math.max(15_000, linkArgs.length * 3_000),
    });
    if (!res) {
      throw ptError("TEMPLATE_LINK_FAILED", `Batch cabling timed out for template "${spec.id}".`);
    }
    let outcomes: Array<{ index: number; ok: boolean; error?: string }>;
    try {
      outcomes = JSON.parse(res);
    } catch {
      throw ptError("TEMPLATE_LINK_FAILED", `Unexpected batch createLink reply: ${res.slice(0, 120)}`);
    }
    for (let i = 0; i < spec.links.length; i++) {
      const l = spec.links[i]!;
      const out = outcomes[i];
      if (!out || !out.ok) {
        throw ptError(
          "TEMPLATE_LINK_FAILED",
          `Failed linking ${l.from}:${l.fromPort} -> ${l.to}:${l.toPort}: ${out?.error ?? "unknown error"}`,
        );
      }
      linkRegistry.register(l.from, l.fromPort, l.to, l.toPort);
      linksCreated++;
    }
  }

  if (spec.pcs.length > 0) {
    const pcArgs = spec.pcs.map(pc => ({
      device: pc.name,
      port: "FastEthernet0",
      ip: pc.ip,
      mask: pc.mask,
      gateway: pc.gateway,
    }));
    const res = await bridge.sendAndWait(setEndpointsStaticIpBatchJs(pcArgs), {
      timeoutMs: Math.max(12_000, pcArgs.length * 3_000),
    });
    if (!res) {
      throw ptError("TEMPLATE_PC_FAILED", `Batch PC configuration timed out for template "${spec.id}".`);
    }
    let outcomes: Array<{ device: string; ok: boolean; error?: string }>;
    try {
      outcomes = JSON.parse(res);
    } catch {
      throw ptError("TEMPLATE_PC_FAILED", `Unexpected batch PC reply: ${res.slice(0, 120)}`);
    }
    for (const item of outcomes) {
      if (!item.ok) {
        throw ptError("TEMPLATE_PC_FAILED", `Failed configuring IP on "${item.device}": ${item.error ?? "unknown error"}`);
      }
      pcsConfigured++;
    }
  }

  if (iosDevices.length > 0 && spec.cliSteps.length > 0) {
    await waitForCliReadyAll(bridge, iosDevices);
  }

  for (const step of spec.cliSteps) {
    await prepareDevice(bridge, step.device);
    const res = await bridge.sendAndWait(
      bulkCliJs(step.device, step.commands.join("\n"), 2_000),
      { timeoutMs: 30_000 },
    );
    if (res === null || res.startsWith("ERR:") || res.startsWith("ERROR:")) {
      throw ptError("TEMPLATE_CLI_FAILED", `Failed applying CLI on "${step.device}": ${res ?? "timeout"}`);
    }
    cliApplied++;
  }

  return { devicesAdded, linksCreated, pcsConfigured, cliApplied };
}
