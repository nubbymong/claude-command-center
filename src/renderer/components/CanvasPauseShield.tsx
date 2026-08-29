import React, { useEffect, useRef } from 'react'
import { scrim } from './ui/Dialog'

/**
 * The one sentence that explains what a note in Testing mode actually does.
 *
 * Exported because it is said EXACTLY ONCE in the product — here, on the paused
 * modal, at the moment it is true. The composer does not repeat it and neither
 * does the header: a promise about what gets saved, restated in three places,
 * is three places that can drift apart.
 */
export const PAUSE_SHIELD_MESSAGE =
  'Saving locks this screen with the note — screenshot · page state · your drawings. Inputs are blocked until you save or cancel.'

interface Props {
  /** Escape cancels; the pane owns the key so the ordering against its own
   *  Escape handling is decided in one place. Passed here only so the card can
   *  say so. */
  onCancelHint?: string
  /**
   * The GLASS owns the pointer (draw mode), so this layer must let it through.
   *
   * Drawing during the pause is not an escape from it — the marks made while
   * writing a note are exactly the marks that belong to it, and they ride it.
   * What the shield blocks is input to the PAGE, and in draw mode the glass is
   * already covering the page for the same reason. Without this the shield sat
   * on top of the glass and froze the annotation tool along with the site.
   */
  passThrough?: boolean
}

/**
 * The PAUSE SHIELD — the site, frozen, while a note is being written (M3).
 *
 * A note in Testing mode is a locked evidence record: the screenshot, the page
 * state and the action trail are taken at the moment the user starts writing,
 * and the words they then type are about THAT screen. So the screen must not
 * move underneath them. Without this, a user who starts a note, reads it back,
 * clicks something to check a detail and then saves gets a note whose evidence
 * shows a page they are no longer describing — which is worse than no evidence,
 * because it looks authoritative.
 *
 * It is the LAST child of the content frame, so it covers the iframe, the glass
 * and the highlight overlay. Two things it deliberately does NOT block:
 *
 *  - the glass in draw mode, which sits ABOVE this layer's stacking position
 *    only when the pane puts it there — drawings made during the pause ride the
 *    note, and are exactly the marks a reviewer makes while writing it;
 *  - the review panel, which is outside the frame entirely.
 */
export function CanvasPauseShield({ onCancelHint, passThrough = false }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || passThrough) return
    // React attaches `wheel` at the root as a PASSIVE listener, so an onWheel
    // prop cannot preventDefault. The shield already receives the event (it
    // covers the frame and takes pointer events), but a wheel that reaches an
    // ancestor scroller would still move the page under the frozen shot.
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [passThrough])

  useEffect(() => {
    // Keyboard focus leaves the frame while paused. Blocking the POINTER is not
    // enough: a user who had clicked into the page before starting the note
    // still has keyboard focus inside it, and every keystroke meant for the
    // note would go on changing the screen the note is about.
    const active = document.activeElement
    if (active instanceof HTMLIFrameElement) active.blur()
  }, [])

  return (
    <div
      ref={ref}
      // The LAST child of the content frame — see the component comment.
      data-canvas-layer="shield"
      data-testid="canvas-pause-shield"
      className="absolute inset-0 z-20 flex items-center justify-center canvas-shield-fade"
      style={{
        background: scrim(0.55),
        backdropFilter: 'blur(1.5px)',
        pointerEvents: passThrough ? 'none' : 'auto',
      }}
      data-shield-passthrough={passThrough ? 'true' : undefined}
      // The card is the only thing here worth reading; the layer itself is
      // furniture. `role="status"` rather than a dialog: nothing here takes
      // input, and announcing it as a dialog would promise a focus trap that
      // does not exist.
      role="status"
      aria-live="polite"
      onMouseDown={(e) => {
        if (!passThrough) e.preventDefault()
      }}
      onContextMenu={(e) => {
        if (!passThrough) e.preventDefault()
      }}
    >
      <div
        className="flex items-start gap-3 max-w-[420px] rounded-[11px] px-4 py-3"
        style={{
          background: 'var(--surface-chrome)',
          border: '1px solid var(--color-peach)',
          boxShadow: '0 14px 44px rgba(0,0,0,0.5)',
        }}
      >
        {/* A DRAWN pause mark: the repo takes no emoji in JSX, and a text
            glyph would inherit whatever the theme does to punctuation. */}
        <span
          aria-hidden
          className="shrink-0 inline-flex items-center justify-center w-[26px] h-[26px] rounded-lg"
          style={{
            background: 'color-mix(in srgb, var(--color-peach) 20%, transparent)',
            color: 'var(--color-peach)',
          }}
        >
          <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor" aria-hidden>
            <rect x="1" y="1" width="3" height="10" rx="1" />
            <rect x="7" y="1" width="3" height="10" rx="1" />
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-[12.5px] font-bold" style={{ color: 'var(--color-peach)' }}>
            Paused — writing a note
          </span>
          <span className="block text-[11px] leading-[1.5] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {PAUSE_SHIELD_MESSAGE}
          </span>
          {onCancelHint && (
            <span className="block text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {onCancelHint}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

export default CanvasPauseShield
