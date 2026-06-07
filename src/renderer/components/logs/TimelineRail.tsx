// src/renderer/components/logs/TimelineRail.tsx
//
// Layout C sidebar: a vertical rail that gives a bird's-eye view of the entire
// transcript. It self-fetches `turnSummary` (a lightweight per-turn index) for
// the given scope, decimates into at most 2000 coloured cells, and renders
// overlay markers for clear/relaunch dividers, search hits, and the current
// viewport window.
//
// Clicking a cell fires `onJump({ runId, idx })` — the first turn of that
// bucket — which the parent wires to `win.jumpTo` from useWindowedTurns.
//
// NOTE: `turnSummary` is a *separate* lightweight query from `readMessages`;
// self-fetching here does NOT duplicate the transcript pager hook.

import { useEffect, useRef, useState } from 'react'
import type { Logs2Scope } from '../../hooks/useWindowedTurns'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a single turnSummary item (mirrors electron.d.ts logs2.turnSummary). */
export interface TurnSummaryItem {
  runId: number
  idx: number
  role: string
  kind: 'message' | 'tool_call' | 'clear' | 'sidechain' | 'unknown' | 'relaunch'
  ts: number
  toolName: string | null
}

/** One decimated bucket. */
export interface RailBucket {
  /** All turns that collapsed into this bucket. */
  turns: TurnSummaryItem[]
  /** The first turn of the bucket — used as the jump target. */
  firstTurn: TurnSummaryItem
  /** Dominant kind (most frequent) among this bucket's turns. */
  dominantKind: TurnSummaryItem['kind']
}

/** Jump target type that exactly matches useWindowedTurns.jumpTo argument. */
export type JumpTarget = { runId: number; idx: number }

