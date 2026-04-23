# Sidebar Flexibility — Phase 2: Easy-Wins Section Upgrades + ScrollingFeed Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every §1, §2, §3, §5, §7 content upgrade from the Sidebar Flexibility spec plus the minimal §4 wiring — ScrollingFeed + verdict mix pills. No Hooks-Gateway fields (edit deltas, Live Activity). No Local Git (§6). The `Reply in Claude` readiness contract ships here because Linked Issues uses it immediately.

**Branch:** `feat/sidebar-easy-wins` stacked on `feat/scrolling-feed` (Phase 1c). Assumes 1a (data model) and 1b (`<SectionOptionsPopover>` + `<ToastUndo>`) are merged.

**Architecture:** Section files stay where they are (`src/renderer/components/github/sections/`). `ScrollingFeed` slots into `ReviewsSection` and `NotificationsSection` as the thread/item container. A new `src/renderer/lib/claude-input-queue.ts` module owns the "Claude busy? queue or append" contract shared by Reviews and Linked Issues. A new `src/main/ipc/github-notifications-mutations.ts` registers mark-read / snooze / unsubscribe / issue-unlink / session-pin / PR-draft handlers. Snooze is enforced at fetch time in `sync-orchestrator.ts` so snoozed threads disappear from the payload until `resumesAt`, then re-surface flagged.

**Tech Stack:** TypeScript strict, Zustand 5, React 18, Tailwind v4 (Catppuccin Mocha), vitest + @testing-library/react. No new npm dependencies.

---

## File structure

- Modify: `src/renderer/components/github/sections/SessionContextSection.tsx` — pin badge, reasoning line, show-more, closed-issue pill.
- Modify: `src/renderer/components/github/sections/ActivePRSection.tsx` — state pill + diff size header, labels chips, body preview, reviewers chips, mergeable detail, convert-to-draft.
- Modify: `src/renderer/components/github/sections/CISection.tsx` — two-line row, auto-expand on failure, filter chips, live summary pill.
- Modify: `src/renderer/components/github/sections/ReviewsSection.tsx` — `<ScrollingFeed>` wiring, filter chips, verdict mix pill.
- Modify: `src/renderer/components/github/sections/IssuesSection.tsx` — internally rename the default export to `LinkedIssuesSection`, add filter / sort / linkage reason / activity / labels / kebab. File stays named `IssuesSection.tsx` to keep git blame clean.
- Modify: `src/renderer/components/github/sections/NotificationsSection.tsx` — merge chip, reason chips, mark-all-read + undo, kebab, `<ScrollingFeed>`.
- Create: `src/renderer/lib/claude-input-queue.ts` — readiness contract.
- Create: `src/main/ipc/github-notifications-mutations.ts` — mutation handlers.
- Modify: `src/shared/github-types.ts` — new optional fields on PR/Issue/Notification snapshots, plus `LinkageReason` / `NotificationReason` unions.
- Modify: `src/main/github/session/sync-orchestrator.ts` — populate new snapshot fields, apply snooze filter, tag re-surfaced items.
- Modify: `src/shared/ipc-channels.ts`, `src/preload/index.ts`, `src/renderer/types/electron.d.ts` — new channels + bridge.
- Tests: one `.test.tsx` per modified section + `claude-input-queue.test.ts` + orchestrator + handler tests + a panel-level smoke.

All new files ≤250 LOC. Each existing section grows by ≤150 LOC.

---

### Task 1: Shared types — PR details, linkage reason, notification reason

**Files:**
- Modify: `src/shared/github-types.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/github-types-phase2.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  PullRequestSnapshot, LinkedIssueSnapshot, NotificationSnapshot,
  LinkageReason, NotificationReason, Reviewer, Label,
} from '../../../src/shared/github-types'

describe('phase2 shared types', () => {
  it('PullRequestSnapshot accepts labels, bodyMarkdown, reviewers, mergeableDetail', () => {
    const pr: PullRequestSnapshot = {
      number: 15, title: 't', state: 'open', draft: false,
      additions: 412, deletions: 38, changedFiles: 14, mergeable: 'conflict',
      labels: [{ name: 'bug', color: 'f00' }] as Label[],
      bodyMarkdown: 'text',
      reviewers: [{ login: 'a', verdict: 'approved' }] as Reviewer[],
      mergeableDetail: { conflictingFiles: ['a.ts'], baseBranch: 'main' },
    } as PullRequestSnapshot
    expect(pr.labels?.[0].name).toBe('bug')
  })
  it('LinkedIssueSnapshot accepts reason, commentCount, lastActivityAt, labels', () => {
    const li: LinkedIssueSnapshot = {
      number: 42, title: 'x', state: 'open',
      reason: 'branch', commentCount: 3, lastActivityAt: Date.now(),
      labels: [{ name: 'doc', color: 'fff' }],
    } as LinkedIssueSnapshot
    const r: LinkageReason = li.reason!
    expect(r).toBe('branch')
  })
  it('NotificationSnapshot accepts reason + profileId + returnedFromSnooze', () => {
    const n: NotificationSnapshot = {
      id: 't1', title: 'x', repo: 'a/b', url: 'u', updatedAt: 0, unread: true,
      reason: 'review_requested', profileId: 'p1', returnedFromSnooze: true,
    } as NotificationSnapshot
    const r: NotificationReason = n.reason!
    expect(r).toBe('review_requested')
  })
})
```

- [ ] **Step 2: Run — FAIL** (types missing)

- [ ] **Step 3: Extend `src/shared/github-types.ts`**

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

export type IssueKebabAction = 'open' | 'reply-in-claude' | 'copy-ref' | 'pin-primary' | 'unlink'
export type NotificationKebabAction =
  | 'open' | 'mark-read' | 'snooze-2h' | 'snooze-tomorrow' | 'unsubscribe' | 'dismiss'
```

Extend the existing interfaces (do not rewrite) with optional fields:
- `PullRequestSnapshot`: `labels?: Label[]; bodyMarkdown?: string; reviewers?: Reviewer[]; mergeableDetail?: MergeableDetail`
- `LinkedIssueSnapshot`: `reason?: LinkageReason; commentCount?: number; lastActivityAt?: number; labels?: Label[]; linkedAt?: number; isPrimary?: boolean`
- `NotificationSnapshot`: `reason?: NotificationReason; profileId?: string; returnedFromSnooze?: boolean`

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/shared/github-types.ts tests/unit/shared/github-types-phase2.test.ts
git commit -m "feat(sidebar): extend shared types for Phase 2 (labels, reviewers, reasons)"
```

---

### Task 2: Orchestrator — populate new PR fields, linkage reason, notification reason

**Files:**
- Modify: `src/main/github/session/sync-orchestrator.ts`

- [ ] **Step 1: Failing test**

Create `tests/unit/main/sync-orchestrator-phase2.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  mapRestPullToSnapshot, decideLinkageReason, mapNotificationReason,
} from '../../src/main/github/session/sync-orchestrator'

describe('sync-orchestrator phase 2 mappers', () => {
  it('PR snapshot — labels / bodyMarkdown / reviewers / mergeableDetail populated', () => {
    const raw = {
      number: 1, state: 'open', draft: false, title: 't',
      additions: 10, deletions: 2, changed_files: 3,
      mergeable_state: 'dirty', mergeable: false, body: 'hi',
      labels: [{ name: 'bug', color: 'ff0000' }],
      requested_reviewers: [{ login: 'b', avatar_url: 'ab' }],
      base: { ref: 'main' },
    }
    const reviews = [{ user: { login: 'a', avatar_url: 'aa' }, state: 'APPROVED' }]
    const pr = mapRestPullToSnapshot(raw, ['conflict.ts'], reviews)
    expect(pr.labels?.[0].name).toBe('bug')
    expect(pr.bodyMarkdown).toBe('hi')
    expect(pr.reviewers?.find((r) => r.login === 'a')?.verdict).toBe('approved')
    expect(pr.reviewers?.find((r) => r.login === 'b')?.verdict).toBe('requested')
    expect(pr.mergeableDetail?.baseBranch).toBe('main')
    expect(pr.mergeableDetail?.conflictingFiles).toEqual(['conflict.ts'])
  })
  it('decideLinkageReason — precedence is pr-body > branch > transcript', () => {
    expect(decideLinkageReason({ prBody: [42], branch: [42], transcript: [42] }, 42)).toBe('pr-body')
    expect(decideLinkageReason({ prBody: [], branch: [42], transcript: [42] }, 42)).toBe('branch')
    expect(decideLinkageReason({ prBody: [], branch: [], transcript: [42] }, 42)).toBe('transcript')
    expect(decideLinkageReason({ prBody: [], branch: [], transcript: [] }, 42)).toBeUndefined()
  })
  it('mapNotificationReason — allowed values pass through; unknown -> "other"', () => {
    expect(mapNotificationReason('review_requested')).toBe('review_requested')
    expect(mapNotificationReason('mention')).toBe('mention')
    expect(mapNotificationReason('ci_activity')).toBe('other')
    expect(mapNotificationReason(undefined)).toBe('other')
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Export + implement**

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
  const allowed: NotificationReason[] = [
    'review_requested', 'mention', 'assign', 'author',
    'comment', 'team_mention', 'subscribed', 'security_alert',
  ]
  if (!raw || !(allowed as string[]).includes(raw)) return 'other'
  return raw as NotificationReason
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
    const login = rev.user?.login; if (!login) continue
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
    additions: raw.additions ?? 0, deletions: raw.deletions ?? 0, changedFiles: raw.changed_files ?? 0,
    mergeable: raw.mergeable_state === 'clean' ? 'clean'
      : raw.mergeable_state === 'dirty' ? 'conflict'
      : raw.mergeable_state === 'blocked' ? 'blocked' : 'unknown',
    labels, bodyMarkdown: raw.body ?? undefined, reviewers, mergeableDetail,
  } as PullRequestSnapshot
}
```

