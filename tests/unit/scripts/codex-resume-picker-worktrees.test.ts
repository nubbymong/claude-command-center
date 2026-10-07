// P3.5 (row 32): the Codex resume picker does what Claude's does
// (scripts/resume-picker.js): it lists the conversations of every git worktree
// of the project, tags the ones from another worktree, names each by its
// session's name where the app has one, and starts the chosen conversation in
// its own worktree. Every string it shows is plain text, built in one place
// (buildPickerRows / displayText). It records the conversation it opens in the
// pick file the app handed it, so the status line and the session follow it.
// Real files in temp folders; nothing is started (git's output is parsed from
// a string, as Claude's parseWorktrees test does).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, rmdirSync, unlinkSync, readFileSync, existsSync, linkSync, readdirSync, statSync, symlinkSync, lstatSync, renameSync } from 'fs'
import { codexFolderIdentity } from '../../../src/main/providers/codex/rollout-lookup'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  parseWorktrees: (text: string) => Array<{ path: string; branch: string | null; isMain: boolean }>
  walkRollouts: (home: string, maxDays: number, where: string | Array<{ path: string; branch: string | null; isMain: boolean }>, platform?: string) => Array<{ id: string; cwd: string; label: string; model: string; effort?: string; mtime: number; sourceCwd: string; worktreeLabel: string | null }>
  loadWorkNames: (configDir: string | undefined) => Map<string, string>
  displayText: (raw: unknown, max?: number) => string
  buildPickerRows: (conversations: Array<Record<string, unknown>>, names: Map<string, string>, width: number, now?: number) => Array<{ num: string; title: string; named: boolean; sub: string | null; meta: string; tag: string | null }>
  writePick: (file: string | undefined, decision: { id: string } | { fresh: true }, ops?: { renameSync?: (from: string, to: string) => void; sleep?: (ms: number) => void; dirId?: string }) => boolean
  recordPick: (file: string | undefined, resumeUuid: string | null, dirId?: string | null, ops?: { renameSync?: (from: string, to: string) => void; sleep?: (ms: number) => void }) => string | null
  folderIdOf: (dir: string) => string | null
  isDirectory: (p: string) => boolean
  pickDecision: (resumeUuid: string | null) => { id: string } | { fresh: true }
  childEnv: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  resolveRetargetCwd: (resumeId: string | null, sourceCwd: string | undefined, currentCwd: string, isDir: (p: string) => boolean, platform?: string) => { cwd: string | null }
  listWorktrees: (cwd: string, platform?: string, deps?: { env?: Record<string, string | undefined>; isFile?: (p: string) => boolean; spawn?: (file: string, args: string[], opts: never) => unknown }) => Array<{ path: string; branch: string | null; isMain: boolean }>
}

const ID1 = '019dd000-0001-7000-8000-000000000101'
const ID2 = '019dd000-0001-7000-8000-000000000102'
const ID3 = '019dd000-0001-7000-8000-000000000103'
const temps: string[] = []
const temp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `ccc-p35-picker-${tag}-`)); temps.push(d); return d }
/** Removes, recursively, only a folder this file made: its own prefix, directly in the temp folder. */
const removeOwn = (d: string) => { if (dirname(d) === tmpdir() && /^ccc-p35-picker-/.test(basename(d))) rmSync(d, { recursive: true, force: true }) }
const originalTz = process.env.TZ
afterEach(() => {
  vi.useRealTimers()
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
  for (const d of temps.splice(0)) removeOwn(d)
})

function rollout(home: string, day: Date, id: string, cwd: string, prompt: string, local = false): void {
  const y = local ? day.getFullYear() : day.getUTCFullYear()
  const m = String((local ? day.getMonth() : day.getUTCMonth()) + 1).padStart(2, '0')
  const d = String(local ? day.getDate() : day.getUTCDate()).padStart(2, '0')
  const dir = join(home, 'sessions', String(y), m, d)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-x-${id}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd, cli_version: '0.155.1' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'low' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
  ].join('\n') + '\n')
}

