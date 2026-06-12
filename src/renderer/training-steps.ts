/** Logical group used in the hero breadcrumb. Keep small — one of these. */
export type TrainingSection =
  | 'getting-started'
  | 'productivity'
  | 'integrations'
  | 'admin'
  | 'tips'

export const SECTION_LABELS: Record<TrainingSection, string> = {
  'getting-started': 'Getting started',
  productivity: 'Productivity',
  integrations: 'Integrations',
  admin: 'Admin & data',
  tips: 'Tips & shortcuts',
}

export interface TrainingStep {
  id: string
  title: string
  sinceVersion: string
  /** Bullet copy. Used by the legacy renderer + as a fallback when the
   * richer hero fields below aren't filled in. */
  bullets: string[]
  screenshotFilename: string
  /** Hero-layout fields. All optional so legacy steps keep working until
   * each is migrated. When `summary` is present the renderer uses the
   * hero layout; otherwise it falls back to the flat bullets list. */
  section?: TrainingSection
  /** One- to two-sentence what-is-this paragraph shown under the hero
   * screenshot. Reads better than a flat bullet list as the opener. */
  summary?: string
  /** Bullets used in the "Highlights" column of the hero layout. If
   * omitted the renderer falls back to `bullets`. */
  highlights?: string[]
  /** Right column of the hero layout. Each entry is a label + short value
   * (button location, keyboard shortcut, menu path, etc.). */
  howToTrigger?: { label: string; value: string }[]
  /** Optional callout shown below "How to open" — pull-quote style. */
  proTip?: string
}

