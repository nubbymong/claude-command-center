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

import { MAX_STAMP_ROUTE_CHARS, MAX_STAMP_TARGET_CHARS, MAX_STAMP_TITLE_CHARS, cleanPageReportedText } from './canvas'
import type { AnchorRef, Annotation, EvidenceStateStamp, Rect, ReviewPayload, TrailEntry } from './canvas'

/**
 * PAGE-REPORTED text, at the moment it is rendered into a line this format gives
 * meaning to.
 *
 * Deliberately redundant with the keepers — a stored stamp carrying the
 * separator or the quote has already been refused. It is here because THE FORMAT
 * OWNS ITS OWN PUNCTUATION: a renderer that joins with ` · `, quotes with `"`,
 * and then trusts every upstream validator to have thought about that is one
 * validator away from printing a forged action as recorded fact. The keeper
 * protects the RECORD; this protects the RENDERING, and neither needs the other
 * to have been right.
 */
function pageText(value: string, max: number, opts?: { allowQuotes?: boolean }): string {
  return cleanPageReportedText(value, max, opts)
}

/** A field name, for the one line that joins names with `", "`. Every renderer
 *  that invents a separator owns stripping it — the shared cleaner knows about
 *  the format's ` · ` and `"`, and cannot know about a list this one builds. */
