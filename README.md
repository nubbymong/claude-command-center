<div align="center">

<img src="docs/screenshots/splash.png" alt="Claude Command Center" width="220" />

# Claude Command Center

**The desktop orchestrator for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).**
Run dozens of Claude and Codex sessions side-by-side, watch every dollar, intercept every high-risk command, and ship without leaving the keyboard.

<br/>

[![Latest release](https://img.shields.io/github/v/release/nubbymong/claude-command-center?include_prereleases&label=v2.0&color=cba6f7)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-89b4fa)](../../releases)
[![Electron](https://img.shields.io/badge/electron-33-89dceb?logo=electron)](https://www.electronjs.org/)
[![Tests](https://img.shields.io/badge/tests-1338%20passing-a6e3a1)](../../actions)
[![License](https://img.shields.io/badge/license-MIT-fab387)](LICENSE)

<br/>

[Download](#install) &middot; [Features](#what-you-get) &middot; [Why CCC?](#why-ccc) &middot; [Architecture](#architecture) &middot; [Security](#security)

<br/>

<img src="docs/screenshots/tokenomics.jpg" alt="Claude Command Center in action" width="100%" />

</div>

---

## What's new in v2.0

<table>
<tr>
<td width="33%" valign="top">

### Opus 4.8 by default
New sessions land on **Opus 4.8** with the full effort ladder &mdash; Low, Medium, High, **Extra high**, **Max**, and **Ultracode** (xhigh + automatic dynamic-workflow orchestration). Fast mode toggle exposes the cheaper $10/$50 2.5&times; lane.

</td>
<td width="33%" valign="top">

### Permission Attention Tray
High-risk Bash &mdash; `rm -rf`, `sudo`, `dd if=`, `chmod 777`, `--force`, fork bombs &mdash; stacks as toasts top-right via Claude Code&apos;s PreToolUse hook. Everything else auto-allows so the tray only fires when it should.

</td>
<td width="33%" valign="top">

### V2 UX uplift
Tokenomics gains a **Project / Account / Model** group-by lens. Insights drops the iframe for a native render. Logs paginates with incremental filter. The whole shell sits on a unified raised-surface tier with the new V2 primitives.

</td>
</tr>
</table>

<br/>

> **Built for Claude Code 2.1.154+** &middot; **Opus 4.8 dynamic workflows are surfaced end-to-end** &middot; v2.0 promotes the v1.5 beta line; channels and channel-aware features land in v2.1.

---

## What you get

<table>
<tr>
<td width="50%" valign="top">

### Multi-session orchestration

Tabbed sessions with save/restore, attention badges, identity colours, and one-keystroke switching. Local terminals in any cwd. SSH terminals with encrypted creds (DPAPI / Keychain) and automated remote setup. Combined Mode pairs Claude with a partner shell in the same tab. Shell-only mode for plain terminals when you just need one.

<img src="src/renderer/assets/training/step-session-options.jpg" alt="Session configuration" width="100%" />

</td>
<td width="50%" valign="top">

### Tokenomics that actually informs

Daily cost trends, per-model breakdown, 5-hour + weekly rate-limit bars, burn-rate detection, anomaly alerts, and project filters. v2 adds a **group-by lens** that pivots the breakdown panel between project, account, and model with one click.

<img src="docs/screenshots/tokenomics.jpg" alt="Tokenomics" width="100%" />

</td>
</tr>
<tr>
<td valign="top">

### Memory you can browse and prune

Every Claude memory file across every project, surfaced as a card grid with size, type, recency, and search. Read rendered markdown in the right pane. Delete stale entries directly from the UI. Catches drift before it bloats your context.

<img src="docs/screenshots/memory.jpg" alt="Memory visualizer" width="100%" />

</td>
<td valign="top">

### Cloud agents + workflows

Tasks dispatch headless Claude jobs with live output streaming. Library is where you author agent templates that double as in-session subagents. With Opus 4.8&apos;s dynamic workflows, the same orchestration patterns now scale to **up to 1,000 parallel subagents per run** &mdash; CCC&apos;s tray still gates the high-risk commands they invoke.

<img src="docs/screenshots/agent-hub.jpg" alt="Agent Hub" width="100%" />

</td>
</tr>
<tr>
<td valign="top">

### GitHub PR context where you work

Right-rail panel surfaces PR status, CI runs, reviews, unresolved threads, and inferred issue context from your branch + transcript. Sign in via OAuth, PAT, or adopt your existing `gh` CLI auth. Per-session opt-in; collapses to a floating icon when you don&apos;t need it.

<img src="src/renderer/assets/training/github-panel.jpg" alt="GitHub sidebar" width="100%" />

</td>
<td valign="top">

### Conductor MCP: vision, codex review, host transfer

Local MCP server exposes 17 browser-vision tools (screenshot, navigate, click, type, eval) plus `codex_review` so Claude can ask Codex to spot-check its work. SSH sessions reach the same server transparently through a reverse tunnel.

<img src="docs/screenshots/vision.jpg" alt="Vision system" width="100%" />

</td>
</tr>
</table>

---

## Why CCC?

Claude Code is a powerful CLI. But the moment you have more than one project, more than one account, more than one machine &mdash; the experience fragments. You lose track of which terminal is which, which sessions are paused, what they&apos;ve spent, where their attention is going. You hand-edit `~/.claude/settings.json` to tune behaviour. You guess about cost.

Claude Command Center wraps Claude Code (and Codex) in a desktop app that treats *the session* as the first-class object. Every session has a colour, a name, an account, a working directory, a saved config. Every spawn surfaces its tokens, its model, its rate-limit window, and its identity in a status strip you don&apos;t have to scroll. Every high-risk command stops at the tray before Claude runs it. Every cent is captured in Tokenomics and broken down the way you want.

It doesn&apos;t replace Claude Code. It conducts it.

---

## Install

### Download

1. Grab the latest installer from **[Releases](../../releases)**:
   - Windows: `ClaudeCommandCenter-x.y.z.exe`
   - macOS: `ClaudeCommandCenter-x.y.z-mac.dmg`
2. Verify the SHA-256 checksum against `CHECKSUMS.txt` in the release.
3. Run the installer and pick your Data + Resources directories.
4. The setup wizard hands off Claude CLI auth.

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 2.1.154+ (for Opus 4.8 + dynamic workflows)
- Node.js 20+ (Claude Code dependency)
- Windows 10 / 11 or macOS 12+

> **Windows note** &middot; The installer is not code-signed today, so SmartScreen will warn on first run. Click **More info** &rarr; **Run anyway**. The macOS DMG is signed and notarized. Every release is also scanned by VirusTotal across 70+ engines.

---

## Build from source

Don&apos;t trust the installer? Build it yourself &mdash; the source is what ships.

```bash
git clone https://github.com/nubbymong/claude-command-center.git
cd claude-command-center
npm install
npx vitest run       # 1338 unit tests
npm run dev          # HMR development
npm run build        # production build
```

### Package for distribution

```bash
npm run package:win  # Windows NSIS installer
npm run package:mac  # macOS DMG (Apple credentials required for signing/notarization)
```

---

## Architecture

| Layer | Stack |
|:------|:------|
| Shell | Electron 33 (frameless, sandboxed renderer, zod-validated IPC) |
| UI | React 18 + Tailwind CSS v4 (`@theme` tokens, Catppuccin Mocha) |
| State | Zustand 5 (hydrated from disk on boot) |
| Terminal | xterm.js 5.5 + node-pty (ConPTY on Windows) |
| Build | electron-vite |
| MCP | `@modelcontextprotocol/sdk` (Conductor MCP server: vision + codex review + host transfer) |
| Tests | Vitest unit (1338) + Playwright E2E |

The main process owns config persistence, the PTY pool, the hooks HTTP gateway (drives the permission tray), the tokenomics aggregator, the statusline ingest, the Conductor MCP server, and cloud-agent dispatch. The renderer is a React SPA that hydrates from disk and talks to main exclusively through typed IPC channels. SSH sessions get a per-session settings file, a per-session MCP config, and a reverse tunnel injected automatically.

---

## Security

### Credentials

| Platform | Backend | Scope |
|:---------|:--------|:------|
| Windows | DPAPI via Electron `safeStorage` | Machine + user |
| macOS | Keychain via Electron `safeStorage` | Machine + user |
| Linux | libsecret via Electron `safeStorage` | Machine + user |

SSH passwords, sudo passwords, and encrypted notes are stored as base64 blobs &mdash; never plaintext. They&apos;re machine-bound and cannot be exfiltrated or transferred.

### Network footprint

CCC makes **no telemetry calls of its own**. The Claude API goes through the Claude CLI directly. The only outbound traffic is:

- **Update check** &mdash; GitHub Releases API on launch and on window focus.
- **Service status** &mdash; `status.claude.com` for the live Code/Claude.ai indicators.
- **GitHub sidebar** (opt-in) &mdash; GitHub API after you sign in.
- **Model pricing** &mdash; LiteLLM open pricing JSON, cached locally for 24h.

### Defence in depth

- **Permission Attention Tray** &mdash; high-risk Bash gates through the gateway before Claude executes. Overflow auto-denies; nothing leaks.
- **Atomic config writes** &mdash; every `writeConfig` goes through a `.tmp` + rename so an interrupted save can&apos;t leave a half-written file.
- **Daily CONFIG backups** &mdash; every launch snapshots `CONFIG/*.json` to `CONFIG/_backups/YYYY-MM-DD/`. Last 7 retained. Recovery is a copy.
- **Capture-script lock** &mdash; the screenshot tool acquires a `.capture.lock` and only restores files it explicitly backed up.

### Reporting vulnerabilities

Please report security issues privately via [GitHub Security Advisories](../../security/advisories/new).

---

## Keyboard shortcuts

| Shortcut | Action |
|:---------|:-------|
| `Ctrl+T` | New config |
| `Ctrl+W` | Close session |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous session |
| `Ctrl+1` &hellip; `Ctrl+9` | Jump to session N |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+/` (`Cmd+/` on macOS) | Toggle GitHub sidebar |
| `Alt+V` | Paste clipboard image |
| `Escape` | Interrupt Claude (`Ctrl+C`) |
| `Shift+Enter` | New line without sending |

All shortcuts are customisable in **Settings &rarr; Shortcuts**.

---

## Project history

CCC was developed privately from late 2025 and open-sourced in April 2026. The git history was squashed for the initial public release; everything from v1.0 forward is in the open.

For the full per-release changelog see [`src/renderer/changelog.ts`](src/renderer/changelog.ts).

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding standards, and the PR process.

---

## License

[MIT](LICENSE) &mdash; see the LICENSE file for details.
