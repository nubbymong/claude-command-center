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
import { configsToEnableMultiSpawn } from '../../../src/renderer/utils/multiSpawn'

// ADR-009 round 2 (Lens C2): normalise CRLF -> LF. This file matches multi-line
// source markers written with `\n`; on a Windows checkout with core.autocrlf the
// working tree is CRLF (there is no `*.tsx text eol=lf` in .gitattributes), so an
// un-normalised read makes every marker miss. CI (Linux, LF) never saw it.
const readSrc = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')
const APP = readSrc('src/renderer/App.tsx')
const INDEX = readSrc('src/main/index.ts')

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
    // ADR-009 round 3 (Codex finding 4): the ref that protects the saved file
    // starts TRUE (startup is unsettled) and is cleared only once the load
    // POSITIVELY resolves -- never in the catch.
    expect(APP, 'restoreUnsettledRef initialised true').toContain('const restoreUnsettledRef = useRef(true)')
    const go = async (returned: unknown, throws = false) => {
      const load = vi.fn(async () => { if (throws) throw new Error('synthetic load failure'); return returned })
      const loadSavedStateAtStartup = vi.fn(async (deps: { load: () => Promise<unknown> }) => { const r = await deps.load(); return r })
      const setPendingRestore = vi.fn()
      const setRestoreTally = vi.fn()
      const pingAllDetachedHosts = vi.fn()
      const reconcile = vi.fn()
      const restoreUnsettledRef = { current: true } // as the component initialises it
      const fn = run<() => Promise<void>>(`async () => { ${stmt} }`, {
        loadSavedStateAtStartup, setPendingRestore, setRestoreTally, pingAllDetachedHosts, restoreUnsettledRef, console,
        useCommandBarStore: { getState: () => ({ reconcile }) }, useSessionStore: { getState: () => ({ sessions: [] }) },
        useDetachedRemotesStore: { getState: () => ({ entries: REGISTRY }) },
        window: { electronAPI: { session: { load } } },
      })
      await fn()
      return { load, loadSavedStateAtStartup, setPendingRestore, setRestoreTally, pingAllDetachedHosts, reconcile, restoreUnsettledRef }
    }
    const REGISTRY = [{ sessionId: 'left-1' }]
    const saved = { sessions: [{ id: 'a' }], activeSessionId: 'a', savedAt: 1 }
    const withCards = await go(saved)
    expect(withCards.loadSavedStateAtStartup).toHaveBeenCalledTimes(1)
    expect(withCards.load).toHaveBeenCalledTimes(1)
    expect(withCards.setPendingRestore).toHaveBeenCalledWith(saved)
    expect(withCards.restoreUnsettledRef.current, 'cleared once the load resolved with cards').toBe(false)
    const deps = withCards.loadSavedStateAtStartup.mock.calls[0][0] as { pingHosts: () => void; reconcile: () => void }
    deps.pingHosts(); expect(withCards.pingAllDetachedHosts).toHaveBeenCalledTimes(1)
    deps.reconcile(); expect(withCards.reconcile).toHaveBeenCalledWith([])
    // Walk fix N5: the restore-time tally is taken where the restore is
    // decided. With cards, that is the prompt's answer (below); with none,
    // here: nothing restored, and the registry just hydrated.
    expect(withCards.setRestoreTally).not.toHaveBeenCalled()
    const without = await go(null)
    expect(without.setPendingRestore).not.toHaveBeenCalled()
    expect(without.setRestoreTally).toHaveBeenCalledWith({ sessions: [], detached: REGISTRY })
    expect(without.restoreUnsettledRef.current, 'cleared once the load resolved with no cards').toBe(false)
    // The load FAILED: the ref stays true so a zero-session close leaves the file.
    const failed = await go(null, true)
    expect(failed.restoreUnsettledRef.current, 'left set when the startup load threw').toBe(true)
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
      // Walk fix N5: nothing reopens; the tally is the remotes just kept.
      setRestoreTally: (t: { sessions: unknown[]; detached: unknown[] }) => { order.push(`tally:${t.sessions.length}:${t.detached.length}`) },
      useDetachedRemotesStore: { getState: () => ({ entries: [{ sessionId: 'r' }] }) },
      useCommandBarStore: { getState: () => ({ reconcile: () => { order.push('reconcile') } }) },
      useSessionStore: { getState: () => ({ sessions: [] }) },
      cancelSessionAutosave: () => { order.push('cancelAutosave') },
      hydrateDetachedFromSavedState: (s: unknown) => { order.push(`hydrate:${s === saved}`); return 1 },
      pingAllDetachedHosts: () => { order.push('ping') },
      persistDetachedOnlyOrClear: async () => { order.push('persist'); return 'saved' },
    })
    handler()
    expect(order).toEqual(['setPendingRestore:null', 'reconcile', 'cancelAutosave', 'hydrate:true', 'ping', 'tally:0:1', 'persist'])
  })

  it('Resume hands the WHOLE saved set to restoreSavedSessions (none dropped), and clears the prompt first', () => {
    const order: string[] = []
    // Walk fix W1: a session whose provider cannot launch is restored too (it
    // reopens as Not started and keeps its conversation); nothing is dropped.
    const saved = { sessions: [{ id: 'a' }, { id: 'x', provider: 'codex' }], activeSessionId: 'a', savedAt: 1 }
    const restoreUnsettledRef = { current: false }
    // 2.1.1 (ADR-021): App injects the two liveness helpers -- session-persistence
    // must not import the stores that import it back -- so the call site hands
    // them over as deps. This pins the WIRING (both named bindings reach the
    // call, unrenamed); that they are the stores' exports is App's import list.
    const probeGoneSessions = async () => []
    const pingAllDetachedHosts = () => {}
    let tally: unknown
    const handler = run<() => void>(jsxHandler(APP, 'onResume'), {
      pendingRestore: saved, setPendingRestore: (v: unknown) => { order.push(`setPendingRestore:${v}`) },
      setRestoreTally: (t: unknown) => { tally = t; order.push('tally') },
      restoreSavedSessions: async (s: unknown, _ref: unknown, deps: { probeGoneSessions: unknown; pingAllDetachedHosts: unknown }) => {
        order.push(`restore:${s === saved}`)
        order.push(`deps:${deps.probeGoneSessions === probeGoneSessions && deps.pingAllDetachedHosts === pingAllDetachedHosts}`)
      },
      restoreUnsettledRef,
      probeGoneSessions,
      pingAllDetachedHosts,
    })
    handler()
    expect(order).toEqual(['tally', 'setPendingRestore:null', 'restore:true', 'deps:true'])
    // Walk fix N5: tallied from the saved set itself, every session in it
    // (one that will reopen Not started included), before the restore lands.
    expect(tally).toEqual({ sessions: saved.sessions, detached: [] })
    // ADR-009 R7: the restore is marked in flight BEFORE the prompt clears, so a
    // close before it lands keeps the saved file.
    expect(restoreUnsettledRef.current).toBe(true)
  })

  it('the resume gate is boot-only: raised by the saved set whatever its providers, set only by the startup load, never brought back once answered', async () => {
    // Walk fix W1/W2. (a) The gate reads the saved set alone, never the launch
    // settings: a set whose every session's provider is off raises it at boot,
    // so nothing is left pending to surface mid-session when that provider is
    // turned on; once answered (null) nothing raises it.
    const m = /\n {4}resumePending: ([^\n]+),\n/.exec(APP)
    expect(m, 'the resumePending entry').not.toBeNull()
    const codexOnly = { sessions: [{ id: 'x', provider: 'codex' }], activeSessionId: 'x', savedAt: 1 }
    expect(run<boolean>(m![1], { pendingRestore: codexOnly })).toBe(true)
    expect(run<boolean>(m![1], { pendingRestore: null })).toBe(false)
    // (b) The one thing that sets a saved set is the startup load, which runs
    // once (hasRestoredRef); everything else clears it or is the Refresh below.
    const setters = APP.match(/setPendingRestore\((?!null\))[^\n]*/g) ?? []
    expect(setters).toEqual(['setPendingRestore(savedState)', 'setPendingRestore((prev) => refreshRestoreOffer(prev, saved, open))'])
    expect(block(APP, APP.indexOf('async function postConfigInit()')).text).toContain('if (savedState) setPendingRestore(savedState)')
    expect(APP).toContain('if (!configLoaded || hasRestoredRef.current) return\n    hasRestoredRef.current = true\n\n    async function postConfigInit()')
    // (c) A Refresh read that lands after the prompt was answered leaves it
    // answered; while it is still up the fresh list replaces it, and a
    // transient empty read keeps the current one. P3.5 (the C item "Resume
    // replaces the tab list"): a tab open now -- launched while the prompt
    // was up, and autosaved into the file -- is never offered again. The
    // helper is cut out of session-persistence.ts and run like the handler.
    const SP = readSrc('src/renderer/session-persistence.ts')
    const offerAt = SP.indexOf('export function refreshRestoreOffer(')
    expect(offerAt, 'refreshRestoreOffer').toBeGreaterThan(-1)
    const refreshRestoreOffer = run<(...a: unknown[]) => unknown>(block(SP, offerAt).text.replace(/^export /, ''), {})
    const fresh = { sessions: [{ id: 'b' }], activeSessionId: 'b', savedAt: 2 }
    const refreshWith = async (loaded: unknown, openIds: string[] = []) => {
      let updater: ((prev: unknown) => unknown) | undefined
      const refresh = run<() => Promise<void>>(jsxHandler(APP, 'onRefresh'), {
        setPendingRestore: (u: (prev: unknown) => unknown) => { updater = u },
        window: { electronAPI: { session: { load: async () => loaded } } },
        useSessionStore: { getState: () => ({ sessions: openIds.map((id) => ({ id })) }) },
        refreshRestoreOffer,
        Set,
      })
      await refresh()
      return updater!
    }
    const update = await refreshWith(fresh)
    expect(update(null), 'answered: stays answered').toBeNull()
    expect(update(codexOnly), 'still up: the fresh list').toEqual(fresh)
    expect((await refreshWith({ sessions: [] }))(codexOnly), 'an empty read keeps the list').toBe(codexOnly)
    expect((await refreshWith(fresh, ['b']))(codexOnly), 'a tab open now is not offered again').toBe(codexOnly)
    const mixed = { sessions: [{ id: 'b' }, { id: 'c' }], activeSessionId: 'b', savedAt: 3 }
    expect((await refreshWith(mixed, ['b']))(codexOnly), 'only the saved tabs not open').toEqual({ ...mixed, sessions: [{ id: 'c' }] })
  })
})

