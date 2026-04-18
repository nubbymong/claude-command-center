# GitHub Sidebar — PR 3: Sections + Sync + Onboarding + Polish

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.

**Depends on:** PR 1 + PR 2 merged into `beta`.

**Goal:** Populate every panel section with real data, ship the sync orchestrator, add post-update onboarding modal, add training-walkthrough step, seed tips in the tips library, implement SSH repo detection, and polish error/rate-limit/expiry states. End state: feature is fully usable.

**Branch:** `feature/github-sidebar-pr3` off `beta`. **PR target:** `beta`.

---

## Cross-Platform Notes (Windows + macOS)

- **Keyboard shortcut labels:** tips, tooltips, onboarding copy must show `Ctrl+/` on Windows and `⌘+/` on macOS. Resolve via `window.electronPlatform === 'darwin'` at render time (or a shared helper built on that value) — matches the existing renderer convention. Do not use `navigator.platform` (deprecated and inconsistent with the rest of the codebase).
- **Training walkthrough screenshots:** ship both `github-panel.jpg` and `github-panel-mac.jpg` (Task N3 below).
- **`gh auth status` output on Windows:** same regex matches because we parse the github.com line, not the decorative characters. Verify on a Windows machine with gh installed via `winget install GitHub.cli`.
- **Keychain semantics differ:** on Windows, `safeStorage.isEncryptionAvailable()` can return false if DPAPI isn't initialized for the user context (rare but seen in RDP / some corporate images). Surface this as a Config page warning, not a crash.
- **Platform-specific Playwright E2E:** the existing harness runs on both. Confirm `github-oauth-ui.spec.ts` and `github-panel.spec.ts` pass on both Windows and macOS CI runners (release workflow already parallelizes them).
- **Chrome and external-link behavior:** `shell.openExternal(pr.url)` opens the default browser on both — behaves slightly differently but works. `navigator.clipboard.writeText` in the OAuth modal: macOS may prompt for permission on first use; test explicitly.
- **File path separators:** all renderer paths go through existing utilities or URLs — no special handling needed. Main-process disk writes use `path.join` from PR 1.
- **Build parity test:** before opening PR 3, run `npm run package:win` and SSH to the Mac build host and run `npm run package:mac`. Both should produce an installer without errors.

## Conventions

- All IPC + types from PR 1 in place. All Config UI + panel shell from PR 2 in place.
- `dangerouslySetInnerHTML` appears in exactly ONE file (`ReviewsSection.tsx`) with a sanitizer call. ESLint disable comment only on that line.
- **Independent code review gate** after each major phase (see Review Gate tasks below). Dispatch `superpowers:code-reviewer` subagent with the scope of the just-completed phase.
- Tips use the existing `TIPS_LIBRARY` + `tipsStore` infrastructure.
- Training walkthrough step added by appending to `src/renderer/training-steps.ts`.
- Commit prefixes same as prior PRs.

---

## File Map — PR 3 only

### Main — sync orchestrator + SSH detection
- CREATE `src/main/github/session/sync-orchestrator.ts`
- CREATE `src/main/github/session/ssh-repo-detector.ts`
- MODIFY `src/main/ipc/github-handlers.ts` (replace stubs with real implementations)
- MODIFY `src/main/index.ts` (wire orchestrator to session lifecycle)

### Renderer — sections (replace PR 2 stubs)
- MODIFY all 8 `src/renderer/components/github/sections/*.tsx`

### Renderer — onboarding + tips + tour
- CREATE `src/renderer/components/github/onboarding/OnboardingModal.tsx`
- MODIFY `src/renderer/tips-library.ts` (add 4–6 GitHub tips)
- MODIFY `src/renderer/training-steps.ts` (add GitHub step)
- MODIFY `src/renderer/App.tsx` (onboarding trigger)
- CREATE `src/renderer/components/github/RateLimitBanner.tsx`
- CREATE `src/renderer/components/github/ExpiryBanner.tsx`
- CREATE `src/renderer/components/github/AutoDetectBanner.tsx` (session header)

### Assets
- CREATE `docs/screenshots/github-panel.jpg` (captured via existing `capture-training` script)

### Tests
- `tests/unit/github/ssh-repo-detector.test.ts`
- `tests/unit/github/sync-orchestrator.test.ts`
- `tests/unit/github/onboarding-trigger.test.ts`
- `tests/e2e/github-panel.spec.ts`
- `tests/e2e/github-oauth-ui.spec.ts`

---

## Task 0: Branch setup

```bash
cd F:/CLAUDE_MULTI_APP
git fetch origin
git checkout -b feature/github-sidebar-pr3 origin/beta
```

---

## Phase Ma — Sync Orchestrator

### Task Ma1: SSH repo detection

**Files:** CREATE `src/main/github/session/ssh-repo-detector.ts`, test.

- [ ] **Step 1: Read existing PTY helpers**

```bash
grep -n "ssh\|executeCommand\|oneshot" src/main/pty-manager.ts | head -20
```
Identify the helper (if any) that sends a one-shot command to an SSH PTY and captures output between sentinels. If none exists, this task creates one.

- [ ] **Step 2: Test**

```ts
// tests/unit/github/ssh-repo-detector.test.ts
import { describe, it, expect, vi } from 'vitest'
import { detectRepoFromSshSession } from '../../../src/main/github/session/ssh-repo-detector'

describe('detectRepoFromSshSession', () => {
  it('parses URL from between sentinels', async () => {
    const send = vi.fn().mockResolvedValue([
      'some terminal noise',
      '__CC_GIT_START__',
      'https://github.com/a/b.git',
      '__CC_GIT_END__',
      'more noise',
    ].join('\n'))
    expect(await detectRepoFromSshSession('sid', '/home/x', send)).toBe('a/b')
  })
  it('returns null when sentinel missing', async () => {
    const send = vi.fn().mockResolvedValue('no sentinels here')
    expect(await detectRepoFromSshSession('sid', '/x', send)).toBeNull()
  })
  it('returns null on timeout', async () => {
    const send = vi.fn().mockRejectedValue(new Error('timeout'))
    expect(await detectRepoFromSshSession('sid', '/x', send)).toBeNull()
  })
})
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/session/ssh-repo-detector.ts
import { parseRepoUrl } from '../security/repo-url-parser'

const START = '__CC_GIT_START__'
const END = '__CC_GIT_END__'

/**
 * Sends a one-shot command to an SSH pty and extracts the remote URL from
 * between sentinels. `sendOneShot` is provided by the caller (pty-manager).
 */
export type SendOneShotSSH = (
  sessionId: string,
  cwd: string,
  command: string,
  timeoutMs?: number,
) => Promise<string>

/**
 * POSIX single-quote shell escape. Safer than `JSON.stringify(arg)` because
 * double-quoted shell strings still expand `$(...)`, backticks, and `$VAR`,
 * leaving an injection path if `cwd` contains `$(rm -rf ~)` etc.
 * Single-quote wrapping disables all expansion; escape embedded `'` as `'\''`.
 */
function posixShellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export async function detectRepoFromSshSession(
  sessionId: string,
  cwd: string,
  sendOneShot: SendOneShotSSH,
): Promise<string | null> {
  // START/END sentinels are module-local hardcoded strings — safe to inline unquoted.
  // `cwd` is attacker-influenceable (user-pasted path on remote host), so it MUST
  // go through posixShellEscape. Do not use JSON.stringify — double quotes still
  // permit $()/`` substitution on POSIX shells.
  const cmd = `echo ${START}; git -C ${posixShellEscape(cwd)} remote get-url origin 2>/dev/null; echo ${END}`
  let output: string
  try {
    output = await sendOneShot(sessionId, cwd, cmd, 5000)
  } catch {
    return null
  }
  const startIdx = output.indexOf(START)
  const endIdx = output.indexOf(END)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null
  const between = output.slice(startIdx + START.length, endIdx).trim()
  return parseRepoUrl(between)
}
```

