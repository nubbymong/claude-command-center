/** Logical group used in the hero breadcrumb. Keep small -- one of these. */
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
  /** Optional callout shown below "How to open" -- pull-quote style. */
  proTip?: string
}

export const trainingSteps: TrainingStep[] = [
  {
    id: 'session-options',
    title: 'Session Configuration',
    // Re-versioned for the 2.1 dialog rebuild: currentTrainingVersion() is the
    // MAX sinceVersion across steps, and getNewSteps() returns only steps newer
    // than the version the user last saw. With every step pinned at <= 2.0.0,
    // nobody already on 2.x was ever shown the rebuilt dialog.
    sinceVersion: '2.1.0',
    section: 'getting-started',
    summary:
      'Every workspace starts as a saved config. First choose what it runs -- Claude Code, Codex, or Terminal only -- then whether it runs locally or over SSH; the rest of the form unfolds from those two answers. A config carries its label, colour, working directory, starting model and starting effort, plus a permission mode and any extra CLI arguments.',
    highlights: [
      'Pick a **starting model** per config; the dropdown lists what is currently available, newest first',
      '**Starting effort** is a config field (low, medium, high, xhigh, max, ultracode); change it live in Claude with `/effort`. The card shows the current level',
      'Local or SSH -- one config form, full Claude support either way',
    ],
    howToTrigger: [
      { label: 'Create', value: 'Saved tab → + New → Config' },
      { label: 'Edit', value: 'Hover a config → pencil icon' },
      { label: 'Pin', value: 'Right-click a config → Pin to Quick Start' },
    ],
    proTip:
      'Drag a folder onto the sidebar to create a working-directory config in one drop -- fastest way to bootstrap a new project session.',
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
      'Add an account by running **`/login`** in a session: The app detects the new login and offers to save it as a separate named account',
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
    // Shipped in 2.0 as "Ask Command Center" and renamed to "Ask Conductor",
    // but it never had a card of its own -- FinishStep promises the Feature
    // Guide "explains every feature", and the help surface itself was the one
    // missing from it (#372).
    //
    // 2.1.1, deliberately ABOVE the 2.1.0 cards, and the reason is the whole
    // point of the entry. getNewSteps() keeps steps with sinceVersion >
    // lastVersion, and TrainingWalkthrough stamps lastTrainingVersion =
    // currentTrainingVersion() on close, so every beta user who has already run
    // the 2.1 tour holds '2.1.0'. At 2.1.0 this card is filtered OUT for them
    // and shouldShowTraining() returns false: the one cohort that already has
    // the feature and does not know what it does would never be shown it --
    // which is the discovery gap #372 was filed about. At 2.1.1 they are shown
    // exactly this one card; the other 2.1.0 cards are not > 2.1.0, so nothing
    // else is re-surfaced. Same move, same reason, as the session-options
    // re-version above. Users arriving from 2.0.x get the card either way.
    // The badge is unaffected -- FeatureGuidePage's shortVersion() renders both
    // 2.1.0 and 2.1.1 as "since 2.1".
    id: 'ask-conductor',
    title: 'Ask Conductor',
    sinceVersion: '2.1.1',
    section: 'getting-started',
    summary:
      'Ask Conductor is the help session: a real Claude session that has already read this app\'s documentation, so you can ask how something works in plain English instead of hunting through Settings. It answers questions about the Conductor and about Claude Code itself, and tells you which of the two it is answering.',
    highlights: [
      'Ask in **plain English** -- "how do I run two accounts?" beats hunting through Settings',
      'Covers **both** the Conductor and **Claude Code** itself, and says which one it is answering',
      'Type your question into the Feature Guide first and the session opens with it **already asked**',
      'Gets its **own tab** and behaves like any other session -- leave it open and come back to it',
      'Use **Past discussions** in its header to reopen an earlier conversation',
      'It reads the **documentation, not your data** -- it cannot see your code, and will say so',
    ],
    howToTrigger: [
      { label: 'Sidebar', value: 'Ask Conductor pill at the bottom of the sidebar' },
      { label: 'Feature Guide', value: '? button → Ask the Conductor box' },
      { label: 'From a tip', value: 'Discuss on any tip' },
    ],
    proTip:
      'It runs in its own documentation folder rather than your project, which is exactly why it cannot see your repository. For a question about your own code, ask in that project\'s session instead. It is not a saved config and never appears in your Saved Configs list.',
    bullets: [
      'A **Claude session primed with this app\'s docs** -- ask about the Conductor in plain English',
      'Also answers **Claude Code** questions, and tells you which of the two it is answering',
      'Open it from the **sidebar pill**, the **Feature Guide** Ask box, or **Discuss** on any tip',
      'Reads the **documentation only** -- not your code',
    ],
    // No dedicated capture of the Ask pill or the help session exists yet; the
    // shell shot shows the sidebar it launches from and the ? button that opens
    // this guide. (Future capture: step-ask-conductor.jpg.)
    screenshotFilename: 'v2-shell-hero.jpg',
  },
  {
    id: 'codex-provider',
    title: 'Codex Provider',
    sinceVersion: '1.5.0',
    section: 'integrations',
    summary:
      "OpenAI's Codex CLI sits alongside Claude in the New Session dialog -- pick the provider per session. gpt-5 series models, runtime permissions presets, the resume picker, and tokenomics segmenting all wired in.",
    highlights: [
      'Provider is chosen on the saved config -- Claude Code, Codex, or Terminal only (Codex is local-only; it cannot run over SSH)',
      'Six gpt-5 models in the dropdown: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.2',
      'Permission presets, model and reasoning effort are set on the Codex config (the session toolbar cluster is Claude-only)',
      'Resume picker mirrors the Claude flow -- recent rollouts surfaced before spawn',
      '**Tokenomics** segments Codex spend automatically alongside Claude, per-day and per-model',
    ],
    howToTrigger: [
      { label: 'Spawn', value: '+ New -> Config -> provider card -> Codex' },
      { label: 'Auth', value: 'Settings -> Codex -> Login' },
      { label: 'Model', value: 'Edit the Codex config -> model' },
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
    id: 'vision',
    title: 'Conductor MCP',
    sinceVersion: '1.2.144',
    section: 'integrations',
    summary:
      'Browser automation via a global MCP server -- every Claude session shares one Chrome instance. Take screenshots, navigate, click, type, and inspect pages without leaving the terminal. Works over SSH too via automatic reverse tunnels.',
    highlights: [
      '18 browser-vision tools (one of four sub-tools on the Conductor MCP server) exposed to Claude',
      'One global Chrome -- all sessions share state, so cookies + login persist',
      'Reverse tunnel auto-injected on SSH connect (-R <port>) -- remote sessions reach the local Conductor MCP server',
      'A dot on the Conductor MCP nav icon shows MCP server health: green = running, red = stopped',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  Conductor MCP  in the sidebar nav' },
      { label: 'Open', value: 'Sidebar → Conductor MCP' },
      { label: 'Browser', value: 'Vision card → Start browser' },
    ],
    proTip:
      'Ask Claude "open the dev server in the browser and click around to verify the layout" -- it\'ll drive vision tools to do exactly that and report back.',
    bullets: [
      '**Browser automation** via a global MCP server -- all sessions share one browser',
      'Click **Conductor MCP** in the sidebar nav to see the tool server and its browser',
      '17 vision tools available to Claude: **screenshot, navigate, click, type** and more',
      'Works over **SSH** too -- reverse tunnels connect remote sessions automatically',
    ],
    screenshotFilename: 'step-vision.jpg',
  },
  {
    id: 'agent-canvas',
    title: 'Agent Canvas',
    sinceVersion: '2.1.0',
    section: 'integrations',
    summary:
      'A review surface for anything visual the agent makes. Ask for a mockup, a plan, or the app you are building; it renders a real page into the session pane. You mark up what is wrong -- notes pinned to elements, freehand sketch over the top -- and send the whole review back for the next version. Distinct from the Excalidraw Sketchpad, which is your own freehand pad.',
    highlights: [
      'The agent renders with **canvas_render** -- every call is a new version, nothing is overwritten',
      '**canvas_snapshot** reads the laid-out page back: names, boxes, form state, and measured problems (clipped text, targets below the minimum size, weak contrast)',
      'Annotate on the glass over the page -- pin a note to an element, box a region, or sketch freehand',
      'Submit drops a one-line marker in the chat; the agent fetches your notes and sketches with **canvas_review**',
      'Per session and local: design renders come from an HTML file the agent writes, and app builds are served only from folders you have opened sessions in',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Session toolbar → Canvas' },
      { label: 'First render', value: 'Canvas landing → Put this in the terminal' },
      { label: 'Send a review', value: 'Notes panel → Submit' },
    ],
    proTip:
      'Ask for the round trip explicitly -- "render it and I will mark it up". Pointing at the pixel that is wrong costs you one sentence and saves the agent a guess.',
    bullets: [
      '**A real page**, laid out by the browser engine in the session pane',
      '**Mark it up**: element notes, region boxes, freehand sketch',
      'One **Submit** hands every note back through canvas_review',
      '**Versioned** -- each render is kept, so you can compare what changed',
    ],
    // No dedicated capture yet; the Vision shot is the nearest surface (a real
    // page under the agent's eye). Future capture: step-agent-canvas.jpg.
    screenshotFilename: 'step-vision.jpg',
  },
  {
    // The Canvas Explained page (2.1 canvas rework, M4): a full-page explainer
    // of the review model, opened from the card on the canvas front page. It
    // exists because the model has real depth users kept missing -- versions,
    // what a note stores, evidence records -- and the front-page card is only
    // discoverable once you are already on the canvas, so this guide card
    // EMBEDS the page itself (View Canvas Explained) as a route that works
    // with zero sessions open.
    id: 'canvas-explained',
    title: 'Canvas Explained',
    sinceVersion: '2.1.0-rc.10',
    section: 'integrations',
    summary:
      'A one-page explainer built into the Agent Canvas: how an artefact moves through versions, what a review stores (the element you anchored to, your drawings, pasted images, and your words, all kept on the version they were made against), and what a Testing note locks together as evidence.',
    highlights: [
      'The **artefact** model in one diagram -- versions increment, and each review with its objects is stored on its version',
      'Rejecting a version **never loses your notes** -- the agent reads them to build the next one, and History keeps the trail',
      'The **Mockup, Plan, and Testing** loops drawn end to end, including the evidence record one saved Testing note stores',
      'Plain terms where they apply: a note reads **resolved** once the agent has acted on it; a review reads **settled** once every note is closed',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Agent Canvas front page → Canvas Explained card' },
      // Second route on purpose: the front-page card lives inside an open
      // session's canvas pane; the guide one needs no session at all.
      { label: 'Guide', value: 'Feature Guide → this card → View Canvas Explained' },
      { label: 'Back', value: '‹ Home in the page header' },
    ],
    proTip:
      'Skim it once before your first review. Knowing that every note is stored on its version -- and that rejecting never loses them -- changes how freely you annotate.',
    bullets: [
      'One page that explains the **whole canvas review model**',
      'Versions, reviews, and **what each note stores**, drawn as diagrams',
      'Open it from the **Canvas Explained** card on the canvas front page, or right here via **View Canvas Explained**',
    ],
    // No dedicated capture yet; the Vision shot is the nearest canvas surface,
    // the same stand-in the Agent Canvas card uses. (Future capture:
    // step-canvas-explained.jpg.)
    screenshotFilename: 'step-vision.jpg',
  },
  {
    id: 'webview',
    title: 'Webview Pane',
    sinceVersion: '1.4.0',
    section: 'productivity',
    summary:
      'A browser of your own, right next to your terminal. Every session has a Browser button: type an address, keep favourites, set a home page, or let a command open a dev server, dashboard or docs for you -- and freezing the pane drops you straight into Excalidraw to annotate over what you are seeing.',
    highlights: [
      'Pinned to the same session -- pane state survives tab switches',
      'Address bar, back/forward, favourites, a home page per config, and open-in-your-real-browser',
      'A command can "watch for a page" or simply "open a page" -- the one button that types nothing',
      'Status pulse: green when reachable, red when the URL fails to load',
      'Freeze + Excalidraw -- capture a frame and draw over it without leaving the session',
      'Esc closes the pane back to terminal-only view',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Session toolbar → Web (visible when a webview command exists)' },
      { label: 'Pin URL', value: 'Custom command → enable webview + URL field' },
      { label: 'Freeze', value: 'Web pane header → Freeze (opens Excalidraw on the snapshot)' },
    ],
    proTip:
      'Wire your dev server URL into a custom command -- every session for that config gets a one-click in-app preview without ever leaving the keyboard.',
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
    // "Sketchpad", not "Canvas": the Agent Canvas is a different feature that
    // shares the toolbar button. The v8 canvas front page dropped its "Open
    // the sketchpad instead" button, so the pad currently has NO front-page
    // entry -- a session already showing it keeps it (the store value
    // survives; see CanvasEmptyView). The trigger copy below states that
    // plainly instead of pointing at the removed door; restoring a real route
    // is an owner-flagged follow-up, and this copy changes with it.
    title: 'Excalidraw Sketchpad',
    sinceVersion: '1.4.0',
    section: 'productivity',
    summary:
      'A per-session whiteboard for diagramming, planning, or sketching ideas before you describe them to Claude. Drawings persist with the session and pair cleanly with Freeze for annotating screenshots. It is your own pad -- the Agent Canvas next door is where the agent renders pages for you to review.',
    highlights: [
      'Per-session sketchpad -- switching sessions swaps the drawing in place',
      'Full Excalidraw toolset: shapes, arrows, text, freehand, libraries',
      'Drawings auto-save to the session config -- closing and reopening the app restores them',
      'Freeze the browser pane to import a snapshot and draw straight over it',
      'Replaces the terminal in place -- no fullscreen modal eating the toolbar',
    ],
    howToTrigger: [
      { label: 'Open', value: 'No front-page entry right now -- the canvas front page is the agent’s review surface; a session already on the sketchpad keeps it' },
      { label: 'Switch back', value: 'Agent Canvas (bottom-right), or Canvas again to close the pane' },
      { label: 'New drawing', value: 'Left rail → + (rename with ✎, delete with ×)' },
    ],
    proTip:
      'Sketch the architecture of what you want to build, hit Copy in the sketchpad toolbar, and paste the image straight into the prompt -- Claude reads the drawing directly. (Sketching ON an agent-rendered page is the Agent Canvas: those sketches travel back with canvas_review.)',
    bullets: [
      '**Per-session whiteboard** for diagrams, planning, or quick sketches',
      'Drawings **persist** with the session config across restarts',
      'Pair with **Freeze** to annotate webview snapshots',
      'Replaces the terminal in place -- toggle off to return',
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
      'Every session has a partner terminal — no setup, any config type',
      'Opens in the working directory locally, at home over SSH',
      'Quick command buttons can target Claude or partner explicitly',
      'Resize the split bar to favour whichever pane is active',
    ],
    howToTrigger: [
      { label: 'Toggle', value: 'Partner button in the command bar' },
      { label: 'Quick commands', value: 'Custom command → Target = Partner' },
      { label: 'Resize', value: 'Drag the vertical bar between panes' },
    ],
    proTip:
      'Keep a test watcher or dev server running in the partner pane for quick sanity checks while Claude does the heavy lifting in the other pane.',
    bullets: [
      '**Side-by-side** Claude + regular shell in the same session',
      'Always available — **no per-config setup**',
      '**Quick commands** can target either pane (Claude or Partner)',
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
      'Window capture mode -- pick from a thumbnail list of any open window',
      'JPEG-encoded at 1920px max long edge to stay under Claude\'s image budget',
      'Saved to the session resources screenshots/ folder so you can drag-drop later too',
      'Esc cancels at any point -- no stuck overlays',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Session toolbar → Snap' },
      { label: 'Region', value: 'Click Snap → drag a rectangle on screen' },
      { label: 'Window', value: 'Click Snap → Window → pick from list' },
    ],
    proTip:
      'Snap a UI bug, then ask Claude to look at the screenshot you just snapped -- it ingests the image directly and you skip the upload-and-describe roundtrip.',
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
      '**Filters** -- config, date range (7d / 30d / all), and a free-text search over model and project',
      'Pricing from BerriAI`s LiteLLM (cached 24h); a green nav badge shows when the index is fresh',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  $  in the sidebar nav' },
      { label: 'Filter', value: 'Header → date / model / account / project' },
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
      '**Reading drawer** to read a memory, write missing frontmatter, or delete it; search covers memory names, projects and descriptions',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click the Memory icon in the sidebar nav' },
      { label: 'Search', value: 'Header → search input' },
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
      'A digest of how Claude is actually performing across your sessions -- what is working, what is friction, and where you spend tokens disproportionately. Generated by analysing your transcripts on demand. v1.5.10 drops the iframe and renders the report natively, so it loads faster and follows your theme.',
    highlights: [
      'Native render -- no iframe, no theme flicker, faster paint (v1.5.10)',
      'Big wins, friction points, and key insight callouts surfaced from real sessions',
      'Per-project area breakdown -- which folders take the most time and cost',
      'KPI sidebar with trend deltas vs your previous report (per account)',
      'Distinct from Tokenomics: qualitative ("what" / "why"), not quantitative',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  ✨  in the sidebar nav' },
      { label: 'Generate', value: 'Insights header → New run' },
      { label: 'History', value: 'Switch between past reports from the header dropdown' },
    ],
    proTip:
      'Run an Insights report after a long working week -- the friction list often surfaces patterns (unclear instructions, retries, dead-ends) you can fix with one tweak to your CLAUDE.md.',
    bullets: [
      '**Qualitative analysis** of how Claude is performing in your sessions',
      'Surfaces **big wins**, **friction points**, and per-area breakdowns',
      'A **KPI sidebar** with trend deltas vs your previous report',
      'Distinct from Tokenomics -- focused on patterns, not raw cost',
    ],
    screenshotFilename: 'step-insights.jpg',
  },
  {
    id: 'logs',
    title: 'Logs',
    sinceVersion: '1.5.30',
    section: 'admin',
    summary:
      "Logs is a chat-transcript viewer. The Conductor indexes Claude's own conversation transcripts (which live in ~/.claude/projects) and renders them back as a readable chat -- messages, tool calls, and thinking -- with a timeline rail for fast scrubbing and full-text search across everything.",
    highlights: [
      'Browse conversations as a chat, grouped by config (filter by account)',
      'A timeline rail beside the transcript scrubs the whole conversation; click to jump',
      'Full-text search across all conversations; click a hit to open it at that turn',
      'Per-session Conversation tab that live-follows the running session',
      "Deleting an index never touches your conversations -- those stay in ~/.claude/projects",
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click the Logs icon in the sidebar nav' },
      { label: 'Search', value: 'Header search box (full-text across all conversations)' },
      { label: 'Per-session', value: 'Click Logs in the session command bar' },
    ],
    proTip:
      "Reading back a long session? Use the timeline rail to jump straight to a tool call or a clear divider -- and search jumps you to the exact turn without scrolling.",
    bullets: [
      "**Chat-transcript viewer** -- Claude's own transcripts, rendered as readable chat",
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
      'General -- default working dir, machine name, update channel, security toggles',
      'Status Line -- toggle each element of the in-terminal status bar + font + size',
      'Shortcuts -- rebind every keyboard shortcut',
      'GitHub -- sign in (OAuth / PAT / gh CLI) and configure per-session integration',
      'About -- version, build time, replay training, view What\'s New',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click  ⚙  in the sidebar nav' },
      { label: 'Replay tour', value: 'About → Replay Training' },
      { label: 'What\'s new', value: 'About → View full changelog' },
    ],
    proTip:
      'Settings is also where you pick Stable or Beta updates, rebind every shortcut, choose which statusline metrics show, and toggle local log indexing -- all without leaving the app.',
    bullets: [
      '**Disable dynamic workflows** globally, or skip permission prompts for headless agents',
      '**Sandbox enabled** -- renderer runs in a sandboxed process',
      'Choose **Stable or Beta** update channel for app updates',
      'Customize **keyboard shortcuts**, terminal font size, and status line metrics',
    ],
    screenshotFilename: 'step-security.jpg',
  },
  {
    id: 'sentinel',
    title: 'Sentinel',
    sinceVersion: '1.5.37',
    section: 'admin',
    summary:
      'An opt-in watcher that notices when Claude Code updates and checks whether the new version might affect the app. It surfaces findings in a labelled "Sentinel" chip and a panel, proposes registry fixes you apply yourself, and never changes anything automatically.',
    highlights: [
      'Runs on startup when Claude Code\'s version changes; **fail-open** so it never blocks the app',
      'Checks the CC changelog against the app\'s compatibility assumptions',
      'Proposes **model and effort registry** fixes you **Apply** (or Dismiss) -- never automatic',
      'A hot-reloadable registry means unknown or brand-new models still get a colour, label, and pricing',
      'Opt-in -- turn it on or off in **Settings → General → Sentinel**',
    ],
    howToTrigger: [
      { label: 'Open', value: 'Click the Sentinel chip in the title bar' },
      { label: 'Enable', value: 'Settings → Sentinel → Enable' },
      { label: 'Apply a fix', value: 'Sentinel panel → Apply on a proposal' },
    ],
    proTip:
      'When a finding offers an Apply button it is a safe registry change you can take in one click; everything else is a compatibility report so you know what to watch after a Claude Code update.',
    bullets: [
      'Opt-in watcher that flags when a **Claude Code update** might affect the app',
      'Findings show in a labelled **Sentinel chip** and a panel',
      'Proposes **registry fixes you apply yourself** -- nothing changes automatically',
      'Toggle it in **Settings → Sentinel**',
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
      'Power moves you\'ll start using on day two. A tip pill in the session header pulses contextual tips as you discover features, so most of these surface naturally as you work.',
    highlights: [
      'Ctrl+Tab / Ctrl+Shift+Tab -- cycle between sessions',
      'Ctrl+1–9 -- jump directly to session N',
      'Alt+V -- paste image-from-clipboard as a file path into Claude\'s prompt',
      'Esc -- close browser pane / dismiss tour / cancel context menu',
      'Status bar -- live tokens, cost, rate limits',
    ],
    howToTrigger: [
      { label: 'Rebind', value: 'Settings → Shortcuts' },
      { label: 'Tip pulse', value: 'Session header → 💡' },
    ],
    proTip:
      'Hover the bottom-toolbar lightbulb to see the catalogue of tips you haven\'t triggered yet -- useful for finding features you didn\'t know existed.',
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
      'Workflows can burn 1000-agent tokens fast. The Conductor\'s tokenomics still tracks the spend per session so you can see exactly what a run cost.',
    bullets: [
      '**Background orchestration** -- subagents run in parallel while your session stays free',
      '**/effort ultracode** in Claude enables it automatically for every task',
      '**/deep-research** is the bundled example; **/workflows** lists active runs',
      'Conductor: **Disable Claude Code dynamic workflows** in Settings -> Security if you want it off',
    ],
    screenshotFilename: 'step-dynamic-workflows.jpg',
  },
  {
    id: 'ai-usage-meter',
    title: 'AI Usage Meter',
    sinceVersion: '2.0.0',
    section: 'integrations',
    summary:
      'A unified usage meter for your AI spend. A compact chip on the session status strip shows GitHub Copilot AI-credit usage at a glance; click it for a popover that breaks down GitHub usage per model and shows the Claude and Codex rate-limit windows side by side. It turns a warning colour the moment GitHub bills you past your included credits.',
    highlights: [
      'A compact chip in the **repo strip** shows credits used (and your cap, when set) without opening anything',
      'When GitHub bills past your included credits the chip shifts to a **warning** and shows the billed amount (for example +$11.69)',
      'Click the chip for a **popover** with per-model GitHub rows, covered and billed totals, plus Claude and Codex 5h / 7d windows',
      'Read-only and best-effort -- it never changes anything, and it fails quietly when a token lacks billing scope',
      'Set your **included-credit cap** in Settings, Status Line so the chip can show a used-of-cap ratio',
    ],
    howToTrigger: [
      { label: 'Enable', value: 'Settings -> GitHub -> AI usage meter' },
      { label: 'Open the breakdown', value: 'Click the AI chip in the repo strip' },
      { label: 'Set the cap', value: 'Settings -> GitHub -> Included-credit cap' },
    ],
    proTip:
      'The billed number is the headline signal. As long as the chip stays neutral you are inside your plan; the moment it goes amber with a +$ amount, GitHub is charging you past your included AI credits.',
    bullets: [
      'Compact **AI-usage chip** in the repo strip -- credits used, and your cap when set',
      'Goes to a **warning** with the billed amount once GitHub bills past your included credits',
      'Click for a popover: **per-model GitHub rows** plus **Claude and Codex** 5h / 7d windows',
      'Enable it and set your cap in **Settings, GitHub**; it is read-only and best-effort',
    ],
    // No dedicated AI-usage capture exists yet; the GitHub panel shot stands in
    // until the meter is captured. (Future capture: step-ai-usage.jpg / the
    // repo-strip chip + the unified usage popover.)
    screenshotFilename: 'github-panel.jpg',
  },
  {
    id: 'github-sidebar',
    title: 'GitHub Sidebar',
    sinceVersion: '1.4.0',
    section: 'integrations',
    summary:
      'Side-by-side PR awareness right inside your terminal. The right rail surfaces your branch\'s PR status, CI runs, reviews, and unresolved threads -- sign in once via OAuth, PAT, or adopt your existing gh CLI auth.',
    highlights: [
      'PR snapshot for your current branch -- status, draft, mergeability',
      'CI runs feed -- green / red / pending per workflow, last 5 visible',
      'Reviews + unresolved threads with click-through to GitHub',
      'Local git state -- ahead/behind main, dirty/clean, staged/unstaged',
      'Session-context inference -- issue # parsed from branch / transcript / PR body',
    ],
    howToTrigger: [
      { label: 'Sign in', value: 'Settings → GitHub → OAuth or PAT' },
      { label: 'Adopt gh CLI', value: 'Settings → GitHub → "Use existing gh auth"' },
      { label: 'Toggle', value: 'GitHub button on the session → Configure GitHub for this session' },
    ],
    proTip:
      'OAuth is fastest if you already have GitHub in a browser -- one click. PAT is the move for headless / CI machines where there\'s no browser to do the redirect dance.',
    bullets: [
      '**PR snapshot** for your current branch -- status, CI runs, reviews, unresolved threads',
      '**Session context** infers the issue you are on from branch, transcript, or PR body',
      '**Local git state** -- ahead/behind, dirty/clean, staged/unstaged -- always visible',
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
