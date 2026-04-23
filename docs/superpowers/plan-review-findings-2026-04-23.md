# Plan Review Findings — 2026-04-23

> Consolidated blocker + should-fix findings from 7 independent
> `superpowers:code-reviewer` passes on the v1.3.2 "once and for all"
> plans. Each plan has this doc pinned at the top as a warning; fix
> blockers on-task as execution reaches them. Should-fix items are
> caught by the CLAUDE.md double-review rule during PR review.

## Cross-plan systemic issues (apply to MULTIPLE plans)

These are root-cause bugs that surfaced in several reviews. Fix once, apply everywhere.

### X1 · Store hook casing: `useGithubStore` vs `useGitHubStore`

**Actual export:** `src/renderer/stores/githubStore.ts` exports `useGitHubStore` (capital H).

**Wrong in plans:** sidebar-data-model (Phase 1a) uses `useGithubStore`. Phase 1b contradictorily uses `useGitHubStore`. Execution must use `useGitHubStore` everywhere. Any `.tsx` component or test referencing `useGithubStore` is a typecheck failure.

### X2 · Main-side handler registration casing: `registerGithubHandlers` vs `registerGitHubHandlers`

**Actual export:** `src/main/index.ts` calls `registerGitHubHandlers(deps)` with injected deps.

**Wrong in plans:** local-git-actions (Task 8 Step 4) uses `registerGithubHandlers`; must be `registerGitHubHandlers` and mirror the deps-injection pattern.

### X3 · Test infrastructure required before `.tsx` tests run

**Current state:** `vitest.config.ts` pins `environment: 'node'` and `include` limits to `.test.ts`. `@testing-library/react` + jsdom not installed.

**Ordering dependency:** Phase 1c adds the test-infra task (broadens include to `.tsx`, installs testing-library, uses per-file `// @vitest-environment jsdom`). Any plan that ships `.tsx` tests before Phase 1c lands will silently skip those tests at best, fail to collect at worst.

**Affected plans:** sidebar-data-model (Phase 1a), sidebar-section-options (Phase 1b), sidebar-hooks-dependent (Phase 4), all renderer tests in account-rework.

**Fix:** Either pull the test-infra task forward into Phase 1a, or strictly order 1a → 1c → 1b → 2 → 3 → 4 and add an explicit "gate on 1c merge" callout to each dependent plan.

### X4 · GitHub type-name assumptions that don't match shipped code

**Shipped type names in `src/shared/github-types.ts`:**
- `PRSnapshot` (not `PullRequestSnapshot`)
- `IssueSnapshot` (not `LinkedIssueSnapshot`)
- `NotificationSummary` (not `NotificationSnapshot`)

**Shipped fields:**
- `PRSnapshot.mergeableState` (not `mergeable`)
- `IssueSnapshot.primary` (not `isPrimary`) — no `url`, `commentCount`, `lastActivityAt`, `reason`, `labels`, `linkedAt`
- `WorkflowRunSnapshot.workflowName` + `durationMs` — no `name`, `durationSec`, `headBranch`, `headSha`, `headMessage`, `event`, `updatedAt`

**Shipped helpers:**
- `githubFetch(path, { tokenFn, shield, etags, method, body })` — NOT `fetchWithAuth`

**Affected plans:** sidebar-easy-wins (Phase 2) heavily; touches each section + mapper.

**Fix:** Either extend the shipped types additively (add new optional fields) or rename shipped types (breaking change — larger blast radius). Recommend additive extension. Mappers in `sync-orchestrator.ts` / `notifications-poller.ts` need updates to populate new fields from REST payloads.

### X5 · Missing dependencies assumed to exist

| Claimed available | Actual state |
|-------------------|--------------|
| `transcript-watcher` IPC + main-side emitter | Does not exist. Only `src/main/github/session/transcript-scanner.ts` (one-shot regex) and `transcript-loader.ts`. Phase 2's Reply-in-Claude readiness contract needs this scaffolded first. |
| Hooks gateway Groups C-F merged | Only Groups A+B committed on `feat/hooks-gateway` (tip `13657c3`). Sidebar Phase 4's Task 1 calls `hooksStore.ingestEvent` which lives in Group C. Phase 4 MUST be explicit about blocking on hooks gateway completion. |
| Phase 1a helpers (`stampLastSeen`, `getLastSeen`, `prunLastSeen` etc.) | Not yet executed. ScrollingFeed (1c) depends on them. Execute 1a first. |
| Phase 1a `pinnedIssueNumber`, `unlinkedIssues`, `sectionPrefs` on `SessionGitHubIntegration` | Needs verification the Phase 1a plan actually creates them (it does per the committed plan). |

