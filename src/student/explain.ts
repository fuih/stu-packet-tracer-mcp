/**
 * Offline, rule-based Cisco IOS output explainer for networking students.
 *
 * Supports:
 *   - `show ip route`
 *   - `show ip arp`
 *   - `show ip interface brief`
 *   - `show vlan brief`
 *   - `show running-config`
 */

export type OutputKind =
  | "show-ip-route"
  | "show-ip-arp"
  | "show-ip-int-brief"
  | "show-vlan-brief"
  | "show-running-config"
  | "unknown";

export interface ExplainedItem {
  readonly line: string;
  readonly explanation: string;
}

export interface ExplainResult {
  readonly kind: OutputKind;
  readonly summary: string;
  readonly items: readonly ExplainedItem[];
  readonly tips: readonly string[];
  readonly markdown: string;
}

const ROUTE_CODES: Readonly<Record<string, string>> = {
  C: "Directly Connected network (interface has an IP in this subnet and is up/up)",
  L: "Local host route (/32) representing the router's own interface IP address",
  S: "Static route manually configured with `ip route`",
  "S*": "Static candidate default route (`0.0.0.0/0` — used when no more specific route matches)",
  R: "RIP (Routing Information Protocol — distance-vector, hop-count metric, default AD 120)",
  O: "OSPF intra-area route (link-state, cost metric, default AD 110)",
  "O IA": "OSPF Inter-Area route learned from another OSPF area",
  "O E1": "OSPF External Type 1 route",
  "O E2": "OSPF External Type 2 route",
  "O*E2": "OSPF candidate default external route",
  D: "EIGRP route (default AD 90)",
  "D EX": "EIGRP external route (default AD 170)",
  B: "BGP route (eBGP AD 20 / iBGP AD 200)",
};

export function detectOutputKind(output: string, commandHint?: string): OutputKind {
  const hint = (commandHint ?? "").toLowerCase();
  if (hint.includes("ip route")) return "show-ip-route";
  if (hint.includes("arp")) return "show-ip-arp";
  if (hint.includes("int") && hint.includes("br")) return "show-ip-int-brief";
  if (hint.includes("vlan")) return "show-vlan-brief";
  if (hint.includes("run") || hint.includes("start")) return "show-running-config";

  if (/Gateway of last resort|Codes:\s*L - local/i.test(output)) return "show-ip-route";
  if (/Protocol\s+Address\s+Age\s*\(min\)\s+Hardware Addr/i.test(output)) return "show-ip-arp";
  if (/Interface\s+IP-Address\s+OK\?\s+Method\s+Status\s+Protocol/i.test(output)) return "show-ip-int-brief";
  if (/VLAN\s+Name\s+Status\s+Ports/i.test(output)) return "show-vlan-brief";
  if (/^hostname\s+|^interface\s+|^version\s+\d+/im.test(output)) return "show-running-config";
  return "unknown";
}

function explainRoute(output: string): { summary: string; items: ExplainedItem[]; tips: string[] } {
  const items: ExplainedItem[] = [];
  const tips: string[] = [];
  let routeCount = 0;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^Gateway of last resort is not set/i.test(line)) {
      items.push({
        line,
        explanation: "No default route (`0.0.0.0/0`) is installed. Packets to unknown destinations will be dropped.",
      });
      tips.push("Add a default route with `ip route 0.0.0.0 0.0.0.0 <next-hop>` if this router should forward unknown traffic upstream.");
      continue;
    }

    const gwMatch = line.match(/^Gateway of last resort is (\S+) to network (\S+)/i);
    if (gwMatch) {
      items.push({
        line,
        explanation: `Default gateway of last resort is active: unmatched packets are forwarded to ${gwMatch[1]} (network ${gwMatch[2]}).`,
      });
      continue;
    }

    // Route entries
    const entryMatch = line.match(
      /^(O\s+IA|O\s+E[12]|O\*E[12]|D\s+EX|[CSLRODB]\*?)\s+(\d+\.\d+\.\d+\.\d+(?:\/\d+)?)\s+(.*)$/,
    );
    if (entryMatch) {
      routeCount++;
      const code = entryMatch[1]!.replace(/\s+/g, " ");
      const prefix = entryMatch[2]!;
      const rest = entryMatch[3]!;
      const codeDesc = ROUTE_CODES[code] ?? `Routing code ${code}`;

      let detail = `${codeDesc} for destination \`${prefix}\`.`;
      const adMetric = rest.match(/\[(\d+)\/(\d+)\]/);
      if (adMetric) {
        detail += ` Administrative Distance (trustworthiness) = ${adMetric[1]}, Metric (cost/hops) = ${adMetric[2]}.`;
      }
      const via = rest.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
      if (via) {
        detail += ` Next-hop router IP is ${via[1]}.`;
      }
      if (/is directly connected,\s*(\S+)/i.test(rest)) {
        const iface = rest.match(/is directly connected,\s*(\S+)/i)![1];
        detail += ` Reachable directly out interface ${iface}.`;
      }

      items.push({ line, explanation: detail });
    }
  }

  if (routeCount === 0) {
    tips.push("No active routes were parsed. Make sure interfaces have IP addresses and `no shutdown` applied.");
  } else {
    tips.push("Remember Longest Prefix Match: routers always choose the most specific mask (e.g., `/24` beats `/16` beats `0.0.0.0/0`).");
  }

  return {
    summary: `Parsed ${routeCount} IPv4 routing table entry/entries.`,
    items,
    tips,
  };
}

