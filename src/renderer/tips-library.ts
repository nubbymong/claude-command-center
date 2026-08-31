/**
 * Tips Library -- seed set of intelligent tips.
 *
 * Each tip has a primary variant (for users who haven't done the thing)
 * and optionally a postUse variant (for users who have).
 *
 * Priority: higher = shown sooner (0-100).
 * Platform-specific body copy: use `bodyMac` / `bodyWin` to override `body`.
 * Focus hints describe WHERE in the UI to look.
 *
 * Categories:
 *   - discovery -- non-obvious features users should know about
 *   - power-user -- shortcuts and advanced uses
 *   - transparency -- what the app does behind the scenes (privacy-relevant)
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
  /** Full modal body -- plain text with **bold** and `code` segments */
  body: string
  /** Optional platform-specific body overrides */
  bodyMac?: string
  bodyWin?: string
  /** Optional call-to-action button label */
  actionLabel?: string
  /** Where the action navigates (matches a ViewType or custom handler key) */
  actionTarget?: string
  /** Optional highlight region hint -- shown in a callout at bottom of modal */
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
        shortText: 'Stash secrets alongside your session',
        title: 'Encrypted Notes',
        body: 'Every session can hold **encrypted notes** -- API keys, SQL snippets, DB connection strings, URLs, anything you want one-click access to without committing it to the repo.\n\nClick the small **lock+ icon** in the session header (next to Restart) to add a note. You can create multiple notes per config with different colors to tell them apart at a glance.\n\nContent is encrypted at rest using your OS credential store -- DPAPI on Windows, Keychain on macOS. The renderer never sees plaintext; decryption happens in the main process only.',
        actionLabel: 'Got it',
        focusHint: 'Session header -- small lock icon with a + next to it',
      },
      postUse: {
        shortText: 'Right-click a note to edit or delete',
        title: 'Organize Your Notes',
        body: 'Nice -- you already use notes. A few things you might not know:\n\n• **Right-click a note** to edit or delete it (change its colour inside the edit dialog)\n• **Drag notes** to reorder them in the bar\n• Notes can be **config-scoped** (only shown for one config) or **global** (shown in every session)\n• Each note shows a **lock icon** indicating encrypted-at-rest status',
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
        shortText: 'Browse what Claude remembers about your projects',
        title: 'Memory',
        body: 'Claude Code writes **auto-memory** files to remember things across sessions: your preferences, past feedback, project context, references to external systems.\n\nClick the **Memory icon** in the sidebar to open the dashboard: a **KPI strip** (memories, projects, total size, stale entries, index health), an **activity chart** and **type donut** for the whole store, and a **ranked project list** with staleness dots and live-session chips.\n\nClick a project to drill in: a sortable memory table plus a sessions rail (live sessions jump straight to the terminal; recent sessions deep-link into Logs). Open any memory in the **reading drawer** to read it cleanly, write missing frontmatter, or delete it. Full-text search spans the whole store.',
        actionLabel: 'Open Memory',
        actionTarget: 'memory',
        focusHint: 'Sidebar -- Memory icon (between Conductor MCP and Logs)',
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
        shortText: 'Ctrl+click a command button to customize args',
        title: 'Customize Command Arguments',
        body: 'You\'ve got commands set up -- here\'s a power move: **Ctrl+click** any command button to pop open an arguments editor. Override the defaults for one run without changing the command itself.\n\nThe last custom args are remembered, so next time you Ctrl+click the same button they pre-fill.\n\nPerfect for a `run tests` command where sometimes you want `--watch`, sometimes `--filter foo`, sometimes nothing.',
        bodyMac: 'You\'ve got commands set up -- here\'s a power move: **Ctrl+click** any command button to pop open an arguments editor (on Mac this is still Ctrl, not Cmd -- the app uses the same binding on both platforms). Override the defaults for one run without changing the command itself.\n\nThe last custom args are remembered, so next time you Ctrl+click the same button they pre-fill.\n\nPerfect for a `run tests` command where sometimes you want `--watch`, sometimes `--filter foo`, sometimes nothing.',
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
        shortText: 'Group command buttons into named sections',
        title: 'Command Sections',
        body: 'Once you have more than 4-5 command buttons they start to get cluttered. Organize them into **named sections** inside the one-row bar:\n\n• **Right-click** the command bar and choose **Add section…** (or use the **Add ▾** menu)\n• **Right-click a command** and use **Move to section** to assign it\n• **Right-click a section** to rename it, recolour it, **collapse it to a chip**, move it between the Global and Session bands, or delete it\n\nSections live per band -- your **global** commands and this config\'s own commands each keep their own.\n\nExamples: "Testing", "Deploy", "DB Ops", "Claude prompts".',
      },
      postUse: {
        shortText: 'Collapse sections to keep the one-row bar short',
        title: 'Section Power Tips',
        body: 'You\'re using sections -- here are some extras:\n\n• **Right-click a section** to rename it or change its **colour** -- great for visual grouping\n• **Collapse to a chip** (same menu) keeps a whole section out of the row -- the fastest way to stop the one-row bar overflowing\n• **Right-click a command** > **Move to section** to quickly reassign it\n• Anything that will not fit the row folds into its band\'s **"N more" pill** -- collapsed or not, nothing is lost',
      },
    },
  },

  {
    id: 'tip.command-target',
    category: 'commands',
    complexity: 'intermediate',
    priority: 55,
    requires: ['commands.create-command'],
    variants: {
      primary: {
        shortText: 'Target commands at your partner terminal',
        title: 'Command Targeting',
        body: 'You use partner terminals -- did you know **each command button can target a specific terminal**?\n\nWhen editing a command, set **Target** to:\n• **Claude** -- always runs in the Claude pane\n• **Partner** -- always runs in your partner shell\n• **Any** (default) -- runs in whichever pane is active\n\nGreat for `git status`, `npm test`, `docker ps` -- commands you want in the shell, not typed into Claude\'s prompt.',
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
        shortText: 'Pin your most-used configs to Quick Start',
        title: 'Quick Start',
        body: 'Right-click any config — or any running session — and choose **Pin to Quick Start**. Pinned configs appear in the Quick Start strip at the top of the **Running** tab with a one-click **Start**, so your daily drivers are always one click away.\n\nA pinned config whose session is already running steps aside until that session closes — no duplicates, no accidental second launch. Collapse the strip from its header if you want it out of the way.',
      },
    },
  },

  {
    id: 'tip.partner-terminal',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 65,
    requires: ['sessions.create-config'],
    
    variants: {
      primary: {
        shortText: 'Add a partner shell next to Claude',
        title: 'Partner Terminal',
        body: 'A **partner terminal** is a second shell that runs in the same session tab, alongside Claude. One click on the Partner button in the command bar toggles between them — every session has one, no setup needed.\n\nUse it to:\n• Run `npm run dev` while Claude edits code\n• Keep a test watcher running\n• Run git commands without Claude\'s interference\n• Tail a log file\n\nIt opens in the session\'s working directory (home for SSH sessions).',
      },
      postUse: {
        shortText: 'Route command buttons to your partner shell',
        title: 'Target Commands at Partner',
        body: 'Now that you use partner terminals: **each command button can target a specific terminal**. When editing a command, set **Target: Partner** and it\'ll always run in the partner shell.\n\nGreat for `git status`, `npm test`, `docker ps` -- anything you want in the shell instead of sent as a Claude prompt.',
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
        shortText: 'Dial Claude\'s thinking depth with /effort',
        title: 'Effort Level',
        body: '**Effort** controls how hard Claude thinks before responding. Set a **Starting effort** on the saved config, and change it live inside Claude with **`/effort`**.\n\nLevels, lightest to heaviest: **low**, **medium**, **high**, **xhigh**, **max**, **ultracode** (ultracode also turns on dynamic workflows). Higher effort means deeper thinking, slower replies, and more cost.\n\nThe Conductor shows the current level as a colour-coded pill on the session card and in the statusline, tinted green through red as effort rises, so you can read it at a glance without opening the session.',
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
        shortText: 'Run Claude on a remote machine over SSH',
        title: 'SSH Sessions',
        body: 'Create a config with **SSH** as the session type, enter host/port/user/remote path, and Claude runs on the remote with full file access. Your terminal stays local.\n\nWhen the session connects, an in-pane overlay shows **Launch Claude / Skip** -- your click triggers the statusline injection and runs Claude. No prompt-detection magic, no setup blobs accidentally pasted into a running Claude.\n\nPasswords (if you don\'t use key auth) are encrypted with your OS credential store and only decrypted in the main process, never in the renderer.',
      },
      postUse: {
        shortText: 'A remote session shows its account and usage too',
        title: 'What a Remote Session Reports Back',
        body: 'A remote session is not a second-class one. It reports its status back over its own connection to the app, so it fills in the same places a local session does: the **account line** on the session card, the **account pill** in the header, and its own bars in the **multi-account strip** along the bottom -- 5-hour, weekly and the per-model ones. All of it is there the moment the session connects, not after a restart, and the header names the connection with a single **SSH** or **SSH-Persistent** pill carrying the host address.\n\nRun **`/login`** on the remote and the session moves to the right account within a few seconds; you do not have to relaunch it.\n\nThere is nothing to install on the host and no setup to re-run. It needs the **built-in tools** left on (Settings > General) because the status travels back through the connection they open -- so if a remote status line is the only one missing, look there first.',
      },
    },
  },

  {
    id: 'tip.ssh-account-tools',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 54,
    requires: ['sessions.session-type'],
    variants: {
      primary: {
        shortText: 'A remote session gets your local account\'s tools',
        title: 'Account Tools on a Remote Session',
        body: 'A session running on another machine over SSH can still reach the account tools that live **here** on yours. When the remote is signed in as one of the accounts you also use locally, the session header grows the same **claude.ai** and **Claude Code** pills a local session has -- each with a refresh -- and its **right-click menu** grows **Open artifacts** and the sign-in items.\n\nThey work because those checks and actions run on your own machine for that account identity, not on the remote. So the tools appear only when the remote account matches a local one; with no match the header just names the account, as before.\n\nOne thing stays local: **switching** a session\'s account. A remote session uses the login on its own host -- to change that, run **`/login`** over there.',
        focusHint: 'A remote session\'s header pills, and its right-click menu in the sidebar',
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
        shortText: 'Duplicate a config instead of recreating it',
        title: 'Duplicate Config',
        body: 'Right-click any config in the sidebar and choose **Duplicate** to create a copy with all its settings. Useful for:\n\n• Creating a "Quick" + "Deep" pair of the same project\n• Testing a config change without losing the original\n• Making dev/staging/prod variants\n\nThe duplicate gets `(copy)` appended to the label -- rename it from the context menu.',
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
        shortText: 'Give Claude a browser to drive',
        title: 'Conductor MCP',
        body: '**Conductor MCP** gives Claude a real browser it can control: screenshot, navigate, click, type, scroll, evaluate JS. Perfect for testing web apps, scraping docs, or just showing Claude what\'s on screen.\n\nOpen the **Conductor MCP** entry in the sidebar and click **Start Browser** under the Vision sub-tool card. The Conductor MCP server itself is always running, so the button just launches a headless Chrome/Edge that Claude can drive via CDP.\n\nEach Conductor-spawned session gets its own `~/.claude/mcp-<sid>.json`, passed via `--mcp-config`. Your global `~/.claude.json` is never modified (an entry written there by older versions is cleaned up at startup). When you stop the browser, the MCP server stays up so the other sub-tools (codex_review, host transfer) remain available.',
        actionLabel: 'Open Conductor MCP',
        actionTarget: 'vision',
        focusHint: 'Sidebar -- Conductor MCP',
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
        shortText: 'See where your Claude money is going',
        title: 'Tokenomics',
        body: 'The **Tokenomics** page is a spend dashboard for every Claude and Codex session: today, this week, all time.\n\nA background indexer reads all of your transcripts (including subagent and sidechain files), dedups globally, and computes cost at query time from live pricing, so the page opens instantly. You get:\n\n• A **KPI row** with total spend, tokens, sessions, and daily burn\n• **Charts** for daily spend and per-model breakdown\n• A **sessions table** with cost, model, and config attribution\n• **Filters** for config, date range (7d / 30d / all) and a free-text search over model and project\n\nModel pricing is fetched from BerriAI\'s LiteLLM repo on GitHub (cached for 24h) so costs stay accurate.',
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
        shortText: 'Ctrl+Tab to flip between sessions',
        title: 'Session Shortcuts',
        body: 'Fast switching between sessions:\n\n• **Ctrl+Tab** -- next session\n• **Ctrl+Shift+Tab** -- previous session\n• **Ctrl+1** through **Ctrl+9** -- jump directly to session N\n• **Ctrl+T** -- new config\n• **Ctrl+W** -- close current session\n• **Ctrl+B** -- toggle sidebar\n\nAll customizable in Settings > Shortcuts. Learn Ctrl+Tab and Ctrl+1-9 and you\'ll rarely touch the mouse.',
        bodyMac: 'Fast switching between sessions (note: on Mac, these still use **Ctrl**, not Cmd -- the app keeps the same bindings on both platforms):\n\n• **Ctrl+Tab** -- next session\n• **Ctrl+Shift+Tab** -- previous session\n• **Ctrl+1** through **Ctrl+9** -- jump directly to session N\n• **Ctrl+T** -- new config\n• **Ctrl+W** -- close current session\n• **Ctrl+B** -- toggle sidebar\n\nAll customizable in Settings > Shortcuts.',
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
        shortText: 'Paste clipboard images with Alt+V',
        title: 'Paste Image from Clipboard',
        body: 'Image on your clipboard? Press **Alt+V** in any session and the app saves it to a temp file and pastes the file path into Claude\'s prompt.\n\nWorks with screenshots, images copied from browser, diagrams from Excalidraw, anything in clipboard image format. No more "let me save this to disk first and drag it in".',
      },
    },
  },

  // tip.excalidraw-scratchpad removed at the 2.1.0-rc.10 canvas sweep: the
  // rewritten canvas front page has no "open the sketchpad instead" door, so the
  // tip told users to click something that is no longer there. The browser
  // pane's Freeze -> Excalidraw flow is untouched and is covered by
  // tip.webview-freeze.

  {
    id: 'tip.command-webview',
    category: 'commands',
    complexity: 'intermediate',
    priority: 55,
    variants: {
      primary: {
        shortText: 'A browser pane beside every session',
        title: 'The Browser Pane',
        body: 'Every session has a **Browser** button next to Snap, Canvas and Logs. It opens a real Chrome view in place of the terminal, with an address bar, back/forward, a home page, saved **favourites** (the star) and **open in your real browser** for anything that needs more than a sandbox.\n\nA command button can point it at a page too:\n• Tick **Watch for a page** on a command that starts a server and give it the URL. The poll starts the moment the command is sent and runs for up to 30 s -- the Browser button pulses **blue** while waiting, turns **green** the moment the page answers, **red** on timeout. Any other command press re-checks the URL, so a stopped server goes red without background polling.\n• Make an **Open a page** button -- the one kind that types nothing. Click it and the browser goes there.\n\nPages load in a sandbox with every permission off (no camera, microphone, location or notifications). The **Freeze** button snapshots the page into Excalidraw for annotation.',
      },
    },
  },

  {
    id: 'tip.artifacts-button',
    category: 'productivity',
    complexity: 'simple',
    priority: 45,
    variants: {
      primary: {
        shortText: 'Open your account artifacts from the command bar',
        title: 'The Artifacts Button',
        body: 'Next to **Browser** in the command bar, the **Artifacts** button opens this account\'s artifacts on claude.ai in one click -- no digging through the sidebar menu.\n\n• Shows for a local session signed into an account; a terminal-only session hides it.\n• Uses the session\'s account (or your primary), so each account opens its own artifacts.\n• Right-click it to open artifacts or hide the button, like the other core tools.',
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
        shortText: 'Freeze + annotate a browser page for screenshots',
        title: 'Freeze the Browser + Annotate',
        body: 'Inside the browser pane, the **Freeze** button captures the current page as an image and opens it in Excalidraw. Draw arrows, circle bugs, redact PII -- then **Copy to clipboard** and paste into Claude with **Alt+V**.\n\nFaster than a separate screenshot tool because the snapshot bypasses the OS clipboard until you\'re ready.',
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
        shortText: 'Customize which metrics show in the status line',
        title: 'Status Line Customization',
        body: 'The status line at the bottom of the screen shows session metrics -- model, context %, tokens, cost, lines changed, duration, and rate limits. You can toggle each one individually.\n\nGo to **Settings > Status Line** and enable just the metrics you care about. Minimalists can hide everything but model + cost. Power users can show all seven fields.',
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
        shortText: 'Dispatch Claude to work in the background',
        title: 'Cloud agents',
        body: '**Cloud Agents** runs headless Claude sessions in the background. You give them a task, they run, you come back later for the result.\n\nPerfect for:\n• Running tests across a large codebase\n• Generating documentation for every file\n• Security audits\n• Long refactors\n\nClick the **Cloud Agents icon** in the sidebar and press "New Agent". Monitor progress from the dashboard: status, elapsed time, token usage, and output for each.',
        actionLabel: 'Open Cloud Agents',
        actionTarget: 'cloud-agents',
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
        shortText: 'AI-powered analysis of your Claude usage',
        title: 'Insights',
        body: '**Insights** runs a Claude-powered analysis of your session history to find big wins, friction points, and regressions over time.\n\nClick the **pulse icon** in the sidebar. You\'ll get KPI trends (sessions/day, avg cost, lines changed) plus qualitative analysis of what\'s working and what\'s not in your Claude usage patterns.\n\nReports are saved to `resources/insights/` so you can look back at past runs.',
        actionLabel: 'Open Insights',
        actionTarget: 'insights',
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
        shortText: 'How we power the statusline metrics',
        title: 'Statusline Script Injection',
        body: 'Heads up, you should know how the rich statusline (tokens, cost, rate limits, context %) actually works:\n\n1. The app keeps a small Node.js statusline script in its own resources folder\n2. Each session the Conductor launches gets a `statusLine` entry in its per-session Claude settings pointing at that script. Your global `~/.claude/settings.json` is never modified (an entry written there by older versions is cleaned up at startup)\n3. Claude Code runs the script and displays its output beneath the session\n4. The script reads your Claude OAuth token from `~/.claude/.credentials.json` to fetch rate limits from `api.anthropic.com/api/oauth/usage`\n\n**What the app does NOT do**: store your token, send data anywhere else, or modify anything in the Claude CLI itself. Turn the status line off in Settings → Status Line and new sessions launch without it.',
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
        shortText: 'How the Conductor MCP server injects into Claude settings',
        title: 'Conductor MCP Registration',
        body: 'The Conductor MCP server hosts four sub-tools (Vision, Codex review, Host transfer, Agent Canvas) on a single local endpoint:\n\n1. Server is bound to `127.0.0.1` (**localhost only** -- not exposed to the network) and auto-starts at app boot\n2. Registration is per session only: each Conductor-spawned session gets `~/.claude/mcp-<sid>.json` passed via `--mcp-config`. Your global `~/.claude.json` is never modified (an entry written there by older versions is cleaned up at startup)\n3. Claude Code picks up the tool list automatically (18 browser-vision tools plus `codex_review`, `fetch_host_screenshot` and the `canvas_*` tools)\n\nFor SSH sessions, the app sets up a reverse tunnel automatically so remote Claude can reach the local Conductor MCP server.',
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
        shortText: 'Your session output is logged locally',
        title: 'Session Activity Logging',
        body: 'The Logs, Memory and Tokenomics pages are powered by an index of **Claude\'s own conversation transcripts** (the files Claude Code already writes under `~/.claude/projects`). The Conductor does not record terminal output itself.\n\n• The index is a local SQLite database in the app\'s data folder\n• It stays **100% local** -- never uploaded or transmitted\n• Turning off "Index conversation logs" in Settings only stops the index; your conversations stay in Claude\'s own files either way\n\nTo clean up: Settings → General → Clear index (removes the app\'s index only, never your conversations).',
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
        shortText: 'How your SSH passwords are encrypted',
        title: 'Credential Storage',
        body: 'SSH passwords and OAuth account tokens are encrypted using **Electron\'s `safeStorage` API**, which wraps your OS credential store:\n\n• **Windows** -- DPAPI (Data Protection API), tied to your Windows user account\n• **macOS** -- Keychain\n• **Linux** -- libsecret (Secret Service)\n\nEncrypted blobs are stored in `resources/CONFIG/ssh-credentials.json` with an `enc:` prefix. The renderer process **never** sees plaintext -- decryption happens only in the main process, right before the credential is needed.\n\nIf you move the app to a new machine, encrypted credentials won\'t work there -- you\'ll need to re-enter them (they\'re tied to the old OS\'s credential store).',
        bodyMac: 'SSH passwords and OAuth account tokens are encrypted using **Electron\'s `safeStorage` API** which wraps macOS **Keychain**.\n\nEncrypted blobs are stored in `~/Library/Application Support/Claude Conductor/resources/CONFIG/ssh-credentials.json` with an `enc:` prefix. The renderer process **never** sees plaintext -- decryption happens only in the main process.\n\nIf you move the app to a new machine, encrypted credentials won\'t work there -- you\'ll need to re-enter them (they\'re tied to the old Keychain).',
        bodyWin: 'SSH passwords and OAuth account tokens are encrypted using **Electron\'s `safeStorage` API** which wraps **Windows DPAPI** (Data Protection API), tied to your Windows user account.\n\nEncrypted blobs are stored under your resources folder (`%LOCALAPPDATA%\\AI Code Conductor\\resources\\CONFIG\\ssh-credentials.json` on a new install, `...\\Claude Command Center\\...` if you upgraded from an older version) with an `enc:` prefix. The renderer process **never** sees plaintext -- decryption happens only in the main process.\n\nIf you move the app to a new Windows machine or reinstall the OS, encrypted credentials won\'t decrypt there -- you\'ll need to re-enter them.',
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
        shortText: 'Where the app stores everything',
        title: 'Resources Folder',
        body: 'The app uses a **Resources Directory** for all user data. Configurable at first-run setup.\n\nContents:\n• `CONFIG/` -- JSON files for your configs, commands, settings, encrypted credentials, tokenomics, usage tracking\n• `logs/` -- per-session JSONL activity logs\n• `screenshots/` -- any screenshots captured by the Snap features\n• `insights/` -- AI-generated usage reports\n• `status/` -- real-time session metrics (written by the statusline script)\n• `scripts/` -- deployed helper scripts like the statusline\n• `claude-versions/` -- installed legacy Claude CLI versions\n\nBack up the whole `resources/` folder to move to a new machine (note: encrypted credentials won\'t transfer -- see the credential tip).',
        bodyMac: 'The app stores everything under `~/Library/Application Support/Claude Conductor/resources/`:\n\n• `CONFIG/` -- JSON files for configs, commands, settings, encrypted credentials, tokenomics, usage tracking\n• `logs/` -- per-session JSONL activity logs\n• `screenshots/` -- captured by Snap features\n• `insights/` -- AI usage reports\n• `status/` -- real-time session metrics (from statusline script)\n• `scripts/` -- deployed helper scripts\n• `claude-versions/` -- installed legacy Claude CLI versions\n\nBack up the whole `resources/` folder to move to a new machine (encrypted credentials won\'t transfer since they\'re tied to Keychain).',
        bodyWin: 'The app stores everything under your resources folder -- `%LOCALAPPDATA%\\AI Code Conductor\\resources\\` on a new install, `...\\Claude Command Center\\...` if you upgraded:\n\n• `CONFIG\\` -- JSON files for configs, commands, settings, encrypted credentials, tokenomics, usage tracking\n• `logs\\` -- per-session JSONL activity logs\n• `screenshots\\` -- captured by Snap features\n• `insights\\` -- AI usage reports\n• `status\\` -- real-time session metrics (from statusline script)\n• `scripts\\` -- deployed helper scripts\n• `claude-versions\\` -- installed legacy Claude CLI versions\n\nBack up the whole `resources\\` folder to move to a new machine (encrypted credentials won\'t transfer since they\'re tied to DPAPI).',
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
        shortText: 'Sign in with GitHub to light up the sidebar',
        title: 'Sign in with GitHub',
        body: 'The GitHub sidebar shows the PR, CI runs, reviews, linked issues, and local git state for your current session. Sign in to unlock it.\n\nYou can use **OAuth device flow** (recommended), **paste a fine-grained PAT** if your org requires it, or let the app auto-detect a **gh CLI** login.\n\nFind it in **Settings > GitHub**. Nothing runs until you opt in per session.',
        actionLabel: 'Open Status Line settings',
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
        shortText: 'Ctrl+/ toggles the GitHub panel',
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
        shortText: 'Enable GitHub on a session to start syncing',
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
        shortText: 'How the sidebar respects your GitHub rate limit',
        title: 'GitHub Rate-Limit Handling',
        body: 'The sidebar polls conservatively and falls back gracefully when you hit a rate limit:\n\n• **Tiered intervals** -- active session polls faster, background sessions slower\n• **304-aware** -- unchanged responses cost 0 against your quota\n• **Per-bucket shields** -- REST vs GraphQL counted separately\n• **Automatic pause + resume** -- when a bucket is exhausted, sync pauses until the reset time, then auto-resumes\n\nYou can lengthen intervals further in **Settings > GitHub > Sync**.',
        actionLabel: 'Open sync settings',
        actionTarget: 'settings',
      },
    },
  },

  {
    id: 'tip.github.ai-usage-meter',
    category: 'github',
    complexity: 'simple',
    priority: 42,
    excludes: ['github.ai-usage-enabled'],
    variants: {
      primary: {
        shortText: 'Track your GitHub Copilot AI-credit spend in the repo strip',
        title: 'AI Usage Meter',
        body: 'Turn on the **AI usage meter** to watch your GitHub Copilot AI-credit spend without leaving the terminal.\n\nA compact chip sits in the **session status strip**. It shows credits used (and your cap, once you set one). The instant GitHub bills you past your included credits the chip turns **amber** and shows the billed amount, for example +$11.69.\n\nClick the chip for a read-only popover: a **per-model GitHub breakdown** (credits, covered, billed) plus the **Claude and Codex** 5h / 7d rate-limit windows side by side.\n\nEnable it under **Settings, GitHub**; set your included-credit cap under **Settings, Status Line**. It is best-effort and never changes anything.',
        actionLabel: 'Open Status Line settings',
        actionTarget: 'settings',
        focusHint: 'Session status strip -- the AI chip',
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
        shortText: 'The panel figures out which issue you are on',
        title: 'Session Context',
        body: 'The **Session Context** section infers which issue your current session is actually working on.\n\nIt checks (in priority order): issue numbers in your current **branch name**, most-recent issue referenced in your **Claude transcript**, first issue referenced in the active **PR body**. Recent file edits show alongside as additional signal.\n\nYou can opt in to transcript scanning under **Settings > GitHub > Privacy** -- it stays entirely local; the transcript never leaves your machine.',
      },
    },
  },

  {
    id: 'tip.dynamic-workflows',
    category: 'productivity',
    complexity: 'advanced',
    priority: 55,
    variants: {
      primary: {
        shortText: 'Opus 4.8 can orchestrate hundreds of subagents',
        title: 'Dynamic Workflows',
        body: 'Opus 4.8 ships **dynamic workflows** -- Claude writes a JavaScript orchestration script on the fly and fans out up to 1,000 parallel subagents in the background while your session stays free.\n\n**Three ways to invoke:**\n- Include the word **workflow** in your prompt\n- Set effort to **Ultracode** in Session Config (auto-orchestrates every task)\n- Run **/deep-research <question>** -- the bundled example\n\nWatch with **/workflows**. Save a run with **s** -- it becomes /<name> in future sessions.\n\nConductor: if you want it off globally, toggle **Disable Claude Code dynamic workflows** in Settings > General > Security.',
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      },
    },
  },

  // ── 2.1: the surfaces the library had nothing for ───────────────────────
  // Everything below covers work that shipped after the last content refresh
  // (2026-06-12): the Agent Canvas and its plan mode, Ask Conductor, the sidebar
  // dock, pages-as-tabs, detachable SSH sessions, Codex, multi-account and the
  // Feature Guide. A tip here gates only on ids this build can actually record
  // (see DIRECT_FEATURE_IDS) -- a gate nothing writes is a tip nobody sees.

  {
    id: 'tip.agent-canvas',
    category: 'agents',
    complexity: 'simple',
    priority: 86,
    excludes: ['canvas.opened'],
    variants: {
      primary: {
        shortText: 'Have your agent SHOW you the work',
        title: 'Agent Canvas',
        body: 'The **Canvas** button in the session toolbar -- next to Snap -- opens a pane your agent can draw into. Ask for a mockup, a design, a plan or a look at the site it just built and it arrives as something you can see, instead of a wall of markdown describing it.\n\nIt is a two-way surface. Click anywhere on the render to leave a **note** -- **Ctrl+V** adds pasted screenshots to it, and anything you draw over the page rides it automatically -- then **approve or reject** the version and send the round. The agent reads the notes, changes the work and renders the next version.\n\nWhen a round is waiting on you, the button turns **amber and says "Review needed"**, with the number of rounds owed beside it -- click the count, or right-click the button, for the list. The session tab carries a dot for the same thing, so a hand-back is visible from any tab.',
        focusHint: 'Session toolbar -- the Canvas button, beside Snap',
      },
      postUse: {
        shortText: 'Every canvas version is kept -- walk back through them',
        title: 'Canvas: Versions, Reviews and the Library',
        body: 'You already use the canvas. A few things it does that are easy to miss:\n\n• **A review is one decision.** You approve or reject the version in front of you, and Submit says exactly what it will do. Notes sent with an **approve** are kept as observations rather than work, and when nothing else is open the artifact signs itself off. Nothing the agent does can re-open a settled round -- reopening a note, or a whole round, is yours alone.\n• **Nothing is overwritten.** **History**, folded at the top of the review panel, picks the artifact (a plan, a mockup, an older test build under Archived), and a per-artifact stepper walks its versions. A History row can also **archive** an artifact (reversible) or **delete it permanently**.\n• **Agents draft in private.** While an agent is still checking its own work it renders invisible drafts; you are only shown versions it deliberately marks ready, and those are what the "Review needed" queue counts.\n• **A note can carry alternatives.** When a fix has more than one defensible answer the agent builds them all and labels them **A**, **B**, **C** on the note. Name your pick in chat and it records the winner, then builds only that one.\n• **The Library** searches every artifact in the project by title and note text, filters by kind and state, expands a test pack to page through its evidence, and archives or deletes in bulk.\n• The pane **replaces the terminal** while it is open -- its mode (PLAN / MOCKUP / TESTING) is the pane title, so you always know what you are looking at.',
      },
    },
  },

  {
    id: 'tip.canvas-plan-mode',
    category: 'agents',
    complexity: 'intermediate',
    priority: 76,
    requires: ['canvas.opened'],
    variants: {
      primary: {
        shortText: 'Ask for the plan as a flow, not a document',
        title: 'Plan Mode on the Canvas',
        body: 'Nobody reads a long markdown plan. Ask your agent to **put the plan on the canvas** and it comes back as a visual flow with a summary: the steps, what each one touches, and what has to happen before what.\n\nA plan is reviewed as a plan, not as a mockup. The two buttons are **Approve** and **Submit Revisions** -- there is no Reject, because a plan is meant to go round again. Click a step to leave a **note**, and send the round.\n\n**Approve is deliberately hard to reach.** It stays unavailable while the plan carries an **open question**, or while you have a note you have not sent, and the panel names which: *"Approve is unavailable: 2 open questions -- answer them in a note and submit revisions"*. Answer them, submit revisions, and the next version is the one you can approve -- so an approval never arrives carrying work the agent has not seen. A round you sent back reads **REVISIONS** in History.\n\nApproving signs the plan off, and the canvas front page keeps a **View plan** jump to it. Use it before a big change: correcting a step on the canvas costs a click, correcting it in the code costs an afternoon.',
        focusHint: 'Session toolbar -- the Canvas button, once your agent has rendered a plan',
      },
    },
  },

  {
    id: 'tip.canvas-testing-evidence',
    category: 'agents',
    complexity: 'intermediate',
    priority: 74,
    requires: ['canvas.opened'],
    variants: {
      primary: {
        shortText: 'Test a live build and save what you actually saw',
        title: 'Testing Mode: Evidence Notes',
        body: 'Ask your agent to serve the build it just made on the canvas and you can click through the real thing, instead of describing what went wrong from memory.\n\nThe moment you start writing a note the screen **pauses** and locks the evidence together: a **screenshot** with your drawings over it, the **page state** (the route, an open dialog, where the focus is, which fields are filled, changed or invalid) and a **timed trail** of what you did to get there. It never records a character of what you typed into a field, only that you typed into it.\n\n**Ctrl+V** adds screenshots of your own, as many as a note needs, and drops **Image 1**, **Image 2** markers where your cursor is -- so your words can point at a specific picture.\n\nNotes collect into a **test pack** you can name, and the build takes one **pass or fail**. After the verdict the pack is a record: the pane shows the saved evidence rather than the live site, and the Library keeps it.',
        focusHint: 'Canvas pane -- TESTING MODE in the title, then just use the page',
      },
    },
  },

  {
    id: 'tip.canvas-explained',
    category: 'agents',
    complexity: 'simple',
    priority: 70,
    requires: ['canvas.opened'],
    variants: {
      primary: {
        shortText: 'One page that draws how canvas reviews work',
        title: 'Canvas Explained',
        body: 'Versions, notes, verdicts, observations, packs -- the canvas has its own vocabulary, and **Canvas Explained** draws all of it on one page instead of describing it.\n\nIt covers what an artifact and its versions are, what a single note actually stores (the element you pointed at, your drawings, pasted images, your words), and the three shapes the loop takes: a **mockup** (versions until you approve), a **plan** (the same machine, where the versions are drafts of the plan) and a **test run** (one build, one verdict, one pack).\n\nTwo doors: the **Canvas Explained** card at the foot of the canvas front page, or the **Feature Guide**, which shows the same page inline.',
        actionLabel: 'Open the Feature Guide',
        actionTarget: 'help',
        focusHint: 'Canvas front page -- the Canvas Explained card at the bottom',
      },
    },
  },

  {
    id: 'tip.canvas-resume',
    category: 'agents',
    complexity: 'simple',
    priority: 66,
    requires: ['canvas.opened'],
    variants: {
      primary: {
        shortText: 'Unfinished canvas work survives its session',
        title: 'Resume Unfinished Canvas Work',
        body: 'A canvas belongs to the session that made it, and while that session is live nobody else sees it. When the session goes away, the work does not.\n\nOpen the canvas in any session on the same project and the front page lists what can be picked up. **Resume** takes a canvas over with its versions, notes and evidence -- the first press wins, and if another session got there first you are told so rather than left guessing. **Dismiss** throws it away, and says how many notes and how much evidence go with it before you confirm.\n\nA small **mauve dot** on the Canvas button is how you know there is something to pick up. It is deliberately quiet: the loud amber "Review needed" state is what YOU owe an answer on, while the dot is work nobody currently holds.\n\nAnything that was signed off is shared with every session on the project as read-only history.',
        focusHint: 'Session toolbar -- the small dot on the Canvas button, then the front page',
      },
    },
  },

  {
    id: 'tip.ask-conductor',
    category: 'ui-navigation',
    complexity: 'simple',
    priority: 84,
    variants: {
      primary: {
        shortText: 'Ask the Conductor how this app works',
        title: 'Ask Conductor',
        body: '**Ask Conductor** sits at the foot of the sidebar. It opens a real session -- its own tab, its own history, resumable like any other -- whose subject is this app rather than your code.\n\nIt is the right place for "how do I...", "what does this button do" and "why did that happen". It is not a saved config and it does not clutter your project list: it is docked below the divider, apart from your work.\n\nThe same session is what **Discuss** opens from any tip, and what the Feature Guide links to -- one conversation, not three.',
        focusHint: 'Bottom of the sidebar -- the Ask Conductor pill, under the session list',
      },
    },
  },

  {
    id: 'tip.dock-right-click',
    category: 'ui-navigation',
    complexity: 'simple',
    priority: 44,
    variants: {
      primary: {
        shortText: 'Right-click the dock to hide tips or Ask Conductor',
        title: 'Hiding a Dock Row',
        body: 'The two rows at the foot of the sidebar -- **Ask Conductor** and the **tip of the day** -- can each be sent away. Right-click either one and choose **Hide**.\n\nIt is worth knowing what that does: it switches the FEATURE off, not just its row. With tips hidden nothing is picked at launch and no tip is raised anywhere; with Ask Conductor hidden there is no way to start one. A dialog says so before anything happens.\n\nBoth come back in **Settings > General** -- "Show intelligent tips" and "Show Ask Conductor".',
        focusHint: 'Bottom of the sidebar -- right-click either dock row',
      },
    },
  },

  {
    id: 'tip.pages-as-tabs',
    category: 'ui-navigation',
    complexity: 'simple',
    priority: 66,
    variants: {
      primary: {
        shortText: 'Tokenomics, Logs and Settings open as tabs',
        title: 'Pages Are Tabs',
        body: 'Opening Tokenomics, Logs, Memory or Settings does not take the window away from your sessions -- each opens as a **tab in the same strip**, beside them.\n\nSo you can leave Tokenomics open while you work, keep Logs a click away, and have several pages open at once.\n\n**Ctrl+Tab** cycles the whole strip -- sessions and pages together -- and **Ctrl+W** closes whichever tab is in front (a session tab routes through the usual close question first).',
      },
    },
  },

  {
    id: 'tip.ssh-persistence',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 74,
    requires: ['sessions.session-type'],
    variants: {
      primary: {
        shortText: 'Keep a remote session alive when the link drops',
        title: 'SSH Persistent Sessions',
        body: 'You run sessions over SSH -- so you have met the failure: the laptop sleeps, the VPN blinks, and the work on the other end dies with the connection.\n\nHow a config connects is a choice of three cards, not a checkbox: **Local**, **SSH**, and **SSH Persistent**. Pick the third and the remote Claude runs inside a tmux session, so the link dropping no longer kills it -- reconnect and you are reattached where you were, output and all.\n\nClosing a persistent session asks what you actually meant -- **End it** on the host, or **Leave it running** and come back later. The sidebar marks which of your sessions are persistent.\n\n(If you set the old **Detachable** checkbox on a config, it already opens as SSH Persistent. Nothing to re-save.)',
        focusHint: 'Session config -- the connection cards, the third one: "SSH Persistent"',
      },
    },
  },

  {
    id: 'tip.container-runtime',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 72,
    requires: ['sessions.session-type'],
    variants: {
      primary: {
        shortText: 'Run a remote session inside a container',
        title: 'Runtime: Run Claude in a Container',
        body: 'An SSH config has a **Runtime** section that decides where the session lands once it has connected: **On the host**, or **In a Docker container**.\n\nPick the container option and you fill in fields instead of maintaining a shell one-liner: the **engine** (docker or podman), the **container name**, whether to **Exec into running** or **Start stopped**, an optional directory inside the container, and a tick if the engine needs **sudo** (that password goes to your OS credential store, like an SSH password). The app composes and runs the command.\n\nClaude runs *inside* the container with the statusline, account and usage all working, and ending the session stops that session\'s Claude in there -- another session sharing the container is left alone.\n\nAlready doing this with a hand-written command? The dialog spots a docker-shaped one and offers a one-click **Convert**. It never rewrites it silently, and **After connecting, run** stays under **Advanced** for prep that is not a container.',
        focusHint: 'Session config -- the Runtime section, below the connection cards (SSH configs only)',
      },
    },
  },

  {
    id: 'tip.codex-sessions',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 64,
    excludes: ['sessions.codex-config'],
    variants: {
      primary: {
        shortText: 'Run OpenAI Codex sessions beside Claude',
        title: 'Codex Sessions',
        body: 'A saved config does not have to run Claude Code. Switch **Settings > Codex** on, and the session dialog grows a provider choice: **Claude** or **Codex**, with its own account and its own sign-in.\n\nEverything else is the same session model you already use -- tabs, notes, commands, logs -- so a Codex session sits in the sidebar next to a Claude one and behaves like it.\n\n**Tokenomics counts Codex too**, so the spend comparison is in one place rather than two. Local sessions only for now: SSH configs stay on Claude.',
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      },
    },
  },

  {
    id: 'tip.multi-account',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 68,
    excludes: ['accounts.switch-session-account'],
    variants: {
      primary: {
        shortText: 'Run more than one Claude account, session by session',
        title: 'Multi-Account',
        body: 'Each session runs as **one account**, and different sessions can run as different ones -- work on one, personal on another, a spare for when the first hits its weekly limit.\n\n**Right-click a session** and pick an account to move it. The footer strip shows every live account with its usage, so you can see which one has room before you choose.\n\nEach account keeps its own credentials, its own browser session and its own limits -- switching a session is not switching your whole app.',
        focusHint: 'Right-click a session in the sidebar -- the account list is in the menu',
      },
    },
  },

  {
    id: 'tip.account-strip-minimal',
    category: 'ui-navigation',
    complexity: 'simple',
    priority: 46,
    requires: ['accounts.switch-session-account'],
    variants: {
      primary: {
        shortText: 'Turn the account strip into traffic lights',
        title: 'A Minimal Account Strip',
        body: 'With several accounts live the footer strip gets busy. **Settings > Status Line > "Multi-account footer style"** turns the bars into dots: one for usage -- the worse of your time windows -- and one per model.\n\nGreen under 70%, amber to 89%, red at 90% and above: the same points at which the bars change colour, so a dot can never disagree with the meter it replaced. The exact figures move into the tooltip.\n\nWhichever buckets you switched off above stay off here -- it is the same list, drawn smaller.',
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      },
    },
  },

  {
    id: 'tip.feature-guide',
    category: 'ui-navigation',
    complexity: 'simple',
    priority: 62,
    variants: {
      primary: {
        shortText: 'The Feature Guide is the map of this app',
        title: 'Feature Guide',
        body: 'Tips arrive one at a time and in no particular order. The **Feature Guide** is the same material laid out properly: Getting started, Integrations, Admin & data and Productivity, each with what the feature is for rather than only where it lives.\n\nIt also carries **What\'s New** -- the full release history, the same notes you are shown after an update, browsable any time rather than only in the moment they appear.\n\nWorth ten minutes on a quiet afternoon; most of what people ask Ask Conductor is answered there.',
        actionLabel: 'Open Feature Guide',
        actionTarget: 'help',
      },
    },
  },

  {
    id: 'tip.logs-page',
    category: 'advanced',
    complexity: 'simple',
    priority: 58,
    excludes: ['advanced.log-viewer'],
    variants: {
      primary: {
        shortText: 'Every session\'s output is kept -- read it in Logs',
        title: 'Logs',
        body: 'Terminal scrollback is finite and a closed session takes its history with it. **Logs** keeps the output anyway: what ran, in which session, and when.\n\nUse it for the thing you saw twenty minutes ago and cannot scroll back to, for what a session did while you were in another tab, and for handing an exact error to someone else.\n\nIt stays on your machine -- the log files live in your resources folder and nothing is uploaded.',
        actionLabel: 'Open Logs',
        actionTarget: 'logs',
      },
    },
  },

  // ── beta.17: the one-row bar, canvas x-ray/zoom, the watchdog, GPU ──────
  // Added at the 2.1.0-beta.17 tips sweep (#377). Same rule as the block
  // above: gate only on ids this build records.

  {
    id: 'tip.command-bar-one-row',
    category: 'commands',
    complexity: 'simple',
    priority: 78,
    variants: {
      primary: {
        shortText: 'The command bar is one row now -- right-click it',
        title: 'The One-Row Command Bar',
        body: 'The command bar is **one row by default**: core tools on the left as icons, then your Global commands, then this config\'s Session ones -- and anything that does not fit folds into a **"N more" pill** at the end of its band instead of wrapping. (Settings can give it a second row before folding.)\n\nThe bar is worth a right-click. **Right-click empty bar** for Add command… and Add section…; **right-click a command** to edit, move, or retarget it; **right-click a core tool** to hide it from the row.\n\nHidden core tools come back under **Settings > Custom Commands**, which also has the switch for the whole row. And **Ctrl+click** any command that takes arguments still opens the one-run arguments editor.',
        focusHint: 'The command bar above the terminal -- try a right-click',
      },
    },
  },

  {
    id: 'tip.canvas-xray-zoom',
    category: 'agents',
    complexity: 'intermediate',
    priority: 60,
    requires: ['canvas.opened'],
    variants: {
      primary: {
        shortText: 'X-Ray and zoom: inspect a render without disturbing it',
        title: 'Canvas X-Ray and Zoom',
        body: 'The pane\'s tool row has two groups, **X-RAY** and **ANNOTATE**.\n\n**X-Ray** decides what hovering does while you are reading the page. **On** outlines and labels the element under the pointer (the default). **Stealth** still identifies it -- the identity and box are read out in the panel -- but draws nothing on the page, so a hover-sensitive design stays undisturbed. **Off** makes the page behave like a normal browser tab. Clicking any X-Ray segment is also the way back to using the page when you have been drawing. Plan pages lock to Stealth: the flow itself is the picture, and boxes on top of it were noise.\n\n**Annotate** is **Sketch** (a toggle -- press it again to give the page back the pointer), **Tools** (hide the drawing tools without leaving Sketch) and **Region** (drag a rectangle to target an area).\n\n**Zoom** is **Ctrl+wheel** anywhere over the pane -- chrome, render or notes panel. The level shows in the header while you are zoomed and holds for as long as the pane is open, so a dense mockup can be read at 150% without asking the agent to render it bigger.',
        focusHint: 'Canvas pane tool row -- the X-RAY and ANNOTATE groups, and the zoom readout',
      },
    },
  },

  {
    id: 'tip.session-watchdog',
    category: 'sessions',
    complexity: 'intermediate',
    priority: 63,
    variants: {
      primary: {
        shortText: 'Auto-resume sessions after a rate limit resets',
        title: 'Session Watchdog',
        body: 'Hit a usage limit at 4pm and the session just sits there until you notice. The **Session Watchdog** notices for you: it reads the limit banner, waits out the reset time, and types the retry itself -- so an overnight session picks itself back up instead of losing the hours.\n\nIt is careful about WHEN it types. Nothing is sent while a permission prompt or picker is open, or while your own unsubmitted draft is in the input box -- the retry defers rather than corrupting either. It also backs off on API overload errors, with capped attempts.\n\n**Off by default.** Turn it on under **Settings > General > Session Watchdog**, where you can also change the retry message. Local Claude sessions only.',
        actionLabel: 'Open Settings',
        actionTarget: 'settings',
      },
    },
  },

  {
    id: 'tip.gpu-rendering',
    category: 'advanced',
    complexity: 'intermediate',
    priority: 35,
    variants: {
      primary: {
        shortText: 'Terminals draw on the GPU now -- Ctrl+Alt+G if glyphs vanish',
        title: 'GPU Terminal Rendering',
        body: 'Terminals are drawn on the **GPU** by default now -- noticeably faster with several busy sessions on screen.\n\nEvery terminal shares one cache of character images. When one session rebuilds that cache, the others redraw themselves the way they would after a window resize, so text no longer drops out of background terminals.\n\nIf you ever DO see characters go missing while backgrounds stay: press **Ctrl+Alt+G** to save a diagnostic (event log plus screenshot) worth attaching to a bug report, and flip **Settings > General > Terminal > GPU rendering** off to fall back to the plain renderer. The change takes effect the next time a terminal is shown -- a tab switch is enough.',
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
        shortText: 'What the app sends over the network',
        title: 'Network Activity',
        body: 'In the interest of transparency, here\'s every network call the app makes:\n\n• **Rate limits** (`api.anthropic.com/api/oauth/usage`) -- once per Claude Code command, only when statusline is enabled. Uses YOUR Claude OAuth token (read from `~/.claude/.credentials.json`).\n\n• **Update check** (`api.github.com`) -- via `gh` CLI, checks for new releases when you explicitly trigger an update check or on app start.\n\n• **Model pricing** (`raw.githubusercontent.com/BerriAI/litellm`) -- once per 24 hours, to get current Claude model pricing for cost calculations. Cached locally.\n\n• **Vision MCP server** -- listens on `127.0.0.1:19333` only. Localhost-only, never exposed to the network.\n\n**The app sends NO telemetry, analytics, or usage data.** Everything else stays on your machine.',
      },
    },
  },
]
