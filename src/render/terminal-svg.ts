import { buildDefaultHighlightRules, highlightLine, type HighlightRule } from "./highlight.js";
import { getTheme, type TerminalTheme, type ThemeName } from "./themes.js";

export interface TerminalAnnotation {
  /** 1-based line number in the input `lines` array. */
  readonly line: number;
  readonly text: string;
}

export interface TerminalRenderOptions {
  readonly title: string;
  readonly lines: readonly string[];
  readonly theme?: ThemeName;
  readonly fontSize?: number;
  readonly maxColumns?: number;
  readonly highlight?: readonly HighlightRule[];
  readonly showWindowChrome?: boolean;
  readonly annotations?: readonly TerminalAnnotation[];
}

export const MONO_FONT_FAMILY =
  "'DejaVu Sans Mono', 'Cascadia Mono', 'Consolas', 'Courier New', monospace";

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface VisualLine {
  readonly text: string;
  readonly isContinuation: boolean;
  readonly sourceLine: number; // 1-based
}

function wrapLines(lines: readonly string[], maxColumns: number): VisualLine[] {
  const out: VisualLine[] = [];
  const safeMax = Math.max(20, maxColumns);

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").replace(/\r/g, "");
    const sourceLine = i + 1;

    if (raw.length <= safeMax) {
      out.push({ text: raw, isContinuation: false, sourceLine });
      continue;
    }

    let offset = 0;
    let first = true;
    while (offset < raw.length) {
      const limit = first ? safeMax : Math.max(10, safeMax - 2);
      const chunk = raw.slice(offset, offset + limit);
      out.push({
        text: chunk,
        isContinuation: !first,
        sourceLine,
      });
      offset += limit;
      first = false;
    }
  }

  return out;
}

