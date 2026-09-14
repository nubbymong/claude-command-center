// Testing-mode evidence at the IPC SEAM (M3): who may capture, what is refused,
// what the read channel will answer, and the navigation push that feeds the
// action trail.
//
// Driven through the registered handlers with the real stores behind them, so
// what is pinned here is the composition — the Zod bound, the ownership check,
// the clamp and the store, in the order the handler runs them — rather than any
// one of them in isolation.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { IPC } from '../../../src/shared/ipc-channels'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const listeners = new Map<string, (...a: unknown[]) => unknown>()

const windowState = vi.hoisted(() => ({
  /** What `BrowserWindow.fromWebContents` answers. */
  found: true as boolean,
  destroyed: false as boolean,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  captureRects: [] as Array<{ x: number; y: number; width: number; height: number }>,
  captureThrows: false as boolean,
  sent: [] as Array<{ channel: string; payload: unknown }>,
}))

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

vi.mock('electron', () => {
  const makeImage = (w: number, h: number): unknown => ({
    getSize: () => ({ width: w, height: h }),
    isEmpty: () => false,
    resize: ({ width, height }: { width?: number; height?: number }) => {
      const scale = width !== undefined ? width / w : height !== undefined ? height / h : 1
      return makeImage(Math.round(w * scale), Math.round(h * scale))
    },
    toPNG: () => Buffer.concat([PNG_MAGIC, Buffer.alloc(64)]),
    toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  })
  const fakeWindow = {
    isDestroyed: () => windowState.destroyed,
    getContentBounds: () => windowState.bounds,
    webContents: {
      send: (channel: string, payload: unknown) => windowState.sent.push({ channel, payload }),
      capturePage: async (rect: { x: number; y: number; width: number; height: number }) => {
        if (windowState.captureThrows) throw new Error('capture blew up')
        windowState.captureRects.push(rect)
        return makeImage(rect.width, rect.height)
      },
    },
  }
  return {
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
      on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
    },
    BrowserWindow: Object.assign(vi.fn(), {
      fromWebContents: () => (windowState.found ? fakeWindow : null),
    }),
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), on: vi.fn() },
    __fakeWindow: fakeWindow,
  }
})

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-evidence-ipc-'))
  return { getResourcesDirectory: () => dir, registerSetupHandlers: () => {} }
})

const electron = (await import('electron')) as unknown as { __fakeWindow: { webContents: unknown } }
const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const reviewStore = await import('../../../src/main/canvas/canvas-review-store')
const evidence = await import('../../../src/main/canvas/canvas-evidence')
const sessionLink = await import('../../../src/main/canvas/canvas-session-link')
const uxProtocol = await import('../../../src/main/canvas/ccc-ux-protocol')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const OTHER_SID = 'b1b2c3d4e5f6a7b8c9d0e1f2'

const invoke = (ch: string, args: unknown) => handlers.get(ch)!({ sender: electron.__fakeWindow.webContents } as never, args)

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const STAMP = {
  capturedAt: '2026-08-29T16:43:52.000Z',
  title: 'Checkout',
  route: '/checkout',
  viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 240, dpr: 2, zoom: 1 },
  dialogs: [],
  fields: [],
}

const RECT = { x: 24, y: 96, width: 1200, height: 700 }

function captureArgs(canvasId: string, versionId: string, overrides: Record<string, unknown> = {}) {
  // No top-level `dpr`: the record's device pixel ratio is `stamp.viewport.dpr`,
  // and `capturePage` takes CSS pixels — a second copy at the envelope was a
  // field with no reader and two possible values.
  return { sessionId: SID, canvasId, versionId, rect: RECT, stamp: STAMP, trail: [], ...overrides }
}

function renderUat(sessionId = SID): { canvasId: string; versionId: string } {
  const dist = tmpDir('ccc-evidence-ipc-dist-')
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><body>build</body>')
  expect(canvasStore.registerCanvasUatRoot(sessionId, dist)).toBe(true)
  return canvasStore.renderVersion(sessionId, { mode: 'uat', distRoot: dist, buildLabel: '5', title: 'Checkout flow' })
}

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  windowState.found = true
  windowState.destroyed = false
  windowState.captureThrows = false
  windowState.captureRects.length = 0
  windowState.sent.length = 0
  canvasStore._resetCanvasStoreForTest()
  reviewStore._resetCanvasReviewStoreForTest()
  evidence._resetCanvasEvidenceForTest()
  sessionLink._resetCanvasSessionLinkForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
  registerCanvasHandlers(() => electron.__fakeWindow as never)
})

