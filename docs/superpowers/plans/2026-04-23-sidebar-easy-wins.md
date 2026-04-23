# Sidebar Flexibility — Phase 2: Easy-Wins Section Upgrades + ScrollingFeed Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land all §1, §2, §3, §5, §7 content upgrades from the Sidebar Flexibility spec plus the minimal §4 wiring (ScrollingFeed + verdict pills only; the Reply-in-Claude UI is here but the button is introduced alongside Linked Issues because both consume the same readiness contract). No Hooks-Gateway-dependent bits. No Local Git.

**Branch:** `feat/sidebar-easy-wins` stacked on `feat/scrolling-feed` (Phase 1c). Assumes Phase 1a (data model) and Phase 1b (`<SectionOptionsPopover>` + `<ToastUndo>`) have merged.

**Architecture:** Each existing section gets surgical upgrades — no rewrites. `ScrollingFeed` wires into `ReviewsSection` and `NotificationsSection` as the thread list. A new `src/renderer/lib/claude-input-queue.ts` module owns the "Claude busy? queue or append" contract used by Reviews and Linked Issues. New IPC handlers live in `src/main/ipc/github-notifications-mutations.ts` for mark-read/snooze/unsubscribe. Snooze is enforced in `sync-orchestrator.ts` at fetch time so snoozed threads disappear from the payload until `resumesAt` passes.

**Tech Stack:** TypeScript strict, Zustand 5, React 18, Tailwind v4 (Catppuccin Mocha), vitest + @testing-library/react. No new dependencies.

---

## File structure

- Modify: `src/renderer/components/github/sections/SessionContextSection.tsx` — pin badge, reasoning line, show-more, closed-issue pill.
- Modify: `src/renderer/components/github/sections/ActivePRSection.tsx` — state pill + diff size header, labels chips, body preview, reviewers chips, mergeable detail, convert-to-draft.
- Modify: `src/renderer/components/github/sections/CISection.tsx` — two-line row, auto-expand on failure, filter chips, live summary pill.
- Modify: `src/renderer/components/github/sections/ReviewsSection.tsx` — ScrollingFeed thread list, filter chips, verdict mix pills.
- Modify: `src/renderer/components/github/sections/IssuesSection.tsx` — filter/sort, linkage reason, activity signal, labels, kebab menu. (Current file name kept — renaming would churn git blame; prefer small internal rename of the default-exported component to `LinkedIssuesSection`.)
- Modify: `src/renderer/components/github/sections/NotificationsSection.tsx` — all-profiles merge chip, reason chips, mark-all-read + undo, kebab with snooze/unsubscribe/dismiss, ScrollingFeed.
- Create: `src/renderer/lib/claude-input-queue.ts` — readiness contract for Reply-in-Claude.
- Create: `src/main/ipc/github-notifications-mutations.ts` — mark-read / snooze / unsubscribe IPC handlers.
- Modify: `src/shared/github-types.ts` — extend `WorkflowRunSnapshot` (if needed) and PR snapshot with fields the header/body/reviewers need (labels, bodyMarkdown, reviewers, mergeableDetail).
- Modify: `src/main/github/session/sync-orchestrator.ts` — filter snoozed threads; re-surface expired.
- Modify: `src/shared/ipc-channels.ts` — `GITHUB_NOTIFICATION_MARK_READ`, `GITHUB_NOTIFICATION_SNOOZE`, `GITHUB_NOTIFICATION_UNSUBSCRIBE`, `GITHUB_ISSUE_UNLINK`, `GITHUB_SESSION_PIN_ISSUE`, `GITHUB_PR_SET_DRAFT`.
- Modify: `src/preload/index.ts` + `src/renderer/types/electron.d.ts` — bridge the new channels.
- Tests: one `.test.tsx` per modified section + `claude-input-queue.test.ts` + handler tests.

All new files ≤250 LOC. Existing sections gain ≤150 LOC each.

---

### Task 1: Shared types — PR details, linkage reason, notification reason, kebab actions

**Files:**
- Modify: `src/shared/github-types.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/github-types-phase2.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  PullRequestSnapshot,
  LinkedIssueSnapshot,
  NotificationSnapshot,
  LinkageReason,
  NotificationReason,
} from '../../../src/shared/github-types'

describe('phase2 shared types', () => {
  it('PullRequestSnapshot accepts labels, bodyMarkdown, reviewers, mergeableDetail', () => {
    const pr: PullRequestSnapshot = {
      number: 15, title: 't', state: 'open', draft: false,
      additions: 412, deletions: 38, changedFiles: 14,
      mergeable: 'conflict',
      labels: [{ name: 'bug', color: 'f00' }],
      bodyMarkdown: 'text',
      reviewers: [{ login: 'a', avatarUrl: 'u', verdict: 'approved' }],
      mergeableDetail: { conflictingFiles: ['a.ts'], baseBranch: 'main' },
    } as PullRequestSnapshot
    expect(pr.labels?.[0].name).toBe('bug')
  })
  it('LinkedIssueSnapshot accepts reason, commentCount, lastActivityAt, labels', () => {
    const li: LinkedIssueSnapshot = {
      number: 42, title: 'x', state: 'open',
      reason: 'branch',
      commentCount: 3, lastActivityAt: Date.now(),
      labels: [{ name: 'doc', color: 'fff' }],
    } as LinkedIssueSnapshot
    const r: LinkageReason = li.reason!
    expect(r).toBe('branch')
  })
  it('NotificationSnapshot accepts reason enum', () => {
    const n: NotificationSnapshot = { id: 't1', title: 'x', repo: 'a/b', url: 'u', updatedAt: 0, unread: true, reason: 'review_requested' } as NotificationSnapshot
    const r: NotificationReason = n.reason!
    expect(r).toBe('review_requested')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/github-types-phase2.test.ts`
Expected: FAIL — missing fields and types.

- [ ] **Step 3: Extend the types**

In `src/shared/github-types.ts`, extend/add:

```ts
export type LinkageReason = 'pr-body' | 'branch' | 'transcript'
export type NotificationReason =
  | 'review_requested' | 'mention' | 'assign' | 'author'
  | 'comment' | 'team_mention' | 'subscribed' | 'security_alert' | 'other'

export interface Label { name: string; color: string }
export interface Reviewer {
  login: string
  avatarUrl?: string
  verdict: 'approved' | 'changes_requested' | 'commented' | 'requested' | 'dismissed'
}
export interface MergeableDetail {
  conflictingFiles?: string[]
  baseBranch?: string
}

// Extend the existing PullRequestSnapshot with optional fields:
//   labels?: Label[]
//   bodyMarkdown?: string
//   reviewers?: Reviewer[]
//   mergeableDetail?: MergeableDetail

// Extend the existing LinkedIssueSnapshot with:
//   reason?: LinkageReason
//   commentCount?: number
//   lastActivityAt?: number
//   labels?: Label[]

// Extend the existing NotificationSnapshot with:
//   reason?: NotificationReason
//   profileId?: string
//   returnedFromSnooze?: boolean

export type IssueKebabAction =
  | 'open' | 'reply-in-claude' | 'copy-ref' | 'pin-primary' | 'unlink'
export type NotificationKebabAction =
  | 'open' | 'mark-read' | 'snooze-2h' | 'snooze-tomorrow' | 'unsubscribe' | 'dismiss'
```

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/shared/github-types.ts tests/unit/shared/github-types-phase2.test.ts
git commit -m "feat(sidebar): extend shared types for Phase 2 (labels, reviewers, reasons)"
```

---

### Task 2: Sync orchestrator — populate new PR fields + linkage reason + notification reason

**Files:**
- Modify: `src/main/github/session/sync-orchestrator.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/sync-orchestrator-phase2.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapRestPullToSnapshot, decideLinkageReason, mapNotificationReason } from '../../src/main/github/session/sync-orchestrator'

