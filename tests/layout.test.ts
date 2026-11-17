import { describe, expect, test } from "bun:test";
import { gridLayoutCanvas, LAYOUT } from "../src/canvas/layout.js";
import type { CanvasSnapshot, DeviceObservation, LinkObservation } from "../src/canvas/types.js";
import type { DeviceCategory } from "../src/ipc/constants.js";

function dev(name: string, category: DeviceCategory, x = 0, y = 0): DeviceObservation {
  return {
    name,
    model: name,
    className: category,
    category,
    x,
    y,
    powered: true,
    ports: [],
  };
}
function link(a: string, b: string): LinkObservation {
  return { aDevice: a, aPort: "p", bDevice: b, bPort: "p" };
}
function snap(devices: DeviceObservation[], links: LinkObservation[]): CanvasSnapshot {
  return { capturedAt: "test", devices, links };
}
function placedAt(moves: readonly { name: string; x: number; y: number }[], name: string) {
  return moves.find(m => m.name === name);
}

describe("gridLayoutCanvas — v2 algorithm", () => {
  test("router ordering respects current snapshot X", () => {
    // Routers out of order in X: R3 to the left. The layout must respect
    // the visual position the user already had.
    const devices = [
      dev("R3", "router", 0, 0),
      dev("R1", "router", 50, 0),
      dev("R2", "router", 100, 0),
      dev("R4", "router", 200, 0),
    ];
    const links = [link("R1", "R2"), link("R2", "R3"), link("R3", "R4")];
    const moves = gridLayoutCanvas(snap(devices, links));
    const r3 = placedAt(moves, "R3")!;
    const r1 = placedAt(moves, "R1")!;
    const r2 = placedAt(moves, "R2")!;
    const r4 = placedAt(moves, "R4")!;
    expect(r3.x).toBeLessThan(r1.x);
    expect(r1.x).toBeLessThan(r2.x);
    expect(r2.x).toBeLessThan(r4.x);
    expect(r3.y).toBe(LAYOUT.Y_ROUTER);
    expect(r4.y).toBe(LAYOUT.Y_ROUTER);
  });

  test("fresh topology (all routers at same X) sorts by name", () => {
    // Typical case of newly cooked canvas: R1-R4 at (0,0) except alphabetical
    // name order. Tie-break by name gives R1-R2-R3-R4.
    const devices = [
      dev("R4", "router"), dev("R2", "router"),
      dev("R1", "router"), dev("R3", "router"),
    ];
    const links = [link("R1", "R2"), link("R2", "R3"), link("R3", "R4")];
    const moves = gridLayoutCanvas(snap(devices, links));
    const xs = ["R1", "R2", "R3", "R4"].map(n => placedAt(moves, n)!.x);
    expect(xs[0]!).toBeLessThan(xs[1]!);
    expect(xs[1]!).toBeLessThan(xs[2]!);
    expect(xs[2]!).toBeLessThan(xs[3]!);
  });

  test("clouds distribute above and below router, not all in the top row", () => {
    // Router with 4 clouds → half above (Y_CLOUD), half below (Y_CLOUD_BOTTOM).
    const devices = [
      dev("R1", "router"),
      dev("LAN1", "cloud"),
      dev("LAN2", "cloud"),
      dev("LAN3", "cloud"),
      dev("LAN4", "cloud"),
    ];
    const links = [link("R1", "LAN1"), link("R1", "LAN2"), link("R1", "LAN3"), link("R1", "LAN4")];
    const moves = gridLayoutCanvas(snap(devices, links));
    const ys = ["LAN1", "LAN2", "LAN3", "LAN4"]
      .map(n => placedAt(moves, n)!.y);
    const top = ys.filter(y => y === LAYOUT.Y_CLOUD).length;
    const bottom = ys.filter(y => y === LAYOUT.Y_CLOUD_BOTTOM).length;
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeGreaterThan(0);
    expect(top + bottom).toBe(4);
  });

  test("shared node between two routers is centered between them", () => {
    // Internet connected to R2 and R3 → x ≈ average of R2 and R3 centers.
    const devices = [
      dev("R1", "router"), dev("R2", "router"),
      dev("R3", "router"), dev("R4", "router"),
      dev("Internet", "cloud"),
    ];
    const links = [
      link("R1", "R2"), link("R2", "R3"), link("R3", "R4"),
      link("Internet", "R2"), link("Internet", "R3"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const r2 = placedAt(moves, "R2")!;
    const r3 = placedAt(moves, "R3")!;
    const inet = placedAt(moves, "Internet")!;
    const mid = (r2.x + r3.x) / 2;
    // 2px rounding tolerance.
    expect(Math.abs(inet.x - mid)).toBeLessThan(2);
    // Shared cloud Y falls into the bottom band.
    expect(inet.y).toBe(LAYOUT.Y_CLOUD_BOTTOM);
  });

  test("sibling switches under same router distribute horizontally without collision", () => {
    // R1 with 3 sibling switches. Must be on same Y_SWITCH row and different X.
    const devices = [
      dev("R1", "router"),
      dev("S1", "switch"), dev("S2", "switch"), dev("S3", "switch"),
    ];
    const links = [link("R1", "S1"), link("R1", "S2"), link("R1", "S3")];
    const moves = gridLayoutCanvas(snap(devices, links));
    const sw = ["S1", "S2", "S3"].map(n => placedAt(moves, n)!);
    expect(sw.every(s => s.y === LAYOUT.Y_SWITCH)).toBe(true);
    const xs = sw.map(s => s.x).sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(60);
    expect(xs[2]! - xs[1]!).toBeGreaterThanOrEqual(60);
  });

  test("endpoints of a switch center under that switch (not under router)", () => {
    const devices = [
      dev("R1", "router"),
      dev("S1", "switch"),
      dev("S2", "switch"),
      dev("PC1", "pc"), dev("PC2", "pc"),
      dev("PC3", "pc"), dev("PC4", "pc"),
    ];
    const links = [
      link("R1", "S1"), link("R1", "S2"),
      link("S1", "PC1"), link("S1", "PC2"),
      link("S2", "PC3"), link("S2", "PC4"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const s1 = placedAt(moves, "S1")!.x;
    const s2 = placedAt(moves, "S2")!.x;
    const pc1 = placedAt(moves, "PC1")!.x;
    const pc2 = placedAt(moves, "PC2")!.x;
    const pc3 = placedAt(moves, "PC3")!.x;
    const pc4 = placedAt(moves, "PC4")!.x;
    // PC1/PC2 centered over S1; PC3/PC4 centered over S2.
    expect(Math.abs((pc1 + pc2) / 2 - s1)).toBeLessThan(2);
    expect(Math.abs((pc3 + pc4) / 2 - s2)).toBeLessThan(2);
  });

  test("idempotence: applying layout and calling it again yields 0 new moves", () => {
    const devices = [
      dev("R1", "router"), dev("R2", "router"),
      dev("S1", "switch"), dev("PC1", "pc"), dev("PC2", "pc"),
      dev("LAN1", "cloud"), dev("LAN2", "cloud"),
    ];
    const links = [
      link("R1", "R2"), link("R1", "S1"),
      link("S1", "PC1"), link("S1", "PC2"),
      link("R1", "LAN1"), link("R2", "LAN2"),
    ];
    const moves1 = gridLayoutCanvas(snap(devices, links));
    expect(moves1.length).toBeGreaterThan(0);
    // Apply and call again.
    const moved = devices.map(d => {
      const m = moves1.find(x => x.name === d.name);
      return m ? { ...d, x: m.x, y: m.y } : d;
    });
    const moves2 = gridLayoutCanvas(snap(moved, links));
    expect(moves2).toHaveLength(0);
  });

  test("childless router still occupies minimum slot (does not collide with next)", () => {
    const devices = [
      dev("R1", "router"),
      dev("R2", "router"),
      dev("R3", "router"),
    ];
    const links = [link("R1", "R2"), link("R2", "R3")];
    const moves = gridLayoutCanvas(snap(devices, links));
    const xs = ["R1", "R2", "R3"].map(n => placedAt(moves, n)!.x);
    // Routers separated by at least 2 units + GAP.
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(2 * LAYOUT.PC_X_SPACING);
    expect(xs[2]! - xs[1]!).toBeGreaterThanOrEqual(2 * LAYOUT.PC_X_SPACING);
  });

  test("orphan switches (no router) go to lateral column", () => {
    const devices = [
      dev("R1", "router"),
      dev("S1", "switch"),
      dev("S_orphan", "switch"),
      dev("PC_orphan", "pc"),
    ];
    const links = [
      link("R1", "S1"),
      link("S_orphan", "PC_orphan"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const r1 = placedAt(moves, "R1")!.x;
    const sOrphan = placedAt(moves, "S_orphan");
    expect(sOrphan).toBeDefined();
    expect(sOrphan!.x).toBeGreaterThan(r1);
  });

  test("RO2-P2: VoIP+QoS lab with two sites and serial link", () => {
    // Faithful replica of topology requested in lab RO2-P2 (Voice over IP
    // and QoS) — two 2811 routers connected by serial, site 1 with 2950 switch +
    // 3560 + Server-PT DHCP + 4 PCs + 3 IP phones + 1 ATA, site 2 with a
    // 3560 and 3 IP phones. Serves as integration test for layout v2
    // against a real topology.
    const devices = [
      // Routers (backbone)
      dev("R1", "router"),
      dev("R2", "router"),
      // Site 1 switches
      dev("S_access", "switch"),         // Cisco 2950
      dev("S_main", "multilayerswitch"), // Cisco 3560
      // Site 2 switch
      dev("S2", "multilayerswitch"),     // Cisco 3560
      // Site 1 endpoints — attached to S_access
      dev("PC01", "pc"),
      dev("PC02", "pc"),
      dev("PC03", "pc"),
      dev("Phone1001", "ipphone"),
      dev("Phone1002", "ipphone"),
      // Site 1 endpoints — attached to S_main
      dev("Server_DHCP", "server"),
      dev("Phone1003", "ipphone"),
      dev("PC04", "pc"),
      dev("ATA1004", "iot"),             // Home-VoIP-PT
      dev("AnalogPhone1004", "tdm"),     // Analog-Phone-PT hanging off ATA
      // Site 2 endpoints — attached to S2
      dev("Phone4001", "ipphone"),
      dev("Phone4002", "ipphone"),
      dev("Phone4003", "ipphone"),
    ];
    const links = [
      // Backbone serial 2M
      link("R1", "R2"),
      // Site 1 — R1 <-> S_main (trunk to 3560), S_main <-> S_access (trunk)
      link("R1", "S_main"),
      link("S_main", "S_access"),
      // S_access: PC01-03 + Phone1001-1002
      link("S_access", "PC01"),
      link("S_access", "PC02"),
      link("S_access", "PC03"),
      link("S_access", "Phone1001"),
      link("S_access", "Phone1002"),
      // S_main: Server DHCP + Phone1003 + PC04 + ATA
      link("S_main", "Server_DHCP"),
      link("S_main", "Phone1003"),
      link("S_main", "PC04"),
      link("S_main", "ATA1004"),
      link("ATA1004", "AnalogPhone1004"),
      // Sede 2 — R2 ↔ S2 + 3 phones
      link("R2", "S2"),
      link("S2", "Phone4001"),
      link("S2", "Phone4002"),
      link("S2", "Phone4003"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));

    // Helper for all positions (even unchanged ones). In this test
    // we start from (0,0) so everything is in moves.
    const pos = (n: string) => placedAt(moves, n)!;

    // ---- Rows ----
    expect(pos("R1").y).toBe(LAYOUT.Y_ROUTER);
    expect(pos("R2").y).toBe(LAYOUT.Y_ROUTER);
    expect(pos("S_access").y).toBe(LAYOUT.Y_SWITCH);
    expect(pos("S_main").y).toBe(LAYOUT.Y_SWITCH);
    expect(pos("S2").y).toBe(LAYOUT.Y_SWITCH);
    expect(pos("PC01").y).toBe(LAYOUT.Y_ENDPOINT);
    expect(pos("Phone1001").y).toBe(LAYOUT.Y_ENDPOINT);
    expect(pos("Phone4001").y).toBe(LAYOUT.Y_ENDPOINT);
    expect(pos("Server_DHCP").y).toBe(LAYOUT.Y_SERVER);

    // ---- Backbone: R1 on left, R2 on right ----
    expect(pos("R1").x).toBeLessThan(pos("R2").x);

    // ---- Site 1 wider than site 2 (larger subtree) ----
    // R1 has 2 switches with 5+3 endpoints; R2 has 1 switch with 3 phones.
    // The gap between R1 and R2 must reflect this width difference.
    const gap = pos("R2").x - pos("R1").x;
    expect(gap).toBeGreaterThanOrEqual(5 * LAYOUT.PC_X_SPACING);

    // ---- Site 1 switches both in left half (close to R1) ----
    expect(pos("S_access").x).toBeLessThan(pos("R2").x);
    expect(pos("S_main").x).toBeLessThan(pos("R2").x);
    // S2 (site 2) is close to R2.
    expect(Math.abs(pos("S2").x - pos("R2").x)).toBeLessThan(
      Math.abs(pos("S2").x - pos("R1").x),
    );

    // ---- PCs and phones of S_access centered under S_access ----
    const sxAccess = pos("S_access").x;
    const accessKids = ["PC01", "PC02", "PC03", "Phone1001", "Phone1002"];
    const accessAvg = accessKids
      .map(n => pos(n).x).reduce((a, b) => a + b, 0) / accessKids.length;
    expect(Math.abs(accessAvg - sxAccess)).toBeLessThan(LAYOUT.PC_X_SPACING);

    // ---- Phones of site 2 centered under S2 ----
    const s2x = pos("S2").x;
    const s2Avg = ["Phone4001", "Phone4002", "Phone4003"]
      .map(n => pos(n).x).reduce((a, b) => a + b, 0) / 3;
    expect(Math.abs(s2Avg - s2x)).toBeLessThan(LAYOUT.PC_X_SPACING);

    // ---- Server DHCP in its row, not overlapping a PC ----
    expect(pos("Server_DHCP").y).toBe(LAYOUT.Y_SERVER);
    // Must not collide (exact same X) with any S_main endpoint.
    const sMainEndpoints = ["Phone1003", "PC04", "ATA1004"];
    for (const ep of sMainEndpoints) {
      const dx = Math.abs(pos("Server_DHCP").x - pos(ep).x);
      const dy = Math.abs(pos("Server_DHCP").y - pos(ep).y);
      // Server is in a different Y band than endpoints, so same X is OK;
      // exact X+Y match is what must not occur.
      expect(dx >= 1 || dy >= 1).toBe(true);
    }

    // ---- No two devices share the exact same coordinates ----
    const occupied = new Set<string>();
    for (const d of devices) {
      const p = pos(d.name);
      const key = `${p.x},${p.y}`;
      expect(occupied.has(key)).toBe(false);
      occupied.add(key);
    }

    // ---- AnalogPhone1004 hangs under ATA, not in orphan column ----
    const ata = pos("ATA1004");
    const analog = pos("AnalogPhone1004");
    expect(analog.y).toBe(LAYOUT.Y_ENDPOINT + 60);
    expect(Math.abs(analog.x - ata.x)).toBeLessThan(2);

    // ---- Endpoints of S_access must not step on S_main ----
    // PT icons ~50px wide; with PC_X_SPACING=80 we enforce >=60px separation
    // between endpoints of sibling switches in the same Y row.
    const accessEps = ["PC01", "PC02", "PC03", "Phone1001", "Phone1002"];
    const mainEps = ["Phone1003", "PC04", "ATA1004"];
    for (const a of accessEps) for (const b of mainEps) {
      const pa = pos(a), pb = pos(b);
      if (pa.y !== pb.y) continue; // different rows, OK
      expect(Math.abs(pa.x - pb.x)).toBeGreaterThanOrEqual(60);
    }

    // ---- Idempotence: re-applying produces no new moves ----
    const moved = devices.map(d => {
      const p = pos(d.name);
      return { ...d, x: p.x, y: p.y };
    });
    const moves2 = gridLayoutCanvas(snap(moved, links));
    expect(moves2).toHaveLength(0);
  });

  test("hub-and-spoke with many endpoints (>6) splits into two rows", () => {
    // Case of "DNS-AAA-X" diagram: single central switch with 10 endpoints.
    // Width formula splits into two rows so they do not overlap.
    const devices = [
      dev("R1", "router"),
      dev("S1", "switch"),
      ...Array.from({ length: 10 }, (_, i) => dev(`H${i + 1}`, "pc")),
    ];
    const links = [
      link("R1", "S1"),
      ...Array.from({ length: 10 }, (_, i) => link("S1", `H${i + 1}`)),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const ys = Array.from({ length: 10 }, (_, i) =>
      moves.find(m => m.name === `H${i + 1}`)!.y);
    const row1 = ys.filter(y => y === LAYOUT.Y_ENDPOINT).length;
    const row2 = ys.filter(y => y === LAYOUT.Y_ENDPOINT + 60).length;
    expect(row1).toBeGreaterThan(0);
    expect(row2).toBeGreaterThan(0);
    expect(row1 + row2).toBe(10);

    // Top row endpoints: minimum 60px separation between them.
    const xs1 = Array.from({ length: 10 }, (_, i) =>
      moves.find(m => m.name === `H${i + 1}`)!)
      .filter(m => m.y === LAYOUT.Y_ENDPOINT)
      .map(m => m.x).sort((a, b) => a - b);
    for (let i = 1; i < xs1.length; i++) {
      expect(xs1[i]! - xs1[i - 1]!).toBeGreaterThanOrEqual(60);
    }
  });

  test("5-router mesh (R3-R5, R3-R6, R5-R6, R5-R4, R4-R2): all in router row", () => {
    // Triangular mesh R3-R5-R6 + R5-R4-R2. Not a linear chain —
    // the router-router graph contains cycles. Layout must keep
    // all routers at Y_ROUTER without overlapping.
    const devices = [
      dev("R2", "router"), dev("R3", "router"),
      dev("R4", "router"), dev("R5", "router"), dev("R6", "router"),
      dev("S1", "switch"),
      dev("PC1", "pc"), dev("PC2", "pc"), dev("PC3", "pc"),
      dev("PC4", "pc"), dev("PC5", "pc"), dev("PC6", "pc"),
      dev("ServerR5", "server"),
    ];
    const links = [
      link("R3", "R5"), link("R3", "R6"), link("R5", "R6"),
      link("R5", "R4"), link("R4", "R2"),
      link("R2", "S1"),
      link("S1", "PC1"), link("S1", "PC2"), link("S1", "PC3"),
      link("S1", "PC4"), link("S1", "PC5"), link("S1", "PC6"),
      link("R5", "ServerR5"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const allRouters = ["R2", "R3", "R4", "R5", "R6"];
    for (const r of allRouters) {
      const p = moves.find(m => m.name === r)!;
      expect(p.y).toBe(LAYOUT.Y_ROUTER);
    }
    // All X coordinates distinct (no collision).
    const rxs = allRouters.map(r => moves.find(m => m.name === r)!.x);
    const uniq = new Set(rxs);
    expect(uniq.size).toBe(allRouters.length);
    // ServerR5 connects directly to R5 → in Y_SERVER row, close to R5 X.
    const serverPos = moves.find(m => m.name === "ServerR5")!;
    const r5x = moves.find(m => m.name === "R5")!.x;
    expect(serverPos.y).toBe(LAYOUT.Y_SERVER);
    expect(Math.abs(serverPos.x - r5x)).toBeLessThanOrEqual(LAYOUT.SERVER_X_SPACING);
  });

  test("linear backbone 4 routers with equal loads: uniform spacing", () => {
    // "Linear chain" case: R0-R1-R2-R3 connected by serial, each with
    // switch + 2 PCs. Equal subtrees → equal spacing between consecutive routers
    // (within rounding tolerance).
    const devices: DeviceObservation[] = [];
    const links: LinkObservation[] = [];
    for (let i = 0; i < 4; i++) {
      devices.push(dev(`R${i}`, "router"));
      devices.push(dev(`Sw${i}`, "switch"));
      devices.push(dev(`PC${2 * i + 1}`, "pc"));
      devices.push(dev(`PC${2 * i + 2}`, "pc"));
      links.push(link(`R${i}`, `Sw${i}`));
      links.push(link(`Sw${i}`, `PC${2 * i + 1}`));
      links.push(link(`Sw${i}`, `PC${2 * i + 2}`));
      if (i > 0) links.push(link(`R${i - 1}`, `R${i}`));
    }
    const moves = gridLayoutCanvas(snap(devices, links));
    const xs = [0, 1, 2, 3].map(i => moves.find(m => m.name === `R${i}`)!.x);
    const gaps = [xs[1]! - xs[0]!, xs[2]! - xs[1]!, xs[3]! - xs[2]!];
    // All separations must match (equal subtrees) — 1px tolerance.
    expect(Math.abs(gaps[0]! - gaps[1]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(gaps[1]! - gaps[2]!)).toBeLessThanOrEqual(1);
    // And PCs of each switch are centered under that switch.
    for (let i = 0; i < 4; i++) {
      const swx = moves.find(m => m.name === `Sw${i}`)!.x;
      const pc1x = moves.find(m => m.name === `PC${2 * i + 1}`)!.x;
      const pc2x = moves.find(m => m.name === `PC${2 * i + 2}`)!.x;
      expect(Math.abs((pc1x + pc2x) / 2 - swx)).toBeLessThan(2);
    }
  });

  test("cloud connected to switch (not router) travels with switch", () => {
    // Common case: "Internet/Other networks" cloud hanging off distribution switch
    // (not router). Must end up in a cloud band aligned with parent switch.
    const devices = [
      dev("R1", "router"),
      dev("S1", "switch"),
      dev("Internet", "cloud"),
      dev("PC1", "pc"),
    ];
    const links = [
      link("R1", "S1"), link("S1", "Internet"), link("S1", "PC1"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const cloud = moves.find(m => m.name === "Internet")!;
    expect([LAYOUT.Y_CLOUD, LAYOUT.Y_CLOUD_BOTTOM]).toContain(cloud.y);
  });

  test("degenerate topology: PCs only, no router or switch — does not crash", () => {
    const devices = [dev("PC1", "pc"), dev("PC2", "pc")];
    const moves = gridLayoutCanvas(snap(devices, []));
    // Both placed in endpoint band.
    expect(moves).toHaveLength(2);
    for (const m of moves) expect(m.y).toBe(LAYOUT.Y_ENDPOINT);
    expect(moves[0]!.x).not.toBe(moves[1]!.x);
  });

  test("empty topology: zero moves, does not crash", () => {
    const moves = gridLayoutCanvas(snap([], []));
    expect(moves).toHaveLength(0);
  });

  test("chained endpoint (analog phone after ATA) hangs UNDER ATA", () => {
    // Analog phone (1004) connects to Home-VoIP-PT (ATA), not switch.
    // Must be placed in sub-row Y_ENDPOINT + 60 with the ATA's X.
    const devices = [
      dev("R1", "router"),
      dev("S1", "switch"),
      dev("PC1", "pc"),
      dev("ATA", "iot"),
      dev("AnalogPhone", "tdm"),
    ];
    const links = [
      link("R1", "S1"), link("S1", "PC1"), link("S1", "ATA"),
      link("ATA", "AnalogPhone"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const ata = moves.find(m => m.name === "ATA")!;
    const ap = moves.find(m => m.name === "AnalogPhone")!;
    // In sub-row +60 with ATA X.
    expect(ap.y).toBe(LAYOUT.Y_ENDPOINT + 60);
    expect(Math.abs(ap.x - ata.x)).toBeLessThan(2);
    // Must not be in orphan lateral column (reasonable X, < 1000).
    expect(ap.x).toBeLessThan(1000);
  });

  test("RO2-P1: transit router (RInternet) drops to second tier between R2 and R3", () => {
    // Replica of RO2-P1 lab (routing + GRE + NAT). 4 office routers (R1-R4)
    // connected via two transit switches (LAN3 R1↔R2, LAN4 R3↔R4) and an exterior
    // router RInternet connecting R2 and R3 via serial and hosting a web server.
    // RInternet must sit OUTSIDE the office router row on a second tier centered
    // between R2 and R3.
    const devices = [
      // Office backbone
      dev("R1", "router"),
      dev("R2", "router"),
      dev("R3", "router"),
      dev("R4", "router"),
      // Exterior router — the "Internet"
      dev("RInternet", "router"),
      // Office LAN switches
      dev("SW1", "switch"),
      dev("SW2", "switch"),
      dev("SW5", "switch"),
      dev("SW6", "switch"),
      // Transit switches (LAN3 R1<->R2, LAN4 R3<->R4)
      dev("SW3", "switch"),
      dev("SW4", "switch"),
      // Exterior network switch
      dev("SWInternet", "switch"),
      // Office LAN PCs
      dev("PC1", "pc"),
      dev("PC2", "pc"),
      dev("PC5", "pc"),
      dev("PC6", "pc"),
      // Web server on exterior network
      dev("WebServer", "server"),
    ];
    const links = [
      // LANs of R1
      link("R1", "SW1"), link("SW1", "PC1"),
      link("R1", "SW2"), link("SW2", "PC2"),
      // LAN3 transit between R1 and R2
      link("R1", "SW3"), link("R2", "SW3"),
      // Serials R2<->RInternet and R3<->RInternet
      link("R2", "RInternet"), link("R3", "RInternet"),
      // LAN4 transit between R3 and R4
      link("R3", "SW4"), link("R4", "SW4"),
      // LANs of R4
      link("R4", "SW5"), link("SW5", "PC5"),
      link("R4", "SW6"), link("SW6", "PC6"),
      // Exterior network
      link("RInternet", "SWInternet"), link("SWInternet", "WebServer"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const pos = (n: string) => placedAt(moves, n)!;

    // ---- Office backbone in Y_ROUTER row ----
    for (const r of ["R1", "R2", "R3", "R4"]) {
      expect(pos(r).y).toBe(LAYOUT.Y_ROUTER);
    }
    // RInternet moves down to second tier.
    expect(pos("RInternet").y).toBe(LAYOUT.Y_TRANSIT_ROUTER);

    // ---- Backbone ordered from left to right ----
    expect(pos("R1").x).toBeLessThan(pos("R2").x);
    expect(pos("R2").x).toBeLessThan(pos("R3").x);
    expect(pos("R3").x).toBeLessThan(pos("R4").x);

    // ---- RInternet centered between R2 and R3 (2px tolerance) ----
    const mid23 = (pos("R2").x + pos("R3").x) / 2;
    expect(Math.abs(pos("RInternet").x - mid23)).toBeLessThan(2);

    // ---- Subtree of RInternet inherits transit bands ----
    expect(pos("SWInternet").y).toBe(LAYOUT.Y_TRANSIT_SWITCH);
    expect(pos("WebServer").y).toBe(LAYOUT.Y_TRANSIT_SERVER);
    // And all centered with RInternet.
    expect(Math.abs(pos("SWInternet").x - pos("RInternet").x)).toBeLessThan(2);
    expect(Math.abs(pos("WebServer").x - pos("RInternet").x)).toBeLessThan(2);

    // ---- LAN3 (SW3) and LAN4 (SW4) are transit and center between their routers ----
    // Existing logic handles them via sharedBetween — verify it remains OK.
    expect(pos("SW3").y).toBe(LAYOUT.Y_SWITCH);
    expect(pos("SW4").y).toBe(LAYOUT.Y_SWITCH);
    const mid12 = (pos("R1").x + pos("R2").x) / 2;
    const mid34 = (pos("R3").x + pos("R4").x) / 2;
    expect(Math.abs(pos("SW3").x - mid12)).toBeLessThan(2);
    expect(Math.abs(pos("SW4").x - mid34)).toBeLessThan(2);

    // ---- Idempotence ----
    const moved = devices.map(d => {
      const p = pos(d.name);
      return { ...d, x: p.x, y: p.y };
    });
    const moves2 = gridLayoutCanvas(snap(moved, links));
    expect(moves2).toHaveLength(0);
  });

  test("deep chained endpoint (PC after phone after ATA)", () => {
    // ATA → IPPhone → PC. Two child generations must be placed:
    // IPPhone directly under ATA; PC directly under IPPhone.
    const devices = [
      dev("R1", "router"),
      dev("S1", "switch"),
      dev("ATA", "iot"),
      dev("IPPhone", "ipphone"),
      dev("PC", "pc"),
    ];
    const links = [
      link("R1", "S1"), link("S1", "ATA"),
      link("ATA", "IPPhone"), link("IPPhone", "PC"),
    ];
    const moves = gridLayoutCanvas(snap(devices, links));
    const ata = moves.find(m => m.name === "ATA")!;
    const phone = moves.find(m => m.name === "IPPhone")!;
    const pc = moves.find(m => m.name === "PC")!;
    expect(phone.y).toBeGreaterThan(ata.y);
    expect(pc.y).toBeGreaterThan(phone.y);
    // Each child reasonably aligned with parent.
    expect(Math.abs(phone.x - ata.x)).toBeLessThan(LAYOUT.PC_X_SPACING);
    expect(Math.abs(pc.x - phone.x)).toBeLessThan(LAYOUT.PC_X_SPACING);
  });
});
