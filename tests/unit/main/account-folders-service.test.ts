// [host] WP2 PR 4, P4.4 (rows 55, 56): where each account's own folders come
// from. The Codex package names a realm's log folder, memories folder and
// settings file only when its home is a folder at exactly its own path (the
// launch's canonical-home check, as usageSessionsDir), and the accounts
// service lists them for each live account with whose they are. PURE: the
// in-memory accounts harness of tests/wp1 (no real folder, no CLI).
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, managedHome, EXT_HOME } from '../../wp1/accounts-harness'
import type { Harness } from '../../wp1/accounts-harness'
import { createCodexAuthOperations } from '../../../src/main/providers/codex/auth-operations'

const realmOf = (h: Harness, accountId: string) => h.doc().accounts.find((a) => a.id === accountId)!.authRealmId
const foldersOf = (home: string) => ({ logDir: `${home}\\log`, memoriesDir: `${home}\\memories`, configFile: `${home}\\config.toml` })
type Row = { providerId: string; accountId: string; external: boolean; logDir: string; memoriesDir: string; configFile: string }
const byAccount = (rows: Row[] | null) => [...(rows ?? [])].sort((x, y) => x.accountId.localeCompare(y.accountId))

describe('the Codex package names a realm\'s own folders (launch.accountFolders)', () => {
  it('the log folder, memories folder and settings file of the realm\'s home, exactly as sessionsDir locates it', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const ref = { authRealmId: realmOf(h, a) }
    expect(await h.codex.launch!.accountFolders!(ref)).toEqual(foldersOf(managedHome(realmOf(h, a))))
    expect(await h.codex.launch!.sessionsDir(ref)).toBe(`${managedHome(realmOf(h, a))}\\sessions`)
  })

  it('none for a home linked elsewhere (its real path is not its own), a missing home, or an unknown realm', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const homeA = managedHome(realmOf(h, a))
    const homeB = managedHome(realmOf(h, b))
    const realpath = h.folders.fs.realpath
    // B's home is a junction into A's.
    h.folders.fs.realpath = (p: string) => (p.toLowerCase() === homeB.toLowerCase() ? homeA : realpath(p))
    expect(await h.codex.launch!.accountFolders!({ authRealmId: realmOf(h, b) })).toBeNull()
    expect(await h.codex.launch!.accountFolders!({ authRealmId: realmOf(h, a) })).toEqual(foldersOf(homeA))
    h.folders.fs.realpath = realpath
    h.folders.dirs.delete(homeB.toLowerCase())
    expect(await h.codex.launch!.accountFolders!({ authRealmId: realmOf(h, b) })).toBeNull()
    expect(await h.codex.launch!.accountFolders!({ authRealmId: 'realm-0000000000000000000000000000000f' })).toBeNull()
    expect(await h.codex.launch!.accountFolders!(null as never)).toBeNull()
  })

  it('the canonical-home check reads a case-only difference by the account-folder real-path rule (P4.4 review B-3): a non-ASCII case pair is the same home where the folder reads both spellings as one entry, the Kelvin sign another', async () => {
    // The auth operations alone, the realm record and the home's identity given.
    const opsFor = (home: string, canonical: string) => createCodexAuthOperations({
      lookupRealm: async (ref: { authRealmId: string }) => ({
        ok: true,
        realm: { id: ref.authRealmId, providerId: 'codex', kind: 'codex-home', ownership: 'external-default', pathRef: 'external-default' },
        roots: { resourcesDir: 'C:\\res', externalDefaultHome: home },
      }),
      realmIdentity: () => ({ canonical, dev: '1', ino: '2', isDirectory: true }),
      // Every spelling of a name is the folder's one entry (a case-insensitive folder).
      folderFs: { lstat: async () => ({ dev: 1n, ino: 2n }), realpath: async (p: string) => p },
      executablePorts: { platform: 'win32' },
    } as never)
    const ref = { authRealmId: 'realm-ext' }
    // Its real path in another case, a non-ASCII letter included: the same home.
    const named = 'c:\\users\\\u00f6zil\\.codex'
    expect(await opsFor(named, 'C:\\Users\\\u00d6zil\\.codex').accountFolders(ref)).toEqual(foldersOf(named))
    // Its real path naming the Kelvin sign where the home has k: to Windows
    // another folder, so not the home's own path.
    const nik = opsFor('C:\\Users\\Nik\\.codex', 'C:\\Users\\Ni\u212a\\.codex')
    expect(await nik.accountFolders(ref)).toBeNull()
    expect(await nik.usageSessionsDir(ref)).toBeNull()
  })
})

describe('AccountsService.accountFolders', () => {
  it('names each live account\'s folders, marks this computer\'s own sign-in, and leaves an archived account\'s out', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const ext = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!ext.ok) throw new Error(ext.code)
    expect(byAccount(await h.service.accountFolders())).toEqual(byAccount([
      { providerId: 'codex', accountId: a, external: false, ...foldersOf(managedHome(realmOf(h, a))) },
      { providerId: 'codex', accountId: b, external: false, ...foldersOf(managedHome(realmOf(h, b))) },
      { providerId: 'codex', accountId: ext.accountId, external: true, ...foldersOf(EXT_HOME) },
    ]))
    // An inactive account keeps its folders (its logs and memories are real);
    // archiving retires the realm.
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect((await h.service.accountFolders())?.map((r) => r.accountId)).toContain(b)
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'archived' })).ok).toBe(true)
    expect((await h.service.accountFolders())?.map((r) => r.accountId)).not.toContain(b)
  })

  it('null before the registry is read, none once it cannot be; a realm that cannot be located is left out', async () => {
    let settled = false
    const h = await harness({ registrySettled: () => settled })
    const a = await addCodexAccount(h, 'A')
    const store = h.store
    h.useStore(null)
    expect(await h.service.accountFolders()).toBeNull()
    settled = true
    expect(await h.service.accountFolders()).toEqual([])
    h.useStore(store)
    const launch = h.codex.launch!
    const real = launch.accountFolders
    ;(launch as { accountFolders: unknown }).accountFolders = async () => { throw new Error('boom') }
    expect(await h.service.accountFolders()).toEqual([])
    ;(launch as { accountFolders: unknown }).accountFolders = async () => ({ logDir: '', memoriesDir: 'x', configFile: 'y' })
    expect(await h.service.accountFolders()).toEqual([])
    ;(launch as { accountFolders: unknown }).accountFolders = real
    expect((await h.service.accountFolders())?.map((r) => r.accountId)).toEqual([a])
  })

  it('not a setup still under way (signed in, its folder made, not yet completed), and nothing for a provider whose package names no folders', async () => {
    const h = await harness()
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    if (!begun.ok) throw new Error(begun.code)
    expect(await h.service.accountFolders()).toEqual([])
    const signed = await h.service.signIn({ accountId: begun.accountId, method: 'browser' }, 1)
    if (!signed.ok) throw new Error(signed.code)
    // The pending realm's folder is there and the package would name it: the
    // service still lists only an account's realm in use.
    const pending = h.doc().realms.find((r) => r.providerId === 'codex' && r.lifecycle === 'pending')!.id
    expect(await h.codex.launch!.accountFolders!({ authRealmId: pending })).toEqual(foldersOf(managedHome(pending)))
    expect(await h.service.accountFolders()).toEqual([])
    expect(h.claude.launch?.accountFolders).toBeUndefined()
  })
})
