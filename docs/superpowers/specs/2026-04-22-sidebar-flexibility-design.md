# GitHub Sidebar Flexibility & Action Surface — Design Spec

**Status:** Draft · 2026-04-22
**Author:** nubbymong (co-authored with Claude)
**Supersedes:** n/a
**Related:**
- `docs/superpowers/specs/2026-04-17-github-sidebar-design.md` (the sidebar this extends)
- `docs/superpowers/specs/2026-04-22-http-hooks-gateway-design.md` (provides Live Activity data + edit deltas)

## Summary

The GitHub sidebar that shipped in v1.3.x is data-rich but interaction-poor. Every section is display-only, globally-configured, and fixed in order. This spec proposes three layers of flexibility — **per-session visibility**, **per-section preferences**, and **rich per-section actions** — plus a shared `ScrollingFeed` pattern for conversations that scale past a dozen items.

All seven existing sections get upgraded. The Live Activity footer from the Hooks Gateway spec slots into the same framework.

## Why

The observation that kicked this off: the sidebar shows a lot of data but almost none of it is actionable from the app. CI fails — click through to GitHub. PR has conflicts — click through. Linked issue needs unlinking — you can't. Different repos / different session types want different section sets — you can't choose.

Secondary: shared components emerge. Reviews, Linked-Issues comment threads, Notifications, and the Hooks Live Activity feed are all "append-mostly scrolling lists with unread state" — building them once pays off across four surfaces.

## Non-goals