// ---------------------------------------------------------------------------
// Pure decimation helper (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Collapse `turns` into at most `maxCells` buckets. When `turns.length <=
 * maxCells` each turn gets its own cell. Otherwise `ceil(n / maxCells)` turns
 * are grouped per bucket and the dominant kind is selected by majority vote.
 *
 * Returns [] for empty input.
 */
export function decimateTurns(turns: TurnSummaryItem[], maxCells = 2000): RailBucket[] {
  if (turns.length === 0) return []

  const bucketSize = turns.length <= maxCells ? 1 : Math.ceil(turns.length / maxCells)
  const numBuckets = Math.ceil(turns.length / bucketSize)
  const buckets: RailBucket[] = []

  for (let b = 0; b < numBuckets; b++) {
    const start = b * bucketSize
    const slice = turns.slice(start, start + bucketSize)

    // Dominant kind: frequency count → pick the kind with the highest count;
    // on tie, the first encountered wins (stable since JS objects retain
    // insertion order for string keys and kind iteration is index order).
    const freq: Partial<Record<TurnSummaryItem['kind'], number>> = {}
    for (const t of slice) {
      freq[t.kind] = (freq[t.kind] ?? 0) + 1
    }
    let dominantKind: TurnSummaryItem['kind'] = slice[0].kind
    let max = 0
    for (const [k, count] of Object.entries(freq) as [TurnSummaryItem['kind'], number][]) {
      if (count > max) {
        max = count
        dominantKind = k
      }
    }

    buckets.push({ turns: slice, firstTurn: slice[0], dominantKind })
  }

  return buckets
}

// ---------------------------------------------------------------------------
// Colour mapping (Catppuccin / theme tokens — no \u{} in JSX)
// ---------------------------------------------------------------------------

/** Returns a CSS colour string for a rail cell's dominant kind. */
function kindToColour(kind: TurnSummaryItem['kind']): string {
  switch (kind) {
    case 'message':
      return 'var(--text-secondary)'
    case 'tool_call':
      return 'var(--color-peach)'
    case 'sidechain':
      return 'var(--text-muted)'
    case 'clear':
    case 'relaunch':
      return 'var(--color-sapphire)'
    case 'unknown':
    default:
      return 'var(--text-muted)'
  }
}

// ---------------------------------------------------------------------------
// Marker computation helpers
// ---------------------------------------------------------------------------

/**
 * Map a (runId, idx) pair to a bucket index in the decimated rail.
 *
 * Matches on BOTH runId AND idx so that, in a configId scope where turnSummary
 * returns turns from multiple runs each starting at idx=0, a hit for
 * {runId:2, idx:5} cannot collide with run-1's idx=5.
 *
 * Returns -1 when the turn is not found; callers should skip -1 markers.
 */
export function idxToBucket(
  runId: number,
  idx: number,
  turns: TurnSummaryItem[],
  numBuckets: number,
): number {
  if (turns.length === 0 || numBuckets === 0) return -1
  const bucketSize = Math.ceil(turns.length / numBuckets)
  const pos = turns.findIndex((t) => t.runId === runId && t.idx === idx)
  if (pos < 0) return -1
  return Math.min(Math.floor(pos / bucketSize), numBuckets - 1)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SearchHit {
  runId: number
  idx: number
}

export interface ViewportRange {
  startRunId: number
  startIdx: number
  endRunId: number
  endIdx: number
}

export interface TimelineRailProps {
  scope: Logs2Scope
  onJump: (target: JumpTarget) => void
  searchHits?: SearchHit[]
  viewportRange?: ViewportRange
  className?: string
}

const MAX_CELLS = 2000

export default function TimelineRail({
  scope,
  onJump,
  searchHits,
  viewportRange,
  className,
}: TimelineRailProps) {
  const [turns, setTurns] = useState<TurnSummaryItem[]>([])
  const [error, setError] = useState(false)

  // Stable scope key so the effect re-runs only when the scope identity changes.
  const scopeKey = 'configId' in scope ? `c:${scope.configId}` : `s:${scope.sessionId}`
  // Hold the scope in a ref so the effect callback reads the latest value without
  // needing it in the dependency array (avoids re-running on every object identity change).
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  useEffect(() => {
    let cancelled = false
    setError(false)
    window.electronAPI.logs2
      .turnSummary({ scope: scopeRef.current })
      .then((data) => {
        if (!cancelled) setTurns(data as TurnSummaryItem[])
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
    // Re-fetch when the scope identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const buckets = decimateTurns(turns, MAX_CELLS)
  const numBuckets = buckets.length

  // --- Search hit markers (deduped by bucket index) ---
  const hitBuckets = new Set<number>()
  if (searchHits && numBuckets > 0) {
    for (const hit of searchHits) {
      const b = idxToBucket(hit.runId, hit.idx, turns, numBuckets)
      if (b >= 0) hitBuckets.add(b)
    }
  }

  // --- Viewport highlight (start/end bucket indices) ---
  let vpStart = -1
  let vpEnd = -1
  if (viewportRange && numBuckets > 0) {
    vpStart = idxToBucket(viewportRange.startRunId, viewportRange.startIdx, turns, numBuckets)
    vpEnd = idxToBucket(viewportRange.endRunId, viewportRange.endIdx, turns, numBuckets)
    // Graceful fallback: if an end isn't found (-1) keep the sentinel and skip rendering
  }

  if (error && numBuckets === 0) {
    // Graceful: render nothing on error
    return null
  }

  return (
    <div
      data-testid="timeline-rail"
      className={[
        'relative flex flex-col gap-px overflow-hidden',
        'w-3 min-w-3',
        'select-none',
        className ?? '',
      ]
        .join(' ')
        .trim()}
      style={{ transition: 'opacity 200ms ease' }}
    >
      {/* Viewport highlight overlay */}
      {vpStart >= 0 && vpEnd >= 0 && numBuckets > 0 && (
        <div
          data-testid="rail-viewport"
          className="pointer-events-none absolute inset-x-0 z-10"
          style={{
            top: `${(vpStart / numBuckets) * 100}%`,
            bottom: `${((numBuckets - 1 - vpEnd) / numBuckets) * 100}%`,
            backgroundColor: 'var(--accent)',
            opacity: 0.12,
            transition: 'top 150ms ease, bottom 150ms ease',
          }}
        />
      )}

      {buckets.map((bucket, bIdx) => {
        const isDivider = bucket.dominantKind === 'clear' || bucket.dominantKind === 'relaunch'
        const isHit = hitBuckets.has(bIdx)
        const colour = kindToColour(bucket.dominantKind)

        return (
          <div
            key={bIdx}
            data-testid="rail-cell"
            onClick={() => onJump({ runId: bucket.firstTurn.runId, idx: bucket.firstTurn.idx })}
            className="relative cursor-pointer"
            style={{
              height: isDivider ? 2 : 1,
              backgroundColor: colour,
              opacity: isDivider ? 1 : 0.55,
              transition: 'opacity 150ms ease',
            }}
            title={`Turn ${bucket.firstTurn.idx} (${bucket.dominantKind})`}
          >
            {/* Search hit marker */}
            {isHit && (
              <div
                data-testid="rail-hit"
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundColor: 'var(--color-yellow)',
                  opacity: 0.9,
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
