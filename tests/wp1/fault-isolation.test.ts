// WP1.59 / WP1.3 -- WP2 commit 3 (design 13, 16.5): no failed Codex operation
// changes Claude's accounts, and no failed Claude operation changes Codex's.
// Each Codex operation the accounts service runs is made to fail -- a missing
// CLI, a refused or cancelled sign-in, a status the CLI cannot give, a
// sign-out that fails, a folder that cannot be made or removed, a write that
// fails, the adoption of the default home -- and Claude's side of the
// registry is compared byte for byte before and after. The inverse: a
// Claude legacy list that cannot be read, and a refused Claude change, leave
// Codex's side as it was. And the two providers are verified independently:
// Codex being off or missing does not make Claude unusable.
//
// PURE.
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, claudeSnapshot, claudeSide, EXT_HOME } from './accounts-harness'
import type { Harness } from './accounts-harness'
import type { ProviderRegistryDoc } from '../../src/shared/providers'

const CLAUDE = [claudeSnapshot('profile-a1', { isDefault: true }), claudeSnapshot('profile-b2', { colourKey: 'indigo' })]

function codexSide(doc: ProviderRegistryDoc): string {
  const accounts = doc.accounts.filter((a) => a.providerId === 'codex')
  const ids = new Set(accounts.map((a) => a.identityId))
  return JSON.stringify({
    accounts, realms: doc.realms.filter((r) => r.providerId === 'codex'),
    identities: doc.identities.filter((i) => ids.has(i.id)),
    journals: doc.journals.filter((j) => j.providerId === 'codex'),
    migrations: doc.migrations.filter((m) => m.providerId === 'codex'),
  })
}

async function codexFailures(h: Harness, managed: string): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = []
  const run = async (label: string, f: () => Promise<unknown> | unknown) => { out.push([label, await f()]) }
  const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
  const pending = (begun as { accountId: string }).accountId
  await run('sign-in refused', () => h.service.signIn({ accountId: pending, method: 'browser' }, 1))
  await run('complete not signed in', () => h.service.completeSetup({ accountId: pending, identity: { mode: 'new', colourKey: 'violet' } }))
  await run('status fails', () => h.service.refreshStatus({ accountId: managed }))
  await run('sign-out fails', () => h.service.logout({ accountId: managed }))
  const realRmdir = h.folders.fs.rmdir
  h.folders.fs.rmdir = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
  await run('removal fails', () => h.service.abandonSetup({ accountId: pending }))
  h.folders.fs.rmdir = realRmdir
  const realMk = h.folders.fs.mkdirSecure
  const realMkdir = h.folders.fs.mkdir
  h.folders.fs.mkdirSecure = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
  h.folders.fs.mkdir = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
  await run('folder cannot be made', () => h.service.beginSetup({ providerId: 'codex', method: 'browser' }))
  h.folders.fs.mkdirSecure = realMk
  h.folders.fs.mkdir = realMkdir
  await run('archive of an active account', () => h.service.setLifecycle({ accountId: managed, lifecycle: 'archived' }))
  await run('adoption, signed out', () => h.service.adoptExternalDefault({ providerId: 'codex' }))
  await run('one-time adoption', () => h.service.migrateExternalDefault('codex'))
  h.port.failWrites = [h.port.writes + 1, h.port.writes + 2, h.port.writes + 3]
  await run('write fails', () => h.service.beginSetup({ providerId: 'codex', method: 'browser' }))
  h.port.failWrites = []
  h.state.cli = false
  await run('CLI missing', () => h.service.discover('codex'))
  return out
}

