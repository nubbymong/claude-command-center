// WP1.27 -- WP2 slice 2 (design 6.4, 14; plan A1, A2): the account registry store.
// PURE: the store persists through an injected port, so this suite drives it
// with an in-memory one. The real file port (atomic write, owner-only) is
// exercised on the VM/CI only (host quarantine).
import { describe, it, expect } from 'vitest'
import { AccountRegistryStore, deterministicOpaqueId, REGISTRY_BACKUPS_KEPT } from '../../src/main/providers/core'
import type { RegistryFsPort, LegacyAccountsPort } from '../../src/main/providers/core'
import { emptyRegistry, createIdentity, isOpaqueId, parseRegistryDoc, updateIdentity, findIdentity } from '../../src/shared/providers'
import type { LegacyAccountSnapshot, LegacyWrite, ProviderRegistryDoc } from '../../src/shared/providers'

class MemoryPort implements RegistryFsPort {
  file: string | null = null
  backups = new Map<string, string>()
  failRead: string | null = null
  failWrite = false
  failBackup = false
  writes = 0
  read() {
    if (this.failRead) return { kind: 'error' as const, message: this.failRead }
    return this.file === null ? { kind: 'missing' as const } : { kind: 'ok' as const, text: this.file }
  }
  write(text: string) {
    if (this.failWrite) throw new Error('disk full')
    this.file = text
    this.writes++
  }
  backup(name: string) {
    if (this.failBackup) throw new Error('backup denied')
    if (this.file === null) throw new Error('nothing to back up')
    this.backups.set(name, this.file)
  }
  listBackups() { return [...this.backups.keys()] }
  removeBackup(name: string) { this.backups.delete(name) }
}

let clock = 1_000
const store = (port: MemoryPort, extra: Partial<ConstructorParameters<typeof AccountRegistryStore>[0]> = {}) =>
  new AccountRegistryStore({ fs: port, now: () => ++clock, ...extra })

const idn = (n: number) => `idn-${n.toString(16).padStart(24, '0')}`

function legacy(records: LegacyAccountSnapshot[] | null, applied: LegacyWrite[][] = []): LegacyAccountsPort {
  return { providerId: 'claude', read: () => records, apply: (w) => { applied.push([...w]) } }
}

const rec = (id: string, over: Partial<LegacyAccountSnapshot> = {}): LegacyAccountSnapshot => ({
  legacyId: id, friendlyName: `Name ${id}`, colourKey: 'pink', lifecycle: 'active', isDefault: false, createdAt: 1,
  realm: { kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: `claude-profile:${id}` }, authMethod: 'browser', identityAssurance: 'user-asserted', ...over,
})

describe('deterministic ids', () => {
  it('are valid opaque ids, stable per seed and distinct per kind', () => {
    const a = deterministicOpaqueId('account', 'claude:profile-a1')
    expect(isOpaqueId(a, 'account')).toBe(true)
    expect(deterministicOpaqueId('account', 'claude:profile-a1')).toBe(a)
    expect(deterministicOpaqueId('realm', 'claude:profile-a1').slice(-32)).not.toBe(a.slice(-32))
  })
})

describe('loading (design 14: recovery mode)', () => {
  it('no file yet: an empty registry, nothing written until the first change', () => {
    const port = new MemoryPort()
    const s = store(port)
    expect(s.load()).toEqual({ mode: 'ready' })
    expect(s.current()).toEqual(emptyRegistry())
    expect(port.writes).toBe(0)
  })

  it('a valid file loads', async () => {
    const port = new MemoryPort()
    const first = store(port)
    first.load()
    await first.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    const again = store(port)
    expect(again.load()).toEqual({ mode: 'ready' })
    expect(again.current()?.identities).toHaveLength(1)
  })

  it.each([
    ['unreadable', (p: MemoryPort) => { p.failRead = 'EACCES' }, 'unreadable'],
    ['not JSON', (p: MemoryPort) => { p.file = '{ nope' }, 'invalid'],
    ['inconsistent', (p: MemoryPort) => { p.file = JSON.stringify({ ...emptyRegistry(), accounts: [{ id: 'x' }] }) }, 'invalid'],
    ['newer schema', (p: MemoryPort) => { p.file = JSON.stringify({ ...emptyRegistry(), schemaVersion: 2 }) }, 'newer-schema'],
  ])('%s: recovery mode, nothing usable, every change refused, the file untouched', async (_n, setup, reason) => {
    const port = new MemoryPort()
    setup(port)
    const before = port.file
    const s = store(port)
    expect(s.load()).toMatchObject({ mode: 'recovery', reason })
    expect(s.current()).toBeNull()
    expect(await s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))).toMatchObject({ ok: false, code: 'recovery' })
    expect(await s.reconcileLegacy(legacy([rec('profile-a1')]))).toMatchObject({ ok: false, code: 'recovery' })
    expect(port.file).toBe(before)
    expect(port.backups.size).toBe(0)
  })

  it('a store that was never loaded refuses changes', async () => {
    expect(await store(new MemoryPort()).mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))).toMatchObject({ ok: false, code: 'recovery' })
  })
})

