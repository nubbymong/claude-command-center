/**
 * User-invoked terminal repaint + geometry re-sync (#503).
 *
 * When a console-attached child of the pty's own process tree writes to the
 * console device directly — Windows OpenSSH does exactly this for its host-key
 * prompt, opening CONIN$/CONOUT$ around its redirected stdio — conhost merges
 * those writes with the TUI's concurrent cursor-addressed repaints and ConPTY
 * emits the spliced result. Two kinds of damage come out of that:
 *
 *  - Rows already scrolled into history hold the spliced text. Those bytes
 *    really arrived that way; nothing downstream can un-write them.
 *  - The TUI's live region can stay desynced from the real rows afterwards,
 *    garbling every later delta-repaint. THIS is repairable: the same
 *    shrink-by-one-row → restore nudge the post-resume path uses makes the
 *    program re-lay-out its whole TUI at reconfirmed geometry, and a strong
 *    repaint then redraws our own stale cells.
 *
 * There is no signal to auto-detect the splice on (the bytes are
 * indistinguishable from ordinary output), so this is a hand-pulled cord:
 * Ctrl+Alt+R and the terminal context menu, via the repaint registry.
 *
 * Deps-injected like staleGlyphRepaint so the sequence is testable without a
 * live terminal.
 */

/** How long the pty stays shrunk before the restore half fires — long enough
 *  for the resize to reach conpty, short enough to read as a flicker. Same
 *  figure the post-resume nudge settled on. */
export const RESYNC_RESTORE_DELAY_MS = 60

export interface GeometryResyncDeps {
  /** Read AT CALL TIME, both on fire and on restore — a real user resize can
   *  land inside the shrink window, and restoring a stale capture would stomp
   *  it (see the post-resume nudge's identical rule). */
  getGeometry: () => { cols: number; rows: number }
  resizePty: (cols: number, rows: number) => void
  /** Repaint every row of the live viewport. */
  refresh: () => void
  /** The atlas-clearing settle sweep, for GPU-side stale cells. */
  settleStrong: () => void
  /** True while some other geometry jiggle is in flight (the post-resume
   *  nudge); firing under it would fight over the restore. */
  isBusy?: () => boolean
  /** Bookkeeping hook: the restore's geometry became the last one sent. */
  onRestore?: (cols: number, rows: number) => void
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface GeometryResync {
  /** Run one shrink→restore→repaint cycle. False when it declined: disposed,
   *  a cycle already in flight, another jiggle busy, or geometry too small to
   *  shrink (rows must survive -1). */
  fire: () => boolean
  /** Cancel a pending restore and, if the pty is still shrunk, put it back —
   *  a remount must not inherit a one-row-short terminal. */
  dispose: () => void
}

export function createGeometryResync(deps: GeometryResyncDeps): GeometryResync {
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let restoreTimer: unknown = null
  let shrunkFrom: { cols: number; rows: number } | null = null
  let disposed = false

  const fire = (): boolean => {
    if (disposed || restoreTimer !== null || deps.isBusy?.()) return false
    const { cols, rows } = deps.getGeometry()
    if (cols <= 0 || rows <= 2) return false
    shrunkFrom = { cols, rows }
    deps.resizePty(cols, rows - 1)
    restoreTimer = setTimer(() => {
      restoreTimer = null
      shrunkFrom = null
      if (disposed) return
      const g = deps.getGeometry()
      if (g.cols > 0 && g.rows > 0) {
        deps.resizePty(g.cols, g.rows)
        deps.onRestore?.(g.cols, g.rows)
      }
      deps.refresh()
      deps.settleStrong()
    }, RESYNC_RESTORE_DELAY_MS)
    return true
  }

  const dispose = (): void => {
    disposed = true
    if (restoreTimer !== null) {
      clearTimer(restoreTimer)
      restoreTimer = null
    }
    if (shrunkFrom) {
      // Prefer LIVE geometry, same rule as the restore: a user resize can land
      // inside the shrink window, and the pty outlives this view — restoring
      // the stale capture would leave it at the pre-resize size. The capture
      // is only the fallback for a term already disposed under us.
      let target = shrunkFrom
      try {
        const g = deps.getGeometry()
        if (g.cols > 0 && g.rows > 0) target = g
      } catch {
        /* term disposed first — the capture will do */
      }
      try {
        deps.resizePty(target.cols, target.rows)
      } catch {
        /* main gone mid-teardown */
      }
      shrunkFrom = null
    }
  }

  return { fire, dispose }
}
