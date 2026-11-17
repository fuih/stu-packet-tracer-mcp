import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderSvgToPng } from "../src/render/png.js";
import { renderAndSaveTerminal } from "../src/render/save.js";
import { escapeXml, renderTerminalSvg } from "../src/render/terminal-svg.js";
import type { ThemeName } from "../src/render/themes.js";
import { formatPcTranscript } from "../src/tools/capture-pc-command.js";

const GOLDEN_DIR = path.resolve(import.meta.dir, "..", "test", "golden");
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

const SAMPLE_ROUTE_LINES = [
  "R1# show ip route",
  "Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP",
  "Gateway of last resort is 10.0.0.2 to network 0.0.0.0",
  "",
  "     10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks",
  "C       10.0.0.0/30 is directly connected, Serial0/0/0",
  "L       10.0.0.1/32 is directly connected, Serial0/0/0",
  "C       192.168.1.0/24 is directly connected, GigabitEthernet0/0",
  "S*   0.0.0.0/0 [1/0] via 10.0.0.2",
  "R1#",
];

const SAMPLE_PC_PING_LINES = [
  "C:\\>ping 192.168.2.10",
  "",
  "Pinging 192.168.2.10 with 32 bytes of data:",
  "",
  "Request timed out.",
  "Reply from 192.168.2.10: bytes=32 time=2ms TTL=126",
  "Reply from 192.168.2.10: bytes=32 time=1ms TTL=126",
  "Reply from 192.168.2.10: bytes=32 time=1ms TTL=126",
  "",
  "Ping statistics for 192.168.2.10:",
  "    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),",
  "C:\\>",
];

function checkGolden(name: string, actual: string): void {
  const goldenPath = path.join(GOLDEN_DIR, name);
  if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath, actual, "utf8");
  }
  const expected = readFileSync(goldenPath, "utf8");
  expect(actual).toBe(expected);
}

