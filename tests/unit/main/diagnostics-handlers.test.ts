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

// The handler throttles by wall clock (Date.now). Advance it well past the
// min-interval before each test so independent tests never rate-limit each other.
let clock = 1_000_000
describe('diagnostics:captureGlyph', () => {
  beforeEach(() => {
    handlers.clear()
    writes.clear()
    mkdirs.length = 0
    showItemInFolder.mockClear()
    clock += 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
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

  it('drops extra fields and defeats the pretty-print amplification (ADR-009): a nested extra field never reaches disk', async () => {
    registerDiagnosticsHandlers(() => null)
    // A compact-small payload whose EXTRA field balloons when pretty-printed —
    // the exact size-cap bypass the adversarial pass found. Sanitize strips it.
    const evil: any = validPayload()
    evil.x = Array.from({ length: 60 }, () => { let n: any = 1; for (let d = 0; d < 1000; d++) n = [n]; return n })
    const compact = Buffer.byteLength(JSON.stringify(evil), 'utf8')
    expect(compact).toBeLessThan(GLYPH_DIAGNOSTIC_MAX_BYTES)   // passes a compact cap
    const r = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, evil)
    expect(r.ok).toBe(true)
    const written = writes.get(r.jsonPath!) as string
    expect(written).not.toContain('"x"')                       // the extra field is gone
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThan(GLYPH_DIAGNOSTIC_MAX_BYTES)  // no balloon
    expect(JSON.parse(written).appVersion).toBe('2.1.0-beta.17')
  })

  it('caps the atlas arrays so a flood of events cannot balloon the write', async () => {
    registerDiagnosticsHandlers(() => null)
    const flood = validPayload()
    flood.atlas.events = Array.from({ length: 50_000 }, (_, i) => ({ t: i, kind: 'clear', label: 'x'.repeat(500), generation: i })) as never
    const r = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, flood)
    expect(r.ok).toBe(true)
    const parsed = JSON.parse(writes.get(r.jsonPath!) as string)
    expect(parsed.atlas.events.length).toBeLessThanOrEqual(500)
    expect(parsed.atlas.events[0].label.length).toBeLessThanOrEqual(128)
  })

  it('throttles rapid calls — a second capture within the min interval is rate-limited and writes nothing', async () => {
    registerDiagnosticsHandlers(() => null)
    const first = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, validPayload())
    expect(first.ok).toBe(true)
    const before = writes.size
    // same clock value -> inside the min interval
    const second = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, validPayload())
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/rate limited/)
    expect(writes.size).toBe(before)   // nothing new written
    // past the interval -> accepted again
    clock += 2000
    const third = await invoke(IPC.DIAGNOSTICS_CAPTURE_GLYPH, validPayload())
    expect(third.ok).toBe(true)
  })
})