const PORCELAIN = [
  'worktree F:/repo/demo', 'HEAD 1111111', 'branch refs/heads/main', '',
  'worktree F:/repo/demo/.worktrees/fix-login', 'HEAD 2222222', 'branch refs/heads/fix-login', '',
].join('\n')

describe('the picker lists every worktree\'s conversations (row 32)', () => {
  it('matches each rollout to a worktree however the path is spelt on Windows, tags the non-main ones, and leaves out other folders', () => {
    const home = temp('home')
    const now = new Date()
    rollout(home, now, ID1, 'F:\\repo\\demo', 'main work')
    rollout(home, now, ID2, 'f:\\REPO\\demo\\.worktrees\\fix-login', 'worktree work')
    rollout(home, now, ID3, 'F:\\elsewhere', 'other project')
    const out = lib.walkRollouts(home, 30, lib.parseWorktrees(PORCELAIN), 'win32')
    expect(out.map((c) => c.id).sort()).toEqual([ID1, ID2])
    const wt = out.find((c) => c.id === ID2)!
    expect(wt.worktreeLabel).toBe('fix-login')
    expect(wt.sourceCwd).toBe('F:/repo/demo/.worktrees/fix-login')
    expect(out.find((c) => c.id === ID1)!.worktreeLabel).toBeNull()
  })

  it('after a staged sign in again, the conversations carried into the account\'s new folder are listed there (P3.3)', () => {
    const old = temp('old-realm')
    rollout(old, new Date(Date.now() - 3 * 24 * 3600 * 1000), ID1, '/srv/demo', 'before the sign in again')
    const fresh = temp('new-realm')
    const day = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    const rel = join('sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'))
    mkdirSync(join(fresh, rel), { recursive: true })
    linkSync(join(old, rel, `rollout-x-${ID1}.jsonl`), join(fresh, rel, `rollout-x-${ID1}.jsonl`))
    removeOwn(old)
    expect(lib.walkRollouts(fresh, 30, '/srv/demo', 'linux').map((c) => c.id)).toEqual([ID1])
  })

  it('never lists a conversation reached through a link or junction at the year, month or day level (thesis 4)', () => {
    const outside = temp('outside')
    const now = new Date()
    rollout(outside, now, ID1, '/srv/demo', 'elsewhere')
    const y = String(now.getUTCFullYear())
    const m = String(now.getUTCMonth() + 1).padStart(2, '0')
    const d = String(now.getUTCDate()).padStart(2, '0')
    const yearHome = temp('home')
    mkdirSync(join(yearHome, 'sessions'), { recursive: true })
    symlinkSync(join(outside, 'sessions', y), join(yearHome, 'sessions', y), 'junction')
    expect(lib.walkRollouts(yearHome, 30, '/srv/demo', 'linux')).toEqual([])
    const monthHome = temp('home')
    mkdirSync(join(monthHome, 'sessions', y), { recursive: true })
    symlinkSync(join(outside, 'sessions', y, m), join(monthHome, 'sessions', y, m), 'junction')
    expect(lib.walkRollouts(monthHome, 30, '/srv/demo', 'linux')).toEqual([])
    const dayHome = temp('home')
    mkdirSync(join(dayHome, 'sessions', y, m), { recursive: true })
    symlinkSync(join(outside, 'sessions', y, m, d), join(dayHome, 'sessions', y, m, d), 'junction')
    expect(lib.walkRollouts(dayHome, 30, '/srv/demo', 'linux')).toEqual([])
  })

  it('a single directory still works as before (no git): exact on Linux', () => {
    const home = temp('home')
    rollout(home, new Date(), ID1, '/srv/demo', 'x')
    expect(lib.walkRollouts(home, 30, '/srv/demo', 'linux').map((c) => c.id)).toEqual([ID1])
    expect(lib.walkRollouts(home, 30, '/srv/DEMO', 'linux')).toEqual([])
  })

  it('finds today\'s conversations in the local-date folder too (05:00 in Tokyo is still the day before in UTC)', () => {
    process.env.TZ = 'Asia/Tokyo'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-27T20:00:00.000Z'))
    const home = temp('home')
    rollout(home, new Date(), ID1, '/srv/demo', 'today in Tokyo', true)
    expect(lib.walkRollouts(home, 30, '/srv/demo', 'linux').map((c) => c.id)).toEqual([ID1])
  })
})

