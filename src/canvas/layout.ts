/**
 * Layout policy for the live PT canvas — v2 (subtree-width tree layout).
 *
 * Single source of truth for X/Y coordinates:
 *   1. Recipes do not invent magic numbers independently.
 *   2. `pt_add_device` can auto-place when caller leaves x/y blank.
 *   3. `pt_auto_layout` neatly rearranges an existing canvas in bulk.
 *
 * # Why v2
 *
 * v1 mechanically reproduced the Python prototype grid: clouds
 * all in the top row, switches centered in the router's column,
 * endpoints centered in the switch's column. That collapsed when a
 * router had multiple switches (they fell in the same column) and when there
 * were more than three clouds (the top banner overflowed and stepped on
 * routers). v2 is topology-aware: each router reserves the width that its
 * subtree actually needs and children are distributed within that budget.
 *
 * # Algorithm
 *
 *   1. Adjacency from `snapshot.links`.
 *   2. Backbone — BFS traversal of routers following router↔router links,
 *      starting from the leftmost router in current X. Preserves the
 *      visual order that the user already had.
 *   3. For each router, classify non-router neighbors into:
 *        - switches (each with its own endpoint subtree)
 *        - access points (band immediately above the router)
 *        - clouds (half above, half below, alternating)
 *        - direct endpoints (when a PC connects to router without a switch)
 *        - servers
 *   4. Calculate subtreeWidth(router) = units of PC_X_SPACING needed by its
 *      subtree = max(1, direct_endpoints, switches × switch_width,
 *      clouds_below). Each switch in turn contributes width proportional to
 *      its endpoints.
 *   5. Place routers horizontally distributing the width budget —
 *      the center of each router is at `cursor + width/2`, the next
 *      begins at `cursor + width + GAP`.
 *   6. Place children within the router's slot:
 *        - APs above router, centered.
 *        - Switches below router, distributed according to their widths.
 *        - Endpoints of each switch, centered under switch (second row
 *          if they saturate available width).
 *        - Endpoints directly on router, in endpoints row.
 *        - Clouds: first half above (Y_CLOUD), rest below (Y_CLOUD_BOTTOM) —
 *          replicating the reference pattern where each router has LANs above and below.
 *        - Servers: right of parent switch, or lateral column if none.
 *   7. Nodes shared between two routers (e.g. Internet cloud between R2 and
 *      R3): centered between the routers sharing them.
 *   8. Orphans (no path to any router): maintain category band but go to a
 *      free column on the far right.
 *
 * Idempotent: coordinates rounded to integer, stable sort by name within each
 * group, so running `pt_auto_layout` twice on the same canvas produces no
 * secondary moves.
 *
 * Y bands by category:
 *   cloud_top    y =  20  ("top" clouds)
 *   router       y = 100
 *   ap / wlc     y = 175
 *   switch       y = 250
 *   endpoint     y = 400  (pc / laptop / phone / printer / iot / ...)
 *   server       y = 480
 *   cloud_bottom y = 560  ("bottom" clouds — second half, second row)
 *
 * # Transit routers (second tier)
 *
 * A router whose sole topological function is BRIDGING other routers
 * (RInternet between R2 and R3, ISP between two branches, etc.) should not
 * occupy a slot in the main router row — visually it sits outside the
 * office hierarchy and forces cables that criss-cross the screen.
 *
 * These are detected via `isTransitRouter` and placed on a second tier
 * with their own shifted Y bands. Their X is computed as the average center
 * of the backbone routers they connect to, falling neatly "between" neighbors.
 *
 *   transit_router    y = 400
 *   transit_switch    y = 530
 *   transit_endpoint  y = 680
 *   transit_server    y = 760
 *
 * The transit router's subtree (private switch + typical WebServer)
 * uses those bands instead of backbone bands.
 */

import type { DeviceCategory } from "../ipc/constants.js";
import type { CanvasSnapshot, DeviceObservation } from "./types.js";