Wire the orchestrator's existing PR-fetch path to call `mapRestPullToSnapshot` (replace the inline mapping), and wire the linked-issue collector to stamp `reason`, `commentCount`, `lastActivityAt`, `labels` from the issues REST payload. Wire notifications tick to call `mapNotificationReason(raw.reason)` and stamp `profileId`.

- [ ] **Step 4: Tests pass; typecheck clean**

- [ ] **Step 5: Commit**

```bash
git add src/main/github/session/sync-orchestrator.ts tests/unit/main/sync-orchestrator-phase2.test.ts
git commit -m "feat(sidebar): populate Phase 2 snapshot fields in sync orchestrator"
```

---

### Task 3: Snooze enforcement — filter-at-fetch with re-surface flag

**Files:**
- Modify: `src/main/github/session/sync-orchestrator.ts`

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
  it('flags returnedFromSnooze when key was active last tick but not now', () => {
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

In the notifications tick, read `getActiveSnoozes(now)` from `github-config-store`, diff against an in-memory `lastTickActiveKeys: Set<string>`, call `applySnoozeFilter(items, active, lastTick - active)`, then `lastTickActiveKeys = active`. Call `clearExpiredSnoozes(now)` once per hour to shrink the store.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/main/github/session/sync-orchestrator.ts tests/unit/main/sync-orchestrator-phase2.test.ts
git commit -m "feat(sidebar): filter snoozed notifications at sync time; flag re-surfaced"
```

---

### Task 4: IPC channels + preload bridge

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`

- [ ] **Step 1: Failing test**

`tests/unit/shared/ipc-channels-phase2.test.ts`:

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
    expect(IPC.TRANSCRIPT_GET_STATE).toBe('transcript:getState')
    expect(IPC.TRANSCRIPT_EVENT).toBe('transcript:event')
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add channels + bridge**

`src/shared/ipc-channels.ts` (append):

```ts
  GITHUB_NOTIFICATION_MARK_READ: 'github:notification:markRead',
  GITHUB_NOTIFICATION_MARK_ALL_READ: 'github:notification:markAllRead',
  GITHUB_NOTIFICATION_SNOOZE: 'github:notification:snooze',
  GITHUB_NOTIFICATION_UNSUBSCRIBE: 'github:notification:unsubscribe',
  GITHUB_ISSUE_UNLINK: 'github:issue:unlink',
  GITHUB_SESSION_PIN_ISSUE: 'github:session:pinIssue',
  GITHUB_PR_SET_DRAFT: 'github:pr:setDraft',
  TRANSCRIPT_GET_STATE: 'transcript:getState',
  TRANSCRIPT_EVENT: 'transcript:event',
```

`src/preload/index.ts` — add under `github`:

```ts
markNotificationRead: (profileId, threadId) =>
  ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_MARK_READ, profileId, threadId),
markAllNotificationsRead: (profileId) =>
  ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_MARK_ALL_READ, profileId),
snoozeNotification: (profileId, threadId, resumesAt) =>
  ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_SNOOZE, profileId, threadId, resumesAt),
unsubscribeThread: (profileId, threadId) =>
  ipcRenderer.invoke(IPC.GITHUB_NOTIFICATION_UNSUBSCRIBE, profileId, threadId),
unlinkIssue: (sessionId, number) =>
  ipcRenderer.invoke(IPC.GITHUB_ISSUE_UNLINK, sessionId, number),
pinSessionIssue: (sessionId, number) =>
  ipcRenderer.invoke(IPC.GITHUB_SESSION_PIN_ISSUE, sessionId, number),
setPullRequestDraft: (profileId, slug, number, draft) =>
  ipcRenderer.invoke(IPC.GITHUB_PR_SET_DRAFT, profileId, slug, number, draft),
```

And a new top-level bridge for transcript state (readiness contract):

```ts
transcript: {
  getState: (sessionId) => ipcRenderer.invoke(IPC.TRANSCRIPT_GET_STATE, sessionId),
  onEvent: (sessionId, cb) => {
    const listener = (_e: unknown, payload: { sessionId: string; event: { type: string } }) => {
      if (payload.sessionId === sessionId) cb(payload.event)
    }
    ipcRenderer.on(IPC.TRANSCRIPT_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.TRANSCRIPT_EVENT, listener)
  },
},
```

Mirror on `src/renderer/types/electron.d.ts` with typed signatures using the new snapshot/type exports from `src/shared/github-types.ts`.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/preload/index.ts src/renderer/types/electron.d.ts tests/unit/shared/ipc-channels-phase2.test.ts
git commit -m "feat(sidebar): IPC channels and preload bridge for Phase 2 mutations"
```

---

### Task 5: Main-side mutation handlers (mark-read, snooze, unsubscribe, unlink, pin, set-draft)

**Files:**
- Create: `src/main/ipc/github-notifications-mutations.ts`
- Modify: `src/main/ipc/github-handlers.ts` — call the new `registerGithubNotificationMutationHandlers()` from boot.

- [ ] **Step 1: Failing test**

`tests/unit/main/github-notifications-mutations.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const restCalls: Array<{ method: string; url: string }> = []
vi.mock('../../src/main/github/client/github-client', () => ({
  fetchWithAuth: vi.fn(async (_p: string, url: string, init?: any) => {
    restCalls.push({ method: init?.method ?? 'GET', url })
    return { ok: true, status: 200, json: async () => ({ node_id: 'NODE' }) }
  }),
}))
const writes: Array<{ key: string; data: any }> = []
vi.mock('../../src/main/config-manager', () => ({
  readConfig: vi.fn((k: string) => {
    if (k === 'github') return { schemaVersion: 2, authProfiles: { p1: {} }, snoozedNotifications: {} }
    if (k === 'sessions') return { sessions: [{ id: 's1', githubIntegration: { enabled: true, autoDetected: false } }] }
    return null
  }),
  writeConfig: vi.fn((k: string, d: any) => { writes.push({ key: k, data: d }) }),
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => undefined, logError: () => undefined }))

const handlers: Record<string, (...a: any[]) => any> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { handlers[ch] = fn } },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { registerGithubNotificationMutationHandlers } from '../../src/main/ipc/github-notifications-mutations'

describe('notification mutation handlers', () => {
  beforeEach(() => {
    restCalls.length = 0; writes.length = 0
    for (const k of Object.keys(handlers)) delete handlers[k]
    registerGithubNotificationMutationHandlers()
  })

  it('mark-read → PATCH /notifications/threads/:id', async () => {
    await handlers['github:notification:markRead'](null, 'p1', 't1')
    expect(restCalls.some((c) => c.url.endsWith('/notifications/threads/t1') && c.method === 'PATCH')).toBe(true)
  })
  it('unsubscribe → DELETE /notifications/threads/:id/subscription', async () => {
    await handlers['github:notification:unsubscribe'](null, 'p1', 't1')
    expect(restCalls.some((c) => c.url.endsWith('/subscription') && c.method === 'DELETE')).toBe(true)
  })
  it('snooze writes to github config, does NOT call REST, rejects past resumesAt', async () => {
    const r1 = await handlers['github:notification:snooze'](null, 'p1', 't1', Date.now() - 1)
    expect(r1.ok).toBe(false)
    await handlers['github:notification:snooze'](null, 'p1', 't1', Date.now() + 7200000)
    expect(restCalls.length).toBe(0)
    expect(writes.at(-1)!.data.snoozedNotifications['p1:t1']).toBeGreaterThan(0)
  })
  it('pin-session-issue writes pinnedIssueNumber; null clears it', async () => {
    await handlers['github:session:pinIssue'](null, 's1', 42)
    expect(writes.at(-1)!.data.sessions[0].githubIntegration.pinnedIssueNumber).toBe(42)
    await handlers['github:session:pinIssue'](null, 's1', null)
    expect(writes.at(-1)!.data.sessions[0].githubIntegration.pinnedIssueNumber).toBeUndefined()
  })
  it('unlink-issue appends to unlinkedIssues (dedup)', async () => {
    await handlers['github:issue:unlink'](null, 's1', 5)
    await handlers['github:issue:unlink'](null, 's1', 5)
    expect(writes.at(-1)!.data.sessions[0].githubIntegration.unlinkedIssues).toEqual([5])
  })
  it('pr-set-draft → GraphQL convert/markReady', async () => {
    await handlers['github:pr:setDraft'](null, 'p1', 'o/r', 15, true)
    expect(restCalls.some((c) => c.url.endsWith('/graphql') && c.method === 'POST')).toBe(true)
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement handlers**

Create `src/main/ipc/github-notifications-mutations.ts`:

```ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { fetchWithAuth } from '../github/client/github-client'
import { readConfig, writeConfig } from '../config-manager'
import { setSnooze } from '../github/github-config-store'
import type { SessionGitHubIntegration } from '../../shared/github-types'

function updateSession(
  sessionId: string,
  update: (gi: SessionGitHubIntegration) => SessionGitHubIntegration,
): { ok: boolean; error?: string } {
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
    const url = 'https://api.github.com/notifications'
    if (profileId) { const r = await fetchWithAuth(profileId, url, { method: 'PUT' }); return { ok: r.ok } }
    const cfg = readConfig<{ authProfiles: Record<string, unknown> }>('github')
    for (const id of Object.keys(cfg?.authProfiles ?? {})) await fetchWithAuth(id, url, { method: 'PUT' })
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
    const idResp = await fetchWithAuth(profileId, `https://api.github.com/repos/${slug}/pulls/${number}`)
    const { node_id } = await idResp.json()
    const query = draft
      ? 'mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest { id } } }'
      : 'mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest { id } } }'
    const r = await fetchWithAuth(profileId, 'https://api.github.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: node_id } }),
    })
    return { ok: r.ok }
  })
}
```

Call `registerGithubNotificationMutationHandlers()` from the main boot registration in `github-handlers.ts`.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/github-notifications-mutations.ts src/main/ipc/github-handlers.ts tests/unit/main/github-notifications-mutations.test.ts
git commit -m "feat(sidebar): main-side handlers for notifications/issues/PR Phase 2 mutations"
```

---

### Task 6: Transcript state bridge — minimal IPC so the input queue can read idle/busy

**Files:**
- Modify: `src/main/utils/claude-project-path.ts` OR a new `src/main/transcript-watcher.ts` (reuse if present)
- Modify: `src/main/ipc/github-handlers.ts` — register the `TRANSCRIPT_GET_STATE` handler

- [ ] **Step 1: Failing test**

`tests/unit/main/transcript-state.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
const handlers: Record<string, any> = {}
vi.mock('electron', () => ({ ipcMain: { handle: (c: string, f: any) => { handlers[c] = f } }, BrowserWindow: { getAllWindows: () => [] } }))
import { registerTranscriptStateHandler, setTranscriptStateForTests } from '../../src/main/transcript-state'

describe('transcript state handler', () => {
  it('returns stored lastEventType for a session', async () => {
    registerTranscriptStateHandler()
    setTranscriptStateForTests('s1', { lastEventType: 'tool-call', userBufferedInput: 'x' })
    const r = await handlers['transcript:getState'](null, 's1')
    expect(r.ok).toBe(true)
    expect(r.data.lastEventType).toBe('tool-call')
  })
  it('defaults to idle when the session is unknown', async () => {
    registerTranscriptStateHandler()
    const r = await handlers['transcript:getState'](null, 'unknown')
    expect(r.data.lastEventType).toBe('idle')
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Create `src/main/transcript-state.ts`:

```ts
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'

type TranscriptEventType = 'idle' | 'tool-call' | 'response' | 'user-input-expected'
interface TranscriptState { lastEventType: TranscriptEventType; userBufferedInput: string }

const state = new Map<string, TranscriptState>()

export function recordTranscriptEvent(sessionId: string, type: TranscriptEventType, userBufferedInput = ''): void {
  state.set(sessionId, { lastEventType: type, userBufferedInput })
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.TRANSCRIPT_EVENT, { sessionId, event: { type } })
  }
}