describe('changes (plan A1: atomic, validated, backed up)', () => {
  it('a change is persisted as a document the next start reads back identically', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    const r = await s.mutate((d) => createIdentity(d, { id: idn(1), friendlyName: 'Work', colourKey: 'pink' }, 5))
    expect(r.ok).toBe(true)
    const parsed = parseRegistryDoc(JSON.parse(port.file!))
    expect(parsed.ok && parsed.doc).toEqual(s.current())
  })

  it('a refused transition changes nothing and writes nothing', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    expect(await s.mutate((d) => createIdentity(d, { id: 'bad', colourKey: 'pink' }, 5))).toMatchObject({ ok: false, code: 'invalid-id' })
    expect(port.writes).toBe(0)
  })

  it('a no-op transition writes nothing', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    expect((await s.mutate((d) => ({ ok: true, doc: d }))).ok).toBe(true)
    expect(port.writes).toBe(0)
  })

  it('a failed write leaves memory at the last persisted document', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    port.failWrite = true
    expect(await s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(s.current()).toEqual(emptyRegistry())
  })

  it('a document that would not read back is never written (fail closed)', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    const broken = (d: ProviderRegistryDoc) => ({ ok: true as const, doc: { ...d, accounts: [{ id: 'x' } as never] } })
    expect(await s.mutate(broken)).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(port.writes).toBe(0)
  })

  it('the first change of a start backs up the existing file once; later changes do not', async () => {
    const port = new MemoryPort()
    const seed = store(port)
    seed.load()
    await seed.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    expect(port.backups.size).toBe(0)
    const original = port.file
    const s = store(port)
    s.load()
    await s.mutate((d) => createIdentity(d, { id: idn(2), colourKey: 'pink' }, 6))
    await s.mutate((d) => createIdentity(d, { id: idn(3), colourKey: 'pink' }, 7))
    expect([...port.backups.values()]).toEqual([original])
    expect([...port.backups.keys()][0]).toMatch(/^registry\.\d+\.json\.bak$/)
  })

  it('a failed backup refuses the change rather than write without a way back', async () => {
    const port = new MemoryPort()
    const seed = store(port)
    seed.load()
    await seed.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    const before = port.file
    const s = store(port)
    s.load()
    port.failBackup = true
    expect(await s.mutate((d) => createIdentity(d, { id: idn(2), colourKey: 'pink' }, 6))).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(port.file).toBe(before)
  })

  it(`only the newest ${REGISTRY_BACKUPS_KEPT} backups are kept`, async () => {
    const port = new MemoryPort()
    const seed = store(port)
    seed.load()
    await seed.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    for (let i = 0; i < REGISTRY_BACKUPS_KEPT + 3; i++) {
      const s = store(port)
      s.load()
      await s.mutate((d) => createIdentity(d, { id: idn(10 + i), colourKey: 'pink' }, 10 + i))
    }
    expect(port.backups.size).toBe(REGISTRY_BACKUPS_KEPT)
  })

  it('changes are serialised: concurrent mutations never lose one another', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    await Promise.all([1, 2, 3, 4, 5].map((n) => s.mutate((d) => createIdentity(d, { id: idn(n), colourKey: 'pink' }, n))))
    expect(s.current()?.identities.map((i) => i.id).sort()).toEqual([1, 2, 3, 4, 5].map(idn).sort())
  })

  it('listeners see each persisted document, and never a refused one', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    const seen: number[] = []
    const off = s.subscribe((d) => seen.push(d.identities.length))
    await s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    await s.mutate((d) => createIdentity(d, { id: 'bad', colourKey: 'pink' }, 6))
    off()
    await s.mutate((d) => createIdentity(d, { id: idn(2), colourKey: 'pink' }, 7))
    expect(seen).toEqual([1])
  })
})

