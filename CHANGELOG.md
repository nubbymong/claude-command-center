# Changelog

All notable changes to Claude Command Center are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Generated file — do not edit by hand.** The source of truth is
> `src/renderer/changelog.ts`. After editing that file, run `npm run changelog`
> (CI enforces that this file is in sync via `npm run changelog:check`).

## [2.2.0] - 2026-08-02

> Insights can now look at all of your accounts at once: one click generates every account's report and then a combined report that compares them side by side.

### Added
- Insights: a "Run all" button generates a report for every signed-in account and then one combined cross-account report. It lines every metric the accounts have in common up side by side, marks the best and worst account for each, totals the counts, and adds a written comparison — where your work actually lives, which account is costing you the most friction, and what one account should copy from another. It appears once you have two or more accounts signed in; with a single account nothing changes.
- The combined report is kept alongside your normal reports and appears in the same dropdown as "All accounts", so you can go back to any earlier comparison. Each account's own full report is still generated and still there.

### Changed
- A combined report never invents a number, and never claims two accounts measured the same thing unless they agree that they did. Where accounts describe a metric differently the report shows both wordings and stops ranking them, rather than silently treating one account's definition as the shared one. Totals appear only where adding up actually means something, and are dropped entirely when the accounts cover reporting periods of different lengths — each column shows its own period so you can see why.
- Metrics only one account reported now get their own section instead of being dropped. In practice that is most of them, and it is often the most interesting part: a tool or a kind of error that shows up in one account and nowhere else says more than a metric you already had side by side. Each account's top tools, languages and goals are carried into the comparison too.
- If the written analysis cannot be produced, you still get the measured comparison and the report says so rather than quietly leaving it out.
- While a cross-account run is in progress it reports which account it is on, and finishing accounts no longer pull the report you are reading out from under you.
- Generating the combined report costs roughly a tenth of what it did: it is now handed the comparison CCC has already worked out rather than every account's full metric dump. That also makes it a better report, because the alignment is done before the analysis starts instead of during it.
- Generating Insights is far cheaper. Each analysis was quietly loading everything your account has configured — every connected tool server, every skill, your instruction files — into a job that only needed to read one report. Measured on a real setup that was about 193,000 words of context per account; it is now about 14,000. Nothing about the analysis itself changes.

### Fixed
- Insights now tells you when an account needs signing in again, on the Insights page itself, with a button that signs it in. Previously an expired sign-in showed up as an unexplained "KPI extraction failed" and there was no way to tell which account was the problem — the report generated fine, so nothing looked broken, and the metrics simply never appeared. A combined cross-account report also no longer loses its written analysis just because the primary account is the expired one.
- Insights: when the analysis step fails, the report no longer just says "KPI extraction failed" with nothing to go on. The full reply is saved next to the report, and the actual reason is written to the log. Previously the result was discarded even when the work had already been paid for.
- Insights: the analysis result is read back much more tolerantly. Anything wrapped in explanation or code fences is now recovered instead of thrown away, which previously lost a complete and correct analysis. A result that arrives cut off part-way is still rejected rather than half-saved, so you never see a report built from a fragment.
- Multi-account: a report was able to compare itself against the wrong run — a combined cross-account report could be picked as the "previous run" for a single account, so the trend arrows were measuring against something unrelated. Comparisons now only ever pair a single account with its own earlier reports.

## [2.1.0-beta.5] - 2026-08-02

> A runtime refresh. CCC now runs on Electron 43, with the terminal backend and the local database updated to match. No feature changes: this build exists so the beta channel is actually running what the beta line has been carrying.

### Changed
- Updated the application runtime to Electron 43, which brings a newer Chromium and Node.js underneath CCC. A foundation update with no feature changes, carrying the browser and platform security fixes released with those versions.
- Updated the two native components CCC depends on: the terminal backend that runs your sessions, and the local database that stores transcripts and usage. Both were rebuilt against the new runtime and exercised in a real launch before this release. Existing data is unchanged and nothing needs migrating.
- Updated the screen-capture component used when you attach a screenshot to a session.
- Updated the build pipeline that produces and publishes the installers. No effect on the application.

## [2.1.0-beta.4] - 2026-07-31

> Security fixes for the session-launch path, and 1M-context models now launch correctly on macOS. Recommended for everyone on the beta channel.

### Fixed
- Selecting a 1M-context model (Opus 1M) now launches correctly on macOS. The model name contains square brackets, which the macOS default shell treats as a filename pattern, so the whole launch command was aborted before the session started and nothing appeared to happen.
- Restoring a session on Windows no longer mangles the paths CCC passes to Claude. The default data folder contains a space and the relaunch was splitting on it, which could silently drop per-session settings and turn the leftover text into an accidental first prompt.
- Extra command-line arguments set on a config can no longer override the flags CCC manages for a session, including its per-session settings file. Certain spellings slipped past the existing check.
- Regenerating the changelog no longer fails when a comment in the source contains an apostrophe. Developer tooling only.

## [2.1.0-beta.3] - 2026-07-31

> Ctrl+V pastes into terminals — which also makes voice dictation and text expanders work — Check for Updates can install the update it finds, and a broad round of security hardening lands across the local tools server, the updater and the bundled dependencies.

### Changed
- Updated bundled dependencies to close 12 published security advisories, plus two more found while checking. No feature changes.

### Fixed
- Ctrl+V now pastes into terminals. Previously only right-click pasted: Ctrl+V was passed straight through to the session as a raw control code, which a shell happened to treat as its own paste command, while Claude ignored it entirely. Cmd+V, Shift+Insert and Ctrl+Shift+V work too, and if the clipboard has no text CCC now says so instead of appearing to do nothing.
- Voice dictation and text-expander tools now work in terminals. Tools of that kind type into whatever is focused by copying text and sending Ctrl+V, so they were silently doing nothing in a Claude session — the same root cause as above.
- Settings -> Check for Updates can now install the update it finds. It used to only report that one existed, leaving you to hunt for the small Update pill in the bottom bar. Open sessions are still saved before CCC restarts.
- Copying with Ctrl+Shift+C no longer fires for every open terminal at once, and no longer competes with a focused text box.
- Hardened the authentication check on the local Conductor server that Claude and Codex sessions use to reach the built-in CCC tools. Its token check accepted some malformed credentials it should have rejected, and a crafted request could make the check do far more work than it needed to. Both are fixed. The server still listens only on your own machine, and no session behaviour changes.
- Session, config, team and agent-template identifiers are now generated with a cryptographic random number generator instead of a predictable one. Existing items keep the identifiers they already have and nothing needs migrating.
- The in-app updater now verifies every installer it downloads against the SHA-256 checksums published with the release, and refuses to run one that does not match. Previously it launched whatever it downloaded, with no client-side check on any platform. If a download fails the check it is discarded and you are told why, rather than the update silently doing nothing.
- Fixed a flaw in how a session's conversation transcript was located. A machine you opened an SSH session to could name a file outside the Claude projects folder — a private key or token elsewhere on your drive — and CCC would open it and read its contents into that session's local transcript store. Transcript locations are now confined to the projects folder, and the status information a remote host sends is checked before it is used. Exploiting this needed you to connect to a host the attacker controlled, and the file contents stayed on your own machine. Advisory GHSA-hw7c-g5pw-w725.

## [2.1.0-beta.2] - 2026-07-29

> Resuming your work is far easier to read, your own Claude hooks now run in CCC sessions, and each config can set its own permission mode and CLI arguments.

### Added
- Each config can now set its own Claude permission mode and extra command-line arguments, instead of every session sharing one global setting.
- Sessions can be given a work name (renamed) independently of their config, so restored windows are recognisable at a glance. The startup "Resume previous sessions?" card is wider, lists each session on two lines so long names are not chopped, shows a count, and has a refresh button that picks up a session you restarted after launch.
- A development instance can now run alongside your installed copy with fully separate data, ports, and an amber DEV badge, so testing a change can no longer disturb your day-to-day sessions.

