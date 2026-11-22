import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "../src/bridge/http-bridge.js";
import { waitForCliReadyAll } from "../src/ipc/cli-wait.js";
import {
  addDevicesBatchJs,
  bulkCliBatchJs,
  createLinksBatchJs,
  moveDevicesBatchJs,
  saveRunningConfigsBatchJs,
  setEndpointsStaticIpBatchJs,
} from "../src/ipc/generator.js";
import { runPingsParallel } from "../src/sim/runner.js";
import { runPingMatrix } from "../src/student/ping-matrix.js";
import { registerBatchBuildTool } from "../src/tools/batch-build.js";
import { registerRunCliBatchTool } from "../src/tools/run-cli-batch.js";
import {
  invalidateDeviceCache,
  primeDeviceCache,
  resolveCanvasDevice,
} from "../src/util/devices.js";

describe("Device Name Cache (resolveCanvasDevice)", () => {
  test("caches device names across lookups, refreshes on miss, and clears on invalidation", async () => {
    let listCalls = 0;
    let currentDevices = ["R1", "SW1", "PC1"];

    const bridge = {
      async sendAndWait(js: string): Promise<string | null> {
        if (js.includes("Listing canvas devices")) {
          listCalls++;
          return `${currentDevices.length}\n${currentDevices.map(n => `${n}|2911|Router|100|100`).join("\n")}`;
        }
        return "OK";
      },
    } as unknown as Bridge;

    invalidateDeviceCache(bridge);

    // First lookup fetches once
    expect(await resolveCanvasDevice(bridge, "r1")).toBe("R1");
    expect(listCalls).toBe(1);

    // Second lookup hits cache (0 extra IPC calls)
    expect(await resolveCanvasDevice(bridge, "sw1")).toBe("SW1");
    expect(await resolveCanvasDevice(bridge, "PC1")).toBe("PC1");
    expect(listCalls).toBe(1);

    // Adding a device externally triggers a cache miss -> refreshes live once
    currentDevices = ["R1", "SW1", "PC1", "R2"];
    expect(await resolveCanvasDevice(bridge, "r2")).toBe("R2");
    expect(listCalls).toBe(2);

    // Explicit invalidation forces next call to fetch again
    invalidateDeviceCache(bridge);
    expect(await resolveCanvasDevice(bridge, "R1")).toBe("R1");
    expect(listCalls).toBe(3);

    // Priming cache avoids IPC lookup completely
    primeDeviceCache(bridge, ["Edge1", "Edge2"]);
    expect(await resolveCanvasDevice(bridge, "edge2")).toBe("Edge2");
    expect(listCalls).toBe(3);
  });
});

describe("Batched IPC Generators", () => {
  test("generate valid ES5 scripts for batch devices, links, PCs, and NVRAM saves", () => {
    const devJs = addDevicesBatchJs([
      { name: "R1", category: "router", model: "2911", x: 100, y: 100 },
      { name: "SW1", category: "switch", model: "2960-24TT", x: 100, y: 250 },
    ]);
    const linkJs = createLinksBatchJs([
      { deviceA: "R1", portA: "GigabitEthernet0/0", deviceB: "SW1", portB: "GigabitEthernet0/1", cable: "straight" },
    ]);
    const pcJs = setEndpointsStaticIpBatchJs([
      { device: "PC1", port: "FastEthernet0", ip: "192.168.1.10", mask: "255.255.255.0", gateway: "192.168.1.1" },
    ]);
    const saveJs = saveRunningConfigsBatchJs(["R1", "SW1"]);
    const moveJs = moveDevicesBatchJs([{ name: "R1", x: 120, y: 100 }, { name: "SW1", x: 120, y: 250 }]);
    const cliBatchJs = bulkCliBatchJs(
      [{ device: "R1", commands: ["configure terminal", "hostname R1", "end"] }],
      { save: true, tailChars: 1000 },
    );

    for (const script of [devJs, linkJs, pcJs, saveJs, moveJs, cliBatchJs]) {
      const expr = script.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
      expect(() => new Function("ipc", `return ${expr}`)).not.toThrow();
    }
  });
});

