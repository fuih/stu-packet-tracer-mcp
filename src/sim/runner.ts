/**
 * Live execution helpers for the simulation/ops layer (Phase 8).
 *
 * The Script Engine in PT 9 dispatches one expression at a time and returns
 * synchronously, so async commands like ping/traceroute can't be awaited
 * inside a single JS round-trip — the device just queues the command and
 * keeps cooking. The pattern mirrors `scripts/smoke.ts`:
 *
 *  1) push the command via `enterCommandJs`
 *  2) poll `getCommandLine().getOutput()` with a tiny JS reader that returns
 *     the slice since the command marker
 *  3) stop when a known terminator appears (or the deadline hits)
 *
 * The terminators are stable across PT 9 transcripts (see `parsers.ts`):
 *  - PC ping: "Ping statistics for"
 *  - Router IOS ping: "Success rate is"
 *  - PC tracert: "Trace complete." / "Trace terminated."
 *  - Router IOS traceroute: "* * *" repeated, or last hop reaching target
 *  - show running-config (any IOS device): the prompt returns at end
 */

import type { Bridge } from "../bridge/http-bridge.js";
import { ensureMode, runCli } from "../cli/engine.js";
import { enterCommandJs } from "../ipc/generator.js";
import { jsStr } from "../ipc/escape.js";
import { withLabel, truncateForLabel } from "../ipc/label.js";
import { parsePing, parseTraceroute, type PingResult, type TracerouteResult } from "./parsers.js";

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_POLL = 300;