export const LAYOUT = {
  X_START: 100,
  X_SPACING: 250,
  PC_X_SPACING: 80,
  Y_CLOUD: 20,
  Y_ROUTER: 100,
  Y_AP: 175,
  Y_SWITCH: 250,
  Y_ENDPOINT: 400,
  Y_SERVER: 480,
  Y_CLOUD_BOTTOM: 560,
  // Second tier for transit routers and their subtree (see module doc).
  Y_TRANSIT_ROUTER: 400,
  Y_TRANSIT_AP: 475,
  Y_TRANSIT_SWITCH: 530,
  Y_TRANSIT_ENDPOINT: 680,
  Y_TRANSIT_SERVER: 760,
  Y_TRANSIT_CLOUD_TOP: 320,
  Y_TRANSIT_CLOUD_BOTTOM: 840,
  ROUTER_GAP: 80,
  SWITCH_X_SPACING: 130,
  CLOUD_X_SPACING: 110,
  SERVER_X_SPACING: 110,
  AP_X_SPACING: 110,
} as const;

/** Y bands according to tier (backbone vs transit). The algorithm queries
 *  `bandsFor(routerName)` to pick the proper row for each child based on
 *  the parent router tier. */
interface YBands {
  readonly ap: number;
  readonly switch: number;
  readonly endpoint: number;
  readonly server: number;
  readonly cloudTop: number;
  readonly cloudBottom: number;
}
const BACKBONE_BANDS: YBands = {
  ap: LAYOUT.Y_AP,
  switch: LAYOUT.Y_SWITCH,
  endpoint: LAYOUT.Y_ENDPOINT,
  server: LAYOUT.Y_SERVER,
  cloudTop: LAYOUT.Y_CLOUD,
  cloudBottom: LAYOUT.Y_CLOUD_BOTTOM,
};
const TRANSIT_BANDS: YBands = {
  ap: LAYOUT.Y_TRANSIT_AP,
  switch: LAYOUT.Y_TRANSIT_SWITCH,
  endpoint: LAYOUT.Y_TRANSIT_ENDPOINT,
  server: LAYOUT.Y_TRANSIT_SERVER,
  cloudTop: LAYOUT.Y_TRANSIT_CLOUD_TOP,
  cloudBottom: LAYOUT.Y_TRANSIT_CLOUD_BOTTOM,
};

const ENDPOINT_CATEGORIES = new Set<DeviceCategory>([
  "pc", "laptop", "ipphone", "smartphone", "tablet", "pda",
  "tv", "printer", "iot", "tdm", "remote",
]);

/** Y band for a given catalog category. Endpoints share Y_ENDPOINT. */
export function categoryRow(category: DeviceCategory): number {
  if (category === "cloud") return LAYOUT.Y_CLOUD;
  if (category === "router" || category === "wirelessrouter" || category === "homerouter" || category === "firewall") {
    return LAYOUT.Y_ROUTER;
  }
  if (category === "accesspoint") return LAYOUT.Y_AP;
  if (category === "switch" || category === "multilayerswitch" || category === "bridge" || category === "hub" || category === "repeater") {
    return LAYOUT.Y_SWITCH;
  }
  if (category === "server") return LAYOUT.Y_SERVER;
  if (ENDPOINT_CATEGORIES.has(category)) return LAYOUT.Y_ENDPOINT;
  return LAYOUT.Y_ENDPOINT;
}

export interface PlacementSlot {
  readonly x: number;
  readonly y: number;
}

/**
 * Pick a free slot for a brand-new device of `category` given the current live
 * canvas. Strategy:
 *   1. Look at every device of the same category already placed.
 *   2. Drop the candidate column at `max(existingX) + X_SPACING` in that row,
 *      or at X_START if the row is empty.
 *
 * That matches the visual result of `pt_cook_topology` recipes (rows that
 * grow rightwards) and is enough to keep manual `pt_add_device` calls tidy.
 */
export function nextSlotForCategory(
  snapshot: CanvasSnapshot,
  category: DeviceCategory,
): PlacementSlot {
  const y = categoryRow(category);
  const sameRow = snapshot.devices.filter(d => Math.abs(d.y - y) < 30);
  if (sameRow.length === 0) {
    return { x: LAYOUT.X_START, y };
  }
  const maxX = sameRow.reduce((m, d) => (d.x > m ? d.x : m), -Infinity);
  return { x: maxX + LAYOUT.X_SPACING, y };
}

