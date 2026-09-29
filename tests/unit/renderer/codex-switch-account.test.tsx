// @vitest-environment jsdom
// P3.6 (row 22; row 35's Switch half): Switch account for a Codex session, as
// Claude's works (settled by parity): the strip's account pill and the
// sidebar's right-click Switch Account list the provider's accounts (the
// current one marked, inactive ones greyed, this computer's own sign-in
// marked "confirm at launch"); a pick pins the new account and saves it, then
// restarts through the Restart path. Main's respawn of the session carries
// the conversation into the new account once the old process has ended and
// resumes it there by id (P3.5; tests/wp1/launch-handoff-pty.test.ts): the
// renderer asks for no carry. When it does not come along whole, the section
// 5 fallback: the terminal says why and what the session did (the note's
// words here; TerminalView writes it from the spawn's answer).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Session } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const killSessionPtyMock = vi.fn()
vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: (...args: unknown[]) => killSessionPtyMock(...args),
  clearSpawned: vi.fn(),
  hasSpawned: vi.fn(() => false),
  markSpawned: vi.fn(),
}))
const markSessionForResumePickerMock = vi.fn()
vi.mock('../../../src/renderer/utils/resumePicker', () => ({
  markSessionForResumePicker: (...args: unknown[]) => markSessionForResumePickerMock(...args),
  shouldUseResumePicker: vi.fn(() => false),
}))

// Review F1: a restart the Multi Spawn rule refuses (useRestartSession's
// refuseRestart), when a test sets one.
const refusal = vi.hoisted(() => ({ next: undefined as string | undefined }))
vi.mock('../../../src/renderer/hooks/useLaunchConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useLaunchConfig')>()),
  restartLaunchRefusal: () => refusal.next,
}))

const saveMock = vi.fn(async () => true)
const touched: string[] = []
const fetchOneMock = vi.fn(async () => null)
;(globalThis as any).window.electronAPI = {
  pty: { kill: vi.fn(), write: vi.fn() },
  session: { save: saveMock },
  accountUsage: { fetchOne: fetchOneMock },
  // Anything the switch reaches for here is recorded: it should reach nothing.
  providerAccounts: new Proxy({}, { get: (_t, prop) => { if (typeof prop === 'string') touched.push(prop); return undefined } }),
}

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useProviderAccountsStore, accountDisplayName } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useSwitchAccount } = await import('../../../src/renderer/hooks/useSwitchAccount')
const { switchAccountItems, switchItemHint } = await import('../../../src/renderer/utils/switchAccountItems')
const { canSwitchAccountForSession } = await import('../../../src/renderer/utils/sessionLaunch')
const { carryNote, terminalNoteLine } = await import('../../../src/renderer/utils/launchNote')
const { switchOrigin, noteSwitchOrigin, forgetSwitchOrigin } = await import('../../../src/renderer/utils/switchOrigin')
const { useLaunchAckStore } = await import('../../../src/renderer/stores/launchAckStore')
const { default: SessionContextMenu } = await import('../../../src/renderer/components/sidebar/SessionContextMenu')
const { snapshot, work, personal, local, old, parked, gone } = await import('./accounts-snapshot-harness')
const { middleTruncateEmail } = await import('../../../src/shared/account-chip-color')

const MIDDOT = String.fromCharCode(0xb7)
const codexSession = (over: Partial<Session> = {}): Session => ({
  id: 'sess-x', label: 'api', workingDirectory: 'C:/work', model: '', color: '', status: 'idle', createdAt: 1, sessionType: 'local', provider: 'codex', providerAccountId: work.id, ...over,
}) as Session

beforeEach(() => {
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  useAccountProfilesStore.setState({ profiles: [] })
  killSessionPtyMock.mockReset(); markSessionForResumePickerMock.mockReset(); saveMock.mockClear(); fetchOneMock.mockClear()
  touched.length = 0
  forgetSwitchOrigin('sess-x')
})
afterEach(() => { useProviderAccountsStore.setState({ snapshot: null, loaded: false }) })

