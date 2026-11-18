import { describe, expect, test } from "bun:test";
import type { CanvasSnapshot } from "../src/canvas/types.js";
import type { AddressingRow } from "../src/student/addressing.js";
import { formatBreakLabMarkdown, planLabFaults } from "../src/student/break-lab.js";
import { analyzeLabFaults, formatDiagnosisMarkdown, type DiagnoseInputState } from "../src/student/fault-diagnose.js";
import { analyzePacketPath } from "../src/student/trace-path.js";

function makeHealthyState(): DiagnoseInputState {
  const snapshot: CanvasSnapshot = {
    capturedAt: "2026-11-18T00:00:00Z",
    devices: [
      {
        name: "R1",
        model: "2911",
        className: "Router",
        category: "router",
        x: 100,
        y: 100,
        powered: true,
        ports: [
          { name: "GigabitEthernet0/0", ip: "10.0.0.1", mask: "255.255.255.0", linked: true },
          { name: "GigabitEthernet0/1", ip: "50.0.0.1", mask: "255.255.255.252", linked: true },
        ],
      },
      {
        name: "R2",
        model: "2911",
        className: "Router",
        category: "router",
        x: 300,
        y: 100,
        powered: true,
        ports: [
          { name: "GigabitEthernet0/0", ip: "20.0.0.1", mask: "255.255.255.0", linked: true },
          { name: "GigabitEthernet0/1", ip: "50.0.0.2", mask: "255.255.255.252", linked: true },
        ],
      },
      {
        name: "SW1",
        model: "2960-24TT",
        className: "Switch",
        category: "switch",
        x: 100,
        y: 220,
        powered: true,
        ports: [
          { name: "FastEthernet0/1", ip: "", mask: "", linked: true },
          { name: "FastEthernet0/2", ip: "", mask: "", linked: true },
        ],
      },
      {
        name: "PC-A",
        model: "PC-PT",
        className: "PC",
        category: "pc",
        x: 100,
        y: 320,
        powered: true,
        ports: [{ name: "FastEthernet0", ip: "10.0.0.10", mask: "255.255.255.0", linked: true }],
      },
      {
        name: "PC-B",
        model: "PC-PT",
        className: "PC",
        category: "pc",
        x: 300,
        y: 320,
        powered: true,
        ports: [{ name: "FastEthernet0", ip: "20.0.0.10", mask: "255.255.255.0", linked: true }],
      },
    ],
    links: [
      { aDevice: "PC-A", aPort: "FastEthernet0", bDevice: "SW1", bPort: "FastEthernet0/2" },
      { aDevice: "SW1", aPort: "FastEthernet0/1", bDevice: "R1", bPort: "GigabitEthernet0/0" },
      { aDevice: "R1", aPort: "GigabitEthernet0/1", bDevice: "R2", bPort: "GigabitEthernet0/1" },
      { aDevice: "R2", aPort: "GigabitEthernet0/0", bDevice: "PC-B", bPort: "FastEthernet0" },
    ],
  };

  const addressingRows: AddressingRow[] = [
    { device: "R1", model: "2911", interface: "GigabitEthernet0/0", ip: "10.0.0.1", mask: "255.255.255.0", cidr: "10.0.0.1/24", gateway: "N/A", connected: true },
    { device: "R1", model: "2911", interface: "GigabitEthernet0/1", ip: "50.0.0.1", mask: "255.255.255.252", cidr: "50.0.0.1/30", gateway: "N/A", connected: true },
    { device: "R2", model: "2911", interface: "GigabitEthernet0/0", ip: "20.0.0.1", mask: "255.255.255.0", cidr: "20.0.0.1/24", gateway: "N/A", connected: true },
    { device: "R2", model: "2911", interface: "GigabitEthernet0/1", ip: "50.0.0.2", mask: "255.255.255.252", cidr: "50.0.0.2/30", gateway: "N/A", connected: true },
    { device: "PC-A", model: "PC-PT", interface: "FastEthernet0", ip: "10.0.0.10", mask: "255.255.255.0", cidr: "10.0.0.10/24", gateway: "10.0.0.1", connected: true },
    { device: "PC-B", model: "PC-PT", interface: "FastEthernet0", ip: "20.0.0.10", mask: "255.255.255.0", cidr: "20.0.0.10/24", gateway: "20.0.0.1", connected: true },
  ];

  const routerRoutes: Record<string, string> = {
    R1: [
      "Gateway of last resort is not set",
      "C    10.0.0.0/24 is directly connected, GigabitEthernet0/0",
      "C    50.0.0.0/30 is directly connected, GigabitEthernet0/1",
      "S    20.0.0.0/24 [1/0] via 50.0.0.2",
    ].join("\n"),
    R2: [
      "Gateway of last resort is not set",
      "C    20.0.0.0/24 is directly connected, GigabitEthernet0/0",
      "C    50.0.0.0/30 is directly connected, GigabitEthernet0/1",
      "S    10.0.0.0/24 [1/0] via 50.0.0.1",
    ].join("\n"),
  };

  const routerIntBrief: Record<string, string> = {
    R1: "GigabitEthernet0/0 10.0.0.1 YES manual up up\nGigabitEthernet0/1 50.0.0.1 YES manual up up",
    R2: "GigabitEthernet0/0 20.0.0.1 YES manual up up\nGigabitEthernet0/1 50.0.0.2 YES manual up up",
  };

  const routerRunningConfig: Record<string, string> = {
    R1: "ip route 20.0.0.0 255.255.255.0 50.0.0.2",
    R2: "ip route 10.0.0.0 255.255.255.0 50.0.0.1",
  };

  return { snapshot, addressingRows, routerRoutes, routerIntBrief, routerRunningConfig };
}

