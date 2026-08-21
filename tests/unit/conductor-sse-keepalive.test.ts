/**
 * SSE keepalive for the Conductor MCP server.
 *
 * Observed 2026-08-21: an agent went 72 minutes without a canvas or vision call
 * — a VM run, five PR merges, CI polling — and its next `canvas_render` came
 * back `404 transport session not found`. The app had never restarted (all
 * seven processes still carried their original creation time) and the agent's
 * own process was untouched, so nothing had died: the SSE stream had simply
 * carried zero bytes for over an hour, been reaped somewhere in the path, and
 * been silently re-established. `transports` is keyed by SSE CONNECTION, and
 * the close handler deletes the entry, so the next call arrived holding the id
 * of a stream that no longer existed.
 *
 * This is NOT the same as the `requestTimeout = 0` fix already in that file.
 * That stopped Node's own clock destroying the response at exactly 5:00. No
 * server-side timer setting can stop an idle connection being dropped by
 * something else in the path; only traffic can.
 */
import { describe, it, expect, vi } from 'vitest'
import { armSseKeepAlive, SSE_KEEPALIVE_MS } from '../../src/main/conductor-mcp-server'

/** A stand-in for ServerResponse, narrowed to what the keepalive touches. */
function fakeRes(over: Partial<{ writableEnded: boolean; destroyed: boolean; throwOnWrite: boolean }> = {}) {
  const writes: string[] = []
  return {
    writes,
    writableEnded: over.writableEnded ?? false,
    destroyed: over.destroyed ?? false,
    write(chunk: string) {
      if (over.throwOnWrite) throw new Error('ERR_STREAM_WRITE_AFTER_END')
      writes.push(chunk)
      return true
    },
  }
}

/** A controllable timer: tick() runs the callback on demand. */
function fakeTimer() {
  let cb: (() => void) | null = null
  let cleared = false
  let unrefs = 0
  return {
    set: (fn: () => void) => { cb = fn; return { unref: () => { unrefs++ } } },
    clear: () => { cleared = true },
    tick: () => cb?.(),
    get cleared() { return cleared },
    get unrefs() { return unrefs },
    get armed() { return cb !== null },
  }
}

describe('armSseKeepAlive', () => {
  it('writes a COMMENT frame, which every SSE client ignores', () => {
    // Not a data frame: that would be a message the client has to parse and
    // discard. A `:` line is the protocol's own no-op.
    const res = fakeRes()
    const t = fakeTimer()
    armSseKeepAlive(res, 1000, t.set, t.clear)
    t.tick()
    expect(res.writes).toEqual([': ping\n\n'])
    expect(res.writes[0].startsWith(':')).toBe(true)
  })

  it('keeps writing on every tick — one heartbeat would not keep anything alive', () => {
    const res = fakeRes()
    const t = fakeTimer()
    armSseKeepAlive(res, 1000, t.set, t.clear)
    t.tick(); t.tick(); t.tick()
    expect(res.writes).toHaveLength(3)
  })

  it('never writes to a stream that has already ended', () => {
    // The window between the socket going away and `close` firing. A throw in a
    // timer has no caller to catch it.
    const res = fakeRes({ writableEnded: true })
    const t = fakeTimer()
    armSseKeepAlive(res, 1000, t.set, t.clear)
    t.tick()
    expect(res.writes).toEqual([])
  })

  it('never writes to a destroyed stream', () => {
    const res = fakeRes({ destroyed: true })
    const t = fakeTimer()
    armSseKeepAlive(res, 1000, t.set, t.clear)
    t.tick()
    expect(res.writes).toEqual([])
  })

  it('swallows a write that throws anyway', () => {
    // The peer can vanish mid-write. A heartbeat failing is never a reason to
    // take anything else down.
    const res = fakeRes({ throwOnWrite: true })
    const t = fakeTimer()
    armSseKeepAlive(res, 1000, t.set, t.clear)
    expect(() => t.tick()).not.toThrow()
  })

  it('unrefs the timer so it cannot hold the process open', () => {
    const res = fakeRes()
    const t = fakeTimer()
    armSseKeepAlive(res, 1000, t.set, t.clear)
    expect(t.unrefs).toBe(1)
  })

  it('the returned stop function clears the timer', () => {
    const res = fakeRes()
    const t = fakeTimer()
    const stop = armSseKeepAlive(res, 1000, t.set, t.clear)
    expect(t.cleared).toBe(false)
    stop()
    expect(t.cleared).toBe(true)
  })

  it('defaults to an interval well inside the windows that reap a connection', () => {
    // 60 s is the shortest idle timeout in common use; anything at or above it
    // would be a heartbeat that arrives after the thing it exists to prevent.
    expect(SSE_KEEPALIVE_MS).toBeLessThan(60_000)
    expect(SSE_KEEPALIVE_MS).toBeGreaterThan(0)
  })

  it('survives a real setInterval without leaking a live handle', async () => {
    // The default path, not the injected one — an interval that is never
    // cleared is exactly the leak this could introduce, one per SSE connection.
    const res = fakeRes()
    const stop = armSseKeepAlive(res, 5)
    await new Promise((r) => setTimeout(r, 30))
    stop()
    const after = res.writes.length
    expect(after).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 25))
    expect(res.writes.length).toBe(after) // stopped means stopped
  })
})
