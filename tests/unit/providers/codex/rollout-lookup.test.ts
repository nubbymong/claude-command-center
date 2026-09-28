// P3.5 (rows 34, 38): where a Codex conversation's rollout is, and whether a
// launch can resume it exactly and in which directory. The rules Claude's
// resolveResumeLaunch keeps (a canonical id; the transcript must exist; the
// directory must exist and is never the home folder by accident), for Codex:
// only the launch's own realm, only real folders, the name and the
// session_meta must agree, and a resume by id is not tied to a directory.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { findCodexRollout, resolveCodexResume, codexDayFolders, sameDirectory, readRolloutFirstLine, CODEX_ROLLOUT_HEAD_MAX_BYTES } from '../../../../src/main/providers/codex/rollout-lookup'

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
    expect(resolveCodexResume({ uuid: ID, cwd: project }, { sessionsDir: sessions, configuredCwd: '/configured' })).toEqual({ resumeId: ID, cwd: project })
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
    const planted = join(temp('realm'), 'sessions')
    put(planted, ['2026', '09', '01'], ID, '/p', '019dd000-0001-7000-8000-0000000000bb')
    expect(resolveCodexResume({ uuid: ID, cwd: '/p' }, { sessionsDir: planted, configuredCwd: '/c' })).toBeNull()
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
