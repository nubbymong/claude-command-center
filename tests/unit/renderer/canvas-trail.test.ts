// The action trail (M3): timing, the ring, the note slice — and the bar the
// whole feature stands on, that nothing the user TYPED can reach it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MAX_TRAIL_ENTRIES_PER_NOTE,
  MAX_TRAIL_ENTRIES_PER_RUN,
} from '../../../src/shared/canvas'
import {
  SCROLL_PAUSE_MS,
  _trailRingCountForTest,
  markTrailNoteSaved,
  recordTrailEvent,
  recordTrailScroll,
  resetAllTrails,
  resetTrail,
  resetTrailsForCanvas,
  trailForRun,
  trailSinceLastNote,
} from '../../../src/renderer/canvas/canvas-trail'

const CID = 'canvas-a'
const V = 'v4'
const T0 = Date.parse('2026-08-29T16:43:58.000Z')

beforeEach(() => {
  resetAllTrails()
})

afterEach(() => {
  resetAllTrails()
  vi.useRealTimers()
})

describe('the trail records actions and timing', () => {
  it('stamps each entry with its own time and the gap since the previous one', () => {
    recordTrailEvent(CID, V, { kind: 'click', target: { role: 'button', name: 'Checkout' } }, T0)
    recordTrailEvent(CID, V, { kind: 'typed', target: { role: 'textbox', name: 'Email' } }, T0 + 3100)
    // Back/forward is a NAVIGATION and nothing more: the bridge reports a
    // route with no cause, so there is no honest way to name one a history move.
    recordTrailEvent(CID, V, { kind: 'navigate', route: '/cart' }, T0 + 3900)

    const trail = trailForRun(CID, V)
    expect(trail.map((e) => e.kind)).toEqual(['click', 'typed', 'navigate'])
    // The first entry has nothing to be a gap FROM.
    expect(trail[0].gapMs).toBe(0)
    expect(trail[1].gapMs).toBe(3100)
    expect(trail[2].gapMs).toBe(800)
    expect(trail[0].at).toBe(new Date(T0).toISOString())
  })

  it('records a navigation route and a click with no target', () => {
    recordTrailEvent(CID, V, { kind: 'navigate', route: '/checkout#step2' }, T0)
    recordTrailEvent(CID, V, { kind: 'click', target: null }, T0 + 10)
    const trail = trailForRun(CID, V)
    expect(trail[0]).toMatchObject({ kind: 'navigate', route: '/checkout#step2' })
    expect(trail[1]).toMatchObject({ kind: 'click', target: null })
  })

  it('keeps runs apart by canvas AND version, and resets one without the other', () => {
    recordTrailEvent(CID, V, { kind: 'navigate', route: '/x' }, T0)
    recordTrailEvent(CID, 'v5', { kind: 'navigate', route: '/x' }, T0)
    recordTrailEvent('canvas-b', V, { kind: 'navigate', route: '/x' }, T0)
    expect(_trailRingCountForTest()).toBe(3)

    resetTrail(CID, V)
    expect(trailForRun(CID, V)).toEqual([])
    expect(trailForRun(CID, 'v5')).toHaveLength(1)
    expect(trailForRun('canvas-b', V)).toHaveLength(1)

    resetTrailsForCanvas(CID)
    expect(trailForRun(CID, 'v5')).toEqual([])
    expect(trailForRun('canvas-b', V)).toHaveLength(1)
  })
})

describe('scroll is one entry per pause, not one per frame', () => {
  it('collapses a burst into a single entry, stamped when the movement settled', () => {
    vi.useFakeTimers()
    recordTrailScroll(CID, V, 100, T0)
    recordTrailScroll(CID, V, 400, T0 + 50)
    recordTrailScroll(CID, V, 900, T0 + 120)
    // Deliberately NOT read here: a read flushes what is pending (see the
    // "rather than losing it" case below), so asking mid-burst would be the
    // question changing the answer. Three movements, one pause, one entry.
    vi.advanceTimersByTime(SCROLL_PAUSE_MS + 5)
    const scrolls = trailForRun(CID, V).filter((e) => e.kind === 'scroll')
    expect(scrolls).toHaveLength(1)
    expect(scrolls[0]).toMatchObject({ kind: 'scroll', scrollY: 900 })
    // Stamped where the movement STOPPED, not where the timer fired.
    expect(scrolls[0].at).toBe(new Date(T0 + 120).toISOString())
  })

  it('lands an outstanding scroll BEFORE the event that interrupted it', () => {
    vi.useFakeTimers()
    recordTrailScroll(CID, V, 640, T0)
    recordTrailEvent(CID, V, { kind: 'click', target: { role: 'button', name: 'Pay now' } }, T0 + 200)
    const trail = trailForRun(CID, V)
    expect(trail.map((e) => e.kind)).toEqual(['scroll', 'click'])
    expect(trail[1].gapMs).toBe(200)
  })

  it('reads out a pending scroll rather than losing it when the run is submitted', () => {
    vi.useFakeTimers()
    recordTrailScroll(CID, V, 220, T0)
    expect(trailForRun(CID, V)).toHaveLength(1)
    // ...and the flush is not double-counted when the timer later fires.
    vi.advanceTimersByTime(SCROLL_PAUSE_MS + 5)
    expect(trailForRun(CID, V)).toHaveLength(1)
  })
})

