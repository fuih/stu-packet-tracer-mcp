# Building the Student MCP Bridge Extension (`.pts`)

Cisco Packet Tracer 9 stores Script Modules in an encrypted `.pts` container that can only be packaged from inside Packet Tracer's built-in Scripting interface. The full, clean English source code lives in `extension/src/`:

- `extension/src/main.js` — Script Engine entry point (`openBridgeWindow`, `runEnvelope`, `runCode`, `__mcpEval`) using PT 9's `webViewManager.createWebView("Student MCP Bridge", "this-sm:index.html", 460, 560)`
- `extension/src/index.html` — Bridge UI markup ("Student MCP Bridge") referencing `this-sm:style.css` and `this-sm:bridge.js`
- `extension/src/style.css` — Offline dark UI styles
- `extension/src/bridge.js` — Protocol v1 long-poll client (`/v1/next`, `/v1/result`) with legacy fallback and exponential backoff

---

## Step-by-Step Packaging Guide (Packet Tracer 9)

1. Open **Cisco Packet Tracer 9**.
2. In the top menu bar, click **Extensions -> Scripting -> Configure PT Script Modules...**
3. Click **New** to open the Script Module editor (5 tabs: `Info`, `General`, `Script Engine`, `Custom Interfaces`, `Data Store`).
4. Open the **General** tab and fill in:
   - **Name**: `Student MCP Bridge`
   - **ID**: `io.github.fuih.stu-mcp-bridge`
   - **Version**: `0.1.0`
   - **Author**: `fuih`
   - **Description**: `English MCP Bridge v1 connecting Packet Tracer 9 to stu-packet-tracer-mcp`
   - **Startup**: `On Startup` (recommended for auto-connect) or `On Demand`
   - **Security** checkboxes (check these 8):
     - `Application`
     - `File Operations`
     - `Change User Interface`
     - `IPC`
     - `Get Network Info`
     - `Change Network Info`
     - `Simulation`
     - `Miscellaneous UI`
5. Open the **Script Engine** tab:
   - Replace `main.js` with `extension/src/main.js` (or delete the default and click **Import** -> `extension/src/main.js`).
6. Open the **Custom Interfaces** tab:
   - Click **Import** and add all three UI files (keeping their exact filenames):
     - `extension/src/index.html`
     - `extension/src/style.css`
     - `extension/src/bridge.js`
7. Return to the **Info** tab -> **6. Saving**:
   - Click **Export** and save the packaged module to:
     ```
     extension/dist/stu-mcp-bridge.pts
     ```
8. Close the editor. Back in **Extensions -> Scripting -> Configure PT Script Modules...**, click **Add**, pick `extension/dist/stu-mcp-bridge.pts`, select it, and click **Start**.

---

## Verifying the Connection

1. Start the MCP server in a terminal:
   ```bash
   bun run src/index.ts
   ```
2. In Packet Tracer, the **Student MCP Bridge** window should automatically transition to **Connected (`http://127.0.0.1:54321`)** with the green badge **Protocol: v1**.
3. Verify from the MCP server by calling `pt_bridge_status` — it should report:
   - `connected: true`
   - `protocol: v1`
4. Test automatic reconnection: stop the terminal server (`Ctrl+C`), wait 5 seconds (the UI backs off calmly without log spam), then restart the server. The extension reconnects automatically within 1–10 seconds.

---

## Emergency Fallback (No `.pts` Extension Required)

If you cannot load a `.pts` file (for example, on a locked-down university lab workstation), you can still connect using the paste-in bootstrap snippet:

1. Call `pt_bridge_status` from your AI client to print the bootstrap one-liner.
2. Open any webview-capable Packet Tracer script editor and paste + execute that snippet once per session.
3. The server transparently serves legacy `/next` + `/result` endpoints alongside Bridge v1.
