/**
 * Tips Library — seed set of intelligent tips.
 *
 * Each tip has a primary variant (for users who haven't done the thing)
 * and optionally a postUse variant (for users who have).
 *
 * Priority: higher = shown sooner (0-100).
 * Platform-specific body copy: use `bodyMac` / `bodyWin` to override `body`.
 * Focus hints describe WHERE in the UI to look.
 *
 * Categories:
 *   - discovery — non-obvious features users should know about
 *   - power-user — shortcuts and advanced uses
 *   - transparency — what the app does behind the scenes (privacy-relevant)
 */

export type TipCategory =
  | 'sessions'
  | 'commands'
  | 'agents'
  | 'vision'
  | 'memory'
  | 'tokenomics'
  | 'security'
  | 'productivity'
  | 'ui-navigation'
  | 'advanced'
  | 'transparency'
  | 'github'

export type TipComplexity = 'simple' | 'intermediate' | 'advanced'

export interface TipContent {
  /** Short text shown in the header pill (keep under 60 chars) */
  shortText: string
  /** Full modal title */
  title: string
  /** Full modal body — plain text with **bold** and `code` segments */
  body: string
  /** Optional platform-specific body overrides */
  bodyMac?: string
  bodyWin?: string
  /** Optional call-to-action button label */
  actionLabel?: string
  /** Where the action navigates (matches a ViewType or custom handler key) */
  actionTarget?: string
  /** Optional highlight region hint — shown in a callout at bottom of modal */
  focusHint?: string
  focusHintMac?: string
  focusHintWin?: string
}

export interface Tip {
  id: string
  category: TipCategory
  complexity: TipComplexity
  /** Higher = more important, shown sooner */
  priority: number
  /** Feature IDs that must be used before this tip is relevant */
  requires?: string[]
  /** Feature IDs that if used, make the primary variant irrelevant */
  excludes?: string[]
  variants: {
    primary: TipContent
    postUse?: TipContent
  }
}

/** Resolve content body for the current platform */
export function resolveBody(content: TipContent, isMac: boolean): string {
  if (isMac && content.bodyMac) return content.bodyMac
  if (!isMac && content.bodyWin) return content.bodyWin
  return content.body
}

/** Resolve focus hint for the current platform */
export function resolveFocusHint(content: TipContent, isMac: boolean): string | undefined {
  if (isMac && content.focusHintMac) return content.focusHintMac
  if (!isMac && content.focusHintWin) return content.focusHintWin
  return content.focusHint
}

