// src/renderer/hooks/useWindowedTurns.ts
//
// GB-safe windowed pager for a transcript slot. The real store has held a
// 1.25 GB transcript — we must NEVER mount the whole thing. This hook keeps at
// most `MAX_PAGES` pages (each `PAGE_SIZE` messages) in memory at once: the
// visible page plus one above and one below. Scrolling past a boundary loads
// the next page and DROPS the far page, so memory stays flat regardless of how
// large the transcript is.
//
// Ownership split (kept testable):
//   - this HOOK owns data: which pages are mounted, the follow flag, loading.
//   - the COMPONENT owns DOM/scroll: it calls `loadOlder()` when its scroll-top
//     sentinel fires, `setFollow(atBottom)` from scroll position, and reads
//     `prependToken` to restore scroll position after an older page prepends.
//
// Pages are keyed by a monotonic integer where HIGHER = NEWER. The tail page is
// index 0; older loads go to -1, -2, …; a live-follow refresh re-reads page 0.
// `messages` is the mounted pages flattened in (run.startedAt, idx) order with
// (runId, idx) dedup so a boundary message is never double-rendered.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** One stitched transcript message (shape mirrors `logs2:readMessages`). */
export interface Logs2Message {
  runId: number
  idx: number
  ts: number
  role: string
  kind: string
  content: string
  toolName: string | null
  toolMeta: string | null
}

/** Read-scope for a slot: a whole config, or a single session instance. */
export type Logs2Scope = { configId: string } | { sessionId: string }

/** Messages per page; ≤3 pages mounted at any time. */
export const PAGE_SIZE = 100
/** Visible page + one above + one below. */
export const MAX_PAGES = 3

export interface WindowedTurns {
  /** Mounted pages flattened in global order, deduped by (runId, idx). */
  messages: Logs2Message[]
  /** Number of pages currently mounted (≤ MAX_PAGES). */
  pageCount: number
  /** True when pinned to the tail (live pushes append). */
  follow: boolean
  /** Initial / jump load in flight. */
  loading: boolean
  /** Older-page load in flight (scroll-top sentinel). */
  loadingOlder: boolean
  /** Last read error, or null. */
  error: Error | null
  /** Set the follow flag (component reports at-bottom from scroll position). */
  setFollow: (v: boolean) => void
  /** Load the next OLDER page (anchor = oldest mounted cursor, dir 'older'). */
  loadOlder: () => Promise<void>
  /** Reload a window centered on a target turn; turns follow OFF. */
  jumpTo: (target: { runId: number; idx: number }) => Promise<void>
  /**
   * Increments every time an OLDER page is prepended. The component watches
   * this in a layout effect to preserve scroll position (add the new content's
   * height to scrollTop so the viewport doesn't jump).
   */
  prependToken: number
  /**
   * The most-recent jump target (a search-hit or timeline-rail click), or null
   * before the first jump. The `nonce` increments on EVERY jump so the view
   * re-fires its scroll-into-view + highlight even when two jumps land on the
   * same (runId, idx) — `jumpTo` already loads a window that BEGINS at the
   * target, but it never told the view where the target row is.
   */
  jumpTarget: { runId: number; idx: number; nonce: number } | null
}

type ReadAnchor = 'tail' | { runId: number; idx: number }

function scopeKey(scope: Logs2Scope): string {
  return 'configId' in scope ? `c:${scope.configId}` : `s:${scope.sessionId}`
}

/** Does a live push (by sessionId/configId) belong to this scope? */
function pushMatchesScope(
  scope: Logs2Scope,
  e: { sessionId: string; configId: string | null },
): boolean {
  if ('sessionId' in scope) return e.sessionId === scope.sessionId
  return e.configId === scope.configId
}

function msgKey(m: Logs2Message): string {
  return `${m.runId}:${m.idx}`
}

/**
 * Windowed transcript pager. Pass a stable-ish scope; the hook re-initializes
 * (reloads at tail) whenever the scope identity changes.
 */
