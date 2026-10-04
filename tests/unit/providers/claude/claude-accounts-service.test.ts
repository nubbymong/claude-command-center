// WP2 PR 4 review fix pass (A2-Q8, A2-S1, L2 U2.1): the provider-neutral
// accounts service composed with the REAL Claude package -- its discovery, its
// sign-in status and its sign-out -- over fake ports. [host] No CLI runs: the
// discovery's `--version` and the auth ports are fakes that record what the
// package hands them; the registry is in memory and Claude's accounts arrive
// through the legacy reconcile, exactly as at start.
//
// What it holds: nothing signs a Claude account out except the user's own Sign
// out (archive, activate, a check and the start-up settle never do, linked or
// not); a sign-out of this computer's own sign-in carries the user's
// acknowledgement or asks for it; the auth operations run only the executable
// discovery proved; and each result is recorded as a plain sign-out records it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// A link to the provider's own store can be absent for a record that is still
// a legacy one (the registry's isLegacyRecord counts its Claude profile home).
// The seam drops the links the SERVICE sees, for one call; the registry's own
// rules stay real.
const seam = vi.hoisted(() => ({ dropClaudeLinks: false }))
vi.mock('../../../../src/shared/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/shared/providers')>()
  return {
    ...real,
    isLegacyLinked: (doc: Parameters<typeof real.isLegacyLinked>[0], id: string) => (
      seam.dropClaudeLinks && doc.accounts.find((a) => a.id === id)?.providerId === 'claude' ? false : real.isLegacyLinked(doc, id)
    ),
  }
})

const { createClaudePackage } = await import('../../../../src/main/providers/claude')
type ClaudeAuthPorts = import('../../../../src/main/providers/claude').ClaudeAuthPorts
type ClaudeReviewPorts = import('../../../../src/main/providers/claude').ClaudeReviewPorts
type ClaudeProfileAuthStatus = import('../../../../src/main/providers/claude').ClaudeProfileAuthStatus
type ClaudeProfileLogout = import('../../../../src/main/providers/claude').ClaudeProfileLogout
const { AccountRegistryStore, AccountsService, ConsumerLeaseRegistry, SecretHandleStore, registerProviderPackage, _resetProviderRegistryForTest } = await import('../../../../src/main/providers/core')
type LegacyAccountsPort = import('../../../../src/main/providers/core').LegacyAccountsPort
const { findRealm, findAccount } = await import('../../../../src/shared/providers')
type ProviderRegistryDoc = import('../../../../src/shared/providers').ProviderRegistryDoc
type LegacyAccountSnapshot = import('../../../../src/shared/providers').LegacyAccountSnapshot
const { MemoryPort, claudeSnapshot, nextHex } = await import('../../../wp1/accounts-harness')

const P1 = 'profile-pri-111'
const P2 = 'profile-sec-222'
const EXE = 'C:\\Tools\\claude.exe'
type Op = { op: 'status' | 'logout'; id: string; executable: string; acknowledged?: boolean }

