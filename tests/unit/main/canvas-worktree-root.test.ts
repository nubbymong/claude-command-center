// Agent Canvas serves the session's DESIGNATED worktree (ADR-016).
//
// Session isolation puts every agent in `<parent>/ccc-wt/<id>` and blocks
// writes to the primary checkout; the canvas served roots were exactly the
// primary checkout. So an isolated agent could not `canvas_render` a file it
// wrote. CCC now designates the worktree location itself (canvas-worktree.ts)
// and records it as a PENDING root (canvas-store.designateCanvasWorktreeRoot):
// consulted only once it exists as a real, un-linked directory that passes the
// floor. These tests pin the store semantics and the pure naming helper.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  designateCanvasWorktreeRoot,
  registerCanvasUatRoot,
  resolveInsideCanvasRoot,
  revokeCanvasUatRoots,
  _resetCanvasStoreForTest,
} from '../../../src/main/canvas/canvas-store'
import { designatedWorktreeDir, worktreeBaseDir, shortSessionId } from '../../../src/main/canvas/canvas-worktree'

const SID = 'wt1111wt1111wt1111wt1111'
const OTHER = 'ot2222ot2222ot2222ot2222'

const tempDirs: string[] = []
function tmp(prefix: string): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

/** A directory link: junction on Windows (no privilege needed), symlink elsewhere. */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

beforeEach(() => _resetCanvasStoreForTest())

describe('designateCanvasWorktreeRoot — a pending root that serves only once it is real', () => {
  it('serves nothing while the designated directory does not exist, then serves it once it does', () => {
    const base = tmp('ccc-wt-base-')
    const designated = path.join(base, 'ccc-wt', 'abcd1234')
    expect(designateCanvasWorktreeRoot(SID, designated)).toBe(true)

    // Not there yet → refused (fail closed), and the store does not throw or create it.
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'mock.html'), SID)).toThrow(/registered canvas root/i)
    expect(fs.existsSync(designated)).toBe(false)

    // The agent's guard claims the worktree there and writes a mockup → served.
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'mock.html'), '<html></html>')
    expect(resolveInsideCanvasRoot(path.join(designated, 'mock.html'), SID)).toBe(
      fs.realpathSync.native(path.join(designated, 'mock.html')),
    )
    // Containment still holds: a sibling of the designated dir is not served.
    fs.writeFileSync(path.join(base, 'ccc-wt', 'other.html'), '<html></html>')
    expect(() => resolveInsideCanvasRoot(path.join(base, 'ccc-wt', 'other.html'), SID)).toThrow(/registered canvas root/i)
  })

  it('refuses a designated directory the agent pre-created as a junction / symlink to somewhere else', () => {
    const base = tmp('ccc-wt-link-')
    const secrets = path.join(base, 'secrets')
    fs.mkdirSync(secrets)
    fs.writeFileSync(path.join(secrets, 'token.html'), 'PRIVATE')
    const designated = path.join(base, 'ccc-wt', 'abcd1234')
    fs.mkdirSync(path.dirname(designated), { recursive: true })
    linkDir(secrets, designated)
    expect(fs.existsSync(path.join(designated, 'token.html'))).toBe(true) // the link works…

    expect(designateCanvasWorktreeRoot(SID, designated)).toBe(true)
    // …but the realpath of the designated dir is `secrets`, not itself → not live.
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'token.html'), SID)).toThrow(/registered canvas root/i)
    expect(() => resolveInsideCanvasRoot(path.join(secrets, 'token.html'), SID)).toThrow(/registered canvas root/i)
  })

  it('refuses when a PARENT of the designated directory is a link (realpath differs anywhere on the way)', () => {
    const base = tmp('ccc-wt-plink-')
    const elsewhere = path.join(base, 'elsewhere')
    fs.mkdirSync(path.join(elsewhere, 'abcd1234'), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, 'abcd1234', 'x.html'), 'x')
    linkDir(elsewhere, path.join(base, 'ccc-wt')) // ccc-wt → elsewhere
    const designated = path.join(base, 'ccc-wt', 'abcd1234')
    expect(designateCanvasWorktreeRoot(SID, designated)).toBe(true)
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'x.html'), SID)).toThrow(/registered canvas root/i)
  })

  it('a link planted INSIDE a live designated worktree cannot reach out (candidate is realpath’d)', () => {
    const base = tmp('ccc-wt-inner-')
    const designated = path.join(base, 'ccc-wt', 'abcd1234')
    fs.mkdirSync(designated, { recursive: true })
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.html'), 'PRIVATE')
    linkDir(outside, path.join(designated, 'esc'))
    expect(designateCanvasWorktreeRoot(SID, designated)).toBe(true)
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'esc', 'secret.html'), SID)).toThrow(/registered canvas root/i)
  })

  it('stops serving the moment the real directory is swapped for a link (evaluated on every resolution)', () => {
    const base = tmp('ccc-wt-swap-')
    const designated = path.join(base, 'ccc-wt', 'abcd1234')
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'a.html'), 'a')
    expect(designateCanvasWorktreeRoot(SID, designated)).toBe(true)
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'a.html'), SID)).not.toThrow()

    fs.rmSync(designated, { recursive: true, force: true })
    const secrets = path.join(base, 'secrets')
    fs.mkdirSync(secrets)
    fs.writeFileSync(path.join(secrets, 'a.html'), 'PRIVATE')
    linkDir(secrets, designated)
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'a.html'), SID)).toThrow(/registered canvas root/i)
  })

  it('applies the same floor as a live root at designation time', () => {
    const home = fs.realpathSync.native(os.homedir())
    expect(designateCanvasWorktreeRoot(SID, home)).toBe(false)
    expect(designateCanvasWorktreeRoot(SID, path.dirname(home))).toBe(false) // ancestor of home
    expect(designateCanvasWorktreeRoot(SID, path.join(home, '.claude', 'ccc-wt', 'x'))).toBe(false) // dot-dir under home
    expect(designateCanvasWorktreeRoot(SID, path.parse(home).root)).toBe(false) // volume root
    expect(designateCanvasWorktreeRoot(SID, 'relative/ccc-wt/x')).toBe(false)
    expect(designateCanvasWorktreeRoot('', path.join(os.tmpdir(), 'x'))).toBe(false)
    expect(designateCanvasWorktreeRoot('bad id!', path.join(os.tmpdir(), 'x'))).toBe(false)
  })

  it('is per session: another session cannot resolve through it, and revoke drops it', () => {
    const base = tmp('ccc-wt-sess-')
    const designated = path.join(base, 'ccc-wt', 'abcd1234')
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'a.html'), 'a')
    expect(designateCanvasWorktreeRoot(SID, designated)).toBe(true)
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'a.html'), SID)).not.toThrow()
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'a.html'), OTHER)).toThrow(/registered canvas root/i)

    revokeCanvasUatRoots(SID)
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'a.html'), SID)).toThrow(/registered canvas root/i)
  })

  it('coexists with a live root: the project AND the designated worktree both resolve', () => {
    const project = tmp('ccc-wt-proj-')
    fs.writeFileSync(path.join(project, 'index.html'), 'p')
    const designated = path.join(path.dirname(project), 'ccc-wt-test-' + path.basename(project), 'abcd1234')
    tempDirs.push(path.dirname(designated))
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'mock.html'), 'm')
    expect(registerCanvasUatRoot(SID, project)).toBe(true)
    expect(designateCanvasWorktreeRoot(SID, designated)).toBe(true)
    expect(() => resolveInsideCanvasRoot(path.join(project, 'index.html'), SID)).not.toThrow()
    expect(() => resolveInsideCanvasRoot(path.join(designated, 'mock.html'), SID)).not.toThrow()
  })
})