describe("Lab Fault Doctor (pt_diagnose_faults)", () => {
  test("reports zero faults on a healthy routed lab", () => {
    const faults = analyzeLabFaults(makeHealthyState());
    expect(faults.length).toBe(0);
    expect(formatDiagnosisMarkdown(faults, "commands")).toContain("0 faults found");
  });

  test("detects classful /8 mask trap, wrong gateway, admin down, self next-hop, and one-way routing", () => {
    const healthy = makeHealthyState();
    const broken: DiagnoseInputState = {
      ...healthy,
      addressingRows: healthy.addressingRows.map(r => {
        if (r.device === "PC-A") {
          return { ...r, mask: "255.0.0.0", cidr: "10.0.0.10/8", gateway: "10.0.0.254" };
        }
        if (r.device === "PC-B") {
          return { ...r, gateway: "Not configured" };
        }
        return r;
      }),
      routerIntBrief: {
        R1: "GigabitEthernet0/0 10.0.0.1 YES manual up up\nGigabitEthernet0/1 50.0.0.1 YES manual up up",
        R2: "GigabitEthernet0/0 20.0.0.1 YES manual administratively down down\nGigabitEthernet0/1 50.0.0.2 YES manual up up",
      },
      routerRunningConfig: {
        R1: "ip route 20.0.0.0 255.255.255.0 50.0.0.1", // self-pointing!
        R2: "",
      },
      routerRoutes: {
        R1: healthy.routerRoutes!.R1!,
        R2: "C 20.0.0.0/24 is directly connected, GigabitEthernet0/0\nC 50.0.0.0/30 is directly connected, GigabitEthernet0/1",
      },
    };

    const faults = analyzeLabFaults(broken);
    const codes = new Set(faults.map(f => f.code));

    expect(codes.has("ROUTER_INTERFACE_ADMIN_DOWN")).toBe(true);
    expect(codes.has("PC_CLASSFUL_MASK_TRAP")).toBe(true);
    expect(codes.has("PC_GATEWAY_IP_MISMATCH")).toBe(true);
    expect(codes.has("PC_MISSING_GATEWAY")).toBe(true);
    expect(codes.has("STATIC_ROUTE_SELF_NEXT_HOP")).toBe(true);
    expect(codes.has("ONE_WAY_ROUTING")).toBe(true);

    // Hints mode hides CLI answer block
    const hintsMd = formatDiagnosisMarkdown(faults, "hints");
    expect(hintsMd).toContain("Study Hints");
    expect(hintsMd).not.toContain("no shutdown");

    // Commands mode includes exact CLI fixes
    const cmdMd = formatDiagnosisMarkdown(faults, "commands");
    expect(cmdMd).toContain("no shutdown");
    expect(cmdMd).toContain("ip route 10.0.0.0 255.255.255.0 50.0.0.1");
  });
});

