/**
 * P3.9 round 1: the folders a run makes for itself and removes after it (the
 * Codex model list read's empty home, Sentinel's analysis folder) can be left
 * behind by a crash or a quit mid-run; the next run sweeps them. Only direct
 * children of the one parent, only the run's own prefix, only real folders
 * (a link is never followed or removed), on POSIX only this user's, and only
 * past an age no live run reaches. Never throws.
 *
 * PURE: the filesystem is injected; nothing on disk is read or removed.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { sweepStaleFolders, type SweepFs } from '../../../src/main/stale-folder-sweep'

const NOW = 10_000_000
const HOUR = 60 * 60 * 1000
// `linkAsFolder`: a link the platform also reports as a folder (lstat
// never should; the sweep still never follows or removes it).
type Entry = { dir?: boolean; link?: boolean; linkAsFolder?: boolean; age: number; uid?: number; lstatThrows?: boolean; rmThrows?: boolean }

/** `anyPathIsStale`: any path not listed reads as an old folder of this
 *  user's, so only the sweep's own checks keep it. */
function fakeFs(parent: string, entries: Record<string, Entry>, opts: { readdirThrows?: boolean; anyPathIsStale?: boolean } = {}) {
  const removed: string[] = []
  const removedPaths: string[] = []
  const fs: SweepFs = {
    readdirSync: (d) => {
      if (opts.readdirThrows) throw new Error('EACCES')
      expect(d).toBe(parent)
      return Object.keys(entries)
    },
    lstatSync: (p) => {
      const listed = path.dirname(p) === parent ? entries[path.basename(p)] : undefined
      const e = listed ?? (opts.anyPathIsStale ? { age: 2 * HOUR } : undefined)
      if (!e || e.lstatThrows) throw new Error('ENOENT')
      return { isDirectory: () => (e.dir !== false && !e.link) || !!e.linkAsFolder, isSymbolicLink: () => !!e.link, mtimeMs: NOW - e.age, uid: e.uid ?? 1000 }
    },
    rmSync: (p, o) => {
      expect(o).toEqual({ recursive: true, force: true })
      if (entries[path.basename(p)]?.rmThrows) throw new Error('EBUSY')
      removed.push(path.basename(p))
      removedPaths.push(p)
    },
  }
  return { fs, removed, removedPaths }
}

const PARENT = path.join(path.sep, 'app', 'runs')
const PREFIX = 'ccc-sentinel-codex-'

describe('sweepStaleFolders', () => {
  it('removes only own-prefix real folders past the age, and says which', () => {
    const { fs, removed } = fakeFs(PARENT, {
      'ccc-sentinel-codex-aaaa': { age: 2 * HOUR },
      'ccc-sentinel-codex-bbbb': { age: HOUR - 1 },                  // young: a run may still use it
      'ccc-sentinel-codex-cccc': { age: HOUR },                      // exactly the age: kept
      'ccc-sentinel-codex-link': { age: 2 * HOUR, link: true },      // a link: never followed or removed
      'ccc-sentinel-codex-lnk2': { age: 2 * HOUR, link: true, linkAsFolder: true },
      'ccc-sentinel-codex-file': { age: 2 * HOUR, dir: false },      // a file: not a run folder
      'ccc-sentinel-codex-': { age: 2 * HOUR },                      // the bare prefix: not a run's name
      'ccc-codex-models-dddd': { age: 2 * HOUR },                    // another run's prefix
      'user-folder': { age: 2 * HOUR },
    })
    const out = sweepStaleFolders(PARENT, PREFIX, { maxAgeMs: HOUR, now: NOW, fs, uid: null })
    expect(out).toEqual(['ccc-sentinel-codex-aaaa'])
    expect(removed).toEqual(['ccc-sentinel-codex-aaaa'])
  })

  it('on POSIX, a folder another user owns is left', () => {
    const { fs, removed } = fakeFs(PARENT, {
      'ccc-sentinel-codex-mine': { age: 2 * HOUR, uid: 1000 },
      'ccc-sentinel-codex-root': { age: 2 * HOUR, uid: 0 },
    })
    expect(sweepStaleFolders(PARENT, PREFIX, { maxAgeMs: HOUR, now: NOW, fs, uid: 1000 })).toEqual(['ccc-sentinel-codex-mine'])
    expect(removed).toEqual(['ccc-sentinel-codex-mine'])
  })

  it('a prefix too short to be a run\'s own sweeps nothing', () => {
    for (const prefix of ['', 'c', 'ccc']) {
      const { fs, removed } = fakeFs(PARENT, { [prefix + 'x-old']: { age: 2 * HOUR }, 'cccx': { age: 2 * HOUR } })
      expect(sweepStaleFolders(PARENT, prefix, { maxAgeMs: HOUR, now: NOW, fs, uid: null })).toEqual([])
      expect(removed).toEqual([])
    }
  })

  it('a name that is not a plain child (a separator in it) is never touched', () => {
    const names = ['ccc-sentinel-codex-a/b', 'ccc-sentinel-codex-a\\b', 'ccc-sentinel-codex-a/../../x']
    const { fs, removedPaths } = fakeFs(PARENT, Object.fromEntries(names.map((n) => [n, { age: 2 * HOUR }])), { anyPathIsStale: true })
    expect(sweepStaleFolders(PARENT, PREFIX, { maxAgeMs: HOUR, now: NOW, fs, uid: null })).toEqual([])
    expect(removedPaths).toEqual([])
  })

  it('never throws: an unreadable parent sweeps nothing; one folder that cannot be read or removed never stops the rest', () => {
    const bad = fakeFs(PARENT, {}, { readdirThrows: true })
    expect(sweepStaleFolders(PARENT, PREFIX, { maxAgeMs: HOUR, now: NOW, fs: bad.fs, uid: null })).toEqual([])
    const { fs, removed } = fakeFs(PARENT, {
      'ccc-sentinel-codex-gone': { age: 2 * HOUR, lstatThrows: true },
      'ccc-sentinel-codex-busy': { age: 2 * HOUR, rmThrows: true },
      'ccc-sentinel-codex-last': { age: 2 * HOUR },
    })
    expect(sweepStaleFolders(PARENT, PREFIX, { maxAgeMs: HOUR, now: NOW, fs, uid: null })).toEqual(['ccc-sentinel-codex-last'])
    expect(removed).toEqual(['ccc-sentinel-codex-last'])
  })
})
