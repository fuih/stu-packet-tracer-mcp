/**
 * Single source of truth for "what model is this live device?".
 *
 * Identified empirically 2026-05-01 by scripts/probe-model-api.ts:
 *   d.getModel() returns the exact ptType ("1941", "ISR4321", "2950-24")
 *   on every router and switch tested.
 *
 * Earlier code used d.getClassName() — that returns the generic JS class
 * ("Router" for ALL ISR routers, "CiscoDevice" for L2/L3 switches), not
 * the model. Using getClassName broke two pre-flight checks silently:
 *   1. resolveSlotCatalogKey() never matched any catalog key, so
 *      pt_add_module skipped chassis-specific bay/family validation.
 *   2. classRejectsEncapsulation() regex /(2950|2960)/ never matched
 *      "CiscoDevice", so pt_run_cli_bulk never stripped the unsupported
 *      `switchport trunk encapsulation` line on 2950/2960.
 * The switch to getModel() restores both checks.
 */

import type { Bridge } from "../bridge/http-bridge.js";

const MODEL_CACHE_TTL_MS = 15_000;
let modelCacheEpoch = 0;
const modelCache = new WeakMap<
  Bridge,
  Map<string, { readonly model: string; readonly fetchedAt: number; readonly epoch: number }>
>();

function getBridgeModelMap(bridge: Bridge) {
  let map = modelCache.get(bridge);
  if (!map) {
    map = new Map();
    modelCache.set(bridge, map);
  }
  return map;
}

export function invalidateModelCache(bridge?: Bridge): void {
  if (bridge) {
    modelCache.delete(bridge);
  } else {
    modelCacheEpoch += 1;
  }
}

export function primeModelCache(
  bridge: Bridge,
  entries: ReadonlyArray<{ readonly name: string; readonly model: string }>,
): void {
  const map = getBridgeModelMap(bridge);
  const now = Date.now();
  for (const item of entries) {
    if (item.name && item.model) {
      map.set(item.name, { model: item.model, fetchedAt: now, epoch: modelCacheEpoch });
    }
  }
}

/**
 * Returns the device's PT model string (e.g. "1941", "ISR4321",
 * "2950-24") or `null` if the device is missing / PT replied with an
 * error / the lookup failed.
 */
export async function fetchDeviceModel(bridge: Bridge, deviceName: string): Promise<string | null> {
  const map = getBridgeModelMap(bridge);
  const cached = map.get(deviceName);
  if (
    cached &&
    cached.epoch === modelCacheEpoch &&
    Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS
  ) {
    return cached.model;
  }

  const js =
    `(function(){var d=ipc.network().getDevice(${JSON.stringify(deviceName)});` +
    `if(!d)return"?";` +
    `try{return String(d.getModel());}catch(e){return"ERR:"+e;}})()`;
  const reply = await bridge.sendAndWait(js, {
    timeoutMs: 3_000,
    label: `Querying model for ${deviceName}`,
  });
  if (!reply || reply === "?" || reply.startsWith("ERR")) return null;
  map.set(deviceName, { model: reply, fetchedAt: Date.now(), epoch: modelCacheEpoch });
  return reply;
}

/**
 * Fetch PT model strings for multiple devices in a single IPC call, reusing
 * fresh cached entries whenever available.
 */
export async function fetchDeviceModelsBatch(
  bridge: Bridge,
  deviceNames: readonly string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const map = getBridgeModelMap(bridge);
  const now = Date.now();
  const missing: string[] = [];

  for (const name of [...new Set(deviceNames)]) {
    const cached = map.get(name);
    if (
      cached &&
      cached.epoch === modelCacheEpoch &&
      now - cached.fetchedAt < MODEL_CACHE_TTL_MS
    ) {
      result.set(name, cached.model);
    } else {
      missing.push(name);
    }
  }

  if (missing.length === 0) return result;

  const js =
    `(function(){var net=ipc.network();var names=${JSON.stringify(missing)};var out={};` +
    `for(var i=0;i<names.length;i++){var dn=names[i];var d=net.getDevice(dn);` +
    `if(!d){out[dn]=null;continue;}try{out[dn]=String(d.getModel()||"");}catch(e){out[dn]=null;}}` +
    `return JSON.stringify(out);})()`;
  const reply = await bridge.sendAndWait(js, {
    timeoutMs: 5_000,
    label: `Querying models for ${missing.length} device(s)`,
  });

  if (reply && reply.startsWith("{")) {
    try {
      const parsed = JSON.parse(reply) as Record<string, string | null>;
      const ts = Date.now();
      for (const name of missing) {
        const val = parsed[name] ?? null;
        result.set(name, val);
        if (val) {
          map.set(name, { model: val, fetchedAt: ts, epoch: modelCacheEpoch });
        }
      }
      return result;
    } catch {}
  }

  for (const name of missing) {
    result.set(name, null);
  }
  return result;
}
