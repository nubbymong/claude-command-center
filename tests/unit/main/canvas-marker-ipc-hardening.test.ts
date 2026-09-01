/**
 * canvas:agentMarker at the SEAM — what may reach the agent's terminal (#580,
 * hardened by the 2026-09-01 adversarial pass).
 *
 * This channel is unlike the rest of the canvas surface: its payload does not
 * end in a store, it ends in a PTY as a line the user appears to have typed, and
 * the canvas skill triggers on that line's literal text. Two properties had to
 * hold and did not:
 *
 *   OWNERSHIP — the payload named no canvas, so there was nothing to check its
 *               claim against. Any session id plus 400 characters was accepted,
 *               i.e. an unverifiable assertion about somebody else's canvas
 *               delivered into a terminal. It now names the canvas and is
 *               refused unless that session owns it, through the same guard
 *               canvas:archiveArtifact uses.
 *
 *   CONTROL   — the schema stripped `[\r\n]` on the theory that "what travels is
 *               a LINE and not keystrokes". CR/LF are the only bytes that
 *               SUBMIT, but far from the only bytes a terminal ACTS on: 0x03 is
 *               SIGINT, 0x1b opens an escape sequence (bracketed-paste
 *               boundaries, an OSC this app's own PTY reader parses), and the
 *               8-bit C1 forms reach the same machinery. All rode through.
 *
 * The store is real; ownership and the marker queue are mocked, so what each
 * case asserts is exactly what the seam let through.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
  BrowserWindow: vi.fn(),
}))

/** The ownership oracle — the same guard canvas:archiveArtifact calls. */
const link = vi.hoisted(() => ({
  allowed: vi.fn(() => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
}))
vi.mock('../../../src/main/canvas/canvas-session-link', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  return { ...real, canvasArtifactMutationAllowed: (...a: unknown[]) => link.allowed(...(a as [])) }
})

/** The delivery seam: what the QUEUE was handed, byte for byte. */
const delivery = vi.hoisted(() => ({ deliver: vi.fn(() => 'sent' as const) }))
vi.mock('../../../src/main/canvas/canvas-marker-delivery', () => ({
  deliverCanvasMarker: (sessionId: string, line: string) => delivery.deliver(sessionId, line),
  forgetCanvasMarkers: vi.fn(),
  startCanvasMarkerQueue: vi.fn(),
}))

const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const CID = 'c1c2c3c4c5c6c7c8c9c0d1d2'
const LINE = 'Approved v7 on the canvas · canvas_version_verdict recorded'

const invoke = (args: unknown): unknown => handlers.get(IPC.CANVAS_AGENT_MARKER)!({} as never, args)
/** The line the queue was handed by the last accepted call. */
const deliveredLine = (): string => delivery.deliver.mock.calls[0][1] as unknown as string

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  link.allowed.mockReturnValue({ ok: true })
  registerCanvasHandlers(() => null)
})

describe('ownership: a marker must name a canvas the session owns', () => {
  it('delivers the owner`s own marker', async () => {
    const r = await invoke({ sessionId: SID, canvasId: CID, line: LINE })
    expect(link.allowed).toHaveBeenCalledWith(SID, CID)
    expect(delivery.deliver).toHaveBeenCalledWith(SID, LINE)
    expect(r).toEqual({ delivery: 'sent' })
  })

  // Mutation to prove this can fail: drop the canvasArtifactMutationAllowed
  // check from the CANVAS_AGENT_MARKER handler (canvas-handlers.ts).
  it('REFUSES a marker for a canvas the session does not own, and never reaches the queue', async () => {
    link.allowed.mockReturnValue({ ok: false, reason: 'owner-live' })
    const r = await invoke({ sessionId: SID, canvasId: CID, line: LINE })
    expect(r).toEqual({ delivery: 'refused', reason: 'owner-live' })
    expect(delivery.deliver).not.toHaveBeenCalled()
  })

  it('reports the refusal rather than throwing — the renderer swallows rejections', async () => {
    link.allowed.mockReturnValue({ ok: false, reason: 'not-eligible' })
    await expect(invoke({ sessionId: SID, canvasId: CID, line: LINE })).resolves.toMatchObject({
      delivery: 'refused',
    })
  })

  // Mutation to prove this can fail: make `canvasId` optional in
  // agentMarkerSchema — the old shape then sails through unchecked.
  it('REQUIRES the canvas: the pre-fix payload shape is rejected outright', async () => {
    await expect(invoke({ sessionId: SID, line: LINE })).rejects.toThrow()
    expect(delivery.deliver).not.toHaveBeenCalled()
  })

  it('rejects a canvasId outside the id charset, before the ownership guard runs', async () => {
    for (const bad of ['../other', 'Canvas-A', 'c a', '', 'x'.repeat(65)]) {
      await expect(invoke({ sessionId: SID, canvasId: bad, line: LINE })).rejects.toThrow()
    }
    expect(link.allowed).not.toHaveBeenCalled()
  })

  it('rejects an unknown extra field rather than waving it through', async () => {
    await expect(invoke({ sessionId: SID, canvasId: CID, line: LINE, submit: true })).rejects.toThrow()
  })
})