export function useWindowedTurns(scope: Logs2Scope): WindowedTurns {
  // pages: monotonic index → page messages. Higher index = newer. Tail = 0.
  const [pages, setPages] = useState<Map<number, Logs2Message[]>>(() => new Map())
  const [follow, setFollowState] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [prependToken, setPrependToken] = useState(0)
  // The target a search-hit / rail jump last landed on, surfaced to the view so
  // it can scroll the row into view + flash it (null until the first jump).
  const [jumpTarget, setJumpTarget] = useState<{ runId: number; idx: number; nonce: number } | null>(null)

  // Refs that the async callbacks read so they don't capture stale closures and
  // so concurrent loads can be guarded without re-subscribing effects.
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const followRef = useRef(follow)
  followRef.current = follow
  const loadingOlderRef = useRef(false)
  // A generation token: bumped on every (re)initialization so a late-resolving
  // read from a previous scope/jump cannot clobber the current window.
  const genRef = useRef(0)
  // Monotonic id stamped on each jumpTarget so a repeat jump to the SAME target
  // still changes identity and re-triggers the view's scroll + highlight.
  const jumpNonceRef = useRef(0)

  const sk = scopeKey(scope)
  // Hold the latest scope in a ref so `read` stays identity-stable per scope key
  // (re-created only when `sk` changes) without depending on the scope object's
  // referential identity, which a caller may recreate every render.
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const read = useCallback(
    (anchor: ReadAnchor, dir?: 'older' | 'newer'): Promise<Logs2Message[]> => {
      return window.electronAPI.logs2.readMessages({
        scope: scopeRef.current,
        anchor,
        ...(dir ? { dir } : {}),
        limit: PAGE_SIZE,
      })
    },
    // re-create when the scope identity (key) changes; scope read via ref.
    [sk],
  )

  // ---- Initial load (tail) + re-init on scope change -----------------------
  useEffect(() => {
    const myGen = ++genRef.current
    setLoading(true)
    setError(null)
    setFollowState(true)
    followRef.current = true
    setPages(new Map())
    // Clear any stale jump target so a new scope can't inherit the prior one's
    // (runId, idx) — they are per-transcript, not globally unique. This keeps the
    // jump machinery's reset consistent with the pages/follow/loading resets.
    setJumpTarget(null)
    let cancelled = false
    read('tail')
      .then((tail) => {
        if (cancelled || genRef.current !== myGen) return
        const next = new Map<number, Logs2Message[]>()
        next.set(0, tail)
        setPages(next)
      })
      .catch((e) => {
        if (cancelled || genRef.current !== myGen) return
        setError(e instanceof Error ? e : new Error(String(e)))
        setPages(new Map())
      })
      .finally(() => {
        if (cancelled || genRef.current !== myGen) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `read` is identity-stable per scope key (`sk`), so this re-runs exactly
    // when the scope changes — the intended re-init trigger.
  }, [read])

  // ---- Live follow: subscribe to LOGS2_NEW_MESSAGES ------------------------
  useEffect(() => {
    const unsub = window.electronAPI.logs2.onNewMessages((e) => {
      if (!pushMatchesScope(scopeRef.current, e)) return
      if (!followRef.current) return // scrolled up — don't yank the user down
      const myGen = genRef.current
      // Refresh the tail page (page index 0). New turns extend it; we re-read
      // 'tail' so /clear & relaunch dividers from the worker land correctly.
      read('tail')
        .then((tail) => {
          if (genRef.current !== myGen) return
          if (!followRef.current) return
          setPages((prev) => {
            const next = new Map(prev)
            next.set(0, tail)
            // Following means the tail page is the newest mounted; enforce cap
            // by dropping the OLDEST (lowest index) page if we somehow exceed.
            enforceCapNewest(next)
            return next
          })
        })
        .catch(() => {
          /* transient; the next push retries */
        })
    })
    return unsub
    // Re-subscribe only when the scope key changes (via the stable `read`).
  }, [read])

  // ---- Scroll-top: load the next OLDER page --------------------------------
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return
    const cur = pagesRef.current
    if (cur.size === 0) return
    const indices = [...cur.keys()].sort((a, b) => a - b)
    const lowest = indices[0]
    const oldestPage = cur.get(lowest)!
    if (oldestPage.length === 0) return
    const oldestMsg = oldestPage[0]
    // Already at the very start? a full-page read that returns < PAGE_SIZE means
    // the top is near; a zero-length older read means we've hit the start.
    loadingOlderRef.current = true
    setLoadingOlder(true)
    const myGen = genRef.current
    try {
      const older = await read({ runId: oldestMsg.runId, idx: oldestMsg.idx }, 'older')
      if (genRef.current !== myGen) return
      if (older.length === 0) return // reached the start; nothing to prepend
      setPages((prev) => {
        const next = new Map(prev)
        next.set(lowest - 1, older)
        // Prepending → if we exceed the cap, drop the NEWEST (highest) page so
        // the window stays ≤ MAX_PAGES and memory stays flat.
        enforceCapOldest(next)
        return next
      })
      // Signal the component to preserve scroll position on this prepend.
      setPrependToken((t) => t + 1)
    } finally {
      if (genRef.current === myGen) setLoadingOlder(false)
      loadingOlderRef.current = false
    }
  }, [read])

  // ---- Rail jump: reload a window that CONTAINS the target -----------------
  const jumpTo = useCallback(
    async (target: { runId: number; idx: number }) => {
      const myGen = ++genRef.current // invalidate any in-flight reads
      setFollowState(false)
      followRef.current = false
      // Surface the target so the view can scroll to + flash the exact row once
      // the centered window settles. Stamp a fresh nonce every time.
      setJumpTarget({ runId: target.runId, idx: target.idx, nonce: ++jumpNonceRef.current })
      setLoading(true)
      setError(null)
      try {
        // The backend has NO centered read: 'older'/'newer' are STRICTLY exclusive
        // of the anchor tuple (transcripts-db.ts readMessagesPage). To get a page
        // that BEGINS AT the target we anchor the forward read at idx-1 with
        // dir:'newer' — the first row strictly after (runId, idx-1) within the
        // same run is exactly (runId, idx), the target. (idx-1 = -1 when idx===0
        // is fine: the first row after idx:-1 is idx:0; the DB resolves the run's
        // startedAt from runId for the tuple compare regardless of idx.)
        const [forward, older] = await Promise.all([
          read({ runId: target.runId, idx: target.idx - 1 }, 'newer'),
          read({ runId: target.runId, idx: target.idx }, 'older'),
        ])
        if (genRef.current !== myGen) return
        const next = new Map<number, Logs2Message[]>()
        // The forward page (target-first) is page 0; the older page below it (-1).
        next.set(0, forward)
        if (older.length > 0) next.set(-1, older)
        setPages(next)
      } catch (e) {
        if (genRef.current !== myGen) return
        setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (genRef.current === myGen) setLoading(false)
      }
    },
    [read],
  )

  const setFollow = useCallback((v: boolean) => {
    setFollowState(v)
    followRef.current = v
  }, [])

  // ---- Flatten mounted pages in global order, deduped ----------------------
  const messages = useMemo(() => {
    // Pages arrive PRE-ORDERED from the DB (stitched order = runs by
    // (startedAt, runId), messages by idx) and are mounted by a monotonic page
    // index (older = more negative, tail = 0, newer = positive). Mounted pages
    // are contiguous and non-overlapping, so concatenating them in page-index
    // order yields correct GLOBAL order — we must NOT re-sort by (runId, idx),
    // which would disagree with the DB's (startedAt, runId, idx) key for
    // backdated/imported runs. Dedup by (runId, idx) keeping the first occurrence
    // guards the jump-window overlap case (a forward page anchored at idx-1 and
    // an older page anchored at idx can share no rows, but live-follow + prepend
    // boundaries can still touch).
    const indices = [...pages.keys()].sort((a, b) => a - b)
    const out: Logs2Message[] = []
    const seen = new Set<string>()
    for (const i of indices) {
      const page = pages.get(i)!
      for (const m of page) {
        const k = msgKey(m)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(m)
      }
    }
    return out
  }, [pages])

  return {
    messages,
    pageCount: pages.size,
    follow,
    loading,
    loadingOlder,
    error,
    setFollow,
    loadOlder,
    jumpTo,
    prependToken,
    jumpTarget,
  }
}

/** Drop the NEWEST (highest-index) page(s) until ≤ MAX_PAGES (used on prepend). */
function enforceCapOldest(map: Map<number, Logs2Message[]>): void {
  while (map.size > MAX_PAGES) {
    const indices = [...map.keys()].sort((a, b) => a - b)
    const highest = indices[indices.length - 1]
    map.delete(highest)
  }
}

/** Drop the OLDEST (lowest-index) page(s) until ≤ MAX_PAGES (used on append). */
function enforceCapNewest(map: Map<number, Logs2Message[]>): void {
  while (map.size > MAX_PAGES) {
    const indices = [...map.keys()].sort((a, b) => a - b)
    const lowest = indices[0]
    map.delete(lowest)
  }
}
