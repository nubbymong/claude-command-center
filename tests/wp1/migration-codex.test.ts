// WP1.43 -- WP2 slice 3e (design 6.3, 6.4, 8.2, 9.3; plan "Existing users"):
// the current Codex home is adopted AT MOST ONCE, on upgrade, as a realm-only
// external account when -- and only when -- the user uses Codex and
// `codex login status` in that home says it is signed in. An undecided
// preference asks first; off, a missing CLI or no answer is recorded as
// skipped with its reason (the user may adopt it explicitly later); an
// interrupted run (whose reservation never outlives an answer), a rerun, a
// setup the user has in progress, an ambient API key and a failed write are
// all covered. The real Codex package runs against a fake CLI and an
// in-memory registry and filesystem.
//
// PURE: no file is written and no process is started (the seam check reads
// source files only).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createCodexPackage } from '../../src/main/providers/codex'
import type { CodexRealmFsPort, CodexCommand, CodexRunOptions, CodexRunResult, CodexDiscoveryDeps } from '../../src/main/providers/codex'
import { AccountRegistryStore, migrateExternalDefaultRealm, packageRegistrationProblem, deterministicOpaqueId } from '../../src/main/providers/core'
import type { RegistryFsPort, ProviderPackage, ProviderPreference } from '../../src/main/providers/core'
import {
  emptyRegistry, parseRegistryDoc, recordProviderMigration, findRealm, beginAccountSetup, commitAccountSetup, createIdentity, setAccountLifecycle,
  markSetupCredentialsWritten, EXTERNAL_DEFAULT_PATH_REF, REGISTRY_SCHEMA_VERSION,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc } from '../../src/shared/providers'

class MemoryPort implements RegistryFsPort {
  file: string | null = null
  failWriteAt: number | null = null
  /** More writes to fail, by number. */
  failWrites: number[] = []
  writes = 0
  backups = 0
  read() { return this.file === null ? { kind: 'missing' as const } : { kind: 'ok' as const, text: this.file } }
  write(text: string) {
    this.writes++
    if ((this.failWriteAt !== null && this.writes === this.failWriteAt) || this.failWrites.includes(this.writes)) throw new Error('disk full')
    this.file = text
  }
  backup() { this.backups++ }
  listBackups() { return [] }
  removeBackup() { /* not under test */ }
}

const RES = 'C:\\res'
const USER = 'C:\\Users\\u'
const EXT_HOME = 'C:\\Users\\u\\.codex'
const EXE = 'C:\\Tools\\codex.exe'
const STAT = { size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '2', isFile: true }
const OWN_ACCOUNT = deterministicOpaqueId('account', 'migration/external-default:codex')
const OWN_REALM = deterministicOpaqueId('realm', 'migration/external-default:codex')

/** Every path its own canonical folder, except those listed as missing. */
function flatFs(missing: Set<string>): CodexRealmFsPort {
  const err = (code: string) => Object.assign(new Error(code), { code })
  const exists = (p: string) => !missing.has(p.toLowerCase())
  return {
    platform: 'win32',
    realpath: (p) => { if (!exists(p)) throw err('ENOENT'); return p },
    lstat: (p) => { if (!exists(p)) throw err('ENOENT'); return { kind: 'dir', dev: '9', ino: String([...p.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)), mode: 0o700 } },
    mkdirSecure: () => {}, mkdir: () => {}, chmod: () => {}, readdir: () => [], unlink: () => {}, rmdir: () => {},
  }
}

interface WorldOpts {
  signedIn?: 'chatgpt' | 'api-key' | 'other' | null
  cli?: boolean
  version?: string
  /** `codex --version` did not answer in time. */
  versionTimedOut?: boolean
  statusOutput?: Partial<CodexRunResult>
  env?: Record<string, string>
  preference?: ProviderPreference | (() => ProviderPreference)
  homeMissing?: boolean
  /** Runs while discovery is in flight. */
  duringDiscovery?: (store: AccountRegistryStore) => Promise<void>
  /** Runs while the status run is in flight. */
  duringStatus?: () => Promise<void>
}

