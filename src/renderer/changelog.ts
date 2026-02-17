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
    version: '1.2.75',
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
