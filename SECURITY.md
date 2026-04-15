# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Claude Command Center, please report it privately via [GitHub Security Advisories](../../security/advisories/new). Do not file a public issue.

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Scope

The following are in scope for security reports:

- Credential storage and encryption (DPAPI/Keychain/libsecret)
- IPC message handling between main and renderer processes
- PTY input injection or command injection
- MCP server access control
- SSH credential handling
- Local file access outside intended directories

## Out of Scope

- Issues in Claude Code CLI itself (report to [Anthropic](https://github.com/anthropics/claude-code))
- Issues in Electron framework (report to [Electron](https://github.com/electron/electron))
- Social engineering attacks
- Attacks requiring physical access to the machine (credentials are machine-bound by design)

## Security Design

- **No telemetry** - the app sends no analytics or tracking data
- **Local-only storage** - all config, logs, and credentials stay on the user's machine
- **Encrypted credentials** - OS credential store (never plaintext)
- **Sandboxed renderer** - Electron's contextIsolation and sandbox enabled
- **IPC validation** - all inter-process messages validated with Zod schemas
- **No remote code execution** - no eval, no remote script loading
