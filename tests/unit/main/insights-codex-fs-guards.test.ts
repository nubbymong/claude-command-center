// [host] WP2 PR 4, P4.7 (row 68): a Codex Insights report's runs folder, its
// sessions read and its report.json, with links MODELLED rather than made. No
// link or junction is ever planted: `h.links` maps a path to a target folder
// or file, and the fs wrapper below does with it what the OS does with a link
// (lstat and a directory entry say "link"; everything else follows it, except
// an open that asks not to follow one). Every real file is under this suite's
// own temp folder. The REAL walk, runner and sweep; the accounts service and
// the model run are fakes, so no process starts. The same guarantees with
// real links are in insights-codex-links.test.ts (quarantined: CI and VM only).
//
// Guarantees held here:
//  - reports, the catalogue and the runs folders are written only into
//    `insights` when it is Insights' own folder (a real folder, its real path
//    `<resources>/insights`, on POSIX this user's and writable by no one
//    else): a Claude Code run, a Codex report, a roll-up and the catalogue
//    are refused before any launch when it is not, and start-up never fails
//    on the catalogue; each run's own folder is made new (an entry already
//    at its name refuses the run), and every file of a run, Claude Code's
//    report and its facets included, is written by one writer that checks
//    the run's folder (and the facets folder made in it) again first;
//  - main reads a report, a run's figures, the catalogue and the files a
//    Claude Code report is copied from only as the regular file each is, at
//    a bounded size, never waiting on one;
//  - the runs folder, and `insights` above it, are real folders (never links)
//    and (POSIX) both writable by no one else, checked before any launch,
//    again just before the stale sweep and again just before the run's
//    folder is removed (each check by lstat and by real path): a runs folder
//    found to be a link at a check is never swept or removed through;
//  - `insights` is checked before the runs folder is made in it, and on POSIX
//    made owner-only only through a handle on the folder its lstat saw
//    (opened without following a link; a folder, this user's, the same
//    device and inode), so nothing that took its place is ever changed;
//  - each session is read through the file the walk saw (the same file, a
//    regular one with no second name), never one that took its place, and
//    the whole read has a time limit: a read that does not end fails the run
//    and lets go of the account and the lock, its stream and file are let go
//    once each, and its walk stops;
//  - main hands the page a Codex run's report.json only as the regular file
//    its lstat saw.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const ACCT = `acct-${'a'.repeat(16)}`
const PREFIX = 'ins-codex-fsg-'

const h = vi.hoisted(() => ({
  resourcesDir: '',
  sessionsDir: '',
  tmpRoot: '',
  /** path -> the folder or file a modelled link there points at */
  links: new Map<string, string>(),
  onReaddir: null as null | ((p: string) => void),
  onLstat: null as null | ((p: string) => void),
  onRun: null as null | ((cwd: string) => void),
  uidFor: null as null | ((p: string) => number | undefined),
  modeFor: null as null | ((p: string) => number | undefined),
  /** Files whose open answers, but which are not regular files (a FIFO). */
  fifo: new Set<string>(),
  /** Open descriptors of such files (the sync calls). */
  fifoFds: new Set<number>(),
  /** Files whose open does not answer until `release` (a stalled mount). */
  hang: new Set<string>(),
  release: null as null | (() => void),
  gate: null as null | Promise<void>,
  hangStreams: [] as Array<{ destroy(e?: Error): void; destroyed: boolean }>,
  /** path -> the file a modelled HARD link there is a second name of: every
   *  call on the path lands on the target, and its stats say nlink 2. */
  hard: new Map<string, string>(),
  /** Files that gain a second name after the walk: the open file says nlink 2. */
  hardOnOpen: new Set<string>(),
  /** Modelled hard links whose other name is gone by the open: the open file says nlink 1. */
  hardGoneOnOpen: new Set<string>(),
  /** Files that open as regular files but whose data never comes. */
  stall: new Set<string>(),
  /** Folders whose listing does not answer until `release`. */
  hangReaddir: new Set<string>(),
  /** destroy() calls on a stalled stream, and closes of a stalled file. */
  destroys: 0,
  closes: 0,
  /** An inode number a stat of the path reports (lstat, or fstat of an open descriptor). */
  inoFor: null as null | ((p: string, how: 'lstat' | 'fstat') => bigint | undefined),
  /** Told of each chmodSync and fchmodSync: the path named (for fchmodSync
   *  the path the descriptor was opened by), the mode, and where it lands
   *  once links are followed (POSIX modes are modelled in `modeFor`). */
  onChmod: null as null | ((p: string, mode: number, target: string) => void),
  /** Open descriptors and the path each was opened by (the sync calls). */
  fdPaths: new Map<number, string>(),
  /** Open descriptors and where each landed once links were followed. */
  fdTargets: new Map<number, string>(),
  /** The owner an fstat of an open descriptor reports, by where it landed
   *  (when unset, `uidFor`'s answer). */
  fstatUidFor: null as null | ((p: string) => number | undefined),
  prepareCalls: [] as Array<Record<string, unknown>>,
  execCalls: [] as Array<{ cwd: string; env: Record<string, string>; prompt: string }>,
  released: 0,
  /** Claude Code terminals started (none may be, in these cases). */
  ptySpawns: 0,
  /** Accounts the accounts snapshot lists. */
  snapAccounts: [] as Array<Record<string, unknown>>,
  /** Told of each mkdirSync, before it runs, with the path it names. */
  beforeMkdir: null as null | ((p: string) => void),
  /** A Claude Code account's home (its usage data is Claude Code's report)
   *  and its profile id; none by default (the default home, never read). */
  claudeHome: '',
  claudeProfile: null as null | string,
  /** What the Claude Code terminal does before it ends (writes nothing by
   *  default); unset, no terminal starts. */
  ptyRun: null as null | (() => void),
  /** The KPI reply a Claude Code run's analysis gets; unset, none runs. */
  claudeKpis: null as null | string,
  /** A rename that fails, by its destination (a full disk). */
  failRename: null as null | ((to: string) => boolean),
  /** Warnings the app logged. */
  warns: [] as string[],
  real: null as any,
}))