async function build(o: { found?: boolean; logout?: (id: string, acknowledged: boolean) => ClaudeProfileLogout; status?: (id: string) => ClaudeProfileAuthStatus } = {}) {
  let clock = 1_000_000
  const now = () => ++clock
  const leases = new ConsumerLeaseRegistry()
  const store = new AccountRegistryStore({ fs: new MemoryPort(), now, consumers: (id) => leases.count(id) })
  store.load()
  const calls: Op[] = []
  const signedIn = new Set<string>()
  const auth: ClaudeAuthPorts = {
    // compose.ts's rule: a snapshot read, only an active realm.
    lookupRealm: async (ref) => {
      const d = store.current()
      const r = d ? findRealm(d, ref.authRealmId) : undefined
      return r && r.lifecycle === 'active' ? { ok: true, realm: r } : { ok: false }
    },
    readStatus: async (id, executable) => {
      calls.push({ op: 'status', id, executable })
      return o.status ? o.status(id) : { authenticated: signedIn.has(id), source: 'cli-status' }
    },
    logout: async (id, input) => {
      calls.push({ op: 'logout', id, executable: input.executable, acknowledged: input.acknowledged })
      if (o.logout) return o.logout(id, input.acknowledged)
      // logoutClaudeCli's rule, as the real one applies it: the primary
      // profile's sign-out reaches this computer's own sign-in.
      if (id === P1 && !input.acknowledged) return { ran: false, after: null, refused: 'computer-sign-in' }
      signedIn.delete(id)
      return { ran: true, after: { authenticated: false, source: 'cli-status' } }
    },
  }
  // The package's discovery: a fixed file that answers --version (or none).
  const review: ClaudeReviewPorts = {
    lookupRealm: async () => ({ ok: false }),
    profileRealmLaunch: () => ({ refused: 'not under test' }),
    holdProfile: async () => null,
    recordPreflight: () => {},
    resolveExecutable: async () => (o.found === false ? null : EXE),
    fileStat: { realpath: (p) => p, stat: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '1', isFile: true }) },
    commandLine: (executable, args) => ({ file: executable, args: [...args], verbatim: false, cwd: 'C:\\Tools' }),
    shellEnv: () => ({}),
    run: async () => ({ exitCode: 0, stdout: '2.1.289 (Claude Code)\n', stderr: '', timedOut: false, truncated: false }),
    platform: 'win32',
  }
  const claude = createClaudePackage({ auth, review })
  _resetProviderRegistryForTest()
  registerProviderPackage(claude)
  let records: LegacyAccountSnapshot[] = [claudeSnapshot(P1, { isDefault: true }), claudeSnapshot(P2, { lifecycle: 'inactive' })]
  const legacy: LegacyAccountsPort = { providerId: 'claude', read: () => records, apply: () => {} }
  const seeded = await store.reconcileLegacy(legacy)
  if (!seeded.ok) throw new Error(`seed: ${seeded.message}`)
  const service = new AccountsService({
    store: () => store, leases, secrets: new SecretHandleStore({ now }), packages: () => [claude],
    preference: () => 'on', experimentalEnabled: () => [], platform: 'win32', randomHex: nextHex,
    reconcileLegacy: async () => { await store.reconcileLegacy(legacy) },
    log: () => {},
  })
  const doc = (): ProviderRegistryDoc => store.current()!
  const acct = (legacyId: string): string => {
    const link = doc().legacyLinks.find((x) => x.legacyId === legacyId)
    if (link) return link.accountId
    const realm = doc().realms.find((r) => r.pathRef === `claude-profile:${legacyId}`)
    return doc().accounts.find((a) => a.authRealmId === realm?.id)!.id
  }
  const state = (legacyId: string) => findAccount(doc(), acct(legacyId))?.lastKnownAuthState
  return { store, service, calls, signedIn, doc, acct, state, setRecords: (r: LegacyAccountSnapshot[]) => { records = r }, reconcile: () => store.reconcileLegacy(legacy) }
}

beforeEach(() => { seam.dropClaudeLinks = false })

