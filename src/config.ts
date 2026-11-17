/**
 * Centralised runtime configuration. Reads from env vars, falls back to
 * sensible defaults that match what PT 9.0 expects.
 *
 * MCP clients connect to MCP_HOST:MCP_PORT/mcp.
 * Packet Tracer's webview polls BRIDGE_PORT.
 */

const envInt = (names: readonly string[], fallback: number): number => {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

const envStr = (names: readonly string[], fallback: string): string => {
  for (const name of names) {
    const raw = process.env[name];
    if (raw) return raw;
  }
  return fallback;
};

export interface RuntimeConfig {
  readonly mcpHost: string;
  readonly mcpPort: number;
  readonly bridgePort: number;
}

export function loadConfig(): RuntimeConfig {
  return {
    mcpHost:    envStr(["STU_PT_MCP_HOST", "MCP_HOST", "PACKETTRACER_MCP_HOST"], "127.0.0.1"),
    mcpPort:    envInt(["STU_PT_MCP_PORT", "MCP_PORT", "PACKETTRACER_MCP_PORT"], 39001),
    bridgePort: envInt(["STU_PT_BRIDGE_PORT", "BRIDGE_PORT", "PACKETTRACER_BRIDGE_PORT"], 54321),
  };
}
