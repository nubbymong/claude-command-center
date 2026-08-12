// The main-side half of a capture: correlation, the timeout that stops a wedged
// frame holding an MCP call open, and the concurrency cap.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  requestCanvasSnapshot,
  resolveCanvasSnapshot,
  setSnapshotSender,
  SNAPSHOT_TIMEOUT_MS,
  _resetSnapshotBrokerForTest,
} from '../../../src/main/canvas/canvas-snapshot-broker'
import { FRAME_TIMEOUT_MS } from '../../../src/renderer/canvas/canvas-snapshot-host'
import { ANALYSIS_RUN_TIMEOUT_MS } from '../../../src/main/canvas/bridge/analysis-loader'
import type { CanvasSnapshotRequestEvent } from '../../../src/shared/canvas'

const REQUEST = { sessionId: 'sess-1', canvasId: 'c1', versionId: 'v1', options: {} }

let sent: CanvasSnapshotRequestEvent[]

function armSender(ok = true): void {
  sent = []
  setSnapshotSender((event) => {
    sent.push(event)
    return ok
  })
}

function okReply(requestId: string, result: unknown) {
  return { requestId, ok: true, result }
}

beforeEach(() => {
  _resetSnapshotBrokerForTest()
  armSender()
})

afterEach(() => {
  _resetSnapshotBrokerForTest()
  vi.useRealTimers()
})

describe('correlation', () => {
  it('resolves the matching request and nothing else', async () => {
    const first = requestCanvasSnapshot(REQUEST)
    const second = requestCanvasSnapshot({ ...REQUEST, versionId: 'v2' })
    expect(sent).toHaveLength(2)
    expect(sent[0].requestId).not.toBe(sent[1].requestId)

    resolveCanvasSnapshot(okReply(sent[1].requestId, { viewport: { width: 10, height: 20, dpr: 1 }, root: { ref: 'e0', role: 'document', name: 'second', box: {}, children: [] } }))
    await expect(second).resolves.toMatchObject({ root: { name: 'second' } })

    resolveCanvasSnapshot(okReply(sent[0].requestId, { viewport: { width: 1, height: 2, dpr: 1 }, root: { ref: 'e0', role: 'document', name: 'first', box: {}, children: [] } }))
    await expect(first).resolves.toMatchObject({ root: { name: 'first' } })
  })

  it('sanitises whatever the frame sent before anyone downstream sees it', async () => {
    const pending = requestCanvasSnapshot(REQUEST)
    resolveCanvasSnapshot(
      okReply(sent[0].requestId, {
        viewport: { width: 'wide', height: null, dpr: 0 },
        root: { ref: 'e0', role: 'document', name: 'x\ny', box: {}, children: [] },
      }),
    )
    const result = await pending
    expect(result.viewport).toEqual({ width: 0, height: 0, dpr: 1 })
    expect(result.root.name).not.toContain('\n')
  })

  it('decides for itself whether the capture was scoped', async () => {
    // Styles are the dominant token cost and ride only on scoped nodes. The
    // bridge enforced that — i.e. code inside the page, which a hostile
    // document replaces. This side knows the honest answer because it made the
    // request, so it is the side that must decide, and it must fail closed.
    const styles = { color: 'rgb(1, 2, 3)', margin: '4px' }
    const reply = (requestId: string) =>
      okReply(requestId, {
        viewport: { width: 100, height: 100, dpr: 1 },
        root: { ref: 'e0', role: 'document', name: '', box: {}, styles, children: [] },
      })

    const unscoped = requestCanvasSnapshot({ ...REQUEST, options: {} })
    resolveCanvasSnapshot(reply(sent[0].requestId))
    expect((await unscoped).root.styles).toBeUndefined()

    armSender()
    const scoped = requestCanvasSnapshot({ ...REQUEST, options: { scope: ['card-1'] } })
    resolveCanvasSnapshot(reply(sent[0].requestId))
    expect((await scoped).root.styles).toEqual(styles)
  })

  it('rejects with the frame-supplied reason on an error reply', async () => {
    const pending = requestCanvasSnapshot(REQUEST)
    resolveCanvasSnapshot({ requestId: sent[0].requestId, ok: false, error: 'no canvas open' })
    await expect(pending).rejects.toThrow('no canvas open')
  })

  it('ignores unknown, duplicate and malformed replies', async () => {
    const pending = requestCanvasSnapshot(REQUEST)
    for (const junk of [null, 42, 'x', {}, { requestId: 7 }, { requestId: 'not-a-request' }]) {
      expect(() => resolveCanvasSnapshot(junk)).not.toThrow()
    }
    resolveCanvasSnapshot(okReply(sent[0].requestId, { viewport: {}, root: { ref: 'e0', role: 'document', name: 'once', box: {}, children: [] } }))
    await expect(pending).resolves.toMatchObject({ root: { name: 'once' } })
    // A late duplicate (the classic after-timeout reply) is a no-op.
    expect(() => resolveCanvasSnapshot(okReply(sent[0].requestId, { root: {} }))).not.toThrow()
  })
})

