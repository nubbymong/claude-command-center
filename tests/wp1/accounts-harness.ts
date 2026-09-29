// WP1.16 / WP1.46 / WP1.47 / WP1.51 / WP1.59 -- shared harness for the
// accounts-service suites (WP2 commit 3). PURE: the real Codex package runs
// against a fake CLI, an in-memory folder tree and an in-memory registry; the
// real Claude package supplies Claude's declarations and its accounts arrive
// through the legacy reconcile, exactly as at start. No file is written and
// no process is started.
import { createCodexPackage } from '../../src/main/providers/codex'
import type { CodexRealmFsPort, CodexCommand, CodexRunOptions, CodexRunResult, CodexDiscoveryDeps, CodexFsEntry, CodexUsageFsPort, CodexLiveUsage, CodexRealmFolderLimits, CodexConversationCarry, CodexCatalogueDeps } from '../../src/main/providers/codex'
import { createClaudePackage } from '../../src/main/providers/claude'
import type { ClaudeReviewPorts } from '../../src/main/providers/claude'
import { AccountRegistryStore, AccountsService, ConsumerLeaseRegistry, SecretHandleStore, registerProviderPackage, _resetProviderRegistryForTest } from '../../src/main/providers/core'
import type { RegistryFsPort, ProviderPackage, LegacyAccountsPort, AccountsServiceDeps } from '../../src/main/providers/core'
import { findRealm, realmOperable } from '../../src/shared/providers'
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
 *  walks, creates and removes. Every call is logged. A file given a second
 *  name (`link`) shares its file id, and each name reports how many it has.
 *  The asynchronous twin (`promises`) calls the synchronous one AT CALL TIME,
 *  so a test that replaces `fs.lstat` changes both. */
