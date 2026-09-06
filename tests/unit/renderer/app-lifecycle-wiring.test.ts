// rc.15 review R6 + R7 (P2-P5 review, MAJOR-1): the lifecycle behaviour lives in
// plain helpers (session-persistence.ts, window-close-coordinator.ts) that are
// tested directly; this file tests that App.tsx and main/index.ts WIRE them --
// each callback is cut out of the source, type-stripped with esbuild (what
// vitest itself compiles with) and run against fake globals, the technique
// Codex's own lifecycle evidence used (credit: Codex rc.15 stability review).
// A later edit that drops a dep from the wiring, or passes a stale value, goes
// red here.
//
// Plan 3.2's prompt-exit permutations are covered as App wires them: Resume,
// Don't open, and Close sessions on the close dialog.
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const APP = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
const INDEX = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

/** The text from `from` (inclusive) to the brace that closes the block opened
 *  by the first `{` at or after `from`. Strings, template literals and line
 *  comments are skipped, which is all these handlers contain. */
function block(src: string, from: number): { text: string; end: number } {
  let i = src.indexOf('{', from)
  expect(i, 'an opening brace').toBeGreaterThan(-1)
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return { text: src.slice(from, i + 1), end: i + 1 } }
  }
  throw new Error('unbalanced braces')
}
/** Compile a TS/TSX expression cut from the source and evaluate it against fake globals. */
function run<T = unknown>(code: string, globals: Record<string, unknown>): T {
  const js = transformSync(`(${code})`, { loader: 'ts', target: 'es2022', format: 'esm' }).code
  return vm.runInContext(js, vm.createContext({ console, ...globals })) as T
}
/** `const <name> = <arrow>`: the arrow expression text. */
function namedArrow(src: string, name: string): string {
  const marker = `const ${name} = `
  const start = src.indexOf(marker)
  expect(start, marker).toBeGreaterThan(-1)
  return block(src, start + marker.length).text
}
/** `<attr>={<arrow>}` in JSX: the arrow expression text. */
function jsxHandler(src: string, attr: string): string {
  const marker = `${attr}={`
  const start = src.indexOf(marker)
  expect(start, marker).toBeGreaterThan(-1)
  expect(src.indexOf(marker, start + 1), `${marker} unique`).toBe(-1)
  return block(src, start + marker.length).text
}
const flush = async () => { await new Promise((r) => setImmediate(r)) }

