# Troubleshooting

Solutions to the most common Packet Tracer 9, bridge, CLI, and rendering issues.

> [!NOTE]
> The MCP HTTP server listens on `127.0.0.1:39001` and the internal Packet Tracer bridge listens on `127.0.0.1:54321`. Almost every connectivity problem traces back to one of those two localhost ports.

---

## 1. Bridge Not Connected (`BRIDGE_NOT_CONNECTED`)

**Symptoms:** `pt_bridge_status` returns `connected: false`, or live tools fail with `Packet Tracer bridge is not connected`.

**Fixes:**
1. Confirm **Cisco Packet Tracer 9** is open and the **Student MCP Bridge** window is visible (**Extensions -> Scripting -> Student MCP Bridge**).
2. Press `s` (or click **start**) in the extension window if polling is paused, then click **config** (or press `u`) and verify `--url` is `http://127.0.0.1:54321`.
3. If you set `STU_PT_BRIDGE_TOKEN` on the server, open **config** (`u`), paste the exact same token into `--token`, and reconnect.
4. Make sure no older `packet-tracer-mcp` or second `stu-packet-tracer-mcp` instance is already holding port `54321` (see Section 7).

---

## 2. Windows Firewall Prompt

**Symptoms:** Windows Defender Firewall pops up when starting `stu-packet-tracer-mcp`, or the Packet Tracer extension stays on `Reconnecting...`.

**Fixes:**
- Allow **Private networks** when Windows prompts for `bun.exe` or `stu-packet-tracer-mcp.exe`.
- Both the MCP endpoint and the bridge bind strictly to `127.0.0.1` (loopback only), so no external network access is needed.
- If a firewall rule blocked loopback earlier, open **Windows Defender Firewall -> Allow an app** and remove the block rule for `bun.exe`.

---

## 3. Router or Switch Stuck at `[yes/no]` Initial Configuration Dialog

**Symptoms:** A freshly added router prints `Would you like to enter the initial configuration dialog? [yes/no]:` and ignores commands.

**How `stu-packet-tracer-mcp` handles it:**
- The CLI engine (`src/cli/engine.ts`) automatically detects the `[yes/no]:` dialog during `prepareDevice`, sends `no` + Enter, elevates with `enable`, and applies `terminal length 0`.
- If a device was still booting when you called the tool, wait 5–10 seconds for IOS to finish decompressing (`##########`) and re-run the tool.
- You can also open the device CLI tab once in Packet Tracer and press Enter to confirm the prompt is ready.

---

## 4. Truncated Output or `--More--` Pagination

**Symptoms:** Long commands like `show running-config` stop halfway through on older switches or routers.

**How `stu-packet-tracer-mcp` handles it:**
- The CLI engine sends `terminal length 0` once per device per session.
- On Packet Tracer models that reject `terminal length 0` (such as some Catalyst 2960 images), the engine detects `--More--` mid-output, automatically feeds Space until the prompt returns, and strips every `--More--` artifact and backspace sequence from the cleaned output.
- Before sending a new command, the engine checks the console tail for any leftover `--More--` and sends `q` first so the first character of your next command is never eaten.

---

## 5. First Ping Fails (1–3 Packets Dropped)

**Symptoms:** Running `ping` from a PC to another subnet fails on the first attempt (`Request timed out`), then succeeds immediately on the second attempt.

**Cause:** Normal Cisco Packet Tracer behavior — ARP resolution along every hop drops the first 1–3 ICMP echo requests.

**Fixes:**
- Use `pt_ping_matrix`, which automatically runs an ARP warm-up ping before recording the final pass/fail status.
- When using `pt_ping` or `pt_capture_pc_command` manually on a fresh topology, run one quick ping first (or set `warmup: true` if supported) before capturing the final screenshot.

---

## 6. PNG Screenshot Not Generated (SVG Only)

**Symptoms:** `pt_capture_cli`, `pt_render_terminal`, or `pt_export_report` outputs `.svg` files cleanly, with a warning that PNG rasterization was skipped.

**Cause:** `@resvg/resvg-wasm` could not initialize its WebAssembly module or load the bundled DejaVu Sans Mono `.ttf` files from `assets/fonts/`.

**Fixes:**
1. Verify `assets/fonts/DejaVuSansMono.ttf` and `assets/fonts/DejaVuSansMono-Bold.ttf` exist in your installation directory.
2. If you cloned from source, run `bun install` to ensure `@resvg/resvg-wasm` is installed.
3. Run `bun test tests/render-terminal.test.ts` to verify PNG generation locally.
4. Note: SVG files always work without WASM, and `report.html` embeds inline SVGs directly so browser **Print -> Save as PDF** still renders crisp vector terminals.

---

## 7. Port Already in Use (`54321` or `39001`)

**Symptoms:** Server startup fails with `EADDRINUSE` or `Failed to start server. Is port 54321 in use?`

**Cause:** Another `stu-packet-tracer-mcp` process (for example, one started by Claude Desktop or Cursor in `stdio` mode, or an older upstream `packet-tracer-mcp` daemon) is already listening on port `54321`.

**Fixes:**

Find and stop the existing process:

```bash
# Linux / macOS
lsof -i :54321
kill <PID>
```

```powershell
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 54321 | Select-Object OwningProcess
Stop-Process -Id <PID>
```

Or run on alternate ports by setting environment variables:

```bash
BRIDGE_PORT=54322 MCP_PORT=39002 bun start
# or with a standalone binary:
BRIDGE_PORT=54322 MCP_PORT=39002 ./stu-packet-tracer-mcp
```

*(If you change `BRIDGE_PORT`, click **config** (`u`) inside the Packet Tracer extension window and update `--url` to `http://127.0.0.1:54322`.)*

---

## 8. Emergency Paste-In Bootstrap

If you have not packaged `extension/dist/stu-mcp-bridge.pts` yet and want to test immediately:

1. Start `stu-packet-tracer-mcp`.
2. In Packet Tracer 9, open **Extensions -> Scripting -> Configure PT Script Modules...** -> **New**, open its webview debug console, or call `pt_bridge_status` (available offline) to print the minimal JavaScript polling snippet.
3. For normal daily use, package the open-source English extension in `extension/src/` by following [docs/BUILD_EXTENSION.md](BUILD_EXTENSION.md).

---

## 9. Commands Feel Slow (~1–2s Per Call Instead of ~30–100ms)

**Symptoms:** Individual commands (`pt_run_cli`, `pt_ping_matrix`, `pt_auto_layout`) suddenly jump from ~30–100ms to ~1.5–2 seconds per IPC round-trip.

**Cause:** Packet Tracer 9 runs the **Student MCP Bridge** UI inside Qt WebEngine (Chromium). When the Packet Tracer or Bridge monitor window is **minimized** or completely covered on another desktop/workspace, Qt WebEngine throttles background timers and XHR callbacks to ~1 tick per second.

**Fixes:**
1. Keep the **Student MCP Bridge** window unminimized (leaving it tiled or partially visible on your desktop is enough to keep round-trips at ~20–50ms).
2. Prefer `pt_batch_build` and `pt_run_cli_batch` for multi-device setups so the entire topology builds and configures in 1–2 IPC calls even if Packet Tracer is in the background.
