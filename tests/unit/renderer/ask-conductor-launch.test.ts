// @vitest-environment jsdom
/**
 * The Ask Conductor launcher.
 *
 * Four properties are load-bearing and each has a real failure behind it:
 *
 *  1. NO SAVED CONFIG. The path this replaced created and persisted a config
 *     called "Ask Conductor" into the user's Saved Configs. Nothing here may
 *     touch the config store.
 *  2. NO RESUME PICKER. Both resume-picker branches of buildClaudeLaunchCommand
 *     return BEFORE the positional prompt is appended, so a launch routed
 *     through the picker drops the question silently, with every existing test
 *     still green.
 *  3. ONE SESSION. The dock pill is a single affordance, not a session factory.
 *  4. `help:workspace` FAILS CLOSED to null. The old code returned silently
 *     there, so the button did nothing at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const markSessionForResumePicker = vi.fn()
const addConfig = vi.fn()

// Neither module is imported by the launcher. The spies stay untouched unless
// somebody wires one back in -- which is exactly the regression being fenced.
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ markSessionForResumePicker }))
vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: Object.assign(() => ({}), { getState: () => ({ addConfig, configs: [] }) }),
}))

import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import {
  launchAskConductor,
  normaliseQuestion,
  findAskSession,
  askSessionIsLive,
  useAskErrorStore,
  ASK_LABEL,
  _resetAskLaunchForTest,
} from '../../../src/renderer/lib/askConductor'

const ptyWrite = vi.fn()
function setApi(workspace: string | null | (() => Promise<never>)) {
  ;(globalThis as any).window.electronAPI = {
    help: {
      workspace: typeof workspace === 'function'
        ? workspace
        : () => Promise.resolve(workspace),
    },
    pty: { write: ptyWrite },
  }
}

describe('launchAskConductor', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
    useAskErrorStore.setState({ error: null })
    markSessionForResumePicker.mockClear()
    addConfig.mockClear()
    ptyWrite.mockClear()
    _resetAskLaunchForTest()
    setApi('C:/res/help')
  })

  it('creates a session with kind "ask", no configId, and the question on askPrompt', async () => {
    const id = await launchAskConductor('  How do I run two accounts   at once? ')
    expect(id).toBeTruthy()
    const sessions = useSessionStore.getState().sessions
    expect(sessions).toHaveLength(1)
    const s = sessions[0]
    expect(s.kind).toBe('ask')
    expect(s.configId).toBeUndefined()
    expect(s.label).toBe(ASK_LABEL)
    expect(s.workingDirectory).toBe('C:/res/help')
    expect(s.askPrompt).toBe('How do I run two accounts at once?')
    // CCC_ASK_PROMPT is only set on the local Claude spawn path.
    expect(s.sessionType).toBe('local')
    expect(s.provider).toBe('claude')
    expect(s.shellOnly).toBeFalsy()
    expect(useSessionStore.getState().activeSessionId).toBe(id)
  })

  it('never creates a saved config (property 1)', async () => {
    await launchAskConductor('anything')
    expect(addConfig).not.toHaveBeenCalled()
  })

  it('never marks the session for the resume picker (property 2)', async () => {
    await launchAskConductor('anything')
    expect(markSessionForResumePicker).not.toHaveBeenCalled()
  })

  it('leaves askPrompt unset for a blank or whitespace-only question', async () => {
    await launchAskConductor('   \n  ')
    expect(useSessionStore.getState().sessions[0].askPrompt).toBeUndefined()
    // An empty string would become a blank positional argument, which is not
    // the same launch as no argument at all.
    expect('askPrompt' in useSessionStore.getState().sessions[0]).toBe(true)
    expect(useSessionStore.getState().sessions[0].askPrompt).not.toBe('')
  })

  it('focuses the open Ask session instead of starting a second one (property 3)', async () => {
    const first = await launchAskConductor('first question')
    useSessionStore.getState().setActiveSession('someone-else')
    const second = await launchAskConductor('second question')
    expect(second).toBe(first)
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().activeSessionId).toBe(first)
    // The env route is spawn-time only, so a running session is handed the
    // question the way a command button hands one over.
    expect(ptyWrite).toHaveBeenCalledWith(first, 'second question\r')
  })

  it('does not write to the PTY when refocusing with no question', async () => {
    const first = await launchAskConductor()
    await launchAskConductor()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(first).toBeTruthy()
  })

  it('revives an Ask session whose process has exited, instead of writing into the void', async () => {
    const first = await launchAskConductor()
    const createdAt = useSessionStore.getState().sessions[0].createdAt
    useSessionStore.getState().updateSession(first, { ptyExited: true })
    ptyWrite.mockClear()

    const second = await launchAskConductor('my question')

    // Same tab, not a second one.
    expect(second).toBe(first)
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    // THE BUG: this used to fire at a dead PTY. main buffers the bytes into a
    // pendingWrites map that only a spawn drains -- and a spawn clears it first
    // -- so the question was destroyed while the input box was emptied as
    // though it had been sent.
    expect(ptyWrite).not.toHaveBeenCalled()

    const s = useSessionStore.getState().sessions[0]
    // The question rides the respawn as CCC_ASK_PROMPT, the same route a first
    // launch uses, and the bumped createdAt is what remounts the pane.
    expect(s.askPrompt).toBe('my question')
    expect(s.ptyExited).toBeUndefined()
    expect(s.createdAt).toBeGreaterThanOrEqual(createdAt)
    expect(useSessionStore.getState().activeSessionId).toBe(first)
  })

  it('revives a dead Ask session even with no question, and does not duplicate it', async () => {
    const first = await launchAskConductor()
    useSessionStore.getState().updateSession(first, { ptyExited: true })
    ptyWrite.mockClear()

    const second = await launchAskConductor()

    expect(second).toBe(first)
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].ptyExited).toBeUndefined()
  })

  it('surfaces a failure to stage the help workspace instead of doing nothing (property 4)', async () => {
    setApi(null)
    const id = await launchAskConductor('q')
    expect(id).toBe('')
    expect(useSessionStore.getState().sessions).toHaveLength(0)
    expect(useAskErrorStore.getState().error).toMatch(/resources directory/i)
  })

  it('treats a throwing help:workspace the same as a null one', async () => {
    setApi(() => Promise.reject(new Error('EACCES')))
    const id = await launchAskConductor('q')
    expect(id).toBe('')
    expect(useAskErrorStore.getState().error).toBeTruthy()
  })

  it('clears a previous error once the workspace stages again', async () => {
    setApi(null)
    await launchAskConductor('q')
    expect(useAskErrorStore.getState().error).toBeTruthy()
    setApi('C:/res/help')
    await launchAskConductor('q')
    expect(useAskErrorStore.getState().error).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // ONE session, even when two clicks land inside one help.workspace() call.
  //
  // The reuse guard reads the session list BEFORE `await help.workspace()`, and
  // that IPC does an mkdir plus two file writes in main -- comfortably wider than
  // a double-click. Both clicks saw "no ask session" and both called addSession.
  // Two ask sessions is not a cosmetic duplicate: Sidebar filters kind !== 'ask'
  // out of the session list and AskConductorDock binds to the FIRST one, so the
  // second is unreachable from either surface, while buildSessionState still
  // persists it and it comes back on every launch.
  // ---------------------------------------------------------------------------

  it('makes ONE session when two launches race inside help.workspace()', async () => {
    let release: (d: string) => void = () => {}
    setApi(() => new Promise<never>((res) => { release = res as unknown as (d: string) => void }) as never)

    const a = launchAskConductor('first question')
    const b = launchAskConductor('second question')
    release('C:/res/help')
    const [idA, idB] = await Promise.all([a, b])

    const ask = useSessionStore.getState().sessions.filter((x) => x.kind === 'ask')
    expect(ask).toHaveLength(1)
    // Both callers get the SAME session, so neither is left holding a dead id.
    expect(idA).toBeTruthy()
    expect(idB).toBe(idA)
  })

  it('still delivers the second question to the one session', async () => {
    let release: (d: string) => void = () => {}
    setApi(() => new Promise<never>((res) => { release = res as unknown as (d: string) => void }) as never)

    const a = launchAskConductor('first question')
    const b = launchAskConductor('second question')
    release('C:/res/help')
    const [id] = await Promise.all([a, b])

    // The first question rides the spawn env (askPrompt); the second cannot,
    // because the spawn already happened -- so it goes over the PTY, exactly as
    // it would for a click that arrived a second later.
    expect(useSessionStore.getState().sessions[0].askPrompt).toBe('first question')
    expect(ptyWrite).toHaveBeenCalledWith(id, 'second question' + '\r')
  })

  it('yields to an ask session added by anything else during the await', async () => {
    // The latch only covers re-entry through this function. The session store is
    // a live singleton, so a restore or another code path can add an ask session
    // while help.workspace() is still doing its mkdir. Without the post-await
    // re-read this launch would add a second one on top of it.
    let release: (d: string) => void = () => {}
    setApi(() => new Promise<never>((res) => { release = res as unknown as (d: string) => void }) as never)

    const p = launchAskConductor('mine')
    useSessionStore.setState({
      sessions: [{
        id: 'other-ask-session', kind: 'ask', label: ASK_LABEL, workingDirectory: 'C:/res/help',
        model: '', status: 'idle', createdAt: Date.now(), sessionType: 'local', provider: 'claude',
      } as never],
    })
    release('C:/res/help')
    const id = await p

    expect(useSessionStore.getState().sessions.filter((x) => x.kind === 'ask')).toHaveLength(1)
    expect(id).toBe('other-ask-session')
    expect(ptyWrite).toHaveBeenCalledWith('other-ask-session', 'mine' + '\r')
  })

  it('does not latch a failure: a later click can still launch', async () => {
    setApi(null)
    expect(await launchAskConductor('q')).toBe('')
    expect(useSessionStore.getState().sessions).toHaveLength(0)

    // The in-flight latch must clear on the failure path too, or the button is
    // dead for the rest of the app's life after one bad staging.
    setApi('C:/res/help')
    const id = await launchAskConductor('q2')
    expect(id).toBeTruthy()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
  })
})

describe('normaliseQuestion', () => {
  it('collapses newlines so a multi-line tip body is one submission', () => {
    expect(normaliseQuestion('line one\nline two\n\nline three')).toBe('line one line two line three')
  })

  it('returns undefined for nothing, blank and whitespace', () => {
    expect(normaliseQuestion(undefined)).toBeUndefined()
    expect(normaliseQuestion('')).toBeUndefined()
    expect(normaliseQuestion('  \t\n ')).toBeUndefined()
  })

  it('caps at the pty:spawn schema bound rather than letting main reject the spawn', () => {
    const out = normaliseQuestion('a'.repeat(9000))
    expect(out).toHaveLength(8000)
  })

  it('leaves shell metacharacters alone -- the env reference is the boundary, not a charset', () => {
    const q = `what's the $(rm -rf /) cost; really \`x\` & 100%?`
    expect(normaliseQuestion(q)).toBe(q)
  })

  it('strips control characters, which on the refocus path are KEYSTROKES', () => {
    // The refocus branch writes the question into a LIVE Claude TUI and appends
    // \r to submit it, so ESC is an interrupt, CSI Z is the mode chord, \x03 is
    // Ctrl+C and \x1b[201~ ends a bracketed paste. `\s` (all this used to
    // collapse) covers none of them, and <input> strips only CR and LF from a
    // paste -- so "paste a question you copied from a web page" was the whole
    // exploit.
    const q = 'how do I \u001b[Zenable\u0003 auto\u0007-accept\u001b[201~?'
    const out = normaliseQuestion(q)
    expect(out).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(out).toBe('how do I [Zenable auto -accept [201~?')
  })

  it('strips bidi overrides, which reorder what the user is shown', () => {
    expect(normaliseQuestion('why\u202edoes\u200bthis\u2066break')).toBe('why does this break')
  })

  it('strips the line and paragraph separators too', () => {
    // \p{Zl}\p{Zp}. Without a case for them, that arm of the class can be
    // dropped with every test still green.
    expect(normaliseQuestion('one\u2028two\u2029three')).toBe('one two three')
  })

  it('returns undefined for a question that is only control characters', () => {
    expect(normaliseQuestion('\u0000\u001b\u0007')).toBeUndefined()
  })
})

describe('findAskSession', () => {
  it('matches on kind, not on a missing configId', () => {
    const base = {
      id: 'a', label: 'x', workingDirectory: '', model: '', color: '#fff',
      status: 'idle' as const, createdAt: 0, sessionType: 'local' as const,
    }
    // The add-account login shell, the re-auth shell and a resumed project
    // folder are all config-less too; none of them is Ask Conductor.
    const loginShell = { ...base, id: 'login', shellOnly: true }
    const ask = { ...base, id: 'ask', kind: 'ask' as const }
    expect(findAskSession([loginShell])).toBeUndefined()
    expect(findAskSession([loginShell, ask])?.id).toBe('ask')
  })

  it('still finds a session whose PTY has exited -- existence and liveness are different questions', () => {
    const base = {
      id: 'a', label: 'x', workingDirectory: '', model: '', color: '#fff',
      status: 'idle' as const, createdAt: 0, sessionType: 'local' as const,
    }
    const dead = { ...base, id: 'ask', kind: 'ask' as const, ptyExited: true }
    // findAskSession answers "is there an Ask tab", which is still yes -- it is
    // what stops a second one being opened. Whether it can be TYPED at is a
    // different question, and the one the launch path got wrong.
    expect(findAskSession([dead])?.id).toBe('ask')
    expect(askSessionIsLive(dead)).toBe(false)
    expect(askSessionIsLive({ ...base, kind: 'ask' as const })).toBe(true)
    expect(askSessionIsLive(undefined)).toBe(false)
  })
})
