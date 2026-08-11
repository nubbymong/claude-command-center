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
