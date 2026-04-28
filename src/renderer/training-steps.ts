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
    sinceVersion: '1.0.0',
    section: 'getting-started',
    summary:
      'Every workspace starts as a saved config — label, colour, working directory, model, effort level, and any agents you want pre-loaded. SSH configs add host + auth and launch Claude on the remote machine the same way local sessions do.',
    highlights: [
      'Local or SSH — one config form, full Claude support either way',
      'Effort level pins thinking depth (Low / Medium / High / Auto)',
      'Model override (Sonnet / Opus / Haiku) when you need to pin a specific tier',
      'Per-session toggles: flicker-free rendering, PowerShell tool, Disable auto-memory',
      'Bundle built-in agents (code-reviewer, test-runner) into the session at spawn',
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
      'Enable **flicker-free rendering** and platform-specific tools per session',
      'Connect to remote machines via **SSH** with full Claude support',
    ],
    screenshotFilename: 'step-session-options.jpg',
  },
  {
    id: 'agent-hub',
    title: 'Agent Hub',
    sinceVersion: '1.0.0',
    section: 'integrations',
    summary:
      'Dispatch headless Claude as a background task. Single agents run one prompt to completion; Teams chain multiple agents with explicit dependencies, all monitored from one dashboard with live status, output streaming, and retry.',
    highlights: [
      'Tasks tab — one-off agent dispatch with prompt, working dir, and model',
      'Teams tab — chain agents (a → b → c) with shared context and per-step prompts',
      'Library tab — pre-built agent templates ready to drop into any config',
      'Live status pills, output streaming, retry on failure',
      'Right-click a task for actions: cancel, retry, remove, copy output',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  ☁  in the sidebar nav' },
      { label: 'New', value: 'Header → + New agent' },
      { label: 'Library', value: 'Left rail → Library' },
    ],
    proTip:
      'Build a Team for your release workflow: lint → test → build → notify. Each step gets the previous step\'s output as context, so failures surface where they happened.',
    bullets: [
      '**Cloud agents** run headless Claude sessions in the background',
      'Browse and install agents from the **agent library**',
      '**Agent Teams** orchestrate multi-agent pipelines with dependencies',
      'Monitor all running agents from a single dashboard',
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
      '17 vision tools exposed to Claude: screenshot, navigate, click, type, eval, and more',
      'One global Chrome — all sessions share state, so cookies + login persist',
      'Reverse tunnel auto-injected on SSH connect (-R 19333) — remote sessions reach the local browser',
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
    id: 'tokenomics',
    title: 'Tokenomics',
    sinceVersion: '1.2.144',
    section: 'admin',
    summary:
      'Track every dollar Claude costs you across every session. Tokenomics parses JSONL transcripts into daily aggregates, per-model breakdowns, burn rate, and rate-limit progress.',
    highlights: [
      'Daily cost chart — click any bar to filter the table to that day',
      'Per-model breakdown for Sonnet, Opus, Haiku',
      '5-hour and 7-day rate-limit progress bars with peak / off-peak label',
      'Burn rate (tokens/min) and anomaly alerts for unusual spend',
      'Extra-spend card when you have an Anthropic API key configured',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  $  in the sidebar nav' },
      { label: 'Reseed', value: 'Header → Reseed (rebuilds from transcripts)' },
      { label: 'Sync', value: 'Header → Sync now (latest only)' },
    ],
    proTip:
      'Click a chart bar to scope the session table to that single day, then drill into individual sessions to see exactly what burned the budget.',
    bullets: [
      'Track **token usage and costs** across all your Claude Code sessions',
      'Parses JSONL transcript files for **historical usage data**',
      'See **daily aggregates**, burn rate, and cost breakdown **by model**',
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
      'Beta channel ships every couple of days; stable is gated on a few days of beta soak. If you want fixes faster, flip to Beta — auto-update will track from there.',
    bullets: [
      '**Sandbox enabled** — renderer runs in a sandboxed process',
      'Choose **Stable or Beta** update channel for app updates',
      'Customize **keyboard shortcuts**, terminal font size, and status line metrics',
      'All IPC calls are **validated with zod** schemas at the boundary',
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
      'Status bar — live tokens, cost, rate limits, peak/off-peak indicator',
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
      'Live **statusline** shows tokens, cost, rate limits, and peak hours',
    ],
    screenshotFilename: 'step-tips.jpg',
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
