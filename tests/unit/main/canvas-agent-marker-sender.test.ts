/**
 * The canvas review notice (`canvas:agentMarker`) types a line into a live
 * session, so it answers only the app's own window, its main frame
 * (ipc/trusted-sender.ts). Any other sender or frame, a destroyed window and a
 * call made while there is no window are answered
 * `{ delivery: 'refused', reason: 'not-app-window' }` -- reported, not thrown,
 * because the renderer treats delivery as best effort -- before the payload is
 * read, the ownership guard runs or the delivery queue is reached. A refusal
 * writes one warning line that carries no part of the request.
 *
 * The store is real; ownership and the delivery queue are fakes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import { notAppMainFrameEvents } from '../../helpers/app-window-events'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  logs: [] as string[],
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn),
    on: () => {},
  },
  BrowserWindow: vi.fn(),
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { h.logs.push(['INFO', ...a].map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { h.logs.push(['WARN', ...a].map(String).join(' ')) },
  logError: (...a: unknown[]) => { h.logs.push(['ERROR', ...a].map(String).join(' ')) },
  logDebug: () => {}, logTrace: () => {}, setVerboseMode: () => {}, isVerboseMode: () => false, setVerboseBaseline: () => {},
  setTraceMode: () => {}, isTraceMode: () => false, installGlobalErrorHandlers: () => {}, closeDebugLogger: () => {},
}))

/** The ownership guard the marker handler calls. */
const link = vi.hoisted(() => ({
  allowed: vi.fn(() => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
}))
vi.mock('../../../src/main/canvas/canvas-session-link', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  return { ...real, canvasArtifactMutationAllowed: (...a: unknown[]) => link.allowed(...(a as [])) }
})

/** The delivery seam: a line reaching it would be typed into the session. */
const delivery = vi.hoisted(() => ({ deliver: vi.fn((_sessionId: string, _line: string) => 'sent' as const) }))
vi.mock('../../../src/main/canvas/canvas-marker-delivery', () => ({
  deliverCanvasMarker: (sessionId: string, line: string) => delivery.deliver(sessionId, line),
  forgetCanvasMarkers: vi.fn(),
  startCanvasMarkerQueue: vi.fn(),
}))

const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const CID = 'c1c2c3c4c5c6c7c8c9c0d1d2'
const LINE = 'Approved v7 on the canvas'
const PAYLOAD = { sessionId: SID, canvasId: CID, line: LINE }
const REFUSED = { delivery: 'refused', reason: 'not-app-window' }

const mainFrame = { name: 'main' }
const webContents = { mainFrame, send: vi.fn() }
let destroyed = false
const win = { isDestroyed: () => destroyed, webContents }
/** Read by main's getter at call time: null is "no window" (none yet, or a closed one not re-created). */
let current: typeof win | null = win

const APP = { sender: webContents, senderFrame: mainFrame }
/** Every frame shape that is not the app window's main frame. */
const FOREIGN = notAppMainFrameEvents(webContents)

const marker = (event: unknown, args: unknown = PAYLOAD) => h.handlers.get(IPC.CANVAS_AGENT_MARKER)!(event, args)

beforeEach(() => {
  h.handlers.clear()
  vi.clearAllMocks()
  link.allowed.mockReturnValue({ ok: true })
  destroyed = false
  current = win
  registerCanvasHandlers(() => current as never)
  h.logs.length = 0
})

describe('canvas:agentMarker answers only the app window', () => {
  it('the app window main frame is answered, and the line is delivered', async () => {
    expect(await marker(APP)).toEqual({ delivery: 'sent' })
    expect(link.allowed).toHaveBeenCalledWith(SID, CID)
    expect(delivery.deliver).toHaveBeenCalledWith(SID, LINE)
    expect(h.logs.filter((l) => l.includes('not the app window'))).toEqual([])
  })

  it('any other sender or frame is refused, and nothing reaches the session', async () => {
    for (const [shape, event] of FOREIGN) {
      expect(await marker(event), shape).toEqual(REFUSED)
    }
    expect(link.allowed).not.toHaveBeenCalled()
    expect(delivery.deliver).not.toHaveBeenCalled()
  })

  it('a request from another frame is refused before its payload is read (reported, never thrown)', async () => {
    await expect(Promise.resolve(marker(FOREIGN[0][1], { not: 'a marker' }))).resolves.toEqual(REFUSED)
    await expect(Promise.resolve(marker(FOREIGN[2][1], undefined))).resolves.toEqual(REFUSED)
    expect(delivery.deliver).not.toHaveBeenCalled()
  })

  it('a destroyed window, or no window at all, is refused, and nothing reaches the session', async () => {
    destroyed = true
    expect(await marker(APP)).toEqual(REFUSED)
    destroyed = false
    current = null
    expect(await marker(APP)).toEqual(REFUSED)
    expect(link.allowed).not.toHaveBeenCalled()
    expect(delivery.deliver).not.toHaveBeenCalled()
    current = win
    expect(await marker(APP)).toEqual({ delivery: 'sent' })
  })

  it('a refusal writes one warning line, which carries no part of the request', async () => {
    await marker(FOREIGN[0][1])
    expect(h.logs.length).toBe(1)
    // A warning, at the level every other refused app-window request is logged at.
    expect(h.logs[0]).toMatch(/^WARN .*not the app window/)
    for (const part of [SID, CID, LINE]) expect(h.logs[0]).not.toContain(part)
  })
})
