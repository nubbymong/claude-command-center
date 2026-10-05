// HOST QUARANTINE: plants junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
//
// Tests never act on a real home: the home guard (tests/helpers/home-guard-core.mjs)
// follows a REAL link or junction out of an allowed folder. A temporary folder stands
// in for the real home, so nothing here points at one. The host-safe stand-in is the
// fake-filesystem case in home-guard.test.ts.
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { MARKER_ENV, PROBE_GUARD_URL, createHomeChecker } from '../../helpers/home-guard-core.mjs'

const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ccc-iso-links-')))
const fakeHome = path.join(base, 'fake-home')
const allowed = path.join(base, 'allowed')
mkdirSync(fakeHome)
mkdirSync(allowed)
// 'junction' on Windows (no privilege needed); ignored elsewhere.
symlinkSync(fakeHome, path.join(allowed, 'live'), 'junction')
symlinkSync(path.join(fakeHome, 'not-yet'), path.join(allowed, 'dangling'), 'junction')

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('[CI] [VM] a real link out of an allowed folder is followed', () => {
  const c = createHomeChecker({ realRoots: [fakeHome], allowedRoots: [{ path: allowed, kind: 'tmp' }] })

  it('through a live link or junction', () => {
    expect(c.isProtected(path.join(allowed, 'live', 'new', 'f'))).toBe(true)
    expect(c.isProtected(path.join(allowed, 'live'))).toBe(true)
  })

  it('through a dangling one (a write would create its target)', () => {
    expect(c.isProtected(path.join(allowed, 'dangling'))).toBe(true)
    expect(c.isProtected(path.join(allowed, 'dangling', 'f'))).toBe(true)
  })

  it('but not into a plain folder beside it', () => {
    expect(c.isProtected(path.join(allowed, 'plain', 'f'))).toBe(false)
  })

  it('a recursive copy destination holding a link into the home is caught; a plain one is not', () => {
    const dest = path.join(base, 'dest')
    const plain = path.join(base, 'plain-dest')
    mkdirSync(path.join(dest, 'sub'), { recursive: true })
    mkdirSync(path.join(plain, 'sub'), { recursive: true })
    symlinkSync(fakeHome, path.join(dest, 'sub', 'lnk'), 'junction')
    const t = createHomeChecker({ realRoots: [fakeHome], allowedRoots: [{ path: base, kind: 'tmp' }] })
    expect(t.treeHit(dest)).not.toBeNull()
    expect(t.treeHit(plain)).toBeNull()
  })
})

describe('[CI] [VM] the guard removes or moves a link into a home, never what it points at', () => {
  it('rm and rename of a link, and a recursive rm of a folder holding one, are no refusal; a path through the link is', () => {
    // A plain-node child whose real home is `home2` (its HOME, and named in the marker);
    // its temp folder holds junctions (symbolic links off Windows) into that home.
    const home2 = path.join(base, 'home2')
    const tmp2 = path.join(base, 'tmp2')
    const work = path.join(tmp2, 'work')
    const nested = path.join(work, 'nested')
    mkdirSync(home2)
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(home2, 'keep.txt'), 'x')
    for (const l of [path.join(work, 'j1'), path.join(work, 'j2'), path.join(nested, 'j3'), path.join(work, 'j4')]) symlinkSync(home2, l, 'junction')
    const child = path.join(tmp2, 'child.mjs')
    writeFileSync(
      child,
      [
        "import fs from 'node:fs'",
        "import path from 'node:path'",
        `const g = await import(${JSON.stringify(PROBE_GUARD_URL)})`,
        `const work = ${JSON.stringify(work)}`,
        'const out = {}',
        'const attempt = (name, fn) => { try { fn(); out[name] = "no refusal" } catch (e) { out[name] = e && e.code } }',
        'attempt("rmLink", () => fs.rmSync(path.join(work, "j1")))',
        'attempt("renameLink", () => fs.renameSync(path.join(work, "j2"), path.join(work, "j2b")))',
        // Node's recursive rm walks the folder with Buffer paths and unlinks each entry.
        'attempt("rmTree", () => fs.rmSync(path.join(work, "nested"), { recursive: true }))',
        'attempt("throughLink", () => fs.rmSync(path.join(work, "j2b", "keep.txt")))',
        'attempt("writeThrough", () => fs.writeFileSync(path.join(work, "j2b", "new.txt"), "x"))',
        // With a trailing separator the path names the link's target (POSIX reads link/ as link/.).
        'attempt("rmTrailing", () => fs.rmSync(path.join(work, "j4") + path.sep, { recursive: true, force: true }))',
        'g.drainViolations()',
        'process.stdout.write(JSON.stringify(out))',
      ].join('\n'),
    )
    const r = spawnSync(process.execPath, [child], {
      // The marker names home2 a real home and tmp2 the only temp area handed over.
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', HOME: home2, USERPROFILE: home2, TEMP: tmp2, TMP: tmp2, TMPDIR: tmp2, [MARKER_ENV]: JSON.stringify({ v: 1, real: [home2], tmp: [tmp2], inst: [] }) },
      cwd: tmp2,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ rmLink: 'no refusal', renameLink: 'no refusal', rmTree: 'no refusal', throughLink: 'TEST_ISOLATION_VIOLATION', writeThrough: 'TEST_ISOLATION_VIOLATION', rmTrailing: 'TEST_ISOLATION_VIOLATION' })
    expect(existsSync(path.join(home2, 'keep.txt'))).toBe(true)
    expect(existsSync(path.join(home2, 'new.txt'))).toBe(false)
    expect(existsSync(path.join(work, 'nested'))).toBe(false)
  })

  it("Node's own synchronous recursive rm of a temp folder holding a link into a home leaves the home untouched", () => {
    // Unguarded on purpose here (the canary is no real home of this process): this shows
    // whether the running Node's rm (JS rimraf on Node 20, native on newer Node) descends
    // into a junction or folder link. The guard only sees the top-level call.
    const canary = path.join(base, 'canary-home')
    const tree = path.join(base, 'rm-tree')
    mkdirSync(canary)
    writeFileSync(path.join(canary, 'keep.txt'), 'x')
    mkdirSync(path.join(tree, 'sub'), { recursive: true })
    symlinkSync(canary, path.join(tree, 'j'), 'junction')
    symlinkSync(canary, path.join(tree, 'sub', 'j'), 'junction')
    rmSync(tree, { recursive: true, force: true })
    expect(existsSync(tree)).toBe(false)
    expect(existsSync(path.join(canary, 'keep.txt'))).toBe(true)
  })
})
