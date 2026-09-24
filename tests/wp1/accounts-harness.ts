// WP1.16 / WP1.46 / WP1.47 / WP1.51 / WP1.59 -- shared harness for the
// accounts-service suites (WP2 commit 3). PURE: the real Codex package runs
// against a fake CLI, an in-memory folder tree and an in-memory registry; the
// real Claude package supplies Claude's declarations and its accounts arrive
// through the legacy reconcile, exactly as at start. No file is written and
// no process is started.
import { createCodexPackage } from '../../src/main/providers/codex'
import type { CodexRealmFsPort, CodexCommand, CodexRunOptions, CodexRunResult, CodexDiscoveryDeps, CodexFsEntry } from '../../src/main/providers/codex'
import { createClaudePackage } from '../../src/main/providers/claude'
import { AccountRegistryStore, AccountsService, ConsumerLeaseRegistry, SecretHandleStore, registerProviderPackage, _resetProviderRegistryForTest } from '../../src/main/providers/core'
import type { RegistryFsPort, ProviderPackage, LegacyAccountsPort } from '../../src/main/providers/core'
import { findRealm } from '../../src/shared/providers'
import type { LegacyAccountSnapshot, ProviderId, ProviderPreference, ScopedCapabilityKey, ProviderRegistryDoc, ProviderCapabilities } from '../../src/shared/providers'

export class MemoryPort implements RegistryFsPort {
  file: string | null = null
  failWrites: number[] = []
  writes = 0
  read() { return this.file === null ? { kind: 'missing' as const } : { kind: 'ok' as const, text: this.file } }
  write(text: string) {
    this.writes++
    if (this.failWrites.includes(this.writes)) throw new Error('disk full')
    this.file = text
  }
  backup() { /* not under test */ }
  listBackups() { return [] }
  removeBackup() { /* not under test */ }
}

export const RES = 'C:\\res'
export const USER = 'C:\\Users\\u'
export const EXT_HOME = 'C:\\Users\\u\\.codex'
export const EXE = 'C:\\Tools\\codex.exe'
export const KEY = 'sk-proj-' + 'Q'.repeat(40) + '7788'
const STAT = { size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '2', isFile: true }

export const managedHome = (realmId: string) => `${RES}\\codex-realms\\${realmId}`

/** A small in-memory folder tree, Windows-shaped: what the realm folder code
 *  walks, creates and removes. Every call is logged. */
export function memoryFs() {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const dirs = new Set<string>(['c:', 'c:\\res', 'c:\\users', 'c:\\users\\u', 'c:\\users\\u\\.codex', 'c:\\tools'])
  const files = new Set<string>()
  const log: string[] = []
  const err = (code: string) => Object.assign(new Error(code), { code })
  const ino = (p: string) => String([...norm(p)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7))
  const parent = (p: string) => norm(p).split('\\').slice(0, -1).join('\\')
  const fs: CodexRealmFsPort = {
    platform: 'win32',
    realpath: (p) => { if (!dirs.has(norm(p)) && !files.has(norm(p))) throw err('ENOENT'); return p.replace(/[\\/]+$/, '') || p },
    lstat: (p): CodexFsEntry => {
      const n = norm(p)
      if (dirs.has(n)) return { kind: 'dir', dev: '9', ino: ino(p), mode: 0o700 }
      if (files.has(n)) return { kind: 'file', dev: '9', ino: ino(p), mode: 0o600 }
      throw err('ENOENT')
    },
    mkdirSecure: (dir) => {
      log.push(`mkdirSecure ${dir}`)
      const parts = norm(dir).split('\\')
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('\\'))
    },
    mkdir: (dir) => {
      log.push(`mkdir ${dir}`)
      if (!dirs.has(parent(dir))) throw err('ENOENT')
      if (dirs.has(norm(dir))) throw err('EEXIST')
      dirs.add(norm(dir))
    },
    chmod: () => {},
    readdir: (dir) => {
      const n = norm(dir)
      if (!dirs.has(n)) throw err('ENOENT')
      return [...dirs, ...files].filter((x) => parent(x) === n).map((x) => x.slice(n.length + 1))
    },
    unlink: (p) => { log.push(`unlink ${p}`); if (!files.delete(norm(p))) throw err('ENOENT') },
    rmdir: (p) => {
      log.push(`rmdir ${p}`)
      const n = norm(p)
      if ([...dirs, ...files].some((x) => parent(x) === n)) throw err('ENOTEMPTY')
      if (!dirs.delete(n)) throw err('ENOENT')
    },
  }
  return { fs, dirs, files, log, exists: (p: string) => dirs.has(norm(p)) }
}

export type Via = 'chatgpt' | 'api-key'
export interface CliRun { args: string; home: string; env: Record<string, string>; opts: CodexRunOptions }
export type CliScript = Partial<Record<string, (r: CliRun) => Partial<CodexRunResult> | Promise<Partial<CodexRunResult>>>>

