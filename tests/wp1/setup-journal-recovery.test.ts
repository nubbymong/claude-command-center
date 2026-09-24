// WP1.47 -- WP2 commit 3 (design 9.3, 13): adding a managed Codex account
// through the accounts service. The ids and the folder exist before any
// sign-in; the account exists only after the realm's own status says it is
// signed in; an interrupted setup -- including one interrupted after the CLI
// wrote credentials -- stays visible and is recovered (finished, or signed
// out and removed), never silently dropped or left unmanaged.
//
// PURE: the real Codex package on a fake CLI, an in-memory folder tree and an
// in-memory registry (./accounts-harness).
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, managedHome, EXT_HOME, KEY, MemoryPort } from './accounts-harness'
import { findRealm } from '../../src/shared/providers'

describe('adding a managed Codex account (WP1.47)', () => {
  it('reserves the ids and creates the folder first, signs in there, and commits only what status verifies', async () => {
    const h = await harness()
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    expect(begun.ok).toBe(true)
    const accountId = (begun as { accountId: string }).accountId
    const journal = h.doc().journals.find((j) => j.accountId === accountId)!
    expect(journal).toMatchObject({ providerId: 'codex', method: 'browser', state: 'pending' })
    const home = managedHome(journal.realmId)
    expect(h.folders.exists(home)).toBe(true)
    // Nothing selectable yet.
    expect(h.service.snapshot().accounts).toEqual([])
    expect(h.service.snapshot().pendingSetups).toEqual([expect.objectContaining({ accountId, state: 'pending', external: false, signingIn: false })])

    const output: string[] = []
    const signed = await h.service.signIn({ accountId, method: 'browser' }, 1, (t) => output.push(t))
    expect(signed).toEqual({ ok: true, state: 'signed-in' })
    expect(output.join('')).toContain('Starting local login server')
    // Credentials may now exist: the journal says so.
    expect(h.doc().journals.find((j) => j.accountId === accountId)?.state).toBe('credentials-written')

    const done = await h.service.completeSetup({ accountId, identity: { mode: 'new', friendlyName: 'Work', colourKey: 'violet' } })
    expect(done).toEqual({ ok: true, accountId })
    const d = h.doc()
    const account = d.accounts.find((a) => a.id === accountId)!
    expect(account).toMatchObject({ providerId: 'codex', lifecycle: 'active', isProviderDefault: true, authMethod: 'browser', identityAssurance: 'user-asserted', lastKnownAuthState: 'signed-in' })
    expect(findRealm(d, account.authRealmId)).toMatchObject({ lifecycle: 'active', ownership: 'conductor-managed' })
    expect(d.identities.find((i) => i.id === account.identityId)).toMatchObject({ friendlyName: 'Work', colourKey: 'violet' })
    expect(d.journals).toEqual([])
    // Every CLI run happened in the account's own home, never the user's.
    expect(new Set(h.runs.map((r) => r.home))).toEqual(new Set([home]))
    expect(h.runs.some((r) => r.home === EXT_HOME)).toBe(false)
    expect(h.args()).toEqual(['login status', 'login', 'login status', 'login status'])
  })

  it('an API-key sign-in takes the key once by handle, and records the method the realm reports', async () => {
    const h = await harness()
    const id = await addCodexAccount(h, 'Key', 'apiKey')
    expect(h.doc().accounts.find((a) => a.id === id)).toMatchObject({ authMethod: 'apiKey' })
    const login = h.runs.find((r) => r.args === 'login --with-api-key')!
    expect(login.opts.stdin).toBe(`${KEY}\n`)
    expect(h.secrets.size()).toBe(0)
  })

  it('a second account is not the default; each has its own folder', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const d = h.doc()
    expect(d.accounts.map((x) => [x.id, x.isProviderDefault])).toEqual([[a, true], [b, false]])
    const ra = findRealm(d, d.accounts[0].authRealmId)!
    const rb = findRealm(d, d.accounts[1].authRealmId)!
    expect(ra.id).not.toBe(rb.id)
    expect(h.folders.exists(managedHome(ra.id)) && h.folders.exists(managedHome(rb.id))).toBe(true)
  })

  it('a setup interrupted after the CLI wrote credentials is recovered after a restart: finished, or signed out and removed', async () => {
    for (const how of ['finish', 'remove'] as const) {
      const port = new MemoryPort()
      const first = await harness({ port })
      const begun = await first.service.beginSetup({ providerId: 'codex', method: 'browser' })
      const accountId = (begun as { accountId: string }).accountId
      expect((await first.service.signIn({ accountId, method: 'browser' }, 1)).ok).toBe(true)
      // The app stops here. A restart reads the journal from disk.
      const again = await harness({ port })
      // The CLI's sign-in lives in the realm folder, which survived.
      for (const [home, via] of first.signedIn) again.signedIn.set(home, via)
      for (const dir of first.folders.dirs) again.folders.dirs.add(dir)
      const pending = again.service.snapshot().pendingSetups
      expect(pending, how).toEqual([expect.objectContaining({ accountId, state: 'credentials-written' })])
      const realmId = again.doc().journals[0].realmId
      if (how === 'finish') {
        expect(await again.service.completeSetup({ accountId, identity: { mode: 'new', friendlyName: 'Recovered', colourKey: 'violet' } })).toEqual({ ok: true, accountId })
        expect(again.doc().accounts.map((a) => a.id)).toEqual([accountId])
      } else {
        expect(await again.service.abandonSetup({ accountId })).toEqual({ ok: true })
        // Signed out through the CLI first, then the folder, then the journal.
        expect(again.args()).toEqual(['login status', 'logout', 'login status'])
        expect(again.folders.exists(managedHome(realmId))).toBe(false)
        const rm = again.folders.log.findIndex((l) => l.startsWith('rmdir') && l.toLowerCase().includes(realmId))
        expect(rm).toBeGreaterThanOrEqual(0)
        expect(again.doc().journals).toEqual([])
        expect(again.doc().realms).toEqual([])
      }
    }
  })

  it('a folder that cannot be removed keeps the journal: nothing is left unmanaged', async () => {
    const h = await harness()
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const accountId = (begun as { accountId: string }).accountId
    const realOne = h.folders.fs.rmdir
    h.folders.fs.rmdir = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
    const r = await h.service.abandonSetup({ accountId })
    h.folders.fs.rmdir = realOne
    expect(r.ok).toBe(false)
    expect(h.doc().journals.map((j) => j.accountId)).toEqual([accountId])
    expect(h.service.snapshot().pendingSetups).toHaveLength(1)
    // And once the folder can go, it goes.
    expect(await h.service.abandonSetup({ accountId })).toEqual({ ok: true })
  })

  it('a sign-out that fails keeps the journal and the folder', async () => {
    const h = await harness({ script: { 'logout': () => ({ exitCode: 1, stderr: 'network down\n' }) } })
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const accountId = (begun as { accountId: string }).accountId
    await h.service.signIn({ accountId, method: 'browser' }, 1)
    const realmId = h.doc().journals[0].realmId
    const r = await h.service.abandonSetup({ accountId })
    expect(r.ok).toBe(false)
    expect(h.doc().journals).toHaveLength(1)
    expect(h.folders.exists(managedHome(realmId))).toBe(true)
  })

  it('completing a setup whose realm is not signed in commits nothing', async () => {
    const h = await harness()
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const accountId = (begun as { accountId: string }).accountId
    const r = await h.service.completeSetup({ accountId, identity: { mode: 'new', colourKey: 'violet' } })
    expect(r).toMatchObject({ ok: false, code: 'not-signed-in', state: 'signed-out' })
    expect(h.doc().accounts).toEqual([])
    expect(h.doc().journals).toHaveLength(1)
  })

  it('a failed or cancelled sign-in leaves the setup for a retry; a sign-in that finished anyway is recorded', async () => {
    const refused = await harness({ script: { 'login': () => ({ exitCode: 1, stderr: 'workspace does not allow this sign-in\n' }) } })
    const b1 = await refused.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const a1 = (b1 as { accountId: string }).accountId
    expect(await refused.service.signIn({ accountId: a1, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'provider-refused' })
    expect(refused.doc().journals[0]).toMatchObject({ accountId: a1, state: 'pending' })
    expect(refused.leases.count(a1)).toBe(0)

    const anyway = await harness({ script: { 'login': (r) => { anyway.signedIn.set(r.home.toLowerCase(), 'chatgpt'); return { spawnError: 'cancelled' } } } })
    const b2 = await anyway.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const a2 = (b2 as { accountId: string }).accountId
    expect(await anyway.service.signIn({ accountId: a2, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'cancelled', state: 'signed-in' })
    expect(anyway.doc().journals[0]).toMatchObject({ accountId: a2, state: 'credentials-written' })
  })

  it('one sign-in per setup at a time, and no removal while it runs', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await harness({ script: { 'login': async (r) => { await gate; h.signedIn.set(r.home.toLowerCase(), 'chatgpt'); return { exitCode: 0 } } } })
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const accountId = (begun as { accountId: string }).accountId
    const first = h.service.signIn({ accountId, method: 'browser' }, 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.service.snapshot().pendingSetups[0].signingIn).toBe(true)
    expect(await h.service.signIn({ accountId, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'busy' })
    expect(await h.service.abandonSetup({ accountId })).toMatchObject({ ok: false, code: 'busy' })
    expect(await h.service.completeSetup({ accountId, identity: { mode: 'new', colourKey: 'violet' } })).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect((await first).ok).toBe(true)
    expect(h.leases.count(accountId)).toBe(0)
  })

  it('a folder that cannot be prepared leaves no journal behind when it is empty', async () => {
    const h = await harness()
    const real = h.folders.fs.mkdir
    h.folders.fs.mkdir = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    const realSecure = h.folders.fs.mkdirSecure
    h.folders.fs.mkdirSecure = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    const r = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    h.folders.fs.mkdir = real
    h.folders.fs.mkdirSecure = realSecure
    expect(r.ok).toBe(false)
    expect(h.doc().journals).toEqual([])
    expect(h.doc().realms).toEqual([])
  })

  it('a setup is refused when the provider is off, the method is not enabled, or the provider keeps its own accounts', async () => {
    const off = await harness({ preference: { codex: 'off' } })
    expect(await off.service.beginSetup({ providerId: 'codex', method: 'browser' })).toMatchObject({ ok: false, code: 'provider-disabled' })
    const h = await harness()
    // Device sign-in is experimental: off until the owner enables it.
    expect(await h.service.beginSetup({ providerId: 'codex', method: 'device' })).toMatchObject({ ok: false, code: 'capability-disabled' })
    expect(h.service.snapshot().providers.find((p) => p.providerId === 'codex')!.signInMethods.device).toEqual({ enabled: false, labelExperimental: true })
    expect(await h.service.beginSetup({ providerId: 'claude', method: 'browser' })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(h.doc().journals).toEqual([])
    const enabled = await harness({ experimental: ['codex:auth.device'] })
    const b = await enabled.service.beginSetup({ providerId: 'codex', method: 'device' })
    expect(b.ok).toBe(true)
    expect(enabled.service.snapshot().providers.find((p) => p.providerId === 'codex')!.signInMethods.device).toEqual({ enabled: true, labelExperimental: true })
    expect(await enabled.service.signIn({ accountId: (b as { accountId: string }).accountId, method: 'device' }, 1)).toEqual({ ok: true, state: 'signed-in' })
  })

  it('a sign-in never runs into the external home, and a pending external adoption cannot be signed into', async () => {
    const h = await harness()
    const adopted = await h.service.adoptExternalDefault({ providerId: 'codex' })
    expect(adopted).toMatchObject({ ok: false, code: 'not-signed-in' })
    expect(h.doc().journals).toEqual([])
    expect(h.runs.every((r) => r.args === 'login status')).toBe(true)
  })
})