function fieldName(value: string): string {
  return pageText(value, MAX_STAMP_TARGET_CHARS)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Testing-mode evidence, rendered (M3) ────────────────────────────────────
//
// THE TOKEN RULE, and it is the reason this is text rather than image blocks:
// a Testing note carries a screenshot, a state stamp and a slice of the action
// trail, and only the first of those is expensive. So the STRUCTURE is what
// `canvas_review` returns by default — it answers most questions about a run —
// and the pictures come only when the agent asks for them (`includeShots`).
// Everything below is that structure, compressed to lines a model reads in one
// pass rather than a JSON tree it has to hold.

// THE TRAIL LINE FORMATTERS ARE EXPORTED, AND THERE IS ONE OF EACH. The recall
// view prints the same lines beside the screenshot the user is looking at, and
// two copies of "how a trail line reads" is how the pane and the agent come to
// describe the same run differently. `src/shared` is where they live because
// both processes need them and neither may own them.

/** Wall-clock time of one trail entry, `HH:MM:SS`, in the USER'S OWN timezone —
 *  the agent and the user are on one machine, and a trail timed in UTC would
 *  disagree with the clock the user was watching. An unparseable stamp yields
 *  '??:??:??' rather than a lie or a throw. */
export function trailClockTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '??:??:??'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** The pause before an entry. Seconds to a tenth up to a minute, then whole
 *  minutes: "+3.1s" is the rhythm of a test, "+0.0517s" is noise, and "+184.2s"
 *  is a number the reader has to divide. */
export function trailGapLabel(gapMs: number): string {
  if (!Number.isFinite(gapMs) || gapMs < 0) return '+0.0s'
  if (gapMs < 60_000) return `+${(gapMs / 1000).toFixed(1)}s`
  return `+${Math.round(gapMs / 60_000)}m`
}

/** One action, in the fewest words that still say which element. Identity only —
 *  there is no branch here that could print a value, because no branch of
 *  `TrailEntry` carries one. */
export function trailAction(entry: TrailEntry): string {
  const target = (t: { name: string; role: string }): string => pageText(t.name || t.role, MAX_STAMP_TARGET_CHARS)
  switch (entry.kind) {
    case 'click':
      return entry.target ? `click "${target(entry.target)}"` : 'click'
    case 'typed':
      return `typed into "${target(entry.target)}"`
    case 'navigate':
      return `navigate ${pageText(entry.route, MAX_STAMP_ROUTE_CHARS)}`
    case 'scroll':
      return `scroll to ${Math.round(entry.scrollY)}`
    case 'note':
      return 'note saved'
  }
}

/** How many actions ride one rendered line. Long enough that a trail is not a
 *  column of stubs, short enough to stay readable. */
const TRAIL_ACTIONS_PER_LINE = 6

/**
 * A run of trail entries as timed lines: the first carries a clock time, the
 * rest carry the pause since the one before.
 *
 * `16:43:58 click "Checkout" · +3.1s typed into "Email" · +0.8s note saved`
 */
function fmtTrail(trail: readonly TrailEntry[], indent: string): string[] {
  const lines: string[] = []
  for (let i = 0; i < trail.length; i += TRAIL_ACTIONS_PER_LINE) {
    const chunk = trail.slice(i, i + TRAIL_ACTIONS_PER_LINE)
    const parts = chunk.map((entry, k) =>
      k === 0 ? `${trailClockTime(entry.at)} ${trailAction(entry)}` : `${trailGapLabel(entry.gapMs)} ${trailAction(entry)}`,
    )
    lines.push(`${indent}${parts.join(' · ')}`)
  }
  return lines
}

/**
 * The state stamp as ONE line: where the page was, what was open, what had
 * focus, and how the form stood.
 *
 * `route /checkout · title "Checkout" · dialog "Confirm order" open · focused textbox "Email" · fields: 2 filled, 1 invalid (Email), 3 empty`
 *
 * The field summary counts rather than lists, EXCEPT for invalid ones — a count
 * of invalid fields is a fact the agent cannot act on, and the name is the whole
 * point of recording them. What is never here, in any branch, is a field's
 * contents: the stamp does not carry them, so this cannot print them.
 */
function fmtStamp(stamp: EvidenceStateStamp): string {
  const parts: string[] = []
  if (stamp.route) parts.push(`route ${pageText(stamp.route, MAX_STAMP_ROUTE_CHARS)}`)
  if (stamp.title) parts.push(`title "${pageText(stamp.title, MAX_STAMP_TITLE_CHARS)}"`)
  for (const dialog of stamp.dialogs) {
    parts.push(`dialog "${pageText(dialog.name || dialog.role, MAX_STAMP_TARGET_CHARS)}" open`)
  }
  if (stamp.focused) {
    parts.push(
      `focused ${pageText(stamp.focused.role, MAX_STAMP_TARGET_CHARS)} "${pageText(stamp.focused.name, MAX_STAMP_TARGET_CHARS)}"`,
    )
  }
  const counts = { filled: 0, changed: 0, invalid: 0, empty: 0 }
  const invalidNames: string[] = []
  for (const field of stamp.fields) {
    counts[field.fill] += 1
    // The invalid names are joined with ", " — this line's OWN separator, which
    // the shared cleaner has no reason to know about — so a field named
    // `Email, Password` would read as two fields the page does not have.
    if (field.fill === 'invalid' && field.name) invalidNames.push(fieldName(field.name))
  }
  const fieldBits: string[] = []
  if (counts.filled > 0) fieldBits.push(`${counts.filled} filled`)
  if (counts.changed > 0) fieldBits.push(`${counts.changed} changed`)
  if (counts.invalid > 0) {
    fieldBits.push(invalidNames.length > 0 ? `${counts.invalid} invalid (${invalidNames.join(', ')})` : `${counts.invalid} invalid`)
  }
  if (counts.empty > 0) fieldBits.push(`${counts.empty} empty`)
  if (fieldBits.length > 0) parts.push(`fields: ${fieldBits.join(', ')}`)
  const scroll = Math.round(stamp.viewport.scrollY)
  if (scroll > 0) parts.push(`scrolled to ${scroll}`)
  return parts.join(' · ')
}

function fmtBox(box: Rect): string {
  return `[box=${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}]`
}

/**
 * An anchor, rendered — and cleaned HERE and nowhere else.
 *
 * `role`, `name` and `ancestorPath` are read off the page, and this line quotes
 * them and joins anchors with `; ` while the note's other lines join with ` · `.
 * So they get the same treatment the stamp and the trail do.
 *
 * AT RENDER ONLY. An `AnchorRef`'s strings are compared for EXACT EQUALITY
 * against freshly recomputed live values when a note re-anchors (bridge/anchors
 * and canvas-geometry-guard), so cleaning them on ingress — without mirroring
 * the same cleaning in resolution — would make a stored fingerprint stop
 * matching the element it names. That is the "present element reads
 * needs-re-pointing" failure of 2026-08-15, and it is the reason this is a
 * display concern and not a storage one.
 */
function fmtAnchor(anchor: AnchorRef): string {
  if (anchor.kind === 'ux-id') return `ux-id ${anchorText(anchor.id)}`
  return (
    `fingerprint role="${anchorText(anchor.role)}"` +
    ` name="${anchorText(anchor.name)}"` +
    ` path="${anchorText(anchor.ancestorPath)}"` +
    ` ordinal=${anchor.ordinal}`
  )
}

/** One anchor field. The `anchors:` line joins anchors with `"; "` — its OWN
 *  separator, which the shared cleaner has no reason to know about — so the
 *  semicolon goes here, exactly as `fieldName` drops the comma from the one line
 *  that joins names with `", "`. Every renderer that invents a separator owns
 *  stripping it. */
function anchorText(value: string): string {
  return pageText(value, MAX_ANCHOR_CHARS)
    .replace(/;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** An anchor string's bound at RENDER. Matches the store's own ANCHOR_STRING_MAX
 *  so nothing is truncated here — this pass is about punctuation, not length. */
const MAX_ANCHOR_CHARS = 512
/** Likewise for a focus label, matching the store's LABEL_MAX_CHARS. */
const MAX_FOCUS_LABEL_CHARS = 120

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
  /** The Testing evidence SHOT's block, present only when the caller asked for
   *  shots (`includeShots`). Its own field rather than another `images` entry:
   *  the user did not paste it, they did not draw it, and the note's prose never
   *  refers to it by number — it is the screen the note was written against. */
  evidence?: number
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
    // The focus LABEL is page-derived too — an `aria-label` becomes it — so the
    // separator goes. Its QUOTES stay: the label is prose (`button "Save"`) in a
    // field that holds nothing else, where a quote delimits nothing a reader
    // parses. Cleaned at render, like the anchors below and for the same reason.
    const label = pageText(a.focus.label, MAX_FOCUS_LABEL_CHARS, { allowQuotes: true })
    if (a.scope === 'element') {
      lines.push(`  target: ${label} ${fmtBox(a.focus.bboxPage)}`)
      if (a.focus.targets.length > 0) {
        lines.push(`  anchors: ${a.focus.targets.map(fmtAnchor).join('; ')}`)
      }
    } else {
      lines.push(`  region: ${label} ${fmtBox(a.focus.bboxPage)}`)
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
  // THE EVIDENCE (M3), and the structure comes first on purpose: `screen:` and
  // `trail:` answer most of what the note is about, and the picture is an
  // expensive last resort the agent has to ask for by name.
  if (a.evidence) {
    lines.push(`  screen: ${fmtStamp(a.evidence.stamp)}`)
    if (a.evidence.trail.length > 0) {
      const trailLines = fmtTrail(a.evidence.trail, '    ')
      lines.push(`  trail (${a.evidence.trail.length} action(s) before this note):`)
      lines.push(...trailLines)
    }
    lines.push(
      blocks?.evidence !== undefined
        ? `  screenshot: the screen as it was, attached as attachment ${blocks.evidence} (${a.evidence.width}x${a.evidence.height})`
        : `  screenshot: the screen as it was, ${a.evidence.width}x${a.evidence.height} — stored for the user; call canvas_review again with includeShots:true if you need the pixels`,
    )
  }
  return lines.join('\n')
}

export interface SerializedReview {
  text: string
}

/** One image block the tool actually loaded, in block order. */
export interface SerializedAttachment {
  annotationId: string
  kind: 'sketch' | 'image' | 'evidence'
  /** 1-based position of this image on its own note. Absent for a sketch and
   *  for an evidence shot (a note has at most one of each). */
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
  opts?: {
    /** The mode of the version this round froze against. Testing mode calls the
     *  same two decisions Pass and Fail; the machine is one, only the words
     *  change, and the agent should read back the word the user saw. */
    uat?: boolean
    /** What the user calls this TEST PACK — their own name, or the generated
     *  default. Inside the envelope, like every other user-authored string: the
     *  operator-voice notes outside it carry only store-minted facts. */
    packName?: string
  },
): SerializedReview {
  const blocksByAnnotation = new Map<string, NoteAttachmentBlocks>()
  attachmentOrder.forEach((att, i) => {
    const block = i + 1
    const entry = blocksByAnnotation.get(att.annotationId) ?? { images: [] }
    if (att.kind === 'sketch') entry.sketch = block
    else if (att.kind === 'evidence') entry.evidence = block
    else entry.images.push({ imageIndex: att.imageIndex ?? entry.images.length + 1, block })
    blocksByAnnotation.set(att.annotationId, entry)
  })

  const parts: string[] = []
  // THE PACK, named. A Testing round is one build under test, and the name is
  // what the user calls it in their Library — so an agent reading the round back
  // can use the same words they do.
  if (opts?.packName) parts.push(`pack: ${opts.packName}`)
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
  // THE WHOLE RUN, once, at the top (M3). Before the notes because it is the
  // context they sit in: what the user did across the build under test, in
  // order. Per-note slices repeat the tail of this deliberately — a note's own
  // "what led to it" is the thing an agent reads when it is looking at that one
  // note, and making it hunt back up the run trail for it would cost more tokens
  // than the repetition does.
  const runTrail = payload.review.trail ?? []
  if (runTrail.length > 0) {
    parts.push(`run trail (${runTrail.length} action(s), oldest first) — what the user did, never what they typed:`)
    parts.push(fmtTrail(runTrail, '  ').join('\n'))
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
