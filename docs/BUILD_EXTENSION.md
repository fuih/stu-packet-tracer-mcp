# Building the Student MCP Bridge Extension (`.pts`)

Cisco Packet Tracer 9 stores Script Modules in an encrypted `.pts` container that can only be packaged from inside Packet Tracer's built-in Scripting interface. The full, clean English source code lives in `extension/src/`:

- `extension/src/main.js` — Script Engine entry point (`runEnvelope`, `runCode`, `__mcpEval`)
- `extension/src/index.html` — Bridge UI markup ("Student MCP Bridge")
- `extension/src/style.css` — Offline UI styles
- `extension/src/bridge.js` — Protocol v1 long-poll client (`/v1/next`, `/v1/result`) with legacy fallback and exponential backoff

---

## Step-by-Step Packaging Guide (Packet Tracer 9)

1. Open **Cisco Packet Tracer 9**.
2. In the top menu bar, click **Extensions → Scripting → Configure PT Script Modules...**
3. Click **New** (or **Add**) to create a new Script Module.
4. Fill in the module metadata:
   - **ID**: `io.github.fuih.stu-mcp-bridge`
   - **Name**: `Student MCP Bridge`
   - **Version**: `0.1.0`
   - **Author**: `fuih`
   - **Description**: `English MCP Bridge v1 connecting Packet Tracer 9 to stu-packet-tracer-mcp`
5. Open the **Script Files / Data Files** tab inside the Script Module editor:
   - Replace the default `main.js` with the full contents of `extension/src/main.js`.
   - Add a new file named `index.html` and paste `extension/src/index.html`.
   - Add a new file named `style.css` and paste `extension/src/style.css`.
   - Add a new file named `bridge.js` and paste `extension/src/bridge.js`.
6. Under **Permissions / Security**, ensure the module is allowed to:
   - Access the **IPC** tree (`ipc.network()`, `gui`, `scriptEngine`)
   - Open a **WebView** and make local HTTP requests to `http://127.0.0.1:54321`
7. Click **Save As...** and save the compiled module to:
   ```
   extension/dist/stu-mcp-bridge.pts
   ```
8. Close the editor and enable **Student MCP Bridge** in **Extensions → Scripting → Configure PT Script Modules...** (check the box next to it and click **Start**).

---

## Verifying the Connection

1. Start the MCP server in a terminal:
   ```bash
   bun run src/index.ts --http
   ```
2. In Packet Tracer, the **Student MCP Bridge** window should automatically transition from **Waiting for server...** to **Connected (`http://127.0.0.1:54321`)** with the green badge **Protocol: v1**.
3. Verify from the MCP server by calling `pt_bridge_status` — it should report:
   - `connected: true`
   - `protocol: v1`
4. Test automatic reconnection: stop the terminal server (`Ctrl+C`), wait 5 seconds (the UI backs off calmly without log spam), then restart the server. The extension should reconnect automatically within 10 seconds.

---

## Emergency Fallback (No `.pts` Extension Required)

If you cannot load a `.pts` file (for example, on a locked-down university lab workstation), you can still connect using the paste-in bootstrap snippet:

1. Call `pt_bridge_status` from your AI client to print the bootstrap one-liner.
2. Open any webview-capable Packet Tracer script editor and paste + execute that snippet once per session.
3. The server transparently serves legacy `/next` + `/result` endpoints alongside Bridge v1.
