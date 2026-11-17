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

const UI_FONT_FAMILY = "'DejaVu Sans', 'Segoe UI', Arial, Helvetica, sans-serif";

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

/**
 * Render Packet Tracer 9's Qt Fusion-style tab strip with thick navy underline on the active tab.
 */
function renderPtTabStrip(
  tabs: readonly string[],
  activeTab: string,
  startX: number,
  topY: number,
  tabH: number,
  activeFill: string,
): string[] {
  const parts: string[] = [];
  let cursorX = startX;
  const bottomY = topY + tabH;

  for (const label of tabs) {
    const isActive = label === activeTab;
    const tabW = Math.max(58, label.length * 7.8 + 24);
    const centerX = cursorX + tabW / 2;

    if (isActive) {
      parts.push(
        `<rect x="${cursorX}" y="${topY}" width="${tabW}" height="${tabH + 1}" fill="${activeFill}"/>`,
        `<text x="${centerX}" y="${topY + 19}" text-anchor="middle" font-family="${UI_FONT_FAMILY}" font-size="12" fill="#111111">${label}</text>`,
        `<rect x="${cursorX + 6}" y="${bottomY - 4}" width="${tabW - 12}" height="3" fill="#0F2B6B"/>`,
      );
    } else {
      parts.push(
        `<rect x="${cursorX}" y="${topY + 2}" width="${tabW}" height="${tabH - 2}" fill="#F3F3F3"/>`,
        `<text x="${centerX}" y="${topY + 19}" text-anchor="middle" font-family="${UI_FONT_FAMILY}" font-size="12" fill="#222222">${label}</text>`,
      );
    }

    cursorX += tabW + 2;
  }

  return parts;
}

/**
 * Render Packet Tracer 9's classic vertical Qt scrollbar inside the right edge of a console box.
 */
function renderPtScrollbar(
  x: number,
  y: number,
  height: number,
  thumbBottom: boolean,
): string[] {
  const w = 15;
  const btnH = 15;
  const trackY = y + btnH;
  const trackH = Math.max(20, height - btnH * 2);
  const thumbH = Math.max(26, Math.min(trackH - 8, Math.round(trackH * 0.62)));
  const thumbY = thumbBottom ? trackY + trackH - thumbH - 2 : trackY + 2;
  const cx = x + w / 2;

  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${height}" fill="#F2F2F2"/>`,
    `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + height}" stroke="#D4D4D4" stroke-width="1"/>`,
    // Up arrow button
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${btnH - 1}" fill="#F0F0F0"/>`,
    `<polygon points="${cx},${y + 5} ${cx - 3.5},${y + 10} ${cx + 3.5},${y + 10}" fill="#444444"/>`,
    // Down arrow button
    `<rect x="${x + 0.5}" y="${y + height - btnH + 0.5}" width="${w - 1}" height="${btnH - 1}" fill="#F0F0F0"/>`,
    `<polygon points="${cx},${y + height - 5} ${cx - 3.5},${y + height - 10} ${cx + 3.5},${y + height - 10}" fill="#444444"/>`,
    // Scrollbar thumb
    `<rect x="${x + 2}" y="${thumbY}" width="${w - 4}" height="${thumbH}" rx="1" fill="#CFCFCF"/>`,
  ];
}

/**
 * Render bottom-left Packet Tracer "☐ Top" checkbox footer.
 */
function renderPtTopCheckbox(x: number, y: number): string[] {
  return [
    `<rect x="${x}" y="${y}" width="13" height="13" rx="1.5" fill="#FFFFFF" stroke="#9B9B9B" stroke-width="1"/>`,
    `<text x="${x + 19}" y="${y + 11}" font-family="${UI_FONT_FAMILY}" font-size="11.5" fill="#222222">Top</text>`,
  ];
}