function world(o: WorldOpts = {}, port = new MemoryPort()) {
  let clock = 1000
  const store = new AccountRegistryStore({ fs: port, now: () => ++clock })
  store.load()
  const runs: Array<{ args: string; env: Record<string, string> }> = []
  let discoveries = 0
  const state = { signedIn: o.signedIn === undefined ? 'chatgpt' as const : o.signedIn, cli: o.cli !== false }
  const missing = new Set<string>(o.homeMissing ? [EXT_HOME.toLowerCase()] : [])
  const pkg = createCodexPackage({
    // The registry's side, as the composition root will supply it.
    realms: {
      lookup: async (ref) => {
        const doc = store.current()
        const realm = doc ? findRealm(doc, ref.authRealmId) : undefined
        return realm ? { ok: true, realm, resourcesDir: RES } : { ok: false }
      },
      mkdirSecure: () => {},
    },
    realmFs: flatFs(missing),
    hostHome: { env: o.env ?? {}, homeDir: USER },
    discoveryDeps: async (): Promise<CodexDiscoveryDeps> => {
      discoveries++
      await o.duringDiscovery?.(store)
      return {
        resolve: () => (state.cli ? EXE : null), realpath: (p) => p, stat: () => STAT,
        run: async () => ({ exitCode: 0, stdout: `codex-cli ${o.version ?? '0.155.1'}\n`, stderr: '', timedOut: o.versionTimedOut === true, truncated: false }),
        env: { SystemRoot: 'C:\\Windows' }, platform: 'win32',
        versionHome: () => ({ home: 'C:\\tmp\\v', dispose: () => {} }), now: () => 1,
      }
    },
    authPorts: {
      executablePorts: { resolve: () => EXE, realpath: (p) => p, stat: () => STAT, platform: 'win32' },
      baseEnv: async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-ambient-0000000000000000' }),
      envFilePresent: () => false,
      run: async (cmd: CodexCommand, opts: CodexRunOptions): Promise<CodexRunResult> => {
        runs.push({ args: cmd.args.join(' '), env: { ...opts.env } })
        await o.duringStatus?.()
        const base = { exitCode: 1, stdout: '', stderr: 'Not logged in\n', timedOut: false, truncated: false }
        if (o.statusOutput) return { ...base, ...o.statusOutput }
        if (state.signedIn === 'chatgpt') return { ...base, exitCode: 0, stderr: 'Logged in using ChatGPT\n' }
        if (state.signedIn === 'api-key') return { ...base, exitCode: 0, stderr: 'Logged in using an API key - sk-proj-***1234\n' }
        if (state.signedIn === 'other') return { ...base, exitCode: 0, stderr: 'Logged in using something new\n' }
        return base
      },
    },
  })
  const pref = o.preference ?? 'on'
  const deps = { store, preference: () => (typeof pref === 'function' ? pref() : pref) }
  return { port, store, pkg, runs, deps, state, discoveries: () => discoveries, missing, run: () => migrateExternalDefaultRealm(pkg, deps) }
}

const doc = (w: ReturnType<typeof world>) => w.store.current()!
const marker = (w: ReturnType<typeof world>) => doc(w).migrations.map((m) => m.outcome)
const reasons = (w: ReturnType<typeof world>) => doc(w).migrations.map((m) => m.reason)
const empty = (w: ReturnType<typeof world>) => {
  const d = doc(w)
  return [d.accounts.length, d.realms.length, d.journals.length, d.identities.length]
}
/** A setup of the external home the user started (random ids, not the migration's). */
async function userSetup(w: ReturnType<typeof world>, tag: string) {
  const r = await w.store.mutate((d, t) => beginAccountSetup(d, {
    accountId: 'acct-' + tag.repeat(16), realmId: 'realm-' + tag.repeat(16), providerId: 'codex', method: 'external',
    realmKind: 'codex-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
  }, t))
  expect(r.ok).toBe(true)
}