export function memoryFs() {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const dirs = new Set<string>(['c:', 'c:\\res', 'c:\\users', 'c:\\users\\u', 'c:\\users\\u\\.codex', 'c:\\tools'])
  const files = new Set<string>()
  const log: string[] = []
  const err = (code: string) => Object.assign(new Error(code), { code })
  const ino = (p: string) => String([...norm(p)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7))
  const parent = (p: string) => norm(p).split('\\').slice(0, -1).join('\\')
  /** A name a link made -> the file id it shares. */
  const sharedId = new Map<string, string>()
  /** A file id with more than one name -> how many it has. */
  const names = new Map<string, number>()
  const idOf = (p: string) => sharedId.get(norm(p)) ?? ino(p)
  const link = (src: string, dest: string) => {
    log.push(`link ${src} -> ${dest}`)
    if (!files.has(norm(src))) throw err('ENOENT')
    if (dirs.has(norm(dest)) || files.has(norm(dest))) throw err('EEXIST')
    if (!dirs.has(parent(dest))) throw err('ENOENT')
    const id = idOf(src)
    sharedId.set(norm(dest), id)
    names.set(id, (names.get(id) ?? 1) + 1)
    files.add(norm(dest))
  }
  const copyFile = (src: string, dest: string) => {
    log.push(`copyFile ${src} -> ${dest}`)
    if (!files.has(norm(src))) throw err('ENOENT')
    if (dirs.has(norm(dest)) || files.has(norm(dest))) throw err('EEXIST')
    if (!dirs.has(parent(dest))) throw err('ENOENT')
    files.add(norm(dest))
  }
  const fs: CodexRealmFsPort = {
    platform: 'win32',
    realpath: (p) => { if (!dirs.has(norm(p)) && !files.has(norm(p))) throw err('ENOENT'); return p.replace(/[\\/]+$/, '') || p },
    lstat: (p): CodexFsEntry => {
      const n = norm(p)
      if (dirs.has(n)) return { kind: 'dir', dev: '9', ino: ino(p), mode: 0o700 }
      if (files.has(n)) return { kind: 'file', dev: '9', ino: idOf(p), mode: 0o600, nlink: names.get(idOf(p)) ?? 1 }
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
    unlink: (p) => {
      log.push(`unlink ${p}`)
      const id = idOf(p)
      if (!files.delete(norm(p))) throw err('ENOENT')
      sharedId.delete(norm(p))
      const left = (names.get(id) ?? 1) - 1
      if (left > 1) names.set(id, left)
      else names.delete(id)
    },
    rmdir: (p) => {
      log.push(`rmdir ${p}`)
      const n = norm(p)
      if ([...dirs, ...files].some((x) => parent(x) === n)) throw err('ENOTEMPTY')
      if (!dirs.delete(n)) throw err('ENOENT')
    },
  }
  const ops = { link, copyFile }
  fs.promises = {
    realpath: async (p) => fs.realpath(p),
    lstat: async (p) => fs.lstat(p),
    readdir: async (dir) => fs.readdir(dir),
    mkdir: async (dir, mode) => fs.mkdir(dir, mode),
    chmod: async (p, mode) => fs.chmod(p, mode),
    unlink: async (p) => fs.unlink(p),
    rmdir: async (p) => fs.rmdir(p),
    link: async (src, dest) => ops.link(src, dest),
    copyFile: async (src, dest) => ops.copyFile(src, dest),
  }
  /** `ops`: replace `link` or `copyFile` to make them refuse or watch them. */
  return { fs, dirs, files, log, ops, exists: (p: string) => dirs.has(norm(p)) }
}

export type Via = 'chatgpt' | 'api-key'
export interface CliRun { args: string; home: string; env: Record<string, string>; opts: CodexRunOptions }
export type CliScript = Partial<Record<string, (r: CliRun) => Partial<CodexRunResult> | Promise<Partial<CodexRunResult>>>>

export interface HarnessOpts {
  /** The composition root's check that a session holds a mirrored record (Claude profile). */
  legacyRecordInUse?: (providerId: ProviderId, legacyId: string) => boolean
  preference?: Partial<Record<ProviderId, ProviderPreference | (() => ProviderPreference)>>
  experimental?: ScopedCapabilityKey[]
  script?: CliScript
  /** Claude accounts as its own profiles list would show them. */
  claude?: LegacyAccountSnapshot[]
  port?: MemoryPort
  cli?: boolean
  /** The folder tree of an earlier start (a restart keeps the disk). */
  folders?: ReturnType<typeof memoryFs>
  /** Smaller bounds on the Codex folder walks. Absent: the shipped ones. */
  realmLimits?: Partial<CodexRealmFolderLimits>
  /** Running sessions that hold no account lease, per provider (Claude's). */
  unleasedSessions?: (providerId: ProviderId) => number
  /** The Claude reviewer's ports (WP2 5b): absent, Claude has no launch. */
  claudeReview?: ClaudeReviewPorts
  /** Awaited at the start of every Codex CLI discovery (WP2 6g): a test
   *  holds a discovery in flight with it. */
  beforeDiscovery?: () => Promise<void> | void
  /** The environment the app inherited, as the Codex package reads it
   *  (CODEX_HOME). Absent: none set. */
  hostEnv?: Record<string, string>
  /** The usage track's filesystem (MP3). Absent: an empty one, so no test
   *  reads the host's disk for a realm's session history. */
  usageFs?: CodexUsageFsPort
  /** The live usage figures, shared with the test (MP3). */
  liveUsage?: CodexLiveUsage
  /** The fresh usage reads' clock and pacing (MP8). Absent: the shipped values. */
  usageReads?: AccountsServiceDeps['usageReads']
  /** Whether the registry's load has run (MP9). Absent: never settled. */
  registrySettled?: () => boolean
  /** Wraps the Codex package's sign-in operations as the service sees them
   *  (P3.3: a provider that reports a subject). Absent: Codex's own. */
  authWrap?: (auth: NonNullable<ProviderPackage['auth']>) => NonNullable<ProviderPackage['auth']>
  /** The file work of a conversation copy (P3.6). Absent: a stub that
   *  refuses, so no test touches a real disk through it. */
  conversationCarry?: CodexConversationCarry
  /** The model catalogue read's ports (P3.9). Absent: a stub whose run
   *  fails, so no test starts a process or makes a folder through it. */
  catalogueDeps?: () => Omit<CodexCatalogueDeps, 'proven'>
}

/** A usage filesystem with nothing in it. */
export const EMPTY_USAGE_FS: CodexUsageFsPort = {
  platform: 'win32',
  lstat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  readdir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  readTail: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
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
  // prepare()'s base environment: in the shipped wiring, the login shell's
  // PATH on macOS and Linux (a process started for the operation).
  let baseEnvReads = 0
  // `envFile`: homes holding a `.env`; `exeStat`: the executable as re-read
  // now (a different one = replaced after setup proved it); `cliVersion`:
  // what the next discovery's version check reports (MP8).
  const state = { cli: o.cli !== false, envFile: new Set<string>(), exeStat: STAT, cliVersion: 'codex-cli 0.155.1' }
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
      lookup: async (ref, use) => {
        const doc = active?.current()
        const realm = doc ? findRealm(doc, ref.authRealmId) : undefined
        // The composition root's rule (compose.ts): never a retired realm.
        return realm && realmOperable(realm, use) ? { ok: true, realm, resourcesDir: RES } : { ok: false }
      },
      mkdirSecure: (dir) => folders.fs.mkdirSecure(dir),
    },
    auth: { takeSecret: (h) => secrets.take(h) },
    realmFs: folders.fs,
    ...(o.realmLimits ? { realmLimits: o.realmLimits } : {}),
    usageFs: o.usageFs ?? EMPTY_USAGE_FS,
    ...(o.liveUsage ? { liveUsage: o.liveUsage } : {}),
    conversationCarry: o.conversationCarry ?? (async () => ({ ok: false, code: 'io-failed' })),
    catalogueDeps: o.catalogueDeps ?? (() => ({
      executablePorts: { resolve: () => EXE, realpath: (p) => p, stat: () => state.exeStat, platform: 'win32' },
      baseEnv: async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows' }),
      run: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, spawnError: 'no process in this harness' }),
      scratchHome: () => ({ home: 'C:\\tmp\\models', dispose: () => {} }),
    })),
    hostHome: { env: o.hostEnv ?? {}, homeDir: USER },
    discoveryDeps: async (): Promise<CodexDiscoveryDeps> => {
      discoveries++
      await o.beforeDiscovery?.()
      return {
        resolve: () => (state.cli ? EXE : null), realpath: (p) => p, stat: () => STAT,
        run: async () => ({ exitCode: 0, stdout: `${state.cliVersion}\n`, stderr: '', timedOut: false, truncated: false }),
        env: { SystemRoot: 'C:\\Windows' }, platform: 'win32',
        versionHome: () => ({ home: 'C:\\tmp\\v', dispose: () => {} }), now: () => 1,
      }
    },
    authPorts: {
      executablePorts: { resolve: () => EXE, realpath: (p) => p, stat: () => state.exeStat, platform: 'win32' },
      baseEnv: async () => { baseEnvReads++; return { PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-ambient-0000000000000000' } },
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
  const claude = createClaudePackage(o.claudeReview ? { review: o.claudeReview } : {})
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
  const codexView: ProviderPackage = {
    ...codex,
    ...(o.authWrap && codex.auth ? { auth: o.authWrap(codex.auth) } : {}),
    get capabilities() { return { ...codex.capabilities, ...capOverride } as ProviderCapabilities },
  }
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
    ...(o.legacyRecordInUse ? { legacyRecordInUse: o.legacyRecordInUse } : {}),
    ...(o.unleasedSessions ? { unleasedSessions: o.unleasedSessions } : {}),
    ...(o.usageReads ? { usageReads: o.usageReads } : {}),
    ...(o.registrySettled ? { registrySettled: o.registrySettled } : {}),
    log: (m) => logs.push(m),
  })
  return {
    store, port, leases, secrets, service, codex, claude, folders, signedIn, runs, logs, state, legacyWrites,
    discoveries: () => discoveries,
    baseEnvReads: () => baseEnvReads,
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