async function wrapFs(real: any): Promise<any> {
  const path = await import('node:path')
  const { Readable } = await import('node:stream')
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
    return h.hard.get(key(r)) ?? r
  }
  const isHard = (p: string) => h.hard.has(key(p))
  const linkAt = (q: string) => [...h.links.keys()].some((L) => key(L) === key(q))
  const delLink = (q: string) => { for (const L of [...h.links.keys()]) if (key(L) === key(q)) h.links.delete(L) }
  const fakeLinkStats = () => ({
    isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, isFIFO: () => false, isSocket: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, uid: 0, gid: 0, mode: 0o120777, size: 0, mtimeMs: Date.now(), nlink: 1, ino: 1, dev: 1,
  })
  /** The same stats, answering as a FIFO would. */
  const asFifo = (s: any) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, { isFile: () => false, isFIFO: () => true })
  /** The same stats with some fields answering otherwise (bigint stats keep bigints). */
  const patch = (st: any, fields: Record<string, number | bigint>) => {
    const out = Object.assign(Object.create(Object.getPrototypeOf(st)), st)
    for (const [k, v] of Object.entries(fields)) out[k] = typeof st[k] === 'bigint' ? BigInt(v) : Number(v)
    return out
  }
  const own = (p: string, st: any) => {
    if (!st) return st
    const fields: Record<string, number | bigint> = {}
    const u = h.uidFor?.(path.resolve(p))
    const m = h.modeFor?.(path.resolve(p))
    const i = h.inoFor?.(path.resolve(p), 'lstat')
    if (u !== undefined) fields.uid = u
    if (m !== undefined) fields.mode = m
    if (i !== undefined) fields.ino = i
    if (isHard(p)) fields.nlink = 2
    return Object.keys(fields).length ? patch(st, fields) : st
  }
  const fakeDirent = (name: string, dir: string) => ({
    name, parentPath: dir, path: dir, isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false,
    isFIFO: () => false, isSocket: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
  })
  const addLinks = (entries: any[], dirQ: string, withTypes: boolean) => {
    const extra = [...h.links.keys()].filter((L) => key(path.dirname(L)) === key(dirQ)).map((L) => path.basename(L))
    if (!extra.length) return entries
    const k = (n: string) => (win ? n.toLowerCase() : n)
    const names = new Set(extra.map(k))
    const kept = entries.filter((e) => !names.has(k(withTypes ? e.name : String(e))))
    return [...kept, ...extra.map((n) => (withTypes ? fakeDirent(n, dirQ) : n))]
  }
  const hanging = () => {
    const st = new Readable({ read() {} })
    const destroy = st.destroy.bind(st)
    st.destroy = ((e?: Error) => { h.destroys++; return destroy(e) }) as typeof st.destroy
    h.hangStreams.push(st)
    return st
  }
  const f1 = (fn: string, final = true) => (p: any, ...rest: any[]) => real[fn](isStr(p) ? follow(p, final) : p, ...rest)
  function realpathSync(p: any, o?: any) { return real.realpathSync(isStr(p) ? follow(p, true) : p, o) }
  realpathSync.native = (p: any, o?: any) => real.realpathSync.native(isStr(p) ? follow(p, true) : p, o)
  const NOFOLLOW = real.constants.O_NOFOLLOW ?? 0
  /** A handle that answers as a FIFO would (open, but not a regular file),
   *  as a file with a second name, or as a file whose data never comes. */
  const wrapHandle = (fh: any, as: { fifo: boolean; hard: boolean; stall: boolean }) => new Proxy(fh, {
    get(t, k) {
      if (k === 'stat') return async (o?: any) => { const s = await t.stat(o); return as.fifo ? asFifo(s) : as.hard ? patch(s, { nlink: 2 }) : s }
      if (k === 'createReadStream' && (as.fifo || as.stall)) return () => hanging()
      if (k === 'close' && as.stall) return async () => { h.closes++; return t.close() }
      const v = Reflect.get(t, k, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  const over: Record<string, any> = {
    existsSync: f1('existsSync'), statSync: f1('statSync'), readFileSync: f1('readFileSync'), writeFileSync: f1('writeFileSync'),
    appendFileSync: f1('appendFileSync'), utimesSync: f1('utimesSync'),
    chmodSync: (p: any, mode: any) => { if (isStr(p)) h.onChmod?.(path.resolve(p), Number(mode), follow(p, true)); return real.chmodSync(isStr(p) ? follow(p, true) : p, mode) },
    fchmodSync: (fd: any, mode: any) => {
      const p = h.fdPaths.get(fd)
      if (p !== undefined) h.onChmod?.(p, Number(mode), h.fdTargets.get(fd) ?? p)
      return real.fchmodSync(fd, mode)
    },
    accessSync: f1('accessSync'),
    // O_NOFOLLOW refuses a link as the last part (POSIX); other links are followed.
    openSync: (p: any, flags?: any, mode?: any) => {
      if (!isStr(p)) return real.openSync(p, flags, mode)
      if (typeof flags === 'number' && NOFOLLOW && (flags & NOFOLLOW) && linkAt(follow(p, false))) {
        throw Object.assign(new Error(`ELOOP: ${p}`), { code: 'ELOOP' })
      }
      const fd = real.openSync(follow(p, true), flags, mode)
      if (h.fifo.has(key(p))) h.fifoFds.add(fd)
      h.fdPaths.set(fd, path.resolve(p))
      h.fdTargets.set(fd, follow(p, true))
      return fd
    },
    fstatSync: (fd: any, o?: any) => {
      const st = h.fifoFds.has(fd) ? asFifo(real.fstatSync(fd, o)) : real.fstatSync(fd, o)
      const p = h.fdPaths.get(fd)
      const t = h.fdTargets.get(fd)
      const fields: Record<string, number | bigint> = {}
      const i = p !== undefined ? h.inoFor?.(p, 'fstat') : undefined
      const u = t !== undefined ? (h.fstatUidFor?.(t) ?? h.uidFor?.(t)) : undefined
      if (i !== undefined) fields.ino = i
      if (u !== undefined) fields.uid = u
      return Object.keys(fields).length ? patch(st, fields) : st
    },
    closeSync: (fd: any) => { h.fifoFds.delete(fd); h.fdPaths.delete(fd); h.fdTargets.delete(fd); return real.closeSync(fd) },
    createReadStream: (p: any, o?: any) => {
      const q = isStr(p) ? follow(p, true) : p
      if (isStr(p) && (h.fifo.has(key(p)) || h.hang.has(key(p)))) return hanging()
      return real.createReadStream(q, o)
    },
    createWriteStream: f1('createWriteStream'),
    unlinkSync: f1('unlinkSync', false),
    // A rename onto a link replaces the link, as the OS does.
    renameSync: (a: any, b: any) => {
      if (isStr(b) && h.failRename?.(path.resolve(b))) throw Object.assign(new Error(`ENOSPC: no space left on device, rename -> ${b}`), { code: 'ENOSPC' })
      const to = isStr(b) ? follow(b, false) : b
      real.renameSync(isStr(a) ? follow(a, false) : a, to)
      if (isStr(b)) delLink(to)
    },
    copyFileSync: (a: any, b: any, m?: any) => real.copyFileSync(isStr(a) ? follow(a, true) : a, isStr(b) ? follow(b, true) : b, m),
    realpathSync,
    lstatSync: (p: any, o?: any) => {
      if (!isStr(p)) return real.lstatSync(p, o)
      const q = follow(p, false)
      const st = linkAt(q) ? fakeLinkStats() : real.lstatSync(q, o)
      const res = own(p, h.fifo.has(key(p)) && st ? asFifo(st) : st)
      h.onLstat?.(path.resolve(p))
      return res
    },
    mkdirSync: (p: any, o?: any) => {
      if (!isStr(p)) return real.mkdirSync(p, o)
      h.beforeMkdir?.(path.resolve(p))
      const q = follow(p, false)
      if (linkAt(q)) { if (o?.recursive) return undefined; throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' }) }
      return real.mkdirSync(q, o)
    },
    mkdtempSync: (prefix: any, o?: any) => {
      const q = follow(String(prefix), false)
      const made = real.mkdtempSync(q, o)
      return String(prefix) + made.slice(q.length)
    },
    rmdirSync: (p: any, o?: any) => { const q = follow(String(p), false); if (linkAt(q)) { delLink(q); return } return real.rmdirSync(q, o) },
    rmSync: (p: any, o?: any) => { const q = follow(String(p), false); if (linkAt(q)) { delLink(q); return } return real.rmSync(q, o) },
    readdirSync: (p: any, o?: any) => {
      if (!isStr(p)) return real.readdirSync(p, o)
      const q = follow(p, true)
      h.onReaddir?.(path.resolve(p))
      return addLinks(real.readdirSync(q, o), path.resolve(p), !!(o && typeof o === 'object' && o.withFileTypes))
    },
  }
  const promises = {
    ...real.promises,
    readdir: async (p: any, o?: any) => {
      if (h.hangReaddir.has(key(String(p)))) { await h.gate }
      const q = follow(String(p), true)
      h.onReaddir?.(path.resolve(String(p)))
      return addLinks(await real.promises.readdir(q, o), path.resolve(String(p)), !!(o && typeof o === 'object' && o.withFileTypes))
    },
    lstat: async (p: any, o?: any) => {
      const s = String(p)
      const q = follow(s, false)
      const res = own(s, linkAt(q) ? fakeLinkStats() : await real.promises.lstat(q, o))
      h.onLstat?.(path.resolve(s))
      return res
    },
    stat: async (p: any, o?: any) => real.promises.stat(follow(String(p), true), o),
    open: async (p: any, flags?: any, mode?: any) => {
      const s = String(p)
      if (h.hang.has(key(s))) { await h.gate }
      // O_NOFOLLOW refuses a link as the last part (POSIX); other links are followed.
      if (typeof flags === 'number' && NOFOLLOW && (flags & NOFOLLOW) && linkAt(follow(s, false))) {
        throw Object.assign(new Error(`ELOOP: ${s}`), { code: 'ELOOP' })
      }
      const fh = await real.promises.open(follow(s, true), flags, mode)
      const as = { fifo: h.fifo.has(key(s)), hard: (isHard(s) && !h.hardGoneOnOpen.has(key(s))) || h.hardOnOpen.has(key(s)), stall: h.stall.has(key(s)) }
      return as.fifo || as.hard || as.stall ? wrapHandle(fh, as) : fh
    },
  }
  const wrapped = { ...real, ...over, promises }
  delete (wrapped as any).default
  return { ...wrapped, default: wrapped }
}
vi.mock('fs', async (orig) => wrapFs(await orig()))
vi.mock('node:fs', async (orig) => wrapFs(await orig()))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.resourcesDir, registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/profile-consumers', () => ({ acquireProfileConsumer: () => () => {}, waitForProfileRefresh: async () => {} }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }), withProfileHome: (env: unknown) => env }))
// A Claude Code terminal only where a case gives it a step (`ptyRun`): it
// does that step and ends at once with exit code 0.
vi.mock('node-pty', () => ({
  spawn: () => {
    h.ptySpawns++
    const step = h.ptyRun
    if (!step) throw new Error('no Claude PTY in a Codex run')
    return { onData: () => {}, write: () => {}, kill: () => {}, onExit: (cb: (e: { exitCode: number }) => void) => { step(); cb({ exitCode: 0 }) } }
  },
}))
// No Claude Code account unless a case names one (`claudeProfile`): a Claude
// Code run then resolves its home (`claudeHome`).
vi.mock('../../../src/main/account-profiles', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => h.claudeProfile,
  getProfileConfigDir: () => h.claudeHome,
  listProfiles: () => [],
  setupProfileLinks: () => {},
}))
vi.mock('../../../src/main/managed-launch-diagnostics', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunch: async () => null,
}))
vi.mock('../../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async () => {
    if (h.claudeKpis === null) throw new Error('no Claude run in a Codex run')
    return { code: 0, stdout: h.claudeKpis, stderr: '' }
  },
}))
vi.mock('../../../src/main/debug-logger', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { h.warns.push(a.map(String).join(' ')) },
}))
vi.mock('../../../src/main/providers/codex/insights-exec', () => ({
  CODEX_INSIGHTS_TIMEOUT_MS: 600_000,
  runCodexInsightsExec: async () => { throw new Error('reached past the package entry point') },
  createCodexInsightsOperations: () => ({ run: async () => { throw new Error('reached past the package entry point') } }),
}))
// The runner's time limit on the sessions read, short here (the module's own
// default is what a real run uses).
vi.mock('../../../src/main/insights-codex', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/insights-codex')>()),
  CODEX_INSIGHTS_READ_TIME_LIMIT_MS: 400,
}))
const REPLY = JSON.stringify({
  atAGlance: { working: 'Small edits land first time.', hindering: 'Read Only sessions stall.', quickWin: 'Start with Standard.' },
  narrative: { paragraphs: ['You use Codex for focused edits.'] },
  bigWins: [], friction: [], features: [], patterns: [], horizon: '',
  summary: { improvements: [], regressions: [], suggestions: [] },
  tasksCompletedRate: 0.8,
})
vi.mock('../../../src/main/providers/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/providers/core')>()),
  tryGetProviderPackage: (id: string) => (id === 'codex' ? {
    displayName: 'Codex',
    insights: {
      run: async (input: { cwd: string; prompt: string; env: Record<string, string> }) => {
        h.execCalls.push({ cwd: input.cwd, env: input.env, prompt: input.prompt })
        h.onRun?.(input.cwd)
        return { ok: true, text: REPLY }
      },
    },
  } : undefined),
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: () => null,
    snapshot: () => ({ revision: 1, providers: [], groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [], identities: [], accounts: h.snapAccounts }),
    prepareLaunch: async (input: Record<string, unknown>) => {
      h.prepareCalls.push(input)
      return {
        ok: true, lease: { release: () => { h.released++ } }, binding: { providerAccountId: input.providerAccountId }, realmOnly: false,
        home: h.sessionsDir + '-home', executable: '/usr/bin/codex', env: { PATH: '/usr/bin' }, sessionsDir: h.sessionsDir,
      }
    },
  }),
}))

