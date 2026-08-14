// Off-screen snapshot capture — what makes `canvas_snapshot` work while the
// user is at the terminal.
//
// The natural moment for the agent to read its render is right after
// `canvas_render` — which is exactly when the Canvas pane is CLOSED, because
// the canvas replaces the chat panel and the user is in the conversation
// (spec D2/D3). The live-frame-only capture path therefore failed in the
// product's default state (VM transcript 2026-08-13: "the Agent Canvas is not
// open on the requested canvas and version").
//
// This module lays the requested canvas version out in a HIDDEN iframe:
// off-screen position — never `display:none` or `visibility:hidden`, both of
// which change what layout, accessible-name and axe computation see — at a
// fixed viewport, with the EXACT sandbox of the visible pane, the same
// origin checks, and the same sanitisation before anything crosses IPC.
// Frames are cached briefly keyed by canvas+version so an agent's scoped
// follow-up calls reuse the laid-out page, then evicted on a TTL.
//
// Security posture (for the deferred adversarial batch): no new ingress — a
// hidden frame renders only an already-stored, already-servable version via
// the same ccc-ux:// protocol and sandbox the visible pane uses; `entry` is
// store-authored (the version record), resolved in main, never model-supplied.

import {
  CANVAS_BRIDGE_NS,
  type CanvasSnapshotReply,
  type CanvasSnapshotRequestEvent,
  canvasContentUrl,
  canvasOrigin,
} from '../../shared/canvas'
import { sanitizeSnapshotResult } from '../../shared/canvas-snapshot-sanitize'
import { askCanvasFrame } from './canvas-frame-rpc'

/** The hidden frame's viewport. Fixed and documented in the tool's own notes:
 *  a headless capture measures THIS layout, not one the user chose. */
export const HEADLESS_VIEWPORT = { width: 1280, height: 800 }

/** Inside the broker's 30s so the specific reason wins over the generic one. */
const READY_TIMEOUT_MS = 20_000
/** Matches the live path's FRAME_TIMEOUT_MS. */
const CAPTURE_TIMEOUT_MS = 25_000
/**
 * How long an idle frame may linger, measured from when it was MOUNTED —
 * never refreshed on use.
 *
 * The first cut refreshed this on every capture and kept the frame after the
 * reply, which made a hidden, executing page survive as long as an agent kept
 * polling: unbounded silent script execution the user could not see (a
 * MAJOR from the 2026-08-14 adversarial pass). Frames are now torn down as
 * soon as the capture that needed them is answered; this ceiling only bounds
 * the window in which a mounted-but-never-answered frame can sit.
 */
const FRAME_TTL_MS = 45_000
/**
 * PER SESSION, not global — the same decision, for the same reason, as the
 * main-side broker's MAX_IN_FLIGHT_PER_SESSION: a global cap let one looping
 * session starve every other session's captures. The first cut of this file
 * reintroduced the global form one layer down.
 */
const MAX_HEADLESS_FRAMES_PER_SESSION = 2
/**
 * And an aggregate ceiling ON TOP of it — the two solve different problems and
 * the app needs both. Replacing the global cap with a per-session one (round 1
 * of this pass) traded starvation for an unbounded total: nothing else in the
 * stack bounds the number of session identities, so 200 of them meant 400
 * hidden page loads in the one renderer process that also draws every terminal.
 */
const MAX_HEADLESS_FRAMES_TOTAL = 8

interface HeadlessFrame {
  key: string
  sessionId: string
  container: HTMLDivElement
  iframe: HTMLIFrameElement
  ready: Promise<Window>
  mountedAt: number
  disposed: boolean
}

const frames = new Map<string, HeadlessFrame>()
let sweepTimer: ReturnType<typeof setTimeout> | null = null
let timing = { readyTimeoutMs: READY_TIMEOUT_MS, frameTtlMs: FRAME_TTL_MS }

/** Per-FRAME, not per canvas+version: frames are one-shot now, and two
 *  concurrent captures of the same version must not collide in the map (the
 *  second would evict the first's entry and leak its element). */
function keyOf(event: CanvasSnapshotRequestEvent): string {
  return `${event.requestId}/${event.canvasId}/${event.versionId}`
}

function dispose(frame: HeadlessFrame): void {
  if (frame.disposed) return
  frame.disposed = true
  if (frames.get(frame.key) === frame) frames.delete(frame.key)
  try {
    frame.container.remove()
  } catch {
    /* already detached */
  }
}

function scheduleSweep(): void {
  if (sweepTimer) return
  sweepTimer = setTimeout(() => {
    sweepTimer = null
    const now = Date.now()
    for (const frame of [...frames.values()]) {
      // From mount, never from last use: a frame must not be able to renew its
      // own lease by being used.
      if (now - frame.mountedAt >= timing.frameTtlMs) dispose(frame)
    }
    if (frames.size > 0) scheduleSweep()
  }, timing.frameTtlMs)
}

