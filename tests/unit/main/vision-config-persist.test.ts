/**
 * Vision settings: a failed read is not "not configured yet" (#371).
 *
 * The loss path here is a round trip through the UI rather than a boot sweep:
 * `vision:getConfig` answered null for a read FAILURE exactly as for an absent
 * file, so the settings form rendered its defaults, the user touched one
 * control, and `vision:saveConfig` wrote those defaults over the config it had
 * never managed to read.
 *
 * And it always said it had worked — the old handler discarded `writeConfig`'s
 * boolean and returned `{ ok: true }` unconditionally, so a failed save was
 * reported to the user as a successful one too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { GlobalVisionConfig } from '../../../src/shared/types'

const handlers = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
  BrowserWindow: class {},
}))

const store: Record<string, unknown> = {}
const cfg = { readFails: false, writeOk: true }
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => store[key] ?? null,
  readConfigChecked: (key: string) => {
    if (cfg.readFails) return { value: null, outcome: 'failed' }
    return key in store ? { value: store[key], outcome: 'ok' } : { value: null, outcome: 'absent' }
  },
  writeConfig: (key: string, data: unknown) => {
    if (!cfg.writeOk) return false
    store[key] = data
    return true
  },
}))

vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(async () => {}),
  stopGlobalVision: vi.fn(async () => {}),
  getGlobalVisionStatus: vi.fn(() => ({ running: false })),
  launchBrowser: vi.fn(async () => ({})),
  tryReconnectGlobalVision: vi.fn(),
  resetVisionRelaunchBreaker: vi.fn(),
  isGlobalVisionRunning: vi.fn(() => false),
}))
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(), logTrace: vi.fn(),
}))

const { registerVisionHandlers, _resetVisionLatchForTest } = await import('../../../src/main/ipc/vision-handlers')

const REAL: GlobalVisionConfig = { enabled: true, browser: 'edge', debugPort: 9333, headless: false } as GlobalVisionConfig
const DEFAULTS = { enabled: true, browser: 'chrome', debugPort: 9222, headless: true } as GlobalVisionConfig

const getConfig = () => handlers.get('vision:getConfig')!({})
const saveConfig = (c: GlobalVisionConfig) => handlers.get('vision:saveConfig')!({}, c)

beforeEach(() => {
  handlers.clear()
  for (const k of Object.keys(store)) delete store[k]
  cfg.readFails = false
  cfg.writeOk = true
  _resetVisionLatchForTest()
  registerVisionHandlers(() => null)
})

describe('vision config persistence', () => {
  it('round-trips a saved config', async () => {
    expect(await saveConfig(REAL)).toEqual({ ok: true })
    expect(await getConfig()).toEqual(REAL)
  })

  it('refuses to save over a config it could not read, and says so', async () => {
    store.visionGlobal = REAL
    cfg.readFails = true

    // The form renders defaults because getConfig came back null…
    expect(await getConfig()).toBeNull()
    // …the user touches a control and it saves. This is the write that lost it.
    const res = await saveConfig(DEFAULTS)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not be read/i)

    cfg.readFails = false
    expect(await getConfig()).toEqual(REAL)
  })

  it('reports a failed write as a failure rather than {ok:true}', async () => {
    cfg.writeOk = false
    const res = await saveConfig(REAL)
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('an ABSENT config still saves — first-run setup must be able to write one', async () => {
    expect(await getConfig()).toBeNull()
    expect(await saveConfig(REAL)).toEqual({ ok: true })
    expect(store.visionGlobal).toEqual(REAL)
  })

  it('resumes saving once a load succeeds', async () => {
    store.visionGlobal = REAL
    cfg.readFails = true
    await getConfig()
    expect((await saveConfig(DEFAULTS)).ok).toBe(false)

    cfg.readFails = false
    expect(await getConfig()).toEqual(REAL)
    expect(await saveConfig(DEFAULTS)).toEqual({ ok: true })
    expect(store.visionGlobal).toEqual(DEFAULTS)
  })

  it('vision:start latches too — it reads the same file', async () => {
    store.visionGlobal = REAL
    cfg.readFails = true
    // A read failure reads as "not configured", which is the pre-existing
    // behaviour; what must NOT happen is a save on the back of it.
    await handlers.get('vision:start')!({})
    expect((await saveConfig(DEFAULTS)).ok).toBe(false)
    cfg.readFails = false
    expect(await getConfig()).toEqual(REAL)
  })
})
