// P3.5 (rows 34, 38): where a Codex conversation's rollout is, and whether a
// launch can resume it exactly and in which directory. The rules Claude's
// resolveResumeLaunch keeps (a canonical id; the transcript must exist; the
// directory must exist and is never the home folder by accident), for Codex:
// only the launch's own realm, only real folders, the name and the
// session_meta must agree, and a resume by id is not tied to a directory.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { findCodexRollout, findCodexRollouts, chooseCodexRollout, resolveCodexResume, codexDayFolders, sameDirectory, readRolloutFirstLine, CODEX_ROLLOUT_HEAD_MAX_BYTES, __codexRolloutEntriesVisitedForTests } from '../../../../src/main/providers/codex/rollout-lookup'

const ID = '019dd000-0001-7000-8000-0000000000f1'
const temps: string[] = []
const temp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `ccc-p35-lookup-${tag}-`)); temps.push(d); return d }
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }) })

function put(sessionsDir: string, ymd: [string, string, string], id: string, cwd: string, metaId = id): string {
  const dir = join(sessionsDir, ...ymd)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-09-01T00-00-00-${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { id: metaId, cwd } }) + '\n')
  return file
}
/** A rollout whose session_meta carries its own time. */
function putAt(sessionsDir: string, ymd: [string, string, string], id: string, cwd: string, iso: string): string {
  const dir = join(sessionsDir, ...ymd)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, cwd } }) + '\n')
  return file
}

