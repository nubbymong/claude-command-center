# Sidebar Flexibility — Phase 1c: `<ScrollingFeed>` Shared Component

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `<ScrollingFeed>` component in isolation with a dev-only storybook-style harness route. Reviews / Notifications / Linked Issues comment threads / Live Activity get wired to it in later phases (`feat/sidebar-easy-wins`, `feat/sidebar-hooks-dependent`). This PR delivers one user-facing surface: a Settings → Debug page link to `/__dev/feed`, gated on a `feedHarness` debug flag, that renders the feed against synthetic data.

**Architecture:** `ScrollingFeed` is a generic `<T>` component living at `src/renderer/components/common/ScrollingFeed.tsx`. Two pure helpers — `ScrollingFeedTimeBucketing.ts` (bucket selection + divider labels) and `ScrollingFeedUnreadTracker.ts` (IntersectionObserver wrapper + 500 ms debouncer) — factor the testable logic out of the component body. Virtualisation past `virtualizeThreshold` (default 100) delegates to `react-virtuoso` (new dep). `react-window` is explicitly ruled out by the spec because it assumes fixed item heights and reviewer-batch rows expand inline on click. Unread state reads from and writes to `github-config.json · lastSeenThreads` via the `stampLastSeen` / `getLastSeen` helpers introduced in Phase 1a. "At-bottom" detection uses an IntersectionObserver on a tail sentinel with `rootMargin: '24px'` and a 150 ms sticky window after programmatic scroll-to-tail so inertial overshoot doesn't flip state back to "scrolled up".

**Tech Stack:** TypeScript strict, React 18, Zustand 5, Tailwind v4 (Catppuccin Mocha), `react-virtuoso` (new), `@testing-library/react` + `@testing-library/user-event` + `jsdom` (new — for component tests), `electron-vite` for HMR.

**Stack order:** This PR sits on top of `feat/sidebar-data-model` (Phase 1a — provides `GitHubSectionId`, `lastSeenThreads` helpers, `stampLastSeen`/`getLastSeen` IPC) and `feat/sidebar-section-options` (Phase 1b — provides `SectionOptionsPopover` + `<ToastUndo>`). Rebase onto `feat/sidebar-section-options` before cutting the branch.

---

## File structure

- Create: `src/renderer/components/common/ScrollingFeed.tsx` — the component.
- Create: `src/renderer/components/common/ScrollingFeedTimeBucketing.ts` — pure bucket selection + divider labels.
- Create: `src/renderer/components/common/ScrollingFeedUnreadTracker.ts` — IntersectionObserver wrapper + 500 ms bulk-stamp debouncer.
- Create: `src/renderer/components/dev/ScrollingFeedHarness.tsx` — dev-only harness page with synthetic data.
- Modify: `src/renderer/stores/settingsStore.ts` — add the `feedHarness: boolean` debug flag.
- Modify: `src/renderer/components/SettingsPage.tsx` — surface the flag toggle + deep-link button.
- Modify: `src/renderer/App.tsx` — honour `#/__dev/feed` hash route when `settings.feedHarness` is on.
- Modify: `src/shared/ipc-channels.ts` — add `GITHUB_LAST_SEEN_STAMP` + `GITHUB_LAST_SEEN_GET` channels (if not introduced by Phase 1a).
- Modify: `src/preload/index.ts` — bridge the last-seen channels.
- Modify: `src/renderer/types/electron.d.ts` — type the bridge methods.
- Modify: `src/main/ipc/github-handlers.ts` — register the last-seen handlers (delegates to Phase 1a helpers).
- Modify: `package.json` — add `react-virtuoso`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`.
- Modify: `vitest.config.ts` — include `.test.tsx` files + jsdom environment per-file override.
- Create: `tests/unit/renderer/components/common/ScrollingFeedTimeBucketing.test.ts` — table-driven boundary tests.
- Create: `tests/unit/renderer/components/common/ScrollingFeedUnreadTracker.test.ts` — 500 ms debouncer behaviour.
- Create: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx` — component behaviour: sticky at-bottom, jump pill state machine, virtualisation threshold, reviewer batching.

All new TypeScript files ≤300 LOC. `ScrollingFeed.tsx` is the bulk of the PR at ~260 LOC.

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify current deps**

Run: `node -e "const p=require('./package.json');console.log('virtuoso:',p.dependencies['react-virtuoso']||'none');console.log('testing-library:',p.devDependencies['@testing-library/react']||'none')"`

Expected: both `none`. If either already present, skip that install in step 2.

- [ ] **Step 2: Install runtime + dev deps**

```bash
npm install --save react-virtuoso
npm install --save-dev @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

- [ ] **Step 3: Verify `react-virtuoso` resolves**

Run: `node -e "require.resolve('react-virtuoso')"`

Expected: exit 0. If it errors, re-run `npm install`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add react-virtuoso and @testing-library for ScrollingFeed"
```

---

### Task 2: Extend `vitest.config.ts` for component tests

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Write the new config**

Replace the entire file with:

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    // Also pick up `.test.tsx` files for React component tests. Component
    // tests opt into jsdom via `// @vitest-environment jsdom` at the top of
    // their file; default stays node for the existing main/shared tests so
    // we don't slow the suite down or break tests that assume no DOM.
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
})
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx vitest run`

Expected: PASS (no new tests yet, existing suite green).

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "chore(test): include .test.tsx in vitest for ScrollingFeed component tests"
```

---

### Task 3: Write the time-bucketing pure helpers + their tests

**Files:**
- Create: `src/renderer/components/common/ScrollingFeedTimeBucketing.ts`
- Create: `tests/unit/renderer/components/common/ScrollingFeedTimeBucketing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/components/common/ScrollingFeedTimeBucketing.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  bucketFor,
  bucketLabel,
  groupItemsByBucket,
  type TimeBucket,
} from '../../../../../src/renderer/components/common/ScrollingFeedTimeBucketing'

const NOW = new Date('2026-04-23T12:00:00Z').getTime()
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('bucketFor boundaries', () => {
  const cases: Array<{ name: string; offsetMs: number; expected: TimeBucket }> = [
    { name: '1s ago → justNow', offsetMs: 1_000, expected: 'justNow' },
    { name: '9min ago → tenMin', offsetMs: 9 * MIN, expected: 'tenMin' },
    { name: '10min ago exact → tenMin', offsetMs: 10 * MIN, expected: 'tenMin' },
    { name: '10min + 1ms → hour', offsetMs: 10 * MIN + 1, expected: 'hour' },
    { name: '59min ago → hour', offsetMs: 59 * MIN, expected: 'hour' },
    { name: '60min exact → hour', offsetMs: 60 * MIN, expected: 'hour' },
    { name: '60min + 1ms → today', offsetMs: 60 * MIN + 1, expected: 'today' },
    { name: '5 hours ago (same cal day) → today', offsetMs: 5 * HOUR, expected: 'today' },
    { name: 'yesterday 23:59 (12:00 NOW - 12h - 1min) → yesterday', offsetMs: 12 * HOUR + MIN, expected: 'yesterday' },
    { name: '2 days ago → thisWeek', offsetMs: 2 * DAY, expected: 'thisWeek' },
    { name: '6 days ago → thisWeek', offsetMs: 6 * DAY, expected: 'thisWeek' },
    { name: '7 days ago exact → thisWeek', offsetMs: 7 * DAY, expected: 'thisWeek' },
    { name: '8 days ago → older', offsetMs: 8 * DAY, expected: 'older' },
    { name: '30 days ago → older', offsetMs: 30 * DAY, expected: 'older' },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(bucketFor(NOW - c.offsetMs, NOW)).toBe(c.expected)
    })
  }
})

describe('bucketLabel', () => {
  it('returns a user-facing string per bucket', () => {
    expect(bucketLabel('justNow')).toBe('Just now')
    expect(bucketLabel('tenMin')).toBe('10 min')
    expect(bucketLabel('hour')).toBe('1 hour')
    expect(bucketLabel('today')).toBe('Today')
    expect(bucketLabel('yesterday')).toBe('Yesterday')
    expect(bucketLabel('thisWeek')).toBe('This week')
    expect(bucketLabel('older')).toBe('Older')
  })
})

describe('groupItemsByBucket', () => {
  it('groups items in ascending order and preserves input order within a bucket', () => {
    const items = [
      { id: 'a', ts: NOW - 30 * MIN },
      { id: 'b', ts: NOW - 5 * MIN },
      { id: 'c', ts: NOW - 2 * DAY },
      { id: 'd', ts: NOW - 3 * DAY },
      { id: 'e', ts: NOW - 10 * DAY },
    ]
    const groups = groupItemsByBucket(items, (x) => x.ts, NOW)
    const buckets = groups.map((g) => g.bucket)
    // Ascending order: older → newer.
    expect(buckets).toEqual(['older', 'thisWeek', 'hour', 'tenMin'])
    expect(groups.find((g) => g.bucket === 'thisWeek')!.items.map((i) => i.id)).toEqual(['c', 'd'])
  })

  it('returns an empty array when items is empty', () => {
    expect(groupItemsByBucket([], () => 0, NOW)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeedTimeBucketing.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `src/renderer/components/common/ScrollingFeedTimeBucketing.ts`:

```ts
/**
 * Pure time-bucketing used by <ScrollingFeed>. Bucket boundaries are inclusive
 * on the "more recent" side and exclusive on the "older" side, per the spec
 * ordering Just now / 10 min / 1 hour / Today / Yesterday / This week / Older.
 *
 * Kept in its own module so bucket selection is testable without jsdom or
 * React. No IO, no globals beyond `Date.now()` callers pass in explicitly.
 */

