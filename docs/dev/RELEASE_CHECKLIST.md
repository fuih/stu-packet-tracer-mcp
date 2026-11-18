# Release Checklist (`v0.1.0`)

Status recorded on **2026-11-18** prior to public GitHub release (`fuih`).

---

## Automated Verification (Completed)

- [x] **TypeScript strict typecheck** (`bun run typecheck`) — 0 errors
- [x] **100% English enforcement** (`bun run check:english`) — 0 violations across `src/`, `tests/`, `extension/src/`, `docs/`, `scripts/`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
- [x] **Auto-generated tool documentation** (`bun run check:tools`) — `docs/TOOLS.md` synced with all **70 registered tools**
- [x] **Full offline unit & golden test suite** (`bun test`) — **411 pass, 0 fail, 1357 expect() calls across 36 files**
  - Bridge Protocol v1 (correlation IDs, long-poll latency, F1 late-result drop, 10x serialization, origin 403, token auth, legacy hex compatibility)
  - Resilient Cisco IOS CLI engine (`[yes/no]` dismissal, multi-page `--More--`, eaten-char prevention, mode tracking)
  - Tool layer (`.strict()` schema enforcement on all 70 tools, fuzzy Levenshtein `<= 2` device resolver, path helpers)
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

## Live Packet Tracer 9 Smoke Test (Completed 2026-11-17)

Tested live against **Cisco Packet Tracer 9.0.1** running our open-source **Student MCP Bridge (`Protocol: v1`)** with `Workshop_Static_Routing.pkt`:

- [x] `bun scripts/mcp-call.ts pt_bridge_status '{}'` -> `connected: true`, `protocol: v1`
- [x] `bun scripts/mcp-call.ts pt_run_cli '{"device":"R1","command":"show running-config"}'` -> full config ending in `end`, zero `--More--`
- [x] `bun scripts/mcp-call.ts pt_run_cli '{"device":"R2","command":"show ip route"}'` twice in a row -> identical output, zero eaten characters
- [x] `bun scripts/mcp-call.ts pt_ping_matrix '{"devices":["A","B","C","D"],"render_image":true}'` -> 12/12 pairs `PASS 4/4` (`ping-matrix.svg` + `ping-matrix.png`)
- [x] `bun scripts/mcp-call.ts pt_capture_cli '{"device":"R1","commands":["show ip route","show ip arp"],"format":"both"}'` & `pt_capture_pc_command` (`A` `ipconfig`, `ping 40.0.0.2`) -> crisp retina PNGs & SVGs visually verified
- [x] `bun scripts/mcp-call.ts pt_addressing_table '{}'` -> 12 rows matching static-routing lab including all 4 PC default gateways (`10.0.0.1`, `20.0.0.1`, `30.0.0.1`, `40.0.0.1`)
- [x] `bun scripts/mcp-call.ts pt_export_report '{...}'` -> generated `workshop-static-default-routing.docx` (499 KB), `.html` (142 KB), `.md` (2.0 KB), `topology.png`, `ping-matrix.png`, and 4 terminal captures
- [x] Killed and restarted `bun run src/index.ts` mid-session -> extension auto-reconnected on tick 1 (~1s) without touching Packet Tracer

---

## Remaining Manual Steps Before Publishing `v0.1.0`

### 1. Commit the Packaged `.pts` Extension (if exported)
Ensure `extension/dist/stu-mcp-bridge.pts` is exported from Packet Tracer per [docs/BUILD_EXTENSION.md](../BUILD_EXTENSION.md) and committed.

### 2. Create GitHub Repository & Push `main`
```bash
git remote add origin https://github.com/fuih/stu-packet-tracer-mcp.git
git push -u origin main
```
Verify GitHub Actions CI passes on `ubuntu-latest`, `windows-latest`, and `macos-latest`.

### 3. Tag & Publish `v0.1.0`
```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
npm publish --access public
```
Pushing the `v0.1.0` tag automatically triggers `.github/workflows/release.yml` to build and attach Linux, Windows, and macOS binaries plus `SHA256SUMS.txt` to the GitHub Release.
