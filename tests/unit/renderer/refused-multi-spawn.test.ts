/**
 * P3.13 round 1 (M7): when main refuses a copy because the config is not Multi
 * Spawn while the screen says it is (a save that did not land), the screen's
 * toggle is made the saved one. The helper on its own, over injected sources;
 * its wiring into the terminal tab is terminalview-account-launch.test.tsx's.
 */
import { describe, it, expect, vi } from 'vitest'
import { reconcileRefusedMultiSpawn, type RefusedMultiSpawnDeps } from '../../../src/renderer/utils/refusedMultiSpawn'

function deps(screen: { found: boolean; allowMultiSpawn?: unknown }, saved: unknown[] | null | 'throws'): RefusedMultiSpawnDeps & { set: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> } {
  const set = vi.fn()
  const read = vi.fn(async () => { if (saved === 'throws') throw new Error('no ipc'); return saved })
  return { onScreen: () => ({ found: screen.found, allowMultiSpawn: screen.allowMultiSpawn }), readSaved: read, setOnScreen: set, set, read }
}

describe('reconcileRefusedMultiSpawn', () => {
  it('a toggle on the screen that is not saved is made the saved one', async () => {
    const d = deps({ found: true, allowMultiSpawn: true }, [{ id: 'c1', allowMultiSpawn: false }])
    expect(await reconcileRefusedMultiSpawn('c1', d)).toBe(true)
    expect(d.set).toHaveBeenCalledWith('c1', false)
  })

  it('a saved config that never had the field makes it undefined again (never chosen)', async () => {
    const d = deps({ found: true, allowMultiSpawn: true }, [{ id: 'c1' }])
    expect(await reconcileRefusedMultiSpawn('c1', d)).toBe(true)
    expect(d.set).toHaveBeenCalledWith('c1', undefined)
  })

  it('anything the saved config holds that is not an explicit true counts as off, as main reads it', async () => {
    for (const v of ['yes', 1, null, 'true']) {
      const d = deps({ found: true, allowMultiSpawn: true }, [{ id: 'c1', allowMultiSpawn: v }])
      expect(await reconcileRefusedMultiSpawn('c1', d), String(v)).toBe(true)
      expect(d.set).toHaveBeenCalledWith('c1', undefined)
    }
  })

  it('reads nothing when the screen already says it is not Multi Spawn: the refusal is simply true', async () => {
    for (const flag of [undefined, false, 'yes', 1]) {
      const d = deps({ found: true, allowMultiSpawn: flag }, [{ id: 'c1', allowMultiSpawn: false }])
      expect(await reconcileRefusedMultiSpawn('c1', d)).toBe(false)
      expect(d.read).not.toHaveBeenCalled()
      expect(d.set).not.toHaveBeenCalled()
    }
  })

  it('changes nothing when the saved config agrees', async () => {
    const d = deps({ found: true, allowMultiSpawn: true }, [{ id: 'c1', allowMultiSpawn: true }])
    expect(await reconcileRefusedMultiSpawn('c1', d)).toBe(false)
    expect(d.set).not.toHaveBeenCalled()
  })

  it('changes nothing when the saved configs cannot be read, the config is not saved, or the read fails', async () => {
    for (const saved of [null, [], [{ id: 'other', allowMultiSpawn: false }], [null, 3, 'x'], 'throws'] as const) {
      const d = deps({ found: true, allowMultiSpawn: true }, saved as never)
      expect(await reconcileRefusedMultiSpawn('c1', d), JSON.stringify(saved)).toBe(false)
      expect(d.set).not.toHaveBeenCalled()
    }
  })

  it('changes nothing for a config that is not on the screen, or a refusal that names none', async () => {
    const d = deps({ found: false }, [{ id: 'c1', allowMultiSpawn: false }])
    expect(await reconcileRefusedMultiSpawn('c1', d)).toBe(false)
    for (const id of [undefined, '']) expect(await reconcileRefusedMultiSpawn(id, d)).toBe(false)
    expect(d.read).not.toHaveBeenCalled()
  })

  it('the first saved config with the id decides, as main reads it', async () => {
    const d = deps({ found: true, allowMultiSpawn: true }, [{ id: 'c1', allowMultiSpawn: true }, { id: 'c1', allowMultiSpawn: false }])
    expect(await reconcileRefusedMultiSpawn('c1', d)).toBe(false)
  })
})