export const TIPS_LIBRARY: Tip[] = [
  // ── Discovery: low-barrier, high-value features ────────────────────────

  {
    id: 'tip.notes',
    category: 'security',
    complexity: 'simple',
    priority: 85,
    excludes: ['security.encrypted-notes'],
    variants: {
      primary: {
        shortText: '🔒 Stash secrets alongside your session',
        title: 'Encrypted Notes',
        body: 'Every session can hold **encrypted notes** — API keys, SQL snippets, DB connection strings, URLs, anything you want one-click access to without committing it to the repo.\n\nClick the small **lock+ icon** in the session header (next to Restart) to add a note. You can create multiple notes per config with different colors to tell them apart at a glance.\n\nContent is encrypted at rest using your OS credential store — DPAPI on Windows, Keychain on macOS. The renderer never sees plaintext; decryption happens in the main process only.',
        actionLabel: 'Got it',
        focusHint: 'Session header — small lock icon with a + next to it',
      },
      postUse: {
        shortText: '🔒 Right-click a note to edit or duplicate',
        title: 'Organize Your Notes',
        body: 'Nice — you already use notes. A few things you might not know:\n\n• **Right-click a note** to edit, duplicate, change color, or delete\n• **Drag notes** to reorder them in the bar\n• Notes can be **config-scoped** (only shown for one config) or **global** (shown in every session)\n• Each note shows a **lock icon** indicating encrypted-at-rest status',
      },
    },
  },

  {
    id: 'tip.memory-visualiser',
    category: 'memory',
    complexity: 'simple',
    priority: 80,
    excludes: ['memory.memory-page'],
    variants: {
      primary: {
        shortText: '🧠 Browse what Claude remembers about your projects',
        title: 'Memory Visualiser',
        body: 'Claude Code writes **auto-memory** files to `~/.claude/projects/*/memory/` to remember things across sessions — your preferences, past feedback, project context, references to external systems.\n\nClick the **brain icon** in the sidebar to browse them visually. Drill down: all projects → project card → type groups (user / feedback / project / reference) → individual memories with rendered markdown.\n\nYou can search across all memories, edit frontmatter, and delete stale entries.',
        actionLabel: 'Open Memory',
        actionTarget: 'memory',
        focusHint: 'Sidebar — brain icon (between Vision and Logs)',
      },
    },
  },

  // ── Commands ────────────────────────────────────────────────────────────

  {
    id: 'tip.command-args-ctrl-click',
    category: 'commands',
    complexity: 'intermediate',
    priority: 75,
    requires: ['commands.create-command'],
    excludes: ['commands.ctrl-click-args'],
    variants: {
      primary: {
        shortText: '⌨ Ctrl+click a command button to customize args',
        title: 'Customize Command Arguments',
        body: 'You\'ve got commands set up — here\'s a power move: **Ctrl+click** any command button to pop open an arguments editor. Override the defaults for one run without changing the command itself.\n\nThe last custom args are remembered, so next time you Ctrl+click the same button they pre-fill.\n\nPerfect for a `run tests` command where sometimes you want `--watch`, sometimes `--filter foo`, sometimes nothing.',
        bodyMac: 'You\'ve got commands set up — here\'s a power move: **Ctrl+click** any command button to pop open an arguments editor (on Mac this is still Ctrl, not Cmd — the app uses the same binding on both platforms). Override the defaults for one run without changing the command itself.\n\nThe last custom args are remembered, so next time you Ctrl+click the same button they pre-fill.\n\nPerfect for a `run tests` command where sometimes you want `--watch`, sometimes `--filter foo`, sometimes nothing.',
      },
    },
  },

  {
    id: 'tip.command-sections',
    category: 'commands',
    complexity: 'simple',
    priority: 60,
    requires: ['commands.create-command'],
    excludes: ['commands.command-sections'],
    variants: {
      primary: {
        shortText: '📂 Group command buttons into named sections',
        title: 'Command Sections',
        body: 'Once you have more than 4-5 command buttons they start to get cluttered. Organize them into **named sections**:\n\n• **Right-click** the command bar and choose **Add Section**\n• **Drag any command button** onto a section header to assign it\n• **Drag it back out** to the unsectioned area to unassign\n• **Right-click a command** and use **Move to Section** to assign without dragging\n• **Click a section header** to collapse/expand it\n• **Right-click a section header** to rename, change text color, or delete it\n• **Drag section headers** to reorder them\n\nExamples: "Testing", "Deploy", "DB Ops", "Claude prompts".',
      },
      postUse: {
        shortText: '🎨 Customize section colors and reorder by dragging',
        title: 'Section Power Tips',
        body: 'You\'re using sections — here are some extras:\n\n• **Right-click a section header** to rename it or change the **text color** — great for visual grouping\n• **Drag section headers** to reorder entire groups\n• **Right-click a command** > **Move to Section** to quickly reassign without dragging\n• Collapsed sections show a **count badge** so you know how many commands are hidden',
      },
    },
  },

  {
    id: 'tip.command-target',
    category: 'commands',
    complexity: 'intermediate',
    priority: 55,
    requires: ['commands.create-command', 'sessions.partner-terminal'],
    variants: {
      primary: {
        shortText: '🎯 Target commands at your partner terminal',
        title: 'Command Targeting',
        body: 'You use partner terminals — did you know **each command button can target a specific terminal**?\n\nWhen editing a command, set **Target** to:\n• **Claude** — always runs in the Claude pane\n• **Partner** — always runs in your partner shell\n• **Any** (default) — runs in whichever pane is active\n\nGreat for `git status`, `npm test`, `docker ps` — commands you want in the shell, not typed into Claude\'s prompt.',
      },
    },
  },

  // ── Sessions & Configs ──────────────────────────────────────────────────

  {
    id: 'tip.pin-config',
    category: 'sessions',
    complexity: 'simple',
    priority: 70,
    requires: ['sessions.create-config'],
    excludes: ['sessions.pin-config'],
    variants: {
      primary: {
        shortText: '📌 Pin your most-used configs to the top',
        title: 'Pinned Configs',
        body: 'Right-click any config in the sidebar and choose **Pin** to move it to a dedicated pinned panel at the top. Pinned configs stay visible even when you scroll through dozens of others.\n\nPerfect for your main project that you launch a dozen times a day. You can also access pinned configs from the Sessions view when the sidebar is collapsed.',
      },
    },
  },

  {
    id: 'tip.partner-terminal',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 65,
    requires: ['sessions.create-config'],
    excludes: ['sessions.partner-terminal'],
    variants: {
      primary: {
        shortText: '🔀 Add a partner shell next to Claude',
        title: 'Partner Terminal',
        body: 'A **partner terminal** is a second shell that runs in the same session tab, alongside Claude. One click toggles between them.\n\nUse it to:\n• Run `npm run dev` while Claude edits code\n• Keep a test watcher running\n• Run git commands without Claude\'s interference\n• Tail a log file\n\nEdit your config and set a Partner Terminal Path. Path examples below.',
        bodyMac: 'A **partner terminal** is a second shell that runs in the same session tab, alongside Claude. One click toggles between them.\n\nUse it to:\n• Run `npm run dev` while Claude edits code\n• Keep a test watcher running\n• Run git commands without Claude\'s interference\n• Tail a log file\n\nEdit your config and set Partner Terminal Path to `/bin/zsh` or `/bin/bash`.',
        bodyWin: 'A **partner terminal** is a second shell that runs in the same session tab, alongside Claude. One click toggles between them.\n\nUse it to:\n• Run `npm run dev` while Claude edits code\n• Keep a test watcher running\n• Run git commands without Claude\'s interference\n• Tail a log file\n\nEdit your config and set Partner Terminal Path to `powershell.exe` or `cmd.exe`. You can also tick **Elevated** to run it as admin (requires `gsudo`).',
      },
      postUse: {
        shortText: '🎯 Route command buttons to your partner shell',
        title: 'Target Commands at Partner',
        body: 'Now that you use partner terminals: **each command button can target a specific terminal**. When editing a command, set **Target: Partner** and it\'ll always run in the partner shell.\n\nGreat for `git status`, `npm test`, `docker ps` — anything you want in the shell instead of sent as a Claude prompt.',
      },
    },
  },

  {
    id: 'tip.effort-level',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 60,
    requires: ['sessions.create-config'],
    excludes: ['sessions.effort-level'],
    variants: {
      primary: {
        shortText: '🧠 Dial Claude\'s thinking depth per config',
        title: 'Effort Level',
        body: '**Effort level** passes `--effort` to Claude Code, controlling how hard Claude thinks before responding:\n\n• **Low** — Quick responses, less reasoning, cheapest\n• **Medium** — Balanced (close to default)\n• **High** — Deep thinking, slower, most expensive\n\nSet it per-config. A common pattern is to have two configs for the same project: "Quick" (low effort) for refactors and docs, "Deep" (high effort) for architecture and debugging.',
      },
    },
  },

  {
    id: 'tip.ssh-config',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 55,
    excludes: ['sessions.session-type'],
    variants: {
      primary: {
        shortText: '🌐 Run Claude on a remote machine over SSH',
        title: 'SSH Sessions',
        body: 'Create a config with **SSH** as the session type, enter host/port/user/remote path, and Claude runs on the remote with full file access. Your terminal stays local.\n\nWhen the session connects, an in-pane overlay shows **Launch Claude / Skip** — your click triggers the statusline injection and runs Claude. No prompt-detection magic, no setup blobs accidentally pasted into a running Claude.\n\nPasswords (if you don\'t use key auth) are encrypted with your OS credential store and only decrypted in the main process, never in the renderer.',
      },
      postUse: {
        shortText: '🐳 Run Claude inside a Docker container via SSH',
        title: 'Docker-in-SSH (post-connect command)',
        body: 'Edit your SSH config and set a **Post-connect command** like `sudo docker exec -it claude-dev bash`. After SSH login the overlay shows **Run post-connect command / Skip**; click it, and once the inner shell is ready a second overlay offers **Launch Claude / Skip**.\n\nSet the **Docker Container** field too — pasted screenshots get copied in via `docker cp` to that container. Great for reproducible builds and isolating Claude\'s file access from the host.',
      },
    },
  },

  {
    id: 'tip.duplicate-config',
    category: 'sessions',
    complexity: 'simple',
    priority: 45,
    requires: ['sessions.create-config'],
    excludes: ['sessions.duplicate-config'],
    variants: {
      primary: {
        shortText: '📋 Duplicate a config instead of recreating it',
        title: 'Duplicate Config',
        body: 'Right-click any config in the sidebar and choose **Duplicate** to create a copy with all its settings. Useful for:\n\n• Creating a "Quick" + "Deep" pair of the same project\n• Testing a config change without losing the original\n• Making dev/staging/prod variants\n\nThe duplicate gets `(copy)` appended to the label — rename it from the context menu.',
      },
    },
  },

  // ── Vision ──────────────────────────────────────────────────────────────

  {
    id: 'tip.vision-system',
    category: 'vision',
    complexity: 'intermediate',
    priority: 50,
    excludes: ['vision.toggle-vision'],
    variants: {
      primary: {
        shortText: '👁 Give Claude a browser to drive',
        title: 'Vision System',
        body: '**Vision** gives Claude a real browser it can control — screenshot, navigate, click, type, scroll, evaluate JS. Perfect for testing web apps, scraping docs, or just showing Claude what\'s on screen.\n\nClick the **eye icon** in the sidebar and press Start. It runs a local MCP server on `127.0.0.1:19333` (localhost only) and 17 tools become available to every Claude session automatically.\n\nThe MCP server is registered in `~/.claude/settings.json` under `mcpServers.conductor-vision`. When you stop Vision, the entry is cleanly removed.',
        actionLabel: 'Open Vision',
        actionTarget: 'vision',
        focusHint: 'Sidebar — eye icon',
      },
    },
  },

  // ── Tokenomics ──────────────────────────────────────────────────────────

  {
    id: 'tip.tokenomics',
    category: 'tokenomics',
    complexity: 'simple',
    priority: 50,
    excludes: ['tokenomics.dashboard'],
    variants: {
      primary: {
        shortText: '💰 See where your Claude money is going',
        title: 'Tokenomics',
        body: 'The **Tokenomics** page tracks your token usage and costs across every Claude session — today, this week, all time.\n\nIt parses your Claude CLI JSONL transcripts to give you historical data going back months, and syncs live as you work. You get:\n\n• Cost breakdown by model\n• Daily spend charts\n• Rate limit utilization (5-hour & 7-day)\n• Per-session burn rate\n\nModel pricing is fetched from BerriAI\'s LiteLLM repo on GitHub (cached for 24h) so costs stay accurate.',
        actionLabel: 'Open Tokenomics',
        actionTarget: 'tokenomics',
      },
    },
  },

  // ── Productivity ────────────────────────────────────────────────────────

  {
    id: 'tip.cycle-sessions',
    category: 'productivity',
    complexity: 'simple',
    priority: 50,
    requires: ['sessions.create-config'],
    variants: {
      primary: {
        shortText: '⌨ Ctrl+Tab to flip between sessions',
        title: 'Session Shortcuts',
        body: 'Fast switching between sessions:\n\n• **Ctrl+Tab** — next session\n• **Ctrl+Shift+Tab** — previous session\n• **Ctrl+1** through **Ctrl+9** — jump directly to session N\n• **Ctrl+T** — new config\n• **Ctrl+W** — close current session\n• **Ctrl+B** — toggle sidebar\n\nAll customizable in Settings > Shortcuts. Learn Ctrl+Tab and Ctrl+1-9 and you\'ll rarely touch the mouse.',
        bodyMac: 'Fast switching between sessions (note: on Mac, these still use **Ctrl**, not Cmd — the app keeps the same bindings on both platforms):\n\n• **Ctrl+Tab** — next session\n• **Ctrl+Shift+Tab** — previous session\n• **Ctrl+1** through **Ctrl+9** — jump directly to session N\n• **Ctrl+T** — new config\n• **Ctrl+W** — close current session\n• **Ctrl+B** — toggle sidebar\n\nAll customizable in Settings > Shortcuts.',
      },
    },
  },

  {
    id: 'tip.paste-image',
    category: 'productivity',
    complexity: 'simple',
    priority: 45,
    variants: {
      primary: {
        shortText: '🖼 Paste clipboard images with Alt+V',
        title: 'Paste Image from Clipboard',
        body: 'Image on your clipboard? Press **Alt+V** in any session and the app saves it to a temp file and pastes the file path into Claude\'s prompt.\n\nWorks with screenshots, images copied from browser, diagrams from Excalidraw, anything in clipboard image format. No more "let me save this to disk first and drag it in".',
      },
    },
  },

  {
    id: 'tip.excalidraw-scratchpad',
    category: 'productivity',
    complexity: 'simple',
    priority: 50,
    variants: {
      primary: {
        shortText: '✏️ Sketch ideas in the Draw scratchpad',
        title: 'Excalidraw Scratchpad',
        body: 'The **Draw** button next to Snap opens a full Excalidraw canvas. Sketch architecture, annotate flowcharts, draw selectors over a screenshot — anything you\'d normally reach for a tablet for.\n\n• **Copy to clipboard** exports the canvas as PNG.\n• Hit **Alt+V** in any terminal to paste it directly into Claude.\n• Available in every session — no per-config setup.\n• Closes with **Esc**.',
      },
    },
  },

  {
    id: 'tip.command-webview',
    category: 'commands',
    complexity: 'intermediate',
    priority: 55,
    variants: {
      primary: {
        shortText: '🌐 Open a webview when a command finishes',
        title: 'Webview on Command Completion',
        body: 'Building a dev server, generating a docs site, or anything that ends with "now look at this URL"? Tick **Launch webview on completion** when editing a command and enter the URL.\n\nWhat happens:\n• Command runs in whichever target you pick — Claude, Partner, or Any (works with SSH `shellOnly` sessions too).\n• The app polls the URL every second for up to 30s after the command write. The button pulses **blue** while polling, goes **green** the moment the URL responds, **red** on timeout.\n• A **Web** button sits in the toolbar whenever a webview command exists for this session. Greyed when idle.\n• If a server is already running when the app launches, the mount-time auto-probe picks it up.\n• Stop your server later? The next time you press any command button in the session the URL gets re-checked, downgrading to red — no constant background polling.\n• Click the button to swap the active pane to a real Chrome view of the page.\n\nThe pane has back/forward/hard-refresh/home, plus a **Freeze** button that snapshots the page and opens it in Excalidraw for annotation.',
      },
    },
  },

  {
    id: 'tip.webview-freeze',
    category: 'productivity',
    complexity: 'intermediate',
    priority: 40,
    requires: ['webview.opened'],
    variants: {
      primary: {
        shortText: '❄️ Freeze + annotate webviews for screenshots',
        title: 'Freeze Webview + Annotate',
        body: 'Inside a webview pane, the **Freeze** button captures the current page as an image and opens it in Excalidraw. Draw arrows, circle bugs, redact PII — then **Copy to clipboard** and paste into Claude with **Alt+V**.\n\nFaster than a separate screenshot tool because the snapshot bypasses the OS clipboard until you\'re ready.',
      },
    },
  },

  {
    id: 'tip.statusline-customize',
    category: 'productivity',
    complexity: 'intermediate',
    priority: 40,
    excludes: ['productivity.statusline-config'],
    variants: {
      primary: {
        shortText: '📊 Customize which metrics show in the status line',
        title: 'Status Line Customization',
        body: 'The status line at the bottom of the screen shows session metrics — model, context %, tokens, cost, lines changed, duration, rate limits, peak hours indicator. You can toggle each one individually.\n\nGo to **Settings > Status Line** and enable just the metrics you care about. Minimalists can hide everything but model + cost. Power users can show all eight fields.',
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      },
    },
  },

  // ── Agents ──────────────────────────────────────────────────────────────

  {
    id: 'tip.cloud-agents',
    category: 'agents',
    complexity: 'intermediate',
    priority: 40,
    excludes: ['agents.cloud-agent-dispatch'],
    variants: {
      primary: {
        shortText: '☁ Dispatch Claude to work in the background',
        title: 'Cloud Agents',
        body: '**Cloud agents** run headless Claude sessions in the background. You give them a task, they run, you come back later for the result.\n\nPerfect for:\n• Running tests across a large codebase\n• Generating documentation for every file\n• Security audits\n• Long refactors\n\nClick the **cloud icon** in the sidebar and press "New Agent". Monitor progress from the dashboard — see status, elapsed time, token usage, and output for each.',
        actionLabel: 'Open Agent Hub',
        actionTarget: 'cloud-agents',
      },
    },
  },

  {
    id: 'tip.agent-teams',
    category: 'agents',
    complexity: 'advanced',
    priority: 30,
    requires: ['agents.cloud-agent-dispatch'],
    excludes: ['agents.agent-teams'],
    variants: {
      primary: {
        shortText: '🤖 Chain agents into multi-step pipelines',
        title: 'Agent Teams',
        body: 'You\'ve used cloud agents — ready for the next level? **Agent Teams** orchestrate multiple agents in sequence or parallel, like a mini CI/CD pipeline for Claude.\n\nExample team: [analyze codebase] → [write tests] → [run tests] → [fix failures]. Each step uses a different agent template with different tools.\n\nGo to Agent Hub > **Teams** tab to create your first one.',
      },
    },
  },

  // ── Advanced ────────────────────────────────────────────────────────────

  {
    id: 'tip.insights',
    category: 'advanced',
    complexity: 'advanced',
    priority: 25,
    variants: {
      primary: {
        shortText: '📈 AI-powered analysis of your Claude usage',
        title: 'Insights',
        body: '**Insights** runs a Claude-powered analysis of your session history to find big wins, friction points, and regressions over time.\n\nClick the **pulse icon** in the sidebar. You\'ll get KPI trends (sessions/day, avg cost, lines changed) plus qualitative analysis of what\'s working and what\'s not in your Claude usage patterns.\n\nReports are saved to `resources/insights/` so you can look back at past runs.',
        actionLabel: 'Open Insights',
        actionTarget: 'insights',
      },
    },
  },

  {
    id: 'tip.flicker-free',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 25,
    requires: ['sessions.create-config'],
    excludes: ['sessions.flicker-free'],
    variants: {
      primary: {
        shortText: '✨ Smoother terminal rendering',
        title: 'Flicker-Free Rendering',
        body: 'Enable **flicker-free rendering** on a config to reduce terminal flicker during long streaming outputs. The app sets `CLAUDE_CODE_NO_FLICKER=1` and Claude uses the terminal\'s alternate screen buffer, which updates smoothly.\n\nTradeoff: you lose Ctrl+F search and scrollback **while Claude is running**. Exit Claude and scrollback comes back.\n\nMost useful for long outputs with lots of updates — e.g., running tests with a watcher.',
      },
    },
  },

  // ── Transparency: what the app does behind the scenes ──────────────────

  {
    id: 'tip.transparency.statusline-injection',
    category: 'transparency',
    complexity: 'intermediate',
    priority: 20,
    variants: {
      primary: {
        shortText: 'ℹ How we power the statusline metrics',
        title: 'Statusline Script Injection',
        body: 'Heads up — you should know how the rich statusline (tokens, cost, rate limits, context %) actually works:\n\n1. The app deploys a small Node.js script to `~/.claude/claude-multi-statusline.js`\n2. It adds a `statusLine` entry to `~/.claude/settings.json` pointing to that script\n3. Claude Code runs the script on each command and displays its output\n4. The script reads your Claude OAuth token from `~/.claude/.credentials.json` to fetch rate limits from `api.anthropic.com/api/oauth/usage`\n\n**What the app does NOT do**: store your token, send data anywhere else, or modify anything in the Claude CLI itself. The injection is reversible — delete the `statusLine` key from settings.json and the feature turns off.',
      },
    },
  },

  {
    id: 'tip.transparency.vision-mcp',
    category: 'transparency',
    complexity: 'intermediate',
    priority: 18,
    requires: ['vision.toggle-vision'],
    variants: {
      primary: {
        shortText: 'ℹ How Vision injects into Claude settings',
        title: 'Vision MCP Registration',
        body: 'When you start Vision, the app:\n\n1. Launches a local MCP server bound to `127.0.0.1:19333` (**localhost only** — not exposed to the network)\n2. Adds an `mcpServers.conductor-vision` entry to `~/.claude/settings.json` pointing to the SSE endpoint\n3. Claude Code picks up 17 vision tools automatically (screenshot, navigate, click, type, etc.)\n\nWhen you stop Vision, the entry is removed cleanly. For SSH sessions, the app sets up a reverse tunnel (`-R 19333:localhost:19333`) automatically so remote Claude can reach the local MCP server.',
      },
    },
  },

  {
    id: 'tip.transparency.session-logs',
    category: 'transparency',
    complexity: 'intermediate',
    priority: 17,
    variants: {
      primary: {
        shortText: 'ℹ Your session output is logged locally',
        title: 'Session Activity Logging',
        body: 'The app records **all PTY output** from every session to `resources/logs/<config-label>/<session-id>/session.jsonl`. This includes:\n\n• Prompts you send to Claude\n• Claude\'s responses\n• Terminal commands and their output\n• File contents Claude reads\n\nThese logs stay **100% local** — they\'re never uploaded or transmitted. They exist so you can audit sessions after the fact or recover lost context. Logs rotate when they exceed 10MB per session.\n\nTo clean them up: open the Logs view in the sidebar, or delete them manually from `resources/logs/`.',
        bodyMac: 'The app records **all PTY output** from every session to `~/Library/Application Support/Claude Conductor/resources/logs/<config-label>/<session-id>/session.jsonl`. This includes:\n\n• Prompts you send to Claude\n• Claude\'s responses\n• Terminal commands and their output\n• File contents Claude reads\n\nThese logs stay **100% local** — they\'re never uploaded or transmitted. Logs rotate when they exceed 10MB per session.\n\nTo clean them up: open the Logs view in the sidebar, or delete them manually.',
        bodyWin: 'The app records **all PTY output** from every session to `%LOCALAPPDATA%\\Claude Conductor\\resources\\logs\\<config-label>\\<session-id>\\session.jsonl`. This includes:\n\n• Prompts you send to Claude\n• Claude\'s responses\n• Terminal commands and their output\n• File contents Claude reads\n\nThese logs stay **100% local** — they\'re never uploaded or transmitted. Logs rotate when they exceed 10MB per session.\n\nTo clean them up: open the Logs view in the sidebar, or delete them manually.',
      },
    },
  },

  {
    id: 'tip.transparency.credential-storage',
    category: 'transparency',
    complexity: 'advanced',
    priority: 16,
    variants: {
      primary: {
        shortText: 'ℹ How your SSH passwords are encrypted',
        title: 'Credential Storage',
        body: 'SSH passwords and OAuth account tokens are encrypted using **Electron\'s `safeStorage` API**, which wraps your OS credential store:\n\n• **Windows** — DPAPI (Data Protection API), tied to your Windows user account\n• **macOS** — Keychain\n• **Linux** — libsecret (Secret Service)\n\nEncrypted blobs are stored in `resources/CONFIG/ssh-credentials.json` with an `enc:` prefix. The renderer process **never** sees plaintext — decryption happens only in the main process, right before the credential is needed.\n\nIf you move the app to a new machine, encrypted credentials won\'t work there — you\'ll need to re-enter them (they\'re tied to the old OS\'s credential store).',
        bodyMac: 'SSH passwords and OAuth account tokens are encrypted using **Electron\'s `safeStorage` API** which wraps macOS **Keychain**.\n\nEncrypted blobs are stored in `~/Library/Application Support/Claude Conductor/resources/CONFIG/ssh-credentials.json` with an `enc:` prefix. The renderer process **never** sees plaintext — decryption happens only in the main process.\n\nIf you move the app to a new machine, encrypted credentials won\'t work there — you\'ll need to re-enter them (they\'re tied to the old Keychain).',
        bodyWin: 'SSH passwords and OAuth account tokens are encrypted using **Electron\'s `safeStorage` API** which wraps **Windows DPAPI** (Data Protection API), tied to your Windows user account.\n\nEncrypted blobs are stored in `%LOCALAPPDATA%\\Claude Conductor\\resources\\CONFIG\\ssh-credentials.json` with an `enc:` prefix. The renderer process **never** sees plaintext — decryption happens only in the main process.\n\nIf you move the app to a new Windows machine or reinstall the OS, encrypted credentials won\'t decrypt there — you\'ll need to re-enter them.',
      },
    },
  },

  {
    id: 'tip.transparency.resources-folder',
    category: 'transparency',
    complexity: 'intermediate',
    priority: 15,
    variants: {
      primary: {
        shortText: 'ℹ Where the app stores everything',
        title: 'Resources Folder',
        body: 'The app uses a **Resources Directory** for all user data. Configurable at first-run setup.\n\nContents:\n• `CONFIG/` — JSON files for your configs, commands, settings, encrypted credentials, tokenomics, usage tracking\n• `logs/` — per-session JSONL activity logs\n• `screenshots/` — any screenshots captured by the Snap features\n• `insights/` — AI-generated usage reports\n• `status/` — real-time session metrics (written by the statusline script)\n• `scripts/` — deployed helper scripts like the statusline\n• `claude-versions/` — installed legacy Claude CLI versions\n\nBack up the whole `resources/` folder to move to a new machine (note: encrypted credentials won\'t transfer — see the credential tip).',
        bodyMac: 'The app stores everything under `~/Library/Application Support/Claude Conductor/resources/`:\n\n• `CONFIG/` — JSON files for configs, commands, settings, encrypted credentials, tokenomics, usage tracking\n• `logs/` — per-session JSONL activity logs\n• `screenshots/` — captured by Snap features\n• `insights/` — AI usage reports\n• `status/` — real-time session metrics (from statusline script)\n• `scripts/` — deployed helper scripts\n• `claude-versions/` — installed legacy Claude CLI versions\n\nBack up the whole `resources/` folder to move to a new machine (encrypted credentials won\'t transfer since they\'re tied to Keychain).',
        bodyWin: 'The app stores everything under `%LOCALAPPDATA%\\Claude Conductor\\resources\\`:\n\n• `CONFIG\\` — JSON files for configs, commands, settings, encrypted credentials, tokenomics, usage tracking\n• `logs\\` — per-session JSONL activity logs\n• `screenshots\\` — captured by Snap features\n• `insights\\` — AI usage reports\n• `status\\` — real-time session metrics (from statusline script)\n• `scripts\\` — deployed helper scripts\n• `claude-versions\\` — installed legacy Claude CLI versions\n\nBack up the whole `resources\\` folder to move to a new machine (encrypted credentials won\'t transfer since they\'re tied to DPAPI).',
      },
    },
  },

  // ── GitHub ──────────────────────────────────────────────────────────────

  {
    id: 'tip.github.signin',
    category: 'github',
    complexity: 'simple',
    priority: 72,
    excludes: ['github.signed-in'],
    variants: {
      primary: {
        shortText: '🐙 Sign in with GitHub to light up the sidebar',
        title: 'Sign in with GitHub',
        body: 'The GitHub sidebar shows the PR, CI runs, reviews, linked issues, and local git state for your current session. Sign in to unlock it.\n\nYou can use **OAuth device flow** (recommended), **paste a fine-grained PAT** if your org requires it, or let the app auto-detect a **gh CLI** login.\n\nFind it in **Settings > GitHub**. Nothing runs until you opt in per session.',
        actionLabel: 'Open GitHub settings',
        actionTarget: 'settings',
        focusHint: 'Settings page > GitHub tab',
      },
    },
  },

  {
    id: 'tip.github.panel-shortcut',
    category: 'github',
    complexity: 'simple',
    priority: 50,
    requires: ['github.signed-in'],
    excludes: ['github.panel-toggled'],
    variants: {
      primary: {
        shortText: '⌨ Ctrl+/ toggles the GitHub panel',
        title: 'Toggle the GitHub panel',
        body: 'Press **Ctrl+/** to show or hide the GitHub panel from anywhere in the app.',
        bodyMac: 'Press **⌘+/** to show or hide the GitHub panel from anywhere in the app.',
      },
    },
  },

  {
    id: 'tip.github.session-enable',
    category: 'github',
    complexity: 'simple',
    priority: 55,
    requires: ['github.signed-in'],
    excludes: ['github.session-enabled'],
    variants: {
      primary: {
        shortText: '🔛 Enable GitHub on a session to start syncing',
        title: 'Enable GitHub per session',
        body: 'Integration is **off by default per session** so nothing hits your API budget until you opt in.\n\nFor a session with a detected GitHub repo, click **Configure** on the collapsed rail and toggle **Enable**. The panel will start populating PR, CI, reviews, and issues automatically.',
      },
    },
  },

  {
    id: 'tip.github.rate-limit',
    category: 'github',
    complexity: 'intermediate',
    priority: 40,
    excludes: ['github.rate-limit-seen'],
    variants: {
      primary: {
        shortText: 'ℹ How the sidebar respects your GitHub rate limit',
        title: 'GitHub Rate-Limit Handling',
        body: 'The sidebar polls conservatively and falls back gracefully when you hit a rate limit:\n\n• **Tiered intervals** — active session polls faster, background sessions slower\n• **304-aware** — unchanged responses cost 0 against your quota\n• **Per-bucket shields** — REST vs GraphQL counted separately\n• **Automatic pause + resume** — when a bucket is exhausted, sync pauses until the reset time, then auto-resumes\n\nYou can lengthen intervals further in **Settings > GitHub > Sync**.',
        actionLabel: 'Open sync settings',
        actionTarget: 'settings',
      },
    },
  },

  {
    id: 'tip.github.session-context',
    category: 'github',
    complexity: 'intermediate',
    priority: 45,
    requires: ['github.signed-in'],
    excludes: ['github.session-context-seen'],
    variants: {
      primary: {
        shortText: '🔎 The panel figures out which issue you are on',
        title: 'Session Context',
        body: 'The **Session Context** section infers which issue your current session is actually working on.\n\nIt checks (in priority order): issue numbers in your current **branch name**, most-recent issue referenced in your **Claude transcript**, first issue referenced in the active **PR body**. Recent file edits show alongside as additional signal.\n\nYou can opt in to transcript scanning under **Settings > GitHub > Privacy** — it stays entirely local; the transcript never leaves your machine.',
      },
    },
  },

  {
    id: 'tip.transparency.network-activity',
    category: 'transparency',
    complexity: 'intermediate',
    priority: 14,
    variants: {
      primary: {
        shortText: 'ℹ What the app sends over the network',
        title: 'Network Activity',
        body: 'In the interest of transparency, here\'s every network call the app makes:\n\n• **Rate limits** (`api.anthropic.com/api/oauth/usage`) — once per Claude Code command, only when statusline is enabled. Uses YOUR Claude OAuth token (read from `~/.claude/.credentials.json`).\n\n• **Update check** (`api.github.com`) — via `gh` CLI, checks for new releases when you explicitly trigger an update check or on app start.\n\n• **Model pricing** (`raw.githubusercontent.com/BerriAI/litellm`) — once per 24 hours, to get current Claude model pricing for cost calculations. Cached locally.\n\n• **Vision MCP server** — listens on `127.0.0.1:19333` only. Localhost-only, never exposed to the network.\n\n**The app sends NO telemetry, analytics, or usage data.** Everything else stays on your machine.',
      },
    },
  },
]
