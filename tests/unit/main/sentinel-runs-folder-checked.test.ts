// [host] Sentinel's runs folder is checked again before anything in it is
// removed: the stale sweep asks before its listing and before each folder it
// removes, and an analysis's own folder is removed only while the runs folder
// is still the one checked. Links are MODELLED, never planted: `h.links` maps
// a path to a target folder, and the fs wrapper below does with it what the
// OS does with a link (lstat says "link"; every other call follows it). Every
// real file is under this suite's own temp folder. The REAL Sentinel service
// and sweep; the CLIs, the accounts service and the notes are fakes, so no
// process starts and no request leaves.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** path -> the folder a modelled link there points at */
  links: new Map<string, string>(),
  onReaddir: null as null | ((p: string) => void),
  /** POSIX as a test sees it: the owner and mode an lstat reports, by path. */
  uidFor: null as null | ((p: string) => number | undefined),
  modeFor: null as null | ((p: string) => number | undefined),
  /** Told of each lstat, after it answers, with the path it names. */
  onLstat: null as null | ((p: string) => void),
  /** Told of each fchmodSync: the path its descriptor was opened by, and the mode. */
  onChmod: null as null | ((p: string, mode: number) => void),
  /** Open descriptors and the path each was opened by. */
  fdPaths: new Map<number, string>(),
  /** Where each folder mkdtempSync made landed once links were followed. */
  made: [] as string[],
  /** Told of each mkdirSync before it runs, with the path it names. */
  beforeMkdir: null as null | ((p: string) => void),
  /** An lstat of a path this answers true for finds nothing there (ENOENT). */
  goneAtLstat: null as null | ((p: string) => boolean),
  /** Where each folder mkdirSync made landed once links were followed. */
  mkdirs: [] as string[],
  real: null as any,
}))