describe('legacy reconcile through a provider port (design 6.2, 6.4)', () => {
  it('migrates, persists, then hands the pending writes to the provider', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    const applied: LegacyWrite[][] = []
    const r = await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })], applied))
    expect(r).toMatchObject({ ok: true, created: 1 })
    expect(parseRegistryDoc(JSON.parse(port.file!)).ok).toBe(true)
    expect(applied).toEqual([])
    const idnId = s.current()!.accounts[0].identityId
    await s.mutate((d) => ({ ok: true, doc: { ...d, identities: d.identities.map((i) => (i.id === idnId ? { ...i, friendlyName: 'Office' } : i)) } }))
    const again = await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })], applied))
    expect(again).toMatchObject({ ok: true, writes: 1 })
    expect(applied).toEqual([[{ providerId: 'claude', legacyId: 'profile-a1', field: 'friendlyName', value: 'Office' }]])
  })

  it('an unreadable legacy store changes nothing and applies nothing', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })]))
    const before = port.file
    const applied: LegacyWrite[][] = []
    expect(await s.reconcileLegacy(legacy(null, applied))).toMatchObject({ ok: false, code: 'legacy-unreadable' })
    expect(port.file).toBe(before)
    expect(applied).toEqual([])
  })

  it('a reconcile that changes nothing writes nothing', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })]))
    const writes = port.writes
    await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })]))
    expect(port.writes).toBe(writes)
  })

  it('writes are not applied when the registry could not be persisted', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })]))
    const idnId = s.current()!.accounts[0].identityId
    await s.mutate((d) => ({ ok: true, doc: { ...d, identities: d.identities.map((i) => (i.id === idnId ? { ...i, friendlyName: 'Office' } : i)) } }))
    port.failWrite = true
    const applied: LegacyWrite[][] = []
    // Legacy was renamed too (a conflict needs persisting): the persist fails, so nothing is applied.
    expect(await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true, friendlyName: 'Theirs' })], applied))).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(applied).toEqual([])
  })

  it('a provider whose apply throws does not break the store; the write is re-emitted next time', async () => {
    const port = new MemoryPort()
    const s = store(port)
    s.load()
    await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })]))
    const idnId = s.current()!.accounts[0].identityId
    await s.mutate((d) => ({ ok: true, doc: { ...d, identities: d.identities.map((i) => (i.id === idnId ? { ...i, friendlyName: 'Office' } : i)) } }))
    const throwing: LegacyAccountsPort = { providerId: 'claude', read: () => [rec('profile-a1', { isDefault: true })], apply: () => { throw new Error('profiles.json locked') } }
    expect(await s.reconcileLegacy(throwing)).toMatchObject({ ok: true, writes: 1, applyFailed: true })
    const applied: LegacyWrite[][] = []
    await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })], applied))
    expect(applied).toHaveLength(1)
  })

  it('held accounts are asked of the consumer count', async () => {
    const port = new MemoryPort()
    let held = ''
    const s = store(port, { consumers: (id) => (id === held ? 1 : 0) })
    s.load()
    await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true }), rec('profile-b2')]))
    held = s.current()!.accounts[1].id
    const r = await s.reconcileLegacy(legacy([rec('profile-a1', { isDefault: true })]))
    expect(r).toMatchObject({ ok: true, archived: 0 })
    expect(s.current()!.accounts[1].lifecycle).toBe('active')
  })
})