describe('findCodexRollout', () => {
  it('finds a conversation in any date folder of the realm, by its id', () => {
    const sessions = join(temp('realm'), 'sessions')
    put(sessions, ['2025', '01', '02'], '019dd000-0001-7000-8000-0000000000aa', '/x')
    const file = put(sessions, ['2024', '12', '31'], ID, 'C:\\p\\demo')
    expect(findCodexRollout(sessions, ID)).toMatchObject({ path: file, meta: { id: ID, cwd: 'C:\\p\\demo' } })
    expect(findCodexRollout(sessions, ID.toUpperCase())?.path).toBe(file)
  })

  it('never follows a link or junction inside the sessions folder', () => {
    const sessions = join(temp('realm'), 'sessions')
    const outside = join(temp('outside'), 'sessions')
    put(outside, ['2026', '09', '01'], ID, '/p')
    mkdirSync(join(sessions, '2026', '09'), { recursive: true })
    symlinkSync(join(outside, '2026', '09', '01'), join(sessions, '2026', '09', '01'), 'junction')
    expect(findCodexRollout(sessions, ID)).toBeNull()
  })

  it('nothing for an id that is not a conversation id, or a folder that is not given', () => {
    const sessions = join(temp('realm'), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/p')
    expect(findCodexRollout(sessions, `${ID}.jsonl`)).toBeNull()
    expect(findCodexRollout(sessions, '*')).toBeNull()
    expect(findCodexRollout('', ID)).toBeNull()
  })
})

describe('resolveCodexResume', () => {
  const always = () => true
  const never = () => false

  it('resumes in the directory the conversation ran in, when the tab kept that one and it is still there', () => {
    const sessions = join(temp('realm'), 'sessions')
    const project = temp('project')
    put(sessions, ['2026', '09', '01'], ID, project)
    expect(resolveCodexResume({ uuid: ID, cwd: project }, { sessionsDir: sessions, configuredCwd: '/configured' })).toMatchObject({ resumeId: ID, cwd: project, cwdMismatch: false, path: expect.stringContaining(ID) })
  })

  it('in the configured directory otherwise: another directory, a relative one, or one at or above home', () => {
    const sessions = join(temp('realm'), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/p/recorded')
    const ctx = { sessionsDir: sessions, configuredCwd: '/configured', dirExists: always, homeOrAbove: never }
    expect(resolveCodexResume({ uuid: ID, cwd: '/p/other' }, ctx)?.cwd).toBe('/configured')
    expect(resolveCodexResume({ uuid: ID, cwd: '' }, ctx)?.cwd).toBe('/configured')
    const home = join(temp('realm2'), 'sessions')
    put(home, ['2026', '09', '01'], ID, homedir())
    expect(resolveCodexResume({ uuid: ID, cwd: homedir() }, { sessionsDir: home, configuredCwd: '/configured', dirExists: always })?.cwd).toBe('/configured')
    // Unless home IS the configured directory.
    expect(resolveCodexResume({ uuid: ID, cwd: homedir() }, { sessionsDir: home, configuredCwd: homedir(), dirExists: always })?.cwd).toBe(homedir())
    const rel = join(temp('realm3'), 'sessions')
    put(rel, ['2026', '09', '01'], ID, 'p/rel')
    expect(resolveCodexResume({ uuid: ID, cwd: 'p/rel' }, { sessionsDir: rel, configuredCwd: '/configured', dirExists: always, homeOrAbove: never })?.cwd).toBe('/configured')
  })

  it('in the configured directory when the conversation\'s own is gone', () => {
    const sessions = join(temp('realm'), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/p/gone')
    expect(resolveCodexResume({ uuid: ID, cwd: '/p/gone' }, { sessionsDir: sessions, configuredCwd: '/configured', dirExists: never, homeOrAbove: never })?.cwd).toBe('/configured')
  })

  it('nothing to resume when the realm does not hold it, or the name and the session_meta disagree', () => {
    const mine = join(temp('realm'), 'sessions')
    const theirs = join(temp('realm'), 'sessions')
    put(theirs, ['2026', '09', '01'], ID, '/p')
    expect(resolveCodexResume({ uuid: ID, cwd: '/p' }, { sessionsDir: mine, configuredCwd: '/c' })).toBeNull()
    const mismatched = join(temp('realm'), 'sessions')
    put(mismatched, ['2026', '09', '01'], ID, '/p', '019dd000-0001-7000-8000-0000000000bb')
    expect(resolveCodexResume({ uuid: ID, cwd: '/p' }, { sessionsDir: mismatched, configuredCwd: '/c' })).toBeNull()
    expect(resolveCodexResume({ uuid: '-c', cwd: '/p' }, { sessionsDir: theirs, configuredCwd: '/c' })).toBeNull()
    expect(resolveCodexResume(null, { sessionsDir: theirs, configuredCwd: '/c' })).toBeNull()
  })
})

describe('the helpers', () => {
  it('day folders: each time by UTC and by local date, once each', () => {
    const t = Date.UTC(2026, 8, 27, 23, 0, 0)
    const folders = codexDayFolders('/s', [t, t])
    expect(folders).toContain(join('/s', '2026', '09', '27'))
    expect(new Set(folders).size).toBe(folders.length)
  })

  it('sameDirectory: resolved, case-folded on Windows only', () => {
    expect(sameDirectory('C:\\P\\Demo', 'c:/p/demo', 'win32')).toBe(true)
    expect(sameDirectory('/p/Demo', '/p/demo', 'linux')).toBe(false)
    expect(sameDirectory('/p/demo/', '/p/demo', 'linux')).toBe(true)
    expect(sameDirectory('', '/p', 'linux')).toBe(false)
  })

  it('a first line longer than the bound is refused, not read on', () => {
    const f = join(temp('long'), 'rollout-x.jsonl')
    writeFileSync(f, 'x'.repeat(CODEX_ROLLOUT_HEAD_MAX_BYTES + 10))
    expect(readRolloutFirstLine(f)).toEqual({ kind: 'too-long' })
    writeFileSync(f, '{"a":1}')
    expect(readRolloutFirstLine(f)).toEqual({ kind: 'partial' })
    writeFileSync(f, '{"a":1}\n{"b":2}\n')
    expect(readRolloutFirstLine(f)).toEqual({ kind: 'line', line: '{"a":1}' })
  })
})

// P3.5 fix round 1 (theses 4, 5, 6): the walk is bounded, never follows a
// link at any level, and says which of two rollouts with one id it takes.
describe('findCodexRollouts: bounds, links and duplicates', () => {
  const OTHER = (n: number) => `019dd000-0001-7000-8000-${String(n).padStart(12, '0')}`

  it('gives up past its bound on day folders (thesis 5)', () => {
    const sessions = join(temp('realm'), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/p')
    for (let d = 2; d <= 5; d++) put(sessions, ['2026', '09', String(d).padStart(2, '0')], OTHER(d), '/p')
    expect(findCodexRollouts(sessions, ID, { maxDays: 4 })).toEqual([])
    expect(findCodexRollouts(sessions, ID, { maxDays: 5 }).map((f) => f.meta.id)).toEqual([ID])
  })

  it('gives up past its bound on folder entries, and never reads more files than it has left (thesis 5)', () => {
    const sessions = join(temp('realm'), 'sessions')
    for (let n = 1; n <= 40; n++) put(sessions, ['2026', '09', '01'], OTHER(n), '/p')
    put(sessions, ['2026', '09', '01'], ID, '/p')
    expect(findCodexRollouts(sessions, ID, { maxEntries: 20 })).toEqual([])
    expect(findCodexRollouts(sessions, ID, { maxEntries: 100 }).map((f) => f.meta.id)).toEqual([ID])
  })

  it('never follows a link at the year or month level, nor a sessions folder that is itself a link (thesis 4)', () => {
    const outside = join(temp('outside'), 'sessions')
    put(outside, ['2026', '09', '01'], ID, '/p')
    const yearLinked = join(temp('realm'), 'sessions')
    mkdirSync(yearLinked, { recursive: true })
    symlinkSync(join(outside, '2026'), join(yearLinked, '2026'), 'junction')
    expect(findCodexRollouts(yearLinked, ID)).toEqual([])
    const monthLinked = join(temp('realm'), 'sessions')
    mkdirSync(join(monthLinked, '2026'), { recursive: true })
    symlinkSync(join(outside, '2026', '09'), join(monthLinked, '2026', '09'), 'junction')
    expect(findCodexRollouts(monthLinked, ID)).toEqual([])
    const home = temp('realm')
    symlinkSync(outside, join(home, 'sessions'), 'junction')
    expect(findCodexRollouts(join(home, 'sessions'), ID)).toEqual([])
  })

  it('never follows a file link (thesis 4)', (ctx) => {
    const outside = join(temp('outside'), 'sessions')
    const real = put(outside, ['2026', '09', '01'], ID, '/p')
    const sessions = join(temp('realm'), 'sessions')
    mkdirSync(join(sessions, '2026', '09', '01'), { recursive: true })
    try { symlinkSync(real, join(sessions, '2026', '09', '01', `rollout-2026-09-01T00-00-00-${ID}.jsonl`), 'file') } catch { ctx.skip(); return }
    expect(findCodexRollouts(sessions, ID)).toEqual([])
  })

  it('a second name of the same file (what a staged sign in again leaves in the new folder) is found: its content is checked like any other', () => {
    const old = join(temp('realm-old'), 'sessions')
    const real = put(old, ['2026', '09', '01'], ID, '/p')
    const fresh = join(temp('realm-new'), 'sessions')
    mkdirSync(join(fresh, '2026', '09', '01'), { recursive: true })
    const second = join(fresh, '2026', '09', '01', `rollout-2026-09-01T00-00-00-${ID}.jsonl`)
    linkSync(real, second)
    expect(findCodexRollouts(fresh, ID).map((f) => f.path)).toEqual([second])
  })

  it('two rollouts with one id: the one in the date folder its session_meta names wins over a newer copy (thesis 6)', () => {
    const sessions = join(temp('realm'), 'sessions')
    const own = putAt(sessions, ['2026', '09', '20'], ID, '/p/demo', '2026-09-20T10:00:00.000Z')
    putAt(sessions, ['2026', '09', '27'], ID, '/p/copy', '2026-09-20T10:00:00.000Z')
    expect(findCodexRollouts(sessions, ID).map((f) => [f.path === own, f.dated])).toEqual([[false, false], [true, true]])
    expect(chooseCodexRollout(findCodexRollouts(sessions, ID))).toMatchObject({ found: { path: own }, cwdMatched: true })
    // The directory the session kept wins over the date: the copy that records it.
    const kept = chooseCodexRollout(findCodexRollouts(sessions, ID), '/p/copy')
    expect(kept?.found.meta.cwd).toBe('/p/copy')
    expect(kept?.cwdMatched).toBe(true)
    // Neither records it: the dated one, and it says so.
    expect(chooseCodexRollout(findCodexRollouts(sessions, ID), '/p/elsewhere')).toMatchObject({ found: { path: own }, cwdMatched: false })
  })

  it('a resume whose kept directory no rollout of that id records starts in the configured directory and says so (thesis 6)', () => {
    const sessions = join(temp('realm'), 'sessions')
    putAt(sessions, ['2026', '09', '20'], ID, '/p/demo', '2026-09-20T10:00:00.000Z')
    const out = resolveCodexResume({ uuid: ID, cwd: '/p/elsewhere' }, { sessionsDir: sessions, configuredCwd: '/configured', dirExists: () => true, homeOrAbove: () => false })
    expect(out).toMatchObject({ resumeId: ID, cwd: '/configured', cwdMismatch: true, path: expect.stringContaining(ID) })
    const match = resolveCodexResume({ uuid: ID, cwd: '/p/demo' }, { sessionsDir: sessions, configuredCwd: '/configured', dirExists: () => true, homeOrAbove: () => false })
    expect(match?.cwdMismatch).toBe(false)
  })
})

// P3.5 fix round 2 (quality major 1): a lookup stops at the conversation's own
// rollout (the first found in the date folder its session_meta names) instead
// of walking the whole realm for copies. Copies in NEWER folders are walked
// first (newest first) and still take part in the choice; a copy in an older
// folder than the conversation's own is not looked for.
describe('findCodexRollouts stops at the conversation\'s own rollout', () => {
  const OTHER = (n: number) => `019dd000-0001-7000-8000-${String(n).padStart(12, '0')}`

  it('visits only what lies before it: a realm with many days is not walked past it', () => {
    const sessions = join(temp('realm'), 'sessions')
    let n = 0
    for (let month = 7; month <= 9; month++) {
      for (let day = 1; day <= 20; day++) {
        const ymd: [string, string, string] = ['2026', String(month).padStart(2, '0'), String(day).padStart(2, '0')]
        for (let k = 0; k < 3; k++) putAt(sessions, ymd, OTHER(++n), '/p', `2026-${ymd[1]}-${ymd[2]}T10:00:0${k}.000Z`)
      }
    }
    putAt(sessions, ['2026', '09', '20'], ID, '/p/demo', '2026-09-20T12:00:00.000Z')
    const before = __codexRolloutEntriesVisitedForTests()
    expect(findCodexRollouts(sessions, ID).map((f) => f.meta.id)).toEqual([ID])
    const visited = __codexRolloutEntriesVisitedForTests() - before
    // The year, its three months, the twenty days of September, and that day's four files.
    expect(visited).toBeLessThanOrEqual(1 + 3 + 20 + 4)
  })

  it('a copy in a newer folder still takes part in the choice; one older than the conversation\'s own is not looked for', () => {
    const sessions = join(temp('realm'), 'sessions')
    const own = putAt(sessions, ['2026', '09', '20'], ID, '/p/demo', '2026-09-20T10:00:00.000Z')
    const newer = putAt(sessions, ['2026', '09', '27'], ID, '/p/newer', '2026-09-20T10:00:00.000Z')
    putAt(sessions, ['2026', '09', '10'], ID, '/p/older', '2026-09-20T10:00:00.000Z')
    expect(findCodexRollouts(sessions, ID).map((f) => f.path)).toEqual([newer, own])
    expect(chooseCodexRollout(findCodexRollouts(sessions, ID), '/p/newer')?.found.path).toBe(newer)
    expect(chooseCodexRollout(findCodexRollouts(sessions, ID), '/p/older')).toMatchObject({ found: { path: own }, cwdMatched: false })
  })
})