// ---------------------------------------------------------------------------
// gridLayoutCanvas — full implementation below
// ---------------------------------------------------------------------------

const ROUTERY = (cat?: DeviceCategory) =>
  cat === "router" || cat === "wirelessrouter" || cat === "homerouter" || cat === "firewall";
const SWITCHY = (cat?: DeviceCategory) =>
  cat === "switch" || cat === "multilayerswitch" || cat === "bridge" || cat === "hub" || cat === "repeater";
const ENDPOINTY = (cat?: DeviceCategory) =>
  cat != null && ENDPOINT_CATEGORIES.has(cat);

/** Minimum logical width (in PC_X_SPACING units) required by a switch.
 *  With N endpoints in a row (PC_X_SPACING = 80px), N units are required
 *  + 0.4 margin so the next switch doesn't step on the last endpoint.
 *  With 7+ endpoints we split into two rows (Y_ENDPOINT and +60), so width
 *  drops to ceil(N/2). */
function switchWidthUnits(endpointCount: number): number {
  if (endpointCount <= 1) return 1.4;
  if (endpointCount <= 6) return endpointCount + 0.4;
  return Math.ceil(endpointCount / 2) + 0.4;
}

/** Minimum logical width required by a router based on its children. */
function routerWidthUnits(args: {
  switchWidths: number[];
  directEndpoints: number;
  clouds: number;
  servers: number;
  aps: number;
}): number {
  const { switchWidths, directEndpoints, clouds, servers, aps } = args;
  const sw = switchWidths.reduce((a, b) => a + b, 0)
    + Math.max(0, switchWidths.length - 1) * 0.2;
  const direct = directEndpoints * 0.9;
  const top = Math.max(aps * 1.0, Math.ceil(clouds / 2) * 1.2);
  const bottom = Math.max(servers * 1.0, Math.floor(clouds / 2) * 1.2);
  return Math.max(2.0, sw, direct, top, bottom);
}

/** Distribute N items symmetrically around cx with spacing `spacing`. */
function spreadAround(cx: number, count: number, spacing: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [cx];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(cx + (i - (count - 1) / 2) * spacing);
  }
  return out;
}

/**
 * Compute a topology-aware grid layout for an entire canvas. See module-level
 * doc for the algorithm.
 *
 * Returns one entry per device whose coordinates differ from the snapshot;
 * unchanged devices are omitted so `pt_auto_layout` issues a minimal set of
 * `moveDevice` calls.
 */
