// WP1.54 Gate 0 characterization of CURRENT Claude account/setup behaviour
// that WP1 touches and that had no behavioural test on the base (gaps C1, C5,
// C6, C7, C8 in docs/wp1/baseline-2026-09-19.md). Observable inputs, outputs,
// persisted state and child-process environment only; no private layout.
//
// The load-bearing fact for the whole work package is C1: a local Claude
// session is isolated by USERPROFILE (and HOME on Linux) pointing at the
// profile home, never by CLAUDE_CONFIG_DIR. WP1's provider-neutral launch
// handoff (WP1.38) must keep exactly this env shape for Claude. One C7
// assertion is scheduled to be inverted by WP1 (marked below): the setup PTY
// inherits the raw parent environment, which the design's allowlist rule for
// install/login processes replaces (design 12, decision D3).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { IPC } from '../../src/shared/ipc-channels'

const ROOT = path.resolve(__dirname, '..', '..')
const PROVIDER_CORE = 'src/main/providers/core/'

class FakePty {
  pid = 4242; cols = 80; rows = 24; process = 'sh'; handleFlowControl = false
  dataCb: ((d: string) => void) | null = null
  exitCb: ((e: { exitCode: number }) => void) | null = null
  onData(cb: (d: string) => void) { this.dataCb = cb; return { dispose() {} } }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; return { dispose() {} } }
  write = vi.fn(); resize = vi.fn(); kill = vi.fn(); pause() {} resume() {} clear() {}
}
const spawned: Array<{ cmd: string; args: string[]; env: Record<string, string>; pty: FakePty }> = []
const ipcHandlers = new Map<string, (...a: any[]) => any>()
const sends: Array<[string, unknown]> = []
const fakeWin = { isDestroyed: () => false, webContents: { send: (ch: string, payload?: unknown) => { sends.push([ch, payload]) } } }
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [], fromWebContents: () => fakeWin }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => ipcHandlers.set(ch, fn) },
}))
const ptySpawnFactory = () => ({
  spawn: (cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    const child = new FakePty()
    spawned.push({ cmd, args, env: opts.env, pty: child })
    return child
  },
})
vi.mock('node-pty', () => ptySpawnFactory())
vi.mock('../../src/main/usage/usage-snapshots', () => ({ loadSnapshots: () => new Map(), saveSnapshots() {} }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logVerbose: vi.fn() }))

const profiles = await import('../../src/main/account-profiles')
const { spawnPty, killPty } = await import('../../src/main/pty-manager')
const { registerProviderPackage, _resetProviderRegistryForTest } = await import('../../src/main/providers/core')
const { createClaudePackage } = await import('../../src/main/providers/claude')
const { getConfigDir } = await import('../../src/main/config-manager')
const identity = await import('../../src/main/claude-account-identity')
const consumers = await import('../../src/main/profile-consumers')
const canvasLink = await import('../../src/main/canvas/canvas-session-link')

// The fake provider's env is what pty-manager extends; mutable so a case can
// pre-seed it (PATH dedupe, inherited CCC_SESSION_WORKTREE).
let providerEnv: Record<string, string> = {}
const fakeClaude = {
  id: 'claude', displayName: 'Claude', resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: 'fake-shell', args: [], env: { ...providerEnv } }),
  detectUiRunning: () => false, ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
  getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
} as never
const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never

