// [host] P4.8 (rows 59, 60; WP1.71): the codex-conformance job's own-home
// check (codex-conformance-ci.mjs own-home record|check), proven to fail on
// every change it exists to catch before the CI job relies on it (verify the
// verifier; PR 4 re-review). PURE: the folder is an in-memory stand-in; no real
// home, no temp folder, no process.
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { picture, ownHomeVerdict } from './codex-own-home.mjs'

type Entry = { dir: true } | { size: number; mtimeMs: number } | { link: string }
const HOME = join('/runner', '.codex')

/** A folder tree as the picture reads it: existsSync, readdirSync, lstatSync. */
function fakeFs(tree: Record<string, Entry>) {
  const at = (rel: string) => (rel === '' ? HOME : join(HOME, ...rel.split('/')))
  const nodes = new Map<string, Entry>(Object.entries(tree).map(([rel, e]) => [at(rel), e]))
  return {
    existsSync: (p: string) => nodes.has(p),
    readdirSync: (p: string) => [...nodes.keys()].filter((k) => k !== p && join(k, '..') === p).map((k) => k.slice(p.length + 1)),
    lstatSync: (p: string) => {
      const e = nodes.get(p)
      if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return {
        isDirectory: () => 'dir' in e,
        isSymbolicLink: () => 'link' in e,
        size: 'size' in e ? e.size : 0,
        mtimeMs: 'mtimeMs' in e ? e.mtimeMs : 0,
      }
    },
  }
}

const BASE: Record<string, Entry> = {
  '': { dir: true },
  'config.toml': { size: 12, mtimeMs: 1_700_000_000_123.9 },
  'log': { dir: true },
  'log/codex-tui.log': { size: 40, mtimeMs: 1_700_000_001_000 },
}

describe('the picture of the runner\'s own Codex home', () => {
  it('reads absent, empty, or every entry: a folder as such, anything else with its size and whole-millisecond modified time', () => {
    expect(picture(HOME, fakeFs({}))).toBe('absent')
    expect(picture(HOME, fakeFs({ '': { dir: true } }))).toBe('empty')
    expect(picture(HOME, fakeFs(BASE)).split('\n')).toEqual([
      'config.toml 12 1700000000123',
      'log/',
      'log/codex-tui.log 40 1700000001000',
    ])
  })

  it('never follows a link: the link is an entry, what it points at is not read', () => {
    const fs = fakeFs({ '': { dir: true }, 'elsewhere': { link: '/runner/secrets' } })
    expect(picture(HOME, fs)).toBe('elsewhere 0 0')
  })
})

describe('the check after the last run of the CLI', () => {
  const before = picture(HOME, fakeFs(BASE))
  const changed = (tree: Record<string, Entry>) => ownHomeVerdict(before, picture(HOME, fakeFs(tree)), HOME)

  it('passes only when nothing changed', () => {
    expect(ownHomeVerdict(before, picture(HOME, fakeFs({ ...BASE })), HOME)).toMatchObject({ ok: true })
    expect(ownHomeVerdict('absent', picture(HOME, fakeFs({})), HOME)).toMatchObject({ ok: true })
  })

  it('fails on every change a run of the CLI could make', () => {
    const cases: Array<[string, Record<string, Entry>]> = [
      ['an entry appeared', { ...BASE, 'auth.json': { size: 2, mtimeMs: 1_700_000_002_000 } }],
      ['an empty folder appeared', { ...BASE, 'sessions': { dir: true } }],
      ['a size changed', { ...BASE, 'log/codex-tui.log': { size: 41, mtimeMs: 1_700_000_001_000 } }],
      ['a modified time changed', { ...BASE, 'config.toml': { size: 12, mtimeMs: 1_700_000_005_000 } }],
      ['an entry went', { '': { dir: true }, 'log': { dir: true }, 'log/codex-tui.log': { size: 40, mtimeMs: 1_700_000_001_000 } }],
    ]
    for (const [what, tree] of cases) {
      const v = changed(tree)
      expect(v.ok, what).toBe(false)
      expect(v.message, what).toMatch(/used the runner's own/)
    }
    // Absent before, an empty folder after.
    expect(ownHomeVerdict('absent', picture(HOME, fakeFs({ '': { dir: true } })), HOME)).toMatchObject({ ok: false })
  })

  it('RCEF-3: with no record (the record step did not run) it fails saying so, never that the home was used', () => {
    for (const none of [null, '']) {
      const v = ownHomeVerdict(none, picture(HOME, fakeFs(BASE)), HOME)
      expect(v.ok).toBe(false)
      expect(v.message).toMatch(/no record/)
      expect(v.message).not.toMatch(/used/)
    }
  })
})