describe('names, as Claude\'s picker gives them (row 32)', () => {
  it('reads each session\'s own name by the conversation it resumes, from the app\'s config folder', () => {
    const cfg = temp('cfg')
    writeFileSync(join(cfg, 'session-state.json'), JSON.stringify({ sessions: [
      { id: 's1', provider: 'codex', customName: 'Login fix', resumeUuid: ID2 },
      { id: 's2', provider: 'codex', customName: '   ', resumeUuid: ID1 },
      { id: 's3', provider: 'codex', resumeUuid: ID3 },
    ] }))
    const names = lib.loadWorkNames(cfg)
    expect([...names]).toEqual([[ID2, 'Login fix']])
    expect(lib.loadWorkNames(undefined).size).toBe(0)
    expect(lib.loadWorkNames(join(cfg, 'missing')).size).toBe(0)
  })

  it('leads with the name, the first prompt beneath it, and tags a worktree conversation', () => {
    const rows = lib.buildPickerRows([
      { id: ID2, label: 'fix the login redirect', model: 'gpt-5.5', effort: 'low', mtime: Date.now(), worktreeLabel: 'fix-login' },
      { id: ID1, label: 'main work', model: 'gpt-5.5', mtime: Date.now(), worktreeLabel: null },
    ], new Map([[ID2, 'Login fix']]), 72)
    expect(rows[0]).toMatchObject({ num: ' 1', title: 'Login fix', named: true, sub: 'fix the login redirect', tag: 'fix-login' })
    expect(rows[0].meta).toContain('gpt-5.5')
    expect(rows[1]).toMatchObject({ title: 'main work', named: false, sub: null, tag: null })
  })
})