let sandbox = ''
let primaryId = ''
let workId = ''
const sids: string[] = []
// A MANAGED spawn -- one that resolves a profile -- is DEFERRED once behind the
// project-settings gate (src/main/managed-launch-diagnostics.ts) and re-enters
// `spawnPty` asynchronously with the verdict, so the PTY does not exist when
// this returns. An UNMANAGED spawn (shell-only with no profile) is still
// synchronous. Awaiting the PTY covers both, bounded so a genuinely absent
// spawn fails the assertion rather than hanging the suite.
const launch = async (sid: string, opts: Record<string, unknown>) => {
  sids.push(sid)
  const before = spawned.length
  spawnPty(win, sid, { cwd: sandbox, ...opts } as never)
  const deadline = Date.now() + 4000
  while (spawned.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  return spawned[spawned.length - 1]
}
const lastEnv = () => spawned[spawned.length - 1].env

// ---------------------------------------------------------------------------
// C1: local Claude spawn -> profile resolution -> child env. Real pty-manager
// and real account-profiles against a sandbox; node-pty and Electron mocked.
// ---------------------------------------------------------------------------
describe('C1: local Claude spawn resolves a profile and isolates it through USERPROFILE/HOME', () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-wp1-c1-'))
    profiles._setRootsForTest({ resourcesDir: sandbox, sharedRoot: path.join(sandbox, 'global', '.claude') })
    fs.mkdirSync(path.join(sandbox, 'global', '.claude'), { recursive: true })
    const p1 = profiles.createProfile('Primary')
    profiles.upsertProfile({ ...p1, accountEmail: 'primary@example.test' })
    profiles.setPrimaryProfile(p1.id)
    primaryId = p1.id
    const p2 = profiles.createProfile('Work')
    profiles.upsertProfile({ ...p2, accountEmail: 'work@example.test', active: true })
    workId = p2.id
    providerEnv = { PATH: '/usr/bin', FROM_PROVIDER: '1', CCC_SESSION_WORKTREE: 'inherited-from-parent' }
    // WP1 slice 2: the launch path now takes the ambient-strip list and the
    // host control from the REGISTERED PACKAGE, so a bare session provider is
    // no longer enough to drive a spawn. Register the REAL Claude package with
    // only its spawn surface faked -- swapping the whole package for a stub
    // would make these cases characterize a stub's policy rather than the
    // shipped one, which is the opposite of what a characterization test is
    // for.
    _resetProviderRegistryForTest()
    registerProviderPackage({ ...createClaudePackage(), session: fakeClaude })
    identity._resetClaudeAccounts()
    consumers._resetProfileConsumersForTest()
    canvasLink._resetCanvasSessionLinkForTest()
    spawned.length = 0
  })
  afterEach(() => {
    for (const sid of sids.splice(0)) { try { killPty(sid) } catch { /* gone */ } }
    for (const s of spawned) s.pty.exitCb?.({ exitCode: 0 })
    identity._resetClaudeAccounts()
    consumers._resetProfileConsumersForTest()
    profiles._setRootsForTest(null)
    fs.rmSync(sandbox, { recursive: true, force: true })
  })

  it('a requested valid profile becomes the child USERPROFILE; CLAUDE_CONFIG_DIR is never set; git/npm stay on the real home', async () => {
    await launch('wp1-c1-requested', { shellOnly: false, profileId: workId })
    const env = lastEnv()
    expect(env.USERPROFILE).toBe(profiles.getProfileConfigDir(workId))
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.FROM_PROVIDER).toBe('1') // the provider env is extended, not replaced
    expect(env.CCC_CONFIG_DIR).toBe(getConfigDir())
    expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(os.homedir(), '.gitconfig'))
    expect(env.npm_config_userconfig).toBe(path.join(os.homedir(), '.npmrc'))
    if (process.platform === 'linux') expect(env.HOME).toBe(profiles.getProfileConfigDir(workId))
    else expect(env.HOME).toBeUndefined()
  })

  it('an invalid or escaping requested id falls back to the primary profile instead of failing the spawn', async () => {
    await launch('wp1-c1-invalid', { shellOnly: false, profileId: '../escape' })
    expect(lastEnv().USERPROFILE).toBe(profiles.getProfileConfigDir(primaryId))
    await launch('wp1-c1-missing', { shellOnly: false, profileId: 'profile-does-not-exist' })
    expect(lastEnv().USERPROFILE).toBe(profiles.getProfileConfigDir(primaryId))
  })

  it('an interactive session with no requested profile never runs on the bare global home (clobber-proofing)', async () => {
    await launch('wp1-c1-default', { shellOnly: false })
    expect(lastEnv().USERPROFILE).toBe(profiles.getProfileConfigDir(primaryId))
  })

  it('a shell-only session with no requested profile keeps the provider env untouched (bare global home)', async () => {
    await launch('wp1-c1-shell', { shellOnly: true })
    const env = lastEnv()
    expect(env.USERPROFILE).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.npm_config_userconfig).toBeUndefined()
  })

  it('an inherited CCC_SESSION_WORKTREE is deleted for a session that does not designate its own worktree (ADR-016)', async () => {
    await launch('wp1-c1-wt-shell', { shellOnly: true })
    expect(lastEnv().CCC_SESSION_WORKTREE).toBeUndefined()
    await launch('wp1-c1-wt-interactive', { shellOnly: false, profileId: workId }) // sandbox cwd is not a git checkout
    expect(lastEnv().CCC_SESSION_WORKTREE).toBeUndefined()
  })

  it('the redirected profile .local/bin is appended to PATH exactly once (case-insensitive) and the real entry stays first', async () => {
    await launch('wp1-c1-path', { shellOnly: false, profileId: workId })
    const localBin = path.join(profiles.getProfileConfigDir(workId), '.local', 'bin')
    const parts = lastEnv().PATH.split(path.delimiter)
    expect(parts[0]).toBe('/usr/bin')
    expect(parts.filter((p) => p.toLowerCase() === localBin.toLowerCase())).toHaveLength(1)
    // Already present in a different case: not appended again.
    providerEnv = { ...providerEnv, PATH: `/usr/bin${path.delimiter}${localBin.toUpperCase()}` }
    await launch('wp1-c1-path-dedupe', { shellOnly: false, profileId: workId })
    const parts2 = lastEnv().PATH.split(path.delimiter)
    expect(parts2.filter((p) => p.toLowerCase() === localBin.toLowerCase())).toHaveLength(1)
    expect(parts2).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// C8: colourKey is never written by main; chip colour is derived from email.
// ---------------------------------------------------------------------------
describe('C8: AccountProfile.colourKey is never written by the main process on the base', () => {
  it('createProfile + upsert round trips leave colourKey undefined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-wp1-c8-'))
    profiles._setRootsForTest({ resourcesDir: dir, sharedRoot: path.join(dir, 'global', '.claude') })
    try {
      const p = profiles.createProfile('Colour')
      profiles.upsertProfile({ ...p, accountEmail: 'c@example.test' })
      const stored = profiles.listProfiles().find((x) => x.id === p.id)!
      expect(stored.colourKey).toBeUndefined()
      expect(Object.keys(stored)).not.toContain('colourKey')
    } finally {
      profiles._setRootsForTest(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  // WP2 CHANGE (scheduled, like C7's inversion): the account registry's write-
  // through now sets colourKey on a profile that has NO email -- only after an
  // explicit colour edit, since such a profile has no email-keyed override to
  // carry it (src/main/providers/claude/legacy-store.ts, tests/wp1/claude-
  // legacy-store.test.ts). That module is the one sanctioned writer. The
  // pattern is POSIX ERE ([[:space:]], not \s): macOS git's regex has no \s,
  // so the earlier `colourKey\s*:` matched nothing there and passed vacuously.
  it('no main-process source writes colourKey on a profile record, except the WP2 write-through for email-less profiles', () => {
    const grep = (re: string) => {
      try {
        return execFileSync('git', ['-C', ROOT, 'grep', '-n', '-E', re, '--', 'src/main', 'src/shared/account-types.ts'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      } catch (e: any) { if (e.status !== 1) throw e; return [] }
    }
    // Every write form: an object-literal key, quoted or not (`{ colourKey: `,
    // `, 'colourKey': `), a shorthand/spread key (`{ ...p, colourKey }`), an
    // assignment incl. compound ones (`.colourKey =`, `??=`, `||=`), a
    // bracket write (`['colourKey'] =`), and Object.assign/defineProperty/
    // Reflect.set naming the field.
    const Q = "[\"'`]"
    const literal = grep(`(^|[{,[])[[:space:]]*${Q}?colourKey${Q}?[[:space:]]*\\]?[[:space:]]*:`)
    const other = [
      ...grep('[{,][[:space:]]*colourKey[[:space:]]*[,}]'),
      ...grep('\\.[[:space:]]*colourKey[[:space:]]*(/\\*.*\\*/[[:space:]]*)?([?|&]{2})?=([^=]|$)'),
      ...grep(`\\[[[:space:]]*${Q}colourKey${Q}[[:space:]]*\\][[:space:]]*([?|&]{2})?=([^=]|$)`),
      ...grep('(assign|defineProperty|Reflect\\.set)[^;]*colourKey'),
    ]
    const at = (l: string) => l.slice(0, l.indexOf(':', l.indexOf(':') + 1) + 1) // "path:line:"
    const pathOf = (l: string) => l.slice(0, l.indexOf(':'))
    // The one sanctioned write, pinned by its exact text, not by its file.
    const SANCTIONED = 'if (p.colourKey !== w.value) { p.colourKey = w.value as IdentityColorKey; changed = true }'
    const sanctioned = other.filter((l) => pathOf(l) === 'src/main/providers/claude/legacy-store.ts' && l.slice(at(l).length).trim() === SANCTIONED)
    // Both pattern families can see a hit on this platform (verify the verifier).
    expect(sanctioned, 'the assignment pattern did not find the sanctioned write -- is it matching on this platform?').toHaveLength(1)
    expect(literal.some((l) => pathOf(l) === 'src/main/claude-account-identity.ts'), 'the object-literal pattern found nothing -- is it matching on this platform?').toBe(true)
    // The type declaration and the identity push payloads (email-derived
    // colour, never a profile write) are exempt from the OBJECT-LITERAL
    // family only, by file path; an assignment there still counts.
    const literalExempt = new Set(['src/shared/account-types.ts', 'src/main/claude-account-identity.ts', 'src/main/account-color.ts'])
    // WP2: provider core works on registry identities (ConductorIdentity),
    // never on a profile record, and the Accounts IPC schema only validates
    // a requested colour. Both are exempt from the OBJECT-LITERAL family only
    // (an assignment there still counts), and the exemption is sound only
    // because core cannot reach the profile store at all: the next test pins
    // core's imports to core, shared and Node built-ins.
    const literalExemptDir = (p: string) => p.startsWith(PROVIDER_CORE) || p === 'src/main/ipc/provider-accounts-handlers.ts'
    const writes = [...new Set([...literal.filter((l) => !literalExempt.has(pathOf(l)) && !literalExemptDir(pathOf(l))), ...other.filter((l) => !sanctioned.includes(l))])]
    expect(writes, writes.join('\n')).toEqual([])
  })

  it('provider core cannot reach the profile store: it imports only core, shared and Node built-ins (what makes its C8 exemption sound)', () => {
    const dir = path.join(ROOT, PROVIDER_CORE)
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(3)
    const bad: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const m of text.matchAll(/(?:^|\n)\s*(import|export)\b([^'"]*?)\bfrom\s+['"]([^'"]+)['"]/g)) {
        const spec = m[3]
        const typeOnly = /^\s*type\b/.test(m[2])
        const ok = spec.startsWith('./') || spec.startsWith('../../../shared/') || spec.startsWith('node:') || (typeOnly && spec === '../types')
        if (!ok) bad.push(`${f}: ${spec}`)
      }
      for (const m of text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g)) bad.push(`${f}: dynamic ${m[1]}`)
    }
    expect(bad).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C6: onboarding settle stamps.
// ---------------------------------------------------------------------------
describe('C6: settleOnboardingFinish / settleWhatsNewOnly stamped shapes', () => {
  const updates: Array<Record<string, unknown>> = []
  const ghUpdates: Array<Record<string, unknown>> = []
  const state = { seen: 0, ghRejects: false }
  beforeEach(() => { updates.length = 0; ghUpdates.length = 0; state.seen = 0; state.ghRejects = false })
  it('full finish stamps every step, the onboarding version, the app version and the training version; what\'s-new-only never touches completedSteps', async () => {
    vi.doMock('../../src/renderer/stores/appMetaStore', () => ({ useAppMetaStore: { getState: () => ({ update: (u: Record<string, unknown>) => updates.push(u) }) } }))
    vi.doMock('../../src/renderer/stores/githubStore', () => ({ useGitHubStore: { getState: () => ({ updateConfig: async (u: Record<string, unknown>) => { ghUpdates.push(u); if (state.ghRejects) throw new Error('gh config unavailable') } }) } }))
    vi.doMock('../../src/renderer/onboarding/whats-new-gate', () => ({ markWhatsNewSeen: () => { state.seen++ } }))
    vi.doMock('../../src/renderer/training-steps', () => ({ currentTrainingVersion: () => 'T-test' }))
    ;(globalThis as any).__APP_VERSION__ = '9.9.9-wp1'
    const { settleOnboardingFinish, settleWhatsNewOnly } = await import('../../src/renderer/onboarding/settle')
    const { STEPS, ONBOARDING_VERSION } = await import('../../src/renderer/onboarding/steps')
    settleOnboardingFinish()
    expect(updates).toHaveLength(1)
    const full = updates[0]
    expect(Object.keys(full.completedSteps as object).sort()).toEqual(STEPS.map((s) => s.id).sort())
    expect(Object.values(full.completedSteps as object).every((v) => v === '9.9.9-wp1')).toBe(true)
    expect(full.onboardingCompletedVersion).toBe(ONBOARDING_VERSION)
    expect(full.onboardingAppVersion).toBe('9.9.9-wp1')
    expect(full.lastTrainingVersion).toBe('T-test')
    expect(state.seen).toBe(1)
    expect(ghUpdates).toEqual([{ seenOnboardingVersion: '9.9.9-wp1' }])
    settleWhatsNewOnly()
    expect(updates).toHaveLength(2)
    expect(updates[1]).toEqual({ onboardingAppVersion: '9.9.9-wp1', lastTrainingVersion: 'T-test' })
    expect(state.seen).toBe(2)
    // A failing GitHub-config write is swallowed: the finish still completes.
    state.ghRejects = true
    expect(() => settleOnboardingFinish()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(updates).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// C5: ACCOUNT_PROFILES_* handler sequencing (the handler, not its parts).
// ---------------------------------------------------------------------------
describe('C5: accountProfiles handlers sequencing on the base', () => {
  const order: string[] = []
  const state = { inUse: [] as boolean[], clearThrows: false, teardownThrows: false }
  let store: Array<Record<string, unknown>> = []
  const invoke = (ch: string, ...args: any[]) => ipcHandlers.get(ch)!({} as any, ...args)

  beforeEach(async () => {
    order.length = 0; state.inUse = []; state.clearThrows = false; state.teardownThrows = false
    store = [{ id: 'primary', name: '', createdAt: 0, isPrimary: true }, { id: 'work', name: 'Work', createdAt: 0 }]
    vi.doMock('../../src/main/account-profiles', () => ({
      listProfiles: () => store.map((p) => ({ ...p })),
      upsertProfile: (p: Record<string, unknown>) => { const i = store.findIndex((x) => x.id === p.id); if (i >= 0) store[i] = p; else store.push(p) },
      isValidProfileId: (id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id),
      safeTeardownProfile: (id: string) => { order.push(`teardown:${id}`); if (state.teardownThrows) throw new Error('file locked') },
      readProfileAccountEmail: vi.fn(), getProfileConfigDir: vi.fn(), createProfile: vi.fn(), captureDetectedAccount: vi.fn(),
      backupProfileHomeToCanonical: vi.fn(), restoreProfileIdentityFromCanonical: vi.fn(), readProfileCredentialStamp: vi.fn(),
    }))
    vi.doMock('../../src/main/claude-account-identity', () => ({
      getAccountIdentity: vi.fn(), getDefaultAccountEmail: vi.fn(), getWatchedProfileId: vi.fn(), detectedNewAccountEmail: vi.fn(),
      isProfileInUseByLiveSession: () => { const v = state.inUse.shift() ?? false; order.push(`inUse:${v}`); return v },
    }))
    vi.doMock('../../src/main/usage/account-usage', () => ({ fetchAllAccountsUsage: vi.fn(), fetchAllAccountsUsageStreaming: vi.fn(), fetchAccountUsage: vi.fn() }))
    vi.doMock('../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: () => [] }))
    vi.doMock('../../src/main/account-web/sign-in', () => ({ clearWebSession: async (id: string) => { order.push(`clear:${id}`); if (state.clearThrows) throw new Error('partition busy') } }))
    vi.doMock('../../src/main/account-web/session-store', () => ({ removeWebSession: (id: string) => { order.push(`removeWeb:${id}`) } }))
    vi.doMock('../../src/main/account-web/artifacts', () => ({ closeArtifacts: (id: string) => { order.push(`closeArtifacts:${id}`) } }))
    vi.doMock('../../src/main/account-web/account-pane', () => ({ closeAccountPanesForProfile: (id: string) => { order.push(`closePanes:${id}`) } }))
    const { registerAccountProfilesHandlers } = await import('../../src/main/ipc/account-profiles-handlers')
    ipcHandlers.clear()
    registerAccountProfilesHandlers()
  })

  it('rename trims and caps the name at 120 characters and refuses an invalid id', () => {
    expect(invoke(IPC.ACCOUNT_PROFILES_RENAME, { id: '../x', name: 'n' })).toEqual({ ok: false })
    expect(invoke(IPC.ACCOUNT_PROFILES_RENAME, { id: 'work', name: '  ' + 'a'.repeat(200) + '  ' })).toEqual({ ok: true })
    expect((store.find((p) => p.id === 'work')!.name as string)).toBe('a'.repeat(120))
  })

  it('delete refuses an invalid or escaping id before touching anything', async () => {
    for (const bad of ['../escape', 'Work', '', undefined]) {
      const r = await invoke(IPC.ACCOUNT_PROFILES_DELETE, bad === undefined ? undefined : { id: bad })
      expect(r).toEqual({ ok: false, error: 'invalid profile id' })
    }
    expect(order).toEqual([])
  })

  it('delete refuses an in-use profile before touching anything', async () => {
    state.inUse = [true]
    const r = await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })
    expect(r.ok).toBe(false)
    expect(order).toEqual(['inUse:true'])
  })

  it('delete clears web state first, re-checks in-use after the await, and only then tears down', async () => {
    state.inUse = [false, false]
    const r = await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })
    expect(r).toEqual({ ok: true })
    expect(order).toEqual(['inUse:false', 'closeArtifacts:work', 'closePanes:work', 'clear:work', 'inUse:false', 'removeWeb:work', 'teardown:work'])
  })

  it('a session that started during the clear stops the delete: web record dropped, no teardown', async () => {
    state.inUse = [false, true]
    const r = await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })
    expect(r.ok).toBe(false)
    expect(order).toEqual(['inUse:false', 'closeArtifacts:work', 'closePanes:work', 'clear:work', 'inUse:true', 'removeWeb:work'])
  })

  it('a failed web-session clear fails closed: the account survives untouched', async () => {
    state.inUse = [false]; state.clearThrows = true
    const r = await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/could not be cleared/)
    expect(order).toEqual(['inUse:false', 'closeArtifacts:work', 'closePanes:work', 'clear:work'])
  })

  it('a teardown that throws (e.g. a Windows file lock) becomes a structured failure, never a rejected invoke', async () => {
    state.inUse = [false, false]; state.teardownThrows = true
    const r = await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })
    expect(r).toEqual({ ok: false, error: 'file locked' })
    expect(order[order.length - 1]).toBe('teardown:work')
  })
})

// ---------------------------------------------------------------------------
// C7: setup handlers: isCliReady folder matching and the CLI-setup PTY shape.
// ---------------------------------------------------------------------------
describe('C7: setup:isCliReady and setup:spawnCliSetup on the base', () => {
  let home = ''
  let installPath = ''
  const ptyCalls: Array<{ cmd: string; args: string[]; opts: any; pty: FakePty }> = []
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-wp1-c7-'))
    installPath = path.join(home, 'proj')
    fs.mkdirSync(installPath)
    ptyCalls.length = 0
    sends.length = 0
    vi.doMock('os', async (importOriginal) => { const a = await importOriginal<typeof import('os')>(); return { ...a, homedir: () => home } })
    vi.doMock('node-pty', () => ({ spawn: (cmd: string, args: string[], opts: any) => { const p = new FakePty(); ptyCalls.push({ cmd, args, opts, pty: p }); return p } }))
    vi.doMock('../../src/main/update-watcher', () => ({ getInstallPath: () => installPath }))
    vi.doMock('../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude-resolved', args: [] }) }))
    vi.doMock('../../src/main/claude-cli-probe', () => ({ probeClaudeCli: async () => ({ installed: true, probe: 'x' }) }))
    vi.doMock('../../src/main/data-paths', () => ({ getDataDirectory: () => home, getResourcesDirectory: () => home, setDataDirectory() {}, setResourcesDirectory() {}, isDataDirFromRegistry: () => true }))
    vi.resetModules()
  })
  afterEach(() => {
    // Restore the file-level factories rather than unmocking (a later describe
    // must never see the real os/node-pty).
    vi.doMock('node-pty', () => ptySpawnFactory())
    vi.doUnmock('os')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('isCliReady is true only when ~/.claude/projects holds the mangled install folder', async () => {
    const { isCliReady } = await vi.importActual<typeof import('../../src/main/ipc/setup-handlers')>('../../src/main/ipc/setup-handlers')
    const { pathToClaudeProjectFolder } = await import('../../src/main/utils/claude-project-path')
    expect(isCliReady()).toBe(false)
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'some-other-folder'), { recursive: true })
    expect(isCliReady()).toBe(false)
    fs.mkdirSync(path.join(home, '.claude', 'projects', pathToClaudeProjectFolder(installPath)), { recursive: true })
    expect(isCliReady()).toBe(true)
  })

  it('spawnCliSetup runs claude directly on win32 and a login shell + typed command elsewhere; data/exit are relayed on the __cli_setup__ channels; kill only while live', async () => {
    vi.useFakeTimers()
    const saved = Object.getOwnPropertyDescriptor(process, 'platform')!
    const savedShell = process.env.SHELL
    try {
      const { registerSetupHandlers } = await vi.importActual<typeof import('../../src/main/ipc/setup-handlers')>('../../src/main/ipc/setup-handlers')
      ipcHandlers.clear()
      registerSetupHandlers()
      const invoke = (ch: string, ...args: any[]) => ipcHandlers.get(ch)!({ sender: {} } as any, ...args)

      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(await invoke('setup:spawnCliSetup', 100, 20)).toBe('__cli_setup__')
      const w = ptyCalls[0]
      expect(w.cmd).toBe('claude-resolved')
      expect(w.args).toEqual([])
      expect(w.opts.cwd).toBe(installPath)
      // [to be inverted by decision D3 / design 12] the setup PTY inherits the raw parent environment
      expect(w.opts.env.PATH ?? w.opts.env.Path).toBe(process.env.PATH ?? process.env.Path)
      w.pty.dataCb?.('hello from claude')
      w.pty.exitCb?.({ exitCode: 3 })
      expect(sends).toEqual([['pty:data:__cli_setup__', 'hello from claude'], ['pty:exit:__cli_setup__', 3]])
      await invoke('setup:killCliSetup')
      expect(w.pty.kill).not.toHaveBeenCalled() // already exited: nothing to kill

      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.SHELL = '/bin/wp1sh'
      await invoke('setup:spawnCliSetup', 0, 0)
      const call = ptyCalls[1]
      expect(call.cmd).toBe('/bin/wp1sh')
      expect(call.args).toEqual(['-l'])
      expect(call.opts.cols).toBe(100)
      expect(call.opts.rows).toBe(20)
      expect(call.opts.cwd).toBe(installPath)
      // The resolved claude command is typed into the login shell after 500 ms.
      vi.advanceTimersByTime(499)
      expect(call.pty.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(call.pty.write).toHaveBeenCalledWith('claude-resolved\r')
      await invoke('setup:killCliSetup')
      expect(call.pty.kill).toHaveBeenCalledTimes(1) // live: killed
    } finally {
      if (savedShell === undefined) delete process.env.SHELL; else process.env.SHELL = savedShell
      Object.defineProperty(process, 'platform', saved)
      vi.useRealTimers()
    }
  })
})