### X6 · IPC channel duplication

`GITHUB_NOTIFICATION_MARK_READ: 'github:notification:markRead'` (proposed in Phase 2 plan Task 4) collides with existing `GITHUB_NOTIF_MARK_READ: 'github:notif:markRead'` (shipped). Use the existing `github:notif:*` namespace or migrate callers.

### X7 · Emoji characters in user-facing copy

Several plans use literal emoji (📌, 👁, 🔗, 💬, ⚠) in UI strings. CLAUDE.md says no emojis unless requested. Use SVG icons or ASCII glyphs via `String.fromCodePoint()` for the `\u{...}`-blocked chars only.

### X8 · Em dashes in user-facing copy

Project memory flags em dashes as an AI tell. Several plans slip em dashes into error messages / dialog body text. Search for `—` in each plan's copy and replace with `-` or restructure.

---

## Per-plan blockers (fix during execution)

### sidebar-data-model (Phase 1a · `feat/sidebar-data-model`)

- [NOT REVIEWED DIRECTLY but surfaced via 1b + 1c reviews]
- X1 applies: `useGithubStore` casing bug — rename all usage to `useGitHubStore`.
- X3 applies: `.tsx` tests won't collect until test-infra lands. Either add the test-infra task here or mark these tests as `.test.ts` with a minimal renderer shim.

### sidebar-section-options (Phase 1b)

- **B1** · Store casing (X1).
- **B2** · FloatingTree `anchor` prop not threaded through `PanelHeader` → `SidebarHeaderMenu`. Task 6 needs an explicit "extend PanelHeader to pass `menuRef.current` as `anchor`" step OR keep absolute-positioning and only wrap in `FloatingNode`/`FloatingFocusManager` (no `useFloating`-driven styles).
- **B3** · Test infra (X3). Either land 1c first, or add the test-infra task here.
- **B4** · `useDismiss(..., { bubbles: false })` is wrong primitive. Consult floating-ui docs; pick `bubbles: { escapeKey, outsidePress }` object form matching the nested-close policy. Make Task 9's test deterministic about expected order.
- **B5** · Dead `useClick({ enabled: false })` + contradictory `role: 'dialog'` with `modal={false}` + `initialFocus={-1}`. Choose modal+focus-trap (spec-aligned) OR non-modal with documented waiver.

### scrolling-feed (Phase 1c)

- **B1** · Phase 1a helpers not landed (X5). Plan must gate execution on 1a merging first, or stub the helpers locally.
- **B3** · ResizeObserver missing in jsdom — unit tests mock Virtuoso, fine; smoke test runs in Electron which has it. Confirm.
- **B4** · IntersectionObserver ordering-assumption fragile — use rootMargin-based marker instead of index-order lookup.
- **B5** · Sticky-window test is unsound — never invokes `scrollToBottom` so sticky state never activates. Rework test to enter sticky window before firing `isIntersecting=false`.
- **B6** · Bulk-stamp `useEffect([feedId])` captures stale `items`; if items mutate between observation and stamping, deltas drop. Add test.
- **B8** · No >500-entry LRU cap test. Add one.
- **S4** · `useMemo` with `Date.now()` and no time dep — bucket assignments freeze. Compute `now` outside memo and include in deps OR minute-resolution timer.
- **S5** · `useMemo` import missing in Task 11 after Task 8 trimmed it. Add explicit re-import step.

### sidebar-easy-wins (Phase 2)

