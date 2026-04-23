# Sidebar Flexibility — Phase 1a: Data Model + Master Visibility Menu

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the `GitHubSectionId` type and the per-session visibility / section-prefs data model, plus the sidebar-level `⋯` master menu that drives hide/show. One user-visible behaviour change: the master visibility checklist works.

**Architecture:** Extend `src/shared/github-types.ts` with `GitHubSectionId` + `SectionPref` + the new `SessionGitHubIntegration` fields. Migrate the existing `collapsedSections: Record<string, boolean>` to `collapsedSections: GitHubSectionId[]` via a one-shot session-state migration at load time. Add `defaultVisibleSections` + `snoozedNotifications` + `lastSeenThreads` on `GitHubConfig`. Build `<SidebarHeaderMenu>` using `@floating-ui/react` with a single floating-tree so popover focus ownership is coherent. Wire it to `githubStore` + `sessionStore`. No section content changes in this phase.

**Tech Stack:** TypeScript strict, Zustand 5, React 18, Tailwind v4 (Catppuccin Mocha), `@floating-ui/react` (already in the repo — verify in package.json), `electron-vite` for HMR.

---

## File structure

- Modify: `src/shared/github-types.ts` — add `GitHubSectionId`, `SectionPref`, extend `SessionGitHubIntegration`, `GitHubConfig`.
- Modify: `src/main/github/github-config-store.ts` — surface new `defaultVisibleSections` etc. via existing read/write helpers.
- Modify: `src/main/session-state.ts` — migration hook on load.
- Modify: `src/main/ipc/github-handlers.ts` — new handlers for the master menu.
- Modify: `src/shared/ipc-channels.ts` — add channels.
- Modify: `src/preload/index.ts` — bridge the new channels.
- Modify: `src/renderer/types/electron.d.ts` — type the bridge.
- Modify: `src/renderer/stores/githubStore.ts` — extend state + selectors.
- Modify: `src/renderer/stores/sessionStore.ts` — expose per-session visibility selectors.
- Create: `src/renderer/components/github/menu/SidebarHeaderMenu.tsx` — master popover.
- Create: `src/renderer/components/github/menu/section-menu-utils.ts` — shared "disabled row" logic referencing `featureToggles` + `profiles[*].capabilities`.
- Modify: `src/renderer/components/github/PanelHeader.tsx` — add the `⋯` button that opens the menu.
- Modify: `src/renderer/components/github/GitHubPanel.tsx` — honour `hiddenSections` when rendering section list.
- Create: `tests/unit/shared/github-types-migration.test.ts` — exercise collapsedSections object→array migration.
- Create: `tests/unit/renderer/components/github/SidebarHeaderMenu.test.tsx` — render, toggle, disabled rows, save-as-default.
- Create: `tests/unit/main/github-config-defaults.test.ts` — defaultVisibleSections read/write; snooze map LRU cap.
- Create: `tests/unit/main/session-state-migration.test.ts` — migrate collapsedSections shape on load.

All new files ≤250 LOC. Existing files grow by ≤80 LOC each.

---

### Task 1: Introduce `GitHubSectionId` and `SectionPref` types

**Files:**
- Modify: `src/shared/github-types.ts:15`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/github-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { GitHubSectionId, SectionPref } from '../../../src/shared/github-types'