describe("Forward & Return Path Analyzer (pt_trace_path)", () => {
  test("confirms bidirectional path when forward and return routes exist", () => {
    const res = analyzePacketPath(makeHealthyState(), "PC-A", "PC-B");
    expect(res.bidirectionalOk).toBe(true);
    expect(res.forward.delivered).toBe(true);
    expect(res.reverse.delivered).toBe(true);
    expect(res.forward.hops.length).toBe(3);
  });

  test("pinpoints one-way return route drop when reply lacks route to PC-A", () => {
    const base = makeHealthyState();
    const oneWay: DiagnoseInputState = {
      ...base,
      routerRoutes: {
        R1: base.routerRoutes!.R1!,
        // R2 lost its return route to 10.0.0.0/24
        R2: "C 20.0.0.0/24 is directly connected, GigabitEthernet0/0\nC 50.0.0.0/30 is directly connected, GigabitEthernet0/1",
      },
    };

    const res = analyzePacketPath(oneWay, "PC-A", "PC-B");
    expect(res.bidirectionalOk).toBe(false);
    expect(res.forward.delivered).toBe(true);
    expect(res.reverse.delivered).toBe(false);
    expect(res.reverse.dropDevice).toBe("R2");
    expect(res.reverse.dropReason).toBe("NO_ROUTE_TO_DESTINATION");
    expect(res.markdown).toContain("dropped on the return path");
  });

  test("catches missing default gateway on source host", () => {
    const base = makeHealthyState();
    const broken: DiagnoseInputState = {
      ...base,
      addressingRows: base.addressingRows.map(r =>
        r.device === "PC-A" ? { ...r, gateway: "Not configured" } : r,
      ),
    };

    const res = analyzePacketPath(broken, "PC-A", "PC-B");
    expect(res.bidirectionalOk).toBe(false);
    expect(res.forward.delivered).toBe(false);
    expect(res.forward.dropDevice).toBe("PC-A");
    expect(res.forward.dropReason).toBe("MISSING_DEFAULT_GATEWAY");
  });
});

describe("Troubleshooting Challenge Generator (pt_break_lab)", () => {
  test("generates repeatable fault tickets and respects reveal_solutions flag", () => {
    const state = makeHealthyState();
    const faults1 = planLabFaults(state, { count: 2, difficulty: "hard", seed: 1234 });
    const faults2 = planLabFaults(state, { count: 2, difficulty: "hard", seed: 1234 });

    expect(faults1.length).toBe(2);
    expect(faults1).toEqual(faults2);
    expect(faults1[0]!.injectAction.device).toBeTruthy();
    expect(faults1[0]!.restoreAction.device).toBeTruthy();

    const hiddenMd = formatBreakLabMarkdown(faults1, "hard", 2, false, false);
    expect(hiddenMd).toContain("Spoilers hidden");
    expect(hiddenMd).not.toContain("Answer Key");

    const revealedMd = formatBreakLabMarkdown(faults1, "hard", 2, false, true);
    expect(revealedMd).toContain("Answer Key & Restore Commands");
  });

  test("handles Router-on-a-Stick subinterfaces and empty snapshot links cleanly", () => {
    const base = makeHealthyState();
    const roasSnapshot = {
      ...base.snapshot,
      devices: base.snapshot.devices.map(d =>
        d.name === "R1"
          ? {
              ...d,
              ports: d.ports.map(p => p.name === "GigabitEthernet0/0" ? { ...p, ip: "0.0.0.0", mask: "0.0.0.0" } : p),
            }
          : d
      ),
      links: [], // Simulates loaded .pkt / restarted daemon with empty in-memory linkRegistry
    };
    const roasRows = [
      ...base.addressingRows.filter(r => !(r.device === "R1" && r.interface === "GigabitEthernet0/0")),
      { device: "R1", interface: "GigabitEthernet0/0.10", ip: "10.0.0.1", mask: "255.255.255.0", gateway: "N/A" },
      { device: "R1", interface: "GigabitEthernet0/0.20", ip: "10.0.99.1", mask: "255.255.255.0", gateway: "N/A" },
    ];
    const roasState = { ...base, snapshot: roasSnapshot, addressingRows: roasRows };

    const faults = analyzeLabFaults(roasState);
    expect(faults).toHaveLength(0);

    const traceRes = analyzePacketPath(roasState, "PC-A", "PC-B");
    expect(traceRes.bidirectionalOk).toBe(true);
    expect(traceRes.forward.delivered).toBe(true);
    expect(traceRes.reverse.delivered).toBe(true);
  });
});
