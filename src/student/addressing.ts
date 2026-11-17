import type { Bridge } from "../bridge/http-bridge.js";
import { ipToInt } from "../canvas/subnetting.js";
import { withLabel } from "../ipc/label.js";
import { ptError } from "../util/errors.js";

export interface AddressingRow {
  readonly device: string;
  readonly model: string;
  readonly interface: string;
  readonly ip: string;
  readonly mask: string;
  readonly cidr: string;
  readonly gateway: string;
  readonly connected: boolean;
}

export interface AddressingTableResult {
  readonly rows: readonly AddressingRow[];
  readonly markdown: string;
  readonly csv: string;
}

/**
 * Convert dotted-quad subnet mask (e.g. "255.255.255.0") to CIDR prefix length (e.g. 24).
 */
export function maskToPrefix(mask: string): number | null {
  if (!mask || mask === "0.0.0.0") return null;
  try {
    const n = ipToInt(mask);
    let count = 0;
    let seenZero = false;
    for (let bit = 31; bit >= 0; bit--) {
      if ((n >>> bit) & 1) {
        if (seenZero) return null; // non-contiguous mask
        count++;
      } else {
        seenZero = true;
      }
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Single-round-trip PT Script Engine dump of every device, its default gateway,
 * and every port with its IPv4 address, subnet mask, and link state.
 */
export function addressingDumpJs(): string {
  return withLabel(
    "Collecting live addressing table (devices, interfaces, IPs, gateways)",
    `(function(){` +
      `var net=ipc.network();` +
      `var n=net.getDeviceCount();` +
      `var out=[];` +
      `for(var i=0;i<n;i++){` +
        `var d=net.getDeviceAt(i);` +
        `var m=d.getModel();` +
        `if(m==="Power Distribution Device")continue;` +
        `var gw="";` +
        `try{gw=d.getDefaultGateway()||"";}catch(e){}` +
        `if(!gw){try{var p0=d.getPortAt(0);if(p0&&typeof p0.getDefaultGateway==="function")gw=p0.getDefaultGateway()||"";}catch(e){}}` +
        `if(!gw&&typeof d.serializeToXml==="function"){try{var xml=String(d.serializeToXml()||"");var gm=xml.match(/<PORT_GATEWAY>([^<]+)<\\/PORT_GATEWAY>/)||xml.match(/<GATEWAY>([^<]+)<\\/GATEWAY>/);if(gm&&gm[1]&&gm[1]!=="0.0.0.0")gw=gm[1].trim();}catch(e){}}` +
        `out.push("DEV|"+d.getName()+"|"+m+"|"+gw);` +
        `var pc=d.getPortCount();` +
        `for(var j=0;j<pc;j++){` +
          `var p=d.getPortAt(j);` +
          `var ip="";var mk="";var lnk=0;` +
          `try{ip=p.getIpAddress()||"";}catch(e){}` +
          `try{mk=p.getSubnetMask()||"";}catch(e){}` +
          `try{lnk=p.getLink()?1:0;}catch(e){}` +
          `out.push("PORT|"+p.getName()+"|"+ip+"|"+mk+"|"+lnk);` +
        `}` +
      `}` +
      `return out.join("\\n");` +
    `})()`,
  );
}

/**
 * Parse raw addressing dump lines into typed AddressingRow entries.
 */
export function parseAddressingDump(
  raw: string,
  includeUnassigned = false,
): AddressingRow[] {
  const rows: AddressingRow[] = [];
  let currentDevice = "";
  let currentModel = "";
  let currentGateway = "";

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("|");

    if (parts[0] === "DEV") {
      currentDevice = parts[1] ?? "";
      currentModel = parts[2] ?? "";
      currentGateway = parts[3] && parts[3] !== "0.0.0.0" ? parts[3] : "";
      continue;
    }

    if (parts[0] === "PORT" && currentDevice) {
      const iface = parts[1] ?? "";
      const ip = parts[2] && parts[2] !== "0.0.0.0" ? parts[2] : "";
      const mask = parts[3] && parts[3] !== "0.0.0.0" ? parts[3] : "";
      const connected = parts[4] === "1";

      if (!ip && !includeUnassigned) continue;

      const prefix = mask ? maskToPrefix(mask) : null;
      const cidr = ip && prefix !== null ? `${ip}/${prefix}` : ip || "N/A";
      const isRouterOrSwitch = /router|isr|2811|2901|2911|1941|4321|4331|switch|2960|3560|3650/i.test(currentModel);

      rows.push({
        device: currentDevice,
        model: currentModel,
        interface: iface,
        ip: ip || "Unassigned",
        mask: mask || "N/A",
        cidr,
        gateway: currentGateway || (isRouterOrSwitch ? "N/A" : "Not configured"),
        connected,
      });
    }
  }

  return rows;
}

export function formatAddressingMarkdown(rows: readonly AddressingRow[]): string {
  if (rows.length === 0) {
    return "_No configured IPv4 interfaces found on the canvas._";
  }
  const lines = [
    "| Device | Interface | IP Address | Subnet Mask | Default Gateway |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(`| ${r.device} | ${r.interface} | ${r.ip} | ${r.mask} | ${r.gateway} |`);
  }
  return lines.join("\n");
}

function csvCell(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function formatAddressingCsv(rows: readonly AddressingRow[]): string {
  const lines = ["Device,Model,Interface,IP Address,Subnet Mask,CIDR,Default Gateway,Connected"];
  for (const r of rows) {
    lines.push([
      csvCell(r.device),
      csvCell(r.model),
      csvCell(r.interface),
      csvCell(r.ip),
      csvCell(r.mask),
      csvCell(r.cidr),
      csvCell(r.gateway),
      r.connected ? "yes" : "no",
    ].join(","));
  }
  return lines.join("\n");
}

export async function collectAddressingTable(
  bridge: Bridge,
  opts: { includeUnassigned?: boolean; devices?: readonly string[] } = {},
): Promise<AddressingTableResult> {
  const raw = await bridge.sendAndWait(addressingDumpJs(), { timeoutMs: 12_000 });
  if (raw === null) {
    throw ptError("BRIDGE_TIMEOUT", "Timed out collecting the addressing table from Packet Tracer.");
  }
  if (raw.startsWith("ERR:") || raw.startsWith("ERROR:")) {
    throw ptError("PT_RAISED", `Packet Tracer error collecting addressing table: ${raw}`);
  }

  let rows = parseAddressingDump(raw, opts.includeUnassigned ?? false);
  if (opts.devices && opts.devices.length > 0) {
    const allowed = new Set(opts.devices.map(d => d.toLowerCase()));
    rows = rows.filter(r => allowed.has(r.device.toLowerCase()));
  }

  return {
    rows,
    markdown: formatAddressingMarkdown(rows),
    csv: formatAddressingCsv(rows),
  };
}