- **B1 (CRITICAL)** · `transcript-watcher` IPC + main-side emitter does not exist (X5). Plan's Task 6 hand-waves it. Must precede Phase 2 as a dedicated "Phase 1d: Transcript State IPC" plan — 300-500 LOC including the main-side tail watcher, event schema, unsubscribe semantics, session-id-to-transcript-path resolution.
- **B2** · Snooze filter applies in wrong file — must be `src/main/github/session/notifications-poller.ts`, not `sync-orchestrator.ts`. `applySnoozeFilter` runs on `mapMany(r.data)` output inside `NotificationsPoller.doPoll()` before `emitNotifications`.
- **B3** · Mark-all-read gap: snoozed items are filtered from view but still marked read server-side. Surface this interaction.
- **B4** · `fetchWithAuth` not a real function (X4). Rewrite Task 5 handlers to use `githubFetch` with tokenFn closure — follow existing `GITHUB_NOTIF_MARK_READ` pattern at `src/main/ipc/github-handlers.ts:817-839`.
- **B5** · IPC channel duplication (X6).
- **B6** · Sync `writeConfig` vs debounced writes race — use `saveConfigDebounced(key, data)` per memory rule.
- **B7** · ScrollingFeed root is `data-testid="feed-root"` and does NOT forward `feedId` as DOM attr. Either amend 1c to forward it, or rewrite Task 14/22 tests to use `feed-root` + assert via unread-state persistence.
- **B8** · Type name mismatches (X4). `PRSnapshot` / `IssueSnapshot` / `NotificationSummary` / field shapes.
- **B9** · `WorkflowRunSnapshot` missing fields (X4). Add Task 1.5: extend snapshot + `mapRuns` + orchestrator fetcher.
- **B11** · `setSectionPrefs` bare call with no import/bridge/handler in Task 4. Add to Task 4.

### local-git-actions (Phase 3)

- **B1** · `SanitizedMarkdown` import/prop mismatch. Shipped is named export with prop `source`. Fix `import { SanitizedMarkdown }` and `<SanitizedMarkdown source={...} />`.
- **B2 (CRITICAL)** · Discard blob-snapshot undo is stubbed. Must ship a functional `GIT_RESTORE_FROM_BLOB` handler running `git cat-file -p <sha>` piped to the target file (via `spawn` + stream redirect, not shell `>` redirect) wired to `ToastUndo.onUndo`. Destructive action with non-functional undo is worse than no undo button.
- **B3** · X2 casing.
- **S1** · `FORBIDDEN_ARG` regex too broad — argv-via-`execFile` never hits shell so `$`/`;`/etc are literal-safe. Narrow the forbidden set to NUL + control chars, or drop entirely and keep per-field validators.
- **S2** · `err.code` from `execFile` can be a string (signal) or `ENOENT`; `Number(code) ?? 1` produces NaN. Type-check before numeric cast.

### sidebar-hooks-dependent (Phase 4)

- **B1 (CRITICAL)** · `added`/`removed` fields don't exist on Claude Code's Edit hook payload. Actual shape is `{ tool_input: { file_path, old_string, new_string }, tool_response: {...} }`. Must compute deltas from the strings: `new_string.split('\n').length - old_string.split('\n').length` or a proper diff. Also handle `Write` (whole-file, no diff basis) and `MultiEdit` (array of edits). Plan would otherwise silently record zero deltas for every real edit.
- **B2** · "Render nothing when hooksEnabled is false" test left as exercise. Write it explicitly.
- **B3** · X5: Hooks gateway Groups C-F not merged. Plan assumed they were. Task 1 needs gating + fallback guidance if `hooksStore` doesn't exist yet.
- **B4** · No explicit "blocks on feat/hooks-gateway merging" callout at the plan top.
- **B5** · CI polling fallback when hooks off is described in prose but not wired. Add failing test + implementation.

### account-rework

