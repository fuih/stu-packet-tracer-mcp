import path from "node:path";
import { formatAddressingMarkdown } from "../student/addressing.js";
import type { LabReport } from "./model.js";

function relPath(baseDir: string, targetPath: string): string {
  return path.relative(baseDir, targetPath).replace(/\\/g, "/");
}

/**
 * Render a LabReport as clean GitHub-Flavored Markdown referencing captured
 * images via relative paths under `captures/`.
 */
export function renderReportMarkdown(report: LabReport): string {
  const lines: string[] = [`# ${report.title}`, ""];

  const meta: string[] = [];
  if (report.course) meta.push(`- **Course:** ${report.course}`);
  if (report.student?.name) meta.push(`- **Student:** ${report.student.name}`);
  if (report.student?.id) meta.push(`- **Student ID:** ${report.student.id}`);
  if (report.student?.group) meta.push(`- **Group:** ${report.student.group}`);
  meta.push(`- **Date:** ${report.generatedAt}`);
  if (report.savedPktPath) {
    meta.push(`- **Packet Tracer File:** \`${path.basename(report.savedPktPath)}\``);
  }
  lines.push(...meta, "");

  if (report.topology) {
    lines.push("## Network Topology", "");
    lines.push(`![Network Topology](${relPath(report.outputDir, report.topology.pngPath)})`, "");
  }

  if (report.addressing && report.addressing.length > 0) {
    lines.push("## Addressing Table", "");
    lines.push(formatAddressingMarkdown(report.addressing), "");
  }

  if (report.pingMatrix) {
    lines.push("## Connectivity Matrix", "");
    const imgPath = report.pingMatrix.pngPath ?? report.pingMatrix.svgPath;
    if (imgPath) {
      lines.push(`![Connectivity Ping Matrix](${relPath(report.outputDir, imgPath)})`, "");
    }
    lines.push(report.pingMatrix.result.markdown, "");
  }

  for (const section of report.sections) {
    lines.push(`## ${section.heading}`, "");
    if (section.text) {
      lines.push(section.text.trim(), "");
    }
    for (const cap of section.captures) {
      lines.push(`### ${cap.label}`, "");
      const imgPath = cap.pngPath ?? cap.svgPath;
      if (imgPath) {
        lines.push(`![${cap.label}](${relPath(report.outputDir, imgPath)})`, "");
      } else {
        lines.push("```text", cap.text, "```", "");
      }
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}
