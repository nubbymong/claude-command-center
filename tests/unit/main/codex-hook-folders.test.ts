// P3.10 round 4 (P1): when the Codex hook folders are prepared. Only while
// Codex is on: after the app's first paint (a delay, as the companion-folder
// pass waits), again whenever Codex is switched on, and before a local Codex
// launch, which waits for it at most a bounded time and otherwise starts
// without hooks (said in the log). Nothing here runs on the main thread's
// path: the preparation is the provider's (asynchronous), injected here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startCodexHookFolders, stopCodexHookFolders, codexHookFoldersSettingsChanged, awaitCodexHookFolders,
  CODEX_HOOK_FOLDERS_START_DELAY_MS, CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS,
} from '../../../src/main/codex-hook-folders'

function deps(o: { on?: boolean; result?: () => Promise<boolean> } = {}) {
  const state = { on: o.on ?? true, prepares: 0, listeners: [] as Array<() => void>, logs: [] as string[] }
  return {
    state,
    d: {
      providerOn: () => state.on,
      prepare: () => { state.prepares++; return o.result ? o.result() : Promise.resolve(true) },
      subscribe: (l: () => void) => { state.listeners.push(l); return () => { state.listeners = state.listeners.filter((x) => x !== l) } },
      log: (_level: 'info' | 'warn', m: string) => { state.logs.push(m) },
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { stopCodexHookFolders(); vi.useRealTimers() })

describe('the hook folders at the app\'s start (round 4, P1)', () => {
  it('nothing before the delay; then once, while Codex is on', async () => {
    const { state, d } = deps()
    startCodexHookFolders(d)
    await vi.advanceTimersByTimeAsync(CODEX_HOOK_FOLDERS_START_DELAY_MS - 1)
    expect(state.prepares).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(state.prepares).toBe(1)
    expect(CODEX_HOOK_FOLDERS_START_DELAY_MS).toBeGreaterThanOrEqual(3000)
  })

  it('Codex off: nothing, until it is switched on (a settings save or the accounts service)', async () => {
    const { state, d } = deps({ on: false })
    startCodexHookFolders(d)
    await vi.advanceTimersByTimeAsync(CODEX_HOOK_FOLDERS_START_DELAY_MS)
    codexHookFoldersSettingsChanged()
    for (const l of state.listeners) l()
    expect(state.prepares).toBe(0)
    state.on = true
    codexHookFoldersSettingsChanged()
    expect(state.prepares).toBe(1)
    for (const l of state.listeners) l()
    expect(state.prepares).toBe(2) // a no-op in the provider once ready
  })

  it('a change before the delay waits for it; stopping ends it all', async () => {
    const { state, d } = deps()
    startCodexHookFolders(d)
    codexHookFoldersSettingsChanged()
    expect(state.prepares).toBe(0)
    stopCodexHookFolders()
    await vi.advanceTimersByTimeAsync(CODEX_HOOK_FOLDERS_START_DELAY_MS)
    codexHookFoldersSettingsChanged()
    expect(state.prepares).toBe(0)
    expect(state.listeners).toEqual([])
  })

  it('a failing preparation is logged and never throws', async () => {
    const { state, d } = deps({ result: () => Promise.reject(new Error('boom')) })
    startCodexHookFolders(d)
    await vi.advanceTimersByTimeAsync(CODEX_HOOK_FOLDERS_START_DELAY_MS)
    expect(state.logs.some((m) => /boom/.test(m))).toBe(true)
  })
})

describe('a local Codex launch waits for its hook folders, bounded (round 4, P1)', () => {
  it('prepares at once (even before the start delay) and resolves with the result', async () => {
    const { state, d } = deps()
    startCodexHookFolders(d)
    await expect(awaitCodexHookFolders()).resolves.toBe(true)
    expect(state.prepares).toBe(1)
  })

  it('past the bound it resolves false and says the launch starts without hooks', async () => {
    const { state, d } = deps({ result: () => new Promise<boolean>(() => {}) })
    startCodexHookFolders(d)
    const p = awaitCodexHookFolders()
    await vi.advanceTimersByTimeAsync(CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS)
    await expect(p).resolves.toBe(false)
    expect(state.logs.some((m) => /starts without hooks/.test(m))).toBe(true)
    expect(CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS).toBeLessThanOrEqual(10_000)
  })

  it('a refused or failing preparation resolves false', async () => {
    const { d } = deps({ result: () => Promise.resolve(false) })
    startCodexHookFolders(d)
    await expect(awaitCodexHookFolders()).resolves.toBe(false)
    const bad = deps({ result: () => { throw new Error('sync throw') } })
    startCodexHookFolders(bad.d)
    await expect(awaitCodexHookFolders()).resolves.toBe(false)
  })

  // Round 5 (G5): a launch that comes before the preparation is wired (a tab
  // restored at start) waits for the wiring within the same bound.
  it('round 5: a launch before the wiring waits for it within the bound, then for the preparation', async () => {
    const p = awaitCodexHookFolders()
    await vi.advanceTimersByTimeAsync(CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS - 1000)
    const { state, d } = deps()
    startCodexHookFolders(d)
    await expect(p).resolves.toBe(true)
    expect(state.prepares).toBe(1)
  })

  it('round 5: with no wiring within the bound it resolves false', async () => {
    const p = awaitCodexHookFolders()
    await vi.advanceTimersByTimeAsync(CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS)
    await expect(p).resolves.toBe(false)
    // Wired later: nothing more runs for that launch.
    const { state, d } = deps()
    startCodexHookFolders(d)
    expect(state.prepares).toBe(0)
  })
})