afterAll(() => {
  uxProtocol.setCanvasFrameNavigatedSink(null)
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('registration', () => {
  it('registers the four evidence channels', () => {
    expect(handlers.has(IPC.CANVAS_EVIDENCE_CAPTURE)).toBe(true)
    expect(handlers.has(IPC.CANVAS_EVIDENCE_DISCARD)).toBe(true)
    expect(handlers.has(IPC.CANVAS_EVIDENCE_READ)).toBe(true)
    expect(handlers.has(IPC.CANVAS_SET_PACK_NAME)).toBe(true)
  })
})

describe('capture — bad args die at the seam', () => {
  it.each([
    [{}],
    [{ sessionId: SID }],
    [{ sessionId: SID, canvasId: 'abc', versionId: 'v1', rect: RECT, stamp: STAMP, trail: [], sneak: 1 }],
    // The retired top-level `dpr` — a key the schema no longer declares.
    [{ sessionId: SID, canvasId: 'abc', versionId: 'v1', rect: RECT, dpr: 2, stamp: STAMP, trail: [] }],
    // A trail entry this build does not define.
    [{ sessionId: SID, canvasId: 'abc', versionId: 'v1', rect: RECT, stamp: STAMP, trail: [{ at: 'x', gapMs: 0, kind: 'exfiltrate' }] }],
    // The RETIRED `history` kind, refused at the seam like any other.
    [{ sessionId: SID, canvasId: 'abc', versionId: 'v1', rect: RECT, stamp: STAMP, trail: [{ at: 'x', gapMs: 0, kind: 'history' }] }],
    // A stamp field carrying a VALUE is not a field this schema has.
    [{ sessionId: SID, canvasId: 'abc', versionId: 'v1', rect: RECT, stamp: { ...STAMP, fields: [{ role: 'textbox', name: 'Email', fill: 'filled', value: 'nick@example.com' }] }, trail: [] }],
  ])('refuses %#', async (args) => {
    await expect(invoke(IPC.CANVAS_EVIDENCE_CAPTURE, args)).rejects.toBeTruthy()
    expect(windowState.captureRects).toHaveLength(0)
  })
})

describe('capture — the gates, in order', () => {
  it('refuses a canvas this session does not own, before anything else is looked at', async () => {
    const { canvasId, versionId } = renderUat()
    const result = await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId, { sessionId: OTHER_SID }))
    expect(result).toEqual({ ok: false, reason: 'not-owner' })
    expect(windowState.captureRects).toHaveLength(0)
  })

  it('refuses a MOCKUP version — Testing only, by design', async () => {
    const rendered = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>mockup</p>' })
    const result = await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(rendered.canvasId, rendered.versionId))
    expect(result).toEqual({ ok: false, reason: 'not-uat' })
    expect(windowState.captureRects).toHaveLength(0)
  })

  it('refuses a version that is not on the canvas', async () => {
    const { canvasId } = renderUat()
    expect(await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, 'v42'))).toEqual({ ok: false, reason: 'not-uat' })
  })

  it('rate-limits repeat captures from one session', async () => {
    const { canvasId, versionId } = renderUat()
    expect(await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId))).toMatchObject({ ok: true })
    expect(await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId))).toEqual({ ok: false, reason: 'rate' })
  })

  it('refuses once the pack is full, and says so in one word', async () => {
    const { canvasId, versionId } = renderUat()
    const dir = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'evidence')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a1.png'), Buffer.alloc(30 * 1024 * 1024))
    expect(await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId))).toEqual({
      ok: false,
      reason: 'pack-full',
    })
  })

  it('reports capture-failed rather than throwing when the window is gone or the capture blows up', async () => {
    const { canvasId, versionId } = renderUat()
    windowState.found = false
    expect(await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId))).toEqual({
      ok: false,
      reason: 'capture-failed',
    })
    windowState.found = true
    evidence._resetCanvasEvidenceForTest()
    windowState.captureThrows = true
    expect(await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId))).toEqual({
      ok: false,
      reason: 'capture-failed',
    })
  })
})

describe('capture — the rect is clamped in MAIN', () => {
  it('never photographs outside the window content box', async () => {
    const { canvasId, versionId } = renderUat()
    await invoke(
      IPC.CANVAS_EVIDENCE_CAPTURE,
      captureArgs(canvasId, versionId, { rect: { x: -100, y: -100, width: 99_999, height: 99_999 } }),
    )
    expect(windowState.captureRects[0]).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
  })

  it('refuses a sliver rather than photographing a corner', async () => {
    const { canvasId, versionId } = renderUat()
    const result = await invoke(
      IPC.CANVAS_EVIDENCE_CAPTURE,
      captureArgs(canvasId, versionId, { rect: { x: 0, y: 0, width: 2, height: 2 } }),
    )
    expect(result).toEqual({ ok: false, reason: 'capture-failed' })
    expect(windowState.captureRects).toHaveLength(0)
  })
})