describe('everything shown is plain text (row 32)', () => {
  const ESC = String.fromCharCode(0x1b)
  const BEL = String.fromCharCode(0x07)
  const CSI8 = String.fromCharCode(0x9b)
  const samples = [
    `${ESC}[2J${ESC}[31mred${ESC}[0m`,
    `${ESC}]0;title${BEL}`,
    `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`,
    `${ESC}]52;c;aGVsbG8=${BEL}`,
    `${CSI8}31mhello`,
    `abc${String.fromCharCode(0x202e)}fed${String.fromCharCode(0x202c)}`,
    `x${String.fromCharCode(0x2066)}y${String.fromCharCode(0x2069)}z${String.fromCharCode(0x200b)}w${String.fromCharCode(0x200d)}v`,
    `tab\there${String.fromCharCode(0x7f)}${String.fromCharCode(0x85)}`,
    `tag${String.fromCodePoint(0xe0041)}end`,
    'y'.repeat(300),
  ]
  // Controls (C0, DEL, C1), bidi overrides, marks and isolates, zero-width and invisible formatters, line separators, the TAG block.
  const unsafe = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u

  it('shows control characters as plain text', () => {
    for (const s of samples) {
      const out = lib.displayText(s)
      expect(unsafe.test(out), JSON.stringify(s)).toBe(false)
    }
    expect(lib.displayText('a\tb')).toBe('a b')
    expect(lib.displayText('x'.repeat(900)).length).toBe(500)
    expect(lib.displayText('x'.repeat(90), 40).length).toBe(40)
    expect(lib.displayText(undefined)).toBe('')
  })

  it('every field of every row, and nothing longer than the row', () => {
    for (const s of samples) {
      const rows = lib.buildPickerRows([
        { id: ID1, label: s, model: s, effort: s, mtime: Date.now(), worktreeLabel: s },
      ], new Map([[ID1, s]]), 60)
      for (const r of rows) {
        for (const v of [r.title, r.sub, r.meta, r.tag]) {
          if (v === null) continue
          expect(unsafe.test(v), JSON.stringify(s)).toBe(false)
          expect([...v].length).toBeLessThanOrEqual(60)
        }
      }
    }
  })

  it('the picker prints only the rows the display builder made (no rollout field reaches the terminal another way)', () => {
    const script = readFileSync(join(__dirname, '../../../scripts/codex-resume-picker.js'), 'utf8')
    expect(script).toContain('buildPickerRows(')
    expect(script).not.toMatch(/\.(label|model|effort|worktreeLabel)\b/)
    expect(script).not.toMatch(/\]\.cwd\b|conv\.cwd\b/)
    expect(script).not.toMatch(/\bprintable\(/)
  })

  it('the picker records every decision, starts a pick in its own worktree, and hands Codex the environment without the pick file (source wiring)', () => {
    const script = readFileSync(join(__dirname, '../../../scripts/codex-resume-picker.js'), 'utf8')
    // Every launch (a pick, New conversation, nothing to list, a failed main)
    // goes through launchCodex, which records its decision first; the
    // fallback after a failed resume records a new conversation.
    const launch = script.slice(script.indexOf('function launchCodex('))
    expect(launch.indexOf('noteUnrecorded(lib.recordPick(process.env.CCC_CODEX_PICK_FILE, resumeUuid, process.env.CCC_CODEX_PICK_DIR_ID))')).toBeGreaterThan(-1)
    expect(launch.indexOf('noteUnrecorded(lib.recordPick(process.env.CCC_CODEX_PICK_FILE, resumeUuid, process.env.CCC_CODEX_PICK_DIR_ID))')).toBeLessThan(launch.indexOf('run(lib.buildResumeArgs('))
    const fallback = launch.slice(launch.indexOf('if (lib.shouldFallback('))
    expect(fallback.indexOf('noteUnrecorded(lib.recordPick(process.env.CCC_CODEX_PICK_FILE, null, process.env.CCC_CODEX_PICK_DIR_ID))')).toBeGreaterThan(-1)
    expect(fallback.indexOf('noteUnrecorded(lib.recordPick(process.env.CCC_CODEX_PICK_FILE, null, process.env.CCC_CODEX_PICK_DIR_ID))')).toBeLessThan(fallback.indexOf('run(forwarded)'))
    // A decision not recorded is said, and the launch goes on either way.
    const note = script.slice(script.indexOf('function noteUnrecorded('), script.indexOf('function launchCodex('))
    expect(note).toContain('if (notice) console.error(notice)')
    expect(note).not.toMatch(/process\.exit|throw /)
    expect(script).not.toMatch(/lib\.writePick\(/)
    expect(script.match(/spawnSync\(/g)).toHaveLength(1)
    expect(script).toContain('launchCodex(id, conv.sourceCwd)')
    expect(script).toContain('lib.resolveRetargetCwd(resumeUuid, sourceCwd, process.cwd(), lib.isDirectory)')
    expect(script).toMatch(/spawnSync\(target\.file, target\.args, \{[^}]*\benv,[^}]*retarget\.cwd/)
    expect(script).toContain('const env = lib.childEnv(process.env)')
    expect(script).toContain('lib.walkRollouts(home, 30, worktrees)')
  })
})

describe('the conversation the picker opens (rows 32, 38)', () => {
  it('each decision is recorded whole in the pick file: a conversation id or a new conversation, to an absolute path only', () => {
    const dir = temp('pick')
    const file = join(dir, 'pick.json')
    expect(lib.pickDecision(ID1)).toEqual({ id: ID1 })
    expect(lib.pickDecision(null)).toEqual({ fresh: true })
    expect(lib.writePick(file, lib.pickDecision(ID1))).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: ID1 })
    // A later decision (the fallback after a failed resume) replaces it.
    expect(lib.writePick(file, lib.pickDecision(null))).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fresh: true })
    const other = join(dir, 'other.json')
    for (const bad of [{ id: '--config=x' }, { fresh: 'yes' }, { id: ID2, extra: 1, fresh: false }, null, undefined]) {
      expect(lib.writePick(other, bad as never), JSON.stringify(bad)).toBe(false)
    }
    expect(existsSync(other)).toBe(false)
    expect(lib.writePick('relative.json', lib.pickDecision(ID1))).toBe(false)
    expect(lib.writePick(undefined, lib.pickDecision(ID1))).toBe(false)
    // Nothing is left beside it.
    expect(readdirSync(dir).sort()).toEqual(['pick.json'])
  })

  it('the pick file is readable by its owner only, where the platform keeps modes', (ctx) => {
    if (process.platform === 'win32') { ctx.skip(); return }
    const file = join(temp('pick-mode'), 'pick.json')
    expect(lib.writePick(file, lib.pickDecision(ID1))).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('a link at the pick path is replaced, never written through', (ctx) => {
    const dir = temp('pick-link')
    const target = join(dir, 'elsewhere.json')
    writeFileSync(target, 'original')
    const file = join(dir, 'pick.json')
    try { symlinkSync(target, file, 'file') } catch { ctx.skip(); return }
    expect(lib.writePick(file, lib.pickDecision(ID1))).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(lstatSync(file).isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: ID1 })
  })

  it('nothing is ever written into a folder a link at the pick path points at; a real folder there is left as it is', () => {
    const dir = temp('pick-junction')
    const inside = join(dir, 'real')
    mkdirSync(inside)
    const file = join(dir, 'pick.json')
    symlinkSync(inside, file, 'junction')
    // Windows refuses to replace a folder link with a file; elsewhere the
    // link itself is replaced. Either way the folder it pointed at stays empty.
    const wrote = lib.writePick(file, lib.pickDecision(ID1))
    expect(readdirSync(inside)).toEqual([])
    if (wrote) expect(lstatSync(file).isFile()).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['pick.json', 'real'])
    const folder = join(dir, 'pick-folder')
    mkdirSync(folder)
    expect(lib.writePick(folder, lib.pickDecision(ID1))).toBe(false)
    expect(readdirSync(folder)).toEqual([])
    expect(readdirSync(dir).sort()).toEqual(['pick-folder', 'pick.json', 'real'])
  })

  it('Codex itself never gets the pick file\'s name, in any spelling', () => {
    const env = lib.childEnv({ PATH: '/bin', CCC_CODEX_PICK_FILE: '/t/p.json', ccc_codex_pick_file: '/t/q.json', CCC_CODEX_PICK_DIR_ID: '1:2', Ccc_Codex_Pick_Dir_Id: '3:4', CODEX_HOME: '/r' })
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/r' })
  })

  it('starts in the chosen conversation\'s own worktree when it is another one that exists', () => {
    const wt = temp('wt')
    expect(lib.resolveRetargetCwd(ID1, wt, temp('main'), existsSync)).toEqual({ cwd: wt })
    expect(lib.resolveRetargetCwd(ID1, join(wt, 'gone'), '/main', existsSync)).toEqual({ cwd: null })
    expect(lib.resolveRetargetCwd(null, wt, '/main', existsSync)).toEqual({ cwd: null })
    expect(lib.resolveRetargetCwd(ID1, 'F:/Repo/Demo', 'f:\\repo\\demo', () => true, 'win32')).toEqual({ cwd: null })
  })
})

