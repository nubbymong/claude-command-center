<p align="center">
  <img src="https://raw.githubusercontent.com/nubbymong/claude-command-center/beta/docs/screenshots/hero-banner.png" alt="AI Code Conductor — mission control for Claude Code" width="100%">
</p>

<p align="center">
  <a href="../../releases"><img src="https://img.shields.io/github/v/release/nubbymong/claude-command-center?include_prereleases&label=release&color=cba6f7&labelColor=313244" alt="Release"></a>
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20(arm64)%20%7C%20Linux%20(experimental)-89b4fa?labelColor=313244" alt="Windows, macOS, Linux">
  <a href="../../actions"><img src="https://img.shields.io/badge/tests-passing-a6e3a1?labelColor=313244" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/MIT-fab387?labelColor=313244" alt="MIT"></a>
</p>

# AI Code Conductor

**Mission control for Claude Code** — run dozens of Claude Code and Codex sessions in parallel, each with its own account, working directory and saved config, and see every session's spend, identity and attention at a glance.

Claude Code is a remarkable CLI. But the moment you have more than one project, more than one account, or more than one machine, the experience fragments: you lose track of which terminal is which, which sessions are paused, what they have spent, and where their attention is going. AI Code Conductor wraps Claude Code and Codex in a desktop app that treats **the session as the first-class object**. Every session has a colour, a name, an account, a working directory and a saved config; every spawn surfaces its tokens, model, rate-limit window and identity; every cent is captured and pivotable. It does not replace Claude Code. It conducts it.