- **B1** · Task 22 `extractSshOscSentinels` has no `sshConfig` in scope. Hook must go on the caller side (the `ptyProcess.onData` closure in the SSH branch of `pty-manager.ts`), tracking `firstSentinelSeen` per-session in the parent closure.
- **B2** · Swap-executor test over-mocks. Drop the `account-manager` mock; inject `writeCredentialsForAccount` via `SwapOpts` (DI). Task 8 must show the full test body, not prose.
- **B3** · Task 10 `ipcMain.once(ACCOUNT_SWAP_SNAPSHOT_READY)` returns void, not a Promise. Wrap in `new Promise<void>((resolve) => ipcMain.once(...))`. Thread `fromId` from `getActiveAccount()?.id` inside the handler.
- **B4** · Task 7 mocks `writeCredentialsForAccount` before Task 8 creates it. Either merge T7+T8, or label T7's test as skeleton + add T8 integration test without mocks.
- **B5** · Swap phase vocabulary silently diverges from spec (`snapshotting` split into `snapshotRequested`/`snapshotReady`; `writing-creds` split into `acquiringLock`/`writingCredentials`/`releasingLock`). Either reconcile or document the plan supersedes spec.
- **B6 (CRITICAL)** · `retiredAccountIds` mechanism entirely missing. Self-review's "B7 folded" claim is false. Add a task: (a) add `retiredAccountIds: string[]` to `AccountsData`, (b) modify `initAccounts` to consult it before auto-save, (c) add `retireAccount(id)` export pushing uuid/fingerprint on delete. Also: `deleteAccount` entry point is missing from the plan.
- **B7** · Crash-recovery (Task 12) races with renderer boot — progress events drop before renderer subscribes. Either skip snapshot request entirely during boot-path auto-resume (`{ skipSnapshotRequest: true }`), or defer auto-resume until `did-finish-load`.
- **B8** · No negative test for atomic-rename failure. Decide rollback policy; add test.
- **S1-S3, S5** · Multiple tasks elide test bodies to prose — violates "full code in every step" from the template self-review. Tasks 5, 6, 8, 9, 12, 19 need real test code.

### ssh-session-redesign

- **B1 (CRITICAL)** · `MarkerParser.process()` unconditionally sets `carry = ''` at the end — which wipes the split-across-chunks state that `ingest` just stored. The strawman implementation fails its own split-across-chunks test. Fix: remove the `carry = ''` line inside `process()`, or only clear it when `process()` has actually consumed the carry bytes.
- **B2** · `isPotentialPartial` fast-path is dead code (buf.length < PREFIX.length + endsWith is equivalent to the next loop, not an optimisation).
- **B3** · Overflow path drops markers silently. When buffer grows past 8 KB, the emitted-half is not scanned for markers. Call `process()` on the emitted slice, or constrain overflow to only apply when `isPotentialPartial` was true.
- **B4** · ANSI-wrapped marker with a real prefix: `'prefix \x1b[0m__CCC_PHASE_SETUP_OK__\x1b[0m\n'` — current logic consumes the entire line, so `'prefix '` is lost. Add test; fix `process()` to keep line prefix.
- **B5** · Task 13 never wires OSC markers to `dispatchSSHStatuslineUpdate`. Plan says "launcher routes them to statusline dispatcher" but shows no code. SSH statusline would go silent on merge. Show the wiring snippet + test.
- **B6** · Task 13 silent on session-logger + debug-capture second `onData` handler. Raw vs cleaned logging decision needs to be made + documented.
- **B7** · Overflow test assertion `r.cleaned.length > 0` is trivially true. Tighten.
- **B8** · Capability probe lives on wrong side — spec says probe inside container BEFORE choosing inner vs outer. Plan folds probe+deploy into one phase. Split into probe → branch → deploy-inner-or-deploy-outer.
- **N1** · `src/shared/` imports from `src/main/` reversed direction bug. Put enums in shared, re-export from main.

---

## Recommended fold-and-execute sequence

1. Pin this document in each plan's header via a short banner ("⚠ See plan-review-findings-2026-04-23.md for known blockers before executing").
2. Surgically fix the most dangerous correctness bugs NOW (before any execution):
   - SSH plan B1 (marker parser) — rewrite the strawman to actually pass its own tests.
   - sidebar-easy-wins B1 — split out a "Phase 1d: Transcript State" plan or fold into another existing plan.
   - account-rework B6 — add the `retiredAccountIds` / `deleteAccount` tasks.
3. Execute in branch-stack order: `feat/hooks-gateway` (Groups C-F first — plan already clean), then the remaining branches.
4. Catch should-fix and nit-level items during per-branch `superpowers:code-reviewer` on the actual implementation PRs (CLAUDE.md double-review rule).

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
