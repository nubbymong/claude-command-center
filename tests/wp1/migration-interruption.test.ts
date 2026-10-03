// WP1.26, WP1.61 -- the account registry migration (design 6.2, 6.4, 14; plan A1, A2):
// load + legacy reconcile, as every start runs it, is atomic and idempotent at every
// injected interruption point. PURE [host]: an in-memory registry file and legacy store
// behind the store's own ports (RegistryFsPort, LegacyAccountsPort); nothing is spawned
// and nothing touches a disk. A fault port fails the k-th port call for EVERY k up to
// the uninterrupted run's call count, counted from a recording run (so a call added
// later is covered without editing this file): as a crash (that call and every later
// one fail) or a transient error (that call alone), before or after it takes effect.
import { describe, it, expect } from 'vitest'
import { AccountRegistryStore, deterministicOpaqueId } from '../../src/main/providers/core'
import type { RegistryFsPort, LegacyAccountsPort, LegacyReconcileOutcome } from '../../src/main/providers/core'
import { emptyRegistry, parseRegistryDoc, reconcileLegacyAccounts, updateIdentity, beginAccountSetup, findIdentity } from '../../src/shared/providers'
import type { LegacyAccountSnapshot, LegacyWrite, ProviderRegistryDoc } from '../../src/shared/providers'

/** What survives a restart: the registry file, its backups and the legacy store. `history`
 *  is every text the file ever held; `unbacked` counts writes over a loaded file that no
 *  backup held at that moment. */
interface World { file: string | null; backups: Map<string, string>; profiles: LegacyAccountSnapshot[]; history: string[]; unbacked: number }
/** Fail port call `at`: `crash` fails it and every later call; `landed` lets it take effect first. */
interface Fault { at: number; crash: boolean; landed: boolean }

const FAULT_KINDS = [false, true].flatMap((crash) => [false, true].map((landed) => ({ crash, landed })))
let clock = 1_000_000

const rec = (id: string, over: Partial<LegacyAccountSnapshot> = {}): LegacyAccountSnapshot => ({
  legacyId: id, friendlyName: `Name ${id}`, colourKey: 'pink', lifecycle: 'active', isDefault: false, createdAt: 1,
  realm: { kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: `claude-profile:${id}` }, authMethod: 'browser', identityAssurance: 'user-asserted', ...over,
})
const text = (doc: ProviderRegistryDoc) => `${JSON.stringify(doc, null, 2)}\n`
const clone = (w: World): World => ({ ...w, backups: new Map(w.backups), profiles: w.profiles.map((p) => ({ ...p })), history: [...w.history] })
const accountId = (legacyId: string) => deterministicOpaqueId('account', `claude:${legacyId}`)
/** Sorted keys, timestamps zeroed (a rerun happens later): equal states compare equal. */
const canonOf = (value: unknown) => JSON.stringify(value, (k, v: unknown) => (typeof v === 'number' && /(^at|At)$/.test(k) ? 0
  : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, (v as Record<string, unknown>)[key]])) : v))
const canon = (t: string | null) => { if (t === null) return 'absent'; try { return canonOf(JSON.parse(t)) } catch { return `not JSON: ${t}` } }
const fullDoc = (t: string) => { try { return parseRegistryDoc(JSON.parse(t)).ok } catch { return false } }
const settled = (o: LegacyReconcileOutcome) => o.ok && !o.applyFailed && !o.convergeFailed
const applyWrites = (ps: LegacyAccountSnapshot[], ws: readonly LegacyWrite[]) =>
  ps.map((p) => ws.reduce((acc, w) => (w.legacyId === acc.legacyId ? ({ ...acc, [w.field]: w.value } as LegacyAccountSnapshot) : acc), p))

