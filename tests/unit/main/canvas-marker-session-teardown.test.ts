/**
 * A canvas marker must not outlive the conversation it was filed against
 * (adversarial review, 2026-09-01 — HIGH).
 *
 * THE BUG. `forgetCanvasMarkers` was wired to ONE place: the `pty:kill` IPC
 * listener in pty-handlers.ts, i.e. the renderer closing a tab. It was NOT in
 * `cleanupSessionResources`, which is the teardown BOTH other paths run —
 * `killPty` (which a Restart and a switch-account respawn call before spawning
 * again UNDER THE SAME SESSION ID) and the natural-exit block.
 *
 * So: file a verdict while the agent's turn is open (the marker is held, by
 * design), restart the session, and the queue still holds that line with
 * `turnOpen` true against a session id the new process now owns. The queue
 * treats `SessionStart` as a boundary and flushes on it — which is precisely
 * the first hook the NEW conversation fires. The agent's opening context is then
 * a line saying a verdict was filed on work it has never seen, and that line is
 * the literal trigger text for the canvas skill. A natural PTY exit reached no
 * clear at all, so the marker simply waited for something to flush it.
 *
 * This drives the REAL pty-manager teardown against the REAL marker queue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => 'linux' }))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ onData() {}, onExit() {}, write() {}, kill() {}, pid: 1 })) }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ stopWatchdog: vi.fn(), noteRedrawTrigger: vi.fn() }),
}))

const { killPty } = await import('../../../src/main/pty-manager')
const marker = await import('../../../src/main/canvas/canvas-marker-delivery')

const SID = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const OTHER = 'b1b2c3d4e5f6b1b2c3d4e5f6'
const APPROVAL = 'Approved v7 on the canvas · canvas_version_verdict recorded'

let written: string[]
/** The hook stream the queue subscribes to at boot (index.ts wires the gateway). */
let emit: (sessionId: string, event: string) => void

beforeEach(() => {
  written = []
  marker._resetCanvasMarkerQueueForTest()
  marker.startCanvasMarkerQueue({
    write: (_sessionId, line) => { written.push(line) },
    subscribe: (cb) => { emit = cb },
  })
})

describe('cleanupSessionResources drops the session`s queued canvas markers', () => {
  // Mutation to prove this can fail: remove the `forgetCanvasMarkers(sessionId)`
  // call from cleanupSessionResources (pty-manager.ts) — the marker then
  // survives the teardown and the NEW conversation's first SessionStart flushes
  // it into the fresh agent.
  it('a marker held across a respawn is NOT written into the new conversation', () => {
    emit(SID, 'UserPromptSubmit')            // the agent is mid-turn
    expect(marker.deliverCanvasMarker(SID, APPROVAL)).toBe('queued')
    expect(written).toEqual([])

    killPty(SID)                              // Restart / switch-account teardown

    // The new process, same session id, fires its first hook.
    emit(SID, 'SessionStart')
    expect(written).toEqual([])
  })

  it('the whole session state goes, not just the pending list — the stale turn does too', () => {
    emit(SID, 'UserPromptSubmit')
    marker.deliverCanvasMarker(SID, APPROVAL)
    killPty(SID)

    // A queue that kept `turnOpen` would HOLD the new session's first marker
    // against a turn that belongs to a process that is gone.
    expect(marker.deliverCanvasMarker(SID, 'Review #1 — 1 notes · canvas_review R1')).toBe('sent')
    expect(written).toEqual(['Review #1 — 1 notes · canvas_review R1'])
  })

  it('touches only the session being torn down', () => {
    emit(SID, 'UserPromptSubmit')
    emit(OTHER, 'UserPromptSubmit')
    marker.deliverCanvasMarker(SID, APPROVAL)
    marker.deliverCanvasMarker(OTHER, APPROVAL)

    killPty(SID)

    emit(OTHER, 'Stop')
    expect(written).toEqual([APPROVAL])
  })

  it('is idempotent — tearing down a session with no markers is a no-op', () => {
    expect(() => { killPty(SID); killPty(SID) }).not.toThrow()
    expect(written).toEqual([])
  })
})