describe('fault isolation (WP1.59)', () => {
  it('every failing Codex operation leaves Claude\'s records byte for byte as they were', async () => {
    let broken = false
    const h: Harness = await harness({
      claude: CLAUDE,
      script: {
        // A status the CLI cannot give, once broken.
        'login status': (r) => (broken ? { exitCode: 2, stderr: 'error: config\n' } : h.signedIn.has(r.home.toLowerCase()) ? { exitCode: 0, stderr: 'Logged in using ChatGPT\n' } : { exitCode: 1, stderr: 'Not logged in\n' }),
        'login': () => ({ exitCode: 1, stderr: 'refused\n' }),
        'logout': () => ({ exitCode: 1, stderr: 'network down\n' }),
      },
    })
    // A signed-in managed account whose later status and sign-out fail.
    h.signedIn.clear()
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const accountId = (b as { accountId: string }).accountId
    const realmId = h.doc().journals[0].realmId
    h.signedIn.set(`c:\\res\\codex-realms\\${realmId}`, 'chatgpt')
    expect((await h.service.completeSetup({ accountId, identity: { mode: 'new', friendlyName: 'M', colourKey: 'violet' } })).ok).toBe(true)
    const before = claudeSide(h.doc())
    const claudeFile = JSON.stringify(JSON.parse(h.port.file!).accounts.filter((a: { providerId: string }) => a.providerId === 'claude'))
    // Status fails from here on.
    broken = true
    const results = await codexFailures(h, accountId)
    for (const [label] of results) expect(claudeSide(h.doc()), label).toBe(before)
    expect(results.filter(([, r]) => (r as { ok: boolean }).ok === false).length).toBeGreaterThanOrEqual(8)
    expect(JSON.stringify(JSON.parse(h.port.file!).accounts.filter((a: { providerId: string }) => a.providerId === 'claude'))).toBe(claudeFile)
    // Claude is still the provider it was: on, and its accounts selectable.
    const snap = h.service.snapshot()
    expect(snap.providers.find((p) => p.providerId === 'claude')!.enabled).toBe(true)
    expect(snap.accounts.filter((a) => a.providerId === 'claude').map((a) => a.lifecycle)).toEqual(['active', 'active'])
  })

  it('a Claude list that cannot be read, and a refused Claude change, leave Codex\'s records as they were', async () => {
    const h = await harness({ claude: CLAUDE })
    await addCodexAccount(h, 'Codex one')
    const before = codexSide(h.doc())
    // The Claude list goes unreadable: its reconcile refuses, nothing moves.
    h.setClaude(null as never)
    const claudeAccount = h.doc().accounts.find((a) => a.providerId === 'claude' && !a.isProviderDefault)!
    const refused = await h.service.setLifecycle({ accountId: claudeAccount.id, lifecycle: 'archived' })
    expect(refused).toMatchObject({ ok: false })
    const renamed = await h.service.updateIdentity({ identityId: claudeAccount.identityId, friendlyName: 'Renamed' })
    expect(renamed.ok).toBe(true)
    expect(codexSide(h.doc())).toBe(before)
  })

  it('the saved on/off is read three-way from each package\'s own enablement data, and the last provider on stays on', async () => {
    const { providerPreferenceFromSettings } = await import('../../src/main/provider-accounts')
    const h = await harness()
    const codex = h.codex.enablement!
    const claude = h.claude.enablement!
    expect([true, false, undefined, 'yes', 1].map((v) => providerPreferenceFromSettings(codex, v === undefined ? {} : { codexEnabled: v }))).toEqual(['on', 'off', 'undecided', 'undecided', 'undecided'])
    expect([true, false, undefined].map((v) => providerPreferenceFromSettings(claude, v === undefined ? {} : { claudeEnabled: v }))).toEqual(['on', 'off', 'on'])
    // Unreadable settings are no answer, never a yes; no data at all is on.
    expect(providerPreferenceFromSettings(codex, null)).toBe('undecided')
    expect(providerPreferenceFromSettings(undefined, { codexEnabled: false })).toBe('on')
    // An inherited property is not a saved answer.
    expect(providerPreferenceFromSettings(codex, Object.create({ codexEnabled: true }))).toBe('undecided')
    // With Claude off, Codex is the last provider on: it cannot be switched off.
    const last = await harness({ preference: { claude: 'off' } })
    expect(await last.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'last-provider' })
    expect(last.service.isEnabled('codex')).toBe(true)
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    expect(h.service.snapshot().providers.find((p) => p.providerId === 'codex')).toMatchObject({ enabled: false, preference: 'off' })
  })

  it('an identity edit a legacy list mirrors is written through now; one it does not mirror is not', async () => {
    const h = await harness({ claude: CLAUDE })
    const reconciles: string[] = []
    const original = h.store.reconcileLegacy.bind(h.store)
    h.store.reconcileLegacy = (port) => { reconciles.push(port.providerId); return original(port) }
    const claudeAccount = h.doc().accounts.find((a) => a.providerId === 'claude')!
    expect((await h.service.updateIdentity({ identityId: claudeAccount.identityId, colourKey: 'plum' })).ok).toBe(true)
    expect(reconciles).toEqual(['claude'])
    const codexId = await addCodexAccount(h, 'C')
    reconciles.length = 0
    const codexIdentity = h.doc().accounts.find((a) => a.id === codexId)!.identityId
    expect((await h.service.updateIdentity({ identityId: codexIdentity, friendlyName: 'Renamed' })).ok).toBe(true)
    expect(reconciles).toEqual([])
  })

  it('Codex off or missing does not make Claude unusable, and the two are checked independently', async () => {
    for (const o of [{ preference: { codex: 'off' as const } }, { cli: false }]) {
      const h = await harness({ claude: CLAUDE, ...o })
      await h.service.discover('codex')
      const snap = h.service.snapshot()
      const claude = snap.providers.find((p) => p.providerId === 'claude')!
      expect(claude.enabled, JSON.stringify(o)).toBe(true)
      expect(snap.accounts.filter((a) => a.providerId === 'claude' && a.lifecycle === 'active')).toHaveLength(2)
      const claudeAccount = h.doc().accounts.find((a) => a.providerId === 'claude')!
      const lease = await h.service.acquireLaunchLease({ kind: 'session', providerId: 'claude', providerAccountId: claudeAccount.id, ownerId: 'c1' })
      expect(lease.ok, JSON.stringify(o)).toBe(true)
      expect(h.runs.some((r) => r.home === EXT_HOME)).toBe(false)
    }
  })
})
