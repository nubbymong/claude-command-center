// HOST QUARANTINE: plants directory junctions, symbolic links and a hard link. [CI] [VM] only -- never run on the owner's machine.
// P3.5 (row 32) and its fix rounds: the link cases of
// codex-resume-picker-worktrees.test.ts, moved here whole so the host-safe
// file plants none. The picker lists a conversation carried into a new
// account folder by a hard link, never one reached through a link or junction
// at the year, month or day level; a link at the pick path is replaced, never
// written through, and nothing is written into a folder a link there points
// at; a pick folder swapped for a link is never written through. Real files
// in temp folders; nothing is started.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, rmdirSync, unlinkSync, readFileSync, linkSync, readdirSync, symlinkSync, lstatSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  walkRollouts: (home: string, maxDays: number, where: string | Array<{ path: string; branch: string | null; isMain: boolean }>, platform?: string) => Array<{ id: string }>
  writePick: (file: string | undefined, decision: { id: string } | { fresh: true }, ops?: { renameSync?: (from: string, to: string) => void; sleep?: (ms: number) => void; dirId?: string }) => boolean
  recordPick: (file: string | undefined, resumeUuid: string | null, dirId?: string | null, ops?: { renameSync?: (from: string, to: string) => void; sleep?: (ms: number) => void }) => string | null
  folderIdOf: (dir: string) => string | null
  pickDecision: (resumeUuid: string | null) => { id: string } | { fresh: true }
}

const ID1 = '019dd000-0001-7000-8000-000000000101'
const temps: string[] = []
const temp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `ccc-p35-picker-${tag}-`)); temps.push(d); return d }
/** Removes, recursively, only a folder this file made: its own prefix, directly in the temp folder. */
const removeOwn = (d: string) => { if (dirname(d) === tmpdir() && /^ccc-p35-picker-/.test(basename(d))) rmSync(d, { recursive: true, force: true }) }
afterEach(() => {
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

describe('the picker lists every worktree\'s conversations, with links (row 32)', () => {
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
})

describe('the conversation the picker opens, with links (rows 32, 38)', () => {
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
})

describe('the pick is written only into the folder the app made, with links (fix round 3)', () => {
  /** Removes a link (a junction on Windows), if still there, and never what it points at. */
  const dropLink = (p: string) => {
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (!st) return
    if (!st.isSymbolicLink()) throw new Error('not a link: ' + p)
    try { unlinkSync(p) } catch { rmdirSync(p) }
  }

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
})