function ports(w: World, fault: Fault | null, names: string[]) {
  let calls = 0
  let loaded: string | null = null
  /** Counts one call; true when it fails. Its effect lands unless it fails first. */
  const fails = (name: string, effect: () => void): boolean => {
    names.push(name)
    calls++
    const failing = fault !== null && (fault.crash ? calls >= fault.at : calls === fault.at)
    if (!failing || (fault.landed && calls === fault.at)) effect()
    return failing
  }
  const boom = () => new Error(`injected fault at port call ${calls}`)
  const fs: RegistryFsPort = {
    read() {
      const seen = w.file
      if (fails('read', () => { loaded = seen })) return { kind: 'error', message: 'injected read fault' }
      return seen === null ? { kind: 'missing' } : { kind: 'ok', text: seen }
    },
    write(t) {
      if (fails('write', () => {
        if (loaded !== null && ![...w.backups.values()].includes(loaded)) w.unbacked++
        w.file = t
        w.history.push(t)
      })) throw boom()
    },
    backup(name) { if (fails('backup', () => { if (w.file === null) throw new Error('nothing to back up'); w.backups.set(name, w.file) })) throw boom() },
    listBackups() { let out: string[] = []; if (fails('listBackups', () => { out = [...w.backups.keys()] })) throw boom(); return out },
    removeBackup(name) { if (fails('removeBackup', () => { w.backups.delete(name) })) throw boom() },
  }
  const legacy: LegacyAccountsPort = {
    providerId: 'claude',
    read() {
      let out: LegacyAccountSnapshot[] = []
      // Both documented failures: a read that throws, and one that answers null.
      if (fails('legacy.read', () => { out = w.profiles.map((p) => ({ ...p })) })) { if (fault?.landed) return null; throw boom() }
      return out
    },
    apply(ws) { if (fails('legacy.apply', () => { w.profiles = applyWrites(w.profiles, ws) })) throw boom() },
  }
  return { fs, legacy, calls: () => calls }
}

/** One start: a NEW store on whatever survived, loaded, then the Claude migration. */
async function start(w: World, fault: Fault | null, names: string[] = []) {
  const h = ports(w, fault, names)
  const store = new AccountRegistryStore({ fs: h.fs, now: () => ++clock })
  store.load()
  return { outcome: await store.reconcileLegacy(h.legacy), calls: h.calls() }
}

/** No registry yet: Claude's profiles migrate into it (the upgrade start). */
const firstStart = (): World => ({ file: null, backups: new Map(), profiles: [rec('profile-a1', { isDefault: true }), rec('profile-b2', { colourKey: 'rose' })], history: [], unbacked: 0 })

/** A later start with work on every port: a registry rename to write through, a profile
 *  gone (archived), a new one (created), and old backups to prune. */
function laterStart(): World {
  const first = reconcileLegacyAccounts(emptyRegistry(), 'claude', [rec('profile-a1', { isDefault: true }), rec('profile-b2')], { now: 500, deterministicId: deterministicOpaqueId })
  if (!first.ok) throw new Error(first.problems.join('; '))
  const renamed = updateIdentity(first.doc, first.doc.accounts[0].identityId, { friendlyName: 'Office', colourKey: 'rose' }, 600)
  if (!renamed.ok) throw new Error(renamed.message)
  const backups = new Map(Array.from({ length: 5 }, (_, i) => [`registry.${i + 1}.json.bak`, `older registry ${i + 1}`] as const))
  return { file: text(renamed.doc), backups, profiles: [rec('profile-a1', { isDefault: true }), rec('profile-c3')], history: [], unbacked: 0 }
}

const SCENARIOS = [
  { name: 'a first start (no registry yet)', make: firstStart, points: ['read', 'legacy.read', 'write'], migrated: (doc: ProviderRegistryDoc, profiles: LegacyAccountSnapshot[]) => {
    expect(doc.accounts.map((a) => [a.id, a.isProviderDefault, a.lifecycle])).toEqual([[accountId('profile-a1'), true, 'active'], [accountId('profile-b2'), false, 'active']])
    expect(profiles).toEqual(firstStart().profiles)
  } },
  { name: 'a later start (write-through, archive, create, prune)', make: laterStart, points: ['read', 'legacy.read', 'backup', 'listBackups', 'removeBackup', 'write', 'legacy.apply'], migrated: (doc: ProviderRegistryDoc, profiles: LegacyAccountSnapshot[]) => {
    expect(doc.accounts.map((a) => [a.id, a.lifecycle])).toEqual([[accountId('profile-a1'), 'active'], [accountId('profile-b2'), 'archived'], [accountId('profile-c3'), 'active']])
    expect(findIdentity(doc, doc.accounts[0].identityId)).toMatchObject({ friendlyName: 'Office', colourKey: 'rose' })
    expect(doc.legacyLinks.find((l) => l.legacyId === 'profile-a1')?.shadow).toEqual({ friendlyName: 'Office', colourKey: 'rose', lifecycle: 'active' })
    expect(profiles.map((p) => [p.legacyId, p.friendlyName, p.colourKey])).toEqual([['profile-a1', 'Office', 'rose'], ['profile-c3', 'Name profile-c3', 'pink']])
  } },
]

type Ref = Awaited<ReturnType<typeof reference>>
async function reference(make: () => World) {
  const w = make()
  const names: string[] = []
  const { outcome, calls } = await start(w, null, names)
  return { w, names, outcome, calls, states: new Set([canon(make().file), ...w.history.map(canon)]) }
}