const nodePath = await import('node:path')
const os = await import('node:os')
const { join, dirname, basename } = nodePath
const codex = await import('../../../src/main/insights-codex')
const runner = await import('../../../src/main/insights-runner')
const win = () => null
const RUNS = '.insights-codex-runs'
const R = () => h.real
const NO_FOLDER = 'This report could not be written: no empty folder could be made for it.'
/** Why nothing is written when `insights` is not Insights' own folder. */
const INSIGHTS_REFUSED = "Nothing was written: the insights folder in the app's resources folder could not be checked as Insights' own folder. It must be a real folder, not a link or junction, and on macOS and Linux one only you can write to (a drive without file permissions cannot hold one)."
/** Why nothing is written when a run's own folder cannot be made new and checked. */
const RUN_FOLDER_REFUSED = "Nothing was written: this run's own folder in the insights folder could not be made and checked."
/** The run-id shaped folders directly in `dir` (a run's own folders). */
const runFolders = (dir: string): string[] => (R().existsSync(dir) ? R().readdirSync(dir).filter((n: string) => /^\d{4}-\d{2}-\d{2}-/.test(n)) : [])

function rollout(cwd: string, text: string): string {
  const at = new Date().toISOString()
  return [
    { timestamp: at, type: 'session_meta', payload: { id: 's', cwd } },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: text, kind: 'plain' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done.', duration_ms: 5000 } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n'
}
const dayDir = () => join(h.sessionsDir, '2026', '10', '01')
const insightsDir = () => join(h.resourcesDir, 'insights')
const runsParent = () => join(insightsDir(), RUNS)
const runOf = (id: string) => runner.getCatalogue().runs.find((r: any) => r.id === id)!
/** A path as the fs wrapper keys it (case-folded on Windows). */
const fkey = (f: string) => { const k = nodePath.resolve(f); return process.platform === 'win32' ? k.toLowerCase() : k }
/** A real folder named like a stale run leftover, with a file in it, 3 hours old. */
function staleVictim(parent: string, name = 'ccc-insights-codex-victim1'): string {
  const d = join(parent, name)
  R().mkdirSync(d, { recursive: true })
  R().writeFileSync(join(d, 'keep.txt'), 'kept')
  const old = new Date(Date.now() - 3 * 3600_000)
  R().utimesSync(d, old, old)
  return d
}
const realGetuid = (process as any).getuid
/** POSIX ownership as a test sees it: the process is uid 4242. */
function posixAs(uidOf: (p: string) => number, modeOf: (p: string) => number | undefined = () => undefined): void {
  ;(process as any).getuid = () => 4242
  h.uidFor = (p) => uidOf(p)
  h.modeFor = (p) => modeOf(p)
}

beforeEach(() => {
  h.tmpRoot = R().mkdtempSync(join(os.tmpdir(), PREFIX))
  h.resourcesDir = join(h.tmpRoot, 'resources')
  h.sessionsDir = join(h.tmpRoot, 'realm', 'sessions')
  R().mkdirSync(h.resourcesDir, { recursive: true })
  R().mkdirSync(dayDir(), { recursive: true })
  R().writeFileSync(join(dayDir(), 'rollout-a.jsonl'), rollout('C:\\proj\\a', 'ACCOUNT-A-TEXT fix the bug'))
  h.links.clear()
  h.onReaddir = null; h.onLstat = null; h.onRun = null; h.uidFor = null; h.modeFor = null
  h.prepareCalls = []; h.execCalls = []; h.released = 0
  h.fifo.clear(); h.fifoFds.clear(); h.hang.clear(); h.hangStreams = []
  h.hard.clear(); h.hardOnOpen.clear(); h.hardGoneOnOpen.clear(); h.stall.clear(); h.hangReaddir.clear(); h.destroys = 0; h.closes = 0
  h.inoFor = null; h.onChmod = null; h.fdPaths.clear(); h.fdTargets.clear(); h.fstatUidFor = null
  h.ptySpawns = 0; h.snapAccounts = []; h.beforeMkdir = null
  h.claudeHome = ''; h.claudeProfile = null; h.ptyRun = null; h.claudeKpis = null; h.failRename = null; h.warns = []
  h.gate = new Promise<void>((r) => { h.release = r })
})
afterEach(() => {
  h.release?.()
  for (const s of h.hangStreams) s.destroy(new Error('the test is over'))
  if (realGetuid === undefined) delete (process as any).getuid
  else (process as any).getuid = realGetuid
  h.links.clear(); h.hard.clear()
  h.onReaddir = null; h.onLstat = null; h.onRun = null; h.uidFor = null; h.modeFor = null; h.inoFor = null; h.onChmod = null; h.fstatUidFor = null
  h.beforeMkdir = null; h.ptyRun = null; h.failRename = null
  const t = h.tmpRoot
  if (t && basename(t).startsWith(PREFIX) && nodePath.resolve(dirname(t)) === nodePath.resolve(os.tmpdir())) {
    try { R().rmSync(t, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('the runs folder is a real folder, checked before any launch [host]', () => {
  it('a runs folder that is a link: refused before the account is launched; nothing swept, made or run through it [host]', async () => {
    const outside = join(h.tmpRoot, 'outside')
    const victim = staleVictim(outside)
    R().mkdirSync(insightsDir(), { recursive: true })
    h.links.set(nodePath.resolve(runsParent()), outside)
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: NO_FOLDER })
    expect(h.prepareCalls).toEqual([])
    expect(h.execCalls).toHaveLength(0)
    expect(R().readdirSync(outside)).toEqual(['ccc-insights-codex-victim1'])
    expect(R().existsSync(join(victim, 'keep.txt'))).toBe(true)
    expect(runner.isRunning()).toBe(false)
  })

  it("an `insights` folder that is a link: refused with the reason before any launch; nothing (no record, no run folder, no runs folder) is made through it [host]", async () => {
    const outside = join(h.tmpRoot, 'outside-insights')
    R().mkdirSync(outside, { recursive: true })
    h.links.set(nodePath.resolve(insightsDir()), outside)
    await expect(runner.runCodexInsights(win, { accountId: ACCT })).rejects.toThrow(INSIGHTS_REFUSED)
    expect(R().readdirSync(outside)).toEqual([])
    expect(h.prepareCalls).toEqual([])
    expect(h.execCalls).toHaveLength(0)
    expect(runner.isRunning()).toBe(false)
  })

  it('on POSIX a runs folder that others can write to is refused before any launch [host]', async () => {
    const parentKey = () => nodePath.resolve(runsParent())
    for (const mode of [0o040770, 0o040707, 0o040777]) {
      // `insights` above it is this user's only, so the runs folder's own mode is what is refused.
      posixAs(() => 4242, (p) => (p === parentKey() ? mode : fkey(p) === fkey(insightsDir()) ? 0o040700 : undefined))
      h.prepareCalls = []
      const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
      expect(runOf(id), mode.toString(8)).toMatchObject({ status: 'failed', error: NO_FOLDER })
      expect(h.prepareCalls).toEqual([])
    }
  })

  // [host] P4.7 fix pass 4: `insights` above the runs folder is held to the
  // runs folder's rule on POSIX. One this user owns that others can write to
  // (an older folder made under a group-writable umask) is made owner-only
  // (0700, fix pass 6) before anything is made in it; one that stays
  // writable by others, or is another user's, is refused before any launch.
  it('on POSIX an insights folder others can write to is made owner-only, or refused before any launch [host]', async () => {
    const ins = () => nodePath.resolve(insightsDir())
    const runs = () => nodePath.resolve(runsParent())
    R().mkdirSync(runsParent(), { recursive: true })
    let insMode = 0o040777
    const chmods: number[] = []
    h.onChmod = (p, m) => { if (fkey(p) === fkey(ins())) { chmods.push(m); insMode = 0o040000 | m } }
    posixAs(() => 4242, (p) => (fkey(p) === fkey(ins()) ? insMode : fkey(p) === fkey(runs()) ? 0o040700 : undefined))
    const ok = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(ok).status).toBe('complete')
    expect(chmods).toEqual([0o700])
    // The folder stays writable by others: refused with the reason, nothing
    // written into it and nothing launched.
    h.onChmod = null
    for (const mode of [0o040775, 0o040757, 0o040777]) {
      insMode = mode
      h.prepareCalls = []
      const before = runFolders(insightsDir())
      await expect(runner.runCodexInsights(win, { accountId: ACCT }), mode.toString(8)).rejects.toThrow(INSIGHTS_REFUSED)
      expect(runFolders(insightsDir()), mode.toString(8)).toEqual(before)
      expect(h.prepareCalls).toEqual([])
    }
    // Another user's insights folder: refused, never changed.
    insMode = 0o040700
    h.onChmod = (p) => { if (fkey(p) === fkey(ins())) chmods.push(-1) }
    posixAs((p) => (fkey(p) === fkey(ins()) ? 7 : 4242), (p) => (fkey(p) === fkey(ins()) ? 0o040777 : fkey(p) === fkey(runs()) ? 0o040700 : undefined))
    h.prepareCalls = []
    await expect(runner.runCodexInsights(win, { accountId: ACCT })).rejects.toThrow(INSIGHTS_REFUSED)
    expect(h.prepareCalls).toEqual([])
    expect(chmods).not.toContain(-1)
  })

  // [host] P4.7 fix pass 6: the owner-only change of `insights` acts through
  // a handle on the folder its lstat saw, opened without following a link
  // and checked to be a folder, this user's, and that same folder (device
  // and inode). Whatever is swapped in after the lstat is never changed, and
  // the run is refused before anything is made in it or launched.
  const insightsSwappedAfterItsLstat = (target: string) => {
    let armed = true
    h.onLstat = (p) => { if (armed && fkey(p) === fkey(insightsDir())) { armed = false; h.links.set(nodePath.resolve(insightsDir()), target) } }
  }
  const groupWritableInsights = () => posixAs(() => 4242, (p) => (fkey(p) === fkey(insightsDir()) ? 0o040775 : fkey(p) === fkey(runsParent()) ? 0o040700 : undefined))

  it("on POSIX `insights` swapped for a link to another folder of this user's after its lstat: that folder's rights never change and no runs folder is made in it; refused before any launch [host]", async () => {
    const elsewhere = join(h.tmpRoot, 'elsewhere-home', 'keys')
    R().mkdirSync(elsewhere, { recursive: true })
    R().writeFileSync(join(elsewhere, 'kept.txt'), 'kept')
    R().mkdirSync(runsParent(), { recursive: true })
    const landed: string[] = []
    h.onChmod = (_p, _m, target) => { landed.push(fkey(target)) }
    groupWritableInsights()
    insightsSwappedAfterItsLstat(elsewhere)
    await expect(runner.runCodexInsights(win, { accountId: ACCT })).rejects.toThrow(INSIGHTS_REFUSED)
    expect(landed).not.toContain(fkey(elsewhere))
    expect(R().readdirSync(elsewhere)).toEqual(['kept.txt'])
    expect(R().readFileSync(join(elsewhere, 'kept.txt'), 'utf8')).toBe('kept')
    expect(h.prepareCalls).toEqual([])
    expect(h.execCalls).toHaveLength(0)
  })

  it("on POSIX `insights` swapped for a link to a file of this user's after its lstat: the file's rights never change; nothing is launched [host]", async () => {
    const file = join(h.tmpRoot, 'elsewhere-home', 'settings.json')
    R().mkdirSync(dirname(file), { recursive: true })
    R().writeFileSync(file, '{}')
    R().mkdirSync(runsParent(), { recursive: true })
    const landed: string[] = []
    h.onChmod = (_p, _m, target) => { landed.push(fkey(target)) }
    groupWritableInsights()
    insightsSwappedAfterItsLstat(file)
    // `insights` now names a file, so the run's record cannot be kept under
    // it either: the run may end in an error; nothing is changed or launched.
    await runner.runCodexInsights(win, { accountId: ACCT }).catch(() => null)
    expect(landed).not.toContain(fkey(file))
    expect(R().readFileSync(file, 'utf8')).toBe('{}')
    expect(h.prepareCalls).toEqual([])
    expect(h.execCalls).toHaveLength(0)
  })

  it("on POSIX a file in `insights`' place that even carries the folder's own inode number is never changed; nothing is launched [host]", async () => {
    const file = join(h.tmpRoot, 'elsewhere-home', 'notes.txt')
    R().mkdirSync(dirname(file), { recursive: true })
    R().writeFileSync(file, 'kept')
    R().mkdirSync(runsParent(), { recursive: true })
    const folderIno = R().lstatSync(insightsDir(), { bigint: true }).ino as bigint
    // The file took the folder's inode number (the folder removed, its number reused).
    h.inoFor = (p, how) => (how === 'fstat' && fkey(p) === fkey(insightsDir()) ? folderIno : undefined)
    const landed: string[] = []
    h.onChmod = (_p, _m, target) => { landed.push(fkey(target)) }
    groupWritableInsights()
    insightsSwappedAfterItsLstat(file)
    await runner.runCodexInsights(win, { accountId: ACCT }).catch(() => null)
    expect(landed).not.toContain(fkey(file))
    expect(R().readFileSync(file, 'utf8')).toBe('kept')
    expect(h.prepareCalls).toEqual([])
  })

  it("on POSIX an `insights` whose open handle is not this user's folder is never changed; refused before any launch [host]", async () => {
    R().mkdirSync(runsParent(), { recursive: true })
    const landed: number[] = []
    h.onChmod = (p, m) => { if (fkey(p) === fkey(insightsDir())) landed.push(m) }
    groupWritableInsights()
    h.fstatUidFor = (p) => (fkey(p) === fkey(insightsDir()) ? 7 : undefined)
    await expect(runner.runCodexInsights(win, { accountId: ACCT })).rejects.toThrow(INSIGHTS_REFUSED)
    expect(landed).toEqual([])
    expect(h.prepareCalls).toEqual([])
  })

  // [host] P4.7 fix pass 4: each check matches the runs folder's real path
  // too, so one that turns into a link after its lstat is still caught.
  it('the runs folder swapped for a link just after its lstat in the check before the sweep: nothing in the link target is swept; no model run [host]', async () => {
    const elsewhere = join(h.tmpRoot, 'elsewhere-rp')
    const victim = staleVictim(elsewhere)
    R().mkdirSync(runsParent(), { recursive: true })
    let seen = 0
    h.onLstat = (p) => { if (fkey(p) === fkey(runsParent()) && ++seen === 2) { h.links.set(nodePath.resolve(runsParent()), elsewhere); h.onLstat = null } }
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(seen).toBe(2)
    expect(runOf(id)).toMatchObject({ status: 'failed', error: NO_FOLDER })
    expect(h.execCalls).toHaveLength(0)
    expect(R().existsSync(join(victim, 'keep.txt'))).toBe(true)
  })
})

describe('the runs folder is checked again before anything in it is removed [host]', () => {
  it('a stale leftover in the real runs folder is swept, and the run completes [host]', async () => {
    const leftover = staleVictim(runsParent(), 'ccc-insights-codex-old1')
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id).status).toBe('complete')
    expect(R().existsSync(leftover)).toBe(false)
  })

  it('swapped for a link while the sessions are read: nothing in the link target is swept; no model run [host]', async () => {
    const elsewhere = join(h.tmpRoot, 'elsewhere')
    const victim = staleVictim(elsewhere)
    R().mkdirSync(runsParent(), { recursive: true })
    h.onReaddir = (p) => { if (p === nodePath.resolve(h.sessionsDir)) { h.links.set(nodePath.resolve(runsParent()), elsewhere); h.onReaddir = null } }
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: NO_FOLDER })
    expect(h.execCalls).toHaveLength(0)
    expect(R().existsSync(join(victim, 'keep.txt'))).toBe(true)
    expect(h.released).toBe(1)
  })

  it('swapped for a link once the stale sweep has listed it: a leftover of the same name in the link target is not removed; no model run [host]', async () => {
    const leftover = staleVictim(runsParent(), 'ccc-insights-codex-old2')
    const elsewhere = join(h.tmpRoot, 'elsewhere3')
    const victim = staleVictim(elsewhere, 'ccc-insights-codex-old2')
    h.onReaddir = (p) => { if (fkey(p) === fkey(runsParent())) { h.onReaddir = null; h.links.set(nodePath.resolve(runsParent()), elsewhere) } }
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(R().readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('kept')
    expect(R().existsSync(join(leftover, 'keep.txt'))).toBe(true)
    expect(runOf(id)).toMatchObject({ status: 'failed', error: NO_FOLDER })
    expect(h.execCalls).toHaveLength(0)
  })

  it('swapped for a link while the model runs: the removal after it removes nothing in the link target [host]', async () => {
    const elsewhere = join(h.tmpRoot, 'elsewhere2')
    R().mkdirSync(elsewhere, { recursive: true })
    let planted = ''
    h.onRun = (cwd) => {
      planted = join(elsewhere, basename(cwd))
      R().mkdirSync(planted)
      R().writeFileSync(join(planted, 'keep.txt'), 'kept')
      h.links.set(nodePath.resolve(runsParent()), elsewhere)
    }
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id).status).toBe('complete')
    expect(planted).not.toBe('')
    expect(R().existsSync(join(planted, 'keep.txt'))).toBe(true)
  })
})