export function gridLayoutCanvas(snapshot: CanvasSnapshot): readonly { name: string; x: number; y: number }[] {
  // ---------------- Adjacency ----------------
  const neighbors = new Map<string, Set<string>>();
  for (const link of snapshot.links) {
    if (!neighbors.has(link.aDevice)) neighbors.set(link.aDevice, new Set());
    if (!neighbors.has(link.bDevice)) neighbors.set(link.bDevice, new Set());
    neighbors.get(link.aDevice)!.add(link.bDevice);
    neighbors.get(link.bDevice)!.add(link.aDevice);
  }
  const byName = new Map(snapshot.devices.map(d => [d.name, d]));
  const neighborsOf = (name: string): DeviceObservation[] =>
    [...(neighbors.get(name) ?? [])]
      .map(n => byName.get(n))
      .filter((x): x is DeviceObservation => !!x);

  const placements = new Map<string, { x: number; y: number }>();

  // ---------------- Backbone ordering ----------------
  // Preserve user's visual order: sort by current X, tie-break by name.
  // This covers the two common cases:
  //   (a) cooked topology with coordinates: X order is already correct;
  //   (b) unplaced topology (equal X): name tie-break usually matches
  //       the chain order (R1-R2-R3-...).
  // A BFS over the router-router graph would disorder (b) if it starts
  // at a middle router, so we omit BFS here.
  const routers = snapshot.devices.filter(d => ROUTERY(d.category));
  const routerSet = new Set(routers.map(r => r.name));
  const routerOrder = [...routers].sort((a, b) =>
    a.x !== b.x ? a.x - b.x : a.name.localeCompare(b.name));

  // ---------------- Classify children per router ----------------
  // Each non-router device is assigned to the "closest router" (direct router
  // neighbor if present; otherwise neighbor-of-neighbor via switch). Nodes
  // touching 2+ routers are marked as "shared" and placed in between.
  type RouterChildren = {
    switches: DeviceObservation[];        // directly connected switches
    aps: DeviceObservation[];             // access points
    clouds: DeviceObservation[];          // dedicated clouds (this router only)
    directEndpoints: DeviceObservation[]; // endpoints without intermediate switch
    servers: DeviceObservation[];         // servers connected to router (not via switch)
  };
  const children = new Map<string, RouterChildren>();
  for (const r of routers) {
    children.set(r.name, {
      switches: [], aps: [], clouds: [], directEndpoints: [], servers: [],
    });
  }

  // shared[node] = list of routers sharing it (when >= 2)
  const sharedBetween = new Map<string, string[]>();
  // switchEndpoints[switchName] = endpoints connected to switch
  const switchEndpoints = new Map<string, DeviceObservation[]>();
  // switchServers[switchName] = servers behind switch
  const switchServers = new Map<string, DeviceObservation[]>();
  // switchOwner[switchName] = router it belongs to (if unique)
  const switchOwner = new Map<string, string>();
  // assigned: devices already assigned to a router hierarchy
  const assigned = new Set<string>(routers.map(r => r.name));
  // dangling[parent] = chained endpoints attached to another endpoint
  // already assigned (typical: analog phone hanging off Home-VoIP-PT,
  // or PC plugged into IP Phone passthrough port). Placed in a sub-row
  // directly under parent without adding width to the switch subtree.
  const danglingByParent = new Map<string, DeviceObservation[]>();

  // 1st pass: switches (determine parent router). Iterative because switches
  // can be cascaded via trunks (access switch connects only to distribution switch,
  // which connects to router). Round 1 resolves direct router neighbors; subsequent
  // rounds propagate ownership downstream along trunks.
  const allSwitches = snapshot.devices.filter(d => SWITCHY(d.category));
  const pendingSwitches = new Set(allSwitches.map(s => s.name));
  let switchProgress = true;
  while (switchProgress && pendingSwitches.size > 0) {
    switchProgress = false;
    for (const swName of [...pendingSwitches]) {
      const sw = byName.get(swName)!;
      const adj = neighborsOf(swName);
      const adjRouters = adj.filter(n => routerSet.has(n.name));
      if (adjRouters.length >= 2) {
        sharedBetween.set(swName, adjRouters.map(r => r.name));
        pendingSwitches.delete(swName);
        switchProgress = true;
        continue;
      }
      if (adjRouters.length === 1) {
        const owner = adjRouters[0]!;
        switchOwner.set(swName, owner.name);
        children.get(owner.name)!.switches.push(sw);
        assigned.add(swName);
        pendingSwitches.delete(swName);
        switchProgress = true;
        continue;
      }
      // Without direct router: reachable via an already resolved switch?
      const adjResolved = adj
        .filter(n => SWITCHY(n.category) && switchOwner.has(n.name));
      if (adjResolved.length > 0) {
        const ownerRouter = switchOwner.get(adjResolved[0]!.name)!;
        switchOwner.set(swName, ownerRouter);
        children.get(ownerRouter)!.switches.push(sw);
        assigned.add(swName);
        pendingSwitches.delete(swName);
        switchProgress = true;
      }
    }
  }

  // 2nd pass: endpoints/servers/clouds/aps.
  for (const d of snapshot.devices) {
    if (assigned.has(d.name)) continue;
    if (ROUTERY(d.category) || SWITCHY(d.category)) continue;
    const adj = neighborsOf(d.name);
    const adjRouters = adj.filter(n => routerSet.has(n.name));
    const adjSwitches = adj.filter(n => SWITCHY(n.category) && switchOwner.has(n.name));

    // Shared between 2+ routers (e.g. "Internet between R2 and R3").
    if (adjRouters.length >= 2) {
      sharedBetween.set(d.name, adjRouters.map(r => r.name));
      assigned.add(d.name);
      continue;
    }

    // Behind a switch that already has an owner.
    if (adjSwitches.length > 0) {
      const sw = adjSwitches[0]!;
      if (d.category === "server") {
        if (!switchServers.has(sw.name)) switchServers.set(sw.name, []);
        switchServers.get(sw.name)!.push(d);
      } else if (ENDPOINTY(d.category)) {
        if (!switchEndpoints.has(sw.name)) switchEndpoints.set(sw.name, []);
        switchEndpoints.get(sw.name)!.push(d);
      } else if (d.category === "accesspoint") {
        // AP behind switch: attach to switch's router as AP.
        const ownerRouter = switchOwner.get(sw.name);
        if (ownerRouter) children.get(ownerRouter)!.aps.push(d);
      } else if (d.category === "cloud") {
        const ownerRouter = switchOwner.get(sw.name);
        if (ownerRouter) children.get(ownerRouter)!.clouds.push(d);
      }
      assigned.add(d.name);
      continue;
    }

    // Directly connected to a single router.
    if (adjRouters.length === 1) {
      const owner = adjRouters[0]!.name;
      const bucket = children.get(owner)!;
      if (d.category === "accesspoint") bucket.aps.push(d);
      else if (d.category === "cloud") bucket.clouds.push(d);
      else if (d.category === "server") bucket.servers.push(d);
      else if (ENDPOINTY(d.category)) bucket.directEndpoints.push(d);
      assigned.add(d.name);
      continue;
    }
    // Otherwise remains as orphan.
  }

  // 3rd pass (iterative): chained endpoints — attached to another endpoint
  // already assigned to a switch or router. Left as "dangling" from the parent
  // and placed in sub-row Y_ENDPOINT + 60 at the end.
  let danglingProgress = true;
  while (danglingProgress) {
    danglingProgress = false;
    for (const d of snapshot.devices) {
      if (assigned.has(d.name)) continue;
      if (ROUTERY(d.category) || SWITCHY(d.category)) continue;
      const adj = neighborsOf(d.name);
      // Look for a neighbor that is an already assigned endpoint (not router/switch).
      const parent = adj.find(n =>
        assigned.has(n.name) && !ROUTERY(n.category) && !SWITCHY(n.category));
      if (!parent) continue;
      if (!danglingByParent.has(parent.name)) danglingByParent.set(parent.name, []);
      danglingByParent.get(parent.name)!.push(d);
      assigned.add(d.name);
      danglingProgress = true;
    }
  }

  // ---------------- Transit router detection ----------------
  // A router is considered "transit" when its sole topological purpose is to
  // bridge OTHER routers that do not see each other directly, and its own
  // subtree contains no user LAN (PCs/phones/APs/clouds), only at most
  // a switch with servers. Canonical case: RInternet between R2 and R3
  // in a WAN with NAT/GRE; ISP router between two branches.
  //
  // Visually it moves down to a second tier (Y_TRANSIT_*) so it doesn't break
  // the orderly row of office routers. Mesh topologies are excluded
  // (neighbors are interconnected, condition 2 fails) and topologies with
  // PCs/APs hanging off the transit router itself are disqualified (the transit LAN
  // makes it a regular site).
  const transitRouters = new Set<string>();
  const isTransit = (r: DeviceObservation): boolean => {
    const adj = neighbors.get(r.name);
    if (!adj) return false;
    const adjRouters = [...adj].filter(n => routerSet.has(n));
    if (adjRouters.length < 2) return false;
    // No pair of direct router neighbors can see each other. If even one pair
    // is directly cabled, it is a mesh, not a bridge.
    for (let i = 0; i < adjRouters.length; i++) {
      for (let j = i + 1; j < adjRouters.length; j++) {
        if (neighbors.get(adjRouters[i]!)?.has(adjRouters[j]!)) return false;
      }
    }
    const c = children.get(r.name)!;
    // No direct user LAN (PCs, phones, etc.).
    if (c.directEndpoints.length > 0) return false;
    if (c.aps.length > 0) return false;
    if (c.clouds.length > 0) return false;
    // Nor via dedicated switch.
    for (const sw of c.switches) {
      const eps = switchEndpoints.get(sw.name) ?? [];
      if (eps.length > 0) return false;
    }
    // And has at least one child (otherwise it is a pure relay and lives
    // fine in backbone aligned with its neighbors without shifting down).
    const total = c.switches.length + c.servers.length + c.directEndpoints.length
      + c.aps.length + c.clouds.length;
    if (total === 0) return false;
    return true;
  };
  for (const r of routers) {
    if (isTransit(r)) transitRouters.add(r.name);
  }
  const bandsFor = (routerName: string): YBands =>
    transitRouters.has(routerName) ? TRANSIT_BANDS : BACKBONE_BANDS;

  // ---------------- Subtree widths ----------------
  const switchWidthFor = (sw: DeviceObservation): number => {
    const eps = switchEndpoints.get(sw.name)?.length ?? 0;
    const srv = switchServers.get(sw.name)?.length ?? 0;
    return switchWidthUnits(Math.max(eps, srv));
  };
  const routerWidth = new Map<string, number>();
  for (const r of routerOrder) {
    const c = children.get(r.name)!;
    routerWidth.set(r.name, routerWidthUnits({
      switchWidths: c.switches.map(switchWidthFor),
      directEndpoints: c.directEndpoints.length,
      clouds: c.clouds.length,
      servers: c.servers.length,
      aps: c.aps.length,
    }));
  }

  // ---------------- Position routers ----------------
  // The center of each backbone router falls at `cursor + width*PC_X_SPACING/2`.
  // Transit routers do NOT consume horizontal slot; they are placed in a
  // second pass at the average center of their backbone neighbors.
  const routerCenter = new Map<string, number>();
  let cursor = LAYOUT.X_START;
  for (const r of routerOrder) {
    if (transitRouters.has(r.name)) continue;
    const w = routerWidth.get(r.name)! * LAYOUT.PC_X_SPACING;
    const cx = cursor + w / 2;
    placements.set(r.name, { x: cx, y: LAYOUT.Y_ROUTER });
    routerCenter.set(r.name, cx);
    cursor = cursor + w + LAYOUT.ROUTER_GAP;
  }
  // Transits: x = average center of backbone neighbors, y = Y_TRANSIT_ROUTER.
  // If two transits share the same backbone pair (rare but possible: two
  // parallel ISPs), they are shifted +/- CLOUD_X_SPACING so they do not collide.
  const transitOrder = routerOrder.filter(r => transitRouters.has(r.name));
  const transitGroups = new Map<string, DeviceObservation[]>();
  for (const r of transitOrder) {
    const adj = [...(neighbors.get(r.name) ?? [])];
    const adjBackbone = adj
      .filter(n => routerSet.has(n) && !transitRouters.has(n))
      .sort();
    const key = adjBackbone.join("|");
    if (!transitGroups.has(key)) transitGroups.set(key, []);
    transitGroups.get(key)!.push(r);
  }
  for (const [key, members] of transitGroups) {
    const adjCenters = key.split("|")
      .map(n => routerCenter.get(n))
      .filter((v): v is number => v != null);
    let cx: number;
    if (adjCenters.length > 0) {
      cx = adjCenters.reduce((a, b) => a + b, 0) / adjCenters.length;
    } else {
      // Degenerate case: transit without resolvable backbone neighbor.
      // Placed to the right of cursor — remains ordered without collisions.
      cx = cursor + LAYOUT.X_SPACING;
      cursor += LAYOUT.X_SPACING;
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    const xs = spreadAround(cx, members.length, LAYOUT.CLOUD_X_SPACING);
    members.forEach((r, i) => {
      placements.set(r.name, { x: xs[i]!, y: LAYOUT.Y_TRANSIT_ROUTER });
      routerCenter.set(r.name, xs[i]!);
    });
  }

  // ---------------- Position shared nodes (between routers) ----------------
  // Centered at the average center of the routers sharing them.
  // Y depends on category (cloud → CLOUD_BOTTOM, server → SERVER, switch → SWITCH).
  const sharedY = (cat?: DeviceCategory): number => {
    if (cat === "cloud") return LAYOUT.Y_CLOUD_BOTTOM;
    if (cat === "server") return LAYOUT.Y_SERVER;
    if (SWITCHY(cat)) return LAYOUT.Y_SWITCH;
    if (cat === "accesspoint") return LAYOUT.Y_AP;
    if (ENDPOINTY(cat)) return LAYOUT.Y_ENDPOINT;
    return LAYOUT.Y_CLOUD_BOTTOM;
  };
  // Group shared by router-pair to avoid horizontal overlapping.
  const sharedGroups = new Map<string, string[]>(); // key = "r1|r2" sorted
  for (const [node, rs] of sharedBetween) {
    const key = [...rs].sort().join("|");
    if (!sharedGroups.has(key)) sharedGroups.set(key, []);
    sharedGroups.get(key)!.push(node);
  }
  for (const [key, nodes] of sharedGroups) {
    const rs = key.split("|");
    const cxs = rs.map(n => routerCenter.get(n)).filter((v): v is number => v != null);
    if (cxs.length === 0) continue;
    const cx = cxs.reduce((a, b) => a + b, 0) / cxs.length;
    // If several nodes are shared by the same pair, spread symmetrically.
    nodes.sort((a, b) => a.localeCompare(b));
    nodes.forEach((n, i) => {
      const dev = byName.get(n);
      if (!dev) return;
      const xs = spreadAround(cx, nodes.length, LAYOUT.CLOUD_X_SPACING);
      placements.set(n, { x: xs[i]!, y: sharedY(dev.category) });
    });
  }

  // ---------------- Position children per router ----------------
  // Each router queries `bandsFor(name)` — backbone or transit — so its
  // children inherit the corresponding Y row for the parent's tier.
  for (const r of routerOrder) {
    const c = children.get(r.name)!;
    const rcx = routerCenter.get(r.name)!;
    const bands = bandsFor(r.name);

    // ---- APs above router ----
    {
      const aps = [...c.aps].sort((a, b) => a.name.localeCompare(b.name));
      const xs = spreadAround(rcx, aps.length, LAYOUT.AP_X_SPACING);
      aps.forEach((d, i) => placements.set(d.name, { x: xs[i]!, y: bands.ap }));
    }

    // ---- Clouds: half above, half below ----
    {
      const cls = [...c.clouds].sort((a, b) => a.name.localeCompare(b.name));
      const halfTop = Math.ceil(cls.length / 2);
      const top = cls.slice(0, halfTop);
      const bottom = cls.slice(halfTop);
      const topXs = spreadAround(rcx, top.length, LAYOUT.CLOUD_X_SPACING);
      const botXs = spreadAround(rcx, bottom.length, LAYOUT.CLOUD_X_SPACING);
      top.forEach((d, i) => placements.set(d.name, { x: topXs[i]!, y: bands.cloudTop }));
      bottom.forEach((d, i) => placements.set(d.name, { x: botXs[i]!, y: bands.cloudBottom }));
    }

    // ---- Switches below router, distributed by their widths ----
    const switchCenter = new Map<string, number>();
    {
      const sws = [...c.switches].sort((a, b) => a.name.localeCompare(b.name));
      if (sws.length > 0) {
        const widths = sws.map(switchWidthFor);
        const total = widths.reduce((a, b) => a + b, 0)
          + Math.max(0, sws.length - 1) * 0.2;
        let xCursor = rcx - (total * LAYOUT.PC_X_SPACING) / 2;
        sws.forEach((sw, i) => {
          const wPx = widths[i]! * LAYOUT.PC_X_SPACING;
          const cx = xCursor + wPx / 2;
          placements.set(sw.name, { x: cx, y: bands.switch });
          switchCenter.set(sw.name, cx);
          xCursor = xCursor + wPx + 0.2 * LAYOUT.PC_X_SPACING;
        });
      }
    }

    // ---- Endpoints for each switch, centered under switch ----
    for (const sw of c.switches) {
      const eps = [...(switchEndpoints.get(sw.name) ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name));
      const cx = switchCenter.get(sw.name)!;
      // If > 6 endpoints, split into two rows (second row + 60px).
      if (eps.length <= 6) {
        const xs = spreadAround(cx, eps.length, LAYOUT.PC_X_SPACING);
        eps.forEach((d, i) => placements.set(d.name, { x: xs[i]!, y: bands.endpoint }));
      } else {
        const half = Math.ceil(eps.length / 2);
        const row1 = eps.slice(0, half);
        const row2 = eps.slice(half);
        const xs1 = spreadAround(cx, row1.length, LAYOUT.PC_X_SPACING);
        const xs2 = spreadAround(cx, row2.length, LAYOUT.PC_X_SPACING);
        row1.forEach((d, i) => placements.set(d.name, { x: xs1[i]!, y: bands.endpoint }));
        row2.forEach((d, i) => placements.set(d.name, { x: xs2[i]!, y: bands.endpoint + 60 }));
      }
      // Servers behind switch: bands.server row, centered.
      const srv = [...(switchServers.get(sw.name) ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name));
      const sxs = spreadAround(cx, srv.length, LAYOUT.SERVER_X_SPACING);
      srv.forEach((d, i) => placements.set(d.name, { x: sxs[i]!, y: bands.server }));
    }

    // ---- Endpoints directly connected to router (without intermediate switch) ----
    {
      const ep = [...c.directEndpoints].sort((a, b) => a.name.localeCompare(b.name));
      const xs = spreadAround(rcx, ep.length, LAYOUT.PC_X_SPACING);
      ep.forEach((d, i) => placements.set(d.name, { x: xs[i]!, y: bands.endpoint }));
    }

    // ---- Servers directly connected to router ----
    {
      const sv = [...c.servers].sort((a, b) => a.name.localeCompare(b.name));
      const xs = spreadAround(rcx, sv.length, LAYOUT.SERVER_X_SPACING);
      sv.forEach((d, i) => placements.set(d.name, { x: xs[i]!, y: bands.server }));
    }
  }

  // ---------------- Chained endpoints (dangling) ----------------
  // Iterative traversal: each dangling is placed under its parent. If the
  // parent is itself a dangling, the parent must be placed first.
  // The loop ensures the parent is in `placements` before the child is processed.
  {
    const pending = new Map(danglingByParent);
    let prog = true;
    while (prog && pending.size > 0) {
      prog = false;
      for (const [parentName, kids] of [...pending]) {
        const parentSlot = placements.get(parentName);
        if (!parentSlot) continue; // parent not placed yet, wait for next round
        const sorted = [...kids].sort((a, b) => a.name.localeCompare(b.name));
        const xs = spreadAround(parentSlot.x, sorted.length, LAYOUT.PC_X_SPACING * 0.9);
        sorted.forEach((d, i) => {
          // Directly under parent. If parent is already in the +60 sub-row,
          // this falls at +120 (an analog phone connected to an analog phone, rare but OK).
          const childY = parentSlot.y === LAYOUT.Y_ENDPOINT
            ? LAYOUT.Y_ENDPOINT + 60
            : parentSlot.y + 60;
          placements.set(d.name, { x: xs[i]!, y: childY });
        });
        pending.delete(parentName);
        prog = true;
      }
    }
  }

  // ---------------- Orphans (no path to router) ----------------
  // Maintain category Y band, free column to the right of the last router.
  // Sorted by name for idempotence.
  const orphans = snapshot.devices
    .filter(d => !placements.has(d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (orphans.length > 0) {
    const baseX = cursor; // cursor is past the last router
    const colCounts = new Map<number, number>(); // y → current #col
    for (const d of orphans) {
      const y = d.category ? categoryRow(d.category) : LAYOUT.Y_ENDPOINT;
      const col = colCounts.get(y) ?? 0;
      colCounts.set(y, col + 1);
      placements.set(d.name, {
        x: baseX + col * LAYOUT.X_SPACING,
        y,
      });
    }
  }

  // ---------------- Build list of moves ----------------
  const moves: { name: string; x: number; y: number }[] = [];
  for (const d of snapshot.devices) {
    const slot = placements.get(d.name);
    if (!slot) continue;
    const rx = Math.round(slot.x);
    const ry = Math.round(slot.y);
    if (Math.abs(rx - d.x) < 1 && Math.abs(ry - d.y) < 1) continue;
    moves.push({ name: d.name, x: rx, y: ry });
  }
  return moves;
}