describe("Parallel Boot Waiter (waitForCliReadyAll)", () => {
  test("polls multiple booting routers together and dismisses boot dialogs in one batch", async () => {
    const state = {
      R1: { prompt: "", tail: "Would you like to enter the initial configuration dialog? [yes/no]: " },
      R2: { prompt: "", tail: "Would you like to enter the initial configuration dialog? [yes/no]: " },
    };
    let pollCalls = 0;
    let dismissBatchCalls = 0;

    const bridge = {
      async sendAndWait(js: string): Promise<string | null> {
        if (js.includes("Polling CLI boot state")) {
          pollCalls++;
          return JSON.stringify([
            { device: "R1", ok: true, prompt: state.R1.prompt, tail: state.R1.tail },
            { device: "R2", ok: true, prompt: state.R2.prompt, tail: state.R2.tail },
          ]);
        }
        if (js.includes("Dismissing boot dialog")) {
          dismissBatchCalls++;
          state.R1 = { prompt: "Router>", tail: "Router>" };
          state.R2 = { prompt: "Router>", tail: "Router>" };
          return "OK";
        }
        return "OK";
      },
    } as unknown as Bridge;

    await waitForCliReadyAll(bridge, ["R1", "R2"], { pollIntervalMs: 10, timeoutMs: 5_000 });
    expect(dismissBatchCalls).toBe(1);
    expect(pollCalls).toBeGreaterThanOrEqual(3);
  });
});

describe("Parallel Pings & Smart-Warmup Ping Matrix", () => {
  test("runPingsParallel launches and polls distinct hosts in batched waves", async () => {
    let startBatchCalls = 0;
    let pollBatchCalls = 0;

    const bridge = {
      async sendAndWait(js: string): Promise<string | null> {
        if (js.includes("Launching 2 parallel ping(s)")) {
          startBatchCalls++;
          return JSON.stringify([
            { ok: true, offset: 0, anchor: "", slice: "Pinging 10.0.0.2 with 32 bytes of data:" },
            { ok: true, offset: 0, anchor: "", slice: "Pinging 10.0.0.1 with 32 bytes of data:" },
          ]);
        }
        if (js.includes("Polling 2 active ping(s)")) {
          pollBatchCalls++;
          return JSON.stringify([
            {
              index: 0,
              slice: "Ping statistics for 10.0.0.2:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),",
            },
            {
              index: 1,
              slice: "Ping statistics for 10.0.0.1:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),",
            },
          ]);
        }
        return "OK";
      },
    } as unknown as Bridge;

    const outcomes = await runPingsParallel(
      bridge,
      [
        { device: "PC1", target: "10.0.0.2" },
        { device: "PC2", target: "10.0.0.1" },
      ],
      { pollIntervalMs: 10, timeoutMs: 5_000 },
    );

    expect(startBatchCalls).toBe(1);
    expect(pollBatchCalls).toBe(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.result.received).toBe(4);
    expect(outcomes[1]!.result.received).toBe(4);
  });

  test("runPingMatrix skips redundant warmup retries when first pass is 4/4, and retries only ARP drops", async () => {
    const attemptCount = new Map<string, number>();

    const bridge = {
      async sendAndWait(js: string): Promise<string | null> {
        // Addressing table snapshot
        if (js.includes("Collecting live addressing table")) {
          return [
            "DEV|PC1|PC-PT|192.168.10.1",
            "PORT|FastEthernet0|192.168.10.10|255.255.255.0|1",
            "DEV|PC2|PC-PT|192.168.20.1",
            "PORT|FastEthernet0|192.168.20.10|255.255.255.0|1",
          ].join("\n");
        }

        // Parallel wave start (PC1->PC2 and PC2->PC1 together)
        if (js.includes("Launching 2 parallel ping(s)")) {
          const m = /var jobs=(\[[\s\S]*?\]);/.exec(js);
          const jobs = JSON.parse(m![1]!) as Array<{ device: string; target: string }>;
          return JSON.stringify(jobs.map(j => {
            const key = `${j.device}->${j.target}`;
            const tries = (attemptCount.get(key) ?? 0) + 1;
            attemptCount.set(key, tries);
            // PC1->PC2 drops 1 packet on first try (ARP), PC2->PC1 passes 4/4 immediately
            const received = key === "PC1->192.168.20.10" && tries === 1 ? 3 : 4;
            return {
              ok: true,
              offset: 0,
              anchor: "",
              slice: `Ping statistics for ${j.target}:\n    Packets: Sent = 4, Received = ${received}, Lost = ${4 - received} (${(4 - received) * 25}% loss),`,
            };
          }));
        }

        // Single retry ping for ONLY the pair that had ARP drop (PC1->PC2)
        if (js.includes("CLI PC1") && js.includes("ping 192.168.20.10")) {
          const key = "PC1->192.168.20.10";
          attemptCount.set(key, (attemptCount.get(key) ?? 0) + 1);
          return "OK";
        }
        if (js.includes("Reading CLI output of PC1")) {
          return "Ping statistics for 192.168.20.10:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),";
        }

        return "OK";
      },
    } as unknown as Bridge;

    const matrix = await runPingMatrix(bridge, { warmup: true, timeoutMs: 5_000 });
    expect(matrix.passed).toBe(2);
    expect(matrix.failed).toBe(0);
    // PC1->PC2 retried once due to 3/4 first attempt; PC2->PC1 ran only once!
    expect(attemptCount.get("PC1->192.168.20.10")).toBe(2);
    expect(attemptCount.get("PC2->192.168.10.10")).toBe(1);
  });
});

