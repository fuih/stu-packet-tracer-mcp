import type { Bridge } from "../bridge/http-bridge.js";
import { ipToInt } from "../canvas/subnetting.js";
import { escapeXml, MONO_FONT_FAMILY } from "../render/terminal-svg.js";
import { runPingsParallel } from "../sim/runner.js";
import { ptError } from "../util/errors.js";
import { collectAddressingTable, type AddressingRow } from "./addressing.js";

export interface PingMatrixCell {
  readonly from: string;
  readonly to: string;
  readonly targetIp: string;
  readonly status: "pass" | "partial" | "fail" | "self" | "skipped";
  readonly sent: number;
  readonly received: number;
  readonly successRate: number;
  readonly diagnosis?: string;
}

export interface PingMatrixResult {
  readonly hosts: ReadonlyArray<{ readonly name: string; readonly ip: string; readonly gateway: string }>;
  readonly cells: readonly PingMatrixCell[];
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly markdown: string;
}

function sameSubnet(ipA: string, maskA: string, ipB: string): boolean {
  try {
    const a = ipToInt(ipA);
    const m = ipToInt(maskA);
    const b = ipToInt(ipB);
    return ((a & m) >>> 0) === ((b & m) >>> 0);
  } catch {
    return false;
  }
}

export function diagnosePingFailure(
  src: AddressingRow,
  dst: AddressingRow,
  rawOutput: string,
): string {
  if (!src.connected) return `${src.device} (${src.interface}) has no active link.`;
  if (!dst.connected) return `${dst.device} (${dst.interface}) has no active link.`;
  if (src.ip === "Unassigned") return `${src.device} has no IPv4 address configured.`;
  if (dst.ip === "Unassigned") return `${dst.device} has no IPv4 address configured.`;

  const localSubnet = sameSubnet(src.ip, src.mask, dst.ip);
  if (!localSubnet && (!src.gateway || src.gateway === "Not configured" || src.gateway === "N/A")) {
    return `${src.device} is missing a default gateway for remote destination ${dst.ip}.`;
  }
  if (!localSubnet && (!dst.gateway || dst.gateway === "Not configured" || dst.gateway === "N/A")) {
    return `${dst.device} is missing a default gateway to send replies back to ${src.ip}.`;
  }
  if (/Destination host unreachable/i.test(rawOutput)) {
    return "Destination host unreachable — check router static/dynamic routes or ACLs.";
  }
  if (/Request timed out/i.test(rawOutput)) {
    return "Request timed out — verify forward and return routes on all intermediate routers.";
  }
  return "No ICMP echo replies received — check IP addressing, gateways, and routing tables.";
}

export function renderPingMatrixMarkdown(
  hosts: ReadonlyArray<{ readonly name: string; readonly ip: string }>,
  cells: readonly PingMatrixCell[],
): string {
  if (hosts.length === 0) return "_No hosts with IPv4 addresses found._";

  const lookup = new Map<string, PingMatrixCell>();
  for (const c of cells) lookup.set(`${c.from}=>${c.to}`, c);

  const header = `| From \\ To | ${hosts.map(h => `${h.name} (${h.ip})`).join(" | ")} |`;
  const sep = `| --- | ${hosts.map(() => ":---:").join(" | ")} |`;
  const rows: string[] = [header, sep];

  for (const src of hosts) {
    const cols: string[] = [];
    for (const dst of hosts) {
      if (src.name === dst.name) {
        cols.push("—");
        continue;
      }
      const cell = lookup.get(`${src.name}=>${dst.name}`);
      if (!cell) {
        cols.push("?");
      } else if (cell.status === "pass") {
        cols.push(`✅ ${cell.received}/${cell.sent}`);
      } else if (cell.status === "partial") {
        cols.push(`⚠️ ${cell.received}/${cell.sent}`);
      } else {
        cols.push(`❌ 0/${cell.sent}`);
      }
    }
    rows.push(`| **${src.name}** | ${cols.join(" | ")} |`);
  }

  const failures = cells.filter(c => c.status === "fail" || c.status === "partial");
  if (failures.length > 0) {
    rows.push("", "### Failure Diagnostics");
    for (const f of failures) {
      rows.push(`- **${f.from} → ${f.to} (${f.targetIp})**: ${f.diagnosis ?? "Ping failed."}`);
    }
  }

  return rows.join("\n");
}

/**
 * Render the ping matrix as a clean standalone SVG table for reports.
 */