// [host] Insights keeps its reports, its catalogue and its runs' own
// folders only in its own folder: `insights` a real folder whose real path
// is `<resources>/insights` (and on POSIX this user's, writable by no one
// else), checked before anything is made or written in it; each run's own
// folder made new (an entry already at its name refuses the run) and checked
// again before each file is written into it.
describe('Insights keeps its reports only in its own folder [host]', () => {
  const ACCT_B = `acct-${'b'.repeat(16)}`
  const activeCodex = (id: string) => ({ id, providerId: 'codex', lifecycle: 'active' })

  it("a Claude Code run with `insights` a link: refused with the reason before any terminal starts; nothing is made through it [host]", async () => {
    const outside = join(h.tmpRoot, 'outside-claude')
    R().mkdirSync(outside, { recursive: true })
    h.links.set(nodePath.resolve(insightsDir()), outside)
    await expect(runner.runInsights(win)).rejects.toThrow(INSIGHTS_REFUSED)
    expect(h.ptySpawns).toBe(0)
    expect(R().readdirSync(outside)).toEqual([])
    expect(runner.isRunning()).toBe(false)
  })

  it('a cross-account roll-up with `insights` a link: refused with the reason before any member runs; nothing is made through it [host]', async () => {
    h.snapAccounts = [activeCodex(ACCT), activeCodex(ACCT_B)]
    const outside = join(h.tmpRoot, 'outside-rollup')
    R().mkdirSync(outside, { recursive: true })
    h.links.set(nodePath.resolve(insightsDir()), outside)
    await expect(runner.runCrossAccountInsights(win)).rejects.toThrow(INSIGHTS_REFUSED)
    expect(h.prepareCalls).toEqual([])
    expect(h.execCalls).toHaveLength(0)
    expect(h.ptySpawns).toBe(0)
    expect(R().readdirSync(outside)).toEqual([])
    expect(runner.isCrossAccountRunning()).toBe(false)
  })

  it("a link already at a run's own folder name: the run fails with the reason before any launch; nothing is written through it [host]", async () => {
    const target = join(h.tmpRoot, 'planted-run-target')
    R().mkdirSync(target, { recursive: true })
    R().mkdirSync(insightsDir(), { recursive: true })
    h.beforeMkdir = (p) => {
      if (nodePath.resolve(dirname(p)) === nodePath.resolve(insightsDir()) && /^\d{4}-\d{2}-\d{2}-/.test(basename(p))) {
        h.beforeMkdir = null
        h.links.set(p, target)
      }
    }
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: RUN_FOLDER_REFUSED })
    expect(h.prepareCalls).toEqual([])
    expect(h.execCalls).toHaveLength(0)
    expect(R().readdirSync(target)).toEqual([])
  })

  it('`insights` swapped for a link just after its lstat in the check: its real path is matched too, so nothing is made in the link target [host]', async () => {
    const elsewhere = join(h.tmpRoot, 'elsewhere-ins-rp')
    R().mkdirSync(elsewhere, { recursive: true })
    R().mkdirSync(insightsDir(), { recursive: true })
    let seen = 0
    h.onLstat = (p) => { if (fkey(p) === fkey(insightsDir()) && ++seen === 2) { h.onLstat = null; h.links.set(nodePath.resolve(insightsDir()), elsewhere) } }
    await expect(runner.runCodexInsights(win, { accountId: ACCT })).rejects.toThrow(INSIGHTS_REFUSED)
    expect(seen).toBe(2)
    expect(R().readdirSync(elsewhere)).toEqual([])
    expect(h.prepareCalls).toEqual([])
  })

  it("`insights` swapped for a link while the model runs: the report and its figures are never written through it [host]", async () => {
    const elsewhere = join(h.tmpRoot, 'elsewhere-ins-run')
    R().mkdirSync(elsewhere, { recursive: true })
    let planted = ''
    h.onRun = () => {
      const [id] = runFolders(insightsDir())
      planted = join(elsewhere, id)
      R().mkdirSync(planted, { recursive: true })
      h.links.set(nodePath.resolve(insightsDir()), elsewhere)
    }
    await expect(runner.runCodexInsights(win, { accountId: ACCT })).rejects.toThrow(INSIGHTS_REFUSED)
    expect(h.execCalls).toHaveLength(1)
    expect(planted).not.toBe('')
    expect(R().readdirSync(planted)).toEqual([])
    expect(runner.isRunning()).toBe(false)
    expect(h.released).toBe(1)
  })

  it("a run's own folder swapped for a link while the model runs (insights still its own): the report and its figures are never written through it [host]", async () => {
    const target = join(h.tmpRoot, 'elsewhere-run-folder')
    R().mkdirSync(target, { recursive: true })
    let swapped = ''
    h.onRun = () => {
      const [id] = runFolders(insightsDir())
      swapped = nodePath.resolve(join(insightsDir(), id))
      h.links.set(swapped, target)
    }
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(swapped).not.toBe('')
    expect(runOf(id)).toMatchObject({ status: 'failed', error: RUN_FOLDER_REFUSED })
    expect(R().readdirSync(target)).toEqual([])
    expect(h.released).toBe(1)
    expect(runner.isRunning()).toBe(false)
  })

  it('at start-up a catalogue in an `insights` that is a link is left as it is, and start-up does not fail [host]', () => {
    const outside = join(h.tmpRoot, 'outside-cleanup')
    R().mkdirSync(outside, { recursive: true })
    const stuck = JSON.stringify({ runs: [{ id: '2026-10-01-120000-000001', timestamp: 1, status: 'running' }] })
    R().writeFileSync(join(outside, 'catalogue.json'), stuck)
    h.links.set(nodePath.resolve(insightsDir()), outside)
    expect(() => runner.cleanupStuckRuns()).not.toThrow()
    expect(R().readFileSync(join(outside, 'catalogue.json'), 'utf8')).toBe(stuck)
    expect(R().readdirSync(outside)).toEqual(['catalogue.json'])
  })

  it('control: a run with `insights` as it should be completes, its own folder owner-only where modes apply [host]', async () => {
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id).status).toBe('complete')
    expect(R().existsSync(join(insightsDir(), id, 'report.json'))).toBe(true)
    if (process.platform !== 'win32') expect(R().statSync(join(insightsDir(), id)).mode & 0o777).toBe(0o700)
  })
})

