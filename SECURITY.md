# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes (current release branch, experimental) |
| `< 0.1` | No |

`stu-packet-tracer-mcp` is currently in active `0.1.x` development. Security fixes are applied to the `main` branch and included in the next `0.1.x` release.

## Threat Model

This server is designed to run **locally on your workstation** alongside your local instance of Cisco Packet Tracer 9:

- **MCP HTTP server** binds to `127.0.0.1:39001` (loopback only by default), or runs over `--stdio`.
- **Internal PT HTTP bridge** binds to `127.0.0.1:54321` (loopback only by default).
- **Origin validation**: `/v1/next`, `/v1/result`, `/v1/status`, and legacy endpoints validate browser/webview origins against localhost and Packet Tracer Script Module origins (`this-sm:`, `pt-sm:`, `file-sm:`, `file://`), rejecting unauthorized cross-origin requests with `HTTP 403`.
- **Optional shared token**: set `STU_PT_BRIDGE_TOKEN` in the MCP server environment and paste the same token in the Packet Tracer extension (`--token`) to require matching `X-Stu-Token` authentication on every bridge request.
- **Zero telemetry**: no outbound connections, analytics, or remote phone-home calls are performed.

> [!WARNING]
> If you set `STU_PT_MCP_HOST=0.0.0.0` or `MCP_HOST=0.0.0.0` to expose the MCP server over a LAN, **you are responsible for firewalling and securing that port**. Use `--stdio` or `127.0.0.1` loopback whenever possible, and always enable `STU_PT_BRIDGE_TOKEN` if binding beyond localhost.

## Reporting a Vulnerability

If you discover a security vulnerability in `stu-packet-tracer-mcp`, please do **not** disclose it in a public issue before a fix is ready.

1. Use **GitHub Security Advisories** ("Report a vulnerability") on <https://github.com/fuih/stu-packet-tracer-mcp/security/advisories>.
2. Include in your report:
   - Description of the issue and its impact
   - Clear reproduction steps or proof-of-concept
   - Affected version (`0.1.x` or commit hash)
   - Any suggested remediation if known

We aim to acknowledge reports within 7 days and coordinate disclosure with the reporter once a fix is released.

## Out of Scope

- Vulnerabilities inside Cisco Packet Tracer 9 itself (report those to Cisco PSIRT).
- Third-party dependency vulnerabilities without a demonstrated exploit path against `stu-packet-tracer-mcp`.
- Risks caused by intentionally exposing `0.0.0.0` without firewalling or authentication tokens.
