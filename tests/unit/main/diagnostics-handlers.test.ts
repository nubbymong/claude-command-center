import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import { GLYPH_DIAGNOSTIC_MAX_BYTES } from '../../../src/shared/glyph-diagnostic'

// Capture ipcMain.handle registrations so we can invoke the handler directly.
const handlers = new Map<string, (...a: any[]) => any>()
const showItemInFolder = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
  shell: { showItemInFolder: (p: string) => showItemInFolder(p) },
}))

// In-memory filesystem: record writes and dirs, assert on them.
const writes = new Map<string, Buffer | string>()
const mkdirs: string[] = []
vi.mock('fs', () => ({
  mkdirSync: (p: string) => { mkdirs.push(p) },
  writeFileSync: (p: string, data: Buffer | string) => { writes.set(p, data) },
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => 'C:/res' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

import { registerDiagnosticsHandlers } from '../../../src/main/ipc/diagnostics-handlers'

const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!({} as any, ...args)

const validPayload = () => ({
  capturedAt: '2026-08-22T09:00:00.000Z',
  appVersion: '2.1.0-beta.17',
  gpuRendering: true,
  gpuAdapter: 'ANGLE (NVIDIA)',
  activeSessionId: 'sess-1',
  terminalCount: 2,
  atlas: { generation: 3, liveCount: 2, live: [{ label: 'sess-1', generation: 3, behind: 0 }], events: [{ t: 1, kind: 'clear', label: 'sess-1', generation: 3 }] },
})

/** A fake window whose capturePage yields a tiny PNG-ish buffer. */
const fakeWindow = (capture: () => Promise<{ toPNG: () => Buffer }>) => ({
  isDestroyed: () => false,
  webContents: { capturePage: capture },
})

describe('diagnostics:captureGlyph', () => {
  beforeEach(() => {
    handlers.clear()
    writes.clear()
    mkdirs.length = 0
    showItemInFolder.mockClear()
  })

  it('writes the JSON + PNG into a fixed glyph-diagnostics dir and reveals them', async () => {
    const win = fakeWindow(async () => ({ toPNG: () => Buffer.from('PNGDATA') }))
    registerDiagnosticsHandlers(() => win as never)
    const r = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, validPayload())
    expect(r.ok).toBe(true)
    // path is built entirely in main: fixed dir + timestamp, never from the payload
    expect(r.jsonPath).toMatch(/C:[/\\]res[/\\]glyph-diagnostics[/\\]glyph-[0-9-]+\.json$/)
    expect(r.imagePath).toMatch(/glyph-[0-9-]+\.png$/)
    expect(mkdirs.some((d) => /glyph-diagnostics/.test(d))).toBe(true)
    expect(writes.has(r.jsonPath!)).toBe(true)
    expect(writes.get(r.imagePath!)).toEqual(Buffer.from('PNGDATA'))
    expect(showItemInFolder).toHaveBeenCalledWith(r.imagePath)
    // the JSON round-trips the payload
    expect(JSON.parse(writes.get(r.jsonPath!) as string).appVersion).toBe('2.1.0-beta.17')
  })

  it('downgrades to JSON-only when the screenshot fails, still ok', async () => {
    const win = fakeWindow(async () => { throw new Error('capture unsupported') })
    registerDiagnosticsHandlers(() => win as never)
    const r = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, validPayload())
    expect(r.ok).toBe(true)
    expect(r.jsonPath).toBeDefined()
    expect(r.imagePath).toBeUndefined()
    expect(showItemInFolder).toHaveBeenCalledWith(r.jsonPath)
  })

  it('writes JSON even with no window (headless), no screenshot', async () => {
    registerDiagnosticsHandlers(() => null)
    const r = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, validPayload())
    expect(r.ok).toBe(true)
    expect(r.imagePath).toBeUndefined()
  })

  it('rejects a payload of the wrong shape without writing anything', async () => {
    registerDiagnosticsHandlers(() => null)
    const r = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, { appVersion: 5, atlas: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/shape/)
    expect(writes.size).toBe(0)
  })

  it('rejects an oversized payload before writing', async () => {
    registerDiagnosticsHandlers(() => null)
    const huge = validPayload()
    huge.atlas.events = Array.from({ length: 50_000 }, (_, i) => ({ t: i, kind: 'clear', label: 'x'.repeat(20), generation: i }))
    // sanity: this really is over the cap
    expect(Buffer.byteLength(JSON.stringify(huge), 'utf8')).toBeGreaterThan(GLYPH_DIAGNOSTIC_MAX_BYTES)
    const r = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, huge)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/too large/)
    expect(writes.size).toBe(0)
  })
})