export function renderPingMatrixSvg(result: PingMatrixResult, title = "Connectivity Ping Matrix"): string {
  const n = result.hosts.length;
  const labelW = 130;
  const colW = 115;
  const rowH = 34;
  const headerH = 40;
  const titleH = 38;
  const pad = 16;

  const width = Math.max(360, pad * 2 + labelW + n * colW);
  const height = pad * 2 + titleH + headerH + n * rowH + 24;

  const lookup = new Map<string, PingMatrixCell>();
  for (const c of result.cells) lookup.set(`${c.from}=>${c.to}`, c);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1"/>`,
    `  <text x="${pad}" y="${pad + 22}" font-family="${MONO_FONT_FAMILY}" font-size="14" font-weight="700" fill="#0F172A">${escapeXml(title)} (${result.passed}/${result.total} passed)</text>`,
  ];

  const tableTop = pad + titleH;
  // Header row background
  parts.push(
    `  <rect x="${pad}" y="${tableTop}" width="${labelW + n * colW}" height="${headerH}" fill="#F1F5F9" stroke="#CBD5E1" stroke-width="1"/>`,
    `  <text x="${pad + 10}" y="${tableTop + 24}" font-family="${MONO_FONT_FAMILY}" font-size="11.5" font-weight="700" fill="#334155">From \\ To</text>`,
  );

  for (let j = 0; j < n; j++) {
    const h = result.hosts[j]!;
    const cx = pad + labelW + j * colW;
    parts.push(
      `  <line x1="${cx}" y1="${tableTop}" x2="${cx}" y2="${tableTop + headerH + n * rowH}" stroke="#E2E8F0" stroke-width="1"/>`,
      `  <text x="${cx + colW / 2}" y="${tableTop + 17}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="11.5" font-weight="700" fill="#0F172A">${escapeXml(h.name)}</text>`,
      `  <text x="${cx + colW / 2}" y="${tableTop + 32}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="9.5" fill="#64748B">${escapeXml(h.ip)}</text>`,
    );
  }

  for (let i = 0; i < n; i++) {
    const src = result.hosts[i]!;
    const ry = tableTop + headerH + i * rowH;
    parts.push(
      `  <rect x="${pad}" y="${ry}" width="${labelW + n * colW}" height="${rowH}" fill="${i % 2 === 0 ? "#FFFFFF" : "#F8FAFC"}" stroke="#E2E8F0" stroke-width="1"/>`,
      `  <text x="${pad + 10}" y="${ry + 21}" font-family="${MONO_FONT_FAMILY}" font-size="11.5" font-weight="700" fill="#0F172A">${escapeXml(src.name)}</text>`,
    );

    for (let j = 0; j < n; j++) {
      const dst = result.hosts[j]!;
      const cx = pad + labelW + j * colW;
      if (i === j) {
        parts.push(
          `  <rect x="${cx + 1}" y="${ry + 1}" width="${colW - 2}" height="${rowH - 2}" fill="#F1F5F9"/>`,
          `  <text x="${cx + colW / 2}" y="${ry + 21}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="12" fill="#94A3B8">—</text>`,
        );
        continue;
      }
      const cell = lookup.get(`${src.name}=>${dst.name}`);
      const isPass = cell?.status === "pass";
      const isPartial = cell?.status === "partial";
      const fill = isPass ? "#DCFCE7" : isPartial ? "#FEF9C3" : "#FEE2E2";
      const color = isPass ? "#166534" : isPartial ? "#854D0E" : "#991B1B";
      const text = isPass
        ? `PASS ${cell!.received}/${cell!.sent}`
        : isPartial
          ? `PART ${cell!.received}/${cell!.sent}`
          : `FAIL 0/${cell?.sent ?? 4}`;

      parts.push(
        `  <rect x="${cx + 4}" y="${ry + 5}" width="${colW - 8}" height="${rowH - 10}" rx="4" fill="${fill}"/>`,
        `  <text x="${cx + colW / 2}" y="${ry + 21}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="11" font-weight="700" fill="${color}">${escapeXml(text)}</text>`,
      );
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

function isEndHost(row: AddressingRow): boolean {
  return /pc|laptop|server|tablet|phone|wireless|host/i.test(row.model);
}

/**
 * Execute an all-pairs ping matrix across selected hosts (or all end-hosts on the canvas).
 * Runs one warm-up ping first (by default) so ARP resolution does not cause false failures (F8).
 */
export async function runPingMatrix(
  bridge: Bridge,
  opts: {
    devices?: readonly string[];
    warmup?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<PingMatrixResult> {
  const table = await collectAddressingTable(bridge, { includeUnassigned: false });
  let candidateRows: AddressingRow[];

  if (opts.devices && opts.devices.length > 0) {
    const wanted = opts.devices.map(d => d.toLowerCase());
    candidateRows = [];
    for (const w of wanted) {
      const found = table.rows.find(r => r.device.toLowerCase() === w && r.ip !== "Unassigned");
      if (!found) {
        throw ptError(
          "HOST_NO_IP",
          `Device "${w}" was not found with an assigned IPv4 address on the canvas.`,
          "Check pt_addressing_table to see which devices have IP addresses configured.",
        );
      }
      candidateRows.push(found);
    }
  } else {
    // Pick first configured interface of each end-host (PC/Laptop/Server)
    const seen = new Set<string>();
    candidateRows = [];
    for (const r of table.rows) {
      if (isEndHost(r) && !seen.has(r.device)) {
        seen.add(r.device);
        candidateRows.push(r);
      }
    }
  }

  if (candidateRows.length < 2) {
    throw ptError(
      "INSUFFICIENT_HOSTS",
      `Need at least 2 hosts with IPv4 addresses to run a ping matrix (found ${candidateRows.length}).`,
      "Pass explicit device names in `devices` or assign IPs to at least two PCs.",
    );
  }

  const doWarmup = opts.warmup ?? true;
  const timeoutMs = opts.timeoutMs ?? 35_000;
  const n = candidateRows.length;

  // Store outcomes keyed by "src=>dst" so final cell order matches candidateRows x candidateRows
  const outcomeMap = new Map<string, { raw: string; sent: number; received: number; successRate: number }>();

  // Partition all N*(N-1) directed pairs into N-1 conflict-free parallel waves
  // where each source host runs at most one ping per wave.
  for (let step = 1; step < n; step++) {
    const wavePairs: Array<{ src: AddressingRow; dst: AddressingRow }> = [];
    for (let i = 0; i < n; i++) {
      const src = candidateRows[i]!;
      const dst = candidateRows[(i + step) % n]!;
      wavePairs.push({ src, dst });
    }

    const firstOutcomes = await runPingsParallel(
      bridge,
      wavePairs.map(p => ({ device: p.src.device, target: p.dst.ip })),
      { timeoutMs },
    );

    const retryIndices: number[] = [];
    for (let idx = 0; idx < wavePairs.length; idx++) {
      const pair = wavePairs[idx]!;
      const out = firstOutcomes[idx]!;
      const sent = out.result.sent || 4;
      const received = out.result.received;
      outcomeMap.set(`${pair.src.device}=>${pair.dst.device}`, {
        raw: out.raw,
        sent,
        received,
        successRate: out.result.successRate,
      });
      // Smart ARP warmup: only re-ping pairs that did not achieve 100% on the first pass.
      if (doWarmup && received < sent) {
        retryIndices.push(idx);
      }
    }

    if (retryIndices.length > 0) {
      const retryOutcomes = await runPingsParallel(
        bridge,
        retryIndices.map(idx => {
          const pair = wavePairs[idx]!;
          return { device: pair.src.device, target: pair.dst.ip };
        }),
        { timeoutMs },
      );
      for (let rIdx = 0; rIdx < retryIndices.length; rIdx++) {
        const pair = wavePairs[retryIndices[rIdx]!]!;
        const out = retryOutcomes[rIdx]!;
        const sent = out.result.sent || 4;
        outcomeMap.set(`${pair.src.device}=>${pair.dst.device}`, {
          raw: out.raw,
          sent,
          received: out.result.received,
          successRate: out.result.successRate,
        });
      }
    }
  }

  const cells: PingMatrixCell[] = [];
  let passed = 0;
  let failed = 0;

  for (const src of candidateRows) {
    for (const dst of candidateRows) {
      if (src.device === dst.device) {
        cells.push({
          from: src.device,
          to: dst.device,
          targetIp: dst.ip,
          status: "self",
          sent: 0,
          received: 0,
          successRate: 100,
        });
        continue;
      }

      const measured = outcomeMap.get(`${src.device}=>${dst.device}`) ?? {
        raw: "",
        sent: 4,
        received: 0,
        successRate: 0,
      };
      const sent = measured.sent || 4;
      const received = measured.received;
      const status: PingMatrixCell["status"] =
        received >= sent && sent > 0
          ? "pass"
          : received > 0
            ? "partial"
            : "fail";

      if (status === "pass") passed++;
      else failed++;

      const diagnosis = status === "pass" ? undefined : diagnosePingFailure(src, dst, measured.raw);
      cells.push({
        from: src.device,
        to: dst.device,
        targetIp: dst.ip,
        status,
        sent,
        received,
        successRate: measured.successRate,
        diagnosis,
      });
    }
  }

  const hosts = candidateRows.map(r => ({ name: r.device, ip: r.ip, gateway: r.gateway }));
  const markdown = renderPingMatrixMarkdown(hosts, cells);

  return {
    hosts,
    cells,
    passed,
    failed,
    total: passed + failed,
    markdown,
  };
}
