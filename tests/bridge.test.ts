import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Bridge, isAllowedOrigin } from "../src/bridge/http-bridge.js";
import type { CommandEnvelope, BridgeV1Status } from "../src/bridge/protocol.js";

function toHex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += text.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
}

describe("Bridge v1 protocol", () => {
  let bridge: Bridge;
  let baseUrl: string;

  beforeEach(() => {
    bridge = new Bridge(0, "127.0.0.1");
    bridge.start();
    baseUrl = `http://127.0.0.1:${bridge.port}`;
  });

  afterEach(() => {
    bridge.stop();
    delete process.env.STU_PT_BRIDGE_TOKEN;
  });

  test("ping and status endpoints", async () => {
    const pingRes = await fetch(`${baseUrl}/v1/ping`);
    expect(pingRes.status).toBe(200);
    expect(await pingRes.text()).toBe("pong");

    // Status checks alone must NOT mark Packet Tracer as connected
    const statusBefore = (await (await fetch(`${baseUrl}/v1/status`)).json()) as BridgeV1Status;
    expect(statusBefore.protocol).toBe(1);
    expect(statusBefore.connected).toBe(false);
    expect(statusBefore.pending).toBe(0);

    // Polling /v1/next marks the extension as connected
    const pollRes = await fetch(`${baseUrl}/v1/next?wait=100`);
    expect(pollRes.status).toBe(204);
    const statusAfter = (await (await fetch(`${baseUrl}/v1/status`)).json()) as BridgeV1Status;
    expect(statusAfter.connected).toBe(true);
    expect(statusAfter.agent).toBeNull();
    expect(isAllowedOrigin("this-sm:index.html")).toBe(true);
  });

  test("setAgentName exposes agent in /v1/status, X-Stu-Agent header, CommandEnvelope, and wakes idle long-poll", async () => {
    const parked = fetch(`${baseUrl}/v1/next?wait=3000`);
    await new Promise(r => setTimeout(r, 20));

    const t0 = Date.now();
    bridge.setAgentName("Antigravity");
    const pollRes = await parked;
    expect(Date.now() - t0).toBeLessThan(150);
    expect(pollRes.status).toBe(204);
    expect(pollRes.headers.get("X-Stu-Agent")).toBe("Antigravity");

    const statusRes = await fetch(`${baseUrl}/v1/status`);
    expect(statusRes.headers.get("X-Stu-Agent")).toBe("Antigravity");
    const statusJson = (await statusRes.json()) as BridgeV1Status;
    expect(statusJson.agent).toBe("Antigravity");

    const cmdPoll = fetch(`${baseUrl}/v1/next?wait=3000`);
    await new Promise(r => setTimeout(r, 20));
    const cmdPromise = bridge.sendAndWait("1+1", { label: "agent test", timeoutMs: 2000 });
    const envRes = await cmdPoll;
    const env = (await envRes.json()) as CommandEnvelope;
    expect(env.agent).toBe("Antigravity");

    await fetch(`${baseUrl}/v1/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: env.id, ok: true, data: "2", elapsedMs: 3 }),
    });
    expect(await cmdPromise).toBe("2");
  });

  test("long-poll /v1/next returns within ~50ms when work arrives", async () => {
    // Start long-poll before enqueuing work
    const pollPromise = fetch(`${baseUrl}/v1/next?wait=3000`);

    // Give poll 20ms to park
    await new Promise(r => setTimeout(r, 20));
    expect(bridge.statusV1().connected).toBe(true);

    const t0 = Date.now();
    const cmdPromise = bridge.sendAndWait("1+1", { label: "math", timeoutMs: 2000 });

    const res = await pollPromise;
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(150);

    const env = (await res.json()) as CommandEnvelope;
    expect(env.code).toBe("1+1");
    expect(env.label).toBe("math");
    expect(env.id).toBeString();

    // Post result back
    const postRes = await fetch(`${baseUrl}/v1/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: env.id, ok: true, data: "2", elapsedMs: 5 }),
    });
    expect(postRes.status).toBe(200);

    const finalResult = await cmdPromise;
    expect(finalResult).toBe("2");
  });

  test("long-poll returns 204 when wait expires with no work", async () => {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/v1/next?wait=120`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(204);
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  test("F1 regression: late result after timeout is dropped and next call gets its own result", async () => {
    // 1. Send command A with very short timeout (50ms)
    const cmdAPromise = bridge.sendAndWait("slow_A()", { timeoutMs: 50 });

    // Extension pulls command A
    const resA = await fetch(`${baseUrl}/v1/next?wait=1000`);
    expect(resA.status).toBe(200);
    const envA = (await resA.json()) as CommandEnvelope;
    expect(envA.code).toBe("slow_A()");

    // Wait for command A to time out
    const resultA = await cmdAPromise;
    expect(resultA).toBeNull();

    // 2. Now send command B
    const cmdBPromise = bridge.sendAndWait("fast_B()", { timeoutMs: 2000 });

    // Extension pulls command B
    const resB = await fetch(`${baseUrl}/v1/next?wait=1000`);
    expect(resB.status).toBe(200);
    const envB = (await resB.json()) as CommandEnvelope;
    expect(envB.code).toBe("fast_B()");
    expect(envB.id).not.toBe(envA.id);

    // 3. NOW the late result from A arrives!
    const latePost = await fetch(`${baseUrl}/v1/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: envA.id, ok: true, data: "STALE_A_DATA" }),
    });
    expect(latePost.status).toBe(200);

    // 4. Now the real result for B arrives!
    const goodPost = await fetch(`${baseUrl}/v1/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: envB.id, ok: true, data: "FRESH_B_DATA" }),
    });
    expect(goodPost.status).toBe(200);

    // Command B MUST receive FRESH_B_DATA, NEVER STALE_A_DATA!
    const resultB = await cmdBPromise;
    expect(resultB).toBe("FRESH_B_DATA");
  });

  test("concurrent sendAndWait x10 serialized strictly and each gets its own result", async () => {
    // Start a fake extension loop that executes commands sequentially
    let active = true;
    const extensionLoop = (async () => {
      while (active) {
        const res = await fetch(`${baseUrl}/v1/next?wait=200`);
        if (res.status === 204) continue;
        if (res.status !== 200) break;
        const env = (await res.json()) as CommandEnvelope;
        // Simulate execution returning "res:" + code
        await fetch(`${baseUrl}/v1/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: env.id, ok: true, data: `res:${env.code}` }),
        });
      }
    })();

    const promises = Array.from({ length: 10 }, (_, i) =>
      bridge.sendAndWait(`cmd_${i}`, { timeoutMs: 5000 }),
    );
    const results = await Promise.all(promises);
    active = false;
    await extensionLoop;

    for (let i = 0; i < 10; i++) {
      expect(results[i]).toBe(`res:cmd_${i}`);
    }
  });

  test("error envelope returns ERROR: prefixed string", async () => {
    const cmdPromise = bridge.sendAndWait("throw new Error('boom')", { timeoutMs: 2000 });
    const res = await fetch(`${baseUrl}/v1/next?wait=1000`);
    const env = (await res.json()) as CommandEnvelope;

    await fetch(`${baseUrl}/v1/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: env.id, ok: false, error: "boom" }),
    });

    const out = await cmdPromise;
    expect(out).toBe("ERROR:boom");
  });

  test("origin check returns 403 on foreign origin and allows PT/local origins", async () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin("null")).toBe(true);
    expect(isAllowedOrigin("file://")).toBe(true);
    expect(isAllowedOrigin("pt-sm://extension")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:39001")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8080")).toBe(true);
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);

    const evilRes = await fetch(`${baseUrl}/v1/ping`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(evilRes.status).toBe(403);

    const ptRes = await fetch(`${baseUrl}/v1/ping`, {
      headers: { Origin: "pt-sm://mcp-bridge" },
    });
    expect(ptRes.status).toBe(200);
  });

  test("optional STU_PT_BRIDGE_TOKEN enforcement", async () => {
    process.env.STU_PT_BRIDGE_TOKEN = "secret-token-123";

    const unauth = await fetch(`${baseUrl}/v1/ping`);
    expect(unauth.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/v1/ping`, {
      headers: { "X-Stu-Token": "wrong-token" },
    });
    expect(wrong.status).toBe(401);

    const valid = await fetch(`${baseUrl}/v1/ping`, {
      headers: { "X-Stu-Token": "secret-token-123" },
    });
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("pong");
  });

  test("legacy /next and /result (hex) remain compatible", async () => {
    const cmdPromise = bridge.sendAndWait("legacyCmd()", { label: "Legacy", timeoutMs: 2000 });

    const nextRes = await fetch(`${baseUrl}/next`);
    expect(nextRes.status).toBe(200);
    const body = await nextRes.text();
    expect(body).toContain("/* Legacy */");
    expect(body).toContain("__mcpEval");

    const hexPayload = toHex("LEGACY_OK");
    const postRes = await fetch(`${baseUrl}/result`, {
      method: "POST",
      body: hexPayload,
    });
    expect(postRes.status).toBe(200);

    const result = await cmdPromise;
    expect(result).toBe("LEGACY_OK");
  });
});
