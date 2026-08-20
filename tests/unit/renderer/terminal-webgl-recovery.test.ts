/**
 * Unit tests for the WebGL addon recovery helper (installWebglWithRecovery).
 * Tests the context-loss → recreate → refresh-fallback logic in isolation,
 * without needing a real GPU or DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installWebglWithRecovery, createAtlasRefresh, DEFAULT_MAX_RECREATES } from '../../../src/renderer/components/terminal/terminalWebgl'

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

  // -------------------------------------------------------------------------
  // Recreate cap: a flapping context must NOT recreate forever (#311)
  // -------------------------------------------------------------------------

  it('stops recreating after maxRecreates consecutive context losses', () => {
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
      maxRecreates: 2,
    })

    // Initial load => 1 construct.
    contextLossCallback!() // loss 1: under cap -> recreate (construct 2)
    contextLossCallback!() // loss 2: under cap -> recreate (construct 3)
    const atCap = constructCallCount
    expect(atCap).toBe(3)

    contextLossCallback!() // loss 3: cap reached -> NO recreate, repaint instead
    contextLossCallback!() // loss 4: still capped -> still no recreate

    expect(constructCallCount).toBe(atCap)          // no further addons built
    expect(refreshCallCount).toBeGreaterThanOrEqual(1) // capped losses repaint the DOM
    expect(refreshArgs).toEqual([0, 23])
  })

  it('bounds total recreations under a persistent context-loss storm (default cap)', () => {
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
    })

    for (let i = 0; i < 50; i++) contextLossCallback!()

    // 1 initial + at most DEFAULT_MAX_RECREATES recreations — never one per loss.
    expect(constructCallCount).toBe(1 + DEFAULT_MAX_RECREATES)
  })

  // -------------------------------------------------------------------------
  // The cap counts ONE storm, not the terminal's lifetime (#312 review)
  // -------------------------------------------------------------------------

  it('does not recreate for a loss still inside the stable period once capped', () => {
    let clock = 0
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
      maxRecreates: 2,
      stablePeriodMs: 30_000,
      now: () => clock,
    })

    clock = 0; contextLossCallback!()      // recreate -> construct 2
    clock = 1_000; contextLossCallback!()  // recreate -> construct 3
    clock = 2_000; contextLossCallback!()  // cap reached -> no recreate
    expect(constructCallCount).toBe(3)

    // Still inside the stable period: the storm is ongoing, stay capped.
    clock = 2_000 + 30_000; contextLossCallback!() // gap == stablePeriodMs, NOT >
    expect(constructCallCount).toBe(3)
  })

  it('resets the cap for a loss that arrives after the context held stable', () => {
    let clock = 0
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
      maxRecreates: 2,
      stablePeriodMs: 30_000,
      now: () => clock,
    })

    clock = 0; contextLossCallback!()
    clock = 1_000; contextLossCallback!()
    clock = 2_000; contextLossCallback!()  // capped
    expect(constructCallCount).toBe(3)

    // The context then rendered for well past the stable period. This loss is a
    // NEW incident — a driver update, a sleep/wake — not the same storm, so the
    // terminal gets its recoveries back instead of being stuck on the DOM
    // renderer for the rest of its life.
    clock = 2_000 + 30_001; contextLossCallback!()
    expect(constructCallCount).toBe(4)
  })

  it('survives three unrelated blips a day apart without giving up WebGL', () => {
    let clock = 0
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
      now: () => clock,
    })

    const DAY = 24 * 60 * 60 * 1000
    for (let i = 1; i <= 6; i++) { clock = i * DAY; contextLossCallback!() }

    // Every one recovered: 1 initial + 6 recreations. A lifetime cap would have
    // stopped at 1 + DEFAULT_MAX_RECREATES.
    expect(constructCallCount).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// createAtlasRefresh: the coordinator callback is inert without live WebGL
// ---------------------------------------------------------------------------

describe('createAtlasRefresh', () => {
  it('repaints while WebGL is live on this terminal', () => {
    let refreshes = 0
    const handle = { isActive: () => true, clearTextureAtlas: () => true }
    createAtlasRefresh(() => handle as any, () => { refreshes++ })()
    expect(refreshes).toBe(1)
  })

  it('does not repaint a terminal whose WebGL never loaded', () => {
    let refreshes = 0
    // installWebglWithRecovery swallows an initial load failure and hands back a
    // handle that is simply never active — the DOM renderer is doing the work
    // and its viewport is already correct.
    const handle = { isActive: () => false, clearTextureAtlas: () => false }
    createAtlasRefresh(() => handle as any, () => { refreshes++ })()
    expect(refreshes).toBe(0)
  })

  it('stops repainting once a terminal falls back to the DOM renderer for good', () => {
    let refreshes = 0
    let live = true
    const handle = { isActive: () => live, clearTextureAtlas: () => live }
    const cb = createAtlasRefresh(() => handle as any, () => { refreshes++ })

    cb()
    expect(refreshes).toBe(1)

    // Context-loss storm hit the recreate cap: WebGL is gone for this terminal.
    // Registration happened at mount, so only a liveness check inside the
    // callback can notice.
    live = false
    cb()
    expect(refreshes).toBe(1)
  })

  it('does not repaint before the handle exists', () => {
    let refreshes = 0
    createAtlasRefresh(() => null, () => { refreshes++ })()
    expect(refreshes).toBe(0)
  })
})