export function registerTranscriptStateHandler(): void {
  ipcMain.handle(IPC.TRANSCRIPT_GET_STATE, async (_e, sessionId: string) => {
    const s = state.get(sessionId) ?? { lastEventType: 'idle' as const, userBufferedInput: '' }
    return { ok: true, data: s }
  })
}

export function setTranscriptStateForTests(sessionId: string, s: TranscriptState): void {
  state.set(sessionId, s)
}
```

Wire `recordTranscriptEvent(sessionId, 'tool-call')` (and equivalents for `response` / `user-input-expected` / `idle`) into whichever existing module tails the transcript file. If that module doesn't exist yet, expose `recordTranscriptEvent` and leave a `TODO: hook into transcript tailer` comment — Phase 4's Hooks Gateway can replace this with real hook-event plumbing.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/main/transcript-state.ts src/main/ipc/github-handlers.ts tests/unit/main/transcript-state.test.ts
git commit -m "feat(sidebar): minimal transcript-state IPC for Reply-in-Claude readiness"
```

---

### Task 7: `claude-input-queue.ts` — readiness contract

**Files:**
- Create: `src/renderer/lib/claude-input-queue.ts`

- [ ] **Step 1: Failing test**

`tests/unit/renderer/lib/claude-input-queue.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = {
  ptyWrite: vi.fn(async () => ({ ok: true })),
  focusSession: vi.fn(async () => ({ ok: true })),
  getState: vi.fn(async () => ({ ok: true, data: { lastEventType: 'idle', userBufferedInput: '' } })),
  onEvent: vi.fn((_sid: string, _cb: (e: any) => void) => () => undefined),
}
;(globalThis as any).window = {
  electronAPI: {
    pty: { write: mocks.ptyWrite },
    session: { focus: mocks.focusSession },
    transcript: { getState: mocks.getState, onEvent: mocks.onEvent },
  },
}

import { queueReplyInClaude, __resetQueueForTests } from '../../../src/renderer/lib/claude-input-queue'

describe('queueReplyInClaude', () => {
  beforeEach(() => { __resetQueueForTests(); vi.clearAllMocks() })

  it('idle + empty buffer + focused → pty.write immediately, status=sent', async () => {
    mocks.getState.mockResolvedValue({ ok: true, data: { lastEventType: 'idle', userBufferedInput: '' } })
    const r = await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true })
    expect(r.status).toBe('sent')
    expect(mocks.ptyWrite).toHaveBeenCalledWith('s1', 'hi')
  })
  it('idle + buffered input → prepends newline to avoid clobber', async () => {
    mocks.getState.mockResolvedValue({ ok: true, data: { lastEventType: 'idle', userBufferedInput: 'abc' } })
    await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true })
    expect(mocks.ptyWrite).toHaveBeenCalledWith('s1', '\nhi')
  })
  it('not focused → focuses session first', async () => {
    mocks.getState.mockResolvedValue({ ok: true, data: { lastEventType: 'idle', userBufferedInput: '' } })
    await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: false })
    expect(mocks.focusSession).toHaveBeenCalledWith('s1')
  })
  it('busy (tool-call) → prompter asked; queue=true queues, user-input-expected fires write', async () => {
    mocks.getState.mockResolvedValue({ ok: true, data: { lastEventType: 'tool-call', userBufferedInput: '' } })
    let emit: ((e: any) => void) | null = null
    mocks.onEvent.mockImplementation((_sid: string, cb: any) => { emit = cb; return () => undefined })
    const prompter = vi.fn(async () => 'queue' as const)
    const r = await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true, prompter })
    expect(r.status).toBe('queued')
    expect(mocks.ptyWrite).not.toHaveBeenCalled()
    emit!({ type: 'user-input-expected' })
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.ptyWrite).toHaveBeenCalledWith('s1', 'hi')
  })
  it('busy + prompter=cancel → no write, status=cancelled', async () => {
    mocks.getState.mockResolvedValue({ ok: true, data: { lastEventType: 'response', userBufferedInput: '' } })
    const r = await queueReplyInClaude({ sessionId: 's1', text: 'hi', focused: true, prompter: async () => 'cancel' })
    expect(r.status).toBe('cancelled')
    expect(mocks.ptyWrite).not.toHaveBeenCalled()
  })
  it('re-queuing replaces prior entry (most recent wins)', async () => {
    mocks.getState.mockResolvedValue({ ok: true, data: { lastEventType: 'tool-call', userBufferedInput: '' } })
    let emit: ((e: any) => void) | null = null
    mocks.onEvent.mockImplementation((_sid: string, cb: any) => { emit = cb; return () => undefined })
    await queueReplyInClaude({ sessionId: 's1', text: 'first', focused: true, prompter: async () => 'queue' })
    await queueReplyInClaude({ sessionId: 's1', text: 'second', focused: true, prompter: async () => 'queue' })
    emit!({ type: 'user-input-expected' })
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.ptyWrite).toHaveBeenCalledWith('s1', 'second')
    expect(mocks.ptyWrite).not.toHaveBeenCalledWith('s1', 'first')
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

const defaultPrompter: ReplyPrompter = async () => 'cancel'

export async function queueReplyInClaude({ sessionId, text, focused, prompter }: Args) {
  const api = window.electronAPI
  if (!focused) await api.session.focus(sessionId)

  const resp = await api.transcript.getState(sessionId)
  const state = resp?.ok ? resp.data : { lastEventType: 'idle', userBufferedInput: '' }
  const busy = state.lastEventType === 'tool-call' || state.lastEventType === 'response'

  if (!busy) {
    const prefix = (state.userBufferedInput && state.userBufferedInput.length > 0) ? '\n' : ''
    await api.pty.write(sessionId, `${prefix}${text}`)
    return { status: 'sent' as const }
  }

  const decision = await (prompter ?? defaultPrompter)({ sessionId, text })
  if (decision === 'cancel') return { status: 'cancelled' as const }

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

The real UI wires `prompter` to `<ToastUndo>`-style component that renders "Claude is busy. Queue this context for when it's ready?" with Cancel / Queue buttons. The default prompter is `cancel` so a forgotten wiring never clobbers the user's input.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/claude-input-queue.ts tests/unit/renderer/lib/claude-input-queue.test.ts
git commit -m "feat(sidebar): Reply-in-Claude readiness contract with queue-on-busy"
```