function mountFrame(event: CanvasSnapshotRequestEvent): HeadlessFrame {
  if (frames.size >= MAX_HEADLESS_FRAMES_TOTAL) {
    throw new Error('off-screen frame limit reached')
  }
  let mine = 0
  for (const frame of frames.values()) if (frame.sessionId === event.sessionId) mine++
  if (mine >= MAX_HEADLESS_FRAMES_PER_SESSION) {
    // Refused, never evicted: evicting the oldest could kill a capture that is
    // mid-flight in it. The message shape is part of the MCP tool's closed
    // failure vocabulary (captureFailureReason).
    throw new Error('off-screen frame limit reached')
  }

  const container = document.createElement('div')
  container.setAttribute('data-canvas-headless', event.canvasId)
  container.style.position = 'fixed'
  container.style.left = '-13000px'
  container.style.top = '0'
  container.style.width = `${HEADLESS_VIEWPORT.width}px`
  container.style.height = `${HEADLESS_VIEWPORT.height}px`
  container.style.overflow = 'hidden'
  container.style.pointerEvents = 'none'

  const iframe = document.createElement('iframe')
  // The EXACT sandbox of the visible pane (AgentCanvasPane): same-origin is
  // safe for the same reason — the frame's ccc-ux://<canvasId> origin is never
  // the app's own origin, so content cannot reach this document.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
  iframe.referrerPolicy = 'no-referrer'
  iframe.title = 'Agent Canvas off-screen capture'
  iframe.style.width = '100%'
  iframe.style.height = '100%'
  iframe.style.border = '0'
  iframe.src = canvasContentUrl(event.canvasId, event.versionId, event.entry)

  container.appendChild(iframe)
  document.body.appendChild(container)

  const frame: HeadlessFrame = {
    key: keyOf(event),
    sessionId: event.sessionId,
    container,
    iframe,
    mountedAt: Date.now(),
    disposed: false,
    ready: Promise.resolve(window), // replaced below, before anyone can await it
  }

  frame.ready = new Promise<Window>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      dispose(frame)
      reject(new Error('The canvas page did not finish loading in time.'))
    }, timing.readyTimeoutMs)
    const onMessage = (e: MessageEvent): void => {
      // The same acceptance test as the pane's bridge listener: OUR frame's
      // window, THIS canvas's exact origin, the canvas namespace.
      const target = frame.iframe.contentWindow
      if (!target || e.source !== target) return
      if (e.origin !== canvasOrigin(event.canvasId)) return
      const msg = e.data as { ns?: unknown; type?: unknown } | null
      if (!msg || msg.ns !== CANVAS_BRIDGE_NS || msg.type !== 'ready') return
      cleanup()
      resolve(target)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }
    window.addEventListener('message', onMessage)
  })
  // A rejected ready with nobody awaiting yet must not be an unhandled
  // rejection (the awaiter attaches in captureHeadless, usually same tick).
  frame.ready.catch(() => {})

  frames.set(frame.key, frame)
  scheduleSweep()
  return frame
}

/**
 * Capture a canvas version that is NOT on a live pane: mount (or reuse) its
 * hidden frame, wait for the bridge to announce itself, ask for the snapshot,
 * sanitise, and mark the reply headless so the tool can say so.
 */
export async function captureHeadless(event: CanvasSnapshotRequestEvent): Promise<CanvasSnapshotReply> {
  const fail = (error: string): CanvasSnapshotReply => ({ requestId: event.requestId, ok: false, error })
  let frame: HeadlessFrame | undefined
  try {
    frame = mountFrame(event)
    const target = await frame.ready
    if (frame.disposed) return fail('The canvas frame is not loaded yet.')

    const options = event.options ?? {}
    const raw = await askCanvasFrame(
      target,
      event.canvasId,
      { type: 'snapshot', scope: options.scope, analysis: options.analysis },
      CAPTURE_TIMEOUT_MS,
    )
    return {
      requestId: event.requestId,
      ok: true,
      headless: true,
      // Sanitised HERE exactly like the live path — the page's answer must be
      // bounded before it crosses IPC, scoped styles only when WE asked.
      result: sanitizeSnapshotResult(raw, undefined, { scoped: (options.scope?.length ?? 0) > 0 }),
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  } finally {
    // ALWAYS, on every exit path. A hidden frame exists to answer exactly one
    // capture; keeping it warm across calls (the first cut did, refreshing its
    // TTL each time) let an agent hold an invisible page executing for as long
    // as it kept polling. A page the user cannot see does not get to outlive
    // the question it was mounted to answer — the cost is re-loading the
    // document on a follow-up scoped call, which is the correct trade.
    if (frame) dispose(frame)
  }
}

/** Test seams. */
export function _resetHeadlessCaptureForTest(): void {
  for (const frame of [...frames.values()]) dispose(frame)
  frames.clear()
  if (sweepTimer) {
    clearTimeout(sweepTimer)
    sweepTimer = null
  }
  timing = { readyTimeoutMs: READY_TIMEOUT_MS, frameTtlMs: FRAME_TTL_MS }
}

export function _configureHeadlessForTest(next: Partial<typeof timing>): void {
  timing = { ...timing, ...next }
}

export function _headlessFramesForTest(): Map<string, HeadlessFrame> {
  return frames
}
