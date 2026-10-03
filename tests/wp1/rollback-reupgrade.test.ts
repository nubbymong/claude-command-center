// WP1.31 -- rollback to the pre-WP1 beta, then re-upgrade, for Claude accounts (plan A3,
// docs/wp2/plan.md:79-85). [host] PURE: profiles.json and registry.json live in memory;
// the REAL strict profiles.json reader/writer (account-profiles.ts), Claude legacy port
// and registry store run over them, wired as compose.ts:42 wires them. Nothing is
// spawned, no file is written, no home is read.
//
// Covered elsewhere, not repeated: an older build's edit imported and a both-sides
// conflict (migration-claude.test.ts:121, :130), archive/restore (:152, :203), a lost
// registry or lost links reattach by deterministic id (:90, :218); only name, active and
// colour written, stray entries untouched (claude-legacy-store.test.ts:64-122); the real
// writer keeps other top-level keys on disk (registry-fs-port.test.ts:108, CI/VM).
// This file does NOT evidence WP1.31: docs/wp1/evidence/rollback.md owes a real VM run.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { readProfilesStrict, updateProfilesStrict, _setRootsForTest } from '../../src/main/account-profiles'
import { PROFILES_ROOT_DIRNAME } from '../../src/main/profile-id'
import { createClaudeLegacyAccountsPort } from '../../src/main/providers/claude/legacy-store'
import { AccountRegistryStore } from '../../src/main/providers/core'
import type { RegistryFsPort, LegacyAccountsPort } from '../../src/main/providers/core'
import { updateIdentity, setAccountLifecycle, checkRegistryInvariants } from '../../src/shared/providers'
import type { ProviderRegistryDoc } from '../../src/shared/providers'
import { isAccountActive } from '../../src/shared/account-types'
import type { AccountProfile } from '../../src/shared/account-types'

// The in-memory disk. Reads under its root are served from the map; a write anywhere
// else throws, so this file can never touch a real one.
const mem = vi.hoisted(() => ({ root: '', files: new Map<string, string>() }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const p = await import('node:path')
  const readFileSync = (file: unknown, ...rest: unknown[]): unknown => {
    const key = typeof file === 'string' ? p.resolve(file) : ''
    if (!mem.root || !key.startsWith(mem.root)) return (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)
    const text = mem.files.get(key)
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' })
    return text
  }
  return { ...real, default: { ...real, readFileSync }, readFileSync }
})
vi.mock('../../src/main/atomic-write', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/atomic-write')>()
  const p = await import('node:path')
  return { ...real, atomicWriteFileSync: (file: string, data: string | Uint8Array) => {
    const key = p.resolve(file)
    if (!mem.root || !key.startsWith(mem.root)) throw new Error(`rollback test: refused a real write to ${file}`)
    mem.files.set(key, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
  } }
})

// The AccountProfile keys of the pre-WP1 base, from 6bafcc33:src/shared/account-types.ts
// (unchanged since: `git log 6bafcc33..HEAD -- src/shared/account-types.ts` is empty).
const BASE_KEYS: readonly string[] = ['id', 'name', 'accountEmail', 'colourKey', 'isPrimary', 'active', 'createdAt']
// The base build's reader and writer (6bafcc33:src/main/account-profiles.ts:768
// listProfiles, :775 saveProfiles). Its writer keeps ONLY `profiles`.
type Rec = Record<string, unknown>
const baseList = (text: string): Rec[] => (JSON.parse(text) as { profiles?: Rec[] } | null)?.profiles ?? []
const baseSave = (profiles: Rec[]) => JSON.stringify({ profiles }, null, 2)

// A base-era profiles.json: every base field, one per-profile key and one top-level key
// no build declares (a hand edit, or a newer build's), which must ride through untouched.
const fixture = () => ({
  profiles: [
    { id: 'profile-a1', name: 'Personal', accountEmail: 'a1@example.com', colourKey: 'pink', isPrimary: true, active: true, createdAt: 1_700_000_000_001 },
    { id: 'profile-b2', name: 'Work', accountEmail: 'b2@example.com', createdAt: 1_700_000_000_002, lastUsedAt: 1_700_000_900_000 },
    { id: 'profile-c3', name: 'Setup pending', accountEmail: '', createdAt: 1_700_000_000_003 },
    { id: 'profile-d4', name: 'Spare', accountEmail: 'd4@example.com', colourKey: 'indigo', active: true, createdAt: 1_700_000_000_004 },
  ] as Rec[],
  windowLayout: { pinned: ['profile-a1'] },
})

