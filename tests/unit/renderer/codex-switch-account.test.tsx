// @vitest-environment jsdom
// P3.6 (row 22; row 35's Switch half): Switch account for a Codex session, as
// Claude's works (settled by parity): the strip's account pill and the
// sidebar's right-click Switch Account list the provider's accounts (the
// current one marked, inactive ones greyed, this computer's own sign-in
// marked "confirm at launch"); a pick pins the new account and saves it, has
// main carry the conversation into that account (both accounts held), then
// restarts through the Restart path, which resumes it there by id (P3.5).
// When the conversation cannot be carried, the section 5 fallback: the
// session starts a new conversation and says so in the terminal.
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

let carryAnswer: unknown = { ok: true, carried: 'copied' }
const carryMock = vi.fn(async () => carryAnswer)
const saveMock = vi.fn(async () => true)
const fetchOneMock = vi.fn(async () => null)
;(globalThis as any).window.electronAPI = {
  pty: { kill: vi.fn(), write: vi.fn() },
  session: { save: saveMock },
  accountUsage: { fetchOne: fetchOneMock },
  providerAccounts: { carryConversation: carryMock },
}

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useProviderAccountsStore, accountDisplayName } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useSwitchAccount } = await import('../../../src/renderer/hooks/useSwitchAccount')
const { switchAccountItems, switchItemHint } = await import('../../../src/renderer/utils/switchAccountItems')
const { canSwitchAccountForSession } = await import('../../../src/renderer/utils/sessionLaunch')
const { takeLaunchNote } = await import('../../../src/renderer/utils/launchNote')
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
  killSessionPtyMock.mockReset(); markSessionForResumePickerMock.mockReset(); carryMock.mockClear(); saveMock.mockClear(); fetchOneMock.mockClear()
  carryAnswer = { ok: true, carried: 'copied' }
  takeLaunchNote('sess-x')
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

  it('pins the new account and saves it, has main carry the conversation, then restarts through the Restart path with it', async () => {
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    expect(saveMock).toHaveBeenCalled()
    expect(carryMock).toHaveBeenCalledWith({ sessionId: 'sess-x', accountId: personal.id })
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(carryMock.mock.invocationCallOrder[0])
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-x')
    expect(carryMock.mock.invocationCallOrder[0]).toBeLessThan(killSessionPtyMock.mock.invocationCallOrder[0])
    expect(stored().providerAccountId).toBe(personal.id)
    // Codex's plain Restart carries on with the conversation (P3.5): no picker.
    expect(markSessionForResumePickerMock).not.toHaveBeenCalled()
    // Carried: nothing to say. And no usage read is started for it.
    expect(takeLaunchNote('sess-x')).toBeUndefined()
    expect(fetchOneMock).not.toHaveBeenCalled()
  })

  it('the section 5 fallback: a conversation that could not be carried starts a new one, and the terminal says why', async () => {
    carryAnswer = { ok: false, code: 'too-large', message: 'This conversation is larger than the app carries between Codex accounts, so it was not carried over.' }
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-x')
    expect(stored().providerAccountId).toBe(personal.id)
    expect(takeLaunchNote('sess-x')).toBe('Switched to Personal. This conversation is larger than the app carries between Codex accounts, so it was not carried over. This is a new conversation.')
    // One-shot.
    expect(takeLaunchNote('sess-x')).toBeUndefined()
  })

  it('an earlier copy already in that account is left as it is, and the terminal says the session carries on from it', async () => {
    carryAnswer = { ok: false, code: 'conversation-differs', message: 'The other Codex account already holds a different copy of this conversation, so the app left it as it is.' }
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    expect(takeLaunchNote('sess-x')).toBe('Switched to Personal. That account already holds an earlier copy of this conversation, which the app left as it is, so the session carries on from that copy.')
  })

  it('a carry that could not be asked still switches, and says so', async () => {
    carryMock.mockRejectedValueOnce(new Error('ipc'))
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    expect(killSessionPtyMock).toHaveBeenCalledWith('sess-x')
    expect(takeLaunchNote('sess-x')).toBe('Switched to Personal. The conversation could not be carried over. This is a new conversation.')
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
    expect(carryMock).not.toHaveBeenCalled()
    expect(killSessionPtyMock).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('a second pick while one is under way is ignored', async () => {
    let release!: () => void
    carryMock.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, carried: 'copied' }) }))
    mount(codexSession())
    switchFn!('sess-x', personal.id)
    await settle()
    switchFn!('sess-x', local.id)
    await settle()
    expect(carryMock).toHaveBeenCalledTimes(1)
    release()
    await settle()
    expect(killSessionPtyMock).toHaveBeenCalledTimes(1)
    expect(stored().providerAccountId).toBe(personal.id)
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