export interface HarnessOpts {
  preference?: Partial<Record<ProviderId, ProviderPreference | (() => ProviderPreference)>>
  experimental?: ScopedCapabilityKey[]
  script?: CliScript
  /** Claude accounts as its own profiles list would show them. */
  claude?: LegacyAccountSnapshot[]
  port?: MemoryPort
  cli?: boolean
  /** The folder tree of an earlier start (a restart keeps the disk). */
  folders?: ReturnType<typeof memoryFs>
  /** Running sessions that hold no account lease, per provider (Claude's). */
  unleasedSessions?: (providerId: ProviderId) => number
}

export const claudeSnapshot = (legacyId: string, over: Partial<LegacyAccountSnapshot> = {}): LegacyAccountSnapshot => ({
  legacyId, friendlyName: `Name ${legacyId}`, colourKey: 'pink', lifecycle: 'active', isDefault: false, providerLabel: `${legacyId}@example.com`,
  realm: { kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: `claude-profile:${legacyId}` },
  authMethod: 'browser', identityAssurance: 'user-asserted', ...over,
})

let hexSeq = 0
/** Deterministic-but-unique randomness for ids. */
export const nextHex = () => (++hexSeq).toString(16).padStart(32, '0')

export async function harness(o: HarnessOpts = {}) {
  let clock = 1_000_000
  const now = () => ++clock
  const port = o.port ?? new MemoryPort()
  const leases = new ConsumerLeaseRegistry()
  const store = new AccountRegistryStore({ fs: port, now, consumers: (id) => leases.count(id) })
  store.load()
  const folders = o.folders ?? memoryFs()
  const signedIn = new Map<string, Via>()
  const runs: CliRun[] = []
  const logs: string[] = []
  let discoveries = 0
  // `envFile`: homes holding a `.env`; `exeStat`: the executable as re-read
  // now (a different one = replaced after setup proved it).
  const state = { cli: o.cli !== false, envFile: new Set<string>(), exeStat: STAT }
  const status = (home: string): Partial<CodexRunResult> => {
    const v = signedIn.get(home.toLowerCase())
    if (v === 'chatgpt') return { exitCode: 0, stderr: 'Logged in using ChatGPT\n' }
    if (v === 'api-key') return { exitCode: 0, stderr: 'Logged in using an API key - sk-proj-***7788\n' }
    return { exitCode: 1, stderr: 'Not logged in\n' }
  }
  const behaviour: CliScript = {
    'login status': (r) => status(r.home),
    'logout': (r) => { signedIn.delete(r.home.toLowerCase()); return { exitCode: 0, stdout: 'Successfully logged out\n' } },
    'login': (r) => {
      r.opts.onOutput?.('Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL:\nhttps://auth.example/oauth/authorize?state=abc\n', 'stderr')
      signedIn.set(r.home.toLowerCase(), 'chatgpt')
      return { exitCode: 0, stdout: 'Successfully logged in\n' }
    },
    'login --device-auth': (r) => {
      r.opts.onOutput?.('1. Open https://auth.example/codex/device\n2. Enter this one-time code\n   ABCD-EFGH\n', 'stdout')
      signedIn.set(r.home.toLowerCase(), 'chatgpt')
      return { exitCode: 0 }
    },
    'login --with-api-key': (r) => {
      if (typeof r.opts.stdin !== 'string' || !r.opts.stdin.trim()) return { exitCode: 3 }
      // A hostile CLI echoing the key back: the redactor must catch it.
      r.opts.onOutput?.(`read key ${r.opts.stdin.trim()}\n`, 'stdout')
      signedIn.set(r.home.toLowerCase(), 'api-key')
      return { exitCode: 0, stdout: 'Successfully logged in\n' }
    },
    ...o.script,
  }
  const secrets = new SecretHandleStore({ now })
  const codex = createCodexPackage({
    realms: {
      lookup: async (ref) => {
        const doc = active?.current()
        const realm = doc ? findRealm(doc, ref.authRealmId) : undefined
        return realm ? { ok: true, realm, resourcesDir: RES } : { ok: false }
      },
      mkdirSecure: (dir) => folders.fs.mkdirSecure(dir),
    },
    auth: { takeSecret: (h) => secrets.take(h) },
    realmFs: folders.fs,
    hostHome: { env: {}, homeDir: USER },
    discoveryDeps: async (): Promise<CodexDiscoveryDeps> => {
      discoveries++
      return {
        resolve: () => (state.cli ? EXE : null), realpath: (p) => p, stat: () => STAT,
        run: async () => ({ exitCode: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', timedOut: false, truncated: false }),
        env: { SystemRoot: 'C:\\Windows' }, platform: 'win32',
        versionHome: () => ({ home: 'C:\\tmp\\v', dispose: () => {} }), now: () => 1,
      }
    },
    authPorts: {
      executablePorts: { resolve: () => EXE, realpath: (p) => p, stat: () => state.exeStat, platform: 'win32' },
      baseEnv: async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-ambient-0000000000000000' }),
      envFilePresent: (home) => state.envFile.has(home.toLowerCase()),
      run: async (cmd: CodexCommand, opts: CodexRunOptions): Promise<CodexRunResult> => {
        const r: CliRun = { args: cmd.args.join(' '), home: opts.env.CODEX_HOME ?? '', env: { ...opts.env }, opts }
        runs.push(r)
        const f = behaviour[r.args]
        const out = f ? await f(r) : { exitCode: 64 }
        return { exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, ...out }
      },
    },
  })
  const claude = createClaudePackage()
  // The launch environment is applied through the registry (the one removal
  // site, realmEnvForProvider): register this harness's packages there, as
  // boot does. Vitest isolates each test file's module registry.
  _resetProviderRegistryForTest()
  registerProviderPackage(claude)
  registerProviderPackage(codex)
  let claudeRecords = o.claude ?? []
  // What the registry asked Claude's own list to change (write-through).
  const legacyWrites: unknown[] = []
  const claudeLegacy: LegacyAccountsPort = {
    providerId: 'claude',
    read: () => claudeRecords,
    apply: (w) => { legacyWrites.push(...w) },
  }
  if (claudeRecords.length) {
    const r = await store.reconcileLegacy(claudeLegacy)
    if (!r.ok) throw new Error(`seeding Claude failed: ${r.message}`)
  }
  // Codex as the service sees it, with capabilities a test may turn off.
  let capOverride: Partial<ProviderCapabilities> = {}
  const codexView: ProviderPackage = { ...codex, get capabilities() { return { ...codex.capabilities, ...capOverride } as ProviderCapabilities } }
  const packages: ProviderPackage[] = [claude, codexView]
  // The store the service is handed: swappable, as a resources-directory change swaps it.
  let active: AccountRegistryStore | null = store
  const pref = (id: ProviderId): ProviderPreference => {
    const p = o.preference?.[id]
    if (p === undefined) return id === 'codex' ? 'on' : 'on'
    return typeof p === 'function' ? p() : p
  }
  const service = new AccountsService({
    store: () => active, leases, secrets,
    packages: () => packages,
    preference: pref,
    experimentalEnabled: () => o.experimental ?? [],
    platform: 'win32',
    randomHex: nextHex,
    reconcileLegacy: async () => { await store.reconcileLegacy(claudeLegacy) },
    ...(o.unleasedSessions ? { unleasedSessions: o.unleasedSessions } : {}),
    log: (m) => logs.push(m),
  })
  return {
    store, port, leases, secrets, service, codex, claude, folders, signedIn, runs, logs, state, legacyWrites,
    discoveries: () => discoveries,
    doc: (): ProviderRegistryDoc => store.current()!,
    setClaude: (records: LegacyAccountSnapshot[]) => { claudeRecords = records },
    useStore: (next: AccountRegistryStore | null) => { active = next },
    setCapabilities: (over: Partial<ProviderCapabilities>) => { capOverride = over },
    newStore: (p = new MemoryPort()) => { const s = new AccountRegistryStore({ fs: p, now, consumers: (id) => leases.count(id) }); s.load(); return s },
    args: () => runs.map((r) => r.args),
  }
}

export type Harness = Awaited<ReturnType<typeof harness>>

/** Begin, sign in and complete a managed Codex account; returns its id. */
export async function addCodexAccount(h: Harness, name = 'Work', method: 'browser' | 'apiKey' = 'browser', senderId = 1): Promise<string> {
  const begun = await h.service.beginSetup({ providerId: 'codex', method })
  if (!begun.ok) throw new Error(`begin: ${begun.code}`)
  let secretHandle: string | undefined
  if (method === 'apiKey') {
    const issued = h.service.issueSecretHandle({ accountId: begun.accountId }, senderId)
    if (!issued.ok) throw new Error(`issue: ${issued.code}`)
    secretHandle = issued.handle
    h.service.depositSecret(secretHandle, senderId, KEY)
  }
  const signed = await h.service.signIn({ accountId: begun.accountId, method, ...(secretHandle ? { secretHandle } : {}) }, senderId)
  if (!signed.ok) throw new Error(`sign in: ${signed.code}`)
  const done = await h.service.completeSetup({ accountId: begun.accountId, identity: { mode: 'new', friendlyName: name, colourKey: 'violet' } })
  if (!done.ok) throw new Error(`complete: ${done.code}`)
  return begun.accountId
}

/** Deterministic, canonical JSON of the Claude side of the registry. */
export function claudeSide(doc: ProviderRegistryDoc): string {
  const accounts = doc.accounts.filter((a) => a.providerId === 'claude')
  const ids = new Set(accounts.map((a) => a.identityId))
  const realms = doc.realms.filter((r) => r.providerId === 'claude')
  return JSON.stringify({
    accounts, realms,
    identities: doc.identities.filter((i) => ids.has(i.id)),
    legacyLinks: doc.legacyLinks,
    journals: doc.journals.filter((j) => j.providerId === 'claude'),
    migrations: doc.migrations.filter((m) => m.providerId === 'claude'),
  })
}
