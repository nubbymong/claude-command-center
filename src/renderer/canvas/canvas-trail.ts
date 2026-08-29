// The ACTION TRAIL of a testing run — what the user did, and when, and nothing
// about what they typed.
//
// Testing mode's evidence has two halves. The state stamp says what the screen
// WAS at the moment a note was written; this says how the user got there. A
// defect report that says "the total is wrong" is worth a great deal more when
// it also says "clicked Checkout, typed into Email, waited three seconds, then
// wrote this" — that is the reproduction, and it is the part a reviewer never
// remembers to write down.
//
// The bar it must clear is the same one the snapshot clears: **identity, never
// content**. A click records the element's page-reported role/name/ux-id; a
// typed entry records WHICH field was typed into and not one character of what
// went in; a navigation records the route the page reported. There is no branch
// here that could carry a value, because no call site is given one — the
// recorder's inputs are the same bounded `StampTarget`s the stamp uses.
//
// The ring lives at module level rather than in the zustand store on purpose. A
// scrolling page produces viewport events at frame rate, and a store write per
// event would re-render every subscriber of the canvas store — the pane, the
// panel, the toolbar count — for a fact nothing paints. `expectedSwitches` in
// canvasStore is the same shape for the same reason; canvasStore.reset() clears
// this too, so nothing outlives the state it describes.

import {
  MAX_TRAIL_ENTRIES_PER_NOTE,
  MAX_TRAIL_ENTRIES_PER_RUN,
  type StampTarget,
  type TrailEntry,
} from '../../shared/canvas'

/**
 * How still the page must be before a scroll is worth recording.
 *
 * A scroll is not an event, it is a hundred of them. What carries meaning is
 * where the user STOPPED — the thing they scrolled to and then looked at — so
 * the burst is collapsed into one entry taken at the moment the movement
 * settled. 800 ms is long enough that a flick through a long page is one entry
 * rather than thirty, and short enough that the pause reads as deliberate.
 */
export const SCROLL_PAUSE_MS = 800

/** What a call site may hand the recorder. `at`/`gapMs` are the recorder's own
 *  — a caller that could choose them could forge the timing evidence. */
export type TrailInput =
  | { kind: 'click'; target: StampTarget | null }
  | { kind: 'typed'; target: StampTarget }
  // Back/forward has no kind of its own. The bridge's `navigated` event reports
  // a pathname and a hash and nothing about the CAUSE, so a popstate and a
  // pushState are indistinguishable to the host — and recording a guess would
  // be inventing evidence. History movement is simply a navigation.
  | { kind: 'navigate'; route: string }
  | { kind: 'note'; annotationId?: string }

interface Stamped {
  seq: number
  entry: TrailEntry
}

interface Ring {
  /** Monotonic within the ring — the note cut is a sequence number, not an
   *  index, because the ring drops from the front once it is full. */
  seq: number
  /** When the previous entry landed, so `gapMs` is a real gap. */
  lastAtMs: number
  /** The sequence of the last `note` entry; a note's slice is everything past
   *  it. Zero until the first note, so the first slice is the whole run. */
  lastNoteSeq: number
  entries: Stamped[]
  /** A scroll burst in progress: where it currently rests, and when it last
   *  moved. Flushed by the timer, by any other event, or by a read. */
  pendingScroll: { scrollY: number; atMs: number } | null
  scrollTimer: ReturnType<typeof setTimeout> | null
}

const rings = new Map<string, Ring>()

function keyOf(canvasId: string, versionId: string): string {
  return `${canvasId}:${versionId}`
}

function ringFor(canvasId: string, versionId: string): Ring {
  const key = keyOf(canvasId, versionId)
  const existing = rings.get(key)
  if (existing) return existing
  const fresh: Ring = { seq: 0, lastAtMs: 0, lastNoteSeq: 0, entries: [], pendingScroll: null, scrollTimer: null }
  rings.set(key, fresh)
  return fresh
}

/** Append one already-built entry, minting its sequence and enforcing the cap. */
function push(ring: Ring, atMs: number, build: (at: string, gapMs: number) => TrailEntry): void {
  const gapMs = ring.lastAtMs === 0 ? 0 : Math.max(0, atMs - ring.lastAtMs)
  ring.lastAtMs = atMs
  ring.seq += 1
  ring.entries.push({ seq: ring.seq, entry: build(new Date(atMs).toISOString(), gapMs) })
  // Oldest first: a run long enough to hit the cap is one where the recent
  // moves are the ones a note is about.
  while (ring.entries.length > MAX_TRAIL_ENTRIES_PER_RUN) ring.entries.shift()
}