// P3.5 fix round 2 (quality nit 4): Windows can refuse the rename for a moment
// while another program (a virus scanner, the app reading the last decision)
// has one of the files open. The rename is tried again a few times, a short
// wait apart, then given up: the picker never holds the session's launch up
// for longer than that, and it says what then happens.
describe('a pick the platform refuses for a moment (fix round 2)', () => {
  const refusing = (codes: string[]) => {
    const seen = { renames: 0, waits: [] as number[] }
    const ops = {
      renameSync: (from: string, to: string) => {
        const code = codes[seen.renames++]
        if (code === undefined) { renameSync(from, to); return }
        throw Object.assign(new Error(code), { code })
      },
      sleep: (ms: number) => { seen.waits.push(ms) },
    }
    return { seen, ops }
  }

  it('is tried again, a short wait apart, and then written', () => {
    const dir = temp('pick-retry')
    const file = join(dir, 'pick.json')
    const { seen, ops } = refusing(['EBUSY', 'EPERM', 'EACCES'])
    expect(lib.writePick(file, lib.pickDecision(ID1), ops)).toBe(true)
    expect(seen.renames).toBe(4)
    expect(seen.waits).toHaveLength(3)
    for (const w of seen.waits) expect(w).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: ID1 })
    expect(readdirSync(dir)).toEqual(['pick.json'])
  })

  it('is given up after a few tries, a fraction of a second in all, and nothing is left beside it', () => {
    const dir = temp('pick-refused')
    const file = join(dir, 'pick.json')
    const { seen, ops } = refusing(Array(50).fill('EBUSY'))
    expect(lib.writePick(file, lib.pickDecision(ID1), ops)).toBe(false)
    expect(seen.renames).toBeGreaterThanOrEqual(3)
    expect(seen.renames).toBeLessThanOrEqual(6)
    expect(seen.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500)
    expect(readdirSync(dir)).toEqual([])
  })

  it('an error a wait does not cure is not tried again', () => {
    const dir = temp('pick-exdev')
    const { seen, ops } = refusing(['EXDEV', 'EXDEV'])
    expect(lib.writePick(join(dir, 'pick.json'), lib.pickDecision(null), ops)).toBe(false)
    expect(seen.renames).toBe(1)
    expect(seen.waits).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('really waits between the tries, and not for long', () => {
    const dir = temp('pick-wait')
    let renames = 0
    const ops = { renameSync: () => { renames++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) } }
    const t0 = Date.now()
    expect(lib.writePick(join(dir, 'pick.json'), lib.pickDecision(ID1), ops)).toBe(false)
    const took = Date.now() - t0
    expect(renames).toBeGreaterThan(1)
    expect(took).toBeGreaterThanOrEqual(50)
    expect(took).toBeLessThan(2_000)
  })

  it('a decision not recorded is said in the terminal; none is said when it was, or when the app asked for none', () => {
    const dir = temp('pick-notice')
    const file = join(dir, 'pick.json')
    expect(lib.recordPick(file, ID1, lib.folderIdOf(dir))).toBeNull()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: ID1 })
    expect(lib.recordPick(undefined, ID1)).toBeNull()
    expect(lib.recordPick('', null)).toBeNull()
    const { ops } = refusing(Array(50).fill('EPERM'))
    const notice = lib.recordPick(file, null, lib.folderIdOf(dir), ops)
    expect(typeof notice).toBe('string')
    expect(notice).toMatch(/status line/)
    expect(notice).toMatch(/conversation itself is not affected/)
    // The earlier decision stays; nothing else is left beside it.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: ID1 })
    expect(readdirSync(dir)).toEqual(['pick.json'])
  })
})