// [host] Claude Code's own report of a run (its report.html and the facets
// beside it, in the account's usage data) is copied into the run's own
// folder only as the regular files they are, each within its size limit, and
// written by the run's one writer, which checks the run's folder (and the
// facets folder made new in it) again before each file.
describe("Claude Code's report is copied into a run's own folder only by the run's one writer [host]", () => {
  const PROFILE = 'abcdef0123456789abcdef01'
  const REPORT = '<html><body>the account report</body></html>'
  const usageDir = () => join(h.claudeHome, '.claude', 'usage-data')
  const KPIS = JSON.stringify({ period: { start: '2026-09-01', end: '2026-09-30', days: 30 }, kpis: { Volume: { sessions: { value: 3, label: 'Sessions', format: 'number', goodDirection: 'up' } } } })
  /** A Claude Code account whose terminal writes nothing: its report and two facets are already there. */
  function claudeAccount(): void {
    h.claudeHome = join(h.tmpRoot, 'claude-home')
    R().mkdirSync(join(usageDir(), 'facets'), { recursive: true })
    R().writeFileSync(join(usageDir(), 'report.html'), REPORT)
    R().writeFileSync(join(usageDir(), 'facets', 's1.json'), '{"s":1}')
    R().writeFileSync(join(usageDir(), 'facets', 's2.json'), '{"s":2}')
    h.claudeProfile = PROFILE
    h.ptyRun = () => {}
  }
  /** The one run folder a case made. */
  const runDir = () => { const [id] = runFolders(insightsDir()); return join(insightsDir(), id) }
  const COPY_FAILED = 'Failed to copy report files'

  it("control: the report and its facets are copied into the run's own folder, owner-only where modes apply, and the run completes [host]", async () => {
    claudeAccount()
    h.claudeKpis = KPIS
    const id = await runner.runInsights(win) as string
    expect(runOf(id).status).toBe('complete')
    expect(h.ptySpawns).toBe(1)
    expect(R().readFileSync(join(insightsDir(), id, 'report.html'), 'utf8')).toBe(REPORT)
    expect(R().readdirSync(join(insightsDir(), id, 'facets')).sort()).toEqual(['s1.json', 's2.json'])
    expect(R().readFileSync(join(insightsDir(), id, 'facets', 's2.json'), 'utf8')).toBe('{"s":2}')
    if (process.platform !== 'win32') {
      expect(R().statSync(join(insightsDir(), id, 'report.html')).mode & 0o777).toBe(0o600)
      expect(R().statSync(join(insightsDir(), id, 'facets')).mode & 0o777).toBe(0o700)
    }
    expect(runner.isRunning(PROFILE)).toBe(false)
  })

  it("a link at `report.html` in the run's own folder, put there while the terminal runs: the report is written into the run's own folder, never through it [host]", async () => {
    claudeAccount()
    const outsideFile = join(h.tmpRoot, 'outside-report.html')
    R().writeFileSync(outsideFile, 'kept')
    h.ptyRun = () => { h.links.set(nodePath.resolve(join(runDir(), 'report.html')), outsideFile) }
    const id = await runner.runInsights(win) as string
    expect(R().readFileSync(outsideFile, 'utf8')).toBe('kept')
    expect(R().readFileSync(join(insightsDir(), id, 'report.html'), 'utf8')).toBe(REPORT)
    expect(runner.isRunning(PROFILE)).toBe(false)
  })

  it("a link at `facets` in the run's own folder, put there while the terminal runs: nothing is written through it, and the run fails [host]", async () => {
    claudeAccount()
    const outside = join(h.tmpRoot, 'outside-facets')
    R().mkdirSync(outside, { recursive: true })
    h.ptyRun = () => { h.links.set(nodePath.resolve(join(runDir(), 'facets')), outside) }
    const id = await runner.runInsights(win) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: COPY_FAILED })
    expect(R().readdirSync(outside)).toEqual([])
    expect(runner.isRunning(PROFILE)).toBe(false)
  })

  it("the run's own folder swapped for a link once the terminal is done: Claude Code's report is never written through it, and the run fails [host]", async () => {
    claudeAccount()
    const outside = join(h.tmpRoot, 'outside-run')
    R().mkdirSync(outside, { recursive: true })
    h.ptyRun = () => { h.links.set(nodePath.resolve(runDir()), outside) }
    const id = await runner.runInsights(win) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: COPY_FAILED })
    expect(R().readdirSync(outside)).toEqual([])
    expect(runner.isRunning(PROFILE)).toBe(false)
  })

  it("`facets` in the run's own folder swapped for a link just after its lstat in the check before a facet is written: its real path is matched too, so nothing is written in the link target [host]", async () => {
    claudeAccount()
    const outside = join(h.tmpRoot, 'outside-facets-rp')
    R().mkdirSync(outside, { recursive: true })
    // The first lstat is the check as the folder is made; the second, the
    // check before the first facet is written.
    h.ptyRun = () => {
      const facets = nodePath.resolve(join(runDir(), 'facets'))
      let seen = 0
      h.onLstat = (p) => { if (fkey(p) === fkey(facets) && ++seen === 2) { h.onLstat = null; h.links.set(facets, outside) } }
    }
    const id = await runner.runInsights(win) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: COPY_FAILED })
    expect(R().readdirSync(outside)).toEqual([])
  })

  it("`facets` in the run's own folder swapped for a link between two facets: no later facet is written through it, and the run fails [host]", async () => {
    claudeAccount()
    const outside = join(h.tmpRoot, 'outside-facets-later')
    R().mkdirSync(outside, { recursive: true })
    // The swap comes as the second facet is read, after the first is written
    // (whichever order the folder lists them in).
    h.ptyRun = () => {
      const facets = nodePath.resolve(join(runDir(), 'facets'))
      let seen = 0
      h.onLstat = (p) => {
        if (nodePath.resolve(dirname(p)) === nodePath.resolve(join(usageDir(), 'facets')) && ++seen === 2) { h.onLstat = null; h.links.set(facets, outside) }
      }
    }
    const id = await runner.runInsights(win) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: COPY_FAILED })
    expect(R().readdirSync(outside)).toEqual([])
  })

  it("a report.html in the account's usage data that is not a regular file (a FIFO) is not copied: the run fails, never waits [host]", async () => {
    claudeAccount()
    h.fifo.add(fkey(join(usageDir(), 'report.html')))
    const id = await runner.runInsights(win) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: COPY_FAILED })
    expect(R().existsSync(join(insightsDir(), id, 'report.html'))).toBe(false)
    expect(runner.isRunning(PROFILE)).toBe(false)
  })

  it('a facet that is not a regular file (a FIFO) is left out, never waited on; the others are copied [host]', async () => {
    claudeAccount()
    h.claudeKpis = KPIS
    h.fifo.add(fkey(join(usageDir(), 'facets', 's1.json')))
    const id = await runner.runInsights(win) as string
    expect(runOf(id).status).toBe('complete')
    expect(R().readdirSync(join(insightsDir(), id, 'facets'))).toEqual(['s2.json'])
  })
})

