import type { Bridge } from "../bridge/http-bridge.js";
import { jsStr } from "../ipc/escape.js";
import { withLabel, truncateForLabel } from "../ipc/label.js";
import { cleanCliOutput, cleanConsoleScrollback } from "./clean.js";
import { detectPrompt, type CliMode } from "./prompt.js";

const NET = "ipc.network()";

export interface RunCliOptions {
  readonly timeoutMs?: number;
  readonly settleMs?: number;
  readonly pollIntervalMs?: number;
  readonly skipPrepare?: boolean;
  readonly allowInteractive?: boolean;
}

export interface CliRunResult {
  readonly device: string;
  readonly command: string;
  readonly mode_before: CliMode;
  readonly mode_after: CliMode;
  readonly prompt: string;
  readonly output: string;
  readonly logs: readonly string[];
  readonly raw: string;
}

const preparedDevices = new Set<string>();
const noTermLengthDevices = new Set<string>();

export function resetCliCache(device?: string): void {
  if (device) {
    preparedDevices.delete(device);
    noTermLengthDevices.delete(device);
  } else {
    preparedDevices.clear();
    noTermLengthDevices.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isLongRunningCommand(cmd: string): boolean {
  const lower = cmd.trim().toLowerCase();
  return (
    lower.startsWith("ping ") ||
    lower.startsWith("traceroute ") ||
    lower.startsWith("tracert ") ||
    lower.startsWith("copy ") ||
    lower.startsWith("crypto key generate")
  );
}

export function readCliTailJs(deviceName: string, chars = 300): string {
  return withLabel(
    `Reading CLI tail of ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `if(!cl)return "ERR:no_cli";` +
      `var out=String(cl.getOutput()||"");` +
      `var len=out.length;` +
      `var tail=len>${chars}?out.substring(len-${chars}):out;` +
      `return JSON.stringify({len:len,tail:tail});` +
    `})()`,
  );
}

export function sendCliPagerKeyJs(deviceName: string, charCode: number, fallbackCmd: string): string {
  return withLabel(
    `Sending CLI pager key (${fallbackCmd === " " ? "Space" : fallbackCmd}) to ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `if(!cl)return "ERR:no_cli";` +
      `if(typeof cl.enterChar==="function"){` +
        `try{cl.enterChar(${charCode},0);return "OK:char";}catch(e){}` +
      `}` +
      `cl.enterCommand(${jsStr(fallbackCmd)});` +
      `return "OK:cmd";` +
    `})()`,
  );
}