- **Not rebuilding GitHub Desktop in the sidebar.** Local Git gets a surgical action set (stage / push / switch / stash); merge-conflict resolution, interactive rebase, and hand-written commit messages stay in a real tool / the terminal.
- **Not replacing the Worktrees dashboard** (its own follow-up spec). The sidebar is per-session context; Worktrees is the cross-session overview.
- **Not redesigning the sidebar layout chrome.** Header, resize handle, collapse-to-icon still work as they do. Collapsed state goes from `GH` text to a monochrome GitHub icon (already merged in PR #22).

## User experience

### Three layers of visibility control

| Layer | Stored in | Scope |
|-------|-----------|-------|
| **Global feature toggle** (existing) | `github-config.json · featureToggles[featureKey]` | Turn off fetching/polling repo-wide. "Disable CI polling across the board." |
| **Per-session visibility** (new) | `session-state.json · sessions[i].githubIntegration.hiddenSections[]` | Feature is globally on, but this session doesn't render it. "In my docs-writing session I don't need Local Git." |
| **Collapsed state** (promote to persisted) | `session-state.json · sessions[i].githubIntegration.collapsedSections[]` | Section rendered but body folded. Cheap toggle. |

### Entry points

- **Sidebar header `⋯`** → master popover. Checklist of every section with disabled rows where caps are missing (e.g. Notifications without the scope). Buttons: "Reset to default" and "Save as default for new sessions" (writes `github-config.json · defaultVisibleSections[]`).
- **Per-section header `⋯`** → section-specific popover with compact toggle, filter default, refresh interval, and a destructive "Hide in this session" button.

New sessions inherit `defaultVisibleSections` if it's set; otherwise every enabled feature is visible.

## Data model changes

```ts
// shared/github-types.ts

export type GitHubSectionId =
  | 'sessionContext'
  | 'activePR'
  | 'ci'
  | 'reviews'
  | 'linkedIssues'
  | 'localGit'
  | 'notifications'
  | 'liveActivity'   // NEW (from Hooks Gateway)

export interface SectionPref {
  compact?: boolean
  filter?: string                 // section-specific: CI → 'all'|'failing'|'this-branch'|'pr-only'
  refreshSec?: number             // override poll interval (clamped to sane values)
  autoExpandOnFailure?: boolean   // CI only, default true
  sortBy?: string                 // issues: 'linked-at'|'last-activity'|'state'|'number'
}

export interface SessionGitHubIntegration {
  enabled: boolean
  repoUrl?: string
  repoSlug?: string
  authProfileId?: string
  autoDetected: boolean
  hiddenSections?: GitHubSectionId[]                                 // NEW
  collapsedSections?: GitHubSectionId[]                              // PROMOTE from in-memory
  sectionPrefs?: Partial<Record<GitHubSectionId, SectionPref>>       // NEW
  pinnedIssueNumber?: number                                         // NEW (Session Context pin override)
  unlinkedIssues?: number[]                                          // NEW (Linked Issues)
}

export interface GitHubConfig {
  // …existing fields…
  defaultVisibleSections?: GitHubSectionId[]                         // NEW — template for new sessions
  snoozedNotifications?: Record<string, number>                      // NEW (`profileId:threadId` → resumesAt epoch ms)
  lastSeenThreads?: Record<string, number>                           // NEW (feedId-namespaced → epoch ms)
}
```

Renderer also adds a small `SessionUIStore` layer that merges `sectionPrefs` with built-in defaults so components don't need to do the merge themselves.

### Where state lives (and why)

`session-state.json` persists only on graceful close. That's fine for things that would be harmless to lose on a hard crash (which section was collapsed, which issue was pinned for this session). It is NOT fine for state that must survive a crash — notably snooze and unread tracking — so those move to `github-config.json`, which uses the debounced-save-on-change pattern already used by feature toggles.

| State | Home | Reason |
|-------|------|--------|
| `hiddenSections`, `collapsedSections`, `sectionPrefs`, `pinnedIssueNumber`, `unlinkedIssues` | `session-state.json` | Genuinely per-session view state; loss on hard crash is recoverable (user re-clicks). |
| `snoozedNotifications` | `github-config.json` | Main-side poller must read this every tick. Also: snoozing is a cross-session user decision — "I don't want to see this until 4pm" shouldn't reset if the app crashes. Key is `profileId:threadId`. |
| `lastSeenThreads` | `github-config.json` | Read by main when computing unread counts for tokenomics / notifications badge. Also cross-session. Capped at 500 entries (LRU) and evicted when `timestamp < now - 90d` on hydration to prevent unbounded growth over years of use. |
| `defaultVisibleSections` | `github-config.json` | Template for new sessions. Repo-wide preference. |

## Shared components

### `<ScrollingFeed>` (new)

Append-mostly scrolling list, reused by **Reviews**, **Notifications**, **big-issue comment threads**, and **Live Activity**. Props:

```ts
interface ScrollingFeedProps<T> {
  items: T[]
  keyOf: (item: T) => string
  timestampOf: (item: T) => number
  sessionId: string                // for lastSeenThreads lookup
  feedId: string                   // for per-feed last-seen bucket
  renderItem: (item: T, opts: { unread: boolean; isNew: boolean }) => JSX.Element
  renderDivider?: (bucket: TimeBucket) => JSX.Element   // defaults provided
  renderCollapsedBatch?: (items: T[], reason: string) => JSX.Element  // reviewer batching
  virtualizeThreshold?: number     // default 100
}
```

Behaviour (matches §High-volume UX mockup):
- **Auto-scroll only when at bottom.** `IntersectionObserver` on a sentinel at the tail with `rootMargin: '24px'` tolerance. "At bottom" is sticky for 150ms after a programmatic scroll-to-tail so a user's inertial / momentum scroll doesn't immediately flip the state back to "scrolled up" on overshoot.
- **Jump-to-new pill** appears when (not at-bottom) AND (new items arrived since the at-bottom transition). Hides on natural scroll-to-bottom OR click (which scrolls-to-tail).
- **Time dividers** bucket by `Just now / 10 min / 1 hour / Today / Yesterday / This week / Older`. Older items collapse under a "Show N older" toggle.
- **Unread per item** via `github-config.json · lastSeenThreads[feedId:itemId]`. Blue dot + subtle flash on arrival. Reading the section (via scroll-into-view OR explicit Mark-all-read) advances the timestamp. Capped at 500 entries + 90-day eviction on hydration.
- **Virtualisation** via `react-virtuoso` past `virtualizeThreshold`. Virtuoso handles variable item heights natively (essential because reviewer-batch rows expand inline on click); `react-window` was considered but its fixed-height assumption clashes with batching.
- **Reviewer batching** produces stable summary rows by default; expanding a batch inserts its items above the batch row (still variable-height but handled by virtuoso). Batching is opt-in per consumer via `renderCollapsedBatch`.

One component, four surfaces, consistent behaviour.

### `<SectionOptionsPopover>` (new)

The per-section `⋯` popover. Renders common controls (compact / refresh interval / hide-in-session) plus section-specific slots (filter dropdown, sort dropdown, auto-expand toggle). Each section declares its section-specific options in a small `SectionOptionsConfig` object; the popover consumes it.

### `<SidebarHeaderMenu>` (new)

The sidebar-level `⋯` popover with the master checklist. Pulls `featureToggles` (to know which rows to disable) and `profiles[*].capabilities` (to know which rows are blocked on auth) from `githubStore`.

### `<ToastUndo>` (expand existing)

Undo-toasts are needed for destructive actions: Mark-all-read, Discard unstaged, Dismiss notification, Unsubscribe thread. Single-pattern component, 5s timeout, undo action receives the pre-action state to restore. Already partially exists — spec makes it a real component.

## Per-section changes

Each section keeps its file under `src/renderer/components/github/sections/`. All of them get the `SectionOptionsPopover` + per-section refresh icon; individual additions below.

### 1 · Session Context
- **Pin override**: `pinnedIssueNumber` in session-state overrides heuristic. UI shows a 📌 badge; unpinning restores auto.
- **Reasoning line** per candidate issue (branch match / PR body ref / transcript ref). Already computed by `session-context-service.ts §6.1`, just not surfaced.
- **Show-more files** (no 5-item cap).
- **Edit deltas on recent files** — `+N/−M` from the Hooks Gateway. Degrades gracefully if hooks are off.
- **Closed-issue warning** — muted pill colour; optional rule "skip closed issues in auto-pick" (`sectionPrefs.skipClosed`).

### 2 · Active PR
- **State pill + diff size** in the header summary. `#15 · open · +412/−38 · 14 files`.
- **Labels chips** from the REST payload (unused today).
- **Body preview** — first ~200 chars through `SanitizedMarkdown`, expand-on-click.
- **Reviewers chips** with avatar + verdict pill (✓ approved / ⌛ requested / ✗ changes).
- **Mergeable detail** — `conflict` shows which files + base branch; `unknown` becomes "checking… ↻".
- **Convert to draft** (symmetric to existing "Ready for review").
- **Merge when clean** — click queues the merge; a main-side watcher polls `mergeable` on the orchestrator schedule and fires the user's chosen merge method when it flips to `clean`. Scope for a follow-up phase.

### 3 · CI / Actions
- **Two-line run row**: line 1 status-icon + workflow-name + duration + actions; line 2 `on <branch> · <sha> · <message> · <trigger> · <when>`.
- **Auto-expand on failure** surfaces failed jobs + tail-of-log inline (data already on `WorkflowRunSnapshot.failedJobs`).
- **Filter chips** — `All / Failing / This branch / PR only`.
- **Watch toggle** on running jobs — 👁 icon, desktop-notifies on completion. Uses Hooks Gateway if available; falls back to polling the run every 10s.
- **Summary pill** reflects live state colour (green / yellow / red) not just count text.

### 4 · Reviews & Comments
- **Reviewer row click** expands to review-level summary body.
- **ScrollingFeed**-backed thread list (volume UX — see Shared components).
- **Filter chips** — `Open / Resolved / All`. Resolved threads dimmed to 45% opacity when shown.
- **💬 Reply in Claude** has a readiness contract — it does NOT blindly `pty.write()` into whatever state the session is in. Flow:
  1. Check the session's last transcript event (via `transcript-watcher`). If the session is mid-tool-call OR mid-Claude-response, the button opens a small confirmation toast: *"Claude is busy. Queue this context for when it's ready?"* with Cancel / Queue. Queue holds the text and fires `pty.write` as soon as the next `user-input-expected` event lands.
  2. If the session IS idle but the user has typed something into Claude's input already, the text is appended with a leading newline so existing keystrokes aren't clobbered.
  3. If the target session isn't the currently-focused one, the focus switches to it first (same behaviour as `notifyFocusChanged`) so the user can see the context land.
  4. All of this is testable via `transcript-watcher` without actually having Claude running — mock the last-event type.
- **📂 Jump to diff** opens the GitHub URL at file:line.
- **Resolve** inline (REST call).
- **Age timestamp** per thread.
- **Verdict mix pills** in header: `1 changes · 1 approved` vs the current opaque "1 open".

### 5 · Linked Issues
- **Filter chips** — `Open / All / Primary only`. Closed issues dimmed when visible.
- **Sort dropdown** — `Last activity / Linked at / State / Number` (default: Last activity).
- **Linkage reason** per row — 🔗 PR body / 🌿 branch name / 📜 transcript reference.
- **Activity signal** — comment count + last-activity age.
- **Labels** shown as chips.
- **Per-issue ⋯ kebab** — Open / Reply in Claude / Copy reference / Pin as session primary / Unlink from session.
- **Big-issue thread** uses `<ScrollingFeed>` when expanded.

### 6 · Local Git

Write operations split into two categories — this is a safety boundary, NOT cosmetic:

**Undoable (via 5s toast + pre-action snapshot restore):**
- Stage / unstage (per-file or bulk)
- Discard unstaged changes (red button; keeps the pre-discard blob in a ref for 5s so undo can restore it)
- Stash / pop stash
- Switch branch with auto-stash (stash ref captured so we can restore)

**Confirm-before (no undo possible — remote state advances or history rewrites):**
- Push, pull (remote refs advance; webhooks fire; CI pipelines trigger)
- Force anything (`push --force`, `reset --hard` against remote, etc.)
- These show a confirmation dialog, not a toast. Dialog body surfaces the effective `git` command so the user sees what runs.

Every write command is also appended to a session-scoped `~/.claude/ccc-git-history.log` file (forensic only; the user can `git reflog` themselves for ref-level recovery).

- **Branch switcher dropdown** — recent branches + "new branch from here". Dirty-state warning auto-stashes (undoable) OR offers to commit first.
- **Push / Pull** buttons — enabled only when ahead/behind > 0. Confirm dialog shows the exact remote / refspec. Failure surfaces stderr inline.
- **Per-file checkbox** for stage/unstage. Group-level "Stage all / Unstage all" (undoable).
- **Per-file status code** (M / A / D / ?) + **+/− line count** from `git diff --numstat`.
- **⚠ Discard** (red button) — undoable toast. Saves file contents to memory; undo restores via `git checkout HEAD -- <file>` using the snapshot.
- **Stash / Pop stash** with stash-count pill. Both undoable.
- **💬 Ask Claude to commit** — paste staged file list into terminal: `Review the staged diff and write a commit message.` Uses the same readiness contract as Reviews' "Reply in Claude".
- **Click a recent commit** → modal with that commit's diff (uses `SanitizedMarkdown` for syntax-highlighted patch).
- **Git path resolution** — reuses `resolveGitBin()` from `src/main/github/session/repo-detector.ts` (already handles macOS homebrew paths + Windows `where git`). Do NOT duplicate path detection in new IPC handlers.
- **Explicitly NOT**: merge conflict resolution, interactive rebase, writing commit messages by hand.

### 7 · Notifications
- **All-profiles merge** chip with per-profile counts next to it. Replaces the dropdown-only pattern.
- **Reason chips** — ⌛ Reviews / @ Mentions / + Assigned / ✏ Author. GitHub's own taxonomy from the REST payload.
- **Mark-all-read** with 5s undo toast.
- **Per-item ⋯ kebab** — Open / Mark read / Snooze 2h / Snooze until tomorrow / Unsubscribe from thread / Dismiss.
- **Snooze** via renderer-persistent `snoozedNotifications[id] = resumesAt`. Poller filters out snoozed items until `Date.now() ≥ resumesAt`, then re-surfaces (flagged as "returned" so the user knows it's back).
- **Unsubscribe** via real GitHub REST call (`DELETE /notifications/threads/:id/subscription`).
- **ScrollingFeed**-backed item list (time dividers, unread dots, hover actions).
- **Empty state copy** — "Inbox clear. Nothing's waiting on you." not "No notifications right now".

### New · Live Activity footer
Defined by the Hooks Gateway spec. Slots in as `GitHubSectionId: 'liveActivity'` with the same visibility / collapsibility controls as any other section. ScrollingFeed-backed.

## Phasing

Six implementation phases, each a separate PR. Phase 1 is split into three sub-phases after the prior review flagged that a single 900-LOC framework PR with no user-visible surface is review-hell.

| # | PR | Scope | LOC est |
|---|----|-------|---------|
| 1a | `feat/sidebar-data-model` | Data model changes + `<SidebarHeaderMenu>` + per-session hide. Migration. One visible change: the master visibility checklist works. | ~350 |
| 1b | `feat/sidebar-section-options` | `<SectionOptionsPopover>` + `<ToastUndo>`. Every section gets its ⋯ popover but no new section content yet. | ~250 |
| 1c | `feat/scrolling-feed` | `<ScrollingFeed>` component in isolation, with a storybook-style harness route in the settings page (dev-only) that exercises it with synthetic data. Not yet wired to Reviews / Notifications. | ~300 |
| 2 | `feat/sidebar-easy-wins` | Sections 1/2/3/5/7 content upgrades that don't need Hooks: Session Context pin + reasoning; Active PR labels/body/reviewers/mergeable-detail/convert-draft; CI two-line row + auto-expand-on-failure + filter chips; Linked Issues filter/sort/reason/kebab; Notifications reason chips + mark-all-read + snooze + unsubscribe. ScrollingFeed wired to Reviews + Notifications. | ~1200 |
| 3 | `feat/local-git-actions` | Section 6 action surface: branch switcher, push/pull (confirm-dialog), per-file stage (undoable), discard (undoable), stash, Ask-Claude-to-commit, commit-diff modal. Standalone — all new main-side git IPC handlers. | ~700 |
| 4 | `feat/sidebar-hooks-dependent` | Depends on Hooks Gateway PR merging first. Edit deltas on Session Context, Live Activity footer, CI watch-on-completion desktop notifies. Also Active PR "merge when clean" watcher (see below for lifecycle). | ~500 |

Phase 2 touches five sections but each delta is small and parallel; keep it as one PR unless a reviewer pushes back.

### Phase 4 follow-up: merge-when-clean watcher

Because the prior reviewer flagged this as under-specified, pinning it down here so Phase 4 can land:

- Watcher identity: `(slug, prNumber)` tuple. One watcher per PR; re-queueing replaces.
- Main-side: attaches to the sync orchestrator. Each time it polls PR status for the watched PR and `mergeable === 'clean'`, fire the merge API call with the user's chosen method and clear the watcher.
- Cancels on: PR closed, PR force-pushed (sha changes), user-initiated cancel, session that requested the merge closing, watcher age > 30min (timeout). Timeout surfaces a toast: "Still not clean after 30 min — cancelled. Re-queue?".
- Failure: if the merge call rejects (e.g. CI regressed since mergeable flipped), surface the error and leave the watcher cleared.

## Migration

- New fields default to undefined / empty arrays. Existing sessions render exactly as before until the user touches the new controls.
- `collapsedSections` was in-memory; on first read from disk, we initialise empty. No backfill required.
- `defaultVisibleSections` — if unset, treat as "all enabled features visible" so existing behaviour is preserved.

No schema migration needed.

## Testing

### Unit
- `ScrollingFeed` — at-bottom detection, jump-pill visibility, time bucketing, last-seen tracking, virtualisation threshold.
- `SectionOptionsPopover` — correct defaults, save persistence, hide-in-session destructive action.
- `SidebarHeaderMenu` — disabled rows for missing caps, "Save as default" writes `defaultVisibleSections`, Reset wipes the session's `hiddenSections`.
- Each section's new filter / sort / pref behaviour.
- Local Git IPC handlers — each command wrapped in a dry-run test against a temp git repo.

### Integration
- End-to-end: toggle off a section via header menu, reload app, verify the section stays hidden for that session but not others.
- Volume: drive ScrollingFeed with 200 synthetic items, verify virtualisation engages, unread persists across "reload", jump-pill works.
- Git actions: spawn a temp repo, run stage/discard/stash/switch/push (to a local remote) and verify expected state transitions.

### Accessibility
- Every popover reachable via keyboard tab.
- `aria-live` on the undo toasts.
- `aria-expanded` on section headers reflects collapsed state.
- Focus-trap in every popover; Esc closes.
- Screen-reader labels on icon-only buttons (refresh, kebab, eye).

## Risks

- **Popover noise.** Every section gets a new `⋯` icon. On a small-width sidebar (users can resize as low as 280px) the icons may crowd. Mitigation: hide `↻` / `⋯` until hover; show them always only when sidebar width ≥ 360px.
- **`ScrollingFeed` complexity.** Build-once pays off, but the component has enough state (scroll, unread, virtualisation, batching, pauseable, filter) to be subtle. Budget an extra day for first-pass polish and schedule a dedicated code-review on it.
- **Settings UI explosion.** Seven sections × per-section prefs × master visibility = a lot of UI. Keep the settings page lean: master list lives in the sidebar `⋯`, section-specific prefs live in the section's `⋯`, global Settings → GitHub keeps only the feature toggles. Don't double-expose.
- **Git actions destructive risk.** Discard and auto-stash-on-switch can lose work. All such actions go through the Undo toast; any command that changes refs logs to a local command history file so you can recover via `git reflog` + our log.
- **Local Git IPC safety.** Every new git command takes untrusted cwd. Validate that cwd is the session's working directory (already known to the app) — never let an arbitrary cwd through the IPC boundary.
- **Per-section refresh storm.** If a user opens the header menu and un-hides five sections on a slow-polling repo, all five fetch concurrently. The orchestrator already handles this; adding dedicated per-section refresh just reuses the same path. Measure; if it's a problem, debounce un-hides.
- **Nested popovers fighting for focus.** Section `⋯` can theoretically open while the sidebar-header `⋯` is still open (menu-within-menu). Two focus traps would fight. Rule: opening a child popover closes its parent — enforced via a single portal-managed popover stack (`@floating-ui/react`'s `FloatingTree` pattern). Only one popover is ever rendered at a time.
- **Type duplication across specs.** The Hooks Gateway spec defines `HookEvent`, the Sidebar spec uses `LiveActivityEvent` conceptually. Make one: `HookEvent` from `src/shared/hook-types.ts` is authoritative; Live Activity renders `HookEvent`s directly. No new type in the sidebar surface area.

## Open questions

- **Do collapsed + hidden compete?** Mockups treat "hidden" as "gone from the layout" and "collapsed" as "fold the body". A user could theoretically toggle both. Rule: hidden wins; unhiding re-shows at its previous collapsed state.
- **Live Activity + Reviews side-by-side.** Both are ScrollingFeed users. When the user has 50 review threads AND hook events streaming, the sidebar gets heavy. Maybe the header `⋯` grows a "compact mode for this session" master toggle that shrinks both feeds. Think: iPadOS-style compact. Deferred unless it becomes a real problem.
