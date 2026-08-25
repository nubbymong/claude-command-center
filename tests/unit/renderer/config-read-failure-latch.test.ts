/**
 * A failed config READ must never become a config WRITE -- the rest of it.
 *
 * #341 latched writes off when `config:loadAll` REJECTED. The ADR-009 pass on
 * the beta.16 substrate found three ways a failed read still wrote (all
 * pre-existing): a read that RESOLVES with `readFailed` / `failedKeys` (an
 * unreachable dir, a corrupt file) never latched; the two boot migrations
 * wrote through their own `config.save` calls regardless of the latch; and the
 * (since-retired, #443) Agent Library saved straight to the IPC. Plus one new crash: a corrupt
 * usage-tracking.json hydrated to {} and the dock's render threw on it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

function setupWindow() {
  const calls: Array<{ key: string; data: unknown }> = []
  const save = vi.fn((key: string, data: unknown) => { calls.push({ key, data }); return Promise.resolve(true) })
  ;(globalThis as any).window = {
    electronAPI: {
      config: { save },
      help: { workspace: vi.fn(() => Promise.resolve('C:/help/workspace')) },
    },
  }
  return { calls, save }
}

const { readFailureLockReason, applyConfigColourMigration, retireAskConfig, hydrateStores } =
  await import('../../../src/renderer/utils/configHydration')
const { useConfigWriteLockStore } = await import('../../../src/renderer/stores/configWriteLockStore')
const { useBrowserStore } = await import('../../../src/renderer/stores/browserStore')
const { useTipsStore, countUnseenTips, normaliseTracking } = await import('../../../src/renderer/stores/tipsStore')

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)) }

beforeEach(() => { useConfigWriteLockStore.getState().unlock() })

describe('readFailureLockReason -- a read that failed without rejecting', () => {
  it('null for a clean result', () => {
    expect(readFailureLockReason({ readFailed: false, failedKeys: [] })).toBeNull()
    expect(readFailureLockReason({})).toBeNull()
    expect(readFailureLockReason(null)).toBeNull()
  })
  it('an unreachable dir', () => {
    expect(readFailureLockReason({ readFailed: true, failedKeys: ['settings', 'commands'] })).toMatch(/could not reach your configuration folder/)
  })
  it('names the failed files', () => {
    expect(readFailureLockReason({ failedKeys: ['settings'] })).toMatch(/one of your configuration files.*\(settings\)/)
    expect(readFailureLockReason({ failedKeys: ['settings', 'appMeta'] })).toMatch(/2 of your configuration files.*\(settings, appMeta\)/)
  })
  it('ignores junk in failedKeys', () => {
    expect(readFailureLockReason({ failedKeys: [42 as never, '', null as never] })).toBeNull()
  })
})

describe('the two boot migrations honour the latch', () => {
  it('applyConfigColourMigration writes NOTHING while locked, and writes when not (so the guard is what stops it)', async () => {
    const legacy = { settings: {}, configs: [{ id: 'a', label: 'A', color: '#89b4fa', workingDirectory: '/', sessionType: 'local', provider: 'claude' }] }
    const { calls } = setupWindow()
    useConfigWriteLockStore.getState().lock('read failed')
    const out = await applyConfigColourMigration(structuredClone(legacy))
    expect(calls).toEqual([])
    expect(out).toEqual(legacy)
    useConfigWriteLockStore.getState().unlock()
    await applyConfigColourMigration(structuredClone(legacy))
    expect(calls.map((c) => c.key)).toContain('configs')
  })
  it('retireAskConfig writes NOTHING while locked', async () => {
    const { calls } = setupWindow()
    useConfigWriteLockStore.getState().lock('read failed')
    const input = { appMeta: null, configs: [] }
    const out = await retireAskConfig(input)
    expect(calls).toEqual([])
    expect(out).toBe(input)
    expect((globalThis as any).window.electronAPI.help.workspace).not.toHaveBeenCalled()
  })
})

describe('store writes go through config-saver (the latch holds)', () => {
  // The original worked example here was the Agent Library (the ADR-009
  // beta.16 finding). #443 retired that store; the invariant it proved --
  // saveConfigNow honours the write latch -- is pinned on the browser
  // favourites store instead, which persists through the same path.
  it('a favourite added under the latch writes nothing; the same add unlocked writes browser', async () => {
    const { calls } = setupWindow()
    useBrowserStore.getState().hydrate({})
    useConfigWriteLockStore.getState().lock('read failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useBrowserStore.getState().toggleFavourite('http://a.example/', 'A')
    await tick()
    expect(calls).toEqual([])
    useConfigWriteLockStore.getState().unlock()
    useBrowserStore.getState().toggleFavourite('http://b.example/', 'B')
    await tick()
    expect(calls.map((c) => c.key)).toEqual(['browser'])
    warn.mockRestore()
  })
})

describe('a corrupt usage-tracking.json cannot take the window down', () => {
  it('normaliseTracking always yields the four maps', () => {
    expect(normaliseTracking([])).toEqual({ features: {}, tipsShown: {}, tipsDismissed: {}, tipsActed: {} })
    expect(normaliseTracking('corrupt')).toEqual({ features: {}, tipsShown: {}, tipsDismissed: {}, tipsActed: {} })
    expect(normaliseTracking({ features: 'x', tipsShown: null, tipsDismissed: { a: 1 } })).toEqual({ features: {}, tipsShown: {}, tipsDismissed: { a: 1 }, tipsActed: {} })
  })
  it('hydrateStores with a corrupt section leaves a VALID tracking, and the readers work', async () => {
    setupWindow()
    useConfigWriteLockStore.getState().lock('keep the test write-free')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrateStores({ usageTracking: 'corrupt' as never })
    hydrateStores({ usageTracking: [] as never })
    const t = useTipsStore.getState().tracking
    expect(t.features).toEqual({})
    expect(t.tipsDismissed).toEqual({})
    expect(() => countUnseenTips(t)).not.toThrow()
    expect(() => useTipsStore.getState().recordUsage('sessions.create-config')).not.toThrow()
    expect(() => useTipsStore.getState().pickNextTip()).not.toThrow()
    warn.mockRestore()
  })
  it('countUnseenTips tolerates a tracking with missing maps even if one reaches it', () => {
    expect(() => countUnseenTips({} as never)).not.toThrow()
  })
})
