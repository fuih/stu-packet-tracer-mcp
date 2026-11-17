# Release Checklist (`v0.1.0`)

Status recorded on **2026-11-17** prior to human handoff (`fuih`).

---

## Automated Verification (Completed)

- [x] **TypeScript strict typecheck** (`bun run typecheck`) — 0 errors
- [x] **100% English enforcement** (`bun run check:english`) — 0 violations across `src/`, `tests/`, `extension/src/`, `docs/`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`
- [x] **Auto-generated tool documentation** (`bun run check:tools`) — `docs/TOOLS.md` synced with all **67 registered tools**
- [x] **Full offline unit & golden test suite** (`bun test`) — **403 pass, 0 fail, 1304 expect() calls across 35 files**
  - Bridge Protocol v1 (correlation IDs, long-poll latency, F1 late-result drop, 10x serialization, origin 403, token auth, legacy hex compatibility)
  - Resilient Cisco IOS CLI engine (`[yes/no]` dismissal, multi-page `--More--`, eaten-char prevention, mode tracking)
  - Tool layer (`.strict()` schema enforcement on all 67 tools, fuzzy Levenshtein `<= 2` device resolver, path helpers)
  - Terminal renderer (5 golden SVG themes, XML escaping, line wrapping, callout annotations, `@resvg/resvg-wasm` + DejaVu Sans Mono 2x PNG)
  - Student tools (addressing table, ping matrix + diagnostics, lab checker, CLI output explainer, subnet/VLSM calculator, 10 lab templates, Teach Mode)
  - Report export (Markdown, self-contained print-ready HTML, real OOXML/ZIP `.docx` with embedded PNGs)
- [x] **Standalone compiled Linux binary verification** (`bun run build`)
  - Compiled `dist/stu-packet-tracer-mcp` (109 MB, 386 bundled modules)
  - Verified `--version` (`0.1.0`) and `--help`
  - Copied standalone executable into isolated `/tmp` folder (no `node_modules/` or `assets/` present), started HTTP MCP server, called `pt_render_terminal` via `scripts/mcp-call.ts`, confirmed valid SVG (`2,656 B`) + PNG (`28,643 B`, header `89 50 4e 47 0d 0a 1a 0a`) and `0` bytes on `stdout`
- [x] **Metadata & attribution**
  - `package.json`: `stu-packet-tracer-mcp@0.1.0`, author `fuih`, bin `stu-packet-tracer-mcp`, `files` includes `src`, `assets`, `extension/dist/*.pts`, `server.json`, `README.md`, `NOTICE.md`, `LICENSE`
  - `server.json`: `io.github.fuih/stu-packet-tracer-mcp@0.1.0`
  - `LICENSE` & `NOTICE.md`: dual copyright & full attribution to upstream author Juan Cordero Pascual (`Jcorderop02/packet-tracer-mcp`)
  - `.github/workflows/ci.yml` (Ubuntu, Windows, macOS) & `.github/workflows/release.yml` (tag-triggered standalone binaries + SHA-256 checksums)

---

## Manual Human Steps Before Publishing `v0.1.0`

Packet Tracer 9 was not running during automated build verification, and git remote pushes / npm publishing are reserved for `fuih`. Complete these steps before tagging `v0.1.0`:

### 1. Package the English PT 9 Extension (`.pts`)
Follow [docs/BUILD_EXTENSION.md](../BUILD_EXTENSION.md) inside Cisco Packet Tracer 9 to package `extension/src/` into `extension/dist/stu-mcp-bridge.pts` and commit the `.pts` artifact.

### 2. Run Live Smoke Test Against Packet Tracer 9
Start `stu-packet-tracer-mcp` (`bun run src/index.ts`), open Cisco Packet Tracer 9 with the **Student MCP Bridge** active, and load `/home/fuih/network/Workshop_Static_Routing.pkt`:

- [ ] `bun scripts/mcp-call.ts pt_bridge_status '{}'` -> `connected: true`, `protocol: 1`
- [ ] `bun scripts/mcp-call.ts pt_run_cli '{"device":"R1","command":"show running-config"}'` -> full config ending in `end`, no `--More--`
- [ ] `bun scripts/mcp-call.ts pt_run_cli '{"device":"R2","command":"show ip route"}'` twice in a row -> identical output, no eaten characters
- [ ] `bun scripts/mcp-call.ts pt_ping_matrix '{"devices":["A","B","C","D"]}'` -> all pairs pass after ARP warm-up
- [ ] `bun scripts/mcp-call.ts pt_capture_cli '{"device":"R1","commands":["show ip route","show ip arp"],"format":"both"}'` -> open generated SVG & PNG files and visually inspect
- [ ] `bun scripts/mcp-call.ts pt_addressing_table '{}'` -> matches static-routing lab addressing table
- [ ] `bun scripts/mcp-call.ts pt_export_report '{...}'` -> open generated `report.docx` in LibreOffice/Word and `report.html` in browser (Print -> Save as PDF)
- [ ] Kill and restart `bun run src/index.ts` mid-session -> verify extension reconnects automatically within ~10 seconds

### 3. Create GitHub Repository & Push `main`
```bash
git remote add origin https://github.com/fuih/stu-packet-tracer-mcp.git
git push -u origin main
```
Verify GitHub Actions CI passes on `ubuntu-latest`, `windows-latest`, and `macos-latest`.

### 4. Tag & Publish `v0.1.0`
```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
npm publish --access public
```
Pushing the `v0.1.0` tag automatically triggers `.github/workflows/release.yml` to build and attach Linux, Windows, and macOS binaries plus `SHA256SUMS.txt` to the GitHub Release.