describe('github-types section identifiers', () => {
  it('includes all seven current sections plus liveActivity', () => {
    const ids: GitHubSectionId[] = [
      'sessionContext',
      'activePR',
      'ci',
      'reviews',
      'linkedIssues',
      'localGit',
      'notifications',
      'liveActivity',
    ]
    expect(ids.length).toBe(8)
  })

  it('accepts a partial SectionPref shape', () => {
    const p: SectionPref = { compact: true, filter: 'failing', refreshSec: 30 }
    expect(p.compact).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/github-types.test.ts`
Expected: FAIL with "Cannot find type GitHubSectionId".

- [ ] **Step 3: Add the types**

Append to `src/shared/github-types.ts` after the existing `GitHubFeatureKey` declaration:

```ts
/** Sidebar section identifiers. Superset of GitHubFeatureKey that also
 * includes liveActivity for the Hooks Gateway footer. */
export type GitHubSectionId =
  | 'sessionContext'
  | 'activePR'
  | 'ci'
  | 'reviews'
  | 'linkedIssues'
  | 'localGit'
  | 'notifications'
  | 'liveActivity'

/** Per-section user preferences, merged onto built-in defaults at render time. */
export interface SectionPref {
  compact?: boolean
  filter?: string
  refreshSec?: number
  autoExpandOnFailure?: boolean
  sortBy?: string
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/shared/github-types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/github-types.ts tests/unit/shared/github-types.test.ts
git commit -m "feat(sidebar): add GitHubSectionId and SectionPref types"
```

---

### Task 2: Extend `SessionGitHubIntegration` with hidden/collapsed/prefs

**Files:**
- Modify: `src/shared/github-types.ts:71-80` (the existing interface)

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/shared/github-types.test.ts`:

```ts
import type { SessionGitHubIntegration } from '../../../src/shared/github-types'

describe('SessionGitHubIntegration extended fields', () => {
  it('accepts hiddenSections, collapsedSections as arrays, and sectionPrefs', () => {
    const v: SessionGitHubIntegration = {
      enabled: true,
      autoDetected: false,
      hiddenSections: ['notifications'],
      collapsedSections: ['ci'],
      sectionPrefs: { ci: { filter: 'failing' } },
      pinnedIssueNumber: 42,
      unlinkedIssues: [99],
    }
    expect(v.hiddenSections?.[0]).toBe('notifications')
    expect(Array.isArray(v.collapsedSections)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/github-types.test.ts`
Expected: FAIL — "hiddenSections does not exist on type SessionGitHubIntegration".

- [ ] **Step 3: Extend the interface**

Replace the existing `SessionGitHubIntegration` in `src/shared/github-types.ts` with:

```ts
export interface SessionGitHubIntegration {
  enabled: boolean
  repoUrl?: string
  repoSlug?: string
  authProfileId?: string
  autoDetected: boolean
  panelWidth?: number
  dismissedAutoDetect?: boolean
  /** IDs of sections hidden in this session (master checklist unticks). */
  hiddenSections?: GitHubSectionId[]
  /** IDs of sections whose body is collapsed. Replaces the old
   * `Record<string, boolean>` shape — migrated at load time. */
  collapsedSections?: GitHubSectionId[]
  /** Per-section overrides merged onto built-in defaults at render time. */
  sectionPrefs?: Partial<Record<GitHubSectionId, SectionPref>>
  /** Override for the Session Context heuristic pin. */
  pinnedIssueNumber?: number
  /** User-unlinked issue numbers that should stay suppressed from Linked Issues. */
  unlinkedIssues?: number[]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shared/github-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/github-types.ts tests/unit/shared/github-types.test.ts
git commit -m "feat(sidebar): extend SessionGitHubIntegration with hidden/collapsed/prefs"
```

---

### Task 3: Extend `GitHubConfig` with defaults + snooze + last-seen maps

**Files:**
- Modify: `src/shared/github-types.ts:60-69`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/shared/github-types.test.ts`:

```ts
import type { GitHubConfig } from '../../../src/shared/github-types'

describe('GitHubConfig extended fields', () => {
  it('accepts defaultVisibleSections, snoozedNotifications, lastSeenThreads', () => {
    const c: GitHubConfig = {
      schemaVersion: 2,
      authProfiles: {},
      featureToggles: {
        activePR: true, ci: true, reviews: true, linkedIssues: true,
        notifications: true, localGit: true, sessionContext: true,
      },
      syncIntervals: { activeSessionSec: 30, backgroundSec: 120, notificationsSec: 60 },
      enabledByDefault: true,
      transcriptScanningOptIn: false,
      defaultVisibleSections: ['activePR', 'ci', 'notifications'],
      snoozedNotifications: { 'p1:thr_1': Date.now() + 7200000 },
      lastSeenThreads: { 'reviews-123:thread_a': 1_700_000_000_000 },
    }
    expect(c.defaultVisibleSections?.length).toBe(3)
    expect(c.schemaVersion).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/github-types.test.ts`
Expected: FAIL — "defaultVisibleSections does not exist on GitHubConfig".

- [ ] **Step 3: Extend the interface**

Replace the existing `GitHubConfig` interface in `src/shared/github-types.ts` with:

```ts
export interface GitHubConfig {
  schemaVersion: number
  authProfiles: Record<string, AuthProfile>
  defaultAuthProfileId?: string
  featureToggles: Record<GitHubFeatureKey, boolean>
  syncIntervals: GitHubSyncIntervals
  enabledByDefault: boolean
  transcriptScanningOptIn: boolean
  seenOnboardingVersion?: string
  /** Template of sections shown by default on new sessions. If undefined,
   * every enabled feature is visible. */
  defaultVisibleSections?: GitHubSectionId[]
  /** `profileId:threadId` → resumesAt epoch ms. Cleared lazily on
   * next-sync pass once resumesAt is in the past. */
  snoozedNotifications?: Record<string, number>
  /** feedId-namespaced thread-last-seen timestamps. LRU-capped at 500 and
   * 90-day-evicted on hydration. */
  lastSeenThreads?: Record<string, number>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shared/github-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/github-types.ts tests/unit/shared/github-types.test.ts
git commit -m "feat(sidebar): extend GitHubConfig with defaults and snooze/last-seen maps"
```

---

### Task 4: Write the `collapsedSections` migration helper

**Files:**
- Create: `src/shared/github-types-migration.ts`
- Create: `tests/unit/shared/github-types-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/github-types-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { migrateSessionGitHubIntegration } from '../../../src/shared/github-types-migration'

describe('migrateSessionGitHubIntegration', () => {
  it('converts collapsedSections from Record<string, boolean> to array form', () => {
    const input = {
      enabled: true,
      autoDetected: false,
      collapsedSections: { ci: true, notifications: false, reviews: true },
    }
    const out = migrateSessionGitHubIntegration(input as any)
    expect(Array.isArray(out.collapsedSections)).toBe(true)
    expect(new Set(out.collapsedSections!)).toEqual(new Set(['ci', 'reviews']))
  })

  it('drops keys that are not recognised GitHubSectionId values', () => {
    const input = {
      enabled: true,
      autoDetected: false,
      collapsedSections: { ci: true, unknownSection: true },
    }
    const out = migrateSessionGitHubIntegration(input as any)
    expect(out.collapsedSections).toEqual(['ci'])
  })

  it('leaves already-array-shaped collapsedSections untouched', () => {
    const input = {
      enabled: true,
      autoDetected: false,
      collapsedSections: ['notifications'] as const,
    }
    const out = migrateSessionGitHubIntegration(input as any)
    expect(out.collapsedSections).toEqual(['notifications'])
  })

  it('handles undefined collapsedSections without error', () => {
    const input = { enabled: true, autoDetected: false }
    const out = migrateSessionGitHubIntegration(input as any)
    expect(out.collapsedSections).toBeUndefined()
  })

  it('preserves other fields', () => {
    const input = {
      enabled: true,
      autoDetected: true,
      repoUrl: 'https://github.com/x/y',
      panelWidth: 420,
      collapsedSections: { ci: true },
    }
    const out = migrateSessionGitHubIntegration(input as any)
    expect(out.repoUrl).toBe('https://github.com/x/y')
    expect(out.panelWidth).toBe(420)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/github-types-migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the migration helper**

Create `src/shared/github-types-migration.ts`:

```ts
import type { GitHubSectionId, SessionGitHubIntegration } from './github-types'

const VALID_IDS: readonly GitHubSectionId[] = [
  'sessionContext', 'activePR', 'ci', 'reviews', 'linkedIssues',
  'localGit', 'notifications', 'liveActivity',
]

function isValidId(x: unknown): x is GitHubSectionId {
  return typeof x === 'string' && (VALID_IDS as readonly string[]).includes(x)
}

/**
 * Normalise a session-state `githubIntegration` record to the new schema.
 * Idempotent: running twice on an already-migrated record returns identical data.
 */
export function migrateSessionGitHubIntegration(
  raw: Record<string, unknown> & Partial<SessionGitHubIntegration>,
): SessionGitHubIntegration {
  const out: SessionGitHubIntegration = {
    enabled: Boolean(raw.enabled),
    autoDetected: Boolean(raw.autoDetected),
  }

  if (typeof raw.repoUrl === 'string') out.repoUrl = raw.repoUrl
  if (typeof raw.repoSlug === 'string') out.repoSlug = raw.repoSlug
  if (typeof raw.authProfileId === 'string') out.authProfileId = raw.authProfileId
  if (typeof raw.panelWidth === 'number') out.panelWidth = raw.panelWidth
  if (typeof raw.dismissedAutoDetect === 'boolean') out.dismissedAutoDetect = raw.dismissedAutoDetect
  if (typeof raw.pinnedIssueNumber === 'number') out.pinnedIssueNumber = raw.pinnedIssueNumber

  if (Array.isArray(raw.hiddenSections)) {
    out.hiddenSections = (raw.hiddenSections as unknown[]).filter(isValidId)
  }

  if (Array.isArray(raw.collapsedSections)) {
    out.collapsedSections = (raw.collapsedSections as unknown[]).filter(isValidId)
  } else if (raw.collapsedSections && typeof raw.collapsedSections === 'object') {
    const obj = raw.collapsedSections as Record<string, unknown>
    out.collapsedSections = Object.entries(obj)
      .filter(([key, value]) => value === true && isValidId(key))
      .map(([key]) => key as GitHubSectionId)
  }

  if (raw.sectionPrefs && typeof raw.sectionPrefs === 'object') {
    const src = raw.sectionPrefs as Record<string, unknown>
    const dst: Partial<Record<GitHubSectionId, unknown>> = {}
    for (const [k, v] of Object.entries(src)) {
      if (isValidId(k) && v && typeof v === 'object') dst[k] = v
    }
    if (Object.keys(dst).length > 0) out.sectionPrefs = dst as SessionGitHubIntegration['sectionPrefs']
  }

  if (Array.isArray(raw.unlinkedIssues)) {
    out.unlinkedIssues = (raw.unlinkedIssues as unknown[]).filter((n): n is number => typeof n === 'number')
  }

  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shared/github-types-migration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/github-types-migration.ts tests/unit/shared/github-types-migration.test.ts
git commit -m "feat(sidebar): migration helper for collapsedSections record→array"
```

---

### Task 5: Wire the migration into session-state load

**Files:**
- Modify: `src/main/session-state.ts`
- Create: `tests/unit/main/session-state-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/session-state-migration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock config-manager so getConfigDir points into a temp dir
let testDir: string
vi.mock('../../src/main/config-manager', () => {
  return {
    getConfigDir: () => testDir,
    ensureConfigDir: () => undefined,
  }
})
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => undefined }))

import { loadSessionState } from '../../src/main/session-state'

describe('loadSessionState migration', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ccc-session-'))
  })
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('migrates legacy collapsedSections object form to array form', () => {
    const legacy = {
      sessions: [
        {
          id: 's1',
          label: 'x',
          workingDirectory: '.',
          model: 'sonnet',
          color: 'blue',
          sessionType: 'local',
          githubIntegration: {
            enabled: true,
            autoDetected: false,
            collapsedSections: { ci: true, notifications: false },
          },
        },
      ],
      activeSessionId: 's1',
      savedAt: Date.now(),
    }
    writeFileSync(join(testDir, 'session-state.json'), JSON.stringify(legacy))
    const loaded = loadSessionState()!
    const gi = loaded.sessions[0].githubIntegration
    expect(Array.isArray(gi?.collapsedSections)).toBe(true)
    expect(gi?.collapsedSections).toEqual(['ci'])
  })

  it('returns null when no file present', () => {
    expect(loadSessionState()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/session-state-migration.test.ts`
Expected: FAIL — the loader returns the legacy shape untouched.

- [ ] **Step 3: Wire the migration into the loader**

In `src/main/session-state.ts`, at the top add:

```ts
import { migrateSessionGitHubIntegration } from '../shared/github-types-migration'
```

Modify `loadSessionState()` to post-process each session:

```ts
export function loadSessionState(): SessionState | null {
  try {
    const file = getSessionStateFile()
    if (!existsSync(file)) {
      return null
    }
    const data = readFileSync(file, 'utf-8')
    const state = JSON.parse(data) as SessionState
    // Migrate the per-session GitHub integration shape if necessary.
    for (const session of state.sessions) {
      if (session.githubIntegration) {
        session.githubIntegration = migrateSessionGitHubIntegration(
          session.githubIntegration as unknown as Record<string, unknown>,
        )
      }
    }
    logInfo(`[session-state] Loaded ${state.sessions.length} sessions from ${new Date(state.savedAt).toLocaleString()}`)
    return state
  } catch (err) {
    console.error('[session-state] Failed to load:', err)
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/session-state-migration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/session-state.ts tests/unit/main/session-state-migration.test.ts
git commit -m "feat(sidebar): migrate collapsedSections shape on session-state load"
```

---

### Task 6: Add `defaultVisibleSections` + `snoozedNotifications` + `lastSeenThreads` to the config store

**Files:**
- Modify: `src/main/github/github-config-store.ts`
- Create: `tests/unit/main/github-config-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/github-config-defaults.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const saved: { key?: string; data?: unknown }[] = []
vi.mock('../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({
    schemaVersion: 2,
    authProfiles: {},
    featureToggles: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: true, localGit: true, sessionContext: true,
    },
    syncIntervals: { activeSessionSec: 30, backgroundSec: 120, notificationsSec: 60 },
    enabledByDefault: true,
    transcriptScanningOptIn: false,
  })),
  writeConfig: vi.fn((key: string, data: unknown) => { saved.push({ key, data }) }),
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => undefined, logError: () => undefined }))

import {
  setDefaultVisibleSections, getDefaultVisibleSections,
  setSnooze, getActiveSnoozes, clearExpiredSnoozes,
  stampLastSeen, getLastSeen, prunLastSeen,
} from '../../src/main/github/github-config-store'

describe('github-config-store defaults/snooze/last-seen', () => {
  beforeEach(() => { saved.length = 0 })

  it('setDefaultVisibleSections writes an array field', () => {
    setDefaultVisibleSections(['activePR', 'ci'])
    expect(saved.at(-1)?.data).toMatchObject({ defaultVisibleSections: ['activePR', 'ci'] })
    expect(getDefaultVisibleSections()).toEqual(['activePR', 'ci'])
  })

  it('setSnooze adds entry; clearExpiredSnoozes removes past entries', () => {
    const now = Date.now()
    setSnooze('profile1:thread_A', now + 1000)
    setSnooze('profile1:thread_B', now - 1000)
    const active = clearExpiredSnoozes(now)
    expect(active).toContain('profile1:thread_A')
    expect(active).not.toContain('profile1:thread_B')
  })

  it('stampLastSeen caps at 500 entries by LRU', () => {
    for (let i = 0; i < 600; i++) stampLastSeen(`feed:${i}`, i)
    const all = getLastSeen()
    expect(Object.keys(all).length).toBeLessThanOrEqual(500)
  })

  it('prunLastSeen drops entries older than 90 days', () => {
    const now = Date.now()
    stampLastSeen('a:1', now - 100 * 24 * 3600 * 1000) // 100d old
    stampLastSeen('a:2', now - 10 * 24 * 3600 * 1000)  // 10d old
    prunLastSeen(now)
    const all = getLastSeen()
    expect(all['a:1']).toBeUndefined()
    expect(all['a:2']).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/github-config-defaults.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Add the helpers**

In `src/main/github/github-config-store.ts`, add the following (adjust imports if `readConfig`/`writeConfig` are already used):

```ts
import type { GitHubSectionId } from '../../shared/github-types'

const MAX_LAST_SEEN = 500
const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000

function readOrInit(): GitHubConfig {
  const existing = readConfig<GitHubConfig>('github')
  if (!existing) throw new Error('github config missing')  // initialised elsewhere at boot
  return existing
}

function patch(fields: Partial<GitHubConfig>): void {
  const cfg = readOrInit()
  writeConfig('github', { ...cfg, ...fields })
}

// defaultVisibleSections -------------------------------------------------
export function setDefaultVisibleSections(ids: GitHubSectionId[] | undefined): void {
  patch({ defaultVisibleSections: ids })
}

export function getDefaultVisibleSections(): GitHubSectionId[] | undefined {
  return readOrInit().defaultVisibleSections
}

// snoozedNotifications ---------------------------------------------------
export function setSnooze(key: string, resumesAt: number): void {
  const cfg = readOrInit()
  const map = { ...(cfg.snoozedNotifications ?? {}), [key]: resumesAt }
  patch({ snoozedNotifications: map })
}

export function getActiveSnoozes(now = Date.now()): string[] {
  const map = readOrInit().snoozedNotifications ?? {}
  return Object.entries(map).filter(([, resumesAt]) => resumesAt > now).map(([k]) => k)
}

export function clearExpiredSnoozes(now = Date.now()): string[] {
  const cfg = readOrInit()
  const map = cfg.snoozedNotifications ?? {}
  const alive: Record<string, number> = {}
  for (const [k, v] of Object.entries(map)) if (v > now) alive[k] = v
  patch({ snoozedNotifications: alive })
  return Object.keys(alive)
}

// lastSeenThreads --------------------------------------------------------
export function stampLastSeen(key: string, ts: number): void {
  const cfg = readOrInit()
  const map = { ...(cfg.lastSeenThreads ?? {}) }
  map[key] = ts
  // LRU cap: drop oldest when exceeding MAX_LAST_SEEN.
  if (Object.keys(map).length > MAX_LAST_SEEN) {
    const sorted = Object.entries(map).sort(([, a], [, b]) => a - b)
    const toRemove = sorted.slice(0, sorted.length - MAX_LAST_SEEN).map(([k]) => k)
    for (const k of toRemove) delete map[k]
  }
  patch({ lastSeenThreads: map })
}

export function getLastSeen(): Record<string, number> {
  return readOrInit().lastSeenThreads ?? {}
}

export function prunLastSeen(now = Date.now()): void {
  const cfg = readOrInit()
  const map = cfg.lastSeenThreads ?? {}
  const alive: Record<string, number> = {}
  for (const [k, ts] of Object.entries(map)) {
    if (now - ts <= NINETY_DAYS_MS) alive[k] = ts
  }
  patch({ lastSeenThreads: alive })
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/github-config-defaults.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/github/github-config-store.ts tests/unit/main/github-config-defaults.test.ts
git commit -m "feat(sidebar): config-store helpers for defaults, snooze, last-seen"
```

---

### Task 7: Add IPC channels for the master menu

**Files:**
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/ipc-channels.test.ts` (or append if exists):

```ts
import { describe, it, expect } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

describe('IPC channels for sidebar master menu', () => {
  it('exposes the new channels', () => {
    expect(IPC.GITHUB_SECTION_HIDDEN_SET).toBe('github:section:hiddenSet')
    expect(IPC.GITHUB_SECTION_HIDDEN_RESET).toBe('github:section:hiddenReset')
    expect(IPC.GITHUB_DEFAULT_VISIBLE_SET).toBe('github:defaults:visibleSet')
    expect(IPC.GITHUB_SECTION_PREFS_SET).toBe('github:section:prefsSet')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/ipc-channels.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add channels**

In `src/shared/ipc-channels.ts`, inside the `GitHub sidebar` group (near line ~194), append:

```ts
  GITHUB_SECTION_HIDDEN_SET: 'github:section:hiddenSet',
  GITHUB_SECTION_HIDDEN_RESET: 'github:section:hiddenReset',
  GITHUB_DEFAULT_VISIBLE_SET: 'github:defaults:visibleSet',
  GITHUB_SECTION_PREFS_SET: 'github:section:prefsSet',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shared/ipc-channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts tests/unit/shared/ipc-channels.test.ts
git commit -m "feat(sidebar): add IPC channels for master menu"
```

---

### Task 8: Wire preload bridge + renderer types

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/preload/github-bridge.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

// Mock electron.ipcRenderer so the preload module loads cleanly.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: () => undefined },
  ipcRenderer: {
    invoke: vi.fn(async () => ({ ok: true })),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

describe('preload github bridge for master menu', () => {
  it('exposes setHiddenSections, resetHidden, setDefaultVisibleSections, setSectionPrefs', async () => {
    const bridge = await import('../../src/preload/index')
    const api = (bridge as any).electronAPI
    expect(typeof api.github.setHiddenSections).toBe('function')
    expect(typeof api.github.resetHidden).toBe('function')
    expect(typeof api.github.setDefaultVisibleSections).toBe('function')
    expect(typeof api.github.setSectionPrefs).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/preload/github-bridge.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Extend the bridge**

In `src/preload/index.ts`, locate the `github` property of the bridge and add:

```ts
      setHiddenSections: (sessionId: string, ids: string[]) =>
        ipcRenderer.invoke(IPC.GITHUB_SECTION_HIDDEN_SET, sessionId, ids),
      resetHidden: (sessionId: string) =>
        ipcRenderer.invoke(IPC.GITHUB_SECTION_HIDDEN_RESET, sessionId),
      setDefaultVisibleSections: (ids: string[] | null) =>
        ipcRenderer.invoke(IPC.GITHUB_DEFAULT_VISIBLE_SET, ids),
      setSectionPrefs: (sessionId: string, id: string, prefs: Record<string, unknown>) =>
        ipcRenderer.invoke(IPC.GITHUB_SECTION_PREFS_SET, sessionId, id, prefs),
```

In `src/renderer/types/electron.d.ts`, add matching method declarations to the `github` bridge interface:

```ts
      setHiddenSections(sessionId: string, ids: GitHubSectionId[]): Promise<{ ok: boolean; error?: string }>
      resetHidden(sessionId: string): Promise<{ ok: boolean; error?: string }>
      setDefaultVisibleSections(ids: GitHubSectionId[] | null): Promise<{ ok: boolean; error?: string }>
      setSectionPrefs(sessionId: string, id: GitHubSectionId, prefs: SectionPref): Promise<{ ok: boolean; error?: string }>
```

And add the cross-process type re-exports at the top of the file:

```ts
export type { GitHubSectionId, SectionPref } from '../../shared/github-types'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/preload/github-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/renderer/types/electron.d.ts tests/unit/preload/github-bridge.test.ts
git commit -m "feat(sidebar): expose master-menu IPC via preload bridge"
```

---

### Task 9: Main-side IPC handlers

**Files:**
- Modify: `src/main/ipc/github-handlers.ts`
- Create: `tests/unit/main/github-handlers-master-menu.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/github-handlers-master-menu.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const writes: { key: string; data: unknown }[] = []
vi.mock('../../src/main/config-manager', () => ({
  readConfig: vi.fn((key: string) => {
    if (key === 'github') {
      return {
        schemaVersion: 2,
        authProfiles: {},
        featureToggles: {
          activePR: true, ci: true, reviews: true, linkedIssues: true,
          notifications: true, localGit: true, sessionContext: true,
        },
        syncIntervals: { activeSessionSec: 30, backgroundSec: 120, notificationsSec: 60 },
        enabledByDefault: true,
        transcriptScanningOptIn: false,
      }
    }
    if (key === 'sessions') {
      return { sessions: [{ id: 's1', githubIntegration: { enabled: true, autoDetected: false } }] }
    }
    return null
  }),
  writeConfig: vi.fn((key: string, data: unknown) => { writes.push({ key, data }) }),
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => undefined, logError: () => undefined }))

// Capture registered handlers
const handlers: Record<string, (...args: any[]) => any> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { handlers[ch] = fn } },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { registerGithubMasterMenuHandlers } from '../../src/main/ipc/github-handlers'

describe('master menu handlers', () => {
  beforeEach(() => { writes.length = 0; for (const k of Object.keys(handlers)) delete handlers[k] })

  it('setHiddenSections persists the list on the session', async () => {
    registerGithubMasterMenuHandlers()
    const fn = handlers['github:section:hiddenSet']
    const out = await fn(null, 's1', ['notifications'])
    expect(out.ok).toBe(true)
    const saved = writes.find((w) => w.key === 'sessions')?.data as any
    expect(saved.sessions[0].githubIntegration.hiddenSections).toEqual(['notifications'])
  })

  it('resetHidden clears the list', async () => {
    registerGithubMasterMenuHandlers()
    const fn = handlers['github:section:hiddenReset']
    const out = await fn(null, 's1')
    expect(out.ok).toBe(true)
    const saved = writes.find((w) => w.key === 'sessions')?.data as any
    expect(saved.sessions[0].githubIntegration.hiddenSections).toBeUndefined()
  })

  it('setDefaultVisibleSections writes to github config', async () => {
    registerGithubMasterMenuHandlers()
    const fn = handlers['github:defaults:visibleSet']
    const out = await fn(null, ['activePR', 'ci'])
    expect(out.ok).toBe(true)
    const saved = writes.find((w) => w.key === 'github')?.data as any
    expect(saved.defaultVisibleSections).toEqual(['activePR', 'ci'])
  })

  it('rejects unknown section id values', async () => {
    registerGithubMasterMenuHandlers()
    const fn = handlers['github:section:hiddenSet']
    const out = await fn(null, 's1', ['not_a_section'])
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/invalid/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/github-handlers-master-menu.test.ts`
Expected: FAIL — registerGithubMasterMenuHandlers not exported.

- [ ] **Step 3: Implement the handlers**

In `src/main/ipc/github-handlers.ts`, append the following. If the file already has an aggregate registration function (e.g. `registerGithubHandlers`), call the new one from there.

```ts
import { readConfig, writeConfig } from '../config-manager'
import type { GitHubSectionId, SessionGitHubIntegration } from '../../shared/github-types'
import { setDefaultVisibleSections as storeSetDefaultVisible } from '../github/github-config-store'

const VALID_IDS: readonly GitHubSectionId[] = [
  'sessionContext', 'activePR', 'ci', 'reviews', 'linkedIssues',
  'localGit', 'notifications', 'liveActivity',
]

function isValidId(x: unknown): x is GitHubSectionId {
  return typeof x === 'string' && (VALID_IDS as readonly string[]).includes(x)
}

function updateSessionIntegration(
  sessionId: string,
  update: (gi: SessionGitHubIntegration) => SessionGitHubIntegration,
): { ok: boolean; error?: string } {
  const raw = readConfig<{ sessions: Array<{ id: string; githubIntegration?: SessionGitHubIntegration }> }>('sessions')
  if (!raw) return { ok: false, error: 'sessions-config-missing' }
  const session = raw.sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, error: 'session-not-found' }
  const current = session.githubIntegration ?? { enabled: true, autoDetected: false }
  session.githubIntegration = update(current)
  writeConfig('sessions', raw)
  return { ok: true }
}

export function registerGithubMasterMenuHandlers(): void {
  ipcMain.handle(IPC.GITHUB_SECTION_HIDDEN_SET, async (_e, sessionId: string, ids: unknown) => {
    if (!Array.isArray(ids) || !ids.every(isValidId)) return { ok: false, error: 'invalid-section-id' }
    return updateSessionIntegration(sessionId, (gi) => ({ ...gi, hiddenSections: ids }))
  })

  ipcMain.handle(IPC.GITHUB_SECTION_HIDDEN_RESET, async (_e, sessionId: string) => {
    return updateSessionIntegration(sessionId, (gi) => {
      const { hiddenSections, ...rest } = gi
      return rest
    })
  })

  ipcMain.handle(IPC.GITHUB_DEFAULT_VISIBLE_SET, async (_e, ids: unknown) => {
    if (ids === null) { storeSetDefaultVisible(undefined); return { ok: true } }
    if (!Array.isArray(ids) || !ids.every(isValidId)) return { ok: false, error: 'invalid-section-id' }
    storeSetDefaultVisible(ids)
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_SECTION_PREFS_SET, async (_e, sessionId: string, id: unknown, prefs: unknown) => {
    if (!isValidId(id)) return { ok: false, error: 'invalid-section-id' }
    if (!prefs || typeof prefs !== 'object') return { ok: false, error: 'invalid-prefs' }
    return updateSessionIntegration(sessionId, (gi) => {
      const next = { ...(gi.sectionPrefs ?? {}) }
      next[id] = { ...(next[id] ?? {}), ...(prefs as Record<string, unknown>) }
      return { ...gi, sectionPrefs: next }
    })
  })
}
```

Ensure `registerGithubMasterMenuHandlers()` is called from the main `registerGithubHandlers()` (or equivalent boot registration).

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/github-handlers-master-menu.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/github-handlers.ts tests/unit/main/github-handlers-master-menu.test.ts
git commit -m "feat(sidebar): main-side handlers for master menu"
```

---

### Task 10: Extend githubStore with defaults + visibility selectors

**Files:**
- Modify: `src/renderer/stores/githubStore.ts`
- Create: `tests/unit/renderer/stores/githubStore-visibility.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/stores/githubStore-visibility.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockWindow = globalThis as any
mockWindow.electronAPI = {
  github: {
    setHiddenSections: vi.fn(async () => ({ ok: true })),
    resetHidden: vi.fn(async () => ({ ok: true })),
    setDefaultVisibleSections: vi.fn(async () => ({ ok: true })),
  },
}

import { useGithubStore } from '../../../src/renderer/stores/githubStore'

describe('githubStore visibility', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('hideSection calls IPC and updates cache', async () => {
    await useGithubStore.getState().hideSection('s1', 'notifications')
    expect(mockWindow.electronAPI.github.setHiddenSections).toHaveBeenCalledWith('s1', ['notifications'])
  })

  it('saveAsDefault calls IPC with current hidden inverse', async () => {
    const currentVisible = ['activePR', 'ci']
    await useGithubStore.getState().saveAsDefault(currentVisible)
    expect(mockWindow.electronAPI.github.setDefaultVisibleSections).toHaveBeenCalledWith(currentVisible)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/stores/githubStore-visibility.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Extend the store**

In `src/renderer/stores/githubStore.ts`, augment state + actions:

```ts
// In the state interface:
  defaultVisibleSections: GitHubSectionId[] | null
  hiddenSectionsBySession: Record<string, GitHubSectionId[]>

// In the actions interface:
  hideSection(sessionId: string, id: GitHubSectionId): Promise<void>
  unhideSection(sessionId: string, id: GitHubSectionId): Promise<void>
  resetHidden(sessionId: string): Promise<void>
  saveAsDefault(visibleIds: GitHubSectionId[]): Promise<void>
  clearDefault(): Promise<void>
```

Implementation additions (inside the store factory):

```ts
  hideSection: async (sessionId, id) => {
    const current = get().hiddenSectionsBySession[sessionId] ?? []
    if (current.includes(id)) return
    const next = [...current, id]
    await window.electronAPI.github.setHiddenSections(sessionId, next)
    set({ hiddenSectionsBySession: { ...get().hiddenSectionsBySession, [sessionId]: next } })
  },
  unhideSection: async (sessionId, id) => {
    const current = get().hiddenSectionsBySession[sessionId] ?? []
    if (!current.includes(id)) return
    const next = current.filter((x) => x !== id)
    await window.electronAPI.github.setHiddenSections(sessionId, next)
    set({ hiddenSectionsBySession: { ...get().hiddenSectionsBySession, [sessionId]: next } })
  },
  resetHidden: async (sessionId) => {
    await window.electronAPI.github.resetHidden(sessionId)
    const next = { ...get().hiddenSectionsBySession }
    delete next[sessionId]
    set({ hiddenSectionsBySession: next })
  },
  saveAsDefault: async (visibleIds) => {
    await window.electronAPI.github.setDefaultVisibleSections(visibleIds)
    set({ defaultVisibleSections: visibleIds })
  },
  clearDefault: async () => {
    await window.electronAPI.github.setDefaultVisibleSections(null)
    set({ defaultVisibleSections: null })
  },
```

Add initial state values: `defaultVisibleSections: null`, `hiddenSectionsBySession: {}`. Hydrate from config on load (extend the existing hydration path).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renderer/stores/githubStore-visibility.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/githubStore.ts tests/unit/renderer/stores/githubStore-visibility.test.ts
git commit -m "feat(sidebar): githubStore actions for hide/unhide/default"
```

---

### Task 11: Build `<SidebarHeaderMenu>`

**Files:**
- Create: `src/renderer/components/github/menu/SidebarHeaderMenu.tsx`
- Create: `src/renderer/components/github/menu/section-menu-utils.ts`
- Create: `tests/unit/renderer/components/github/SidebarHeaderMenu.test.tsx`

- [ ] **Step 1: Write the failing test**

Create the test:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const store = {
  defaultVisibleSections: null as string[] | null,
  hiddenSectionsBySession: { s1: [] as string[] },
  featureToggles: {
    activePR: true, ci: false, reviews: true, linkedIssues: true,
    notifications: true, localGit: true, sessionContext: true,
  },
  profiles: { p1: { capabilities: ['notifications', 'pulls', 'contents'] } },
  hideSection: vi.fn(), unhideSection: vi.fn(),
  resetHidden: vi.fn(), saveAsDefault: vi.fn(), clearDefault: vi.fn(),
}

vi.mock('../../../src/renderer/stores/githubStore', () => ({
  useGithubStore: (sel: (s: typeof store) => unknown) => sel(store),
}))

import { SidebarHeaderMenu } from '../../../src/renderer/components/github/menu/SidebarHeaderMenu'

describe('SidebarHeaderMenu', () => {
  it('renders a row per section and disables CI (feature off)', () => {
    render(<SidebarHeaderMenu sessionId="s1" open onClose={() => undefined} />)
    expect(screen.getByText(/Session Context/i)).toBeInTheDocument()
    const ciRow = screen.getByTestId('menu-row-ci')
    expect(ciRow).toHaveAttribute('aria-disabled', 'true')
  })

  it('clicking an enabled row toggles visibility via the store', () => {
    render(<SidebarHeaderMenu sessionId="s1" open onClose={() => undefined} />)
    fireEvent.click(screen.getByTestId('menu-row-notifications'))
    expect(store.hideSection).toHaveBeenCalledWith('s1', 'notifications')
  })

  it('Save as default calls saveAsDefault with current visible ids', () => {
    render(<SidebarHeaderMenu sessionId="s1" open onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /save as default/i }))
    expect(store.saveAsDefault).toHaveBeenCalled()
  })

  it('Reset calls resetHidden', () => {
    render(<SidebarHeaderMenu sessionId="s1" open onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /^reset/i }))
    expect(store.resetHidden).toHaveBeenCalledWith('s1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/github/SidebarHeaderMenu.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Write the utilities file**

Create `src/renderer/components/github/menu/section-menu-utils.ts`:

```ts
import type { GitHubSectionId, GitHubFeatureKey, Capability } from '../../../../shared/github-types'

export interface MenuRow {
  id: GitHubSectionId
  label: string
  disabledReason?: 'feature-off' | 'capability-missing' | 'hooks-off'
}

const LABELS: Record<GitHubSectionId, string> = {
  sessionContext: 'Session Context',
  activePR: 'Active PR',
  ci: 'CI / Actions',
  reviews: 'Reviews & Comments',
  linkedIssues: 'Linked Issues',
  localGit: 'Local Git',
  notifications: 'Notifications',
  liveActivity: 'Live Activity',
}

const CAP_NEEDED: Partial<Record<GitHubSectionId, Capability>> = {
  activePR: 'pulls',
  ci: 'actions',
  reviews: 'pulls',
  linkedIssues: 'issues',
  notifications: 'notifications',
}

const FEATURE_FOR: Partial<Record<GitHubSectionId, GitHubFeatureKey>> = {
  sessionContext: 'sessionContext',
  activePR: 'activePR',
  ci: 'ci',
  reviews: 'reviews',
  linkedIssues: 'linkedIssues',
  localGit: 'localGit',
  notifications: 'notifications',
  // liveActivity handled separately — depends on hooks gateway
}

export function buildMenuRows(args: {
  featureToggles: Record<GitHubFeatureKey, boolean>
  profileCapabilities: Capability[]
  hooksEnabled: boolean
}): MenuRow[] {
  const rows: MenuRow[] = []
  for (const id of Object.keys(LABELS) as GitHubSectionId[]) {
    const row: MenuRow = { id, label: LABELS[id] }
    if (id === 'liveActivity') {
      if (!args.hooksEnabled) row.disabledReason = 'hooks-off'
    } else {
      const featureKey = FEATURE_FOR[id]
      if (featureKey && args.featureToggles[featureKey] === false) row.disabledReason = 'feature-off'
      const capNeeded = CAP_NEEDED[id]
      if (!row.disabledReason && capNeeded && !args.profileCapabilities.includes(capNeeded)) {
        row.disabledReason = 'capability-missing'
      }
    }
    rows.push(row)
  }
  return rows
}
```

- [ ] **Step 4: Write the component**

Create `src/renderer/components/github/menu/SidebarHeaderMenu.tsx`:

```tsx
import React, { useMemo } from 'react'
import { useGithubStore } from '../../../stores/githubStore'
import type { GitHubSectionId } from '../../../../shared/github-types'
import { buildMenuRows } from './section-menu-utils'

interface Props {
  sessionId: string
  open: boolean
  onClose: () => void
}

export function SidebarHeaderMenu({ sessionId, open, onClose }: Props) {
  const featureToggles = useGithubStore((s) => s.featureToggles)
  const profiles = useGithubStore((s) => s.profiles)
  const hiddenBySession = useGithubStore((s) => s.hiddenSectionsBySession)
  const defaultVisible = useGithubStore((s) => s.defaultVisibleSections)
  const hideSection = useGithubStore((s) => s.hideSection)
  const unhideSection = useGithubStore((s) => s.unhideSection)
  const resetHidden = useGithubStore((s) => s.resetHidden)
  const saveAsDefault = useGithubStore((s) => s.saveAsDefault)
  const clearDefault = useGithubStore((s) => s.clearDefault)

  const caps = useMemo(() => {
    const c = new Set<string>()
    for (const p of Object.values(profiles ?? {})) for (const cap of p.capabilities ?? []) c.add(cap)
    return Array.from(c) as any
  }, [profiles])

  const rows = useMemo(
    () => buildMenuRows({ featureToggles, profileCapabilities: caps, hooksEnabled: true }),
    [featureToggles, caps],
  )

  const hidden = hiddenBySession[sessionId] ?? []
  const visibleIds = rows.filter((r) => !hidden.includes(r.id) && !r.disabledReason).map((r) => r.id)

  if (!open) return null

  return (
    <div
      role="menu"
      aria-label="Sidebar sections"
      className="absolute right-1 top-8 z-20 w-64 rounded border border-surface0 bg-base p-2 shadow-lg"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="px-1 pb-1 text-xs text-overlay0">Show sections</div>
      {rows.map((row) => {
        const disabled = Boolean(row.disabledReason)
        const isHidden = hidden.includes(row.id)
        return (
          <button
            key={row.id}
            data-testid={`menu-row-${row.id}`}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            onClick={() => { if (disabled) return; isHidden ? unhideSection(sessionId, row.id) : hideSection(sessionId, row.id) }}
            className={`flex w-full items-center justify-between px-2 py-1 text-left text-sm ${disabled ? 'opacity-40' : 'hover:bg-surface0'}`}
          >
            <span>{row.label}</span>
            <span className="text-xs text-overlay1">
              {disabled
                ? (row.disabledReason === 'feature-off' ? 'off (settings)'
                  : row.disabledReason === 'capability-missing' ? 'auth'
                  : 'no hooks')
                : (isHidden ? 'hidden' : 'shown')}
            </span>
          </button>
        )
      })}

      <div className="mt-2 flex justify-between gap-1 border-t border-surface0 pt-2">
        <button
          className="rounded px-2 py-1 text-xs text-subtext0 hover:bg-surface0"
          onClick={() => { resetHidden(sessionId); onClose() }}
        >
          Reset
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-subtext0 hover:bg-surface0"
          onClick={() => {
            if (defaultVisible) clearDefault()
            else saveAsDefault(visibleIds as GitHubSectionId[])
          }}
        >
          {defaultVisible ? 'Clear default' : 'Save as default'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify green**

Run: `npx vitest run tests/unit/renderer/components/github/SidebarHeaderMenu.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/github/menu/ tests/unit/renderer/components/github/SidebarHeaderMenu.test.tsx
git commit -m "feat(sidebar): SidebarHeaderMenu master visibility popover"
```

---

### Task 12: Wire the `⋯` button into `PanelHeader.tsx`

**Files:**
- Modify: `src/renderer/components/github/PanelHeader.tsx`

- [ ] **Step 1: Skim existing header**

Read `PanelHeader.tsx` top-to-bottom once so you know where to drop the trigger without breaking existing layout. Identify the rightmost icon cluster.

- [ ] **Step 2: Add the trigger**

Add near the other header icons:

```tsx
const [menuOpen, setMenuOpen] = useState(false)
const menuRef = useRef<HTMLDivElement>(null)

useEffect(() => {
  function onClickOutside(e: MouseEvent) {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
  }
  if (menuOpen) document.addEventListener('mousedown', onClickOutside)
  return () => document.removeEventListener('mousedown', onClickOutside)
}, [menuOpen])

// ... inside the header layout:
<div className="relative" ref={menuRef}>
  <button
    aria-label="Sidebar options"
    aria-expanded={menuOpen}
    className="rounded p-1 text-overlay0 hover:bg-surface0"
    onClick={() => setMenuOpen((v) => !v)}
  >
    {String.fromCodePoint(0x22ef)}
  </button>
  <SidebarHeaderMenu sessionId={sessionId} open={menuOpen} onClose={() => setMenuOpen(false)} />
</div>
```

(Do not import `@floating-ui/react` yet. The absolute-positioned child is fine for a single-level menu at a fixed anchor. Phase 1b introduces floating-ui for nested popovers.)

- [ ] **Step 3: Smoke-test the UI**

Run dev:

```bash
npm run dev
```

Open the sidebar. Click the `⋯` icon. Verify menu opens, click outside closes. Toggle a section. Verify it disappears/reappears. Refresh the app — verify it stays hidden.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/github/PanelHeader.tsx
git commit -m "feat(sidebar): wire master menu trigger into panel header"
```

---

### Task 13: Honour `hiddenSections` in `GitHubPanel.tsx`

**Files:**
- Modify: `src/renderer/components/github/GitHubPanel.tsx`

- [ ] **Step 1: Read the existing render**

Identify the section-render loop (each section component rendered in order).

- [ ] **Step 2: Filter rendered sections**

Before the loop, compute:

```tsx
const hidden = useGithubStore((s) => s.hiddenSectionsBySession[sessionId] ?? [])
const isHidden = (id: GitHubSectionId) => hidden.includes(id)
```

Wrap each section's render with:

```tsx
{!isHidden('activePR') && <ActivePRSection ... />}
```

(Repeat per section.)

Defaults for new sessions: when the session has never set `hiddenSections` and `defaultVisibleSections` is set, interpret `hiddenSections` as "all except the default list". Add a small selector:

```tsx
const defaultVisible = useGithubStore((s) => s.defaultVisibleSections)
const effectiveHidden = useMemo(() => {
  if (hidden.length > 0) return hidden
  if (defaultVisible && defaultVisible.length > 0) {
    const all: GitHubSectionId[] = ['sessionContext','activePR','ci','reviews','linkedIssues','localGit','notifications','liveActivity']
    return all.filter((id) => !defaultVisible.includes(id))
  }
  return [] as GitHubSectionId[]
}, [hidden, defaultVisible])
const isHidden = (id: GitHubSectionId) => effectiveHidden.includes(id)
```

- [ ] **Step 3: Smoke-test**

Run dev. Toggle each section off, refresh, toggle on, refresh. Use "Save as default" with a subset and spawn a new session — verify the new session picks up the default.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/github/GitHubPanel.tsx
git commit -m "feat(sidebar): GitHubPanel honours per-session hiddenSections and defaults"
```

---

### Task 14: Typecheck + full test run before pushing

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS with no new errors.

- [ ] **Step 2: Full unit test run**

Run: `npx vitest run`
Expected: PASS (all tests including the new ones).

- [ ] **Step 3: Build the Windows installer for smoke testing**

Run: `npm run package:win`
Expected: `dist/ClaudeCommandCenter-1.3.1.exe` updated.

- [ ] **Step 4: Manual smoke (document in PR body)**

Follow the exact same checks as Task 12's smoke but on the built installer. Verify no console errors. Verify HMR reload preserves hidden state.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feat/sidebar-data-model
gh pr create --title "sidebar 1a: data model + master visibility menu" --body "$(cat <<'EOF'
## Summary
- Adds `GitHubSectionId`, `SectionPref` types and per-session `hiddenSections` / `collapsedSections` (array form) / `sectionPrefs` / `pinnedIssueNumber` / `unlinkedIssues` fields on `SessionGitHubIntegration`.
- Adds `defaultVisibleSections`, `snoozedNotifications`, `lastSeenThreads` on `GitHubConfig` (with LRU + 90-day eviction helpers).
- Migrates legacy `collapsedSections: Record<string, boolean>` to array form on session-state load.
- Adds main-side handlers + preload bridge for master-menu actions.
- Renders the `SidebarHeaderMenu` popover (`⋯` button in `PanelHeader`) that lets users hide/show sections, save-as-default, and reset. Disabled rows when a feature toggle is off or the auth profile lacks the capability.

No section-content changes in this PR; Phase 1b introduces section-level options and ToastUndo, Phase 1c introduces ScrollingFeed.

## Test plan
- [x] `npx vitest run` green (new tests around migration, config helpers, handlers, store, component).
- [x] `npm run typecheck` green.
- [x] Smoke: open sidebar, click `⋯`, toggle each section off/on, refresh app, verify persistence.
- [x] Smoke: save current subset as default, spawn a new session, verify defaults applied.
- [x] Smoke: disable the `ci` feature toggle; menu shows CI row as disabled.
EOF
)"
```

---

## Self-review checklist

- [ ] Every task has exact file paths.
- [ ] Every code step shows the full code to write.
- [ ] Every test has expected failure / expected pass.
- [ ] Types used in later tasks are defined in earlier tasks (`GitHubSectionId` Task 1 → used throughout).
- [ ] Migration handles all four input shapes (object, array, undefined, bogus keys).
- [ ] IPC validation rejects unknown section IDs.
- [ ] No new dependencies introduced (no @floating-ui/react yet — deferred to Phase 1b).
- [ ] User-visible behaviour change limited to the master menu; all existing flows work unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