describe('capture — what comes back', () => {
  it('returns an id and a preview, and the STAMP time is main’s own', async () => {
    const { canvasId, versionId } = renderUat()
    const before = Date.now()
    const result = (await invoke(
      IPC.CANVAS_EVIDENCE_CAPTURE,
      captureArgs(canvasId, versionId, { stamp: { ...STAMP, capturedAt: '1999-01-01T00:00:00.000Z' } }),
    )) as { ok: true; evidenceId: string; previewDataUrl: string; width: number; height: number }
    expect(result.ok).toBe(true)
    expect(result.evidenceId).toMatch(/^[0-9a-f]{24}$/)
    expect(result.previewDataUrl.startsWith('data:image/')).toBe(true)
    expect(result.width).toBe(1200)

    // Lock it onto a note and read the stamp back: the renderer's own
    // `capturedAt` was overwritten with main's clock.
    const saved = reviewStore.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: result.evidenceId,
    })
    const recorded = saved.state.annotations.find((a) => a.id === saved.annotationId)!.evidence!
    expect(Date.parse(recorded.stamp.capturedAt)).toBeGreaterThanOrEqual(before)
  })

  it('strips control characters out of page-reported text at the seam', async () => {
    const { canvasId, versionId } = renderUat()
    const dirty = { ...STAMP, title: 'Check\u0000out\nsecond line', route: '/pay\u202e' }
    const result = (await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId, { stamp: dirty }))) as {
      ok: true
      evidenceId: string
    }
    const saved = reviewStore.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: result.evidenceId,
    })
    const stampBack = saved.state.annotations.find((a) => a.id === saved.annotationId)!.evidence!.stamp
    expect(stampBack.title).toBe('Check out second line')
    // U+202E is a format character, not a control one — the shared keeper's
    // business, not this seam's; what matters here is that no line break rode in.
    expect(stampBack.title).not.toMatch(/[\r\n]/)
  })
})

describe('discard', () => {
  it('is scoped to the caller’s own canvas', async () => {
    const { canvasId, versionId } = renderUat()
    const captured = (await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId))) as { evidenceId: string }
    expect(await invoke(IPC.CANVAS_EVIDENCE_DISCARD, { sessionId: OTHER_SID, canvasId, evidenceId: captured.evidenceId })).toEqual({
      ok: false,
    })
    expect(await invoke(IPC.CANVAS_EVIDENCE_DISCARD, { sessionId: SID, canvasId, evidenceId: captured.evidenceId })).toEqual({
      ok: true,
    })
  })

  it('refuses an id that is not one main mints', async () => {
    const { canvasId } = renderUat()
    await expect(
      invoke(IPC.CANVAS_EVIDENCE_DISCARD, { sessionId: SID, canvasId, evidenceId: '../../etc/passwd' }),
    ).rejects.toBeTruthy()
  })
})

describe('read — scope, then the record', () => {
  async function noteWithEvidence(): Promise<{ canvasId: string; shotPath: string }> {
    const { canvasId, versionId } = renderUat()
    const captured = (await invoke(IPC.CANVAS_EVIDENCE_CAPTURE, captureArgs(canvasId, versionId))) as { evidenceId: string }
    const saved = reviewStore.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: captured.evidenceId,
    })
    return { canvasId, shotPath: `reviews/evidence/${saved.annotationId}.png` }
  }

  it('answers the owner with a data URL', async () => {
    const { canvasId, shotPath } = await noteWithEvidence()
    const result = (await invoke(IPC.CANVAS_EVIDENCE_READ, { sessionId: SID, canvasId, path: shotPath })) as {
      dataUrl: string
    }
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('refuses a stranger session with no project in common — fail closed', async () => {
    const { canvasId, shotPath } = await noteWithEvidence()
    expect(await invoke(IPC.CANVAS_EVIDENCE_READ, { sessionId: OTHER_SID, canvasId, path: shotPath })).toBeNull()
  })

  it('answers a session in the SAME project — the Library opens memorialised packs', async () => {
    const project = tmpDir('ccc-evidence-project-')
    sessionLink.noteSessionSpawnForCanvas(SID, { cwd: project })
    sessionLink.noteSessionSpawnForCanvas(OTHER_SID, { cwd: project })
    // Re-install the resolver so the canvas record picks the cwd up on render.
    registerCanvasHandlers(() => electron.__fakeWindow as never)
    const { canvasId, shotPath } = await noteWithEvidence()
    const result = await invoke(IPC.CANVAS_EVIDENCE_READ, { sessionId: OTHER_SID, canvasId, path: shotPath })
    expect(result).not.toBeNull()
  })

  it('answers null for a path the canvas does not record', async () => {
    const { canvasId } = await noteWithEvidence()
    for (const attempt of ['reviews/evidence/a999.png', '../reviews.json', 'reviews.json']) {
      expect(await invoke(IPC.CANVAS_EVIDENCE_READ, { sessionId: SID, canvasId, path: attempt })).toBeNull()
    }
  })
})