describe('sync-orchestrator phase 2 mappers', () => {
  it('populates labels / bodyMarkdown / reviewers / mergeableDetail on PR snapshot', () => {
    const raw = {
      number: 1, state: 'open', draft: false, title: 't',
      additions: 10, deletions: 2, changed_files: 3,
      mergeable_state: 'dirty', mergeable: false, body: 'hi',
      labels: [{ name: 'bug', color: 'ff0000' }],
      requested_reviewers: [{ login: 'b', avatar_url: 'ab' }],
      base: { ref: 'main' },
    }
    const files = ['conflict.ts']
    const reviews = [{ user: { login: 'a', avatar_url: 'aa' }, state: 'APPROVED' }]
    const pr = mapRestPullToSnapshot(raw, files, reviews)
    expect(pr.labels?.[0].name).toBe('bug')
    expect(pr.bodyMarkdown).toBe('hi')
    expect(pr.reviewers?.find((r) => r.login === 'a')?.verdict).toBe('approved')
    expect(pr.reviewers?.find((r) => r.login === 'b')?.verdict).toBe('requested')
    expect(pr.mergeableDetail?.conflictingFiles).toEqual(['conflict.ts'])
    expect(pr.mergeableDetail?.baseBranch).toBe('main')
  })
  it('decideLinkageReason picks pr-body > branch > transcript by precedence', () => {
    expect(decideLinkageReason({ prBody: [42], branch: [42], transcript: [42] }, 42)).toBe('pr-body')
    expect(decideLinkageReason({ prBody: [], branch: [42], transcript: [42] }, 42)).toBe('branch')
    expect(decideLinkageReason({ prBody: [], branch: [], transcript: [42] }, 42)).toBe('transcript')
    expect(decideLinkageReason({ prBody: [], branch: [], transcript: [] }, 42)).toBeUndefined()
  })
  it('mapNotificationReason covers each GH reason', () => {
    expect(mapNotificationReason('review_requested')).toBe('review_requested')
    expect(mapNotificationReason('mention')).toBe('mention')
    expect(mapNotificationReason('assign')).toBe('assign')
    expect(mapNotificationReason('author')).toBe('author')
    expect(mapNotificationReason('ci_activity')).toBe('other')
  })
})
```

- [ ] **Step 2: Run test — FAIL** (exports missing)

- [ ] **Step 3: Export + implement the mappers**

Add to `sync-orchestrator.ts`:

```ts
export function decideLinkageReason(
  sources: { prBody: number[]; branch: number[]; transcript: number[] },
  issueNumber: number,
): LinkageReason | undefined {
  if (sources.prBody.includes(issueNumber)) return 'pr-body'
  if (sources.branch.includes(issueNumber)) return 'branch'
  if (sources.transcript.includes(issueNumber)) return 'transcript'
  return undefined
}

export function mapNotificationReason(raw: string | undefined): NotificationReason {
  if (!raw) return 'other'
  const allowed: NotificationReason[] = [
    'review_requested', 'mention', 'assign', 'author',
    'comment', 'team_mention', 'subscribed', 'security_alert',
  ]
  return (allowed as string[]).includes(raw) ? (raw as NotificationReason) : 'other'
}

export function mapRestPullToSnapshot(
  raw: any,
  conflictingFiles: string[] | undefined,
  reviews: Array<{ user?: { login: string; avatar_url?: string }; state: string }>,
): PullRequestSnapshot {
  const labels: Label[] = Array.isArray(raw.labels)
    ? raw.labels.map((l: any) => ({ name: String(l.name ?? ''), color: String(l.color ?? '') }))
    : []
  const reviewers: Reviewer[] = []
  for (const rev of reviews) {
    const login = rev.user?.login
    if (!login) continue
    const verdict: Reviewer['verdict'] =
      rev.state === 'APPROVED' ? 'approved' :
      rev.state === 'CHANGES_REQUESTED' ? 'changes_requested' :
      rev.state === 'DISMISSED' ? 'dismissed' : 'commented'
    reviewers.push({ login, avatarUrl: rev.user?.avatar_url, verdict })
  }
  for (const r of raw.requested_reviewers ?? []) {
    if (!reviewers.find((x) => x.login === r.login)) {
      reviewers.push({ login: r.login, avatarUrl: r.avatar_url, verdict: 'requested' })
    }
  }
  const mergeableDetail: MergeableDetail | undefined =
    raw.mergeable_state === 'dirty' || raw.mergeable === false
      ? { conflictingFiles, baseBranch: raw.base?.ref }
      : undefined
  return {
    number: raw.number, title: raw.title, state: raw.state, draft: Boolean(raw.draft),
    additions: raw.additions ?? 0, deletions: raw.deletions ?? 0,
    changedFiles: raw.changed_files ?? 0,
    mergeable: raw.mergeable_state === 'clean' ? 'clean'
      : raw.mergeable_state === 'dirty' ? 'conflict'
      : raw.mergeable_state === 'blocked' ? 'blocked' : 'unknown',
    labels, bodyMarkdown: raw.body ?? undefined,
    reviewers, mergeableDetail,
  } as PullRequestSnapshot
}
```

Wire the orchestrator's PR-fetch path to use this mapper; wire linked-issue collection to stamp `reason` / `commentCount` / `lastActivityAt` / `labels`; wire notifications to populate `reason` + `profileId`.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/main/github/session/sync-orchestrator.ts tests/unit/main/sync-orchestrator-phase2.test.ts
git commit -m "feat(sidebar): populate Phase 2 snapshot fields in sync orchestrator"
```

---

### Task 3: Snooze enforcement in orchestrator — filter-at-fetch with re-surface

**Files:**
- Modify: `src/main/github/session/sync-orchestrator.ts`
- Modify: `src/main/github/github-config-store.ts` (use `getActiveSnoozes` and add `wasSnoozed` helper)

- [ ] **Step 1: Failing test**

Append to `tests/unit/main/sync-orchestrator-phase2.test.ts`:

```ts
import { applySnoozeFilter } from '../../src/main/github/session/sync-orchestrator'

describe('applySnoozeFilter', () => {
  it('drops items whose snooze key is still active', () => {
    const items = [{ id: 't1', profileId: 'p1' }, { id: 't2', profileId: 'p1' }] as any[]
    const out = applySnoozeFilter(items, new Set(['p1:t1']), new Set())
    expect(out.map((x) => x.id)).toEqual(['t2'])
  })
  it('flags returned-from-snooze when key was active previously', () => {
    const items = [{ id: 't1', profileId: 'p1' }] as any[]
    const out = applySnoozeFilter(items, new Set(), new Set(['p1:t1']))
    expect(out[0].returnedFromSnooze).toBe(true)
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```ts
export function applySnoozeFilter(
  items: NotificationSnapshot[],
  activeKeys: Set<string>,
  previouslyActiveKeys: Set<string>,
): NotificationSnapshot[] {
  const out: NotificationSnapshot[] = []
  for (const n of items) {
    const key = `${n.profileId ?? ''}:${n.id}`
    if (activeKeys.has(key)) continue
    if (previouslyActiveKeys.has(key)) out.push({ ...n, returnedFromSnooze: true })
    else out.push(n)
  }
  return out
}
```

In the notifications fetch tick, read `getActiveSnoozes(now)` → pass to `applySnoozeFilter`; keep an in-memory `Set<string>` of last-tick active keys so we can compute `previouslyActiveKeys` (set-diff `prev - current`). Call `clearExpiredSnoozes(now)` once per hour to shrink the store.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/main/github/session/sync-orchestrator.ts tests/unit/main/sync-orchestrator-phase2.test.ts
git commit -m "feat(sidebar): filter snoozed notifications at sync time; flag re-surfaced"
```

---