describe("Batch Authoring & CLI Tools (pt_batch_build & pt_run_cli_batch)", () => {
  test("pt_batch_build and pt_run_cli_batch support dry_run preview cleanly", async () => {
    const server = new McpServer({ name: "test", version: "0.1.0" });
    const fakeBridge = {
      status: () => ({ connected: true, port: 54321, queueLength: 0, hasPendingResult: false, lastSeenAt: Date.now() }),
      async sendAndWait() {
        throw new Error("Should not hit PT during dry_run");
      },
    } as unknown as Bridge;

    registerBatchBuildTool({ bridge: fakeBridge, server });
    registerRunCliBatchTool({ bridge: fakeBridge, server });

    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: unknown) => Promise<{ content: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }>;
      }>;
    })._registeredTools;

    const buildRes = await tools["pt_batch_build"]!.handler({
      clear_first: true,
      devices: [
        { name: "R1", model: "2911" },
        { name: "SW1", model: "2960-24TT" },
        { name: "PC1", model: "PC-PT" },
      ],
      modules: [],
      links: [
        { device_a: "R1", port_a: "GigabitEthernet0/0", device_b: "SW1", port_b: "GigabitEthernet0/1" },
        { device_a: "PC1", port_a: "FastEthernet0", device_b: "SW1", port_b: "FastEthernet0/1" },
      ],
      pcs: [{ device: "PC1", port: "FastEthernet0", ip: "192.168.1.10", mask: "255.255.255.0", gateway: "192.168.1.1" }],
      wait_for_cli: true,
      dry_run: true,
    });
    expect(buildRes.isError).toBeUndefined();
    expect(buildRes.content[0]?.text).toContain("devices (3)");
    expect(buildRes.content[0]?.text).toContain("links (2)");

    const cliRes = await tools["pt_run_cli_batch"]!.handler({
      targets: [
        { device: "R1", commands: ["enable", "configure terminal", "hostname R1", "end"] },
        { device: "SW1", commands: ["enable", "configure terminal", "hostname SW1", "end"] },
      ],
      save: true,
      tail_chars: 1500,
      dry_run: true,
    });
    expect(cliRes.isError).toBeUndefined();
    expect(cliRes.content[0]?.text).toContain("### R1 (4 lines)");
    expect(cliRes.content[0]?.text).toContain("### SW1 (4 lines)");
  });
});