async function wrapFs(real: any): Promise<any> {
  const path = await import('node:path')
  h.real = h.real ?? real
  const win = process.platform === 'win32'
  const key = (p: string) => { const r = path.resolve(p); return win ? r.toLowerCase() : r }
  const isStr = (p: unknown): p is string => typeof p === 'string'
  /** Where `p` lands once the modelled links are followed (`final`: the last part too). */
  const follow = (p: string, final: boolean): string => {
    let r = path.resolve(p)
    for (let i = 0; i < 16; i++) {
      let hit = false
      for (const [L, T] of h.links) {
        const kl = key(L)
        const kr = key(r)
        if (kr.startsWith(kl + path.sep)) { r = path.join(T, r.slice(L.length)); hit = true; break }
        if (final && kr === kl) { r = T; hit = true; break }
      }
      if (!hit) break
    }
    return r
  }
  const linkAt = (q: string) => [...h.links.keys()].some((L) => key(L) === key(q))
  const delLink = (q: string) => { for (const L of [...h.links.keys()]) if (key(L) === key(q)) h.links.delete(L) }
  const fakeLinkStats = () => ({
    isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, uid: 0, gid: 0, mode: 0o120777, size: 0, mtimeMs: Date.now(), nlink: 1, ino: 1, dev: 1,
  })
  const own = (p: string, st: any) => {
    if (!st) return st
    const u = h.uidFor?.(path.resolve(p))
    const m = h.modeFor?.(path.resolve(p))
    if (u === undefined && m === undefined) return st
    // Bigint stats keep bigints.
    const out = Object.assign(Object.create(Object.getPrototypeOf(st)), st)
    if (u !== undefined) out.uid = typeof st.uid === 'bigint' ? BigInt(u) : u
    if (m !== undefined) out.mode = typeof st.mode === 'bigint' ? BigInt(m) : m
    return out
  }
  const f1 = (fn: string) => (p: any, ...rest: any[]) => real[fn](isStr(p) ? follow(p, true) : p, ...rest)
  function realpathSync(p: any, o?: any) { return real.realpathSync(isStr(p) ? follow(p, true) : p, o) }
  realpathSync.native = (p: any, o?: any) => real.realpathSync.native(isStr(p) ? follow(p, true) : p, o)
  const over: Record<string, any> = {
    existsSync: f1('existsSync'), statSync: f1('statSync'), readFileSync: f1('readFileSync'), writeFileSync: f1('writeFileSync'),
    utimesSync: f1('utimesSync'),
    // A descriptor answers fstat for the path it was opened by (POSIX owner
    // and mode as modelled), and a mode change on it is told.
    openSync: (p: any, flags?: any, mode?: any) => {
      const fd = real.openSync(isStr(p) ? follow(p, true) : p, flags, mode)
      if (isStr(p)) h.fdPaths.set(fd, path.resolve(p))
      return fd
    },
    fstatSync: (fd: any, o?: any) => { const st = real.fstatSync(fd, o); const p = h.fdPaths.get(fd); return p === undefined ? st : own(p, st) },
    fchmodSync: (fd: any, mode: any) => { const p = h.fdPaths.get(fd); if (p !== undefined) h.onChmod?.(p, Number(mode)); return real.fchmodSync(fd, mode) },
    closeSync: (fd: any) => { h.fdPaths.delete(fd); return real.closeSync(fd) },
    unlinkSync: (p: any) => real.unlinkSync(isStr(p) ? follow(p, false) : p),
    renameSync: (a: any, b: any) => real.renameSync(isStr(a) ? follow(a, false) : a, isStr(b) ? follow(b, false) : b),
    realpathSync,
    lstatSync: (p: any, o?: any) => {
      if (!isStr(p)) return real.lstatSync(p, o)
      if (h.goneAtLstat?.(path.resolve(p))) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      const q = follow(p, false)
      const res = own(p, linkAt(q) ? fakeLinkStats() : real.lstatSync(q, o))
      h.onLstat?.(path.resolve(p))
      return res
    },
    mkdirSync: (p: any, o?: any) => {
      if (!isStr(p)) return real.mkdirSync(p, o)
      h.beforeMkdir?.(path.resolve(p))
      const q = follow(p, false)
      if (linkAt(q)) { if (o?.recursive) return undefined; throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' }) }
      const out = real.mkdirSync(q, o)
      h.mkdirs.push(path.resolve(q))
      return out
    },
    mkdtempSync: (prefix: any, o?: any) => {
      const q = follow(String(prefix), false)
      const made = real.mkdtempSync(q, o)
      h.made.push(path.resolve(made))
      return String(prefix) + made.slice(q.length)
    },
    rmdirSync: (p: any, o?: any) => { const q = follow(String(p), false); if (linkAt(q)) { delLink(q); return } return real.rmdirSync(q, o) },
    rmSync: (p: any, o?: any) => { const q = follow(String(p), false); if (linkAt(q)) { delLink(q); return } return real.rmSync(q, o) },
    readdirSync: (p: any, o?: any) => {
      if (!isStr(p)) return real.readdirSync(p, o)
      const out = real.readdirSync(follow(p, true), o)
      h.onReaddir?.(path.resolve(p))
      return out
    },
  }
  const wrapped = { ...real, ...over }
  delete (wrapped as any).default
  return { ...wrapped, default: wrapped }
}
vi.mock('fs', async (orig) => wrapFs(await orig()))
vi.mock('node:fs', async (orig) => wrapFs(await orig()))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => '' },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

const svc = vi.hoisted(() => ({
  pref: { claude: 'on', codex: 'on' } as Record<string, 'on' | 'off'>,
  released: 0,
}))
const runs = vi.hoisted(() => ({
  /** Told of each analysis as it starts, with the folder it runs in. */
  onAnalysis: null as null | ((cwd: string) => void),
  claudeCwds: [] as string[],
  codexCwds: [] as string[],
}))
const refusal = (id: string) => (svc.pref[id] === 'off'
  ? { code: 'provider-off', providerId: id, message: `${id === 'codex' ? 'Codex' : 'Claude Code'} is off. Turn it on in Settings, Accounts.` }
  : null)
