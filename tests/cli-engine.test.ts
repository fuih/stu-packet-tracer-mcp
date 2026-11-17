import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPrompt } from "../src/cli/prompt.js";
import { cleanCliOutput, cleanConsoleScrollback } from "../src/cli/clean.js";
import { runCli, ensureMode, resetCliCache } from "../src/cli/engine.js";
import type { Bridge } from "../src/bridge/http-bridge.js";

describe("CLI prompt parser", () => {
  test("detects user, privileged, and config modes", () => {
    expect(detectPrompt("Router>")).toEqual({ prompt: "Router>", hostname: "Router", mode: "user" });
    expect(detectPrompt("R1#")).toEqual({ prompt: "R1#", hostname: "R1", mode: "privileged" });
    expect(detectPrompt("R1(config)#")).toEqual({ prompt: "R1(config)#", hostname: "R1", mode: "config" });
    expect(detectPrompt("R1(config-if)#")).toEqual({ prompt: "R1(config-if)#", hostname: "R1", mode: "config-if" });
    expect(detectPrompt("SW-Core(config-vlan)#")).toEqual({ prompt: "SW-Core(config-vlan)#", hostname: "SW-Core", mode: "config-vlan" });
    expect(detectPrompt("R1(dhcp-config)#")).toEqual({ prompt: "R1(dhcp-config)#", hostname: "R1", mode: "dhcp-config" });
  });

  test("detects initial configuration dialog", () => {
    const out = "Would you like to enter the initial configuration dialog? [yes/no]: ";
    const p = detectPrompt(out);
    expect(p?.mode).toBe("dialog");
  });

  test("returns null for non-prompt text", () => {
    expect(detectPrompt("Building configuration...")).toBeNull();
    expect(detectPrompt(" --More-- ")).toBeNull();
  });
});

describe("CLI output cleaner", () => {
  test("cleans running-config fixture (strips echo and trailing prompt)", () => {
    const raw = readFileSync(join(import.meta.dir, "../test/fixtures/cli/sample-running-config.txt"), "utf-8");
    const cleaned = cleanCliOutput(raw, "show running-config");
    expect(cleaned.prompt).toBe("R1#");
    expect(cleaned.output).toStartWith("Building configuration...");
    expect(cleaned.output).toEndWith("end");
    expect(cleaned.output).not.toContain("show running-config");
    expect(cleaned.logs).toHaveLength(0);
  });

  test("cleans --More-- pager markers and separates syslog lines", () => {
    const raw = readFileSync(join(import.meta.dir, "../test/fixtures/cli/sample-more.txt"), "utf-8");
    const cleaned = cleanCliOutput(raw, "show ip route");
    expect(cleaned.prompt).toBe("R1#");
    expect(cleaned.output).not.toContain("--More--");
    expect(cleaned.output).toContain("O     192.168.2.0/24");
    expect(cleaned.output).toContain("O     192.168.3.0/24");
    expect(cleaned.output).not.toContain("%LINK-5-CHANGED");
    expect(cleaned.logs).toEqual([
      "%LINK-5-CHANGED: Interface Serial0/1/0, changed state to up",
      "%LINEPROTO-5-UPDOWN: Line protocol on Interface Serial0/1/0, changed state to up",
    ]);
  });

  test("resolves literal backspaces left by IOS pager", () => {
    const raw = "show version\r\nCisco IOS\r\n --More-- \x08\x08\x08\x08\x08\x08\x08\x08\x08\x08          \x08\x08\x08\x08\x08\x08\x08\x08\x08\x08Line 2\r\nR1#\r\n";
    const cleaned = cleanCliOutput(raw, "show version");
    expect(cleaned.output).toBe("Cisco IOS\nLine 2");
    expect(cleaned.prompt).toBe("R1#");
  });

  test("cleanConsoleScrollback preserves prior commands, errors, and drops partial top line", () => {
    const raw = [
      "chopped-partial-line",
      "R1>enable",
      "R1#terminal length 0",
      "             ^",
      "% Invalid input detected at '^' marker.",
      "R1#show ip arp",
      "Internet  10.0.0.1   -   000A.4176.01BA  ARPA   FastEthernet0/0",
      " --More-- \x08\x08\x08\x08\x08\x08\x08\x08\x08\x08R1#show ip route",
      "S*   0.0.0.0/0 [1/0] via 50.0.0.2",
      "R1#",
      "",
    ].join("\n");

    const lines = cleanConsoleScrollback(raw, 20, { dropFirstPartialLine: true, fallbackPrompt: "R1#" });
    expect(lines[0]).toBe("R1>enable");
    expect(lines.some(l => l.includes("% Invalid input detected"))).toBe(true);
    expect(lines.some(l => l.includes("R1#show ip arp"))).toBe(true);
    expect(lines.some(l => l.includes("--More--"))).toBe(false);
    expect(lines[lines.length - 1]).toBe("R1#");
  });
});

/**
 * Fake simulated IOS terminal behind a mock Bridge for testing engine.ts offline.
 */