/** Land a scroll burst that has stopped moving, if one is outstanding. */
function flushScroll(ring: Ring): void {
  const pending = ring.pendingScroll
  if (ring.scrollTimer !== null) {
    clearTimeout(ring.scrollTimer)
    ring.scrollTimer = null
  }
  ring.pendingScroll = null
  if (!pending) return
  // Stamped at the moment the movement SETTLED, not at the moment the timer
  // fired or another event forced the flush — otherwise the gap either side of
  // a scroll would be invented rather than measured.
  push(ring, pending.atMs, (at, gapMs) => ({ at, gapMs, kind: 'scroll', scrollY: pending.scrollY }))
}

/**
 * Record one action on this canvas+version's run.
 *
 * `nowMs` is injectable so the tests can drive the clock; every production
 * caller leaves it alone.
 */
export function recordTrailEvent(canvasId: string, versionId: string, input: TrailInput, nowMs = Date.now()): void {
  const ring = ringFor(canvasId, versionId)
  // Chronology first: a scroll that has not landed yet happened BEFORE whatever
  // is being recorded now.
  flushScroll(ring)
  push(ring, nowMs, (at, gapMs) => {
    switch (input.kind) {
      case 'click':
        return { at, gapMs, kind: 'click', target: input.target }
      case 'typed':
        return { at, gapMs, kind: 'typed', target: input.target }
      case 'navigate':
        return { at, gapMs, kind: 'navigate', route: input.route }
      case 'note':
        return { at, gapMs, kind: 'note', ...(input.annotationId ? { annotationId: input.annotationId } : {}) }
    }
  })
}

/**
 * The page moved. Nothing is recorded until it has been still for
 * SCROLL_PAUSE_MS — see the constant.
 */
export function recordTrailScroll(canvasId: string, versionId: string, scrollY: number, nowMs = Date.now()): void {
  const ring = ringFor(canvasId, versionId)
  ring.pendingScroll = { scrollY, atMs: nowMs }
  if (ring.scrollTimer !== null) clearTimeout(ring.scrollTimer)
  ring.scrollTimer = setTimeout(() => {
    ring.scrollTimer = null
    flushScroll(ring)
  }, SCROLL_PAUSE_MS)
}

/** The whole run, oldest first — what rides the review at submit. */
export function trailForRun(canvasId: string, versionId: string): TrailEntry[] {
  const ring = ringFor(canvasId, versionId)
  flushScroll(ring)
  return ring.entries.map((e) => e.entry)
}

/**
 * The slice a NOTE carries: everything since the previous note, capped.
 *
 * The tail is kept rather than the head when the cap bites — a note is about
 * what just happened, and the moves immediately before it are the ones that
 * reproduce it.
 */
export function trailSinceLastNote(canvasId: string, versionId: string): TrailEntry[] {
  const ring = ringFor(canvasId, versionId)
  flushScroll(ring)
  const since = ring.entries.filter((e) => e.seq > ring.lastNoteSeq).map((e) => e.entry)
  return since.length > MAX_TRAIL_ENTRIES_PER_NOTE ? since.slice(since.length - MAX_TRAIL_ENTRIES_PER_NOTE) : since
}

/**
 * A note was saved: mark it on the trail and cut the next slice from here.
 *
 * The marker is part of the run's own record — reading a trail back, "note
 * saved" is what separates one piece of evidence from the next.
 */
export function markTrailNoteSaved(canvasId: string, versionId: string, annotationId?: string, nowMs = Date.now()): void {
  const ring = ringFor(canvasId, versionId)
  recordTrailEvent(canvasId, versionId, { kind: 'note', ...(annotationId ? { annotationId } : {}) }, nowMs)
  ring.lastNoteSeq = ring.seq
}

/** Drop one run's trail — the version changed, or its round went out. */
export function resetTrail(canvasId: string, versionId: string): void {
  const key = keyOf(canvasId, versionId)
  const ring = rings.get(key)
  if (ring?.scrollTimer != null) clearTimeout(ring.scrollTimer)
  rings.delete(key)
}

/** Drop every run on a canvas — it was deleted, or the pane left it. */
export function resetTrailsForCanvas(canvasId: string): void {
  const prefix = `${canvasId}:`
  for (const [key, ring] of rings) {
    if (!key.startsWith(prefix)) continue
    if (ring.scrollTimer !== null) clearTimeout(ring.scrollTimer)
    rings.delete(key)
  }
}

/** Every ring, gone. Called from canvasStore.reset(). */
export function resetAllTrails(): void {
  for (const ring of rings.values()) {
    if (ring.scrollTimer !== null) clearTimeout(ring.scrollTimer)
  }
  rings.clear()
}

/** How many runs are being recorded — the leak check the suite makes. */
export function _trailRingCountForTest(): number {
  return rings.size
}
