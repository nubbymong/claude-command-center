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
      'Every workspace starts as a saved config -- label, colour, working directory, model, effort level, and any agents you want pre-loaded. v1.5.11 defaults new sessions to Opus 4.8 and adds the Extra high / Max effort levels plus a Fast mode toggle for 2.5x speed at 2x cost.',
    highlights: [
      'Model defaults to **Opus 4.8** (Anthropic`s newest, released 2026-05-28)',
      'Effort level pins thinking depth -- Low / Medium / High / Extra high / Max / Auto',
      '**Fast mode** toggle (Opus 4.8): 2.5x speed at 2x cost; tokenomics tracks Fast spend separately',
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
      'Create **terminal configs** with custom working directories and models',
      'Set **effort level** (Low/Medium/High) to control thinking depth and cost',
      '**Bundle agent templates** from your Library into the spawned session',
      'Connect to remote machines via **SSH** with full Claude support',
    ],
    screenshotFilename: 'step-session-options.jpg',
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
    title: 'Vision System',
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
      { label: 'Open', value: 'Click  👁  in the sidebar nav' },
      { label: 'Start', value: 'Vision page → Start' },
      { label: 'Launch browser', value: 'Vision page → Launch Chrome' },
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
    screenshotFilename: 'step-webview.jpg',
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
      'Track every dollar Claude costs you across every session. Tokenomics parses JSONL transcripts into daily aggregates, per-model breakdowns, burn rate, and rate-limit progress. v1.5.10 adds a group-by lens — pivot the same data between Project, Account, and Model.',
    highlights: [
      'Group by **Project / Account / Model** — same data, three lenses (v1.5.10)',
      'Daily cost chart — click any bar to filter the table to that day',
      '5-hour and 7-day rate-limit progress bars',
      'Burn rate (tokens/min) and anomaly alerts for unusual spend',
      'Extra-spend card when you have an Anthropic API key configured',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  $  in the sidebar nav' },
      { label: 'Group by', value: 'Header → Project / Account / Model' },
      { label: 'Reseed', value: 'Header → Reseed (rebuilds from transcripts)' },
    ],
    proTip:
      'Switch the group-by lens to Account when you want to see which login is burning the budget; Model is the right lens when you want to compare Opus vs Sonnet vs Haiku spend across the same projects.',
    bullets: [
      'Pivot between **Project / Account / Model** with one click (v1.5.10)',
      'Track **token usage and costs** across all your Claude Code sessions',
      'See **daily aggregates**, burn rate, and cost breakdown',
      'Monitor **rate limits** and extra spend from the Anthropic API',
    ],
    screenshotFilename: 'step-tokenomics.jpg',
  },
  {
    id: 'memory-visualiser',
    title: 'Memory Visualiser',
    sinceVersion: '1.2.152',
    section: 'admin',
    summary:
      'Browse Claude\'s auto-memory across every project. Project cards roll up size and recency; drill in for type groups (User / Feedback / Project / Reference) with full-text search across the whole library.',
    highlights: [
      'Project grid — one card per ~/.claude/projects/* with size + memory count',
      'Type groups colour-coded: User, Feedback, Project, Reference, Snapshot',
      'Full-text search across every memory file with highlighted matches',
      'Rendered markdown preview in the right detail pane',
      'Stale-warning banner flags MEMORY.md files over 200 lines (Claude\'s soft cap)',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  💡  in the sidebar nav' },
      { label: 'Search', value: 'Header → search input or  Ctrl+F' },
      { label: 'Delete', value: 'Right detail pane → Delete' },
    ],
    proTip:
      'Use the type groups as a feedback loop: if you have a lot of "Snapshot" memories piling up in a project, that\'s a sign auto-memory is grabbing things you don\'t need — prune them in bulk from the project view.',
    bullets: [
      'Browse Claude Code **auto-memory** files across all your projects',
      'Click the **brain icon** in the sidebar to explore memory',
      'Drill down: **project cards** > **type groups** > individual memories',
      '**Search** across all memories, view rendered markdown, delete stale entries',
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
      'v1.5.10 adds a Permission Attention Tray — high-risk Bash commands (rm -rf, dd, force-push, etc.) now stack as toasts top-right so you can approve or reject without scrolling back through the terminal.',
    bullets: [
      '**Permission Attention Tray** stacks high-risk prompts as toasts (v1.5.10)',
      '**Sandbox enabled** — renderer runs in a sandboxed process',
      'Choose **Stable or Beta** update channel for app updates',
      'Customize **keyboard shortcuts**, terminal font size, and status line metrics',
    ],
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
    id: 'permission-tray',
    title: 'Permission Attention Tray',
    sinceVersion: '1.5.12',
    section: 'admin',
    summary:
      'High-risk Bash commands -- rm -rf, sudo, force-push, dd, mkfs, chmod 777, fork bombs -- stack as toasts in the top-right corner. Approve or reject without scrolling back through the terminal. Everything else auto-allows so the tray only fires when it should.',
    highlights: [
      'Toast stack tops out at 50 entries; overflow auto-denies',
      'Detection runs on Claude Code\'s PreToolUse hook -- the gateway intercepts before Claude executes',
      'Auto-allow path handles non-Bash tools (Read, Edit, Grep, Write) silently',
      'High-risk patterns: rm -rf / rm -fr, sudo, dd if=, chmod 777, --force / --force-with-lease, fork bombs',
      'Toast survives session focus changes -- you can approve from any view',
    ],
    howToTrigger: [
      { label: 'Spawn a Claude session', value: 'Saved Configs → +' },
      { label: 'Trigger', value: 'Ask Claude to delete files, force-push, sudo, etc.' },
      { label: 'Approve / reject', value: 'Top-right toast → click or keyboard' },
    ],
    proTip:
      'The tray catches commands that come from dynamic-workflow subagents too -- if a 1000-agent run tries to rm -rf something, the high-risk detection still gates it.',
    bullets: [
      '**Toast stack** for high-risk Bash; everything else auto-allows',
      'Hooks into **PreToolUse** so it fires before Claude actually runs the command',
      'Patterns: **rm -rf, sudo, force-push, dd, mkfs, chmod 777, fork bombs**',
      'Overflow (>50) auto-denies so a runaway agent can\'t bury you in prompts',
    ],
    screenshotFilename: 'step-permission-tray.jpg',
  },
  {
    id: 'dynamic-workflows',
    title: 'Dynamic Workflows',
    sinceVersion: '1.5.12',
    section: 'productivity',
    summary:
      'Opus 4.8\'s dynamic workflows orchestrate tens to hundreds of parallel subagents from a JavaScript script Claude writes for you. Run `workflow` in your prompt, set effort to `ultracode`, or use the bundled `/deep-research`. Watch progress via `/workflows`. Caps: 16 concurrent agents, 1000 total per run.',
    highlights: [
      'Ask in the prompt: include the word **workflow** and Claude writes one for the task',
      'Auto-mode: **Ultracode** effort in Session Config + `/effort ultracode` enables auto-orchestration',
      'Bundled: **`/deep-research <question>`** is the headline preview workflow',
      'Watch with **`/workflows`** -- per-phase agent counts, token totals, drill-down per agent',
      'Save with **`s`** in the `/workflows` view -- becomes `/<name>` in future sessions',
    ],
    howToTrigger: [
      { label: 'One-off', value: "include 'workflow' in your prompt" },
      { label: 'Auto every task', value: 'Session Config → Effort → Ultracode' },
      { label: 'Disable globally', value: 'Settings → General → Security → Disable Claude Code dynamic workflows' },
    ],
    proTip:
      'Workflows can burn 1000-agent tokens fast. CCC\'s tokenomics still tracks the spend per session and the permission tray still catches any high-risk Bash a subagent tries.',
    bullets: [
      '**Background orchestration** -- subagents run in parallel while your session stays free',
      '**Ultracode** in the effort dropdown enables it automatically for every task',
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
    screenshotFilename: 'step-github-sidebar.jpg',
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