describe('bounds', () => {
  it('times out rather than holding the tool call open forever', async () => {
    vi.useFakeTimers()
    const pending = requestCanvasSnapshot(REQUEST)
    const assertion = expect(pending).rejects.toThrow(/did not answer in time/)
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS + 10)
    await assertion
  })

  it('one session cannot starve another: the cap is per session', async () => {
    const busy = [
      requestCanvasSnapshot({ ...REQUEST, sessionId: 'sess-loop' }),
      requestCanvasSnapshot({ ...REQUEST, sessionId: 'sess-loop' }),
      requestCanvasSnapshot({ ...REQUEST, sessionId: 'sess-loop' }),
      requestCanvasSnapshot({ ...REQUEST, sessionId: 'sess-loop' }),
    ]
    await expect(requestCanvasSnapshot({ ...REQUEST, sessionId: 'sess-loop' })).rejects.toThrow(/already in flight/)

    // A different session is unaffected.
    const victim = requestCanvasSnapshot({ ...REQUEST, sessionId: 'sess-victim' })
    const victimEvent = sent[sent.length - 1]
    resolveCanvasSnapshot(okReply(victimEvent.requestId, { viewport: {}, root: { ref: 'e0', role: 'document', name: 'served', box: {}, children: [] } }))
    await expect(victim).resolves.toMatchObject({ root: { name: 'served' } })

    for (const event of sent.slice(0, 4)) {
      resolveCanvasSnapshot(okReply(event.requestId, { viewport: {}, root: { ref: 'e0', role: 'document', name: '', box: {}, children: [] } }))
    }
    await Promise.all(busy)
  })

  it('refuses more than a handful of concurrent captures', async () => {
    const inFlight = [
      requestCanvasSnapshot(REQUEST),
      requestCanvasSnapshot(REQUEST),
      requestCanvasSnapshot(REQUEST),
      requestCanvasSnapshot(REQUEST),
    ]
    await expect(requestCanvasSnapshot(REQUEST)).rejects.toThrow(/already in flight/)

    // Draining one frees a slot.
    resolveCanvasSnapshot(okReply(sent[0].requestId, { viewport: {}, root: { ref: 'e0', role: 'document', name: '', box: {}, children: [] } }))
    await inFlight[0]
    const next = requestCanvasSnapshot(REQUEST)
    expect(sent).toHaveLength(5)
    resolveCanvasSnapshot(okReply(sent[4].requestId, { viewport: {}, root: { ref: 'e0', role: 'document', name: '', box: {}, children: [] } }))
    await expect(next).resolves.toBeDefined()

    for (const event of sent.slice(1, 4)) {
      resolveCanvasSnapshot(okReply(event.requestId, { viewport: {}, root: { ref: 'e0', role: 'document', name: '', box: {}, children: [] } }))
    }
    await Promise.all(inFlight)
  })

  it('fails fast when there is no window to ask', async () => {
    _resetSnapshotBrokerForTest()
    await expect(requestCanvasSnapshot(REQUEST)).rejects.toThrow(/window is not available/)

    armSender(false) // window present but the send failed
    await expect(requestCanvasSnapshot(REQUEST)).rejects.toThrow(/window is not available/)
  })
})

// The timeout tests above advance the clock by `SNAPSHOT_TIMEOUT_MS + 10` — they
// read the constant they exist to pin, so setting it to ~24 days left them green
// and the bound was never actually guarded. What matters is not that a timer
// exists but that it fires SOON, and that the renderer's own timeout sits inside
// main's so a slow frame surfaces the specific message, not the generic one.
describe('the bounds themselves', () => {
  it('keeps the capture timeouts short and correctly nested', () => {
    expect(SNAPSHOT_TIMEOUT_MS).toBe(30_000)
    expect(FRAME_TIMEOUT_MS).toBe(25_000)
    expect(FRAME_TIMEOUT_MS).toBeLessThan(SNAPSHOT_TIMEOUT_MS)
    // An MCP call must never outlive a reasonable human wait.
    expect(SNAPSHOT_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('bounds the analysis run so a wedged rule pass cannot hold the reply', () => {
    expect(ANALYSIS_RUN_TIMEOUT_MS).toBe(12_000)
    expect(ANALYSIS_RUN_TIMEOUT_MS).toBeLessThan(FRAME_TIMEOUT_MS)
  })
})
