// @vitest-environment jsdom
// rc.15 review R6 + R7 (Codex, 2026-09-06; aicc_planning#53 and adjacent): the
// reviewer's characterizations (evidence/lifecycle-source-callbacks.review.test.ts,
// the macOS discard case and the F9 attached+detached startup case) flipped into
// the desired behaviour, credit Codex rc.15 stability review. Codex executed the
// App.tsx callbacks by AST extraction; the logic now lives in three plain
// helpers the App wires up, tested here directly. Positive controls are labelled.
//
//  R7: boot with attached cards AND left-running remotes used to hydrate the
//      registry only inside the attached-session restore, so while the restore
//      prompt was pending the live registry was empty and a close in that window
//      cleared the whole file -- remotes included. Now: hydrate for both shapes
//      before the prompt is decided, and leave the file untouched while the
//      prompt is unanswered.
//  R6: "Close sessions" on the close dialog discarded the cards and let the
//      window close WITHOUT ending the sessions; on macOS the app stays resident,
//      so the PTYs kept executing with no renderer. Now the sessions are ended
//      (gracefulExit, the Save path's teardown) before the window may go.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DetachedRemote, SessionState } from '../../../src/shared/types'

const save = vi.fn(async () => true)
const clear = vi.fn(async () => true)
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  session: { save, clear, load: vi.fn(), hasSaved: vi.fn() },
}

const { loadSavedStateAtStartup, closeWithNoSessions, discardAndClose } = await import('../../../src/renderer/session-persistence')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')

const remote: DetachedRemote = {
  sessionId: 'ssh-1', configId: 'cfg-9', host: 'pi.local', username: 'mong', remotePath: '~/work',
  mux: 'tmux', label: 'pi', detachedAt: 1_700_000_000_000,
}
const card = { id: 'attached', label: 'work', workingDirectory: 'C:/work', sessionType: 'local', provider: 'claude' } as unknown as SessionState['sessions'][number]
const saved = (over: Partial<SessionState>): SessionState => ({ sessions: [], activeSessionId: null, savedAt: 1, ...over })

beforeEach(() => {
  useDetachedRemotesStore.setState({ entries: [] })
  save.mockClear()
  clear.mockClear()
})