const installation = (id: string) => ({ providerId: id, discoveryState: 'found', version: '0.155.1', compatibility: 'supported' })
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => refusal(id),
    discover: async (id: string) => (refusal(id) ? { ok: false, code: 'provider-disabled', message: 'off' } : { ok: true, installation: installation(id) }),
    readModelCatalogue: async () => ({ ok: true, catalogue: { ok: false, code: 'failed', detail: 'x' } }),
    prepareLaunch: async () => ({
      ok: true, lease: { release: () => { svc.released++ } }, binding: { providerAccountId: 'acct-work', authRealmId: 'realm-1' }, realmOnly: false,
      home: 'C:\\realms\\realm-1', executable: 'C:\\Tools\\codex.exe', env: { PATH: 'C:\\Tools' }, sessionsDir: 'C:\\realms\\realm-1\\sessions',
    }),
    snapshot: () => ({
      providers: [installation('codex')],
      accounts: [{ id: 'acct-work', identityId: 'id-1', providerLabel: 'work@example.com' }],
      identities: [{ id: 'id-1', friendlyName: 'Work' }],
    }),
  }),
}))
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/core')>()),
  tryGetProviderPackage: (id: string) => id !== 'codex' ? null : {
    id, displayName: 'Codex',
    setup: { supportedVersions: { minimum: '0.153.4', maximumTested: '0.156.1' } },
    review: {
      run: async (input: { cwd: string }) => {
        runs.codexCwds.push(input.cwd)
        runs.onAnalysis?.(input.cwd)
        return { ok: true, text: JSON.stringify({ breakingChanges: [] }) }
      },
    },
  },
}))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
}))
vi.mock('../../../src/main/account-profiles', () => ({
  resolveHeadlessProfileHome: () => ({ home: null, profileId: null }),
  // No start steps pending and every sign-in folder checked (the waits a launch makes first).
  startProfileStepsPending: () => false,
  startProfileStepsSettled: async () => {},
  profileCredentialFoldersChecked: () => true,
  checkProfileCredentialFolders: async () => {},
  listProfiles: () => [],
  sharedRoot: () => '',
}))
vi.mock('../../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async (args: string[], _t?: number, _stdin?: string, _home?: string | null, _signal?: AbortSignal, opts?: { cwd?: string }) => {
    if (args[0] === '--version') return { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '' }
    if (opts?.cwd) {
      runs.claudeCwds.push(opts.cwd)
      runs.onAnalysis?.(opts.cwd)
    }
    return { code: 0, stdout: JSON.stringify({ type: 'result', result: JSON.stringify({ breakingChanges: [] }) }), stderr: '' }
  },
}))
vi.mock('../../../src/main/sentinel/sentinel-model-article', () => ({ fetchArticleModelIds: async () => null }))
vi.mock('../../../src/main/sentinel/sentinel-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-changelog')>()),
  fetchChangelog: async () => null,
}))
vi.mock('../../../src/main/sentinel/sentinel-codex-changelog', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/sentinel/sentinel-codex-changelog')>()),
  fetchCodexReleaseNotes: async () => ({ text: '## 0.155.1\n- The rollout file format changed.', versions: ['0.155.1'], cut: null }),
}))

const nodePath = await import('node:path')
const os = await import('node:os')
// Loads the wrapper now, so the real module is at hand before the first case.
await import('fs')
const { join, basename, dirname } = nodePath
const R = () => h.real
const PREFIX = 'ccc-sentinel-runs-held-'
let dir = ''
const realGetuid = (process as any).getuid