export type TimeBucket =
  | 'justNow'
  | 'tenMin'
  | 'hour'
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'older'

export const BUCKET_ORDER: readonly TimeBucket[] = [
  'older', 'thisWeek', 'yesterday', 'today', 'hour', 'tenMin', 'justNow',
] as const

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function bucketFor(ts: number, now: number): TimeBucket {
  const diff = now - ts
  if (diff < 10 * 1000) return 'justNow'
  if (diff <= 10 * MIN) return 'tenMin'
  if (diff <= 60 * MIN) return 'hour'
  // "Today" / "Yesterday" are calendar-day based, not diff-based. The user
  // expects 'Yesterday' to mean "previous calendar day" not "24 to 48 hours
  // ago". Use local calendar boundaries.
  const nowDate = new Date(now)
  const tsDate = new Date(ts)
  const nowDay = Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate())
  const tsDay = Date.UTC(tsDate.getFullYear(), tsDate.getMonth(), tsDate.getDate())
  const dayDelta = Math.floor((nowDay - tsDay) / DAY)
  if (dayDelta === 0) return 'today'
  if (dayDelta === 1) return 'yesterday'
  if (dayDelta <= 7) return 'thisWeek'
  return 'older'
}

export function bucketLabel(bucket: TimeBucket): string {
  switch (bucket) {
    case 'justNow': return 'Just now'
    case 'tenMin': return '10 min'
    case 'hour': return '1 hour'
    case 'today': return 'Today'
    case 'yesterday': return 'Yesterday'
    case 'thisWeek': return 'This week'
    case 'older': return 'Older'
  }
}

export interface BucketGroup<T> {
  bucket: TimeBucket
  items: T[]
}

/**
 * Group items into buckets in ascending order (older → newer). Within a
 * bucket, items keep their input order (the caller is expected to pass
 * them already sorted oldest-first).
 */