---

### Task 8: `SessionContextSection` — pin badge + pin/unpin action + reasoning + show-more + closed warning

**Files:**
- Modify: `src/renderer/components/github/sections/SessionContextSection.tsx`

- [ ] **Step 1: Failing test**

`tests/unit/renderer/components/github/SessionContextSection.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const api = {
  github: {
    getSessionContext: vi.fn(async () => ({ ok: true, data: {
      primaryIssue: { number: 42, title: 't', state: 'closed' },
      otherSignals: [{ number: 7, source: 'branch' }, { number: 8, source: 'pr-body' }, { number: 9, source: 'transcript' }],
      activePR: null,
      recentFiles: Array.from({ length: 8 }, (_, i) => ({ filePath: `f${i}.ts`, at: Date.now() })),
    } })),
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
  it('shows pin badge and Unpin button when pinned', async () => {
    render(<SessionContextSection sessionId="s1" />)
    expect(await screen.findByLabelText(/pinned/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unpin/i })).toBeInTheDocument()
  })
  it('closed state uses muted colour and warning title', async () => {
    render(<SessionContextSection sessionId="s1" />)
    const pill = await screen.findByText('closed')
    expect(pill.className).toMatch(/overlay/)
    expect(pill).toHaveAttribute('title', expect.stringMatching(/closed/i))
  })
  it('renders reasoning glyphs for branch / pr-body / transcript signals', async () => {
    render(<SessionContextSection sessionId="s1" />)
    await screen.findByText(/branch match/i)
    expect(screen.getByText(/PR body ref/i)).toBeInTheDocument()
    expect(screen.getByText(/transcript ref/i)).toBeInTheDocument()
  })
  it('shows show-more control when recentFiles > 5; expands on click', async () => {
    render(<SessionContextSection sessionId="s1" />)
    const btn = await screen.findByRole('button', { name: /show 3 more/i })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(8))
  })
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Extend `SessionContextSection.tsx`. Key additions (append to existing body; keep the default export):

```tsx
import { useSessionStore } from '../../../stores/sessionStore'

// inside component, after state hooks:
const pinned = useSessionStore((s) =>
  s.sessions.find((x) => x.id === sessionId)?.githubIntegration?.pinnedIssueNumber,
)
const isPinned = !!ctx?.primaryIssue && ctx.primaryIssue.number === pinned
const [showAllFiles, setShowAllFiles] = useState(false)
const files = ctx?.recentFiles ?? []
const visibleFiles = showAllFiles ? files : files.slice(0, 5)
const extraFiles = files.length - visibleFiles.length

const REASON_LABEL: Record<string, string> = {
  branch: 'branch match',
  'pr-body': 'PR body ref',
  transcript: 'transcript ref',
}
```

In the primary-issue block, after the state pill:

```tsx
<span
  className={`ml-2 text-[10px] px-1 rounded ${
    ctx.primaryIssue.state === 'open'
      ? 'bg-green/20 text-green'
      : 'bg-overlay0/20 text-overlay1'
  }`}
  title={ctx.primaryIssue.state === 'closed' ? 'Closed issue — consider reviewing your pin' : undefined}
>
  {ctx.primaryIssue.state}
</span>
{isPinned && (
  <span aria-label="pinned" title="Pinned for this session" className="ml-2 text-[10px]">
    {String.fromCodePoint(0x1f4cc)}
  </span>
)}
<button
  className="ml-2 text-[10px] text-overlay0 hover:text-subtext0 transition-colors duration-200"
  onClick={() => window.electronAPI.github.pinSessionIssue(sessionId, isPinned ? null : ctx!.primaryIssue!.number)}
>
  {isPinned ? 'Unpin' : 'Pin'}
</button>
```

Update the other-signals list entries to show the reason label:

```tsx
<li key={`${s.source}:${s.repo ?? ''}:${s.number}`}>
  #{s.number} <span className="text-overlay0">({REASON_LABEL[s.source] ?? s.source})</span>
</li>
```

Replace the hard-coded `.slice(0, 5)` in the files block with the dynamic `visibleFiles` and append:

```tsx
{extraFiles > 0 && (
  <button
    className="ml-3 mt-1 text-overlay0 hover:text-subtext0 transition-colors duration-200"
    onClick={() => setShowAllFiles(true)}
  >
    Show {extraFiles} more
  </button>
)}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/sections/SessionContextSection.tsx tests/unit/renderer/components/github/SessionContextSection.test.tsx
git commit -m "feat(sidebar): Session Context pin, reasoning lines, show-more files, closed warning"
```

---

### Task 9: `ActivePRSection` — header (state pill + diff size + files) + labels chips

**Files:**
- Modify: `src/renderer/components/github/sections/ActivePRSection.tsx`

- [ ] **Step 1: Failing test**

`tests/unit/renderer/components/github/ActivePRSection.test.tsx` (seed a thin render helper that mocks the IPC result):

```tsx
function renderWith(pr: Partial<PullRequestSnapshot>) { /* wraps render with IPC mock */ }

it('header reads "#15 · open · +412/-38 · 14 files"', () => {
  renderWith({ number: 15, state: 'open', draft: false, additions: 412, deletions: 38, changedFiles: 14 })
  expect(screen.getByTestId('pr-header')).toHaveTextContent('#15')
  expect(screen.getByTestId('pr-header')).toHaveTextContent('open')
  expect(screen.getByTestId('pr-header')).toHaveTextContent('+412')
  expect(screen.getByTestId('pr-header')).toHaveTextContent('-38')
  expect(screen.getByTestId('pr-header')).toHaveTextContent('14 files')
})
it('renders labels chips', () => {
  renderWith({ labels: [{ name: 'bug', color: 'ff0000' }, { name: 'docs', color: '00ff00' }] })
  expect(screen.getByText('bug')).toBeInTheDocument()
  expect(screen.getByText('docs')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Replace the existing PR header block with:

```tsx
<div data-testid="pr-header" className="flex flex-wrap items-center gap-2 text-xs">
  <span className="text-mauve">#{pr.number}</span>
  <span className={`rounded px-1 ${pr.state === 'open' ? 'bg-green/20 text-green' : 'bg-overlay0/20 text-overlay1'}`}>
    {pr.draft ? 'draft' : pr.state}
  </span>
  <span className="text-green">+{pr.additions}</span>
  <span className="text-red">-{pr.deletions}</span>
  <span className="text-overlay0">{pr.changedFiles} files</span>
</div>

{pr.labels && pr.labels.length > 0 && (
  <div className="mt-1 flex flex-wrap gap-1">
    {pr.labels.map((l) => (
      <span
        key={l.name}
        className="rounded px-1 text-[10px]"
        style={{ backgroundColor: `#${l.color}30`, color: `#${l.color}` }}
      >
        {l.name}
      </span>
    ))}
  </div>
)}
```

Note: `+412/-38` uses an ASCII minus; interpunct `·` separates fields (existing convention elsewhere in the sidebar). No em dashes.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/sections/ActivePRSection.tsx tests/unit/renderer/components/github/ActivePRSection.test.tsx
git commit -m "feat(sidebar): Active PR header with state/diff/files + labels chips"
```

---

### Task 10: `ActivePRSection` — body preview + reviewers chips

- [ ] **Step 1: Failing test**

```tsx
it('body preview — 200 char max + expand/collapse', () => {
  renderWith({ bodyMarkdown: 'x'.repeat(500) })
  expect(screen.getByTestId('pr-body-preview').textContent!.length).toBeLessThanOrEqual(203)
  fireEvent.click(screen.getByRole('button', { name: /show more/i }))
  expect(screen.getByTestId('pr-body-preview').textContent!.length).toBeGreaterThan(400)
  fireEvent.click(screen.getByRole('button', { name: /show less/i }))
  expect(screen.getByTestId('pr-body-preview').textContent!.length).toBeLessThanOrEqual(203)
})
it('reviewer chips + verdict pill render', () => {
  renderWith({ reviewers: [
    { login: 'alice', verdict: 'approved' },
    { login: 'bob', verdict: 'changes_requested' },
    { login: 'carol', verdict: 'requested' },
  ] })
  expect(screen.getByText('alice')).toBeInTheDocument()
  expect(screen.getByText(/approved/i)).toBeInTheDocument()
  expect(screen.getByText(/changes requested/i)).toBeInTheDocument()
  expect(screen.getByText(/requested/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
const [bodyExpanded, setBodyExpanded] = useState(false)
{pr.bodyMarkdown && (
  <div className="mt-1 text-xs">
    <div data-testid="pr-body-preview" className="text-subtext0 whitespace-pre-wrap">
      {(bodyExpanded || pr.bodyMarkdown.length <= 200)
        ? pr.bodyMarkdown
        : pr.bodyMarkdown.slice(0, 200) + String.fromCodePoint(0x2026)}
    </div>
    {pr.bodyMarkdown.length > 200 && (
      <button
        className="text-overlay0 hover:text-subtext0 transition-colors duration-200"
        onClick={() => setBodyExpanded((v) => !v)}
      >
        {bodyExpanded ? 'Show less' : 'Show more'}
      </button>
    )}
  </div>
)}

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
          {r.verdict.replace('_', ' ')}
        </span>
      </span>
    ))}
  </div>
)}
```