### Changed
- The Resume Conversation picker shown in the terminal is much easier to scan: it now fills the width of your window instead of being capped at a narrow column, leads each entry with a recognisable title (your session's work name when you renamed it, otherwise Claude's own summary of the conversation), and strips the slash-command markup that used to crowd out the actual content. Conversations that only showed "(continued session)" now show what they were about.

### Fixed
- Hooks you configure yourself now run in CCC sessions. CCC was replacing the whole hooks block with its own, so hooks from your user settings or a project's .claude/settings.json never fired in a CCC session even though they worked in a plain Claude session in the same folder. They are now merged, so a CCC session behaves like a normal Claude session in that folder, plus CCC's own hooks.
- The text cursor is visible and blinking again in shell terminals on Windows and macOS.
- Startup no longer freezes for roughly half a minute: two long synchronous sweeps during boot now run in the background.
- macOS: fixed the "A keychain cannot be found to store" error at launch, which was caused by CCC redirecting your home directory away from your login keychain.
- Multi-account: sessions belonging to a signed-in account whose per-account project folder had been orphaned are recovered, so cross-account resume finds your conversations again.

## [2.1.0-beta.1] - 2026-07-17

> Experimental Linux support — Claude Command Center now runs on Linux as an AppImage, alongside Windows and macOS.

### Added
- Linux (experimental): download the AppImage, make it executable (chmod +x), and run it. Verified on Ubuntu 24.04 and Rocky Linux 10; needs a modern glibc (2.39+, i.e. Ubuntu 24.04+, Rocky 10+, Fedora 40+). Older distributions are not covered by this build yet.

### Changed
- The in-app updater and the vision browser tool now understand Linux. On Linux the vision tool needs a deb/rpm build of Chrome or Chromium — the Ubuntu snap build is sandboxed away from the debug port, so vision stays off there.

## [2.0.0-rc.2] - 2026-07-15

> Release Candidate 2: terminal scrolling holds your place during live output, and relaunch reopens every session under its saved account — the first community-contributed fixes.

### Fixed
- Scrolling up with the scrollbar or keyboard now holds your place while a session streams output. Previously only mouse-wheel scrolling was recognised, so any other way of scrolling up got yanked back to the bottom by the next burst of output.
- Relaunching CCC reopens each session under the account it was closed with, instead of re-asking which account to use for every restored session.

## [2.0.0-rc.1] - 2026-07-10

> v2.0 Release Candidate 1: in-app updates work again, every signed-in account shows live usage, the stray blank browser window is gone, and a full dependency security refresh.

### Changed
- Security refresh: the one remaining vulnerable dependency (the WebSocket client used for browser automation) is patched, and the dependency audit is clean — 0 known vulnerabilities across the shipped tree.

### Fixed
- In-app update checks now find newer releases. Releases were being tagged against a stale commit, which mis-dated them so the updater never saw them; they are now tagged at the exact commit that was built, the updater scans the full release list, and it understands release-candidate versions.
- The all-accounts usage panel now shows live usage for every signed-in account — even ones you have not opened a session with recently. It quietly refreshes each account's short-lived key in the background, only for accounts with no running session or sign-in in progress. Your primary account is deliberately left untouched (its credentials are shared with Claude outside CCC) — it shows last-known usage until you open a session.
- Codex sessions no longer double-count cached input and reasoning tokens in the statusline and Tokenomics — token counts and dollar costs for cache-heavy Codex sessions were inflated (input could read nearly double).
- Fixed a blank browser window that could appear on startup (and linger after closing the app) when the browser/vision tool was enabled. The automation browser is now kept off-screen and is reliably shut down together with the app.
- The automation browser no longer runs Chrome's first-run setup on every launch, which was touching the desktop shortcuts and making the Chrome icon flicker on OneDrive-synced desktops.
- Codex sessions: the context meter now shows how full the context window actually is (the last request against the window), instead of the session's lifetime token total — which pinned the bar red at ~100% on long sessions whose window was mostly free.
- Resumed sessions: after the resume replay finishes, the terminal geometry is re-confirmed and the view repainted — targeting the garbled overlay text (stray line fragments over the input box) that could appear and persist after resuming a session.

## [2.0.0-beta.6] - 2026-07-08

> The all-accounts usage panel is far more reliable — no more spurious "Sign in" or "HTTP 429" on accounts that are actually fine.

### Changed
- When a live refresh can't complete (rate-limit, a network blip, or a lapsed token), the panel keeps showing each account's last-known figures with their age, instead of blanking the card.

### Fixed
- The account usage panel no longer loads every account at once, which was triggering rate-limit (HTTP 429) errors on perfectly valid accounts. Accounts now load staggered, with automatic retry, so a transient rate-limit recovers on its own instead of showing an error.
- Accounts that are still signed in no longer show a false "Sign in" prompt. Between sessions only the short-lived access token lapses — the account stays logged in — so the panel now shows the last-known usage (or a quiet "open a session to refresh") instead of a misleading Sign in button. A real Sign in appears only when an account genuinely has no credentials.

## [2.0.0-beta.5] - 2026-07-07

> Two SSH fixes: Conductor tools and the session status line both work again inside SSH sessions.

### Fixed
- Conductor tools (host screenshot and browser vision) work in SSH sessions again. The reverse tunnel that carries them was connecting to the wrong loopback address on the host — the server listens on IPv4 while the tunnel was landing on IPv6 — so remote sessions saw the connection close immediately. It now targets the right address.
- The session status line shows again in SSH sessions on Linux hosts (model, context, cost, and rate limits). Over SSH, Claude runs the status-line command without a terminal of its own, so the update was being dropped; it is now routed back through the session's terminal.

## [2.0.0] - 2026-07-02

> Claude Command Center 2.0: a guided first-run setup, an in-app Ask Command Center guide, a modernized engine, and a privacy pass that keeps every Claude config write per-session.

### Added
- New guided setup on first launch (and once after this upgrade): pick your theme, point CCC at your Claude install, see how accounts and GitHub connect, and switch on exactly the features you want. Every step shows real state from your machine, and nothing runs or gets enabled without you seeing it.
- A live guided tour follows setup: coach marks anchored to the real app walk you to your first session. The old static tour and the stack of first-launch popups are retired.
- Ask Command Center: the ? button in the sidebar opens a searchable guide to every feature, or hands your question to a Claude session primed with the app's docs so you can ask in plain language.
- Built-in tools are now under your control: a master switch plus per-tool toggles (vision, code review, host transfer) in setup and Settings, enforced everywhere a session spawns: local, SSH, and Codex.
- The status line has a real master switch: turn it off and CCC stops injecting it into sessions entirely, local and SSH alike.
- Codex support is now clearly marked Beta with its own master switch, and you can sign in during setup with the browser flow or an API key. Off means off: Codex configs are marked disabled (with the reason) and will not launch while the master is off.

### Changed
- Engine modernization: Electron 42, React 19, xterm.js 6, Vite 7, and TypeScript 6. A faster renderer on a current Chromium security baseline.
- Privacy pass: the status line and the Conductor MCP server are now delivered per session instead of being written into your global Claude config, legacy global entries are cleaned up on boot, per-session SSH files are swept on close, and your ~/.claude/CLAUDE.md is never touched.
- Claude Code 2.1.195+ renders its questions with clickable answer options; inside CCC a stray terminal click could select one, so they are switched off by default and answers stay keyboard-driven. Opt back in under Settings, General, Terminal.
- CCC Sentinel and cloud-agent permissions now default to off. Both are opt-in, with the ask made plainly during setup, so nothing spends tokens or grants permissions without your say-so.
- Agent Hub is reorganized into Tasks, Pipelines, and Library, with clearer first-run guidance.
- Insights reliability round: runs compare against the previous run of the same account, concurrent runs are locked per account, failed runs and KPI-extraction failures are surfaced instead of silently vanishing, and KPI extraction no longer bypasses permissions.
- Security hardening: external links open only over verified https, config files are validated as they load, the vision browser's debug port binds to loopback only, memory files are contained against symlink escape, and all known dependency vulnerabilities are resolved (undici, ws).

### Fixed
- Alt+V now pastes copied image files (not just screenshots), with inline feedback when the clipboard has no usable image.
- Each rate-limit window in the status line shows its own reset time (5-hour and weekly), instead of one shared timestamp.