// [host] A run's own folder made through an `insights` that became a link
// as it was made is removed again (it is empty: nothing was written in it);
// its real path is matched as well as its lstat when it is checked.
describe("a run's own folder is made only in the insights folder that was checked [host]", () => {
  it("`insights` swapped for a link as the run's own folder is made: the folder made through it is removed again, and nothing is launched [host]", async () => {
    const elsewhere = join(h.tmpRoot, 'elsewhere-made')
    R().mkdirSync(elsewhere, { recursive: true })
    R().mkdirSync(insightsDir(), { recursive: true })
    h.beforeMkdir = (p) => {
      if (nodePath.resolve(dirname(p)) === nodePath.resolve(insightsDir()) && /^\d{4}-\d{2}-\d{2}-/.test(basename(p))) {
        h.beforeMkdir = null
        h.links.set(nodePath.resolve(insightsDir()), elsewhere)
      }
    }
    await expect(runner.runCodexInsights(win, { accountId: ACCT })).rejects.toThrow(INSIGHTS_REFUSED)
    expect(R().readdirSync(elsewhere)).toEqual([])
    expect(h.prepareCalls).toEqual([])
  })

  it("the run's own folder swapped for a link just after its lstat when it is checked: its real path is matched too, so the run fails before any launch [host]", async () => {
    const target = join(h.tmpRoot, 'elsewhere-run-rp')
    R().mkdirSync(target, { recursive: true })
    R().mkdirSync(insightsDir(), { recursive: true })
    h.onLstat = (p) => {
      if (nodePath.resolve(dirname(p)) === nodePath.resolve(insightsDir()) && /^\d{4}-\d{2}-\d{2}-/.test(basename(p))) {
        h.onLstat = null
        h.links.set(nodePath.resolve(p), target)
      }
    }
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: RUN_FOLDER_REFUSED })
    expect(h.prepareCalls).toEqual([])
    expect(R().readdirSync(target)).toEqual([])
  })
})