describe('App.tsx wires the R6/R7 helpers', () => {
  it('Close sessions (handleCloseWithoutSaving) delegates to discardAndClose with gracefulExit, installAndRestart and allowClose wired to the preload API, and un-closes on failure', async () => {
    const discardAndClose = vi.fn(async () => false)
    const api = {
      session: { gracefulExit: vi.fn(async () => true) },
      update: { installAndRestart: vi.fn(async () => true) },
      window: { allowClose: vi.fn() },
    }
    const setIsClosing = vi.fn()
    const handler = run<() => Promise<void>>(namedArrow(APP, 'handleCloseWithoutSaving'), {
      closeDialog: 'close', setCloseDialog: vi.fn(), setIsClosing, setIsUpdating: vi.fn(),
      discardAndClose, flushPendingConfigSaves: vi.fn(async () => {}), cancelSessionAutosave: vi.fn(),
      window: { electronAPI: api },
    })
    await handler()
    expect(discardAndClose).toHaveBeenCalledTimes(1)
    const deps = discardAndClose.mock.calls[0][0] as Record<string, () => unknown>
    expect(deps.isUpdate).toBe(false)
    await deps.gracefulExit()
    expect(api.session.gracefulExit).toHaveBeenCalledTimes(1)
    await deps.installAndRestart()
    expect(api.update.installAndRestart).toHaveBeenCalledTimes(1)
    deps.allowClose()
    expect(api.window.allowClose).toHaveBeenCalledTimes(1)
    expect(setIsClosing).toHaveBeenLastCalledWith(false) // the helper returned false: closing state released
  })

  it('the update dialog reaches discardAndClose with isUpdate true', async () => {
    const discardAndClose = vi.fn(async () => true)
    const setIsUpdating = vi.fn()
    const handler = run<() => Promise<void>>(namedArrow(APP, 'handleCloseWithoutSaving'), {
      closeDialog: 'update', setCloseDialog: vi.fn(), setIsClosing: vi.fn(), setIsUpdating,
      discardAndClose, flushPendingConfigSaves: vi.fn(async () => {}), cancelSessionAutosave: vi.fn(),
      window: { electronAPI: { session: {}, update: {}, window: {} } },
    })
    await handler()
    expect(setIsUpdating).toHaveBeenCalledWith(true)
    expect((discardAndClose.mock.calls[0][0] as { isUpdate: boolean }).isUpdate).toBe(true)
  })

  it('startup loads through loadSavedStateAtStartup (load wired to session.load) and offers the prompt only when it returns cards', async () => {
    // The try/catch around the load: the `try` block and the `catch` block that follows it.
    const marker = "      try {\n        // rc.15 review R7 (aicc_planning#53)"
    const start = APP.indexOf(marker)
    expect(start, 'the R7 startup try block').toBeGreaterThan(-1)
    expect(APP.indexOf(marker, start + 1)).toBe(-1)
    const tryBlock = block(APP, start)
    const catchBlock = block(APP, APP.indexOf('catch', tryBlock.end))
    const stmt = `${tryBlock.text} ${catchBlock.text}`
    expect(stmt).toContain('loadSavedStateAtStartup(')
    expect(stmt).toContain('[App] Failed to load saved sessions:')
    const go = async (returned: unknown) => {
      const load = vi.fn(async () => returned)
      const loadSavedStateAtStartup = vi.fn(async (deps: { load: () => Promise<unknown> }) => { await deps.load(); return returned })
      const setPendingRestore = vi.fn()
      const pingAllDetachedHosts = vi.fn()
      const reconcile = vi.fn()
      const fn = run<() => Promise<void>>(`async () => { ${stmt} }`, {
        loadSavedStateAtStartup, setPendingRestore, pingAllDetachedHosts,
        useCommandBarStore: { getState: () => ({ reconcile }) }, useSessionStore: { getState: () => ({ sessions: [] }) },
        window: { electronAPI: { session: { load } } },
      })
      await fn()
      return { load, loadSavedStateAtStartup, setPendingRestore, pingAllDetachedHosts, reconcile }
    }
    const saved = { sessions: [{ id: 'a' }], activeSessionId: 'a', savedAt: 1 }
    const withCards = await go(saved)
    expect(withCards.loadSavedStateAtStartup).toHaveBeenCalledTimes(1)
    expect(withCards.load).toHaveBeenCalledTimes(1)
    expect(withCards.setPendingRestore).toHaveBeenCalledWith(saved)
    const deps = withCards.loadSavedStateAtStartup.mock.calls[0][0] as { pingHosts: () => void; reconcile: () => void }
    deps.pingHosts(); expect(withCards.pingAllDetachedHosts).toHaveBeenCalledTimes(1)
    deps.reconcile(); expect(withCards.reconcile).toHaveBeenCalledWith([])
    const without = await go(null)
    expect(without.setPendingRestore).not.toHaveBeenCalled()
  })

  it('the zero-session close passes whether the restore prompt is pending, and a non-empty session set still opens the dialog', () => {
    const go = (sessions: unknown[], pendingRestore: unknown, restoreUnsettled = false) => {
      const closeWithNoSessions = vi.fn(async () => 'left-untouched')
      const setCloseDialog = vi.fn()
      const allowClose = vi.fn()
      const cancelSessionAutosave = vi.fn()
      const flushPendingConfigSaves = vi.fn(async () => {})
      const handler = run<() => void>(namedArrow(APP, 'handleCloseRequested'), {
        isClosing: false, pendingRestore, restoreUnsettledRef: { current: restoreUnsettled }, useSessionStore: { getState: () => ({ sessions }) },
        closeWithNoSessions, cancelSessionAutosave, flushPendingConfigSaves, setCloseDialog,
        window: { electronAPI: { window: { allowClose } } },
      })
      handler()
      return { closeWithNoSessions, setCloseDialog, allowClose, cancelSessionAutosave, flushPendingConfigSaves }
    }
    const pending = go([], { sessions: [{ id: 'a' }] })
    expect(pending.closeWithNoSessions).toHaveBeenCalledTimes(1)
    const deps = pending.closeWithNoSessions.mock.calls[0][0] as { restorePromptPending: boolean; allowClose: () => void; cancelAutosave: () => void; flush: () => Promise<void> }
    expect(deps.restorePromptPending).toBe(true)
    deps.allowClose(); expect(pending.allowClose).toHaveBeenCalledTimes(1)
    deps.cancelAutosave(); expect(pending.cancelSessionAutosave).toHaveBeenCalledTimes(1)
    void deps.flush(); expect(pending.flushPendingConfigSaves).toHaveBeenCalledTimes(1)
    expect(pending.setCloseDialog).not.toHaveBeenCalled()
    const noPrompt = go([], null)
    expect((noPrompt.closeWithNoSessions.mock.calls[0][0] as { restorePromptPending: boolean }).restorePromptPending).toBe(false)
    // ADR-009 R7: a restore chosen but not yet landed (prompt already cleared)
    // still protects the saved file from the zero-session clear.
    const unsettled = go([], null, true)
    expect((unsettled.closeWithNoSessions.mock.calls[0][0] as { restorePromptPending: boolean }).restorePromptPending).toBe(true)
    const withSessions = go([{ id: 'a' }], null)
    expect(withSessions.closeWithNoSessions).not.toHaveBeenCalled()
    expect(withSessions.setCloseDialog).toHaveBeenCalledWith('close')
  })

  it('the close-requested subscription re-subscribes when the prompt state changes (its effect depends on pendingRestore)', () => {
    const at = APP.indexOf('const handleCloseRequested = ')
    const depsList = APP.slice(APP.indexOf('}, [', at), APP.indexOf(']', APP.indexOf('}, [', at)) + 1)
    expect(depsList).toContain('pendingRestore')
    expect(depsList).toContain('isClosing')
  })

  it("Don't open keeps the remotes (hydrate, ping, persist) after cancelling the autosave, and clears the prompt", () => {
    const order: string[] = []
    const saved = { sessions: [{ id: 'a' }], activeSessionId: 'a', savedAt: 1, detachedRemotes: [{ sessionId: 'r' }] }
    const handler = run<() => void>(jsxHandler(APP, 'onDontOpen'), {
      pendingRestore: saved, setPendingRestore: (v: unknown) => { order.push(`setPendingRestore:${v}`) },
      useCommandBarStore: { getState: () => ({ reconcile: () => { order.push('reconcile') } }) },
      useSessionStore: { getState: () => ({ sessions: [] }) },
      cancelSessionAutosave: () => { order.push('cancelAutosave') },
      hydrateDetachedFromSavedState: (s: unknown) => { order.push(`hydrate:${s === saved}`); return 1 },
      pingAllDetachedHosts: () => { order.push('ping') },
      persistDetachedOnlyOrClear: async () => { order.push('persist'); return 'saved' },
    })
    handler()
    expect(order).toEqual(['setPendingRestore:null', 'reconcile', 'cancelAutosave', 'hydrate:true', 'ping', 'persist'])
  })

  it('Resume hands the saved state to restoreSavedSessions and clears the prompt first', () => {
    const order: string[] = []
    const saved = { sessions: [{ id: 'a' }], activeSessionId: 'a', savedAt: 1 }
    const restoreUnsettledRef = { current: false }
    const handler = run<() => void>(jsxHandler(APP, 'onResume'), {
      pendingRestore: saved, setPendingRestore: (v: unknown) => { order.push(`setPendingRestore:${v}`) },
      restoreSavedSessions: async (s: unknown) => { order.push(`restore:${s === saved}`) },
      restoreUnsettledRef,
    })
    handler()
    expect(order).toEqual(['setPendingRestore:null', 'restore:true'])
    // ADR-009 R7: the restore is marked in flight BEFORE the prompt clears, so a
    // close before it lands keeps the saved file.
    expect(restoreUnsettledRef.current).toBe(true)
  })
})

describe('main/index.ts wires window-all-closed', () => {
  it('delegates to onAllWindowsClosed with the platform, app.quit and killAllPty', async () => {
    const marker = "app.on('window-all-closed', "
    const start = INDEX.indexOf(marker)
    expect(start, marker).toBeGreaterThan(-1)
    expect(INDEX.indexOf(marker, start + 1)).toBe(-1)
    const cb = block(INDEX, start + marker.length).text
    const onAllWindowsClosed = vi.fn()
    const killAllPty = vi.fn()
    const quit = vi.fn()
    const fn = run<() => void>(cb, { onAllWindowsClosed, killAllPty, process: { platform: 'darwin' }, app: { quit } })
    fn()
    expect(onAllWindowsClosed).toHaveBeenCalledTimes(1)
    const deps = onAllWindowsClosed.mock.calls[0][0] as { platform: string; quit: () => void; endStragglerPtys: () => void }
    expect(deps.platform).toBe('darwin')
    expect(deps.endStragglerPtys).toBe(killAllPty)
    deps.quit(); expect(quit).toHaveBeenCalledTimes(1)
    await flush()
  })
})
