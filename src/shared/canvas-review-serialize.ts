// ReviewPayload → the compact text the canvas_review MCP tool returns (§4.1
// discipline: one entry per note, everything inline, a fraction of the JSON
// token count).
//
// EVERYTHING this module emits goes INSIDE the untrusted-content envelope. The
// note text is the user's, the labels and anchors are page-derived, and the
// envelope's defang pass (escape `&` then `<`) runs on the whole body after
// this serializer — so nothing here needs to escape, and nothing here may be
// mistaken for operator voice by construction. The operator-authored header
// (review id, counts) is the TOOL's job and rides outside, as envelope notes.

import type { AnchorRef, Annotation, Rect, ReviewPayload } from './canvas'

function fmtBox(box: Rect): string {
  return `[box=${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}]`
}

function fmtAnchor(anchor: AnchorRef): string {
  if (anchor.kind === 'ux-id') return `ux-id ${anchor.id}`
  if (anchor.kind === 'plan-step') return `plan-step ${anchor.id}`
  return `fingerprint role="${anchor.role}" name="${anchor.name}" path="${anchor.ancestorPath}" ordinal=${anchor.ordinal}`
}

/** A multi-line user note, indented so continuation lines sit visibly under
 *  their `note:` opener. Purely cosmetic — inside the envelope every line is
 *  data regardless of what it starts with. */
function fmtNote(note: string, indent: string): string {
  return note.split('\n').join(`\n${indent}    `)
}

function fmtAnnotation(a: Annotation, imageIndexByAnnotation: Map<string, number>): string {
  const lines: string[] = []
  const head = `- ${a.id} [${a.scope}] [${a.state}] on ${a.versionId}`
  lines.push(head)
  if (a.focus) {
    if (a.scope === 'element') {
      lines.push(`  target: ${a.focus.label} ${fmtBox(a.focus.bboxPage)}`)
      if (a.focus.targets.length > 0) {
        lines.push(`  anchors: ${a.focus.targets.map(fmtAnchor).join('; ')}`)
      }
    } else {
      lines.push(`  region: ${a.focus.label} ${fmtBox(a.focus.bboxPage)}`)
    }
  }
  if (a.supersededBy) lines.push(`  superseded-by: ${a.supersededBy}`)
  // Alternatives the agent attached when addressing (#373), and — once the
  // user approves — which one they picked. This is how the agent learns the
  // winner: it re-reads the round and builds only that variant. Emitted only
  // while the offer is live (addressed) or ruled on (approved): a dismissed,
  // stale, or superseded note advertising alternatives would read as a
  // question still open.
  if (a.variants && a.variants.length > 0 && (a.state === 'addressed' || a.state === 'approved')) {
    lines.push(`  variants: ${a.variants.map((v) => `${v.key}=${v.label}`).join('; ')}`)
  }
  // `(picked in chat)` distinguishes an agent-recorded chat pick from the
  // user's own Approve click; the suffix is this serializer's, never data.
  if (a.chosenVariantKey) {
    lines.push(`  chosen-variant: ${a.chosenVariantKey}${a.pickSource === 'chat' ? ' (picked in chat)' : ''}`)
  }
  lines.push(`  note: ${fmtNote(a.note, '  ')}`)
  const imageIndex = imageIndexByAnnotation.get(a.id)
  if (imageIndex !== undefined && a.sketch) {
    lines.push(`  sketch: attached as image ${imageIndex} ${fmtBox(a.sketch.bboxPage)}`)
  } else if (imageIndex !== undefined && a.image) {
    lines.push(`  image: pasted screenshot, attached as image ${imageIndex}`)
  }
  return lines.join('\n')
}

export interface SerializedReview {
  text: string
}

/**
 * The body text for one review payload. `attachmentOrder` is the annotation-id
 * order the tool will append images in — the serializer numbers sketches from
 * it (1-based) so the text and the image blocks can never drift apart.
 */
export function serializeReviewPayload(payload: ReviewPayload, attachmentOrder: string[]): SerializedReview {
  const imageIndexByAnnotation = new Map<string, number>()
  attachmentOrder.forEach((annotationId, i) => imageIndexByAnnotation.set(annotationId, i + 1))

  const parts: string[] = []
  const anchored = payload.annotations
  if (anchored.length > 0) {
    parts.push(anchored.map((a) => fmtAnnotation(a, imageIndexByAnnotation)).join('\n'))
  }
  if (payload.generalNotes.length > 0) {
    parts.push('general notes:')
    parts.push(payload.generalNotes.map((a) => fmtAnnotation(a, imageIndexByAnnotation)).join('\n'))
  }
  if (parts.length === 0) parts.push('(this review has no notes)')
  return { text: parts.join('\n') }
}
