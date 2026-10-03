// [host] PR 4 VM checkpoint (F3): the help folder's rebuild removes a link as
// the link and never walks into it (src/main/help-workspace.ts removeNoFollow,
// P4.3, ADR-009). The real-link case is the quarantined file
// help-workspace-rebuild-links.test.ts (CI and the VM); there, on Windows with
// Node 24, a recursive fs.rmSync also removes a junction or a file link as the
// link, so a remover that follows links cannot be told apart by what is left
// on disk. This file holds the guard's contract instead, on every platform,
// with no link made: the remover is handed its reads and removals, and for a
// link entry the only removal it makes is unlink of the link itself (no
// listing of it, no recursive removal, no folder removal, no mode change,
// since a mode change follows a link to its target).
//
// The paths are inside this file's own empty temporary folder and none of
// them exists, so even a remover that ignored the handed-in operations would
// find nothing to remove.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { removeNoFollow, type NoFollowRemoveOps } from '../../../src/main/help-workspace'

type Kind = 'dir' | 'file' | 'link-dir' | 'link-file' | 'link-and-dir'

let root = ''
beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-help-nofollow-')) })
afterAll(() => {
  if (root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('ccc-help-nofollow-')) fs.rmSync(root, { recursive: true, force: true })
})

/** A help folder as the remover sees it, every call recorded. `failUnlink`:
 *  paths whose first unlink fails (EPERM). */
function fakeTree(entries: Record<string, Kind>, failUnlink: readonly string[] = []) {
  const at = (rel: string): string => path.join(root, 'help', ...rel.split('/'))
  const kinds = new Map<string, Kind>(Object.entries(entries).map(([rel, k]) => [at(rel), k]))
  const failing = new Set(failUnlink.map(at))
  const calls: Array<[string, string]> = []
  const ops: NoFollowRemoveOps = {
    lstat: (p) => {
      calls.push(['lstat', p])
      const k = kinds.get(p)
      if (!k) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      // As Node's lstat reports them: a junction or a directory symlink is a
      // symbolic link and not a directory. 'link-and-dir' says both, which
      // no platform reports, so a remover is held to the link reading first.
      return { isDirectory: () => k === 'dir' || k === 'link-and-dir', isSymbolicLink: () => k.startsWith('link') }
    },
    readdir: (p) => {
      calls.push(['readdir', p])
      return [...kinds.keys()].filter((k) => path.dirname(k) === p).map((k) => path.basename(k))
    },
    rmdir: (p) => { calls.push(['rmdir', p]); kinds.delete(p) },
    unlink: (p) => {
      calls.push(['unlink', p])
      if (failing.delete(p)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      kinds.delete(p)
    },
    chmod: (p, mode) => { calls.push([`chmod ${mode.toString(8)}`, p]) },
  }
  return { at, ops, calls, kinds }
}

describe('removeNoFollow removes a link as the link (F3)', () => {
  it.each([
    ['a directory link (a junction on Windows)', 'link-dir'],
    ['a file link', 'link-file'],
    ['an entry read as both a link and a folder', 'link-and-dir'],
  ] as Array<[string, Kind]>)('%s: unlink of the link only', (_name, kind) => {
    const t = fakeTree({ planted: kind, 'planted/inside.txt': 'file' })
    removeNoFollow(t.at('planted'), t.ops)
    expect(t.calls).toEqual([['lstat', t.at('planted')], ['unlink', t.at('planted')]])
    // What the link points at was never named, let alone removed.
    expect(t.kinds.has(t.at('planted/inside.txt'))).toBe(true)
  })

  it('a real folder holding a link: the folder is walked, the link unlinked and never walked, then the folder removed', () => {
    const t = fakeTree({ sub: 'dir', 'sub/a.txt': 'file', 'sub/jn': 'link-dir', 'sub/jn/target.txt': 'file' })
    removeNoFollow(t.at('sub'), t.ops)
    expect(t.calls.filter(([op]) => op !== 'lstat')).toEqual([
      ['readdir', t.at('sub')],
      ['unlink', t.at('sub/a.txt')],
      ['unlink', t.at('sub/jn')],
      ['rmdir', t.at('sub')],
    ])
    expect(t.calls.some(([, p]) => p.startsWith(t.at('sub/jn') + path.sep))).toBe(false)
  })

  it('a link that cannot be unlinked: the error is thrown, and no mode is changed through it', () => {
    const t = fakeTree({ planted: 'link-dir' }, ['planted'])
    expect(() => removeNoFollow(t.at('planted'), t.ops)).toThrow(/EPERM/)
    expect(t.calls).toEqual([['lstat', t.at('planted')], ['unlink', t.at('planted')]])
  })

  it('a real file that cannot be unlinked at first: its mode is lifted and the unlink tried once more', () => {
    const t = fakeTree({ 'ro.txt': 'file' }, ['ro.txt'])
    removeNoFollow(t.at('ro.txt'), t.ops)
    expect(t.calls).toEqual([['lstat', t.at('ro.txt')], ['unlink', t.at('ro.txt')], ['chmod 600', t.at('ro.txt')], ['unlink', t.at('ro.txt')]])
  })

  it('the paths used here do not exist on disk', () => {
    expect(fs.readdirSync(root)).toEqual([])
  })
})
