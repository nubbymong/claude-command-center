// The streaming usage IPC (plan P3): the renderer opens a private reply channel
// and passes its name; each account's usage is sent back on it AS IT RESOLVES.
// The channel names only where to send on the CALLER's OWN webContents, but it is
// prefix- and length-checked so a stray value cannot address an unrelated
// ipcRenderer listener in that same renderer. These pin the validation, the
// per-result send, and (adversarial pass on #598) the one-stream-per-caller rule;
// the credentialStamp and delete handlers' trust shape rides in the same harness.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import type { AccountUsage } from '../../../src/shared/usage-types'

const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

const h = vi.hoisted(() => ({
  inUse: vi.fn<(id: string) => boolean>(() => false),
  safeTeardownProfile: vi.fn(),
  clearWebSession: vi.fn(async (_id: string) => {}),
  removeWebSession: vi.fn(),
  readProfileCredentialStamp: vi.fn((_id: string) => ({ stamp: '1:2', signedIn: true })),
}))

// A scripted streaming source: emits the profiles listed in `emit`, yielding to
// the event loop before each (so a second invoke can interleave) and asking
// `shouldContinue` before each, as the real one does. `produced` records every
// account the SOURCE went on to fetch, across all streams.
const emit: AccountUsage[] = []
const produced: string[] = []
const usage = (profileId: string): AccountUsage => ({
  profileId, email: null, name: profileId, isPrimary: false, active: true,
  status: 'ok', buckets: [], fetchedAt: 0,
})
const fetchAllAccountsUsageStreaming = vi.fn(async (onResult: (u: AccountUsage) => void, opts?: { shouldContinue?: () => boolean }) => {
  for (const u of emit) {
    await new Promise((r) => setTimeout(r, 0))
    if (opts?.shouldContinue && !opts.shouldContinue()) return
    produced.push(u.profileId)
    onResult(u)
  }
})
vi.mock('../../../src/main/usage/account-usage', () => ({
  fetchAllAccountsUsage: vi.fn(), fetchAccountUsage: vi.fn(),
  fetchAllAccountsUsageStreaming: (cb: (u: AccountUsage) => void, opts?: { shouldContinue?: () => boolean }) => fetchAllAccountsUsageStreaming(cb, opts),
}))
vi.mock('../../../src/main/account-profiles', () => ({
  listProfiles: () => [], upsertProfile: vi.fn(),
  isValidProfileId: (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[a-z0-9][a-z0-9-]*$/.test(id),
  safeTeardownProfile: h.safeTeardownProfile, readProfileAccountEmail: vi.fn(), getProfileConfigDir: vi.fn(),
  createProfile: vi.fn(), captureDetectedAccount: vi.fn(), backupProfileHomeToCanonical: vi.fn(),
  restoreProfileHomeFromCanonical: vi.fn(), readProfileCredentialStamp: h.readProfileCredentialStamp,
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  getAccountIdentity: vi.fn(), getDefaultAccountEmail: vi.fn(),
  getWatchedProfileId: vi.fn(), isProfileInUseByLiveSession: (id: string) => h.inUse(id),
}))
vi.mock('../../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: vi.fn(() => []) }))
vi.mock('../../../src/main/debug-logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('../../../src/main/account-web/sign-in', () => ({ clearWebSession: (id: string) => h.clearWebSession(id) }))
vi.mock('../../../src/main/account-web/session-store', () => ({ removeWebSession: h.removeWebSession }))
vi.mock('../../../src/main/account-web/artifacts', () => ({ closeArtifacts: vi.fn() }))
vi.mock('../../../src/main/account-web/account-pane', () => ({ closeAccountPanesForProfile: vi.fn() }))

const { registerAccountProfilesHandlers } = await import('../../../src/main/ipc/account-profiles-handlers')

/** A fake IPC event whose sender is webContents `id`; `destroy()` flips isDestroyed. */
function fakeEvent(id = 1) {
  const sent: Array<{ channel: string; usage: AccountUsage }> = []
  let destroyed = false
  return {
    sent,
    destroy: () => { destroyed = true },
    sender: { id, isDestroyed: () => destroyed, send: (channel: string, u: AccountUsage) => sent.push({ channel, usage: u }) },
  }
}
const CH = 'accountUsage:result:abc123'
const ids = (ev: ReturnType<typeof fakeEvent>) => ev.sent.map((s) => s.usage.profileId)
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  handlers.clear()
  emit.length = 0
  produced.length = 0
  fetchAllAccountsUsageStreaming.mockClear()
  h.inUse.mockReset().mockImplementation(() => false)
  h.safeTeardownProfile.mockClear()
  h.clearWebSession.mockReset().mockImplementation(async () => {})
  h.removeWebSession.mockClear()
  h.readProfileCredentialStamp.mockClear()
  registerAccountProfilesHandlers()
})

// Look up per call: handlers are registered in beforeEach, after module load.
const runStream = (ev: any, arg: any) => handlers.get(IPC.ACCOUNT_USAGE_FETCH_ALL_STREAM)!(ev, arg)

describe('accountUsage:fetchAllStream handler', () => {
  it('sends each streamed account on the caller-named channel, in order', async () => {
    emit.push(usage('a'), usage('b'), usage('c'))
    const ev = fakeEvent()
    await runStream(ev, { channel: CH })
    expect(ev.sent.map((s) => s.channel)).toEqual([CH, CH, CH])
    expect(ids(ev)).toEqual(['a', 'b', 'c'])
  })

  it('refuses a channel that is not the accountUsage:result: prefix, and streams nothing', async () => {
    emit.push(usage('a'))
    for (const channel of ['pty:data:evil', 'accountProfiles:list', 'AccountUsage:result:x', '', 42 as unknown as string, undefined]) {
      const ev = fakeEvent()
      await runStream(ev, { channel })
      expect(ev.sent, JSON.stringify(channel)).toEqual([])
    }
    expect(fetchAllAccountsUsageStreaming).not.toHaveBeenCalled()
  })

  it('refuses an over-long channel (a bound on the string)', async () => {
    emit.push(usage('a'))
    const ev = fakeEvent()
    await runStream(ev, { channel: 'accountUsage:result:' + 'x'.repeat(200) })
    expect(ev.sent).toEqual([])
    expect(fetchAllAccountsUsageStreaming).not.toHaveBeenCalled()
  })

  it('does not send to a destroyed sender (no throw)', async () => {
    emit.push(usage('a'))
    const ev = fakeEvent()
    ev.destroy()
    await runStream(ev, { channel: CH })
    expect(ev.sent).toEqual([])
  })
})

describe('accountUsage:fetchAllStream — one stream per caller (adversarial pass on #598)', () => {
  it('REGRESSION: a newer stream from the same sender stops the older one at its next account', async () => {
    emit.push(usage('a'), usage('b'), usage('c'))
    const ev1 = fakeEvent(7)
    const ev2 = fakeEvent(7) // the same webContents, invoking again
    const first = runStream(ev1, { channel: CH })
    // Real zero-delay timers, on purpose: Node fires equal-delay timers in the
    // order they were armed, so the source's timer (armed first) delivers 'a'
    // before this one returns and the second stream is opened -- deterministic.
    await tick() // the first stream has delivered 'a' and is pacing toward 'b'
    const second = runStream(ev2, { channel: CH })
    await Promise.all([first, second])
    expect(ids(ev1)).toEqual(['a'])
    expect(ids(ev2)).toEqual(['a', 'b', 'c'])
    // The SOURCE stopped too -- no fan-out for accounts nobody will read.
    expect(produced).toEqual(['a', 'a', 'b', 'c'])
  })

  it('a sender destroyed mid-stream stops the source, not only the sends', async () => {
    emit.push(usage('a'), usage('b'), usage('c'))
    const ev = fakeEvent(8)
    const p = runStream(ev, { channel: CH })
    await tick() // 'a' delivered
    ev.destroy()
    await p
    expect(ids(ev)).toEqual(['a'])
    expect(produced).toEqual(['a'])
  })

  it('streams from DIFFERENT senders do not stop each other', async () => {
    emit.push(usage('a'), usage('b'))
    const ev1 = fakeEvent(1)
    const ev2 = fakeEvent(2)
    await Promise.all([runStream(ev1, { channel: CH }), runStream(ev2, { channel: CH })])
    expect(ids(ev1)).toEqual(['a', 'b'])
    expect(ids(ev2)).toEqual(['a', 'b'])
  })

  it('a completed stream does not shadow the sender\'s next one', async () => {
    emit.push(usage('a'))
    const ev1 = fakeEvent(9)
    await runStream(ev1, { channel: CH })
    const ev2 = fakeEvent(9)
    await runStream(ev2, { channel: CH })
    expect(ids(ev2)).toEqual(['a'])
  })
})

// rc.14 review F7: the re-auth poll's generation stamp. The handler validates the
// id BEFORE the reader touches the filesystem, and passes the reader's stat-shaped
// answer through unchanged -- no token, email or path is added on the way.
describe('accountProfiles:credentialStamp handler', () => {
  const stamp = (arg: unknown) => handlers.get(IPC.ACCOUNT_PROFILES_CREDENTIAL_STAMP)!({}, arg)

  it('REGRESSION: an invalid id is refused before the credential file is touched', () => {
    const hostile: unknown[] = [
      '..', '../x', 'a/../..', '..\\..\\.claude', 'C:\\Users\\nicho', '/etc/passwd', '', '.', 'P1',
      'x'.repeat(129), 'p1\0', { toString: () => 'p1' }, ['p1'], 42, null, undefined,
    ]
    for (const id of hostile) expect(stamp({ id }), JSON.stringify(id)).toEqual({ ok: false, stamp: null, signedIn: false })
    expect(stamp(undefined)).toEqual({ ok: false, stamp: null, signedIn: false })
    expect(stamp({})).toEqual({ ok: false, stamp: null, signedIn: false })
    expect(h.readProfileCredentialStamp).not.toHaveBeenCalled()
  })

  it('a valid id reads the stamp and returns exactly { ok, stamp, signedIn }', () => {
    expect(stamp({ id: 'profile-a1b2' })).toEqual({ ok: true, stamp: '1:2', signedIn: true })
    expect(h.readProfileCredentialStamp).toHaveBeenCalledWith('profile-a1b2')
  })
})

// R-006 + #48: a profile any live consumer holds cannot be deleted -- and the
// guard covers the WHOLE delete, not only its first instant (the web-session
// clear is awaited, and a session can spawn on the profile meanwhile).
describe('accountProfiles:delete — the in-use guard', () => {
  const del = (id: unknown) => handlers.get(IPC.ACCOUNT_PROFILES_DELETE)!({}, { id })
  const REFUSED = { ok: false, error: 'This account is in use by an open session. Close its sessions and try again.' }

  it('REGRESSION: a held profile is refused, and nothing is cleared or torn down', async () => {
    h.inUse.mockImplementation((id) => id === 'profile-held')
    expect(await del('profile-held')).toEqual(REFUSED)
    expect(h.clearWebSession).not.toHaveBeenCalled()
    expect(h.removeWebSession).not.toHaveBeenCalled()
    expect(h.safeTeardownProfile).not.toHaveBeenCalled()
  })

  it('a session that spawns on the profile DURING the web-session clear still stops the teardown; the cleared session\'s record goes with it', async () => {
    h.clearWebSession.mockImplementation(async () => { h.inUse.mockImplementation(() => true) })
    const r = await del('profile-racing')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/in use by an open session/)
    expect(r.error).toMatch(/sign-in was cleared/) // the user is told what did happen
    expect(h.clearWebSession).toHaveBeenCalledTimes(1)
    expect(h.removeWebSession).toHaveBeenCalledWith('profile-racing') // no record claiming a wiped partition survives
    expect(h.safeTeardownProfile).not.toHaveBeenCalled()
  })

  it('an idle profile is cleared, unrecorded and torn down, in that order', async () => {
    const order: string[] = []
    h.clearWebSession.mockImplementation(async () => { order.push('clear') })
    h.removeWebSession.mockImplementation(() => { order.push('remove') })
    h.safeTeardownProfile.mockImplementation(() => { order.push('teardown') })
    expect(await del('profile-idle')).toEqual({ ok: true })
    expect(order).toEqual(['clear', 'remove', 'teardown'])
  })

  it('an invalid id is refused before any of that', async () => {
    for (const id of ['..', '../x', '', 'P1', 42, undefined]) expect(await del(id), JSON.stringify(id)).toEqual({ ok: false, error: 'invalid profile id' })
    expect(h.clearWebSession).not.toHaveBeenCalled()
    expect(h.safeTeardownProfile).not.toHaveBeenCalled()
  })
})
