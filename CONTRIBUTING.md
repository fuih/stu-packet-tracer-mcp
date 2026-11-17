# Contributing to `stu-packet-tracer-mcp`

Contributions, bug reports, lab templates, and documentation improvements are welcome!

---

## Development Setup

1. Install **Bun >= 1.2** (`https://bun.sh`).
2. Clone the repository and install dependencies:

```bash
git clone https://github.com/fuih/stu-packet-tracer-mcp.git
cd stu-packet-tracer-mcp
bun install
```

3. Run the full local verification suite:

```bash
bun run ci
```

`bun run ci` executes four checks that must stay green on every PR:

1. `bun run typecheck` — TypeScript strict check (`tsc --noEmit`)
2. `bun run check:english` — 100% English enforcement across `src/`, `tests/`, `extension/src/`, and docs
3. `bun run check:tools` — verifies `docs/TOOLS.md` matches the live tool registry
4. `bun test` — full offline unit and golden-snapshot test suite

---

## Coding Conventions

- **100% English**: all code, comments, tool descriptions, error messages, tests, extension UI, and docs must be written in English.
- **Stdio safety**: never write logs to `stdout` — always write diagnostic output to `stderr` prefixed with `[stu-pt-mcp]`.
- **Strict tool schemas**: define new tools with `defineTool` (`src/tools/define.ts`) and strict Zod schemas. Whenever you add or edit tool schemas/descriptions, regenerate docs with:

```bash
bun run docs:tools
```

- **Golden SVG tests**: if you intentionally change terminal rendering visuals in `src/render/`, update the golden snapshots and inspect the diff carefully:

```bash
UPDATE_GOLDEN=1 bun test tests/render-terminal.test.ts
```

- **Offline testability**: every new module should include offline unit tests that run without Cisco Packet Tracer open.
- **Conventional Commits**: use clear prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.

---

## Pull Request Checklist

- [ ] `bun run ci` passes locally with zero errors
- [ ] New or modified tools have updated `docs/TOOLS.md` (`bun run docs:tools`)
- [ ] New features include unit tests under `tests/`
- [ ] Live Packet Tracer behavior was verified if touching `src/ipc/`, `src/cli/`, or `extension/src/`
