/**
 * P3.12 (row 32): the name file next to a Codex rollout. Claude's picker reads
 * `<transcript>.ccc-name.json`; the app writes the same file next to a Codex
 * rollout, into the account's own sessions folder, and never through a link:
 * only inside the realm's real YYYY/MM/DD folders, a name-file entry that is not
 * a plain file is left alone, and the file is created fresh and renamed into
 * place (a link there is replaced, never written through). A blank name removes
 * it. It never throws.
 *
 * Real files in a fresh temp folder (removed only by this test, by its own
 * prefix); the link cases use an injected file system so they need no
 * link-creation rights on the host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { writeRealmNameSidecar, nodeRealmNameFs, type RealmNameFs } from '../../../src/main/logging/session-name-sidecar'

let root: string
let sessions: string
let day: string
let rollout: string
const ID = '019dd000-0001-7000-8000-00000000000a'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccc-p312-name-'))
  sessions = join(root, 'sessions')
  day = join(sessions, '2026', '09', '29')
  mkdirSync(day, { recursive: true })
  rollout = join(day, `rollout-2026-09-29T10-00-00-${ID}.jsonl`)
  writeFileSync(rollout, '{}\n')
})
afterEach(() => {
  if (basename(root).startsWith('ccc-p312-name-') && dirname(root) === tmpdir()) rmSync(root, { recursive: true, force: true })
})

const nameFile = () => join(day, `rollout-2026-09-29T10-00-00-${ID}.ccc-name.json`)

describe('the name file next to a Codex rollout (P3.12, row 32)', () => {
  it('writes {name, updatedAt} as the file Claude\'s picker reads, trimmed and JSON-escaped; nothing else is left in the folder', () => {
    expect(writeRealmNameSidecar(rollout, sessions, '  My "work" \n name  ', nodeRealmNameFs)).toBe(true)
    const parsed = JSON.parse(readFileSync(nameFile(), 'utf8'))
    expect(parsed.name).toBe('My "work" \n name')
    expect(typeof parsed.updatedAt).toBe('number')
    expect(readdirSync(day).sort()).toEqual([basename(nameFile()), basename(rollout)].sort())
  })

  it('a second name replaces the first; a blank name removes the file', () => {
    writeRealmNameSidecar(rollout, sessions, 'one', nodeRealmNameFs)
    writeRealmNameSidecar(rollout, sessions, 'two', nodeRealmNameFs)
    expect(JSON.parse(readFileSync(nameFile(), 'utf8')).name).toBe('two')
    expect(writeRealmNameSidecar(rollout, sessions, '   ', nodeRealmNameFs)).toBe(true)
    expect(existsSync(nameFile())).toBe(false)
  })

  it('writes nothing outside the realm\'s own YYYY/MM/DD folders, or next to anything but a rollout', () => {
    const outside = join(root, 'elsewhere', `rollout-x-${ID}.jsonl`)
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, '{}\n')
    expect(writeRealmNameSidecar(outside, sessions, 'n', nodeRealmNameFs)).toBe(false)
    const shallow = join(sessions, '2026', `rollout-x-${ID}.jsonl`)
    expect(writeRealmNameSidecar(shallow, sessions, 'n', nodeRealmNameFs)).toBe(false)
    const notRollout = join(day, 'notes.jsonl')
    expect(writeRealmNameSidecar(notRollout, sessions, 'n', nodeRealmNameFs)).toBe(false)
    expect(writeRealmNameSidecar(join(day, '..', '..', '..', '..', `rollout-x-${ID}.jsonl`), sessions, 'n', nodeRealmNameFs)).toBe(false)
    expect(writeRealmNameSidecar(rollout, '', 'n', nodeRealmNameFs)).toBe(false)
    expect(readdirSync(day)).toEqual([basename(rollout)])
  })

  // The link cases, through an injected file system that says what lstat would.
  function fakeFs(kinds: Record<string, 'dir' | 'file' | 'link'>): RealmNameFs & { ops: string[] } {
    const ops: string[] = []
    return {
      ops,
      lstat: (p) => {
        const k = kinds[p]
        if (!k) return null
        return { isFile: () => k === 'file', isDirectory: () => k === 'dir' }
      },
      createExclusive: (p) => { ops.push(`create ${basename(p)}`) },
      rename: (a, b) => { ops.push(`rename ${basename(a)} -> ${basename(b)}`) },
      unlink: (p) => { ops.push(`unlink ${basename(p)}`) },
      randomHex: () => '0123456789abcdef',
      now: () => 1,
    }
  }
  const dirs = () => ({ [sessions]: 'dir', [join(sessions, '2026')]: 'dir', [join(sessions, '2026', '09')]: 'dir', [day]: 'dir' } as Record<string, 'dir' | 'file' | 'link'>)

  it('a folder on the way that is a link or junction: nothing is written', () => {
    for (const at of [sessions, join(sessions, '2026'), join(sessions, '2026', '09'), day]) {
      const f = fakeFs({ ...dirs(), [at]: 'link' })
      expect(writeRealmNameSidecar(rollout, sessions, 'n', f)).toBe(false)
      expect(f.ops).toEqual([])
    }
  })

  it('a name-file entry that is a link or a folder is left alone (never written through, never removed)', () => {
    for (const kind of ['link', 'dir'] as const) {
      const f = fakeFs({ ...dirs(), [nameFile()]: kind })
      expect(writeRealmNameSidecar(rollout, sessions, 'n', f)).toBe(false)
      expect(writeRealmNameSidecar(rollout, sessions, '', f)).toBe(false)
      expect(f.ops).toEqual([])
    }
  })

  it('writes by creating a fresh file and renaming it over the name file; a failed rename removes the fresh file; never throws', () => {
    const f = fakeFs({ ...dirs(), [nameFile()]: 'file' })
    writeRealmNameSidecar(rollout, sessions, 'n', f)
    const tmp = `${basename(nameFile())}.0123456789abcdef.tmp`
    expect(f.ops).toEqual([`create ${tmp}`, `rename ${tmp} -> ${basename(nameFile())}`])
    const failing = { ...fakeFs(dirs()), rename: () => { throw new Error('busy') } }
    const ops: string[] = []
    failing.unlink = (p: string) => { ops.push(`unlink ${basename(p)}`) }
    expect(writeRealmNameSidecar(rollout, sessions, 'n', failing)).toBe(false)
    expect(ops).toEqual([`unlink ${tmp}`])
    const throwing = { ...fakeFs(dirs()), lstat: () => { throw new Error('io') } }
    expect(() => writeRealmNameSidecar(rollout, sessions, 'n', throwing)).not.toThrow()
  })

  it('the production file system creates the fresh file exclusively: never over anything already there', () => {
    const at = join(day, 'taken.tmp')
    writeFileSync(at, 'x')
    expect(() => nodeRealmNameFs.createExclusive(at, 'y')).toThrow()
    expect(readFileSync(at, 'utf8')).toBe('x')
  })
})
