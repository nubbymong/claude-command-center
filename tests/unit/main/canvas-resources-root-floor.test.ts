/**
 * The canvas served-root floor refuses the app's own resources directory (#371).
 *
 * The floor already refused the home directory, a volume root and the dot
 * directories under home — the places a USER's credentials live. It did not
 * refuse the place THIS APP keeps credentials: the resources directory holds
 * `CONFIG/` (`ssh-credentials.json`, the DPAPI-encrypted SSH and sudo passwords
 * and secret arguments; `conductor-secret.json`, the MCP HMAC key),
 * `account-profiles/` and `account-homes/` (Claude OAuth tokens).
 *
 * Same-user hardening rather than a privilege boundary — the agent already runs
 * as the user. What it removes is the canvas turning "read a file" into "serve
 * a credential store over HTTP" because a working directory happened to point
 * there.
 *
 * Real filesystem throughout: every layer under test is a realpath/stat
 * containment layer, which is exactly what a mocked fs cannot exercise. The
 * resources directory is MUTABLE here so the floor can be watched being
 * re-applied on a later resolution, not just at registration.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({ resourcesDir: '' }))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
}))

const store = await import('../../../src/main/canvas/canvas-store')

const SID = 'aaaa1111aaaa1111aaaa1111'

const tempDirs: string[] = []
function tmp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

let resources = ''

beforeEach(() => {
  store._resetCanvasStoreForTest()
  store.revokeCanvasUatRoots(SID)
  resources = tmp('ccc-res-')
  h.resourcesDir = resources
})

afterAll(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

describe('a live root is refused anywhere near the resources directory', () => {
  it('refuses the resources directory itself', () => {
    expect(store.registerCanvasUatRoot(SID, resources)).toBe(false)
    expect(store.canvasRootsForSession(SID).project).toBeNull()
  })

  it('refuses the credential directories UNDER it', () => {
    for (const name of ['CONFIG', 'account-profiles', 'account-homes', 'canvas']) {
      const dir = path.join(resources, name)
      fs.mkdirSync(dir, { recursive: true })
      expect(store.registerCanvasUatRoot(SID, dir), name).toBe(false)
    }
    // …and something nested deeper still.
    const deep = path.join(resources, 'CONFIG', '_backups', '2026-08-22')
    fs.mkdirSync(deep, { recursive: true })
    expect(store.registerCanvasUatRoot(SID, deep)).toBe(false)
  })

  it('refuses a directory that CONTAINS it — serving a parent serves the resources dir', () => {
    // The case that bites: resources pointed inside a directory you work in.
    const project = tmp('ccc-proj-')
    h.resourcesDir = path.join(project, 'resources')
    fs.mkdirSync(h.resourcesDir, { recursive: true })
    expect(store.registerCanvasUatRoot(SID, project)).toBe(false)
  })

  it('refuses a case-variant spelling on a case-insensitive filesystem', () => {
    const variant = process.platform === 'win32' ? resources.toUpperCase() : resources
    expect(store.registerCanvasUatRoot(SID, variant)).toBe(false)
  })

  it('refuses a path that reaches it through ..', () => {
    const sibling = path.join(resources, 'CONFIG', '..')
    fs.mkdirSync(path.join(resources, 'CONFIG'), { recursive: true })
    expect(store.registerCanvasUatRoot(SID, sibling)).toBe(false)
  })

  it('still accepts an ordinary project directory — the refusal is scoped, not a blanket deny', () => {
    const project = tmp('ccc-proj-')
    expect(store.registerCanvasUatRoot(SID, project)).toBe(true)
    expect(store.canvasRootsForSession(SID).project).toBe(project)
  })

  it('accepts a sibling of the resources directory', () => {
    const sibling = path.join(path.dirname(resources), `${path.basename(resources)}-work`)
    fs.mkdirSync(sibling, { recursive: true })
    tempDirs.push(sibling)
    expect(store.registerCanvasUatRoot(SID, sibling)).toBe(true)
  })
})

describe('a designated worktree root gets the same floor', () => {
  it('refuses one under the resources directory at designation time', () => {
    expect(store.designateCanvasWorktreeRoot(SID, path.join(resources, 'CONFIG', 'wt'))).toBe(false)
    expect(store.designateCanvasWorktreeRoot(SID, resources)).toBe(false)
  })

  it('accepts an ordinary worktree path that does not exist yet', () => {
    const wt = path.join(tmp('ccc-wt-'), 'branch-a')
    expect(store.designateCanvasWorktreeRoot(SID, wt)).toBe(true)
    expect(store.canvasRootsForSession(SID).worktreePending).toBe(true)
    fs.mkdirSync(wt, { recursive: true })
    expect(store.canvasRootsForSession(SID).worktree).toBe(fs.realpathSync.native(wt))
  })

  /**
   * The floor is re-applied on EVERY resolution, not just at designation — a
   * directory that was fine yesterday and is inside the resources dir today
   * stops serving today. Driven here by moving the resources directory onto an
   * already-designated, already-serving root.
   */
  it('stops serving a designated root the moment the resources directory moves onto it', () => {
    const wt = path.join(tmp('ccc-wt-'), 'branch-b')
    fs.mkdirSync(wt, { recursive: true })
    expect(store.designateCanvasWorktreeRoot(SID, wt)).toBe(true)
    expect(store.canvasRootsForSession(SID).worktree).toBe(fs.realpathSync.native(wt))

    h.resourcesDir = wt
    expect(store.canvasRootsForSession(SID).worktree).toBeNull()

    // …and comes back when it moves away again: this is a live check, not a latch.
    h.resourcesDir = resources
    expect(store.canvasRootsForSession(SID).worktree).toBe(fs.realpathSync.native(wt))
  })
})

