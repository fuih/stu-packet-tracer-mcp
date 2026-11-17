import { describe, expect, test } from "bun:test";
import path from "node:path";
import { renderSvgToPng } from "../src/render/png.js";
import { renderTerminalSvg } from "../src/render/terminal-svg.js";
import { readPngDimensions, renderReportDocx } from "../src/report/docx.js";
import { renderReportHtml } from "../src/report/html.js";
import { renderReportMarkdown } from "../src/report/markdown.js";
import type { LabReport } from "../src/report/model.js";
import { renderPingMatrixSvg, type PingMatrixResult } from "../src/student/ping-matrix.js";

async function buildSampleReport(): Promise<LabReport> {
  const outputDir = "/tmp/stu-pt-test-report";
  const routeLines = [
    "R1# show ip route",
    "Gateway of last resort is 10.0.0.2 to network 0.0.0.0",
    "C    192.168.1.0/24 is directly connected, GigabitEthernet0/0",
    "S*   0.0.0.0/0 [1/0] via 10.0.0.2",
    "R1#",
  ];
  const routeSvg = renderTerminalSvg({ title: "R1 - CLI", lines: routeLines, theme: "pt-classic" });
  const routeRaster = await renderSvgToPng(routeSvg, 2);

  const pingLines = [
    "C:\\>ping 192.168.2.10",
    "Reply from 192.168.2.10: bytes=32 time=1ms TTL=126",
    "Ping statistics for 192.168.2.10:",
    "    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),",
    "C:\\>",
  ];
  const pingSvg = renderTerminalSvg({ title: "PC-A — Command Prompt", lines: pingLines, theme: "pc-cmd" });
  const pingRaster = await renderSvgToPng(pingSvg, 2);

  const matrixResult: PingMatrixResult = {
    hosts: [
      { name: "PC-A", ip: "192.168.1.10", gateway: "192.168.1.1" },
      { name: "PC-B", ip: "192.168.2.10", gateway: "192.168.2.1" },
    ],
    cells: [
      { from: "PC-A", to: "PC-A", targetIp: "192.168.1.10", status: "self", sent: 0, received: 0, successRate: 100 },
      { from: "PC-A", to: "PC-B", targetIp: "192.168.2.10", status: "pass", sent: 4, received: 4, successRate: 100 },
      { from: "PC-B", to: "PC-A", targetIp: "192.168.1.10", status: "pass", sent: 4, received: 4, successRate: 100 },
      { from: "PC-B", to: "PC-B", targetIp: "192.168.2.10", status: "self", sent: 0, received: 0, successRate: 100 },
    ],
    passed: 2,
    failed: 0,
    total: 2,
    markdown: "| From \\ To | PC-A | PC-B |\n| --- | :---: | :---: |\n| **PC-A** | — | ✅ 4/4 |",
  };
  const matrixSvg = renderPingMatrixSvg(matrixResult);
  const matrixRaster = await renderSvgToPng(matrixSvg, 2);

  return {
    title: "Workshop: Static & Default Routing",
    course: "Computer Networks — Lab 3",
    student: { name: "Alex Student", group: "Group A", id: "2026-0042" },
    generatedAt: "2026-11-17",
    outputDir,
    topology: {
      pngPath: path.join(outputDir, "captures", "topology.png"),
      pngBytes: routeRaster.png!,
    },
    addressing: [
      {
        device: "R1",
        model: "2911",
        interface: "GigabitEthernet0/0",
        ip: "192.168.1.1",
        mask: "255.255.255.0",
        cidr: "192.168.1.1/24",
        gateway: "N/A",
        connected: true,
      },
      {
        device: "PC-A",
        model: "PC-PT",
        interface: "FastEthernet0",
        ip: "192.168.1.10",
        mask: "255.255.255.0",
        cidr: "192.168.1.10/24",
        gateway: "192.168.1.1",
        connected: true,
      },
    ],
    pingMatrix: {
      result: matrixResult,
      svg: matrixSvg,
      svgPath: path.join(outputDir, "captures", "ping-matrix.svg"),
      pngPath: path.join(outputDir, "captures", "ping-matrix.png"),
      pngBytes: matrixRaster.png ?? undefined,
    },
    sections: [
      {
        heading: "1. Routing Table Verification",
        text: "Router **R1** installs a default static route (`0.0.0.0/0`) via `10.0.0.2`.",
        captures: [
          {
            label: "R1: `show ip route`",
            device: "R1",
            command: "show ip route",
            text: routeLines.join("\n"),
            svg: routeSvg,
            svgPath: path.join(outputDir, "captures", "01-r1-show-ip-route.svg"),
            pngPath: path.join(outputDir, "captures", "01-r1-show-ip-route.png"),
            pngBytes: routeRaster.png ?? undefined,
          },
        ],
      },
      {
        heading: "2. End-to-End Connectivity",
        text: "- Verified ICMP replies between PC-A and PC-B.\n- Fallback capture below without PNG.",
        captures: [
          {
            label: "PC-A Command Prompt: `ping 192.168.2.10`",
            device: "PC-A",
            command: "ping 192.168.2.10",
            text: pingLines.join("\n"),
            svg: pingSvg,
            svgPath: path.join(outputDir, "captures", "02-pc-a-ping.svg"),
            pngPath: path.join(outputDir, "captures", "02-pc-a-ping.png"),
            pngBytes: pingRaster.png ?? undefined,
          },
          {
            label: "Fallback Text Block",
            device: "R2",
            command: "show version",
            text: "Cisco IOS Software, Version 15.1",
          },
        ],
      },
    ],
  };
}

describe("Lab Report Exporters (pt_export_report)", () => {
  test("exports clean Markdown with relative capture paths and addressing table", async () => {
    const report = await buildSampleReport();
    const md = renderReportMarkdown(report);
    expect(md).toContain("# Workshop: Static & Default Routing");
    expect(md).toContain("**Student:** Alex Student");
    expect(md).toContain("![Network Topology](captures/topology.png)");
    expect(md).toContain("| R1 | GigabitEthernet0/0 | 192.168.1.1 | 255.255.255.0 | N/A |");
    expect(md).toContain("![R1: `show ip route`](captures/01-r1-show-ip-route.png)");
    expect(md).toContain("```text\nCisco IOS Software, Version 15.1\n```");
  });

  test("exports self-contained print-ready HTML with inline SVG and embedded topology PNG", async () => {
    const report = await buildSampleReport();
    const html = renderReportHtml(report);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("@media print");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("<svg xmlns=");
    expect(html).toContain("<strong>R1</strong>");
    expect(html).toContain("Workshop: Static &amp; Default Routing");
  });

  test("exports valid Microsoft Word DOCX (OOXML ZIP) with embedded PNGs and IHDR sizing", async () => {
    const report = await buildSampleReport();
    const dims = readPngDimensions(report.topology!.pngBytes);
    expect(dims).not.toBeNull();
    expect(dims!.width).toBeGreaterThan(200);
    expect(dims!.height).toBeGreaterThan(100);

    const docxBytes = await renderReportDocx(report);
    // Verify ZIP/OOXML magic header: PK\x03\x04
    expect(Array.from(docxBytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(docxBytes.length).toBeGreaterThan(10_000);
  });
});
