import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import type { AccountProfile } from '../../../src/shared/account-types'

// Capture ipcMain.handle registrations so we can invoke handlers directly.
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

// In-memory profiles store backing the mocked persistence layer. isAccountActive
// is deliberately NOT mocked -- the last-active backstop must be tested against
// the real read-side rule.
let store: AccountProfile[] = []
vi.mock('../../../src/main/account-profiles', () => ({
  listProfiles: () => store.map((p) => ({ ...p })),
  upsertProfile: (p: AccountProfile) => {
    const i = store.findIndex((x) => x.id === p.id)
    if (i >= 0) store[i] = p
    else store.push(p)
  },
  isValidProfileId: (id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id),
  safeTeardownProfile: vi.fn(),
  readProfileAccountEmail: vi.fn(),
  getProfileConfigDir: vi.fn(),
  createProfile: vi.fn(),
  captureDetectedAccount: vi.fn(),
  backupProfileHomeToCanonical: vi.fn(),
  restoreProfileHomeFromCanonical: vi.fn(),
  // The macOS multi-account delete path (ADR-024): a per-profile serialisation
  // that runs the delete as is, and a Keychain item removal that is a no-op.
  runSerialisedForProfile: (_id: string, fn: () => Promise<unknown>) => fn(),
  removeProfileKeychainItem: async () => ({ ok: true }),
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  getAccountIdentity: vi.fn(), getDefaultAccountEmail: vi.fn(),
  getWatchedProfileId: vi.fn(), isProfileInUseByLiveSession: vi.fn(() => false), sessionsOnProfile: vi.fn(() => [] as string[]),
}))
vi.mock('../../../src/main/usage/account-usage', () => ({ fetchAllAccountsUsage: vi.fn(), fetchAllAccountsUsageStreaming: vi.fn(), fetchAccountUsage: vi.fn() }))
vi.mock('../../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: vi.fn(() => []) }))
vi.mock('../../../src/main/debug-logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

import { registerAccountProfilesHandlers } from '../../../src/main/ipc/account-profiles-handlers'


// The app's own window, and an event from its top frame: the account-profile
// handlers answer nothing else (P3.2, trusted-sender.ts). An event object is
// stamped as coming from it (its sender becomes the window's webContents).
const appFrame = { frame: 'app' }
const appWindow: any = { isDestroyed: () => false, webContents: { mainFrame: appFrame } }
const getAppWindow = () => appWindow
function fromApp<T extends Record<string, any>>(ev: T = {} as T): T {
  const wc = ev.sender ?? { mainFrame: appFrame }
  if (!wc.mainFrame) wc.mainFrame = { frame: 'main' }
  appWindow.webContents = wc
  return Object.assign(ev, { sender: wc, senderFrame: wc.mainFrame })
}
const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!(fromApp({} as any), ...args)
const prof = (over: Partial<AccountProfile>): AccountProfile =>
  ({ id: 'p1', name: '', createdAt: 0, ...over }) as AccountProfile
const activeOf = (id: string) => store.find((p) => p.id === id)?.active

describe('accountProfiles:setActive handler', () => {
  beforeEach(() => {
    handlers.clear()
    store = []
    registerAccountProfilesHandlers(getAppWindow)
  })

  it('deactivates a non-primary account and round-trips the flag', () => {
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'work' })]
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: false })).toEqual({ ok: true })
    expect(activeOf('work')).toBe(false)
    // ...and back on again
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: true })).toEqual({ ok: true })
    expect(activeOf('work')).toBe(true)
  })

  it('refuses to deactivate the primary account', () => {
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'work' })]
    const res = invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'primary', active: false })
    expect(res.ok).toBe(false)
    expect(activeOf('primary')).not.toBe(false)
  })

  it('refuses to deactivate the LAST active account when there is no primary', () => {
    // No primary (default global never logged in): two ordinary accounts.
    store = [prof({ id: 'a' }), prof({ id: 'b' })]
    // Turning one off is fine.
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'a', active: false })).toEqual({ ok: true })
    // Turning the last remaining one off is refused -> switcher/launch gate never empty.
    const res = invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'b', active: false })
    expect(res.ok).toBe(false)
    expect(activeOf('b')).not.toBe(false)
  })

  it('only strict boolean false deactivates (fail-safe to active on junk input)', () => {
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'work' })]
    for (const junk of [0, '', 'false', null, undefined, NaN] as any[]) {
      invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: junk })
      expect(activeOf('work')).toBe(true)
    }
  })

  it('rejects an invalid id or an unknown profile without writing', () => {
    store = [prof({ id: 'primary', isPrimary: true })]
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: '../escape', active: false })).toEqual({ ok: false })
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'ghost', active: false })).toEqual({ ok: false })
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, undefined)).toEqual({ ok: false })
    expect(store).toHaveLength(1)
  })
})