/** Everything that went wrong with one interrupted history, as readable lines. */
function problems(label: string, w: World, ref: Ref, last: LegacyReconcileOutcome): string[] {
  const out: string[] = []
  if (!settled(last)) out.push(`${label}: the clean rerun did not settle: ${JSON.stringify(last)}`)
  if (canon(w.file) !== canon(ref.w.file)) out.push(`${label}: the registry ended unlike the uninterrupted run's`)
  if (canonOf(w.profiles) !== canonOf(ref.w.profiles)) out.push(`${label}: the legacy store ended unlike the uninterrupted run's`)
  const torn = w.history.filter((t) => !fullDoc(t) || !ref.states.has(canon(t)))
  if (torn.length) out.push(`${label}: the registry held ${torn.length} document(s) neither old nor new`)
  if (w.unbacked) out.push(`${label}: ${w.unbacked} write(s) landed with no backup of the file loaded`)
  return out
}

const describeFault = (at: number, names: string[], k: { crash: boolean; landed: boolean }) =>
  `call ${at} (${names[at - 1]}) ${k.crash ? 'crash' : 'error'} ${k.landed ? 'after' : 'before'} it lands`

describe.each(SCENARIOS)('migration interruption: $name', ({ make, points, migrated }) => {
  it('[host] the uninterrupted run migrates, and a second run changes nothing: no write, no backup, no legacy write', async () => {
    const ref = await reference(make)
    expect(settled(ref.outcome)).toBe(true)
    migrated(JSON.parse(ref.w.file!) as ProviderRegistryDoc, ref.w.profiles)
    expect(ref.w.unbacked).toBe(0)
    // A floor, not a ceiling: every interruption point below is really reached.
    expect(ref.names).toEqual(expect.arrayContaining(points))
    const [file, backups, profiles] = [ref.w.file, [...ref.w.backups], canonOf(ref.w.profiles)]
    const names: string[] = []
    const again = await start(ref.w, null, names)
    expect([again.outcome, names, ref.w.file, [...ref.w.backups], canonOf(ref.w.profiles)])
      .toMatchObject([{ ok: true, created: 0, imported: 0, archived: 0, restored: 0, writes: 0 }, ['read', 'legacy.read'], file, backups, profiles])
  })

  it('[host] an interruption at ANY port call converges on one clean rerun to the uninterrupted result, never torn or unbacked, then stays put', async () => {
    const ref = await reference(make)
    const failures: string[] = []
    for (let at = 1; at <= ref.calls; at++) {
      for (const kind of FAULT_KINDS) {
        const label = describeFault(at, ref.names, kind)
        const w = make()
        await start(w, { at, ...kind })
        failures.push(...problems(label, w, ref, (await start(w, null)).outcome))
        const [file, n] = [w.file, w.history.length]
        await start(w, null)
        if (w.file !== file || w.history.length !== n) failures.push(`${label}: a further start wrote again`)
      }
    }
    expect(failures).toEqual([])
  })

  it('[host] two interruptions in a row (any call k, then any call j of the rerun) still converge', async () => {
    const ref = await reference(make)
    const failures: string[] = []
    for (let at = 1; at <= ref.calls; at++) {
      for (const kind of FAULT_KINDS) {
        const after1 = make()
        await start(after1, { at, ...kind })
        const names: string[] = []
        const rerun = await start(clone(after1), null, names)
        for (let at2 = 1; at2 <= rerun.calls; at2++) {
          for (const kind2 of FAULT_KINDS) {
            const w = clone(after1)
            await start(w, { at: at2, ...kind2 })
            failures.push(...problems(`${describeFault(at, ref.names, kind)}, then ${describeFault(at2, names, kind2)}`, w, ref, (await start(w, null)).outcome))
          }
        }
      }
    }
    expect(failures).toEqual([])
  })
})

describe('a refused reconcile', () => {
  it('[host] changes nothing, applies nothing, and is refused again on every rerun until resolved', async () => {
    // A setup in progress already holds the account id profile-a1 would get.
    const held = beginAccountSetup(emptyRegistry(), { accountId: accountId('profile-a1'), realmId: `realm-${'c'.repeat(24)}`, providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:realm-${'c'.repeat(24)}` }, 1)
    if (!held.ok) throw new Error(held.message)
    const w: World = { ...firstStart(), file: text(held.doc) }
    for (let i = 0; i < 2; i++) expect((await start(w, null)).outcome).toMatchObject({ ok: false, code: 'reconcile-refused' })
    expect([w.file, w.history, w.backups.size, w.profiles]).toEqual([text(held.doc), [], 0, firstStart().profiles])
  })
})