function explainArp(output: string): { summary: string; items: ExplainedItem[]; tips: string[] } {
  const items: ExplainedItem[] = [];
  let count = 0;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^Internet\s+(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s+([0-9a-fA-F.]+)\s+ARPA\s+(\S+)/);
    if (!m) continue;
    count++;
    const [, ip, age, mac, iface] = m;
    const ageExplain = age === "-"
      ? "Age `-` means this IP/MAC belongs to the router's own local interface (never expires)."
      : `Learned dynamically ${age} minute(s) ago via ARP.`;
    items.push({
      line,
      explanation: `Maps IPv4 \`${ip}\` → Layer-2 MAC \`${mac}\` on interface ${iface}. ${ageExplain}`,
    });
  }

  return {
    summary: `Parsed ${count} ARP cache entry/entries.`,
    items,
    tips: [
      "An Age of `-` always identifies the device's own interface IP/MAC.",
      "Missing ARP entries are normal until traffic (such as a ping) triggers an ARP Request broadcast.",
    ],
  };
}

function explainIntBrief(output: string): { summary: string; items: ExplainedItem[]; tips: string[] } {
  const items: ExplainedItem[] = [];
  const tips: string[] = [];
  let upCount = 0;
  let adminDownCount = 0;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^Interface\s+IP-Address/i.test(line)) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+(YES|NO)\s+(\S+)\s+(administratively down|up|down)\s+(up|down)$/i);
    if (!m) continue;
    const [, iface, ip, , method, status, proto] = m;
    const sLow = status!.toLowerCase();
    const pLow = proto!.toLowerCase();

    let stateExplain: string;
    if (sLow === "up" && pLow === "up") {
      upCount++;
      stateExplain = "Healthy! Both Layer 1 (physical link) and Layer 2 (line protocol) are UP.";
    } else if (sLow === "administratively down") {
      adminDownCount++;
      stateExplain = "Disabled in configuration (`shutdown`). Run `no shutdown` in interface config mode to enable it.";
    } else if (sLow === "down" && pLow === "down") {
      stateExplain = "Layer 1 problem: cable disconnected, wrong cable type, or remote device powered off/shutdown.";
    } else {
      stateExplain = "Layer 1 is UP, but Layer 2 protocol is DOWN (check encapsulation mismatch, clock rate on serial DCE, or speed/duplex).";
    }

    const ipExplain = ip!.toLowerCase() === "unassigned"
      ? "No IPv4 address assigned"
      : `IPv4 ${ip} (configured via ${method})`;

    items.push({
      line,
      explanation: `**${iface}**: ${ipExplain}. ${stateExplain}`,
    });
  }

  if (adminDownCount > 0) {
    tips.push(`${adminDownCount} interface(s) are administratively down — remember Cisco router interfaces default to \`shutdown\`.`);
  }

  return {
    summary: `Parsed ${items.length} interface(s): ${upCount} up/up, ${adminDownCount} administratively down.`,
    items,
    tips,
  };
}

function explainVlanBrief(output: string): { summary: string; items: ExplainedItem[]; tips: string[] } {
  const items: ExplainedItem[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^(\d+)\s+(\S+)\s+(active|act\/lshut|suspended)\s*(.*)$/i);
    if (!m) continue;
    const [, id, name, status, ports] = m;
    const portDesc = ports && ports.trim().length > 0
      ? `Access ports assigned: ${ports.trim()}.`
      : "No access ports currently assigned (may be carried over trunk ports).";
    items.push({
      line,
      explanation: `VLAN ${id} ("${name}") is **${status}**. ${portDesc}`,
    });
  }

  return {
    summary: `Parsed ${items.length} VLAN(s).`,
    items,
    tips: [
      "Trunk ports do NOT appear in `show vlan brief` — use `show interfaces trunk` to see trunk links.",
      "VLAN 1 is the default VLAN; best practice is to move user ports to dedicated VLANs.",
    ],
  };
}

