import { escapeXml } from "../render/terminal-svg.js";
import type { LabReport } from "./model.js";

function renderInlineMarkdown(text: string): string {
  const escaped = escapeXml(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderProseBlock(markdown: string): string {
  const paragraphs = markdown.trim().split(/\n\s*\n/);
  const parts: string[] = [];

  for (const paragraph of paragraphs) {
    const lines = paragraph.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.every(l => /^[-*]\s+/.test(l))) {
      const items = lines.map(l => `<li>${renderInlineMarkdown(l.replace(/^[-*]\s+/, ""))}</li>`);
      parts.push(`<ul>${items.join("")}</ul>`);
    } else {
      parts.push(`<p>${lines.map(renderInlineMarkdown).join("<br/>")}</p>`);
    }
  }
  return parts.join("\n");
}

/**
 * Render a LabReport into a single, self-contained, print-to-PDF-ready HTML
 * document with inline CSS, inline vector SVGs, and embedded topology PNG.
 */
export function renderReportHtml(report: LabReport): string {
  const metaRows: string[] = [];
  if (report.course) metaRows.push(`<div><strong>Course:</strong> ${escapeXml(report.course)}</div>`);
  if (report.student?.name) metaRows.push(`<div><strong>Student:</strong> ${escapeXml(report.student.name)}</div>`);
  if (report.student?.id) metaRows.push(`<div><strong>ID:</strong> ${escapeXml(report.student.id)}</div>`);
  if (report.student?.group) metaRows.push(`<div><strong>Group:</strong> ${escapeXml(report.student.group)}</div>`);
  metaRows.push(`<div><strong>Date:</strong> ${escapeXml(report.generatedAt)}</div>`);

  const bodyParts: string[] = [];

  if (report.topology) {
    const b64 = Buffer.from(report.topology.pngBytes).toString("base64");
    bodyParts.push(`
    <section class="report-section">
      <h2>Network Topology</h2>
      <figure class="figure">
        <img src="data:image/png;base64,${b64}" alt="Network Topology" />
      </figure>
    </section>`);
  }

  if (report.addressing && report.addressing.length > 0) {
    const rowsHtml = report.addressing.map(r => `
          <tr>
            <td><strong>${escapeXml(r.device)}</strong></td>
            <td><code>${escapeXml(r.interface)}</code></td>
            <td><code>${escapeXml(r.ip)}</code></td>
            <td><code>${escapeXml(r.mask)}</code></td>
            <td><code>${escapeXml(r.gateway)}</code></td>
          </tr>`).join("");

    bodyParts.push(`
    <section class="report-section">
      <h2>Addressing Table</h2>
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Interface</th>
            <th>IP Address</th>
            <th>Subnet Mask</th>
            <th>Default Gateway</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}
        </tbody>
      </table>
    </section>`);
  }

  if (report.pingMatrix) {
    const visual = report.pingMatrix.svg
      ? `<div class="svg-wrap">${report.pingMatrix.svg}</div>`
      : report.pingMatrix.pngBytes
        ? `<figure class="figure"><img src="data:image/png;base64,${Buffer.from(report.pingMatrix.pngBytes).toString("base64")}" alt="Ping Matrix" /></figure>`
        : "";
    bodyParts.push(`
    <section class="report-section">
      <h2>Connectivity Matrix</h2>
      <p><strong>Summary:</strong> ${report.pingMatrix.result.passed}/${report.pingMatrix.result.total} host pairs reachable.</p>
      ${visual}
    </section>`);
  }

  for (const sec of report.sections) {
    const capParts: string[] = [];
    for (const cap of sec.captures) {
      let visual: string;
      if (cap.svg) {
        visual = `<div class="svg-wrap">${cap.svg}</div>`;
      } else if (cap.pngBytes) {
        const b64 = Buffer.from(cap.pngBytes).toString("base64");
        visual = `<figure class="figure"><img src="data:image/png;base64,${b64}" alt="${escapeXml(cap.label)}" /></figure>`;
      } else {
        visual = `<pre class="fallback-pre">${escapeXml(cap.text)}</pre>`;
      }

      capParts.push(`
      <div class="capture-block">
        <h3>${escapeXml(cap.label)}</h3>
        ${visual}
      </div>`);
    }

    bodyParts.push(`
    <section class="report-section">
      <h2>${escapeXml(sec.heading)}</h2>
      ${sec.text ? `<div class="prose">${renderProseBlock(sec.text)}</div>` : ""}
      ${capParts.join("\n")}
    </section>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeXml(report.title)}</title>
  <style>
    :root {
      --ink: #0f172a;
      --muted: #475569;
      --accent: #1e3a8a;
      --border: #cbd5e1;
      --bg-subtle: #f8fafc;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--ink);
      background: #ffffff;
      margin: 0;
      padding: 32px 24px;
      line-height: 1.55;
    }
    .page {
      max-width: 920px;
      margin: 0 auto;
    }
    header.cover {
      border-bottom: 3px solid var(--accent);
      padding-bottom: 18px;
      margin-bottom: 28px;
    }
    header.cover h1 {
      margin: 0 0 12px;
      font-size: 28px;
      color: var(--accent);
    }
    .meta-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 24px;
      color: var(--muted);
      font-size: 14px;
    }
    .report-section {
      margin-bottom: 30px;
    }
    h2 {
      font-size: 20px;
      color: var(--accent);
      border-bottom: 1px solid var(--border);
      padding-bottom: 6px;
      margin: 24px 0 12px;
      page-break-after: avoid;
    }
    h3 {
      font-size: 15px;
      color: var(--ink);
      margin: 16px 0 8px;
      page-break-after: avoid;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 13.5px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      text-align: left;
    }
    th {
      background: var(--accent);
      color: #ffffff;
      font-weight: 600;
    }
    tbody tr:nth-child(even) {
      background: var(--bg-subtle);
    }
    code {
      font-family: "DejaVu Sans Mono", Consolas, monospace;
      font-size: 0.92em;
      background: #f1f5f9;
      padding: 1px 4px;
      border-radius: 3px;
    }
    .figure {
      margin: 12px 0;
      text-align: center;
    }
    .figure img {
      max-width: 100%;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .svg-wrap {
      margin: 10px 0 18px;
      overflow-x: auto;
    }
    .svg-wrap svg {
      max-width: 100%;
      height: auto;
      display: block;
    }
    .capture-block {
      page-break-inside: avoid;
      margin-bottom: 16px;
    }
    .fallback-pre {
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      font-family: "DejaVu Sans Mono", Consolas, monospace;
      font-size: 12.5px;
      overflow-x: auto;
    }
    footer.doc-footer {
      margin-top: 36px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }
    @media print {
      body { padding: 0; }
      .page { max-width: 100%; }
      .capture-block, .figure, table { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="cover">
      <h1>${escapeXml(report.title)}</h1>
      <div class="meta-grid">
        ${metaRows.join("\n        ")}
      </div>
    </header>
    ${bodyParts.join("\n")}
    <footer class="doc-footer">
      Generated with stu-packet-tracer-mcp
    </footer>
  </div>
</body>
</html>
`;
}