function readSinceMarkerJs(device: string, marker: string): string {
  return withLabel(
    `Reading CLI output of ${device} since marker "${truncateForLabel(marker, 30)}"`,
    `(function(){` +
      `var d=ipc.network().getDevice(${jsStr(device)});` +
      `if(!d)return "ERR:not_found";` +
      `var out=d.getCommandLine().getOutput();` +
      `var marker=${jsStr(marker)};` +
      `var i=out.lastIndexOf(marker);` +
      `return i>=0?out.substring(i):out;` +
    `})()`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send `command` to `device` and poll the CLI output until any of `done`
 * regexes matches the slice produced after the command, or the deadline
 * expires. Returns the captured slice (raw transcript including the echoed
 * command line).
 */
async function runAndWait(
  bridge: Bridge,
  device: string,
  command: string,
  done: readonly RegExp[],
  opts: RunOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL;

  const sent = await bridge.sendAndWait(enterCommandJs(device, command), { timeoutMs: 10_000 });
  if (sent === null) throw new Error(`Bridge timeout sending '${command}' to ${device}.`);
  if (sent.startsWith("ERR:") || sent.startsWith("ERROR:")) {
    throw new Error(`PT raised on '${command}' (${device}): ${sent}`);
  }

  const deadline = Date.now() + timeoutMs;
  let last = sent;
  while (Date.now() < deadline) {
    const slice = await bridge.sendAndWait(readSinceMarkerJs(device, command), { timeoutMs: 8_000 });
    if (slice !== null && !slice.startsWith("ERR:") && !slice.startsWith("ERROR:")) {
      last = slice;
      if (done.some(re => re.test(last))) return last;
    }
    await sleep(pollIntervalMs);
  }
  return last;
}

const PING_DONE = [/Ping statistics for/i, /Success rate is/i, /Destination host unreachable/i];
const TRACE_DONE = [/Trace complete\./i, /Trace terminated/i, /Success rate is/i];

export async function runPing(
  bridge: Bridge,
  device: string,
  target: string,
  opts: RunOptions = {},
): Promise<{ raw: string; result: PingResult }> {
  const cmd = `ping ${target}`;
  const raw = await runAndWait(bridge, device, cmd, PING_DONE, {
    timeoutMs: opts.timeoutMs ?? 25_000,
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL,
  });
  return { raw, result: parsePing(raw, target) };
}

export interface ParallelPingJob {
  readonly device: string;
  readonly target: string;
}

export interface ParallelPingOutcome {
  readonly device: string;
  readonly target: string;
  readonly raw: string;
  readonly result: PingResult;
}

function startPingsBatchJs(jobs: readonly ParallelPingJob[]): string {
  const payload = JSON.stringify(jobs.map(j => ({ device: j.device, target: j.target })));
  return withLabel(
    `Launching ${jobs.length} parallel ping(s)`,
    `(function(){` +
      `var jobs=${payload};` +
      `var res=[];` +
      `for(var i=0;i<jobs.length;i++){` +
        `var j=jobs[i];` +
        `var d=ipc.network().getDevice(j.device);` +
        `if(!d){res.push({ok:false,offset:0,anchor:"",slice:"ERR:not_found"});continue;}` +
        `var cl=d.getCommandLine();` +
        `if(!cl){res.push({ok:false,offset:0,anchor:"",slice:"ERR:no_cli"});continue;}` +
        `var out0=String(cl.getOutput()||"");` +
        `var before=out0.length;` +
        `var anchor=before>80?out0.substring(before-80):out0;` +
        `cl.enterCommand("ping "+j.target);` +
        `var after=String(cl.getOutput()||"");` +
        `var slice="";` +
        `if(anchor&&after.length>=before&&after.substring(before-anchor.length,before)===anchor){` +
          `slice=after.substring(before);` +
        `}else if(anchor){` +
          `var idx=after.lastIndexOf(anchor);` +
          `slice=idx>=0?after.substring(idx+anchor.length):after.substring(before);` +
        `}else{slice=after.substring(before);}` +
        `res.push({ok:true,offset:before,anchor:anchor,slice:slice});` +
      `}` +
      `return JSON.stringify(res);` +
    `})()`,
  );
}

function readPingSlicesBatchJs(
  pending: ReadonlyArray<{ readonly index: number; readonly device: string; readonly offset: number; readonly anchor: string }>,
): string {
  const payload = JSON.stringify(pending);
  return withLabel(
    `Polling ${pending.length} active ping(s)`,
    `(function(){` +
      `var items=${payload};` +
      `var res=[];` +
      `for(var i=0;i<items.length;i++){` +
        `var it=items[i];` +
        `var d=ipc.network().getDevice(it.device);` +
        `if(!d){res.push({index:it.index,slice:""});continue;}` +
        `var cl=d.getCommandLine();` +
        `if(!cl){res.push({index:it.index,slice:""});continue;}` +
        `var out=String(cl.getOutput()||"");` +
        `var slice="";` +
        `if(it.anchor){` +
          `if(it.offset>=it.anchor.length&&out.substring(it.offset-it.anchor.length,it.offset)===it.anchor){` +
            `slice=out.substring(it.offset);` +
          `}else{` +
            `var idx=out.lastIndexOf(it.anchor);` +
            `slice=idx>=0?out.substring(idx+it.anchor.length):out.substring(it.offset);` +
          `}` +
        `}else{slice=out.substring(it.offset);}` +
        `res.push({index:it.index,slice:slice});` +
      `}` +
      `return JSON.stringify(res);` +
    `})()`,
  );
}

/**
 * Execute multiple pings concurrently across distinct source devices in a single
 * batched IPC start + batched poll loop.
 */
export async function runPingsParallel(
  bridge: Bridge,
  jobs: readonly ParallelPingJob[],
  opts: RunOptions = {},
): Promise<ParallelPingOutcome[]> {
  if (jobs.length === 0) return [];
  if (jobs.length === 1) {
    const j = jobs[0]!;
    const { raw, result } = await runPing(bridge, j.device, j.target, opts);
    return [{ device: j.device, target: j.target, raw, result }];
  }

  const timeoutMs = opts.timeoutMs ?? 25_000;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL;

  const startRaw = await bridge.sendAndWait(startPingsBatchJs(jobs), { timeoutMs: 12_000 });
  if (startRaw === null) {
    throw new Error(`Bridge timeout launching ${jobs.length} parallel ping(s).`);
  }

  interface StartedItem {
    ok: boolean;
    offset: number;
    anchor: string;
    slice: string;
  }
  let started: StartedItem[];
  try {
    started = JSON.parse(startRaw) as StartedItem[];
  } catch {
    // Fallback sequentially if reply was unexpected (e.g. custom mock bridge)
    const fallback: ParallelPingOutcome[] = [];
    for (const j of jobs) {
      const { raw, result } = await runPing(bridge, j.device, j.target, opts);
      fallback.push({ device: j.device, target: j.target, raw, result });
    }
    return fallback;
  }

  const states = jobs.map((job, idx) => {
    const s = started[idx] ?? { ok: false, offset: 0, anchor: "", slice: "" };
    const done = !s.ok || PING_DONE.some(re => re.test(s.slice));
    return {
      index: idx,
      device: job.device,
      target: job.target,
      offset: s.offset,
      anchor: s.anchor,
      raw: s.slice,
      done,
    };
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = states.filter(s => !s.done);
    if (active.length === 0) break;

    await sleep(pollIntervalMs);
    const pollRaw = await bridge.sendAndWait(
      readPingSlicesBatchJs(
        active.map(a => ({ index: a.index, device: a.device, offset: a.offset, anchor: a.anchor })),
      ),
      { timeoutMs: 10_000 },
    );
    if (!pollRaw || !pollRaw.startsWith("[")) continue;
    try {
      const updates = JSON.parse(pollRaw) as Array<{ index: number; slice: string }>;
      for (const u of updates) {
        const st = states[u.index];
        if (!st || st.done) continue;
        if (u.slice) {
          st.raw = u.slice;
          if (PING_DONE.some(re => re.test(st.raw))) {
            st.done = true;
          }
        }
      }
    } catch {
      // ignore malformed poll reply and retry before deadline
    }
  }

  return states.map(s => ({
    device: s.device,
    target: s.target,
    raw: s.raw,
    result: parsePing(s.raw, s.target),
  }));
}

export async function runTraceroute(
  bridge: Bridge,
  device: string,
  target: string,
  opts: RunOptions = {},
): Promise<{ raw: string; result: TracerouteResult }> {
  // PC uses `tracert`, IOS routers use `traceroute`. Send both — the wrong
  // one prints `Invalid input` and is ignored; the right one runs. This
  // keeps the tool agnostic to device type without an extra IPC round-trip
  // to introspect the device kind.
  const cmd = `traceroute ${target}`;
  const tracert = `tracert ${target}`;
  // Send `traceroute` first (works on routers), then `tracert` after a
  // short delay (works on PCs). The poller waits for either terminator.
  const sent1 = await bridge.sendAndWait(enterCommandJs(device, cmd), { timeoutMs: 10_000 });
  if (sent1 === null) throw new Error(`Bridge timeout sending '${cmd}' to ${device}.`);
  await sleep(300);
  await bridge.sendAndWait(enterCommandJs(device, tracert), { timeoutMs: 10_000 });

  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let last = "";
  while (Date.now() < deadline) {
    // Read since the earliest of the two echoed commands.
    const slice = await bridge.sendAndWait(readSinceMarkerJs(device, "race"), { timeoutMs: 8_000 });
    if (slice !== null && !slice.startsWith("ERR:") && !slice.startsWith("ERROR:")) {
      last = slice;
      if (TRACE_DONE.some(re => re.test(last))) break;
    }
    await sleep(opts.pollIntervalMs ?? DEFAULT_POLL);
  }
  return { raw: last, result: parseTraceroute(last, target) };
}

/**
 * Execute `show running-config` (optionally filtered by a `| section`
 * pattern) on a single device through the resilient CLI engine.
 * Automatically enters privileged mode and advances `--More--` pagination
 * on switches/routers that reject `terminal length 0`.
 */
export async function runShowRunning(
  bridge: Bridge,
  device: string,
  section?: string,
  tailChars = 20_000,
): Promise<string> {
  await ensureMode(bridge, device, "privileged");
  const cmd = section ? `show running-config | section ${section}` : "show running-config";
  const res = await runCli(bridge, device, cmd, { settleMs: 6_000, timeoutMs: 30_000 });
  if (tailChars > 0 && res.output.length > tailChars) {
    return res.output.slice(-tailChars);
  }
  return res.output;
}

/**
 * `show running-config | include <pattern>` — filtered running-config
 * lookup routed through the resilient CLI engine.
 */
export async function runShowRunningInclude(
  bridge: Bridge,
  device: string,
  pattern: string,
  tailChars = 8_000,
): Promise<string> {
  await ensureMode(bridge, device, "privileged");
  const cmd = `show running-config | include ${pattern}`;
  const res = await runCli(bridge, device, cmd, { settleMs: 4_000, timeoutMs: 30_000 });
  if (tailChars > 0 && res.output.length > tailChars) {
    return res.output.slice(-tailChars);
  }
  return res.output;
}
