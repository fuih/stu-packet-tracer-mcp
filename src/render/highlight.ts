import type { TerminalTheme } from "./themes.js";

export interface HighlightRule {
  readonly pattern: RegExp;
  readonly color?: string;
  readonly bold?: boolean;
}

export interface TextSpan {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
}

/**
 * Default Cisco IOS & Windows Command Prompt syntax highlighting rules.
 */
export function buildDefaultHighlightRules(theme: TerminalTheme): readonly HighlightRule[] {
  if (theme.plainText) {
    return [];
  }
  return [
    // IOS / Windows prompts at start of line
    {
      pattern: /^(?:[A-Za-z0-9_.\-]+(?:\([A-Za-z0-9_.\-]+\))?[>#]|[A-Za-z]:\\[^>]*>)/,
      color: theme.promptColor,
      bold: true,
    },
    // Ping success & 100% rate
    {
      pattern: /\b(?:Reply from|Success rate is 100 percent)\b/g,
      color: theme.successColor,
      bold: true,
    },
    // Errors, timeouts, unreachable, administratively down
    {
      pattern: /(?:Request timed out\.?|Destination host unreachable\.?|% Invalid input[^\n]*|% Incomplete command\.?|% Ambiguous command[^\n]*|administratively down)/gi,
      color: theme.errorColor,
      bold: true,
    },
    // Cisco routing table codes at start of line (C, L, S, S*, R, O, O IA, D, B)
    {
      pattern: /^(?:[CSLRODB]\*?(?:\s+(?:IA|E1|E2|N1|N2|EX))?)(?=\s+\d)/,
      color: theme.accentColor,
      bold: true,
    },
    // Interface status keywords in `show ip interface brief`
    {
      pattern: /\bup\b/g,
      color: theme.successColor,
      bold: false,
    },
    {
      pattern: /\bdown\b/g,
      color: theme.errorColor,
      bold: false,
    },
  ];
}

interface MatchSpan {
  start: number;
  end: number;
  color?: string;
  bold?: boolean;
  priority: number;
}

/**
 * Split a single line into non-overlapping highlighted spans according to
 * priority-ordered regex rules (earlier rules win on overlap).
 */
export function highlightLine(
  line: string,
  rules: readonly HighlightRule[],
): readonly TextSpan[] {
  if (!line || rules.length === 0) {
    return [{ text: line }];
  }

  const matches: MatchSpan[] = [];

  for (let p = 0; p < rules.length; p++) {
    const rule = rules[p]!;
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const re = new RegExp(rule.pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        color: rule.color,
        bold: rule.bold,
        priority: p,
      });
      if (!rule.pattern.flags.includes("g")) break;
    }
  }

  if (matches.length === 0) {
    return [{ text: line }];
  }

  // Sort by priority first, then start position, and greedily pick non-overlapping matches
  matches.sort((a, b) => a.priority - b.priority || a.start - b.start);
  const chosen: MatchSpan[] = [];
  for (const cand of matches) {
    const overlaps = chosen.some(c => cand.start < c.end && cand.end > c.start);
    if (!overlaps) chosen.push(cand);
  }
  chosen.sort((a, b) => a.start - b.start);

  const spans: TextSpan[] = [];
  let cursor = 0;
  for (const seg of chosen) {
    if (seg.start > cursor) {
      spans.push({ text: line.slice(cursor, seg.start) });
    }
    spans.push({
      text: line.slice(seg.start, seg.end),
      color: seg.color,
      bold: seg.bold,
    });
    cursor = seg.end;
  }
  if (cursor < line.length) {
    spans.push({ text: line.slice(cursor) });
  }

  return spans;
}
