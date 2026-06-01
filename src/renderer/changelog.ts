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
    version: '1.5.22',
    date: '2026-06-01',
    highlights: 'Pick the account a session runs under when it starts, and a clearer Accounts list.',
    changes: [
      { type: 'improvement', description: 'Account is now chosen when a session starts, not saved on the config. The first time a session launches you pick which account it runs under, so the account stays a live choice rather than a buried setting.' },
      { type: 'improvement', description: 'The Accounts list in Settings now shows each account by its email, with a clearly labelled Name field below it to give the account a friendly label. Add and remove accounts as before.' },
      { type: 'improvement', description: 'The start-session account picker now shows the friendly name you gave each account, including your default account.' },
      { type: 'fix', description: 'You can now switch a session between your Default account and a single added account from the status strip (previously this needed two added accounts).' },
      { type: 'fix', description: 'Removed the leftover Setup Statusline command from existing setups.' },
      { type: 'improvement', description: 'Added the independent-project disclaimer to the startup splash screen.' },
    ],
  },
  {
    version: '1.5.19',
    date: '2026-06-01',
    highlights: 'Run multiple Claude accounts in CCC: add accounts, switch per session, keep them isolated.',
    changes: [
      { type: 'feature', description: 'Multiple accounts: add a second or third Claude account and run different sessions under different accounts. A first-run prompt walks you through it, and you can manage accounts anytime in Settings then Accounts.' },
      { type: 'feature', description: 'Switch a session to another account from the status strip pill or the right-click menu (it respawns and resumes under the chosen account). Signing in or out of an added account never touches your other accounts.' },
      { type: 'improvement', description: 'The status strip shows which account a session is using, and the account chip now resolves correctly for single-account users.' },
      { type: 'improvement', description: 'Effort level now reflects live /effort changes in the status line, and you can toggle the Effort and Account elements in Statusline settings.' },
      { type: 'improvement', description: 'Removed the Mode pill from the status strip (use Shift+Tab to change permission mode) and the redundant Setup Statusline command.' },
    ],
  },
  {
    version: '1.5.18',
    date: '2026-05-31',
    changes: [
      { type: 'improvement', description: 'Permission tray no longer shows a card for the session you are currently viewing (Claude prompts you right there). The card appears if you switch to another session while the prompt is still waiting.' },
      { type: 'fix', description: 'Permission cards now reliably show which tool and command Claude is asking about, even when several tools run at once.' },
      { type: 'fix', description: 'Permission cards are now mouse-only: they never steal keyboard focus or interrupt your typing, and a stray Enter or Escape can no longer action a card.' },
      { type: 'improvement', description: 'Added a footer note clarifying this is an independent project, not affiliated with or endorsed by Anthropic.' },
    ],
  },
  {
    version: '1.5.17',
    date: '2026-05-31',
    changes: [
      { type: 'improvement', description: 'Permission tray now surfaces only genuine prompts Claude is blocked on, honoring your Claude settings (no more cards for auto-approved commands).' },
      { type: 'feature', description: 'Each card has Go to session and Ignore; a Settings toggle disables the tray.' },
    ],
  },
  {
    version: '1.5.16',
    date: '2026-05-30',
    changes: [
      { type: 'feature', description: 'Permission tray: approve or deny any tool request from one place, across all sessions' },
      { type: 'improvement', description: 'Attention indicator no longer re-fires when you revisit a session' },
      { type: 'fix', description: 'Effort level now shows permanently in the status line' },
      { type: 'fix', description: 'Settings toggles no longer overlap their labels' },
    ],
  },
  {
    version: '1.5.15',
    date: '2026-05-29',
    highlights: "Removes the per-session account alias feature. Showing which Claude account a session is on is not reliable without isolating each session's config (which would fragment your shared memory and settings), so the alias label on session rows, the right-click Account tagging, and the Settings account-alias list are gone. Per-account spend tracking on the Tokenomics page is unaffected.",
    changes: [
      { type: 'improvement', description: "Removed the session account-alias feature: the alias label on session rows, the right-click 'Account' tagging menu, and the Settings account-aliases list. Claude exposes no reliable per-session account signal (it is global / last-login only), so the labels were frequently wrong whenever more than one account was in use" },
      { type: 'improvement', description: "Tokenomics per-account spend (the Account filter and group-by-account view) is unchanged -- it uses a separate ledger-side mechanism, not the live session label" },
    ],
  },
  {
    version: '1.5.14',
    date: '2026-05-29',
    highlights: "Polish pass: the session duration in the status strip now reads as hours and days past an hour (no more '1731m 38s'), the Permission Attention Tray stops false-flagging safe commands, and sessions whose saved folder no longer exists open in your home directory instead of dying on launch.",
    changes: [
      { type: 'fix', description: "Status strip: session duration rolls up to hours past 60 minutes and days past 24 hours, showing two units max (e.g. '1d 4h'). Long-running or resumed sessions no longer show an unreadable raw-minutes count" },
      { type: 'fix', description: "Permission tray: `git push --force-with-lease` (the safe push form) is no longer flagged as a high-risk force-push, and `sudo` detection only fires when sudo is the command being run -- not when it appears inside a quoted string or a path like /etc/sudoers" },
      { type: 'fix', description: "Sessions with a working directory that no longer exists (a deleted worktree, an un-cloned repo, a demo path) now fall back to your home directory instead of exiting immediately with '[Process exited with code 1]'" },
    ],
  },
  {
    version: '1.5.13',
    date: '2026-05-29',
    highlights: "Day-two Opus 4.8 polish: Ultracode effort level (xhigh + automatic dynamic workflows), a global Disable Claude Code dynamic workflows toggle in Settings > Security, and new tour + tips entries for the Permission Attention Tray and Dynamic Workflows so they actually show up in /help.",
    changes: [
      { type: 'feature', description: "Effort dropdown: **Ultracode** option added. Sets `--effort ultracode` so Claude Code (2.1.154+) automatically plans dynamic workflows for every substantive task. Resets when you start a new session" },
      { type: 'feature', description: "Settings > Security: **Disable Claude Code dynamic workflows** toggle writes `disableWorkflows: true` into the per-session Claude settings so workflows are off for newly spawned sessions. Applies on next spawn; existing sessions keep their setting" },
      { type: 'feature', description: "Tour: dedicated **Permission Attention Tray** step covering the high-risk Bash patterns, the 50-entry cap, and how the gateway intercepts before Claude runs the command" },
      { type: 'feature', description: "Tour: dedicated **Dynamic Workflows** step covering the three ways to invoke (workflow keyword, Ultracode, /deep-research), the /workflows progress view, the 1000-subagent cap, and the global disable" },
      { type: 'improvement', description: "Tips: new entries for the Permission Tray and Dynamic Workflows so the contextual tip system surfaces them after first use" },
    ],
  },
  {
    version: '1.5.11',
    date: '2026-05-29',
    highlights: "Opus 4.8 lands as the new default, with Extra high effort and a Fast mode toggle (2.5x speed at 2x cost). The Permission Attention Tray from v1.5.10 is now actually wired -- v1.5.10 shipped the toast stack but the hook injection was disabled, so no toast ever fired; v1.5.11 fixes the wiring and ties it to Claude Code's real PreToolUse hook.",
    changes: [
      { type: 'feature', description: "Opus 4.8 default: new Claude sessions land on Opus 4.8 (Anthropic's newest model, released 2026-05-28). The model dropdown uses the `opus` alias so the default stays current as Anthropic releases new versions" },
      { type: 'feature', description: "Effort levels: Extra high (xhigh) and Max added to the Session dropdown; Opus 4.8 supports xhigh as its hardest-task setting" },
      { type: 'feature', description: "Fast mode toggle for Opus 4.8: 2.5x speed at 2x cost ($10/$50 per 1M tokens vs standard $5/$25). Tokenomics tracks Fast spend through a separate `<model>-fast` pricing row" },
      { type: 'fix', description: "Permission Attention Tray wiring: v1.5.10 had injectHooks disabled and the gateway only matched a 'PermissionRequest' event Claude Code never fires. v1.5.11 re-enables hook injection per Claude session, ties the gateway to the real PreToolUse hook for Bash, and updates the disposition rule so the tray only fires for the high-risk patterns (rm -rf, sudo, force-push, dd, mkfs, chmod 777, fork bombs)" },
      { type: 'improvement', description: "Tokenomics: hardcoded fallback pricing for Opus 4.8 + 4.7 ($5/$25 standard, $10/$50 fast). LiteLLM live pricing still wins when reachable" },
    ],
  },
  {
    version: '1.5.10',
    date: '2026-05-28',
    highlights: "V2 UX uplift across Tokenomics, Insights, Logs, Settings, and Agent Hub -- plus a new Permission Attention Tray for high-risk Bash prompts. Insights drops its iframe and renders natively, Logs paginates large buffers, and Tokenomics gains a Project / Account / Model group-by lens.",
    changes: [
      { type: 'feature', description: "Permission Attention Tray: high-risk Bash commands (rm -rf, dd, mkfs, force-push, etc.) now stack as toasts in the top-right corner. Keyboard shortcuts let you approve or reject without scrolling back to the prompt; auto-allow handles read-only commands transparently" },
      { type: 'feature', description: "Tokenomics: new Group by lens (Project / Account / Model) pivots the breakdown panel + sessions table without re-running anything" },
      { type: 'improvement', description: "Insights: native renderer replaces the iframe + injected dark theme CSS, so the report loads faster, follows your theme cleanly, and inherits the V2 surface tokens" },
      { type: 'improvement', description: "Logs: chunked virtualization (500 entries per page with a Load older button) plus incremental filter diff -- big session logs no longer freeze the UI" },
      { type: 'improvement', description: "Settings and Agent Hub: V2 primitive pass (StatusDot, MetricChip, SectionLabel, Kbd) and accent-token rails for tab + filter selection" },
      { type: 'improvement', description: "TitleBar and Session Status Strip lifted onto the V2 raised-surface tier so they read as a single instrument cluster against the chrome below" },
      { type: 'fix', description: "Cloud agent status colours now go through semantic tokens; status dot uses the StatusDot primitive (no more broken hex+alpha concat on the box-shadow)" },
    ],
  },
  {
    version: '1.5.9',
    date: '2026-05-27',
    highlights: "Account labels are now user-managed -- you set them once in Settings and tag any session by right-click. The v1.5.7 auto-detected email chip was structurally unreliable (the field it read is global, not per-session) and has been removed.",
    changes: [
      { type: 'fix', description: "Removed the per-session account-email chip from the session header and status strip -- it was reading a global file and could display the wrong account when you switched logins in another session" },
      { type: 'feature', description: "Settings > General > Account Aliases lets you keep a short list of email + alias rows; right-click any session in the sidebar to tag it with one. The alias shows after the project name in non-bold text" },
      { type: 'fix', description: "Use this repo: clicking on a freshly-spawned session now persists correctly instead of silently doing nothing (regression introduced in v1.5.8 where the session state had not yet been flushed to disk before the IPC write)" },
    ],
  },
  {
    version: '1.5.8',
    date: '2026-05-27',
    highlights: "Three bug fixes: 'Use this repo' in the auto-detect banner now persists across restarts and skips the Settings detour when you are already authed; the Codex MCP server's 'Session not found' 404 now logs diagnostics and returns an actionable recovery message.",
    changes: [
      { type: 'fix', description: "Clicking 'Use this repo' in the auto-detect banner now writes the repo to the parent saved config (not just the live session), so the selection survives an app restart" },
      { type: 'fix', description: "When at least one GitHub auth profile already exists, 'Use this repo' enables the integration in place and auto-picks a matching profile by repo or username -- no more bounce to the Settings tab" },
      { type: 'improvement', description: "Conductor MCP /messages 404 now logs the requested transport id, active-transport count, sample ids and user-agent, and returns a multi-line recovery message instead of a bare 'Session not found' (helps when Claude reports the Codex review tool as unavailable mid-session)" },
    ]
  },
  {
    version: '1.5.7',
    date: '2026-05-27',
    highlights: "Your account email is back in the status line and session header -- coloured per account -- and you can now pin a fixed colour to any account in Settings. The Update pill also appears on its own now, without needing a restart.",
    changes: [
      { type: 'fix', description: "The active account email is shown again in the per-session status line and the session header, coloured per account -- it was dropped during the V2 shell refactor" },
      { type: 'feature', description: "Assign a fixed colour to any account email in Settings > General > Account Colours. Detected accounts are listed automatically, or add one manually; the chosen colour tints that account's email everywhere it shows" },
      { type: 'improvement', description: "The app now re-checks for updates periodically and when the window regains focus, so the Update pill appears on its own instead of only after a manual restart" },
    ]
  },
  {
    version: '1.5.6',
    date: '2026-05-26',
    highlights: "Identity colours now span the full hue wheel so sessions are instantly distinguishable, the GitHub panel slides in when shown, and a few first-launch papercuts are fixed.",
    changes: [
      { type: 'improvement', description: "Identity colours are re-tuned across the whole colour wheel (blues, teals, greens, ambers, oranges, roses, purples) so saved configs and active sessions are instantly distinguishable in the left rail, tabs, and inactive dots -- not all variations of purple" },
      { type: 'improvement', description: "The GitHub panel now slides in and fades when shown, and the collapsed floating logo button fades in (both respect reduced-motion)" },
      { type: 'fix', description: "The Claude service-status pills (Code / Claude.ai) now appear immediately on launch instead of staying blank until the first background poll minutes later" },
      { type: 'fix', description: "Pasting an image with Alt+V now works on the first try -- previously the first attempt after copying could report 'no image detected' until you typed something (a Windows clipboard timing quirk)" },
    ]
  },
  {
    version: '1.5.5',
    date: '2026-05-26',
    highlights: "Bottom-region rework from UAT: the per-session status line now sits directly above the command rows, CLI/version is a slim status bar at the bottom-left, and the GitHub panel ends above the command rows with a floating logo button when collapsed.",
    changes: [
      { type: 'improvement', description: "The per-session status line (model, tokens, context, rate limits) and the Mode / Model / Compact / Restart controls now sit directly above the command rows, where the old context bar lived" },
      { type: 'improvement', description: "CLI, version and channel are now a slim global status bar pinned to the bottom-left of the window, spanning the full width -- separate from the per-session status line" },
      { type: 'fix', description: "The GitHub panel no longer stretches down past the status line and command rows. It ends above them, beside the terminal" },
      { type: 'improvement', description: "When the GitHub panel is collapsed it is now a floating GitHub-logo button in the top-right corner instead of a thin vertical bar (with a coloured hover)" },
      { type: 'fix', description: "The 'New: GitHub sidebar' onboarding popup no longer reappears on every launch once you have a GitHub account configured" },
      { type: 'improvement', description: "The update notification is no longer duplicated. The large 'Update Available' card is gone; the status-bar Update pill gently pulses when an update is ready" },
      { type: 'improvement', description: "Command chips and the Mode / Model / Compact / Restart controls restyled into one consistent set; the model name shows properly and Restart is set apart" },
    ]
  },
  {
    version: '1.5.4',
    date: '2026-05-26',
    highlights: "V2 shell polish from first-look feedback: the bottom instrument bar now sits under the terminal only, inactive sessions keep their identity colour, and the global/custom command rows follow the theme.",
    changes: [
      { type: 'fix', description: "The bottom instrument bar is now scoped to the content area instead of spanning the full window width underneath the sidebar" },
      { type: 'fix', description: "Inactive sessions keep a muted identity-colour rail, so you can still tell sessions apart at a glance; the selected session shows the full rail, tint, and border" },
      { type: 'fix', description: "Global and custom command rows now use the theme's surface tokens instead of a fixed dark background, so they follow light and dark correctly" },
    ]
  },
  {
    version: '1.5.3',
    date: '2026-05-26',
    highlights: "V2 command-center shell -- a ground-up visual redesign: dense session cards, a single bottom instrument bar, a cleaner header and terminal framing, light/dark theming, and per-session identity colours.",
    changes: [
      { type: 'feature', description: "New 'Command Workbench' shell. The session list is rebuilt as dense two-line cards with an unmistakable selected state (identity rail, tint, elevation, bold name, chip); health reads only as a status dot and pill; keyboard focus is a quiet dashed ring distinct from selection" },
      { type: 'feature', description: "Single bottom instrument bar replaces the old status bar, the per-terminal context bar, and the dead toolbar: runtime (CLI, version, channel, update) on the left, live session telemetry inline in the middle, and Mode / Model / Compact / Restart controls on the right" },
      { type: 'feature', description: "Per-session identity colours, resolved per theme, shown consistently on cards, tabs, and the header accent -- a curated non-status palette that never collides with running/warning/error status or the teal focus ring. Legacy session colours are migrated once, with a dismissible notice" },
      { type: 'feature', description: "Light and dark themes with a one-click Light/Dark flip in the title bar; the full Dark / Light / System choice lives in Settings" },
      { type: 'feature', description: "A passive breadcrumb strip in the header (working directory + detected repo), a quieter info-style repo auto-detect suggestion, and a collapsible command bar with neutral command chips" },
      { type: 'improvement', description: "Context-aware empty state: with saved configs you get launch cards plus 'Show all configs'; with none, a clear 'Create a terminal config' action. Saved configs are reachable by keyboard, not hover-only" },
      { type: 'improvement', description: "Terminal container framing -- comfortable padding and a real left gutter so text no longer crowds the edge" },
      { type: 'fix', description: "Theme toggle no longer shows duplicate icons or dead clicks -- every click reliably and visibly changes the theme" },
      { type: 'fix', description: "Session attention pulse no longer re-fires when you simply switch away from a session; it only re-arms on genuine new keyboard input, not focus or mouse reports" },
      { type: 'fix', description: "New branded startup splash" },
    ]
  },
  {
    version: '1.5.2',
    date: '2026-05-24',
    highlights: "Per-session account attribution -- see which Claude/Codex account each session and dollar belongs to. Plus the Electron 38 engine upgrade.",
    changes: [
      { type: 'feature', description: "Per-session account attribution. The active account email now shows in the context bar, coloured deterministically per account, so you can tell at a glance which login a session is running under. Works for both Claude (read live from ~/.claude.json) and Codex (decoded from the session JWT)" },
      { type: 'feature', description: "Tokenomics page gains an Account filter. Slice spend by account email, or by (Mixed) and (Unknown) for sessions that span logins or predate attribution" },
      { type: 'feature', description: "Account attribution back-fill wizard. Historic sessions recorded before this release are bucketed by config and suggested an account from your ~/.claude backup timeline -- confirm, override, or mark mixed. Runs once on first launch and is re-openable from the tokenomics page" },
      { type: 'improvement', description: "Removed the global account picker from the title bar. Attribution is now per-session and automatic -- no manual switching, and historic spend is never silently re-stamped to whoever is logged in now" },
      { type: 'improvement', description: "Electron 33 to 38 engine upgrade (Chromium 132 to 140). Newer rendering engine and security baseline under the hood" },
      { type: 'fix', description: "Codex sessions no longer open to a blank terminal on Windows. ConPTY does not do PATH lookup, so the bare 'node' spawn failed silently -- now resolved to a full node.exe path" },
      { type: 'fix', description: "Codex MCP handshake now speaks streamable HTTP alongside SSE, so the conductor tools (vision, codex review) connect correctly under Codex CLI 0.128+" },
      { type: 'fix', description: "Codex resume picker reads the newer 0.133 rollout format, so resuming a Codex session lists the right sessions with readable labels instead of '(continued session)'" },
      { type: 'fix', description: "GitHub sidebar can be collapsed when open, and its per-session enablement now persists across app restarts" },
    ]
  },
  {
    version: '1.5.1',
    date: '2026-05-08',
    highlights: "Codex provider, mega release",
    changes: [
      { type: 'fix', description: "Removed the peak/off-peak indicator -- Anthropic no longer differentiates peak hours in their rate-limit policy, so the badge was reporting outdated information" },
    ]
  },
  {
    version: '1.4.3',
    date: '2026-04-29',
    highlights: "New branded splash now actually shows on launch, plus a refreshed README with v1.4 feature highlights",
    changes: [
      { type: 'fix', description: "Splash window now displays the new branded artwork. The 1.5 MB PNG was being inlined into a data: URL that exceeded Electron's loadURL size limit, so the window was created but never reached ready-to-show. Switched to writing the wrapper HTML to a temp file and loading via loadFile — works for any image size" },
      { type: 'improvement', description: "README overhaul. Branded splash at the top, six new feature highlight cards (Excalidraw, Combined Mode, Insights, Logs, GitHub sidebar, Vision), accurate v1.4 feature audit, dedicated 'What's New' section, corrected installer naming, and a 'Defence in Depth' security subsection covering daily CONFIG backups" },
    ]
  },
  {
    version: '1.4.2',
    date: '2026-04-28',
    highlights: "Safety-net daily backups of your CONFIG directory — never lose a session list to a corrupted write again",
    changes: [
      { type: 'feature', description: "Daily auto-backup of CONFIG/*.json under CONFIG/_backups/YYYY-MM-DD/ on every app launch. Last 7 days kept, prunes older. Recovery is a manual copy back into CONFIG/ — but the data is always there if anything goes sideways" },
      { type: 'fix', description: "Capture-training script no longer destroys real config data on cleanup. PID lock prevents concurrent captures; cleanup only restores files it explicitly backed up; never blind-deletes by filename match" },
      { type: 'fix', description: "Memory frontmatter writer now produces valid YAML for values containing backslashes, newlines, and other control chars. Previously only escaped quotes — anything else round-tripped as malformed YAML. Switched to JSON-stringify which is a strict subset of YAML 1.2's double-quoted scalar grammar" },
    ]
  },
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