function renderStandardChrome(
  theme: TerminalTheme,
  title: string,
  width: number,
  radius: number,
): { svg: string; height: number } {
  const safeTitle = escapeXml(title);

  if (theme.chromeStyle === "macos") {
    const h = 34;
    const svg = [
      `<path d="M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${h} L 0 ${h} Z" fill="${theme.chromeBg}"/>`,
      `<line x1="0" y1="${h}" x2="${width}" y2="${h}" stroke="${theme.chromeBorder}" stroke-width="1"/>`,
      `<circle cx="18" cy="17" r="5.5" fill="#FF5F56"/>`,
      `<circle cx="36" cy="17" r="5.5" fill="#FFBD2E"/>`,
      `<circle cx="54" cy="17" r="5.5" fill="#27C93F"/>`,
      `<text x="${width / 2}" y="21" text-anchor="middle" font-family="${UI_FONT_FAMILY}" font-size="12.5" font-weight="600" fill="${theme.chromeText}">${safeTitle}</text>`,
    ].join("\n  ");
    return { svg, height: h };
  }

  if (theme.chromeStyle === "windows") {
    const h = 32;
    const svg = [
      `<path d="M 0 ${radius} Q 0 0 ${radius} 0 L ${width - radius} 0 Q ${width} 0 ${width} ${radius} L ${width} ${h} L 0 ${h} Z" fill="${theme.chromeBg}"/>`,
      `<rect x="10" y="8" width="16" height="16" rx="2" fill="#0F2A52" stroke="#93C5FD" stroke-width="0.8"/>`,
      `<text x="18" y="19" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="8.5" font-weight="700" fill="#FACC15">PT</text>`,
      `<text x="34" y="20" font-family="${UI_FONT_FAMILY}" font-size="12.5" font-weight="600" fill="${theme.chromeText}">${safeTitle}</text>`,
      `<text x="${width - 54}" y="20" font-family="${UI_FONT_FAMILY}" font-size="12" fill="#E5E7EB">—</text>`,
      `<rect x="${width - 37}" y="11" width="9" height="9" fill="none" stroke="#E5E7EB" stroke-width="1.2"/>`,
      `<text x="${width - 18}" y="20" font-family="${UI_FONT_FAMILY}" font-size="13" fill="#E5E7EB">×</text>`,
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

function buildTextAndAnnotations(
  visualLines: readonly VisualLine[],
  theme: TerminalTheme,
  rules: readonly HighlightRule[],
  annotations: readonly TerminalAnnotation[],
  textStartX: number,
  textStartY: number,
  fontSize: number,
  lineHeight: number,
  charW: number,
  annX: number,
  annotationWidth: number,
  drawIosCaret: boolean,
): { textElements: string[]; annotationElements: string[]; caretSvg: string } {
  const annotationMap = new Map<number, string>();
  for (const a of annotations) {
    annotationMap.set(a.line, a.text);
  }
  const annotatedLinesEmitted = new Set<number>();

  const textElements: string[] = [];
  const annotationElements: string[] = [];
  let caretSvg = "";

  for (let idx = 0; idx < visualLines.length; idx++) {
    const vl = visualLines[idx]!;
    const baselineY = textStartY + idx * lineHeight + fontSize;

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
      `<text x="${textStartX}" y="${baselineY}" xml:space="preserve">${tspanParts.join("")}</text>`,
    );

    if (
      drawIosCaret &&
      idx === visualLines.length - 1 &&
      /^[A-Za-z0-9_.\-]+(?:\([A-Za-z0-9_.\-]+\))?[>#]\s*$/.test(vl.text)
    ) {
      const caretX = Math.round((textStartX + vl.text.length * charW + 1) * 10) / 10;
      caretSvg = `<line x1="${caretX}" y1="${baselineY - fontSize + 2}" x2="${caretX}" y2="${baselineY + 2}" stroke="#000000" stroke-width="1.2"/>`;
    }

    if (annotationMap.has(vl.sourceLine) && !annotatedLinesEmitted.has(vl.sourceLine)) {
      annotatedLinesEmitted.add(vl.sourceLine);
      const noteText = annotationMap.get(vl.sourceLine)!;
      const boxY = baselineY - fontSize + 1;
      const boxH = fontSize + 6;
      const lineEndX = Math.min(annX - 8, textStartX + Math.ceil(vl.text.length * charW) + 8);
      annotationElements.push(
        `<line x1="${lineEndX}" y1="${boxY + boxH / 2}" x2="${annX - 2}" y2="${boxY + boxH / 2}" stroke="${theme.annotationBorder}" stroke-width="1" stroke-dasharray="3 2"/>`,
        `<rect x="${annX}" y="${boxY}" width="${annotationWidth - 8}" height="${boxH}" rx="4" fill="${theme.annotationBg}" stroke="${theme.annotationBorder}" stroke-width="1"/>`,
        `<text x="${annX + 8}" y="${baselineY - 1}" font-family="${UI_FONT_FAMILY}" font-size="11.5" font-weight="600" fill="${theme.annotationText}">${escapeXml(noteText)}</text>`,
      );
    }
  }

  return { textElements, annotationElements, caretSvg };
}

/**
 * Render cleaned CLI or Command Prompt output as a crisp, selectable SVG.
 * Themes `pt-classic` and `pc-cmd` faithfully mirror Cisco Packet Tracer 9's
 * native IOS CLI tab and Desktop Command Prompt UI.
 */
export function renderTerminalSvg(opts: TerminalRenderOptions): string {
  const theme = getTheme(opts.theme ?? "pt-classic");
  const isPtNative = theme.chromeStyle === "pt-cli" || theme.chromeStyle === "pt-cmd";
  const fontSize = opts.fontSize ?? (isPtNative ? 13 : 14);
  const maxColumns = opts.maxColumns ?? 100;
  const showChrome = opts.showWindowChrome ?? true;
  const rules = opts.highlight ?? buildDefaultHighlightRules(theme);
  const annotations = opts.annotations ?? [];

  const charW = fontSize * 0.602;
  const lineHeight = Math.round(fontSize * (isPtNative ? 1.32 : 1.38));

  const inputLines = opts.lines.length > 0 ? opts.lines : [""];
  const visualLines = wrapLines(inputLines, maxColumns);

  let maxColsUsed = Math.max(opts.title.length + 10, isPtNative ? 64 : 42);
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

  // -------------------------------------------------------------------------
  // Native Cisco Packet Tracer 9 — Router/Switch IOS CLI ("pt-classic")
  // -------------------------------------------------------------------------
  if (theme.chromeStyle === "pt-cli" && showChrome) {
    const outerPad = 12;
    const tabTop = 10;
    const tabH = 28;
    const panelTop = tabTop + tabH;
    const consolePadX = 12;
    const consoleX = outerPad + 12;
    const consoleY = panelTop + 36; // space for centered "IOS Command Line Interface"
    const scrollbarW = 15;
    const innerPadX = 8;
    const innerPadTop = 6;
    const innerPadBottom = 10;

    const consoleInnerW = innerPadX * 2 + contentWidth + annotationGap + annotationWidth + scrollbarW + 4;
    const consoleW = Math.max(540, consoleInnerW);
    const consoleH = Math.max(160, innerPadTop + visualLines.length * lineHeight + innerPadBottom);

    const width = consoleX * 2 + consoleW;
    const panelW = width - outerPad * 2;
    const btnRowH = 44; // Copy / Paste buttons row inside white panel
    const panelH = (consoleY - panelTop) + consoleH + btnRowH;
    const footerH = 32; // bottom "☐ Top" bar on #F0F0F0 dialog
    const height = panelTop + panelH + footerH;

    const textStartX = consoleX + innerPadX;
    const textStartY = consoleY + innerPadTop;
    const annX = textStartX + contentWidth + annotationGap;

    const { textElements, annotationElements, caretSvg } = buildTextAndAnnotations(
      visualLines,
      theme,
      rules,
      annotations,
      textStartX,
      textStartY,
      fontSize,
      lineHeight,
      charW,
      annX,
      annotationWidth,
      true,
    );

    const tabParts = renderPtTabStrip(
      ["Physical", "Config", "CLI", "Attributes"],
      "CLI",
      outerPad,
      tabTop,
      tabH,
      "#FFFFFF",
    );
    const scrollParts = renderPtScrollbar(
      consoleX + consoleW - scrollbarW - 1,
      consoleY + 1,
      consoleH - 2,
      true,
    );
    const topCheckboxParts = renderPtTopCheckbox(outerPad + 2, panelTop + panelH + 9);

    // Copy & Paste buttons right-aligned beneath the console box
    const btnW = 74;
    const btnH = 25;
    const btnY = consoleY + consoleH + 10;
    const pasteX = consoleX + consoleW - btnW;
    const copyX = pasteX - btnW - 8;

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(opts.title)}">`,
      `  <defs>`,
      `    <linearGradient id="pt-btn-grad" x1="0" y1="0" x2="0" y2="1">`,
      `      <stop offset="0%" stop-color="#F7F7F7"/>`,
      `      <stop offset="100%" stop-color="#E4E4E4"/>`,
      `    </linearGradient>`,
      `  </defs>`,
      // Outer PT 9 light gray window frame
      `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="#F0F0F0" stroke="#C8C8C8" stroke-width="1"/>`,
      // Tab strip + white inner panel
      `  <rect x="${outerPad}" y="${panelTop}" width="${panelW}" height="${panelH}" fill="#FFFFFF" stroke="#DCDCDC" stroke-width="1"/>`,
      ...tabParts.map(item => `  ${item}`),
      // Centered title inside white panel
      `  <text x="${width / 2}" y="${panelTop + 23}" text-anchor="middle" font-family="${UI_FONT_FAMILY}" font-size="13" fill="#111111">IOS Command Line Interface</text>`,
      // 2px solid black-bordered CLI console box
      `  <rect x="${consoleX}" y="${consoleY}" width="${consoleW}" height="${consoleH}" fill="#FFFFFF" stroke="#000000" stroke-width="2"/>`,
      ...scrollParts.map(item => `  ${item}`),
      // Console text lines
      `  <g font-family="${MONO_FONT_FAMILY}" font-size="${fontSize}" fill="#000000">`,
      ...textElements.map(line => `    ${line}`),
      `  </g>`,
      caretSvg ? `  ${caretSvg}` : "",
      annotationElements.length > 0
        ? `  <g class="annotations">\n${annotationElements.map(item => `    ${item}`).join("\n")}\n  </g>`
        : "",
      // Copy & Paste buttons
      `  <rect x="${copyX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="3" fill="url(#pt-btn-grad)" stroke="#B5B5B5" stroke-width="1"/>`,
      `  <text x="${copyX + btnW / 2}" y="${btnY + 17}" text-anchor="middle" font-family="${UI_FONT_FAMILY}" font-size="12" fill="#111111">Copy</text>`,
      `  <rect x="${pasteX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="3" fill="url(#pt-btn-grad)" stroke="#B5B5B5" stroke-width="1"/>`,
      `  <text x="${pasteX + btnW / 2}" y="${btnY + 17}" text-anchor="middle" font-family="${UI_FONT_FAMILY}" font-size="12" fill="#111111">Paste</text>`,
      // Bottom "☐ Top" checkbox
      ...topCheckboxParts.map(item => `  ${item}`),
      // Suppress unused local lint cleanly
      ...(consolePadX > 0 ? [] : []),
      `</svg>`,
    ]
      .filter(Boolean)
      .join("\n") + "\n";
  }

  // -------------------------------------------------------------------------
  // Native Cisco Packet Tracer 9 — PC Desktop Command Prompt ("pc-cmd")
  // -------------------------------------------------------------------------
  if (theme.chromeStyle === "pt-cmd" && showChrome) {
    const outerPad = 12;
    const tabTop = 10;
    const tabH = 28;
    const panelTop = tabTop + tabH;
    const blueBarX = outerPad + 10;
    const blueBarY = panelTop + 10;
    const blueBarH = 27;
    const consoleX = blueBarX;
    const consoleY = blueBarY + blueBarH + 6;
    const scrollbarW = 15;
    const innerPadX = 8;
    const innerPadTop = 6;
    const innerPadBottom = 10;

    const consoleInnerW = innerPadX * 2 + contentWidth + annotationGap + annotationWidth + scrollbarW + 4;
    const consoleW = Math.max(540, consoleInnerW);
    const consoleH = Math.max(160, innerPadTop + visualLines.length * lineHeight + innerPadBottom);

    const width = consoleX * 2 + consoleW;
    const panelW = width - outerPad * 2;
    const panelH = (consoleY - panelTop) + consoleH + 10;
    const footerH = 30;
    const height = panelTop + panelH + footerH;

    const textStartX = consoleX + innerPadX;
    const textStartY = consoleY + innerPadTop;
    const annX = textStartX + contentWidth + annotationGap;

    const { textElements, annotationElements } = buildTextAndAnnotations(
      visualLines,
      theme,
      rules,
      annotations,
      textStartX,
      textStartY,
      fontSize,
      lineHeight,
      charW,
      annX,
      annotationWidth,
      false,
    );

    const tabParts = renderPtTabStrip(
      ["Physical", "Config", "Desktop", "Programming", "Attributes"],
      "Desktop",
      outerPad,
      tabTop,
      tabH,
      "#F5F5F5",
    );
    const scrollParts = renderPtScrollbar(
      consoleX + consoleW - scrollbarW,
      consoleY,
      consoleH,
      true,
    );
    const topCheckboxParts = renderPtTopCheckbox(outerPad + 2, panelTop + panelH + 8);

    // Classic PT 9 blue bar right-hand square X close button
    const closeW = 28;
    const closeH = 23;
    const closeX = blueBarX + consoleW - closeW - 2;
    const closeY = blueBarY + 2;

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(opts.title)}">`,
      // Outer PT 9 light gray window frame
      `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="#F0F0F0" stroke="#C8C8C8" stroke-width="1"/>`,
      // Desktop container frame
      `  <rect x="${outerPad}" y="${panelTop}" width="${panelW}" height="${panelH}" fill="#F5F5F5" stroke="#D0D0D0" stroke-width="1"/>`,
      ...tabParts.map(item => `  ${item}`),
      // Vivid royal-blue Command Prompt title bar
      `  <rect x="${blueBarX}" y="${blueBarY}" width="${consoleW}" height="${blueBarH}" fill="#0000FF"/>`,
      `  <text x="${blueBarX + 6}" y="${blueBarY + 18}" font-family="${UI_FONT_FAMILY}" font-size="12.5" fill="#E8ECFF">Command Prompt</text>`,
      // Classic gray square close button [X]
      `  <rect x="${closeX}" y="${closeY}" width="${closeW}" height="${closeH}" fill="#EAEAEA" stroke="#9A9A9A" stroke-width="1"/>`,
      `  <text x="${closeX + closeW / 2}" y="${closeY + 16}" text-anchor="middle" font-family="${UI_FONT_FAMILY}" font-size="12" fill="#111111">X</text>`,
      // Pure black Command Prompt console box
      `  <rect x="${consoleX}" y="${consoleY}" width="${consoleW}" height="${consoleH}" fill="#000000" stroke="#7A7A7A" stroke-width="1"/>`,
      ...scrollParts.map(item => `  ${item}`),
      // Uniform crisp light-gray console text
      `  <g font-family="${MONO_FONT_FAMILY}" font-size="${fontSize}" fill="#EAEAEA">`,
      ...textElements.map(line => `    ${line}`),
      `  </g>`,
      annotationElements.length > 0
        ? `  <g class="annotations">\n${annotationElements.map(item => `    ${item}`).join("\n")}\n  </g>`
        : "",
      // Bottom "☐ Top" checkbox
      ...topCheckboxParts.map(item => `  ${item}`),
      `</svg>`,
    ]
      .filter(Boolean)
      .join("\n") + "\n";
  }

  // -------------------------------------------------------------------------
  // Standard Terminal Themes ("dark", "putty", "high-contrast", or chromeless)
  // -------------------------------------------------------------------------
  const padX = 16;
  const padTop = 14;
  const padBottom = 16;
  const radius = theme.chromeStyle === "print" ? 0 : 8;

  const width = Math.max(360, padX * 2 + contentWidth + annotationGap + annotationWidth);
  const chrome = showChrome
    ? renderStandardChrome(theme, opts.title, width, radius)
    : { svg: "", height: 0 };

  const height = chrome.height + padTop + visualLines.length * lineHeight + padBottom;
  const annX = padX + contentWidth + annotationGap;

  const { textElements, annotationElements } = buildTextAndAnnotations(
    visualLines,
    theme,
    rules,
    annotations,
    padX,
    chrome.height + padTop,
    fontSize,
    lineHeight,
    charW,
    annX,
    annotationWidth,
    false,
  );

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