export function groupItemsByBucket<T>(
  items: T[],
  timestampOf: (item: T) => number,
  now: number,
): Array<BucketGroup<T>> {
  if (items.length === 0) return []
  const map = new Map<TimeBucket, T[]>()
  for (const item of items) {
    const b = bucketFor(timestampOf(item), now)
    const list = map.get(b) ?? []
    list.push(item)
    map.set(b, list)
  }
  const out: Array<BucketGroup<T>> = []
  for (const bucket of BUCKET_ORDER) {
    const list = map.get(bucket)
    if (list && list.length > 0) out.push({ bucket, items: list })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeedTimeBucketing.test.ts`

Expected: PASS (all 14 boundary cases + label + grouping).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeedTimeBucketing.ts tests/unit/renderer/components/common/ScrollingFeedTimeBucketing.test.ts
git commit -m "feat(feed): pure time-bucketing helpers for ScrollingFeed"
```

---

### Task 4: Write the unread tracker helper + its tests

**Files:**
- Create: `src/renderer/components/common/ScrollingFeedUnreadTracker.ts`
- Create: `tests/unit/renderer/components/common/ScrollingFeedUnreadTracker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/components/common/ScrollingFeedUnreadTracker.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createUnreadTracker } from '../../../../../src/renderer/components/common/ScrollingFeedUnreadTracker'

// Minimal IntersectionObserver mock that lets tests drive callbacks directly.
type IOCallback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void
let observers: Array<{ cb: IOCallback; observed: Set<Element> }>

class MockIO {
  cb: IOCallback
  observed: Set<Element> = new Set()
  constructor(cb: IOCallback) {
    this.cb = cb
    observers.push({ cb, observed: this.observed })
  }
  observe(el: Element) { this.observed.add(el) }
  unobserve(el: Element) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  takeRecords() { return [] as any[] }
}

describe('createUnreadTracker', () => {
  beforeEach(() => {
    observers = []
    ;(globalThis as any).IntersectionObserver = MockIO as unknown as typeof IntersectionObserver
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bulk-stamps all seen ids after 500 ms of inactivity', () => {
    const stamp = vi.fn()
    const tracker = createUnreadTracker({ onStamp: stamp, debounceMs: 500 })
    const el1 = document.createElement('div')
    const el2 = document.createElement('div')
    tracker.observe(el1, 'id-1')
    tracker.observe(el2, 'id-2')
    const obs = observers[0]
    obs.cb([{ target: el1, isIntersecting: true }])
    obs.cb([{ target: el2, isIntersecting: true }])
    expect(stamp).not.toHaveBeenCalled()
    vi.advanceTimersByTime(499)
    expect(stamp).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stamp).toHaveBeenCalledTimes(1)
    expect(stamp.mock.calls[0][0]).toEqual(['id-1', 'id-2'])
  })

  it('resets the debounce window on each new sighting', () => {
    const stamp = vi.fn()
    const tracker = createUnreadTracker({ onStamp: stamp, debounceMs: 500 })
    const el1 = document.createElement('div')
    const el2 = document.createElement('div')
    tracker.observe(el1, 'id-1')
    tracker.observe(el2, 'id-2')
    const obs = observers[0]
    obs.cb([{ target: el1, isIntersecting: true }])
    vi.advanceTimersByTime(400)
    obs.cb([{ target: el2, isIntersecting: true }])
    vi.advanceTimersByTime(400)
    expect(stamp).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(stamp).toHaveBeenCalledTimes(1)
    expect(new Set(stamp.mock.calls[0][0])).toEqual(new Set(['id-1', 'id-2']))
  })

  it('does not re-stamp an id that was already reported', () => {
    const stamp = vi.fn()
    const tracker = createUnreadTracker({ onStamp: stamp, debounceMs: 500 })
    const el = document.createElement('div')
    tracker.observe(el, 'id-1')
    const obs = observers[0]
    obs.cb([{ target: el, isIntersecting: true }])
    vi.advanceTimersByTime(500)
    obs.cb([{ target: el, isIntersecting: true }])
    vi.advanceTimersByTime(500)
    expect(stamp).toHaveBeenCalledTimes(1)
  })

  it('flush() stamps immediately and clears the pending set', () => {
    const stamp = vi.fn()
    const tracker = createUnreadTracker({ onStamp: stamp, debounceMs: 500 })
    const el = document.createElement('div')
    tracker.observe(el, 'id-1')
    const obs = observers[0]
    obs.cb([{ target: el, isIntersecting: true }])
    tracker.flush()
    expect(stamp).toHaveBeenCalledWith(['id-1'])
    vi.advanceTimersByTime(500)
    expect(stamp).toHaveBeenCalledTimes(1)
  })

  it('dispose() unobserves and cancels pending stamp', () => {
    const stamp = vi.fn()
    const tracker = createUnreadTracker({ onStamp: stamp, debounceMs: 500 })
    const el = document.createElement('div')
    tracker.observe(el, 'id-1')
    const obs = observers[0]
    obs.cb([{ target: el, isIntersecting: true }])
    tracker.dispose()
    vi.advanceTimersByTime(1000)
    expect(stamp).not.toHaveBeenCalled()
    expect(obs.observed.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeedUnreadTracker.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `src/renderer/components/common/ScrollingFeedUnreadTracker.ts`:

```ts
/**
 * IntersectionObserver wrapper that batches "seen" item ids and bulk-fires
 * a stamp callback after a debounce window (default 500 ms). Extracted from
 * <ScrollingFeed> so the debouncer can be exercised with fake timers and
 * without a running virtuoso.
 *
 * Usage:
 *   const tracker = createUnreadTracker({ onStamp, debounceMs: 500 })
 *   tracker.observe(el, itemId)       // call for each rendered unread row
 *   tracker.flush()                   // force-stamp e.g. on Mark-all-read
 *   tracker.dispose()                 // cleanup on unmount
 */

export interface UnreadTrackerOpts {
  onStamp: (ids: string[]) => void
  debounceMs?: number
  rootMargin?: string
}

export interface UnreadTracker {
  observe(el: Element, id: string): void
  unobserve(id: string): void
  flush(): void
  dispose(): void
}

export function createUnreadTracker(opts: UnreadTrackerOpts): UnreadTracker {
  const debounceMs = opts.debounceMs ?? 500
  const elToId = new WeakMap<Element, string>()
  const idToEl = new Map<string, Element>()
  const pending = new Set<string>()
  const alreadyStamped = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const observer = new IntersectionObserver(
    (entries) => {
      let added = false
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const id = elToId.get(entry.target)
        if (!id || alreadyStamped.has(id) || pending.has(id)) continue
        pending.add(id)
        added = true
      }
      if (!added) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(fire, debounceMs)
    },
    { rootMargin: opts.rootMargin ?? '0px' },
  )

  function fire(): void {
    timer = null
    if (pending.size === 0) return
    const ids = Array.from(pending)
    pending.clear()
    for (const id of ids) alreadyStamped.add(id)
    opts.onStamp(ids)
  }

  return {
    observe(el, id) {
      if (alreadyStamped.has(id)) return
      elToId.set(el, id)
      idToEl.set(id, el)
      observer.observe(el)
    },
    unobserve(id) {
      const el = idToEl.get(id)
      if (!el) return
      observer.unobserve(el)
      idToEl.delete(id)
      pending.delete(id)
    },
    flush() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      fire()
    },
    dispose() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      observer.disconnect()
      idToEl.clear()
      pending.clear()
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeedUnreadTracker.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeedUnreadTracker.ts tests/unit/renderer/components/common/ScrollingFeedUnreadTracker.test.ts
git commit -m "feat(feed): IntersectionObserver debouncer for unread tracking"
```

---

### Task 5: Add last-seen IPC channels + preload bridge + main handlers

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/main/ipc/github-handlers.ts`
- Create: `tests/unit/main/github-handlers-last-seen.test.ts`

> Phase 1a ships `stampLastSeen`/`getLastSeen` as internal helpers but does NOT expose them over IPC. We expose them here because `<ScrollingFeed>` needs renderer-side access. Skip this task if Phase 1a already shipped these channels.

- [ ] **Step 1: Verify channels don't already exist**

Run: `node -e "const {IPC}=require('./src/shared/ipc-channels.ts');console.log(IPC.GITHUB_LAST_SEEN_STAMP)"` — if it prints a string, skip the entire task; otherwise proceed.

Fallback: open `src/shared/ipc-channels.ts` and search for `LAST_SEEN`. If absent, continue.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/main/github-handlers-last-seen.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stampSpy = vi.fn()
const getSpy = vi.fn(() => ({ 'reviews-1:a': 1700000000000 }))
vi.mock('../../../src/main/github/github-config-store', () => ({
  stampLastSeen: (k: string, t: number) => stampSpy(k, t),
  getLastSeen: () => getSpy(),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => undefined, logError: () => undefined }))

const handlers: Record<string, (...args: any[]) => any> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { handlers[ch] = fn } },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { registerGithubLastSeenHandlers } from '../../../src/main/ipc/github-handlers'

describe('last-seen IPC', () => {
  beforeEach(() => { stampSpy.mockClear(); getSpy.mockClear(); for (const k of Object.keys(handlers)) delete handlers[k] })

  it('stamp handler writes via the config store', async () => {
    registerGithubLastSeenHandlers()
    const fn = handlers['github:lastSeen:stamp']
    const out = await fn(null, 'reviews-1:thr_a', 1_700_000_100_000)
    expect(out).toEqual({ ok: true })
    expect(stampSpy).toHaveBeenCalledWith('reviews-1:thr_a', 1_700_000_100_000)
  })

  it('stamp handler accepts a batch', async () => {
    registerGithubLastSeenHandlers()
    const fn = handlers['github:lastSeen:stampBatch']
    const out = await fn(null, [{ key: 'reviews-1:a', ts: 1 }, { key: 'reviews-1:b', ts: 2 }])
    expect(out.ok).toBe(true)
    expect(stampSpy).toHaveBeenCalledTimes(2)
  })

  it('get handler returns the full map', async () => {
    registerGithubLastSeenHandlers()
    const fn = handlers['github:lastSeen:get']
    const out = await fn()
    expect(out).toEqual({ 'reviews-1:a': 1700000000000 })
  })

  it('stamp handler rejects non-string keys', async () => {
    registerGithubLastSeenHandlers()
    const fn = handlers['github:lastSeen:stamp']
    const out = await fn(null, 42, 1)
    expect(out).toEqual({ ok: false, error: 'invalid-key' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/github-handlers-last-seen.test.ts`

Expected: FAIL — `registerGithubLastSeenHandlers` not exported.

- [ ] **Step 4: Add channel constants**

In `src/shared/ipc-channels.ts`, inside the `GitHub sidebar` group, append:

```ts
  GITHUB_LAST_SEEN_STAMP: 'github:lastSeen:stamp',
  GITHUB_LAST_SEEN_STAMP_BATCH: 'github:lastSeen:stampBatch',
  GITHUB_LAST_SEEN_GET: 'github:lastSeen:get',
```

- [ ] **Step 5: Implement the main handlers**

In `src/main/ipc/github-handlers.ts`, add:

```ts
import { stampLastSeen, getLastSeen } from '../github/github-config-store'

export function registerGithubLastSeenHandlers(): void {
  ipcMain.handle(IPC.GITHUB_LAST_SEEN_STAMP, async (_e, key: unknown, ts: unknown) => {
    if (typeof key !== 'string' || !key.includes(':')) return { ok: false, error: 'invalid-key' }
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, error: 'invalid-ts' }
    stampLastSeen(key, ts)
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_LAST_SEEN_STAMP_BATCH, async (_e, entries: unknown) => {
    if (!Array.isArray(entries)) return { ok: false, error: 'invalid-entries' }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') return { ok: false, error: 'invalid-entry' }
      const k = (entry as any).key
      const t = (entry as any).ts
      if (typeof k !== 'string' || !k.includes(':')) return { ok: false, error: 'invalid-key' }
      if (typeof t !== 'number' || !Number.isFinite(t)) return { ok: false, error: 'invalid-ts' }
      stampLastSeen(k, t)
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.GITHUB_LAST_SEEN_GET, async () => {
    return getLastSeen()
  })
}
```

Call it from the top-level `registerGithubHandlers()` (or the existing boot registration) alongside the other handler registrations.

- [ ] **Step 6: Expose via preload**

In `src/preload/index.ts`, inside the `github` bridge object, add:

```ts
      stampLastSeen: (key: string, ts: number) =>
        ipcRenderer.invoke(IPC.GITHUB_LAST_SEEN_STAMP, key, ts),
      stampLastSeenBatch: (entries: Array<{ key: string; ts: number }>) =>
        ipcRenderer.invoke(IPC.GITHUB_LAST_SEEN_STAMP_BATCH, entries),
      getLastSeen: () => ipcRenderer.invoke(IPC.GITHUB_LAST_SEEN_GET),
```

- [ ] **Step 7: Type the bridge**

In `src/renderer/types/electron.d.ts`, add to the `github` interface:

```ts
      stampLastSeen(key: string, ts: number): Promise<{ ok: boolean; error?: string }>
      stampLastSeenBatch(entries: Array<{ key: string; ts: number }>): Promise<{ ok: boolean; error?: string }>
      getLastSeen(): Promise<Record<string, number>>
```

- [ ] **Step 8: Run tests to verify green**

Run: `npx vitest run tests/unit/main/github-handlers-last-seen.test.ts`

Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add src/shared/ipc-channels.ts src/preload/index.ts src/renderer/types/electron.d.ts src/main/ipc/github-handlers.ts tests/unit/main/github-handlers-last-seen.test.ts
git commit -m "feat(feed): IPC bridge for lastSeenThreads stamp/get"
```

---

### Task 6: Skeleton `ScrollingFeed.tsx` — render items, no scroll behaviour yet

**Files:**
- Create: `src/renderer/components/common/ScrollingFeed.tsx`
- Create: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

- [ ] **Step 1: Write the first failing test**

Create `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`:

```tsx
// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ScrollingFeed } from '../../../../../src/renderer/components/common/ScrollingFeed'

// Mock react-virtuoso so it doesn't touch real DOM measurements. The feed
// falls back to plain-list rendering below the virtualize threshold, so for
// small-volume tests Virtuoso never renders anyway.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: any) => (
    <div data-testid="virtuoso">
      {(data as any[]).map((item, i) => (
        <div key={i}>{itemContent(i, item)}</div>
      ))}
    </div>
  ),
}))

;(globalThis as any).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
} as any

const items = [
  { id: 'a', ts: Date.now() - 5 * 60 * 1000, text: 'Alpha' },
  { id: 'b', ts: Date.now() - 2 * 60 * 1000, text: 'Bravo' },
]

describe('ScrollingFeed basic render', () => {
  it('renders each item via renderItem', () => {
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="reviews-1"
        renderItem={(item) => <div data-testid={`row-${item.id}`}>{item.text}</div>}
      />,
    )
    expect(screen.getByTestId('row-a')).toHaveTextContent('Alpha')
    expect(screen.getByTestId('row-b')).toHaveTextContent('Bravo')
  })

  it('renders an empty-state placeholder when items is empty', () => {
    render(
      <ScrollingFeed
        items={[]}
        keyOf={(x: any) => x.id}
        timestampOf={(x: any) => x.ts}
        sessionId="s1"
        feedId="reviews-1"
        renderItem={() => <div />}
      />,
    )
    expect(screen.getByTestId('feed-empty')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the skeleton component**

Create `src/renderer/components/common/ScrollingFeed.tsx`:

```tsx
import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { Virtuoso } from 'react-virtuoso'
import {
  bucketFor,
  bucketLabel,
  type TimeBucket,
} from './ScrollingFeedTimeBucketing'
import { createUnreadTracker, type UnreadTracker } from './ScrollingFeedUnreadTracker'

export interface ScrollingFeedProps<T> {
  items: T[]
  keyOf: (item: T) => string
  timestampOf: (item: T) => number
  sessionId: string
  feedId: string
  renderItem: (item: T, opts: { unread: boolean; isNew: boolean }) => JSX.Element
  renderDivider?: (bucket: TimeBucket) => JSX.Element
  renderCollapsedBatch?: (items: T[], reason: string) => JSX.Element
  virtualizeThreshold?: number
}

const DEFAULT_VIRTUALIZE_THRESHOLD = 100

export function ScrollingFeed<T>(props: ScrollingFeedProps<T>): JSX.Element {
  const {
    items,
    keyOf,
    timestampOf,
    sessionId: _sessionId,
    feedId: _feedId,
    renderItem,
    renderDivider,
    renderCollapsedBatch: _renderCollapsedBatch,
    virtualizeThreshold = DEFAULT_VIRTUALIZE_THRESHOLD,
  } = props

  if (items.length === 0) {
    return (
      <div data-testid="feed-empty" className="px-3 py-6 text-center text-xs text-overlay0">
        Nothing yet.
      </div>
    )
  }

  // Below-threshold fast path: plain list, no virtuoso. Keeps the DOM
  // measurement cost off the table for the common "handful of items" case.
  const virtualised = items.length >= virtualizeThreshold

  const renderedItem = useCallback(
    (item: T) => (
      <div key={keyOf(item)} data-feed-item-id={keyOf(item)}>
        {renderItem(item, { unread: false, isNew: false })}
      </div>
    ),
    [keyOf, renderItem],
  )

  if (virtualised) {
    return (
      <div className="relative flex h-full flex-col bg-base">
        <Virtuoso
          data={items}
          computeItemKey={(_idx: number, item: T) => keyOf(item)}
          itemContent={(_i: number, item: T) => renderedItem(item)}
        />
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-base">
      {items.map((item) => renderedItem(item))}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeed.tsx tests/unit/renderer/components/common/ScrollingFeed.test.tsx
git commit -m "feat(feed): skeleton ScrollingFeed with threshold-gated virtuoso"
```

---

### Task 7: Virtualisation threshold test + assertion

**Files:**
- Modify: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

- [ ] **Step 1: Add the failing test**

Append to the test file:

```tsx
describe('ScrollingFeed virtualisation threshold', () => {
  it('uses a plain list under the threshold', () => {
    const small = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, ts: Date.now(), text: `X${i}` }))
    render(
      <ScrollingFeed
        items={small}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
        virtualizeThreshold={10}
      />,
    )
    expect(screen.queryByTestId('virtuoso')).not.toBeInTheDocument()
  })

  it('switches to Virtuoso at or above the threshold', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, ts: Date.now(), text: `X${i}` }))
    render(
      <ScrollingFeed
        items={big}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
        virtualizeThreshold={10}
      />,
    )
    expect(screen.getByTestId('virtuoso')).toBeInTheDocument()
  })

  it('defaults threshold to 100', () => {
    const ninety = Array.from({ length: 90 }, (_, i) => ({ id: `x${i}`, ts: Date.now(), text: `X${i}` }))
    render(
      <ScrollingFeed
        items={ninety}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
      />,
    )
    expect(screen.queryByTestId('virtuoso')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and verify green**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: PASS (5 tests total — skeleton tests stay green).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/renderer/components/common/ScrollingFeed.test.tsx
git commit -m "test(feed): virtualisation threshold activation at 10/100 items"
```

---

### Task 8: At-bottom detection + jump-to-new pill state machine

**Files:**
- Modify: `src/renderer/components/common/ScrollingFeed.tsx`
- Modify: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```tsx
describe('ScrollingFeed at-bottom detection and jump pill', () => {
  // Drive a single shared IntersectionObserver so tests can flip sentinel
  // intersection on demand.
  let sentinelCb: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null = null
  let sentinelEl: Element | null = null

  beforeEach(() => {
    sentinelCb = null
    sentinelEl = null
    ;(globalThis as any).IntersectionObserver = class {
      cb: any
      constructor(cb: any) { this.cb = cb; sentinelCb = cb }
      observe(el: Element) { sentinelEl = el }
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    } as any
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  function makeItems(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `i${i}`, ts: Date.now() - (n - i) * 1000, text: `Row ${i}` }))
  }

  it('hides jump pill while at bottom', () => {
    render(
      <ScrollingFeed
        items={makeItems(5)}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
      />,
    )
    // Simulate sentinel intersecting (at bottom).
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: true }])
    expect(screen.queryByTestId('jump-pill')).not.toBeInTheDocument()
  })

  it('shows jump pill after scrolling away and new items arrive', async () => {
    const { rerender } = render(
      <ScrollingFeed
        items={makeItems(5)}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
      />,
    )
    // Start at bottom.
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: true }])
    // User scrolls away.
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: false }])
    // New items arrive.
    rerender(
      <ScrollingFeed
        items={makeItems(8)}
        keyOf={(x: any) => x.id}
        timestampOf={(x: any) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item: any) => <div>{item.text}</div>}
      />,
    )
    expect(screen.getByTestId('jump-pill')).toBeInTheDocument()
  })

  it('keeps at-bottom sticky for 150 ms after programmatic scroll-to-tail', () => {
    render(
      <ScrollingFeed
        items={makeItems(5)}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
      />,
    )
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: true }])
    // Simulate inertial overshoot immediately after a programmatic scroll.
    // Click the pill (even though invisible — we just care about the programmatic scroll marker).
    // Instead, simulate: sentinel briefly reports not-intersecting within 150 ms.
    // We expose an imperative marker via data-at-bottom attribute for assertion.
    const root = screen.getByTestId('feed-root')
    expect(root).toHaveAttribute('data-at-bottom', 'true')
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: false }])
    vi.advanceTimersByTime(100)
    expect(root).toHaveAttribute('data-at-bottom', 'true')
    vi.advanceTimersByTime(60)
    expect(root).toHaveAttribute('data-at-bottom', 'false')
  })

  it('clicking the jump pill scrolls to bottom and hides the pill', () => {
    const { rerender } = render(
      <ScrollingFeed
        items={makeItems(5)}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
      />,
    )
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: true }])
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: false }])
    rerender(
      <ScrollingFeed
        items={makeItems(8)}
        keyOf={(x: any) => x.id}
        timestampOf={(x: any) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item: any) => <div>{item.text}</div>}
      />,
    )
    const pill = screen.getByTestId('jump-pill')
    pill.click()
    sentinelCb?.([{ target: sentinelEl!, isIntersecting: true }])
    expect(screen.queryByTestId('jump-pill')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests — verify at-bottom tests fail**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: at-bottom tests FAIL; earlier tests still PASS.

- [ ] **Step 3: Replace the component body with scroll-aware version**

Rewrite `src/renderer/components/common/ScrollingFeed.tsx`:

```tsx
import React, { useRef, useEffect, useState, useCallback } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import {
  type TimeBucket,
} from './ScrollingFeedTimeBucketing'

export interface ScrollingFeedProps<T> {
  items: T[]
  keyOf: (item: T) => string
  timestampOf: (item: T) => number
  sessionId: string
  feedId: string
  renderItem: (item: T, opts: { unread: boolean; isNew: boolean }) => JSX.Element
  renderDivider?: (bucket: TimeBucket) => JSX.Element
  renderCollapsedBatch?: (items: T[], reason: string) => JSX.Element
  virtualizeThreshold?: number
}

const DEFAULT_VIRTUALIZE_THRESHOLD = 100
const STICKY_AT_BOTTOM_MS = 150

export function ScrollingFeed<T>(props: ScrollingFeedProps<T>): JSX.Element {
  const {
    items,
    keyOf,
    timestampOf: _timestampOf,
    sessionId: _sessionId,
    feedId: _feedId,
    renderItem,
    renderDivider: _renderDivider,
    renderCollapsedBatch: _renderCollapsedBatch,
    virtualizeThreshold = DEFAULT_VIRTUALIZE_THRESHOLD,
  } = props

  const scrollRootRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [itemCountAtLastBottom, setItemCountAtLastBottom] = useState(items.length)
  const [showJumpPill, setShowJumpPill] = useState(false)

  // Sticky window state: while in a sticky window we ignore sentinel
  // reports that would flip at-bottom to false.
  const stickyUntilRef = useRef<number>(0)

  // Attach the sentinel-based at-bottom observer. We create it once and
  // re-observe the sentinel when it remounts.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== sentinel) continue
          if (entry.isIntersecting) {
            setAtBottom(true)
            setShowJumpPill(false)
            setItemCountAtLastBottom(items.length)
          } else {
            // Ignore the flip if we're inside the sticky window.
            if (Date.now() < stickyUntilRef.current) continue
            setAtBottom(false)
          }
        }
      },
      { rootMargin: '24px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `items.length`
    // is captured here intentionally so the "at-bottom → remember count"
    // snapshot is current; we don't want to tear down / re-observe on every
    // items change.
  }, [items.length])

  // Flip the jump pill on when (not at bottom) AND (item count increased
  // since the last at-bottom snapshot).
  useEffect(() => {
    if (atBottom) return
    if (items.length > itemCountAtLastBottom) setShowJumpPill(true)
  }, [items.length, atBottom, itemCountAtLastBottom])

  const scrollToBottom = useCallback(() => {
    // Enter the sticky window BEFORE we trigger the scroll so inertial
    // overshoot during the programmatic animation doesn't flip us to
    // "scrolled up" immediately.
    stickyUntilRef.current = Date.now() + STICKY_AT_BOTTOM_MS
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: items.length - 1, behavior: 'smooth' })
    } else if (scrollRootRef.current) {
      scrollRootRef.current.scrollTo({ top: scrollRootRef.current.scrollHeight, behavior: 'smooth' })
    }
    // Proactively mark at-bottom; the sentinel will confirm shortly.
    setAtBottom(true)
    setShowJumpPill(false)
    setItemCountAtLastBottom(items.length)
  }, [items.length])

  // Re-evaluate at-bottom state after the sticky window expires. We poll
  // because IntersectionObserver doesn't re-fire if intersection didn't
  // change — if the user really did overshoot and we suppressed the flip,
  // we want the next natural report to land after stickyUntilRef elapses.
  useEffect(() => {
    if (stickyUntilRef.current === 0) return
    const handle = setTimeout(() => {
      // Force a re-read by nudging state if the sticky window has now
      // passed. We don't know the real intersection status; leave it to
      // the next IO callback.
      if (Date.now() >= stickyUntilRef.current) stickyUntilRef.current = 0
    }, STICKY_AT_BOTTOM_MS + 10)
    return () => clearTimeout(handle)
  }, [atBottom])

  if (items.length === 0) {
    return (
      <div data-testid="feed-empty" className="px-3 py-6 text-center text-xs text-overlay0">
        Nothing yet.
      </div>
    )
  }

  const virtualised = items.length >= virtualizeThreshold

  const renderedItem = (item: T) => (
    <div key={keyOf(item)} data-feed-item-id={keyOf(item)}>
      {renderItem(item, { unread: false, isNew: false })}
    </div>
  )

  return (
    <div
      data-testid="feed-root"
      data-at-bottom={String(atBottom)}
      className="relative flex h-full flex-col bg-base"
    >
      {virtualised ? (
        <Virtuoso
          ref={virtuosoRef}
          data={items}
          style={{ flex: 1 }}
          computeItemKey={(_idx, item) => keyOf(item)}
          itemContent={(_i, item) => renderedItem(item)}
        />
      ) : (
        <div ref={scrollRootRef} className="flex-1 overflow-y-auto">
          {items.map((item) => renderedItem(item))}
        </div>
      )}

      <div ref={sentinelRef} data-testid="feed-sentinel" aria-hidden="true" style={{ height: 1 }} />

      {showJumpPill && (
        <button
          type="button"
          data-testid="jump-pill"
          onClick={scrollToBottom}
          className="animate-fade-in absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-blue/40 bg-base/90 px-3 py-1 text-xs text-blue shadow-md transition-opacity duration-200 hover:bg-surface0"
        >
          {String.fromCodePoint(0x2193)} Jump to new
        </button>
      )}
    </div>
  )
}
```

Add the `animate-fade-in` keyframe to `src/renderer/styles.css` once (look for existing `@keyframes` near the top; add if not already present):

```css
@keyframes fade-in {
  from { opacity: 0; transform: translate(-50%, 4px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
.animate-fade-in { animation: fade-in 180ms ease-out; }
```

- [ ] **Step 4: Run tests — verify all green**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: PASS (at-bottom, jump-pill, sticky, click-to-scroll + prior tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeed.tsx src/renderer/styles.css tests/unit/renderer/components/common/ScrollingFeed.test.tsx
git commit -m "feat(feed): at-bottom detection, jump pill, 150ms sticky window"
```

---

### Task 9: Wire unread tracking + mark-all-read

**Files:**
- Modify: `src/renderer/components/common/ScrollingFeed.tsx`
- Modify: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```tsx
describe('ScrollingFeed unread state', () => {
  it('marks items as unread when ts > lastSeen', async () => {
    ;(window as any).electronAPI = {
      github: {
        getLastSeen: vi.fn(async () => ({ 'reviews-1': Date.now() - 60 * 60 * 1000 })),
        stampLastSeenBatch: vi.fn(async () => ({ ok: true })),
      },
    }
    const now = Date.now()
    const items = [
      { id: 'old', ts: now - 2 * 60 * 60 * 1000, text: 'old' }, // before lastSeen → read
      { id: 'new', ts: now - 30 * 60 * 1000, text: 'new' },     // after lastSeen → unread
    ]
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="reviews-1"
        renderItem={(item, { unread }) => (
          <div data-testid={`row-${item.id}`} data-unread={String(unread)}>{item.text}</div>
        )}
      />,
    )
    // getLastSeen is async — React flush.
    await vi.waitFor(() => {
      expect(screen.getByTestId('row-new')).toHaveAttribute('data-unread', 'true')
    })
    expect(screen.getByTestId('row-old')).toHaveAttribute('data-unread', 'false')
  })

  it('Mark-all-read stamps the newest timestamp and clears unread', async () => {
    const stampBatch = vi.fn(async () => ({ ok: true }))
    ;(window as any).electronAPI = {
      github: {
        getLastSeen: vi.fn(async () => ({})),
        stampLastSeenBatch: stampBatch,
      },
    }
    const now = Date.now()
    const items = [
      { id: 'a', ts: now - 3_000, text: 'a' },
      { id: 'b', ts: now - 1_000, text: 'b' },
    ]
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="reviews-1"
        renderItem={(item) => <div>{item.text}</div>}
      />,
    )
    const markAll = await screen.findByTestId('mark-all-read')
    markAll.click()
    await vi.waitFor(() => {
      expect(stampBatch).toHaveBeenCalledWith([{ key: 'reviews-1', ts: now - 1_000 }])
    })
  })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: unread tests FAIL (no `data-unread`, no `mark-all-read` button).

- [ ] **Step 3: Add unread-state logic to the component**

In `ScrollingFeed.tsx`, add near the top of the function body (after refs, before the render):

```tsx
const [lastSeen, setLastSeen] = useState<number>(0)

useEffect(() => {
  let cancelled = false
  ;(async () => {
    const map = await window.electronAPI.github.getLastSeen()
    if (cancelled) return
    setLastSeen(map[props.feedId] ?? 0)
  })()
  return () => { cancelled = true }
}, [props.feedId])

const markAllRead = useCallback(async () => {
  const newest = items.reduce((max, item) => Math.max(max, _timestampOf(item)), 0)
  if (newest === 0) return
  await window.electronAPI.github.stampLastSeenBatch([{ key: props.feedId, ts: newest }])
  setLastSeen(newest)
}, [items, _timestampOf, props.feedId])
```

Update `renderedItem` to compute unread from `lastSeen`:

```tsx
const renderedItem = (item: T) => {
  const unread = _timestampOf(item) > lastSeen
  return (
    <div key={keyOf(item)} data-feed-item-id={keyOf(item)}>
      {renderItem(item, { unread, isNew: false })}
    </div>
  )
}
```

Add the Mark-all-read button inside the feed root, above the scroll area:

```tsx
<div className="flex items-center justify-end border-b border-surface0 px-2 py-1">
  <button
    type="button"
    data-testid="mark-all-read"
    onClick={markAllRead}
    className="rounded px-2 py-0.5 text-[11px] text-subtext0 hover:bg-surface0"
  >
    Mark all read
  </button>
</div>
```

- [ ] **Step 4: Run tests — verify green**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: PASS (unread + prior tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeed.tsx tests/unit/renderer/components/common/ScrollingFeed.test.tsx
git commit -m "feat(feed): unread state via lastSeenThreads and Mark all read"
```

---

### Task 10: Scroll-into-view bulk stamp (debounced via unread tracker)

**Files:**
- Modify: `src/renderer/components/common/ScrollingFeed.tsx`
- Modify: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

- [ ] **Step 1: Write the failing test**

Append:

```tsx
describe('ScrollingFeed scroll-into-view bulk stamp', () => {
  let sentinelCb: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null
  const createdObservers: Array<{ cb: any; observed: Element[] }> = []

  beforeEach(() => {
    createdObservers.length = 0
    sentinelCb = null
    ;(globalThis as any).IntersectionObserver = class {
      cb: any
      observed: Element[] = []
      constructor(cb: any) { this.cb = cb; createdObservers.push({ cb, observed: this.observed }) }
      observe(el: Element) { this.observed.push(el) }
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    } as any
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('bulk-stamps unread items after 500 ms of sightings', async () => {
    const stampBatch = vi.fn(async () => ({ ok: true }))
    ;(window as any).electronAPI = {
      github: {
        getLastSeen: vi.fn(async () => ({})),
        stampLastSeenBatch: stampBatch,
      },
    }
    render(
      <ScrollingFeed
        items={[
          { id: 'a', ts: 1000, text: 'a' },
          { id: 'b', ts: 2000, text: 'b' },
        ]}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="reviews-1"
        renderItem={(item) => <div data-testid={`row-${item.id}`}>{item.text}</div>}
      />,
    )
    // Wait for getLastSeen to flush.
    await vi.runAllTimersAsync()
    // Per-item observer is the second one (sentinel is first).
    const perItem = createdObservers.find((o) => o !== createdObservers[0])
    expect(perItem).toBeTruthy()
    const elA = document.querySelector('[data-feed-item-id="a"]')!
    const elB = document.querySelector('[data-feed-item-id="b"]')!
    perItem!.cb([{ target: elA, isIntersecting: true }])
    perItem!.cb([{ target: elB, isIntersecting: true }])
    vi.advanceTimersByTime(499)
    expect(stampBatch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await Promise.resolve() // microtask flush
    expect(stampBatch).toHaveBeenCalledTimes(1)
    expect(stampBatch.mock.calls[0][0]).toEqual([
      { key: 'reviews-1', ts: 2000 },
    ])
  })
})
```

- [ ] **Step 2: Run it — expect failure**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: FAIL — no per-item observer yet, no stamp-on-scroll.

- [ ] **Step 3: Wire the unread tracker into the component**

In `ScrollingFeed.tsx`, add a ref and wire `createUnreadTracker`:

```tsx
const trackerRef = useRef<ReturnType<typeof createUnreadTracker> | null>(null)

useEffect(() => {
  trackerRef.current = createUnreadTracker({
    onStamp: (ids) => {
      // Find the newest timestamp across the seen ids and stamp the feed
      // under feedId. We don't stamp per-item — lastSeenThreads is a
      // feed-level high-water-mark, not per-item.
      const idToTs = new Map<string, number>()
      for (const item of items) idToTs.set(keyOf(item), _timestampOf(item))
      let newest = 0
      for (const id of ids) newest = Math.max(newest, idToTs.get(id) ?? 0)
      if (newest === 0) return
      window.electronAPI.github.stampLastSeenBatch([{ key: props.feedId, ts: newest }])
      setLastSeen((prev) => Math.max(prev, newest))
    },
    debounceMs: 500,
    rootMargin: '0px',
  })
  return () => {
    trackerRef.current?.dispose()
    trackerRef.current = null
  }
  // Deliberately don't depend on `items` — the tracker is long-lived across
  // items changes and looks up timestamps on the fly in onStamp.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [props.feedId])

// Wire per-item refs. Because Virtuoso owns DOM for virtualised lists,
// we use a ref callback in the rendered cell.
const observeItem = useCallback((el: Element | null, id: string, unread: boolean) => {
  if (!el || !unread) return
  trackerRef.current?.observe(el, id)
}, [])
```

Replace `renderedItem`:

```tsx
const renderedItem = (item: T) => {
  const id = keyOf(item)
  const unread = _timestampOf(item) > lastSeen
  return (
    <div
      key={id}
      data-feed-item-id={id}
      ref={(el) => observeItem(el, id, unread)}
    >
      {renderItem(item, { unread, isNew: false })}
    </div>
  )
}
```

- [ ] **Step 4: Run tests — verify green**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: PASS including the bulk-stamp test.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeed.tsx tests/unit/renderer/components/common/ScrollingFeed.test.tsx
git commit -m "feat(feed): bulk-stamp lastSeen on scroll-into-view via 500ms debouncer"
```

---

### Task 11: Time dividers + "Show N older" toggle

**Files:**
- Modify: `src/renderer/components/common/ScrollingFeed.tsx`
- Modify: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append:

```tsx
describe('ScrollingFeed time dividers', () => {
  it('renders a divider per non-empty bucket in ascending order', () => {
    const now = Date.now()
    const items = [
      { id: '1', ts: now - 10 * 24 * 60 * 60 * 1000, text: 'older' },
      { id: '2', ts: now - 2 * 24 * 60 * 60 * 1000, text: 'thisWeek' },
      { id: '3', ts: now - 5 * 60 * 1000, text: 'tenMin' },
    ]
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
      />,
    )
    // Older items are collapsed behind "Show N older" by default.
    expect(screen.getByTestId('show-older')).toHaveTextContent('Show 1 older')
    expect(screen.getByTestId('divider-thisWeek')).toBeInTheDocument()
    expect(screen.getByTestId('divider-tenMin')).toBeInTheDocument()
    // Older bucket not rendered until the toggle is clicked.
    expect(screen.queryByTestId('divider-older')).not.toBeInTheDocument()
  })

  it('Show N older expands the older bucket inline', () => {
    const now = Date.now()
    const items = [
      { id: '1', ts: now - 10 * 24 * 60 * 60 * 1000, text: 'older' },
      { id: '2', ts: now - 30 * 60 * 1000, text: 'hour' },
    ]
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div data-testid={`row-${item.id}`}>{item.text}</div>}
      />,
    )
    expect(screen.queryByTestId('row-1')).not.toBeInTheDocument()
    screen.getByTestId('show-older').click()
    expect(screen.getByTestId('row-1')).toBeInTheDocument()
    expect(screen.getByTestId('divider-older')).toBeInTheDocument()
  })

  it('uses the renderDivider prop override when provided', () => {
    const now = Date.now()
    const items = [{ id: '1', ts: now - 5 * 60 * 1000, text: 'x' }]
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div>{item.text}</div>}
        renderDivider={(bucket) => <div data-testid={`custom-${bucket}`}>{bucket}</div>}
      />,
    )
    expect(screen.getByTestId('custom-tenMin')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: divider tests FAIL.

- [ ] **Step 3: Integrate bucketing into rendering**

In `ScrollingFeed.tsx`:

Add import:
```ts
import { groupItemsByBucket, bucketLabel, BUCKET_ORDER } from './ScrollingFeedTimeBucketing'
```

Add state:
```tsx
const [showOlder, setShowOlder] = useState(false)
```

Replace the list-rendering section (inside the plain-list branch and the virtuoso branch) with a computed "rows" array that interleaves dividers + items + an older toggle. Introduce a helper:

```tsx
type Row<T> =
  | { kind: 'divider'; bucket: TimeBucket }
  | { kind: 'item'; item: T }
  | { kind: 'show-older'; count: number }

const rows: Array<Row<T>> = useMemo(() => {
  const groups = groupItemsByBucket(items, _timestampOf, Date.now())
  const olderGroup = groups.find((g) => g.bucket === 'older')
  const visibleGroups = showOlder
    ? groups
    : groups.filter((g) => g.bucket !== 'older')
  const out: Array<Row<T>> = []
  if (olderGroup && !showOlder) {
    out.push({ kind: 'show-older', count: olderGroup.items.length })
  }
  for (const g of visibleGroups) {
    out.push({ kind: 'divider', bucket: g.bucket })
    for (const item of g.items) out.push({ kind: 'item', item })
  }
  return out
}, [items, showOlder, _timestampOf])
```

Replace the rendering to iterate rows:

```tsx
const renderRow = (row: Row<T>): JSX.Element => {
  if (row.kind === 'divider') {
    return _renderDivider
      ? React.cloneElement(_renderDivider(row.bucket), {
          'data-testid': `divider-${row.bucket}`,
          key: `divider-${row.bucket}`,
        })
      : (
          <div
            key={`divider-${row.bucket}`}
            data-testid={`divider-${row.bucket}`}
            className="sticky top-0 z-10 bg-mantle px-3 py-1 text-[10px] uppercase tracking-wide text-overlay0"
          >
            {bucketLabel(row.bucket)}
          </div>
        )
  }
  if (row.kind === 'show-older') {
    return (
      <button
        key="show-older"
        type="button"
        data-testid="show-older"
        onClick={() => setShowOlder(true)}
        className="mx-3 my-1 rounded border border-surface0 px-3 py-1 text-xs text-subtext0 hover:bg-surface0"
      >
        Show {row.count} older
      </button>
    )
  }
  return renderedItem(row.item)
}
```

In the plain-list branch:
```tsx
{rows.map((row) => renderRow(row))}
```

In the virtuoso branch, swap `data={items}` for `data={rows}` and `itemContent` to render via `renderRow`:
```tsx
<Virtuoso
  ref={virtuosoRef}
  data={rows}
  style={{ flex: 1 }}
  computeItemKey={(_idx, row) => row.kind === 'item' ? keyOf(row.item) : row.kind === 'divider' ? `divider-${row.bucket}` : 'show-older'}
  itemContent={(_i, row) => renderRow(row)}
/>
```

Also update the virtualisation threshold check to use `items.length` (unchanged).

- [ ] **Step 4: Run tests — verify green**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: PASS including dividers.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeed.tsx tests/unit/renderer/components/common/ScrollingFeed.test.tsx
git commit -m "feat(feed): time dividers with Show N older toggle"
```

---

### Task 12: Reviewer batching — collapse consecutive same-author rows

**Files:**
- Modify: `src/renderer/components/common/ScrollingFeed.tsx`
- Modify: `tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append:

```tsx
describe('ScrollingFeed reviewer batching', () => {
  type R = { id: string; ts: number; author: string; text: string }
  function rows(n: number, author: string, start: number): R[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `${author}-${i}`, ts: start + i, author, text: `${author} ${i}`,
    }))
  }

  it('collapses 3+ consecutive items by the same author into a batch', () => {
    const items: R[] = [
      ...rows(3, 'alice', 1000),
      { id: 'bob-0', ts: 1100, author: 'bob', text: 'B' },
      ...rows(2, 'carol', 1200),
    ]
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div data-testid={`row-${item.id}`}>{item.text}</div>}
        renderCollapsedBatch={(batchItems, reason) => (
          <div data-testid={`batch-${(batchItems[0] as R).author}`}>
            {(batchItems[0] as R).author} ×{batchItems.length} ({reason})
          </div>
        )}
      />,
    )
    // Alice collapsed (3 consecutive same author).
    expect(screen.getByTestId('batch-alice')).toHaveTextContent('alice ×3')
    expect(screen.queryByTestId('row-alice-0')).not.toBeInTheDocument()
    // Bob rendered inline (not enough to batch).
    expect(screen.getByTestId('row-bob-0')).toBeInTheDocument()
    // Carol rendered inline (only 2 consecutive).
    expect(screen.getByTestId('row-carol-0')).toBeInTheDocument()
  })

  it('clicking a batch row expands its items above', () => {
    const items: R[] = rows(3, 'alice', 1000)
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div data-testid={`row-${item.id}`}>{item.text}</div>}
        renderCollapsedBatch={(batchItems) => (
          <div data-testid="batch-alice">alice ×{batchItems.length}</div>
        )}
      />,
    )
    const batch = screen.getByTestId('batch-alice')
    batch.click()
    expect(screen.getByTestId('row-alice-0')).toBeInTheDocument()
    expect(screen.getByTestId('row-alice-1')).toBeInTheDocument()
    expect(screen.getByTestId('row-alice-2')).toBeInTheDocument()
  })

  it('does NOT batch when renderCollapsedBatch is not provided', () => {
    const items: R[] = rows(5, 'alice', 1000)
    render(
      <ScrollingFeed
        items={items}
        keyOf={(x) => x.id}
        timestampOf={(x) => x.ts}
        sessionId="s1"
        feedId="f1"
        renderItem={(item) => <div data-testid={`row-${item.id}`}>{item.text}</div>}
      />,
    )
    expect(screen.getByTestId('row-alice-0')).toBeInTheDocument()
    expect(screen.getByTestId('row-alice-4')).toBeInTheDocument()
    expect(screen.queryByTestId('batch-alice')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: batching tests FAIL.

- [ ] **Step 3: Add batching to the component**

The component doesn't know about "author" — the caller conveys it via the items. We batch whenever `renderCollapsedBatch` is provided AND a helper prop decides grouping. Per spec: "collapse consecutive same-author items". We need the caller to give us an `authorOf(item)` equivalent, so we pragmatically infer it by asking the caller via an OPTIONAL `batchKeyOf` prop that defaults to "no batching".

Add to `ScrollingFeedProps`:
```ts
  batchKeyOf?: (item: T) => string
  batchThreshold?: number // default 3
```

Now extend rendering. After `groupItemsByBucket`, replace the per-bucket item loop with batched groups:

```tsx
type BatchRow<T> = { kind: 'batch'; items: T[]; reason: string }
type ItemOrBatch<T> = { kind: 'item'; item: T } | BatchRow<T>

function applyBatching<T>(
  itemsInBucket: T[],
  batchKeyOf: ((item: T) => string) | undefined,
  threshold: number,
  hasCollapseRenderer: boolean,
): Array<ItemOrBatch<T>> {
  if (!batchKeyOf || !hasCollapseRenderer) {
    return itemsInBucket.map((item) => ({ kind: 'item' as const, item }))
  }
  const out: Array<ItemOrBatch<T>> = []
  let run: T[] = []
  let runKey: string | null = null
  const flush = () => {
    if (run.length === 0) return
    if (run.length >= threshold) {
      out.push({ kind: 'batch', items: run, reason: `same-author-×${run.length}` })
    } else {
      for (const x of run) out.push({ kind: 'item', item: x })
    }
    run = []
    runKey = null
  }
  for (const item of itemsInBucket) {
    const k = batchKeyOf(item)
    if (runKey === null) { runKey = k; run = [item]; continue }
    if (k === runKey) { run.push(item); continue }
    flush()
    runKey = k
    run = [item]
  }
  flush()
  return out
}
```

Introduce expansion state:
```tsx
const [expandedBatches, setExpandedBatches] = useState<Set<string>>(() => new Set())
```

Update the rows computation:
```tsx
const rows: Array<Row<T>> = useMemo(() => {
  const groups = groupItemsByBucket(items, _timestampOf, Date.now())
  const olderGroup = groups.find((g) => g.bucket === 'older')
  const visibleGroups = showOlder ? groups : groups.filter((g) => g.bucket !== 'older')
  const out: Array<Row<T>> = []
  if (olderGroup && !showOlder) out.push({ kind: 'show-older', count: olderGroup.items.length })
  for (const g of visibleGroups) {
    out.push({ kind: 'divider', bucket: g.bucket })
    const batched = applyBatching(
      g.items,
      props.batchKeyOf,
      props.batchThreshold ?? 3,
      Boolean(_renderCollapsedBatch),
    )
    for (const entry of batched) {
      if (entry.kind === 'item') {
        out.push({ kind: 'item', item: entry.item })
      } else {
        // stable batch key — concatenates the first item's key.
        const batchId = `batch-${keyOf(entry.items[0])}-${entry.items.length}`
        if (expandedBatches.has(batchId)) {
          for (const inner of entry.items) out.push({ kind: 'item', item: inner })
        } else {
          out.push({ kind: 'batch', batchId, items: entry.items, reason: entry.reason })
        }
      }
    }
  }
  return out
}, [items, showOlder, _timestampOf, props.batchKeyOf, props.batchThreshold, _renderCollapsedBatch, expandedBatches, keyOf])
```

Extend `Row<T>`:
```ts
type Row<T> =
  | { kind: 'divider'; bucket: TimeBucket }
  | { kind: 'item'; item: T }
  | { kind: 'show-older'; count: number }
  | { kind: 'batch'; batchId: string; items: T[]; reason: string }
```

Extend `renderRow`:
```tsx
if (row.kind === 'batch') {
  const inner = _renderCollapsedBatch!(row.items, row.reason)
  return (
    <button
      key={row.batchId}
      type="button"
      onClick={() => setExpandedBatches((prev) => new Set(prev).add(row.batchId))}
      className="block w-full text-left"
    >
      {inner}
    </button>
  )
}
```

Extend the virtuoso `computeItemKey`:
```tsx
computeItemKey={(_idx, row) =>
  row.kind === 'item' ? keyOf(row.item)
  : row.kind === 'divider' ? `divider-${row.bucket}`
  : row.kind === 'batch' ? row.batchId
  : 'show-older'
}
```

- [ ] **Step 4: Run tests — verify green**

Run: `npx vitest run tests/unit/renderer/components/common/ScrollingFeed.test.tsx`

Expected: PASS all tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ScrollingFeed.tsx tests/unit/renderer/components/common/ScrollingFeed.test.tsx
git commit -m "feat(feed): reviewer batching with expand-on-click"
```

---

### Task 13: Debug flag on settingsStore + harness route

**Files:**
- Modify: `src/renderer/stores/settingsStore.ts`
- Modify: `src/renderer/components/SettingsPage.tsx`

- [ ] **Step 1: Add the flag to settingsStore**

Locate the settings shape (search for `debugMode: false`). Next to it add:

```ts
  feedHarness: false,
```

In the type/interface a few lines up:

```ts
  feedHarness: boolean
```

- [ ] **Step 2: Surface the toggle + link in SettingsPage**

In `SettingsPage.tsx`, find the `general` tab's debug section (near the existing `debugMode` toggle). Underneath it, add:

```tsx
<div className="mt-3 flex items-center justify-between">
  <label className="text-sm text-subtext0">ScrollingFeed harness (dev)</label>
  <button
    type="button"
    onClick={() => save({ feedHarness: !settings.feedHarness })}
    className={`relative h-6 w-11 rounded-full transition-colors ${
      settings.feedHarness ? 'bg-green' : 'bg-surface1'
    }`}
  >
    <span
      className={`absolute top-1 block h-4 w-4 rounded-full bg-base transition-transform ${
        settings.feedHarness ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
</div>
{settings.feedHarness && (
  <div className="mt-2 rounded border border-surface0 bg-mantle p-2 text-xs text-subtext0">
    Harness enabled. Navigate to{' '}
    <a
      href="#/__dev/feed"
      className="text-blue underline"
      onClick={(e) => { e.preventDefault(); window.location.hash = '#/__dev/feed' }}
    >
      #/__dev/feed
    </a>{' '}
    to open the ScrollingFeed harness.
  </div>
)}
```

- [ ] **Step 3: Smoke-check**

Run: `npm run dev`

Open Settings → General, scroll to the debug region. Verify the toggle appears and persists across reload.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/stores/settingsStore.ts src/renderer/components/SettingsPage.tsx
git commit -m "feat(feed): Settings toggle for ScrollingFeed harness"
```

---

### Task 14: `ScrollingFeedHarness` dev route

**Files:**
- Create: `src/renderer/components/dev/ScrollingFeedHarness.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Write the harness**

Create `src/renderer/components/dev/ScrollingFeedHarness.tsx`:

```tsx
import React, { useState, useCallback } from 'react'
import { ScrollingFeed } from '../common/ScrollingFeed'

interface SyntheticItem {
  id: string
  ts: number
  author: string
  text: string
}

const AUTHORS = ['alice', 'bob', 'carol', 'dan', 'eve']

function synth(n: number, startTs: number, idOffset: number): SyntheticItem[] {
  return Array.from({ length: n }, (_, i) => {
    const ts = startTs + i * 60_000
    const author = AUTHORS[(idOffset + i) % AUTHORS.length]
    return {
      id: `synthetic-${idOffset + i}`,
      ts,
      author,
      text: `[${author}] Row ${idOffset + i} at ${new Date(ts).toLocaleTimeString()}`,
    }
  })
}

export function ScrollingFeedHarness(): JSX.Element {
  const [items, setItems] = useState<SyntheticItem[]>(() => synth(20, Date.now() - 20 * 60_000, 0))

  const addOne = useCallback(() => {
    setItems((prev) => [...prev, ...synth(1, Date.now(), prev.length)])
  }, [])

  const add200 = useCallback(() => {
    setItems((prev) => [...prev, ...synth(200, Date.now(), prev.length)])
  }, [])

  const reset = useCallback(() => {
    setItems(synth(20, Date.now() - 20 * 60_000, 0))
  }, [])

  return (
    <div
      data-harness="true"
      className="flex h-screen flex-col bg-base text-text"
    >
      <div className="flex items-center gap-2 border-b border-surface0 bg-mantle px-3 py-2">
        <div className="text-sm text-subtext0">ScrollingFeed harness</div>
        <span className="text-xs text-overlay0">items: {items.length}</span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={addOne}
            className="rounded border border-surface0 px-2 py-1 text-xs text-subtext0 hover:bg-surface0"
          >
            Add 1 item
          </button>
          <button
            type="button"
            onClick={add200}
            className="rounded border border-surface0 px-2 py-1 text-xs text-subtext0 hover:bg-surface0"
          >
            Add 200 items
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded border border-surface0 px-2 py-1 text-xs text-subtext0 hover:bg-surface0"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <ScrollingFeed<SyntheticItem>
          items={items}
          keyOf={(x) => x.id}
          timestampOf={(x) => x.ts}
          sessionId="harness-session"
          feedId="harness-feed"
          batchKeyOf={(x) => x.author}
          renderItem={(item, { unread }) => (
            <div
              className={`border-b border-surface0 px-3 py-2 text-sm ${
                unread ? 'bg-surface0/30 text-text' : 'text-subtext0'
              }`}
            >
              {unread && <span className="mr-2 inline-block h-2 w-2 rounded-full bg-blue" />}
              {item.text}
            </div>
          )}
          renderCollapsedBatch={(batch) => (
            <div className="border-b border-surface0 bg-surface0/50 px-3 py-2 text-sm text-subtext0">
              {String.fromCodePoint(0x2026)} {(batch[0] as SyntheticItem).author} wrote{' '}
              {batch.length} items
            </div>
          )}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the hash route in App.tsx**

Open `src/renderer/App.tsx`. Above the main render, add a tiny hash-router check:

```tsx
import { ScrollingFeedHarness } from './components/dev/ScrollingFeedHarness'
// ...
const [hashRoute, setHashRoute] = useState(() => window.location.hash)
useEffect(() => {
  const onChange = () => setHashRoute(window.location.hash)
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}, [])

const feedHarness = useSettingsStore((s) => s.settings.feedHarness)
if (feedHarness && hashRoute === '#/__dev/feed') {
  return <ScrollingFeedHarness />
}
```

(Place the early return before the normal App layout renders.)

- [ ] **Step 3: Smoke-test**

Run: `npm run dev`

1. Toggle feedHarness on in Settings.
2. Click the link (or manually set `window.location.hash = '#/__dev/feed'`).
3. Verify 20 items render, "Add 1", "Add 200", "Reset" work.
4. Add 200 items; verify you see the virtuoso switch (DOM row count stays ~viewport-bound).
5. Scroll to the middle; verify jump-pill appears on new items.
6. Verify time dividers + author batching (where applicable) render.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/dev/ScrollingFeedHarness.tsx src/renderer/App.tsx
git commit -m "feat(feed): dev-only ScrollingFeed harness route"
```

---

### Task 15: Typecheck + full test run + PR

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`

Expected: PASS. If `react-virtuoso` types complain, add `import type { VirtuosoHandle } from 'react-virtuoso'` where used.

- [ ] **Step 2: Full test run**

Run: `npx vitest run`

Expected: all tests green (new bucketing, tracker, component, last-seen IPC + existing suite).

- [ ] **Step 3: Build installer for smoke**

Run: `npm run package:win`

Expected: `dist/ClaudeCommandCenter-1.3.1.exe` rebuilds cleanly.

- [ ] **Step 4: Manual smoke on installer**

Repeat the Task 14 Step 3 checks on the installed app. Verify no console errors in DevTools.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feat/scrolling-feed
gh pr create --title "sidebar 1c: ScrollingFeed shared component" --body "$(cat <<'EOF'
## Summary
- New `<ScrollingFeed>` generic component at `src/renderer/components/common/ScrollingFeed.tsx` with: sticky at-bottom detection (150 ms after programmatic scroll-to-tail), jump-to-new pill, time-bucket dividers, "Show N older" toggle, per-item unread via `lastSeenThreads`, 500 ms debounced bulk-stamp on scroll-into-view, mark-all-read button, reviewer batching (opt-in via `renderCollapsedBatch` + `batchKeyOf`), and virtuoso-backed virtualisation past `virtualizeThreshold` (default 100).
- Pure helpers `ScrollingFeedTimeBucketing.ts` and `ScrollingFeedUnreadTracker.ts` for testability.
- New IPC channels for `lastSeenThreads` stamp/get (bridged via preload to the Phase 1a helpers).
- Dev-only harness at `#/__dev/feed` gated by a `feedHarness` flag in Settings → General. Renders ScrollingFeed against 3-button synthetic data.
- Not yet wired to Reviews/Notifications/Live Activity — that lands in Phase 2 (`feat/sidebar-easy-wins`) and Phase 4 (`feat/sidebar-hooks-dependent`).

## Test plan
- [x] Pure bucketing: 14 boundary cases + label map + group-order.
- [x] Unread tracker: 500 ms debounce, reset-on-sighting, already-stamped idempotence, flush, dispose.
- [x] Component: basic render, empty state, virtualisation threshold at 10/100, at-bottom sentinel, jump pill on new items, 150 ms sticky window, click-to-scroll hides pill, unread computed from lastSeen, mark-all-read stamps newest ts, bulk stamp on scroll-into-view (500 ms), dividers per non-empty bucket, Show N older expand, renderDivider override, reviewer batching at threshold 3, expand on click, no-batch when renderCollapsedBatch absent.
- [x] `npm run typecheck` green.
- [x] Manual smoke on installer: harness route renders; Add 1 / Add 200 / Reset behave; virtuoso engages past 100; jump pill works; unread persists across reload.
EOF
)"
```

---

## Self-review checklist

- [ ] Every task has exact file paths.
- [ ] Every code step shows the full code to write.
- [ ] Every test has expected failure / expected pass.
- [ ] `react-virtuoso` installed as dependency (not devDependency) so production bundle includes it.
- [ ] `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` are devDependencies.
- [ ] No `react-window` anywhere — explicitly ruled out by the spec.
- [ ] No `\u{...}` Unicode escapes — used `String.fromCodePoint(0x2193)` for the pill arrow, `0x2026` for the ellipsis.
- [ ] No em dashes in user-facing strings (`Jump to new`, `Show N older`, `Mark all read`, `Nothing yet.`, `ScrollingFeed harness (dev)`).
- [ ] Zustand selectors use the `useStore((s) => s.x)` shape (`useSettingsStore((s) => s.settings.feedHarness)`).
- [ ] No default exports from new `.ts`/`.tsx` files except where the file's sole export is a React component (not used here — we named-export the component to match the convention).
- [ ] Dev harness root has `data-harness="true"` for e2e distinguishability.
- [ ] Tailwind classes use only Catppuccin tokens already in the theme (`base`, `mantle`, `surface0`, `surface1`, `subtext0`, `overlay0`, `blue`, `green`, `text`).
- [ ] Fade-in animation respects 150–300 ms bound (180 ms).
- [ ] Component does NOT import any Node module; all IO flows through `window.electronAPI`.
- [ ] Spec deviation: the spec describes "collapse consecutive same-author items" without exposing how the feed knows the author; I added an optional `batchKeyOf` prop so the caller supplies that. Batching activates only when BOTH `renderCollapsedBatch` AND `batchKeyOf` are provided. Noted in the PR body.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