describe('the accounts service never signs a Claude account out on its own [host]', () => {
  it('the composed package offers status and sign-out, so the service gate is open for Claude', async () => {
    const h = await build()
    const view = h.service.snapshot().providers.find((p) => p.providerId === 'claude')!
    expect(view.status.enabled).toBe(true)
    expect(view.logout.enabled).toBe(true)
  })

  it('archive of an inactive signed-in Claude account runs no check and no sign-out; the registry refuses it', async () => {
    const h = await build()
    h.signedIn.add(P2)
    const r = await h.service.setLifecycle({ accountId: h.acct(P2), lifecycle: 'archived' })
    expect(r.ok).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.signedIn.has(P2)).toBe(true)
    // An acknowledgement changes nothing.
    expect((await h.service.setLifecycle({ accountId: h.acct(P2), lifecycle: 'archived', acknowledgeExternal: true })).ok).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('activating an inactive Claude account runs no check on its behalf', async () => {
    const h = await build()
    expect(await h.service.setLifecycle({ accountId: h.acct(P2), lifecycle: 'active' })).toEqual({ ok: true })
    expect(h.calls).toEqual([])
  })

  it('a record that is a legacy one without its link (the registry\'s own rule) still takes the legacy branch: no check, no sign-out', async () => {
    const h = await build()
    h.signedIn.add(P2)
    seam.dropClaudeLinks = true
    const archived = await h.service.setLifecycle({ accountId: h.acct(P2), lifecycle: 'archived' })
    const activated = await h.service.setLifecycle({ accountId: h.acct(P2), lifecycle: 'active' })
    seam.dropClaudeLinks = false
    expect(archived.ok).toBe(false)
    expect(activated.ok).toBe(true)
    expect(h.calls).toEqual([])
    expect(h.signedIn.has(P2)).toBe(true)
  })

  it('a check, a reconcile and the start-up settle run a status at most, from the proved executable, never a sign-out', async () => {
    const h = await build()
    h.signedIn.add(P2)
    expect(await h.service.refreshStatus({ accountId: h.acct(P2) })).toEqual({ ok: true, state: 'signed-in' })
    expect(await h.service.reconcileSignIn({ accountId: h.acct(P2) })).toEqual({ ok: true, state: 'signed-in' })
    await h.service.settleLeftoverSignIns()
    expect(h.calls).toEqual([{ op: 'status', id: P2, executable: EXE }, { op: 'status', id: P2, executable: EXE }])
  })

  it('a check whose CLI did not answer records nothing (a negative answer from the credential file is no state)', async () => {
    const h = await build({ status: () => ({ authenticated: false, source: 'credential-file' }) })
    const before = h.state(P2)
    const r = await h.service.refreshStatus({ accountId: h.acct(P2) })
    expect(r).toMatchObject({ ok: false, code: 'status-unrecognised' })
    expect(h.state(P2)).toBe(before)
  })
})

describe('the user\'s Sign out of a Claude account through the service [host]', () => {
  it('the primary profile (this computer\'s own sign-in) asks for the acknowledgement, records nothing, then signs out with it', async () => {
    const h = await build()
    h.signedIn.add(P1)
    const before = h.state(P1)
    const asked = await h.service.logout({ accountId: h.acct(P1) })
    expect(asked).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect((asked as { message?: string }).message).toMatch(/outside the app/)
    expect(h.state(P1)).toBe(before)
    expect(h.signedIn.has(P1)).toBe(true)
    expect(h.calls).toEqual([{ op: 'logout', id: P1, executable: EXE, acknowledged: false }])
    h.calls.length = 0
    expect(await h.service.logout({ accountId: h.acct(P1), acknowledgeExternal: true })).toEqual({ ok: true, state: 'signed-out' })
    expect(h.calls).toEqual([{ op: 'logout', id: P1, executable: EXE, acknowledged: true }])
    expect(h.state(P1)).toBe('signed-out')
  })

  it('another profile signs out without one, from the proved executable', async () => {
    const h = await build()
    h.signedIn.add(P2)
    expect(await h.service.logout({ accountId: h.acct(P2) })).toEqual({ ok: true, state: 'signed-out' })
    expect(h.calls).toEqual([{ op: 'logout', id: P2, executable: EXE, acknowledged: false }])
    expect(h.state(P2)).toBe('signed-out')
  })

  it('with no Claude executable proved, neither a sign-out nor a check runs (cli-unavailable)', async () => {
    const h = await build({ found: false })
    expect(await h.service.discover('claude')).toMatchObject({ ok: true })
    expect(await h.service.logout({ accountId: h.acct(P2) })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(await h.service.refreshStatus({ accountId: h.acct(P2) })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(h.calls).toEqual([])
  })

  it('records what a sign-out left: in use records nothing, timed out records unknown, still signed in records signed-in', async () => {
    const inUse = await build({ logout: () => ({ ran: false, after: null, refused: 'in-use' }) })
    const before = inUse.state(P2)
    expect(await inUse.service.logout({ accountId: inUse.acct(P2) })).toMatchObject({ ok: false, code: 'busy' })
    expect(inUse.state(P2)).toBe(before)
    const slow = await build({ logout: () => ({ ran: true, after: null, timedOut: true }) })
    expect(await slow.service.logout({ accountId: slow.acct(P2) })).toMatchObject({ ok: false, code: 'timed-out' })
    expect(slow.state(P2)).toBe('unknown')
    const still = await build({ logout: () => ({ ran: true, after: { authenticated: true, source: 'cli-status' } }) })
    expect(await still.service.logout({ accountId: still.acct(P2) })).toMatchObject({ ok: false, code: 'still-signed-in' })
    expect(still.state(P2)).toBe('signed-in')
  })
})
