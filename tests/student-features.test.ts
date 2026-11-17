import { describe, expect, test } from "bun:test";
import { resolveModel } from "../src/catalog/devices.js";
import { renderSvgToPng } from "../src/render/png.js";
import {
  formatAddressingCsv,
  formatAddressingMarkdown,
  maskToPrefix,
  parseAddressingDump,
} from "../src/student/addressing.js";
import { explainCliOutput } from "../src/student/explain.js";
import {
  checkConfigContainsText,
  checkInterfaceUpInOutput,
  checkRouteInOutput,
  checkVlanInOutput,
  formatLabCheckMarkdown,
} from "../src/student/lab-check.js";
import {
  buildLabTemplate,
  formatLabTemplateMarkdown,
  LAB_TEMPLATE_IDS,
} from "../src/student/lab-templates.js";
import {
  diagnosePingFailure,
  renderPingMatrixMarkdown,
  renderPingMatrixSvg,
  type PingMatrixResult,
} from "../src/student/ping-matrix.js";
import { calculateSubnet, calculateVlsm } from "../src/student/subnet-calc.js";
import { isTeachModeEnabled } from "../src/student/teach.js";

describe("Addressing Table (pt_addressing_table)", () => {
  const sampleDump = [
    "DEV|R1|2911|",
    "PORT|GigabitEthernet0/0|192.168.1.1|255.255.255.0|1",
    "PORT|GigabitEthernet0/1|10.0.0.1|255.255.255.252|1",
    "PORT|GigabitEthernet0/2|||0",
    "DEV|PC-A|PC-PT|192.168.1.1",
    "PORT|FastEthernet0|192.168.1.10|255.255.255.0|1",
  ].join("\n");

  test("maskToPrefix converts standard and VLSM masks", () => {
    expect(maskToPrefix("255.255.255.0")).toBe(24);
    expect(maskToPrefix("255.255.255.252")).toBe(30);
    expect(maskToPrefix("255.255.0.0")).toBe(16);
    expect(maskToPrefix("0.0.0.0")).toBeNull();
    expect(maskToPrefix("255.0.255.0")).toBeNull();
  });

  test("parses addressing dump into rows, Markdown, and CSV", () => {
    const rows = parseAddressingDump(sampleDump, false);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({ device: "R1", interface: "GigabitEthernet0/0", cidr: "192.168.1.1/24", gateway: "N/A" });
    expect(rows[2]).toMatchObject({ device: "PC-A", ip: "192.168.1.10", gateway: "192.168.1.1" });

    const md = formatAddressingMarkdown(rows);
    expect(md).toContain("| Device | Interface | IP Address | Subnet Mask | Default Gateway |");
    expect(md).toContain("| PC-A | FastEthernet0 | 192.168.1.10 | 255.255.255.0 | 192.168.1.1 |");

    const csv = formatAddressingCsv(rows);
    expect(csv).toContain("PC-A,PC-PT,FastEthernet0,192.168.1.10,255.255.255.0,192.168.1.10/24,192.168.1.1,yes");
  });
});

