/**
 * Changelog for What's New modal
 * Add new releases at the top of the array
 */

export interface ChangelogEntry {
  version: string
  date: string  // YYYY-MM-DD format
  highlights?: string  // Brief summary shown prominently
  changes: {
    type: 'feature' | 'fix' | 'improvement'
    description: string
  }[]
}

export const changelog: ChangelogEntry[] = [
  {
    version: '1.4.0',
    date: '2026-04-24',
    highlights: "GitHub sidebar — PR, CI, reviews, linked issues, and session context next to the terminal",
    changes: [
      { type: 'feature', description: "New GitHub sidebar. Collapsible right panel that shows the PR for your current branch, CI runs, reviews, linked issues, local git state, and a session-context summary of what this terminal is working on" },
      { type: 'feature', description: "Sign in with GitHub via OAuth device flow, fine-grained PAT, or gh CLI adoption. Nothing runs until you opt in per session" },
      { type: 'feature', description: "Per-session enable with repo auto-detection banner. Ctrl+/ (Cmd+/ on Mac) toggles the panel" },
      { type: 'feature', description: "PR-body reference scanning. Closes/fixes/resolves #N and owner/repo#N refs in a PR body all surface in the session context" },
      { type: 'feature', description: "Notifications mini-section with mark-read, plus rate-limit and expiry banners on your auth profiles" },
      { type: 'feature', description: "First-launch onboarding modal for the GitHub sidebar, with a Set up now button that deep-links into the GitHub settings tab" },
      { type: 'improvement', description: "HTTP Hooks Gateway plumbing. Opt-in loopback 127.0.0.1 listener that receives tool-call, permission, and lifecycle events from your Claude Code sessions via per-session UUID secrets. No UI in this release - it's the foundation for desktop notifications and external automations in upcoming versions. Toggle under Settings > GitHub" },
      { type: 'fix', description: "Right-click paste in terminals now respects bracketed-paste mode. Pasting multi-line text into Claude Code (or any other app that enables the mode) lands as a single atomic paste instead of submitting on the first newline" },
      { type: 'fix', description: "Session labels no longer leak into Claude as user prompts. Dropped the --name CLI flag whose value was being split by Windows shell quoting, sending part of the label as the first message" },
      { type: 'improvement', description: "What's New modal fade-out now uses a shared 200 ms constant matched to the Tailwind transition, so the animation never truncates" },
    ]
  },
  {
    version: '1.3.1',
    date: '2026-04-15',
    highlights: "First public release — open-sourced on GitHub",
    changes: [
      { type: 'feature', description: "Command bar sections: drag commands into named sections, right-click to rename/delete, custom text colors, independent Claude/Partner row sections" },
      { type: 'feature', description: "SSH statusline now shows full second line (rate limits, extra spend, peak/off-peak) — fetches from Anthropic API on the remote" },
      { type: 'feature', description: "Insights report links now open in your system browser instead of showing blank pages" },
      { type: 'fix', description: "SSH sessions now auto-start Claude (was broken for sessions without a post-connect command)" },
      { type: 'fix', description: "SSH setup script no longer echoes binary text — suppressed with stty" },
      { type: 'fix', description: "Logs tab no longer freezes the UI — async file reads with loading spinner" },
      { type: 'fix', description: "Memory manager: 'originSessionId' recognized as valid field, warnings now expandable" },
      { type: 'fix', description: "Insights KPI extraction: prompt piped via stdin instead of fragile shell arguments" },
      { type: 'improvement', description: "Tips updated for new section features with trackUsage calls" },
      { type: 'improvement', description: "Pre-release checklist prompt added to release script" },
    ]
  },
  {
    version: '1.2.166',
    date: '2026-04-08',
    highlights: "Branching model: beta + main with promote flow",
    changes: [
      { type: 'improvement', description: "New branching model: all feature work happens on the `beta` branch; the `main` branch is stable-only and receives fast-forwards from beta" },
      { type: 'improvement', description: "Release script now enforces branch ↔ channel correspondence — --stable must run on main, --beta/--dev must run on beta (bypass with --skip-branch-check in emergencies)" },
      { type: 'feature', description: "New `npm run promote` command merges the beta→main PR and ships a stable release at the same version as the current beta" },
      { type: 'feature', description: "New --no-bump flag on the release script reuses the current package.json version instead of incrementing — used by the promote flow to keep beta and stable version numbers aligned" },
      { type: 'feature', description: "New --ff-only and --yes flags on the promote script for partial/automated runs" },
    ]
  },
  {
    version: '1.2.165',
    date: '2026-04-08',
    highlights: "Release script hotfix: cross-platform sleep + proper workflow watching",
    changes: [
      { type: 'fix', description: "Local release script now uses Node-native sleep instead of shelling out to `timeout`/`sleep`, which was silently failing inside execSync and preventing the script from finding the dispatched workflow run ID" },
      { type: 'fix', description: "Release script now surfaces real errors from the run-ID polling loop instead of swallowing them — gives a useful hint if GitHub API is unreachable" },
      { type: 'improvement', description: "Run-ID detection picks the newest workflow_dispatch run regardless of branch, so the filter doesn't miss the just-dispatched run due to API pagination lag" },
    ]
  },
  {
    version: '1.2.164',
    date: '2026-04-08',
    highlights: "Unified release pipeline + channel label on update button",
    changes: [
      { type: 'improvement', description: "Release script now dispatches the GitHub Actions workflow for canonical dual-platform builds (Windows EXE + macOS DMG, both signed/notarized, both VirusTotal-scanned, single release with checksums) instead of doing a Windows-only local build" },
      { type: 'improvement', description: "Local release script does fast smoke checks (typecheck + unit tests + build) for fast feedback before pushing to CI, then watches the workflow run to completion and verifies both .exe and .dmg are attached" },
      { type: 'improvement', description: "Release script now supports stable / beta / dev channels via --stable / --beta / --dev (default: interactive prompt with beta as fallback)" },
      { type: 'feature', description: "Check for Updates button now shows the active channel — 'Check for Beta Updates' / 'Check for Stable Updates' / 'Check for Dev Updates' — so you always know what you're checking against without opening the dropdown" },
    ]
  },
  {
    version: '1.2.163',
    date: '2026-04-08',
    highlights: "SSH statusline + unified MCP image transport + dual service status indicator",
    changes: [
      { type: 'fix', description: "SSH statusline now updates: a tiny shim deployed to the remote ~/.claude emits an OSC sentinel via /dev/tty that the host parses out of the PTY stream (no SMB mount needed)" },
      { type: 'feature', description: "Image paste, snap, and storyboard now work in BOTH local and SSH sessions via the conductor-vision MCP fetch_host_screenshot tool — one unified code path, no path-vs-base64 hacks" },
      { type: 'feature', description: "vision_screenshot returns inline image content directly — no second Read tool call needed to view the captured browser screenshot" },
      { type: 'feature', description: "Conductor MCP server now starts at app launch independent of browser/vision config so fetch_host_screenshot is always available" },
      { type: 'feature', description: "Title bar service status redesigned: separate Claude Code + Claude.ai pills with colored dots, plus API status surfacing only when degraded" },
      { type: 'fix', description: "'Got it' tip button now actually clears the tip pill from the session header (markTipActed clears currentTipId)" },
      { type: 'fix', description: "Snap, storyboard, and clipboard image resize now preserve aspect ratio — was previously distorting non-square images by passing both width and height to nativeImage.resize()" },
      { type: 'improvement', description: "All screenshot capture sites cap longest edge to 1920px and use JPEG q85 (q78 for storyboard frames) to reduce token cost" },
      { type: 'improvement', description: "Clipboard paste regression fixed — was sending raw base64 to the PTY, now uses saveImage path through the MCP fetch tool" },
    ]
  },
  {
    version: '1.2.162',
    date: '2026-04-07',
    highlights: "Update system refactor: GitHub-only with stable/beta/dev channels + PTY dedupe",
    changes: [
      { type: 'feature', description: "Update checker now polls GitHub releases directly instead of a local WebSocket server" },
      { type: 'feature', description: "New update channel selector next to Check for Updates button — stable / beta / dev with full keyboard accessibility" },
      { type: 'feature', description: "Dev channel for experimental builds (alongside existing stable and beta)" },
      { type: 'fix', description: "Duplicate Claude prompts: PTY now suppresses identical submitted payloads within 300ms (prevents double-sends that triggered rate limits)" },
      { type: 'improvement', description: "Update checker works without gh CLI once the repo is public (tries public GitHub API first, falls back to gh CLI only when needed)" },
      { type: 'improvement', description: "Safer update downloads: HTTPS-only redirects, Windows retry safety (unlinks stale files before rename), no shell injection risk" },
      { type: 'improvement', description: "Proper prerelease ordering (beta.2 > beta.1, final > beta)" },
      { type: 'improvement', description: "CI workflow on every PR — typecheck, tests, build on both Windows and macOS" },
    ]
  },
  {
    version: '1.2.161',
    date: '2026-04-07',
    highlights: "Intelligent tips system with 26 seed tips and transparency disclosures",
    changes: [
      { type: 'feature', description: "Animated tip pill in the session header shows contextual, one-per-session feature discovery hints" },
      { type: 'feature', description: "Clicking a tip opens a platform-aware modal with full details, optional navigation, and dismiss/silence controls" },
      { type: 'feature', description: "New Transparency category: explicit tips about statusline injection, Vision MCP, session logging, credential storage, resources folder, and all network activity" },
      { type: 'feature', description: "Usage tracking persists to CONFIG/usage-tracking.json — tips intelligently skip features you've already used or show 'did you know' variants" },
      { type: 'feature', description: "Toggle 'Show intelligent tips' in Settings > General to disable the system" },
      { type: 'improvement', description: "Platform-aware tip copy: Partner Terminal, Credential Storage, Resources Folder, and Session Logs tips show correct Windows vs macOS paths" },
    ]
  },
  {
    version: '1.2.160',
    date: '2026-04-07',
    highlights: "Guided first-run config + terminal column fix",
    changes: [
      { type: 'feature', description: "New users see a 'Get Started' card with a guided split-view to create their first config with inline help" },
      { type: 'fix', description: "Terminal column mismatch: wait for custom fonts to load before computing cols (no more text fragments on the right edge)" },
    ]
  },
  {
    version: '1.2.159',
    date: '2026-04-07',
    highlights: "First CI/CD release: parallel Windows + macOS builds with signing",
    changes: [
      { type: 'feature', description: "GitHub Actions workflow builds Windows EXE and macOS DMG in parallel" },
      { type: 'feature', description: "macOS DMG is code-signed and notarized via Apple Developer ID" },
      { type: 'improvement', description: "Tour walkthrough consolidated to 7 focused steps with matching screenshots" },
      { type: 'fix', description: "Splash screen now shows before main window renders" },
      { type: 'fix', description: "CLI setup dialog now works on macOS via login shell PATH" },
      { type: 'fix', description: "Setup dialog no longer crashes with null ResizeObserver target" },
    ]
  },
  {
    version: '1.2.158',
    date: '2026-02-11',
    highlights: "Maintenance release with internal improvements",
    changes: [
      { type: 'improvement', description: "Internal code maintenance and stability improvements" }
    ]
  },
  {
    version: '1.2.68',
    date: '2026-02-11',
    highlights: 'Automated release pipeline with Claude CLI, VirusTotal, and GitHub Releases',
    changes: [
      { type: 'feature', description: 'Release pipeline now auto-generates changelog and release notes via Claude CLI' },
      { type: 'feature', description: 'VirusTotal scan of installer with results linked in GitHub Release' },
      { type: 'feature', description: 'SHA-256 checksums generated and attached to each release' },
      { type: 'feature', description: 'GitHub Releases created automatically with installer download' },
      { type: 'improvement', description: 'Old installer versions auto-cleaned from project root on each release' },
      { type: 'improvement', description: 'npm audit pre-check blocks release if critical vulnerabilities found' },
    ]
  },
  {
    version: '1.2.67',
    date: '2026-02-08',
    highlights: 'Platform v9 theme, rate limits, enriched statusline, config improvements',
    changes: [
      { type: 'feature', description: 'Rate limit tracking — 5-hour and weekly usage with colored dot bars, reset times, and extra usage cost shown in context bar' },
      { type: 'feature', description: 'Enriched context bar — now shows model name, token count (135k/200k), context %, cost, lines changed, and session duration' },
      { type: 'improvement', description: 'New platform v9 dark theme — deeper blue-black backgrounds replace the old purple-tinted Catppuccin palette' },
      { type: 'feature', description: 'Config right-click menu now includes Edit and Delete options alongside group management' },
      { type: 'improvement', description: 'Config items show Claude/Shell badges and colored left borders. Active tabs have colored bottom border' },
      { type: 'fix', description: 'Command button context menu no longer truncates at window edge — opens upward when near bottom' },
    ]
  },
  {
    version: '1.2.36',
    date: '2026-02-07',
    highlights: 'Insights fix, command button fix, update reliability',
    changes: [
      { type: 'fix', description: 'Insights now works — /insights runs via PTY with proper TTY instead of headless spawn that hung forever' },
      { type: 'fix', description: 'Custom command buttons no longer re-fire when pressing Enter — buttons no longer steal keyboard focus' },
      { type: 'fix', description: 'Update process simplified — copies installer to Downloads, kills PTYs, launches installer, exits immediately' },
    ]
  },
  {
    version: '1.2.24',
    date: '2026-02-07',
    highlights: 'Debug logging overhaul, input protection, crash recovery',
    changes: [
      { type: 'improvement', description: 'Debug toggle now controls verbose app logging instead of screenshot capture — logs persist across updates' },
      { type: 'improvement', description: 'Log rotation increased to 10MB with 3 backup files for better diagnostic history' },
      { type: 'fix', description: 'Restored image paste handler — clipboard images saved as JPEG (max 1920px, 85%) with file path sent to Claude' },
      { type: 'fix', description: 'Right-click in terminal pastes clipboard text when no text is selected' },
      { type: 'fix', description: 'Input bar blocks multi-char text when Claude is asking a question — prevents losing typed content' },
      { type: 'fix', description: 'Image paste debounced (3s) to prevent duplicate sends via Alt+V or Ctrl+V' },
      { type: 'improvement', description: 'Insights timeout increased from 5 to 10 minutes' },
      { type: 'improvement', description: 'Error boundary catches renderer crashes and shows error with recovery button instead of blank screen' },
      { type: 'improvement', description: 'Verbose PTY lifecycle logging (spawn, exit, kill) for debugging session issues' },
    ]
  },
  {
    version: '1.2.20',
    date: '2026-02-06',
    highlights: 'Config and session groups with collapsible tree view',
    changes: [
      { type: 'feature', description: 'Group saved configs into named groups — collapsible tree view in sidebar' },
      { type: 'feature', description: 'Launch all configs in a group at once with the group play button' },
      { type: 'feature', description: 'Active sessions auto-group based on their config\'s group' },
      { type: 'feature', description: 'Right-click configs to move between groups or create new ones' },
      { type: 'feature', description: 'Group field in config dialog for assigning during create/edit' },
      { type: 'fix', description: 'Context remaining indicator now works for SSH sessions (accumulation buffer for chunked data)' },
    ]
  },
  {
    version: '1.2.5',
    date: '2026-02-06',
    highlights: 'Image optimization, yellow cursor fix, and update button fix',
    changes: [
      { type: 'fix', description: 'Clipboard images (Alt+V) now resized to max 1920px and saved as JPEG — drastically reduces context usage' },
      { type: 'fix', description: 'Screenshot capture also switched from PNG to JPEG for smaller files' },
      { type: 'fix', description: 'Yellow cursor block eliminated by stripping yellow background color sequences' },
      { type: 'fix', description: 'Screenshot dropdown labels render properly (SVG icons instead of broken Unicode)' },
      { type: 'fix', description: 'Update button now runs pre-built installer instead of rebuilding from source' },
    ]
  },
  {
    version: '1.2.3',
    date: '2026-02-06',
    highlights: 'Smart insights with AI-powered analysis and actionable summaries',
    changes: [
      { type: 'feature', description: 'KPI extraction now uses smart Claude skill that compares to previous run and produces actionable bullet points' },
      { type: 'feature', description: 'Insights sidebar shows improvements (green), regressions (red), and suggestions (purple) at the top' },
      { type: 'improvement', description: 'KPI format is now fully dynamic — the skill decides categories, metrics, and lists without hardcoded schemas' },
      { type: 'improvement', description: 'What\'s New modal now triggers on version change, not every build' },
    ]
  },
  {
    version: '1.2.2',
    date: '2026-02-06',
    highlights: 'Screenshot button redesign, input persistence, and release automation',
    changes: [
      { type: 'improvement', description: 'Screenshot button restyled to match app design (no more garish cyan)' },
      { type: 'fix', description: 'Input text no longer lost when switching between sessions and other views' },
      { type: 'feature', description: 'npm run release — single command for full build, package, and update notification' },
    ]
  },
  {
    version: '1.2.1',
    date: '2026-02-06',
    highlights: 'Better insights rendering, screenshot button fix, and clipboard paste fix',
    changes: [
      { type: 'improvement', description: 'Insights report now renders with full Catppuccin dark theme matching the app' },
      { type: 'fix', description: 'Screenshot button replaced with clean SVG icon instead of emoji' },
      { type: 'fix', description: 'Ctrl+V paste no longer intercepts clipboard images — screenshot workflow uses right-click only' },
      { type: 'fix', description: 'Stuck insight runs automatically marked as failed on app restart' },
      { type: 'feature', description: 'CLI availability indicator (green/red dot) in status bar' },
      { type: 'fix', description: 'Restart button now works for SSH/remote sessions (kills old PTY before re-spawning)' },
    ]
  },
  {
    version: '1.2.0',
    date: '2026-02-06',
    highlights: 'Insights analytics with KPI tracking and trend comparison',
    changes: [
      { type: 'feature', description: 'Insights integration: run claude /insights from the sidebar and view reports in-app' },
      { type: 'feature', description: 'KPI extraction via Claude headless with automatic trend comparison between runs' },
      { type: 'feature', description: 'Insights archive with history browsing and versioned reports' },
      { type: 'feature', description: 'KPI sidebar showing metrics grouped by category with trend arrows' },
      { type: 'feature', description: 'Auto-seeds existing report on first launch so your data is immediately available' },
      { type: 'fix', description: 'Update process now properly rebuilds, runs the installer, and relaunches the app' },
    ]
  },
  {
    version: '1.1.0',
    date: '2026-02-05',
    highlights: 'Session restore, Docker screenshot support, and graceful shutdown',
    changes: [
      { type: 'feature', description: 'Sessions are now saved on close and restored on launch with /resume' },
      { type: 'feature', description: 'Graceful shutdown sends /exit to Claude before closing' },
      { type: 'feature', description: 'Screenshots now work in Docker containers via docker cp' },
      { type: 'feature', description: 'Shell-only terminals (without Claude) option added' },
      { type: 'feature', description: 'Push-based update notifications via WebSocket' },
      { type: 'improvement', description: 'Build timestamp shown in status bar for version tracking' },
      { type: 'improvement', description: 'Expanded color palette with 24 vibrant colors' },
      { type: 'fix', description: 'Log viewer now properly displays terminal logs' },
      { type: 'fix', description: 'Yellow cursor issue resolved by hiding cursor layer' },
    ]
  },
  {
    version: '1.0.0',
    date: '2026-02-01',
    highlights: 'Initial release',
    changes: [
      { type: 'feature', description: 'Multi-session Claude Code terminal management' },
      { type: 'feature', description: 'SSH session support with password authentication' },
      { type: 'feature', description: 'Custom commands per session/config' },
      { type: 'feature', description: 'Session logging with history viewer' },
      { type: 'feature', description: 'Tab attention indicators for waiting prompts' },
      { type: 'feature', description: 'Context usage tracking via statusline API' },
    ]
  }
]

// Get the latest version info
export function getLatestVersion(): ChangelogEntry {
  return changelog[0]
}

// Get all changes since a specific version
export function getChangesSince(version: string): ChangelogEntry[] {
  const idx = changelog.findIndex(e => e.version === version)
  if (idx === -1) return changelog // Unknown version, show all
  return changelog.slice(0, idx)
}