describe('control bytes: a marker is a line, not keystrokes', () => {
  /** Assemble the hostile bytes at runtime — never as source literals. */
  const ch = (code: number): string => String.fromCharCode(code)

  // Mutation to prove these can fail: put `.replace(/[\r\n]+/g, ' ')` back in
  // agentMarkerSchema (canvas-handlers.ts).
  it('strips ETX (0x03) — otherwise the marker interrupts whatever the agent is doing', async () => {
    await invoke({ sessionId: SID, canvasId: CID, line: `Approved${ch(3)}v7 on the canvas` })
    expect(deliveredLine()).toBe('Approved v7 on the canvas')
    expect(deliveredLine()).not.toContain(ch(3))
  })

  it('strips ESC (0x1b) — otherwise the rest of the line is an escape sequence', async () => {
    // Bracketed-paste boundaries and an OSC this app`s own PTY reader parses.
    const hostile = `Approved${ch(27)}[200~payload${ch(27)}[201~ and ${ch(27)}]9999;CMSTATUS={}${ch(7)}`
    await invoke({ sessionId: SID, canvasId: CID, line: hostile })
    expect(deliveredLine()).not.toContain(ch(27))
    expect(deliveredLine()).not.toContain(ch(7))
  })

  it('strips NUL and the 8-bit C1 forms (0x9b CSI, 0x9d OSC), which reach the same machinery', async () => {
    await invoke({ sessionId: SID, canvasId: CID, line: `a${ch(0)}b${ch(0x9b)}c${ch(0x9d)}d${ch(0x7f)}e` })
    expect(deliveredLine()).toBe('a b c d e')
  })

  it('still strips CR/LF — one marker can never become several submitted messages', async () => {
    await invoke({ sessionId: SID, canvasId: CID, line: 'first\r\nsecond\nthird' })
    expect(deliveredLine()).toBe('first second third')
  })

  it('every code point below 0x20, DEL, and the whole C1 range is covered — none survives', async () => {
    const codes = [
      ...Array.from({ length: 0x20 }, (_, i) => i),
      0x7f,
      ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
    ]
    for (const code of codes) {
      delivery.deliver.mockClear()
      await invoke({ sessionId: SID, canvasId: CID, line: `ok${ch(code)}line` })
      expect(deliveredLine(), `code point ${code} survived`).toBe('ok line')
    }
  })

  it('leaves the real markers untouched — `·` and `—` are well above the control range', async () => {
    for (const line of [LINE, 'Review #3 — 5 notes · canvas_review R3']) {
      delivery.deliver.mockClear()
      await invoke({ sessionId: SID, canvasId: CID, line })
      expect(deliveredLine()).toBe(line)
    }
  })

  it('a line that is ONLY control bytes is refused, not delivered as an empty message', async () => {
    await expect(
      invoke({ sessionId: SID, canvasId: CID, line: `${ch(3)}${ch(27)}${ch(0)}` }),
    ).rejects.toThrow()
    expect(delivery.deliver).not.toHaveBeenCalled()
  })

  it('still caps the length', async () => {
    await expect(invoke({ sessionId: SID, canvasId: CID, line: 'x'.repeat(401) })).rejects.toThrow()
  })
})