// [host] Start-up marks interrupted runs failed in the catalogue; a write of
// it that fails (here a full disk) is logged and never fails start-up.
describe('start-up never fails on the catalogue [host]', () => {
  it('a catalogue write that fails at start-up is logged, and start-up goes on [host]', () => {
    R().mkdirSync(insightsDir(), { recursive: true })
    const stuck = JSON.stringify({ runs: [{ id: '2026-10-01-120000-000002', timestamp: 1, status: 'running' }] })
    R().writeFileSync(join(insightsDir(), 'catalogue.json'), stuck)
    h.failRename = (to) => basename(to) === 'catalogue.json'
    expect(() => runner.cleanupStuckRuns()).not.toThrow()
    expect(R().readFileSync(join(insightsDir(), 'catalogue.json'), 'utf8')).toBe(stuck)
    expect(h.warns.some((w) => w.includes('catalogue'))).toBe(true)
  })
})

// [host] A refused run says why once in the log, though its own failure
// record meets the same refusal.
describe('a refusal is logged once [host]', () => {
  it('a Claude Code run with `insights` a link logs the refusal once [host]', async () => {
    const outside = join(h.tmpRoot, 'outside-once')
    R().mkdirSync(outside, { recursive: true })
    h.links.set(nodePath.resolve(insightsDir()), outside)
    await expect(runner.runInsights(win)).rejects.toThrow(INSIGHTS_REFUSED)
    expect(h.warns.filter((w) => w.includes(INSIGHTS_REFUSED))).toHaveLength(1)
  })
})

describe('each session is read through the file the walk saw [host]', () => {
  it("a rollout swapped for a link to another account's rollout after the walk is not read, and is counted [host]", async () => {
    const other = join(h.tmpRoot, 'other-account-rollout.jsonl')
    R().writeFileSync(other, rollout('C:\\proj\\b', 'ACCOUNT-B-PLAN'))
    const target = nodePath.resolve(join(dayDir(), 'rollout-a.jsonl'))
    h.onLstat = (p) => { if (p === target) { h.links.set(target, other); h.onLstat = null } }
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null })
    expect(read.sessions).toEqual([])
    expect(read.linksSkipped).toBe(1)
  })

  it('a day folder swapped for a link after it was listed: its rollout is not read through the link [host]', async () => {
    const otherDay = join(h.tmpRoot, 'other-account', 'day')
    R().mkdirSync(otherDay, { recursive: true })
    R().writeFileSync(join(otherDay, 'rollout-a.jsonl'), rollout('C:\\proj\\b', 'ACCOUNT-B-DAY'))
    const target = nodePath.resolve(join(dayDir(), 'rollout-a.jsonl'))
    h.onLstat = (p) => { if (p === target) { h.links.set(nodePath.resolve(dayDir()), otherDay); h.onLstat = null } }
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null })
    expect(codex.buildCodexDigest(read.sessions).text).not.toContain('ACCOUNT-B-DAY')
    expect(read.sessions).toEqual([])
  })

  it('a file that is not a regular one when opened (a FIFO) is not read; the read goes on to the next [host]', async () => {
    R().writeFileSync(join(dayDir(), 'rollout-b.jsonl'), rollout('C:\\proj\\b', 'SECOND-SESSION'))
    h.fifo.add(fkey(join(dayDir(), 'rollout-a.jsonl')))
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null, timeLimitMs: 2000 })
    expect(read.sessions).toHaveLength(1)
    expect(codex.buildCodexDigest(read.sessions).text).toContain('SECOND-SESSION')
  })

  // [host] P4.7 fix pass 4: a rollout with a second name (a hard link) may be
  // another account's session under this account's folder: it is not read,
  // whether the walk sees the second name or the open file does.
  it("a rollout with a second name when the walk finds it is not read, and is counted with the links not followed; the account's own sessions are [host]", async () => {
    const other = join(h.tmpRoot, 'realm-B', 'sessions', 'rollout-B.jsonl')
    R().mkdirSync(dirname(other), { recursive: true })
    R().writeFileSync(other, rollout('C:\\proj\\b', 'ACCOUNT-B-PLAN'))
    const second = join(dayDir(), 'rollout-h.jsonl')
    R().writeFileSync(second, 'placeholder')
    h.hard.set(fkey(second), nodePath.resolve(other))
    const st = await (await import('node:fs')).promises.lstat(second, { bigint: true })
    expect(st.isFile() && !st.isSymbolicLink() && st.nlink === 2n).toBe(true)
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null, timeLimitMs: 5000 })
    expect(codex.buildCodexDigest(read.sessions).text).not.toContain('ACCOUNT-B-PLAN')
    expect(codex.buildCodexDigest(read.sessions).text).toContain('ACCOUNT-A-TEXT')
    expect(read.linksSkipped).toBe(1)
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id).status).toBe('complete')
    expect(h.execCalls[0].prompt).toContain('ACCOUNT-A-TEXT')
    expect(h.execCalls[0].prompt).not.toContain('ACCOUNT-B-PLAN')
  })

  it("a rollout with a second name when the walk finds it is not read even when its other name is gone by the open [host]", async () => {
    const other = join(h.tmpRoot, 'realm-B', 'sessions', 'rollout-B.jsonl')
    R().mkdirSync(dirname(other), { recursive: true })
    R().writeFileSync(other, rollout('C:\\proj\\b', 'ACCOUNT-B-PLAN'))
    const second = join(dayDir(), 'rollout-h.jsonl')
    R().writeFileSync(second, 'placeholder')
    h.hard.set(fkey(second), nodePath.resolve(other))
    h.hardGoneOnOpen.add(fkey(second))
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null, timeLimitMs: 5000 })
    expect(codex.buildCodexDigest(read.sessions).text).not.toContain('ACCOUNT-B-PLAN')
    expect(read.linksSkipped).toBe(1)
  })

  it('a rollout that has a second name by the time it is opened is not read, and is counted [host]', async () => {
    h.hardOnOpen.add(fkey(join(dayDir(), 'rollout-a.jsonl')))
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null, timeLimitMs: 5000 })
    expect(read.sessions).toEqual([])
    expect(read.linksSkipped).toBe(1)
  })
})

describe('the sessions read has a time limit [host]', () => {
  const hangOn = (file: string) => { h.hang.add(fkey(file)) }

  it('a session file whose open does not answer: the read stops at the limit and says so [host]', async () => {
    hangOn(join(dayDir(), 'rollout-a.jsonl'))
    const started = Date.now()
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null, timeLimitMs: 150 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(read.timedOut).toBe(true)
    expect(read.sessions).toEqual([])
  })

  it('a run whose sessions read does not end fails at the limit, saying so; the account and the lock are let go; no model run [host]', async () => {
    hangOn(join(dayDir(), 'rollout-a.jsonl'))
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: "This account's Codex sessions could not be read in time, so nothing was sent to Codex. Try New run again." })
    expect(h.execCalls).toHaveLength(0)
    expect(h.released).toBe(1)
    expect(runner.isRunning()).toBe(false)
  }, 5000)

  // [host] P4.7 fix pass 4: what a read stopped at the limit holds is let go.
  it('a file that opens but whose data never comes: the read stops at the limit; its stream is destroyed and the file closed, once each [host]', async () => {
    h.stall.add(fkey(join(dayDir(), 'rollout-a.jsonl')))
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null, timeLimitMs: 300 })
    expect(read.timedOut).toBe(true)
    expect(read.sessions).toEqual([])
    await new Promise((r) => setTimeout(r, 150))
    expect(h.hangStreams).toHaveLength(1)
    expect(h.hangStreams[0].destroyed).toBe(true)
    expect(h.destroys).toBe(1)
    expect(h.closes).toBe(1)
  })

  it('a walk still going at the limit stops: nothing more is looked at once the read has ended [host]', async () => {
    const day2 = join(h.sessionsDir, '2026', '10', '02')
    R().mkdirSync(day2, { recursive: true })
    R().writeFileSync(join(day2, 'rollout-b.jsonl'), rollout('C:\\proj\\b', 'LATE'))
    h.hangReaddir.add(fkey(day2))
    const read = await codex.readCodexSessions(h.sessionsDir, { runsParent: null, timeLimitMs: 150 })
    expect(read.timedOut).toBe(true)
    const after: string[] = []
    h.onLstat = (p) => { after.push(p) }
    h.release!()
    await new Promise((r) => setTimeout(r, 150))
    expect(after).toEqual([])
  })
})