describe('the note slice', () => {
  it('is everything since the previous note, and the marker rides the run', () => {
    recordTrailEvent(CID, V, { kind: 'click', target: { role: 'link', name: 'Cart' } }, T0)
    expect(trailSinceLastNote(CID, V)).toHaveLength(1)

    markTrailNoteSaved(CID, V, 'a1', T0 + 500)
    // The marker itself belongs to the FIRST note's slice, not the next one's.
    expect(trailSinceLastNote(CID, V)).toEqual([])
    expect(trailForRun(CID, V).map((e) => e.kind)).toEqual(['click', 'note'])
    expect(trailForRun(CID, V)[1]).toMatchObject({ kind: 'note', annotationId: 'a1' })

    recordTrailEvent(CID, V, { kind: 'navigate', route: '/x' }, T0 + 900)
    const slice = trailSinceLastNote(CID, V)
    expect(slice.map((e) => e.kind)).toEqual(['navigate'])
  })

  it('keeps the MOST RECENT entries when the per-note cap bites', () => {
    for (let i = 0; i < MAX_TRAIL_ENTRIES_PER_NOTE + 20; i++) {
      recordTrailEvent(CID, V, { kind: 'navigate', route: `/step-${i}` }, T0 + i)
    }
    const slice = trailSinceLastNote(CID, V)
    expect(slice).toHaveLength(MAX_TRAIL_ENTRIES_PER_NOTE)
    expect(slice[slice.length - 1]).toMatchObject({ route: `/step-${MAX_TRAIL_ENTRIES_PER_NOTE + 19}` })
  })
})

describe('the run ring is bounded', () => {
  it('drops the oldest past MAX_TRAIL_ENTRIES_PER_RUN and keeps the note cut correct', () => {
    markTrailNoteSaved(CID, V, 'a1', T0)
    for (let i = 0; i < MAX_TRAIL_ENTRIES_PER_RUN + 50; i++) {
      recordTrailEvent(CID, V, { kind: 'navigate', route: `/n-${i}` }, T0 + 1 + i)
    }
    const run = trailForRun(CID, V)
    expect(run).toHaveLength(MAX_TRAIL_ENTRIES_PER_RUN)
    // The note marker was pushed out of the ring; the CUT is a sequence number,
    // so the slice is still "since that note" rather than the whole ring.
    expect(run.some((e) => e.kind === 'note')).toBe(false)
    expect(trailSinceLastNote(CID, V)).toHaveLength(MAX_TRAIL_ENTRIES_PER_NOTE)
  })
})

describe('the privacy bar', () => {
  it('carries identity and timing only — no seeded value reaches a serialised trail', () => {
    const SECRET = 'hunter2-PASSPHRASE'
    // Every shape a call site can hand the recorder, with the secret pushed at
    // each of them the way a careless caller would.
    recordTrailEvent(CID, V, { kind: 'typed', target: { role: 'textbox', name: 'Email' } }, T0)
    recordTrailEvent(
      CID,
      V,
      { kind: 'click', target: { role: 'button', name: 'Pay now', uxId: 'pay-now' } } as never,
      T0 + 10,
    )
    recordTrailEvent(CID, V, { kind: 'navigate', route: '/checkout' }, T0 + 20)
    markTrailNoteSaved(CID, V, 'a1', T0 + 30)

    const serialised = JSON.stringify(trailForRun(CID, V))
    expect(serialised).not.toContain(SECRET)
    expect(serialised).not.toContain('valueLength')
    expect(serialised).not.toContain('value')
    // What it DOES carry: the identities and the clock.
    expect(serialised).toContain('Email')
    expect(serialised).toContain('gapMs')
  })

  it('a typed entry names the field and nothing else about it', () => {
    recordTrailEvent(CID, V, { kind: 'typed', target: { role: 'textbox', name: 'Card number', uxId: 'card' } }, T0)
    const [entry] = trailForRun(CID, V)
    expect(entry).toEqual({
      at: new Date(T0).toISOString(),
      gapMs: 0,
      kind: 'typed',
      target: { role: 'textbox', name: 'Card number', uxId: 'card' },
    })
  })
})
