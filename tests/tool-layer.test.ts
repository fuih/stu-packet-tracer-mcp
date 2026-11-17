import { describe, expect, test } from "bun:test";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Bridge } from "../src/bridge/http-bridge.js";
import { defineTool, getRegisteredTools, installStrictToolWrapper } from "../src/tools/define.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import {
  formatDeviceNotFound,
  levenshteinDistance,
  resolveDeviceName,
} from "../src/util/devices.js";
import { PtError, ptError } from "../src/util/errors.js";
import { resolveOutputPath, slugify } from "../src/util/paths.js";

describe("PtError helper", () => {
  test("formats error with and without hint", () => {
    const e1 = ptError("DEVICE_NOT_FOUND", 'Device "R3" not found.');
    expect(e1).toBeInstanceOf(PtError);
    expect(e1.format()).toBe('[DEVICE_NOT_FOUND] Device "R3" not found.');

    const e2 = ptError("BRIDGE_TIMEOUT", "Timed out.", "Check pt_bridge_status.");
    expect(e2.format()).toBe("[BRIDGE_TIMEOUT] Timed out.\nHint: Check pt_bridge_status.");
  });
});

describe("Device name resolver", () => {
  const devices = ["R1", "R2", "Switch_A", "Switch_B", "PC-1", "Server0"];

  test("levenshteinDistance calculates edit distance accurately", () => {
    expect(levenshteinDistance("r1", "r1")).toBe(0);
    expect(levenshteinDistance("r3", "r2")).toBe(1);
    expect(levenshteinDistance("swich_a", "switch_a")).toBe(1);
    expect(levenshteinDistance("roter1", "router1")).toBe(1);
    expect(levenshteinDistance("abcdef", "xyz")).toBe(6);
  });

  test("resolves exact and case-insensitive matches", () => {
    expect(resolveDeviceName("R1", devices)).toMatchObject({ found: true, name: "R1" });
    expect(resolveDeviceName("switch_a", devices)).toMatchObject({ found: true, name: "Switch_A" });
    expect(resolveDeviceName("server0", devices)).toMatchObject({ found: true, name: "Server0" });
  });

  test("suggests closest device within Levenshtein distance <= 2", () => {
    const res = resolveDeviceName("Swich_A", devices);
    expect(res.found).toBe(false);
    expect(res.suggested).toBe("Switch_A");

    const msg = formatDeviceNotFound("R3", devices);
    expect(msg).toContain('Device "R3" not found');
    expect(msg).toContain('Did you mean "R1"?');
    expect(msg).toContain("Available: R1, R2, Switch_A");
  });

  test("omits suggestion when no device is within distance 2", () => {
    const res = resolveDeviceName("CompletelyDifferentName", devices);
    expect(res.found).toBe(false);
    expect(res.suggested).toBeUndefined();
  });
});

describe("Output path utilities", () => {
  test("resolves relative paths under STU_PT_OUTPUT_DIR or default", () => {
    const prev = process.env.STU_PT_OUTPUT_DIR;
    try {
      delete process.env.STU_PT_OUTPUT_DIR;
      const p1 = resolveOutputPath("captures/r1.svg");
      expect(path.isAbsolute(p1)).toBe(true);
      expect(p1).toEndWith(path.join("stu-pt-output", "captures", "r1.svg"));

      process.env.STU_PT_OUTPUT_DIR = "/tmp/custom-pt-out";
      const p2 = resolveOutputPath("report.docx");
      expect(p2).toBe(path.resolve("/tmp/custom-pt-out/report.docx"));

      const p3 = resolveOutputPath("/tmp/explicit/file.png");
      expect(p3).toBe(path.resolve("/tmp/explicit/file.png"));
    } finally {
      if (prev === undefined) delete process.env.STU_PT_OUTPUT_DIR;
      else process.env.STU_PT_OUTPUT_DIR = prev;
    }
  });

  test("slugify creates safe filenames", () => {
    expect(slugify("show ip interface brief")).toBe("show-ip-interface-brief");
    expect(slugify("show running-config | section ospf")).toBe("show-running-config-section-ospf");
    expect(slugify("   ")).toBe("output");
  });
});

describe("Tool layer (defineTool & strict schemas)", () => {
  test("defineTool enforces strict schemas, offline check, PtError conversion, and structuredContent", async () => {
    const server = new McpServer({ name: "test", version: "0.1.0" });
    const bridge = new Bridge(0);

    const registerDemo = defineTool({
      name: "pt_demo_offline",
      description: "Demo offline tool.",
      offline: true,
      input: z.object({ value: z.string(), fail: z.boolean().optional() }),
      handler: async ({ value, fail }) => {
        if (fail) throw ptError("DEMO_FAIL", "Intentional failure.", "Pass fail: false.");
        return { text: `ok: ${value}`, structured: { value } };
      },
    });

    const registerOnline = defineTool({
      name: "pt_demo_online",
      description: "Demo online tool.",
      input: z.object({}),
      handler: async () => "should not run",
    });

    registerDemo({ bridge, server });
    registerOnline({ bridge, server });

    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        inputSchema: z.ZodTypeAny;
        handler: (args: unknown) => Promise<{ content: Array<{ text?: string }>; structuredContent?: unknown; isError?: boolean }>;
      }>;
    })._registeredTools;

    // Strict schema rejects unknown keys
    const badParse = tools["pt_demo_offline"]!.inputSchema.safeParse({ value: "hi", extra: 123 });
    expect(badParse.success).toBe(false);

    // Offline tool succeeds and sets structuredContent
    const okRes = await tools["pt_demo_offline"]!.handler({ value: "hello" });
    expect(okRes.isError).toBeUndefined();
    expect(okRes.content[0]?.text).toBe("ok: hello");
    expect(okRes.structuredContent).toEqual({ value: "hello" });

    // PtError converts to isError result
    const errRes = await tools["pt_demo_offline"]!.handler({ value: "hello", fail: true });
    expect(errRes.isError).toBe(true);
    expect(errRes.content[0]?.text).toContain("[DEMO_FAIL] Intentional failure.");
    expect(errRes.content[0]?.text).toContain("Hint: Pass fail: false.");

    // Online tool blocks when bridge is disconnected
    const blockedRes = await tools["pt_demo_online"]!.handler({});
    expect(blockedRes.isError).toBe(true);
    expect(blockedRes.content[0]?.text).toContain("Bridge not seeing PT");
  });

  test("every registered tool in ALL_TOOLS enforces strict schemas (additionalProperties: false)", () => {
    const server = new McpServer({ name: "stu-packet-tracer-mcp", version: "0.1.0" });
    const bridge = new Bridge(0);
    installStrictToolWrapper(server, bridge);
    for (const reg of ALL_TOOLS) {
      reg({ bridge, server });
    }

    const registered = getRegisteredTools(server);
    expect(registered.length).toBe(ALL_TOOLS.length);

    for (const tool of registered) {
      const parsed = tool.schema.safeParse({ __definitely_unknown_key_xyz__: true });
      expect(parsed.success).toBe(false);
    }
  });
});
