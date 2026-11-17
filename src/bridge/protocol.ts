/**
 * Bridge v1 protocol definitions for stu-packet-tracer-mcp.
 * Communication between Packet Tracer extension (or test runner) and MCP server.
 */

export interface CommandEnvelope {
  readonly id: string;
  readonly code: string;
  readonly label?: string;
  readonly timeoutMs: number;
}

export interface ResultEnvelope {
  readonly id: string;
  readonly ok: boolean;
  readonly data?: string;
  readonly error?: string;
  readonly elapsedMs?: number;
}

export interface BridgeV1Status {
  readonly connected: boolean;
  readonly lastSeenMs: number | null;
  readonly pending: number;
  readonly protocol: 1;
  readonly version: string;
}
