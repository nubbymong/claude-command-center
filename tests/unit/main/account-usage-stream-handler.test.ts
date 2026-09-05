// The streaming usage IPC (plan P3): the renderer opens a private reply channel
// and passes its name; each account's usage is sent back on it AS IT RESOLVES.
// The channel names only where to send on the CALLER's OWN webContents, but it is
// prefix- and length-checked so a stray value cannot address an unrelated
// ipcRenderer listener in that same renderer. These pin the validation and the
// per-result send.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import type { AccountUsage } from '../../../src/shared/usage-types'

const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

// A scripted streaming source: emits the profiles listed in `emit`.
const emit: AccountUsage[] = []
const usage = (profileId: string): AccountUsage => ({
  profileId, email: null, name: profileId, isPrimary: false, active: true,
  status: 'ok', buckets: [], fetchedAt: 0,
})
const fetchAllAccountsUsageStreaming = vi.fn(async (onResult: (u: AccountUsage) => void) => {
  for (const u of emit) onResult(u)
})
vi.mock('../../../src/main/usage/account-usage', () => ({
  fetchAllAccountsUsage: vi.fn(), fetchAccountUsage: vi.fn(),
  fetchAllAccountsUsageStreaming: (cb: (u: AccountUsage) => void) => fetchAllAccountsUsageStreaming(cb),
}))
vi.mock('../../../src/main/account-profiles', () => ({
  listProfiles: () => [], upsertProfile: vi.fn(),
  isValidProfileId: (id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id),
  safeTeardownProfile: vi.fn(), readProfileAccountEmail: vi.fn(), getProfileConfigDir: vi.fn(),
  createProfile: vi.fn(), captureDetectedAccount: vi.fn(), backupProfileHomeToCanonical: vi.fn(),
  restoreProfileHomeFromCanonical: vi.fn(), readProfileCredentialStamp: vi.fn(),
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  getAccountIdentity: vi.fn(), getDefaultAccountEmail: vi.fn(),
  getWatchedProfileId: vi.fn(), isProfileInUseByLiveSession: vi.fn(() => false),
}))
vi.mock('../../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: vi.fn(() => []) }))
vi.mock('../../../src/main/debug-logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('../../../src/main/account-web/sign-in', () => ({ clearWebSession: vi.fn() }))
vi.mock('../../../src/main/account-web/session-store', () => ({ removeWebSession: vi.fn() }))
vi.mock('../../../src/main/account-web/artifacts', () => ({ closeArtifacts: vi.fn() }))
vi.mock('../../../src/main/account-web/account-pane', () => ({ closeAccountPanesForProfile: vi.fn() }))

const { registerAccountProfilesHandlers } = await import('../../../src/main/ipc/account-profiles-handlers')

function fakeEvent() {
  const sent: Array<{ channel: string; usage: AccountUsage }> = []
  return { sent, sender: { isDestroyed: () => false, send: (channel: string, u: AccountUsage) => sent.push({ channel, usage: u }) } }
}
const CH = 'accountUsage:result:abc123'

beforeEach(() => {
  handlers.clear()
  emit.length = 0
  fetchAllAccountsUsageStreaming.mockClear()
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
    expect(ev.sent.map((s) => s.usage.profileId)).toEqual(['a', 'b', 'c'])
  })

  it('refuses a channel that is not the accountUsage:result: prefix, and streams nothing', async () => {
    emit.push(usage('a'))
    for (const channel of ['pty:data:evil', 'accountProfiles:list', '', 42 as unknown as string, undefined]) {
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
    const sent: unknown[] = []
    const ev = { sender: { isDestroyed: () => true, send: (..._a: unknown[]) => sent.push(_a) } }
    await runStream(ev, { channel: CH })
    expect(sent).toEqual([])
  })
})