describe('adversarial round 1 (slice 2)', () => {
  it('a write-through that lands moves the shadow at once, so a later legacy edit is imported, never reverted', async () => {
    let profiles = [rec('profile-a1', { isDefault: true })]
    const port: LegacyAccountsPort = {
      providerId: 'claude',
      read: () => profiles,
      apply: (ws) => { for (const w of ws) if (w.field === 'friendlyName') profiles = profiles.map((p) => (p.legacyId === w.legacyId ? { ...p, friendlyName: w.value } : p)) },
    }
    const s = store(new MemoryPort())
    s.load()
    await s.reconcileLegacy(port)
    const idnId = s.current()!.accounts[0].identityId
    await s.mutate((d, now) => updateIdentity(d, idnId, { friendlyName: 'Work' }, now))
    expect(await s.reconcileLegacy(port)).toMatchObject({ ok: true, writes: 1 })
    expect(profiles[0].friendlyName).toBe('Work')
    // The user renames it back in the Claude UI before the next start.
    profiles = [{ ...profiles[0], friendlyName: 'Original' }]
    expect(await s.reconcileLegacy(port)).toMatchObject({ ok: true, writes: 0 })
    expect(profiles[0].friendlyName).toBe('Original')
    expect(findIdentity(s.current()!, idnId)?.friendlyName).toBe('Original')
  })

  it('the backup just written survives pruning even when older ones carry later stamps', async () => {
    const port = new MemoryPort()
    const seed = store(port)
    seed.load()
    await seed.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    const original = port.file
    for (let i = 0; i < REGISTRY_BACKUPS_KEPT; i++) port.backups.set(`registry.${9_000_000_000_000 + i}.json.bak`, 'future')
    const s = store(port)
    s.load()
    await s.mutate((d) => createIdentity(d, { id: idn(2), colourKey: 'pink' }, 6))
    expect([...port.backups.values()]).toContain(original)
    expect(port.backups.size).toBe(REGISTRY_BACKUPS_KEPT)
  })

  it('the lock refuses a nested call instead of deadlocking, and later work still runs', async () => {
    const s = store(new MemoryPort())
    s.load()
    await expect(s.exclusive(() => s.exclusive(() => 1))).rejects.toThrow(/re-entrant/)
    expect((await s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))).ok).toBe(true)
  })

  it('a listener may start a change: it queues behind the current one', async () => {
    const s = store(new MemoryPort())
    s.load()
    let queued: Promise<unknown> | null = null
    s.subscribe((d) => { if (d.identities.length === 1) queued = s.mutate((dd) => createIdentity(dd, { id: idn(2), colourKey: 'pink' }, 6)) })
    await s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    expect(await queued).toMatchObject({ ok: true })
    expect(s.current()!.identities).toHaveLength(2)
  })

  it('the document handed out is frozen: an in-place edit cannot ride along with the next change', async () => {
    const s = store(new MemoryPort())
    s.load()
    await s.mutate((d) => createIdentity(d, { id: idn(1), friendlyName: 'A', colourKey: 'pink' }, 5))
    expect(() => { (s.current()!.identities[0] as { friendlyName?: string }).friendlyName = 'smuggled' }).toThrow()
    expect(() => { (s.current()!.identities as unknown[]).push({}) }).toThrow()
  })
})

describe('adversarial confirmation (slice 2)', () => {
  it('a shadow that could not be moved after a write-through is reported, not hidden', async () => {
    const port = new MemoryPort()
    let profiles = [rec('profile-a1', { isDefault: true })]
    const legacyPort: LegacyAccountsPort = {
      providerId: 'claude',
      read: () => profiles,
      apply: (ws) => {
        for (const w of ws) if (w.field === 'friendlyName') profiles = profiles.map((p) => (p.legacyId === w.legacyId ? { ...p, friendlyName: w.value } : p))
        port.failWrite = true
      },
    }
    const s = store(port)
    s.load()
    await s.reconcileLegacy(legacyPort)
    const idnId = s.current()!.accounts[0].identityId
    await s.mutate((d, now) => updateIdentity(d, idnId, { friendlyName: 'Work' }, now))
    expect(await s.reconcileLegacy(legacyPort)).toMatchObject({ ok: true, writes: 1, convergeFailed: true })
  })

  it('work a finished run left behind (a timer) may take the lock once that run is over', async () => {
    const s = store(new MemoryPort())
    s.load()
    let later: Promise<unknown> | null = null
    await s.exclusive(() => { setTimeout(() => { later = s.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5)) }, 5) })
    await new Promise((r) => setTimeout(r, 30))
    expect(await later).toMatchObject({ ok: true })
  })

  it('backups stamped in the future (clock skew) never displace the real history', async () => {
    const port = new MemoryPort()
    const seed = store(port)
    seed.load()
    await seed.mutate((d) => createIdentity(d, { id: idn(1), colourKey: 'pink' }, 5))
    for (let i = 0; i < REGISTRY_BACKUPS_KEPT; i++) port.backups.set(`registry.${9_000_000_000_000 + i}.json.bak`, 'future')
    for (let n = 2; n <= 4; n++) {
      const s = store(port)
      s.load()
      await s.mutate((d) => createIdentity(d, { id: idn(n), colourKey: 'pink' }, n))
    }
    expect([...port.backups.values()].filter((v) => v !== 'future')).toHaveLength(3)
    expect(port.backups.size).toBe(REGISTRY_BACKUPS_KEPT)
  })
})
