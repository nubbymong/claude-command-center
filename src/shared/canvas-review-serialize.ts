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
  return `fingerprint role="${anchor.role}" name="${anchor.name}" path="${anchor.ancestorPath}" ordinal=${anchor.ordinal}`
}

/** A multi-line user note, indented so continuation lines sit visibly under
 *  their `note:` opener. Purely cosmetic — inside the envelope every line is
 *  data regardless of what it starts with. */
function fmtNote(note: string, indent: string): string {
  return note.split('\n').join(`\n${indent}    `)
}

/**
 * Which image BLOCKS one note's attachments became.
 *
 * `sketch` is the block the drawing landed in; `images` maps the note's own
 * 1-based image position — the "Image 2" the user typed into the note text — to
 * the block that carries it. The two numbers are different on purpose and both
 * have to be said: the note's prose counts per note, the image blocks count
 * across the whole payload, and an agent handed only one of them cannot tell
 * which picture "Image 2" is.
 */
export interface NoteAttachmentBlocks {
  sketch?: number
  images: Array<{ imageIndex: number; block: number }>
}

function fmtAnnotation(a: Annotation, blocksByAnnotation: Map<string, NoteAttachmentBlocks>): string {
  const lines: string[] = []
  const head = `- ${a.id} [${a.scope}] [${a.state}] on ${a.versionId}`
  lines.push(head)
  // An OBSERVATION is a note the user filed WITH an approval. It is here to be
  // read, not answered, and saying so on the line is the difference between an
  // agent acting on it (fine) and an agent treating it as outstanding work that
  // blocks the round (the working-pill strand, from the other side).
  if (a.state === 'observation') lines.push('  nothing owed — recorded for you')
  // Where the agent said the fix landed, echoed back so a re-read of the round
  // shows its own claim rather than only the note.
  if (a.addressedIn) lines.push(`  updated-in: ${a.addressedIn}`)
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
  const blocks = blocksByAnnotation.get(a.id)
  // The note's own numbering, spelled out. The user types "Image 2" into the
  // text and means the second screenshot they pasted onto THIS note; the image
  // blocks are numbered across the whole payload. Saying which is which is the
  // difference between an agent looking at the right picture and it guessing.
  if (blocks && blocks.images.length > 0) {
    const map = blocks.images.map((b) => `Image ${b.imageIndex} = attachment ${b.block}`).join('; ')
    lines.push(`  images (${blocks.images.length}): ${map}`)
  }
  // A DRAWING rides its note automatically now — the user does not attach it,
  // they draw on the page and it goes with whatever note they write next. Said
  // in those words so the agent reads the strokes as part of the note rather
  // than as a separate artefact somebody chose to include.
  if (blocks?.sketch !== undefined && a.sketch) {
    lines.push(`  drawing: rides this note, attached as attachment ${blocks.sketch} ${fmtBox(a.sketch.bboxPage)}`)
  }
  return lines.join('\n')
}

export interface SerializedReview {
  text: string
}

/** One image block the tool actually loaded, in block order. */
export interface SerializedAttachment {
  annotationId: string
  kind: 'sketch' | 'image'
  /** 1-based position of this image on its own note. Absent for a sketch. */
  imageIndex?: number
}

/**
 * The body text for one review payload. `attachmentOrder` is the list of image
 * blocks the tool will append, in order — the serializer numbers from it
 * (1-based) so the text and the image blocks can never drift apart. A note may
 * contribute several blocks now (its pasted images, then its drawing), which is
 * why the entries are typed rather than bare annotation ids.
 */
export function serializeReviewPayload(
  payload: ReviewPayload,
  attachmentOrder: readonly SerializedAttachment[],
  /** The mode of the version this round froze against. Testing mode calls the
   *  same two decisions Pass and Fail; the machine is one, only the words
   *  change, and the agent should read back the word the user saw. */
  opts?: { uat?: boolean },
): SerializedReview {
  const blocksByAnnotation = new Map<string, NoteAttachmentBlocks>()
  attachmentOrder.forEach((att, i) => {
    const block = i + 1
    const entry = blocksByAnnotation.get(att.annotationId) ?? { images: [] }
    if (att.kind === 'sketch') entry.sketch = block
    else entry.images.push({ imageIndex: att.imageIndex ?? entry.images.length + 1, block })
    blocksByAnnotation.set(att.annotationId, entry)
  })

  const parts: string[] = []
  // THE DECISION FIRST. It is the single most load-bearing fact about a round —
  // an approval means nothing on it is owed, a rejection means all of it drives
  // the next version — and an agent reading a list of notes without it has to
  // guess which.
  const decision = payload.review.decision
  if (decision === 'approve') {
    parts.push(
      `decision: ${opts?.uat ? 'PASSED' : 'APPROVED'} — nothing on this round is owed. The notes below are observations.`,
    )
  } else if (decision === 'reject') {
    parts.push(
      `decision: ${opts?.uat ? 'FAILED' : 'REJECTED'} — the notes below drive the next version. ` +
        'Call canvas_resolve with updatedIn when you render it.',
    )
  }
  const anchored = payload.annotations
  if (anchored.length > 0) {
    parts.push(anchored.map((a) => fmtAnnotation(a, blocksByAnnotation)).join('\n'))
  }
  if (payload.generalNotes.length > 0) {
    parts.push('general notes:')
    parts.push(payload.generalNotes.map((a) => fmtAnnotation(a, blocksByAnnotation)).join('\n'))
  }
  if (anchored.length === 0 && payload.generalNotes.length === 0) parts.push('(this review has no notes)')
  // A4: the earlier rounds this submission settled, and the notes on them that
  // nobody ever answered. Listed rather than dropped, because the settle is
  // otherwise invisible: the agent would simply find those rounds gone between
  // one canvas_review and the next, with no way to tell a note it handled from
  // a note that timed out.
  const settled = payload.settledByThisSubmission ?? []
  if (settled.length > 0) {
    // The COUNT is every round this decision closed; the list under it is only
    // the notes nobody ever answered. Two different numbers, said as two —
    // heading the block "never resolved" and then counting rounds made the
    // count read as a count of lost notes, which it is not.
    const lost = settled.flatMap((r) => r.neverResolved)
    parts.push(`settled by this submission (${settled.length}): ${settled.map((r) => r.reviewId).join(', ')}`)
    parts.push(lost.length > 0 ? `never resolved (${lost.length}):` : 'never resolved: none — every note on them was answered')
    for (const round of settled) {
      if (round.neverResolved.length === 0) continue
      parts.push(`- ${round.reviewId}`)
      parts.push(round.neverResolved.map((a) => fmtAnnotation(a, blocksByAnnotation)).join('\n'))
    }
  }
  return { text: parts.join('\n') }
}