If a `SanitizedMarkdown` component exists, swap the body `<div>` for it. Otherwise, plain text is acceptable for Phase 2 — markdown rendering is deferred to its own follow-up.

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/ActivePRSection.tsx tests/unit/renderer/components/github/ActivePRSection.test.tsx
git commit -m "feat(sidebar): Active PR body preview + reviewers chips"
```

---

### Task 11: `ActivePRSection` — mergeable detail + convert-to-draft

- [ ] **Step 1: Failing test**

```tsx
it('conflict — shows files + base branch', () => {
  renderWith({ mergeable: 'conflict', mergeableDetail: { conflictingFiles: ['a.ts', 'b.ts'], baseBranch: 'main' } })
  expect(screen.getByText('a.ts')).toBeInTheDocument()
  expect(screen.getByText('b.ts')).toBeInTheDocument()
  expect(screen.getByText(/main/)).toBeInTheDocument()
})
it('unknown — shows "checking..." with refresh glyph', () => {
  renderWith({ mergeable: 'unknown' })
  expect(screen.getByText(/checking/i)).toBeInTheDocument()
})
it('convert-to-draft → setPullRequestDraft(profileId, slug, number, true)', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.setPullRequestDraft = spy
  renderWith({ draft: false, number: 15 })
  fireEvent.click(screen.getByRole('button', { name: /convert to draft/i }))
  expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 15, true)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
{pr.mergeable === 'conflict' && pr.mergeableDetail && (
  <div className="mt-1 text-xs text-red">
    Conflicts against <code className="text-peach">{pr.mergeableDetail.baseBranch}</code>:
    <ul className="ml-3">
      {pr.mergeableDetail.conflictingFiles?.map((f) => (
        <li key={f}><code className="text-peach">{f}</code></li>
      ))}
    </ul>
  </div>
)}
{pr.mergeable === 'unknown' && (
  <div className="mt-1 text-xs text-overlay0">
    checking... {String.fromCodePoint(0x21bb)}
  </div>
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

`profileId` and `slug` come from the section's existing props (or `useGithubStore`). If the section doesn't currently have `profileId` in scope, add it as a prop from `GitHubPanel` which already resolves it.

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/ActivePRSection.tsx tests/unit/renderer/components/github/ActivePRSection.test.tsx
git commit -m "feat(sidebar): Active PR mergeable detail + convert-to-draft"
```

---

### Task 12: `CISection` — two-line run row + summary pill colour

**Files:**
- Modify: `src/renderer/components/github/sections/CISection.tsx`

- [ ] **Step 1: Failing test**

`tests/unit/renderer/components/github/CISection.test.tsx`:

```tsx
it('renders two-line row: line 1 workflow+duration, line 2 branch/sha/message/trigger/when', () => {
  render(<CISection runs={[{ id:1, name:'CI', status:'completed', conclusion:'success',
    durationSec: 73, headBranch:'feat/x', headSha:'abc1234abcd', headMessage:'fix: y', event:'push', updatedAt: Date.now() - 60000 }]} />)
  expect(screen.getByTestId('ci-line-1-1')).toHaveTextContent(/CI/)
  expect(screen.getByTestId('ci-line-1-1')).toHaveTextContent(/1m 13s/)
  expect(screen.getByTestId('ci-line-2-1')).toHaveTextContent(/feat\/x/)
  expect(screen.getByTestId('ci-line-2-1')).toHaveTextContent(/abc1234/)
  expect(screen.getByTestId('ci-line-2-1')).toHaveTextContent(/fix: y/)
  expect(screen.getByTestId('ci-line-2-1')).toHaveTextContent(/push/)
})
it('summary pill reflects live state colour', () => {
  render(<CISection runs={[{ id:1, conclusion:'success', status:'completed' }, { id:2, conclusion:'failure', status:'completed' }]} />)
  expect(screen.getByTestId('ci-summary-pill').className).toMatch(/bg-red/)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
function formatDuration(sec: number | undefined): string {
  if (!sec || sec < 0) return ''
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
}

// row:
<div data-testid={`ci-line-1-${r.id}`} className="flex items-center gap-2 text-xs">
  <span className={runColor(r)}>{runIcon(r)}</span>
  <span className="text-text font-medium">{r.name}</span>
  {r.durationSec !== undefined && <span className="text-overlay0">{formatDuration(r.durationSec)}</span>}
  <span className="ml-auto flex gap-1">{/* open / watch / rerun buttons */}</span>
</div>
<div data-testid={`ci-line-2-${r.id}`} className="pl-5 text-[11px] text-overlay0">
  on <span className="text-peach">{r.headBranch}</span>
  {' · '}<code>{r.headSha?.slice(0, 7)}</code>
  {r.headMessage && <> {' · '}{r.headMessage}</>}
  {r.event && <> {' · '}{r.event}</>}
  {' · '}{relativeTime(r.updatedAt)}
</div>

// summary pill colour:
const summaryColor = useMemo(() => {
  if (runs.some((r) => r.conclusion === 'failure')) return 'bg-red/20 text-red'
  if (runs.some((r) => r.status === 'in_progress' || r.status === 'queued')) return 'bg-yellow/20 text-yellow'
  return 'bg-green/20 text-green'
}, [runs])
// <span data-testid="ci-summary-pill" className={`rounded px-1 ${summaryColor}`}>{runs.length}</span>
```

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/CISection.tsx tests/unit/renderer/components/github/CISection.test.tsx
git commit -m "feat(sidebar): CI two-line row + live-colour summary pill"
```

---

### Task 13: `CISection` — auto-expand on failure + filter chips

- [ ] **Step 1: Failing test**

```tsx
it('auto-expands failed runs to show failedJobs + tailLine', () => {
  render(<CISection runs={[{ id:1, status:'completed', conclusion:'failure', name:'CI',
    failedJobs: [{ id:10, name:'tests', tailLine:'AssertionError: x' }] }]} />)
  expect(screen.getByText('tests')).toBeInTheDocument()
  expect(screen.getByText(/AssertionError/)).toBeInTheDocument()
})
it('respects sectionPrefs.ci.autoExpandOnFailure=false', () => {
  renderWithPrefs({ ci: { autoExpandOnFailure: false } }, { runs: [failingRun] })
  expect(screen.queryByText(/AssertionError/)).toBeNull()
})
it('filter chips — All / Failing / This branch / PR only', () => {
  render(<CISection runs={fourMixedRuns} currentBranch="feat/x" />)
  fireEvent.click(screen.getByRole('button', { name: /failing/i }))
  expect(screen.getAllByTestId(/^ci-line-1-/).length).toBe(2)
  fireEvent.click(screen.getByRole('button', { name: /this branch/i }))
  expect(screen.getAllByTestId(/^ci-line-1-/).every((el) => el.textContent!.includes('feat/x'))).toBe(true)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
const autoExpand = sectionPrefs?.ci?.autoExpandOnFailure ?? true
const [expandedRunIds, setExpandedRunIds] = useState<Set<number>>(new Set())
const isExpanded = (r: WorkflowRunSnapshot) =>
  expandedRunIds.has(r.id) || (autoExpand && r.conclusion === 'failure')

{isExpanded(r) && r.failedJobs && r.failedJobs.length > 0 && (
  <ul className="mt-1 ml-5 space-y-1 text-[11px]">
    {r.failedJobs.map((j) => (
      <li key={j.id}>
        <span className="text-red">{String.fromCodePoint(0x2717)}</span> {j.name}
        {j.tailLine && (
          <pre className="mt-0.5 whitespace-pre-wrap rounded bg-surface0 px-2 py-1 text-overlay1">
            {j.tailLine}
          </pre>
        )}
      </li>
    ))}
  </ul>
)}

const [filter, setFilter] = useState<'all'|'failing'|'this-branch'|'pr-only'>(
  (sectionPrefs?.ci?.filter as any) ?? 'all'
)
const filtered = useMemo(() => {
  switch (filter) {
    case 'failing': return runs.filter((r) => r.conclusion === 'failure')
    case 'this-branch': return runs.filter((r) => r.headBranch === currentBranch)
    case 'pr-only': return runs.filter((r) => (r as any).pullRequestNumbers?.length > 0)
    default: return runs
  }
}, [runs, filter, currentBranch])

function onFilterChange(next: typeof filter) {
  setFilter(next)
  void window.electronAPI.github.setSectionPrefs(sessionId, 'ci', { filter: next })
}
```

Render chips as a small segmented control. Each chip: `rounded px-2 py-0.5 text-[10px] transition-colors duration-200` plus a highlighted style when active.

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/CISection.tsx tests/unit/renderer/components/github/CISection.test.tsx
git commit -m "feat(sidebar): CI auto-expand on failure + filter chips"
```

---

### Task 14: `ReviewsSection` — ScrollingFeed + filter chips + verdict mix pill

**Files:**
- Modify: `src/renderer/components/github/sections/ReviewsSection.tsx`

- [ ] **Step 1: Failing test**

`tests/unit/renderer/components/github/ReviewsSection.test.tsx`:

```tsx
it('wraps thread list in ScrollingFeed with feedId "reviews:<slug>:<pr>"', () => {
  render(<ReviewsSection sessionId="s1" slug="o/r" prNumber={15} threads={threeOpenThreads} reviewers={[]} />)
  expect(screen.getByTestId('scrolling-feed')).toHaveAttribute('data-feed-id', 'reviews:o/r:15')
})
it('filter chips — Open / Resolved / All — filter threads', () => {
  render(<ReviewsSection threads={[openT, resolvedT]} />)
  fireEvent.click(screen.getByRole('button', { name: /resolved/i }))
  expect(screen.getAllByTestId('review-thread').length).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: /all/i }))
  expect(screen.getAllByTestId('review-thread').length).toBe(2)
})
it('verdict mix pill: "1 changes · 1 approved"', () => {
  render(<ReviewsSection reviewers={[{ verdict:'changes_requested' }, { verdict:'approved' }]} threads={[]} />)
  expect(screen.getByTestId('review-verdict-mix')).toHaveTextContent('1 changes · 1 approved')
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
import { ScrollingFeed } from '../feed/ScrollingFeed'

const [filter, setFilter] = useState<'open'|'resolved'|'all'>('open')
const filteredThreads = useMemo(() => {
  if (filter === 'all') return threads
  return threads.filter((t) => filter === 'open' ? !t.resolved : t.resolved)
}, [threads, filter])

const mix = useMemo(() => {
  const count = (v: string) => reviewers.filter((r) => r.verdict === v).length
  const parts: string[] = []
  const c = count('changes_requested'); if (c) parts.push(`${c} changes`)
  const a = count('approved'); if (a) parts.push(`${a} approved`)
  const q = count('requested'); if (q) parts.push(`${q} requested`)
  return parts.join(' · ') || `${threads.length} open`
}, [reviewers, threads.length])

// render:
<div className="flex items-center gap-2 text-xs">
  <span data-testid="review-verdict-mix" className="text-overlay1">{mix}</span>
  <SegmentedChips value={filter} onChange={setFilter} options={['open','resolved','all']} />
</div>
<ScrollingFeed
  data-testid="scrolling-feed"
  data-feed-id={`reviews:${slug}:${prNumber}`}
  items={filteredThreads}
  keyOf={(t) => t.id}
  timestampOf={(t) => t.updatedAt}
  sessionId={sessionId}
  feedId={`reviews:${slug}:${prNumber}`}
  renderItem={(t, { unread }) => (
    <div data-testid="review-thread" className={t.resolved ? 'opacity-45' : ''}>
      {/* existing thread row; add `unread` blue dot left of author */}
    </div>
  )}
/>
```

`<SegmentedChips>` is a trivial local helper — three `<button>`s with `transition-colors duration-200` and an active/inactive style. Defined in-file to avoid churning Phase 1b's section-options components.

Reply-in-Claude button is NOT wired in Reviews this phase (scope note in PR body) — it lands with its Linked Issues counterpart in the follow-up slice of this PR if the UI-level toast prompter is ready, or deferred otherwise.

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/ReviewsSection.tsx tests/unit/renderer/components/github/ReviewsSection.test.tsx
git commit -m "feat(sidebar): Reviews wired to ScrollingFeed with filter chips and verdict mix"
```

---

### Task 15: `IssuesSection` — filter chips + sort dropdown

**Files:**
- Modify: `src/renderer/components/github/sections/IssuesSection.tsx`

- [ ] **Step 1: Failing test**

`tests/unit/renderer/components/github/IssuesSection.test.tsx`:

```tsx
it('defaults to Last activity sort — most recent first', () => {
  render(<IssuesSection issues={[{ number:99, lastActivityAt:1, state:'open' }, { number:3, lastActivityAt:100, state:'open' }]} />)
  expect(screen.getAllByTestId(/^issue-row-/)[0]).toHaveTextContent('#3')
})
it('Number sort re-orders ascending', () => {
  render(<IssuesSection issues={sameIssues} />)
  fireEvent.click(screen.getByRole('button', { name: /sort/i }))
  fireEvent.click(screen.getByRole('menuitem', { name: /number/i }))
  expect(screen.getAllByTestId(/^issue-row-/)[0]).toHaveTextContent('#3')
})
it('Primary-only filter hides non-primary', () => {
  render(<IssuesSection issues={[{ number:1, isPrimary:true, state:'open' }, { number:2, state:'open' }]} />)
  fireEvent.click(screen.getByRole('button', { name: /primary only/i }))
  expect(screen.getAllByTestId(/^issue-row-/).length).toBe(1)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Internally rename the default-exported component to `LinkedIssuesSection` (file stays named `IssuesSection.tsx`; export stays default). Key additions:

```tsx
const [filter, setFilter] = useState<'open'|'all'|'primary'>((prefs?.linkedIssues?.filter as any) ?? 'open')
const [sortBy, setSortBy] = useState<'last-activity'|'linked-at'|'state'|'number'>(
  (prefs?.linkedIssues?.sortBy as any) ?? 'last-activity'
)

const visible = useMemo(() => {
  let xs = issues
  if (filter === 'open') xs = xs.filter((i) => i.state === 'open')
  if (filter === 'primary') xs = xs.filter((i) => i.isPrimary)
  const keyOf: Record<typeof sortBy, (i: LinkedIssueSnapshot) => number> = {
    'last-activity': (i) => i.lastActivityAt ?? 0,
    'linked-at':     (i) => i.linkedAt ?? 0,
    'state':         (i) => (i.state === 'open' ? 0 : 1),
    'number':        (i) => i.number,
  }
  const asc = sortBy === 'number' || sortBy === 'state'
  return [...xs].sort((a, b) => {
    const d = keyOf[sortBy](a) - keyOf[sortBy](b)
    return asc ? d : -d
  })
}, [issues, filter, sortBy])

const persistFilter = (next: typeof filter) => {
  setFilter(next); void window.electronAPI.github.setSectionPrefs(sessionId, 'linkedIssues', { filter: next })
}
const persistSort = (next: typeof sortBy) => {
  setSortBy(next); void window.electronAPI.github.setSectionPrefs(sessionId, 'linkedIssues', { sortBy: next })
}
```

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/IssuesSection.tsx tests/unit/renderer/components/github/IssuesSection.test.tsx
git commit -m "feat(sidebar): Linked Issues filter chips + sort dropdown"
```

---

### Task 16: `IssuesSection` — linkage reason, activity signal, labels

- [ ] **Step 1: Failing test**

```tsx
it('renders reason glyph by source', () => {
  render(<IssuesSection issues={[
    { number:1, reason:'branch', state:'open' },
    { number:2, reason:'pr-body', state:'open' },
    { number:3, reason:'transcript', state:'open' },
  ]} />)
  expect(screen.getByTestId('issue-row-1')).toHaveTextContent(String.fromCodePoint(0x1f33f))
  expect(screen.getByTestId('issue-row-2')).toHaveTextContent(String.fromCodePoint(0x1f517))
  expect(screen.getByTestId('issue-row-3')).toHaveTextContent(String.fromCodePoint(0x1f4dc))
})
it('shows comment count + last activity age + label chips', () => {
  render(<IssuesSection issues={[
    { number:1, state:'open', commentCount:3, lastActivityAt: Date.now() - 3600*1000,
      labels: [{ name:'bug', color:'f00' }] },
  ]} />)
  expect(screen.getByText(/3 comments/i)).toBeInTheDocument()
  expect(screen.getByText(/1h ago/i)).toBeInTheDocument()
  expect(screen.getByText('bug')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
const REASON_GLYPH: Record<LinkageReason, string> = {
  branch: String.fromCodePoint(0x1f33f),      // 🌿
  'pr-body': String.fromCodePoint(0x1f517),   // 🔗
  transcript: String.fromCodePoint(0x1f4dc),  // 📜
}

visible.map((i) => (
  <div key={i.number} data-testid={`issue-row-${i.number}`} className="flex items-center gap-2 text-xs">
    {i.reason && <span title={i.reason}>{REASON_GLYPH[i.reason]}</span>}
    <span className="text-blue">#{i.number}</span>
    <span className="truncate text-text">{i.title}</span>
    {i.commentCount !== undefined && <span className="text-overlay0">{i.commentCount} comments</span>}
    {i.lastActivityAt && <span className="text-overlay0">{relativeTime(i.lastActivityAt)}</span>}
    {(i.labels ?? []).map((l) => (
      <span key={l.name} className="rounded px-1 text-[10px]"
            style={{ backgroundColor: `#${l.color}30`, color: `#${l.color}` }}>
        {l.name}
      </span>
    ))}
  </div>
))
```

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/IssuesSection.tsx tests/unit/renderer/components/github/IssuesSection.test.tsx
git commit -m "feat(sidebar): Linked Issues reason glyph + activity + labels"
```

