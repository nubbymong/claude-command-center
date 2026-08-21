import React from 'react'

/**
 * Decides which chips of each band fold into the "N more" pill (ADR-018 D8).
 *
 * How: the bar renders every chip once with nothing folded; this hook measures
 * the row (in a layout effect, before paint) and folds from the END of the
 * lowest-priority band until the row fits. With `wrap2` the row may take a
 * second line first, and folding starts only when a third line would appear.
 * Re-measure only on container resize and when the chip set changes -- never
 * on hover/focus/drag-over -- because every height change re-fits the
 * terminal. While a drag is in progress the result is frozen.
 *
 * The caller gives the hook, per band in FOLD PRIORITY order (first folds
 * first), the ids of its chips in row order with pinned chips FIRST; pinned
 * never fold. The hook returns, per band, the set of folded ids.
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

const PILL_WIDTH = 72       // "N more" pill incl. gap, reserved when a band folds
const ROW_HEIGHT_SLACK = 6  // px of tolerance before a line counts as a new row

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

  // A new chip set or mode: unfold everything and measure again.
  if (lastSig.current !== signature) {
    lastSig.current = signature
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
    const chipEls = Array.from(row.querySelectorAll<HTMLElement>('[data-fold-band][data-command-id]'))
    const next: Record<string, Set<string>> = {}
    for (const b of bands) next[b.key] = new Set()

    if (mode === 'fold') {
      // Single line: a chip that ends past the row's right edge (minus room for
      // the pill) folds, and so does everything after it in its band.
      const limit = rowRect.right - row.clientLeft - 6
      for (const b of bands) {
        const els = chipEls.filter((el) => el.dataset.foldBand === b.key)
        let overflowAt = -1
        for (let i = 0; i < els.length; i++) {
          const el = els[i]
          const r = el.getBoundingClientRect()
          const reserve = i < els.length - 1 || bands.some((o) => o !== b && next[o.key].size) ? PILL_WIDTH : 0
          if (r.right > limit - (overflowAt === -1 ? reserve : 0)) { overflowAt = i; break }
        }
        if (overflowAt === -1) continue
        for (let i = overflowAt; i < els.length; i++) {
          const id = els[i].dataset.commandId!
          if (!b.pinned.has(id)) next[b.key].add(id)
        }
      }
      // Folding one band frees room, so a later (higher-priority) band that
      // overflowed only because of it is re-checked by the next layout pass.
    } else {
      // wrap2: allow two lines. Fold from the lowest-priority band's end while
      // any chip sits on a third line.
      const rowTop = rowRect.top
      const lineHeight = (chipEls[0]?.getBoundingClientRect().height ?? 22) + 6
      const thirdLineTop = rowTop + 2 * lineHeight + ROW_HEIGHT_SLACK
      const onThirdLine = chipEls.filter((el) => el.getBoundingClientRect().top >= thirdLineTop)
      if (onThirdLine.length) {
        // Fold everything from the first third-line chip onward in ITS band,
        // lowest-priority band first; the next layout pass re-checks.
        for (const b of bands) {
          const els = chipEls.filter((el) => el.dataset.foldBand === b.key)
          const firstBad = els.findIndex((el) => el.getBoundingClientRect().top >= thirdLineTop)
          if (firstBad === -1) continue
          // Fold one more than strictly needed so the pill itself fits.
          for (let i = Math.max(0, firstBad - 1); i < els.length; i++) {
            const id = els[i].dataset.commandId!
            if (!b.pinned.has(id)) next[b.key].add(id)
          }
          break
        }
      }
    }

    // Only GROWTH counts as a change: a pass never unfolds (that happens on a
    // new chip set or a wider container), so a stable result must not re-set
    // state -- the layout effect runs after every render and would loop.
    const changed = bands.some((b) => {
      const a = folded[b.key] ?? new Set<string>()
      for (const id of next[b.key]) if (!a.has(id)) return true
      return false
    })
    if (changed) setFolded((prev) => {
      // Accumulate: never unfold inside a pass (unfolding happens only when the
      // signature changes or the container grows).
      const merged: Record<string, Set<string>> = {}
      for (const b of bands) merged[b.key] = new Set([...(prev[b.key] ?? []), ...next[b.key]])
      return merged
    })
    else setSettled(true)
  }, [bands, folded, mode, rowRef])

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
      setFolded({})
      setSettled(false)
    })
    ro.observe(row)
    return () => ro.disconnect()
  }, [rowRef])

  return { folded, settled }
}
