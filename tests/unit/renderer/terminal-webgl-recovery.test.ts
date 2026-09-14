/**
 * Unit tests for the WebGL addon recovery helper (installWebglWithRecovery).
 * Tests the context-loss → recreate → refresh-fallback logic in isolation,
 * without needing a real GPU or DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installWebglWithRecovery, createAtlasResync, DEFAULT_MAX_RECREATES, DEFAULT_STABLE_PERIOD_MS } from '../../../src/renderer/components/terminal/terminalWebgl'

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
  it('bounds a frame-paced storm, counting losses as they arrive', () => {
    // A real storm: losses ~one frame apart, and the browser runs the queued
    // frames later. Counting inside the frame instead of at loss time would let
    // N losses queue N recreates before the cap is ever consulted.
    const queue: Array<() => void> = []
    const queuedRaf = (cb: () => void) => { queue.push(cb); return queue.length }
    let clock = 0

    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: queuedRaf,
      isDisposed: () => false,
      now: () => clock,
    })

    for (let i = 0; i < 10; i++) {
      clock += 16
      contextLossCallback!()
    }

    // At most one queued recreate per permitted recovery -- never one per loss.
    expect(queue.length).toBeLessThanOrEqual(DEFAULT_MAX_RECREATES)

    queue.splice(0).forEach((fn) => fn())
    expect(constructCallCount).toBeLessThanOrEqual(1 + DEFAULT_MAX_RECREATES)
  })

  it('caps a storm paced just under the stable period', () => {
    // The case the stable-period reset must NOT rescue: losses seconds apart is
    // still a storm, not a series of unrelated blips.
    let clock = 0
    installWebglWithRecovery(fakeTerm as any, {
      WebglAddonCtor: FakeWebglAddon as any,
      raf: syncRaf,
      isDisposed: () => false,
      now: () => clock,
    })
    for (let i = 0; i < 20; i++) {
      clock += DEFAULT_STABLE_PERIOD_MS - 1
      contextLossCallback!()
    }
    expect(constructCallCount).toBe(1 + DEFAULT_MAX_RECREATES)
  })
})

// ---------------------------------------------------------------------------
// createAtlasResync: clear this terminal's OWN model, THEN repaint — and only
// while WebGL is live here.
// ---------------------------------------------------------------------------

describe('createAtlasResync', () => {
  it('clears this terminal\'s own model BEFORE repainting', () => {
    // The order is the fix. Refreshing a victim whose model still says "nothing
    // changed" is what paints it blank: _updateModel keeps the stale vertices
    // and draws them against the atlas the other terminal just emptied.
    const calls: string[] = []
    const handle = { isActive: () => true, clearTextureAtlas: () => true }
    createAtlasResync(() => handle as any, () => calls.push('clear'), () => calls.push('refresh'))()
    expect(calls).toEqual(['clear', 'refresh'])
  })

  it('does nothing at all for a terminal whose WebGL never loaded', () => {
    // installWebglWithRecovery swallows an initial load failure and hands back a
    // handle that is simply never active — the DOM renderer is doing the work,
    // holds no shared atlas, and its viewport is already correct. Clearing its
    // model would be a visible repaint for no reason.
    const calls: string[] = []
    const handle = { isActive: () => false, clearTextureAtlas: () => false }
    createAtlasResync(() => handle as any, () => calls.push('clear'), () => calls.push('refresh'))()
    expect(calls).toEqual([])
  })

  it('stops once a terminal falls back to the DOM renderer for good', () => {
    const calls: string[] = []
    let live = true
    const handle = { isActive: () => live, clearTextureAtlas: () => live }
    const cb = createAtlasResync(() => handle as any, () => calls.push('clear'), () => calls.push('refresh'))

    cb()
    expect(calls).toEqual(['clear', 'refresh'])

    // Context-loss storm hit the recreate cap: WebGL is gone for this terminal.
    // Registration happened at mount, so only a liveness check inside the
    // callback can notice.
    live = false
    cb()
    expect(calls).toEqual(['clear', 'refresh'])
  })

  it('does nothing before the handle exists', () => {
    const calls: string[] = []
    createAtlasResync(() => null, () => calls.push('clear'), () => calls.push('refresh'))()
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The cap's own numbers, and its behaviour under a REAL (async) rAF.
//
// Three mutations survived the whole suite before these existed:
//   - DEFAULT_STABLE_PERIOD_MS 30_000 -> 1. A flapping context re-fires about a
//     frame apart, so a stable period under the storm cadence resets the counter
//     on every loss and the cap NEVER engages.
//   - DEFAULT_MAX_RECREATES 3 -> 25. The storm test asserted
//     `toBe(1 + DEFAULT_MAX_RECREATES)`, comparing the constant to itself.
//   - moving `recreateCount++` into the raf() callback. Every other test in this
//     file uses a SYNCHRONOUS rAF, which makes "counted at loss time" and
//     "counted at frame time" indistinguishable -- so no ordering bug in this
//     function was detectable at all.
// ---------------------------------------------------------------------------

describe('the recreate cap constants', () => {
  it('pins the numbers, because the storm test compares the constant to itself', () => {
    expect(DEFAULT_MAX_RECREATES).toBe(3)
    // Must stay well ABOVE the frame cadence of a real flapping context (~16ms),
    // or the stable-period reset cancels the cap it is meant to qualify.
    expect(DEFAULT_STABLE_PERIOD_MS).toBe(30_000)
    expect(DEFAULT_STABLE_PERIOD_MS).toBeGreaterThan(1_000)
  })
})

// ---------------------------------------------------------------------------
// Detaching: what makes "only the visible terminal holds a GPU context" possible
// ---------------------------------------------------------------------------

describe('dispose (detaching a hidden pane)', () => {
  let contextLoss: (() => void) | null
  let disposeCount: number
  let constructCount: number
  let refreshCount: number
  let Fake: new () => { onContextLoss: (cb: () => void) => void; dispose: () => void }
  let term: { loadAddon: (a: unknown) => void; refresh: (s: number, e: number) => void; rows: number }
  const syncRaf = (cb: () => void) => { cb(); return 0 }

  beforeEach(() => {
    contextLoss = null
    disposeCount = 0
    constructCount = 0
    refreshCount = 0
    Fake = class {
      constructor() { constructCount++ }
      onContextLoss(cb: () => void) { contextLoss = cb }
      dispose() { disposeCount++ }
    }
    term = { rows: 24, loadAddon: vi.fn(), refresh: vi.fn(() => { refreshCount++ }) }
  })

  const install = () => installWebglWithRecovery(term as never, {
    WebglAddonCtor: Fake as never,
    raf: syncRaf,
    isDisposed: () => false,
  })

  it('disposes the live addon and reports itself inactive', () => {
    const h = install()
    expect(h.isActive()).toBe(true)
    h.dispose()
    expect(disposeCount).toBe(1)
    expect(h.isActive()).toBe(false)
  })

  it('repaints on the way out, so the viewport WebGL last drew is not left behind', () => {
    const h = install()
    h.dispose()
    expect(refreshCount).toBe(1)
  })

  it('is idempotent -- a second dispose is not a second addon teardown', () => {
    const h = install()
    h.dispose()
    h.dispose()
    h.dispose()
    expect(disposeCount).toBe(1)
  })

  it('a context loss AFTER detaching does not take a context back', () => {
    // The whole point of detaching is that this terminal stops holding one of
    // the ~16 contexts the renderer allows. A recovery that fires afterwards
    // would quietly re-acquire it -- and a hidden pane would be holding a
    // context again with nothing on screen to show for it.
    const h = install()
    expect(constructCount).toBe(1)
    h.dispose()
    contextLoss?.()
    expect(constructCount).toBe(1)
    expect(h.isActive()).toBe(false)
    // …and the detached addon is not torn down a second time by the handler
    // that is no longer its business. Two guards stand between a detached
    // terminal and a live context -- the early-out here and the one in the
    // recreate callback -- and this assertion is what keeps the first of them
    // from silently becoming decoration.
    expect(disposeCount).toBe(1)
  })

  it('a recreate already QUEUED when the pane is hidden does not land', () => {
    // The real race, and the only thing the second guard covers: a context loss
    // schedules the recreate for the next frame, the user switches tab before
    // that frame arrives, and the callback then runs against a handle that has
    // already let go of its context. rAF is deferred here rather than
    // synchronous precisely so this ordering is reachable.
    let queued: (() => void) | null = null
    const h = installWebglWithRecovery(term as never, {
      WebglAddonCtor: Fake as never,
      raf: (cb) => { queued = cb; return 1 },
      isDisposed: () => false,
    })
    contextLoss?.()          // loss -> recreate scheduled, not yet run
    expect(queued).not.toBeNull()
    h.dispose()              // the tab goes away first
    queued!()                // …and only then does the frame arrive
    expect(constructCount).toBe(1)
    expect(h.isActive()).toBe(false)
  })

  it('clearTextureAtlas after detaching is a no-op that reports false', () => {
    const h = install()
    h.dispose()
    expect(h.clearTextureAtlas()).toBe(false)
  })

  it('re-installing after a detach gives a fresh, live handle', () => {
    // Coming back to the tab has to work, or the pane returns blank.
    const first = install()
    first.dispose()
    const second = install()
    expect(second.isActive()).toBe(true)
    expect(constructCount).toBe(2)
  })
})