function explainRunningConfig(output: string): { summary: string; items: ExplainedItem[]; tips: string[] } {
  const items: ExplainedItem[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "!") continue;

    if (/^hostname\s+(\S+)/i.test(line)) {
      items.push({ line, explanation: `Sets the device prompt/hostname to "${line.split(/\s+/)[1]}".` });
    } else if (/^no ip domain[- ]lookup/i.test(line)) {
      items.push({ line, explanation: "Prevents IOS from pausing to DNS-lookup mistyped CLI commands." });
    } else if (/^interface\s+(\S+)/i.test(line)) {
      items.push({ line, explanation: `Begins configuration block for interface ${line.split(/\s+/)[1]}.` });
    } else if (/^encapsulation dot1Q\s+(\d+)/i.test(line)) {
      items.push({ line, explanation: `Tags this subinterface with 802.1Q VLAN ${line.match(/\d+/)![0]} (Router-on-a-Stick).` });
    } else if (/^ip address\s+(\S+)\s+(\S+)/i.test(line)) {
      const p = line.split(/\s+/);
      items.push({ line, explanation: `Assigns IPv4 address ${p[2]} with subnet mask ${p[3]}.` });
    } else if (/^ip route\s+(\S+)\s+(\S+)\s+(\S+)/i.test(line)) {
      const p = line.split(/\s+/);
      const isDefault = p[2] === "0.0.0.0" && p[3] === "0.0.0.0";
      items.push({
        line,
        explanation: isDefault
          ? `Default static route: forwards all unmatched traffic to next-hop/exit ${p[4]}.`
          : `Static route: traffic to network ${p[2]} (mask ${p[3]}) goes via ${p[4]}.`,
      });
    } else if (/^router ospf\s+(\d+)/i.test(line)) {
      items.push({ line, explanation: `Enables OSPF dynamic routing process #${line.split(/\s+/)[2]}.` });
    } else if (/^router rip/i.test(line)) {
      items.push({ line, explanation: "Enables RIP dynamic routing protocol." });
    } else if (/^ip dhcp pool\s+(\S+)/i.test(line)) {
      items.push({ line, explanation: `Defines DHCP address pool "${line.split(/\s+/)[3]}".` });
    } else if (/^ip nat inside source list/i.test(line)) {
      items.push({ line, explanation: "Configures NAT/PAT translation mapping internal hosts matched by an ACL to an outside IP/interface." });
    } else if (/^access-list\s+/i.test(line)) {
      items.push({ line, explanation: "Access Control List (ACL) rule filtering traffic or selecting interesting traffic for NAT." });
    } else if (/^switchport mode (access|trunk)/i.test(line)) {
      const mode = line.split(/\s+/)[2];
      items.push({
        line,
        explanation: mode === "trunk"
          ? "Configures switch port as an 802.1Q trunk carrying multiple VLANs."
          : "Configures switch port as an access port carrying a single untagged VLAN.",
      });
    }
  }

  return {
    summary: `Highlighted ${items.length} key configuration directive(s).`,
    items,
    tips: ["Use `copy running-config startup-config` (or `wr`) so your configuration survives a reload."],
  };
}

export function explainCliOutput(output: string, commandHint?: string): ExplainResult {
  const kind = detectOutputKind(output, commandHint);
  let res: { summary: string; items: ExplainedItem[]; tips: string[] };

  switch (kind) {
    case "show-ip-route":
      res = explainRoute(output);
      break;
    case "show-ip-arp":
      res = explainArp(output);
      break;
    case "show-ip-int-brief":
      res = explainIntBrief(output);
      break;
    case "show-vlan-brief":
      res = explainVlanBrief(output);
      break;
    case "show-running-config":
      res = explainRunningConfig(output);
      break;
    default:
      res = {
        summary: "Could not auto-detect the IOS command format.",
        items: [],
        tips: [
          "Pass `command` (e.g. 'show ip route', 'show ip arp', 'show ip interface brief', 'show vlan brief', or 'show running-config') to force a specific parser.",
        ],
      };
  }

  const md: string[] = [
    `## Explanation (${kind})`,
    "",
    res.summary,
    "",
  ];
  if (res.items.length > 0) {
    for (const item of res.items) {
      md.push(`- \`${item.line}\``);
      md.push(`  - ${item.explanation}`);
    }
    md.push("");
  }
  if (res.tips.length > 0) {
    md.push("### Study Tips");
    for (const tip of res.tips) {
      md.push(`- ${tip}`);
    }
  }

  return {
    kind,
    summary: res.summary,
    items: res.items,
    tips: res.tips,
    markdown: md.join("\n").trimEnd(),
  };
}