---

### Task 17: `IssuesSection` — per-issue ⋯ kebab with Reply-in-Claude

- [ ] **Step 1: Failing test**

```tsx
it('kebab menu — Open / Reply in Claude / Copy ref / Pin / Unlink', () => {
  render(<IssuesSection sessionId="s1" issues={[{ number:7, title:'t', state:'open', url:'https://x' }]} />)
  fireEvent.click(screen.getByLabelText(/options for #7/i))
  for (const name of [/open/i, /reply in claude/i, /copy ref/i, /pin as/i, /unlink/i]) {
    expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
  }
})
it('Reply in Claude → queueReplyInClaude with a prompt referencing #N and title', async () => {
  const spy = vi.fn(async () => ({ status: 'sent' }))
  vi.doMock('../../../src/renderer/lib/claude-input-queue', () => ({ queueReplyInClaude: spy }))
  // re-render, open menu, click Reply in Claude
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 's1',
    text: expect.stringMatching(/#7.*t/),
  }))
})
it('Unlink → unlinkIssue(sessionId, number)', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.unlinkIssue = spy
  fireEvent.click(screen.getByLabelText(/options for #7/i))
  fireEvent.click(screen.getByRole('menuitem', { name: /unlink/i }))
  expect(spy).toHaveBeenCalledWith('s1', 7)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Inline kebab (no new shared component in Phase 2 — reuse the pattern from `<SidebarHeaderMenu>` in Phase 1a):

```tsx
import { queueReplyInClaude } from '../../../lib/claude-input-queue'
import { useToastPrompter } from '../../toast/ToastUndo' // supplied by Phase 1b