export const trainingSteps: TrainingStep[] = [
  {
    id: 'session-options',
    title: 'Session Configuration',
    sinceVersion: '1.5.11',
    section: 'getting-started',
    summary:
      'Every workspace starts as a saved config -- label, colour, working directory, model, and any agents you want pre-loaded. New sessions default to Opus 4.8. Effort is a live setting you change in Claude with /effort (it shows in the statusline and on the session card), not a config field.',
    highlights: [
      'Model defaults to **Opus 4.8** (Anthropic`s newest, released 2026-05-28)',
      'Effort is **live** -- set it in Claude with `/effort` (low, medium, high, xhigh, max, ultracode); the card shows the current level',
      'Local or SSH -- one config form, full Claude support either way',
      'Bundle agent templates from your Library into the session at spawn',
    ],
    howToTrigger: [
      { label: 'Create', value: 'Saved Configs → +' },
      { label: 'Edit', value: 'Hover a config → pencil icon' },
      { label: 'Pin', value: 'Saved Configs → 📌' },
    ],
    proTip:
      'Drag a folder onto the sidebar to create a working-directory config in one drop — fastest way to bootstrap a new project session.',
    bullets: [
      'Create **saved configs** with custom working directories and models',
      'Effort is **live** -- run `/effort` in Claude to change it; the level shows on the card and in the statusline',
      '**Bundle agent templates** from your Library into the spawned session',
      'Connect to remote machines via **SSH** with full Claude support',
    ],
    screenshotFilename: 'step-session-options.jpg',
  },
  {
    id: 'multi-account',
    title: 'Multiple Accounts',
    sinceVersion: '1.5.26',
    section: 'getting-started',
    summary:
      'Run more than one Claude account side by side. Your existing login is captured into a protected primary account on first run, and every session runs under a saved, isolated account, so signing in to one never disturbs another or your default login.',
    highlights: [
      'Pick the account at **launch time** -- the first time a session spawns this run, a small dialog asks which account to use (pre-set to the last one you used)',
      'Add an account by running **`/login`** in a session: CCC detects the new login and offers to save it as a separate named account',
      '**Per-session isolation** -- each session gets its own private home, so two sessions on different accounts never cross over',
      'Your **primary** account (the one captured on first run) is protected and can never be deleted',
      'Memory, settings, and history stay **shared** across all accounts',
    ],
    howToTrigger: [
      { label: 'Choose at launch', value: 'Start a session → account dialog' },
      { label: 'Add an account', value: 'run /login in a session, or Settings → Accounts → Add' },
      { label: 'Manage', value: 'Settings → Accounts (name + colour each one)' },
    ],
    proTip:
      'Give each account a friendly name and a distinct colour in Settings, Accounts. The colour follows the account onto the session card, the statusline, and the launch picker so you always know which login a session is on.',
    bullets: [
      'Run **multiple Claude accounts**; pick which one a session uses when it launches',
      'Add accounts by running **/login** in a session, or from Settings, Accounts',
      'Each session is **isolated** -- signing in to one never touches the others or your default',
      'Name and colour each account in **Settings, Accounts**; memory and history stay shared',
    ],
    // No dedicated account-picker capture exists yet; the Settings shot shows
    // where accounts are managed. (Future capture: step-accounts.jpg / the
    // launch-time account picker.)
    screenshotFilename: 'step-security.jpg',
  },
  {
    id: 'codex-provider',
    title: 'Codex Provider',
    sinceVersion: '1.5.0',
    section: 'integrations',
    summary:
      "OpenAI's Codex CLI sits alongside Claude in the New Session dialog -- pick the provider per session. gpt-5 series models, runtime permissions presets, the resume picker, and tokenomics segmenting all wired in.",
    highlights: [
      'Provider toggle in **New Session** -- Claude or Codex, chosen per spawn',
      'Six gpt-5 models in the dropdown: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.2',
      'Permissions presets in the session toolbar: read-only, standard, auto, unrestricted',
      'Resume picker mirrors the Claude flow -- recent rollouts surfaced before spawn',
      '**Tokenomics** segments Codex spend automatically alongside Claude, per-day and per-model',
    ],
    howToTrigger: [
      { label: 'Spawn', value: 'New Session -> Provider -> Codex' },
      { label: 'Auth', value: 'Settings -> Codex -> Login' },
      { label: 'Model swap', value: 'Session toolbar -> model dropdown' },
    ],
    proTip:
      'Login once via Settings -> Codex; subsequent Codex sessions reuse the same auth. Spend lands in tokenomics under the Codex provider tag, side by side with Claude.',
    bullets: [
      '**Provider per session** -- Claude OR Codex, picked at New Session time',
      '**gpt-5 series** model dropdown plus **permissions presets** in the toolbar',
      '**Resume picker** for recent Codex rollouts, same flow as Claude',
      '**Tokenomics** segments Codex spend automatically alongside Claude',
    ],
    screenshotFilename: 'step-codex.jpg',
  },
  {
    id: 'agent-hub',
    title: 'Agent Hub',
    sinceVersion: '1.0.0',
    section: 'integrations',
    summary:
      'Two surfaces in one. Tasks dispatch headless Claude as background jobs. The Library is where you author agent templates — name, prompt, model, tool whitelist — that surface as tickable subagents in every Edit Config dialog.',
    highlights: [
      'Tasks tab — fire-and-forget headless agent runs with live status + output streaming',
      'Teams tab — chain agents (a → b → c) with shared context and per-step prompts',
      'Library tab — author your own templates; built-ins (code-reviewer, test-runner...) are starting points to copy and edit',
      'Tick a template in Edit Config → Agents and Claude can delegate to it via the Task tool inside the running session',
      'Right-click a task for actions: cancel, retry, remove, copy output',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  ☁  in the sidebar nav' },
      { label: 'Author', value: 'Library tab → + New Agent' },
      { label: 'Bundle into session', value: 'Edit Config → Agents → tick template' },
    ],
    proTip:
      'Library templates aren\'t just for headless Tasks — anything you author there is also a subagent inside any Claude session that has it ticked in the config. Same definition, two delivery surfaces.',
    bullets: [
      '**Tasks** dispatch headless Claude jobs with live output streaming',
      '**Library** is where you author agent templates that surface in Edit Config',
      '**Teams** chain agents with shared context and per-step prompts',
      'Built-ins (code-reviewer, test-runner...) are **starting points** — copy and edit',
    ],
    screenshotFilename: 'step-agent-hub.jpg',
  },
  {
    id: 'vision',
    title: 'Conductor MCP',
    sinceVersion: '1.2.144',
    section: 'integrations',
    summary:
      'Browser automation via a global MCP server — every Claude session shares one Chrome instance. Take screenshots, navigate, click, type, and inspect pages without leaving the terminal. Works over SSH too via automatic reverse tunnels.',
    highlights: [
      '17 browser-vision tools (one of three sub-tools on the Conductor MCP server) exposed to Claude',
      'One global Chrome -- all sessions share state, so cookies + login persist',
      'Reverse tunnel auto-injected on SSH connect (-R <port>) -- remote sessions reach the local Conductor MCP server',
      'Status pill in the sidebar shows running / connected state at a glance',
      'Headless or visible browser — toggled per-config in Settings',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  Conductor MCP  in the sidebar nav' },
      { label: 'Start', value: 'Conductor MCP page → Start' },
      { label: 'Launch browser', value: 'Conductor MCP page → Launch Chrome' },
    ],
    proTip:
      'Ask Claude "open the dev server in the browser and click around to verify the layout" — it\'ll drive vision tools to do exactly that and report back.',
    bullets: [
      '**Browser automation** via a global MCP server — all sessions share one browser',
      'Click the **eye icon** in the sidebar to configure and start vision',
      '17 vision tools available to Claude: **screenshot, navigate, click, type** and more',
      'Works over **SSH** too — reverse tunnels connect remote sessions automatically',
    ],
    screenshotFilename: 'step-vision.jpg',
  },
  {
    id: 'webview',
    title: 'Webview Pane',
    sinceVersion: '1.4.0',
    section: 'productivity',
    summary:
      'Embed any URL right next to your terminal. Custom commands open dev servers, dashboards, or docs in-app — and freezing the pane drops you straight into Excalidraw to annotate over what you are seeing.',
    highlights: [
      'Pinned to the same session — pane state survives tab switches',
      'Custom commands declare URLs so the toolbar surfaces a Web button automatically',
      'Status pulse: green when reachable, red when the URL fails to load',
      'Freeze + Excalidraw — capture a frame and draw over it without leaving the session',
      'Esc closes the pane back to terminal-only view',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Session toolbar → Web (visible when a webview command exists)' },
      { label: 'Pin URL', value: 'Custom command → enable webview + URL field' },
      { label: 'Freeze', value: 'Web pane header → Freeze (opens Excalidraw on the snapshot)' },
    ],
    proTip:
      'Wire your dev server URL into a custom command — every session for that config gets a one-click in-app preview without ever leaving the keyboard.',
    bullets: [
      '**Embed any URL** in the session pane via webview-enabled custom commands',
      '**Freeze** the current frame and annotate it in Excalidraw',
      'Status indicator turns **green when reachable, red when broken**',
      'Closes with **Esc** or the toolbar button toggle',
    ],
    // No dedicated webview capture exists yet; the Excalidraw shot shows the
    // same in-pane swap of the terminal, so it reads correctly until a real
    // webview screenshot is captured. (Future capture: step-webview.jpg.)
    screenshotFilename: 'step-excalidraw.jpg',
  },
  {
    id: 'excalidraw',
    title: 'Excalidraw Scratchpad',
    sinceVersion: '1.4.0',
    section: 'productivity',
    summary:
      'A per-session whiteboard for diagramming, planning, or sketching ideas before you describe them to Claude. Drawings persist with the session and pair cleanly with Freeze for annotating screenshots.',
    highlights: [
      'Per-session canvas — switching sessions swaps the drawing in place',
      'Full Excalidraw toolset: shapes, arrows, text, freehand, libraries',
      'Drawings auto-save to the session config — closing and reopening the app restores them',
      'Freeze the webview pane to import a snapshot and draw straight over it',
      'Replaces the terminal in place — no fullscreen modal eating the toolbar',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Session toolbar → Draw' },
      { label: 'Switch back', value: 'Click Draw again, or pick a different session' },
      { label: 'Clear canvas', value: 'Excalidraw header → Reset' },
    ],
    proTip:
      'Sketch the architecture of what you want to build, then ask Claude to look at the drawing in Excalidraw — it will fetch the canvas via the vision MCP and reason about it directly.',
    bullets: [
      '**Per-session whiteboard** for diagrams, planning, or quick sketches',
      'Drawings **persist** with the session config across restarts',
      'Pair with **Freeze** to annotate webview snapshots',
      'Replaces the terminal in place — toggle off to return',
    ],
    screenshotFilename: 'step-excalidraw.jpg',
  },
  {
    id: 'combined-mode',
    title: 'Combined Mode',
    sinceVersion: '1.4.0',
    section: 'productivity',
    summary:
      'Run Claude and a regular shell side-by-side in the same session. Useful when you want to watch logs, run quick git commands, or babysit a long-running build without spawning a second session.',
    highlights: [
      'Configure a partner terminal path (cmd, pwsh, bash) per saved config',
      'Both shells share the same working directory at spawn',
      'Quick command buttons can target Claude or partner explicitly',
      'Resize the split bar to favour whichever pane is active',
      'Optional elevated partner — runs as admin via gsudo on Windows',
    ],
    howToTrigger: [
      { label: 'Configure', value: 'Edit Config → Partner terminal path' },
      { label: 'Quick commands', value: 'Custom command → Target = Partner' },
      { label: 'Resize', value: 'Drag the vertical bar between panes' },
    ],
    proTip:
      'Set partner = pwsh.exe on Windows or bash on macOS so you have a familiar shell ready for quick sanity checks while Claude does the heavy lifting in the other pane.',
    bullets: [
      '**Side-by-side** Claude + regular shell in the same session',
      'Configure a **partner terminal** path in the session config',
      '**Quick commands** can target either pane (Claude or Partner)',
      'Optional **elevated partner** for admin tasks (Windows: gsudo)',
    ],
    screenshotFilename: 'step-combined.jpg',
  },
  {
    id: 'snap',
    title: 'Snap Screenshot',
    sinceVersion: '1.4.0',
    section: 'productivity',
    summary:
      'Capture a region of any screen and hand it straight to Claude. Local sessions get the file path written into the prompt; SSH sessions fetch the image over the Conductor MCP tunnel.',
    highlights: [
      'Region capture with magnifier, mosaic, brush, redo / undo built in',
      'Window capture mode — pick from a thumbnail list of any open window',
      'JPEG-encoded at 1920px max long edge to stay under Claude\'s image budget',
      'Saved to the session resources screenshots/ folder so you can drag-drop later too',
      'Esc cancels at any point — no stuck overlays',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Session toolbar → Snap' },
      { label: 'Region', value: 'Click Snap → drag a rectangle on screen' },
      { label: 'Window', value: 'Click Snap → Window → pick from list' },
    ],
    proTip:
      'Snap a UI bug, then ask Claude to look at the screenshot you just snapped — it ingests the image directly and you skip the upload-and-describe roundtrip.',
    bullets: [
      '**Region or window** capture, both routed straight to Claude',
      'Local sessions get the **file path** in the prompt; SSH uses **vision MCP fetch**',
      'Encoded at **1920px / JPEG 85** to stay under image budget',
      '**Esc** cancels mid-drag if you change your mind',
    ],
    screenshotFilename: 'step-snap.jpg',
  },
  {
    id: 'tokenomics',
    title: 'Tokenomics',
    sinceVersion: '1.5.10',
    section: 'admin',
    summary:
      'Track every dollar Claude and Codex cost you across every session. A background indexer reads all of your transcripts (including subagent and sidechain files), dedups globally, and computes cost at query time from live pricing, so the dashboard opens instantly with a KPI row, charts, and a sessions table you can filter.',
    highlights: [
      '**KPI row** -- total spend, tokens, sessions, and daily burn at the top',
      '**Charts** for daily spend and a per-model breakdown',
      '**Sessions table** with cost, model, and config attribution per session',
      '**Filters** -- slice by date, model, account, or project',
      'Pricing from BerriAI`s LiteLLM (cached 24h); a green nav badge shows when the index is fresh',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  $  in the sidebar nav' },
      { label: 'Filter', value: 'Header → date / model / account / project' },
      { label: 'Reindex', value: 'Header → Reindex (rebuilds from transcripts)' },
    ],
    proTip:
      'Filter by account to see which login is burning the budget, or by model to compare Opus vs Sonnet vs Haiku spend across the same projects. Life-to-date may read lower than the old page -- the rebuild dedups and prices at current rates.',
    bullets: [
      'Instant-open dashboard: **KPI row**, **charts**, and a filterable **sessions table**',
      'Track **token usage and costs** across all your Claude and Codex sessions',
      '**Filter** by date, model, account, or project',
      'Cost computed at query time from **live pricing** over a deduped index of every transcript',
    ],
    screenshotFilename: 'step-tokenomics.jpg',
  },
  {
    id: 'memory-visualiser',
    title: 'Memory',
    sinceVersion: '1.5.38',
    section: 'admin',
    summary:
      'A dashboard over Claude\'s auto-memory across every project. A KPI strip and charts summarise the whole store; a ranked project list shows staleness and live-session activity; drill into any project for a sortable memory table, and open a memory in the reading drawer to read it cleanly.',
    highlights: [
      '**KPI strip** -- memories, projects, total size, stale over 30 days, and index health',
      '**Activity chart** + **type donut** for the whole store',
      '**Ranked projects** with staleness dots, index warnings, and live-session chips',
      'Drilldown: sortable memory table + sessions rail (live sessions jump to the terminal; recent sessions deep-link into Logs)',
      '**Reading drawer** to read a memory, write missing frontmatter, or delete it; full-text search across everything',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click the Memory icon in the sidebar nav' },
      { label: 'Search', value: 'Header → search input or  Ctrl+F' },
      { label: 'Read / delete', value: 'Click a memory → reading drawer' },
    ],
    proTip:
      'Watch the index-health KPI and the per-project staleness dots: a project that has gone red is a sign its memory has drifted out of date or grown past Claude\'s soft cap, so it is worth a prune.',
    bullets: [
      'Dashboard over Claude Code **auto-memory** across all your projects',
      'Click the **Memory icon** in the sidebar to open it',
      '**KPI strip**, activity chart, type donut, and a **ranked project list** with live-session chips',
      'Drill into a project, then **read, write frontmatter, or delete** any memory from the reading drawer',
    ],
    screenshotFilename: 'step-memory.jpg',
  },
  {
    id: 'insights',
    title: 'Insights',
    sinceVersion: '1.5.10',
    section: 'admin',
    summary:
      'A digest of how Claude is actually performing across your sessions — what is working, what is friction, and where you spend tokens disproportionately. Generated by analysing your transcripts on demand. v1.5.10 drops the iframe and renders the report natively, so it loads faster and follows your theme.',
    highlights: [
      'Native render — no iframe, no theme flicker, faster paint (v1.5.10)',
      'Big wins, friction points, and key insight callouts surfaced from real sessions',
      'Per-project area breakdown — which folders take the most time and cost',
      'Click through to the underlying transcripts that drive each finding',
      'Distinct from Tokenomics: qualitative ("what" / "why"), not quantitative',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  ✨  in the sidebar nav' },
      { label: 'Generate', value: 'Insights page → Generate report' },
      { label: 'Drill in', value: 'Click any project area for a detailed breakdown' },
    ],
    proTip:
      'Run an Insights report after a long working week — the friction list often surfaces patterns (unclear instructions, retries, dead-ends) you can fix with one tweak to your CLAUDE.md.',
    bullets: [
      '**Qualitative analysis** of how Claude is performing in your sessions',
      'Surfaces **big wins**, **friction points**, and per-area breakdowns',
      'Click through to the **underlying transcripts** that drive each finding',
      'Distinct from Tokenomics — focused on patterns, not raw cost',
    ],
    screenshotFilename: 'step-insights.jpg',
  },
  {
    id: 'logs',
    title: 'Logs',
    sinceVersion: '1.5.30',
    section: 'admin',
    summary:
      "Logs is a chat-transcript viewer. CCC indexes Claude's own conversation transcripts (which live in ~/.claude/projects) and renders them back as a readable chat — messages, tool calls, and thinking — with a timeline rail for fast scrubbing and full-text search across everything.",
    highlights: [
      'Browse conversations as a chat, grouped by config (filter by account)',
      'A timeline rail beside the transcript scrubs the whole conversation; click to jump',
      'Full-text search across all conversations; click a hit to open it at that turn',
      'Per-session Conversation tab that live-follows the running session',
      "Deleting an index never touches your conversations — those stay in ~/.claude/projects",
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click the Logs icon in the sidebar nav' },
      { label: 'Search', value: 'Header search box (full-text across all conversations)' },
      { label: 'Per-session', value: 'Open the Conversation tab on a running session' },
    ],
    proTip:
      "Reading back a long session? Use the timeline rail to jump straight to a tool call or a clear divider — and search jumps you to the exact turn without scrolling.",
    bullets: [
      "**Chat-transcript viewer** — Claude's own transcripts, rendered as readable chat",
      '**Grouped by config** with an account filter; conversations live in ~/.claude/projects',
      '**Full-text search** across all conversations; jump straight to the matching turn',
      '**Timeline rail** to scrub the whole conversation, plus a per-session **Conversation** tab',
    ],
    screenshotFilename: 'step-logs.jpg',
  },
  {
    id: 'settings',
    title: 'Settings',
    sinceVersion: '1.2.155',
    section: 'admin',
    summary:
      'Every preference you can set lives here, organised in a left rail. Sandboxed renderer + signed updates + zod-validated IPC keep the app safe; the visible knobs let you tune everything else.',
    highlights: [
      'General — default working dir, machine name, update channel, security toggles',
      'Status Line — toggle each element of the in-terminal status bar + font + size',
      'Shortcuts — rebind every keyboard shortcut',
      'GitHub — sign in (OAuth / PAT / gh CLI) and configure per-session integration',
      'About — version, build time, replay training, view What\'s New',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  ⚙  in the sidebar nav' },
      { label: 'Replay tour', value: 'About → Replay Training' },
      { label: 'What\'s new', value: 'About → View What\'s New' },
    ],
    proTip:
      'Settings is also where you pick Stable or Beta updates, rebind every shortcut, choose which statusline metrics show, and toggle local log indexing — all without leaving the app.',
    bullets: [
      '**Disable dynamic workflows** globally, or skip permission prompts for headless agents',
      '**Sandbox enabled** — renderer runs in a sandboxed process',
      'Choose **Stable or Beta** update channel for app updates',
      'Customize **keyboard shortcuts**, terminal font size, and status line metrics',
    ],
    screenshotFilename: 'step-security.jpg',
  },
  {
    id: 'sentinel',
    title: 'CCC Sentinel',
    sinceVersion: '1.5.37',
    section: 'admin',
    summary:
      'An opt-in watcher that notices when Claude Code updates and checks whether the new version might affect CCC. It surfaces findings in a labelled "Sentinel" chip and a panel, proposes registry fixes you apply yourself, and never changes anything automatically.',
    highlights: [
      'Runs on startup when Claude Code\'s version changes; **fail-open** so it never blocks the app',
      'Checks the CC changelog against CCC\'s compatibility assumptions',
      'Proposes **model and effort registry** fixes you **Apply** (or Dismiss) -- never automatic',
      'A hot-reloadable registry means unknown or brand-new models still get a colour, label, and pricing',
      'Opt-in -- turn it on or off in **Settings → CCC Sentinel**',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click the Sentinel chip in the title bar' },
      { label: 'Enable', value: 'Settings → CCC Sentinel → Enable' },
      { label: 'Apply a fix', value: 'Sentinel panel → Apply on a proposal' },
    ],
    proTip:
      'When a finding offers an Apply button it is a safe registry change you can take in one click; everything else is a compatibility report so you know what to watch after a Claude Code update.',
    bullets: [
      'Opt-in watcher that flags when a **Claude Code update** might affect CCC',
      'Findings show in a labelled **Sentinel chip** and a panel',
      'Proposes **registry fixes you apply yourself** -- nothing changes automatically',
      'Toggle it in **Settings → CCC Sentinel**',
    ],
    // No dedicated Sentinel capture exists yet; the Settings shot shows where
    // it is enabled. (Future capture: step-sentinel.jpg / the Sentinel panel.)
    screenshotFilename: 'step-security.jpg',
  },
  {
    id: 'tips',
    title: 'Tips & Shortcuts',
    sinceVersion: '1.0.0',
    section: 'tips',
    summary:
      'Power moves you\'ll start using on day two. The status bar in the bottom toolbar pulses contextual tips as you discover features, so most of these surface naturally as you work.',
    highlights: [
      'Ctrl+Tab / Ctrl+Shift+Tab — cycle between sessions',
      'Ctrl+1–9 — jump directly to session N',
      'Alt+V — paste image-from-clipboard as a file path into Claude\'s prompt',
      'Esc — close webview pane / dismiss tour / cancel context menu',
      'Status bar — live tokens, cost, rate limits',
    ],
    howToTrigger: [
      { label: 'Rebind', value: 'Settings → Shortcuts' },
      { label: 'Tip pulse', value: 'Bottom toolbar → 💡' },
    ],
    proTip:
      'Hover the bottom-toolbar lightbulb to see the catalogue of tips you haven\'t triggered yet — useful for finding features you didn\'t know existed.',
    bullets: [
      '**Ctrl+Tab** / **Ctrl+Shift+Tab** to cycle between sessions',
      '**Ctrl+1-9** to jump directly to a session by number',
      'Create **quick command buttons** with customizable arguments',
      'Live **statusline** shows tokens, cost, and rate limits',
    ],
    screenshotFilename: 'step-tips.jpg',
  },
  {
    id: 'dynamic-workflows',
    title: 'Dynamic Workflows',
    sinceVersion: '1.5.12',
    section: 'productivity',
    summary:
      'Opus 4.8\'s dynamic workflows orchestrate tens to hundreds of parallel subagents from a JavaScript script Claude writes for you. Run `workflow` in your prompt, run `/effort ultracode`, or use the bundled `/deep-research`. Watch progress via `/workflows`. Caps: 16 concurrent agents, 1000 total per run.',
    highlights: [
      'Ask in the prompt: include the word **workflow** and Claude writes one for the task',
      'Auto-mode: run **`/effort ultracode`** in Claude to enable auto-orchestration for every task',
      'Bundled: **`/deep-research <question>`** is the headline preview workflow',
      'Watch with **`/workflows`** -- per-phase agent counts, token totals, drill-down per agent',
      'Save with **`s`** in the `/workflows` view -- becomes `/<name>` in future sessions',
    ],
    howToTrigger: [
      { label: 'One-off', value: "include 'workflow' in your prompt" },
      { label: 'Auto every task', value: 'run /effort ultracode in Claude' },
      { label: 'Disable globally', value: 'Settings → General → Security → Disable Claude Code dynamic workflows' },
    ],
    proTip:
      'Workflows can burn 1000-agent tokens fast. CCC\'s tokenomics still tracks the spend per session so you can see exactly what a run cost.',
    bullets: [
      '**Background orchestration** -- subagents run in parallel while your session stays free',
      '**/effort ultracode** in Claude enables it automatically for every task',
      '**/deep-research** is the bundled example; **/workflows** lists active runs',
      'CCC: **Disable Claude Code dynamic workflows** in Settings -> Security if you want it off',
    ],
    screenshotFilename: 'step-dynamic-workflows.jpg',
  },
  {
    id: 'github-sidebar',
    title: 'GitHub Sidebar',
    sinceVersion: '1.4.0',
    section: 'integrations',
    summary:
      'Side-by-side PR awareness right inside your terminal. The right rail surfaces your branch\'s PR status, CI runs, reviews, and unresolved threads — sign in once via OAuth, PAT, or adopt your existing gh CLI auth.',
    highlights: [
      'PR snapshot for your current branch — status, draft, mergeability',
      'CI runs feed — green / red / pending per workflow, last 5 visible',
      'Reviews + unresolved threads with click-through to GitHub',
      'Local git state — ahead/behind main, dirty/clean, staged/unstaged',
      'Session-context inference — issue # parsed from branch / transcript / PR body',
    ],
    howToTrigger: [
      { label: 'Sign in', value: 'Settings → GitHub → OAuth or PAT' },
      { label: 'Adopt gh CLI', value: 'Settings → GitHub → "Use existing gh auth"' },
      { label: 'Toggle', value: 'Per-session enable in Edit Config' },
    ],
    proTip:
      'OAuth is fastest if you already have GitHub in a browser — one click. PAT is the move for headless / CI machines where there\'s no browser to do the redirect dance.',
    bullets: [
      '**PR snapshot** for your current branch — status, CI runs, reviews, unresolved threads',
      '**Session context** infers the issue you are on from branch, transcript, or PR body',
      '**Local git state** — ahead/behind, dirty/clean, staged/unstaged — always visible',
      'Sign in via **OAuth**, PAT, or adopt your existing **gh CLI** auth. Per-session opt-in',
    ],
    screenshotFilename: 'github-panel.jpg',
  },
]

/** Returns the highest sinceVersion across all training steps */
export function currentTrainingVersion(): string {
  let max = '0.0.0'
  for (const step of trainingSteps) {
    if (compareVersions(step.sinceVersion, max) > 0) {
      max = step.sinceVersion
    }
  }
  return max
}

/** Returns steps added after the given version, or all if no version provided */
export function getNewSteps(lastVersion?: string): TrainingStep[] {
  if (!lastVersion) return trainingSteps
  return trainingSteps.filter(
    (step) => compareVersions(step.sinceVersion, lastVersion) > 0
  )
}

/** Compare two semver strings: returns >0 if a > b, <0 if a < b, 0 if equal */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