describe('the Switch account list for a Codex session', () => {
  it('lists the provider\'s accounts: current marked, inactive and blocked greyed, this computer\'s sign-in marked confirm at launch, archived left out', () => {
    const snap = snapshot()
    const items = switchAccountItems(codexSession(), { profiles: [], aliases: {}, snapshot: snap })
    expect(items.map((i) => i.value).sort()).toEqual([work.id, personal.id, local.id, old.id, parked.id].sort())
    expect(items.some((i) => i.value === gone.id)).toBe(false)
    const by = (id: string) => items.find((i) => i.value === id)!
    expect(by(work.id)).toMatchObject({ label: 'Work', active: true, disabled: false })
    expect(by(personal.id)).toMatchObject({ label: 'Personal', active: false, disabled: false, detail: 'alex@home.example' })
    expect(by(parked.id)).toMatchObject({ state: 'inactive', disabled: true })
    expect(by(old.id)).toMatchObject({ state: 'needs attention', disabled: true })
    expect(by(local.id)).toMatchObject({ label: accountDisplayName(snap, local), state: 'confirm at launch', disabled: false })
    expect(switchItemHint(by(local.id))).toBe(`alex@example.com ${MIDDOT} confirm at launch`)
    expect(switchItemHint(by(personal.id))).toBe('alex@home.example')
  })

  it('a session on no named account is on the provider default; a current account stays selectable even if it has since gone inactive', () => {
    const items = switchAccountItems(codexSession({ providerAccountId: undefined }), { profiles: [], aliases: {}, snapshot: snapshot() })
    expect(items.find((i) => i.active)?.value).toBe(work.id)
    const onParked = switchAccountItems(codexSession({ providerAccountId: parked.id }), { profiles: [], aliases: {}, snapshot: snapshot() })
    expect(onParked.find((i) => i.value === parked.id)).toMatchObject({ active: true, disabled: false })
  })

  it('Claude\'s list reads exactly as before', () => {
    const profiles = [
      { id: 'p1', name: 'Main', accountEmail: 'main@x.com', createdAt: 0 },
      { id: 'p2', name: '', accountEmail: 'second-very-long-address@example-company.com', active: false, createdAt: 0 },
    ]
    const items = switchAccountItems({ provider: 'claude', profileId: 'p1' } as Session, { profiles, aliases: { 'second-very-long-address@example-company.com': 'Second' }, snapshot: null })
    expect(items).toEqual([
      { value: 'p1', label: 'Main', detail: 'main@x.com', title: 'main@x.com', active: true, disabled: false },
      { value: 'p2', label: 'Second', detail: middleTruncateEmail('second-very-long-address@example-company.com'), title: 'second-very-long-address@example-company.com', state: 'inactive', active: false, disabled: true },
    ])
    expect(switchItemHint(items[1])).toBe(`${middleTruncateEmail('second-very-long-address@example-company.com')} ${MIDDOT} inactive`)
  })

  it('offered for a local Codex session with two or more accounts, on every platform; never over SSH or for a terminal-only tab', () => {
    expect(canSwitchAccountForSession({ provider: 'codex', profileCount: 0, providerAccountCount: 2 })).toBe(true)
    expect(canSwitchAccountForSession({ provider: 'codex', profileCount: 5, providerAccountCount: 1 })).toBe(false)
    expect(canSwitchAccountForSession({ provider: 'codex', isSsh: true, profileCount: 0, providerAccountCount: 3 })).toBe(false)
    expect(canSwitchAccountForSession({ provider: 'codex', shellOnly: true, profileCount: 0, providerAccountCount: 3 })).toBe(false)
    const was = (window as any).electronPlatform
    ;(window as any).electronPlatform = 'darwin'
    try {
      expect(canSwitchAccountForSession({ provider: 'codex', profileCount: 0, providerAccountCount: 2 })).toBe(true)
      expect(canSwitchAccountForSession({ provider: 'claude', profileCount: 2 })).toBe(false)
    } finally { (window as any).electronPlatform = was }
  })
})

