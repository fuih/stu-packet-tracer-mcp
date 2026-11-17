/**
 * IOS CLI Prompt and Mode parsing for stu-packet-tracer-mcp.
 */

export type CliMode =
  | "user"
  | "privileged"
  | "config"
  | "config-if"
  | "config-subif"
  | "config-router"
  | "config-line"
  | "config-vlan"
  | "dhcp-config"
  | "cfg-voice"
  | "rommon"
  | "dialog"
  | "unknown";

export interface PromptInfo {
  readonly prompt: string;
  readonly hostname: string;
  readonly mode: CliMode;
}

// Dialog prompt patterns (anchored to the end of output)
const DIALOG_PATTERN = /(?:initial configuration dialog\?\s*\[yes\/no\]:?|\[confirm\]|\[yes\/no\]:?)\s*$/i;

// Mode patterns from tail of line
const PROMPT_REGEX = /(?:^|\r?\n)([\w.\-]+)(?:\(([\w.\-]+)\))?([>#])\s*$/;

export function detectPrompt(text: string): PromptInfo | null {
  if (!text || text.trim().length === 0) return null;

  const trimmed = text.trimEnd();

  if (DIALOG_PATTERN.test(trimmed)) {
    return {
      prompt: trimmed.slice(Math.max(0, trimmed.lastIndexOf("\n") + 1)),
      hostname: "",
      mode: "dialog",
    };
  }

  const match = trimmed.match(PROMPT_REGEX);
  if (!match) return null;

  const hostname = match[1]!;
  const submode = match[2];
  const char = match[3];

  let mode: CliMode = "unknown";
  if (char === ">") {
    if (hostname.toLowerCase().startsWith("rommon")) {
      mode = "rommon";
    } else {
      mode = "user";
    }
  } else if (char === "#") {
    if (!submode) {
      mode = "privileged";
    } else {
      const s = submode.toLowerCase();
      if (s === "config") mode = "config";
      else if (s === "config-if") mode = "config-if";
      else if (s === "config-subif") mode = "config-subif";
      else if (s === "config-router") mode = "config-router";
      else if (s === "config-line") mode = "config-line";
      else if (s === "config-vlan") mode = "config-vlan";
      else if (s === "dhcp-config") mode = "dhcp-config";
      else if (s.startsWith("cfg-")) mode = "cfg-voice";
      else mode = "config";
    }
  }

  return {
    prompt: match[0].trim(),
    hostname,
    mode,
  };
}

export function isPrompt(text: string): boolean {
  return detectPrompt(text) !== null;
}
