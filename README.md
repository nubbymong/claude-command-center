<div align="center">

<img src="docs/screenshots/brand-icon.png" alt="AI Code Conductor" width="180" />

# AI Code Conductor

<sub>formerly **Claude Command Center**</sub>

### **v2.0** &middot; Mission control for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Run dozens of Claude Code and Codex sessions in parallel, each with its own account, working directory, and saved config. See every session's spend, identity, and attention at a glance. Read back any conversation, track every cent, and prune your memory before it bloats your context.

<br/>

[![Release](https://img.shields.io/github/v/release/nubbymong/claude-command-center?include_prereleases&label=release&color=cba6f7&labelColor=313244)](../../releases)
[![Opus 4.8](https://img.shields.io/badge/Opus%204.8-day--one-f9e2af?labelColor=313244)](https://www.anthropic.com/news/claude-opus-4-8)
[![Tests](https://img.shields.io/badge/tests-passing-a6e3a1?labelColor=313244)](../../actions)
[![Platform](https://img.shields.io/badge/Windows%20%7C%20macOS%20(arm64)%20%7C%20Linux%20(experimental)-89b4fa?labelColor=313244)](../../releases)
[![License](https://img.shields.io/badge/MIT-fab387?labelColor=313244)](LICENSE)

[Download](#install) &middot; [Features](#what-it-does) &middot; [Architecture](#under-the-hood) &middot; [Security](#security)

<br/>

<sub>An independent, community-built project &middot; not affiliated with, endorsed by, or sponsored by Anthropic. See [Disclaimer](#disclaimer-and-trademarks).</sub>

<br/>

<img src="docs/screenshots/v2-shell-hero.jpg" alt="AI Code Conductor v2.0 multi-session shell" width="100%" />

</div>

---

## What it does

Claude Code is a remarkable CLI. But the moment you have more than one project, more than one account, or more than one machine, the experience fragments. You lose track of which terminal is which, which sessions are paused, what they have spent, and where their attention is going.

AI Code Conductor wraps Claude Code and Codex in a desktop app that treats the session as the first-class object. Every session has a colour, a name, an account, a working directory, and a saved config. Every spawn surfaces its tokens, its model, its rate-limit window, and its identity. Every cent is captured and pivotable.

It does not replace Claude Code. It conducts it.

---

## Highlights

<br/>

### Sessions and saved configs

<img src="src/renderer/assets/training/step-session-options.jpg" alt="Session configuration" width="100%" />

Every workspace starts as a **saved config**: a label, a colour, a working directory, a model, and any agent templates you want pre-loaded. New sessions land on **Opus 4.8**. Effort is a live setting you change inside Claude with `/effort` and read off the statusline and the session card, not a config field. Drag a folder onto the sidebar to bootstrap a working-directory config in one drop. Local or SSH, the same form drives both.

<br/>

### Multiple accounts, per-session isolation

<img src="docs/screenshots/settings.jpg" alt="Settings" width="100%" />

Run more than one Claude account side by side. Your existing login is captured into a protected **primary** account on first run, and every session runs under a saved, isolated account, so signing in to one never disturbs another or your default login. You pick the account at **launch time**, the first time a session spawns this run. Add an account by running `/login` in any session: the Conductor detects the new login and offers to save it as a separate named account. Name and colour each one in **Settings, Accounts**; the colour follows the account onto the session card, the statusline, and the launch picker. Memory, settings, and history stay shared across all accounts.

<br/>

### Logs, a chat-transcript viewer

<img src="docs/screenshots/logs.jpg" alt="Logs chat-transcript viewer with timeline rail" width="100%" />

The Conductor indexes Claude's own conversation transcripts and renders them back as a readable chat: messages, tool calls, and thinking. A **timeline rail** beside the transcript scrubs the whole conversation; click to jump. **Full-text search** spans every conversation and jumps you straight to the matching turn. A per-session **Conversation** tab live-follows the running session. Deleting the index never touches your conversations, which stay in `~/.claude/projects`.

<br/>

### Tokenomics

<img src="docs/screenshots/tokenomics.jpg" alt="Tokenomics dashboard" width="100%" />

Track every dollar Claude and Codex cost you across every session. A background indexer reads all of your transcripts (including subagent and sidechain files), dedups globally, and computes cost at query time from live pricing, so the dashboard opens instantly with a **KPI row** (total spend, tokens, sessions, daily burn), a **daily-spend chart** and **per-model breakdown**, and a **sessions table** with cost, model, and config attribution. Filter the whole view by date, model, **account**, or project. Pricing comes from LiteLLM open pricing (cached 24 hours).

<br/>

### Memory dashboard

<img src="docs/screenshots/memory.jpg" alt="Memory dashboard" width="100%" />

A dashboard over Claude's auto-memory across every project. A **KPI strip** (memories, projects, total size, stale-over-30-days, index health) and charts summarise the whole store; a **ranked project list** shows staleness dots, index warnings, and live-session activity. Drill into any project for a sortable memory table, then open a memory in the **reading drawer** to read it cleanly, write missing frontmatter, or delete it. Full-text search runs across everything. Catches drift before it bloats your context.

---

## The rest of the surface

<table>
<tr>
<td width="50%" valign="top">

### Sentinel

<img src="docs/screenshots/settings.jpg" alt="Settings, Sentinel" width="100%" />

An opt-in watcher that notices when Claude Code updates and checks whether the new version might affect the Conductor. Findings surface in a labelled **Sentinel** chip in the title bar and a panel. It proposes **model and effort registry** fixes you apply yourself and never changes anything automatically. A hot-reloadable registry means brand-new models still get a colour, label, and pricing. Fail-open, so it never blocks the app. Toggle it in **Settings, Sentinel**.

</td>
<td width="50%" valign="top">

### Conductor MCP

<img src="docs/screenshots/vision.jpg" alt="Conductor MCP page" width="100%" />

A local MCP server exposing 17 browser-vision tools (screenshot, navigate, click, type, eval) plus `codex_review`, so Claude can ask Codex to spot-check its own work. One global Chrome instance is shared across every session, so cookies and logins persist. SSH sessions reach the same server transparently through an auto-injected reverse tunnel.

</td>
</tr>
<tr>
<td valign="top">

### Agent Hub

<img src="docs/screenshots/agent-hub.jpg" alt="Agent Hub" width="100%" />

Two surfaces in one. **Tasks** dispatch headless Claude as background jobs with live status and output streaming. The **Library** is where you author agent templates (name, prompt, model, tool whitelist) that surface as tickable subagents in every Edit Config dialog, so Claude can delegate to them via the Task tool inside a running session. **Teams** chain agents with shared context and per-step prompts.

</td>
<td valign="top">

### Codex provider, first-class

<img src="src/renderer/assets/training/step-codex.jpg" alt="Codex provider configuration" width="100%" />

OpenAI Codex CLI sits alongside Claude in the New Session dialog. Pick the provider per spawn. The gpt-5 series sits in the model dropdown, with read-only / standard / auto / unrestricted permission presets in the toolbar. The resume picker mirrors the Claude flow. Tokenomics segments Codex spend automatically.

</td>
</tr>
<tr>
<td valign="top">

### GitHub PR context where you work

<img src="src/renderer/assets/training/github-panel.jpg" alt="GitHub sidebar" width="100%" />

A collapsible right-rail panel surfaces PR status, CI runs, reviews, unresolved threads, and inferred issue context from your branch and transcript. Sign in via OAuth or PAT, or adopt your existing `gh` CLI auth. Per-session opt-in; toggles with `Ctrl+/` (`Cmd+/` on macOS).

</td>
<td valign="top">

### Combined Mode and Draw

<img src="src/renderer/assets/training/step-combined.jpg" alt="Combined Mode pairs Claude with a partner shell" width="100%" />

Pair Claude with a partner shell (`pwsh`, `bash`, `cmd`) in the same tab for the build, git, and docker commands you want one keystroke from your prompt. The Draw scratchpad is a per-session Excalidraw whiteboard that persists with the config; freeze the webview pane to annotate a snapshot, or export the canvas straight into Claude as an image.

</td>
</tr>
<tr>
<td valign="top">

### Snap and Vision capture

<img src="src/renderer/assets/training/step-snap.jpg" alt="Snap region capture" width="100%" />

Region or window capture from any screen, encoded at 1920px / JPEG 85 to stay under Claude's image budget. Local sessions get a file path inline; SSH fetches the image over the Conductor MCP tunnel. Paste images from the clipboard with **Alt+V**.

</td>
<td valign="top">

### Dynamic workflows, surfaced

<img src="docs/screenshots/dynamic-workflows.jpg" alt="Dynamic workflows" width="100%" />

Invoke an Opus 4.8 dynamic workflow three ways: include the word `workflow` in a prompt for a one-off, run `/effort ultracode` so every substantive task auto-orchestrates, or run the bundled `/deep-research <question>`. Watch active runs with `/workflows`. The Conductor rolls workflow spend into your session totals, and a Settings toggle disables dynamic workflows globally if you want them off.

</td>
</tr>
</table>

---

## Install

### Download

1. Grab the latest installer from **[Releases](../../releases)**.
   - Windows: `ClaudeCommandCenter-x.y.z.exe`
   - macOS (Apple Silicon): `ClaudeCommandCenter-x.y.z-mac.dmg`
   - Linux (experimental): `ClaudeCommandCenter-x.y.z-linux-x86_64.AppImage`

   > Installer files keep the legacy `ClaudeCommandCenter-` name on purpose: the auto-updater in every installed copy matches release assets by that name, so renaming the files would silently strand existing installs.
2. Verify the **SHA-256** of the file you downloaded against the checksum printed on the release page.
3. Run the installer and choose your Data and Resources directories.
4. The setup wizard hands off to Claude CLI auth.

### Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (a recent version, for Opus 4.8 and dynamic workflows)
- Node.js 20+ (a Claude Code dependency)
- Windows 10 or 11 (x64), or macOS 12+ on **Apple Silicon (arm64)**, or a Linux distro with **glibc 2.39+** (Ubuntu 24.04+, Rocky 10+, Fedora 40+) on x64

> **Linux (experimental)** &middot; Make the AppImage executable before first run (`chmod +x ClaudeCommandCenter-*.AppImage`); it needs FUSE (`sudo apt install libfuse2` on Ubuntu) and the usual GTK 3 desktop libraries. Verified on Ubuntu 24.04 and Rocky Linux 10. Older glibc lines (Ubuntu 22.04, Rocky 8/9) are not covered by this build. The vision browser tool needs a **deb/rpm** Chrome or Chromium — the Ubuntu *snap* build's confinement blocks the debug profile, so vision stays disabled with snap-only Chromium.

> **Windows SmartScreen** &middot; These installers are **not code-signed**. This is an independent, single-maintainer build, and a code-signing certificate is not in place yet, so Windows SmartScreen will warn the first time you run a new release: click **More info**, then **Run anyway**. To convince yourself the download is intact, verify the SHA-256 against the value on the release page before running it. Releases produced by the CI pipeline are additionally scanned through VirusTotal (70+ engines); the scan link is included in those release notes.

> **macOS** &middot; The DMG is not notarised. Gatekeeper will block it on first open: right-click the app and choose **Open**, or allow it under **System Settings, Privacy & Security**.

---

## Build from source

```bash
git clone https://github.com/nubbymong/claude-command-center.git
cd claude-command-center
npm install
npm run typecheck    # tsc, no emit
npx vitest run       # unit suite
npm run dev          # HMR dev
npm run build        # production build
```

```bash
npm run package:win    # Windows NSIS installer
npm run package:mac    # macOS DMG (Apple Silicon)
npm run package:linux  # Linux AppImage (x64)
```

The repository ships well over two thousand unit tests plus a native (better-sqlite3 / node-pty) suite; both run green on Windows and macOS in CI on every labelled PR. See the [Actions](../../actions) tab for current status.

---

## Under the hood

| Layer | Stack |
|:------|:------|
| Shell | Electron (frameless, sandboxed renderer, zod-validated IPC) |
| UI | React 18 + Tailwind CSS v4 (`@theme` tokens, Catppuccin Mocha by default, with light and system themes) |
| State | Zustand 5 (hydrated from disk on boot) |
| Terminal | xterm.js 5.5 + node-pty (ConPTY on Windows) |
| Build | electron-vite |
| MCP | `@modelcontextprotocol/sdk` (Conductor MCP server: browser vision + Codex review) |
| Tests | Vitest unit + native suites, Playwright E2E |

The main process owns config persistence, the PTY pool, the hooks HTTP gateway (which drives the session attention pulse), the tokenomics aggregator, the statusline ingest, the Conductor MCP server, and cloud-agent dispatch. The renderer is a React SPA that hydrates from disk and talks to main exclusively through typed IPC channels. SSH sessions get a per-session settings file, a per-session MCP config, and a reverse tunnel injected automatically.

---

## Security

| Layer | What we do |
|:------|:-----------|
| **Credentials** | SSH passwords, sudo passwords, and encrypted notes are stored as encrypted blobs via the OS keystore (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Machine-bound, never plaintext. |
| **Account isolation** | Each session runs under its own isolated home so signing in to one account never touches another or your default login. The original global login is snapshotted read-only on first run. |
| **Permissions** | The Conductor honors Claude Code's own permission prompts and settings. It is not a gate and never auto-approves or intercepts tool calls on your behalf. |
| **Telemetry** | None of our own. The Claude API goes through the Claude CLI directly. Outbound is limited to: GitHub Releases (update check), `status.claude.com` (status pills), the GitHub API (opt-in GitHub sidebar after sign-in), and LiteLLM open-pricing JSON (cached 24 hours). |
| **Data integrity** | Atomic config writes (`.tmp` + rename). Daily snapshots of `CONFIG/*.json` to `CONFIG/_backups/YYYY-MM-DD/`, 7-day retention. Sandboxed renderer; typed IPC with schema validation on data-bearing channels. |
| **Releases** | Installers are unsigned (see [Install](#install)). Releases built by the CI pipeline are scanned through VirusTotal across 70+ engines; verify the SHA-256 from the release page before running any installer. |

Report vulnerabilities privately via [GitHub Security Advisories](../../security/advisories/new). See [SECURITY.md](SECURITY.md) for scope.

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
| `Escape` | Interrupt Claude |
| `Shift+Enter` | New line without sending |

All shortcuts are rebindable in **Settings, Shortcuts**.

---

## Project history

The app was developed privately from late 2025 and open-sourced in April 2026 (as Claude Command Center). The git history was squashed for the initial public release; everything from v1.0 forward is in the open.

Per-release detail lives in [`src/renderer/changelog.ts`](src/renderer/changelog.ts).

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding standards, and the PR process.

---

## Disclaimer and trademarks

Claude and Claude Code are trademarks of Anthropic, PBC. OpenAI and Codex are trademarks of OpenAI. This project is an independent, community-built tool. It is **not affiliated with, endorsed by, sponsored by, or supported by Anthropic or OpenAI**.

All references to "Claude", "Claude Code", "Codex", "Anthropic", or "OpenAI" are nominative, used solely to identify the third-party software this tool interoperates with. AI Code Conductor (formerly Claude Command Center) is a separate work that wraps and orchestrates the official Claude Code and Codex CLIs. It does not include, modify, or redistribute their code, and it requires you to install and authenticate those tools yourself under their own terms.

If you are a rights holder with a concern about this project's use of a name or mark, please open a [GitHub issue](../../issues) or contact the maintainer and it will be addressed promptly.

---

## License

[MIT](LICENSE).
</content>
</invoke>