describe("main hands the page a Codex run's report.json only as the regular file it saw [host]", () => {
  const STORED = (mark: string) => JSON.stringify({
    version: 1, title: 'Codex Insights', subtitle: mark,
    sections: [{ kind: 'at-a-glance', title: 'At a glance', body: 'a' }, { kind: 'narrative', title: 'How you use Codex', paragraphs: ['p'] }],
  })
  /** A Codex run in the catalogue, with a report.json; its path. */
  function codexRun(id: string): string {
    const dir = join(insightsDir(), id)
    R().mkdirSync(dir, { recursive: true })
    R().writeFileSync(join(insightsDir(), 'catalogue.json'), JSON.stringify({ runs: [{ id, timestamp: 1, status: 'complete', provider: 'codex', profileId: ACCT }] }))
    R().writeFileSync(join(dir, 'report.json'), STORED('THE-RUN-OWN'))
    return join(dir, 'report.json')
  }

  it('a report.json that is not a regular file (a FIFO) is no report [host]', () => {
    const file = codexRun('r-fifo')
    expect(JSON.parse(runner.getInsightsReport('r-fifo')!).subtitle).toBe('THE-RUN-OWN')
    h.fifo.add(fkey(file))
    expect(runner.getInsightsReport('r-fifo')).toBeNull()
  })

  it('a report.json swapped for a link after its lstat: the file it now names is not served [host]', () => {
    const file = codexRun('r-swap')
    const other = join(h.tmpRoot, 'elsewhere-report.json')
    R().writeFileSync(other, STORED('NOT-THIS-RUN'))
    const target = nodePath.resolve(file)
    h.onLstat = (p) => { if (p === target) { h.links.set(target, other); h.onLstat = null } }
    expect(runner.getInsightsReport('r-swap')).toBeNull()
  })

  // [host] P4.7 fix pass 4: inode numbers past 2^53 (as NTFS gives) are
  // compared whole, never as rounded numbers.
  it('the open file and its lstat are matched on their whole inode numbers [host]', () => {
    const file = codexRun('r-ino')
    const big = 2n ** 60n
    h.inoFor = (p, how) => (fkey(p) === fkey(file) ? (how === 'lstat' ? big : big + 1n) : undefined)
    expect(runner.getInsightsReport('r-ino')).toBeNull()
    h.inoFor = (p) => (fkey(p) === fkey(file) ? big : undefined)
    expect(JSON.parse(runner.getInsightsReport('r-ino')!).subtitle).toBe('THE-RUN-OWN')
  })
})

// [host] A report.html, a kpis.json and the catalogue are read only as the
// regular file each is, within its own size limit: a folder, a FIFO, a link
// put in its place after its lstat, a file whose open is not the one lstat
// saw, or one past the limit is no report (null) or no runs, never an error
// and never a wait.
describe("main reads a report, a run's figures and the catalogue only as the regular file each is, at a bounded size [host]", () => {
  const HTML = '<html><body>THE-RUN-OWN-REPORT</body></html>'
  const KPIS = { kpis: { Volume: { sessions: { value: 7 } } }, mark: 'THE-RUN-OWN-KPIS' }
  /** A Claude Code run in the catalogue, with its report.html and kpis.json; their paths. */
  function claudeRun(id: string): { html: string; kpis: string } {
    const dir = join(insightsDir(), id)
    R().mkdirSync(dir, { recursive: true })
    R().writeFileSync(join(insightsDir(), 'catalogue.json'), JSON.stringify({ runs: [{ id, timestamp: 1, status: 'complete' }] }))
    R().writeFileSync(join(dir, 'report.html'), HTML)
    R().writeFileSync(join(dir, 'kpis.json'), JSON.stringify(KPIS))
    return { html: join(dir, 'report.html'), kpis: join(dir, 'kpis.json') }
  }

  it('a regular report and its figures are read as written [host]', () => {
    claudeRun('r-plain')
    expect(runner.getInsightsReport('r-plain')).toBe(HTML)
    expect(runner.getInsightsKpis('r-plain')).toEqual(KPIS)
  })

  it('a report.html or a kpis.json that is a folder is none, never an error [host]', () => {
    const f = claudeRun('r-dirs')
    for (const p of [f.html, f.kpis]) { R().rmSync(p); R().mkdirSync(p) }
    expect(runner.getInsightsReport('r-dirs')).toBeNull()
    expect(runner.getInsightsKpis('r-dirs')).toBeNull()
  })

  it('a run whose report.html and kpis.json are not there has none, never an error [host]', () => {
    const f = claudeRun('r-gone')
    for (const p of [f.html, f.kpis]) R().rmSync(p)
    expect(runner.getInsightsReport('r-gone')).toBeNull()
    expect(runner.getInsightsKpis('r-gone')).toBeNull()
    expect(runner.getInsightsKpis('r-never-made')).toBeNull()
  })

  it('a report.html or a kpis.json that is not a regular file (a FIFO) is none, never a wait [host]', () => {
    const f = claudeRun('r-fifo2')
    h.fifo.add(fkey(f.html)); h.fifo.add(fkey(f.kpis))
    expect(runner.getInsightsReport('r-fifo2')).toBeNull()
    expect(runner.getInsightsKpis('r-fifo2')).toBeNull()
  })

  it('a report.html or a kpis.json swapped for a link after its lstat: the file it now names is not read [host]', () => {
    const f = claudeRun('r-swap2')
    const otherHtml = join(h.tmpRoot, 'elsewhere-report.html')
    const otherKpis = join(h.tmpRoot, 'elsewhere-kpis.json')
    R().writeFileSync(otherHtml, '<html>NOT-THIS-RUN</html>')
    R().writeFileSync(otherKpis, JSON.stringify({ mark: 'NOT-THIS-RUN' }))
    const swapAt = new Map([[fkey(f.html), otherHtml], [fkey(f.kpis), otherKpis]])
    h.onLstat = (p) => { const to = swapAt.get(fkey(p)); if (to) { swapAt.delete(fkey(p)); h.links.set(nodePath.resolve(p), to) } }
    expect(runner.getInsightsReport('r-swap2')).toBeNull()
    expect(runner.getInsightsKpis('r-swap2')).toBeNull()
  })

  it('a report.html or a kpis.json whose open file is not the one its lstat saw (whole inode numbers) is none [host]', () => {
    const f = claudeRun('r-ino2')
    const big = 2n ** 60n
    h.inoFor = (p, how) => (fkey(p) === fkey(f.html) || fkey(p) === fkey(f.kpis) ? (how === 'lstat' ? big : big + 1n) : undefined)
    expect(runner.getInsightsReport('r-ino2')).toBeNull()
    expect(runner.getInsightsKpis('r-ino2')).toBeNull()
  })

  it('a report.html or a kpis.json past its size limit is none; one at the limit is read [host]', () => {
    const f = claudeRun('r-big')
    R().writeFileSync(f.html, 'x'.repeat(runner.INSIGHTS_REPORT_MAX_BYTES + 1))
    const pad = (n: number) => JSON.stringify({ pad: 'y'.repeat(n - '{"pad":""}'.length) })
    R().writeFileSync(f.kpis, pad(runner.INSIGHTS_KPIS_MAX_BYTES + 1))
    expect(runner.getInsightsReport('r-big')).toBeNull()
    expect(runner.getInsightsKpis('r-big')).toBeNull()
    R().writeFileSync(f.html, 'x'.repeat(runner.INSIGHTS_REPORT_MAX_BYTES))
    R().writeFileSync(f.kpis, pad(runner.INSIGHTS_KPIS_MAX_BYTES))
    expect(runner.getInsightsReport('r-big')).toHaveLength(runner.INSIGHTS_REPORT_MAX_BYTES)
    expect((runner.getInsightsKpis('r-big') as { pad: string }).pad).toHaveLength(runner.INSIGHTS_KPIS_MAX_BYTES - '{"pad":""}'.length)
  })

  it('a catalogue that is not a regular file (a FIFO, a folder) reads as no runs, never a wait [host]', () => {
    claudeRun('r-cat')
    const cat = join(insightsDir(), 'catalogue.json')
    expect(runner.getCatalogue().runs.map((r: any) => r.id)).toEqual(['r-cat'])
    h.fifo.add(fkey(cat))
    expect(runner.getCatalogue()).toEqual({ runs: [] })
    h.fifo.clear()
    R().rmSync(cat); R().mkdirSync(cat)
    expect(runner.getCatalogue()).toEqual({ runs: [] })
  })
})