// P3.5 fix round 3 (lens A): the picker writes its pick only into the folder
// the app made for the launch: a real folder (not a link or junction) whose
// device and file id are the ones the app recorded (CCC_CODEX_PICK_DIR_ID),
// looked at before the new file is written and again before its rename.
describe('the pick is written only into the folder the app made (fix round 3)', () => {
  /** Removes a link (a junction on Windows), if still there, and never what it points at. */
  const dropLink = (p: string) => {
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (!st) return
    if (!st.isSymbolicLink()) throw new Error('not a link: ' + p)
    try { unlinkSync(p) } catch { rmdirSync(p) }
  }

  it('its id as the app recorded it: written; any other id, or none, and nothing is written', () => {
    const dir = temp('pick-own')
    const file = join(dir, 'pick.json')
    const id = lib.folderIdOf(dir)
    expect(id).toBe(codexFolderIdentity(dir)?.id)
    expect(lib.writePick(file, lib.pickDecision(ID1), { dirId: id! })).toBe(true)
    expect(lib.writePick(file, lib.pickDecision(ID2), { dirId: '1:2' })).toBe(false)
    expect(lib.writePick(file, lib.pickDecision(ID2), { dirId: '' })).toBe(false)
    expect(lib.recordPick(file, ID2, undefined)).toMatch(/status line/)
    expect(lib.recordPick(file, ID2, null)).toMatch(/status line/)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ id: ID1 })
    expect(readdirSync(dir)).toEqual(['pick.json'])
  })

  it('a pick folder swapped for a link to another folder is never written through', (ctx) => {
    const victim = temp('pick-victim')
    writeFileSync(join(victim, 'pick.json'), 'theirs')
    const own = join(temp('pick-holder'), 'ccc-codex-pick-x')
    mkdirSync(own)
    const id = lib.folderIdOf(own)!
    rmdirSync(own)
    // A junction on Windows; a folder link elsewhere.
    try { symlinkSync(victim, own, 'junction') } catch { ctx.skip(); return }
    try {
      expect(lib.folderIdOf(own)).toBeNull()
      expect(lib.recordPick(join(own, 'pick.json'), ID1, id)).toMatch(/status line/)
      // Not even its new file is written there.
      const writes: string[] = []
      expect(lib.writePick(join(own, 'pick.json'), lib.pickDecision(ID1), { dirId: id, writeFileSync: (p: string, d: string, o: object) => { writes.push(p); writeFileSync(p, d, o) } } as never)).toBe(false)
      expect(writes).toEqual([])
      expect(readFileSync(join(victim, 'pick.json'), 'utf8')).toBe('theirs')
      expect(readdirSync(victim)).toEqual(['pick.json'])
    } finally {
      dropLink(own)
    }
  })

  it('another folder put in its place is not written into', () => {
    const own = join(temp('pick-holder'), 'ccc-codex-pick-y')
    mkdirSync(own)
    const id = lib.folderIdOf(own)!
    // The folder made is moved aside (its file id stays taken) and another put in its place.
    renameSync(own, own + '-aside')
    mkdirSync(own)
    expect(lib.folderIdOf(own)).not.toBe(id)
    expect(lib.recordPick(join(own, 'pick.json'), ID1, id)).toMatch(/status line/)
    expect(readdirSync(own)).toEqual([])
  })

  it('the folder made, swapped between the write and the rename: nothing is renamed, and nothing is left in the folder now there', () => {
    const dir = temp('pick-late-swap')
    const file = join(dir, 'pick.json')
    const id = lib.folderIdOf(dir)!
    let renames = 0
    const ops = { dirId: id, renameSync: () => { renames++ }, writeFileSync: (f: string, data: string, o: object) => { writeFileSync(f, data, o); renameSync(dir, dir + '-aside'); mkdirSync(dir) } }
    expect(lib.writePick(file, lib.pickDecision(ID1), ops as never)).toBe(false)
    expect(renames).toBe(0)
    expect(readdirSync(dir)).toEqual([])
    removeOwn(dir + '-aside')
  })
})