describe('switching a Codex session\'s account', () => {
  let container: HTMLDivElement
  let root: Root
  let switchFn: ((sessionId: string, next: string | undefined) => void) | null = null
  function Harness({ session }: { session: Session }) {
    const fn = useSwitchAccount(session)
    React.useEffect(() => { switchFn = fn }, [fn])
    return null
  }
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => { root.unmount() }); container.remove(); switchFn = null })
  const mount = (session: Session) => { useSessionStore.getState().addSession(session); act(() => { root.render(React.createElement(Harness, { session })) }) }
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
  const stored = () => useSessionStore.getState().sessions.find((s) => s.id === 'sess-x')!

  it('pins the new account and saves it, then restarts through the Restart path with it; the carry is main\'s, in the respawn', async () => {
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    expect(saveMock).toHaveBeenCalled()
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-x')
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(killSessionPtyMock.mock.invocationCallOrder[0])
    expect(stored().providerAccountId).toBe(personal.id)
    // Codex's plain Restart carries on with the conversation (P3.5): no picker.
    expect(markSessionForResumePickerMock).not.toHaveBeenCalled()
    // The renderer names no conversation and asks for no carry (ADR-009
    // thesis 3): there is no such call to make. And no usage read either.
    expect(touched).toEqual([])
    expect(fetchOneMock).not.toHaveBeenCalled()
    // VM finding V3: where it came from, for a launch there that is declined.
    expect(switchOrigin('sess-x')).toEqual({ from: work.id, to: personal.id })
    forgetSwitchOrigin('sess-x')
  })

  // Review F1: nothing is left to take a tab back later: a switch whose
  // restart is refused moved nothing, and a closed tab keeps nothing.
  it('a switch whose restart is refused leaves no origin, an earlier one included, and the pin where it was; a closed tab keeps none', async () => {
    mount(codexSession())
    noteSwitchOrigin('sess-x', parked.id, work.id)
    refusal.next = 'Already running.'
    try {
      switchFn!('sess-x', personal.id)
      await settle()
    } finally {
      refusal.next = undefined
    }
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    expect(switchOrigin('sess-x')).toBeNull()
    // Nothing moved, so the pin is back on the account the tab is on (review N1).
    expect(stored().providerAccountId).toBe(work.id)
    switchFn!('sess-x', local.id)
    await settle()
    expect(switchOrigin('sess-x')).toEqual({ from: work.id, to: local.id })
    useSessionStore.getState().removeSession('sess-x')
    expect(switchOrigin('sess-x')).toBeNull()
  })

  // Final nits (review of e170052d): the pin put back is the live one, and an
  // earlier switch's origin stays while that switch's launch is still asking.
  it('a refused switch puts back the pin as the store has it, and keeps an earlier origin whose launch is still asking', async () => {
    mount(codexSession())
    // The tab's record moved on since this view last rendered it.
    useSessionStore.getState().updateSession('sess-x', { providerAccountId: local.id })
    noteSwitchOrigin('sess-x', parked.id, local.id)
    void useLaunchAckStore.getState().request({ sessionId: 'sess-x', sessionLabel: 'api', accountName: 'External', external: true, unknown: false })
    refusal.next = 'Already running.'
    try {
      switchFn!('sess-x', personal.id)
      await settle()
    } finally {
      refusal.next = undefined
      useLaunchAckStore.getState().withdraw('sess-x')
    }
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    expect(stored().providerAccountId).toBe(local.id)
    expect(switchOrigin('sess-x')).toEqual({ from: parked.id, to: local.id })
  })

  // Review F3 (ADR-009 lens B): a second switch before the first one's launch
  // is answered keeps the account the tab was really on.
  it('a second switch before the first one\'s launch is answered keeps the first origin, with the new target', async () => {
    mount(codexSession())
    switchFn!('sess-x', local.id)
    await settle()
    expect(switchOrigin('sess-x')).toEqual({ from: work.id, to: local.id })
    // The tab now shows the first switch's account; its launch is still asking.
    act(() => { root.render(React.createElement(Harness, { session: codexSession({ providerAccountId: local.id }) })) })
    switchFn!('sess-x', personal.id)
    await settle()
    expect(stored().providerAccountId).toBe(personal.id)
    expect(switchOrigin('sess-x')).toEqual({ from: work.id, to: personal.id })
    forgetSwitchOrigin('sess-x')
  })

  it('a save that fails still switches: the account is pinned on the session and the restart goes ahead', async () => {
    saveMock.mockRejectedValueOnce(new Error('disk'))
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    expect(stored().providerAccountId).toBe(personal.id)
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-x')
  })

  it('refused before anything changes: the current account, one that is inactive, blocked, archived, another provider\'s or unknown; over SSH; a terminal-only tab', async () => {
    for (const target of [work.id, parked.id, old.id, gone.id, 'acc-claude-main', 'acc-nope', undefined]) {
      mount(codexSession())
      switchFn!('sess-x', target)
      await settle()
      act(() => { root.unmount() }); root = createRoot(container)
      useSessionStore.setState({ sessions: [] })
    }
    for (const over of [{ sshConfig: { host: 'h' } }, { shellOnly: true }] as Partial<Session>[]) {
      mount(codexSession(over))
      switchFn!('sess-x', personal.id)
      await settle()
      act(() => { root.unmount() }); root = createRoot(container)
      useSessionStore.setState({ sessions: [] })
    }
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('a second pick while the first is still being saved is ignored', async () => {
    let release!: () => void
    saveMock.mockImplementationOnce(() => new Promise((r) => { release = () => r(true) }))
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    switchFn!('sess-x', local.id)
    await settle()
    expect(saveMock).toHaveBeenCalledTimes(1)
    release()
    await settle()
    expect(killSessionPtyMock).toHaveBeenCalledTimes(1)
    expect(stored().providerAccountId).toBe(personal.id)
  })
})