// P3.2 (design 5.3, WP1.16): an account in use is not made inactive, as for
// every provider's accounts, and the refusal carries a code the Accounts row
// acts on (it names the sessions with Go to); so does a refused removal.
describe('accountProfiles: in use by a live session', () => {
  beforeEach(() => {
    handlers.clear()
    store = []
    registerAccountProfilesHandlers(getAppWindow)
  })

  it('refuses Make inactive with code in-use and the sessions on it, and writes nothing; Make active is never refused for it', async () => {
    const { sessionsOnProfile } = await import('../../../src/main/claude-account-identity')
    vi.mocked(sessionsOnProfile).mockImplementation((id: string) => (id === 'work' || id === 'idle' ? ['s-1'] : []))
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'work' }), prof({ id: 'idle', active: false })]
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: false })).toEqual({
      ok: false, code: 'in-use', error: 'This account is in use by an open session. Close its sessions and try again.', sessions: ['s-1'],
    })
    expect(activeOf('work')).toBeUndefined()
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'idle', active: true })).toEqual({ ok: true })
    vi.mocked(sessionsOnProfile).mockImplementation(() => [])
  })

  it('a transient holder (the sign-in status probe Accounts starts on open) does not refuse Make inactive (review round 3)', async () => {
    const { isProfileInUseByLiveSession, sessionsOnProfile } = await import('../../../src/main/claude-account-identity')
    vi.mocked(isProfileInUseByLiveSession).mockImplementation(() => true)
    vi.mocked(sessionsOnProfile).mockImplementation(() => [])
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'work' })]
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: false })).toEqual({ ok: true })
    expect(activeOf('work')).toBe(false)
    vi.mocked(isProfileInUseByLiveSession).mockImplementation(() => false)
  })

  it('a removal refused for a live session carries code in-use and the sessions on it (a probe still refuses a removal)', async () => {
    const { isProfileInUseByLiveSession, sessionsOnProfile } = await import('../../../src/main/claude-account-identity')
    vi.mocked(isProfileInUseByLiveSession).mockImplementation((id: string) => id === 'work')
    vi.mocked(sessionsOnProfile).mockImplementation((id: string) => (id === 'work' ? ['s-1'] : []))
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'work' })]
    expect(await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })).toMatchObject({ ok: false, code: 'in-use', sessions: ['s-1'] })
    vi.mocked(sessionsOnProfile).mockImplementation(() => [])
    const r = await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })
    expect(r).toMatchObject({ ok: false, code: 'in-use' })
    expect('sessions' in r).toBe(false)
    vi.mocked(isProfileInUseByLiveSession).mockImplementation(() => false)
  })
})

describe('accountProfiles handlers: an already-inactive account, and who may ask (P3.2 ADR-009 pass, F3, F4)', () => {
  beforeEach(() => {
    handlers.clear()
    store = []
    registerAccountProfilesHandlers(getAppWindow)
  })

  it('Make inactive on an account already inactive is a no-op ok, even with sessions on it', async () => {
    const { sessionsOnProfile } = await import('../../../src/main/claude-account-identity')
    vi.mocked(sessionsOnProfile).mockImplementation(() => ['s-1'])
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'idle', active: false })]
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'idle', active: false })).toEqual({ ok: true })
    expect(activeOf('idle')).toBe(false)
    vi.mocked(sessionsOnProfile).mockImplementation(() => [])
  })

  it('a foreign sender and a subframe of the app window are refused, and nothing is read or written', async () => {
    store = [prof({ id: 'primary', isPrimary: true }), prof({ id: 'work' })]
    const foreign = { sender: { id: 77 }, senderFrame: { frame: 'other' } }
    const sub = () => { const ev = fromApp({} as any); return { sender: ev.sender, senderFrame: { frame: 'iframe' } } }
    const REFUSED = { ok: false, code: 'untrusted-sender', error: 'That request was not accepted.' }
    for (const ev of [foreign, sub()]) {
      expect(handlers.get(IPC.ACCOUNT_PROFILES_SET_ACTIVE)!(ev, { id: 'work', active: false })).toEqual(REFUSED)
      expect(await handlers.get(IPC.ACCOUNT_PROFILES_DELETE)!(ev, { id: 'work' })).toEqual(REFUSED)
      expect(handlers.get(IPC.ACCOUNT_PROFILES_RENAME)!(ev, { id: 'work', name: 'x' })).toEqual(REFUSED)
      expect(handlers.get(IPC.ACCOUNT_PROFILES_LIST)!(ev)).toEqual(REFUSED)
    }
    expect(activeOf('work')).toBeUndefined()
    expect(store.find((p) => p.id === 'work')!.name).toBe('')
    // The app's own window is answered.
    expect(invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: false })).toEqual({ ok: true })
  })

  it('every handler this module registers answers the app window only', () => {
    const foreign = { sender: { id: 77 }, senderFrame: { frame: 'other' } }
    expect(handlers.size).toBeGreaterThanOrEqual(16)
    for (const [channel, fn] of handlers) {
      const r = fn(foreign, {})
      expect(r, channel).toEqual({ ok: false, code: 'untrusted-sender', error: 'That request was not accepted.' })
    }
  })
})