function createFakeCliBridge(initialBuffer: string, options?: { paginateRunningConfig?: boolean }) {
  let buffer = initialBuffer;
  const sentCommands: string[] = [];
  let pageStep = 0;

  const mockBridge = {
    async sendAndWait(js: string): Promise<string | null> {
      // 1. Tail read
      if (js.includes("Reading CLI tail")) {
        const tail = buffer.length > 300 ? buffer.slice(-300) : buffer;
        return JSON.stringify({ len: buffer.length, tail });
      }

      // 2. Pager key ('q' or ' ')
      if (js.includes("Sending CLI pager key")) {
        if (js.includes("113")) {
          sentCommands.push("<KEY:q>");
          buffer = buffer.replace(/--More--\s*$/, "\nR1#\n");
        } else if (js.includes("32")) {
          sentCommands.push("<KEY:Space>");
          pageStep++;
          if (pageStep === 1) {
            buffer = buffer.replace(/--More--\s*$/, "interface Gi0/0\n ip address 10.0.0.1 255.255.255.0\n --More-- ");
          } else {
            buffer = buffer.replace(/--More--\s*$/, "!\nend\n\nR1#\n");
          }
        }
        return "OK:char";
      }

      // 3. Read slice from offset
      if (js.includes("Reading CLI output slice")) {
        const m = /out\.substring\((\d+)\)/.exec(js);
        const offset = m ? Number(m[1]) : 0;
        return buffer.substring(offset);
      }

      // 4. Enter command
      const cmdMatch = /cl\.enterCommand\(("[^"]*")\)/.exec(js);
      if (cmdMatch) {
        const cmd = JSON.parse(cmdMatch[1]!) as string;
        const before = buffer.length;
        sentCommands.push(cmd);

        if (cmd === "no" && buffer.includes("[yes/no]")) {
          buffer = "Press RETURN to get started!\n";
        } else if (cmd === "" && buffer.includes("Press RETURN to get started!")) {
          buffer = "Router>\n";
        } else if (cmd === "enable") {
          buffer += "enable\nR1#\n";
        } else if (cmd === "terminal length 0") {
          buffer += "terminal length 0\nR1#\n";
        } else if (cmd === "configure terminal") {
          buffer += "configure terminal\nEnter configuration commands, one per line.\nR1(config)#\n";
        } else if (cmd === "end") {
          buffer += "end\nR1#\n";
        } else if (cmd === "show running-config") {
          if (options?.paginateRunningConfig) {
            pageStep = 0;
            buffer += "show running-config\nBuilding configuration...\n!\nhostname R1\n --More-- ";
          } else {
            buffer += "show running-config\nBuilding configuration...\n!\nhostname R1\n!\nend\n\nR1#\n";
          }
        } else {
          buffer += `${cmd}\nOK_OUTPUT\nR1#\n`;
        }
        return `${before}|${buffer.substring(before)}`;
      }

      return "OK";
    },
  } as unknown as Bridge;

  return { bridge: mockBridge, sentCommands, getBuffer: () => buffer };
}

describe("CLI Engine (F3 pagination & eaten-char fixes)", () => {
  beforeEach(() => {
    resetCliCache();
  });

  test("prepares fresh device by dismissing boot dialog, enabling, and setting terminal length 0", async () => {
    const sim = createFakeCliBridge(
      "Would you like to enter the initial configuration dialog? [yes/no]: ",
    );
    const res = await runCli(sim.bridge, "R1", "show version", { pollIntervalMs: 10, settleMs: 200 });

    expect(sim.sentCommands).toContain("no");
    expect(sim.sentCommands).toContain("enable");
    expect(sim.sentCommands).toContain("terminal length 0");
    expect(sim.sentCommands).toContain("show version");
    expect(res.output).toBe("OK_OUTPUT");
    expect(res.mode_after).toBe("privileged");
  });

  test("handles multi-page --More-- during show running-config and returns full config ending with end", async () => {
    const sim = createFakeCliBridge("R1#\n", { paginateRunningConfig: true });
    const res = await runCli(sim.bridge, "R1", "show running-config", {
      pollIntervalMs: 10,
      settleMs: 500,
    });

    expect(sim.sentCommands.filter(c => c === "<KEY:Space>").length).toBe(2);
    expect(res.output).toContain("hostname R1");
    expect(res.output).toContain("interface Gi0/0");
    expect(res.output).toEndWith("end");
    expect(res.output).not.toContain("--More--");
  });

  test("clears lingering --More-- with 'q' before next command so characters are not eaten", async () => {
    const sim = createFakeCliBridge("R1#show running-config\nline1\n --More-- ");
    const res = await runCli(sim.bridge, "R1", "show ip int brief", {
      skipPrepare: true,
      pollIntervalMs: 10,
      settleMs: 200,
    });

    // Must send <KEY:q> BEFORE sending 'show ip int brief'
    expect(sim.sentCommands[0]).toBe("<KEY:q>");
    expect(sim.sentCommands[1]).toBe("show ip int brief");
    expect(res.output).toBe("OK_OUTPUT");
  });

  test("ensureMode transitions cleanly between user, privileged, and config", async () => {
    const sim = createFakeCliBridge("Router>\n");
    const m1 = await ensureMode(sim.bridge, "R1", "config");
    expect(m1).toBe("config");
    expect(sim.sentCommands).toContain("enable");
    expect(sim.sentCommands).toContain("configure terminal");

    const m2 = await ensureMode(sim.bridge, "R1", "privileged");
    expect(m2).toBe("privileged");
    expect(sim.sentCommands).toContain("end");
  });
});
