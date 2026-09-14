/**
 * #580 — a canvas verdict must reach the agent even when it is filed mid-turn.
 *
 * The live failure: a clean APPROVAL on the Agent Canvas delivered NOTHING to
 * the session when it fired while the agent was working. It arrived fine when
 * the agent was idle. A clean approval creates no review record either (the
 * store refuses a round with no notes), so the marker line IS the delivery —
 * lose it and the approval never happened as far as the agent is concerned.
 *
 * The rule under test: hold a marker while the turn is open, flush it at the
 * boundary, in order, and never hold one for ever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))

const { CanvasMarkerQueue, MARKER_FALLBACK_FLUSH_MS, MARKER_QUEUE_MAX } =
  await import('../../../src/main/canvas/canvas-marker-queue')

const SID = 'session-1'
const APPROVAL = 'Approved v7 on the canvas · canvas_version_verdict recorded'
const REVIEW = 'Review #3 — 5 notes · canvas_review R3'

let written: Array<{ sessionId: string; line: string }>
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>

function makeQueue() {
  return new CanvasMarkerQueue({
    write: (sessionId, line) => { written.push({ sessionId, line }) },
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return () => { entry.cancelled = true }
    },
  })
}

/** Run the newest live timer, the way the real clock eventually would. */
function fireFallback() {
  const live = timers.filter((t) => !t.cancelled)
  expect(live.length).toBeGreaterThan(0)
  live[live.length - 1].fn()
}

beforeEach(() => {
  written = []
  timers = []
})

describe('idle: the marker goes straight out', () => {
  it('writes immediately when no turn has ever opened', () => {
    const q = makeQueue()
    expect(q.deliver(SID, APPROVAL)).toBe('sent')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    expect(q.pendingCount(SID)).toBe(0)
  })

  it('writes immediately again once the turn has ended', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent(SID, 'Stop')
    expect(q.deliver(SID, APPROVAL)).toBe('sent')
    expect(written).toHaveLength(1)
  })

  it('arms no fallback timer for a marker that went straight out', () => {
    const q = makeQueue()
    q.deliver(SID, APPROVAL)
    expect(timers).toHaveLength(0)
  })
})

describe('busy: nothing is lost', () => {
  it('holds the marker while the agent turn is open, then flushes it on Stop', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    expect(q.deliver(SID, APPROVAL)).toBe('queued')
    expect(written).toHaveLength(0)
    expect(q.pendingCount(SID)).toBe(1)

    q.noteHookEvent(SID, 'Stop')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    expect(q.pendingCount(SID)).toBe(0)
  })

  it('a tool call opens the turn too — not only a user prompt', () => {
    for (const opener of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']) {
      written = []
      timers = []
      const q = makeQueue()
      q.noteHookEvent(SID, opener)
      expect(q.deliver(SID, APPROVAL)).toBe('queued')
      expect(written).toHaveLength(0)
    }
  })

  it('a Notification does NOT open a turn — Claude fires it when it WANTS input', () => {
    // A false "open" here would park every marker until some later turn ended,
    // which is the same bug wearing the opposite sign.
    const q = makeQueue()
    q.noteHookEvent(SID, 'Notification')
    expect(q.isTurnOpen(SID)).toBe(false)
    expect(q.deliver(SID, APPROVAL)).toBe('sent')
  })

  it('a SubagentStop does not close the MAIN turn', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent(SID, 'SubagentStop')
    expect(q.isTurnOpen(SID)).toBe(true)
    expect(q.deliver(SID, APPROVAL)).toBe('queued')
    expect(written).toHaveLength(0)
  })

  it('ORDER IS PRESERVED — two rounds filed in one turn arrive as they were filed', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, 'Review #3 — 2 notes · canvas_review R3')
    q.deliver(SID, 'Review #4 — 1 notes · canvas_review R4')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([
      'Review #3 — 2 notes · canvas_review R3',
      'Review #4 — 1 notes · canvas_review R4',
      APPROVAL,
    ])
  })

  it('holds across a whole turn of tool calls, not just the prompt', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, REVIEW)
    q.noteHookEvent(SID, 'PreToolUse')
    q.noteHookEvent(SID, 'PostToolUse')
    q.noteHookEvent(SID, 'PreToolUse')
    expect(written).toHaveLength(0)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([REVIEW])
  })

  it('keeps sessions apart: one session`s turn never gates another`s marker', () => {
    const q = makeQueue()
    q.noteHookEvent('busy', 'UserPromptSubmit')
    expect(q.deliver('busy', APPROVAL)).toBe('queued')
    expect(q.deliver('idle', APPROVAL)).toBe('sent')
    expect(written).toEqual([{ sessionId: 'idle', line: APPROVAL }])
    q.noteHookEvent('busy', 'Stop')
    expect(written).toHaveLength(2)
    expect(written[1].sessionId).toBe('busy')
  })

  it('a Stop for a session that queued nothing writes nothing', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent(SID, 'Stop')
    expect(written).toHaveLength(0)
  })
})

describe('a turn that never ends', () => {
  it('flushes anyway on the fallback — late beats lost', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    expect(timers[0].ms).toBe(MARKER_FALLBACK_FLUSH_MS)
    expect(written).toHaveLength(0)

    fireFallback()
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    // ...and the turn is presumed over, so the next marker is immediate.
    expect(q.deliver(SID, REVIEW)).toBe('sent')
  })

  it('arms ONE fallback for a burst, not one per marker', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, 'a')
    q.deliver(SID, 'b')
    q.deliver(SID, 'c')
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(1)
  })

  it('cancels the fallback once a real Stop flushed the queue', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    expect(timers.every((t) => t.cancelled)).toBe(true)
  })

  it('a fallback that fires after the queue already drained writes nothing twice', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    const armed = timers[0]
    q.noteHookEvent(SID, 'Stop')
    armed.fn() // a stale timer that the runtime fired anyway
    expect(written).toHaveLength(1)
  })
})

