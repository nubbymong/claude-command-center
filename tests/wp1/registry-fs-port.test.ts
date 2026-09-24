// WP1.27, WP1.4 -- WP2 slice 2 (plan A1): the REAL registry file port and the strict
// profiles.json reader, against real files in a temp directory; and (commit 3)
// the registry following a resources directory chosen after start.
//
// HOST QUARANTINE: this suite writes files. It runs on the VM and in CI, never
// on the owner's workstation. It touches no ACL, no junction and no real home.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRegistryFsPort, REGISTRY_DIRNAME, REGISTRY_FILENAME } from '../../src/main/provider-account-registry'
import { AccountRegistryStore } from '../../src/main/providers/core'
import { createIdentity } from '../../src/shared/providers'
import { readProfilesStrict, updateProfilesStrict, _setRootsForTest } from '../../src/main/account-profiles'

let root: string

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-registry-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const idn = (n: number) => `idn-${n.toString(16).padStart(24, '0')}`

describe('the registry file port', () => {
  it('a resources directory without a registry reads as missing; a missing resources directory is an error', () => {
    expect(createRegistryFsPort(root).read()).toEqual({ kind: 'missing' })
    expect(createRegistryFsPort(path.join(root, 'not-there')).read()).toMatchObject({ kind: 'error' })
  })

  it('a missing registry.json whose backups or cloud placeholder remain is an error, never a fresh start', () => {
    const dir = path.join(root, REGISTRY_DIRNAME)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'registry.1790000000000.json.bak'), '{}')
    expect(createRegistryFsPort(root).read()).toMatchObject({ kind: 'error' })
    fs.rmSync(path.join(dir, 'registry.1790000000000.json.bak'))
    fs.writeFileSync(path.join(dir, '.registry.json.icloud'), '')
    expect(createRegistryFsPort(root).read()).toMatchObject({ kind: 'error' })
    fs.rmSync(path.join(dir, '.registry.json.icloud'))
    expect(createRegistryFsPort(root).read()).toEqual({ kind: 'missing' })
  })

  it('writes providers/registry.json and reads it back', () => {
    const port = createRegistryFsPort(root)
    port.write('{"a":1}\n')
    expect(fs.readFileSync(path.join(root, REGISTRY_DIRNAME, REGISTRY_FILENAME), 'utf8')).toBe('{"a":1}\n')
    expect(port.read()).toEqual({ kind: 'ok', text: '{"a":1}\n' })
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, REGISTRY_DIRNAME, REGISTRY_FILENAME)).mode & 0o777).toBe(0o600)
  })

  it('backs up, lists and prunes only well-formed backup names', () => {
    const port = createRegistryFsPort(root)
    port.write('one')
    port.backup('registry.5.json.bak')
    fs.writeFileSync(path.join(root, REGISTRY_DIRNAME, 'other.txt'), 'x')
    expect(port.listBackups()).toEqual(['registry.5.json.bak'])
    expect(() => port.backup('../evil.json.bak')).toThrow()
    expect(() => port.removeBackup('../../x')).toThrow()
    port.removeBackup('registry.5.json.bak')
    expect(port.listBackups()).toEqual([])
  })

  it('end to end: a store persists through the real port and a new store reads it', async () => {
    const s = new AccountRegistryStore({ fs: createRegistryFsPort(root), now: () => Date.now() })
    s.load()
    expect((await s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))).ok).toBe(true)
    const again = new AccountRegistryStore({ fs: createRegistryFsPort(root), now: () => Date.now() })
    expect(again.load()).toEqual({ mode: 'ready' })
    expect(again.current()?.identities).toHaveLength(1)
  })

  it('a corrupt file puts the store in recovery and is left exactly as it was', async () => {
    const port = createRegistryFsPort(root)
    port.write('{ corrupt')
    const s = new AccountRegistryStore({ fs: port, now: () => Date.now() })
    expect(s.load()).toMatchObject({ mode: 'recovery', reason: 'invalid' })
    await s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    expect(fs.readFileSync(path.join(root, REGISTRY_DIRNAME, REGISTRY_FILENAME), 'utf8')).toBe('{ corrupt')
  })
})

describe('the strict profiles.json reader', () => {
  beforeEach(() => { _setRootsForTest({ resourcesDir: path.join(root, 'res'), sharedRoot: path.join(root, 'shared') }) })
  afterEach(() => { _setRootsForTest(null) })
  const meta = () => path.join(root, 'res', 'account-profiles', 'profiles.json')
  const put = (text: string) => { fs.mkdirSync(path.dirname(meta()), { recursive: true }); fs.writeFileSync(meta(), text) }

  it('no file is an empty list; unreadable JSON or no profiles array is null', () => {
    expect(readProfilesStrict()).toEqual([])
    put('{ nope')
    expect(readProfilesStrict()).toBeNull()
    put('{"profiles":{}}')
    expect(readProfilesStrict()).toBeNull()
    put('{"profiles":[{"id":"profile-a1","name":"A","accountEmail":"","createdAt":1}]}')
    expect(readProfilesStrict()?.map((p) => p.id)).toEqual(['profile-a1'])
  })

  it('an update against an unreadable file writes nothing and reports it', () => {
    put('{ nope')
    expect(updateProfilesStrict(() => true)).toBe(false)
    expect(fs.readFileSync(meta(), 'utf8')).toBe('{ nope')
  })

  it('an update changes only what the callback changed and keeps every other profile', () => {
    put(JSON.stringify({ profiles: [{ id: 'profile-a1', name: 'A', accountEmail: '', createdAt: 1 }, { id: 'profile-b2', name: 'B', accountEmail: '', createdAt: 1 }] }))
    expect(updateProfilesStrict((all) => { all[1].name = 'Office'; return true })).toBe(true)
    expect(readProfilesStrict()?.map((p) => p.name)).toEqual(['A', 'Office'])
  })

  it('an update keeps the rest of the file and any stray entry exactly as they were; no change writes nothing', () => {
    put(JSON.stringify({ profiles: [{ id: 'profile-a1', name: 'A', accountEmail: '', createdAt: 1 }, null, 'junk'], future: { keep: 1 } }))
    const before = fs.readFileSync(meta(), 'utf8')
    expect(updateProfilesStrict(() => false)).toBe(true)
    expect(fs.readFileSync(meta(), 'utf8')).toBe(before)
    expect(updateProfilesStrict((all) => { all[0].name = 'Office'; return true })).toBe(true)
    expect(JSON.parse(fs.readFileSync(meta(), 'utf8'))).toEqual({ profiles: [{ id: 'profile-a1', name: 'Office', accountEmail: '', createdAt: 1 }, null, 'junk'], future: { keep: 1 } })
  })
})