class MemRegistry implements RegistryFsPort {
  file: string | null = null
  backups = new Map<string, string>()
  read() { return this.file === null ? { kind: 'missing' as const } : { kind: 'ok' as const, text: this.file } }
  write(text: string) { this.file = text }
  backup(name: string) { if (this.file !== null) this.backups.set(name, this.file) }
  listBackups() { return [...this.backups.keys()] }
  removeBackup(name: string) { this.backups.delete(name) }
}

let META = ''
let clock = 1_000
beforeEach(() => {
  mem.root = path.resolve(os.tmpdir(), `ccc-rollback-mem-${process.pid}-never-created`)
  mem.files.clear()
  _setRootsForTest({ resourcesDir: path.join(mem.root, 'res'), sharedRoot: path.join(mem.root, 'shared') })
  META = path.resolve(mem.root, 'res', PROFILES_ROOT_DIRNAME, 'profiles.json')
})
afterEach(() => { _setRootsForTest(null); mem.root = '' })

/** The Claude port exactly as compose.ts:42 builds it (settings absent). */
const claudePort = (): LegacyAccountsPort => createClaudeLegacyAccountsPort({
  readProfiles: readProfilesStrict, updateProfiles: updateProfilesStrict, readSettings: () => ({ outcome: 'absent', value: null }),
})

/** One start of this build: load the registry, reconcile Claude's profiles.json. */
async function startThisBuild(reg: MemRegistry) {
  const store = new AccountRegistryStore({ fs: reg, now: () => ++clock })
  expect(store.load()).toEqual({ mode: 'ready' })
  return { store, out: await store.reconcileLegacy(claudePort()) }
}

const accountFor = (doc: ProviderRegistryDoc, legacyId: string) =>
  doc.accounts.find((a) => doc.realms.find((r) => r.id === a.authRealmId)?.pathRef === `claude-profile:${legacyId}`)
const idsOf = (doc: ProviderRegistryDoc) => Object.fromEntries(doc.legacyLinks.map((l) => {
  const a = doc.accounts.find((x) => x.id === l.accountId)
  return [l.legacyId, { account: a?.id, identity: a?.identityId, realm: a?.authRealmId }]
}))

/** Upgrade onto the base file, then edit in this build: rename b2, recolour c3 (no
 *  email, so its own key), deactivate d4; the write-through reconcile the accounts
 *  service runs after an edit (accounts-service.ts:2199) lands them in profiles.json. */
async function upgradeAndEdit() {
  const reg = new MemRegistry()
  mem.files.set(META, JSON.stringify(fixture(), null, 2))
  const { store, out } = await startThisBuild(reg)
  // Preconditions: migration alone writes nothing (migration-claude.test.ts:79).
  expect(out).toMatchObject({ ok: true, created: 4, writes: 0 })
  expect(mem.files.get(META)).toBe(JSON.stringify(fixture(), null, 2))
  const ids = idsOf(store.current()!)
  const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true)
  ok(await store.mutate((d, now) => updateIdentity(d, ids['profile-b2'].identity!, { friendlyName: 'Office' }, now)))
  ok(await store.mutate((d, now) => updateIdentity(d, ids['profile-c3'].identity!, { colourKey: 'rose' }, now)))
  ok(await store.mutate((d, now) => setAccountLifecycle(d, ids['profile-d4'].account!, 'inactive', { consumers: 0 }, now)))
  const through = await store.reconcileLegacy(claudePort())
  expect(through).toMatchObject({ ok: true, writes: 3 })
  expect(through).not.toHaveProperty('applyFailed')
  expect(through).not.toHaveProperty('convergeFailed')
  return { reg, ids }
}