// P3.5 fix round 2 (lens B minor): the chosen conversation's worktree is used
// only when it is a directory, as main's resume check requires.
describe('the worktree a pick starts in is a directory (fix round 2)', () => {
  it('a file, or nothing, at the worktree path starts it here instead', () => {
    const wt = temp('wt-dir')
    const file = join(temp('wt-file'), 'not-a-folder')
    writeFileSync(file, 'x')
    expect(lib.isDirectory(wt)).toBe(true)
    expect(lib.isDirectory(file)).toBe(false)
    expect(lib.isDirectory(join(wt, 'gone'))).toBe(false)
    expect(lib.resolveRetargetCwd(ID1, wt, temp('here'), lib.isDirectory)).toEqual({ cwd: wt })
    expect(lib.resolveRetargetCwd(ID1, file, temp('here2'), lib.isDirectory)).toEqual({ cwd: null })
    expect(lib.resolveRetargetCwd(ID1, join(wt, 'gone'), temp('here3'), lib.isDirectory)).toEqual({ cwd: null })
  })
})

// P3.5 fix round 1 (thesis 19): the worktree list fails safe and never runs a
// `git` found in the project folder: git is named by an absolute path from
// PATH's absolute entries (as the reviewer's findGit), with a hardened
// command line, and on Windows with NoDefaultCurrentDirectoryInExePath=1.
// The spawn and the file check are injected: nothing is started.
describe('listWorktrees (thesis 19)', () => {
  type Call = { file: string; args: string[]; opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; windowsHide?: boolean; shell?: unknown } }
  const ESC = String.fromCharCode(27)
  const run = (answer: unknown, env: Record<string, string | undefined>, platform = 'win32', gitAt: string | ((p: string) => boolean) = 'C:\\Git\\cmd\\git.exe', cwd = 'F:\\repo\\demo') => {
    const calls: Call[] = []
    const out = lib.listWorktrees(cwd, platform, {
      env,
      isFile: (p: string) => (typeof gitAt === 'function' ? gitAt(p) : p === gitAt),
      spawn: (file: string, args: string[], opts: Call['opts']) => { calls.push({ file, args, opts }); if (answer instanceof Error) throw answer; return answer },
    })
    return { out, calls }
  }
  const OWN = [{ path: 'F:\\repo\\demo', branch: null, isMain: true }]

  it('runs git by an absolute path from PATH\'s absolute entries, never one resolved from the project folder, with its command line hardened', () => {
    const { out, calls } = run(
      { status: 0, stdout: 'worktree F:/repo/demo\nbranch refs/heads/main\n\nworktree F:/repo/wt\nbranch refs/heads/wt\n' },
      { Path: '.;relative\\bin;%SystemRoot%;"C:\\Git\\cmd"', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('C:\\Git\\cmd\\git.exe')
    expect(calls[0].args).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain'])
    expect(calls[0].opts).toMatchObject({ cwd: 'F:\\repo\\demo', timeout: 5000, windowsHide: true })
    expect(calls[0].opts.shell).toBeFalsy()
    const spellings = Object.keys(calls[0].opts.env ?? {}).filter((k) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')
    expect(spellings).toEqual(['NoDefaultCurrentDirectoryInExePath'])
    expect(calls[0].opts.env?.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(out.map((w: { path: string }) => w.path)).toEqual(['F:/repo/demo', 'F:/repo/wt'])
  })

  it('a git in the project folder or a relative PATH entry is never run: with no git on the absolute entries it lists the configured folder alone', () => {
    // Whatever a relative entry would name "exists": it is still never run.
    const { out, calls } = run({ status: 0, stdout: 'worktree F:/repo/wt\n' }, { PATH: '.;relative;%CD%' }, 'win32', (p) => !/^[A-Za-z]:[\\/]/.test(p))
    expect(calls).toEqual([])
    expect(out).toEqual(OWN)
    const inProject = run({ status: 0, stdout: 'worktree F:/repo/wt\n' }, { PATH: 'F:\\other' }, 'win32', 'F:\\repo\\demo\\git.exe')
    expect(inProject.calls).toEqual([])
  })

  it('fails safe: git missing, a non-zero exit, no output, garbage, a throw', () => {
    for (const answer of [{ error: new Error('ENOENT') }, { status: 128, stdout: 'worktree F:/repo/wt\n' }, { status: 0, stdout: '' }, { status: 0, stdout: 'not porcelain at all\n' + String.fromCharCode(0, 1) }, new Error('spawn failed')]) {
      expect(run(answer, { PATH: 'C:\\Git\\cmd' }).out, String(answer)).toEqual(OWN)
    }
  })

  it('keeps only absolute worktree paths with no control characters', () => {
    const text = ['worktree F:/repo/demo', '', 'worktree relative/wt', '', `worktree F:/repo/bad${ESC}[2J`, '', 'worktree \\\\host\\share\\wt', ''].join('\n')
    const { out } = run({ status: 0, stdout: text }, { PATH: 'C:\\Git\\cmd' })
    expect(out.map((w: { path: string }) => w.path)).toEqual(['F:/repo/demo', '\\\\host\\share\\wt'])
    const posix = run({ status: 0, stdout: 'worktree /srv/demo\n\nworktree srv/rel\n' }, { PATH: 'bin:/usr/bin' }, 'linux', '/usr/bin/git', '/srv/demo')
    expect(posix.calls[0].file).toBe('/usr/bin/git')
    expect(posix.calls[0].opts.env?.NoDefaultCurrentDirectoryInExePath).toBeUndefined()
    expect(posix.out.map((w: { path: string }) => w.path)).toEqual(['/srv/demo'])
  })
})