// P3.6 (quality round 1; spec minor at useSwitchAccount:46): the words for a
// respawn whose conversation did not come along whole are true for what the
// launch did, main answering both why and whether it resumed.
describe('the note a Switch account\'s respawn says', () => {
  it('not resumed: a new conversation, in main\'s words for why', () => {
    expect(carryNote({ code: 'too-large', message: 'This conversation is larger than the app carries between Codex accounts, so it was not carried over.', resumed: false }, 'Personal'))
      .toBe('Switched to Personal. This conversation is larger than the app carries between Codex accounts, so it was not carried over. This is a new conversation.')
    expect(carryNote({ code: 'internal', message: '  ', resumed: false }, 'Personal')).toBe('Switched to Personal. The conversation could not be carried over. This is a new conversation.')
    // ADR-009 round 2 (C1): another open session on the conversation is
    // never resumed on the new account (main answers resumed: false), so the
    // line never speaks of the copy already in that account.
    const inUse = carryNote({ code: 'in-use', message: 'Another open session is on this conversation, so it was not carried over.', resumed: false }, 'Personal')
    expect(inUse).toBe('Switched to Personal. Another open session is on this conversation, so it was not carried over. This is a new conversation.')
    expect(inUse).not.toMatch(/already in that account/)
  })

  it('resumed from a copy that went its own way there: carries on from that copy, never called a new conversation', () => {
    const line = carryNote({ code: 'conversation-differs', message: 'x', resumed: true }, 'Personal')
    expect(line).toBe('Switched to Personal. That account already holds a copy of this conversation that went on differently there, which the app left as it is, so the session carries on from that copy.')
    expect(line).not.toMatch(/new conversation/)
  })

  it('resumed from an earlier copy for another reason (A -> B -> A with the carry refused): carries on from it, and says it may be behind', () => {
    const line = carryNote({ code: 'busy', message: "The session's previous run had not ended yet, so its conversation was not carried over.", resumed: true }, 'Personal')
    expect(line).toBe("Switched to Personal. The session's previous run had not ended yet, so its conversation was not carried over. The session carries on from the copy of this conversation already in that account, which may not have what was said since.")
    expect(line).not.toMatch(/new conversation/)
  })

  it('ADR-009 thesis 18: the line reaches the terminal with every control and spoofing character replaced, as the app treats every such line', () => {
    const RLO = String.fromCharCode(0x202e)
    const LRI = String.fromCharCode(0x2066)
    const ZWSP = String.fromCharCode(0x200b)
    const CSI = String.fromCharCode(0x9b)
    const LS = String.fromCharCode(0x2028)
    const line = terminalNoteLine(carryNote({ code: 'too-large', message: 'Too large.', resumed: false }, `Pers${RLO}lanos${LRI}x${ZWSP}y${CSI}2J\u001b]8;;http://e/\u0007z${LS}fake`))
    for (const c of [RLO, LRI, ZWSP, CSI, LS, '\u001b', '\u0007']) expect(line.includes(c), c.charCodeAt(0).toString(16)).toBe(false)
    expect(line.startsWith('Switched to Pers lanos x y 2J ]8;;http://e/ z fake.')).toBe(true)
    expect(terminalNoteLine('x'.repeat(5000)).length).toBe(1000)
  })
})

describe('the sidebar\'s right-click Switch Account lists them too', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => { root.unmount() }); container.remove() })

  it('shows the list for a Codex session and switches on a pick; greyed ones cannot be picked', () => {
    const onSwitch = vi.fn()
    const items = switchAccountItems(codexSession(), { profiles: [], aliases: {}, snapshot: snapshot() })
    act(() => {
      root.render(React.createElement(SessionContextMenu, {
        x: 0, y: 0, session: codexSession(), hasGroup: false,
        onRename: () => {}, onRemoveFromGroup: () => {}, onClose: () => {}, onDismiss: () => {},
        canSwitchAccount: true, switchItems: items, onSwitchAccount: onSwitch,
      }))
    })
    const open = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Switch Account'))!
    act(() => { open.click() })
    const row = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label))!
    expect(row('Parked').disabled).toBe(true)
    expect(row('Parked').textContent).toContain(`${MIDDOT} inactive`)
    expect(row(accountDisplayName(snapshot(), local)).textContent).toContain(`${MIDDOT} confirm at launch`)
    act(() => { row('Parked').click() })
    expect(onSwitch).not.toHaveBeenCalled()
    act(() => { row('Personal').click() })
    expect(onSwitch).toHaveBeenCalledWith(personal.id)
  })
})