describe('adopting the current Codex home (WP1.43)', () => {
  it('a signed-in default home becomes one realm-only external account with an unverified private identity, once', async () => {
    const w = world()
    expect(await w.run()).toBe('registered')
    const d = doc(w)
    expect(d.accounts).toHaveLength(1)
    const account = d.accounts[0]
    expect(account).toMatchObject({ id: OWN_ACCOUNT, providerId: 'codex', identityAssurance: 'realm-only', lifecycle: 'active', lastKnownAuthState: 'signed-in', authMethod: 'external' })
    expect(account.providerSubject).toBeUndefined()
    expect(findRealm(d, account.authRealmId)).toMatchObject({ id: OWN_REALM, ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF, lifecycle: 'active', kind: 'codex-home' })
    expect(d.identities.find((i) => i.id === account.identityId)).toMatchObject({ friendlyName: 'External Codex sign-in (account unverified)' })
    expect(d.journals).toEqual([])
    expect(d.migrations).toEqual([expect.objectContaining({ providerId: 'codex', step: 'external-default', outcome: 'registered' })])
    // Status ran in the external home, and nowhere else.
    expect(w.runs.map((r) => [r.args, r.env.CODEX_HOME])).toEqual([['login status', EXT_HOME]])
    expect(await w.run()).toBe('already-done')
    expect(doc(w).accounts).toHaveLength(1)
    expect(w.runs).toHaveLength(1)
  })

  it('the sign-in method is recorded as the provider says it: API key, ChatGPT, or unknown', async () => {
    for (const [signedIn, method] of [['api-key', 'apiKey'], ['chatgpt', 'external'], ['other', 'unknown']] as const) {
      const w = world({ signedIn })
      expect(await w.run(), signedIn).toBe('registered')
      expect(doc(w).accounts[0], signedIn).toMatchObject({ authMethod: method, identityAssurance: 'realm-only' })
    }
  })

  it('a signed-out home registers nothing, and is not asked again', async () => {
    const w = world({ signedIn: null })
    expect(await w.run()).toBe('not-signed-in')
    expect(empty(w)).toEqual([0, 0, 0, 0])
    expect(marker(w)).toEqual(['none'])
    w.state.signedIn = 'chatgpt'
    expect(await w.run()).toBe('already-done')
    expect(doc(w).accounts).toEqual([])
    expect(w.runs).toHaveLength(1)
  })

  it('an API key in the environment is never an account: status cannot see it', async () => {
    const w = world({ signedIn: null })
    expect(await w.run()).toBe('not-signed-in')
    expect(w.runs[0].env.OPENAI_API_KEY).toBeUndefined()
    expect(doc(w).accounts).toEqual([])
  })

  it('an undecided preference asks first: no discovery, no CLI run, no marker -- and runs once the user says yes', async () => {
    let pref: ProviderPreference = 'undecided'
    const w = world({ preference: () => pref })
    expect(await w.run()).toBe('needs-confirmation')
    expect([w.discoveries(), w.runs.length, doc(w).migrations.length, w.port.writes]).toEqual([0, 0, 0, 0])
    // A throwing or odd answer is undecided too, never yes.
    const v = world()
    for (const odd of [() => { throw new Error('settings unreadable') }, () => true as never, () => 'yes' as never]) {
      expect(await migrateExternalDefaultRealm(v.pkg, { store: v.store, preference: odd })).toBe('needs-confirmation')
    }
    expect(v.runs).toEqual([])
    pref = 'on'
    expect(await w.run()).toBe('registered')
  })

  it('a provider switched off is not checked: marker "skipped", nothing else, never asked again automatically', async () => {
    let pref: ProviderPreference = 'off'
    const w = world({ preference: () => pref })
    expect(await w.run()).toBe('skipped')
    expect([w.discoveries(), w.runs.length]).toEqual([0, 0])
    expect(empty(w)).toEqual([0, 0, 0, 0])
    expect(marker(w)).toEqual(['skipped'])
    expect(reasons(w)).toEqual(['off'])
    pref = 'on'
    expect(await w.run()).toBe('already-done')
    expect(w.runs).toEqual([])
  })

  it('a preference switched off during the check drops the reservation and records skipped, before and after the status run', async () => {
    let pref: ProviderPreference = 'on'
    const before = world({ preference: () => pref, duringDiscovery: async () => { pref = 'off' } })
    expect(await before.run()).toBe('skipped')
    expect(before.runs).toEqual([])
    expect(empty(before)).toEqual([0, 0, 0, 0])
    expect(reasons(before)).toEqual(['off'])
    let pref2: ProviderPreference = 'on'
    const after = world({ preference: () => pref2, duringStatus: async () => { pref2 = 'off' } })
    expect(await after.run()).toBe('skipped')
    expect(empty(after)).toEqual([0, 0, 0, 0])
    expect(marker(after)).toEqual(['skipped'])
    expect(reasons(after)).toEqual(['off'])
  })

  it('a preference that stops being a yes or no mid-run is no answer: the reservation goes, nothing is recorded, the user is asked', async () => {
    const undecided: Array<() => ProviderPreference> = [() => 'undecided', () => { throw new Error('settings unreadable') }]
    for (const [i, mid] of undecided.entries()) {
      // Before the status run, and before the commit.
      for (const when of ['duringDiscovery', 'duringStatus'] as const) {
        let pref: () => ProviderPreference = () => 'on'
        let flips = 0
        const flip = async () => { if (flips++ === 0) pref = mid }
        const w = world({ preference: () => pref(), ...(when === 'duringDiscovery' ? { duringDiscovery: flip } : { duringStatus: flip }) })
        expect(await w.run(), `${i} ${when}`).toBe('needs-confirmation')
        expect(empty(w), `${i} ${when}`).toEqual([0, 0, 0, 0])
        expect(doc(w).migrations, `${i} ${when}`).toEqual([])
        expect(w.runs.length, `${i} ${when}`).toBe(when === 'duringStatus' ? 1 : 0)
        pref = () => 'on'
        expect(await w.run(), `${i} ${when}`).toBe('registered')
      }
    }
  })

  it('no usable CLI -- missing, unreadable, too old or not answering -- is not checked: marker "skipped" with its reason, and nothing left behind', async () => {
    const cases: Array<[WorldOpts, string]> = [[{ cli: false }, 'no-cli'], [{ version: 'banana' }, 'cli-unsupported'], [{ version: '0.100.0' }, 'cli-unsupported'], [{ versionTimedOut: true }, 'unavailable']]
    for (const [o, reason] of cases) {
      const w = world(o)
      const r = await w.run()
      expect(r, JSON.stringify(o)).toBe('skipped')
      expect(empty(w), JSON.stringify(o)).toEqual([0, 0, 0, 0])
      expect(marker(w), JSON.stringify(o)).toEqual(['skipped'])
      expect(reasons(w), JSON.stringify(o)).toEqual([reason])
      // Never reserved: the status run never happened, and one write only.
      expect([w.runs.length, w.port.writes], JSON.stringify(o)).toEqual([0, 1])
      expect(await w.run()).toBe('already-done')
    }
  })

  it('an answer status does not recognise, a missing home, an overlapping one or a status that cannot run drops the reservation and records skipped with its reason, once', async () => {
    const cases: Array<[WorldOpts, string]> = [
      [{ statusOutput: { exitCode: 2, stderr: 'Error: config\n' } }, 'no-answer'],
      [{ homeMissing: true }, 'home-missing'],
      [{ env: { CODEX_HOME: 'C:\\res\\codex-realms' } }, 'overlap'],
      [{ statusOutput: { timedOut: true } }, 'unavailable'],
      [{ statusOutput: { spawnError: 'ENOENT' } }, 'unavailable'],
    ]
    for (const [o, reason] of cases) {
      const w = world(o)
      expect(await w.run(), JSON.stringify(o)).toBe('skipped')
      expect(empty(w), JSON.stringify(o)).toEqual([0, 0, 0, 0])
      expect(marker(w), JSON.stringify(o)).toEqual(['skipped'])
      expect(reasons(w), JSON.stringify(o)).toEqual([reason])
      const writes = w.port.writes
      expect(await w.run()).toBe('already-done')
      // Nothing churns on later starts.
      expect(w.port.writes).toBe(writes)
    }
  })

  it('a status that fails is never a sign-in or a sign-out, whatever state it carries; one that throws could not answer', async () => {
    for (const [status, reason] of [
      [async () => ({ ok: false, code: 'not-confirmed', state: 'signed-in', credential: 'account' }), 'no-answer'],
      [async () => ({ ok: false, code: 'busy', state: 'signed-in' }), 'unavailable'],
      // Usable at discovery, refused at status: another check is running, or it just changed.
      [async () => ({ ok: false, code: 'cli-unavailable' }), 'unavailable'],
      [async () => ({ ok: false, code: 'provider-refused', state: 'signed-out' }), 'no-answer'],
      [async () => ({ ok: true, state: 'unknown' }), 'no-answer'],
      [async () => { throw new Error('boom') }, 'unavailable'],
    ] as const) {
      const w = world()
      const pkg = { ...w.pkg, auth: { ...w.pkg.auth!, status: status as never } }
      expect(await migrateExternalDefaultRealm(pkg, w.deps)).toBe('skipped')
      expect(empty(w)).toEqual([0, 0, 0, 0])
      expect(reasons(w)).toEqual([reason])
    }
  })

  it('a CLI that discovery calls found but unusable is skipped there, before anything is reserved', async () => {
    for (const compatibility of ['too-old', 'unsupported'] as const) {
      const w = world()
      const setup = { ...w.pkg.setup!, discover: async () => ({ state: 'found' as const, compatibility, version: '9.9.9', checkedAt: 1 }) }
      expect(await migrateExternalDefaultRealm({ ...w.pkg, setup }, w.deps), compatibility).toBe('skipped')
      expect(reasons(w), compatibility).toEqual(['cli-unsupported'])
      expect([w.runs.length, w.port.writes], compatibility).toEqual([0, 1])
    }
  })

  it('an interrupted run leaves its own reservation, which the next run drops before it tries again', async () => {
    const w = world()
    const r = await w.store.mutate((d, t) => beginAccountSetup(d, {
      accountId: OWN_ACCOUNT, realmId: OWN_REALM, providerId: 'codex', method: 'external',
      realmKind: 'codex-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
    }, t))
    expect(r.ok).toBe(true)
    expect(await w.run()).toBe('registered')
    const d = doc(w)
    expect([d.accounts.length, d.realms.length, d.journals.length]).toEqual([1, 1, 0])
  })

  it('an interrupted run\'s reservation never outlives the answer: off, undecided or a marker already there, it goes, and the user can adopt the home', async () => {
    const reserveOwn = (w: ReturnType<typeof world>) => w.store.mutate((d, t) => beginAccountSetup(d, {
      accountId: OWN_ACCOUNT, realmId: OWN_REALM, providerId: 'codex', method: 'external',
      realmKind: 'codex-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
    }, t))
    const preMarked = world()
    expect((await preMarked.store.mutate((d, t) => recordProviderMigration(d, { providerId: 'codex', step: 'external-default', outcome: 'none' }, t))).ok).toBe(true)
    for (const [label, w, preference, outcome, tag] of [
      ['off', world(), 'off', 'skipped', 'a'],
      ['undecided', world(), 'undecided', 'needs-confirmation', 'b'],
      ['marked', preMarked, 'on', 'already-done', 'c'],
    ] as const) {
      expect((await reserveOwn(w)).ok, label).toBe(true)
      // A restart reads the leftover from disk.
      const again = world({ preference }, w.port)
      expect(again.store.current()!.journals.map((j) => j.accountId), label).toEqual([OWN_ACCOUNT])
      expect(await again.run(), label).toBe(outcome)
      expect(again.store.current()!.journals, label).toEqual([])
      expect(again.runs, label).toEqual([])
      // The user's explicit adoption of the same home is not blocked.
      await userSetup(again, tag)
    }
  })

  it('an interrupted run\'s reservation that cannot be dropped is retried next start: no marker, no CLI run', async () => {
    const w = world()
    expect((await w.store.mutate((d, t) => beginAccountSetup(d, {
      accountId: OWN_ACCOUNT, realmId: OWN_REALM, providerId: 'codex', method: 'external',
      realmKind: 'codex-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
    }, t))).ok).toBe(true)
    w.port.failWriteAt = w.port.writes + 1
    expect(await w.run()).toBe('retry-later')
    expect([doc(w).journals.length, doc(w).migrations.length, w.discoveries(), w.runs.length]).toEqual([1, 0, 0, 0])
    w.port.failWriteAt = null
    expect(await w.run()).toBe('registered')
  })

  it('the migration\'s own ids cannot be a legacy profile\'s: a setup under the id a legacy "external-default-migration" profile would get is never dropped', async () => {
    const legacyLike = deterministicOpaqueId('account', 'codex:external-default-migration')
    expect(legacyLike).not.toBe(OWN_ACCOUNT)
    const w = world()
    expect((await w.store.mutate((d, t) => beginAccountSetup(d, {
      accountId: legacyLike, realmId: deterministicOpaqueId('realm', 'codex:external-default-migration'), providerId: 'codex', method: 'external',
      realmKind: 'codex-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
    }, t))).ok).toBe(true)
    expect(await w.run()).toBe('retry-later')
    expect(doc(w).journals.map((j) => j.accountId)).toEqual([legacyLike])
    expect(doc(w).migrations).toEqual([])
  })

  it('no answer ever drops another setup in progress: a managed one and another provider\'s survive every outcome', async () => {
    const managed = 'acct-' + 'b'.repeat(16)
    const claude = 'acct-' + 'c'.repeat(16)
    const others = async (w: ReturnType<typeof world>) => {
      const r = await w.store.mutate((d, t) => {
        const x = beginAccountSetup(d, { accountId: managed, realmId: 'realm-' + 'b'.repeat(16), providerId: 'codex', method: 'device', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:realm-${'b'.repeat(16)}` }, t)
        return x.ok ? beginAccountSetup(x.doc, { accountId: claude, realmId: 'realm-' + 'c'.repeat(16), providerId: 'claude', method: 'external', realmKind: 'claude-config-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF }, t) : x
      })
      expect(r.ok).toBe(true)
    }
    const survivors = (w: ReturnType<typeof world>) => doc(w).journals.map((j) => j.accountId).sort()
    let pref: ProviderPreference = 'on'
    const cases: Array<[string, WorldOpts, string]> = [
      ['off', { preference: 'off' }, 'skipped'],
      ['signed out', { signedIn: null }, 'not-signed-in'],
      ['no CLI', { cli: false }, 'skipped'],
      ['no answer', { statusOutput: { exitCode: 2, stderr: 'Error: config\n' } }, 'skipped'],
      ['registered', {}, 'registered'],
      ['undecided mid-run', { preference: () => pref, duringDiscovery: async () => { pref = 'undecided' } }, 'needs-confirmation'],
    ]
    for (const [label, o, outcome] of cases) {
      const w = world(o)
      await others(w)
      expect(await w.run(), label).toBe(outcome)
      expect(survivors(w), label).toEqual([managed, claude].sort())
    }
  })

  it('a setup the user started is never dropped: an external one waits for the next start, a managed one and another provider\'s are untouched', async () => {
    const w = world()
    await userSetup(w, 'a')
    const managed = await w.store.mutate((d, t) => {
      const x = beginAccountSetup(d, { accountId: 'acct-' + 'b'.repeat(16), realmId: 'realm-' + 'b'.repeat(16), providerId: 'codex', method: 'device', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:realm-${'b'.repeat(16)}` }, t)
      return x.ok ? markSetupCredentialsWritten(x.doc, 'acct-' + 'b'.repeat(16), t) : x
    })
    expect(managed.ok).toBe(true)
    expect(await w.run()).toBe('retry-later')
    const d = doc(w)
    expect(d.journals.map((j) => j.accountId).sort()).toEqual(['acct-' + 'a'.repeat(16), 'acct-' + 'b'.repeat(16)])
    expect(d.migrations).toEqual([])
    expect(w.runs).toEqual([])
  })

  it('a setup of the same home that starts while discovery runs is not taken for an answer', async () => {
    const w = world({ duringDiscovery: (store) => store.mutate((d, t) => beginAccountSetup(d, {
      accountId: 'acct-' + 'e'.repeat(16), realmId: 'realm-' + 'e'.repeat(16), providerId: 'codex', method: 'external',
      realmKind: 'codex-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
    }, t)).then(() => undefined) })
    expect(await w.run()).toBe('retry-later')
    expect(doc(w).migrations).toEqual([])
    expect(doc(w).journals).toHaveLength(1)
    expect(w.runs).toEqual([])
  })

  it('an account committed while discovery runs is the answer', async () => {
    const w = world({ duringDiscovery: (store) => store.mutate((d, t) => chainAdopt(d, t)).then(() => undefined) })
    expect(await w.run()).toBe('already-done')
    expect(marker(w)).toEqual(['registered'])
    expect(w.runs).toEqual([])
  })

  it('an external account registered some other way -- even archived since -- is the answer: recorded, and the CLI is not run', async () => {
    const w = world()
    const made = await w.store.mutate((d, t) => {
      const x = chainAdopt(d, t)
      if (!x.ok) return x
      const y = setAccountLifecycle(x.doc, 'acct-' + 'd'.repeat(16), 'inactive', { consumers: 0 }, t)
      return y.ok ? setAccountLifecycle(y.doc, 'acct-' + 'd'.repeat(16), 'archived', { consumers: 0 }, t) : y
    })
    expect(made.ok).toBe(true)
    expect(findRealm(doc(w), 'realm-' + 'd'.repeat(16))?.lifecycle).toBe('retired')
    expect(await w.run()).toBe('already-done')
    expect([w.runs.length, w.discoveries(), doc(w).accounts.length]).toEqual([0, 0, 1])
    expect(marker(w)).toEqual(['registered'])
  })

  it('another provider\'s external realm is not this one\'s answer', async () => {
    const w = world()
    const acct = 'acct-' + 'f'.repeat(16)
    const idn = 'idn-' + 'f'.repeat(16)
    const made = await w.store.mutate((d, t) => {
      let x = beginAccountSetup(d, { accountId: acct, realmId: 'realm-' + 'f'.repeat(16), providerId: 'claude', method: 'external', realmKind: 'claude-config-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF }, t)
      if (!x.ok) return x
      x = createIdentity(x.doc, { id: idn, colourKey: 'pink' }, t)
      return x.ok ? commitAccountSetup(x.doc, acct, { identityId: idn, authMethod: 'external', lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, t) : x
    })
    expect(made.ok).toBe(true)
    expect(await w.run()).toBe('registered')
    expect(doc(w).accounts.map((a) => a.providerId).sort()).toEqual(['claude', 'codex'])
  })

  it('a registry in recovery mode is left alone', async () => {
    const port = new MemoryPort()
    port.file = '{ not json'
    const store = new AccountRegistryStore({ fs: port, now: () => 1 })
    store.load()
    const w = world()
    expect(await migrateExternalDefaultRealm(w.pkg, { store, preference: () => 'on' })).toBe('registry-unavailable')
    expect(w.runs).toEqual([])
  })

  it('an account that could not be saved is not half-made; the reservation goes, and the next start tries again', async () => {
    const w = world()
    // Write 1 reserves; write 2 would commit the account.
    w.port.failWriteAt = 2
    expect(await w.run()).toBe('retry-later')
    expect(empty(w)).toEqual([0, 0, 0, 0])
    expect(doc(w).migrations).toEqual([])
    w.port.failWriteAt = null
    expect(await w.run()).toBe('registered')
  })

  it('a signed-out answer that could not be saved records nothing and drops the reservation on its own, so the user can adopt the home in the same session', async () => {
    const w = world({ signedIn: null })
    // Write 1 reserves; write 2 would drop it and record "none" together;
    // write 3 drops it alone.
    w.port.failWriteAt = 2
    expect(await w.run()).toBe('retry-later')
    expect([doc(w).journals.length, doc(w).migrations.length]).toEqual([0, 0])
    // Nothing on disk either: no marker, so the next start runs again.
    const again = world({ signedIn: null }, w.port)
    expect([again.store.current()!.journals.length, again.store.current()!.migrations.length]).toEqual([0, 0])
    await userSetup(w, 'a')
  })

  it('an answer and the drop after it that both fail leave the reservation, which the next start drops before it asks again', async () => {
    const w = world({ signedIn: null })
    w.port.failWrites = [2, 3]
    expect(await w.run()).toBe('retry-later')
    // A restart reads what is on disk.
    const again = world({ signedIn: null }, w.port)
    const onDisk = again.store.current()!
    expect([onDisk.journals.length, onDisk.migrations.length]).toEqual([1, 0])
    w.port.failWrites = []
    expect(await again.run()).toBe('not-signed-in')
    expect(empty(again)).toEqual([0, 0, 0, 0])
    expect(marker(again)).toEqual(['none'])
  })

  it('two runs at once are one run', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const w = world({ duringStatus: () => gate })
    const a = w.run()
    const b = w.run()
    release()
    expect(await a).toBe('registered')
    expect(await b).toBe('registered')
    expect(w.runs).toHaveLength(1)
    expect(doc(w).accounts).toHaveLength(1)
  })

  it('a caller that wraps the store afresh waits for the run in flight, then finds it done: still one check', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const w = world({ duringStatus: () => gate })
    const wrapped = () => ({ store: { current: () => w.store.current(), mutate: w.store.mutate.bind(w.store), status: () => w.store.status() }, preference: () => 'on' as const })
    const a = migrateExternalDefaultRealm(w.pkg, wrapped())
    const b = migrateExternalDefaultRealm(w.pkg, wrapped())
    release()
    expect([await a, await b]).toEqual(['registered', 'already-done'])
    expect([w.runs.length, w.discoveries()]).toEqual([1, 1])
    expect(doc(w).accounts).toHaveLength(1)
  })

  it('a run that settles never frees the slot of the run waiting behind it: a third caller still waits, and never drops the second\'s reservation', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const w = world({ duringStatus: () => gate })
    const wrapped = { store: { current: () => w.store.current(), mutate: w.store.mutate.bind(w.store), status: () => w.store.status() }, preference: () => 'on' as const }
    try {
      const first = migrateExternalDefaultRealm(w.pkg, { store: w.store, preference: () => 'undecided' })
      const second = migrateExternalDefaultRealm(w.pkg, wrapped)
      expect(await first).toBe('needs-confirmation')
      // The second is now in its status run.
      await new Promise((res) => setTimeout(res, 0))
      expect([w.discoveries(), w.runs.length]).toEqual([1, 1])
      const third = migrateExternalDefaultRealm(w.pkg, { store: w.store, preference: () => 'on' })
      await new Promise((res) => setTimeout(res, 0))
      // Waiting behind the second, not running beside it.
      expect([w.discoveries(), w.runs.length]).toEqual([1, 1])
      release()
      expect([await second, await third]).toEqual(['registered', 'already-done'])
      expect(doc(w).accounts).toHaveLength(1)
    } finally {
      release()
    }
  })

  it('a run that fails does not fail the one waiting behind it', async () => {
    const w = world()
    const broken = { store: { current: () => w.store.current(), mutate: w.store.mutate.bind(w.store), status: (): never => { throw new Error('status unreadable') } }, preference: () => 'on' as const }
    const first = migrateExternalDefaultRealm(w.pkg, broken)
    const second = w.run()
    await expect(first).rejects.toThrow('status unreadable')
    expect(await second).toBe('registered')
  })

  it('a run for another registry is never answered by the one in flight: it waits, then runs against its own', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const w = world({ duringStatus: () => gate })
    const v = world()
    const a = w.run()
    const b = v.run()
    await new Promise((res) => setTimeout(res, 0))
    // Waiting: nothing of its own has started yet.
    expect([v.discoveries(), v.port.writes, v.runs.length]).toEqual([0, 0, 0])
    release()
    expect([await a, await b]).toEqual(['registered', 'registered'])
    for (const x of [w, v]) {
      expect(doc(x).accounts).toHaveLength(1)
      expect(marker(x)).toEqual(['registered'])
      expect(x.runs).toHaveLength(1)
    }
  })

  it('a package without an external default home, setup or auth is not touched', async () => {
    const w = world()
    for (const drop of ['externalDefaultRealm', 'setup', 'auth'] as const) {
      const { [drop]: _gone, ...bare } = w.pkg
      expect(await migrateExternalDefaultRealm(bare as ProviderPackage, w.deps), drop).toBe('unsupported')
    }
    expect(w.runs).toEqual([])
  })
})