describe('R7: the left-running registry is hydrated for both startup shapes, before the restore prompt (Codex, flipped)', () => {
  it('Codex: attached cards AND remotes -> the prompt is offered AND the registry is already live', async () => {
    const pingHosts = vi.fn()
    const reconcile = vi.fn()
    const state = await loadSavedStateAtStartup({ load: async () => saved({ sessions: [card], detachedRemotes: [remote] }), pingHosts, reconcile })
    expect(state?.sessions).toEqual([card]) // the prompt follows
    expect(useDetachedRemotesStore.getState().entries).toEqual([remote]) // 7ef62a2e: [] until the prompt was answered
    expect(pingHosts).toHaveBeenCalledTimes(1)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('positive control: remotes only -> no prompt, registry live, tool hides reconciled (rc.14 F9 shape, unchanged)', async () => {
    const pingHosts = vi.fn()
    const reconcile = vi.fn()
    const state = await loadSavedStateAtStartup({ load: async () => saved({ detachedRemotes: [remote] }), pingHosts, reconcile })
    expect(state).toBeNull()
    expect(useDetachedRemotesStore.getState().entries).toEqual([remote])
    expect(pingHosts).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('positive control: nothing saved -> null, nothing hydrated, no ping', async () => {
    const pingHosts = vi.fn()
    const reconcile = vi.fn()
    expect(await loadSavedStateAtStartup({ load: async () => null, pingHosts, reconcile })).toBeNull()
    expect(useDetachedRemotesStore.getState().entries).toEqual([])
    expect(pingHosts).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})

describe('R7: the zero-session close while the restore prompt is pending (Codex, flipped)', () => {
  const deps = (restorePromptPending: boolean) => ({
    restorePromptPending, cancelAutosave: vi.fn(), flush: vi.fn(async () => {}), allowClose: vi.fn(),
  })

  it('Codex: prompt pending -> the saved file is left untouched (neither cleared nor rewritten) and the window may close', async () => {
    useDetachedRemotesStore.setState({ entries: [remote] }) // hydrated at boot now
    const d = deps(true)
    expect(await closeWithNoSessions(d)).toBe('left-untouched')
    expect(clear).not.toHaveBeenCalled() // 7ef62a2e: cleared, remotes and cards gone
    expect(save).not.toHaveBeenCalled() // and not rewritten as an empty card set either
    expect(d.cancelAutosave).toHaveBeenCalledTimes(1)
    expect(d.flush).toHaveBeenCalledTimes(1)
    expect(d.allowClose).toHaveBeenCalledTimes(1)
  })

  it('positive control: no prompt, a remote left running -> the registry is kept on its own (rc.14 F9)', async () => {
    useDetachedRemotesStore.setState({ entries: [remote] })
    const d = deps(false)
    expect(await closeWithNoSessions(d)).toBe('saved')
    expect(save).toHaveBeenCalledTimes(1)
    expect(clear).not.toHaveBeenCalled()
    expect(d.allowClose).toHaveBeenCalledTimes(1)
  })

  it('positive control: no prompt, nothing left running -> cleared as before', async () => {
    const d = deps(false)
    expect(await closeWithNoSessions(d)).toBe('cleared')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(d.allowClose).toHaveBeenCalledTimes(1)
  })

  it('a failing flush still lets the window close, and touches nothing', async () => {
    const d = { ...deps(false), flush: vi.fn(async () => { throw new Error('disk') }) }
    expect(await closeWithNoSessions(d)).toBe('left-untouched')
    expect(clear).not.toHaveBeenCalled()
    expect(d.allowClose).toHaveBeenCalledTimes(1)
  })
})

describe('R6: Close sessions ends the sessions before the window may close (Codex, flipped)', () => {
  function deps(over: Partial<Parameters<typeof discardAndClose>[0]> = {}) {
    const order: string[] = []
    const d = {
      isUpdate: false,
      flush: vi.fn(async () => { order.push('flush') }),
      cancelAutosave: vi.fn(() => { order.push('cancelAutosave') }),
      gracefulExit: vi.fn(async () => { order.push('gracefulExit') }),
      installAndRestart: vi.fn(async () => { order.push('installAndRestart') }),
      allowClose: vi.fn(() => { order.push('allowClose') }),
      ...over,
    }
    return { d, order }
  }

  it('Codex: the sessions are gracefully exited, then the window is allowed to close -- in that order', async () => {
    const { d, order } = deps()
    expect(await discardAndClose(d)).toBe(true)
    expect(d.gracefulExit).toHaveBeenCalledTimes(1) // 7ef62a2e: 0 -- the PTYs outlived the window
    expect(order).toEqual(['flush', 'cancelAutosave', 'gracefulExit', 'allowClose'])
    expect(clear).toHaveBeenCalledTimes(1) // the cards are still discarded
  })

  it('the remotes left running are still kept on their own (rc.14 F9), ended nowhere', async () => {
    useDetachedRemotesStore.setState({ entries: [remote] })
    const { d } = deps()
    expect(await discardAndClose(d)).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect((save.mock.calls[0] as unknown[])[0]).toMatchObject({ sessions: [], detachedRemotes: [remote] })
    expect(d.gracefulExit).toHaveBeenCalledTimes(1)
  })

  it('a teardown error never strands the close: the window is still allowed to go', async () => {
    const { d, order } = deps({ gracefulExit: vi.fn(async () => { throw new Error('pty gone') }) })
    expect(await discardAndClose(d)).toBe(true)
    expect(order).toEqual(['flush', 'cancelAutosave', 'allowClose'])
  })

  it('positive control: the update path installs and restarts instead (the restart tears everything down)', async () => {
    const { d, order } = deps({ isUpdate: true })
    expect(await discardAndClose(d)).toBe(true)
    expect(order).toEqual(['flush', 'cancelAutosave', 'installAndRestart'])
    expect(d.gracefulExit).not.toHaveBeenCalled()
    expect(d.allowClose).not.toHaveBeenCalled()
  })

  it('a failure before the sessions are touched still allows the close and reports it', async () => {
    clear.mockImplementationOnce(async () => { throw new Error('refused') })
    const { d } = deps()
    expect(await discardAndClose(d)).toBe(false)
    expect(d.gracefulExit).not.toHaveBeenCalled()
    expect(d.allowClose).toHaveBeenCalledTimes(1)
  })
})