describe('rollback: the base build still reads what this build wrote (WP1.31)', () => {
  it('[host] profiles.json keeps its shape, its unknown keys and every base value but the three this build edited', async () => {
    await upgradeAndEdit()
    const text = mem.files.get(META)!
    const after = JSON.parse(text) as { profiles: Rec[] } & Rec
    const before = fixture()
    // Same top-level shape; a key no build declares is kept as it was.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    expect(after.windowLayout).toStrictEqual(before.windowLayout)
    // No profile gains a key outside the base AccountProfile key set.
    after.profiles.forEach((p, i) => {
      expect(Object.keys(p).filter((k) => !(k in before.profiles[i]) && !BASE_KEYS.includes(k))).toEqual([])
    })
    // Through the base reader: base-typed fields, the same accounts, the base active rule.
    const base = baseList(text)
    for (const p of base) {
      expect([typeof p.id, typeof p.name, typeof p.accountEmail, typeof p.createdAt]).toEqual(['string', 'string', 'string', 'number'])
      for (const k of ['isPrimary', 'active'] as const) expect(['undefined', 'boolean']).toContain(typeof p[k])
    }
    expect(base.map((p) => [p.id, p.name, isAccountActive(p as unknown as AccountProfile), p.colourKey ?? null])).toEqual([
      ['profile-a1', 'Personal', true, 'pink'], ['profile-b2', 'Office', true, null],
      ['profile-c3', 'Setup pending', true, 'rose'], ['profile-d4', 'Spare', false, 'indigo'],
    ])
    // Every base-era key and value kept; only name, active and colourKey moved.
    const want = fixture()
    want.profiles[1].name = 'Office'
    want.profiles[2].colourKey = 'rose'
    want.profiles[3].active = false
    expect(after).toStrictEqual(want)
  })
})

describe('re-upgrade after the base build edited profiles.json (WP1.31, plan A3)', () => {
  it.each(['kept', 'lost'] as const)('[host] registry %s: same ids, the edits imported, the new one added, nothing guessed', async (registry) => {
    const { reg, ids } = await upgradeAndEdit()
    // The base build renames a1, recolours c3, removes d4 and adds e5, through its own writer.
    const old = baseList(mem.files.get(META)!)
    old[0].name = 'Home'
    old[2].colourKey = 'plum'
    const next = old.filter((p) => p.id !== 'profile-d4')
    next.push({ id: 'profile-e5', name: 'Added in base', accountEmail: 'e5@example.com', createdAt: 1_700_000_000_005 })
    mem.files.set(META, baseSave(next))
    // Lost outright, backups too: one with backups left is an error, never a fresh
    // start (registry-fs-port.test.ts:29).
    if (registry === 'lost') { reg.file = null; reg.backups.clear() }
    const written = mem.files.get(META)
    const { store, out } = await startThisBuild(reg)
    expect(out).toMatchObject(registry === 'kept'
      ? { ok: true, created: 1, imported: 2, archived: 1, restored: 0, writes: 0 }
      : { ok: true, created: 4, imported: 0, archived: 0, restored: 0, writes: 0 })
    const doc = store.current()!
    // Nothing guessed: no conflict held, nothing written back over the base build's edits.
    expect(doc.conflicts).toEqual([])
    expect(mem.files.get(META)).toBe(written)
    // The same deterministic ids for every surviving profile; one account per profile.
    const now = idsOf(doc)
    expect(Object.keys(now).sort()).toEqual(['profile-a1', 'profile-b2', 'profile-c3', 'profile-e5'])
    for (const id of ['profile-a1', 'profile-b2', 'profile-c3']) expect(now[id]).toEqual(ids[id])
    expect(new Set(doc.accounts.map((a) => a.id)).size).toBe(doc.accounts.length)
    expect(doc.accounts).toHaveLength(registry === 'kept' ? 5 : 4)
    // The base build's edits, this build's surviving rename, and the new profile.
    const idn = (legacyId: string) => doc.identities.find((i) => i.id === now[legacyId].identity)
    expect([idn('profile-a1')?.friendlyName, idn('profile-b2')?.friendlyName, idn('profile-c3')?.colourKey, idn('profile-e5')?.friendlyName])
      .toEqual(['Home', 'Office', 'plum', 'Added in base'])
    // The removed profile: archived with its realm retired while the registry survived;
    // with the registry lost there is no record of it, and it is not brought back.
    const d4 = accountFor(doc, 'profile-d4')
    if (registry === 'kept') {
      expect(d4).toMatchObject({ id: ids['profile-d4'].account, lifecycle: 'archived' })
      expect(doc.realms.find((r) => r.id === d4?.authRealmId)?.lifecycle).toBe('retired')
    } else expect(d4).toBeUndefined()
    expect(checkRegistryInvariants(doc)).toEqual([])
  })
})