beforeEach(() => {
  dir = R().mkdtempSync(join(os.tmpdir(), PREFIX))
  h.links.clear()
  h.onReaddir = null; h.uidFor = null; h.modeFor = null; h.onLstat = null; h.onChmod = null
  h.fdPaths.clear(); h.made = []
  h.beforeMkdir = null; h.goneAtLstat = null; h.mkdirs = []
  svc.pref = { claude: 'on', codex: 'on' }
  svc.released = 0
  runs.onAnalysis = null
  runs.claudeCwds = []
  runs.codexCwds = []
})
afterEach(() => {
  if (realGetuid === undefined) delete (process as any).getuid
  else (process as any).getuid = realGetuid
  h.links.clear()
  h.onReaddir = null; h.uidFor = null; h.modeFor = null; h.onLstat = null; h.onChmod = null
  h.beforeMkdir = null; h.goneAtLstat = null
  // TEST CLEANUP GUARD: only this suite's own state folder, by its prefix and parent.
  if (basename(dir).startsWith(PREFIX) && nodePath.resolve(dirname(dir)) === nodePath.resolve(os.tmpdir())) {
    try { R().rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** The REAL Sentinel service over this suite's own folder; a Codex update is
 *  waiting to be analysed (on Claude Code while it is on, else on Codex). */
async function sentinel() {
  R().mkdirSync(join(dir, 'sentinel'), { recursive: true })
  R().writeFileSync(join(dir, 'sentinel', 'sentinel-state.json'), JSON.stringify({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.153.4', analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [] }))
  const { _initRegistryForTest } = await import('../../../src/main/model-registry-service')
  _initRegistryForTest(dir)
  const mod = await import('../../../src/main/sentinel/index')
  mod.initSentinel(dir)
  return mod
}
const sentinelDir = () => join(dir, 'sentinel')
const runsDir = () => join(dir, 'sentinel', 'runs')
const same = (a: string, b: string) => (process.platform === 'win32' ? nodePath.resolve(a).toLowerCase() === nodePath.resolve(b).toLowerCase() : nodePath.resolve(a) === nodePath.resolve(b))
const NO_FOLDER = "Sentinel's analysis could not run on Claude Code: no empty folder could be made for it."
/** A real folder named like a run's leftover, with a file in it, 2 hours old. */
function oldFolder(parent: string, name: string): string {
  const d = join(parent, name)
  R().mkdirSync(d, { recursive: true })
  R().writeFileSync(join(d, 'keep.txt'), 'kept')
  const old = new Date(Date.now() - 2 * 3600_000)
  R().utimesSync(d, old, old)
  return d
}
/** While an analysis runs: a folder of its own name is put in `elsewhere`,
 *  and the runs folder becomes a link to `elsewhere`. */
function swapRunsWhileItRuns(elsewhere: string): { planted: () => string } {
  let planted = ''
  runs.onAnalysis = (cwd) => {
    planted = join(elsewhere, basename(cwd))
    R().mkdirSync(planted, { recursive: true })
    R().writeFileSync(join(planted, 'keep.txt'), 'kept')
    h.links.set(nodePath.resolve(runsDir()), elsewhere)
  }
  return { planted: () => planted }
}

describe("an analysis's own folder is removed only while the runs folder is still the one checked [host]", () => {
  it("Claude Code's analysis: the runs folder swapped for a link while it runs; nothing in the link target is removed [host]", async () => {
    const elsewhere = join(dir, 'elsewhere')
    R().mkdirSync(elsewhere, { recursive: true })
    const swap = swapRunsWhileItRuns(elsewhere)
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(runs.claudeCwds).toHaveLength(1)
    expect(swap.planted()).not.toBe('')
    expect(R().readFileSync(join(swap.planted(), 'keep.txt'), 'utf8')).toBe('kept')
  })

  it("Codex's analysis: the runs folder swapped for a link while it runs; nothing in the link target is removed, and the lease goes [host]", async () => {
    svc.pref.claude = 'off'
    const elsewhere = join(dir, 'elsewhere')
    R().mkdirSync(elsewhere, { recursive: true })
    const swap = swapRunsWhileItRuns(elsewhere)
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(runs.codexCwds).toHaveLength(1)
    expect(R().readFileSync(join(swap.planted(), 'keep.txt'), 'utf8')).toBe('kept')
    expect(svc.released).toBe(1)
  })

  it('control: with the runs folder as it was, the analysis folder goes after the run [host]', async () => {
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(runs.claudeCwds).toHaveLength(1)
    expect(R().existsSync(runs.claudeCwds[0])).toBe(false)
  })
})

describe('the stale sweep asks again before each folder it removes [host]', () => {
  it('the runs folder swapped for a link once it is listed: a leftover of the same name in the link target is not removed [host]', async () => {
    R().mkdirSync(runsDir(), { recursive: true })
    oldFolder(runsDir(), 'ccc-sentinel-claude-OLD111')
    const elsewhere = join(dir, 'elsewhere')
    const victim = oldFolder(elsewhere, 'ccc-sentinel-claude-OLD111')
    h.onReaddir = (p) => { if (nodePath.resolve(p) === nodePath.resolve(runsDir())) { h.onReaddir = null; h.links.set(nodePath.resolve(runsDir()), elsewhere) } }
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(R().readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('kept')
    // The runs folder no longer holds: no folder is made through it, nothing runs.
    expect(runs.claudeCwds).toHaveLength(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe("Sentinel's analysis could not run on Claude Code: no empty folder could be made for it.")
  })

  it('control: a leftover in the real runs folder is swept, and the analysis runs [host]', async () => {
    R().mkdirSync(runsDir(), { recursive: true })
    const leftover = oldFolder(runsDir(), 'ccc-sentinel-claude-OLD222')
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(R().existsSync(leftover)).toBe(false)
    expect(runs.claudeCwds).toHaveLength(1)
  })
})

describe('on POSIX the runs folder is writable by no one else [host]', () => {
  it('a runs folder others can write to is refused: nothing is swept in it and nothing runs [host]', async () => {
    R().mkdirSync(runsDir(), { recursive: true })
    const leftover = oldFolder(runsDir(), 'ccc-sentinel-claude-OLD333')
    for (const mode of [0o040770, 0o040707]) {
      ;(process as any).getuid = () => 4242
      h.uidFor = () => 4242
      h.modeFor = (p) => (nodePath.resolve(p) === nodePath.resolve(runsDir()) ? mode : undefined)
      runs.claudeCwds = []
      const s = await sentinel()
      await s.sentinelStartupCheck()
      expect(runs.claudeCwds, mode.toString(8)).toHaveLength(0)
      expect(R().existsSync(join(leftover, 'keep.txt')), mode.toString(8)).toBe(true)
      expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe(NO_FOLDER)
    }
  })

  it("Sentinel's own folder, this user's but others can write to it: made owner-only through a handle on the folder its lstat saw, and the analysis runs [host]", async () => {
    let sentinelMode = 0o040775
    const chmods: number[] = []
    h.onChmod = (p, m) => { if (same(p, sentinelDir())) { chmods.push(m); sentinelMode = 0o040000 | m } }
    ;(process as any).getuid = () => 4242
    h.uidFor = () => 4242
    h.modeFor = (p) => (same(p, sentinelDir()) ? sentinelMode : same(p, runsDir()) ? 0o040700 : undefined)
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(chmods).toEqual([0o700])
    expect(runs.claudeCwds).toHaveLength(1)
  })

  it("Sentinel's own folder that others can still write to (a drive without file permissions), or another user's: refused, nothing is swept in its runs folder and nothing runs [host]", async () => {
    R().mkdirSync(runsDir(), { recursive: true })
    const leftover = oldFolder(runsDir(), 'ccc-sentinel-claude-OLD444')
    for (const [uid, mode] of [[4242, 0o040775], [4242, 0o040757], [7, 0o040700]]) {
      const tag = `${uid} ${mode.toString(8)}`
      ;(process as any).getuid = () => 4242
      h.uidFor = (p) => (same(p, sentinelDir()) ? uid : 4242)
      h.modeFor = (p) => (same(p, sentinelDir()) ? mode : same(p, runsDir()) ? 0o040700 : undefined)
      runs.claudeCwds = []
      const s = await sentinel()
      await s.sentinelStartupCheck()
      expect(runs.claudeCwds, tag).toHaveLength(0)
      expect(R().existsSync(join(leftover, 'keep.txt')), tag).toBe(true)
      expect(s.getSentinelState()!.snapshot().lastAnalysisError, tag).toBe(NO_FOLDER)
    }
  })
})

describe("Sentinel's own folder is checked before its runs folder is made in it [host]", () => {
  it("Sentinel's own folder a link: refused before its runs folder or an analysis folder is made through it; nothing runs [host]", async () => {
    const elsewhere = join(dir, 'elsewhere-sentinel')
    R().mkdirSync(elsewhere, { recursive: true })
    const s = await sentinel()
    h.links.set(nodePath.resolve(sentinelDir()), elsewhere)
    await s.sentinelStartupCheck()
    // (Its state file is another module's, written where the folder names.)
    expect(R().existsSync(join(elsewhere, 'runs'))).toBe(false)
    expect(h.made.filter((m) => same(nodePath.dirname(nodePath.dirname(m)), elsewhere))).toEqual([])
    expect(runs.claudeCwds).toHaveLength(0)
  })

  it("Sentinel's own folder not there at its check, and a link put in its place before it is made: nothing is made through the link, and nothing runs [host]", async () => {
    const elsewhere = join(dir, 'elsewhere-absent')
    R().mkdirSync(elsewhere, { recursive: true })
    const s = await sentinel()
    let fired = false
    h.goneAtLstat = (p) => {
      if (fired || !same(p, sentinelDir())) return false
      fired = true
      h.links.set(nodePath.resolve(sentinelDir()), elsewhere)
      return true
    }
    await s.sentinelStartupCheck()
    expect(fired).toBe(true)
    expect(R().existsSync(join(elsewhere, 'runs'))).toBe(false)
    expect(h.mkdirs.filter((m) => same(m, elsewhere) || nodePath.resolve(m).toLowerCase().startsWith(nodePath.resolve(elsewhere).toLowerCase() + nodePath.sep))).toEqual([])
    expect(runs.claudeCwds).toHaveLength(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe(NO_FOLDER)
  })

  it("Sentinel's own folder swapped for a link as its runs folder is made: the runs folder made through it is removed again, and nothing runs [host]", async () => {
    const elsewhere = join(dir, 'elsewhere-at-make')
    R().mkdirSync(elsewhere, { recursive: true })
    const s = await sentinel()
    h.beforeMkdir = (p) => { if (same(p, runsDir())) { h.beforeMkdir = null; h.links.set(nodePath.resolve(sentinelDir()), elsewhere) } }
    await s.sentinelStartupCheck()
    expect(R().existsSync(join(elsewhere, 'runs'))).toBe(false)
    expect(runs.claudeCwds).toHaveLength(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe(NO_FOLDER)
  })

  it("on POSIX, Sentinel's own folder another user's: refused before its runs folder is made in it; nothing runs [host]", async () => {
    ;(process as any).getuid = () => 4242
    h.uidFor = (p) => (same(p, sentinelDir()) ? 7 : 4242)
    h.modeFor = (p) => (same(p, sentinelDir()) ? 0o040700 : undefined)
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(R().existsSync(runsDir())).toBe(false)
    expect(h.mkdirs.filter((m) => same(m, runsDir()))).toEqual([])
    expect(runs.claudeCwds).toHaveLength(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe(NO_FOLDER)
  })

  it("control: Sentinel's own folder and its runs folder not there yet are each made, owner-only where modes apply, and the analysis runs [host]", async () => {
    const s = await sentinel()
    R().rmSync(runsDir(), { recursive: true, force: true })
    await s.sentinelStartupCheck()
    expect(runs.claudeCwds).toHaveLength(1)
    expect(R().statSync(runsDir()).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(R().statSync(runsDir()).mode & 0o777).toBe(0o700)
  })
})

describe('the runs folder is matched by its real path as well as its lstat [host]', () => {
  it('the runs folder swapped for a link just after its lstat when it is chosen: no folder is made in the link target, and nothing runs [host]', async () => {
    const elsewhere = join(dir, 'elsewhere-rp')
    R().mkdirSync(elsewhere, { recursive: true })
    h.onLstat = (p) => { if (same(p, runsDir())) { h.onLstat = null; h.links.set(nodePath.resolve(runsDir()), elsewhere) } }
    const s = await sentinel()
    await s.sentinelStartupCheck()
    expect(h.made.filter((m) => same(nodePath.dirname(m), elsewhere))).toEqual([])
    expect(R().readdirSync(elsewhere)).toEqual([])
    expect(runs.claudeCwds).toHaveLength(0)
    expect(s.getSentinelState()!.snapshot().lastAnalysisError).toBe(NO_FOLDER)
  })
})