/** An external account made the way the Accounts surface will make one. */
function chainAdopt(d: ProviderRegistryDoc, t: number) {
  const acct = 'acct-' + 'd'.repeat(16)
  const realm = 'realm-' + 'd'.repeat(16)
  const idn = 'idn-' + 'd'.repeat(16)
  let x = beginAccountSetup(d, { accountId: acct, realmId: realm, providerId: 'codex', method: 'external', realmKind: 'codex-home', ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF }, t)
  if (!x.ok) return x
  x = createIdentity(x.doc, { id: idn, friendlyName: 'Mine', colourKey: 'pink' }, t)
  if (!x.ok) return x
  return commitAccountSetup(x.doc, acct, { identityId: idn, authMethod: 'external', lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, t)
}

describe('the migration marker, the schema and the package declaration', () => {
  it('the marker is append-only and round-trips; one per provider and step; a reason exactly when skipped', () => {
    const a = recordProviderMigration(emptyRegistry(), { providerId: 'codex', step: 'external-default', outcome: 'skipped', reason: 'unavailable' }, 5)
    expect(a.ok).toBe(true)
    const d = (a as { doc: ProviderRegistryDoc }).doc
    const b = recordProviderMigration(d, { providerId: 'codex', step: 'external-default', outcome: 'registered' }, 6)
    expect((b as { doc: ProviderRegistryDoc }).doc.migrations).toEqual([{ providerId: 'codex', step: 'external-default', outcome: 'skipped', reason: 'unavailable', at: 5 }])
    expect(parseRegistryDoc(JSON.parse(JSON.stringify(d)))).toMatchObject({ ok: true, doc: { migrations: d.migrations } })
    const none = (recordProviderMigration(emptyRegistry(), { providerId: 'codex', step: 'external-default', outcome: 'none' }, 7) as { doc: ProviderRegistryDoc }).doc
    expect(none.migrations[0]).not.toHaveProperty('reason')
    expect(parseRegistryDoc(JSON.parse(JSON.stringify(none)))).toMatchObject({ ok: true, doc: { migrations: none.migrations } })
    const m = d.migrations[0]
    for (const bad of [
      { ...d, migrations: 'x' },
      { ...d, migrations: [{ providerId: 'codex', step: 'nope', outcome: 'none', at: 1 }] },
      { ...d, migrations: [...d.migrations, ...d.migrations] },
      { ...d, migrations: [{ ...m, reason: undefined }] },
      { ...d, migrations: [{ ...m, reason: 'bored' }] },
      { ...d, migrations: [{ ...m, outcome: 'none' }] },
      { ...d, migrations: [{ ...m, outcome: 'registered' }] },
    ]) {
      expect(parseRegistryDoc(JSON.parse(JSON.stringify(bad))), JSON.stringify(bad.migrations)).toMatchObject({ ok: false })
    }
    for (const input of [
      { providerId: 'x', step: 'external-default', outcome: 'none' },
      { providerId: 'codex', step: 'y', outcome: 'none' },
      { providerId: 'codex', step: 'external-default', outcome: 'maybe' },
      { providerId: 'codex', step: 'external-default', outcome: 'skipped' },
      { providerId: 'codex', step: 'external-default', outcome: 'skipped', reason: 'bored' },
      { providerId: 'codex', step: 'external-default', outcome: 'none', reason: 'off' },
      { providerId: 'codex', step: 'external-default', outcome: 'registered', reason: 'off' },
    ]) {
      expect(recordProviderMigration(emptyRegistry(), input as never, 1), JSON.stringify(input)).toMatchObject({ ok: false })
    }
  })

  it('schema 2 requires the list; a schema 1 file (no list yet) reads as none recorded and is written back as 2', async () => {
    expect(REGISTRY_SCHEMA_VERSION).toBe(2)
    const { migrations: _m, ...v2NoList } = emptyRegistry()
    expect(parseRegistryDoc(v2NoList)).toMatchObject({ ok: false })
    const v1 = { ...v2NoList, schemaVersion: 1 }
    expect(parseRegistryDoc(v1)).toMatchObject({ ok: true, doc: { schemaVersion: 2, migrations: [] } })
    expect(parseRegistryDoc({ ...v1, schemaVersion: 3 })).toMatchObject({ ok: false, reason: 'newer-schema' })
    const port = new MemoryPort()
    port.file = JSON.stringify(v1)
    const w = world({ signedIn: null }, port)
    expect(await w.run()).toBe('not-signed-in')
    expect(JSON.parse(port.file!)).toMatchObject({ schemaVersion: 2, migrations: [expect.objectContaining({ outcome: 'none' })] })
  })

  it('Codex declares its external home only when wired; a declaration must be well formed and backed', () => {
    expect(createCodexPackage().externalDefaultRealm).toBeUndefined()
    const w = world()
    expect(w.pkg.externalDefaultRealm).toEqual({ kind: 'codex-home', identityLabel: 'External Codex sign-in (account unverified)' })
    expect(packageRegistrationProblem(w.pkg)).toBeNull()
    expect(packageRegistrationProblem({ ...w.pkg, externalDefaultRealm: { kind: 'claude-config-home', identityLabel: 'x' } })).toMatch(/realm kind/)
    expect(packageRegistrationProblem({ ...w.pkg, externalDefaultRealm: { kind: 'codex-home', identityLabel: ' ' } })).toMatch(/identityLabel/)
    expect(packageRegistrationProblem({ ...w.pkg, externalDefaultRealm: null as never })).toMatch(/externalDefaultRealm/)
    for (const drop of ['auth', 'setup'] as const) {
      const { [drop]: _gone, ...without } = w.pkg
      expect(packageRegistrationProblem(without as ProviderPackage), drop).toMatch(/setup and auth/)
    }
  })

  it('production composes the Codex package without any test seam, wherever it is created', () => {
    const src = path.resolve(__dirname, '../../src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(src)
    const definition = path.join(src, 'main', 'providers', 'codex', 'index.ts')
    const callers = files.filter((f) => f !== definition && /\bcreateCodexPackage\b/.test(fs.readFileSync(f, 'utf8')))
    // Only the composition root refers to it (as its factory, or a call).
    expect(callers.map((f) => path.relative(src, f).split(path.sep).join('/'))).toEqual(['main/providers/compose.ts'])
    for (const f of callers) {
      const text = fs.readFileSync(f, 'utf8')
      for (const seam of ['hostHome', 'realmFs', 'authPorts', 'discoveryDeps']) expect(text, `${f} ${seam}`).not.toContain(seam)
    }
  })
})