describe('restart and teardown', () => {
  it('SessionStart clears a stale turn and releases what was held', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    // The session restarts: the Stop for that turn is never coming.
    q.noteHookEvent(SID, 'SessionStart')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    expect(q.isTurnOpen(SID)).toBe(false)
  })

  it('forget drops a dead session`s queue and its timer', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.forget(SID)
    expect(timers.every((t) => t.cancelled)).toBe(true)
    fireFallbackIsGone()
    expect(written).toHaveLength(0)
    // A forgotten session starts clean — no stale "turn open".
    expect(q.deliver(SID, REVIEW)).toBe('sent')
  })

  function fireFallbackIsGone() {
    for (const t of timers) if (!t.cancelled) t.fn()
  }
})

describe('the cap', () => {
  it('bounds a wedged session, keeping the NEWEST markers', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    for (let i = 0; i < MARKER_QUEUE_MAX + 3; i++) q.deliver(SID, `m${i}`)
    expect(q.pendingCount(SID)).toBe(MARKER_QUEUE_MAX)
    q.noteHookEvent(SID, 'Stop')
    expect(written).toHaveLength(MARKER_QUEUE_MAX)
    expect(written[0].line).toBe('m3')
    expect(written[written.length - 1].line).toBe(`m${MARKER_QUEUE_MAX + 2}`)
  })
})

// ── Repetition must not evict the thing this module exists to save ──────────
//
// Drop-oldest is right for a queue of DISTINCT verdicts, and it made the queue
// EVICTABLE BY REPETITION: a re-render loop, a double-click, or a panel effect
// that re-fires puts 32 copies of one line in front of the approval, and the
// approval is dropped — silently, into a warn line the user never sees. The
// markers are idempotent NOTIFICATIONS, so a repeat carries nothing the first
// copy did not.
//
// Mutation to prove these can fail: remove the `s.pending.includes(line)`
// collapse from CanvasMarkerQueue.deliver (canvas-marker-queue.ts).
describe('duplicate collapse', () => {
  it('collapses a repeated pending line instead of stacking copies', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    for (let i = 0; i < 100; i++) expect(q.deliver(SID, APPROVAL)).toBe('queued')
    expect(q.pendingCount(SID)).toBe(1)
    q.noteHookEvent(SID, 'Stop')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
  })

  it('a FLOOD of one line can no longer evict the approval behind it', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    for (let i = 0; i < MARKER_QUEUE_MAX * 4; i++) q.deliver(SID, REVIEW)
    q.noteHookEvent(SID, 'Stop')
    // Both survive, in the order they were filed. Pre-fix the approval was
    // pushed out by copy 33 of the review.
    expect(written.map((w) => w.line)).toEqual([APPROVAL, REVIEW])
  })

  it('collapses only against PENDING — a genuinely distinct line still queues', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.deliver(SID, REVIEW)
    q.deliver(SID, APPROVAL)
    expect(q.pendingCount(SID)).toBe(2)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([APPROVAL, REVIEW])
  })

  it('is a COLLAPSE, not a memory: the same verdict filed in a LATER turn goes out again', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([APPROVAL, APPROVAL])
  })

  it('keeps the fallback armed, so a collapsed-only queue is still flushed if Stop never comes', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.deliver(SID, APPROVAL)
    expect(written).toHaveLength(0)
    fireFallback()
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
  })

  it('keeps sessions apart — one session`s pending line does not collapse another`s', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent('session-2', 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.deliver('session-2', APPROVAL)
    expect(q.pendingCount(SID)).toBe(1)
    expect(q.pendingCount('session-2')).toBe(1)
  })
})

// ── The singleton around it ─────────────────────────────────────────────────
describe('canvas-marker-delivery', () => {
  it('is honest before boot wires it, and routes through the queue after', async () => {
    const mod = await import('../../../src/main/canvas/canvas-marker-delivery')
    mod._resetCanvasMarkerQueueForTest()

    // Nothing wired: say "unwired" rather than claiming a delivery.
    expect(mod.deliverCanvasMarker(SID, APPROVAL)).toBe('unwired')

    const out: string[] = []
    let emit: ((sessionId: string, event: string) => void) | null = null
    mod.startCanvasMarkerQueue({
      write: (_s, line) => { out.push(line) },
      subscribe: (cb) => { emit = cb },
    })

    expect(mod.deliverCanvasMarker(SID, APPROVAL)).toBe('sent')
    expect(out).toEqual([APPROVAL])

    emit!(SID, 'UserPromptSubmit')
    expect(mod.deliverCanvasMarker(SID, REVIEW)).toBe('queued')
    expect(out).toHaveLength(1)
    emit!(SID, 'Stop')
    expect(out).toEqual([APPROVAL, REVIEW])

    mod._resetCanvasMarkerQueueForTest()
  })

  it('with NO hook stream every marker goes out immediately — the pre-#580 behaviour', async () => {
    const mod = await import('../../../src/main/canvas/canvas-marker-delivery')
    mod._resetCanvasMarkerQueueForTest()
    const out: string[] = []
    mod.startCanvasMarkerQueue({ write: (_s, line) => { out.push(line) } })
    expect(mod.deliverCanvasMarker(SID, APPROVAL)).toBe('sent')
    expect(mod.deliverCanvasMarker(SID, REVIEW)).toBe('sent')
    expect(out).toEqual([APPROVAL, REVIEW])
    mod._resetCanvasMarkerQueueForTest()
  })
})
