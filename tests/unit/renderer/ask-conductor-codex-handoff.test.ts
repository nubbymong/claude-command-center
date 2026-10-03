// @vitest-environment jsdom
// [host] WP2 PR 4, P4.3 (row 53): a question for a RUNNING Ask session on
// Codex (src/renderer/lib/askConductor.ts handQuestionToRunning) goes to
// main's submit primitive through askConductor:handOff, never as the raw
// question and Enter written into the PTY (Codex submits no such write, PB3),
// with the question kept for the dock first; a question not sent raises the
// dock's line. A Claude tab keeps the PTY write a command button uses.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../src/renderer/utils/resumePicker', () => ({ markSessionForResumePicker: vi.fn() }))
vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: Object.assign(() => ({}), { getState: () => ({ addConfig: vi.fn(), configs: [] }) }),
}))

import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { launchAskConductor, useAskErrorStore, useAskNoticeStore, askNoticeText, _resetAskLaunchForTest, _resetAskNoticesForTest } from '../../../src/renderer/lib/askConductor'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

const ptyWrite = vi.fn()
const handOff = vi.fn()
const ASK_ID = 'ask00000ask00000ask00000'
const askSession = (provider: 'claude' | 'codex') => ({
  id: ASK_ID, kind: 'ask', label: 'Ask Conductor', workingDirectory: 'C:/res/help', model: '', color: '', status: 'idle',
  createdAt: 1, sessionType: 'local', provider, ...(provider === 'codex' ? { codexOptions: { permissionsPreset: 'standard' } } : {}),
})
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  ptyWrite.mockReset()
  handOff.mockReset()
  handOff.mockResolvedValue({ delivered: true })
  _resetAskLaunchForTest()
  _resetAskNoticesForTest()
  useAskErrorStore.setState({ error: null })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true, codexEnabled: true, codexAnswered: true } as never })
  ;(globalThis as any).window.electronAPI = {
    help: { workspace: () => Promise.resolve('C:/res/help') },
    pty: { write: ptyWrite },
    askConductor: { handOff, onNotice: () => () => {} },
  }
})
afterEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
})

describe('a running Codex Ask tab', () => {
  it('[host] the question goes to main\'s submit primitive, whole, and never into the PTY', async () => {
    useSessionStore.setState({ sessions: [askSession('codex') as never], activeSessionId: null })
    expect(await launchAskConductor('how do I add an account?')).toBe(ASK_ID)
    await flush()
    expect(handOff).toHaveBeenCalledWith({ sessionId: ASK_ID, question: 'how do I add an account?' })
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(useAskNoticeStore.getState().kept).toEqual({ sessionId: ASK_ID, question: 'how do I add an account?' })
    expect(useAskNoticeStore.getState().notice).toBeNull()
  })

  it('[host] not sent: the dock says why, and the question stays kept', async () => {
    useSessionStore.setState({ sessions: [askSession('codex') as never], activeSessionId: null })
    handOff.mockResolvedValue({ delivered: false, reason: 'busy-timeout' })
    await launchAskConductor('and then?')
    await flush()
    expect(useAskNoticeStore.getState().notice).toEqual({ sessionId: ASK_ID, kind: 'not-delivered', reason: 'busy-timeout' })
    expect(useAskNoticeStore.getState().kept).toEqual({ sessionId: ASK_ID, question: 'and then?' })
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('[host] the hand-off failing, or no bridge at all: said as not sent, never a raw write instead', async () => {
    useSessionStore.setState({ sessions: [askSession('codex') as never], activeSessionId: null })
    handOff.mockRejectedValue(new Error('no handler'))
    await launchAskConductor('first')
    await flush()
    expect(useAskNoticeStore.getState().notice).toEqual({ sessionId: ASK_ID, kind: 'not-delivered', reason: 'session-gone' })
    ;(globalThis as any).window.electronAPI.askConductor = undefined
    useAskNoticeStore.setState({ notice: null })
    await launchAskConductor('second')
    await flush()
    expect(useAskNoticeStore.getState().notice).toEqual({ sessionId: ASK_ID, kind: 'not-delivered', reason: 'session-gone' })
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('[host] an answer main could not have sent reads as not sent (the session gone)', async () => {
    useSessionStore.setState({ sessions: [askSession('codex') as never], activeSessionId: null })
    handOff.mockResolvedValue({ delivered: false, reason: 'made-up' })
    await launchAskConductor('x')
    await flush()
    expect(useAskNoticeStore.getState().notice).toEqual({ sessionId: ASK_ID, kind: 'not-delivered', reason: 'session-gone' })
  })

  it('[host] the second click of a launch still being staged hands its question over the same way', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true, codexAnswered: true } as never })
    let release: (d: string) => void = () => {}
    ;(globalThis as any).window.electronAPI.help.workspace = () => new Promise<string>((res) => { release = res })
    const a = launchAskConductor('first question')
    const b = launchAskConductor('second question')
    release('C:/res/help')
    const [id] = await Promise.all([a, b])
    await flush()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ provider: 'codex', askPrompt: 'first question' })
    expect(handOff).toHaveBeenCalledWith({ sessionId: id, question: 'second question' })
    expect(ptyWrite).not.toHaveBeenCalled()
  })
})