describe("Ping Matrix (pt_ping_matrix)", () => {
  test("diagnoses missing default gateway for remote subnet", () => {
    const src = {
      device: "PC-A", model: "PC-PT", interface: "Fa0",
      ip: "192.168.1.10", mask: "255.255.255.0", cidr: "192.168.1.10/24",
      gateway: "Not configured", connected: true,
    };
    const dst = {
      device: "PC-B", model: "PC-PT", interface: "Fa0",
      ip: "192.168.2.10", mask: "255.255.255.0", cidr: "192.168.2.10/24",
      gateway: "192.168.2.1", connected: true,
    };
    expect(diagnosePingFailure(src, dst, "Request timed out.")).toContain("missing a default gateway");
  });

  test("renders Markdown and valid SVG + PNG matrix image", async () => {
    const hosts = [
      { name: "PC-A", ip: "192.168.1.10", gateway: "192.168.1.1" },
      { name: "PC-B", ip: "192.168.2.10", gateway: "192.168.2.1" },
    ];
    const cells = [
      { from: "PC-A", to: "PC-A", targetIp: "192.168.1.10", status: "self" as const, sent: 0, received: 0, successRate: 100 },
      { from: "PC-A", to: "PC-B", targetIp: "192.168.2.10", status: "pass" as const, sent: 4, received: 4, successRate: 100 },
      { from: "PC-B", to: "PC-A", targetIp: "192.168.1.10", status: "fail" as const, sent: 4, received: 0, successRate: 0, diagnosis: "No return route." },
      { from: "PC-B", to: "PC-B", targetIp: "192.168.2.10", status: "self" as const, sent: 0, received: 0, successRate: 100 },
    ];
    const md = renderPingMatrixMarkdown(hosts, cells);
    expect(md).toContain("✅ 4/4");
    expect(md).toContain("❌ 0/4");
    expect(md).toContain("No return route.");

    const matrix: PingMatrixResult = { hosts, cells, passed: 1, failed: 1, total: 2, markdown: md };
    const svg = renderPingMatrixSvg(matrix);
    expect(svg).toContain("PASS 4/4");
    expect(svg).toContain("FAIL 0/4");

    const raster = await renderSvgToPng(svg, 2);
    expect(raster.png).not.toBeNull();
    expect(Array.from(raster.png!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("Lab Checker Evaluators (pt_check_lab)", () => {
  test("checks route, interface_up, config_contains, and vlan_exists accurately", () => {
    const routeOut = "S*   0.0.0.0/0 [1/0] via 10.0.0.2\nC    192.168.1.0/24 is directly connected, GigabitEthernet0/0";
    expect(checkRouteInOutput(routeOut, "0.0.0.0/0", "10.0.0.2").passed).toBe(true);
    expect(checkRouteInOutput(routeOut, "172.16.0.0/16").passed).toBe(false);

    const intBrief = [
      "Interface              IP-Address      OK? Method Status                Protocol",
      "GigabitEthernet0/0     192.168.1.1     YES manual up                    up",
      "GigabitEthernet0/1     unassigned      YES unset  administratively down down",
    ].join("\n");
    expect(checkInterfaceUpInOutput(intBrief, "GigabitEthernet0/0", "192.168.1.1").passed).toBe(true);
    expect(checkInterfaceUpInOutput(intBrief, "GigabitEthernet0/1").passed).toBe(false);

    expect(checkConfigContainsText("hostname R1\nrouter ospf 1\n", "router ospf 1").passed).toBe(true);
    expect(checkConfigContainsText("hostname R1\n", "router bgp").passed).toBe(false);

    const vlanOut = "10   STUDENTS                         active    Fa0/1, Fa0/2\n20   FACULTY                          active    Fa0/3";
    expect(checkVlanInOutput(vlanOut, 10, "STUDENTS").passed).toBe(true);
    expect(checkVlanInOutput(vlanOut, 10, "WRONG").passed).toBe(false);
    expect(checkVlanInOutput(vlanOut, 99).passed).toBe(false);

    const md = formatLabCheckMarkdown([
      { objective: { type: "route", device: "R1", prefix: "0.0.0.0/0" }, passed: true, label: "Default route", evidence: "S* 0.0.0.0/0" },
    ]);
    expect(md).toContain("1/1 passed (100%)");
  });
});

describe("Explain CLI Output (pt_explain_output)", () => {
  test("explains show ip route with codes, AD/metric, and gateway of last resort", () => {
    const out = [
      "Gateway of last resort is 10.0.0.2 to network 0.0.0.0",
      "C    192.168.1.0/24 is directly connected, GigabitEthernet0/0",
      "S*   0.0.0.0/0 [1/0] via 10.0.0.2",
      "O    192.168.2.0/24 [110/2] via 10.0.0.2",
    ].join("\n");
    const res = explainCliOutput(out);
    expect(res.kind).toBe("show-ip-route");
    expect(res.markdown).toContain("Administrative Distance (trustworthiness) = 110, Metric (cost/hops) = 2");
    expect(res.markdown).toContain("Default gateway of last resort is active");
  });

  test("explains show ip arp including local interface age '-'", () => {
    const out = [
      "Protocol  Address          Age (min)  Hardware Addr   Type   Interface",
      "Internet  192.168.1.1             -   0001.42A1.B201  ARPA   GigabitEthernet0/0",
      "Internet  192.168.1.10            4   00D0.BC12.3456  ARPA   GigabitEthernet0/0",
    ].join("\n");
    const res = explainCliOutput(out);
    expect(res.kind).toBe("show-ip-arp");
    expect(res.markdown).toContain("own local interface");
    expect(res.markdown).toContain("Learned dynamically 4 minute(s) ago");
  });

  test("explains show ip interface brief up/up vs administratively down", () => {
    const out = [
      "Interface              IP-Address      OK? Method Status                Protocol",
      "GigabitEthernet0/0     192.168.1.1     YES manual up                    up",
      "GigabitEthernet0/1     unassigned      YES unset  administratively down down",
    ].join("\n");
    const res = explainCliOutput(out);
    expect(res.kind).toBe("show-ip-int-brief");
    expect(res.markdown).toContain("Both Layer 1 (physical link) and Layer 2 (line protocol) are UP");
    expect(res.markdown).toContain("Run `no shutdown`");
  });
});

describe("Subnet & VLSM Calculator (pt_subnet_calc)", () => {
  test("calculates single subnet details accurately", () => {
    const s = calculateSubnet("192.168.10.55/26");
    expect(s.network).toBe("192.168.10.0");
    expect(s.broadcast).toBe("192.168.10.63");
    expect(s.mask).toBe("255.255.255.192");
    expect(s.wildcard).toBe("0.0.0.63");
    expect(s.firstHost).toBe("192.168.10.1");
    expect(s.lastHost).toBe("192.168.10.62");
    expect(s.usableHosts).toBe(62);
    expect(s.isPrivate).toBe(true);

    const byMask = calculateSubnet("10.0.0.1", "255.255.255.252");
    expect(byMask.cidr).toBe("10.0.0.0/30");
    expect(byMask.usableHosts).toBe(2);
  });

  test("allocates non-overlapping VLSM subnets sorted largest-first", () => {
    const plan = calculateVlsm("192.168.10.0/24", [
      { name: "WAN", hosts: 2 },
      { name: "Students", hosts: 100 },
      { name: "Faculty", hosts: 40 },
    ]);
    expect(plan.allocations.map(a => a.name)).toEqual(["Students", "Faculty", "WAN"]);
    expect(plan.allocations[0]!.cidr).toBe("192.168.10.0/25");
    expect(plan.allocations[1]!.cidr).toBe("192.168.10.128/26");
    expect(plan.allocations[2]!.cidr).toBe("192.168.10.192/30");
    expect(plan.remainingAddresses).toBe(256 - 128 - 64 - 4);
  });
});

describe("University Lab Templates & Teach Mode (pt_lab_template)", () => {
  test("Teach mode is OFF by default and respects dry_run & STU_PT_TEACH_MODE", () => {
    const prev = process.env.STU_PT_TEACH_MODE;
    try {
      delete process.env.STU_PT_TEACH_MODE;
      expect(isTeachModeEnabled()).toBe(false);
      expect(isTeachModeEnabled(true)).toBe(true);
      process.env.STU_PT_TEACH_MODE = "1";
      expect(isTeachModeEnabled()).toBe(true);
      expect(isTeachModeEnabled(false)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.STU_PT_TEACH_MODE;
      else process.env.STU_PT_TEACH_MODE = prev;
    }
  });

  test("all 10 lab templates build valid device catalogs, CLI steps, and objectives", () => {
    expect(LAB_TEMPLATE_IDS.length).toBe(10);
    for (const id of LAB_TEMPLATE_IDS) {
      const spec = buildLabTemplate(id);
      expect(spec.devices.length).toBeGreaterThanOrEqual(3);
      expect(spec.cliSteps.length).toBeGreaterThanOrEqual(1);
      expect(spec.objectives.length).toBeGreaterThanOrEqual(2);
      for (const dev of spec.devices) {
        expect(resolveModel(dev.model)).not.toBeNull();
      }
      const teachMd = formatLabTemplateMarkdown(spec, true);
      expect(teachMd).toContain("[Teach Mode — Dry Run]");
    }
  });
});
