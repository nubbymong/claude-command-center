// BLOCKER 1 (adversarial review, 2026-08-15) — the canvas served-root
// allowlist. The finding was proven end to end against the real modules: a
// prompt-injected agent read SSH private keys and Claude OAuth tokens through
// it. Four linked defects, one test each here (the read primitive itself is
// the sibling suite, canvas-served-file-guards.test.ts):
//
//   1. no home filter — the raw renderer cwd became a root, and a config whose
//      workingDirectory is '.', empty or stale resolves to the HOME directory,
//      which contains ~/.ssh, ~/.claude and ~/.aws;
//   2. `resume.cwd` is model-controlled — it is read verbatim out of a
//      transcript JSONL the agent can write, so the agent named its own root;
//   3. a FILE could be a root — `~/.ssh/id_rsa` registered as a root is read
//      by resolveInsideCanvasRoot, which treats a root as its own first legal
//      target;
//   4. the root set was global and permanent — one Set for the whole install,
//      no session key, and no production revocation at all.
//
// Real filesystem throughout: every layer under test is a realpath/stat
// containment layer, which is exactly what a mocked fs cannot exercise.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-root-scope-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const { handleCccUxRequest } = await import('../../../src/main/canvas/ccc-ux-protocol')

const SID_A = 'aaaa1111aaaa1111aaaa1111'
const SID_B = 'bbbb2222bbbb2222bbbb2222'

const tempDirs: string[] = []
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Every volume root that exists on this machine: `/` on POSIX, and each mounted
 *  drive letter on Windows (the non-home ones are the interesting half — they
 *  are not ancestors of home, so the #188 check does not reach them). */
function volumeRoots(): string[] {
  if (process.platform !== 'win32') return ['/']
  const out: string[] = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try {
      if (fs.statSync(root).isDirectory()) out.push(root)
    } catch {
      /* no such drive */
    }
  }
  return out
}

/** A project directory with a built dist inside it — the shape a real session
 *  registers: the LAUNCH cwd is the root, `dist/` is what gets served. */
