/**
 * Curated, user-facing knowledge about AI Code Conductor.
 *
 * SINGLE SOURCE for two surfaces:
 *  - the in-app searchable Help panel (renderer renders the sections), and
 *  - the "Ask Conductor" session: main stages this as app-knowledge.md
 *    (plus a CLAUDE.md preamble) in a help workspace folder, and the ask
 *    session launches there so Claude reads it automatically.
 *
 * RULES for this file: user documentation ONLY. No internal paths, no build
 * secrets, no architecture internals, no em dashes (public-facing doc).
 */

export interface AppKnowledgeSection {
  id: string
  title: string
  body: string
}

export const APP_KNOWLEDGE_SECTIONS: AppKnowledgeSection[] = [
  {
    id: 'overview',
    title: 'What is AI Code Conductor?',
    body: `AI Code Conductor (formerly Claude Command Center) runs the Claude Code you already have, side by side: multiple sessions in one window, with saved configs, live usage in a status line, cost tracking, searchable history, and optional GitHub and Codex integrations. It sits on top of Claude Code; it never replaces it, and Claude Code outside the Conductor keeps working exactly as before. It is an independent community project.`,
  },
  {
    id: 'sessions',
    title: 'Sessions and saved configs',
    body: `Every session starts from a saved config. First pick what it runs: Claude Code, Codex, or Terminal only (a plain terminal with no AI). Then pick where it runs: on this PC or over SSH (Codex is local-only). A config carries a name, working directory, starting model and starting effort, a permission mode, and any extra CLI arguments. The working directory is required for Claude Code and Codex; for Terminal only it is optional, and leaving it blank starts the session in your home folder. Create a config with the + button in the sidebar or Ctrl+T; click it to launch. Sessions arrange themselves in a grid; use Ctrl+Tab to switch. Every session also gets a partner terminal from the command bar, with no setup. A running session can be given its own work name, separate from the config it came from.`,
  },
  {
    id: 'accounts',
    title: 'Multiple Claude accounts',
    body: `On Windows and Linux you can run each local session under a different Claude account. Logins never mix between accounts, while memory, projects, and history are shared, so switching never loses your place. Your existing login becomes the primary account and is backed up once before anything is set up. Accounts apply to local sessions only: SSH sessions use the remote machine's own login, and Codex uses its own OpenAI login. Add or switch accounts in Settings, in the New Session picker, or from the status strip's account pill. On macOS this is not available yet, because Claude Code keeps its sign-in in the login Keychain, which cannot be isolated per account.`,
  },
  {
    id: 'settings-scope',
    title: 'Which settings apply where',
    body: `Claude Code reads its settings from several files at once, and the one nearest your project wins. Strongest first: settings your organisation manages, then flags on the command line, then the project-local file (.claude/settings.local.json in the project folder, which is yours alone), then the shared project file (.claude/settings.json, which is committed and applies to everyone working on that repo), then your personal file in the .claude folder in your home directory. This is why a setting you change can look like it did nothing: something stronger further up that list is still setting it. Claude Code's own /config menu writes to the project-local file, so a change made there applies to that project only, not everywhere. Settings are also read when a session starts, so a change reaches only the sessions you launch afterwards, never one already running. Output style, model, and permission settings all follow these rules. Running several Claude accounts adds one more step, because each account has its own private Claude configuration: your personal settings file is copied into each account when a session starts. Change the personal file in your home folder and every account picks it up at its next launch. Change the copy inside an account and the next launch overwrites it, so always edit the one in your home folder. Memory, projects, agents, skills, commands, and plugins are genuinely shared between accounts rather than copied, so those always match.`,
  },
  {
    id: 'github',
    title: 'GitHub integration',
    body: `Connect a GitHub account once (GitHub CLI reuse, sign-in with a one-time code, or a personal access token) and every project session can show a live GitHub panel: your branch's active PR with CI and reviews, workflow runs with re-run, threaded review comments with reply, linked issues, and a notifications inbox. Local git state and session context work with no account at all. It reads only; the only writes are buttons you press, such as Merge, Re-run, or Reply. Manage everything in Settings, GitHub tab. The optional Copilot meter shows AI credits used this cycle in your status line; switch it on in Settings, Status Line tab.`,
  },
  {
    id: 'statusline',
    title: 'The status line',
    body: `Each Claude session can show a live status line: model, account, tokens against the context window, an API-equivalent cost estimate, lines changed, duration, and your 5-hour and weekly rate limits. Pick exactly which elements appear in Settings, Status Line tab; its font and size live in Settings, Font & Size, under Regions; the master switch there turns the whole thing off for new sessions. It applies only to sessions launched from the Conductor and never changes your global Claude config.`,
  },
  {
    id: 'tools',
    title: 'Built-in tools',
    body: `AI Code Conductor can hand every session a small set of ready-made tools with no setup: Vision (Claude can open a real browser, take screenshots, click, type, and run JavaScript; Claude sessions only), Code review (an independent second opinion on your working changes, powered by Codex, so it needs Codex enabled), and host screenshots (pull images from your machine into the conversation, even over SSH). Code review is available in every local Claude session while Codex is on, but is skipped when the config working directory is missing or resolves to your home folder. Toggle them in Settings, General, under Built-in Tools. They are registered per session and only for sessions launched here; nothing is added to your global Claude or Codex config.`,
  },
  {
    id: 'codex',
    title: 'Codex (Beta)',
    body: `AI Code Conductor can also run OpenAI's Codex CLI in the same workbench: sessions, saved configs, status line telemetry, and history all work. Sign in with ChatGPT or an API key in Settings, Codex tab. Codex support is Beta. Turning Codex off also removes the Code review built-in tool from new sessions.`,
  },
  {
    id: 'pages',
    title: 'The pages on the left rail',
    body: `Agent Hub dispatches headless agent runs and pipelines from templates you author in its Library. Insights builds a qualitative digest of how your Claude sessions have been going. Tokenomics is the spend dashboard: daily charts, per-account costs, and a filterable session table. Memory is a dashboard over Claude's auto-memory, with drilldown and a reading drawer. Logs is a full chat-transcript viewer over your sessions with a timeline rail and full-text search. Conductor MCP shows the built-in tool server and its browser connection. Settings holds everything else.`,
  },
  {
    id: 'ask-conductor',
    title: 'Ask Conductor',
    body: `Ask Conductor is the help session: a real Claude session that has read this app's documentation, so you can ask about the Conductor in plain English instead of hunting through Settings. It also answers questions about Claude Code itself, and will tell you which of the two you are asking about. Open it from the pill at the bottom of the sidebar, the button in the footer, the Feature Guide's Ask box, or Discuss on any tip. Type your question in the Feature Guide first and the session opens with it already asked. It gets its own tab and behaves like any other session, so you can leave it open, come back to it, and use Past discussions in its header to reopen an earlier conversation. It runs in its own documentation folder rather than your project, which is why it cannot see your code: for a question about your repository, ask in that project's session. It is not a saved config and never appears in your Saved Configs list.`,
  },
  {
    id: 'draw',
    title: 'Canvas, Snap, and the webview',
    body: `Inside a session you can swap the terminal for a webview pane (Web), freeze that page into the Excalidraw scratchpad to sketch over it (Freeze), or take a Snap screenshot that lands in the conversation. The alternative pane replaces the terminal while it is open, and closing it brings the terminal straight back.`,
  },
  {
    id: 'sentinel',
    title: 'Sentinel',
    body: `Sentinel is an optional watcher that checks new Claude Code releases for changes that could affect your setup and proposes fixes. It is off by default because analysis spends Claude tokens when Claude updates. Enable it in Settings, General, under Sentinel; it takes effect after a restart. Its chip lives in the title bar.`,
  },
  {
    id: 'privacy',
    title: 'Privacy and data',
    body: `Everything stays on your machine: configs, logs index, memory, and cost data are local files. Session-log indexing (for the Logs, Memory, and Tokenomics pages) reads Claude's own transcript files locally and can be turned off in Settings, General. Network traffic happens only for the services you connect: Claude and Codex talk to their own APIs, and the GitHub integration talks only to github.com. Beyond that the app checks GitHub for its own updates and reads Anthropic public service-status page. AI Code Conductor sends no telemetry.`,
  },
  {
    id: 'shortcuts',
    title: 'Useful shortcuts',
    body: `Ctrl+T creates a new config. Ctrl+Tab switches sessions. Ctrl+/ toggles the GitHub panel. Keyboard shortcuts are configurable in Settings, Shortcuts tab. The Feature Guide (the ? button in the sidebar) replays the full feature tour anytime.`,
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting basics',
    body: `If the status line is missing, check the master switch in Settings, Status Line, and note it applies to newly launched sessions. If the Logs page is greyed out, session-log indexing is off in Settings, General. If GitHub features look dead, re-check the account's access in Settings, GitHub (tokens can expire or lack scopes). If Codex features are missing, confirm the Codex CLI is installed and signed in under Settings, Codex. Compatibility with your installed Claude Code version is checked during onboarding and can be re-run by reinstalling or updating Claude Code and reopening the app.`,
  },
  {
    id: 'known-issues',
    title: 'Known issues and workarounds',
    body: `Terminal text vanishing while other sessions are open. If a terminal keeps its background colours but loses its characters, and resizing the window, scrolling it, or clicking into it brings the text straight back, that is GPU rendering. Drawing terminals on the GPU uses one shared store of character images for the whole app rather than one per terminal, so whenever any single session refreshes that store, every other open terminal loses its characters until something makes it redraw. It needs two or more sessions open, which is why it can look random, and it gets worse the more sessions you have. GPU rendering is off by default and marked experimental, so this reaches you only if you switched it on yourself. The workaround is to turn it off in Settings, General, under Terminal, then open your sessions again; terminals opened after the change are drawn by the normal font engine, which keeps no shared store and cannot show the fault. A first attempt at repairing the GPU path did not hold and the work continues.`,
  },
]

/** The full knowledge as one markdown document (for the ask-session workspace). */
export function appKnowledgeMarkdown(): string {
  return [
    '# AI Code Conductor: user guide',
    '',
    ...APP_KNOWLEDGE_SECTIONS.flatMap((s) => [`## ${s.title}`, '', s.body, '']),
  ].join('\n')
}