describe('the registry follows the resources directory (plan: carried from slice 2)', () => {
  // The real data-paths over temp directories. Its Windows-registry backing
  // is replaced, so nothing outside the temp directory is read or written.
  const ENV = ['CCC_E2E_DATA_DIR', 'CCC_DEV_DATA_DIR'] as const
  const savedEnv: Partial<Record<(typeof ENV)[number], string>> = {}
  async function load(initial: string) {
    // An override would win over the registry value this suite controls.
    for (const k of ENV) { if (process.env[k] !== undefined) savedEnv[k] = process.env[k]; delete process.env[k] }
    vi.resetModules()
    let stored: string | null = initial
    vi.doMock('../../src/main/registry', () => ({
      readRegistry: (key: string) => (key === 'ResourcesDirectory' ? stored : null),
      writeRegistry: (key: string, value: string) => { if (key === 'ResourcesDirectory') stored = value },
    }))
    vi.doUnmock('../../src/main/data-paths')
    const paths = await import('../../src/main/data-paths')
    const reg = await import('../../src/main/provider-account-registry')
    const accounts = await import('../../src/main/provider-accounts')
    const logger = await import('../../src/main/debug-logger')
    return { paths, reg, accounts, logger }
  }
  afterEach(() => {
    for (const k of ENV) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    vi.doUnmock('../../src/main/registry')
    vi.resetModules()
  })

  it('a directory chosen after start moves the registry there before anything reconciles it; the old file is left as it was', async () => {
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    const { paths, reg, accounts } = await load(a)
    expect(paths.getResourcesDirectory()).toBe(a)
    reg.initAccountRegistry(a)
    expect(reg.accountRegistryIsCurrent()).toBe(true)
    expect((await reg.getAccountRegistry()!.mutate((d, t) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, t))).ok).toBe(true)
    const fileA = fs.readFileSync(path.join(a, REGISTRY_DIRNAME, REGISTRY_FILENAME), 'utf8')
    const replaced = reg.getAccountRegistry()!
    const heard: string[] = []
    paths.onResourcesDirectoryChanged((dir) => heard.push(dir))
    const followed: Promise<void>[] = []
    paths.onResourcesDirectoryChanged((dir) => { followed.push(accounts.followResourcesDirectory(dir)) })
    expect(paths.setResourcesDirectory(b)).toBe(true)
    await Promise.all(followed)
    expect(heard).toEqual([b])
    expect(reg.getAccountRegistryResourcesDir()).toBe(b)
    expect(reg.accountRegistryIsCurrent()).toBe(true)
    expect(reg.getAccountRegistry()!.current()!.identities).toEqual([])
    expect(fs.readFileSync(path.join(a, REGISTRY_DIRNAME, REGISTRY_FILENAME), 'utf8')).toBe(fileA)
    // An operation that captured the replaced store cannot write through it.
    expect((await replaced.mutate((d, t) => createIdentity(d, { id: idn(2), colourKey: 'pink' }, t))).ok).toBe(false)
    expect(fs.readFileSync(path.join(a, REGISTRY_DIRNAME, REGISTRY_FILENAME), 'utf8')).toBe(fileA)
    // The same folder spelled another way keeps the one store.
    const current = reg.getAccountRegistry()
    await accounts.followResourcesDirectory(b + path.sep)
    expect(reg.getAccountRegistry()).toBe(current)
    // The same directory again is no change.
    expect(paths.setResourcesDirectory(b)).toBe(true)
    expect(heard).toEqual([b])
  })

  it('the same folder spelled another way is the directory the registry was loaded from: its reconciles are not skipped', async () => {
    const a = path.join(root, 'a')
    fs.mkdirSync(a)
    const { reg } = await load(a + path.sep)
    reg.initAccountRegistry(a)
    expect(reg.accountRegistryIsCurrent()).toBe(true)
  })

  it('a reconcile against a registry loaded from another directory is refused, never mixed', async () => {
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    const { reg, logger } = await load(b)
    reg.initAccountRegistry(a)
    expect(reg.accountRegistryIsCurrent()).toBe(false)
    vi.mocked(logger.logError).mockClear()
    expect(await reg.reconcileLegacyAccountStores()).toEqual([])
    expect(vi.mocked(logger.logError).mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/reconcile skipped: the resources directory changed/)
  })
})