function makeProject(prefix: string): { project: string; dist: string } {
  const project = tmp(prefix)
  const dist = path.join(project, 'dist')
  fs.mkdirSync(dist)
  fs.writeFileSync(path.join(dist, 'index.html'), '<html><head></head><body>app</body></html>')
  return { project, dist }
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// ---------------------------------------------------------------------------
// Defect 1 — the home directory is never a served root
// ---------------------------------------------------------------------------

describe('a home-resolving cwd is refused as a canvas root', () => {
  it('refuses the home directory itself and every ancestor of it', () => {
    const home = os.homedir()
    expect(store.registerCanvasUatRoot(SID_A, home)).toBe(false)

    // Ancestors too: a root ABOVE home contains home, so `~/.ssh` resolves
    // inside it with no '..' and every containment layer says yes.
    let cur = path.dirname(home)
    let checked = 0
    while (checked < 3) {
      expect(store.registerCanvasUatRoot(SID_A, cur)).toBe(false)
      checked++
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    expect(checked).toBeGreaterThan(0)

    // Nothing was registered by any of that, so nothing resolves.
    expect(() => store.resolveInsideCanvasRoot(path.join(home, '.ssh', 'id_rsa'), SID_A)).toThrow(
      /registered canvas root/i,
    )
  })

  it('still accepts an ordinary project directory (not a blanket refusal)', () => {
    // The half that makes the test above meaningful: a guard that refuses
    // everything looks identical to a correct one until this line runs.
    const { project } = makeProject('ccc-root-ok-')
    expect(store.registerCanvasUatRoot(SID_A, project)).toBe(true)
    const file = path.join(project, 'dist', 'index.html')
    expect(store.resolveInsideCanvasRoot(file, SID_A)).toBe(fs.realpathSync.native(file))
  })
})

// ---------------------------------------------------------------------------
// Defect 2 — nothing the model can author reaches the allowlist
//
// This lived here as three assertions over the SOURCE TEXT of pty-manager and
// pty-handlers: "the call is not in the IPC seam", "the call in pty-manager
// reads `registerCanvasUatRoot(sessionId, claudeCwd)`", "no other file contains
// the identifier". All three passed against a build in which the served root
// was STILL transcript-derived — `claudeCwd` is overwritten from
// `resolveResumeLaunch(target).claudeCwd`, i.e. `target.cwd`, i.e. the first
// `cwd` string in an agent-writable JSONL. A grep can see where a call is. It
// cannot see what flows into it, and that was the whole defect.
//
// They are replaced by canvas-root-provenance.test.ts, which drives the real
// `spawnPty` with a poisoned resume target and asks the real store what it will
// serve. No assertion in this repo's canvas suites reads source text any more.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Defect 2b — the store's own floor, independent of any caller
// ---------------------------------------------------------------------------

describe('the store refuses roots no caller should ever ask for', () => {
  it('refuses a dot-directory under home (~/.ssh, ~/.claude, ~/.aws)', () => {
    // The gap the second pass walked through: `isHomeOrAncestor` refuses home
    // and everything ABOVE it, and a credential directory is BELOW it. So the
    // #188 helper says yes to the three directories the attack wanted.
    const home = fs.realpathSync.native(os.homedir())
    const underHome = (p: string): boolean => {
      const rel = path.relative(home, p)
      return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..'
    }
    // The real ones, when this machine actually has them under the home the
    // process sees. (A dotfile dir is commonly a symlink to somewhere else
    // entirely, and a redirected HOME — CCC's own account profiles do exactly
    // that — moves the target out from under it. Asserting on a directory that
    // is not under home would be asserting the wrong thing.)
    let realChecked = 0
    for (const name of ['.ssh', '.claude', '.aws']) {
      const dir = path.join(home, name)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
      if (!underHome(fs.realpathSync.native(dir))) continue
      realChecked++
      expect(store.registerCanvasUatRoot(SID_A, dir), name).toBe(false)
      expect(() => store.resolveInsideCanvasRoot(path.join(dir, 'anything'), SID_A)).toThrow(
        /registered canvas root/i,
      )
    }
    // …and ones created on the spot, so the assertion never depends on what a
    // particular machine happens to have (realChecked can legitimately be 0).
    expect(realChecked).toBeGreaterThanOrEqual(0)
    const made = path.join(home, '.ccc-canvas-root-scoping-probe')
    fs.mkdirSync(made, { recursive: true })
    try {
      expect(store.registerCanvasUatRoot(SID_A, made)).toBe(false)
      // Deep under it too — a project checked out inside a dot-dir is refused.
      const deep = path.join(made, 'nested', 'project')
      fs.mkdirSync(deep, { recursive: true })
      expect(store.registerCanvasUatRoot(SID_A, deep)).toBe(false)
      expect(() => store.resolveInsideCanvasRoot(path.join(deep, 'x.html'), SID_A)).toThrow(
        /registered canvas root/i,
      )
    } finally {
      fs.rmSync(made, { recursive: true, force: true })
    }
  })

  it('accepts an ordinary non-dot directory under home (the refusal is scoped)', () => {
    const home = fs.realpathSync.native(os.homedir())
    const made = path.join(home, 'ccc-canvas-root-scoping-probe-ok')
    fs.mkdirSync(made, { recursive: true })
    try {
      expect(store.registerCanvasUatRoot(SID_A, made)).toBe(true)
    } finally {
      store.revokeCanvasUatRoots(SID_A)
      fs.rmSync(made, { recursive: true, force: true })
    }
  })

  it('refuses every volume root the machine has', () => {
    // Two mechanisms, one observable property. The HOME drive's root is an
    // ancestor of home, so the #188 check already reaches it. Any OTHER drive's
    // root is not — home is not under `D:\` — so the home check waves it
    // through, and it is the whole-disk file server the allowlist exists to
    // prevent. (`C:\Windows` was accepted too; a volume root is the strictly
    // worse version of the same shape, and the one with a name.)
    const roots = volumeRoots()
    expect(roots.length, 'a machine has at least one volume root').toBeGreaterThan(0)
    for (const root of roots) {
      expect(store.registerCanvasUatRoot(SID_A, root), root).toBe(false)
      expect(() => store.resolveInsideCanvasRoot(path.join(root, 'anything'), SID_A)).toThrow(
        /registered canvas root/i,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Defect 3 — a file is not a directory is not a root
// ---------------------------------------------------------------------------

describe('a file cannot be a canvas root', () => {
  it('refuses a file, so registering ~/.ssh/id_rsa cannot serve the key', () => {
    const dir = tmp('ccc-root-file-')
    const key = path.join(dir, 'id_rsa')
    fs.writeFileSync(key, 'PRIVATE-KEY-BYTES')

    expect(store.registerCanvasUatRoot(SID_A, key)).toBe(false)
    // The root IS its own first legal target (`real === base`), so a registered
    // file would have been read by exactly the call the canvas_render htmlPath
    // path makes.
    expect(() => store.resolveInsideCanvasRoot(key, SID_A)).toThrow(/registered canvas root/i)
  })

  it('refuses a path that does not exist at all', () => {
    const dir = tmp('ccc-root-ghost-')
    expect(store.registerCanvasUatRoot(SID_A, path.join(dir, 'nope'))).toBe(false)
  })

  it('refuses a malformed session id', () => {
    const { project } = makeProject('ccc-root-badsid-')
    expect(store.registerCanvasUatRoot('', project)).toBe(false)
    expect(store.registerCanvasUatRoot('has spaces', project)).toBe(false)
    expect(store.registerCanvasUatRoot('a'.repeat(129), project)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Defect 4 — the allowlist is per session, and it is revoked
// ---------------------------------------------------------------------------

describe('roots are scoped to the session that registered them', () => {
  it('session A cannot resolve session B’s root', () => {
    const a = makeProject('ccc-root-a-')
    const b = makeProject('ccc-root-b-')
    fs.writeFileSync(path.join(b.project, 'secret.html'), '<p>B PRIVATE</p>')

    expect(store.registerCanvasUatRoot(SID_A, a.project)).toBe(true)
    expect(store.registerCanvasUatRoot(SID_B, b.project)).toBe(true)

    // Each session reaches its own…
    expect(store.resolveInsideCanvasRoot(path.join(a.dist, 'index.html'), SID_A)).toBeTruthy()
    expect(store.resolveInsideCanvasRoot(path.join(b.project, 'secret.html'), SID_B)).toBeTruthy()
    // …and neither reaches the other's. This is the cross-session read: with a
    // single global Set, every local session on the machine had contributed.
    expect(() => store.resolveInsideCanvasRoot(path.join(b.project, 'secret.html'), SID_A)).toThrow(
      /registered canvas root/i,
    )
    expect(() => store.resolveInsideCanvasRoot(path.join(a.dist, 'index.html'), SID_B)).toThrow(
      /registered canvas root/i,
    )
  })

  it('refuses a SIBLING directory whose name merely starts with the root', () => {
    // Containment is a prefix test, and a prefix test without the separator
    // makes `<root>-evil` look like it is inside `<root>`. Nothing in the suite
    // caught the separator being dropped — with `startsWith(base)` in place of
    // `startsWith(base + path.sep)` every canvas test stayed green (adversarial
    // review of #308), so this is that one assertion.
    const a = makeProject('ccc-root-sibling-')
    const sibling = `${a.project}-evil`
    fs.mkdirSync(sibling, { recursive: true })
    tempDirs.push(sibling)
    fs.writeFileSync(path.join(sibling, 'x.html'), '<p>NOT YOURS</p>')

    expect(store.registerCanvasUatRoot(SID_A, a.project)).toBe(true)
    expect(store.resolveInsideCanvasRoot(path.join(a.dist, 'index.html'), SID_A)).toBeTruthy()
    expect(() => store.resolveInsideCanvasRoot(path.join(sibling, 'x.html'), SID_A)).toThrow(
      /registered canvas root/i,
    )
  })

  it('a session with no roots of its own resolves nothing, however many others have registered', () => {
    // The SSH case: its cwd is remote so it registers nothing, and under the
    // global set it still reached every local project.
    const a = makeProject('ccc-root-ssh-a-')
    store.registerCanvasUatRoot(SID_A, a.project)
    expect(() => store.resolveInsideCanvasRoot(path.join(a.dist, 'index.html'), SID_B)).toThrow(
      /registered canvas root/i,
    )
  })

  it('refuses a UAT render aimed at another session’s root', () => {
    const a = makeProject('ccc-root-render-a-')
    const b = makeProject('ccc-root-render-b-')
    store.registerCanvasUatRoot(SID_A, a.project)
    store.registerCanvasUatRoot(SID_B, b.project)
    expect(() => store.renderVersion(SID_A, { mode: 'uat', distRoot: b.dist })).toThrow(
      /registered canvas UAT root/i,
    )
  })
})

describe('roots are dropped when the session ends', () => {
  it('revokeCanvasUatRoots stops both the htmlPath read and the serve', async () => {
    const a = makeProject('ccc-root-revoke-')
    store.registerCanvasUatRoot(SID_A, a.project)
    const { canvasId } = store.renderVersion(SID_A, { mode: 'uat', distRoot: a.dist })

    // Alive: the version serves.
    expect(store.getServableVersion(canvasId, 'v1')).not.toBeNull()
    expect((await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/index.html`))).status).toBe(200)

    store.revokeCanvasUatRoots(SID_A)

    // Gone: no root, nothing served, nothing read. There was NO production
    // revocation before this — `uatRoots.clear()` existed only in the test seam.
    expect(store.getServableVersion(canvasId, 'v1')).toBeNull()
    expect((await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/index.html`))).status).toBe(404)
    expect(() => store.resolveInsideCanvasRoot(path.join(a.dist, 'index.html'), SID_A)).toThrow(
      /registered canvas root/i,
    )
  })

  it('revoking one session leaves the other untouched', () => {
    const a = makeProject('ccc-root-revoke-a-')
    const b = makeProject('ccc-root-revoke-b-')
    store.registerCanvasUatRoot(SID_A, a.project)
    store.registerCanvasUatRoot(SID_B, b.project)
    store.revokeCanvasUatRoots(SID_A)
    expect(() => store.resolveInsideCanvasRoot(path.join(a.dist, 'index.html'), SID_A)).toThrow()
    expect(store.resolveInsideCanvasRoot(path.join(b.dist, 'index.html'), SID_B)).toBeTruthy()
  })

  it('serves a canvas against its OWNER session’s roots, not the caller’s', async () => {
    // The protocol has no transport session; `getServableVersion` takes the
    // owner from the record. Session B having a root of its own must not make
    // session A's canvas servable once A's roots are gone.
    const a = makeProject('ccc-root-owner-a-')
    const b = makeProject('ccc-root-owner-b-')
    store.registerCanvasUatRoot(SID_A, a.project)
    store.registerCanvasUatRoot(SID_B, b.project)
    const { canvasId } = store.renderVersion(SID_A, { mode: 'uat', distRoot: a.dist })
    store.revokeCanvasUatRoots(SID_A)
    expect((await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/index.html`))).status).toBe(404)
  })
})