function renderChrome(
  theme: TerminalTheme,
  title: string,
  width: number,
  radius: number,
): { svg: string; height: number } {
  const safeTitle = escapeXml(title);

  if (theme.chromeStyle === "pt-tabs") {
    const titleH = 32;
    const tabH = 28;
    const totalH = titleH + tabH;
    const tabs = ["Physical", "Config", "CLI", "Attributes"];
    let tabX = 12;
    const tabParts: string[] = [];

    for (const tab of tabs) {
      const active = tab === "CLI";
      const tw = tab.length * 8 + 22;
      if (active) {
        tabParts.push(
          `<path d="M ${tabX} ${totalH} L ${tabX} ${titleH + 4} Q ${tabX} ${titleH + 1} ${tabX + 3} ${titleH + 1} L ${tabX + tw - 3} ${titleH + 1} Q ${tabX + tw} ${titleH + 1} ${tabX + tw} ${titleH + 4} L ${tabX + tw} ${totalH} Z" fill="${theme.background}" stroke="${theme.chromeBorder}" stroke-width="1"/>`,
          `<rect x="${tabX + 1}" y="${totalH - 1}" width="${tw - 2}" height="2" fill="${theme.background}"/>`,
          `<text x="${tabX + tw / 2}" y="${titleH + 19}" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="${theme.chromeText}">${tab}</text>`,
        );
      } else {
        tabParts.push(
          `<rect x="${tabX}" y="${titleH + 4}" width="${tw}" height="${tabH - 4}" rx="3" fill="#DDE2EA" stroke="${theme.chromeBorder}" stroke-width="0.75"/>`,
          `<text x="${tabX + tw / 2}" y="${titleH + 19}" text-anchor="middle" font-family="sans-serif" font-size="11.5" fill="#4B5563">${tab}</text>`,
        );
      }
      tabX += tw + 5;
    }

    const svg = [
      `<path d="M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${totalH} L 0 ${totalH} Z" fill="${theme.chromeBg}"/>`,
      `<line x1="0" y1="${titleH}" x2="${width}" y2="${titleH}" stroke="${theme.chromeBorder}" stroke-width="1"/>`,
      `<line x1="0" y1="${totalH}" x2="${width}" y2="${totalH}" stroke="${theme.chromeBorder}" stroke-width="1"/>`,
      `<rect x="12" y="9" width="14" height="14" rx="2" fill="#2563EB"/>`,
      `<text x="19" y="19" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="9" font-weight="700" fill="#FFFFFF">&gt;_</text>`,
      `<text x="34" y="21" font-family="sans-serif" font-size="13" font-weight="600" fill="${theme.chromeText}">${safeTitle}</text>`,
      // Window buttons (right)
      `<text x="${width - 54}" y="20" font-family="sans-serif" font-size="12" fill="#4B5563">—</text>`,
      `<rect x="${width - 37}" y="11" width="9" height="9" fill="none" stroke="#4B5563" stroke-width="1.2"/>`,
      `<text x="${width - 18}" y="20" font-family="sans-serif" font-size="13" fill="#4B5563">×</text>`,
      ...tabParts,
    ].join("\n  ");

    return { svg, height: totalH };
  }

  if (theme.chromeStyle === "macos") {
    const h = 34;
    const svg = [
      `<path d="M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${h} L 0 ${h} Z" fill="${theme.chromeBg}"/>`,
      `<line x1="0" y1="${h}" x2="${width}" y2="${h}" stroke="${theme.chromeBorder}" stroke-width="1"/>`,
      `<circle cx="18" cy="17" r="5.5" fill="#FF5F56"/>`,
      `<circle cx="36" cy="17" r="5.5" fill="#FFBD2E"/>`,
      `<circle cx="54" cy="17" r="5.5" fill="#27C93F"/>`,
      `<text x="${width / 2}" y="21" text-anchor="middle" font-family="sans-serif" font-size="12.5" font-weight="600" fill="${theme.chromeText}">${safeTitle}</text>`,
    ].join("\n  ");
    return { svg, height: h };
  }

  if (theme.chromeStyle === "windows") {
    const h = 32;
    const svg = [
      `<path d="M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${h} L 0 ${h} Z" fill="${theme.chromeBg}"/>`,
      `<rect x="10" y="8" width="16" height="16" rx="2" fill="#0F2A52" stroke="#93C5FD" stroke-width="0.8"/>`,
      `<text x="18" y="19" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="8.5" font-weight="700" fill="#FACC15">PT</text>`,
      `<text x="34" y="20" font-family="sans-serif" font-size="12.5" font-weight="600" fill="${theme.chromeText}">${safeTitle}</text>`,
      `<text x="${width - 54}" y="20" font-family="sans-serif" font-size="12" fill="#E5E7EB">—</text>`,
      `<rect x="${width - 37}" y="11" width="9" height="9" fill="none" stroke="#E5E7EB" stroke-width="1.2"/>`,
      `<text x="${width - 18}" y="20" font-family="sans-serif" font-size="13" fill="#E5E7EB">×</text>`,
    ].join("\n  ");
    return { svg, height: h };
  }

  if (theme.chromeStyle === "cmd") {
    const h = 32;
    const svg = [
      `<path d="M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${h} L 0 ${h} Z" fill="${theme.chromeBg}"/>`,
      `<line x1="0" y1="${h}" x2="${width}" y2="${h}" stroke="${theme.chromeBorder}" stroke-width="1"/>`,
      `<rect x="10" y="9" width="18" height="14" rx="1.5" fill="#000000" stroke="#9CA3AF" stroke-width="1"/>`,
      `<text x="19" y="19" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="8" font-weight="700" fill="#FFFFFF">C:\\</text>`,
      `<text x="36" y="20" font-family="sans-serif" font-size="12.5" font-weight="600" fill="${theme.chromeText}">${safeTitle}</text>`,
      `<text x="${width - 54}" y="20" font-family="sans-serif" font-size="12" fill="#9CA3AF">—</text>`,
      `<rect x="${width - 37}" y="11" width="9" height="9" fill="none" stroke="#9CA3AF" stroke-width="1.2"/>`,
      `<text x="${width - 18}" y="20" font-family="sans-serif" font-size="13" fill="#9CA3AF">×</text>`,
    ].join("\n  ");
    return { svg, height: h };
  }

  // "print" (high-contrast)
  const h = 30;
  const svg = [
    `<rect x="0" y="0" width="${width}" height="${h}" fill="${theme.chromeBg}"/>`,
    `<line x1="0" y1="${h}" x2="${width}" y2="${h}" stroke="${theme.chromeBorder}" stroke-width="1.5"/>`,
    `<text x="14" y="20" font-family="${MONO_FONT_FAMILY}" font-size="12.5" font-weight="700" fill="${theme.chromeText}">${safeTitle}</text>`,
  ].join("\n  ");
  return { svg, height: h };
}

/**
 * Render cleaned CLI output lines as a crisp, selectable terminal-window SVG.
 */
