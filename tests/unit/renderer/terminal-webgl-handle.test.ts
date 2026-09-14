/**
 * Unit tests for the WebglHandle returned by installWebglWithRecovery (#273).
 *
 * The handle must target whichever addon is CURRENTLY live — including after a
 * context-loss recreation — and cleanly no-op (return false) when WebGL isn't
 * active, so the caller falls back to a plain term.refresh().
 */
import { describe, it, expect, vi } from 'vitest'
import { installWebglWithRecovery } from '../../../src/renderer/components/terminal/terminalWebgl'

interface FakeInstance {
  clearTextureAtlas: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  contextLoss?: () => void
}

function setup(opts?: { throwOnConstruct?: (n: number) => boolean; throwOnClear?: boolean }) {
  const instances: FakeInstance[] = []
  let n = 0
  const FakeWebglAddon = class {
    clearTextureAtlas = vi.fn(() => { if (opts?.throwOnClear) throw new Error('gl gone') })
    dispose = vi.fn()
    contextLoss?: () => void
    constructor() {
      n += 1
      if (opts?.throwOnConstruct?.(n)) throw new Error('no webgl')
      instances.push(this as unknown as FakeInstance)
    }
    onContextLoss(cb: () => void) { (this as unknown as FakeInstance).contextLoss = cb }
  }
  const term = { rows: 24, loadAddon: vi.fn(), refresh: vi.fn() }
  const syncRaf = (cb: () => void) => { cb(); return 0 }
  const handle = installWebglWithRecovery(term as never, {
    WebglAddonCtor: FakeWebglAddon as never,
    raf: syncRaf,
    isDisposed: () => false,
  })
  return { handle, term, instances }
}

describe('installWebglWithRecovery — WebglHandle', () => {
  it('clearTextureAtlas() targets the loaded addon and returns true', () => {
    const { handle, instances } = setup()
    expect(handle.clearTextureAtlas()).toBe(true)
    expect(instances[0].clearTextureAtlas).toHaveBeenCalledTimes(1)
  })

  it('returns false when WebGL never loaded (initial construction threw)', () => {
    const { handle, term } = setup({ throwOnConstruct: (n) => n === 1 })
    expect(handle.clearTextureAtlas()).toBe(false)
    expect(term.loadAddon).not.toHaveBeenCalled()
  })

  it('after a context loss + successful recreate, targets the NEW addon', () => {
    const { handle, instances } = setup()
    instances[0].contextLoss!()          // recreate succeeds → instances[1]
    expect(instances).toHaveLength(2)

    expect(handle.clearTextureAtlas()).toBe(true)
    expect(instances[1].clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(instances[0].clearTextureAtlas).not.toHaveBeenCalled()
  })

  it('returns false after a context loss whose recreate fails (dropped to DOM)', () => {
    const { handle, term, instances } = setup({ throwOnConstruct: (n) => n === 2 })
    instances[0].contextLoss!()          // recreate throws → DOM fallback
    expect(handle.clearTextureAtlas()).toBe(false)
    // The recreate-failure path forces a DOM repaint.
    expect(term.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('returns false (not throws) when the live addon clearTextureAtlas throws', () => {
    const { handle } = setup({ throwOnClear: true })
    expect(() => handle.clearTextureAtlas()).not.toThrow()
    expect(handle.clearTextureAtlas()).toBe(false)
  })
})