describe("Terminal SVG Renderer", () => {
  test("escapes all XML special characters safely", () => {
    expect(escapeXml(`<tag attr="a" & 'b'>`)).toBe("&lt;tag attr=&quot;a&quot; &amp; &#39;b&#39;&gt;");

    const svg = renderTerminalSvg({
      title: `R1 <CLI> & "test"`,
      lines: [`R1# banner motd # <Welcome & 'Hello'> #`],
    });
    expect(svg).toContain("&lt;CLI&gt; &amp; &quot;test&quot;");
    expect(svg).toContain("&lt;Welcome &amp; &#39;Hello&#39;&gt;");
    expect(svg).not.toContain("<Welcome");
  });

  test("wraps long lines cleanly with continuation marker", () => {
    const longLine = "A".repeat(120);
    const svg = renderTerminalSvg({
      title: "R1 - CLI",
      lines: [longLine],
      maxColumns: 50,
    });
    expect(svg).toContain("↪ ");
    expect(svg).toContain('xml:space="preserve"');
  });

  test("renders right-margin annotations on specified lines", () => {
    const svg = renderTerminalSvg({
      title: "R1 - CLI",
      lines: SAMPLE_ROUTE_LINES,
      theme: "pt-classic",
      annotations: [{ line: 9, text: "Default route to R2" }],
    });
    expect(svg).toContain("Default route to R2");
    expect(svg).toContain('class="annotations"');
  });

  test("highlights prompts, route codes, ping replies, and timeouts on syntax themes", () => {
    const svgRoute = renderTerminalSvg({
      title: "R1 - CLI",
      lines: SAMPLE_ROUTE_LINES,
      theme: "dark",
    });
    expect(svgRoute).toContain('fill="#4ADE80" font-weight="700">R1#</tspan>');
    expect(svgRoute).toContain('fill="#60A5FA" font-weight="700">S*</tspan>');

    const svgPingDark = renderTerminalSvg({
      title: "PC0 — Command Prompt",
      lines: SAMPLE_PC_PING_LINES,
      theme: "dark",
    });
    expect(svgPingDark).toContain('fill="#F87171" font-weight="700">Request timed out.</tspan>');
    expect(svgPingDark).toContain('fill="#4ADE80" font-weight="700">Reply from</tspan>');
  });

  test("clones native Packet Tracer 9 CLI and Command Prompt UI chrome", () => {
    const cliSvg = renderTerminalSvg({
      title: "R1 - CLI",
      lines: SAMPLE_ROUTE_LINES,
      theme: "pt-classic",
    });
    expect(cliSvg).toContain("IOS Command Line Interface");
    expect(cliSvg).toContain("Copy");
    expect(cliSvg).toContain("Paste");
    expect(cliSvg).toContain("Top");
    expect(cliSvg).toContain("#0F2B6B");

    const cmdSvg = renderTerminalSvg({
      title: "PC0 - Command Prompt",
      lines: SAMPLE_PC_PING_LINES,
      theme: "pc-cmd",
    });
    expect(cmdSvg).toContain("Desktop");
    expect(cmdSvg).toContain("Programming");
    expect(cmdSvg).toContain("Command Prompt");
    expect(cmdSvg).toContain("#0000FF");
    expect(cmdSvg).toContain("Top");
  });

  const themes: Array<{ theme: ThemeName; file: string; title: string; lines: string[] }> = [
    { theme: "pt-classic", file: "route-pt-classic.svg", title: "R1 - CLI", lines: SAMPLE_ROUTE_LINES },
    { theme: "dark", file: "route-dark.svg", title: "R1 - CLI", lines: SAMPLE_ROUTE_LINES },
    { theme: "putty", file: "route-putty.svg", title: "R1 - PuTTY", lines: SAMPLE_ROUTE_LINES },
    { theme: "high-contrast", file: "route-high-contrast.svg", title: "R1 - CLI", lines: SAMPLE_ROUTE_LINES },
    { theme: "pc-cmd", file: "ping-pc-cmd.svg", title: "PC0 — Command Prompt", lines: SAMPLE_PC_PING_LINES },
  ];

  for (const tc of themes) {
    test(`matches golden SVG snapshot for theme "${tc.theme}"`, () => {
      const svg = renderTerminalSvg({
        title: tc.title,
        lines: tc.lines,
        theme: tc.theme,
      });
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      checkGolden(tc.file, svg);
    });
  }
});

describe("PNG Rasterization (@resvg/resvg-wasm + DejaVu Sans Mono)", () => {
  test("rasterizes terminal SVG to a valid 2x PNG image", async () => {
    const svg = renderTerminalSvg({
      title: "R1 - CLI",
      lines: SAMPLE_ROUTE_LINES,
      theme: "pt-classic",
    });
    const res = await renderSvgToPng(svg, 2);
    expect(res.error).toBeUndefined();
    expect(res.png).not.toBeNull();
    const bytes = res.png!;
    // Verify PNG magic signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBeGreaterThan(2_000);
    expect(res.width).toBeGreaterThan(600);
    expect(res.height).toBeGreaterThan(200);
  });

  test("renderAndSaveTerminal writes both SVG and PNG files to disk", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "stu-pt-render-"));
    try {
      const base = path.join(tmp, "r1-route");
      const saved = await renderAndSaveTerminal(
        { title: "R1 - CLI", lines: SAMPLE_ROUTE_LINES, theme: "dark" },
        base,
        "both",
      );
      expect(saved.svgPath).toBe(`${base}.svg`);
      expect(saved.pngPath).toBe(`${base}.png`);
      expect(existsSync(saved.svgPath!)).toBe(true);
      expect(existsSync(saved.pngPath!)).toBe(true);
      expect(saved.pngBase64 && saved.pngBase64.length > 100).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("PC Command Prompt formatting", () => {
  test("normalizes raw PC ping slice with C:\\> header and footer", () => {
    const lines = formatPcTranscript("ipconfig", "ipconfig\n\nFastEthernet0 Connection:\n   IP Address: 192.168.1.10");
    expect(lines[0]).toBe("C:\\>ipconfig");
    expect(lines.some(l => l.includes("192.168.1.10"))).toBe(true);
    expect(lines[lines.length - 1]).toBe("C:\\>");
  });
});
