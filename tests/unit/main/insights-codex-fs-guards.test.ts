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
//  - the runs folder, and `insights` above it, are real folders (never links)
//    and (POSIX) the runs folder is writable by no one else, checked before
//    any launch, again just before the stale sweep and again just before the
//    run's folder is removed: nothing in a link's target is swept or removed;
//  - `insights` is checked before the runs folder is made in it;
//  - each session is read through the file the walk saw (the same file, a
//    regular one), never one that took its place, and the whole read has a
//    time limit: a read that does not end fails the run and lets go of the
//    account and the lock;
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
  hangStreams: [] as Array<{ destroy(e?: Error): void }>,
  prepareCalls: [] as Array<Record<string, unknown>>,
  execCalls: [] as Array<{ cwd: string; env: Record<string, string>; prompt: string }>,
  released: 0,
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
    return r
  }
  const linkAt = (q: string) => [...h.links.keys()].some((L) => key(L) === key(q))
  const delLink = (q: string) => { for (const L of [...h.links.keys()]) if (key(L) === key(q)) h.links.delete(L) }
  const fakeLinkStats = () => ({
    isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, isFIFO: () => false, isSocket: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, uid: 0, gid: 0, mode: 0o120777, size: 0, mtimeMs: Date.now(), nlink: 1, ino: 1, dev: 1,
  })
  /** The same stats, answering as a FIFO would. */
  const asFifo = (s: any) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, { isFile: () => false, isFIFO: () => true })
  const own = (p: string, st: any) => {
    if (!st) return st
    const u = h.uidFor?.(path.resolve(p))
    const m = h.modeFor?.(path.resolve(p))
    if (u === undefined && m === undefined) return st
    const out = Object.assign(Object.create(Object.getPrototypeOf(st)), st)
    if (u !== undefined) out.uid = typeof st.uid === 'bigint' ? BigInt(u) : u
    if (m !== undefined) out.mode = typeof st.mode === 'bigint' ? BigInt(m) : m
    return out
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
  const hanging = () => { const st = new Readable({ read() {} }); h.hangStreams.push(st); return st }
  const f1 = (fn: string, final = true) => (p: any, ...rest: any[]) => real[fn](isStr(p) ? follow(p, final) : p, ...rest)
  function realpathSync(p: any, o?: any) { return real.realpathSync(isStr(p) ? follow(p, true) : p, o) }
  realpathSync.native = (p: any, o?: any) => real.realpathSync.native(isStr(p) ? follow(p, true) : p, o)
  const NOFOLLOW = real.constants.O_NOFOLLOW ?? 0
  /** A handle that answers as a FIFO would: open, but not a regular file. */
  const fifoHandle = (fh: any) => new Proxy(fh, {
    get(t, k) {
      if (k === 'stat') return async (o?: any) => asFifo(await t.stat(o))
      if (k === 'createReadStream') return () => hanging()
      const v = Reflect.get(t, k, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  const over: Record<string, any> = {
    existsSync: f1('existsSync'), statSync: f1('statSync'), readFileSync: f1('readFileSync'), writeFileSync: f1('writeFileSync'),
    appendFileSync: f1('appendFileSync'), utimesSync: f1('utimesSync'), chmodSync: f1('chmodSync'),
    accessSync: f1('accessSync'),
    // O_NOFOLLOW refuses a link as the last part (POSIX); other links are followed.
    openSync: (p: any, flags?: any, mode?: any) => {
      if (!isStr(p)) return real.openSync(p, flags, mode)
      if (typeof flags === 'number' && NOFOLLOW && (flags & NOFOLLOW) && linkAt(follow(p, false))) {
        throw Object.assign(new Error(`ELOOP: ${p}`), { code: 'ELOOP' })
      }
      const fd = real.openSync(follow(p, true), flags, mode)
      if (h.fifo.has(key(p))) h.fifoFds.add(fd)
      return fd
    },
    fstatSync: (fd: any, o?: any) => (h.fifoFds.has(fd) ? asFifo(real.fstatSync(fd, o)) : real.fstatSync(fd, o)),
    closeSync: (fd: any) => { h.fifoFds.delete(fd); return real.closeSync(fd) },
    createReadStream: (p: any, o?: any) => {
      const q = isStr(p) ? follow(p, true) : p
      if (isStr(p) && (h.fifo.has(key(p)) || h.hang.has(key(p)))) return hanging()
      return real.createReadStream(q, o)
    },
    createWriteStream: f1('createWriteStream'),
    unlinkSync: f1('unlinkSync', false),
    renameSync: (a: any, b: any) => real.renameSync(isStr(a) ? follow(a, false) : a, isStr(b) ? follow(b, false) : b),
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
      return h.fifo.has(key(s)) ? fifoHandle(fh) : fh
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
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no Claude PTY in a Codex run') } }))
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: async () => { throw new Error('no Claude run in a Codex run') } }))
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
    snapshot: () => ({ revision: 1, providers: [], groups: [], pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [], identities: [], accounts: [] }),
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
  h.gate = new Promise<void>((r) => { h.release = r })
})
afterEach(() => {
  h.release?.()
  for (const s of h.hangStreams) s.destroy(new Error('the test is over'))
  if (realGetuid === undefined) delete (process as any).getuid
  else (process as any).getuid = realGetuid
  h.links.clear()
  h.onReaddir = null; h.onLstat = null; h.onRun = null; h.uidFor = null; h.modeFor = null
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

  it("an `insights` folder that is a link: the runs folder is never made through it; refused before any launch [host]", async () => {
    const outside = join(h.tmpRoot, 'outside-insights')
    R().mkdirSync(outside, { recursive: true })
    h.links.set(nodePath.resolve(insightsDir()), outside)
    const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
    expect(runOf(id)).toMatchObject({ status: 'failed', error: NO_FOLDER })
    expect(R().readdirSync(outside)).not.toContain(RUNS)
    expect(h.prepareCalls).toEqual([])
    expect(h.execCalls).toHaveLength(0)
  })

  it('on POSIX a runs folder that others can write to is refused before any launch [host]', async () => {
    const parentKey = () => nodePath.resolve(runsParent())
    for (const mode of [0o040770, 0o040707, 0o040777]) {
      posixAs(() => 4242, (p) => (p === parentKey() ? mode : undefined))
      h.prepareCalls = []
      const id = await runner.runCodexInsights(win, { accountId: ACCT }) as string
      expect(runOf(id), mode.toString(8)).toMatchObject({ status: 'failed', error: NO_FOLDER })
      expect(h.prepareCalls).toEqual([])
    }
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
})
