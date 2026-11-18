import { randomUUID } from "node:crypto";
import type { CommandEnvelope, ResultEnvelope, BridgeV1Status } from "./protocol.js";

type BunServer = ReturnType<typeof Bun.serve>;

export interface BridgeStatus {
  readonly connected: boolean;
  readonly port: number;
  readonly queueLength: number;
  readonly hasPendingResult: boolean;
  readonly lastSeenAt: number | null;
}

export interface SendAndWaitOptions {
  readonly timeoutMs?: number;
  readonly label?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Stu-Token, *",
  "Access-Control-Expose-Headers": "X-Stu-Agent",
  "Access-Control-Max-Age": "86400",
} as const;

const HEADERS_TEXT = { "Content-Type": "text/plain", ...CORS_HEADERS } as const;
const HEADERS_JSON = { "Content-Type": "application/json", ...CORS_HEADERS } as const;

interface PendingEntry {
  readonly resolve: (value: string | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly startTime: number;
  readonly label?: string;
}

interface ParkedWaiter {
  readonly resolve: (cmd: CommandEnvelope | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function isAllowedOrigin(originHeader: string | null): boolean {
  if (!originHeader || originHeader === "null") return true;
  const o = originHeader.toLowerCase();
  if (o.startsWith("file://")) return true;
  if (o.startsWith("pt-sm:")) return true;
  if (o.startsWith("this-sm:")) return true;
  if (o.startsWith("file-sm:")) return true;
  if (o.startsWith("chrome-extension://")) return true;
  if (o.startsWith("vscode-webview://")) return true;
  try {
    const u = new URL(o);
    if (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1" ||
      u.hostname === "[::1]"
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function isTokenValid(req: Request): boolean {
  const expected = process.env.STU_PT_BRIDGE_TOKEN;
  if (!expected) return true;
  const actual = req.headers.get("X-Stu-Token");
  return actual === expected;
}

export class Bridge {
  private readonly queue: CommandEnvelope[] = [];
  private readonly pendingWaiters = new Map<string, PendingEntry>();
  private readonly parkedWaiters: ParkedWaiter[] = [];
  private readonly legacyWaiters: Array<(value: string | null) => void> = [];

  private bunServer: BunServer | null = null;
  private lastSeenAt: number | null = null;
  private inFlightId: string | null = null;
  private agentName: string | null = null;

  constructor(private readonly _port: number = 54321, public readonly host: string = "127.0.0.1") {}

  setAgentName(name: string | null | undefined): void {
    const cleaned = typeof name === "string" ? name.trim() : "";
    const next = cleaned.length > 0 ? cleaned : null;
    if (this.agentName === next) return;
    this.agentName = next;
    // Wake idle long-poll waiters so the PT extension displays the active agent immediately.
    if (this.inFlightId === null && this.queue.length === 0) {
      while (this.parkedWaiters.length > 0) {
        const w = this.parkedWaiters.shift();
        if (w) {
          clearTimeout(w.timer);
          w.resolve(null);
        }
      }
    }
  }

  getAgentName(): string | null {
    return this.agentName;
  }

  get port(): number {
    return this.bunServer?.port ?? this._port;
  }

  start(): void {
    if (this.bunServer) return;
    this.bunServer = Bun.serve({
      hostname: this.host,
      port: this._port,
      // Long-poll /v1/next holds connections open up to 60s; default Bun idleTimeout (10s) would abort them.
      idleTimeout: 120,
      fetch: (req) => this.handle(req),
    });
  }

  stop(): void {
    this.bunServer?.stop(true);
    this.bunServer = null;

    // Flush parked /v1/next waiters
    while (this.parkedWaiters.length > 0) {
      const w = this.parkedWaiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }

    // Flush pending command waiters
    for (const [id, entry] of this.pendingWaiters) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pendingWaiters.clear();

    // Flush legacy waiters
    while (this.legacyWaiters.length > 0) {
      const w = this.legacyWaiters.shift();
      w?.(null);
    }

    this.inFlightId = null;
    this.queue.length = 0;
  }

  status(): BridgeStatus {
    const since = this.lastSeenAt;
    const isParked = this.parkedWaiters.length > 0;
    const connected = isParked || (since !== null && Date.now() - since < 3_000);
    return {
      connected,
      port: this.port,
      queueLength: this.queue.length,
      hasPendingResult: this.pendingWaiters.size > 0 || this.legacyWaiters.length > 0,
      lastSeenAt: since,
    };
  }

  statusV1(): BridgeV1Status {
    const since = this.lastSeenAt;
    const isParked = this.parkedWaiters.length > 0;
    const connected = isParked || (since !== null && Date.now() - since < 3_000);
    return {
      connected,
      lastSeenMs: since !== null ? Date.now() - since : null,
      pending: this.pendingWaiters.size,
      protocol: 1,
      version: "0.1.0",
      agent: this.agentName,
    };
  }

  private jsonHeaders(): Record<string, string> {
    return this.agentName
      ? { ...HEADERS_JSON, "X-Stu-Agent": this.agentName }
      : { ...HEADERS_JSON };
  }

  enqueue(cmd: string | CommandEnvelope): void {
    const env: CommandEnvelope = typeof cmd === "string"
      ? { id: randomUUID(), code: cmd, timeoutMs: 10_000 }
      : cmd;
    this.queue.push(env);
    this.pumpQueue();
  }

  async sendAndWait(jsExpression: string, opts: SendAndWaitOptions = {}): Promise<string | null> {
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const env: CommandEnvelope = {
      id,
      code: jsExpression,
      label: opts.label,
      timeoutMs,
    };

    const promise = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWaiters.delete(id);
        if (this.inFlightId === id) {
          this.inFlightId = null;
          this.pumpQueue();
        }
        console.warn(`[stu-pt-mcp] Command ${id} timed out after ${timeoutMs}ms (${opts.label ?? "no label"})`);
        resolve(null);
      }, timeoutMs);

      this.pendingWaiters.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        timer,
        startTime: Date.now(),
        label: opts.label,
      });
    });