describe('a question for an Ask tab that is still starting (P4.3 review RASK-5)', () => {
  it('[host] main has no running session yet while the tab is open: the dock says it is starting, not closed, and keeps the question', async () => {
    useSessionStore.setState({ sessions: [askSession('codex') as never], activeSessionId: null })
    handOff.mockResolvedValue({ delivered: false, reason: 'session-gone' })
    await launchAskConductor('are you there?')
    await flush()
    const notice = useAskNoticeStore.getState().notice!
    expect(notice).toMatchObject({ sessionId: ASK_ID, kind: 'not-delivered', reason: 'session-gone', starting: true })
    expect(askNoticeText(notice)).toMatch(/still starting/)
    expect(askNoticeText(notice)).not.toMatch(/closed/)
    expect(useAskNoticeStore.getState().kept).toEqual({ sessionId: ASK_ID, question: 'are you there?' })
  })

  it('[host] the second click of a launch still being staged: the same', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true, codexAnswered: true } as never })
    handOff.mockResolvedValue({ delivered: false, reason: 'session-gone' })
    let release: (d: string) => void = () => {}
    ;(globalThis as any).window.electronAPI.help.workspace = () => new Promise<string>((res) => { release = res })
    const a = launchAskConductor('first question')
    const b = launchAskConductor('second question')
    release('C:/res/help')
    await Promise.all([a, b])
    await flush()
    expect(askNoticeText(useAskNoticeStore.getState().notice!)).toMatch(/still starting/)
  })

  it('[host] the tab ended meanwhile: the dock says the session closed', async () => {
    useSessionStore.setState({ sessions: [askSession('codex') as never], activeSessionId: null })
    handOff.mockImplementation(async () => {
      useSessionStore.setState({ sessions: [{ ...askSession('codex'), ptyExited: true } as never] })
      return { delivered: false, reason: 'session-gone' }
    })
    await launchAskConductor('still there?')
    await flush()
    const notice = useAskNoticeStore.getState().notice!
    expect(notice).toEqual({ sessionId: ASK_ID, kind: 'not-delivered', reason: 'session-gone' })
    expect(askNoticeText(notice)).toMatch(/closed/)
  })
})

describe('a running Claude Ask tab', () => {
  it('[host] keeps the PTY write a command button uses (its TUI submits the line and its Enter)', async () => {
    useSessionStore.setState({ sessions: [askSession('claude') as never], activeSessionId: null })
    await launchAskConductor('how do I hide tips?')
    await flush()
    expect(ptyWrite).toHaveBeenCalledWith(ASK_ID, 'how do I hide tips?\r')
    expect(handOff).not.toHaveBeenCalled()
  })
})