> Formerly **Claude Command Center**. Same app, same data — the rename is cosmetic and updates carry across on their own. An independent, community-built project, not affiliated with Anthropic — see [Disclaimer](#disclaimer-and-trademarks).

---

## Sessions, accounts, and a sidebar that knows what is going on

<p align="center">
  <img src="https://raw.githubusercontent.com/nubbymong/claude-command-center/beta/docs/screenshots/shot-sessions.png" alt="The session sidebar — live sessions across three accounts" width="88%">
</p>

Every workspace starts as a **saved config**: a label, a colour, a working directory, a starting model and effort, and any agent templates you want pre-loaded. Configs live in **sections and groups** you arrange yourself, and the sidebar mirrors that hierarchy for the sessions running under them. Each session card carries the whole picture on one line: status, the model and effort actually in use (read live from Claude, never guessed), context consumed, the account it is signed in as, and its type — Claude Code, Codex or a plain terminal, over SSH or not.

- **Multiple accounts, real isolation** — your existing login is captured into a protected primary account on first run, and every session runs under a saved, isolated home. Pick the account at launch, **switch it mid-session** without losing the session, and **park** the ones you are not using. Add one by running `/login` in any session; the Conductor notices and offers to save it.
- **In-app claude.ai sign-in** — each account also carries its own claude.ai web session, signed in inside the app rather than by handing you off to a browser.
- **Attention where it belongs** — a session that needs you pulses; a session that is working says so; nothing is inferred from a spinner.
- **Command buttons** — a bar of your own buttons under every terminal. A button does one of three things — sends a prompt to Claude, runs a line in a shell, or opens a page in the browser pane — and the dialog asks that first, then shows you the button and the exact text it will type as you fill it in. Rows are named for where a button runs, a button shared by every config carries a `global` mark, and an argument that is a secret (a token, a key) lives in the OS keychain and is typed as a reference, so it never reaches your shell history.
- **Help where you are** — the tip of the day and **Ask Conductor** sit at the foot of the sidebar. Ask Conductor opens a real Claude session that has read the app's documentation and its known issues; Discuss on any tip hands the question to it. Right-click either to switch it off.

## Remote sessions that survive the link

Remote sessions run over SSH with the same session model as local ones — same dialog, same statusline, same account handling — and the Conductor's own MCP server reaches the remote through an automatically injected reverse tunnel. Mark a config **Detachable** and its remote session runs under `tmux`, so a dropped VPN, a closed lid or a flaky network no longer kills the work: Claude keeps going on the remote, and reconnecting reattaches to the same session with your conversation and scrollback intact. If the remote has no tmux the app can fetch a verified copy for it, or push one down the existing connection when the remote has no internet of its own. Ending a session and leaving it running are separate, explicit choices, and a pill on the session says which it is.

## Agent Canvas — review what Claude built by pointing at it

<p align="center">
  <img src="https://raw.githubusercontent.com/nubbymong/claude-command-center/beta/docs/screenshots/shot-canvas.png" alt="The Agent Canvas — annotating a rendered mockup" width="88%">
</p>

Claude renders a design mockup, or your project's real built site, onto a canvas inside the app. You mark it up directly — pin a note to an element, draw over a region, leave a general comment — and submit the lot as one review. Claude receives the notes **anchored to the actual elements you pointed at**, works through them in one pass, renders the result and hands back; the pane returns you to the terminal on its own. It is a review loop rather than a screenshot: the page is laid out by a real browser engine, so what you annotate is what will ship. Each canvas holds one subject, so a new topic never inherits an old one's notes; the pane names the subject it is showing and a picker moves you between the canvases a session has built up (the library lists every canvas in the project, for pruning); and when you answer a note in chat instead of the pane, Claude marks it addressed — the final approval stays yours. Reviews come back as the rounds you sent, each saying who it is waiting on, with "approve the remaining N" to close a round in one go; the Canvas button counts what is still open across every canvas the session owns, so nothing waits out of sight. The canvas also has a **plan mode**: before starting anything large, Claude puts the plan on the canvas rather than in the chat, and you review it the way you review a mockup — per step, anchored — before a line of code is written.

## Tokenomics — every cent, pivotable

<p align="center">
  <img src="https://raw.githubusercontent.com/nubbymong/claude-command-center/beta/docs/screenshots/shot-tokenomics.png" alt="The Tokenomics dashboard" width="88%">
</p>

A background indexer reads all of your transcripts — subagent and sidechain files included — dedups globally, and computes cost at query time from live pricing, so the dashboard opens instantly. A KPI row, a daily-spend chart, a per-model breakdown and a sessions table with cost, model and config attribution; filter the whole view by date, model, **account** or project. Codex spend is segmented automatically. Pricing comes from LiteLLM's open pricing data, cached for a day.

## Logs — your conversations, readable

<p align="center">
  <img src="https://raw.githubusercontent.com/nubbymong/claude-command-center/beta/docs/screenshots/shot-logs.png" alt="The Logs viewer with its timeline rail" width="88%">
</p>

The Conductor indexes Claude's own transcripts and renders them back as a readable chat — messages, tool calls, thinking. A **timeline rail** beside the transcript scrubs the whole conversation; click to jump. **Full-text search** spans every conversation and lands you on the matching turn. A per-session **Conversation** tab live-follows the running session. Deleting the index never touches your conversations, which stay in `~/.claude/projects`.

## Memory — catch the drift before it costs you context

<p align="center">
  <img src="https://raw.githubusercontent.com/nubbymong/claude-command-center/beta/docs/screenshots/shot-memory.png" alt="The Memory dashboard" width="88%">
</p>

A dashboard over Claude's auto-memory across every project. A KPI strip — memories, projects, total size, stale-over-30-days, index health — and charts summarise the store; a ranked project list shows staleness, index warnings and live-session activity. Drill into any project for a sortable table, open a memory in the **reading drawer** to read it cleanly, write missing frontmatter, or delete it. Full-text search runs across everything.

## Insights — what actually happened, across every account

<p align="center">
  <img src="https://raw.githubusercontent.com/nubbymong/claude-command-center/beta/docs/screenshots/shot-insights.png" alt="Insights — a cross-account report" width="88%">
</p>

Scheduled and on-demand reports over your own usage, runnable across **all of your accounts at once** rather than one at a time. Where Tokenomics answers what things cost, Insights answers what you did with them.

## And the rest of the surface

- **Conductor MCP** — a local MCP server giving Claude eighteen browser-vision tools (screenshot, navigate, click, type, eval), a host-screenshot fetch, the Agent Canvas tools and `codex_review`, so Claude can ask Codex to spot-check its own work. One global Chrome instance is shared across every session so logins persist; SSH sessions reach it through the tunnel.
- **Agent Hub** — dispatch headless Claude as background **Tasks** with live status and streaming output; author agent templates in the **Library** that surface as tickable subagents in every config; chain them as **Teams** with shared context.
- **Codex** — OpenAI's Codex CLI sits beside Claude in the New Session dialog. Pick the provider per spawn, the gpt-5 series in the model dropdown, read-only / standard / auto / unrestricted permission presets. Still marked Beta, behind a master switch.
- **GitHub panel** — PR status, CI runs, reviews, unresolved threads and inferred issue context in a collapsible right rail; OAuth, PAT, or adopt your `gh` login. `Ctrl+/` (`Cmd+/`).
- **Sentinel** — an opt-in watcher that notices when Claude Code updates and checks whether the new version might affect the Conductor, proposing model and effort registry fixes you apply yourself. Fail-open; a hot-reloadable registry means brand-new models still get a colour, label and pricing.
- **Browser pane** — every session has a browser beside its terminal: an address bar (type `localhost:5173` and press Enter), working history, a home page per config, saved favourites, and a button to open the page in your real browser. Pages load in a sandbox with every permission off. A command button can point it at a dev server as it starts ("watch for a page") or simply open a page; freeze the page to annotate a snapshot in Excalidraw.
- **Partner terminal and scratchpad** — every session carries a partner shell in the same tab, and a per-session Excalidraw whiteboard that persists with the config; export the drawing straight into Claude.
- **Multi-account usage strip** — every signed-in account's usage along the bottom of the window, and a minimal mode that shows just the account name and two traffic-light dots (green under 70 %, amber to 89 %, red from 90 %) so the strip stays readable with many accounts.
- **Snap and Vision capture** — region or window capture from any screen at 1920px / JPEG 85, a file path inline for local sessions and over the tunnel for SSH; `Alt+V` pastes clipboard images.
- **A first-run tour and What's New that know where you came from** — a fresh install gets the tour; an upgrade across a release line gets everything new since your last version and walks the tour again; a move within a line gets the notes only.

---

## Getting started

1. **Download** the installer for your platform from **[Releases](../../releases)** — `AI-Code-Conductor-x.y.z.exe`, `-mac.dmg` (Apple Silicon) or `-linux-x86_64.AppImage` — and verify its SHA-256 against `CHECKSUMS.txt` on the release page.
2. **Run it** and choose your Data and Resources directories.
3. The **setup wizard** finds your Claude Code CLI, walks you through accounts, and hands off to Claude's own auth. Every feature is optional and asks before it turns on.
4. **Create a config**, launch a session, and the sidebar starts filling in.

> Internally the app still identifies itself as `claude-conductor` (npm name) and `com.claudeconductor.app` (Windows application id). Those are frozen on purpose — changing them would break the upgrade path and orphan existing data — so you may see them in paths and installer metadata.

### Requirements

| | |
|---|---|
| **Claude Code** | The [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed and authenticated |
| **Node.js** | 20+ (a Claude Code dependency) |
| **Windows** | 10 or 11, x64. Installers are code-signed (SSL.com, publisher "Nicholas Moger"); SmartScreen may still prompt on a brand-new release — More info → Run anyway |
| **macOS** | 12+ on Apple Silicon. Builds are signed and notarised |
| **Linux** | Experimental — glibc 2.39+ (Ubuntu 24.04+, Rocky 10+, Fedora 40+), x64. `chmod +x` the AppImage; needs FUSE and GTK 3. The vision browser needs a deb/rpm Chrome — the snap build's confinement blocks the debug profile |

## Under the hood

Electron 43 with a frameless, sandboxed renderer and zod-validated IPC; React 19 with Tailwind CSS v4 (dark, light and system themes); Zustand 5 hydrated from disk on boot; xterm.js 6 over node-pty (ConPTY on Windows) — GPU rendering is opt-in and only ever drives the terminal you are looking at, because the WebGL addon keeps one glyph cache per process and a session rebuilding it blanked every other; electron-vite; `@modelcontextprotocol/sdk` for the Conductor MCP server. The main process owns config persistence, the PTY pool, the hooks HTTP gateway that drives the attention pulse, the tokenomics aggregator, the statusline ingest, the MCP server and cloud-agent dispatch; the renderer talks to it exclusively through typed IPC channels.

Over six thousand unit tests plus a native suite that runs under Electron's own runtime — for better-sqlite3, node-pty, and anything whose behaviour differs between Electron and plain Node — green on Windows and macOS in CI on every labelled PR. Security-sensitive changes go through an adversarial review pass before merge: independent agents attack the change with distinct lenses, and the verdict is recorded on the pull request.

```bash
git clone https://github.com/nubbymong/claude-command-center.git
cd claude-command-center
npm install
npm run typecheck && npx vitest run    # tsc, then the unit suite
npm run dev                            # HMR dev
npm run package:win | package:mac | package:linux
```

## Security & privacy

| | |
|---|---|
| **Credentials** | SSH passwords, sudo passwords and encrypted notes are stored as encrypted blobs via the OS keystore — DPAPI, Keychain, libsecret. Machine-bound, never plaintext |
| **Account isolation** | Each session runs under its own isolated home; the original global login is snapshotted read-only on first run and never touched |
| **Permissions** | Claude Code's own permission prompts surface in the app. You can grant a **standing approval** so a repeated prompt stops interrupting you — yours to create and revoke, high-risk payloads excluded, nothing approved that you did not choose |
| **Telemetry** | None of our own. Outbound traffic is limited to GitHub Releases (update check), `status.claude.com` (status pills), `api.anthropic.com` (usage and rate-limit figures, with your own token), `claude.ai` (in-app sign-in and the per-account web session), the GitHub API (opt-in panel, after you sign in), and LiteLLM's open-pricing JSON. The full list, with what each request carries, is in [PRIVACY.md](PRIVACY.md) |
| **Data integrity** | Atomic config writes; daily snapshots of `CONFIG/*.json` with 7-day retention; typed IPC with schema validation on every data-bearing channel |
| **Releases** | Windows code-signed, macOS signed and notarised, Linux unsigned by convention. Every download verifiable by SHA-256 against `CHECKSUMS.txt` — the in-app updater checks this on each update — and CI scans installers through VirusTotal |

Report vulnerabilities privately via [GitHub Security Advisories](../../security/advisories/new). See [SECURITY.md](SECURITY.md) for scope.

## Keyboard shortcuts

`Ctrl+T` new config · `Ctrl+W` close session · `Ctrl+Tab` / `Ctrl+Shift+Tab` next / previous · `Ctrl+1…9` jump to session · `Ctrl+B` sidebar · `Ctrl+/` GitHub panel · `Alt+V` paste image · `F2` rename. Most are rebindable in **Settings → Shortcuts**; `Ctrl+1…9` and `Ctrl+/` are fixed. Keys you press *inside* a session — `Escape` to interrupt, `Shift+Enter` for a newline — belong to Claude Code, not to the Conductor.

## Contributing & history

Developed privately from late 2025 and open-sourced in April 2026 as Claude Command Center; everything from v1.0 forward is in the open. Per-release detail lives in [`src/renderer/changelog.ts`](src/renderer/changelog.ts), which also drives the in-app What's New. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR process, and [AGENTS.md](AGENTS.md) if you are pointing an AI agent at this repository.

## Disclaimer and trademarks

Claude and Claude Code are trademarks of Anthropic, PBC. OpenAI and Codex are trademarks of OpenAI. This project is an independent, community-built tool. It is **not affiliated with, endorsed by, sponsored by, or supported by Anthropic or OpenAI**. All references to "Claude", "Claude Code", "Codex", "Anthropic" or "OpenAI" are nominative, used solely to identify the third-party software this tool interoperates with. AI Code Conductor wraps and orchestrates the official Claude Code and Codex CLIs; it does not include, modify or redistribute their code, and it requires you to install and authenticate those tools yourself under their own terms. If you are a rights holder with a concern about this project's use of a name or mark, please open a [GitHub issue](../../issues) or contact the maintainer and it will be addressed promptly.

---

<p align="center"><sub>AI Code Conductor © Nicholas Moger · <a href="LICENSE">MIT</a> · Built on top of the <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> CLI</sub></p>