describe('the config name behind the generated pack name', () => {
  it('is exactly the configLabel the renderer sent at spawn', () => {
    // TerminalView sends `customName || label || 'default'`; main records it in
    // the same spawn note as the cwd and hands it back unchanged.
    sessionLink.noteSessionSpawnForCanvas(SID, { cwd: 'F:/project', configLabel: 'Checkout flow' })
    expect(sessionLink.canvasConfigNameForSession(SID)).toBe('Checkout flow')
  })

  it('treats the renderer’s "default" placeholder as ABSENT, so both surfaces fall to the title', () => {
    sessionLink.noteSessionSpawnForCanvas(SID, { cwd: 'F:/project', configLabel: 'default' })
    expect(sessionLink.canvasConfigNameForSession(SID)).toBeUndefined()
    sessionLink.noteSessionSpawnForCanvas(SID, { cwd: 'F:/project', configLabel: '   ' })
    expect(sessionLink.canvasConfigNameForSession(SID)).toBeUndefined()
    // A session we never saw spawn (restored from a previous run) has none.
    expect(sessionLink.canvasConfigNameForSession(OTHER_SID)).toBeUndefined()
  })
})

describe('the pack name channel', () => {
  it('renames, and answers the state main KEPT when it refuses', async () => {
    const { canvasId, versionId } = renderUat()
    const renamed = (await invoke(IPC.CANVAS_SET_PACK_NAME, {
      sessionId: SID,
      canvasId,
      versionId,
      name: 'Checkout flow',
    })) as { versions: Array<{ packName?: string }> }
    expect(renamed.versions[0].packName).toBe('Checkout flow')

    const refused = (await invoke(IPC.CANVAS_SET_PACK_NAME, {
      sessionId: SID,
      canvasId,
      versionId: 'v99',
      name: 'nope',
    })) as { versions: Array<{ packName?: string }> }
    // Not an error object: the header snaps back to what is actually stored.
    expect(refused.versions[0].packName).toBe('Checkout flow')
  })
})

describe('the frame-navigation push', () => {
  it('forwards an ALLOWED in-version navigation, with the session resolved in main', () => {
    const { canvasId } = renderUat()
    let listener: ((details: unknown) => void) | null = null
    uxProtocol.installCanvasFrameNavigationGuard({
      on: (_event: 'will-frame-navigate', fn: (details: never) => void) => {
        listener = fn as unknown as (details: unknown) => void
      },
    })
    const preventDefault = vi.fn()
    listener!({
      url: `ccc-ux://${canvasId}/v1/checkout/payment?token=secret#step-2`,
      isMainFrame: false,
      frame: { url: `ccc-ux://${canvasId}/v1/index.html`, parent: { url: 'file:///app/index.html' } },
      preventDefault,
    })
    expect(preventDefault).not.toHaveBeenCalled()
    const pushed = windowState.sent.filter((s) => s.channel === IPC.CANVAS_FRAME_NAVIGATED)
    expect(pushed).toHaveLength(1)
    expect(pushed[0].payload).toEqual({ sessionId: SID, canvasId, route: '/checkout/payment#step-2' })
  })

  it('reports NOTHING for a navigation the guard refused', () => {
    const { canvasId } = renderUat()
    let listener: ((details: unknown) => void) | null = null
    uxProtocol.installCanvasFrameNavigationGuard({
      on: (_event: 'will-frame-navigate', fn: (details: never) => void) => {
        listener = fn as unknown as (details: unknown) => void
      },
    })
    const preventDefault = vi.fn()
    listener!({
      url: 'https://evil.example/steal',
      isMainFrame: false,
      frame: { url: `ccc-ux://${canvasId}/v1/index.html`, parent: { url: 'file:///app/index.html' } },
      preventDefault,
    })
    expect(preventDefault).toHaveBeenCalled()
    expect(windowState.sent.filter((s) => s.channel === IPC.CANVAS_FRAME_NAVIGATED)).toHaveLength(0)
  })
})