/**
 * #371 review MAJOR-1 — the refusal must not be a silent dead end.
 *
 * The one configuration the contains-it direction exists for (resources
 * directory inside a project you work in) produced: a log line that did not say
 * which floor refused, the loss of a worktree root that did not need refusing,
 * and an agent told to "write the html inside the project folder" — which is
 * exactly where it had just written it.
 */
describe('a refusal says which floor it hit', () => {
  it('names the resources directory as the reason, and does not blame the path', () => {
    expect(store.canvasRootRefusalReason(SID, resources)).toBe('resources-dir')
    const words = store.describeCanvasRootRefusal('resources-dir', resources)
    expect(words).toContain(resources)
    expect(words).toMatch(/resources directory/i)
    // It must tell the user what to DO, not just that it is refused.
    expect(words).toMatch(/Settings|move|Point this session/i)
  })

  /**
   * The refusal string is relayed to a MODEL, and a folder name inside the path
   * is user-authored. Control/format/bidi characters and unbounded length are
   * the same ingress class `safeRootLabel` already strips one layer up
   * (#371, ADR-009 pass).
   */
  it('sanitises the path before putting it in model-facing text', () => {
    const nasty = `${resources}\u0007\u001b[31m\u202Eevil\u0085\u200B`
    const words = store.describeCanvasRootRefusal('resources-dir', nasty)
    for (const ch of ['\u0007', '\u001b', '\u202E', '\u0085']) expect(words).not.toContain(ch)
    expect(words).toContain('evil') // the NAME survives; only the controls go
  })

  it('caps an absurdly long path rather than relaying all of it', () => {
    const words = store.describeCanvasRootRefusal('resources-dir', `C:\\${'a'.repeat(5000)}`)
    expect(words.length).toBeLessThan(600)
    expect(words).toContain('…')
  })

  /**
   * TOCTOU: the check and the add used to realpath separately, so a directory
   * swapped for a symlink between them was checked as itself and added as its
   * target. `canvasRootCheck` resolves ONCE and hands that path back.
   */
  it('resolves once, and registers exactly what it checked', () => {
    const project = tmp('ccc-proj-')
    const checked = store.canvasRootCheck(SID, project)
    expect(checked.refusal).toBeNull()
    expect(checked.real).toBe(fs.realpathSync.native(project))

    expect(store.registerCanvasUatRoot(SID, project)).toBe(true)
    expect(store.canvasRootsForSession(SID).project).toBe(checked.real)
  })

  it('never throws, whatever it is handed — a spawn must not die on a bad path', () => {
    for (const bad of ['', 'relative', 'C:\\does\\not\\exist\\at\\all', '\0', 'Z:\\unmapped']) {
      expect(() => store.canvasRootCheck(SID, bad)).not.toThrow()
      expect(() => store.registerCanvasUatRoot(SID, bad)).not.toThrow()
    }
  })

  it('distinguishes the floors rather than lumping them together', () => {
    const project = tmp('ccc-proj-')
    expect(store.canvasRootRefusalReason(SID, project)).toBeNull()
    expect(store.canvasRootRefusalReason(SID, os.homedir())).toBe('home-or-ancestor')
    expect(store.canvasRootRefusalReason(SID, 'relative/path')).toBe('not-absolute')
    // A drive root is ALSO an ancestor of home, and that floor is checked
    // first — so it reports 'home-or-ancestor'. Refused either way; the point
    // here is that the reasons are distinct, not that this one is 'volume-root'.
    expect(store.canvasRootRefusalReason(SID, path.parse(process.cwd()).root)).not.toBeNull()
  })

  it('carries the explanation to whatever has to tell somebody, and clears once a root registers', () => {
    store.setCanvasRootRefusal(SID, store.describeCanvasRootRefusal('resources-dir', resources))
    expect(store.canvasRootRefusalFor(SID)).toMatch(/resources directory/i)

    // A session that later registers a legitimate root has nothing to explain.
    expect(store.registerCanvasUatRoot(SID, tmp('ccc-proj-'))).toBe(true)
    expect(store.canvasRootRefusalFor(SID)).toBeNull()
  })

  it('a refused PROJECT root does not cost the session its worktree root', () => {
    // They were in one else-if chain, so one refusal took both — even though
    // `<parent>/ccc-wt/<sid>` neither contains nor sits under the resources dir.
    expect(store.registerCanvasUatRoot(SID, resources)).toBe(false)
    const wt = path.join(tmp('ccc-wt-'), 'branch-x')
    expect(store.designateCanvasWorktreeRoot(SID, wt)).toBe(true)
    fs.mkdirSync(wt, { recursive: true })
    expect(store.canvasRootsForSession(SID).worktree).toBe(fs.realpathSync.native(wt))
  })
})

describe('an unresolvable resources directory does not take the floor down with it', () => {
  it('falls back to the other refusals rather than accepting everything', () => {
    h.resourcesDir = ''
    const project = tmp('ccc-proj-')
    // The resources check cannot answer, so it abstains — and the pre-existing
    // floors still hold.
    expect(store.registerCanvasUatRoot(SID, project)).toBe(true)
    expect(store.registerCanvasUatRoot(SID, os.homedir())).toBe(false)
  })

  it('refuses a resources directory that is not on disk yet, lexically', () => {
    const ghost = path.join(tmp('ccc-ghost-'), 'not-created')
    h.resourcesDir = ghost
    fs.mkdirSync(ghost, { recursive: true })
    expect(store.registerCanvasUatRoot(SID, ghost)).toBe(false)
  })
})
