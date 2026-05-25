import { describe, it, expect, beforeEach, vi } from 'vitest'
import { applyConfigColourMigration } from '../../../src/renderer/utils/configHydration'

function setupSave(impl?: (key: string, data: any) => Promise<unknown>) {
  const calls: Array<{ key: string; data: any }> = []
  const save = vi.fn((key: string, data: any) => {
    calls.push({ key, data })
    return impl ? impl(key, data) : Promise.resolve()
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
