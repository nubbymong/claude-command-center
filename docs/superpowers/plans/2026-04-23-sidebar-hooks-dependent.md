# Sidebar Phase 4 — Hooks-Dependent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the features that depend on the Hooks Gateway being landed: edit-delta chips on Session Context recent files, the Live Activity footer in the GitHub sidebar, CI watch-on-completion desktop notifications, and the merge-when-clean PR watcher.

**Architecture:** Consumes `HookEvent` stream from `hooksStore` (already shipped in feat/hooks-gateway Groups C-F). Introduces one new store (`mergeWatcherStore`), one new renderer section (`LiveActivityFooter`), and one main-side watcher (`merge-when-clean-watcher.ts`). All feature toggles sit behind the existing `hooksEnabled` check plus the `liveActivity` section visibility — if hooks is off, every feature in this phase degrades gracefully (edit deltas simply don't appear; Live Activity is hidden; CI watch-on-completion silently falls back to polling).

**Tech Stack:** TypeScript strict, Zustand 5, Electron `Notification` API, existing sync orchestrator (for merge watcher), vitest + `@testing-library/react`.

---

## File structure

**Shared:**
- Modify: `src/shared/ipc-channels.ts` — add `MERGE_WATCHER_ENQUEUE`, `MERGE_WATCHER_CANCEL`, `MERGE_WATCHER_STATUS`.
- Modify: `src/shared/github-types.ts` — add `MergeWatcherEntry` interface.

**Main:**
- Create: `src/main/github/merge-when-clean-watcher.ts` — the PR watcher. Hooked into the sync orchestrator.
- Create: `src/main/ipc/merge-watcher-handlers.ts`.
- Modify: `src/main/github/session/sync-orchestrator.ts` — call the watcher's tick.
- Modify: `src/main/notifications.ts` (or equivalent) — new `notifyCiCompletion(sessionId, runId, conclusion)` helper.

**Renderer:**
- Create: `src/renderer/components/github/sections/LiveActivityFooter.tsx` — pinned bottom footer using `<ScrollingFeed>` (from Phase 1c).
- Create: `src/renderer/components/github/localgit/EditDeltaBadge.tsx` — `+N/−M` chip from hooksStore derived data.
- Create: `src/renderer/stores/mergeWatcherStore.ts`.
- Modify: `src/renderer/components/github/sections/SessionContextSection.tsx` — render edit-delta badge on recent files.
- Modify: `src/renderer/components/github/sections/CISection.tsx` — add 👁 watch toggle per running job.
- Modify: `src/renderer/components/github/sections/ActivePRSection.tsx` — render "Merge when clean" button when PR is blocked on CI but otherwise mergeable.
- Modify: `src/renderer/components/github/GitHubPanel.tsx` — render `<LiveActivityFooter>` at the bottom.

**Tests:**
- `tests/unit/main/github/merge-when-clean-watcher.test.ts`
- `tests/unit/main/ipc/merge-watcher-handlers.test.ts`
- `tests/unit/renderer/stores/mergeWatcherStore.test.ts`
- `tests/unit/renderer/components/github/sections/LiveActivityFooter.test.tsx`
- `tests/unit/renderer/components/github/localgit/EditDeltaBadge.test.tsx`
- `tests/unit/renderer/components/github/sections/CISection-watch-toggle.test.tsx`

All new files ≤300 LOC.

---

## Task 1: Edit-delta derivation in hooksStore

**Files:**
- Modify: `src/renderer/stores/hooksStore.ts` — add `editDeltasBySession: Record<sessionId, Record<filePath, { added: number; removed: number }>>`.

- [ ] **Step 1: Failing test**

Create `tests/unit/renderer/stores/hooksStore-deltas.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { HookEvent } from '../../../src/shared/hook-types'
import { useHooksStore } from '../../../src/renderer/stores/hooksStore'

describe('hooksStore edit deltas', () => {
  beforeEach(() => { useHooksStore.getState().clearAllForTests() })

  it('aggregates PostToolUse Edit events into (filePath → {added, removed})', () => {
    const ev: HookEvent = {
      sessionId: 's1', event: 'PostToolUse', toolName: 'Edit',
      payload: { file_path: '/x/App.tsx', added: 3, removed: 1 },
      ts: Date.now(),
    }
    useHooksStore.getState().ingestEvent(ev)
    const deltas = useHooksStore.getState().editDeltasBySession['s1']
    expect(deltas['/x/App.tsx']).toEqual({ added: 3, removed: 1 })
  })

  it('accumulates across multiple edits to the same file', () => {
    const mk = (added: number, removed: number): HookEvent => ({
      sessionId: 's1', event: 'PostToolUse', toolName: 'Edit',
      payload: { file_path: '/x/App.tsx', added, removed }, ts: Date.now(),
    })
    useHooksStore.getState().ingestEvent(mk(3, 1))
    useHooksStore.getState().ingestEvent(mk(5, 2))
    expect(useHooksStore.getState().editDeltasBySession['s1']['/x/App.tsx']).toEqual({ added: 8, removed: 3 })
  })

  it('is scoped per session', () => {
    const mk = (sid: string): HookEvent => ({
      sessionId: sid, event: 'PostToolUse', toolName: 'Edit',
      payload: { file_path: '/x/App.tsx', added: 1, removed: 0 }, ts: Date.now(),
    })
    useHooksStore.getState().ingestEvent(mk('s1'))
    useHooksStore.getState().ingestEvent(mk('s2'))
    expect(useHooksStore.getState().editDeltasBySession['s1']['/x/App.tsx']).toEqual({ added: 1, removed: 0 })
    expect(useHooksStore.getState().editDeltasBySession['s2']['/x/App.tsx']).toEqual({ added: 1, removed: 0 })
  })

  it('resets when session ends (hooks:sessionEnded)', () => {
    const ev: HookEvent = {
      sessionId: 's1', event: 'PostToolUse', toolName: 'Edit',
      payload: { file_path: '/x/App.tsx', added: 1, removed: 0 }, ts: Date.now(),
    }
    useHooksStore.getState().ingestEvent(ev)
    useHooksStore.getState().clearSession('s1')
    expect(useHooksStore.getState().editDeltasBySession['s1']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run — FAIL** (store doesn't have `editDeltasBySession` or `ingestEvent` yet).

- [ ] **Step 3: Extend hooksStore**

Where `hooksStore.ts` already ingests hook events (from Phase 1/feat/hooks-gateway), augment the reducer to update `editDeltasBySession`:

```ts
function updateDeltas(state: State, ev: HookEvent): State {
  if (ev.event !== 'PostToolUse') return state
  if (ev.toolName !== 'Edit' && ev.toolName !== 'Write' && ev.toolName !== 'MultiEdit') return state
  const filePath = (ev.payload.file_path as string | undefined) ?? (ev.payload.filePath as string | undefined)
  if (!filePath) return state
  const added = Number((ev.payload.added as number | undefined) ?? 0)
  const removed = Number((ev.payload.removed as number | undefined) ?? 0)
  const sid = ev.sessionId
  const perSid = state.editDeltasBySession[sid] ?? {}
  const cur = perSid[filePath] ?? { added: 0, removed: 0 }
  return {
    ...state,
    editDeltasBySession: {
      ...state.editDeltasBySession,
      [sid]: { ...perSid, [filePath]: { added: cur.added + added, removed: cur.removed + removed } },
    },
  }
}
```

Call it inside `ingestEvent`; add `clearSession(sid)` that drops `editDeltasBySession[sid]`; wire `clearSession` into the existing `hooks:sessionEnded` IPC listener.

- [ ] **Step 4: Passes (4 tests).**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/hooksStore.ts tests/unit/renderer/stores/hooksStore-deltas.test.ts
git commit -m "feat(sidebar-4): hooksStore derives edit deltas per session per file"
```

---

## Task 2: `EditDeltaBadge` component

**Files:**
- Create: `src/renderer/components/github/localgit/EditDeltaBadge.tsx`

- [ ] **Step 1: Failing test**

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EditDeltaBadge } from '../../../src/renderer/components/github/localgit/EditDeltaBadge'