const [openFor, setOpenFor] = useState<number | null>(null)
const busyPrompter = useToastPrompter() // returns an async ({ text }) => 'queue'|'cancel' bound to a toast

function kebab(i: LinkedIssueSnapshot) {
  if (openFor !== i.number) return null
  return (
    <div role="menu" aria-label={`Options for #${i.number}`} className="absolute right-0 top-6 z-10 w-44 rounded border border-surface0 bg-base p-1 shadow-lg">
      <MenuBtn onClick={() => window.electronAPI.shell.openExternal(i.url)}>Open</MenuBtn>
      <MenuBtn onClick={() => queueReplyInClaude({
        sessionId, text: `Working on issue #${i.number}: ${i.title}\n${i.url}`,
        focused: sessionIsFocused, prompter: busyPrompter,
      })}>Reply in Claude</MenuBtn>
      <MenuBtn onClick={() => navigator.clipboard.writeText(`${slug}#${i.number}`)}>Copy ref</MenuBtn>
      <MenuBtn onClick={() => window.electronAPI.github.pinSessionIssue(sessionId, i.number)}>Pin as primary</MenuBtn>
      <MenuBtn onClick={() => window.electronAPI.github.unlinkIssue(sessionId, i.number)}>Unlink from session</MenuBtn>
    </div>
  )
}

const MenuBtn = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button role="menuitem" onClick={() => { onClick(); setOpenFor(null) }}
          className="block w-full px-2 py-1 text-left text-xs hover:bg-surface0 transition-colors duration-150">
    {children}
  </button>
)
```

If `useToastPrompter` isn't on the 1b base yet, stub it in-file returning `'cancel'` with a `TODO(1b)` so the readiness contract's `defaultPrompter: 'cancel'` guard applies.

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/IssuesSection.tsx tests/unit/renderer/components/github/IssuesSection.test.tsx
git commit -m "feat(sidebar): Linked Issues per-issue kebab with Reply-in-Claude"
```

---

### Task 18: `NotificationsSection` — merge chip + reason chips

**Files:**
- Modify: `src/renderer/components/github/sections/NotificationsSection.tsx`

- [ ] **Step 1: Failing test**

`tests/unit/renderer/components/github/NotificationsSection.test.tsx`:

```tsx
it('renders merged count and per-profile breakdown chip', () => {
  render(<NotificationsSection sessionId="s1" notifications={[
    { id:'t1', profileId:'p1', unread:true, reason:'review_requested', updatedAt:0, title:'x', repo:'a/b', url:'u' },
    { id:'t2', profileId:'p2', unread:true, reason:'mention', updatedAt:0, title:'y', repo:'a/b', url:'u' },
  ]} />)
  const chip = screen.getByTestId('notifications-merge-chip')
  expect(chip).toHaveTextContent(/p1/)
  expect(chip).toHaveTextContent(/p2/)
})
it('renders reason glyphs per item', () => {
  render(<NotificationsSection notifications={[
    { id:'t1', reason:'review_requested', unread:true, updatedAt:0, title:'x', repo:'a/b', url:'u' },
    { id:'t2', reason:'mention', unread:true, updatedAt:0, title:'y', repo:'a/b', url:'u' },
    { id:'t3', reason:'assign', unread:true, updatedAt:0, title:'z', repo:'a/b', url:'u' },
    { id:'t4', reason:'author', unread:true, updatedAt:0, title:'w', repo:'a/b', url:'u' },
  ]} />)
  for (const id of ['t1','t2','t3','t4']) {
    expect(screen.getByTestId(`notif-reason-${id}`)).toBeInTheDocument()
  }
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
const perProfile = useMemo(() => {
  const m = new Map<string, number>()
  for (const n of notifications) {
    const pid = n.profileId ?? 'unknown'
    m.set(pid, (m.get(pid) ?? 0) + 1)
  }
  return Array.from(m.entries())
}, [notifications])

<div data-testid="notifications-merge-chip" className="flex flex-wrap gap-1 text-[10px]">
  <span className="rounded bg-surface0 px-1 text-subtext0">{notifications.length} total</span>
  {perProfile.map(([pid, n]) => (
    <span key={pid} className="rounded bg-surface0 px-1 text-overlay1">{pid}: {n}</span>
  ))}
</div>

const REASON_GLYPH: Partial<Record<NotificationReason, { glyph: string; title: string }>> = {
  review_requested: { glyph: String.fromCodePoint(0x23f3), title: 'Reviews' },
  mention:         { glyph: '@', title: 'Mentions' },
  assign:          { glyph: '+', title: 'Assigned' },
  author:          { glyph: String.fromCodePoint(0x270f), title: 'Author' },
}

// per notif row:
{n.reason && REASON_GLYPH[n.reason] && (
  <span data-testid={`notif-reason-${n.id}`} title={REASON_GLYPH[n.reason]!.title}
        className="text-[10px] text-overlay1">
    {REASON_GLYPH[n.reason]!.glyph}
  </span>
)}
```

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/NotificationsSection.tsx tests/unit/renderer/components/github/NotificationsSection.test.tsx
git commit -m "feat(sidebar): Notifications merge chip + reason chips"
```

---

### Task 19: `NotificationsSection` — mark-all-read with ToastUndo

- [ ] **Step 1: Failing test**

```tsx
it('mark-all-read optimistically clears unread then shows ToastUndo; undo restores', async () => {
  const api = (globalThis as any).window.electronAPI.github
  api.markAllNotificationsRead = vi.fn(async () => ({ ok: true }))
  render(<NotificationsSection notifications={twoUnread} />)
  fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))
  expect(screen.queryAllByTestId(/^unread-dot-/).length).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: /undo/i }))
  expect(screen.queryAllByTestId(/^unread-dot-/).length).toBe(2)
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
import { useToastUndo } from '../../toast/ToastUndo' // Phase 1b

const [localNotifs, setLocalNotifs] = useState(notifications)
useEffect(() => setLocalNotifs(notifications), [notifications])

const { showUndo } = useToastUndo()
const markAll = async () => {
  const snapshot = localNotifs
  setLocalNotifs(localNotifs.map((n) => ({ ...n, unread: false })))
  const profileId = selectedProfileId ?? null
  await window.electronAPI.github.markAllNotificationsRead(profileId)
  showUndo('Marked all as read.', {
    onUndo: () => setLocalNotifs(snapshot),
    timeoutMs: 5000,
  })
}

// Button lives next to the merge chip:
<button
  className="rounded px-2 py-1 text-[10px] text-overlay1 hover:bg-surface0 hover:text-text transition-colors duration-200"
  onClick={markAll}
>
  Mark all read
</button>
```

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/NotificationsSection.tsx tests/unit/renderer/components/github/NotificationsSection.test.tsx
git commit -m "feat(sidebar): Notifications mark-all-read with ToastUndo"
```

---

### Task 20: `NotificationsSection` — per-item kebab (snooze + unsubscribe + dismiss)

- [ ] **Step 1: Failing test**