export function renderTerminalSvg(opts: TerminalRenderOptions): string {
  const theme = getTheme(opts.theme ?? "pt-classic");
  const fontSize = opts.fontSize ?? 14;
  const maxColumns = opts.maxColumns ?? 100;
  const showChrome = opts.showWindowChrome ?? true;
  const rules = opts.highlight ?? buildDefaultHighlightRules(theme);
  const annotations = opts.annotations ?? [];

  const charW = fontSize * 0.602;
  const lineHeight = Math.round(fontSize * 1.38);
  const padX = 16;
  const padTop = 14;
  const padBottom = 16;
  const radius = theme.chromeStyle === "print" ? 0 : 8;

  const inputLines = opts.lines.length > 0 ? opts.lines : [""];
  const visualLines = wrapLines(inputLines, maxColumns);

  let maxColsUsed = Math.max(opts.title.length + 12, 42);
  for (const vl of visualLines) {
    const colLen = vl.text.length + (vl.isContinuation ? 2 : 0);
    if (colLen > maxColsUsed) maxColsUsed = colLen;
  }
  maxColsUsed = Math.min(maxColsUsed, maxColumns);

  const hasAnnotations = annotations.length > 0;
  const maxAnnLen = hasAnnotations
    ? Math.max(...annotations.map(a => a.text.length), 12)
    : 0;
  const annotationGap = hasAnnotations ? 24 : 0;
  const annotationWidth = hasAnnotations ? Math.ceil(maxAnnLen * 7.5 + 28) : 0;

  const contentWidth = Math.ceil(maxColsUsed * charW);
  const width = Math.max(360, padX * 2 + contentWidth + annotationGap + annotationWidth);

  const chrome = showChrome
    ? renderChrome(theme, opts.title, width, radius)
    : { svg: "", height: 0 };

  const height = chrome.height + padTop + visualLines.length * lineHeight + padBottom;

  // Map 1-based source line -> first visual line index for annotation positioning
  const annotationMap = new Map<number, string>();
  for (const a of annotations) {
    annotationMap.set(a.line, a.text);
  }
  const annotatedLinesEmitted = new Set<number>();

  const textElements: string[] = [];
  const annotationElements: string[] = [];
  const annX = padX + contentWidth + annotationGap;

  for (let idx = 0; idx < visualLines.length; idx++) {
    const vl = visualLines[idx]!;
    const baselineY = chrome.height + padTop + idx * lineHeight + fontSize;

    const spans = highlightLine(vl.text, rules);
    const tspanParts: string[] = [];

    if (vl.isContinuation) {
      tspanParts.push(`<tspan fill="${theme.mutedColor}">↪ </tspan>`);
    }

    for (const span of spans) {
      if (!span.text) continue;
      const escaped = escapeXml(span.text);
      const attrs: string[] = [];
      if (span.color && span.color !== theme.text) attrs.push(`fill="${span.color}"`);
      if (span.bold) attrs.push(`font-weight="700"`);
      if (attrs.length > 0) {
        tspanParts.push(`<tspan ${attrs.join(" ")}>${escaped}</tspan>`);
      } else {
        tspanParts.push(escaped);
      }
    }

    textElements.push(
      `<text x="${padX}" y="${baselineY}" xml:space="preserve">${tspanParts.join("")}</text>`,
    );

    if (annotationMap.has(vl.sourceLine) && !annotatedLinesEmitted.has(vl.sourceLine)) {
      annotatedLinesEmitted.add(vl.sourceLine);
      const noteText = annotationMap.get(vl.sourceLine)!;
      const boxY = baselineY - fontSize + 1;
      const boxH = fontSize + 6;
      const lineEndX = Math.min(annX - 8, padX + Math.ceil(vl.text.length * charW) + 8);
      annotationElements.push(
        `<line x1="${lineEndX}" y1="${boxY + boxH / 2}" x2="${annX - 2}" y2="${boxY + boxH / 2}" stroke="${theme.annotationBorder}" stroke-width="1" stroke-dasharray="3 2"/>`,
        `<rect x="${annX}" y="${boxY}" width="${annotationWidth - 8}" height="${boxH}" rx="4" fill="${theme.annotationBg}" stroke="${theme.annotationBorder}" stroke-width="1"/>`,
        `<text x="${annX + 8}" y="${baselineY - 1}" font-family="sans-serif" font-size="11.5" font-weight="600" fill="${theme.annotationText}">${escapeXml(noteText)}</text>`,
      );
    }
  }

  const strokeWidth = theme.chromeStyle === "print" ? 1.5 : 1;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(opts.title)}">`,
    `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius}" fill="${theme.background}" stroke="${theme.border}" stroke-width="${strokeWidth}"/>`,
    chrome.svg ? `  ${chrome.svg}` : "",
    `  <g font-family="${MONO_FONT_FAMILY}" font-size="${fontSize}" fill="${theme.text}">`,
    ...textElements.map(line => `    ${line}`),
    `  </g>`,
    annotationElements.length > 0
      ? `  <g class="annotations">\n${annotationElements.map(item => `    ${item}`).join("\n")}\n  </g>`
      : "",
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n") + "\n";
}