describe('EditDeltaBadge', () => {
  it('renders +N/-M when both non-zero', () => {
    render(<EditDeltaBadge added={3} removed={1} />)
    expect(screen.getByText('+3/-1')).toBeInTheDocument()
  })
  it('renders only + when removed is 0', () => {
    render(<EditDeltaBadge added={5} removed={0} />)
    expect(screen.getByText('+5')).toBeInTheDocument()
  })
  it('renders nothing when both are 0', () => {
    const { container } = render(<EditDeltaBadge added={0} removed={0} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Fails**

- [ ] **Step 3: Implement**

```tsx
import React from 'react'

interface Props { added: number; removed: number }

export function EditDeltaBadge({ added, removed }: Props) {
  if (added === 0 && removed === 0) return null
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`-${removed}`)
  return (
    <span
      className="ml-1 rounded px-1 py-0.5 text-[10px] font-mono"
      style={{
        background: 'var(--color-surface0)',
        color: 'var(--color-subtext0)',
      }}
      aria-label={`${added} added, ${removed} removed`}
    >
      {parts.join('/')}
    </span>
  )
}
```

- [ ] **Step 4: Passes**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/localgit/EditDeltaBadge.tsx tests/unit/renderer/components/github/localgit/EditDeltaBadge.test.tsx
git commit -m "feat(sidebar-4): EditDeltaBadge component"
```

---

## Task 3: Wire badges into SessionContextSection

**Files:**
- Modify: `src/renderer/components/github/sections/SessionContextSection.tsx`

For each recent-file row:

```tsx
const deltas = useHooksStore((s) => s.editDeltasBySession[sessionId]?.[file.filePath])
// ...
<span className="flex items-center">
  <span>{shortName(file.filePath)}</span>
  {deltas && <EditDeltaBadge added={deltas.added} removed={deltas.removed} />}
</span>
```

Test with fake hooksStore seeded with one delta; assert badge renders on the correct row.

```bash
git commit -m "feat(sidebar-4): Session Context rows show edit-delta badges"
```

---

## Task 4: `LiveActivityFooter` component

**Files:**
- Create: `src/renderer/components/github/sections/LiveActivityFooter.tsx`

Uses `<ScrollingFeed>` from Phase 1c with:
- `items`: `useHooksStore((s) => s.eventsBySession[sessionId] ?? [])` (renderer-held list of the last 200 events per session, already populated by Phase C of hooks gateway).
- `keyOf`: event.ts + event.event
- `timestampOf`: event.ts
- `renderItem`: one-line summary — `<time> <event kind icon> <toolName ?? event> <summary if any>`.
- Collapsed state: pulse dot + count + last-ago. Click expands.

- [ ] **Step 1: Failing test**

`tests/unit/renderer/components/github/sections/LiveActivityFooter.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const events = [
  { sessionId: 's1', event: 'PostToolUse', toolName: 'Edit', summary: 'Edit App.tsx', payload: {}, ts: Date.now() - 1000 },
]

vi.mock('../../../../src/renderer/stores/hooksStore', () => ({
  useHooksStore: (sel: any) => sel({ eventsBySession: { s1: events }, hooksEnabled: true }),
}))

import { LiveActivityFooter } from '../../../../src/renderer/components/github/sections/LiveActivityFooter'

describe('LiveActivityFooter', () => {
  it('renders collapsed state with event count', () => {
    render(<LiveActivityFooter sessionId="s1" />)
    expect(screen.getByText(/1 event/i)).toBeInTheDocument()
  })
  it('expands when clicked and shows recent rows', () => {
    render(<LiveActivityFooter sessionId="s1" />)
    fireEvent.click(screen.getByRole('button', { name: /live activity/i }))
    expect(screen.getByText(/Edit App.tsx/)).toBeInTheDocument()
  })
  it('renders nothing when hooksEnabled is false', () => {
    // override for this test — simplest: re-mock; left as exercise to implementation
  })
})
```

- [ ] **Step 2: Fails**

- [ ] **Step 3: Implement**

Full component (~160 LOC). Structure:

```tsx
import React, { useState } from 'react'
import { useHooksStore } from '../../../stores/hooksStore'
import { ScrollingFeed } from '../../common/ScrollingFeed'
import type { HookEvent } from '../../../../shared/hook-types'

interface Props { sessionId: string }

export function LiveActivityFooter({ sessionId }: Props) {
  const enabled = useHooksStore((s) => s.hooksEnabled)
  const events = useHooksStore((s) => s.eventsBySession[sessionId] ?? [])
  const [expanded, setExpanded] = useState(false)
  if (!enabled) return null

  const lastTs = events[events.length - 1]?.ts
  const ago = lastTs ? humanAgo(Date.now() - lastTs) : '—'

  return (
    <div
      className="border-t px-2 py-1 text-xs"
      style={{ borderColor: 'var(--color-surface0)', background: 'var(--color-mantle)' }}
    >
      <button
        aria-label="Live Activity"
        className="flex w-full items-center justify-between"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex items-center gap-1">
          <span style={{ color: events.length ? 'var(--color-green)' : 'var(--color-overlay0)' }}>●</span>
          <span>{expanded ? 'Hide live activity' : 'Live Activity'}</span>
        </span>
        <span style={{ color: 'var(--color-overlay0)' }}>
          {events.length} event{events.length === 1 ? '' : 's'} · {ago}
        </span>
      </button>

      {expanded && (
        <div className="mt-1" style={{ maxHeight: 240 }}>
          <ScrollingFeed<HookEvent>
            items={events}
            keyOf={(e) => `${e.ts}-${e.event}`}
            timestampOf={(e) => e.ts}
            sessionId={sessionId}
            feedId={`hooks:${sessionId}`}
            renderItem={(e) => (
              <div className="flex items-center gap-2 py-0.5">
                <span style={{ color: 'var(--color-overlay0)' }}>{new Date(e.ts).toLocaleTimeString()}</span>
                <span>{iconFor(e)}</span>
                <span style={{ color: 'var(--color-text)' }}>{e.summary ?? e.toolName ?? e.event}</span>
              </div>
            )}
          />
        </div>
      )}
    </div>
  )
}

function iconFor(e: HookEvent): string {
  if (e.event === 'Notification') return String.fromCodePoint(0x26A0)
  if (e.event === 'Stop') return String.fromCodePoint(0x25A0)
  return String.fromCodePoint(0x2192)
}

function humanAgo(ms: number): string {
  if (ms < 2000) return 'now'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}
```

- [ ] **Step 4: Passes**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sidebar-4): LiveActivityFooter wired to hooksStore via ScrollingFeed"
```

---

## Task 5: Slot `<LiveActivityFooter>` into GitHubPanel

**Files:**
- Modify: `src/renderer/components/github/GitHubPanel.tsx`

At the bottom of the panel render:

```tsx
{!isHidden('liveActivity') && <LiveActivityFooter sessionId={sessionId} />}
```

(`isHidden` helper already from Phase 1a.) Commit.

---

## Task 6: CI watch-on-completion toggle

**Files:**
- Modify: `src/renderer/components/github/sections/CISection.tsx`
- Modify: `src/main/notifications.ts` (or add new file `src/main/github/ci-notifier.ts`).

On each running job, render a 👁 toggle button. When on, the session subscribes — renderer-side `useEffect` watches the run's `WorkflowRunSnapshot.status` via `githubStore`; when it flips to `completed`, fires a desktop notification via `window.electronAPI.notifications.notifyCi(runId, conclusion)`.

Main side creates and shows an `Electron.Notification` when the IPC arrives. Test with a mocked notification API.

If `hooksEnabled` is false, fallback to polling every 10s (reuse existing orchestrator poll interval for the watched PR) — document in the component.

```bash
git commit -m "feat(sidebar-4): CI watch-on-completion toggle + desktop notification"
```

---

## Task 7: Merge-when-clean watcher (main-side)

**Files:**
- Create: `src/main/github/merge-when-clean-watcher.ts`
- Create: `tests/unit/main/github/merge-when-clean-watcher.test.ts`

Behaviour per spec §Phase 4 follow-up:
- Watcher identity: `(slug, prNumber)` tuple. One watcher per PR; re-queueing replaces.
- Sync orchestrator ticks → watcher polls the PR's `mergeable` field → if `clean`, fires the merge API call with the user's chosen method, clears the watcher.
- Cancels on: PR closed, PR force-pushed (sha changes), user-initiated cancel, owning session closed, age > 30 min.
- Timeout fires a toast: "Still not clean after 30 min — cancelled. Re-queue?".

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MergeWhenCleanWatcher } from '../../src/main/github/merge-when-clean-watcher'

describe('MergeWhenCleanWatcher', () => {
  let watcher: MergeWhenCleanWatcher
  let mergeApi: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mergeApi = vi.fn(async () => ({ merged: true }))
    watcher = new MergeWhenCleanWatcher({ mergeApi, now: () => Date.now() })
  })

  it('fires merge when mergeable flips to clean', async () => {
    watcher.enqueue({ slug: 'o/r', prNumber: 42, method: 'squash', sessionId: 's1' })
    await watcher.tick({ slug: 'o/r', prNumber: 42, mergeable: 'blocked', sha: 'a' })
    expect(mergeApi).not.toHaveBeenCalled()
    await watcher.tick({ slug: 'o/r', prNumber: 42, mergeable: 'clean', sha: 'a' })
    expect(mergeApi).toHaveBeenCalledWith('o/r', 42, 'squash')
  })

  it('cancels when sha changes (force-push)', async () => {
    watcher.enqueue({ slug: 'o/r', prNumber: 42, method: 'squash', sessionId: 's1' })
    await watcher.tick({ slug: 'o/r', prNumber: 42, mergeable: 'blocked', sha: 'a' })
    await watcher.tick({ slug: 'o/r', prNumber: 42, mergeable: 'blocked', sha: 'b' })
    expect(watcher.isWatching('o/r', 42)).toBe(false)
  })

  it('times out after 30 minutes', async () => {
    let clock = Date.now()
    watcher = new MergeWhenCleanWatcher({ mergeApi, now: () => clock })
    watcher.enqueue({ slug: 'o/r', prNumber: 42, method: 'squash', sessionId: 's1' })
    clock += 31 * 60 * 1000
    await watcher.tick({ slug: 'o/r', prNumber: 42, mergeable: 'blocked', sha: 'a' })
    expect(watcher.isWatching('o/r', 42)).toBe(false)
  })

  it('re-queueing replaces the existing entry', () => {
    watcher.enqueue({ slug: 'o/r', prNumber: 42, method: 'merge', sessionId: 's1' })
    watcher.enqueue({ slug: 'o/r', prNumber: 42, method: 'squash', sessionId: 's1' })
    const entry = watcher.getEntry('o/r', 42)
    expect(entry?.method).toBe('squash')
  })

  it('cancel on PR close', async () => {
    watcher.enqueue({ slug: 'o/r', prNumber: 42, method: 'squash', sessionId: 's1' })
    watcher.notifyPrClosed('o/r', 42)
    expect(watcher.isWatching('o/r', 42)).toBe(false)
  })
})
```

- [ ] **Step 2: Fails**

- [ ] **Step 3: Implement**

```ts
// src/main/github/merge-when-clean-watcher.ts
import type { MergeMethod } from '../../shared/github-types'

export interface MergeWatcherEntry {
  slug: string
  prNumber: number
  method: MergeMethod
  sessionId: string
  enqueuedAt: number
  lastSha?: string
}

interface Opts {
  mergeApi: (slug: string, pr: number, method: MergeMethod) => Promise<{ merged: boolean; error?: string }>
  now: () => number
}

const TIMEOUT_MS = 30 * 60 * 1000

export class MergeWhenCleanWatcher {
  private entries = new Map<string, MergeWatcherEntry>()
  constructor(private opts: Opts) {}

  private key(slug: string, pr: number): string { return `${slug}#${pr}` }

  enqueue(args: Omit<MergeWatcherEntry, 'enqueuedAt' | 'lastSha'>): void {
    this.entries.set(this.key(args.slug, args.prNumber), { ...args, enqueuedAt: this.opts.now() })
  }

  async tick(snapshot: { slug: string; prNumber: number; mergeable: string; sha: string }): Promise<void> {
    const k = this.key(snapshot.slug, snapshot.prNumber)
    const entry = this.entries.get(k)
    if (!entry) return
    if (entry.lastSha && entry.lastSha !== snapshot.sha) { this.entries.delete(k); return }
    entry.lastSha = snapshot.sha
    if (this.opts.now() - entry.enqueuedAt > TIMEOUT_MS) { this.entries.delete(k); return }
    if (snapshot.mergeable === 'clean') {
      this.entries.delete(k)
      await this.opts.mergeApi(entry.slug, entry.prNumber, entry.method)
    }
  }

  notifyPrClosed(slug: string, pr: number): void { this.entries.delete(this.key(slug, pr)) }
  notifySessionClosed(sessionId: string): void {
    for (const [k, e] of this.entries) if (e.sessionId === sessionId) this.entries.delete(k)
  }

  cancel(slug: string, pr: number): void { this.entries.delete(this.key(slug, pr)) }
  isWatching(slug: string, pr: number): boolean { return this.entries.has(this.key(slug, pr)) }
  getEntry(slug: string, pr: number): MergeWatcherEntry | undefined { return this.entries.get(this.key(slug, pr)) }
}
```

- [ ] **Step 4: Passes (5 tests)**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sidebar-4): merge-when-clean watcher (main-side)"
```

---

## Task 8: Hook watcher into sync orchestrator

**Files:**
- Modify: `src/main/github/session/sync-orchestrator.ts`

In each PR snapshot tick, call `mergeWatcher.tick({ slug, prNumber, mergeable, sha })` with the fresh data. Also wire `notifyPrClosed` on PR state transition to `closed`.

Commit.

---

## Task 9: IPC for merge watcher + mergeWatcherStore

**Files:**
- Modify: `src/shared/ipc-channels.ts` — `MERGE_WATCHER_ENQUEUE`, `MERGE_WATCHER_CANCEL`, `MERGE_WATCHER_STATUS`.
- Create: `src/main/ipc/merge-watcher-handlers.ts`.
- Create: `src/renderer/stores/mergeWatcherStore.ts`.
- Modify: `src/preload/index.ts` + `src/renderer/types/electron.d.ts`.

Commit.

---

## Task 10: "Merge when clean" button in ActivePRSection

**Files:**
- Modify: `src/renderer/components/github/sections/ActivePRSection.tsx`

Button visible when:
- PR is open.
- `mergeableState === 'blocked'` (typically CI pending) OR `'unknown'`.
- No watcher for this (slug, prNumber) currently.

Clicking opens a small confirm: "Queue to merge once mergeable → clean?" with a `squash / merge / rebase` radio (defaults to user's last choice). On confirm → `mergeWatcherStore.enqueue(...)`. Once enqueued, button changes to "Merging when clean (cancel)".

Commit.

---

## Task 11: Typecheck + vitest + package

- [ ] Typecheck green, all unit tests green.
- [ ] `npm run package:win` — installer rebuilt.

## Task 12: Manual smoke

1. Open a Claude session that does edits; observe Session Context shows `+N/-M` chips on recent files.
2. Disable the master Hooks toggle; chips and Live Activity disappear immediately.
3. CI running → toggle 👁 on one job → trigger completion → desktop notification fires.
4. Open a PR that's blocked on CI but otherwise mergeable → click "Merge when clean" → once CI passes, PR merges automatically.
5. Close a session with an active merge watcher → watcher cancels.
6. Queue a merge + force-push the PR → watcher cancels.

## Task 13: PR

```bash
git push -u origin feat/sidebar-hooks-dependent
gh pr create --title "sidebar 4: hooks-dependent features (edit deltas, Live Activity, CI notify, merge-when-clean)" --body "..."
```

---

## Self-review checklist

- [ ] Every feature degrades cleanly when hooks are disabled.
- [ ] LiveActivityFooter honours `hiddenSections` (Phase 1a), `featureToggles` (existing), and `hooksEnabled` (hooks gateway).
- [ ] Edit deltas accumulate rather than overwrite.
- [ ] Merge watcher cancels on PR close / sha change / session close / timeout — all four paths tested.
- [ ] CI watch toggle stays scoped per session (not per-profile).
- [ ] No em dashes in user-facing copy.
- [ ] No `\u{...}` escapes in JSX.
- [ ] No new main-side state that isn't recoverable from disk on restart (watcher state is in-memory; surviving across restart is out of scope for MVP).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
