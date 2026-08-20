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
  useAskErrorStore,
  ASK_LABEL,
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
})
