import type { Bridge } from "../bridge/http-bridge.js";
import { listDevicesJs } from "../ipc/generator.js";
import { ptError } from "./errors.js";

/**
 * Compute the classic Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = 1 + Math.min(
          dp[i - 1]![j]!,
          dp[i]![j - 1]!,
          dp[i - 1]![j - 1]!,
        );
      }
    }
  }
  return dp[m]![n]!;
}

export interface ResolveDeviceResult {
  readonly found: boolean;
  readonly name?: string;
  readonly suggested?: string;
  readonly available: readonly string[];
}

/**
 * Resolve a candidate device name against a list of known device names:
 *  1. Exact match (case-sensitive)
 *  2. Case-insensitive match (e.g. "r1" -> "R1")
 *  3. Fuzzy match: Levenshtein distance <= 2 (e.g. "Routr1" -> "Router1")
 */
export function resolveDeviceName(
  candidate: string,
  existingDevices: readonly string[],
): ResolveDeviceResult {
  // 1. Exact match
  if (existingDevices.includes(candidate)) {
    return { found: true, name: candidate, available: existingDevices };
  }

  // 2. Case-insensitive match
  const lowerCandidate = candidate.toLowerCase();
  const caseMatch = existingDevices.find(d => d.toLowerCase() === lowerCandidate);
  if (caseMatch) {
    return { found: true, name: caseMatch, available: existingDevices };
  }

  // 3. Levenshtein <= 2
  let bestCandidate: string | undefined;
  let minDistance = 3;
  for (const d of existingDevices) {
    const dist = levenshteinDistance(lowerCandidate, d.toLowerCase());
    if (dist <= 2 && dist < minDistance) {
      minDistance = dist;
      bestCandidate = d;
    }
  }

  return {
    found: false,
    suggested: bestCandidate,
    available: existingDevices,
  };
}

/**
 * Format a helpful "Device not found" message with suggestions and available devices.
 */
export function formatDeviceNotFound(candidate: string, existingDevices: readonly string[]): string {
  const res = resolveDeviceName(candidate, existingDevices);
  if (res.found && res.name) return res.name;

  let msg = `Device "${candidate}" not found on the canvas.`;
  if (res.suggested) {
    msg += ` Did you mean "${res.suggested}"?`;
  }
  if (res.available.length > 0) {
    msg += ` Available: ${res.available.join(", ")}.`;
  } else {
    msg += ` No devices currently on the canvas.`;
  }
  return msg;
}

const DEVICE_CACHE_TTL_MS = 5_000;
let deviceCacheEpoch = 0;
const deviceNameCache = new WeakMap<
  Bridge,
  { readonly names: string[]; readonly fetchedAt: number; readonly epoch: number }
>();

/**
 * Invalidate cached canvas device names after any topology mutation
 * (add/delete/rename/clear/open). Calling with no arguments invalidates all bridges.
 */
export function invalidateDeviceCache(bridge?: Bridge): void {
  if (bridge) {
    deviceNameCache.delete(bridge);
  } else {
    deviceCacheEpoch += 1;
  }
}

/**
 * Populate the short-lived device-name cache from an already-fetched device list
 * (for example, right after captureSnapshot).
 */
export function primeDeviceCache(bridge: Bridge, names: readonly string[]): void {
  deviceNameCache.set(bridge, {
    names: [...names],
    fetchedAt: Date.now(),
    epoch: deviceCacheEpoch,
  });
}

/**
 * Fetch all device names currently placed on the Packet Tracer canvas.
 * Uses a short 5-second per-bridge cache unless `force: true` is passed.
 */
export async function fetchCanvasDeviceNames(
  bridge: Bridge,
  opts: { readonly force?: boolean } = {},
): Promise<string[]> {
  if (!opts.force) {
    const cached = deviceNameCache.get(bridge);
    if (
      cached &&
      cached.epoch === deviceCacheEpoch &&
      Date.now() - cached.fetchedAt < DEVICE_CACHE_TTL_MS
    ) {
      return cached.names;
    }
  }

  const reply = await bridge.sendAndWait(listDevicesJs(), { timeoutMs: 8_000 });
  if (!reply || reply.startsWith("ERR:") || reply.startsWith("ERROR:")) {
    return [];
  }
  const lines = reply.trim().split("\n");
  if (lines.length <= 1) {
    primeDeviceCache(bridge, []);
    return [];
  }
  const names: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const parts = line.split("|");
    const name = parts[0]?.trim();
    if (name) names.push(name);
  }
  primeDeviceCache(bridge, names);
  return names;
}

/**
 * Resolve a candidate device name against the live Packet Tracer canvas.
 * Fast-paths hits from the 5s cache; on any miss, refreshes live from PT before
 * throwing a formatted PtError with Levenshtein suggestions.
 */
export async function resolveCanvasDevice(bridge: Bridge, candidate: string): Promise<string> {
  const cached = await fetchCanvasDeviceNames(bridge);
  if (cached.length > 0) {
    const hit = resolveDeviceName(candidate, cached);
    if (hit.found && hit.name) {
      return hit.name;
    }
  }

  const fresh = await fetchCanvasDeviceNames(bridge, { force: true });
  if (fresh.length === 0) {
    // If we couldn't list devices or canvas is empty, return candidate as-is
    return candidate;
  }
  const res = resolveDeviceName(candidate, fresh);
  if (res.found && res.name) {
    return res.name;
  }
  const msg = formatDeviceNotFound(candidate, fresh);
  throw ptError("DEVICE_NOT_FOUND", msg, "Use pt_query_topology to inspect canvas devices.");
}