> **Integration note:** If `src/main/pty-manager.ts` doesn't yet expose a one-shot SSH helper, add one as part of this task using its existing write + onData patterns. Match the codebase's style for such helpers.

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/ssh-repo-detector.test.ts
git add src/main/github/session/ssh-repo-detector.ts tests/unit/github/ssh-repo-detector.test.ts
git commit -m "feat(github): SSH repo detector (sentinel-based one-shot command)"
```

---

### Task Ma2: Sync orchestrator

**Files:** CREATE `src/main/github/session/sync-orchestrator.ts`, test.

- [ ] **Step 1: Test (focus on rate-limit + 304 handling)**

```ts
// tests/unit/github/sync-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncOrchestrator } from '../../../src/main/github/session/sync-orchestrator'
import { CacheStore } from '../../../src/main/github/cache/cache-store'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('SyncOrchestrator', () => {
  let tmp: string
  let cacheStore: CacheStore

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gho-'))
    cacheStore = new CacheStore(tmp)
  })

  it('emits synced state on success', async () => {
    const states: any[] = []
    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => 'gho_x',
      emitData: (p) => {},
      emitSyncState: (p) => states.push(p),
      fetchers: {
        pr: async () => ({ status: 'ok', data: { number: 1, title: 't', state: 'open', draft: false, user: { login: 'x' }, created_at: '2026-01-01', updated_at: '2026-01-01', mergeable: true, html_url: 'u' } }),
        runs: async () => ({ status: 'ok', data: [] }),
        reviews: async () => ({ status: 'ok', data: [] }),
      },
    })
    orch.registerSession({ sessionId: 's1', slug: 'a/b', branch: 'main', integration: { enabled: true, autoDetected: false } })
    await orch.syncNow('s1')
    expect(states.some((s) => s.state === 'synced')).toBe(true)
  })

  it('preserves cached PR on "unchanged" (304)', async () => {
    const cache = await cacheStore.load()
    cache.repos['a/b'] = {
      etags: {}, lastSynced: 100, accessedAt: 100,
      pr: { number: 99, title: 'cached', state: 'open', draft: false, author: 'x', createdAt: 0, updatedAt: 0, mergeableState: 'clean', url: 'u' },
    }
    await cacheStore.save(cache)
    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => 'gho_x',
      emitData: () => {},
      emitSyncState: () => {},
      fetchers: {
        pr: async () => ({ status: 'unchanged' }),
        runs: async () => ({ status: 'unchanged' }),
        reviews: async () => ({ status: 'unchanged' }),
      },
    })
    orch.registerSession({ sessionId: 's1', slug: 'a/b', branch: 'x', integration: { enabled: true, autoDetected: false } })
    await orch.syncNow('s1')
    const after = await cacheStore.load()
    expect(after.repos['a/b'].pr?.number).toBe(99)
  })

  it('emits rate-limited + backs off until reset', async () => {
    const states: any[] = []
    const resetAt = Date.now() + 3_000
    const orch = new SyncOrchestrator({
      cacheStore,
      getConfig: async () => null,
      getTokenForSession: async () => 'gho_x',
      emitData: () => {},
      emitSyncState: (p) => states.push(p),
      fetchers: {
        pr: async () => { const e: any = new Error('rate limited'); e.name = 'RateLimitError'; e.resetAt = resetAt; throw e },
        runs: async () => ({ status: 'ok', data: [] }),
        reviews: async () => ({ status: 'ok', data: [] }),
      },
    })
    orch.registerSession({ sessionId: 's1', slug: 'a/b', branch: 'x', integration: { enabled: true, autoDetected: false } })
    await orch.syncNow('s1')
    expect(states.some((s) => s.state === 'rate-limited' && s.nextResetAt === resetAt)).toBe(true)
  })

  it('pause/resume blocks scheduleNext', () => {
    const orch = new SyncOrchestrator({
      cacheStore, getConfig: async () => null,
      getTokenForSession: async () => null,
      emitData: () => {}, emitSyncState: () => {},
      fetchers: { pr: async () => ({ status: 'empty' }), runs: async () => ({ status: 'ok', data: [] }), reviews: async () => ({ status: 'ok', data: [] }) },
    })
    orch.registerSession({ sessionId: 's1', slug: 'a/b', branch: 'x', integration: { enabled: true, autoDetected: false } })
    orch.pause()
    expect(orch.isPaused()).toBe(true)
    orch.resume()
    expect(orch.isPaused()).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/sync-orchestrator.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/main/github/session/sync-orchestrator.ts
import type {
  GitHubConfig,
  PRSnapshot,
  RepoCache,
  SessionGitHubIntegration,
  WorkflowRunSnapshot,
} from '../../../shared/github-types'
import { CacheStore } from '../cache/cache-store'

type FetchResult<T> =
  | { status: 'unchanged' }
  | { status: 'empty' }
  | { status: 'ok'; data: T }

export interface OrchestratorFetchers {
  pr: (slug: string, branch: string) => Promise<FetchResult<any>>
  runs: (slug: string, branch: string) => Promise<FetchResult<any[]>>
  reviews: (slug: string, prNumber: number) => Promise<FetchResult<any[]>>
}

export interface SyncOrchestratorDeps {
  cacheStore: CacheStore
  getConfig: () => Promise<GitHubConfig | null>
  getTokenForSession: (sessionId: string) => Promise<string | null>
  emitData: (p: { slug: string; data: RepoCache }) => void
  emitSyncState: (p: { slug: string; state: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'; at: number; nextResetAt?: number }) => void
  fetchers: OrchestratorFetchers
}

interface SessionState {
  sessionId: string
  slug: string
  branch: string
  integration: SessionGitHubIntegration
  timer?: NodeJS.Timeout
  focused: boolean
  lastSync: number
}

export class SyncOrchestrator {
  private sessions = new Map<string, SessionState>()
  private paused = false

  constructor(private deps: SyncOrchestratorDeps) {}

  registerSession(input: Omit<SessionState, 'timer' | 'focused' | 'lastSync'>) {
    this.sessions.set(input.sessionId, { ...input, focused: false, lastSync: 0 })
    this.scheduleNext(input.sessionId)
  }

  unregisterSession(id: string) {
    const s = this.sessions.get(id)
    if (s?.timer) clearTimeout(s.timer)
    this.sessions.delete(id)
  }

  setFocus(id: string, focused: boolean) {
    const s = this.sessions.get(id)
    if (!s) return
    s.focused = focused
    this.scheduleNext(id)
  }

  pause() { this.paused = true }
  resume() { this.paused = false; this.sessions.forEach((_, id) => this.scheduleNext(id)) }
  isPaused() { return this.paused }

  async syncNow(sessionId: string) {
    await this.doSync(sessionId)
  }

  private async scheduleNext(id: string) {
    if (this.paused) return
    const s = this.sessions.get(id)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    const cfg = await this.deps.getConfig()
    const intervalSec = s.focused
      ? cfg?.syncIntervals.activeSessionSec ?? 60
      : cfg?.syncIntervals.backgroundSec ?? 300
    s.timer = setTimeout(() => {
      this.doSync(id).finally(() => this.scheduleNext(id))
    }, intervalSec * 1000)
  }

  private async doSync(sessionId: string) {
    const s = this.sessions.get(sessionId)
    if (!s) return

    this.deps.emitSyncState({ slug: s.slug, state: 'syncing', at: Date.now() })

    const cache = await this.deps.cacheStore.load()
    const existing: RepoCache = cache.repos[s.slug] ?? { etags: {}, lastSynced: 0, accessedAt: 0 }

    try {
      // PR
      const prR = await this.deps.fetchers.pr(s.slug, s.branch)
      if (prR.status === 'ok') {
        existing.pr = mapPR(prR.data)
      } else if (prR.status === 'empty') {
        existing.pr = null
      }
      // runs
      const runsR = await this.deps.fetchers.runs(s.slug, s.branch)
      if (runsR.status === 'ok') {
        existing.actions = mapRuns(runsR.data)
      }
      // reviews (only if PR known)
      if (existing.pr) {
        const revR = await this.deps.fetchers.reviews(s.slug, existing.pr.number)
        if (revR.status === 'ok') {
          existing.reviews = mapReviews(revR.data)
        }
      }

      existing.lastSynced = Date.now()
      existing.accessedAt = Date.now()
      cache.repos[s.slug] = existing
      if (!cache.lru.includes(s.slug)) cache.lru.push(s.slug)
      await this.deps.cacheStore.save(cache)

      this.deps.emitData({ slug: s.slug, data: existing })
      this.deps.emitSyncState({ slug: s.slug, state: 'synced', at: Date.now() })
      s.lastSync = Date.now()
    } catch (err: any) {
      if (err?.name === 'RateLimitError') {
        this.deps.emitSyncState({
          slug: s.slug,
          state: 'rate-limited',
          at: Date.now(),
          nextResetAt: err.resetAt,
        })
        // Skip further scheduleNext until reset
        if (s.timer) clearTimeout(s.timer)
        s.timer = setTimeout(
          () => this.doSync(sessionId).finally(() => this.scheduleNext(sessionId)),
          Math.max(err.resetAt - Date.now() + 1000, 1000),
        )
      } else {
        this.deps.emitSyncState({ slug: s.slug, state: 'error', at: Date.now() })
      }
    }
  }
}

function mapPR(raw: any): PRSnapshot {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    draft: !!raw.draft,
    author: raw.user?.login ?? 'unknown',
    authorAvatarUrl: raw.user?.avatar_url,
    createdAt: Date.parse(raw.created_at),
    updatedAt: Date.parse(raw.updated_at),
    mergeableState: raw.mergeable === null ? 'unknown' : raw.mergeable ? 'clean' : 'conflict',
    url: raw.html_url,
  }
}

function mapRuns(raw: any[]): WorkflowRunSnapshot[] {
  return raw.map((r) => ({
    id: r.id,
    workflowName: r.name ?? r.workflow_id,
    status: r.status,
    conclusion: r.conclusion ?? null,
    url: r.html_url,
  }))
}

function mapReviews(raw: any[]) {
  return raw.map((rv) => ({
    id: rv.id,
    reviewer: rv.user?.login ?? 'unknown',
    reviewerAvatarUrl: rv.user?.avatar_url,
    state: rv.state,
    threads: [],
  }))
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/sync-orchestrator.test.ts
git add src/main/github/session/sync-orchestrator.ts tests/unit/github/sync-orchestrator.test.ts
git commit -m "feat(github): sync orchestrator (304-aware, rate-limit-safe, tiered intervals)"
```

---

### Task Ma3: Wire handlers — replace stubs

**Files:** MODIFY `src/main/ipc/github-handlers.ts`, `src/main/index.ts`.

- [ ] **Step 1: Replace stubs in `github-handlers.ts`**

Replace each `ipcMain.handle(IPC.GITHUB_*, async () => ({ ok: true }))` stub with real implementations that delegate to the orchestrator + client + cache:

```ts
// Wire these in registerGitHubHandlers after constructing orchestrator:
const orchestrator = new SyncOrchestrator({ /* deps */ })

ipcMain.handle(IPC.GITHUB_SYNC_NOW, async (_e, sessionId: string) => {
  await orchestrator.syncNow(sessionId)
  return { ok: true }
})
ipcMain.handle(IPC.GITHUB_SYNC_PAUSE, async () => {
  orchestrator.pause()
  return { ok: true }
})
ipcMain.handle(IPC.GITHUB_SYNC_RESUME, async () => {
  orchestrator.resume()
  return { ok: true }
})
ipcMain.handle(IPC.GITHUB_DATA_GET, async (_e, slug: string) => {
  const c = await cacheStore.load()
  return { ok: true, data: c.repos[slug] ?? null }
})

// Session context
ipcMain.handle(IPC.GITHUB_SESSION_CONTEXT_GET, async (_e, sessionId: string) => {
  // Load session, extract branch, read transcript JSONL, inspect tool calls,
  // (opt-in) scan messages, call buildSessionContext.
  const sessions = await deps.loadSessions()
  const session = sessions.find((s) => s.id === sessionId)
  if (!session?.githubIntegration?.repoSlug) return { ok: true, data: null }
  const config = await configStore.read()
  const transcript = await loadTranscriptEvents(session) // implement helper; reads ~/.claude/projects/*/<sessionId>.jsonl
  const recentFiles = extractFileSignals(transcript.toolCalls)
  const transcriptRefs = config?.transcriptScanningOptIn
    ? scanTranscriptMessages(transcript.messages)
    : []
  const ctx = await buildSessionContext({
    branchName: transcript.currentBranch,
    transcriptRefs,
    prBodyRefs: [],
    recentFiles,
    sessionRepo: session.githubIntegration.repoSlug,
    enrichIssue: async (repo, n) => { /* use github-fetch to call /repos/{repo}/issues/{n} */ return null },
  })
  return { ok: true, data: ctx }
})

// Merge / rerun / reply / mark read — each builds a githubFetch call and returns ok/error.
```

(Full implementations of `loadTranscriptEvents`, the PR merge call, rerun call, etc., follow the same shape: resolve the session's auth profile → get token → `githubFetch` with correct body.)

- [ ] **Step 2: Wire orchestrator to session lifecycle in `main/index.ts`**

Find where session state changes fire (session added, focus changed, session removed). Add:
```ts
sessionEmitter.on('session:added', (s) => {
  if (s.githubIntegration?.enabled && s.githubIntegration.repoSlug) {
    orchestrator.registerSession({
      sessionId: s.id, slug: s.githubIntegration.repoSlug,
      branch: s.currentBranch ?? 'main', integration: s.githubIntegration,
    })
  }
})
sessionEmitter.on('session:focused', (s) => orchestrator.setFocus(s.id, true))
sessionEmitter.on('session:blurred', (s) => orchestrator.setFocus(s.id, false))
sessionEmitter.on('session:removed', (s) => orchestrator.unregisterSession(s.id))
```
(Adapt event names to match the actual pattern in the codebase — inspect `main/index.ts` for precedent.)

- [ ] **Step 3: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/main/ipc/github-handlers.ts src/main/index.ts
git commit -m "feat(github): wire sync orchestrator + real handler implementations"
```

---

### Review Gate 1: After Ma1–Ma3

- [ ] **Dispatch `superpowers:code-reviewer` subagent** with prompt:

> "Review PR 3 tasks Ma1–Ma3 (SSH repo detector, SyncOrchestrator, wired handlers) in the feature/github-sidebar-pr3 branch. Verify: 304 handling preserves cache; RateLimitError path backs off until reset; SSH detector handles timeout safely; handlers don't leak tokens. Report blockers + should-fixes."

Apply findings inline (additional tests or small implementation fixes) before proceeding to Phase L.

---

## Phase L — Panel Sections

### Task L2a: LocalGitSection (populated)

**Files:** MODIFY `src/renderer/components/github/sections/LocalGitSection.tsx`.

- [ ] **Step 1: Implement**

```tsx
// src/renderer/components/github/sections/LocalGitSection.tsx
import React, { useEffect, useState } from 'react'
import SectionFrame from '../SectionFrame'
import type { LocalGitState } from '../../../../shared/github-types'
import { relativeTime } from '../../../utils/relativeTime'

interface Props { sessionId: string; cwd?: string }

export default function LocalGitSection({ sessionId, cwd }: Props) {
  const [state, setState] = useState<LocalGitState | null>(null)

  useEffect(() => {
    if (!cwd) return
    let alive = true
    const poll = async () => {
      const r = await window.electronAPI.github.getLocalGit(cwd)
      if (alive && r.ok) setState(r.state)
    }
    poll()
    const t = setInterval(poll, 15_000)
    return () => { alive = false; clearInterval(t) }
  }, [cwd])

  if (!state) return <SectionFrame sessionId={sessionId} id="localGit" title="Local Git" emptyIndicator><div className="text-xs text-overlay0">Loading…</div></SectionFrame>

  const dirtyCount = state.staged.length + state.unstaged.length + state.untracked.length
  const summary = dirtyCount > 0 ? `${dirtyCount} changes` : 'clean'
  const empty = !state.branch

  return (
    <SectionFrame sessionId={sessionId} id="localGit" title="Local Git" summary={summary} emptyIndicator={empty}>
      {state.branch && (
        <div className="space-y-2 text-xs">
          <div className="text-subtext0">
            On <span className="text-text">{state.branch}</span>
            {state.ahead > 0 && <span className="text-green ml-2">↑{state.ahead}</span>}
            {state.behind > 0 && <span className="text-teal ml-1">↓{state.behind}</span>}
          </div>
          {state.staged.length > 0 && (
            <details>
              <summary className="cursor-pointer text-green">Staged ({state.staged.length})</summary>
              <ul className="ml-4 text-overlay1">{state.staged.map((f) => <li key={f}>{f}</li>)}</ul>
            </details>
          )}
          {state.unstaged.length > 0 && (
            <details>
              <summary className="cursor-pointer text-peach">Unstaged ({state.unstaged.length})</summary>
              <ul className="ml-4 text-overlay1">{state.unstaged.map((f) => <li key={f}>{f}</li>)}</ul>
            </details>
          )}
          {state.untracked.length > 0 && (
            <details>
              <summary className="cursor-pointer text-overlay1">Untracked ({state.untracked.length})</summary>
              <ul className="ml-4 text-overlay1">{state.untracked.map((f) => <li key={f}>{f}</li>)}</ul>
            </details>
          )}
          {state.recentCommits.length > 0 && (
            <div className="pt-2 border-t border-surface0">
              <div className="text-subtext0 mb-1">Recent commits</div>
              <ul className="space-y-0.5">
                {state.recentCommits.map((c) => (
                  <li key={c.sha} className="flex gap-2">
                    <code className="text-mauve">{c.sha}</code>
                    <span className="text-overlay1 truncate flex-1" title={c.subject}>{c.subject}</span>
                    <span className="text-overlay0 shrink-0">{relativeTime(c.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.stashCount > 0 && (
            <div className="text-overlay1 pt-1">Stash: {state.stashCount}</div>
          )}
        </div>
      )}
    </SectionFrame>
  )
}
```

- [ ] **Step 2: Wire `cwd` prop** in `GitHubPanel.tsx` — the panel already takes sessionId; add `cwd` and pass down.

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/renderer/components/github/sections/LocalGitSection.tsx src/renderer/components/github/GitHubPanel.tsx
git commit -m "feat(github): LocalGitSection with staged/unstaged/untracked/commits"
```

---

### Task L2b: SessionContextSection (populated)

```tsx
// src/renderer/components/github/sections/SessionContextSection.tsx
import React, { useEffect, useState } from 'react'
import SectionFrame from '../SectionFrame'
import type { SessionContextResult } from '../../../../shared/github-types'
import { relativeTime } from '../../../utils/relativeTime'

interface Props { sessionId: string }

export default function SessionContextSection({ sessionId }: Props) {
  const [ctx, setCtx] = useState<SessionContextResult | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      const r = await window.electronAPI.github.getSessionContext(sessionId)
      if (alive && r.ok) setCtx(r.data)
    }
    poll()
    const t = setInterval(poll, 20_000)
    return () => { alive = false; clearInterval(t) }
  }, [sessionId])

  const empty = !ctx || (!ctx.primaryIssue && !ctx.activePR && ctx.recentFiles.length === 0)
  const summary = ctx?.primaryIssue ? `#${ctx.primaryIssue.number}` : undefined

  return (
    <SectionFrame sessionId={sessionId} id="sessionContext" title="Session Context" summary={summary} emptyIndicator={empty}>
      {ctx?.primaryIssue ? (
        <div className="text-xs space-y-2">
          <div>
            <span className="text-subtext0">Working on: </span>
            <span className="text-blue">#{ctx.primaryIssue.number}</span>
            {ctx.primaryIssue.title && <span className="text-text ml-1">{ctx.primaryIssue.title}</span>}
            {ctx.primaryIssue.state && (
              <span className={`ml-2 text-[10px] px-1 rounded ${ctx.primaryIssue.state === 'open' ? 'bg-green/20 text-green' : 'bg-overlay0/20 text-overlay1'}`}>
                {ctx.primaryIssue.state}
              </span>
            )}
          </div>
          {ctx.otherSignals.length > 0 && (
            <details className="text-overlay1">
              <summary className="cursor-pointer">Other signals ({ctx.otherSignals.length})</summary>
              <ul className="ml-4">
                {ctx.otherSignals.map((s, i) => (
                  <li key={i}>#{s.number} <span className="text-overlay0">({s.source})</span></li>
                ))}
              </ul>
            </details>
          )}
          {ctx.activePR && (
            <div>
              <span className="text-subtext0">Related PR: </span>
              <span className="text-mauve">#{ctx.activePR.number}</span>
              <span className="text-overlay0 ml-1">{ctx.activePR.draft ? 'draft' : ctx.activePR.state}</span>
            </div>
          )}
          {ctx.recentFiles.length > 0 && (
            <div>
              <div className="text-subtext0">Claude recently edited:</div>
              <ul className="ml-3">
                {ctx.recentFiles.slice(0, 5).map((f) => (
                  <li key={f.filePath} className="flex gap-2">
                    <code className="text-peach truncate" title={f.filePath}>{f.filePath}</code>
                    <span className="text-overlay0 shrink-0">{relativeTime(f.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-overlay0">No session context yet</div>
      )}
    </SectionFrame>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/sections/SessionContextSection.tsx
git commit -m "feat(github): SessionContextSection — primary issue + recent files + active PR"
```

---

### Task L2c: ActivePRSection

```tsx
// src/renderer/components/github/sections/ActivePRSection.tsx
import React from 'react'
import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'
import { relativeTime } from '../../../utils/relativeTime'

interface Props { sessionId: string; slug?: string }

export default function ActivePRSection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const pr = data?.pr

  if (!slug) return <SectionFrame sessionId={sessionId} id="activePR" title="Active PR" emptyIndicator><div className="text-xs text-overlay0">No repo configured</div></SectionFrame>
  if (!pr) return <SectionFrame sessionId={sessionId} id="activePR" title="Active PR" emptyIndicator><div className="text-xs text-overlay0">No PR for this branch</div></SectionFrame>

  // App denies window.open; always use shell.openExternal for external navigation
  const open = () => void window.electronAPI.shell.openExternal(pr.url)
  const ready = async () => { await window.electronAPI.github.readyPR(slug, pr.number) }
  const merge = async (method: 'merge' | 'squash' | 'rebase') => {
    await window.electronAPI.github.mergePR(slug, pr.number, method)
  }

  return (
    <SectionFrame sessionId={sessionId} id="activePR" title="Active PR" summary={`#${pr.number}`}>
      <div className="text-xs space-y-1">
        <div className="text-text">{pr.title}</div>
        <div className="text-overlay1">
          @{pr.author} · {pr.draft ? 'draft' : pr.state} · {relativeTime(pr.updatedAt)}
        </div>
        <div className="text-subtext0">
          Mergeable: <span className={pr.mergeableState === 'clean' ? 'text-green' : pr.mergeableState === 'conflict' ? 'text-red' : 'text-overlay1'}>
            {pr.mergeableState}
          </span>
        </div>
        <div className="flex gap-1 pt-2 flex-wrap">
          <button onClick={open} className="bg-surface0 hover:bg-surface1 px-2 py-0.5 rounded text-xs">Open in GitHub</button>
          {pr.draft && <button onClick={ready} className="bg-surface0 hover:bg-surface1 px-2 py-0.5 rounded text-xs">Ready for review</button>}
          {pr.mergeableState === 'clean' && pr.allowedMergeMethods?.map((m) => (
            <button key={m} onClick={() => merge(m)} className="bg-blue/20 hover:bg-blue/40 text-blue px-2 py-0.5 rounded text-xs capitalize">{m}</button>
          ))}
        </div>
      </div>
    </SectionFrame>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/sections/ActivePRSection.tsx
git commit -m "feat(github): ActivePRSection with merge/ready actions"
```

---

### Task L2d: CISection

```tsx
// src/renderer/components/github/sections/CISection.tsx
import React, { useState } from 'react'
import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'
import type { WorkflowRunSnapshot } from '../../../../shared/github-types'

interface Props { sessionId: string; slug?: string }

function runIcon(r: WorkflowRunSnapshot): string {
  if (r.conclusion === 'success') return '✓'
  if (r.conclusion === 'failure') return '✗'
  if (r.status === 'in_progress' || r.status === 'queued') return '◌'
  return '—'
}
function runColor(r: WorkflowRunSnapshot): string {
  if (r.conclusion === 'success') return 'text-green'
  if (r.conclusion === 'failure') return 'text-red'
  if (r.status !== 'completed') return 'text-yellow'
  return 'text-overlay1'
}

export default function CISection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const runs = data?.actions ?? []
  const [rerunning, setRerunning] = useState<number | null>(null)
  const empty = runs.length === 0

  const rerun = async (id: number) => {
    if (!slug) return
    setRerunning(id)
    await window.electronAPI.github.rerunActionsRun(slug, id)
    setRerunning(null)
  }

  const failed = runs.filter((r) => r.conclusion === 'failure').length
  const summary = empty ? undefined : failed > 0 ? `${failed} failed` : 'all passing'

  return (
    <SectionFrame sessionId={sessionId} id="ci" title="CI / Actions" summary={summary} emptyIndicator={empty}>
      <div className="space-y-1 text-xs">
        {runs.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            <span className={runColor(r)} aria-label={r.conclusion ?? r.status}>{runIcon(r)}</span>
            <span className="text-text truncate flex-1" title={r.workflowName}>{r.workflowName}</span>
            <button onClick={() => void window.electronAPI.shell.openExternal(r.url)} className="text-overlay1 hover:text-text" aria-label="Open run in GitHub">↗</button>
            {r.conclusion === 'failure' && slug && (
              <button
                onClick={() => rerun(r.id)}
                disabled={rerunning === r.id}
                className="bg-surface0 hover:bg-surface1 px-1.5 py-0.5 rounded text-xs"
              >{rerunning === r.id ? '…' : 'Re-run'}</button>
            )}
          </div>
        ))}
      </div>
    </SectionFrame>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/sections/CISection.tsx
git commit -m "feat(github): CISection with workflow runs + re-run action"
```

---

### Task L2e: ReviewsSection (sanitized markdown — the ONE dangerouslySetInnerHTML)

```tsx
// src/renderer/components/github/sections/ReviewsSection.tsx
import React, { useState } from 'react'
import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'
import { renderCommentMarkdown } from '../../../utils/markdownSanitizer'

interface Props { sessionId: string; slug?: string }

export default function ReviewsSection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const reviews = data?.reviews ?? []
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')

  const allThreads = reviews.flatMap((r) => r.threads)
  const unresolved = allThreads.filter((t) => !t.resolved)
  const empty = allThreads.length === 0

  const send = async (threadId: string) => {
    if (!slug) return
    await window.electronAPI.github.replyToReview(slug, threadId, replyText)
    setReplyingTo(null)
    setReplyText('')
  }

  return (
    <SectionFrame
      sessionId={sessionId}
      id="reviews"
      title="Reviews & Comments"
      summary={empty ? undefined : `${unresolved.length} open`}
      emptyIndicator={empty}
    >
      <div className="space-y-3 text-xs">
        {reviews.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-overlay1">
            {r.reviewerAvatarUrl && <img src={r.reviewerAvatarUrl} alt={r.reviewer} className="w-5 h-5 rounded-full" />}
            <span>@{r.reviewer}</span>
            <span className={r.state === 'APPROVED' ? 'text-green' : r.state === 'CHANGES_REQUESTED' ? 'text-red' : 'text-overlay1'}>
              {r.state.toLowerCase().replace('_', ' ')}
            </span>
          </div>
        ))}
        {unresolved.map((t) => (
          <div key={t.id} className="border-l-2 border-surface0 pl-2 space-y-1">
            <div className="text-overlay0">
              @{t.commenter} on <code className="text-peach">{t.file}:{t.line}</code>
            </div>
            <div
              className="prose prose-invert prose-sm max-w-none text-text"
              // eslint-disable-next-line react/no-danger -- sanitized via renderCommentMarkdown
              dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(t.bodyMarkdown) }}
            />
            {replyingTo === t.id ? (
              <div className="flex gap-1">
                <input
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="flex-1 bg-surface0 p-1 rounded text-xs"
                  placeholder="Reply…"
                />
                <button onClick={() => send(t.id)} className="bg-blue text-base px-2 py-0.5 rounded text-xs">Send</button>
                <button onClick={() => setReplyingTo(null)} className="text-overlay1">×</button>
              </div>
            ) : (
              <button onClick={() => setReplyingTo(t.id)} className="text-blue text-xs">Reply</button>
            )}
          </div>
        ))}
      </div>
    </SectionFrame>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/sections/ReviewsSection.tsx
git commit -m "feat(github): ReviewsSection with sanitized markdown + reply"
```

---

### Task L2f: IssuesSection

```tsx
// src/renderer/components/github/sections/IssuesSection.tsx
import React from 'react'
import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'

interface Props { sessionId: string; slug?: string }

export default function IssuesSection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const issues = data?.issues ?? []
  const empty = issues.length === 0

  return (
    <SectionFrame sessionId={sessionId} id="issues" title="Issues" summary={empty ? undefined : `${issues.length}`} emptyIndicator={empty}>
      <ul className="space-y-1 text-xs">
        {issues.map((i) => (
          <li key={i.number} className="flex items-start gap-2">
            <button onClick={() => void window.electronAPI.shell.openExternal(i.url)} className="text-blue hover:underline">#{i.number}</button>
            {i.primary && <span className="bg-mauve/20 text-mauve text-[10px] px-1 rounded">primary</span>}
            <span className={i.state === 'open' ? 'text-green' : 'text-overlay0'}>{i.state}</span>
            <span className="text-text truncate flex-1" title={i.title}>{i.title}</span>
            {i.assignee && <span className="text-overlay1">@{i.assignee}</span>}
          </li>
        ))}
      </ul>
    </SectionFrame>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/sections/IssuesSection.tsx
git commit -m "feat(github): IssuesSection with primary badge"
```

---

### Task L2g: NotificationsSection

```tsx
// src/renderer/components/github/sections/NotificationsSection.tsx
import React, { useEffect, useState } from 'react'
import SectionFrame from '../SectionFrame'
import type { NotificationSummary } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'

interface Props { sessionId: string }

export default function NotificationsSection({ sessionId }: Props) {
  const profiles = useGitHubStore((s) => s.profiles)
  const notifCapable = profiles.filter((p) => p.capabilities.includes('notifications'))
  const [selectedId, setSelectedId] = useState(notifCapable[0]?.id ?? '')
  const [items, setItems] = useState<NotificationSummary[]>([])

  useEffect(() => {
    if (!selectedId) return
    // Main notifications fetch happens on a timer in main; for simplicity
    // the renderer just asks for current cache per profile via a data get.
    // (Can be added as a dedicated IPC in a follow-up.)
  }, [selectedId])

  if (notifCapable.length === 0) {
    return (
      <SectionFrame sessionId={sessionId} id="notifications" title="Notifications" emptyIndicator>
        <div className="text-xs text-overlay0">
          Add auth with notifications scope to enable this.
        </div>
      </SectionFrame>
    )
  }

  const unread = items.filter((i) => i.unread).length
  return (
    <SectionFrame
      sessionId={sessionId}
      id="notifications"
      title="Notifications"
      summary={unread > 0 ? `${unread} unread` : undefined}
      emptyIndicator={items.length === 0}
    >
      {notifCapable.length > 1 && (
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="bg-surface0 p-1 rounded text-xs mb-2"
        >
          {notifCapable.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.username})</option>)}
        </select>
      )}
      <ul className="space-y-1 text-xs">
        {items.map((i) => (
          <li key={i.id} className="flex gap-2">
            {i.unread && <span className="text-peach w-2">●</span>}
            <button onClick={() => void window.electronAPI.shell.openExternal(i.url)} className="text-blue hover:underline">{i.repo}</button>
            <span className="text-text truncate flex-1" title={i.title}>{i.title}</span>
            {i.unread && (
              <button
                onClick={() => window.electronAPI.github.markNotifRead(selectedId, i.id)}
                className="text-overlay1 text-[10px]"
              >mark read</button>
            )}
          </li>
        ))}
      </ul>
    </SectionFrame>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/sections/NotificationsSection.tsx
git commit -m "feat(github): NotificationsSection (per-profile selector)"
```

---

### Review Gate 2: After L2a–L2g

- [ ] **Dispatch `superpowers:code-reviewer`** with prompt:

> "Review PR 3 panel section implementations (L2a–L2g). Verify: ReviewsSection is the ONLY `dangerouslySetInnerHTML` in the feature's React tree and uses `renderCommentMarkdown`; all external links use `rel='noreferrer'`; polling timers clean up on unmount; error/empty states render safely without crashing."

Apply findings before Phase N.

---

## Phase N — Onboarding + Tips + Tour

### Task N1: OnboardingModal

**Files:** CREATE `src/renderer/components/github/onboarding/OnboardingModal.tsx`.

```tsx
// src/renderer/components/github/onboarding/OnboardingModal.tsx
import React from 'react'

interface Props { onClose: () => void; onSetup: () => void }

export default function OnboardingModal({ onClose, onSetup }: Props) {
  return (
    <div className="fixed inset-0 bg-base/80 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-label="GitHub integration onboarding">
      <div className="bg-mantle p-6 rounded max-w-lg text-text">
        <h3 className="text-lg mb-3">New: GitHub sidebar</h3>
        <div className="bg-surface0 rounded overflow-hidden mb-3">
          {/*
            Image lives at src/renderer/assets/training/github-panel.jpg (see N3).
            Loaded via Vite glob in TrainingWalkthrough — here we use a plain
            new URL(...) since we're in a React component. Vite resolves the
            relative path at build time and bundles the image for packaged builds.
          */}
          <img
            src={new URL('../../../assets/training/github-panel.jpg', import.meta.url).toString()}
            alt="GitHub panel preview"
            className="w-full"
          />
        </div>
        <p className="text-sm text-subtext0 mb-3">
          See PR, CI, reviews, issues, and session context for whatever you're working on — next to the terminal.
        </p>
        <ol className="text-sm text-subtext0 space-y-2 mb-4 list-decimal list-inside">
          <li>We auto-detect your repos per session — accept or edit.</li>
          <li>Sign in with GitHub (or use <code>gh</code> CLI if you have it).</li>
          <li>Enable per session at your own pace — nothing runs until you opt in.</li>
        </ol>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-subtext0 px-3 py-1">Later</button>
          <button onClick={onSetup} className="bg-blue text-base px-3 py-1 rounded">Set up now</button>
        </div>
      </div>
    </div>
  )
}
```

### Task N2: Wire post-update trigger in App.tsx

**Files:** MODIFY `src/renderer/App.tsx`.

```tsx
// Inside App body
const [showOnboard, setShowOnboard] = useState(false)
const githubConfig = useGitHubStore((s) => s.config)

useEffect(() => {
  if (!githubConfig) return
  const currentVersion = __APP_VERSION__ /* inject in vite config or import */
  if (githubConfig.seenOnboardingVersion !== currentVersion) {
    setShowOnboard(true)
  }
}, [githubConfig])

const dismissOnboard = async () => {
  await useGitHubStore.getState().updateConfig({
    seenOnboardingVersion: __APP_VERSION__,
  })
  setShowOnboard(false)
}

// In JSX:
{showOnboard && (
  <OnboardingModal
    onClose={dismissOnboard}
    onSetup={() => { dismissOnboard(); /* navigate to Settings→GitHub */ }}
  />
)}
```

Commit both:
```bash
npm run typecheck
npm run build
git add src/renderer/components/github/onboarding/OnboardingModal.tsx src/renderer/App.tsx
git commit -m "feat(github): onboarding modal with post-update trigger"
```

---

### Task N3: Screenshots for onboarding + tour (BOTH platforms)

**Files:** CREATE `src/renderer/assets/training/github-panel.jpg` AND `src/renderer/assets/training/github-panel-mac.jpg`. Also optional copies under `docs/screenshots/` for markdown/README use.

The existing `getScreenshot()` helper in `TrainingWalkthrough.tsx` (via `import.meta.glob('../assets/training/*.jpg')`) prefers `<name>-mac.jpg` on macOS and falls back to `<name>.jpg`. Ship both so the tour looks right on either OS. The onboarding modal (Task N1) loads the same asset via `new URL('../../../assets/training/github-panel.jpg', import.meta.url)` so it gets bundled in packaged builds.

- [ ] **Step 1: Capture Windows screenshot**

```bash
# On your Windows dev machine
npm run dev
# In the running app: switch to APP_DEV, sign in, enable a session on nubbymong/claude-command-center
# Wait for panel to populate (PR card, CI, Session Context)
# Capture the right panel region at ~600×800px, save as:
# src/renderer/assets/training/github-panel.jpg
```

- [ ] **Step 2: Capture macOS screenshot**

On your macOS build host (whichever Mac you use for the Mac installer build — see `.github/workflows/release.yml` for the job config):
```bash
# SSH to your Mac build host (exact address lives in your local notes/1Password; keep it out of the public repo)
# Pull the branch, install, run dev
git pull  # get feature/github-sidebar-pr3
npm install
npm run dev
# Same repro: APP_DEV session, sign in, enable panel. Capture at 2x retina.
# Save as src/renderer/assets/training/github-panel-mac.jpg and scp / commit / push.
```

If direct ssh capture is impractical, capture manually on any macOS machine and drop the file into the branch before pushing.

- [ ] **Step 3: Commit both**

```bash
git add src/renderer/assets/training/github-panel.jpg src/renderer/assets/training/github-panel-mac.jpg
git commit -m "docs(github): add panel screenshots (Windows + macOS)"
```

Optionally also copy to `docs/screenshots/` for use in README/docs:

```bash
cp src/renderer/assets/training/github-panel*.jpg docs/screenshots/
git add docs/screenshots/github-panel*.jpg
git commit -m "docs(github): mirror panel screenshots in docs/screenshots for README use"
```

- [ ] **Step 4: Update existing screenshots if panel overlaps other captures**

The panel sits on the right; existing screenshots (`tokenomics.jpg`, `agent-hub.jpg`, `memory.jpg`, etc.) were captured before the panel existed. If the panel would now be visible in those captures (when integration is enabled by default, or during demos), re-run the capture:

```bash
npm run capture-training   # existing script; hides real data, seeds demos
```

Then diff the `docs/screenshots/` directory — any screenshot whose frame now includes the panel on the right must be recaptured with the panel hidden (toggle off before capture) so existing training steps don't shift visually.

Commit if anything re-captured:
```bash
git add docs/screenshots/
git commit -m "docs: refresh screenshots that would now show the new panel"
```

---

### Task N4: Add tour step

**Files:** MODIFY `src/renderer/training-steps.ts`.

- [ ] **Step 1: Read current structure**

```bash
head -60 src/renderer/training-steps.ts
```
Note the shape of a step (title, bullets, screenshotFilename, minVersion).

- [ ] **Step 2: Append a new step**

```ts
// Append to the steps array
{
  id: 'github-sidebar',
  minVersion: '1.4.0',  // adjust to the release version this ships in
  title: 'GitHub sidebar',
  screenshotFilename: 'github-panel.jpg',
  bullets: [
    'Collapsible right panel — toggle with Ctrl+/ (Cmd+/ on Mac).',
    'Shows the PR for your current branch, CI runs, reviews, linked issues, and local git state.',
    'Session Context explains what this session is actually working on — issue from branch/conversation, files Claude just edited.',
    'Sign in with GitHub to unlock PR/CI/review data. Per-session enable: nothing runs until you opt in.',
    'Find it in Settings → GitHub.',
  ],
},
```

- [ ] **Step 3: Commit**

```bash
npm run typecheck
git add src/renderer/training-steps.ts
git commit -m "feat(github): add training-walkthrough step"
```

---

### Task N5: Seed tips

**Files:** MODIFY `src/renderer/tips-library.ts`.

- [ ] **Step 1: Read library structure**

```bash
head -60 src/renderer/tips-library.ts
```
Note the `Tip` shape (id, featureId, trigger condition, content).

- [ ] **Step 2: Append tips**

```ts
// Append to TIPS_LIBRARY
{
  id: 'github-first-visit-settings',
  featureId: 'github.settings',
  triggerAfterUsageCount: 0,
  triggerAfterFeature: 'settings.github',
  content: {
    title: 'Sign in with GitHub',
    body: 'Click "Sign in with GitHub" to unlock PR, CI, and review data. Or paste a fine-grained PAT if your org policy prefers it.',
    actionLabel: 'Open GitHub tab',
    actionFeatureId: 'settings.github',
  },
},
{
  id: 'github-panel-toggle-shortcut',
  featureId: 'github.panel.firstOpen',
  triggerAfterUsageCount: 1,
  content: {
    title: 'Toggle the GitHub panel',
    body: 'Press Ctrl+/ (⌘+/ on Mac) to show or hide the GitHub panel from anywhere in the app.',
  },
},
{
  id: 'github-session-enable',
  featureId: 'github.session.notEnabled',
  triggerAfterUsageCount: 3,
  content: {
    title: 'Enable GitHub for this session',
    body: 'Your session has a GitHub repo detected but integration is off. Open the session config to turn it on.',
    actionLabel: 'Open session config',
    actionFeatureId: 'session.config.github',
  },
},
{
  id: 'github-rate-limited',
  featureId: 'github.panel.rateLimited',
  triggerAfterUsageCount: 0,
  content: {
    title: 'GitHub rate-limited',
    body: 'We paused syncs to preserve your API budget. The panel resumes automatically at reset. You can lengthen sync intervals in Settings → GitHub.',
    actionLabel: 'Open sync settings',
    actionFeatureId: 'settings.github.sync',
  },
},
{
  id: 'github-token-expiring',
  featureId: 'github.token.expiringSoon',
  triggerAfterUsageCount: 0,
  content: {
    title: 'GitHub token expiring soon',
    body: 'Your PAT expires in under 7 days. Regenerate it and paste the new token to keep the panel working.',
    actionLabel: 'Renew token',
    actionFeatureId: 'settings.github.profile',
  },
},
```

- [ ] **Step 3: Record the feature IDs where users trip them**

Add `recordUsage` calls:
- In `GitHubConfigTab.tsx` on mount: `useTipsStore.getState().recordUsage('settings.github')`
- In `GitHubPanel.tsx` on first render with slug: `recordUsage('github.panel.firstOpen')`
- When panel shows rate-limited state: `recordUsage('github.panel.rateLimited')`
- On session config drawer open with detected repo but disabled: `recordUsage('github.session.notEnabled')`
- On expiry threshold crossing: `recordUsage('github.token.expiringSoon')`

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add src/renderer/tips-library.ts src/renderer/components/github/
git commit -m "feat(github): seed 5 tips in TIPS_LIBRARY + record usage in components"
```

---

### Task N6: Banners — auto-detect, rate limit, expiry

**Files:** CREATE `AutoDetectBanner.tsx`, `RateLimitBanner.tsx`, `ExpiryBanner.tsx`.

```tsx
// src/renderer/components/github/AutoDetectBanner.tsx
import React, { useEffect, useState } from 'react'

interface Props { sessionId: string; cwd: string; onAccept: (slug: string) => void; onEdit: () => void; onDismiss: () => void }

export default function AutoDetectBanner({ sessionId, cwd, onAccept, onEdit, onDismiss }: Props) {
  const [slug, setSlug] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.github.repoDetect(cwd).then((r) => { if (r.ok) setSlug(r.slug) })
  }, [cwd])

  if (!slug) return null
  return (
    <div className="bg-mantle border-b border-surface0 px-3 py-1.5 flex items-center gap-2 text-xs">
      <span className="text-subtext0">Detected</span>
      <code className="text-blue">{slug}</code>
      <button onClick={() => onAccept(slug)} className="bg-surface0 hover:bg-surface1 px-2 py-0.5 rounded">Use this</button>
      <button onClick={onEdit} className="text-overlay1">Edit</button>
      <button onClick={onDismiss} className="text-overlay1 ml-auto">×</button>
    </div>
  )
}
```

```tsx
// src/renderer/components/github/RateLimitBanner.tsx
import React from 'react'

interface Props { resetAt: number }

export default function RateLimitBanner({ resetAt }: Props) {
  return (
    <div className="bg-yellow/10 text-yellow px-3 py-2 text-xs border-b border-yellow/30">
      GitHub rate-limited. Resumes at {new Date(resetAt).toLocaleTimeString()}.
    </div>
  )
}
```

```tsx
// src/renderer/components/github/ExpiryBanner.tsx
import React from 'react'
import type { AuthProfile } from '../../../shared/github-types'

interface Props { profile: AuthProfile; onRenew: () => void }

// Static className map — Tailwind's class scanner cannot resolve dynamic
// `bg-${tone}/10` strings, so we ship the complete class strings here.
const TONE_CLASSES = {
  red:    'bg-red/10    text-red    border-red/30',
  peach:  'bg-peach/10  text-peach  border-peach/30',
  yellow: 'bg-yellow/10 text-yellow border-yellow/30',
} as const

export default function ExpiryBanner({ profile, onRenew }: Props) {
  if (!profile.expiryObservable || !profile.expiresAt) return null
  const daysLeft = (profile.expiresAt - Date.now()) / 86_400_000
  if (daysLeft > 7) return null
  const tone: keyof typeof TONE_CLASSES = daysLeft < 2 ? 'red' : daysLeft < 7 ? 'peach' : 'yellow'
  return (
    <div className={`${TONE_CLASSES[tone]} px-3 py-2 text-xs border-b flex items-center gap-2`}>
      <span>{profile.label}: PAT expires in {Math.max(Math.ceil(daysLeft), 0)} days.</span>
      <button onClick={onRenew} className="bg-surface0 px-2 py-0.5 rounded">Renew</button>
    </div>
  )
}
```

Integrate:
- `AutoDetectBanner` in session header (only when session has no `githubIntegration.repoUrl` and not dismissed).
- `RateLimitBanner` atop `GitHubPanel` when `syncStatus[slug].state === 'rate-limited'`.
- `ExpiryBanner` per profile in Config page `AuthProfilesList`.

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/AutoDetectBanner.tsx src/renderer/components/github/RateLimitBanner.tsx src/renderer/components/github/ExpiryBanner.tsx
git commit -m "feat(github): auto-detect, rate-limit, and expiry banners"
```

---

### Review Gate 3: After Phase N

- [ ] **Dispatch `superpowers:code-reviewer`** with prompt:

> "Review PR 3 onboarding + tips + banners + tour. Verify: onboarding trigger resets correctly across fresh install and version bump; tips don't over-trigger; banners have proper `role`/`aria-live`; screenshot committed and referenced with valid path."

---

## Phase O — Accessibility + E2E

### Task O1: Accessibility pass

- [ ] **Step 1: Audit**

Run through the full panel with keyboard only. Checklist:
- Every button reachable by Tab
- `aria-expanded` correct on all `SectionFrame`s
- `aria-label` on icon-only buttons (Refresh, close)
- Color + icon pairing in CI runs (✓/✗ plus text)
- `aria-live="polite"` on panel content scroll region
- Contrast: check each color against Catppuccin base for WCAG AA

- [ ] **Step 2: Commit any fixes**

```bash
git add -u
git commit -m "refactor(github): accessibility pass — aria, focus, alt text"
```

### Task O2: E2E test for OAuth UI

**Files:** CREATE `tests/e2e/github-oauth-ui.spec.ts`.

```ts
import { test, expect, _electron as electron } from '@playwright/test'

test('OAuth sign-in modal shows device code', async () => {
  // Use the existing Playwright launch pattern from other e2e specs
  // Mock IPC main-side to return a deterministic device code response
  // Assert modal renders user code, copy button, Open GitHub button
  // (adapt the existing test harness's IPC mocking approach)
})
```

Full implementation follows the patterns in `tests/e2e/*.spec.ts` already in the repo — mirror one of those specs (e.g., `tokenomics.spec.ts` if present) for Electron launch + mock setup. Skip detailed expansion here; the engineer lifts from an existing spec.

Commit:
```bash
git add tests/e2e/github-oauth-ui.spec.ts
git commit -m "test(github): E2E for OAuth device code modal"
```

### Task O3: E2E test for panel states

**Files:** CREATE `tests/e2e/github-panel.spec.ts`.

Covers: empty state (no repo), auth-not-configured state ("Sign in to unlock"), rate-limited banner, collapsed sections.

Commit per existing test conventions.

---

## Phase P — Final + PR

### Task P1: Full verification

```bash
npm run typecheck
npx vitest run
npm run test:e2e
npm run build
```
All green.

Manual:
- Switch to APP_DEV config, ensure signed into GitHub
- Enable integration for `nubbymong/claude-command-center` session
- Verify panel populates (PR card, CI, reviews if PR has any, issues, local git, session context)
- Re-run a failed workflow (if available)
- Simulate rate limit via dev console (drop `core.remaining` to 0) → banner appears
- Trigger expiry warning on a mock PAT

### Task P2: Final independent review

- [ ] **Dispatch `superpowers:code-reviewer`** with full-PR scope:

> "Final review of PR 3 before opening. Cross-check against spec §1–§12. Verify: Session Context differentiator works end-to-end; sanitization only happens in ReviewsSection; no token appears in any logs during an exercise run; cache survives a forced-corrupt restart; onboarding shows on version bump; all three Review Gates' findings landed. Produce a blocker/should-fix punchlist."

Apply findings before opening the PR.

### Task P3: Push + PR

```bash
git fetch origin
git rebase origin/beta
git push -u origin feature/github-sidebar-pr3

gh pr create --base beta --title "feat(github): sections + sync + onboarding (PR 3/3)" --body "$(cat <<'EOF'
## Summary

- Sync orchestrator (304-aware, rate-limit-safe, tiered intervals, focus-aware)
- SSH repo detection via PTY one-shot with sentinels
- 8 panel sections fully populated: Session Context (differentiator), Active PR, CI / Actions, Reviews (sanitized markdown), Issues, Local Git, Notifications, Agent Intent (reserved)
- Post-update onboarding modal with screenshot
- Training walkthrough step added
- 5 tips seeded in TIPS_LIBRARY with usage-recording call sites
- Auto-detect, rate-limit, and expiry banners
- Accessibility pass
- E2E tests for OAuth UI and panel states
- Three independent code-review gates landed

## Depends on

PR 1 + PR 2 merged

## Spec

`docs/superpowers/specs/2026-04-17-github-sidebar-design.md` (rev 4)

## Test plan

- [x] Unit + E2E tests pass
- [x] Three independent review gates passed
- [ ] Manual: populated panel against APP_DEV config on `nubbymong/claude-command-center`
- [ ] Manual: re-run a failing workflow action
- [ ] Manual: rate-limit simulation → yellow banner
- [ ] Manual: expiring token simulation → expiry banner at each threshold
- [ ] Manual: first-launch onboarding modal with screenshot
- [ ] Manual: training walkthrough shows the GitHub step on upgrade
- [ ] Manual: tip appears on first Config page visit

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Review Gates Summary

| Gate | After | Scope |
|---|---|---|
| Gate 1 | Ma1–Ma3 | Sync orchestrator + SSH detector + wired handlers |
| Gate 2 | L2a–L2g | All 8 section components |
| Gate 3 | Phase N | Onboarding + tips + tour + banners |
| Gate 4 (Final) | Before PR | End-to-end spec coverage + security sweep |

Each gate uses `superpowers:code-reviewer`. **Do not proceed past a gate without landing its findings.** Gates exist because sections like ReviewsSection (dangerouslySetInnerHTML) and sync orchestrator (rate-limit backoff) carry real risk; independent fresh-eyes is the only reliable check.

## Execution Handoff

**REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`. The plan has ~30 tasks, 4 review gates, and integration with existing session lifecycle / PTY / tips / tour machinery. Inline execution will lose coherence.