    this.queue.push(env);
    this.pumpQueue();
    return promise;
  }

  waitForNext(timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let done = false;
      const settle = (value: string | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      this.legacyWaiters.push(settle);
      setTimeout(() => {
        const idx = this.legacyWaiters.indexOf(settle);
        if (idx >= 0) this.legacyWaiters.splice(idx, 1);
        settle(null);
      }, timeoutMs);
    });
  }

  private pumpQueue(): void {
    if (this.inFlightId !== null) return;
    if (this.queue.length === 0) return;
    if (this.parkedWaiters.length === 0) return;

    const cmd = this.queue.shift()!;
    const waiter = this.parkedWaiters.shift()!;
    clearTimeout(waiter.timer);
    this.inFlightId = cmd.id;
    waiter.resolve(cmd);
  }

  private deliverResult(id: string, ok: boolean, data?: string, error?: string): void {
    if (this.inFlightId === id) {
      this.inFlightId = null;
    }

    const waiter = this.pendingWaiters.get(id);
    if (!waiter) {
      // F1 FIX: Drop late result from previous timed-out command. Never hand it to next caller!
      console.warn(`[stu-pt-mcp] Late or unknown result dropped for id: ${id}`);
      this.pumpQueue();
      return;
    }

    this.pendingWaiters.delete(id);
    this.pumpQueue();

    if (ok) {
      waiter.resolve(data ?? "OK");
    } else {
      const errMsg = error
        ? (error.startsWith("ERR") || error.startsWith("ERROR") ? error : `ERROR:${error}`)
        : "ERROR:unknown";
      waiter.resolve(errMsg);
    }
  }

  private deliverLegacyResult(text: string): void {
    // Deliver to in-flight pending waiter first if present
    if (this.inFlightId && this.pendingWaiters.has(this.inFlightId)) {
      const id = this.inFlightId;
      this.deliverResult(id, !text.startsWith("ERR") && !text.startsWith("ERROR"), text, text);
      return;
    }

    // Otherwise deliver to legacy waiter
    const next = this.legacyWaiters.shift();
    if (next) next(text);
  }

  private async handle(req: Request): Promise<Response> {
    const origin = req.headers.get("Origin");
    if (!isAllowedOrigin(origin)) {
      return new Response(JSON.stringify({ error: "Forbidden origin" }), {
        status: 403,
        headers: HEADERS_JSON,
      });
    }

    if (!isTokenValid(req)) {
      return new Response(JSON.stringify({ error: "Unauthorized: invalid bridge token" }), {
        status: 401,
        headers: HEADERS_JSON,
      });
    }

    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // -------------------------------------------------------------
    // Bridge Protocol v1 endpoints
    // -------------------------------------------------------------
    if (method === "GET" && url.pathname === "/v1/ping") {
      return new Response("pong", { headers: HEADERS_TEXT });
    }

    if (method === "GET" && url.pathname === "/v1/status") {
      return new Response(JSON.stringify(this.statusV1()), { headers: this.jsonHeaders() });
    }

    if (method === "GET" && url.pathname === "/v1/next") {
      this.lastSeenAt = Date.now();
      const waitParam = Number(url.searchParams.get("wait") ?? 25_000);
      const waitMs = Math.min(Math.max(100, isNaN(waitParam) ? 25_000 : waitParam), 60_000);

      // If no command is in flight and queue has an item, return immediately
      if (this.inFlightId === null && this.queue.length > 0) {
        const cmd = this.queue.shift()!;
        this.inFlightId = cmd.id;
        return new Response(JSON.stringify({ ...cmd, agent: this.agentName }), { headers: this.jsonHeaders() });
      }

      // Otherwise park the request and clean up immediately if the client aborts
      return new Promise<Response>((resolve) => {
        let settled = false;
        const removeWaiter = () => {
          const idx = this.parkedWaiters.findIndex(w => w.resolve === onReady);
          if (idx >= 0) this.parkedWaiters.splice(idx, 1);
        };

        const cleanup = () => {
          clearTimeout(timer);
          removeWaiter();
          req.signal.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(new Response(null, { status: 204, headers: this.jsonHeaders() }));
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(new Response(null, { status: 204, headers: this.jsonHeaders() }));
        }, waitMs);

        const onReady = (cmd: CommandEnvelope | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (cmd) {
            resolve(new Response(JSON.stringify({ ...cmd, agent: this.agentName }), { headers: this.jsonHeaders() }));
          } else {
            resolve(new Response(null, { status: 204, headers: this.jsonHeaders() }));
          }
        };

        if (req.signal.aborted) {
          onAbort();
          return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });
        this.parkedWaiters.push({ resolve: onReady, timer });
      });
    }

    if (method === "POST" && url.pathname === "/v1/result") {
      this.lastSeenAt = Date.now();
      let envelope: ResultEnvelope;
      try {
        envelope = (await req.json()) as ResultEnvelope;
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400,
          headers: HEADERS_JSON,
        });
      }

      if (!envelope || typeof envelope.id !== "string") {
        return new Response(JSON.stringify({ error: "Missing envelope id" }), {
          status: 400,
          headers: HEADERS_JSON,
        });
      }

      this.deliverResult(envelope.id, !!envelope.ok, envelope.data, envelope.error);
      return new Response("ok", { headers: HEADERS_TEXT });
    }

    // -------------------------------------------------------------
    // Legacy endpoints (backward compatibility)
    // -------------------------------------------------------------
    if (method === "GET" && url.pathname === "/ping") {
      return new Response("pong", { headers: HEADERS_TEXT });
    }

    if (method === "GET" && url.pathname === "/status") {
      return new Response(JSON.stringify(this.status()), { headers: HEADERS_JSON });
    }

    if (method === "GET" && url.pathname === "/next") {
      this.lastSeenAt = Date.now();
      if (this.queue.length > 0) {
        const cmd = this.queue.shift()!;
        this.inFlightId = cmd.id;
        const legacyCode = wrapForResult(cmd.code, this.port, cmd.label);
        return new Response(legacyCode, { headers: HEADERS_TEXT });
      }
      return new Response("", { headers: HEADERS_TEXT });
    }

    if (method === "POST" && url.pathname === "/queue") {
      const body = await req.text();
      this.enqueue(body);
      return new Response("queued", { headers: HEADERS_TEXT });
    }

    if (method === "POST" && url.pathname === "/result") {
      this.lastSeenAt = Date.now();
      const hexBody = await req.text();
      this.deliverLegacyResult(hexFromBridgeToText(hexBody));
      return new Response("ok", { headers: HEADERS_TEXT });
    }

    if (method === "GET" && url.pathname === "/result") {
      const timeoutMs = Number(url.searchParams.get("timeout_ms") ?? 9_000);
      const text = await this.waitForNext(timeoutMs);
      if (text === null) return new Response("", { status: 204, headers: HEADERS_TEXT });
      return new Response(text, { headers: HEADERS_TEXT });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: HEADERS_JSON });
  }
}

export function hexFromBridgeToText(hex: string): string {
  const cleaned = hex.replace(/[^0-9a-f]/gi, "");
  let out = "";
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    out += String.fromCharCode(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

const LABEL_RE = /^\s*\/\*\s*([^*][^]*?)\s*\*\/\s*/;

export function wrapForResult(jsExpression: string, port: number, explicitLabel?: string): string {
  const match = jsExpression.match(LABEL_RE);
  const embeddedLabel = match?.[1] ? match[1].replace(/\s+/g, " ").trim() : null;
  const code = match ? jsExpression.slice(match[0].length) : jsExpression;
  const label = explicitLabel?.trim() || embeddedLabel || null;
  const prefix = label ? `/* ${label} */ ` : "";
  return `${prefix}__mcpEval(${JSON.stringify(code)},${port});`;
}
