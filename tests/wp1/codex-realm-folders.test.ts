// WP1.28, WP1.30, WP1.45 -- WP2 slice 3d (plan A5; design 5.4, 5.5, 9.3, 12,
// 13): the managed Codex account folders. Canonical roots (a SUBST or mapped
// resources directory), the external home refused on ANY overlap with the
// managed tree -- by canonical path and by file identity -- creation before
// sign-in (real, owner-only folders; links refused), and removal of an
// abandoned setup's folder only after proving it is inside the managed root.
//
// PURE: every filesystem call goes to an in-memory fake with Windows and POSIX
// semantics. No file is written, no process started. The real-filesystem
// counterpart is tests/wp1/codex-realm-isolation.test.ts (CI/VM only).
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import {
  createCodexRealmFolders, createCodexRealmLocks, codexRealmLockKey, resolveCodexRealmRoots, codexRealmHome, codexExternalHomeCandidate,
  createCodexPackage, CODEX_REMOVE_MAX_DEPTH, CODEX_REMOVE_MAX_ENTRIES, CODEX_UNDER_LOCK_LOOKUP_MS,
} from '../../src/main/providers/codex'
import type { CodexRealmFsPort, CodexFsEntry, CodexFolderLookup, CodexRealmRoots } from '../../src/main/providers/codex'
import { packageRegistrationProblem } from '../../src/main/providers/core'

// ---------------------------------------------------------------------------
// An in-memory filesystem.
// ---------------------------------------------------------------------------

type Kind = CodexFsEntry['kind']
/** `hidden`: a directory reparse point lstat reports as a plain folder (a
 *  junction to a volume-GUID path): followed like a link, never reported as one. */
interface Node { kind: Kind; name: string; dev: string; ino: string; mode: number; children?: Map<string, Node>; target?: string; hidden?: boolean }
const err = (code: string) => Object.assign(new Error(code), { code })

class FakeFs implements CodexRealmFsPort {
  readonly api: typeof path
  readonly ops: string[] = []
  private readonly roots = new Map<string, Node>()
  private readonly aliases: Array<[string, string]> = []
  private readonly mirrors: Array<[string, string]> = []
  private ino = 100
  chmodMode: 'ok' | 'ignored' | 'eperm' = 'ok'
  /** Called before each unlink/rmdir with the path. */
  beforeRemove: ((p: string) => void) | null = null
  /** Overrides lstat for one path (a racing change). */
  lstatOverride: ((p: string, real: () => CodexFsEntry) => CodexFsEntry) | null = null
  realpathFails: Map<string, string> = new Map()

  constructor(readonly platform: NodeJS.Platform, readonly trust: string) {
    this.api = platform === 'win32' ? path.win32 : path.posix
  }

  private key(s: string) { return this.platform === 'win32' ? s.toLowerCase() : s }
  private rewrite(s: string, pairs: Array<[string, string]>): { s: string; pair: [string, string] | null } {
    for (const pair of pairs) {
      // `from` and `to` both end in a separator.
      if (this.key(s + this.api.sep).startsWith(this.key(pair[0]))) return { s: pair[1] + s.slice(pair[0].length), pair }
    }
    return { s, pair: null }
  }
  private parts(p: string): { root: string; segs: string[]; mirror: [string, string] | null } {
    const a = this.rewrite(p, this.aliases)
    const m = this.rewrite(a.s, this.mirrors)
    const { root } = this.api.parse(m.s)
    const segs = m.s.slice(root.length).split(/[\\/]+/).filter(Boolean)
    return { root, segs, mirror: m.pair }
  }
  private rootNode(root: string): Node {
    let n = this.roots.get(this.key(root))
    if (!n) { n = { kind: 'dir', name: root, dev: `vol-${this.key(root)}`, ino: String(this.ino++), mode: 0o755, children: new Map() }; this.roots.set(this.key(root), n) }
    return n
  }
  /** The chain of folders a path resolves through, kernel-style: `..` is
   *  the parent of where a link led, not of the link's own name. */
  private resolve(p: string, followLast: boolean, hops: number): Array<{ node: Node; canon: string }> {
    if (hops > 40) throw err('ELOOP')
    const failing = [...this.realpathFails.entries()].find(([k]) => this.key(k) === this.key(p))
    if (failing) throw err(failing[1])
    const { root, segs } = this.parts(p)
    let stack: Array<{ node: Node; canon: string }> = [{ node: this.rootNode(root), canon: root }]
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] === '.') continue
      if (segs[i] === '..') { if (stack.length > 1) stack.pop(); continue }
      const top = stack[stack.length - 1]
      if (top.node.kind !== 'dir') throw err('ENOTDIR')
      const child = top.node.children!.get(this.key(segs[i]))
      if (!child) throw err('ENOENT')
      const follow = i < segs.length - 1 || followLast
      if ((child.kind === 'link' || child.hidden) && follow) stack = this.resolve(child.target!, true, hops + 1)
      else stack.push({ node: child, canon: this.api.join(top.canon, child.name) })
    }
    return stack
  }
  private walk(p: string, followLast: boolean): { node: Node; canonical: string } {
    const stack = this.resolve(p, followLast, 0)
    const top = stack[stack.length - 1]
    // A mirrored spelling resolves to the same folders but reports its own
    // spelling, as realpath does for \\localhost\C$.
    const { mirror } = this.parts(p)
    let canonical = top.canon
    if (mirror && this.key(canonical + this.api.sep).startsWith(this.key(mirror[1]))) canonical = mirror[0] + canonical.slice(mirror[1].length)
    return { node: top.node, canonical }
  }
  private entry(n: Node): CodexFsEntry { return { kind: n.kind, dev: n.dev, ino: n.ino, mode: n.mode } }
  private dirOf(p: string): Node {
    const d = this.walk(this.api.dirname(p), true).node
    if (d.kind !== 'dir') throw err('ENOTDIR')
    return d
  }

  // -- building the world ---------------------------------------------------
  alias(from: string, to: string) { this.aliases.push([from, to]) }
  mirror(from: string, to: string) { this.mirrors.push([from, to]) }
  add(p: string, kind: Kind, extra: Partial<Node> = {}): Node {
    const parent = this.mkdirp(this.api.dirname(p))
    const name = this.api.basename(p)
    const n: Node = { kind, name, dev: parent.dev, ino: String(this.ino++), mode: kind === 'dir' ? 0o755 : 0o644, ...(kind === 'dir' ? { children: new Map() } : {}), ...extra }
    parent.children!.set(this.key(name), n)
    return n
  }
  dir(p: string, extra: Partial<Node> = {}) { return this.add(p, 'dir', extra) }
  file(p: string) { return this.add(p, 'file') }
  link(p: string, target: string) { return this.add(p, 'link', { target }) }
  node(p: string): Node { return this.walk(p, false).node }
  exists(p: string): boolean { try { this.walk(p, false); return true } catch { return false } }
  private mkdirp(p: string): Node {
    const { root, segs } = this.parts(p)
    let node = this.rootNode(root)
    let at = root
    for (const s of segs) {
      at = this.api.join(at, s)
      let child = node.children!.get(this.key(s))
      if (!child) { child = { kind: 'dir', name: s, dev: node.dev, ino: String(this.ino++), mode: 0o755, children: new Map() }; node.children!.set(this.key(s), child) }
      if (child.kind === 'link') child = this.walk(at, true).node
      if (child.kind !== 'dir') throw err('EEXIST')
      node = child
    }
    return node
  }

  // -- the port -------------------------------------------------------------
  realpath(p: string): string { return this.walk(p, true).canonical }
  lstat(p: string): CodexFsEntry {
    const real = () => this.entry(this.walk(p, false).node)
    return this.lstatOverride ? this.lstatOverride(p, real) : real()
  }
  mkdirSecure(dir: string): void {
    this.ops.push(`mkdirSecure ${dir}`)
    this.mkdirp(dir)
    const under = this.key(dir).startsWith(this.key(this.trust) + this.api.sep)
    const stop = under ? this.trust : this.api.dirname(dir)
    let cur = dir
    while (this.key(cur) !== this.key(stop)) {
      if (this.walk(cur, false).node.kind === 'link') throw new Error(`refusing to write credentials: ${cur} is a reparse point`)
      const up = this.api.dirname(cur)
      if (up === cur) break
      cur = up
    }
  }
  mkdir(dir: string, mode: number): void {
    this.ops.push(`mkdir ${dir} ${mode.toString(8)}`)
    const parent = this.dirOf(dir)
    const name = this.api.basename(dir)
    if (parent.children!.has(this.key(name))) throw err('EEXIST')
    parent.children!.set(this.key(name), { kind: 'dir', name, dev: parent.dev, ino: String(this.ino++), mode, children: new Map() })
  }
  chmod(p: string, mode: number): void {
    this.ops.push(`chmod ${p} ${mode.toString(8)}`)
    if (this.chmodMode === 'eperm') throw err('EPERM')
    const n = this.walk(p, true).node
    if (this.chmodMode === 'ok') n.mode = mode
  }
  readdir(dir: string): string[] {
    const n = this.walk(dir, true).node
    if (n.kind !== 'dir') throw err('ENOTDIR')
    return [...n.children!.values()].map((c) => c.name)
  }
  unlink(p: string): void {
    this.beforeRemove?.(p)
    this.ops.push(`unlink ${p}`)
    const parent = this.dirOf(p)
    const c = parent.children!.get(this.key(this.api.basename(p)))
    if (!c) throw err('ENOENT')
    if (c.kind === 'dir') throw err('EPERM')
    parent.children!.delete(this.key(this.api.basename(p)))
  }
  rmdir(p: string): void {
    this.beforeRemove?.(p)
    this.ops.push(`rmdir ${p}`)
    const parent = this.dirOf(p)
    const c = parent.children!.get(this.key(this.api.basename(p)))
    if (!c) throw err('ENOENT')
    if (c.kind !== 'dir') throw err('ENOTDIR')
    if (c.children!.size) throw err('ENOTEMPTY')
    parent.children!.delete(this.key(this.api.basename(p)))
  }
}