```tsx
it('Snooze 2h → snoozeNotification(profileId, threadId, now+2h ±60s)', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.snoozeNotification = spy
  render(<NotificationsSection notifications={[{ id:'t1', profileId:'p1', unread:true, updatedAt:0, title:'x', repo:'a/b', url:'u' }]} />)
  fireEvent.click(screen.getByLabelText(/options for t1/i))
  fireEvent.click(screen.getByRole('menuitem', { name: /snooze 2h/i }))
  const resumesAt = spy.mock.calls[0][2] as number
  expect(Math.abs(resumesAt - (Date.now() + 2 * 3600 * 1000))).toBeLessThan(60_000)
})
it('Snooze tomorrow → resumes at 8am next day', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.snoozeNotification = spy
  // open menu, click snooze tomorrow
  const d = new Date(spy.mock.calls[0][2])
  expect(d.getHours()).toBe(8); expect(d.getMinutes()).toBe(0)
})
it('Unsubscribe → unsubscribeThread(profileId, threadId)', async () => {
  const spy = vi.fn(async () => ({ ok: true }))
  ;(globalThis as any).window.electronAPI.github.unsubscribeThread = spy
  // open menu, click unsubscribe
  expect(spy).toHaveBeenCalledWith('p1', 't1')
})
it('Dismiss removes item from local UI', () => {
  render(<NotificationsSection notifications={[{ id:'t1', profileId:'p1', unread:true, updatedAt:0, title:'x', repo:'a/b', url:'u' }]} />)
  fireEvent.click(screen.getByLabelText(/options for t1/i))
  fireEvent.click(screen.getByRole('menuitem', { name: /dismiss/i }))
  expect(screen.queryByLabelText(/options for t1/i)).toBeNull()
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
const tomorrow8am = () => {
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime()
}

const [openFor, setOpenFor] = useState<string | null>(null)
const kebab = (n: NotificationSnapshot) => (
  <div role="menu" aria-label={`Options for ${n.id}`} className="absolute right-0 top-6 z-10 w-44 rounded border border-surface0 bg-base p-1 shadow-lg">
    <MenuBtn onClick={() => window.electronAPI.shell.openExternal(n.url)}>Open</MenuBtn>
    <MenuBtn onClick={() => window.electronAPI.github.markNotificationRead(n.profileId!, n.id)}>Mark read</MenuBtn>
    <MenuBtn onClick={() => window.electronAPI.github.snoozeNotification(n.profileId!, n.id, Date.now() + 2 * 3600 * 1000)}>Snooze 2h</MenuBtn>
    <MenuBtn onClick={() => window.electronAPI.github.snoozeNotification(n.profileId!, n.id, tomorrow8am())}>Snooze until tomorrow</MenuBtn>
    <MenuBtn onClick={() => window.electronAPI.github.unsubscribeThread(n.profileId!, n.id)}>Unsubscribe</MenuBtn>
    <MenuBtn onClick={() => setLocalNotifs((xs) => xs.filter((x) => x.id !== n.id))}>Dismiss</MenuBtn>
  </div>
)
```

Dismiss is a local-UI action only — GitHub has no dedicated dismiss API. Add a code comment calling that out.

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/NotificationsSection.tsx tests/unit/renderer/components/github/NotificationsSection.test.tsx
git commit -m "feat(sidebar): Notifications per-item kebab (snooze/unsubscribe/dismiss)"
```

---

### Task 21: `NotificationsSection` — wire ScrollingFeed + returned-from-snooze pill

- [ ] **Step 1: Failing test**

```tsx
it('wraps list in ScrollingFeed with feedId "notifications:<scope>"', () => {
  render(<NotificationsSection notifications={manyUnread} sessionId="s1" />)
  expect(screen.getByTestId('scrolling-feed')).toHaveAttribute('data-feed-id', /^notifications:/)
})
it('returnedFromSnooze items render with a "returned" pill', () => {
  render(<NotificationsSection notifications={[{ id:'t1', unread:true, returnedFromSnooze:true, updatedAt:0, title:'x', repo:'a/b', url:'u', profileId:'p1' }]} />)
  expect(screen.getByText(/returned/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```tsx
const feedId = `notifications:${selectedProfileId ?? 'merged'}`
<ScrollingFeed
  data-testid="scrolling-feed"
  data-feed-id={feedId}
  items={filtered}
  keyOf={(n) => `${n.profileId ?? 'x'}:${n.id}`}
  timestampOf={(n) => n.updatedAt}
  sessionId={sessionId}
  feedId={feedId}
  renderItem={(n, { unread }) => (
    <div className="flex items-start gap-2">
      {unread && <span data-testid={`unread-dot-${n.id}`} className="mt-1.5 h-2 w-2 rounded-full bg-blue" />}
      {/* reason glyph + repo + title + age + kebab */}
      {n.returnedFromSnooze && (
        <span className="rounded bg-yellow/20 px-1 text-[10px] text-yellow">returned</span>
      )}
    </div>
  )}
/>
```

- [ ] **Step 4: Run — PASS + commit**

```bash
git add src/renderer/components/github/sections/NotificationsSection.tsx tests/unit/renderer/components/github/NotificationsSection.test.tsx
git commit -m "feat(sidebar): Notifications wired to ScrollingFeed with returned-from-snooze pill"
```

---

### Task 22: Panel-level smoke test

**Files:**
- Create: `tests/unit/renderer/components/github/panel-phase2-smoke.test.tsx`

- [ ] **Step 1: Write the smoke**

Render the whole `GitHubPanel` with a fixture payload that exercises every new branch:
- primary issue in closed state + pinned
- PR with labels + long body + conflicting files + requested reviewer
- CI with a failing run having `failedJobs`
- Linked issues with all three reason glyphs + labels + activity
- Notifications across two profiles with one `returnedFromSnooze`

Assert: no console errors; at least one visible element from each upgraded section renders; no React warnings about keys; interactions (chip click / kebab open) don't throw.

- [ ] **Step 2: Run `npx vitest run`** — full green.

- [ ] **Step 3: `npm run typecheck`** — clean.

- [ ] **Step 4: `npm run dev`** — hand-verify per scope:
  - Session Context: pin/unpin round-trips; reasoning labels correct; show-more reveals all files.
  - Active PR: header, labels, body expand/collapse, reviewers, conflict list, convert-to-draft all work.
  - CI: two-line rows render; failing run auto-expands; chips change counts; summary pill matches live colour.
  - Reviews: threads virtualise past ~100; chips filter; verdict pill correct.
  - Linked Issues: sort persists across reload (via `sectionPrefs`); filter chips work; kebab → Unlink drops row; Reply-in-Claude toast opens when session is busy.
  - Notifications: Snooze 2h hides item; mark-all-read + Undo round-trips; Unsubscribe hits REST.

- [ ] **Step 5: Commit smoke**

```bash
git add tests/unit/renderer/components/github/panel-phase2-smoke.test.tsx
git commit -m "test(sidebar): integration smoke for Phase 2 easy-wins"
```

---

### Task 23: Push + PR

- [ ] **Step 1:**

```bash
git push -u origin feat/sidebar-easy-wins
gh pr create --base feat/scrolling-feed --title "sidebar 2: easy-wins content + ScrollingFeed wired to Reviews/Notifications" --body "$(cat <<'EOF'
## Summary
- Session Context: pin/unpin with 📌, reasoning labels per candidate, show-more files, closed muted pill.
- Active PR: header with state pill + diff + file count, label chips, 200-char body preview with expand, reviewer chips with verdict pill, conflict file list + base branch, checking-state on `unknown`, Convert to draft.
- CI: two-line run row, failedJobs+tail auto-expand on failure, All/Failing/This branch/PR only chips, live-colour summary pill.
- Reviews: `<ScrollingFeed>` thread list, Open/Resolved/All chips, verdict mix pill.
- Linked Issues: Open/All/Primary chips, sort dropdown (last activity default), linkage-reason glyphs, comment count + age, label chips, per-issue kebab (Open / Reply in Claude / Copy ref / Pin / Unlink).
- Notifications: all-profiles merge chip with per-profile counts, reason glyphs, Mark all read + ToastUndo, per-item kebab (Open / Mark read / Snooze 2h / Snooze tomorrow / Unsubscribe / Dismiss), `<ScrollingFeed>` list, snooze filtered at sync tick with returned-from-snooze pill.
- `src/renderer/lib/claude-input-queue.ts`: Reply-in-Claude readiness contract — checks `transcript-watcher` state, queues on busy, prefixes newline when idle-with-buffered-input, focuses session first when needed.
- `src/main/ipc/github-notifications-mutations.ts`: mark-read / mark-all / snooze / unsubscribe / unlink / pin / set-draft handlers. Real REST where applicable; GraphQL for PR draft conversion.

Stacked on `feat/scrolling-feed`. Skips Local Git (§6), edit deltas, Live Activity (those are Phases 3 and 4).

## Test plan
- [x] `npx vitest run` — all new unit tests green.
- [x] `npm run typecheck` clean.
- [x] Manual smoke per Task 22.
- [x] Real GitHub REST exercised manually for: mark-read, mark-all-read, unsubscribe, PR draft conversion.
- [x] Snooze re-surface verified on a real 2h interval once end-to-end; short interval faked in tests.
EOF
)"
```

---

## Self-review checklist

- [ ] Every task lists exact file paths.
- [ ] Every TDD step has expected FAIL then expected PASS.
- [ ] Types used in later tasks (LinkageReason, Reviewer, etc.) defined in Task 1.
- [ ] Snooze lives in `github-config.json` (survives crash), not session-state.
- [ ] Unsubscribe is a real `DELETE /notifications/threads/:id/subscription`.
- [ ] PR draft conversion uses GraphQL mutations (`convertPullRequestToDraft` / `markPullRequestReadyForReview`).
- [ ] No new npm dependencies. ScrollingFeed + ToastUndo assumed to exist from Phase 1b/1c.
- [ ] Zustand selectors use `useStore((s) => s.x)`; no destructuring.
- [ ] No `\u{...}` escapes — all glyphs via `String.fromCodePoint(0x...)`.
- [ ] No Node imports in renderer.
- [ ] Public-facing copy: no em dashes; minus signs in diff counts; interpuncts for field separators.
- [ ] Animations 150-300ms via Tailwind `transition-colors duration-200` (150 for menu items).
- [ ] `claude-input-queue` default prompter is `cancel` — never clobbers input on missing wiring.
- [ ] All Reply-in-Claude payloads include `#N` and title so Claude sees enough context.
- [ ] Smoke test covers at least one element from each upgraded section.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
