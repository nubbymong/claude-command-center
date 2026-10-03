// [host] WP2 PR 4, P4.1 (row 51): the canvas marker queue's wiring for a
// Codex session (src/main/canvas/canvas-marker-delivery.ts). A Codex
// session's marker goes through the submit primitive, whose answer comes
// later; a marker it did not deliver is handed on with the canvas it was
// filed on, so the canvas can show it on its review. Claude's markers keep
// their synchronous write and raise nothing. The queue's own rule (held while
// a turn is open, flushed at the boundary) is unchanged: Codex's hook events
// drive it once its hooks are trusted, and until then the primitive holds
// the marker until Codex's prompt is ready (codex-composer-submit.test.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CanvasMarkerUndelivered, SubmitTextResult } from '../../../src/shared/types'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const marker = await import('../../../src/main/canvas/canvas-marker-delivery')

const SID = 'mkcx1111mkcx1111mkcx1111'
const CID = 'cnv-0123456789abcdef'
const LINE = `Review #3 ${String.fromCharCode(0x2014)} 5 notes ${String.fromCharCode(0xb7)} canvas_review R3`
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let undelivered: CanvasMarkerUndelivered[]
let emit: (sessionId: string, event: string) => void
let answer: (sessionId: string, line: string) => void | Promise<SubmitTextResult>

beforeEach(() => {
  undelivered = []
  marker._resetCanvasMarkerQueueForTest()
  marker.startCanvasMarkerQueue({
    write: (sessionId, line) => answer(sessionId, line),
    subscribe: (cb) => { emit = cb },
    onUndelivered: (u) => { undelivered.push(u) },
  })
})

describe('a Codex marker the primitive did not deliver is shown on its canvas', () => {
  it('hands on the session, the canvas, the line and the reason', async () => {
    answer = () => Promise.resolve({ delivered: false, reason: 'busy-timeout' })
    expect(marker.deliverCanvasMarker(SID, LINE, CID)).toBe('sent')
    await flush()
    expect(undelivered).toEqual([{ sessionId: SID, canvasId: CID, line: LINE, reason: 'busy-timeout' }])
  })

  it('a delivered marker raises nothing', async () => {
    answer = () => Promise.resolve({ delivered: true })
    marker.deliverCanvasMarker(SID, LINE, CID)
    await flush()
    expect(undelivered).toEqual([])
  })

  it('a marker queued over an open turn is answered when it is flushed at the boundary', async () => {
    const results: Array<(r: SubmitTextResult) => void> = []
    answer = () => new Promise((resolve) => { results.push(resolve) })
    emit(SID, 'UserPromptSubmit')
    expect(marker.deliverCanvasMarker(SID, LINE, CID)).toBe('queued')
    expect(results).toHaveLength(0)
    emit(SID, 'Stop')
    expect(results).toHaveLength(1)
    results[0]({ delivered: false, reason: 'prompt-on-screen' })
    await flush()
    expect(undelivered.map((u) => u.reason)).toEqual(['prompt-on-screen'])
  })

  it('without the canvas it was filed on, nothing is raised (it cannot be placed)', async () => {
    answer = () => Promise.resolve({ delivered: false, reason: 'not-drawn' })
    marker.deliverCanvasMarker(SID, LINE)
    await flush()
    expect(undelivered).toEqual([])
  })

  it('a session that ends drops what it held, and its canvas record with it', async () => {
    let resolveLater: (r: SubmitTextResult) => void = () => {}
    answer = () => new Promise((resolve) => { resolveLater = resolve })
    marker.deliverCanvasMarker(SID, LINE, CID)
    marker.forgetCanvasMarkers(SID)
    resolveLater({ delivered: false, reason: 'session-gone' })
    await flush()
    expect(undelivered).toEqual([])
  })

  it('a Claude session\'s synchronous write raises nothing', async () => {
    const written: string[] = []
    answer = (_s, line) => { written.push(line) }
    marker.deliverCanvasMarker(SID, LINE, CID)
    await flush()
    expect(written).toEqual([LINE])
    expect(undelivered).toEqual([])
  })
})

describe('two canvases of one session filing the same line (ADR-009 round 1, L2-1)', () => {
  // Version and review numbers are counted per canvas, so two canvases of one
  // session can file the very same marker line. Each marker carries its own
  // canvas with its write, never looked up by the line.
  const CANVAS_A = 'cnv-aaaaaaaaaaaaaaaa'
  const CANVAS_B = 'cnv-bbbbbbbbbbbbbbbb'
  const APPROVAL = `Approved v1 on the canvas ${String.fromCharCode(0xb7)} canvas_version_verdict recorded`

  it('[host] canvas A\'s undelivered marker is raised on canvas A only, while B\'s same line was delivered', async () => {
    const results: Array<(r: SubmitTextResult) => void> = []
    answer = () => new Promise((resolve) => { results.push(resolve) })
    marker.deliverCanvasMarker(SID, APPROVAL, CANVAS_A)
    marker.deliverCanvasMarker(SID, APPROVAL, CANVAS_B)
    expect(results).toHaveLength(2)
    results[0]({ delivered: false, reason: 'busy-timeout' })
    await flush()
    results[1]({ delivered: true })
    await flush()
    expect(undelivered).toEqual([{ sessionId: SID, canvasId: CANVAS_A, line: APPROVAL, reason: 'busy-timeout' }])
  })

  it('[host] and the other way round: B\'s is raised on B', async () => {
    const results: Array<(r: SubmitTextResult) => void> = []
    answer = () => new Promise((resolve) => { results.push(resolve) })
    marker.deliverCanvasMarker(SID, APPROVAL, CANVAS_A)
    marker.deliverCanvasMarker(SID, APPROVAL, CANVAS_B)
    results[1]({ delivered: false, reason: 'prompt-on-screen' })
    results[0]({ delivered: true })
    await flush()
    expect(undelivered).toEqual([{ sessionId: SID, canvasId: CANVAS_B, line: APPROVAL, reason: 'prompt-on-screen' }])
  })

  it('[host] held over an open turn: neither is folded into the other, and each is answered for its own canvas', async () => {
    const results: Array<(r: SubmitTextResult) => void> = []
    answer = () => new Promise((resolve) => { results.push(resolve) })
    emit(SID, 'UserPromptSubmit')
    expect(marker.deliverCanvasMarker(SID, APPROVAL, CANVAS_A)).toBe('queued')
    expect(marker.deliverCanvasMarker(SID, APPROVAL, CANVAS_B)).toBe('queued')
    // The same line about the SAME canvas again is still folded into the first.
    expect(marker.deliverCanvasMarker(SID, APPROVAL, CANVAS_A)).toBe('queued')
    emit(SID, 'Stop')
    expect(results).toHaveLength(2)
    results[0]({ delivered: true })
    results[1]({ delivered: false, reason: 'not-drawn' })
    await flush()
    expect(undelivered.map((u) => u.canvasId)).toEqual([CANVAS_B])
  })
})