export function enterCommandOffsetJs(deviceName: string, command: string, anchorLen = 120): string {
  return withLabel(
    `CLI ${deviceName} → ${truncateForLabel(command)}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `if(!cl)return "ERR:no_cli";` +
      `var out0=String(cl.getOutput()||"");` +
      `var before=out0.length;` +
      `var anchor=before>${anchorLen}?out0.substring(before-${anchorLen}):out0;` +
      `cl.enterCommand(${jsStr(command)});` +
      `var after=String(cl.getOutput()||"");` +
      `if(anchor&&after.length>=before&&after.substring(before-anchor.length,before)===anchor){` +
        `return before+"|"+after.substring(before);` +
      `}` +
      `if(anchor){` +
        `var idx=after.lastIndexOf(anchor);` +
        `if(idx>=0){var off=idx+anchor.length;return off+"|"+after.substring(off);}` +
      `}` +
      `return before+"|"+after.substring(before);` +
    `})()`,
  );
}

export function readCliSliceJs(deviceName: string, offset: number, anchor = ""): string {
  const safeOffset = Math.max(0, Math.floor(offset));
  return withLabel(
    `Reading CLI output slice of ${deviceName}`,
    `(function(){` +
      `var d=${NET}.getDevice(${jsStr(deviceName)});` +
      `if(!d)return "ERR:not_found";` +
      `var cl=d.getCommandLine();` +
      `if(!cl)return "ERR:no_cli";` +
      `var out=String(cl.getOutput()||"");` +
      `var a=${jsStr(anchor)};` +
      `if(a){` +
        `var off=${safeOffset};` +
        `if(off>=a.length&&out.substring(off-a.length,off)===a)return out.substring(off);` +
        `var idx=out.lastIndexOf(a);` +
        `if(idx>=0)return out.substring(idx+a.length);` +
      `}` +
      `return out.substring(${safeOffset});` +
    `})()`,
  );
}

function endsWithMore(text: string): boolean {
  return /--More--\s*$/.test(text);
}

function endsWithUnexpectedPrompt(text: string): boolean {
  const trimmed = text.trimEnd();
  return /(?:\[confirm\]|\[yes\/no\]:?)\s*$/i.test(trimmed);
}

async function readTail(bridge: Bridge, device: string, chars = 300): Promise<{ len: number; tail: string }> {
  const res = await bridge.sendAndWait(readCliTailJs(device, chars), { timeoutMs: 8_000 });
  if (res === null) throw new Error(`Timed out reading CLI tail of "${device}".`);
  if (res.startsWith("ERR:")) throw new Error(`Device "${device}" error: ${res}`);
  try {
    return JSON.parse(res) as { len: number; tail: string };
  } catch {
    return { len: res.length, tail: res };
  }
}

/**
 * Read and clean the live Packet Tracer console scrollback buffer (IOS CLI or PC
 * Command Prompt), returning the bottom `maxLines` lines as they appear in PT.
 */
export async function readConsoleScrollback(
  bridge: Bridge,
  device: string,
  maxLines = 42,
  fallbackPrompt?: string,
  maxChars = 16_000,
): Promise<string[]> {
  const { len, tail } = await readTail(bridge, device, maxChars);
  return cleanConsoleScrollback(tail, maxLines, {
    dropFirstPartialLine: len > maxChars,
    fallbackPrompt,
  });
}

/**
 * Prepare a device once per session:
 *  - Dismiss initial configuration dialog (`[yes/no]` -> `no`)
 *  - Dismiss any lingering `--More--`
 *  - Enter privileged EXEC mode (`enable`) if in user mode (`>`)
 *  - Attempt `terminal length 0` (remembering if unsupported)
 */
export async function prepareDevice(bridge: Bridge, device: string): Promise<void> {
  if (preparedDevices.has(device)) return;

  let { tail } = await readTail(bridge, device);

  // Dismiss lingering --More--
  if (endsWithMore(tail)) {
    await bridge.sendAndWait(sendCliPagerKeyJs(device, 113, "q"), { timeoutMs: 5_000 });
    await sleep(150);
    ({ tail } = await readTail(bridge, device));
  }

  // Dismiss initial config dialog if currently active at the tail
  if (/initial configuration dialog\?\s*\[yes\/no\]:?\s*$/i.test(tail.trimEnd())) {
    await bridge.sendAndWait(enterCommandOffsetJs(device, "no"), { timeoutMs: 8_000 });
    await sleep(400);
    await bridge.sendAndWait(enterCommandOffsetJs(device, ""), { timeoutMs: 5_000 });
    await sleep(300);
    ({ tail } = await readTail(bridge, device));
  }

  // Nudge empty CLI to get a prompt
  let pInfo = detectPrompt(tail);
  if (!pInfo) {
    await bridge.sendAndWait(enterCommandOffsetJs(device, ""), { timeoutMs: 5_000 });
    await sleep(250);
    ({ tail } = await readTail(bridge, device));
    pInfo = detectPrompt(tail);
  }

  // If in user EXEC mode, elevate to privileged EXEC
  if (pInfo?.mode === "user") {
    await bridge.sendAndWait(enterCommandOffsetJs(device, "enable"), { timeoutMs: 8_000 });
    await sleep(200);
    ({ tail } = await readTail(bridge, device));
    pInfo = detectPrompt(tail);
  }

  // Try `terminal length 0` if in privileged mode
  if (pInfo?.mode === "privileged" && !noTermLengthDevices.has(device)) {
    const reply = await bridge.sendAndWait(enterCommandOffsetJs(device, "terminal length 0"), { timeoutMs: 8_000 });
    if (reply && (reply.includes("% Invalid") || reply.includes("^"))) {
      noTermLengthDevices.add(device);
    }
    await sleep(100);
  }

  preparedDevices.add(device);
}

/**
 * Execute a single CLI command cleanly on a Packet Tracer device, handling:
 *  - Lingering `--More--` clearance before execution (preventing eaten characters)
 *  - Mid-output `--More--` pagination (automatically sending Space until complete)
 *  - Settling until IOS prompt returns and output stabilizes
 *  - Stripping echoed command, pager artifacts, trailing prompt, and separating syslogs
 */
export async function runCli(
  bridge: Bridge,
  device: string,
  command: string,
  opts: RunCliOptions = {},
): Promise<CliRunResult> {
  if (!opts.skipPrepare) {
    await prepareDevice(bridge, device);
  }

  // Pre-flight check on tail
  let { tail } = await readTail(bridge, device);

  // If previous output left the pager at --More--, dismiss with 'q' so the
  // first character of our new command isn't eaten!
  if (endsWithMore(tail)) {
    await bridge.sendAndWait(sendCliPagerKeyJs(device, 113, "q"), { timeoutMs: 5_000 });
    await sleep(150);
    ({ tail } = await readTail(bridge, device));
  }

  if (!opts.allowInteractive && endsWithUnexpectedPrompt(tail)) {
    throw new Error(
      `Device "${device}" is waiting at an interactive prompt ("${tail.trim().slice(-60)}"). ` +
      `Send an explicit response or pass allowInteractive: true.`,
    );
  }

  const modeBefore: CliMode = detectPrompt(tail)?.mode ?? "unknown";

  // Anchor tail before sending command so ring-buffered scrollback trims cannot zero out offset
  const preAnchor = tail.length > 120 ? tail.slice(-120) : tail;
  const defaultSettle = isLongRunningCommand(command) ? 25_000 : 2_000;
  const settleMs = opts.settleMs ?? defaultSettle;
  const pollIntervalMs = opts.pollIntervalMs ?? 120;
  const rpcTimeout = opts.timeoutMs ?? Math.max(15_000, settleMs + 5_000);

  // Dispatch command and capture starting byte offset
  const initialRes = await bridge.sendAndWait(enterCommandOffsetJs(device, command), {
    timeoutMs: rpcTimeout,
  });
  if (initialRes === null) {
    throw new Error(`Timed out sending CLI command "${command}" to "${device}".`);
  }
  if (initialRes.startsWith("ERR:")) {
    throw new Error(`Device "${device}" error: ${initialRes}`);
  }

  const sepIdx = initialRes.indexOf("|");
  const beforeOffset = sepIdx >= 0 ? Number(initialRes.slice(0, sepIdx)) : 0;
  let rawSlice = sepIdx >= 0 ? initialRes.slice(sepIdx + 1) : initialRes;

  let deadline = Date.now() + settleMs;
  const hardDeadline = Date.now() + Math.max(45_000, settleMs * 2);
  let stableCount = 0;
  let lastLen = rawSlice.length;
  let pagesSent = 0;
  const maxPages = 60;

  // Poll until prompt returns and stabilizes, handling --More-- pages along the way
  while (Date.now() < deadline && Date.now() < hardDeadline) {
    if (endsWithMore(rawSlice) && pagesSent < maxPages) {
      pagesSent++;
      await bridge.sendAndWait(sendCliPagerKeyJs(device, 32, " "), { timeoutMs: 5_000 });
      await sleep(pollIntervalMs);
      const nextSlice = await bridge.sendAndWait(readCliSliceJs(device, beforeOffset, preAnchor), { timeoutMs: 5_000 });
      if (nextSlice !== null && !nextSlice.startsWith("ERR:")) {
        rawSlice = nextSlice;
        lastLen = rawSlice.length;
        stableCount = 0;
      }
      // Extend settle deadline as pagination makes forward progress
      deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + 3_000));
      continue;
    }

    const pInfo = detectPrompt(rawSlice);
    if (pInfo && pInfo.mode !== "dialog") {
      if (rawSlice.length === lastLen) {
        stableCount++;
        if (stableCount >= 2) break;
      } else {
        lastLen = rawSlice.length;
        stableCount = 0;
      }
    }

    await sleep(pollIntervalMs);
    const nextSlice = await bridge.sendAndWait(readCliSliceJs(device, beforeOffset, preAnchor), { timeoutMs: 5_000 });
    if (nextSlice !== null && !nextSlice.startsWith("ERR:")) {
      if (nextSlice.length !== lastLen) {
        rawSlice = nextSlice;
        lastLen = rawSlice.length;
        stableCount = 0;
        deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + 2_000));
      } else {
        rawSlice = nextSlice;
        if (detectPrompt(rawSlice)) {
          stableCount++;
          if (stableCount >= 2) break;
        }
      }
    }
  }

  const cleaned = cleanCliOutput(rawSlice, command);
  const modeAfter: CliMode = cleaned.prompt
    ? (detectPrompt(cleaned.prompt)?.mode ?? modeBefore)
    : (detectPrompt(rawSlice)?.mode ?? modeBefore);

  return {
    device,
    command,
    mode_before: modeBefore,
    mode_after: modeAfter,
    prompt: cleaned.prompt,
    output: cleaned.output,
    logs: cleaned.logs,
    raw: rawSlice,
  };
}

/**
 * Ensure the device CLI is in the requested IOS mode (`privileged` or `config`).
 */
export async function ensureMode(
  bridge: Bridge,
  device: string,
  target: "privileged" | "config",
): Promise<CliMode> {
  await prepareDevice(bridge, device);
  const { tail } = await readTail(bridge, device);
  let current = detectPrompt(tail)?.mode ?? "unknown";

  if (target === "privileged") {
    if (current === "privileged") return current;
    if (current === "user") {
      const r = await runCli(bridge, device, "enable", { skipPrepare: true, settleMs: 1_000 });
      return r.mode_after;
    }
    if (current.startsWith("config") || current === "dhcp-config" || current === "cfg-voice") {
      const r = await runCli(bridge, device, "end", { skipPrepare: true, settleMs: 1_000 });
      return r.mode_after;
    }
    return current;
  }

  // target === "config"
  if (current === "config") return current;
  if (current !== "privileged") {
    current = await ensureMode(bridge, device, "privileged");
  }
  if (current === "privileged") {
    const r = await runCli(bridge, device, "configure terminal", { skipPrepare: true, settleMs: 1_000 });
    return r.mode_after;
  }
  return current;
}