## [1.5.45] - 2026-06-14

> CCC Sentinel's status dot now only turns amber when a finding actually affects your setup.

### Changed
- The Sentinel status dot is graded by reachability: amber means a compatibility finding reaches the accounts and features you actually use, and a calm grey state shows once you have reviewed the report.

## [1.5.44] - 2026-06-14

> Light theme: Claude sessions now start with a matching light terminal theme.

### Fixed
- When CCC is in light mode, new Claude sessions are told about it (via the standard COLORFGBG signal) so Claude picks its light terminal theme instead of rendering dark-on-light. Applies to newly started sessions.

## [1.5.43] - 2026-06-14

> The Copilot AI-credits meter now tracks your current billing cycle, with a progress bar.

### Changed
- The Copilot chip counts credits used in the current billing cycle instead of a lifetime total, and gains an inline progress bar matching the Claude rate-limit meters.
- Copilot meter configuration (including your plan's included-credits cap) now lives in Settings, Status Line, next to the other status-line elements.

## [1.5.42] - 2026-06-13

> GitHub settings, round two: re-auth now targets the right account and asks only for what it needs, and a Copilot usage meter lands in the session status strip.

### Added
- A Copilot AI-credits meter in the session status strip, with a toggle to show or hide it.

### Changed
- Re-auth requests are additive and minimal: the scopes asked for are derived from the features you actually have enabled, so you never grant more than the app uses.
- GitHub settings are recomposed account-first, with one consistent panel per account and an app-wide group for the settings that span accounts.

### Fixed
- Re-authenticating a GitHub account now works per account and per auth kind (OAuth, PAT, or gh CLI), fixing the long-standing bug where re-auth could target the wrong profile or silently do nothing.

## [1.5.41] - 2026-06-13

> Copy the CCC Sentinel compatibility report to your clipboard.

### Added
- The Sentinel report gains copy buttons: copy the whole report or a single finding, ready to paste into an issue or a Claude session.

## [1.5.40] - 2026-06-13

> Fix: conversations recorded outside a CCC session now show up in the resume picker.

### Fixed
- The resume picker now surfaces and resumes conversations that were recorded without a companion log folder (for example, work done directly in a repo before or outside CCC sessions). Existing conversations are backfilled on the next scan.

## [1.5.39] - 2026-06-13

> GitHub settings are rebuilt around your accounts, plus a batch of fixes: first-launch prompts no longer stack, the Sentinel watcher no longer hangs, and the Tokenomics cost donut is cleaner.

### Added
- GitHub settings are rebuilt around accounts. Each connected account gets its own panel with a Status and permissions tab and a Features tab, so you can see and control each account on its own terms instead of one flat list.
- A new "Features for all accounts" master section sits above the per-account panels: each feature shows a tri-state (on, off, or mixed across your accounts) with an "apply to all accounts" action to set it everywhere at once.
- Per-account feature toggles. Turn features like active PR, CI, reviews, linked issues, notifications, and AI credits on or off for each account independently, with the state held per account.

### Changed
- Honest re-auth surfacing. When a feature is switched on for an account whose token cannot power it yet, the account now shows a clear "switched on but needs re-auth" state instead of silently doing nothing, and a collapsible "what each feature needs" reference shows which scopes the features you enabled require.

### Fixed
- First-launch prompts (logging consent, What's New, setup steps) now appear one at a time in priority order instead of stacking on top of each other.
- CCC Sentinel's background compatibility analysis no longer hangs on a shared login or leaves stray claude processes behind: it now runs against one of your signed-in accounts and tears the whole process tree down on timeout.
- The Tokenomics cost donut no longer shows a "<synthetic>" slice; those system rows are labelled and excluded from the cost breakdown.

## [1.5.38] - 2026-06-12

> Memory is now a full dashboard -- KPIs, charts, ranked projects, drilldown, and a reading drawer -- and the Sentinel status dot is now a labelled chip.

### Added
- The Memory page is rebuilt as a dashboard: a KPI strip (memories, projects, total size, stale over 30 days, and an index-health KPI that replaces the old warning banner), an activity area-chart, and a type donut for the whole store.
- Ranked project list with staleness dots, index warnings, and live-session chips. Click a project to drill in: a sortable memory table plus a sessions rail where live sessions jump straight to the terminal and recent sessions deep-link into the Logs viewer.
- New reading drawer for distraction-free memory reading, and the search view restyled to match.

### Changed
- The Sentinel status dot is now a persistent labelled "Sentinel" chip, so the compatibility watcher is easier to find.

### Fixed
- The memory scanner no longer warns about custom frontmatter fields or types, silencing hundreds of spurious warnings on stores with custom metadata while keeping real signals.

## [1.5.37] - 2026-06-11

> New: CCC Sentinel -- an opt-in watcher that flags when a Claude Code update might affect the app, plus Memory and Hooks fixes.

### Added
- CCC Sentinel (opt-in, fail-open) detects Claude Code version changes on startup, checks the CC changelog against CCC's compatibility assumptions, and surfaces findings in a status dot plus a panel. It proposes model and effort registry fixes you apply yourself (never automatically) and reports compatibility for everything else. Toggle it in Settings, CCC Sentinel.

### Changed
- A new hot-reloadable model and effort registry replaces around ten hardcoded model-identity sites, so an unknown or brand-new model now gets a colour, a label, and flagged pricing instead of vanishing.
- Memory scanning now runs off the main thread, so opening Memory on a large store no longer stalls the UI. Spurious "unknown frontmatter field" warnings for the standard metadata block are gone, and the close button is back on sessions.

### Fixed
- Raised the hooks request body cap from 256 KiB to 4 MiB so large file-edit events are no longer dropped from the activity feed; the first oversized payload per session is now logged.

## [1.5.36] - 2026-06-11

> Three big workstreams land: Logs v2 (a chat-transcript viewer), a ground-up Tokenomics rebuild, and the removal of the permission tray.

### Added
- Logs v2: a clean-slate transcript system. CCC indexes Claude's own conversation transcripts and renders them back as a readable chat with a timeline rail and full-text search. Restart and relaunch now resume the conversation you were actually in, worktree-aware. The old logging stack is removed.

### Changed
- Tokenomics is rebuilt on its own background indexer that reads ALL transcripts including subagent and sidechain files (the old scan missed around half the events), dedups globally, computes cost at query time from live pricing, attributes by config, and opens instantly with an indexing state and a green nav badge.
- Heads up: life-to-date spend will read LOWER than the old page. The old ledger priced Opus at a stale 3x tier and double-counted statusline costs. The new number is the deduped API-equivalent at current pricing.
- Security: dependency updates (vitest, ws, hono, tmp). The Electron 38 to 39 upgrade is deferred to a dedicated task.

### Fixed
- The permission tray has been removed. Claude's permission notifications are generic and fire for auto-approved subagent tools, producing phantom cards no heuristic could filter. The session attention pulse is kept.

## [1.5.34] - 2026-06-09

> Fix: closing all your sessions now reliably means no resume prompt on the next launch -- even when you update via the installer.

### Fixed
- The "Resume previous sessions?" prompt no longer offers sessions you already closed. Your open sessions are now saved continuously as you open and close them, so the next launch always reflects what was actually open -- even if the app was force-closed by an external installer or a crash (which previously left a stale list and re-offered phantom sessions). Close everything, and there is nothing to resume.

## [1.5.33] - 2026-06-09

> Fable 5 support -- Anthropic's new flagship model (the tier above Opus) is now a first-class choice across the app.

### Added
- Fable 5 is now selectable in the session model dropdown and the agent/config model pickers. It is Anthropic's most capable model (the tier above Opus) and runs roughly 2x faster than Opus.
- Tokenomics now prices Fable 5 correctly out of the box ($10/$50 per 1M tokens) and gives it its own colour in the model breakdown, so Fable spend is tracked and shown distinctly. LiteLLM live pricing still wins when reachable.

## [1.5.32] - 2026-06-06

> Critical fix: importing your existing logs no longer freezes the app. Tested against a real 16 GB log set, with live progress, a completion notice, and safe interruption.

### Added
- A notice now appears when the log import finishes, wherever you are in the app, with a View report shortcut to the reconciliation report. If anything failed it says so clearly, and nothing is deleted.
- Closing the app while a log import runs now asks first. Quitting is safe: the import stops cleanly and continues from where it left off the next time you run it.
- New startup choice for saved sessions: Resume or Don't open. You are no longer forced to resume your saved sessions on every launch.

### Fixed
- Importing existing logs no longer freezes the app. The import now runs entirely in the background logging worker, streams the data in small pieces, keeps the app fully usable throughout, and shows live progress. Verified end to end against a real 16 GB, 990-session log set.
- An interrupted log import is now safe by design: anything already imported stays, the interrupted session is automatically redone on the next run, re-runs skip completed sessions instantly, and the permanent space reclaim stays locked until an import completes 100% cleanly.
- The per-session Logs pane no longer goes blank after running /clear in a session. The replay now keeps the full history scrollable and marks where the screen was cleared with a divider. Your captured logs were never lost; this was purely a display issue.

## [1.5.31] - 2026-06-05

> More accurate per-account cost tracking under the hood, plus a clearer warning in the account attribution tool.

### Changed
- Per-account cost tracking is now anchored to a stable account id captured when each session starts, so your usage stays attributed to the right account even if you later rename that account or change its sign-in email.
- Daily cost totals now keep a per-account breakdown, so your per-account spending history stays correct over time even as older session details age out.

### Fixed
- The account attribution tool now explains that its email suggestions come from a history that records one sign-in at a time, so they can be wrong for a setup that ran several accounts at once. Double-check each before applying, or mark a group as mixed.

## [1.5.30] - 2026-06-04

> Critical multi-account stability: upgrades no longer disrupt a running session memory, and your last-used account survives a crash.

### Fixed
- Upgrades no longer disrupt session memory. A session left running across an app update could end up pointing at an old per-session home that the update had cleaned away, so on resume it looked like it had lost its memory. The update now keeps those old homes and re-points them at your shared memory store, so resuming or switching accounts across an update always reaches the same memory. No data was affected, your memory is shared as designed.
- Your last-used account now survives a crash. The account you pick for a session is saved to disk immediately instead of only on a clean close, so after an unexpected shutdown a session still defaults to the account you last used for it.

## [1.5.29] - 2026-06-04

> Keeps your Claude login working in scripts outside the app, read each session effort and fast mode at a glance, with a tidier, more consistent dark and light theme, plus a new terminal-health view in the Conductor diagnostics.

### Added
- Session cards now show a colour-coded effort pill (Low through Ultracode) in the top-right, tinted from green to red as effort rises, so you can read each session effort level at a glance without opening it.
- Session cards now show a lightning bolt when a session is running in Fast Mode, so you can spot fast-mode sessions at a glance. It appears only while Fast Mode is actually on and clears the moment you turn it off.
- The Conductor diagnostics console gained a PTY integrity section with live terminal metrics per session (bytes received, resize events and width desyncs) to help track down terminal display glitches.

### Changed
- The effort pill now waits for live data before it appears, so a card no longer briefly shows a stale or default effort (for example XHIGH) before the real level loads. A restarted session stays calm until its new effort is known.
- Tidied the session cards by removing the small leading dot. It only showed grey when idle and duplicated the status pill already shown on the right.

### Fixed
- Running the Claude CLI outside the app (e.g. claude -p in your own scripts) no longer breaks authentication. The app now keeps your real Claude login in lockstep with your main account, so a token refresh inside a session never leaves your outside scripts on a dead login. Only your main account's token is mirrored, and only when both sides are still that account.
- Themed the Settings pages and the top and tab bars to match the rest of the app, removing the leftover near-black backgrounds and making dark and light mode consistent throughout. The window background now follows the theme instead of staying dark in light mode.

## [1.5.28] - 2026-06-02

> Per-account statusline stats, settable account colours, and the account follows a mid-session sign-in.

### Added
- Set a colour for each account in Settings that sticks, so you can tell your accounts apart at a glance.

### Fixed
- Each account now shows its own usage and rate limits in the statusline. Previously the usage numbers could briefly show another account figures.
- When you sign in to a different account inside a session, the account name and colour now follow the new account.
- Your captured main account now shows its email instead of a generic placeholder name.

## [1.5.27] - 2026-06-02

> Per-session account isolation, plus a safety backup of your Claude config taken before anything runs.

### Added
- Safety backup: on first launch the app snapshots your existing Claude login and settings to a backup folder before the multi-account feature does anything, so your original login is always recoverable.

### Fixed
- Two sessions running the same account are now fully isolated. Previously they shared one login on disk, so signing into a different account in one session changed the other and could overwrite the saved account. Each session now gets its own private home.

## [1.5.26] - 2026-06-02

> Multi-account is always on and clobber-proof: your accounts are protected and signing in never overwrites your main login.

### Added
- No on/off switch any more. On first run your current Claude login is captured into a protected account, and every session runs under a saved account, so you are multi-account ready from the start.
- New account detection: run /login as a different account inside a session and CCC offers to add it as a separate named account, keeping your original account intact.

### Changed
- The Accounts list shows every account the same way, with the captured original marked as primary (and never deletable).

### Fixed
- Your main login can no longer be overwritten. A session never runs on the bare global login, so running /login in a session can no longer replace the account you are signed in with globally.

## [1.5.25] - 2026-06-01

> Sessions now genuinely run under the account you choose, with no impact on your other tools.

### Changed
- Zero degradation to your other tools: each account home mirrors your real home, so git, ssh, npm and the rest behave exactly as before. Only the Claude account is private; your memory and history stay shared.
- Cleaner session cards: removed the redundant right-side dots. The account colour dot stays next to the account name.

### Fixed
- Added accounts are now truly isolated. Previously only the credentials were separated, not the account identity, so a session could still run as the wrong account. Each added account now runs under its own private home, so the account you pick is the account Claude uses.
- One-time after this update: re-run /login once per added account so it re-establishes its isolated login.

## [1.5.23] - 2026-06-01

> Pick the account a session runs under when it starts, and a clearer Accounts list.

### Changed
- Account is now chosen when a session starts, not saved on the config. The first time a session launches you pick which account it runs under, so the account stays a live choice rather than a buried setting.
- The Accounts list in Settings now shows each account by its email, with a clearly labelled Name field below it to give the account a friendly label. Add and remove accounts as before.
- The start-session account picker now shows the friendly name you gave each account, including your default account.
- Added the independent-project disclaimer to the startup splash screen.

### Fixed
- If you run /login inside a session and change account, the status strip, session card and statusline now update to the new account (previously they stayed on the account the session started with).
- You can now switch a session between your Default account and a single added account from the status strip (previously this needed two added accounts).
- Removed the leftover Setup Statusline command from existing setups.

## [1.5.19] - 2026-06-01

> Run multiple Claude accounts in CCC: add accounts, switch per session, keep them isolated.

### Added
- Multiple accounts: add a second or third Claude account and run different sessions under different accounts. A first-run prompt walks you through it, and you can manage accounts anytime in Settings then Accounts.
- Switch a session to another account from the status strip pill or the right-click menu (it respawns and resumes under the chosen account). Signing in or out of an added account never touches your other accounts.

### Changed
- The status strip shows which account a session is using, and the account chip now resolves correctly for single-account users.
- Effort level now reflects live /effort changes in the status line, and you can toggle the Effort and Account elements in Statusline settings.
- Removed the Mode pill from the status strip (use Shift+Tab to change permission mode) and the redundant Setup Statusline command.

## [1.5.18] - 2026-05-31

### Changed
- Permission tray no longer shows a card for the session you are currently viewing (Claude prompts you right there). The card appears if you switch to another session while the prompt is still waiting.
- Added a footer note clarifying this is an independent project, not affiliated with or endorsed by Anthropic.

### Fixed
- Permission cards now reliably show which tool and command Claude is asking about, even when several tools run at once.
- Permission cards are now mouse-only: they never steal keyboard focus or interrupt your typing, and a stray Enter or Escape can no longer action a card.

## [1.5.17] - 2026-05-31

### Added
- Each card has Go to session and Ignore; a Settings toggle disables the tray.

### Changed
- Permission tray now surfaces only genuine prompts Claude is blocked on, honoring your Claude settings (no more cards for auto-approved commands).

## [1.5.16] - 2026-05-30

### Added
- Permission tray: approve or deny any tool request from one place, across all sessions

### Changed
- Attention indicator no longer re-fires when you revisit a session

### Fixed
- Effort level now shows permanently in the status line
- Settings toggles no longer overlap their labels

## [1.5.15] - 2026-05-29

> Removes the per-session account alias feature. Showing which Claude account a session is on is not reliable without isolating each session's config (which would fragment your shared memory and settings), so the alias label on session rows, the right-click Account tagging, and the Settings account-alias list are gone. Per-account spend tracking on the Tokenomics page is unaffected.

### Changed
- Removed the session account-alias feature: the alias label on session rows, the right-click 'Account' tagging menu, and the Settings account-aliases list. Claude exposes no reliable per-session account signal (it is global / last-login only), so the labels were frequently wrong whenever more than one account was in use
- Tokenomics per-account spend (the Account filter and group-by-account view) is unchanged -- it uses a separate ledger-side mechanism, not the live session label

## [1.5.14] - 2026-05-29

> Polish pass: the session duration in the status strip now reads as hours and days past an hour (no more '1731m 38s'), the Permission Attention Tray stops false-flagging safe commands, and sessions whose saved folder no longer exists open in your home directory instead of dying on launch.

### Fixed
- Status strip: session duration rolls up to hours past 60 minutes and days past 24 hours, showing two units max (e.g. '1d 4h'). Long-running or resumed sessions no longer show an unreadable raw-minutes count
- Permission tray: `git push --force-with-lease` (the safe push form) is no longer flagged as a high-risk force-push, and `sudo` detection only fires when sudo is the command being run -- not when it appears inside a quoted string or a path like /etc/sudoers
- Sessions with a working directory that no longer exists (a deleted worktree, an un-cloned repo, a demo path) now fall back to your home directory instead of exiting immediately with '[Process exited with code 1]'

## [1.5.13] - 2026-05-29

> Day-two Opus 4.8 polish: Ultracode effort level (xhigh + automatic dynamic workflows), a global Disable Claude Code dynamic workflows toggle in Settings > Security, and new tour + tips entries for the Permission Attention Tray and Dynamic Workflows so they actually show up in /help.

### Added
- Effort dropdown: **Ultracode** option added. Sets `--effort ultracode` so Claude Code (2.1.154+) automatically plans dynamic workflows for every substantive task. Resets when you start a new session
- Settings > Security: **Disable Claude Code dynamic workflows** toggle writes `disableWorkflows: true` into the per-session Claude settings so workflows are off for newly spawned sessions. Applies on next spawn; existing sessions keep their setting
- Tour: dedicated **Permission Attention Tray** step covering the high-risk Bash patterns, the 50-entry cap, and how the gateway intercepts before Claude runs the command
- Tour: dedicated **Dynamic Workflows** step covering the three ways to invoke (workflow keyword, Ultracode, /deep-research), the /workflows progress view, the 1000-subagent cap, and the global disable

### Changed
- Tips: new entries for the Permission Tray and Dynamic Workflows so the contextual tip system surfaces them after first use

## [1.5.11] - 2026-05-29

> Opus 4.8 lands as the new default, with Extra high effort and a Fast mode toggle (2.5x speed at 2x cost). The Permission Attention Tray from v1.5.10 is now actually wired -- v1.5.10 shipped the toast stack but the hook injection was disabled, so no toast ever fired; v1.5.11 fixes the wiring and ties it to Claude Code's real PreToolUse hook.

### Added
- Opus 4.8 default: new Claude sessions land on Opus 4.8 (Anthropic's newest model, released 2026-05-28). The model dropdown uses the `opus` alias so the default stays current as Anthropic releases new versions
- Effort levels: Extra high (xhigh) and Max added to the Session dropdown; Opus 4.8 supports xhigh as its hardest-task setting
- Fast mode toggle for Opus 4.8: 2.5x speed at 2x cost ($10/$50 per 1M tokens vs standard $5/$25). Tokenomics tracks Fast spend through a separate `<model>-fast` pricing row

### Changed
- Tokenomics: hardcoded fallback pricing for Opus 4.8 + 4.7 ($5/$25 standard, $10/$50 fast). LiteLLM live pricing still wins when reachable

### Fixed
- Permission Attention Tray wiring: v1.5.10 had injectHooks disabled and the gateway only matched a 'PermissionRequest' event Claude Code never fires. v1.5.11 re-enables hook injection per Claude session, ties the gateway to the real PreToolUse hook for Bash, and updates the disposition rule so the tray only fires for the high-risk patterns (rm -rf, sudo, force-push, dd, mkfs, chmod 777, fork bombs)

## [1.5.10] - 2026-05-28

> V2 UX uplift across Tokenomics, Insights, Logs, Settings, and Agent Hub -- plus a new Permission Attention Tray for high-risk Bash prompts. Insights drops its iframe and renders natively, Logs paginates large buffers, and Tokenomics gains a Project / Account / Model group-by lens.

### Added
- Permission Attention Tray: high-risk Bash commands (rm -rf, dd, mkfs, force-push, etc.) now stack as toasts in the top-right corner. Keyboard shortcuts let you approve or reject without scrolling back to the prompt; auto-allow handles read-only commands transparently
- Tokenomics: new Group by lens (Project / Account / Model) pivots the breakdown panel + sessions table without re-running anything

### Changed
- Insights: native renderer replaces the iframe + injected dark theme CSS, so the report loads faster, follows your theme cleanly, and inherits the V2 surface tokens
- Logs: chunked virtualization (500 entries per page with a Load older button) plus incremental filter diff -- big session logs no longer freeze the UI
- Settings and Agent Hub: V2 primitive pass (StatusDot, MetricChip, SectionLabel, Kbd) and accent-token rails for tab + filter selection
- TitleBar and Session Status Strip lifted onto the V2 raised-surface tier so they read as a single instrument cluster against the chrome below

### Fixed
- Cloud agent status colours now go through semantic tokens; status dot uses the StatusDot primitive (no more broken hex+alpha concat on the box-shadow)

## [1.5.9] - 2026-05-27

> Account labels are now user-managed -- you set them once in Settings and tag any session by right-click. The v1.5.7 auto-detected email chip was structurally unreliable (the field it read is global, not per-session) and has been removed.

### Added
- Settings > General > Account Aliases lets you keep a short list of email + alias rows; right-click any session in the sidebar to tag it with one. The alias shows after the project name in non-bold text

### Fixed
- Removed the per-session account-email chip from the session header and status strip -- it was reading a global file and could display the wrong account when you switched logins in another session
- Use this repo: clicking on a freshly-spawned session now persists correctly instead of silently doing nothing (regression introduced in v1.5.8 where the session state had not yet been flushed to disk before the IPC write)

## [1.5.8] - 2026-05-27

> Three bug fixes: 'Use this repo' in the auto-detect banner now persists across restarts and skips the Settings detour when you are already authed; the Codex MCP server's 'Session not found' 404 now logs diagnostics and returns an actionable recovery message.

### Changed
- Conductor MCP /messages 404 now logs the requested transport id, active-transport count, sample ids and user-agent, and returns a multi-line recovery message instead of a bare 'Session not found' (helps when Claude reports the Codex review tool as unavailable mid-session)

### Fixed
- Clicking 'Use this repo' in the auto-detect banner now writes the repo to the parent saved config (not just the live session), so the selection survives an app restart
- When at least one GitHub auth profile already exists, 'Use this repo' enables the integration in place and auto-picks a matching profile by repo or username -- no more bounce to the Settings tab

## [1.5.7] - 2026-05-27

> Your account email is back in the status line and session header -- coloured per account -- and you can now pin a fixed colour to any account in Settings. The Update pill also appears on its own now, without needing a restart.

### Added
- Assign a fixed colour to any account email in Settings > General > Account Colours. Detected accounts are listed automatically, or add one manually; the chosen colour tints that account's email everywhere it shows

### Changed
- The app now re-checks for updates periodically and when the window regains focus, so the Update pill appears on its own instead of only after a manual restart

### Fixed
- The active account email is shown again in the per-session status line and the session header, coloured per account -- it was dropped during the V2 shell refactor

## [1.5.6] - 2026-05-26

> Identity colours now span the full hue wheel so sessions are instantly distinguishable, the GitHub panel slides in when shown, and a few first-launch papercuts are fixed.

### Changed
- Identity colours are re-tuned across the whole colour wheel (blues, teals, greens, ambers, oranges, roses, purples) so saved configs and active sessions are instantly distinguishable in the left rail, tabs, and inactive dots -- not all variations of purple
- The GitHub panel now slides in and fades when shown, and the collapsed floating logo button fades in (both respect reduced-motion)

### Fixed
- The Claude service-status pills (Code / Claude.ai) now appear immediately on launch instead of staying blank until the first background poll minutes later
- Pasting an image with Alt+V now works on the first try -- previously the first attempt after copying could report 'no image detected' until you typed something (a Windows clipboard timing quirk)

## [1.5.5] - 2026-05-26

> Bottom-region rework from UAT: the per-session status line now sits directly above the command rows, CLI/version is a slim status bar at the bottom-left, and the GitHub panel ends above the command rows with a floating logo button when collapsed.

### Changed
- The per-session status line (model, tokens, context, rate limits) and the Mode / Model / Compact / Restart controls now sit directly above the command rows, where the old context bar lived
- CLI, version and channel are now a slim global status bar pinned to the bottom-left of the window, spanning the full width -- separate from the per-session status line
- When the GitHub panel is collapsed it is now a floating GitHub-logo button in the top-right corner instead of a thin vertical bar (with a coloured hover)
- The update notification is no longer duplicated. The large 'Update Available' card is gone; the status-bar Update pill gently pulses when an update is ready
- Command chips and the Mode / Model / Compact / Restart controls restyled into one consistent set; the model name shows properly and Restart is set apart

### Fixed
- The GitHub panel no longer stretches down past the status line and command rows. It ends above them, beside the terminal
- The 'New: GitHub sidebar' onboarding popup no longer reappears on every launch once you have a GitHub account configured

## [1.5.4] - 2026-05-26

> V2 shell polish from first-look feedback: the bottom instrument bar now sits under the terminal only, inactive sessions keep their identity colour, and the global/custom command rows follow the theme.

### Fixed
- The bottom instrument bar is now scoped to the content area instead of spanning the full window width underneath the sidebar
- Inactive sessions keep a muted identity-colour rail, so you can still tell sessions apart at a glance; the selected session shows the full rail, tint, and border
- Global and custom command rows now use the theme's surface tokens instead of a fixed dark background, so they follow light and dark correctly

## [1.5.3] - 2026-05-26

> V2 command-center shell -- a ground-up visual redesign: dense session cards, a single bottom instrument bar, a cleaner header and terminal framing, light/dark theming, and per-session identity colours.

### Added
- New 'Command Workbench' shell. The session list is rebuilt as dense two-line cards with an unmistakable selected state (identity rail, tint, elevation, bold name, chip); health reads only as a status dot and pill; keyboard focus is a quiet dashed ring distinct from selection
- Single bottom instrument bar replaces the old status bar, the per-terminal context bar, and the dead toolbar: runtime (CLI, version, channel, update) on the left, live session telemetry inline in the middle, and Mode / Model / Compact / Restart controls on the right
- Per-session identity colours, resolved per theme, shown consistently on cards, tabs, and the header accent -- a curated non-status palette that never collides with running/warning/error status or the teal focus ring. Legacy session colours are migrated once, with a dismissible notice
- Light and dark themes with a one-click Light/Dark flip in the title bar; the full Dark / Light / System choice lives in Settings
- A passive breadcrumb strip in the header (working directory + detected repo), a quieter info-style repo auto-detect suggestion, and a collapsible command bar with neutral command chips

### Changed
- Context-aware empty state: with saved configs you get launch cards plus 'Show all configs'; with none, a clear 'Create a terminal config' action. Saved configs are reachable by keyboard, not hover-only
- Terminal container framing -- comfortable padding and a real left gutter so text no longer crowds the edge

### Fixed
- Theme toggle no longer shows duplicate icons or dead clicks -- every click reliably and visibly changes the theme
- Session attention pulse no longer re-fires when you simply switch away from a session; it only re-arms on genuine new keyboard input, not focus or mouse reports
- New branded startup splash

## [1.5.2] - 2026-05-24

> Per-session account attribution -- see which Claude/Codex account each session and dollar belongs to. Plus the Electron 38 engine upgrade.

### Added
- Per-session account attribution. The active account email now shows in the context bar, coloured deterministically per account, so you can tell at a glance which login a session is running under. Works for both Claude (read live from ~/.claude.json) and Codex (decoded from the session JWT)
- Tokenomics page gains an Account filter. Slice spend by account email, or by (Mixed) and (Unknown) for sessions that span logins or predate attribution
- Account attribution back-fill wizard. Historic sessions recorded before this release are bucketed by config and suggested an account from your ~/.claude backup timeline -- confirm, override, or mark mixed. Runs once on first launch and is re-openable from the tokenomics page

### Changed
- Removed the global account picker from the title bar. Attribution is now per-session and automatic -- no manual switching, and historic spend is never silently re-stamped to whoever is logged in now
- Electron 33 to 38 engine upgrade (Chromium 132 to 140). Newer rendering engine and security baseline under the hood

### Fixed
- Codex sessions no longer open to a blank terminal on Windows. ConPTY does not do PATH lookup, so the bare 'node' spawn failed silently -- now resolved to a full node.exe path
- Codex MCP handshake now speaks streamable HTTP alongside SSE, so the conductor tools (vision, codex review) connect correctly under Codex CLI 0.128+
- Codex resume picker reads the newer 0.133 rollout format, so resuming a Codex session lists the right sessions with readable labels instead of '(continued session)'
- GitHub sidebar can be collapsed when open, and its per-session enablement now persists across app restarts

## [1.5.1] - 2026-05-08

> Codex provider, mega release

### Fixed
- Removed the peak/off-peak indicator -- Anthropic no longer differentiates peak hours in their rate-limit policy, so the badge was reporting outdated information

## [1.4.3] - 2026-04-29

> New branded splash now actually shows on launch, plus a refreshed README with v1.4 feature highlights

### Changed
- README overhaul. Branded splash at the top, six new feature highlight cards (Excalidraw, Combined Mode, Insights, Logs, GitHub sidebar, Vision), accurate v1.4 feature audit, dedicated 'What's New' section, corrected installer naming, and a 'Defence in Depth' security subsection covering daily CONFIG backups

### Fixed
- Splash window now displays the new branded artwork. The 1.5 MB PNG was being inlined into a data: URL that exceeded Electron's loadURL size limit, so the window was created but never reached ready-to-show. Switched to writing the wrapper HTML to a temp file and loading via loadFile -- works for any image size

## [1.4.2] - 2026-04-28

> Safety-net daily backups of your CONFIG directory -- never lose a session list to a corrupted write again

### Added
- Daily auto-backup of CONFIG/*.json under CONFIG/_backups/YYYY-MM-DD/ on every app launch. Last 7 days kept, prunes older. Recovery is a manual copy back into CONFIG/ -- but the data is always there if anything goes sideways

### Fixed
- Capture-training script no longer destroys real config data on cleanup. PID lock prevents concurrent captures; cleanup only restores files it explicitly backed up; never blind-deletes by filename match
- Memory frontmatter writer now produces valid YAML for values containing backslashes, newlines, and other control chars. Previously only escaped quotes -- anything else round-tripped as malformed YAML. Switched to JSON-stringify which is a strict subset of YAML 1.2's double-quoted scalar grammar

## [1.4.0] - 2026-04-24

> GitHub sidebar -- PR, CI, reviews, linked issues, and session context next to the terminal

### Added
- New GitHub sidebar. Collapsible right panel that shows the PR for your current branch, CI runs, reviews, linked issues, local git state, and a session-context summary of what this terminal is working on
- Sign in with GitHub via OAuth device flow, fine-grained PAT, or gh CLI adoption. Nothing runs until you opt in per session
- Per-session enable with repo auto-detection banner. Ctrl+/ (Cmd+/ on Mac) toggles the panel
- PR-body reference scanning. Closes/fixes/resolves #N and owner/repo#N refs in a PR body all surface in the session context
- Notifications mini-section with mark-read, plus rate-limit and expiry banners on your auth profiles
- First-launch onboarding modal for the GitHub sidebar, with a Set up now button that deep-links into the GitHub settings tab

### Changed
- HTTP Hooks Gateway plumbing. Opt-in loopback 127.0.0.1 listener that receives tool-call, permission, and lifecycle events from your Claude Code sessions via per-session UUID secrets. No UI in this release - it's the foundation for desktop notifications and external automations in upcoming versions. Toggle under Settings > GitHub
- What's New modal fade-out now uses a shared 200 ms constant matched to the Tailwind transition, so the animation never truncates

### Fixed
- Right-click paste in terminals now respects bracketed-paste mode. Pasting multi-line text into Claude Code (or any other app that enables the mode) lands as a single atomic paste instead of submitting on the first newline
- Session labels no longer leak into Claude as user prompts. Dropped the --name CLI flag whose value was being split by Windows shell quoting, sending part of the label as the first message

## [1.3.1] - 2026-04-15

> First public release -- open-sourced on GitHub

### Added
- Command bar sections: drag commands into named sections, right-click to rename/delete, custom text colors, independent Claude/Partner row sections
- SSH statusline now shows full second line (rate limits, extra spend, peak/off-peak) -- fetches from Anthropic API on the remote
- Insights report links now open in your system browser instead of showing blank pages

### Changed
- Tips updated for new section features with trackUsage calls
- Pre-release checklist prompt added to release script

### Fixed
- SSH sessions now auto-start Claude (was broken for sessions without a post-connect command)
- SSH setup script no longer echoes binary text -- suppressed with stty
- Logs tab no longer freezes the UI -- async file reads with loading spinner
- Memory manager: 'originSessionId' recognized as valid field, warnings now expandable
- Insights KPI extraction: prompt piped via stdin instead of fragile shell arguments

## [1.2.166] - 2026-04-08

> Branching model: beta + main with promote flow

### Added
- New `npm run promote` command merges the beta→main PR and ships a stable release at the same version as the current beta
- New --no-bump flag on the release script reuses the current package.json version instead of incrementing -- used by the promote flow to keep beta and stable version numbers aligned
- New --ff-only and --yes flags on the promote script for partial/automated runs

### Changed
- New branching model: all feature work happens on the `beta` branch; the `main` branch is stable-only and receives fast-forwards from beta
- Release script now enforces branch ↔ channel correspondence -- --stable must run on main, --beta/--dev must run on beta (bypass with --skip-branch-check in emergencies)

## [1.2.165] - 2026-04-08

> Release script hotfix: cross-platform sleep + proper workflow watching

### Changed
- Run-ID detection picks the newest workflow_dispatch run regardless of branch, so the filter doesn't miss the just-dispatched run due to API pagination lag

### Fixed
- Local release script now uses Node-native sleep instead of shelling out to `timeout`/`sleep`, which was silently failing inside execSync and preventing the script from finding the dispatched workflow run ID
- Release script now surfaces real errors from the run-ID polling loop instead of swallowing them -- gives a useful hint if GitHub API is unreachable

## [1.2.164] - 2026-04-08

> Unified release pipeline + channel label on update button

### Added
- Check for Updates button now shows the active channel -- 'Check for Beta Updates' / 'Check for Stable Updates' / 'Check for Dev Updates' -- so you always know what you're checking against without opening the dropdown

### Changed
- Release script now dispatches the GitHub Actions workflow for canonical dual-platform builds (Windows EXE + macOS DMG, both signed/notarized, both VirusTotal-scanned, single release with checksums) instead of doing a Windows-only local build
- Local release script does fast smoke checks (typecheck + unit tests + build) for fast feedback before pushing to CI, then watches the workflow run to completion and verifies both .exe and .dmg are attached
- Release script now supports stable / beta / dev channels via --stable / --beta / --dev (default: interactive prompt with beta as fallback)

## [1.2.163] - 2026-04-08

> SSH statusline + unified MCP image transport + dual service status indicator

### Added
- Image paste, snap, and storyboard now work in BOTH local and SSH sessions via the conductor-vision MCP fetch_host_screenshot tool -- one unified code path, no path-vs-base64 hacks
- vision_screenshot returns inline image content directly -- no second Read tool call needed to view the captured browser screenshot
- Conductor MCP server now starts at app launch independent of browser/vision config so fetch_host_screenshot is always available
- Title bar service status redesigned: separate Claude Code + Claude.ai pills with colored dots, plus API status surfacing only when degraded

### Changed
- All screenshot capture sites cap longest edge to 1920px and use JPEG q85 (q78 for storyboard frames) to reduce token cost
- Clipboard paste regression fixed -- was sending raw base64 to the PTY, now uses saveImage path through the MCP fetch tool

### Fixed
- SSH statusline now updates: a tiny shim deployed to the remote ~/.claude emits an OSC sentinel via /dev/tty that the host parses out of the PTY stream (no SMB mount needed)
- 'Got it' tip button now actually clears the tip pill from the session header (markTipActed clears currentTipId)
- Snap, storyboard, and clipboard image resize now preserve aspect ratio -- was previously distorting non-square images by passing both width and height to nativeImage.resize()

## [1.2.162] - 2026-04-07

> Update system refactor: GitHub-only with stable/beta/dev channels + PTY dedupe

### Added
- Update checker now polls GitHub releases directly instead of a local WebSocket server
- New update channel selector next to Check for Updates button -- stable / beta / dev with full keyboard accessibility
- Dev channel for experimental builds (alongside existing stable and beta)

### Changed
- Update checker works without gh CLI once the repo is public (tries public GitHub API first, falls back to gh CLI only when needed)
- Safer update downloads: HTTPS-only redirects, Windows retry safety (unlinks stale files before rename), no shell injection risk
- Proper prerelease ordering (beta.2 > beta.1, final > beta)
- CI workflow on every PR -- typecheck, tests, build on both Windows and macOS

### Fixed
- Duplicate Claude prompts: PTY now suppresses identical submitted payloads within 300ms (prevents double-sends that triggered rate limits)

## [1.2.161] - 2026-04-07

> Intelligent tips system with 26 seed tips and transparency disclosures

### Added
- Animated tip pill in the session header shows contextual, one-per-session feature discovery hints
- Clicking a tip opens a platform-aware modal with full details, optional navigation, and dismiss/silence controls
- New Transparency category: explicit tips about statusline injection, Vision MCP, session logging, credential storage, resources folder, and all network activity
- Usage tracking persists to CONFIG/usage-tracking.json -- tips intelligently skip features you've already used or show 'did you know' variants
- Toggle 'Show intelligent tips' in Settings > General to disable the system

### Changed
- Platform-aware tip copy: Partner Terminal, Credential Storage, Resources Folder, and Session Logs tips show correct Windows vs macOS paths

## [1.2.160] - 2026-04-07

> Guided first-run config + terminal column fix

### Added
- New users see a 'Get Started' card with a guided split-view to create their first config with inline help

### Fixed
- Terminal column mismatch: wait for custom fonts to load before computing cols (no more text fragments on the right edge)

## [1.2.159] - 2026-04-07

> First CI/CD release: parallel Windows + macOS builds with signing

### Added
- GitHub Actions workflow builds Windows EXE and macOS DMG in parallel
- macOS DMG is code-signed and notarized via Apple Developer ID

### Changed
- Tour walkthrough consolidated to 7 focused steps with matching screenshots

### Fixed
- Splash screen now shows before main window renders
- CLI setup dialog now works on macOS via login shell PATH
- Setup dialog no longer crashes with null ResizeObserver target

## [1.2.158] - 2026-02-11

> Maintenance release with internal improvements

### Changed
- Internal code maintenance and stability improvements

## [1.2.68] - 2026-02-11

> Automated release pipeline with Claude CLI, VirusTotal, and GitHub Releases

### Added
- Release pipeline now auto-generates changelog and release notes via Claude CLI
- VirusTotal scan of installer with results linked in GitHub Release
- SHA-256 checksums generated and attached to each release
- GitHub Releases created automatically with installer download

### Changed
- Old installer versions auto-cleaned from project root on each release
- npm audit pre-check blocks release if critical vulnerabilities found

## [1.2.67] - 2026-02-08

> Platform v9 theme, rate limits, enriched statusline, config improvements

### Added
- Rate limit tracking -- 5-hour and weekly usage with colored dot bars, reset times, and extra usage cost shown in context bar
- Enriched context bar -- now shows model name, token count (135k/200k), context %, cost, lines changed, and session duration
- Config right-click menu now includes Edit and Delete options alongside group management

### Changed
- New platform v9 dark theme -- deeper blue-black backgrounds replace the old purple-tinted Catppuccin palette
- Config items show Claude/Shell badges and colored left borders. Active tabs have colored bottom border

### Fixed
- Command button context menu no longer truncates at window edge -- opens upward when near bottom

## [1.2.36] - 2026-02-07

> Insights fix, command button fix, update reliability

### Fixed
- Insights now works -- /insights runs via PTY with proper TTY instead of headless spawn that hung forever
- Custom command buttons no longer re-fire when pressing Enter -- buttons no longer steal keyboard focus
- Update process simplified -- copies installer to Downloads, kills PTYs, launches installer, exits immediately

## [1.2.24] - 2026-02-07

> Debug logging overhaul, input protection, crash recovery

### Changed
- Debug toggle now controls verbose app logging instead of screenshot capture -- logs persist across updates
- Log rotation increased to 10MB with 3 backup files for better diagnostic history
- Insights timeout increased from 5 to 10 minutes
- Error boundary catches renderer crashes and shows error with recovery button instead of blank screen
- Verbose PTY lifecycle logging (spawn, exit, kill) for debugging session issues

### Fixed
- Restored image paste handler -- clipboard images saved as JPEG (max 1920px, 85%) with file path sent to Claude
- Right-click in terminal pastes clipboard text when no text is selected
- Input bar blocks multi-char text when Claude is asking a question -- prevents losing typed content
- Image paste debounced (3s) to prevent duplicate sends via Alt+V or Ctrl+V

## [1.2.20] - 2026-02-06

> Config and session groups with collapsible tree view

### Added
- Group saved configs into named groups -- collapsible tree view in sidebar
- Launch all configs in a group at once with the group play button
- Active sessions auto-group based on their config's group
- Right-click configs to move between groups or create new ones
- Group field in config dialog for assigning during create/edit

### Fixed
- Context remaining indicator now works for SSH sessions (accumulation buffer for chunked data)

## [1.2.5] - 2026-02-06

> Image optimization, yellow cursor fix, and update button fix

### Fixed
- Clipboard images (Alt+V) now resized to max 1920px and saved as JPEG -- drastically reduces context usage
- Screenshot capture also switched from PNG to JPEG for smaller files
- Yellow cursor block eliminated by stripping yellow background color sequences
- Screenshot dropdown labels render properly (SVG icons instead of broken Unicode)
- Update button now runs pre-built installer instead of rebuilding from source

## [1.2.3] - 2026-02-06

> Smart insights with AI-powered analysis and actionable summaries

### Added
- KPI extraction now uses smart Claude skill that compares to previous run and produces actionable bullet points
- Insights sidebar shows improvements (green), regressions (red), and suggestions (purple) at the top

### Changed
- KPI format is now fully dynamic -- the skill decides categories, metrics, and lists without hardcoded schemas
- What's New modal now triggers on version change, not every build

## [1.2.2] - 2026-02-06

> Screenshot button redesign, input persistence, and release automation

### Added
- npm run release -- single command for full build, package, and update notification

### Changed
- Screenshot button restyled to match app design (no more garish cyan)

### Fixed
- Input text no longer lost when switching between sessions and other views

## [1.2.1] - 2026-02-06

> Better insights rendering, screenshot button fix, and clipboard paste fix

### Added
- CLI availability indicator (green/red dot) in status bar

### Changed
- Insights report now renders with full Catppuccin dark theme matching the app

### Fixed
- Screenshot button replaced with clean SVG icon instead of emoji
- Ctrl+V paste no longer intercepts clipboard images -- screenshot workflow uses right-click only
- Stuck insight runs automatically marked as failed on app restart
- Restart button now works for SSH/remote sessions (kills old PTY before re-spawning)

## [1.2.0] - 2026-02-06

> Insights analytics with KPI tracking and trend comparison

### Added
- Insights integration: run claude /insights from the sidebar and view reports in-app
- KPI extraction via Claude headless with automatic trend comparison between runs
- Insights archive with history browsing and versioned reports
- KPI sidebar showing metrics grouped by category with trend arrows
- Auto-seeds existing report on first launch so your data is immediately available

### Fixed
- Update process now properly rebuilds, runs the installer, and relaunches the app

## [1.1.0] - 2026-02-05

> Session restore, Docker screenshot support, and graceful shutdown

### Added
- Sessions are now saved on close and restored on launch with /resume
- Graceful shutdown sends /exit to Claude before closing
- Screenshots now work in Docker containers via docker cp
- Shell-only terminals (without Claude) option added
- Push-based update notifications via WebSocket

### Changed
- Build timestamp shown in status bar for version tracking
- Expanded color palette with 24 vibrant colors

### Fixed
- Log viewer now properly displays terminal logs
- Yellow cursor issue resolved by hiding cursor layer

## [1.0.0] - 2026-02-01

> Initial release

### Added
- Multi-session Claude Code terminal management
- SSH session support with password authentication
- Custom commands per session/config
- Session logging with history viewer
- Tab attention indicators for waiting prompts
- Context usage tracking via statusline API

[2.2.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.2.0
[2.1.0-beta.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.5
[2.1.0-beta.4]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.4
[2.1.0-beta.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.3
[2.1.0-beta.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.2
[2.1.0-beta.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.1
[2.0.0-rc.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-rc.2
[2.0.0-rc.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-rc.1
[2.0.0-beta.6]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-beta.6
[2.0.0-beta.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-beta.5
[2.0.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0
[1.5.45]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.45
[1.5.44]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.44
[1.5.43]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.43
[1.5.42]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.42
[1.5.41]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.41
[1.5.40]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.40
[1.5.39]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.39
[1.5.38]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.38
[1.5.37]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.37
[1.5.36]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.36
[1.5.34]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.34
[1.5.33]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.33
[1.5.32]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.32
[1.5.31]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.31
[1.5.30]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.30
[1.5.29]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.29
[1.5.28]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.28
[1.5.27]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.27
[1.5.26]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.26
[1.5.25]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.25
[1.5.23]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.23
[1.5.19]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.19
[1.5.18]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.18
[1.5.17]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.17
[1.5.16]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.16
[1.5.15]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.15
[1.5.14]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.14
[1.5.13]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.13
[1.5.11]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.11
[1.5.10]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.10
[1.5.9]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.9
[1.5.8]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.8
[1.5.7]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.7
[1.5.6]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.6
[1.5.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.5
[1.5.4]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.4
[1.5.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.3
[1.5.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.2
[1.5.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.1
[1.4.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.4.3
[1.4.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.4.2
[1.4.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.4.0
[1.3.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.3.1
[1.2.166]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.166
[1.2.165]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.165
[1.2.164]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.164
[1.2.163]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.163
[1.2.162]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.162
[1.2.161]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.161
[1.2.160]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.160
[1.2.159]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.159
[1.2.158]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.158
[1.2.68]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.68
[1.2.67]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.67
[1.2.36]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.36
[1.2.24]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.24
[1.2.20]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.20
[1.2.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.5
[1.2.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.3
[1.2.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.2
[1.2.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.1
[1.2.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.0
[1.1.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.1.0
[1.0.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.0.0
