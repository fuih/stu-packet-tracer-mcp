import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { AddressingRow } from "../student/addressing.js";
import type { LabReport } from "./model.js";

/**
 * Read pixel width & height from a PNG IHDR header (bytes 16..24).
 */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function fitImageDimensions(
  bytes: Uint8Array,
  fallbackW = 600,
  fallbackH = 320,
  maxWidth = 580,
  maxHeight = 660,
): { width: number; height: number } {
  const dims = readPngDimensions(bytes);
  // Our resvg PNGs are rendered at 2x zoom, so divide raw pixels by 2 as CSS size
  let w = dims ? Math.round(dims.width / 2) : fallbackW;
  let h = dims ? Math.round(dims.height / 2) : fallbackH;

  if (w > maxWidth) {
    const scale = maxWidth / w;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  if (h > maxHeight) {
    const scale = maxHeight / h;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  return { width: Math.max(80, w), height: Math.max(40, h) };
}

function buildAddressingTable(rows: readonly AddressingRow[]): Table {
  const headers = ["Device", "Interface", "IP Address", "Subnet Mask", "Default Gateway"];
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" };
  const cellBorders = { top: border, bottom: border, left: border, right: border };

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(text =>
      new TableCell({
        borders: cellBorders,
        shading: { type: ShadingType.SOLID, fill: "1E3A8A", color: "1E3A8A" },
        children: [
          new Paragraph({
            spacing: { before: 80, after: 80 },
            children: [
              new TextRun({ text, bold: true, color: "FFFFFF", size: 20, font: "Calibri" }),
            ],
          }),
        ],
      }),
    ),
  });

  const bodyRows = rows.map((r, idx) => {
    const fill = idx % 2 === 1 ? "F8FAFC" : "FFFFFF";
    const values = [r.device, r.interface, r.ip, r.mask, r.gateway];
    return new TableRow({
      children: values.map((val, colIdx) =>
        new TableCell({
          borders: cellBorders,
          shading: { type: ShadingType.SOLID, fill, color: fill },
          children: [
            new Paragraph({
              spacing: { before: 60, after: 60 },
              children: [
                new TextRun({
                  text: val,
                  bold: colIdx === 0,
                  font: colIdx === 0 ? "Calibri" : "Courier New",
                  size: 19,
                }),
              ],
            }),
          ],
        }),
      ),
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

function renderProseParagraphs(text: string): Paragraph[] {
  const blocks = text.trim().split(/\n\s*\n/);
  const out: Paragraph[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const isBullet = /^[-*]\s+/.test(line);
      const cleanLine = isBullet ? line.replace(/^[-*]\s+/, "") : line;

      // Support simple **bold** and `code` spans inline
      const runs: TextRun[] = [];
      const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = tokenRe.exec(cleanLine)) !== null) {
        if (match.index > last) {
          runs.push(new TextRun({ text: cleanLine.slice(last, match.index), font: "Calibri", size: 22 }));
        }
        const tok = match[0];
        if (tok.startsWith("**")) {
          runs.push(new TextRun({ text: tok.slice(2, -2), bold: true, font: "Calibri", size: 22 }));
        } else {
          runs.push(new TextRun({ text: tok.slice(1, -1), font: "Courier New", size: 20 }));
        }
        last = match.index + tok.length;
      }
      if (last < cleanLine.length) {
        runs.push(new TextRun({ text: cleanLine.slice(last), font: "Calibri", size: 22 }));
      }

      out.push(
        new Paragraph({
          bullet: isBullet ? { level: 0 } : undefined,
          spacing: { before: 60, after: 100 },
          children: runs.length > 0 ? runs : [new TextRun({ text: cleanLine, font: "Calibri", size: 22 })],
        }),
      );
    }
  }
  return out;
}

function buildCodeFallbackParagraphs(text: string): Paragraph[] {
  return text.split(/\r?\n/).map(line =>
    new Paragraph({
      spacing: { before: 0, after: 20 },
      shading: { type: ShadingType.SOLID, fill: "F1F5F9", color: "F1F5F9" },
      children: [new TextRun({ text: line || " ", font: "Courier New", size: 18 })],
    }),
  );
}

/**
 * Render a LabReport to a Microsoft Word `.docx` binary buffer.
 */
export async function renderReportDocx(report: LabReport): Promise<Uint8Array> {
  const children: Array<Paragraph | Table> = [];

  // Title header block
  children.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: report.title,
          bold: true,
          size: 44,
          color: "1E3A8A",
          font: "Calibri",
        }),
      ],
    }),
  );

  const metaLines: string[] = [];
  if (report.course) metaLines.push(`Course: ${report.course}`);
  if (report.student?.name) metaLines.push(`Student: ${report.student.name}`);
  if (report.student?.id) metaLines.push(`Student ID: ${report.student.id}`);
  if (report.student?.group) metaLines.push(`Group: ${report.student.group}`);
  metaLines.push(`Date: ${report.generatedAt}`);

  for (const m of metaLines) {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: m, size: 22, color: "475569", font: "Calibri" })],
      }),
    );
  }

  // Divider paragraph
  children.push(
    new Paragraph({
      spacing: { before: 120, after: 240 },
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 12, color: "1E3A8A" },
      },
      children: [],
    }),
  );

  // Topology Screenshot
  if (report.topology) {
    children.push(
      new Paragraph({
        text: "Network Topology",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 200, after: 120 },
      }),
    );
    const dims = fitImageDimensions(report.topology.pngBytes, 580, 360);
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new ImageRun({
            type: "png",
            data: report.topology.pngBytes,
            transformation: dims,
          }),
        ],
      }),
    );
  }

  // Addressing Table
  if (report.addressing && report.addressing.length > 0) {
    children.push(
      new Paragraph({
        text: "Addressing Table",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 200, after: 120 },
      }),
    );
    children.push(buildAddressingTable(report.addressing));
    children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
  }

  // Ping Matrix
  if (report.pingMatrix) {
    children.push(
      new Paragraph({
        text: "Connectivity Matrix",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 200, after: 120 },
      }),
    );
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: `Summary: ${report.pingMatrix.result.passed}/${report.pingMatrix.result.total} host pairs reachable.`,
            bold: true,
            font: "Calibri",
            size: 22,
          }),
        ],
      }),
    );
    if (report.pingMatrix.pngBytes) {
      const dims = fitImageDimensions(report.pingMatrix.pngBytes, 560, 260);
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [
            new ImageRun({
              type: "png",
              data: report.pingMatrix.pngBytes,
              transformation: dims,
            }),
          ],
        }),
      );
    }
  }

  // Sections
  for (const sec of report.sections) {
    children.push(
      new Paragraph({
        text: sec.heading,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 },
      }),
    );

    if (sec.text) {
      children.push(...renderProseParagraphs(sec.text));
    }

    for (const cap of sec.captures) {
      children.push(
        new Paragraph({
          text: cap.label,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 160, after: 80 },
        }),
      );

      if (cap.pngBytes) {
        const dims = fitImageDimensions(cap.pngBytes);
        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 180 },
            children: [
              new ImageRun({
                type: "png",
                data: cap.pngBytes,
                transformation: dims,
              }),
            ],
          }),
        );
      } else {
        children.push(...buildCodeFallbackParagraphs(cap.text));
      }
    }
  }

  const doc = new Document({
    creator: report.student?.name ?? "stu-packet-tracer-mcp",
    title: report.title,
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: "Page ", size: 18, color: "64748B", font: "Calibri" }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "64748B", font: "Calibri" }),
                  new TextRun({ text: " of ", size: 18, color: "64748B", font: "Calibri" }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "64748B", font: "Calibri" }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
