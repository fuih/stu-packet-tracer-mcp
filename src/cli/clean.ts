import { detectPrompt } from "./prompt.js";

export interface CleanedCliOutput {
  readonly output: string;
  readonly logs: readonly string[];
  readonly prompt: string;
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
// Matches `--More--` plus surrounding spaces, backspaces, and carriage returns
const MORE_PAGER_REGEX = /[ \t]*--More--[\x08 \t\r]*/g;
// Matches standard Cisco IOS syslog lines (with or without timestamp)
const SYSLOG_REGEX = /^(?:\*?[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+(?:\.\d+)?:\s+)?%[A-Z0-9_]+-\d+-[A-Z0-9_]+:/;

function applyBackspaces(str: string): string {
  if (!str.includes("\x08")) return str;
  const chars: string[] = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (ch === "\x08") {
      if (chars.length > 0 && chars[chars.length - 1] !== "\n") {
        chars.pop();
      }
    } else {
      chars.push(ch);
    }
  }
  return chars.join("");
}

/**
 * Clean raw IOS CLI output:
 *  - Strips ANSI codes and `--More--` pager artifacts + backspaces
 *  - Extracts Cisco syslog lines (`%LINK-5-CHANGED...`) into `logs[]`
 *  - Strips echoed command from the top
 *  - Extracts and strips trailing IOS prompt
 */
export function cleanCliOutput(raw: string, command: string): CleanedCliOutput {
  if (!raw) {
    return { output: "", logs: [], prompt: "" };
  }

  let text = raw.replace(ANSI_REGEX, "");
  text = text.replace(MORE_PAGER_REGEX, "");
  text = applyBackspaces(text);
  // Normalize line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const rawLines = text.split("\n");
  const logs: string[] = [];
  const filteredLines: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (SYSLOG_REGEX.test(trimmed)) {
      logs.push(trimmed);
    } else {
      filteredLines.push(line);
    }
  }

  // Strip leading empty lines
  while (filteredLines.length > 0 && filteredLines[0]!.trim() === "") {
    filteredLines.shift();
  }

  // Strip echoed command line if present at the top
  const cmdTrimmed = command.trim();
  if (cmdTrimmed.length > 0 && filteredLines.length > 0) {
    const firstLine = filteredLines[0]!.trim();
    if (
      firstLine === cmdTrimmed ||
      firstLine.endsWith(`>${cmdTrimmed}`) ||
      firstLine.endsWith(`#${cmdTrimmed}`) ||
      firstLine.endsWith(`> ${cmdTrimmed}`) ||
      firstLine.endsWith(`# ${cmdTrimmed}`)
    ) {
      filteredLines.shift();
    }
  }

  // Strip trailing empty lines before checking prompt
  while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1]!.trim() === "") {
    filteredLines.pop();
  }

  // Extract trailing prompt if present
  let prompt = "";
  if (filteredLines.length > 0) {
    const lastLine = filteredLines[filteredLines.length - 1]!;
    const pInfo = detectPrompt(lastLine);
    if (pInfo && pInfo.mode !== "dialog") {
      prompt = pInfo.prompt;
      filteredLines.pop();
    }
  }

  // Final trim of leading/trailing blank lines in body
  while (filteredLines.length > 0 && filteredLines[0]!.trim() === "") {
    filteredLines.shift();
  }
  while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1]!.trim() === "") {
    filteredLines.pop();
  }

  return {
    output: filteredLines.join("\n"),
    logs,
    prompt,
  };
}