describe('the Allow Multi Spawn grandfathering counts the restore-time tally, never live launches (walk fix N5)', () => {
  // The migration effect as App wires it, cut out and run. Its globals cover
  // both the fixed wiring and the earlier live-count one, so a revert runs
  // (and fails on what it decides) rather than failing to run.
  const marker = 'const ids = configsToEnableMultiSpawn('
  const at = APP.lastIndexOf('useEffect(', APP.indexOf(marker))
  const effect = block(APP, at + 'useEffect('.length).text
  const cfg = { id: 'cfg-a', sessionType: 'local' }
  const decide = (restoreTally: unknown, live: Array<{ id: string; configId: string; neverStarted?: boolean }>, restoredIds: string[]) => {
    const updateConfig = vi.fn()
    run<() => void>(effect, {
      configLoaded: true, restoreTally, configs: [cfg], sessions: live, restoredIds, detachedRemoteEntries: [],
      configsToEnableMultiSpawn,
      copiesAsRestored: (s: Array<{ id: string; neverStarted?: boolean }>, ids: string[]) => s.map((x) => (x.neverStarted && ids.includes(x.id) ? { ...x, neverStarted: undefined } : x)),
      useConfigStore: { getState: () => ({ updateConfig }) },
      setMultiSpawnAutoEnabled: () => {},
    })()
    return updateConfig.mock.calls.map((c) => c[0])
  }
  const X = { id: 'x', configId: 'cfg-a' }
  const Y = { id: 'y', configId: 'cfg-a' }

  it("one restored copy that is Not started, then a fresh launch once its provider is on: NOT grandfathered (the reviewer's X+Y)", () => {
    expect(decide({ sessions: [X], detached: [] }, [{ ...X, neverStarted: true }, Y], ['x'])).toEqual([])
  })

  it('a legacy config restored with two copies while its provider is off: grandfathered', () => {
    const X2 = { id: 'x2', configId: 'cfg-a' }
    expect(decide({ sessions: [X, X2], detached: [] }, [{ ...X, neverStarted: true }, { ...X2, neverStarted: true }], ['x', 'x2'])).toEqual(['cfg-a'])
  })

  it('restored with two launchable copies: grandfathered, as before', () => {
    const X2 = { id: 'x2', configId: 'cfg-a' }
    expect(decide({ sessions: [X, X2], detached: [] }, [X, X2], ['x', 'x2'])).toEqual(['cfg-a'])
  })

  it('before the restore is decided (no tally yet), nothing is decided', () => {
    expect(decide(null, [X, Y], [])).toEqual([])
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