describe('designatedWorktreeDir — CCC names the location from its own inputs', () => {
  const primary = (dir: string) => path.basename(dir) === 'project'
  const noEnv = {} as NodeJS.ProcessEnv

  it('is <parent of the primary checkout>/ccc-wt/<first 8 of the CCC session id>', () => {
    const project = path.join(os.tmpdir(), 'somewhere', 'project')
    expect(designatedWorktreeDir(project, SID, { env: noEnv, isPrimaryCheckout: primary })).toBe(
      path.join(os.tmpdir(), 'somewhere', 'ccc-wt', 'wt1111wt'),
    )
    expect(shortSessionId(SID)).toBe('wt1111wt')
  })

  it('honours CCC_WT_ROOT from CCC’s own environment (the guard inherits the same variable)', () => {
    const project = path.join(os.tmpdir(), 'somewhere', 'project')
    const wt = path.join(os.tmpdir(), 'my-wt')
    expect(designatedWorktreeDir(project, SID, { env: { CCC_WT_ROOT: wt }, isPrimaryCheckout: primary })).toBe(
      path.join(wt, 'wt1111wt'),
    )
    // A relative CCC_WT_ROOT is ignored (the guard would resolve it against ITS
    // cwd — a place CCC cannot predict).
    expect(worktreeBaseDir(project, { CCC_WT_ROOT: 'rel/wt' })).toBe(path.join(os.tmpdir(), 'somewhere', 'ccc-wt'))
  })

  it('returns null when the project is not a primary git checkout, or inputs are malformed', () => {
    const notPrimary = path.join(os.tmpdir(), 'somewhere', 'worktree')
    expect(designatedWorktreeDir(notPrimary, SID, { env: noEnv, isPrimaryCheckout: primary })).toBeNull()
    const project = path.join(os.tmpdir(), 'somewhere', 'project')
    expect(designatedWorktreeDir('relative/project', SID, { env: noEnv, isPrimaryCheckout: () => true })).toBeNull()
    expect(designatedWorktreeDir(project, 'short', { env: noEnv, isPrimaryCheckout: () => true })).toBeNull()
    expect(designatedWorktreeDir(project, 'bad id with spaces!', { env: noEnv, isPrimaryCheckout: () => true })).toBeNull()
  })

  it('the real isPrimaryCheckout dep: `.git` directory → yes; `.git` file (linked worktree) or none → no', async () => {
    const { nodeDesignateDeps } = await import('../../../src/main/canvas/canvas-worktree')
    const a = tmp('ccc-wt-prim-')
    fs.mkdirSync(path.join(a, '.git'))
    expect(nodeDesignateDeps.isPrimaryCheckout(a)).toBe(true)
    const b = tmp('ccc-wt-linked-')
    fs.writeFileSync(path.join(b, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n')
    expect(nodeDesignateDeps.isPrimaryCheckout(b)).toBe(false)
    const c = tmp('ccc-wt-norepo-')
    expect(nodeDesignateDeps.isPrimaryCheckout(c)).toBe(false)
  })
})
