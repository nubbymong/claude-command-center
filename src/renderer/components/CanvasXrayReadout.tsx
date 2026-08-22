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

interface Props {
  /** The hovered element as the CONTENT reported it, or null when the pointer
   *  is off the page (or has not been on it yet). */
  hit: CanvasHitInfo | null
  /** The same one-line identity the On-mode chip prints, assembled by the pane
   *  so the two modes can never drift into naming the same element differently. */
  label: string
}

/** Page coordinates, rounded — a sub-pixel box is noise in a readout. */
function boxText(box: CanvasHitInfo['box']): string {
  const r = (n: number) => Math.round(n)
  return `${r(box.width)} × ${r(box.height)} at ${r(box.x)}, ${r(box.y)}`
}

export default function CanvasXrayReadout({ hit, label }: Props) {
  return (
    <div
      className="w-80 shrink-0 border-l border-t border-surface0 bg-mantle text-[12px] px-3 py-2"
      data-testid="canvas-xray-readout"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-subtext1">X-ray</span>
        <span className="text-[11px] text-overlay1">stealth — nothing is drawn on the page</span>
      </div>
      {hit ? (
        <>
          {/* Every word of the identity is the frame's own report about itself,
              marked exactly as the On-mode chip and the locked label are. Moving
              the readout off the page does not make the page a more reliable
              narrator of it. */}
          <div className="mt-1 truncate text-text" title={PAGE_REPORTED_TITLE} data-testid="canvas-xray-label">
            <span className="text-overlay1">{PAGE_REPORTED_MARK} </span>
            {label}
          </div>
          <div className="mt-0.5 text-[11px] text-subtext0" data-testid="canvas-xray-box">
            {boxText(hit.box)}
          </div>
        </>
      ) : (
        <div className="mt-1 text-[11px] text-subtext0">
          Hover the page — what you point at is named here.
        </div>
      )}
    </div>
  )
}