// ---------------------------------------------------------------------------
// The world: a resources directory, a user home and a registry of realms.
// ---------------------------------------------------------------------------

const hex = (c: string) => c.repeat(16)
const RA = `realm-${hex('a')}`
const RB = `realm-${hex('b')}`
const RX = `realm-${hex('e')}`
type RealmRecord = Extract<CodexFolderLookup, { ok: true }>['realm']
const managed = (id: string, lifecycle: RealmRecord['lifecycle'] = 'pending'): RealmRecord => ({ id, providerId: 'codex', kind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${id}`, lifecycle })
const external = (id: string): RealmRecord => ({ id, providerId: 'codex', kind: 'codex-home', ownership: 'external-default', pathRef: 'external-default', lifecycle: 'active' })

interface WorldOpts { platform?: NodeJS.Platform; configured?: string; env?: Record<string, string> }
function world(o: WorldOpts = {}) {
  const platform = o.platform ?? 'win32'
  const win = platform === 'win32'
  const RES = win ? 'C:\\data\\res' : '/data/res'
  const USER = win ? 'C:\\Users\\u' : '/home/u'
  const configured = o.configured ?? RES
  const fs = new FakeFs(platform, configured)
  fs.dir(RES)
  fs.dir(USER)
  const api = fs.api
  const ROOT = api.join(RES, 'codex-realms')
  const home = (id: string) => api.join(ROOT, id)
  const realms = new Map<string, RealmRecord>([[RA, managed(RA)], [RB, managed(RB)], [RX, external(RX)]])
  let lookups = 0
  const env = o.env ?? {}
  const lookupRealm = async (ref: { authRealmId: string }): Promise<CodexFolderLookup> => {
    lookups++
    const realm = realms.get(ref.authRealmId)
    if (!realm) return { ok: false }
    const r = resolveCodexRealmRoots({ resourcesDir: configured, env, homeDir: USER }, fs)
    return r.ok ? { ok: true, realm, roots: r.roots } : { ok: false }
  }
  const locks = createCodexRealmLocks()
  const folders = createCodexRealmFolders({ lookupRealm, fs, locks })
  const roots = () => resolveCodexRealmRoots({ resourcesDir: configured, env, homeDir: USER }, fs)
  return { fs, api, RES, USER, ROOT, home, realms, folders, locks, roots, lookupRealm, lookups: () => lookups, win }
}

const A = { authRealmId: RA }
const B = { authRealmId: RB }
const X = { authRealmId: RX }
const mutating = (ops: string[]) => ops.filter((o) => /^(mkdirSecure|mkdir|chmod|unlink|rmdir) /.test(o))

// ---------------------------------------------------------------------------

describe('canonical roots', () => {
  it('the resources directory is canonicalised: a SUBST or mapped drive resolves to the underlying path', () => {
    const w = world({ configured: 'S:\\res' })
    w.fs.alias('S:\\', 'C:\\data\\')
    const r = w.roots()
    expect(r).toMatchObject({ ok: true, roots: { resourcesDir: 'C:\\data\\res' } })
  })

  it('a resources directory that is missing, a file or not fully qualified is unavailable', () => {
    for (const configured of ['C:\\nope', 'res', '\\res']) {
      expect(world({ configured }).roots().ok, configured).toBe(false)
    }
    const w = world({ configured: 'C:\\data\\f' })
    w.fs.file('C:\\data\\f')
    expect(w.roots().ok).toBe(false)
  })

  it('the external home is CODEX_HOME, else ~/.codex, canonicalised; one not made yet is null, never a guess', () => {
    const w = world()
    const r0 = w.roots()
    expect(r0).toMatchObject({ ok: true, roots: { externalDefaultHome: null } })
    expect(r0.ok && r0.roots.externalConflict).toBeFalsy()
    w.fs.dir('C:\\Users\\u\\.codex')
    expect(w.roots()).toMatchObject({ ok: true, roots: { externalDefaultHome: 'C:\\Users\\u\\.codex' } })
    const v = world({ env: { CODEX_HOME: 'D:\\codex' } })
    v.fs.dir('E:\\real\\codex')
    v.fs.alias('D:\\', 'E:\\real\\')
    expect(v.roots()).toMatchObject({ ok: true, roots: { externalDefaultHome: 'E:\\real\\codex' } })
  })

  it('an external home the app cannot check -- unresolvable, relative, drive- or root-relative, ambiguous -- counts as an overlap', () => {
    const u = world({ env: { CODEX_HOME: 'Z:\\share\\codex' } })
    u.fs.realpathFails.set('Z:\\share\\codex', 'EACCES')
    expect(conflicted(u)).toMatchObject({ externalDefaultHome: null, externalConflict: true })
    for (const v of ['codex', '.\\codex', 'C:codex', '\\data\\res\\codex-realms', '~\\.codex', ' C:\\x']) {
      expect(conflicted(world({ env: { CODEX_HOME: v } })), JSON.stringify(v)).toMatchObject({ externalConflict: true })
    }
    expect(conflicted(world({ env: { CODEX_HOME: 'C:\\a', codex_home: 'C:\\b' } }))).toMatchObject({ externalConflict: true })
    for (const v of ['relative', '~/x', ' /opt/codex']) {
      expect(conflicted(world({ platform: 'linux', env: { CODEX_HOME: v } })), JSON.stringify(v)).toMatchObject({ externalConflict: true })
    }
    // Empty is unset, as the CLI treats it.
    const e = conflicted(world({ env: { CODEX_HOME: '' } }))
    expect(e.externalConflict).toBeFalsy()
  })

  it('a Windows device or verbatim spelling of the managed tree (\\\\.\\C:\\, \\\\?\\UNC\\) is canonicalised and refused, and nothing under it is removed', async () => {
    for (const spelling of [`\\\\.\\C:\\data\\res\\codex-realms\\${RA}`, `\\\\?\\UNC\\localhost\\C$\\data\\res\\codex-realms\\${RA}`, `\\\\?\\C:\\data\\res\\codex-realms`]) {
      const w = world({ env: { CODEX_HOME: spelling } })
      w.fs.alias('\\\\.\\C:\\', 'C:\\')
      w.fs.alias('\\\\?\\UNC\\localhost\\C$\\', 'C:\\')
      w.fs.alias('\\\\?\\C:\\', 'C:\\')
      w.fs.dir(w.home(RA))
      w.fs.file(w.api.join(w.home(RA), 'config.toml'))
      expect(conflicted(w), spelling).toMatchObject({ externalConflict: true })
      expect(await w.folders.remove(A, { contents: 'all' }), spelling).toMatchObject({ ok: false, code: 'overlaps-external' })
      expect(w.fs.exists(w.api.join(w.home(RA), 'config.toml')), spelling).toBe(true)
    }
  })

  it('POSIX: `..` after a link is resolved the kernel\'s way, not by text', () => {
    const w = world({ platform: 'linux', env: { CODEX_HOME: '/home/u/link/../codex-realms' } })
    w.fs.dir('/data/res/x')
    w.fs.link('/home/u/link', '/data/res/x')
    // By text this is /home/u/codex-realms; the kernel lands in /data/res/codex-realms.
    w.fs.dir('/home/u/codex-realms')
    expect(conflicted(w)).toMatchObject({ externalDefaultHome: null, externalConflict: true })
  })

  it('Windows: a resources directory whose canonical path has a name ending in a dot or a space is unavailable', () => {
    for (const bad of ['C:\\data\\res.', 'C:\\data.\\res', 'C:\\data\\res ']) {
      const w = world({ configured: bad })
      w.fs.dir(bad)
      expect(w.roots().ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('a relative resources directory is refused even when the port would resolve it', () => {
    const w = world()
    const realpath = w.fs.realpath.bind(w.fs)
    w.fs.realpath = (p) => (p === 'res' ? w.RES : realpath(p))
    expect(resolveCodexRealmRoots({ resourcesDir: 'res', env: {}, homeDir: w.USER }, w.fs).ok).toBe(false)
  })

  const conflicted = (w: ReturnType<typeof world>) => {
    const r = w.roots()
    expect(r.ok).toBe(true)
    return r.ok ? r.roots : ({} as CodexRealmRoots)
  }

  it('an external home that IS the managed root, spelled another way (an 8.3 name, a loopback share), is an overlap by file identity', () => {
    const w = world({ env: { CODEX_HOME: 'C:\\DATA~1\\res\\codex-realms' } })
    w.fs.dir(w.ROOT)
    // A second spelling of the same folder: same identity, a different string.
    const same = w.fs.node(w.ROOT)
    w.fs.dir('C:\\DATA~1\\res\\codex-realms', { dev: same.dev, ino: same.ino })
    const roots = conflicted(w)
    expect(roots).toMatchObject({ externalDefaultHome: null, externalConflict: true })
  })

  it('an external home inside a managed home, reached through an alias, is an overlap', () => {
    const w = world({ env: { CODEX_HOME: 'Q:\\x' } })
    w.fs.dir(w.home(RA))
    w.fs.dir(w.api.join(w.home(RA), 'x'))
    w.fs.alias('Q:\\', `${w.home(RA)}\\`)
    expect(conflicted(w)).toMatchObject({ externalDefaultHome: null, externalConflict: true })
  })

  it('a managed root inside the external home (CODEX_HOME above the resources directory) is an overlap, by path and by identity', () => {
    expect(conflicted(world({ env: { CODEX_HOME: 'C:\\data' } }))).toMatchObject({ externalConflict: true })
    const w = world({ env: { CODEX_HOME: 'C:\\DAT~1' } })
    const data = w.fs.node('C:\\data')
    w.fs.dir('C:\\DAT~1', { dev: data.dev, ino: data.ino })
    expect(conflicted(w)).toMatchObject({ externalDefaultHome: null, externalConflict: true })
  })

  it('an external home with the identity of one managed home (a bind mount) is an overlap', () => {
    const w = world({ env: { CODEX_HOME: 'C:\\elsewhere\\codex' } })
    const ext = w.fs.dir('C:\\elsewhere\\codex')
    w.fs.dir(w.home(RB), { dev: ext.dev, ino: ext.ino })
    expect(conflicted(w)).toMatchObject({ externalConflict: true })
  })

  it('an external home that does not exist yet but would land in the managed tree is an overlap', () => {
    const w = world({ env: { CODEX_HOME: 'S:\\res\\codex-realms\\mine' } })
    w.fs.alias('S:\\', 'C:\\data\\')
    expect(conflicted(w)).toMatchObject({ externalConflict: true })
    expect(conflicted(world({ env: { CODEX_HOME: 'C:\\data\\res\\codex-realms\\x' } }))).toMatchObject({ externalConflict: true })
  })

  it('an external home that does not exist yet, whose nearest existing folder IS the managed root by identity (a loopback share), is an overlap', () => {
    const w = world({ env: { CODEX_HOME: 'L:\\res\\codex-realms\\mine' } })
    w.fs.dir(w.ROOT)
    const same = w.fs.node(w.ROOT)
    // realpath answers the share's own spelling, as it does for \\localhost\C$.
    w.fs.dir('L:\\res\\codex-realms', { dev: same.dev, ino: same.ino })
    expect(conflicted(w)).toMatchObject({ externalDefaultHome: null, externalConflict: true })
    // The same shape one level down: inside a managed home.
    const v = world({ env: { CODEX_HOME: 'L:\\h\\x' } })
    const h = v.fs.dir(v.home(RA))
    v.fs.dir('L:\\h', { dev: h.dev, ino: h.ino })
    expect(conflicted(v)).toMatchObject({ externalConflict: true })
  })

  it('a file system without file ids falls back to paths and raises no false overlap', () => {
    const w = world({ env: { CODEX_HOME: 'C:\\Users\\u\\.codex' } })
    w.fs.dir('C:\\Users\\u\\.codex', { ino: '0' })
    w.fs.dir(w.ROOT, { ino: '0' })
    expect(conflicted(w)).toMatchObject({ externalDefaultHome: 'C:\\Users\\u\\.codex' })
    expect(conflicted(w).externalConflict).toBeFalsy()
  })

  it('while they overlap, every Codex realm is unavailable -- managed ones too', () => {
    const roots = { resourcesDir: 'C:\\data\\res', externalDefaultHome: null, externalConflict: true }
    expect(codexRealmHome(managed(RA), roots, path.win32)).toMatchObject({ ok: false })
    expect(codexRealmHome(external(RX), roots, path.win32)).toMatchObject({ ok: false })
    expect(codexRealmHome(managed(RA), { ...roots, externalConflict: false }, path.win32)).toMatchObject({ ok: true })
  })

  it('POSIX: the same rules with case-sensitive paths', () => {
    const w = world({ platform: 'linux', env: { CODEX_HOME: '/data/res/codex-realms/x' } })
    expect(w.roots()).toMatchObject({ ok: true, roots: { resourcesDir: '/data/res', externalConflict: true } })
    const v = world({ platform: 'linux' })
    v.fs.dir('/home/u/.codex')
    expect(v.roots()).toMatchObject({ ok: true, roots: { externalDefaultHome: '/home/u/.codex' } })
  })

  it('a throwing port never escapes', () => {
    const w = world()
    w.fs.realpathFails.set('C:\\data\\res', 'EIO')
    expect(w.roots()).toEqual({ ok: false, message: 'the resources directory is not available' })
  })
})

describe('creating a managed folder before sign-in', () => {
  it('POSIX: creates the managed root and the home as real, owner-only (0700) folders', async () => {
    const w = world({ platform: 'linux' })
    expect(await w.folders.prepare(A)).toEqual({ ok: true, created: true })
    expect(w.fs.node(w.ROOT)).toMatchObject({ kind: 'dir', mode: 0o700 })
    expect(w.fs.node(w.home(RA))).toMatchObject({ kind: 'dir', mode: 0o700 })
    expect(w.fs.ops).toContain(`mkdir ${w.home(RA)} 700`)
  })

  it('a second prepare re-verifies the folder an earlier attempt left, and restores its privacy', async () => {
    const w = world({ platform: 'linux' })
    await w.folders.prepare(A)
    w.fs.node(w.home(RA)).mode = 0o755
    w.fs.file(w.api.join(w.home(RA), 'config.toml'))
    expect(await w.folders.prepare(A)).toEqual({ ok: true, created: false })
    expect(w.fs.node(w.home(RA)).mode).toBe(0o700)
  })

  it('Windows: creates the folders and makes no permission change at all (ACL hardening is deferred, #103)', async () => {
    const w = world()
    expect(await w.folders.prepare(A)).toEqual({ ok: true, created: true })
    expect(w.fs.node(w.home(RA)).kind).toBe('dir')
    expect(w.fs.ops.filter((o) => o.startsWith('chmod'))).toEqual([])
  })

  it('a SUBST resources directory yields the home at its canonical path', async () => {
    const w = world({ configured: 'S:\\res' })
    w.fs.alias('S:\\', 'C:\\data\\')
    expect(await w.folders.prepare(A)).toMatchObject({ ok: true })
    expect(w.fs.ops).toContain(`mkdir C:\\data\\res\\codex-realms\\${RA} 700`)
  })

  it('only a pending, app-managed Codex realm: external, active, retired, unknown, wrong-provider or lifecycle-less records are refused, and nothing is made', async () => {
    const w = world()
    w.realms.set(RB, managed(RB, 'active'))
    expect(await w.folders.prepare(X)).toMatchObject({ ok: false, code: 'not-managed' })
    expect(await w.folders.prepare(B)).toMatchObject({ ok: false, code: 'lifecycle' })
    for (const lifecycle of ['retired', 'retiring', 'recovery', undefined] as const) {
      w.realms.set(RB, { ...managed(RB), lifecycle })
      expect(await w.folders.prepare(B), String(lifecycle)).toMatchObject({ ok: false, code: 'lifecycle' })
    }
    expect(await w.folders.prepare({ authRealmId: `realm-${hex('f')}` })).toMatchObject({ ok: false, code: 'realm-unavailable' })
    // Active, so a missing provider check would answer 'lifecycle' instead.
    w.realms.set(RB, { ...managed(RB, 'active'), providerId: 'claude' as never })
    expect(await w.folders.prepare(B)).toMatchObject({ ok: false, code: 'realm-unavailable' })
    w.realms.set(RB, { ...managed(RB), pathRef: `managed:${RA}` })
    expect(await w.folders.prepare(B)).toMatchObject({ ok: false, code: 'realm-unavailable' })
    for (const ref of [null, {}, { authRealmId: 7 }, { authRealmId: '' }]) {
      expect(await w.folders.prepare(ref as never)).toMatchObject({ ok: false, code: 'realm-unavailable' })
    }
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('refused while the external home overlaps the managed tree', async () => {
    const w = world({ env: { CODEX_HOME: 'C:\\data\\res\\codex-realms' } })
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'overlaps-external' })
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('a junction planted as the managed root is refused and nothing is created through it', async () => {
    const w = world()
    w.fs.dir('C:\\attacker')
    w.fs.link(w.ROOT, 'C:\\attacker')
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(w.fs.readdir('C:\\attacker')).toEqual([])
  })

  it('a link planted as the home is refused, never followed', async () => {
    const w = world({ platform: 'linux' })
    w.fs.dir('/home/u/.codex')
    w.fs.dir(w.ROOT)
    w.fs.link(w.home(RA), '/home/u/.codex')
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(w.fs.node('/home/u/.codex').mode).toBe(0o755)
    expect(w.fs.ops.filter((o) => o.startsWith('chmod /home/u/.codex'))).toEqual([])
  })

  it('a resources directory that is no longer at its canonical path is refused', async () => {
    const w = world()
    const folders = createCodexRealmFolders({
      lookupRealm: async () => ({ ok: true, realm: managed(RA), roots: { resourcesDir: 'C:\\DATA~1\\res', externalDefaultHome: null } }),
      fs: w.fs,
      locks: createCodexRealmLocks(),
    })
    w.fs.alias('C:\\DATA~1\\', 'C:\\data\\')
    expect(await folders.prepare(A)).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('a home whose parent is not the managed root by identity is refused, and the folder just made is taken back', async () => {
    const w = world()
    w.fs.lstatOverride = (p, real) => {
      const e = real()
      return p === w.ROOT && w.fs.exists(w.home(RA)) ? { ...e, ino: '999999' } : e
    }
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'unsafe-path' })
    w.fs.lstatOverride = null
    expect(w.fs.exists(w.home(RA))).toBe(false)
  })

  it('POSIX: a folder that cannot be made owner-only is refused, and one just made is taken back', async () => {
    const ignored = world({ platform: 'linux' })
    ignored.fs.chmodMode = 'ignored'
    expect(await ignored.folders.prepare(A)).toMatchObject({ ok: false, code: 'permissions' })
    // The root this call made is taken back with it.
    expect(ignored.fs.exists(ignored.ROOT)).toBe(false)
    const eperm = world({ platform: 'linux' })
    eperm.fs.dir(eperm.ROOT, { mode: 0o700 })
    eperm.fs.chmodMode = 'eperm'
    expect(await eperm.folders.prepare(A)).toMatchObject({ ok: false, code: 'permissions' })
    // The root passed, the home did not: the home goes.
    const late = world({ platform: 'linux' })
    const chmod = late.fs.chmod.bind(late.fs)
    late.fs.chmod = (p, m) => { if (p === late.home(RA)) throw err('EPERM'); chmod(p, m) }
    expect(await late.folders.prepare(A)).toMatchObject({ ok: false, code: 'permissions' })
    expect(late.fs.exists(late.home(RA))).toBe(false)
    // A root that was already there stays, even when taking the home back empties it.
    const kept = world({ platform: 'linux' })
    kept.fs.dir(kept.ROOT, { mode: 0o700 })
    const chmodKept = kept.fs.chmod.bind(kept.fs)
    kept.fs.chmod = (p, m) => { if (p === kept.home(RA)) throw err('EPERM'); chmodKept(p, m) }
    expect(await kept.folders.prepare(A)).toMatchObject({ ok: false, code: 'permissions' })
    expect(kept.fs.exists(kept.home(RA))).toBe(false)
    expect(kept.fs.exists(kept.ROOT)).toBe(true)
  })

  it('an earlier attempt\'s folder is never taken back by a failed re-verify', async () => {
    const w = world({ platform: 'linux' })
    await w.folders.prepare(A)
    w.fs.file(w.api.join(w.home(RA), 'config.toml'))
    w.fs.chmodMode = 'ignored'
    w.fs.node(w.home(RA)).mode = 0o777
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'permissions' })
    expect(w.fs.exists(w.api.join(w.home(RA), 'config.toml'))).toBe(true)
  })

  it('a port that throws anything fails closed with a code; nothing rejects', async () => {
    for (const method of ['realpath', 'lstat', 'mkdirSecure', 'mkdir'] as const) {
      const w = world()
      ;(w.fs as unknown as Record<string, unknown>)[method] = () => { throw 'odd' }
      const r = await w.folders.prepare(A)
      expect(r.ok, method).toBe(false)
      expect(typeof r.code, method).toBe('string')
    }
    const w = world()
    const folders = createCodexRealmFolders({ lookupRealm: async () => { throw new Error('registry gone') }, fs: w.fs, locks: createCodexRealmLocks() })
    expect(await folders.prepare(A)).toMatchObject({ ok: false, code: 'realm-unavailable' })
  })

  it('results are user-safe: no path in any message', async () => {
    const w = world()
    w.fs.dir('C:\\attacker')
    w.fs.link(w.ROOT, 'C:\\attacker')
    const r = await w.folders.prepare(A)
    expect(r.message).toBeTruthy()
    expect(r.message).not.toMatch(/[A-Za-z]:\\|\/data|realm-/)
  })

  it('an external home that names the managed root by a mirrored spelling BEFORE the root exists is caught once prepare has made it, and both folders are taken back', async () => {
    // L:\ is the same folders as C:\data\, but realpath answers L:\... (a loopback share).
    const w = world({ env: { CODEX_HOME: 'L:\\res\\codex-realms' } })
    w.fs.mirror('L:\\', 'C:\\data\\')
    expect(w.roots()).toMatchObject({ ok: true })
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'overlaps-external' })
    expect(w.fs.exists(w.home(RA))).toBe(false)
    expect(w.fs.exists(w.ROOT)).toBe(false)
  })

  it('the post-create check never takes back a root another realm moved into meanwhile', async () => {
    const w = world({ env: { CODEX_HOME: 'L:\\res\\codex-realms' } })
    w.fs.mirror('L:\\', 'C:\\data\\')
    let n = 0
    const folders = createCodexRealmFolders({
      // While the second lookup is in flight, another realm's prepare fills the new root.
      lookupRealm: async (ref) => { if (++n === 2) w.fs.dir(w.home(RB)); return w.lookupRealm(ref) },
      fs: w.fs,
      locks: createCodexRealmLocks(),
    })
    expect(await folders.prepare(A)).toMatchObject({ ok: false, code: 'overlaps-external' })
    expect(w.fs.exists(w.home(RA))).toBe(false)
    expect(w.fs.exists(w.home(RB))).toBe(true)
  })

  it('a home that is another volume mounted at its place is refused', async () => {
    const w = world({ platform: 'linux' })
    w.fs.dir(w.ROOT, { mode: 0o700 })
    w.fs.dir(w.home(RA), { dev: 'usb-volume', mode: 0o700 })
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(w.fs.exists(w.home(RA))).toBe(true)
  })

  it('a record whose id differs from the reference is refused', async () => {
    const w = world()
    const folders = createCodexRealmFolders({ lookupRealm: async () => ({ ok: true, realm: managed(RB), roots: { resourcesDir: w.RES, externalDefaultHome: null } }), fs: w.fs, locks: createCodexRealmLocks() })
    expect(await folders.prepare(A)).toMatchObject({ ok: false, code: 'realm-unavailable' })
    expect(await folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'realm-unavailable' })
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('the overlap is reported before anything else, for every realm, whatever its state', async () => {
    const w = world({ env: { CODEX_HOME: 'C:\\data\\res\\codex-realms' } })
    w.realms.set(RB, managed(RB, 'active'))
    for (const ref of [A, B, X]) {
      expect(await w.folders.prepare(ref)).toMatchObject({ ok: false, code: 'overlaps-external' })
      expect(await w.folders.remove(ref, { contents: 'all' })).toMatchObject({ ok: false, code: 'overlaps-external' })
    }
  })

  it('a failed re-verify never takes back an EMPTY folder an earlier attempt made', async () => {
    const w = world({ platform: 'linux' })
    await w.folders.prepare(A)
    w.fs.chmodMode = 'ignored'
    w.fs.node(w.home(RA)).mode = 0o777
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'permissions' })
    expect(w.fs.exists(w.home(RA))).toBe(true)
    expect(w.fs.exists(w.ROOT)).toBe(true)
  })
})

describe('removing an abandoned setup\'s folder', () => {
  const tree = (w: ReturnType<typeof world>) => {
    const h = w.home(RA)
    w.fs.dir(h)
    w.fs.file(w.api.join(h, 'config.toml'))
    w.fs.dir(w.api.join(h, 'log'))
    w.fs.file(w.api.join(h, 'log', 'codex-tui.log'))
    w.fs.dir(w.api.join(h, 'sessions', '2026', '09'))
    w.fs.file(w.api.join(h, 'sessions', '2026', '09', 'rollout.jsonl'))
    return h
  }

  it('empty-only removes an empty folder and keeps one with anything inside', async () => {
    const w = world()
    w.fs.dir(w.home(RA))
    expect(await w.folders.remove(A, { contents: 'empty-only' })).toEqual({ ok: true, removed: true })
    expect(w.fs.exists(w.home(RA))).toBe(false)
    tree(w)
    expect(await w.folders.remove(A, { contents: 'empty-only' })).toMatchObject({ ok: false, code: 'not-empty' })
    expect(w.fs.exists(w.api.join(w.home(RA), 'config.toml'))).toBe(true)
  })

  it('all removes a plain tree, children first, and touches nothing outside it', async () => {
    const w = world()
    tree(w)
    w.fs.dir(w.home(RB))
    w.fs.file(w.api.join(w.RES, 'keep.json'))
    expect(await w.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
    expect(w.fs.exists(w.home(RA))).toBe(false)
    expect(w.fs.exists(w.home(RB))).toBe(true)
    expect(w.fs.exists(w.api.join(w.RES, 'keep.json'))).toBe(true)
    const removed = mutating(w.fs.ops).map((o) => o.replace(/^\w+ /, ''))
    expect(removed.every((p) => p.startsWith(w.home(RA)))).toBe(true)
    expect(removed[removed.length - 1]).toBe(w.home(RA))
  })

  it('an absent folder is nothing to remove', async () => {
    expect(await world().folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: false })
  })

  it('a link, a junction or a special file anywhere inside refuses the whole removal, and nothing is deleted', async () => {
    for (const plant of ['file-link', 'dir-junction', 'fifo'] as const) {
      const w = world()
      const h = tree(w)
      const victim = w.fs.dir('C:\\Users\\u\\Documents')
      w.fs.file('C:\\Users\\u\\Documents\\thesis.docx')
      const at = w.api.join(h, 'sessions', '2026', 'x')
      if (plant === 'file-link') w.fs.link(at, 'C:\\Users\\u\\Documents\\thesis.docx')
      else if (plant === 'dir-junction') w.fs.link(at, 'C:\\Users\\u\\Documents')
      else w.fs.add(at, 'other')
      expect(await w.folders.remove(A, { contents: 'all' }), plant).toMatchObject({ ok: false, code: 'unsafe-contents' })
      expect(mutating(w.fs.ops), plant).toEqual([])
      expect(victim.children!.size, plant).toBe(1)
    }
  })

  it('another volume mounted inside refuses the removal', async () => {
    const w = world()
    const h = tree(w)
    w.fs.dir(w.api.join(h, 'mnt'), { dev: 'other-volume' })
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-contents' })
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('a tree deeper or larger than the bounds refuses the removal', async () => {
    const deep = world()
    let p = deep.home(RA)
    for (let i = 0; i < CODEX_REMOVE_MAX_DEPTH; i++) p = deep.api.join(p, 'd')
    deep.fs.dir(p)
    expect(await deep.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-contents' })
    const wide = world()
    wide.fs.dir(wide.home(RA))
    for (let i = 0; i <= CODEX_REMOVE_MAX_ENTRIES; i++) wide.fs.file(wide.api.join(wide.home(RA), `f${i}`))
    expect(await wide.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-contents' })
    expect(mutating(wide.fs.ops)).toEqual([])
    // Exactly at the bounds is fine.
    const edge = world()
    let q = edge.home(RA)
    for (let i = 1; i < CODEX_REMOVE_MAX_DEPTH; i++) q = edge.api.join(q, 'd')
    edge.fs.file(edge.api.join(q, 'f'))
    expect(await edge.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
  })

  it('a name the directory listing should never return refuses the removal', async () => {
    for (const bad of ['..', '.', 'a/b', 'a\\b', '', 'x\0y']) {
      const w = world()
      tree(w)
      const readdir = w.fs.readdir.bind(w.fs)
      w.fs.readdir = (d) => (d === w.home(RA) ? [...readdir(d), bad] : readdir(d))
      expect(await w.folders.remove(A, { contents: 'all' }), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'unsafe-contents' })
      expect(mutating(w.fs.ops)).toEqual([])
    }
  })

  it('an entry swapped for a link mid-removal stops it before that entry is touched', async () => {
    const w = world()
    const h = tree(w)
    w.fs.dir('C:\\Users\\u\\Documents')
    const log = w.api.join(h, 'log', 'codex-tui.log')
    let swapped = false
    w.fs.beforeRemove = (p) => {
      if (!swapped) {
        swapped = true
        w.fs.unlink(log)
        w.fs.link(log, 'C:\\Users\\u\\Documents')
      }
      void p
    }
    const r = await w.folders.remove(A, { contents: 'all' })
    w.fs.beforeRemove = null
    expect(r).toMatchObject({ ok: false, code: 'changed' })
    expect(w.fs.exists('C:\\Users\\u\\Documents')).toBe(true)
    expect(w.fs.node(log).kind).toBe('link')
  })

  it('a folder above an entry swapped for a link mid-removal stops it, even where the file system has no file ids', async () => {
    const w = world()
    const h = w.home(RA)
    const noId = { ino: '0' }
    w.fs.dir(h, noId)
    w.fs.file(w.api.join(h, 'a.txt')).ino = '0'
    w.fs.dir(w.api.join(h, 'sessions'), noId)
    w.fs.dir(w.api.join(h, 'sessions', '2026'), noId)
    w.fs.file(w.api.join(h, 'sessions', '2026', 'rollout.jsonl')).ino = '0'
    // A look-alike tree elsewhere, same names, same kinds, no ids.
    w.fs.dir('C:\\victim', noId)
    w.fs.dir('C:\\victim\\2026', noId)
    w.fs.file('C:\\victim\\2026\\rollout.jsonl').ino = '0'
    let swapped = false
    w.fs.beforeRemove = () => {
      if (swapped) return
      swapped = true
      const s = w.fs.node(w.api.join(h, 'sessions'))
      s.children!.clear()
      w.fs.rmdir(w.api.join(h, 'sessions'))
      w.fs.link(w.api.join(h, 'sessions'), 'C:\\victim')
    }
    // Plan order visits a.txt first, so the swap lands before the sessions
    // entries are reached; their grandparent is now a link.
    const readdir = w.fs.readdir.bind(w.fs)
    w.fs.readdir = (d) => readdir(d).sort((a, b) => (a === 'a.txt' ? -1 : b === 'a.txt' ? 1 : 0))
    const r = await w.folders.remove(A, { contents: 'all' })
    w.fs.beforeRemove = null
    expect(r).toMatchObject({ ok: false, code: 'changed' })
    expect(w.fs.exists('C:\\victim\\2026\\rollout.jsonl')).toBe(true)
  })

  it('a home that is a link, or whose root is a link, is refused, and its target is untouched', async () => {
    const w = world({ platform: 'linux' })
    w.fs.dir('/home/u/.codex')
    w.fs.file('/home/u/.codex/auth.json')
    w.fs.dir(w.ROOT)
    w.fs.link(w.home(RA), '/home/u/.codex')
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-path' })
    const v = world({ platform: 'linux' })
    v.fs.dir(`/elsewhere/${RA}`)
    v.fs.file(`/elsewhere/${RA}/auth.json`)
    v.fs.link(v.ROOT, '/elsewhere')
    expect(await v.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-path' })
    for (const x of [w, v]) expect(mutating(x.fs.ops)).toEqual([])
    expect(w.fs.exists('/home/u/.codex/auth.json')).toBe(true)
    expect(v.fs.exists(`/elsewhere/${RA}/auth.json`)).toBe(true)
  })

  it('a home whose parent is not the managed root by identity is refused', async () => {
    const w = world()
    tree(w)
    // The root reads as itself, then its identity changes between the home's
    // own check and the comparison of the home's parent with the root.
    let armed = false
    const realpath = w.fs.realpath.bind(w.fs)
    w.fs.realpath = (p) => { if (p === w.home(RA)) armed = true; return realpath(p) }
    w.fs.lstatOverride = (p, real) => (p === w.ROOT && armed ? { ...real(), ino: '424242' } : real())
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-path' })
    w.fs.lstatOverride = null
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('only a pending setup\'s folder, never an external home, never while the external home overlaps', async () => {
    const w = world()
    tree(w)
    w.fs.dir('C:\\Users\\u\\.codex')
    expect(await w.folders.remove(X, { contents: 'all' })).toMatchObject({ ok: false, code: 'not-managed' })
    for (const lifecycle of ['active', 'retiring', 'retired', 'recovery', undefined] as const) {
      w.realms.set(RA, { ...managed(RA), lifecycle })
      expect(await w.folders.remove(A, { contents: 'all' }), String(lifecycle)).toMatchObject({ ok: false, code: 'lifecycle' })
    }
    const v = world({ env: { CODEX_HOME: `C:\\data\\res\\codex-realms\\${RA}` } })
    tree(v)
    expect(await v.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'overlaps-external' })
    for (const x of [w, v]) expect(mutating(x.fs.ops)).toEqual([])
  })

  it('an unknown contents mode removes nothing', async () => {
    const w = world()
    tree(w)
    for (const opts of [undefined, {}, { contents: 'everything' }, null]) {
      expect(await w.folders.remove(A, opts as never)).toMatchObject({ ok: false })
    }
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('never while a sign-in or sign-out holds the realm: the lock is the folder\'s file identity', async () => {
    const w = world()
    const h = tree(w)
    const id = w.fs.lstat(h)
    const release = w.locks.hold(codexRealmLockKey(w.fs.realpath(h), id.dev, id.ino))!
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'busy' })
    expect(mutating(w.fs.ops)).toEqual([])
    release()
    expect(await w.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
  })

  it('Windows: a read-only file is made writable and removed', async () => {
    const w = world()
    const h = tree(w)
    const ro = w.api.join(h, 'config.toml')
    const unlink = w.fs.unlink.bind(w.fs)
    let tries = 0
    w.fs.unlink = (p) => { if (p === ro && tries++ === 0) throw err('EPERM'); unlink(p) }
    expect(await w.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
    expect(w.fs.ops).toContain(`chmod ${ro} 666`)
  })

  it('POSIX: a file that cannot be unlinked stops the removal with a code (no chmod retry)', async () => {
    const w = world({ platform: 'linux' })
    const h = tree(w)
    const unlink = w.fs.unlink.bind(w.fs)
    w.fs.unlink = (p) => { if (p.endsWith('config.toml')) throw err('EPERM'); unlink(p) }
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'io-failed' })
    expect(w.fs.ops.filter((o) => o.startsWith('chmod'))).toEqual([])
    expect(w.fs.exists(h)).toBe(true)
  })
})

describe('removal: round-1 regressions (ADR-009)', () => {
  const plain = (w: ReturnType<typeof world>) => {
    const h = w.home(RA)
    w.fs.dir(h)
    w.fs.file(w.api.join(h, 'config.toml'))
    w.fs.dir(w.api.join(h, 'log'))
    w.fs.file(w.api.join(h, 'log', 'codex.log'))
    return h
  }

  it('a folder reparse point lstat reports as a plain folder (a junction to a volume-GUID path) refuses the removal at PLANNING, before anything is deleted', async () => {
    const w = world()
    const h = plain(w)
    w.fs.dir('C:\\victim')
    w.fs.file('C:\\victim\\thesis.docx')
    w.fs.dir(w.api.join(h, 'sessions'), { hidden: true, target: 'C:\\victim' })
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-contents' })
    expect(mutating(w.fs.ops)).toEqual([])
    expect(w.fs.exists('C:\\victim\\thesis.docx')).toBe(true)
  })

  it('another volume inside is refused even when the file system reports no file ids', async () => {
    const w = world()
    const h = plain(w)
    w.fs.dir(w.api.join(h, 'mnt'), { dev: 'other-volume', ino: '0' })
    w.fs.file(w.api.join(h, 'mnt', 'x'))
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-contents' })
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('the registry is read again under the lock: a realm committed while the first lookup was in flight is not removed', async () => {
    const w = world()
    plain(w)
    let n = 0
    const folders = createCodexRealmFolders({
      lookupRealm: async (ref) => { if (++n === 2) w.realms.set(RA, managed(RA, 'active')); return w.lookupRealm(ref) },
      fs: w.fs,
      locks: createCodexRealmLocks(),
    })
    expect(await folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(n).toBe(2)
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('a folder replaced while the lock was being taken stops the removal', async () => {
    const w = world()
    plain(w)
    let n = 0
    const folders = createCodexRealmFolders({
      lookupRealm: async (ref) => {
        if (++n === 2) {
          w.fs.node(w.ROOT).children!.delete(RA)
          w.fs.dir(w.home(RA))
        }
        return w.lookupRealm(ref)
      },
      fs: w.fs,
      locks: createCodexRealmLocks(),
    })
    expect(await folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'changed' })
    expect(mutating(w.fs.ops)).toEqual([])
  })

  it('a folder still holding a stored sign-in is refused -- it is signed out through the CLI, never deleted', async () => {
    for (const contents of ['all', 'empty-only'] as const) {
      const w = world()
      const h = plain(w)
      w.fs.file(w.api.join(h, 'auth.json'))
      expect(await w.folders.remove(A, { contents }), contents).toMatchObject({ ok: false, code: 'credentials-present' })
      expect(mutating(w.fs.ops), contents).toEqual([])
    }
    // Anything by that name counts, and so does a check that cannot answer.
    const v = world()
    const h = plain(v)
    v.fs.dir(v.api.join(h, 'auth.json'))
    expect(await v.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'credentials-present' })
    const u = world()
    plain(u)
    u.fs.lstatOverride = (p, real) => { if (p.endsWith('auth.json')) throw err('EACCES'); return real() }
    expect(await u.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'credentials-present' })
  })

  it('a file that appears just before the home itself goes is reported as not empty, and the lock is released', async () => {
    const w = world()
    const h = plain(w)
    w.fs.beforeRemove = (p) => { if (p === h) { w.fs.beforeRemove = null; w.fs.file(w.api.join(h, 'late.log')) } }
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'not-empty' })
    expect(await w.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
  })

  it('a refused empty-only removal releases the lock for the next one', async () => {
    const w = world()
    plain(w)
    expect(await w.folders.remove(A, { contents: 'empty-only' })).toMatchObject({ ok: false, code: 'not-empty' })
    expect(await w.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
  })

  it('an unknown contents mode removes nothing, even from an empty folder', async () => {
    const w = world()
    w.fs.dir(w.home(RA))
    for (const opts of [undefined, {}, { contents: 'everything' }, null, { contents: 'ALL' }]) {
      expect(await w.folders.remove(A, opts as never)).toMatchObject({ ok: false })
    }
    expect(w.fs.exists(w.home(RA))).toBe(true)
  })

  it('a removal that failed midway leaves a folder the next prepare re-verifies and the next removal finishes', async () => {
    const w = world({ platform: 'linux' })
    await w.folders.prepare(A)
    const h = w.home(RA)
    w.fs.file(w.api.join(h, 'a.log'))
    w.fs.file(w.api.join(h, 'b.log'))
    const unlink = w.fs.unlink.bind(w.fs)
    let fails = 1
    w.fs.unlink = (p) => { if (p.endsWith('b.log') && fails-- > 0) throw err('EIO'); unlink(p) }
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'io-failed' })
    expect(await w.folders.prepare(A)).toEqual({ ok: true, created: false })
    expect(await w.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
    expect(w.fs.exists(h)).toBe(false)
  })

  it('the lock key falls back to the canonical path, caselessly, where the file system has no file ids', () => {
    expect(codexRealmLockKey('C:\\Data\\X\\', '5', '0')).toBe('path:c:\\data\\x')
    expect(codexRealmLockKey('C:\\data\\x', '5', '')).toBe(codexRealmLockKey('c:\\DATA\\x', '5', '0'))
    expect(codexRealmLockKey('C:\\data\\x', '5', '77')).toBe('id:5:77')
  })
})

describe('confirmation-round regressions (ADR-009)', () => {
  /** A lookup whose Nth call waits until released, answering what `answer` gives. */
  const gatedLookup = (w: ReturnType<typeof world>, gateAt: number) => {
    let n = 0
    let open: () => void = () => {}
    const gate = new Promise<void>((res) => { open = res })
    let answer: (ref: { authRealmId: string }) => Promise<CodexFolderLookup> = (ref) => w.lookupRealm(ref)
    const lookupRealm = async (ref: { authRealmId: string }) => { if (++n === gateAt) await gate; return answer(ref) }
    return { lookupRealm, release: (a?: typeof answer) => { if (a) answer = a; open() } }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const keyOf = (w: ReturnType<typeof world>, p: string) => { const e = w.fs.lstat(p); return codexRealmLockKey(w.fs.realpath(p), e.dev, e.ino) }

  it('prepare never takes back, after its await, a folder a sign-in now holds', async () => {
    const w = world()
    const g = gatedLookup(w, 2)
    const locks = createCodexRealmLocks()
    const folders = createCodexRealmFolders({ lookupRealm: g.lookupRealm, fs: w.fs, locks })
    const p = folders.prepare(A)
    await tick()
    expect(w.fs.exists(w.home(RA))).toBe(true)
    const signIn = locks.hold(keyOf(w, w.home(RA)))!
    g.release(async () => ({ ok: false }))
    expect(await p).toMatchObject({ ok: false, code: 'realm-unavailable' })
    expect(w.fs.exists(w.home(RA))).toBe(true)
    signIn()
  })

  it('prepare never takes back, after its await, a folder another call removed and made again', async () => {
    const w = world()
    const g = gatedLookup(w, 2)
    const folders = createCodexRealmFolders({ lookupRealm: g.lookupRealm, fs: w.fs, locks: createCodexRealmLocks() })
    const p = folders.prepare(A)
    await tick()
    w.fs.rmdir(w.home(RA))
    w.fs.dir(w.home(RA))
    const again = w.fs.node(w.home(RA))
    g.release(async () => ({ ok: false }))
    expect(await p).toMatchObject({ ok: false })
    expect(w.fs.node(w.home(RA))).toBe(again)
  })

  it('prepare takes back what it made when the second look moves the home', async () => {
    const w = world()
    w.fs.dir('C:\\other')
    const g = gatedLookup(w, 2)
    const folders = createCodexRealmFolders({ lookupRealm: g.lookupRealm, fs: w.fs, locks: createCodexRealmLocks() })
    const p = folders.prepare(A)
    await tick()
    g.release(async () => ({ ok: true, realm: managed(RA), roots: { resourcesDir: 'C:\\other', externalDefaultHome: null } }))
    expect(await p).toMatchObject({ ok: false, code: 'changed' })
    expect(w.fs.exists(w.home(RA))).toBe(false)
    expect(w.fs.exists(w.ROOT)).toBe(false)
  })

  it('a removal whose second look moves the home, or finds it gone, stops without deleting', async () => {
    const w = world()
    w.fs.dir('C:\\other')
    w.fs.dir(w.home(RA))
    w.fs.file(w.api.join(w.home(RA), 'config.toml'))
    const g = gatedLookup(w, 2)
    const folders = createCodexRealmFolders({ lookupRealm: g.lookupRealm, fs: w.fs, locks: createCodexRealmLocks() })
    const r = folders.remove(A, { contents: 'all' })
    g.release(async () => ({ ok: true, realm: managed(RA), roots: { resourcesDir: 'C:\\other', externalDefaultHome: null } }))
    expect(await r).toMatchObject({ ok: false, code: 'changed' })
    expect(mutating(w.fs.ops)).toEqual([])
    const v = world()
    v.fs.dir(v.home(RA))
    const h = gatedLookup(v, 2)
    const vf = createCodexRealmFolders({ lookupRealm: h.lookupRealm, fs: v.fs, locks: createCodexRealmLocks() })
    const q = vf.remove(A, { contents: 'all' })
    await tick()
    v.fs.rmdir(v.home(RA))
    h.release()
    expect(await q).toEqual({ ok: true, removed: false })
  })

  it('a registry answer that never comes under the lock fails the removal and frees the realm', async () => {
    vi.useFakeTimers()
    try {
      const w = world()
      w.fs.dir(w.home(RA))
      const locks = createCodexRealmLocks()
      let n = 0
      const folders = createCodexRealmFolders({
        lookupRealm: async (ref) => (++n === 2 ? new Promise<never>(() => {}) : w.lookupRealm(ref)),
        fs: w.fs,
        locks,
      })
      const r = folders.remove(A, { contents: 'all' })
      await vi.advanceTimersByTimeAsync(CODEX_UNDER_LOCK_LOOKUP_MS - 1)
      expect(locks.hold(keyOf(w, w.home(RA)))).toBeNull()
      await vi.advanceTimersByTimeAsync(2)
      expect(await r).toMatchObject({ ok: false, code: 'io-failed' })
      expect(locks.hold(keyOf(w, w.home(RA)))).not.toBeNull()
      expect(w.fs.exists(w.home(RA))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('status is a reader: many at once and beside a sign-in, never during a removal; a removal never during one', () => {
    const locks = createCodexRealmLocks()
    const r1 = locks.holdReader('k')!
    const r2 = locks.holdReader('k')!
    expect([typeof r1, typeof r2]).toEqual(['function', 'function'])
    expect(locks.holdRemoval('k')).toBeNull()
    const signIn = locks.hold('k')!
    expect(signIn).toBeTruthy()
    r1(); r1()
    expect(locks.holdRemoval('k')).toBeNull()
    r2()
    signIn()
    const removal = locks.holdRemoval('k')!
    expect(removal).toBeTruthy()
    expect(locks.holdReader('k')).toBeNull()
    expect(locks.hold('k')).toBeNull()
    removal()
    expect(locks.holdReader('k')).not.toBeNull()
  })

  it('an entry moved into a replacement folder after planning stops the removal', async () => {
    const w = world()
    const h = w.home(RA)
    w.fs.dir(w.api.join(h, 'log'))
    const moved = w.fs.file(w.api.join(h, 'log', 'codex.log'))
    w.fs.file(w.api.join(h, 'a.txt'))
    const readdir = w.fs.readdir.bind(w.fs)
    w.fs.readdir = (d) => readdir(d).sort((x, y) => (x === 'a.txt' ? -1 : y === 'a.txt' ? 1 : 0))
    let done = false
    w.fs.beforeRemove = () => {
      if (done) return
      done = true
      // Swap the folder for a new real one and move the same file into it.
      w.fs.node(h).children!.delete('log')
      w.fs.dir(w.api.join(h, 'log')).children!.set('codex.log', moved)
    }
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'changed' })
    w.fs.beforeRemove = null
    // Stopped before the moved file, not after it.
    expect(w.fs.exists(w.api.join(h, 'log', 'codex.log'))).toBe(true)
  })

  it('a home replaced just before it goes stops the removal', async () => {
    const w = world()
    const h = w.home(RA)
    w.fs.dir(h)
    w.fs.file(w.api.join(h, 'a.txt'))
    w.fs.beforeRemove = (p) => {
      if (!p.endsWith('a.txt')) return
      w.fs.beforeRemove = null
      w.fs.node(w.ROOT).children!.delete(RA)
      w.fs.dir(h)
      w.fs.file(w.api.join(h, 'a.txt'))
    }
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false })
    expect(w.fs.exists(h)).toBe(true)
  })

  it('an external home spelled with a trailing dot or space (which Win32 drops) is an overlap; a verbatim one is taken as written', () => {
    for (const v of [`C:\\data\\res\\CODEX-~1.\\${RA}`, 'C:\\Users\\u\\cx ', 'C:\\Users\\u.\\x']) {
      expect(conflicted2(world({ env: { CODEX_HOME: v } })), JSON.stringify(v)).toMatchObject({ externalConflict: true })
    }
    expect(codexExternalHomeCandidate({ CODEX_HOME: '\\\\?\\C:\\a.' }, 'C:\\Users\\u', path.win32)).toEqual({ kind: 'path', path: '\\\\?\\C:\\a.' })
    expect(codexExternalHomeCandidate({ CODEX_HOME: 'C:\\a.' }, 'C:\\Users\\u', path.win32)).toEqual({ kind: 'unusable' })
    expect(codexExternalHomeCandidate({}, 'C:\\Users\\u.', path.win32)).toEqual({ kind: 'unusable' })
    // POSIX names may end in a dot.
    expect(codexExternalHomeCandidate({ CODEX_HOME: '/opt/a.' }, '/home/u', path.posix)).toEqual({ kind: 'path', path: '/opt/a.' })
  })

  it('the default home is joined by hand: `..` in HOME stays for the kernel', () => {
    expect(codexExternalHomeCandidate({}, '/home/lnk/..', path.posix)).toEqual({ kind: 'path', path: '/home/lnk/../.codex' })
    expect(codexExternalHomeCandidate({}, '/home/u/', path.posix)).toEqual({ kind: 'path', path: '/home/u/.codex' })
    expect(codexExternalHomeCandidate({}, 'C:\\Users\\u', path.win32)).toEqual({ kind: 'path', path: 'C:\\Users\\u\\.codex' })
    expect(codexExternalHomeCandidate({}, '', path.posix)).toEqual({ kind: 'none' })
  })

  it('no home at all and no CODEX_HOME is no external home and no overlap', () => {
    const w = world()
    const r = resolveCodexRealmRoots({ resourcesDir: w.RES, env: {}, homeDir: '' }, w.fs)
    expect(r).toEqual({ ok: true, roots: { resourcesDir: w.RES, externalDefaultHome: null } })
  })

  it('a CODEX_HOME on a drive or share that is not there is no external home and no overlap; other errors still are', () => {
    const w = world({ env: { CODEX_HOME: 'Z:\\codex' } })
    w.fs.realpathFails.set('Z:\\codex', 'ENOENT')
    w.fs.realpathFails.set('Z:\\', 'ENOENT')
    expect(conflicted2(w)).toEqual({ resourcesDir: w.RES, externalDefaultHome: null })
    const v = world({ env: { CODEX_HOME: 'Z:\\codex' } })
    v.fs.realpathFails.set('Z:\\codex', 'ENOENT')
    v.fs.realpathFails.set('Z:\\', 'EACCES')
    expect(conflicted2(v)).toMatchObject({ externalConflict: true })
  })

  it('a home that is a reparse point lstat reports as a plain folder is refused by its canonical path, for prepare and removal', async () => {
    const w = world()
    w.fs.dir('C:\\victim')
    w.fs.file('C:\\victim\\auth.json')
    w.fs.dir(w.ROOT)
    w.fs.dir(w.home(RA), { hidden: true, target: 'C:\\victim' })
    expect(await w.folders.prepare(A)).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(w.fs.exists('C:\\victim\\auth.json')).toBe(true)
  })

  it('a removal waits for no status run: a reader on the folder makes it busy', async () => {
    const w = world()
    w.fs.dir(w.home(RA))
    const reader = w.locks.holdReader(keyOf(w, w.home(RA)))!
    expect(await w.folders.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'busy' })
    expect(w.fs.exists(w.home(RA))).toBe(true)
    reader()
    expect(await w.folders.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
  })

  it('a device-path CODEX_HOME outside the managed tree is canonicalised and used', () => {
    const w = world({ env: { CODEX_HOME: '\\\\.\\C:\\Users\\u\\.codex' } })
    w.fs.alias('\\\\.\\C:\\', 'C:\\')
    w.fs.dir('C:\\Users\\u\\.codex')
    expect(conflicted2(w)).toEqual({ resourcesDir: w.RES, externalDefaultHome: 'C:\\Users\\u\\.codex' })
  })

  it('a realpath answer that is not a fully qualified path is not trusted, for the resources directory or the external home', () => {
    const w = world({ env: { CODEX_HOME: 'C:\\Users\\u\\.codex' } })
    w.fs.dir('C:\\Users\\u\\.codex')
    const realpath = w.fs.realpath.bind(w.fs)
    w.fs.realpath = (p) => (p === 'C:\\Users\\u\\.codex' ? '\\\\?\\Volume{0}\\codex' : realpath(p))
    expect(conflicted2(w)).toMatchObject({ externalConflict: true })
    const v = world()
    const vRealpath = v.fs.realpath.bind(v.fs)
    v.fs.realpath = (p) => (p === v.RES ? '\\\\?\\Volume{0}\\res' : vRealpath(p))
    // Even where the odd answer names a real folder.
    v.fs.lstatOverride = (p, real) => (p === '\\\\?\\Volume{0}\\res' ? { kind: 'dir', dev: 'v', ino: '5', mode: 0o755 } : real())
    expect(v.roots().ok).toBe(false)
  })

  it('POSIX: a spelling that overlaps by text but resolves elsewhere is still refused', () => {
    const w = world({ platform: 'linux', env: { CODEX_HOME: '/data/res/codex-realms/lnk/..' } })
    w.fs.dir('/elsewhere/deep')
    w.fs.link('/data/res/codex-realms/lnk', '/elsewhere/deep')
    expect(conflicted2(w)).toMatchObject({ externalConflict: true })
  })
})

function conflicted2(w: ReturnType<typeof world>) {
  const r = w.roots()
  expect(r.ok).toBe(true)
  return r.ok ? r.roots : ({} as CodexRealmRoots)
}

describe('the package exposes folder operations only when wired, sharing one lock with sign-in', () => {
  const source = (w: ReturnType<typeof world>) => ({
    lookup: async (ref: { authRealmId: string }) => {
      const realm = w.realms.get(ref.authRealmId)
      return realm ? { ok: true as const, realm: { ...realm, lifecycle: realm.lifecycle ?? 'pending' }, resourcesDir: w.RES } : { ok: false as const }
    },
    mkdirSecure: (dir: string) => w.fs.mkdirSecure(dir),
  })

  it('without the registry source there are no folder operations; with it they register', () => {
    expect(createCodexPackage().realmFolders).toBeUndefined()
    const w = world()
    const pkg = createCodexPackage({ realms: source(w), realmFs: w.fs })
    expect(pkg.realmFolders).toBeDefined()
    expect(packageRegistrationProblem(pkg)).toBeNull()
  })

  it('registration refuses a malformed folder-operations object', () => {
    const w = world()
    const pkg = createCodexPackage({ realms: source(w), realmFs: w.fs })
    expect(packageRegistrationProblem({ ...pkg, realmFolders: { prepare: pkg.realmFolders!.prepare } as never })).toMatch(/realmFolders\.remove/)
    expect(packageRegistrationProblem({ ...pkg, realmFolders: null as never })).toMatch(/realmFolders/)
  })

  it('prepare and remove go through the registry source and the package\'s canonical roots', async () => {
    const w = world({ configured: 'S:\\res' })
    w.fs.alias('S:\\', 'C:\\data\\')
    const pkg = createCodexPackage({ realms: { ...source(w), lookup: async (ref) => ({ ...(await source(w).lookup(ref)), resourcesDir: 'S:\\res' }) as never }, realmFs: w.fs })
    expect(await pkg.realmFolders!.prepare(A)).toEqual({ ok: true, created: true })
    expect(w.fs.exists(`C:\\data\\res\\codex-realms\\${RA}`)).toBe(true)
    expect(await pkg.realmFolders!.remove(A, { contents: 'empty-only' })).toEqual({ ok: true, removed: true })
  })

  /** The package over the fake world, with a proven fake CLI. The realm
   *  identity sign-in keys its lock on is the package's own, read through
   *  the same folder port removal uses. */
  const wired = (w: ReturnType<typeof world>, over: { baseEnv?: () => Promise<Record<string, string>>; run?: (args: string) => Promise<void> } = {}) => {
    const runs: string[] = []
    const pkg = createCodexPackage({
      realms: source(w),
      realmFs: w.fs,
      discoveryDeps: async () => ({
        resolve: () => 'C:\\Tools\\codex.exe', realpath: (p) => p,
        stat: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '2', isFile: true }),
        run: async () => ({ exitCode: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', timedOut: false, truncated: false }),
        env: { SystemRoot: 'C:\\Windows' }, platform: 'win32',
        versionHome: () => ({ home: 'C:\\tmp\\v', dispose: () => {} }), now: () => 1,
      }),
      authPorts: {
        executablePorts: { resolve: () => 'C:\\Tools\\codex.exe', realpath: (p) => p, stat: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '2', isFile: true }), platform: 'win32' },
        baseEnv: over.baseEnv ?? (async () => ({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows' })),
        envFilePresent: () => false,
        run: async (cmd) => {
          const args = cmd.args.join(' ')
          runs.push(args)
          if (args === 'login status') return { exitCode: 1, stdout: '', stderr: 'Not logged in\n', timedOut: false, truncated: false }
          await over.run?.(args)
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false, truncated: false }
        },
      },
    })
    return { pkg, runs }
  }

  it('a folder under a running sign-in is busy for removal', async () => {
    const w = world()
    let finish: () => void = () => {}
    const pending = new Promise<void>((res) => { finish = res })
    const { pkg } = wired(w, { run: () => pending })
    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    expect(await pkg.realmFolders!.prepare(A)).toMatchObject({ ok: true })
    const login = pkg.auth!.login(A, 'device')
    await new Promise((r) => setTimeout(r, 0))
    expect(await pkg.realmFolders!.remove(A, { contents: 'all' })).toMatchObject({ ok: false, code: 'busy' })
    finish()
    expect(await login).toMatchObject({ ok: false })
    expect(await pkg.realmFolders!.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
  })

  it('a sign-in whose folder was removed and re-made while it waited for its environment never runs under the stale lock', async () => {
    const w = world()
    let releaseEnv: () => void = () => {}
    const envGate = new Promise<void>((res) => { releaseEnv = res })
    let gated = true
    const { pkg, runs } = wired(w, {
      baseEnv: async () => { if (gated) { gated = false; await envGate } return { PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows' } },
    })
    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    expect(await pkg.realmFolders!.prepare(A)).toEqual({ ok: true, created: true })
    const login = pkg.auth!.login(A, 'device')
    await new Promise((r) => setTimeout(r, 0))
    // The sign-in holds no lock yet: the folder can go, and come back as a new folder.
    expect(await pkg.realmFolders!.remove(A, { contents: 'empty-only' })).toEqual({ ok: true, removed: true })
    expect(await pkg.realmFolders!.prepare(A)).toEqual({ ok: true, created: true })
    releaseEnv()
    expect(await login).toMatchObject({ ok: false, code: 'realm-unavailable' })
    expect(runs).toEqual([])
    // Nothing is left holding the new folder's lock.
    expect(await pkg.realmFolders!.remove(A, { contents: 'all' })).toEqual({ ok: true, removed: true })
  })

  it('while the inherited CODEX_HOME overlaps the managed tree, sign-in and status refuse with their own code and run nothing', async () => {
    const saved = Object.keys(process.env).filter((k) => k.toUpperCase() === 'CODEX_HOME').map((k) => [k, process.env[k]] as const)
    for (const [k] of saved) delete process.env[k]
    process.env.CODEX_HOME = 'C:\\data\\res\\codex-realms'
    try {
      const w = world()
      const { pkg, runs } = wired(w)
      delete process.env.CODEX_HOME
      expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
      expect(await pkg.auth!.status(A)).toMatchObject({ ok: false, code: 'external-overlap' })
      expect(await pkg.auth!.login(A, 'device')).toMatchObject({ ok: false, code: 'external-overlap' })
      expect(await pkg.auth!.logout(A)).toMatchObject({ ok: false, code: 'external-overlap' })
      expect(await pkg.realmFolders!.prepare(A)).toMatchObject({ ok: false, code: 'overlaps-external' })
      expect(runs).toEqual([])
    } finally {
      delete process.env.CODEX_HOME
      for (const [k, v] of saved) process.env[k] = v
    }
  })
})