### Task 4: IPC channels + preload bridge — mutations for notifications, issues, PR draft, session pin

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/shared/ipc-channels-phase2.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
describe('phase 2 channels', () => {
  it('exposes channels', () => {
    expect(IPC.GITHUB_NOTIFICATION_MARK_READ).toBe('github:notification:markRead')
    expect(IPC.GITHUB_NOTIFICATION_MARK_ALL_READ).toBe('github:notification:markAllRead')
    expect(IPC.GITHUB_NOTIFICATION_SNOOZE).toBe('github:notification:snooze')
    expect(IPC.GITHUB_NOTIFICATION_UNSUBSCRIBE).toBe('github:notification:unsubscribe')
    expect(IPC.GITHUB_ISSUE_UNLINK).toBe('github:issue:unlink')
    expect(IPC.GITHUB_SESSION_PIN_ISSUE).toBe('github:session:pinIssue')
    expect(IPC.GITHUB_PR_SET_DRAFT).toBe('github:pr:setDraft')
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add channels**

In `src/shared/ipc-channels.ts`:

```ts
  GITHUB_NOTIFICATION_MARK_READ: 'github:notification:markRead',
  GITHUB_NOTIFICATION_MARK_ALL_READ: 'github:notification:markAllRead',
  GITHUB_NOTIFICATION_SNOOZE: 'github:notification:snooze',
  GITHUB_NOTIFICATION_UNSUBSCRIBE: 'github:notification:unsubscribe',
  GITHUB_ISSUE_UNLINK: 'github:issue:unlink',
  GITHUB_SESSION_PIN_ISSUE: 'github:session:pinIssue',
  GITHUB_PR_SET_DRAFT: 'github:pr:setDraft',
```

- [ ] **Step 4: Extend preload bridge**

In `src/preload/index.ts`, inside the `github` namespace:

```ts
      markNotificationRead: (profileId: string, threadId: string) =>
        ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_MARK_READ, profileId, threadId),
      markAllNotificationsRead: (profileId: string | null) =>
        ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_MARK_ALL_READ, profileId),
      snoozeNotification: (profileId: string, threadId: string, resumesAt: number) =>
        ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_SNOOZE, profileId, threadId, resumesAt),
      unsubscribeThread: (profileId: string, threadId: string) =>
        ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_UNSUBSCRIBE, profileId, threadId),
      unlinkIssue: (sessionId: string, number: number) =>
        ipcRenderer.invoke(IPC.GITHUB_ISSUE_UNLINK, sessionId, number),
      pinSessionIssue: (sessionId: string, number: number | null) =>
        ipcRenderer.invoke(IPC.GITHUB_SESSION_PIN_ISSUE, sessionId, number),
      setPullRequestDraft: (profileId: string, slug: string, number: number, draft: boolean) =>
        ipcRenderer.invoke(IPC.GITHUB_PR_SET_DRAFT, profileId, slug, number, draft),
```

Add matching typed method declarations in `src/renderer/types/electron.d.ts`.

- [ ] **Step 5: Tests + typecheck pass; commit**

```bash
git add src/shared/ipc-channels.ts src/preload/index.ts src/renderer/types/electron.d.ts tests/unit/shared/ipc-channels-phase2.test.ts
git commit -m "feat(sidebar): IPC channels and preload bridge for Phase 2 mutations"
```

---

### Task 5: Main-side handlers — notifications mutations + session pin + issue unlink + PR draft

**Files:**
- Create: `src/main/ipc/github-notifications-mutations.ts`
- Modify: `src/main/ipc/github-handlers.ts` (just call the new registration fn from boot)

- [ ] **Step 1: Failing test**

Create `tests/unit/main/github-notifications-mutations.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const restCalls: Array<{ method: string; url: string }> = []
vi.mock('../../src/main/github/client/github-client', () => ({
  fetchWithAuth: vi.fn(async (profileId: string, url: string, init?: any) => {
    restCalls.push({ method: init?.method ?? 'GET', url })
    return { ok: true, status: 200, json: async () => ({}) }
  }),
}))
const writes: Array<{ key: string; data: any }> = []
vi.mock('../../src/main/config-manager', () => ({
  readConfig: vi.fn((k: string) => {
    if (k === 'github') return { schemaVersion: 2, snoozedNotifications: {} }
    if (k === 'sessions') return { sessions: [{ id: 's1', githubIntegration: { enabled: true, autoDetected: false } }] }
    return null
  }),
  writeConfig: vi.fn((k: string, d: any) => { writes.push({ key: k, data: d }) }),
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => undefined, logError: () => undefined }))

const handlers: Record<string, (...args: any[]) => any> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { handlers[ch] = fn } },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { registerGithubNotificationMutationHandlers } from '../../src/main/ipc/github-notifications-mutations'

describe('notification mutation handlers', () => {
  beforeEach(() => { restCalls.length = 0; writes.length = 0; for (const k of Object.keys(handlers)) delete handlers[k] })

  it('mark-read calls PATCH /notifications/threads/:id', async () => {
    registerGithubNotificationMutationHandlers()
    await handlers['github:notification:markRead'](null, 'p1', 't1')
    expect(restCalls.find((c) => c.url.endsWith('/notifications/threads/t1') && c.method === 'PATCH')).toBeTruthy()
  })

  it('unsubscribe calls DELETE /notifications/threads/:id/subscription', async () => {
    registerGithubNotificationMutationHandlers()
    await handlers['github:notification:unsubscribe'](null, 'p1', 't1')
    expect(restCalls.find((c) => c.url.endsWith('/subscription') && c.method === 'DELETE')).toBeTruthy()
  })

  it('snooze writes to github config and does NOT call REST', async () => {
    registerGithubNotificationMutationHandlers()
    await handlers['github:notification:snooze'](null, 'p1', 't1', Date.now() + 7200000)
    expect(restCalls.length).toBe(0)
    const saved = writes.find((w) => w.key === 'github')?.data
    expect(saved.snoozedNotifications['p1:t1']).toBeGreaterThan(0)
  })

  it('pin-session-issue writes pinnedIssueNumber; null clears it', async () => {
    registerGithubNotificationMutationHandlers()
    await handlers['github:session:pinIssue'](null, 's1', 42)
    let gi = writes.at(-1)!.data.sessions[0].githubIntegration
    expect(gi.pinnedIssueNumber).toBe(42)
    await handlers['github:session:pinIssue'](null, 's1', null)
    gi = writes.at(-1)!.data.sessions[0].githubIntegration
    expect(gi.pinnedIssueNumber).toBeUndefined()
  })

  it('unlink-issue appends to unlinkedIssues (dedup)', async () => {
    registerGithubNotificationMutationHandlers()
    await handlers['github:issue:unlink'](null, 's1', 5)
    await handlers['github:issue:unlink'](null, 's1', 5)
    const gi = writes.at(-1)!.data.sessions[0].githubIntegration
    expect(gi.unlinkedIssues).toEqual([5])
  })

  it('pr-set-draft calls GraphQL conversion endpoint', async () => {
    registerGithubNotificationMutationHandlers()
    await handlers['github:pr:setDraft'](null, 'p1', 'o/r', 15, true)
    expect(restCalls.find((c) => c.url.endsWith('/graphql') && c.method === 'POST')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Create `src/main/ipc/github-notifications-mutations.ts`:

```ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { fetchWithAuth } from '../github/client/github-client'
import { readConfig, writeConfig } from '../config-manager'
import { setSnooze } from '../github/github-config-store'
import type { SessionGitHubIntegration } from '../../shared/github-types'

function updateSession(sessionId: string, update: (gi: SessionGitHubIntegration) => SessionGitHubIntegration) {
  const cfg = readConfig<{ sessions: Array<{ id: string; githubIntegration?: SessionGitHubIntegration }> }>('sessions')
  if (!cfg) return { ok: false, error: 'no-sessions' }
  const s = cfg.sessions.find((x) => x.id === sessionId)
  if (!s) return { ok: false, error: 'session-not-found' }
  s.githubIntegration = update(s.githubIntegration ?? { enabled: true, autoDetected: false })
  writeConfig('sessions', cfg)
  return { ok: true }
}

export function registerGithubNotificationMutationHandlers(): void {
  ipcMain.handle(IPC.GITHUB_NOTIFICATION_MARK_READ, async (_e, profileId: string, threadId: string) => {
    const r = await fetchWithAuth(profileId, `https://api.github.com/notifications/threads/${threadId}`, { method: 'PATCH' })
    return { ok: r.ok, status: r.status }
  })
  ipcMain.handle(IPC.GITHUB_NOTIFICATION_MARK_ALL_READ, async (_e, profileId: string | null) => {
    // Per-profile OR all profiles: if null, iterate profile IDs from config and call each.
    const url = 'https://api.github.com/notifications'
    if (profileId) { const r = await fetchWithAuth(profileId, url, { method: 'PUT' }); return { ok: r.ok } }
    const cfg = readConfig<{ authProfiles: Record<string, unknown> }>('github')
    const ids = Object.keys(cfg?.authProfiles ?? {})
    for (const id of ids) await fetchWithAuth(id, url, { method: 'PUT' })
    return { ok: true }
  })
  ipcMain.handle(IPC.GITHUB_NOTIFICATION_SNOOZE, async (_e, profileId: string, threadId: string, resumesAt: number) => {
    if (typeof resumesAt !== 'number' || resumesAt <= Date.now()) return { ok: false, error: 'bad-resumesAt' }
    setSnooze(`${profileId}:${threadId}`, resumesAt)
    return { ok: true }
  })
  ipcMain.handle(IPC.GITHUB_NOTIFICATION_UNSUBSCRIBE, async (_e, profileId: string, threadId: string) => {
    const r = await fetchWithAuth(profileId, `https://api.github.com/notifications/threads/${threadId}/subscription`, { method: 'DELETE' })
    return { ok: r.ok }
  })
  ipcMain.handle(IPC.GITHUB_ISSUE_UNLINK, async (_e, sessionId: string, number: number) => {
    return updateSession(sessionId, (gi) => {
      const prev = gi.unlinkedIssues ?? []
      if (prev.includes(number)) return gi
      return { ...gi, unlinkedIssues: [...prev, number] }
    })
  })
  ipcMain.handle(IPC.GITHUB_SESSION_PIN_ISSUE, async (_e, sessionId: string, number: number | null) => {
    return updateSession(sessionId, (gi) => {
      if (number === null) { const { pinnedIssueNumber, ...rest } = gi; return rest }
      return { ...gi, pinnedIssueNumber: number }
    })
  })
  ipcMain.handle(IPC.GITHUB_PR_SET_DRAFT, async (_e, profileId: string, slug: string, number: number, draft: boolean) => {
    // GitHub requires GraphQL for markPullRequestReadyForReview / convertPullRequestToDraft.
    const query = draft
      ? 'mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest { id } } }'
      : 'mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest { id } } }'
    // Resolve node id via REST first (kept minimal here; a helper lives in github-client).
    const idResp = await fetchWithAuth(profileId, `https://api.github.com/repos/${slug}/pulls/${number}`)
    const idBody = await idResp.json()
    const resp = await fetchWithAuth(profileId, 'https://api.github.com/graphql', {
      method: 'POST', body: JSON.stringify({ query, variables: { id: idBody.node_id } }),
      headers: { 'Content-Type': 'application/json' },
    })
    return { ok: resp.ok }
  })
}
```

Call `registerGithubNotificationMutationHandlers()` from the main boot registration in `github-handlers.ts`.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/github-notifications-mutations.ts src/main/ipc/github-handlers.ts tests/unit/main/github-notifications-mutations.test.ts
git commit -m "feat(sidebar): main-side handlers for notifications/issues/PR Phase 2 mutations"
```

---

### Task 6: `claude-input-queue.ts` — Reply-in-Claude readiness contract

**Files:**
- Create: `src/renderer/lib/claude-input-queue.ts`
- Create: `tests/unit/renderer/lib/claude-input-queue.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = {
  ptyWrite: vi.fn(async () => ({ ok: true })),
  focusSession: vi.fn(async () => ({ ok: true })),
  getTranscriptState: vi.fn(async () => ({ ok: true, data: { lastEventType: 'idle', userBufferedInput: '' } })),
  onTranscriptEvent: vi.fn((_sid: string, _cb: (ev: any) => void) => () => undefined),
}
;(globalThis as any).window = {
  electronAPI: {
    pty: { write: mocks.ptyWrite },
    session: { focus: mocks.focusSession },
    transcript: { getState: mocks.getTranscriptState, onEvent: mocks.onTranscriptEvent },
  },
}

import { queueReplyInClaude, __resetQueueForTests } from '../../../src/renderer/lib/claude-input-queue'

describe('queueReplyInClaude', () => {
  beforeEach(() => { __resetQueueForTests(); vi.clearAllMocks() })

  it('writes immediately when session is idle and focused with empty buffer', async () => {
    mocks.getTranscriptState.mockResolvedValue({ ok: true, data: { lastEventType: 'idle', userBufferedInput: '' } })
    const res = await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true })
    expect(res.status).toBe('sent')
    expect(mocks.ptyWrite).toHaveBeenCalledWith('s1', 'hi')
  })

  it('appends a leading newline when idle but user has typed something', async () => {
    mocks.getTranscriptState.mockResolvedValue({ ok: true, data: { lastEventType: 'idle', userBufferedInput: 'abc' } })
    await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true })
    expect(mocks.ptyWrite).toHaveBeenCalledWith('s1', '\nhi')
  })

  it('focuses the session first when it is not focused', async () => {
    mocks.getTranscriptState.mockResolvedValue({ ok: true, data: { lastEventType: 'idle', userBufferedInput: '' } })
    await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: false })
    expect(mocks.focusSession).toHaveBeenCalledWith('s1')
  })

  it('queues when busy and returns status=queued; fires on next user-input-expected', async () => {
    mocks.getTranscriptState.mockResolvedValue({ ok: true, data: { lastEventType: 'tool-call', userBufferedInput: '' } })
    let emit: ((ev: any) => void) | null = null
    mocks.onTranscriptEvent.mockImplementation((_sid: string, cb: any) => { emit = cb; return () => undefined })
    const prompter = vi.fn(async () => 'queue' as const)
    const res = await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true, prompter })
    expect(res.status).toBe('queued')
    expect(prompter).toHaveBeenCalled()
    expect(mocks.ptyWrite).not.toHaveBeenCalled()
    emit!({ type: 'user-input-expected' })
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.ptyWrite).toHaveBeenCalledWith('s1', 'hi')
  })

  it('returns status=cancelled when the user cancels the prompt', async () => {
    mocks.getTranscriptState.mockResolvedValue({ ok: true, data: { lastEventType: 'response', userBufferedInput: '' } })
    const prompter = vi.fn(async () => 'cancel' as const)
    const res = await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true, prompter })
    expect(res.status).toBe('cancelled')
    expect(mocks.ptyWrite).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Create `src/renderer/lib/claude-input-queue.ts`:

```ts
export type ReplyPrompterResult = 'queue' | 'cancel'
export type ReplyPrompter = (opts: { sessionId: string; text: string }) => Promise<ReplyPrompterResult>

interface Args {
  sessionId: string
  text: string
  focused: boolean
  prompter?: ReplyPrompter
}

interface QueueEntry { text: string; unsubscribe: () => void }
const queued = new Map<string, QueueEntry>()

const defaultPrompter: ReplyPrompter = async ({ sessionId, text }) => {
  // Placeholder — in the real app this renders a <ToastUndo>-style toast with Queue / Cancel.
  // Keeping the contract as a function so tests can stub it and the UI can inject its own prompt.
  // Default: decline the queue to avoid clobbering user input when wired incorrectly.
  void sessionId; void text
  return 'cancel'
}

export async function queueReplyInClaude({ sessionId, text, focused, prompter }: Args) {
  const api = window.electronAPI
  if (!focused) await api.session.focus(sessionId)

  const stateResp = await api.transcript.getState(sessionId)
  const state = stateResp?.ok ? stateResp.data : { lastEventType: 'idle', userBufferedInput: '' }

  const busy = state.lastEventType === 'tool-call' || state.lastEventType === 'response'

  if (!busy) {
    const prefix = state.userBufferedInput && state.userBufferedInput.length > 0 ? '\n' : ''
    await api.pty.write(sessionId, `${prefix}${text}`)
    return { status: 'sent' as const }
  }

  const ask = prompter ?? defaultPrompter
  const decision = await ask({ sessionId, text })
  if (decision === 'cancel') return { status: 'cancelled' as const }

  // Replace any prior queued entry for this session (most recent wins).
  const prev = queued.get(sessionId)
  if (prev) prev.unsubscribe()

  const unsubscribe = api.transcript.onEvent(sessionId, (ev: { type: string }) => {
    if (ev.type !== 'user-input-expected') return
    const entry = queued.get(sessionId)
    if (!entry) return
    queued.delete(sessionId)
    entry.unsubscribe()
    void api.pty.write(sessionId, entry.text)
  })
  queued.set(sessionId, { text, unsubscribe })
  return { status: 'queued' as const }
}

export function __resetQueueForTests(): void {
  for (const [, v] of queued) v.unsubscribe()
  queued.clear()
}
```

(The `window.electronAPI.transcript.getState` and `onEvent` are new shapes — add them to preload + types in Task 4's companion. Scope callout: if the transcript event channel doesn't exist yet, scaffold it minimally here — one IPC event per `user-input-expected` emit from `src/main/utils/claude-project-path.ts`'s transcript tail. Flag to reviewer if this needs to be its own prior task; for plan purposes, the bridge additions fit inside Task 4.)

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/claude-input-queue.ts tests/unit/renderer/lib/claude-input-queue.test.ts
git commit -m "feat(sidebar): Reply-in-Claude readiness contract with queue-on-busy"
```

---

### Task 7: `SessionContextSection` — pin badge + pin/unpin action

**Files:**
- Modify: `src/renderer/components/github/sections/SessionContextSection.tsx`

- [ ] **Step 1: Failing test**

Create `tests/unit/renderer/components/github/SessionContextSection.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const api = {
  github: {
    getSessionContext: vi.fn(async () => ({ ok: true, data: {
      primaryIssue: { number: 42, title: 't', state: 'closed' },
      otherSignals: [{ number: 7, source: 'branch' }],
      activePR: null,
      recentFiles: Array.from({ length: 8 }, (_, i) => ({ filePath: `f${i}.ts`, at: Date.now() })),
    }}) ),
    pinSessionIssue: vi.fn(async () => ({ ok: true })),
  },
}
;(globalThis as any).window = { electronAPI: api }
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: () => undefined }))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: [{ id: 's1', githubIntegration: { pinnedIssueNumber: 42 } }] }),
}))

import SessionContextSection from '../../../src/renderer/components/github/sections/SessionContextSection'

describe('SessionContextSection', () => {
  it('shows pin badge when pinnedIssueNumber matches primaryIssue', async () => {
    render(<SessionContextSection sessionId="s1" />)
    expect(await screen.findByLabelText(/pinned/i)).toBeInTheDocument()
  })
  it('shows closed warning pill with muted colour', async () => {
    render(<SessionContextSection sessionId="s1" />)
    expect(await screen.findByText('closed')).toHaveClass(/overlay/)
  })
  it('renders show-more past 5 recent files', async () => {
    render(<SessionContextSection sessionId="s1" />)
    expect(await screen.findByRole('button', { name: /show \d+ more/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add pin selector + reasoning lookup**

Modify the component. Keep the existing `default export` shape (sole export of file). Add:

```tsx
import { useSessionStore } from '../../../stores/sessionStore'
// ...
const pinned = useSessionStore((s) =>
  s.sessions.find((x) => x.id === sessionId)?.githubIntegration?.pinnedIssueNumber,
)
const isPinned = ctx?.primaryIssue?.number === pinned
const [showAllFiles, setShowAllFiles] = useState(false)
const visibleFiles = showAllFiles ? ctx?.recentFiles ?? [] : (ctx?.recentFiles ?? []).slice(0, 5)
const extra = (ctx?.recentFiles.length ?? 0) - visibleFiles.length
```

In the primary-issue block, add after the state pill:

```tsx
{isPinned && (
  <span aria-label="pinned" title="Pinned for this session" className="ml-2 text-[10px]">
    {String.fromCodePoint(0x1f4cc)}
  </span>
)}
<button
  className="ml-2 text-[10px] text-overlay0 hover:text-subtext0"
  onClick={() => window.electronAPI.github.pinSessionIssue(sessionId, isPinned ? null : ctx!.primaryIssue!.number)}
>
  {isPinned ? 'Unpin' : 'Pin'}
</button>
```

Change the closed-state pill colour to muted when `state === 'closed'` (re-use `bg-overlay0/20 text-overlay1`; that's already the path in the component — add a warning tooltip: `title="Closed — consider reviewing pin"`).

- [ ] **Step 4: Reasoning lines per candidate**

The snapshot already includes `otherSignals[i].source` — render it next to each row:

```tsx
<li key={`${s.source}:${s.repo ?? ''}:${s.number}`}>
  #{s.number}{' '}
  <span className="text-overlay0">
    ({s.source === 'branch' ? 'branch match' : s.source === 'pr-body' ? 'PR body ref' : 'transcript ref'})
  </span>
</li>
```

- [ ] **Step 5: Show-more files**

Replace the files list with:

```tsx
{visibleFiles.map((f) => ( /* existing li */ ))}
{extra > 0 && (
  <button className="text-overlay0 hover:text-subtext0" onClick={() => setShowAllFiles(true)}>
    Show {extra} more
  </button>
)}
```

- [ ] **Step 6: `sectionPrefs.skipClosed` rule**

Read `sectionPrefs?.sessionContext?.skipClosed` from the session; if true AND primaryIssue is closed, swap the rendered title for "Auto-skip closed" and surface the other-signals list prominently. One-line guard at the top of the JSX branch.

- [ ] **Step 7: Tests pass**

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/github/sections/SessionContextSection.tsx tests/unit/renderer/components/github/SessionContextSection.test.tsx
git commit -m "feat(sidebar): Session Context pin, reasoning, show-more, closed warning"
```

---

### Task 8: `ActivePRSection` — header (state pill + diff size + files)

**Files:**
- Modify: `src/renderer/components/github/sections/ActivePRSection.tsx`

- [ ] **Step 1: Failing test**

Append to a new `tests/unit/renderer/components/github/ActivePRSection.test.tsx`:

```tsx
it('renders "#15 · open · +412/−38 · 14 files" header line', () => {
  const pr = { number: 15, state: 'open', draft: false, additions: 412, deletions: 38, changedFiles: 14 }
  renderWith(pr)
  expect(screen.getByTestId('pr-header')).toHaveTextContent('#15 · open · +412/-38 · 14 files')
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement header**

Add near the top of the PR body render:

```tsx
<div data-testid="pr-header" className="flex items-center gap-2 text-xs">
  <span className="text-mauve">#{pr.number}</span>
  <span className={`px-1 rounded ${pr.state === 'open' ? 'bg-green/20 text-green' : 'bg-overlay0/20 text-overlay1'}`}>
    {pr.draft ? 'draft' : pr.state}
  </span>
  <span className="text-green">+{pr.additions}</span>
  <span className="text-red">-{pr.deletions}</span>
  <span className="text-overlay0">{pr.changedFiles} files</span>
</div>
```

Public-facing strings use the ASCII minus sign in `+412/-38` (no em dashes; `·` is an interpunct, acceptable per existing conventions).

- [ ] **Step 4: PASS + commit**

---

### Task 9: `ActivePRSection` — labels chips + body preview + reviewers chips

- [ ] **Step 1: Failing test**

```tsx
it('renders labels as chips', () => {
  renderWith({ labels: [{ name: 'bug', color: 'ff0000' }] })
  expect(screen.getByText('bug')).toBeInTheDocument()
})
it('renders body preview truncated to 200 chars and expands on click', async () => {
  renderWith({ bodyMarkdown: 'x'.repeat(500) })
  expect(screen.getByTestId('pr-body-preview').textContent!.length).toBeLessThanOrEqual(203) // 200 + ellipsis
  fireEvent.click(screen.getByRole('button', { name: /show more/i }))
  expect(screen.getByTestId('pr-body-preview').textContent!.length).toBeGreaterThan(400)
})
it('renders reviewer chips with verdict pills', () => {
  renderWith({ reviewers: [{ login: 'alice', verdict: 'approved' }] })
  expect(screen.getByText('alice')).toBeInTheDocument()
  expect(screen.getByText(/approved/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
{pr.labels && pr.labels.length > 0 && (
  <div className="mt-1 flex flex-wrap gap-1">
    {pr.labels.map((l) => (
      <span key={l.name} className="rounded px-1 text-[10px]" style={{ backgroundColor: `#${l.color}30`, color: `#${l.color}` }}>
        {l.name}
      </span>
    ))}
  </div>
)}

{pr.bodyMarkdown && (() => {
  const [expanded, setExpanded] = useState(false)
  const text = expanded || pr.bodyMarkdown.length <= 200 ? pr.bodyMarkdown : pr.bodyMarkdown.slice(0, 200) + '…'
  return (
    <div className="mt-1 text-xs">
      <div data-testid="pr-body-preview" className="text-subtext0 whitespace-pre-wrap">{text}</div>
      {pr.bodyMarkdown.length > 200 && (
        <button className="text-overlay0 hover:text-subtext0" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
})()}

{pr.reviewers && pr.reviewers.length > 0 && (
  <div className="mt-1 flex flex-wrap gap-1">
    {pr.reviewers.map((r) => (
      <span key={r.login} className="flex items-center gap-1 rounded bg-surface0 px-1 py-0.5 text-[10px]">
        {r.avatarUrl && <img src={r.avatarUrl} alt="" className="h-3 w-3 rounded-full" />}
        <span className="text-text">{r.login}</span>
        <span className={
          r.verdict === 'approved' ? 'text-green' :
          r.verdict === 'changes_requested' ? 'text-red' :
          r.verdict === 'requested' ? 'text-yellow' : 'text-overlay1'
        }>
          {r.verdict === 'approved' ? String.fromCodePoint(0x2713)
            : r.verdict === 'changes_requested' ? String.fromCodePoint(0x2717)
            : r.verdict === 'requested' ? String.fromCodePoint(0x23f3) : ''}
          {' '}{r.verdict.replace('_', ' ')}
        </span>
      </span>
    ))}
  </div>
)}
```

If `SanitizedMarkdown` exists for the body, swap the inner `<div>` for it. If not, the current plain-text path is acceptable for Phase 2 — mark a TODO inline and file a tracking issue.

- [ ] **Step 4: PASS + commit**

---

### Task 10: `ActivePRSection` — mergeable detail + convert-to-draft

- [ ] **Step 1: Failing test**

```tsx
it('shows conflicting files + base branch when mergeable=conflict', () => {
  renderWith({ mergeable: 'conflict', mergeableDetail: { conflictingFiles: ['a.ts','b.ts'], baseBranch: 'main' } })
  expect(screen.getByText(/a\.ts/)).toBeInTheDocument()
  expect(screen.getByText(/main/)).toBeInTheDocument()
})
it('shows "checking..." with spinner when mergeable=unknown', () => {
  renderWith({ mergeable: 'unknown' })
  expect(screen.getByText(/checking/i)).toBeInTheDocument()
})
it('convert-to-draft button calls setPullRequestDraft with draft=true', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.setPullRequestDraft = spy
  renderWith({ draft: false })
  fireEvent.click(screen.getByRole('button', { name: /convert to draft/i }))
  expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Number), true)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
{pr.mergeable === 'conflict' && pr.mergeableDetail && (
  <div className="mt-1 text-xs text-red">
    Conflicts against <code className="text-peach">{pr.mergeableDetail.baseBranch}</code>:
    <ul className="ml-3">
      {pr.mergeableDetail.conflictingFiles?.map((f) => <li key={f}><code className="text-peach">{f}</code></li>)}
    </ul>
  </div>
)}
{pr.mergeable === 'unknown' && (
  <div className="mt-1 text-xs text-overlay0">checking... {String.fromCodePoint(0x21bb)}</div>
)}

{!pr.draft && (
  <button
    className="mt-1 rounded px-2 py-1 text-xs text-overlay1 hover:bg-surface0 hover:text-text transition-colors duration-200"
    onClick={() => window.electronAPI.github.setPullRequestDraft(profileId, slug, pr.number, true)}
  >
    Convert to draft
  </button>
)}
```

`profileId` + `slug` come from existing section props (or from `useGithubStore`). If the section does not currently have the profile id, add it to the props — document in the commit.

- [ ] **Step 4: PASS + commit**

```bash
git add src/renderer/components/github/sections/ActivePRSection.tsx tests/unit/renderer/components/github/ActivePRSection.test.tsx
git commit -m "feat(sidebar): Active PR header, labels, body, reviewers, mergeable detail, convert-to-draft"
```

---

### Task 11: `CISection` — two-line run row

- [ ] **Step 1: Failing test**

```tsx
it('renders line 1 status + workflow + duration + actions, line 2 branch/sha/message/trigger/when', () => {
  render(<CISection runs={[{ id:1, status:'completed', conclusion:'failure', name:'CI', durationSec:73, headBranch:'feat/x', headSha:'abc1234', headMessage:'fix: y', event:'push', updatedAt:Date.now() }]} />)
  expect(screen.getByTestId('ci-line-1')).toHaveTextContent(/CI.*1m 13s/)
  expect(screen.getByTestId('ci-line-2')).toHaveTextContent(/feat\/x.*abc1234.*fix: y.*push/)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
<div data-testid="ci-line-1" className="flex items-center gap-2 text-xs">
  <span className={runColor(r)}>{runIcon(r)}</span>
  <span className="text-text font-medium">{r.name}</span>
  <span className="text-overlay0">{formatDuration(r.durationSec)}</span>
  <span className="ml-auto flex gap-1">{/* actions: open, watch, rerun */}</span>
</div>
<div data-testid="ci-line-2" className="text-[11px] text-overlay0 pl-5">
  on <span className="text-peach">{r.headBranch}</span>
  {' · '}<code>{r.headSha?.slice(0,7)}</code>
  {' · '}{r.headMessage}
  {' · '}{r.event}
  {' · '}{relativeTime(r.updatedAt)}
</div>
```

`formatDuration(seconds)` returns `Xm Ys` / `Xh Ym`.

- [ ] **Step 4: PASS + commit**

---

### Task 12: `CISection` — auto-expand on failure (failedJobs + tail-of-log)

- [ ] **Step 1: Failing test**

```tsx
it('auto-expands a failed run and shows failedJobs + tailLine inline', () => {
  render(<CISection runs={[{ id:1, status:'completed', conclusion:'failure', name:'CI',
    failedJobs: [{ id: 10, name: 'tests', tailLine: 'AssertionError: x' }] }]} />)
  expect(screen.getByText('tests')).toBeInTheDocument()
  expect(screen.getByText(/AssertionError/)).toBeInTheDocument()
})
it('respects sectionPrefs.autoExpandOnFailure=false', () => {
  renderWithPrefs({ autoExpandOnFailure: false }, { runs: [failureRun] })
  expect(screen.queryByText(/AssertionError/)).toBeNull()
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const autoExpand = sectionPrefs?.ci?.autoExpandOnFailure ?? true
const expanded = expandedRunIds.has(r.id) || (autoExpand && r.conclusion === 'failure')
{expanded && r.failedJobs && (
  <ul className="mt-1 ml-5 space-y-1 text-[11px]">
    {r.failedJobs.map((j) => (
      <li key={j.id}>
        <span className="text-red">{String.fromCodePoint(0x2717)}</span> {j.name}
        {j.tailLine && <pre className="mt-0.5 whitespace-pre-wrap bg-surface0 px-2 py-1 text-overlay1">{j.tailLine}</pre>}
      </li>
    ))}
  </ul>
)}
```

- [ ] **Step 4: PASS + commit**

---

### Task 13: `CISection` — filter chips + live summary pill

- [ ] **Step 1: Failing test**

```tsx
it('All/Failing/This branch/PR only filter each produce expected counts', () => {
  // render with 4 runs: 2 failing, 2 on branch "feat/x", 1 of those associated with PR
  // assert filter chips click → filtered list length
})
it('summary pill is green when all runs green, yellow when mixed, red when any failing', () => {
  renderWith({ runs: [greenRun, failingRun] })
  expect(screen.getByTestId('ci-summary-pill')).toHaveClass(/bg-red/)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const [filter, setFilter] = useState<'all' | 'failing' | 'this-branch' | 'pr-only'>(
  (sectionPrefs?.ci?.filter as any) ?? 'all'
)

const filtered = useMemo(() => {
  switch (filter) {
    case 'failing': return runs.filter((r) => r.conclusion === 'failure')
    case 'this-branch': return runs.filter((r) => r.headBranch === currentBranch)
    case 'pr-only': return runs.filter((r) => r.pullRequestNumbers && r.pullRequestNumbers.length > 0)
    default: return runs
  }
}, [runs, filter, currentBranch])

const summaryColor = useMemo(() => {
  if (runs.some((r) => r.conclusion === 'failure')) return 'bg-red/20 text-red'
  if (runs.some((r) => r.status === 'in_progress' || r.status === 'queued')) return 'bg-yellow/20 text-yellow'
  return 'bg-green/20 text-green'
}, [runs])
```

Chips render as a small segmented control with pill styling; persisted via `sectionPrefs.ci.filter` on change (call `setSectionPrefs(sessionId, 'ci', { filter })`).

- [ ] **Step 4: PASS + commit**

```bash
git add src/renderer/components/github/sections/CISection.tsx tests/unit/renderer/components/github/CISection.test.tsx
git commit -m "feat(sidebar): CI two-line row, auto-expand on failure, filter chips, live summary"
```

---

### Task 14: `ReviewsSection` — ScrollingFeed thread list + filter chips + verdict pills

- [ ] **Step 1: Failing test**

```tsx
it('wraps thread items in ScrollingFeed with feedId "reviews:<slug>:<pr>"', () => {
  render(<ReviewsSection sessionId="s1" threads={threeOpenThreads} />)
  expect(screen.getByTestId('scrolling-feed')).toHaveAttribute('data-feed-id', /reviews:/)
})
it('Open/Resolved/All chips filter thread list', () => {
  render(<ReviewsSection threads={twoOpenOneResolved} />)
  fireEvent.click(screen.getByRole('button', { name: /resolved/i }))
  expect(screen.getAllByTestId('review-thread')).toHaveLength(1)
})
it('verdict mix pills show "1 changes · 1 approved"', () => {
  render(<ReviewsSection reviewers={[{ verdict: 'changes_requested' }, { verdict: 'approved' }]} />)
  expect(screen.getByTestId('review-verdict-mix')).toHaveTextContent('1 changes · 1 approved')
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
import { ScrollingFeed } from '../feed/ScrollingFeed'
// ...
const [filter, setFilter] = useState<'open'|'resolved'|'all'>('open')
const filteredThreads = useMemo(() => {
  if (filter === 'all') return threads
  return threads.filter((t) => filter === 'open' ? !t.resolved : t.resolved)
}, [threads, filter])

const mix = useMemo(() => {
  const changes = reviewers.filter((r) => r.verdict === 'changes_requested').length
  const approved = reviewers.filter((r) => r.verdict === 'approved').length
  const requested = reviewers.filter((r) => r.verdict === 'requested').length
  const parts: string[] = []
  if (changes) parts.push(`${changes} changes`)
  if (approved) parts.push(`${approved} approved`)
  if (requested) parts.push(`${requested} requested`)
  return parts.join(' · ') || `${threads.length} open`
}, [reviewers, threads.length])
// ...
<div data-testid="review-verdict-mix" className="text-xs text-overlay1">{mix}</div>
<SegmentedChips value={filter} onChange={setFilter} options={['open','resolved','all']} />
<ScrollingFeed
  data-testid="scrolling-feed"
  items={filteredThreads}
  keyOf={(t) => t.id}
  timestampOf={(t) => t.updatedAt}
  sessionId={sessionId}
  feedId={`reviews:${slug}:${prNumber}`}
  renderItem={(t, { unread }) => (
    <div data-testid="review-thread" className={`${t.resolved ? 'opacity-45' : ''}`}>
      {/* existing thread row with unread dot when `unread` is true */}
    </div>
  )}
/>
```

Do NOT add the "Reply in Claude" button here yet — that's wired in the Linked Issues task and deliberately skipped for Reviews per the scope note.

- [ ] **Step 4: PASS + commit**

```bash
git add src/renderer/components/github/sections/ReviewsSection.tsx tests/unit/renderer/components/github/ReviewsSection.test.tsx
git commit -m "feat(sidebar): Reviews wired to ScrollingFeed with filter chips and verdict mix"
```

---

### Task 15: `IssuesSection` — rename default export to `LinkedIssuesSection`, filter + sort

**Files:**
- Modify: `src/renderer/components/github/sections/IssuesSection.tsx` (file stays named; internal export renamed)

- [ ] **Step 1: Failing test**

Create `tests/unit/renderer/components/github/IssuesSection.test.tsx` covering filter chips (`Open / All / Primary only`) and sort dropdown (`Last activity / Linked at / State / Number`).

```tsx
it('defaults to Last activity sort; clicking Number re-orders ascending', () => {
  render(<IssuesSection issues={[{ number: 99, lastActivityAt: 1 }, { number: 3, lastActivityAt: 100 }]} />)
  expect(screen.getAllByTestId('issue-row')[0]).toHaveTextContent('#3')
  fireEvent.click(screen.getByRole('button', { name: /number/i }))
  expect(screen.getAllByTestId('issue-row')[0]).toHaveTextContent('#3')
})
it('Primary only filter hides non-primary issues', () => {
  render(<IssuesSection issues={[{ number: 1, isPrimary: true }, { number: 2 }]} />)
  fireEvent.click(screen.getByRole('button', { name: /primary only/i }))
  expect(screen.getAllByTestId('issue-row')).toHaveLength(1)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
function LinkedIssuesSection({ sessionId }: { sessionId: string }) {
  const [filter, setFilter] = useState<'open'|'all'|'primary'>((prefs?.linkedIssues?.filter as any) ?? 'open')
  const [sortBy, setSortBy] = useState<'last-activity'|'linked-at'|'state'|'number'>(
    (prefs?.linkedIssues?.sortBy as any) ?? 'last-activity'
  )
  const visible = useMemo(() => {
    let xs = issues
    if (filter === 'open') xs = xs.filter((i) => i.state === 'open')
    if (filter === 'primary') xs = xs.filter((i) => i.isPrimary)
    const key = {
      'last-activity': (i: LinkedIssueSnapshot) => i.lastActivityAt ?? 0,
      'linked-at': (i: LinkedIssueSnapshot) => i.linkedAt ?? 0,
      'state': (i: LinkedIssueSnapshot) => (i.state === 'open' ? 0 : 1),
      'number': (i: LinkedIssueSnapshot) => i.number,
    }[sortBy]
    return [...xs].sort((a, b) => (key(a) > key(b) ? 1 : -1))
  }, [issues, filter, sortBy])
  // ... render
}
export default LinkedIssuesSection
```

Persist chip+sort changes via `setSectionPrefs(sessionId, 'linkedIssues', { filter, sortBy })`.

- [ ] **Step 4: PASS + commit**

---

### Task 16: `IssuesSection` — linkage reason, activity, labels per row

- [ ] **Step 1: Failing test**

```tsx
it('renders reason emoji by source', () => {
  render(<IssuesSection issues={[{ number:1, reason:'branch' }, { number:2, reason:'pr-body' }, { number:3, reason:'transcript' }]} />)
  expect(screen.getByTestId('issue-row-1')).toHaveTextContent(String.fromCodePoint(0x1f33f)) // 🌿
  expect(screen.getByTestId('issue-row-2')).toHaveTextContent(String.fromCodePoint(0x1f517)) // 🔗
  expect(screen.getByTestId('issue-row-3')).toHaveTextContent(String.fromCodePoint(0x1f4dc)) // 📜
})
it('renders comment count and last-activity age', () => {
  render(<IssuesSection issues={[{ number:1, commentCount: 3, lastActivityAt: Date.now() - 3600*1000 }]} />)
  expect(screen.getByText(/3 comments/i)).toBeInTheDocument()
  expect(screen.getByText(/1h ago/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const REASON_GLYPH: Record<LinkageReason, string> = {
  'branch': String.fromCodePoint(0x1f33f),
  'pr-body': String.fromCodePoint(0x1f517),
  'transcript': String.fromCodePoint(0x1f4dc),
}
// per row:
<div data-testid={`issue-row-${i.number}`} className="text-xs flex items-center gap-2">
  {i.reason && <span title={i.reason}>{REASON_GLYPH[i.reason]}</span>}
  <span>#{i.number}</span>
  <span className="truncate">{i.title}</span>
  {i.commentCount !== undefined && <span className="text-overlay0">{i.commentCount} comments</span>}
  {i.lastActivityAt && <span className="text-overlay0">{relativeTime(i.lastActivityAt)}</span>}
  {(i.labels ?? []).map((l) => (
    <span key={l.name} className="rounded px-1 text-[10px]" style={{ backgroundColor: `#${l.color}30`, color: `#${l.color}` }}>{l.name}</span>
  ))}
</div>
```

- [ ] **Step 4: PASS + commit**

---

### Task 17: `IssuesSection` — per-issue ⋯ kebab with Reply-in-Claude

- [ ] **Step 1: Failing test**

```tsx
it('kebab opens menu with Open / Reply in Claude / Copy ref / Pin / Unlink', () => {
  render(<IssuesSection issues={[{ number: 7, title: 't' }]} sessionId="s1" />)
  fireEvent.click(screen.getByLabelText(/options for #7/i))
  expect(screen.getByRole('menuitem', { name: /open/i })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /reply in claude/i })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /copy/i })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /pin/i })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /unlink/i })).toBeInTheDocument()
})
it('Reply in Claude calls queueReplyInClaude with #N title text', async () => {
  const spy = vi.fn(async () => ({ status: 'sent' }))
  vi.doMock('../../../src/renderer/lib/claude-input-queue', () => ({ queueReplyInClaude: spy }))
  // ... click kebab → Reply in Claude
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', text: expect.stringContaining('#7') }))
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const kebab = (i: LinkedIssueSnapshot) => (
  <Menu aria-label={`Options for #${i.number}`}>
    <MenuItem onSelect={() => window.electronAPI.shell.openExternal(i.url)}>Open</MenuItem>
    <MenuItem onSelect={() => queueReplyInClaude({
      sessionId, focused: sessionIsFocused,
      text: `Working on issue #${i.number}: ${i.title}\n${i.url}`,
      prompter: busyToastPrompter, // provided by ToastUndo / inline toast component
    })}>Reply in Claude</MenuItem>
    <MenuItem onSelect={() => navigator.clipboard.writeText(`${slug}#${i.number}`)}>Copy ref</MenuItem>
    <MenuItem onSelect={() => window.electronAPI.github.pinSessionIssue(sessionId, i.number)}>Pin as primary</MenuItem>
    <MenuItem onSelect={() => window.electronAPI.github.unlinkIssue(sessionId, i.number)}>Unlink from session</MenuItem>
  </Menu>
)
```

If a `<Menu>` primitive doesn't exist yet, reuse the pattern from `<SidebarHeaderMenu>` (Phase 1a) — a `role="menu"` div with `role="menuitem"` buttons, no nested popover.

- [ ] **Step 4: PASS + commit**

```bash
git add src/renderer/components/github/sections/IssuesSection.tsx tests/unit/renderer/components/github/IssuesSection.test.tsx
git commit -m "feat(sidebar): Linked Issues filter/sort/reason/activity/labels/kebab"
```

---

### Task 18: `NotificationsSection` — all-profiles merge chip with per-profile counts

- [ ] **Step 1: Failing test**

```tsx
it('renders merged count with per-profile breakdown chip', () => {
  render(<NotificationsSection notifications={[
    { profileId: 'p1', id: 't1', unread: true }, { profileId: 'p2', id: 't2', unread: true },
  ]} />)
  expect(screen.getByTestId('notifications-merge-chip')).toHaveTextContent(/p1.*1.*p2.*1/)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const perProfile = useMemo(() => {
  const m = new Map<string, number>()
  for (const n of notifications) m.set(n.profileId ?? 'unknown', (m.get(n.profileId ?? 'unknown') ?? 0) + 1)
  return Array.from(m.entries())
}, [notifications])

<div data-testid="notifications-merge-chip" className="flex gap-1 text-[10px]">
  {perProfile.map(([pid, n]) => (
    <span key={pid} className="rounded bg-surface0 px-1">{pid}: {n}</span>
  ))}
</div>
```

- [ ] **Step 4: PASS + commit**

---

### Task 19: `NotificationsSection` — reason chips per item

- [ ] **Step 1: Failing test**

```tsx
it('renders reason glyph per item', () => {
  render(<NotificationsSection notifications={[
    { id: 't1', reason: 'review_requested', unread: true },
    { id: 't2', reason: 'mention', unread: true },
    { id: 't3', reason: 'assign', unread: true },
    { id: 't4', reason: 'author', unread: true },
  ]} />)
  expect(screen.getByTestId('notif-reason-t1')).toHaveAttribute('title', /review/i)
  expect(screen.getByTestId('notif-reason-t2')).toHaveAttribute('title', /mention/i)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const REASON_GLYPH: Partial<Record<NotificationReason, { glyph: string; title: string }>> = {
  review_requested: { glyph: String.fromCodePoint(0x23f3), title: 'Reviews' },
  mention: { glyph: '@', title: 'Mentions' },
  assign: { glyph: '+', title: 'Assigned' },
  author: { glyph: String.fromCodePoint(0x270f), title: 'Author' },
}
// per item:
{n.reason && REASON_GLYPH[n.reason] && (
  <span data-testid={`notif-reason-${n.id}`} title={REASON_GLYPH[n.reason]!.title} className="text-[10px] text-overlay1">
    {REASON_GLYPH[n.reason]!.glyph}
  </span>
)}
```

- [ ] **Step 4: PASS + commit**

---

### Task 20: `NotificationsSection` — mark-all-read with ToastUndo

- [ ] **Step 1: Failing test**

```tsx
it('mark-all-read optimistically clears unread, shows ToastUndo; undo restores', async () => {
  const api = (globalThis as any).window.electronAPI.github
  api.markAllNotificationsRead = vi.fn(async () => ({ ok: true }))
  render(<NotificationsSection notifications={twoUnread} />)
  fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))
  expect(screen.queryAllByTestId(/unread-dot/)).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /undo/i }))
  expect(screen.queryAllByTestId(/unread-dot/).length).toBe(2)
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const { showUndo } = useToastUndo()  // from Phase 1b
const markAll = async () => {
  const snapshot = notifications
  setLocal(notifications.map((n) => ({ ...n, unread: false })))
  const profileId = mergedProfileId ?? null
  await window.electronAPI.github.markAllNotificationsRead(profileId)
  showUndo('Marked all as read.', {
    onUndo: () => setLocal(snapshot),
    timeoutMs: 5000,
  })
}
```

If `useToastUndo` isn't on the current base yet (landed in Phase 1b), use its contract and stub in-file — the real component will drop in when 1b merges.

- [ ] **Step 4: PASS + commit**

---

### Task 21: `NotificationsSection` — per-item kebab (Open / Mark read / Snooze 2h / Snooze tomorrow / Unsubscribe / Dismiss)

- [ ] **Step 1: Failing test**

```tsx
it('Snooze 2h calls snoozeNotification with now+2h (±60s tolerance)', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.snoozeNotification = spy
  render(<NotificationsSection notifications={[{ id: 't1', profileId: 'p1', unread: true }]} />)
  fireEvent.click(screen.getByLabelText(/options for t1/i))
  fireEvent.click(screen.getByRole('menuitem', { name: /snooze 2h/i }))
  const resumesAt = spy.mock.calls[0][2] as number
  const expected = Date.now() + 2 * 3600 * 1000
  expect(Math.abs(resumesAt - expected)).toBeLessThan(60_000)
})
it('Unsubscribe calls REST DELETE via unsubscribeThread', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.unsubscribeThread = spy
  // click through kebab -> Unsubscribe
  expect(spy).toHaveBeenCalledWith('p1', 't1')
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
const tomorrow8am = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0)
  return d.getTime()
}

const kebab = (n: NotificationSnapshot) => (
  <Menu aria-label={`Options for ${n.id}`}>
    <MenuItem onSelect={() => window.electronAPI.shell.openExternal(n.url)}>Open</MenuItem>
    <MenuItem onSelect={() => window.electronAPI.github.markNotificationRead(n.profileId!, n.id)}>Mark read</MenuItem>
    <MenuItem onSelect={() => window.electronAPI.github.snoozeNotification(n.profileId!, n.id, Date.now() + 2 * 3600 * 1000)}>Snooze 2h</MenuItem>
    <MenuItem onSelect={() => window.electronAPI.github.snoozeNotification(n.profileId!, n.id, tomorrow8am())}>Snooze until tomorrow</MenuItem>
    <MenuItem onSelect={() => window.electronAPI.github.unsubscribeThread(n.profileId!, n.id)}>Unsubscribe</MenuItem>
    <MenuItem onSelect={() => setLocal((xs) => xs.filter((x) => x.id !== n.id))}>Dismiss</MenuItem>
  </Menu>
)
```

Dismiss is local-only (UI state) — GitHub has no "dismiss" API distinct from mark-read; document that in a code comment.

- [ ] **Step 4: PASS + commit**

---

### Task 22: `NotificationsSection` — wire ScrollingFeed as the list container

- [ ] **Step 1: Failing test**

```tsx
it('wraps notifications list in ScrollingFeed with feedId "notifications:all" (or per-profile)', () => {
  render(<NotificationsSection notifications={manyUnread} />)
  expect(screen.getByTestId('scrolling-feed')).toHaveAttribute('data-feed-id', /notifications:/)
})
it('"returnedFromSnooze" items render with a small pill indicator', () => {
  render(<NotificationsSection notifications={[{ id:'t1', unread:true, returnedFromSnooze:true }]} />)
  expect(screen.getByText(/returned/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```tsx
<ScrollingFeed
  items={filteredNotifications}
  keyOf={(n) => `${n.profileId ?? 'x'}:${n.id}`}
  timestampOf={(n) => n.updatedAt}
  sessionId={sessionId}
  feedId={`notifications:${filter === 'all' ? 'merged' : selectedProfileId}`}
  renderItem={(n, { unread }) => (
    <div className="flex items-start gap-2">
      {unread && <span data-testid={`unread-dot-${n.id}`} className="mt-1.5 h-2 w-2 rounded-full bg-blue" />}
      {/* reason glyph, title, timestamp, kebab ... */}
      {n.returnedFromSnooze && <span className="rounded bg-yellow/20 px-1 text-[10px] text-yellow">returned</span>}
    </div>
  )}
/>
```

- [ ] **Step 4: PASS + commit**

```bash
git add src/renderer/components/github/sections/NotificationsSection.tsx tests/unit/renderer/components/github/NotificationsSection.test.tsx
git commit -m "feat(sidebar): Notifications merge chip, reason chips, mark-all-read, kebab, ScrollingFeed"
```

---

### Task 23: Smoke — sections render together, no regressions

- [ ] **Step 1: Integration test**

Create `tests/unit/renderer/components/github/panel-phase2-smoke.test.tsx`. Render the full panel with a fixture payload that exercises every new branch (labels, conflict detail, failed jobs, linkage reasons, snoozed-returned items). Assert no React errors logged and that at least one visible element from each upgraded section renders.

- [ ] **Step 2: Run `npx vitest run` — all green**

- [ ] **Step 3: `npm run typecheck` — clean**

- [ ] **Step 4: `npm run dev`** — hand-verify:
  - Session Context: pin an issue, refresh, stays pinned; unpin restores auto.
  - Active PR: header shows `#N · state · +X/-Y · Z files`; labels render; body expand/collapse works; conflict lists files against base; convert-to-draft flips state.
  - CI: run row is two lines; failing run auto-expands with tail line; filter chips swap counts; summary pill matches colour.
  - Reviews: threads virtualise past ~100; filter chips work; verdict mix reads correctly.
  - Linked Issues: sort dropdown reorders; filter chips work; kebab → Unlink drops the row.
  - Notifications: Snooze 2h removes item from list; reappears after two hours with "returned" pill; Mark-all-read + Undo restores.

- [ ] **Step 5: Commit smoke test**

```bash
git add tests/unit/renderer/components/github/panel-phase2-smoke.test.tsx
git commit -m "test(sidebar): integration smoke for Phase 2 easy-wins"
```

---

### Task 24: Push + PR

- [ ] **Step 1:**

```bash
git push -u origin feat/sidebar-easy-wins
gh pr create --title "sidebar 2: easy-wins content + ScrollingFeed wired to Reviews/Notifications" --body "$(cat <<'EOF'
## Summary
- Session Context: pin/unpin with 📌, reasoning line per candidate, show-more files, closed-issue muted pill + optional `skipClosed` rule.
- Active PR: header shows state + diff size + file count, labels chips, body preview (200 char, expand), reviewers chips with verdict pill, mergeable detail (conflict files + base / "checking..." on unknown), convert-to-draft button.
- CI: two-line run row, auto-expand failures with failedJobs + tail line, `All / Failing / This branch / PR only` filter chips, summary pill reflects live colour.
- Reviews: `<ScrollingFeed>` thread list, `Open / Resolved / All` chips, verdict mix pill header.
- Linked Issues: `Open / All / Primary only` chips, sort dropdown (Last activity / Linked at / State / Number), linkage reason glyphs, comment count + age, label chips, per-issue ⋯ kebab (Open / Reply in Claude / Copy ref / Pin / Unlink).
- Notifications: all-profiles merge chip, reason chips, mark-all-read with ToastUndo, per-item kebab (Open / Mark read / Snooze 2h / Snooze tomorrow / Unsubscribe / Dismiss), `<ScrollingFeed>` list, snooze enforced in sync orchestrator, re-surfaced items flagged.
- `src/renderer/lib/claude-input-queue.ts`: Reply-in-Claude readiness contract — idle-vs-busy check via `transcript-watcher`, Queue/Cancel prompt on busy, leading-newline append on idle-with-buffered-input, focus-switch when target session isn't focused.
- `src/main/ipc/github-notifications-mutations.ts`: new IPC handlers for mark-read / mark-all / snooze / unsubscribe (real REST) / unlink / pin / set-draft (GraphQL).

Stacked on `feat/scrolling-feed` (Phase 1c). No Hooks-Gateway fields (edit deltas, Live Activity) — those arrive in Phase 4.

## Test plan
- [x] `npx vitest run` green (per-section tests + claude-input-queue + orchestrator + handler tests + smoke).
- [x] `npm run typecheck` clean.
- [x] Smoke scenarios in Task 23.
- [x] Snooze re-surface verified at real elapsed time (2h) once; shorter interval faked in tests.
EOF
)"
```

---

## Self-review checklist

- [ ] Every task has exact file paths.
- [ ] Every code step shows the full code to write (or a representative shape where trivial markup follows existing patterns).
- [ ] Every test has expected failure / expected pass.
- [ ] No default exports added except the three existing section defaults (SessionContext, ActivePR, CI, Reviews, Issues, Notifications all remain default exports because they are the sole export of their file).
- [ ] No `\u{...}` Unicode escapes in JSX — all glyphs via `String.fromCodePoint(0x...)` or literal characters.
- [ ] No Node module imports in renderer; IPC-only.
- [ ] Zustand selectors use `useStore((s) => s.x)` — no destructuring.
- [ ] Public-facing strings avoid em dashes (minus signs in diff stats, interpuncts for separators).
- [ ] Animations for expand/collapse and chip-selection are 150-300ms via Tailwind's `transition-colors` / `duration-200`.
- [ ] ScrollingFeed is reused for Reviews and Notifications (both call sites pass `sessionId` + `feedId`).
- [ ] Reply-in-Claude readiness contract is shared between Linked Issues and (future) Reviews via `src/renderer/lib/claude-input-queue.ts`.
- [ ] Snooze survives crash because it lives in `github-config.json`, not session-state.
- [ ] Unsubscribe is a real `DELETE /notifications/threads/:id/subscription`; GraphQL used for PR draft-conversion.
- [ ] No new npm dependencies introduced.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
