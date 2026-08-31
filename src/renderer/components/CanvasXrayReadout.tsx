// The stealth x-ray readout (#367) — where the hovered element goes when
// nothing may be drawn on the page.
//
// Stealth is the mode for looking at the artifact as a user would while still
// wanting to know what you are pointing at: the hit is resolved exactly as in
// On, but the outline and the label chip that would sit over the content are
// replaced by this strip beside the notes panel. The box is stated in numbers
// instead of being painted, because a rectangle drawn on the page IS the thing
// stealth exists to avoid.
//
// It is a SIBLING of CanvasNotesPanel rather than a section inside it. Two
// reasons, and the second is the load-bearing one: the panel is the review
// surface (notes, checklist, composer) and this is a live pointer readout that
// belongs to the stage, and the panel is under concurrent change on another
// branch (#403), so a strip that can live outside it should.

import type { CanvasHitInfo } from '../../shared/canvas'
import { PAGE_REPORTED_MARK, PAGE_REPORTED_TITLE } from '../canvas/page-reported'

/**
 * Who owns the pointer right now — the pane's Browse / Draw / Region switch,
 * restated for this strip.
 *
 * The readout has to say something when it has no element to name, and "hover
 * the page" is only true when hovering the page is a thing that can happen. In
 * Draw the glass sits over the content and in Region the marquee layer does, so
 * the content never sees the pointer: the invitation was an instruction the
 * user could follow for a while before working out why nothing ever appeared
 * (independent review of #405).
 */
export type CanvasPointerOwner = 'content' | 'glass' | 'marquee'

interface Props {
  /** The hovered element as the CONTENT reported it, or null when the pointer
   *  is off the page (or has not been on it yet). */
  hit: CanvasHitInfo | null
  /** The same one-line identity the On-mode chip prints, assembled by the pane
   *  so the two modes can never drift into naming the same element differently. */
  label: string
  /** Which layer the pointer is on, so the empty state can be honest about
   *  whether hovering the content is even possible. */
  pointerOwner: CanvasPointerOwner
  /** What this strip is CALLED. 'X-Ray' everywhere the X-Ray switch exists; a
   *  plan has no such switch on its toolbar, so naming the strip after it would
   *  re-introduce the apparatus by the back door. */
  heading?: string
}

/** Page coordinates, rounded — a sub-pixel box is noise in a readout. */
function boxText(box: CanvasHitInfo['box']): string {
  const r = (n: number) => Math.round(n)
  return `${r(box.width)} × ${r(box.height)} at ${r(box.x)}, ${r(box.y)}`
}

/**
 * What to say with no element to name.
 *
 * Only when hovering is IMPOSSIBLE — Draw and Region hold the pointer, so the
 * strip owes the user an explanation for staying empty (independent review of
 * #405). Browse with the pointer simply off the page owes nothing: "Hover the
 * page — what you point at is named here" was a tutorial line living permanently
 * in the chrome, telling a user who is about to hover something they already
 * know. An em dash says "nothing under the pointer" in the width it deserves.
 */
function idleText(pointerOwner: CanvasPointerOwner): string {
  if (pointerOwner === 'glass') return 'Draw has the pointer — switch to Browse to name what you point at.'
  if (pointerOwner === 'marquee') return 'Region has the pointer — switch to Browse to name what you point at.'
  return '—'
}

/**
 * One line, not three.
 *
 * This is a status strip under the review panel, and it used to open with a
 * heading, a subtitle explaining what stealth mode is, and only then the thing
 * the user is pointing at — two lines of standing explanation above one line of
 * content, in a 320px box hung off the bottom of a 352px panel, so it did not
 * even line up with it. It now reads left to right on one row: what it is, what
 * is under the pointer, and the box in numbers. The tokens are the app's own
 * (`--surface-chrome`, `--border-subtle`, …) rather than raw palette classes, so
 * it matches the toolbar it belongs to instead of the terminal.
 */
export default function CanvasXrayReadout({ hit, label, pointerOwner, heading = 'X-Ray' }: Props) {
  return (
    <div
      className="w-full shrink-0 flex items-center gap-2 px-3 h-[26px] text-[11px]"
      style={{
        borderTop: '1px solid var(--border-subtle)',
        borderLeft: '1px solid var(--border-subtle)',
        background: 'var(--surface-chrome)',
        color: 'var(--text-secondary)',
      }}
      data-testid="canvas-xray-readout"
    >
      <span className="shrink-0 text-[9px] font-bold tracking-[0.08em]" style={{ color: 'var(--text-secondary)' }} aria-hidden>
        {heading.toUpperCase()}
      </span>
      {hit ? (
        <>
          {/* Every word of the identity is the frame's own report about itself,
              marked exactly as the On-mode chip and the locked label are. Moving
              the readout off the page does not make the page a more reliable
              narrator of it. */}
          <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }} title={PAGE_REPORTED_TITLE} data-testid="canvas-xray-label">
            <span style={{ color: 'var(--text-muted)' }}>{PAGE_REPORTED_MARK} </span>
            {label}
          </span>
          <span className="shrink-0 ml-auto tabular-nums" style={{ color: 'var(--text-muted)' }} data-testid="canvas-xray-box">
            {boxText(hit.box)}
          </span>
        </>
      ) : (
        <span className="min-w-0 truncate" style={{ color: 'var(--text-muted)' }} data-testid="canvas-xray-idle">
          {idleText(pointerOwner)}
        </span>
      )}
    </div>
  )
}
