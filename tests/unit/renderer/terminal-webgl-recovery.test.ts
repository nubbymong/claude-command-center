/**
 * Unit tests for the WebGL addon recovery helper (installWebglWithRecovery).
 * Tests the context-loss → recreate → refresh-fallback logic in isolation,
 * without needing a real GPU or DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installWebglWithRecovery } from '../../../src/renderer/components/terminal/terminalWebgl'

describe('installWebglWithRecovery', () => {
  let contextLossCallback: (() => void) | null
  let disposeCallCount: number
  let loadAddonCallCount: number
  let refreshCallCount: number
  let refreshArgs: [number, number] | null
  let constructCallCount: number

  // A fake WebglAddon whose onContextLoss captures the callback.
  let FakeWebglAddon: new () => {
    onContextLoss: (cb: () => void) => void
    dispose: () => void
  }

  // A fake Terminal with spies for loadAddon and refresh.
  let fakeTerm: {
    loadAddon: (addon: unknown) => void
    refresh: (start: number, end: number) => void
    rows: number
  }

  // A synchronous rAF stub that runs the callback immediately.
  const syncRaf = (cb: () => void) => { cb(); return 0 }

  beforeEach(() => {
    contextLossCallback = null
    disposeCallCount = 0
    loadAddonCallCount = 0
    refreshCallCount = 0
    refreshArgs = null
    constructCallCount = 0

    FakeWebglAddon = class {
      constructor() { constructCallCount++ }
      onContextLoss(cb: () => void) { contextLossCallback = cb }
      dispose() { disposeCallCount++ }
    }

    fakeTerm = {
      rows: 24,
      loadAddon: vi.fn(() => { loadAddonCallCount++ }),
      refresh: vi.fn((start: number, end: number) => {
        refreshCallCount++
        refreshArgs = [start, end]
      }),
    }
  })

  // -------------------------------------------------------------------------
  // Happy path: initial load
  // -------------------------------------------------------------------------

  it('constructs a WebglAddon and loads it on the terminal on first call', () => {
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
    })

    expect(constructCallCount).toBe(1)
    expect(loadAddonCallCount).toBe(1)
  })

  it('registers an onContextLoss handler', () => {
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
    })

    expect(contextLossCallback).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // Context-loss → recreate
  // -------------------------------------------------------------------------

  it('disposes old addon and creates + loads a new one after context loss', () => {
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
    })

    // Simulate the GPU context being lost.
    contextLossCallback!()

    // Old addon disposed.
    expect(disposeCallCount).toBe(1)

    // A second WebglAddon was constructed and loaded (the recreate).
    expect(constructCallCount).toBe(2)
    expect(loadAddonCallCount).toBe(2)

    // term.refresh should NOT have been called — recreate succeeded.
    expect(refreshCallCount).toBe(0)
  })

  it('does NOT call term.refresh when recreate succeeds', () => {
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
    })

    contextLossCallback!()

    expect(refreshCallCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Context-loss → recreate fails → refresh fallback
  // -------------------------------------------------------------------------

  it('calls term.refresh(0, rows-1) when the recreate constructor throws', () => {
    let firstInstance = true
    const ThrowingOnSecondCtor = class {
      constructor() {
        constructCallCount++
        if (!firstInstance) throw new Error('WebGL unavailable')
        firstInstance = false
      }
      onContextLoss(cb: () => void) { contextLossCallback = cb }
      dispose() { disposeCallCount++ }
    }

    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: ThrowingOnSecondCtor as any,
      raf: syncRaf,
      isDisposed: () => false,
    })

    // First construction succeeded; fire context loss.
    contextLossCallback!()

    expect(disposeCallCount).toBe(1)
    // Second construction threw; fallback refresh should have fired.
    expect(refreshCallCount).toBe(1)
    expect(refreshArgs).toEqual([0, 23]) // term.rows - 1 = 23
  })

  it('calls term.refresh(0, rows-1) when loadAddon throws on recreate', () => {
    let firstLoad = true
    fakeTerm.loadAddon = vi.fn(() => {
      loadAddonCallCount++
      if (!firstLoad) throw new Error('loadAddon failed')
      firstLoad = false
    })

    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
    })

    contextLossCallback!()

    expect(disposeCallCount).toBe(1)
    expect(refreshCallCount).toBe(1)
    expect(refreshArgs).toEqual([0, 23])
  })

  // -------------------------------------------------------------------------
  // disposed guard: no action after the component is torn down
  // -------------------------------------------------------------------------

  it('does not recreate or refresh when isDisposed() returns true at the time of rAF', () => {
    let disposed = false

    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => disposed,
    })

    // Component is torn down before the rAF fires.
    disposed = true
    const countBefore = constructCallCount
    contextLossCallback!()

    expect(constructCallCount).toBe(countBefore) // no new addon
    expect(refreshCallCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Does not throw when WebGL is unavailable on first call
  // -------------------------------------------------------------------------

  it('swallows the error silently when initial construction throws', () => {
    const AlwaysThrows = class {
      constructor() { throw new Error('no WebGL') }
    }

    expect(() =>
      installWebglWithRecovery(fakeTerm as any, {
        WebglAddonCtor: AlwaysThrows as any,
        raf: syncRaf,
        isDisposed: () => false,
      })
    ).not.toThrow()

    // No load attempt either.
    expect(loadAddonCallCount).toBe(0)
  })
})
