import React from 'react'

/**
 * Decides which chips of each band fold into the "N more" pill (ADR-018 D8).
 *
 * How: the bar renders every chip once with nothing folded; this hook measures
 * the row (in a layout effect, before paint) and folds chips until the row
 * fits. With `wrap2` the row may take a second line first, and folding starts
 * only when a third line would appear. Re-measure only on container resize and
 * when the chip set changes -- never on hover/focus/drag-over -- because every
 * height change re-fits the terminal. While a drag is in progress the result
 * is frozen.
 *
 * PRIORITY (D8): the caller gives the bands in FOLD ORDER -- Global first,
 * Session last. When the row overflows, the room is found by folding the
 * FIRST band's chips from its end, even when those chips themselves fit; only
 * when that band has nothing left to fold does the next band give way. Pinned
 * chips never fold. The hook returns, per band, the set of folded ids.
 */
export interface FoldBand {
  key: string
  /** Chip ids in row order; those listed in `pinned` are never folded. */
  ids: string[]
  pinned: Set<string>
}

export interface FoldResult {
  folded: Record<string, Set<string>>
  /** True once a measurement has been taken for the current chip set. */
  settled: boolean
}

const PILL_WIDTH = 72       // "N more" pill incl. gap, reserved the first time a band folds
const CHIP_GAP = 4          // the row's gap-1
const ROW_HEIGHT_SLACK = 6  // px of tolerance before a line counts as a new row
const MAX_PASSES = 8        // layout passes per chip set before we accept the result

/**
 * Fold `needed` px worth of chips, taking from the first band's END first,
 * then the next band's, skipping pinned chips. Pure, so the rule is testable.
 * `widths` gives each chip's width; `alreadyFolded` says which bands already
 * show a pill (no room to reserve for it).
 */
export function foldForWidth(
  bands: readonly FoldBand[],
  needed: number,
  widths: (id: string) => number,
  alreadyFolded: (bandKey: string) => boolean,
): Record<string, Set<string>> {
  const next: Record<string, Set<string>> = {}
  for (const b of bands) next[b.key] = new Set()
  let remaining = needed
  for (const b of bands) {
    if (remaining <= 0) break
    let pillReserved = alreadyFolded(b.key)
    for (let i = b.ids.length - 1; i >= 0 && remaining > 0; i--) {
      const id = b.ids[i]
      if (b.pinned.has(id)) continue
      next[b.key].add(id)
      remaining -= widths(id) + CHIP_GAP
      if (!pillReserved) { remaining += PILL_WIDTH; pillReserved = true }
    }
  }
  return next
}

export function useBandFolding(
  rowRef: React.RefObject<HTMLDivElement | null>,
  bands: FoldBand[],
  mode: 'fold' | 'wrap2',
  frozen: boolean,
): FoldResult {
  const signature = bands.map((b) => `${b.key}:${b.ids.join(',')}|${[...b.pinned].join(',')}`).join(';') + `#${mode}`
  const [folded, setFolded] = React.useState<Record<string, Set<string>>>({})
  const [settled, setSettled] = React.useState(false)
  const lastSig = React.useRef('')
  const lastWidth = React.useRef(0)
  const passes = React.useRef(0)

  // A new chip set or mode: unfold everything and measure again.
  if (lastSig.current !== signature) {
    lastSig.current = signature
    passes.current = 0
    if (Object.keys(folded).length) setFolded({})
    if (settled) setSettled(false)
  }

  const measure = React.useCallback(() => {
    const row = rowRef.current
    if (!row) return
    const rowRect = row.getBoundingClientRect()
    lastWidth.current = rowRect.width
    // No layout yet (hidden, or a non-layout DOM such as jsdom): nothing to fold.
    if (rowRect.width <= 0) { if (!settled) setSettled(true); return }
    if (passes.current >= MAX_PASSES) { if (!settled) setSettled(true); return }
    // Only the chips still ON the row are in the DOM; the folded set is `folded`.
    const chipEls = Array.from(row.querySelectorAll<HTMLElement>('[data-fold-band][data-command-id]'))
    const rectOf = new Map<string, DOMRect>()
    for (const el of chipEls) rectOf.set(el.dataset.commandId!, el.getBoundingClientRect())
    const onRow: FoldBand[] = bands.map((b) => ({ ...b, ids: b.ids.filter((id) => rectOf.has(id)) }))
    const widths = (id: string) => rectOf.get(id)?.width ?? 0
    const alreadyFolded = (key: string) => (folded[key]?.size ?? 0) > 0

    let needed = 0
    if (mode === 'fold') {
      // Single line: everything must end before the row's right edge.
      const limit = rowRect.right - row.clientLeft - 6
      let lastRight = 0
      for (const r of rectOf.values()) lastRight = Math.max(lastRight, r.right)
      needed = lastRight - limit
    } else {
      // wrap2: two lines allowed. Anything on a third line must go, and the
      // room it takes is the width of those chips.
      const lineHeight = (chipEls[0]?.getBoundingClientRect().height ?? 22) + 6
      const thirdLineTop = rowRect.top + 2 * lineHeight + ROW_HEIGHT_SLACK
      for (const r of rectOf.values()) if (r.top >= thirdLineTop) needed += r.width + CHIP_GAP
    }
    if (needed <= 0) { if (!settled) setSettled(true); return }

    const next = foldForWidth(onRow, needed, widths, alreadyFolded)
    // Growth only: a pass never unfolds (that happens on a new chip set or a
    // wider container), so a stable result must not re-set state -- the layout
    // effect runs after every render and would loop.
    const changed = bands.some((b) => {
      const a = folded[b.key] ?? new Set<string>()
      for (const id of next[b.key]) if (!a.has(id)) return true
      return false
    })
    if (changed) {
      passes.current += 1
      setFolded((prev) => {
        const merged: Record<string, Set<string>> = {}
        for (const b of bands) merged[b.key] = new Set([...(prev[b.key] ?? []), ...next[b.key]])
        return merged
      })
    } else if (!settled) setSettled(true)
  }, [bands, folded, mode, rowRef, settled])

  React.useLayoutEffect(() => {
    if (frozen) return
    measure()
  })

  React.useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = row.getBoundingClientRect().width
      if (Math.abs(w - lastWidth.current) < 2) return
      // Width changed: start over (unfold) and let the layout effect re-measure.
      lastSig.current = ''
      passes.current = 0
      setFolded({})
      setSettled(false)
    })
    ro.observe(row)
    return () => ro.disconnect()
  }, [rowRef])

  return { folded, settled }
}
