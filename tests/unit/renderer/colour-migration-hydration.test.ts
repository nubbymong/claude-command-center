import { describe, it, expect, beforeEach, vi } from 'vitest'
import { applyConfigColourMigration } from '../../../src/renderer/utils/configHydration'

function setupSave(impl?: (key: string, data: any) => Promise<unknown>) {
  const calls: Array<{ key: string; data: any }> = []
  const save = vi.fn((key: string, data: any) => {
    calls.push({ key, data })
    // `true`, not `undefined`. config.save resolves a BOOLEAN -- it reports
    // failure by resolving FALSE, never by rejecting. A default of undefined
    // encodes "undefined counts as a successful save", a value the real API
    // never produces, so hardening the source from `saved === false` to the
    // safer `!saved` would turn these tests red for the wrong reason.
    return impl ? impl(key, data) : Promise.resolve(true)
  })
  ;(globalThis as any).window = { electronAPI: { config: { save } } }
  return { calls, save }
}

describe('applyConfigColourMigration', () => {
  beforeEach(() => { (globalThis as any).window = undefined })

  it('fast-path: guard already set -> no saves, returns input unchanged', async () => {
    const { save } = setupSave()
    const data = { settings: { identityColorMigratedV2: true }, configs: [{ color: '#FF3366' }] }
    const out = await applyConfigColourMigration(data)
    expect(save).not.toHaveBeenCalled()
    expect(out).toBe(data)
  })

  it('changed configs: awaits configs save BEFORE settings save, sets guard + pending', async () => {
    const { calls } = setupSave()
    const data = { settings: {}, configs: [{ color: '#FF3366' }, { color: '#00FFFF' }] }
    const out: any = await applyConfigColourMigration(data)
    expect(calls.map((c) => c.key)).toEqual(['configs', 'settings'])
    expect(out.configs[0].identityColorKey).toBe('rose')
    expect(out.settings.identityColorMigratedV2).toBe(true)
    expect(out.settings.colourMigrationNoticePending).toBe(true)
  })

  it('clean / all-keyed: no configs save, guard set, pending NOT set', async () => {
    const { calls } = setupSave()
    const data = { settings: {}, configs: [{ color: '#FF3366', identityColorKey: 'rose' }] }
    const out: any = await applyConfigColourMigration(data)
    expect(calls.map((c) => c.key)).toEqual(['settings'])
    expect(out.settings.identityColorMigratedV2).toBe(true)
    expect(out.settings.colourMigrationNoticePending).toBeUndefined()
  })

  it('config save rejects: guard NOT set, returns original', async () => {
    const data = { settings: {}, configs: [{ color: '#FF3366' }] }
    setupSave((key) => key === 'configs' ? Promise.reject(new Error('disk')) : Promise.resolve())
    const out: any = await applyConfigColourMigration(data)
    expect(out).toBe(data)
  })

  it('config save RESOLVES FALSE: guard NOT set, returns original', async () => {
    // This is how the write actually fails. writeConfig catches everything and
    // returns a boolean, so the reject case above cannot happen in production —
    // and reading it as a rejection set the guard on a write that never landed,
    // then told the user to go review colours that were never saved.
    const data = { settings: {}, configs: [{ color: '#FF3366' }] }
    const { calls } = setupSave((key) => Promise.resolve(key === 'configs' ? false : true))
    const out: any = await applyConfigColourMigration(data)
    expect(out).toBe(data)
    expect(calls.map((c) => c.key)).toEqual(['configs'])
  })

  it('settings save RESOLVES FALSE: keeps the written configs, leaves the guard unset', async () => {
    const data = { settings: {}, configs: [{ color: '#FF3366' }] }
    setupSave((key) => Promise.resolve(key === 'settings' ? false : true))
    const out: any = await applyConfigColourMigration(data)
    expect(out.configs[0].identityColorKey).toBe('rose')
    expect(out.settings?.identityColorMigratedV2).toBeUndefined()
  })

  it('no-op case, settings save RESOLVES FALSE: guard NOT set', async () => {
    const data = { settings: {}, configs: [{ color: '#FF3366', identityColorKey: 'rose' }] }
    setupSave(() => Promise.resolve(false))
    const out: any = await applyConfigColourMigration(data)
    expect(out).toBe(data)
  })

  it('stands aside for a corrupt configs section instead of throwing the hydrate away', async () => {
    // `|| []` let a non-array through to migrateColorRecords, where
    // `records.map` threw from OUTSIDE the try — App.tsx then hydrated from {},
    // resetting every store to defaults and overwriting the user's real configs
    // on their next edit.
    const { save } = setupSave()
    const data = { settings: {}, configs: { nope: true } }
    const out = await applyConfigColourMigration(data)
    expect(out).toBe(data)
    expect(save).not.toHaveBeenCalled()
  })


  it('stands aside for a corrupt settings section instead of mangling it', async () => {
    // The mirror of the configs case above, and worse in one way. `|| {}` rejects
    // only FALSY values, so a string is truthy and spreads into character keys:
    // {"0":"t","1":"h",...}. Writing that back destroys the user's only forensic
    // copy AND sets identityColorMigratedV2 on it, so it never revisits -- and
    // because the result is a genuine plain object, hydrateStores' coerceObject
    // passes it without raising configHydrationNoticePending. A detected,
    // reportable corruption becomes a silent permanent one.
    const { save } = setupSave()
    const data = { settings: 'theme=dark', configs: [{ color: '#FF3366' }] }
    const out = await applyConfigColourMigration(data)
    expect(out).toBe(data)
    expect(data.settings).toBe('theme=dark')
    expect(save).not.toHaveBeenCalled()
  })

  it('stands aside for a settings section that is an array', async () => {
    const { save } = setupSave()
    const data = { settings: [{ a: 1 }], configs: [{ color: '#FF3366' }] }
    const out = await applyConfigColourMigration(data)
    expect(out).toBe(data)
    expect(save).not.toHaveBeenCalled()
  })

  it('still migrates when settings is absent or null', async () => {
    // Absent must stay writable: that is an ordinary first-run config, not a
    // corrupt one, and refusing it would strand the migration forever.
    for (const settings of [undefined, null]) {
      const { save } = setupSave()
      const data: any = { settings, configs: [{ color: '#FF3366' }] }
      const out: any = await applyConfigColourMigration(data)
      expect(out).not.toBe(data)
      expect(save).toHaveBeenCalled()
    }
  })

  it('config save ok but settings save rejects: returns original (retry next launch)', async () => {
    const data = { settings: {}, configs: [{ color: '#FF3366' }] }
    setupSave((key) => key === 'settings' ? Promise.reject(new Error('disk')) : Promise.resolve())
    const out: any = await applyConfigColourMigration(data)
    expect(out).toBe(data)
  })

  it('partial-success recovery: guard false, changed 0, records already keyed+legacy -> guard + pending', async () => {
    const { calls } = setupSave()
    const data = { settings: {}, configs: [{ color: '#FF3366', identityColorKey: 'rose', legacyColor: '#FF3366' }] }
    const out: any = await applyConfigColourMigration(data)
    expect(calls.map((c) => c.key)).toEqual(['settings'])
    expect(out.settings.identityColorMigratedV2).toBe(true)
    expect(out.settings.colourMigrationNoticePending).toBe(true)
  })

  it('partial-success recovery respects prior dismissal', async () => {
    setupSave()
    const data = { settings: { colourMigrationNoticeDismissed: true }, configs: [{ color: '#FF3366', identityColorKey: 'rose', legacyColor: '#FF3366' }] }
    const out: any = await applyConfigColourMigration(data)
    expect(out.settings.colourMigrationNoticePending).toBeUndefined()
  })
})
