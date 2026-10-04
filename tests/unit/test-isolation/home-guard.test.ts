// [host] Tests and probes never act on a real home.
//
// Covers the guard installed by tests/helpers/home-isolation.ts (setupFiles[0]) and
// its plain-node twin tests/helpers/probe-guard.mjs: the home variables point at an
// isolated folder, and every fs mutation or spawn aimed at a real home throws
// TEST_ISOLATION_VIOLATION, whatever the import form or path spelling.
//
// Every real-home target below is harmless if the guard were missing: deletes and
// renames name a random entry that does not exist, writes and creates go into a
// random folder that does not exist (the call fails ENOENT and creates nothing),
// copies and links read a source that does not exist, and spawns either run
// `node -e 0` or fail on a missing working folder. The API is imported from the
// core module, not from the setup entry, so a config without the setup runs these
// tests unguarded and they fail.
import { afterAll, describe, expect, it } from 'vitest'
import fsDefault from 'fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import * as fsNs from 'node:fs'
import { rm as rmPromise } from 'fs/promises'
import * as fsp from 'node:fs/promises'
import * as cpNs from 'child_process'
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  HOME_VARS,
  MARKER_ENV,
  VIOLATION_CODE,
  createHomeChecker,
  deriveAccountProfilesRoots,
  drainViolations,
  isRealHomePath,
  isolatedProbeEnv,
  isolatedRoot,
  ptyGuarded,
  realHomeRoots,
  reassertHomeEnv,
} from '../../helpers/home-guard-core.mjs'

const WIN = process.platform === 'win32'
const FOLDS = WIN || process.platform === 'darwin'
const PROBE_GUARD = path.resolve(__dirname, '../../helpers/probe-guard.mjs')
const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const requireCjs = createRequire(import.meta.url)
const PTY_LOADS = ((): boolean => {
  try {
    requireCjs('node-pty')
    return true
  } catch {
    return false
  }
})()

// The real home the targets live in: the OS's own answer, which ignores the
// environment, so it is a real home with or without the guard.
const REAL = os.userInfo().homedir
const TAG = randomUUID().slice(0, 8)
let seq = 0

/** A random entry directly in a real home that does not exist. */
function missing(root = REAL): string {
  const p = path.join(root, `.ccc-iso-canary-${TAG}-${seq++}`)
  if (existsSync(p)) throw new Error(`canary unexpectedly exists: ${p}`)
  return p
}
/** A file inside a real-home folder that does not exist: an unguarded write fails ENOENT. */
function inMissing(root = REAL): string {
  return path.join(missing(root), 'f')
}

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'ccc-iso-guard-'))
const NOSRC = path.join(SCRATCH, 'no-such-source')
const NOPARENT = path.join(SCRATCH, 'no-such-folder')
const MIN_ENV = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }
const noop = (): void => {}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

type Recorded = { op: string; target: string; root: string }

/** Quiet whatever an unguarded call handed back (a child, a stream, a promise). */
function settle(result: unknown): void {
  if (!result || typeof result !== 'object') return
  const r = result as { on?: unknown; kill?: unknown; destroy?: unknown; then?: unknown; catch?: unknown }
  if (typeof r.on === 'function') (r.on as (e: string, f: () => void) => void).call(result, 'error', noop)
  if (typeof r.kill === 'function') {
    try {
      ;(r.kill as () => void).call(result)
    } catch {
      /* already gone */
    }
  }
  if (typeof r.destroy === 'function') {
    try {
      ;(r.destroy as () => void).call(result)
    } catch {
      /* already closed */
    }
  }
  if (typeof r.then === 'function' && typeof r.catch === 'function') (r.catch as (f: () => void) => void).call(result, noop)
}

function expectRecorded(op: string): void {
  const recorded = drainViolations() as Recorded[]
  expect(
    recorded.some((v) => v.op === op),
    `recorded ops: ${recorded.map((v) => v.op).join(', ') || '(none)'}`,
  ).toBe(true)
}

function expectRefused(fn: () => unknown, op: string): void {
  let thrown: unknown
  let result: unknown
  try {
    result = fn()
  } catch (e) {
    thrown = e
  }
  settle(result)
  expect((thrown as { code?: string } | undefined)?.code, `${op}: ${String(thrown)}`).toBe(VIOLATION_CODE)
  expectRecorded(op)
}

async function expectRejected(fn: () => Promise<unknown>, op: string): Promise<void> {
  let err: unknown
  try {
    await fn()
  } catch (e) {
    err = e
  }
  expect((err as { code?: string } | undefined)?.code, `${op}: ${String(err)}`).toBe(VIOLATION_CODE)
  expectRecorded(op)
}

function norm(p: string): string {
  const r = path.resolve(p)
  return FOLDS ? r.toLowerCase() : r
}
function inside(p: string | undefined, root: string | undefined): boolean {
  if (!p || !root) return false
  const a = norm(p)
  const b = norm(root)
  return a === b || a.startsWith(b + path.sep)
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
function readEnvFile(file: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) out[WIN ? k.toUpperCase() : k] = v
  return out
}
const PRINT_ENV = 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))'

describe('the home variables point at an isolated folder', () => {
  it('points the six home variables, and os.homedir(), inside the isolated root', () => {
    const iso = isolatedRoot()
    expect(iso, 'no isolated root: the home guard is not installed').toBeTruthy()
    for (const name of HOME_VARS) {
      expect(inside(process.env[name], iso), `${name}=${process.env[name]}`).toBe(true)
      expect(isDir(process.env[name] ?? ''), `${name} folder exists`).toBe(true)
    }
    expect(inside(os.homedir(), iso)).toBe(true)
  })

  it('knows the real home (the OS answer) and protects every captured root, and only those', () => {
    const roots = realHomeRoots()
    expect(roots.map(norm)).toContain(norm(REAL))
    for (const r of roots) expect(isRealHomePath(path.join(r, 'x')), r).toBe(true)
    expect(isRealHomePath(path.join(os.tmpdir(), 'x'))).toBe(false)
    expect(isRealHomePath(path.join(isolatedRoot() ?? REAL, 'home', '.claude', 'x'))).toBe(false)
    expect(isRealHomePath(path.join(PROJECT_ROOT, 'tests', 'x'))).toBe(false)
  })

  it('refuses a write into every captured real root that exists', () => {
    const roots = realHomeRoots().filter(isDir)
    expect(roots.length).toBeGreaterThan(0)
    for (const r of roots) expectRefused(() => writeFileSync(inMissing(r), 'x'), 'fs.writeFileSync')
  })
})

describe('fs deletes and moves aimed at a real home throw', () => {
  const cases: [string, () => unknown][] = [
    ['fs.rmSync', () => fsNs.rmSync(missing())],
    ['fs.rm', () => fsNs.rm(missing(), noop)],
    ['fs.rmdirSync', () => fsNs.rmdirSync(missing())],
    ['fs.rmdir', () => fsNs.rmdir(missing(), noop)],
    ['fs.unlinkSync', () => fsNs.unlinkSync(missing())],
    ['fs.unlink', () => fsNs.unlink(missing(), noop)],
    ['fs.renameSync', () => fsNs.renameSync(missing(), path.join(NOPARENT, 'x'))],
    ['fs.renameSync', () => fsNs.renameSync(NOSRC, inMissing())],
    ['fs.rename', () => fsNs.rename(missing(), path.join(NOPARENT, 'x'), noop)],
  ]
  it.each(cases)('%s', (op, run) => expectRefused(run, op))
})

describe('fs writes and creates aimed at a real home throw', () => {
  const now = new Date()
  const cases: [string, () => unknown][] = [
    ['fs.writeFileSync', () => fsNs.writeFileSync(inMissing(), 'x')],
    ['fs.writeFile', () => fsNs.writeFile(inMissing(), 'x', noop)],
    ['fs.appendFileSync', () => fsNs.appendFileSync(inMissing(), 'x')],
    ['fs.appendFile', () => fsNs.appendFile(inMissing(), 'x', noop)],
    ['fs.mkdirSync', () => fsNs.mkdirSync(inMissing())],
    ['fs.mkdir', () => fsNs.mkdir(inMissing(), noop)],
    ['fs.mkdtempSync', () => fsNs.mkdtempSync(inMissing() + '-')],
    ['fs.mkdtemp', () => fsNs.mkdtemp(inMissing() + '-', noop)],
    ['fs.copyFileSync', () => fsNs.copyFileSync(NOSRC, inMissing())],
    ['fs.copyFile', () => fsNs.copyFile(NOSRC, inMissing(), noop)],
    ['fs.cpSync', () => fsNs.cpSync(NOSRC, inMissing())],
    ['fs.cp', () => fsNs.cp(NOSRC, inMissing(), noop)],
    ['fs.symlinkSync', () => fsNs.symlinkSync(SCRATCH, inMissing())],
    ['fs.symlinkSync target', () => fsNs.symlinkSync(missing(), path.join(NOPARENT, 'link'))],
    ['fs.symlink', () => fsNs.symlink(SCRATCH, inMissing(), noop)],
    ['fs.linkSync', () => fsNs.linkSync(NOSRC, inMissing())],
    // A hard link to a real-home file would make a later write invisible to realpath.
    ['fs.linkSync', () => fsNs.linkSync(missing(), path.join(NOPARENT, 'x'))],
    ['fs.link', () => fsNs.link(NOSRC, inMissing(), noop)],
    ['fs.truncateSync', () => fsNs.truncateSync(missing())],
    ['fs.truncate', () => fsNs.truncate(missing(), noop)],
    ['fs.chmodSync', () => fsNs.chmodSync(missing(), 0o600)],
    ['fs.chmod', () => fsNs.chmod(missing(), 0o600, noop)],
    ['fs.chownSync', () => fsNs.chownSync(missing(), 0, 0)],
    ['fs.lchownSync', () => fsNs.lchownSync(missing(), 0, 0)],
    ['fs.utimesSync', () => fsNs.utimesSync(missing(), now, now)],
    ['fs.utimes', () => fsNs.utimes(missing(), now, now, noop)],
    ['fs.lutimesSync', () => fsNs.lutimesSync(missing(), now, now)],
    ['fs.openSync', () => fsNs.openSync(inMissing(), 'w')],
    ['fs.openSync', () => fsNs.openSync(inMissing(), 'a+')],
    ['fs.openSync', () => fsNs.openSync(inMissing(), fsNs.constants.O_WRONLY | fsNs.constants.O_CREAT)],
    ['fs.open', () => fsNs.open(inMissing(), 'r+', noop)],
    ['fs.createWriteStream', () => fsNs.createWriteStream(inMissing())],
  ]
  it.each(cases)('%s', (op, run) => expectRefused(run, op))

  it('a read-only open is not a mutation and is not refused', () => {
    let code: string | undefined
    try {
      fsNs.closeSync(fsNs.openSync(missing(), 'r'))
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ENOENT')
    expect(drainViolations()).toEqual([])
  })
})

describe('fs.promises deletes, moves, writes and creates aimed at a real home reject', () => {
  const now = new Date()
  const cases: [string, () => Promise<unknown>][] = [
    ['fs.promises.rm', () => fsp.rm(missing())],
    ['fs.promises.rmdir', () => fsp.rmdir(missing())],
    ['fs.promises.unlink', () => fsp.unlink(missing())],
    ['fs.promises.rename', () => fsp.rename(missing(), path.join(NOPARENT, 'x'))],
    ['fs.promises.rename', () => fsp.rename(NOSRC, inMissing())],
    ['fs.promises.writeFile', () => fsp.writeFile(inMissing(), 'x')],
    ['fs.promises.appendFile', () => fsp.appendFile(inMissing(), 'x')],
    ['fs.promises.mkdir', () => fsp.mkdir(inMissing())],
    ['fs.promises.mkdtemp', () => fsp.mkdtemp(inMissing() + '-')],
    ['fs.promises.copyFile', () => fsp.copyFile(NOSRC, inMissing())],
    ['fs.promises.cp', () => fsp.cp(NOSRC, inMissing())],
    ['fs.promises.symlink', () => fsp.symlink(SCRATCH, inMissing())],
    ['fs.promises.symlink target', () => fsp.symlink(missing(), path.join(NOPARENT, 'link'))],
    ['fs.promises.link', () => fsp.link(NOSRC, inMissing())],
    ['fs.promises.truncate', () => fsp.truncate(missing())],
    ['fs.promises.chmod', () => fsp.chmod(missing(), 0o600)],
    ['fs.promises.chown', () => fsp.chown(missing(), 0, 0)],
    ['fs.promises.utimes', () => fsp.utimes(missing(), now, now)],
    ['fs.promises.lutimes', () => fsp.lutimes(missing(), now, now)],
    ['fs.promises.open', () => fsp.open(inMissing(), 'w')],
  ]
  it.each(cases)('%s', (op, run) => expectRejected(run, op))
})

describe('every import form sees the guard', () => {
  it("named import from 'fs'", () => expectRefused(() => rmSync(missing()), 'fs.rmSync'))
  it("namespace import of 'node:fs'", () => expectRefused(() => fsNs.writeFileSync(inMissing(), 'x'), 'fs.writeFileSync'))
  it("default import of 'fs'", () => expectRefused(() => fsDefault.unlinkSync(missing()), 'fs.unlinkSync'))
  it("require('fs')", () => expectRefused(() => (requireCjs('fs') as typeof fsNs).mkdirSync(inMissing()), 'fs.mkdirSync'))
  it("dynamic import('node:fs')", async () => {
    const m = await import('node:fs')
    expectRefused(() => m.rmdirSync(missing()), 'fs.rmdirSync')
  })
  it("named import from 'fs/promises'", () => expectRejected(() => rmPromise(missing()), 'fs.promises.rm'))
  it("namespace import of 'node:fs/promises'", () => expectRejected(() => fsp.writeFile(inMissing(), 'x'), 'fs.promises.writeFile'))
  it('fs.promises on the fs module', () => expectRejected(() => fsNs.promises.unlink(missing()), 'fs.promises.unlink'))
  it("named import from 'node:child_process'", () =>
    expectRefused(() => spawnSync(process.execPath, ['-e', '0'], { cwd: missing() }), 'child_process.spawnSync cwd'))
  it("namespace import of 'child_process'", () =>
    expectRefused(() => cpNs.execFileSync(process.execPath, ['-e', '0'], { cwd: missing() }), 'child_process.execFileSync cwd'))
  it("require('child_process')", () =>
    expectRefused(
      () => (requireCjs('child_process') as typeof cpNs).spawn(process.execPath, ['-e', '0'], { cwd: missing() }),
      'child_process.spawn cwd',
    ))
  it('util.promisify(execFile)', () =>
    expectRejected(() => promisify(execFile)(process.execPath, ['-e', '0'], { cwd: missing() }), 'child_process.execFile cwd'))
  it('util.promisify(exec)', () =>
    expectRejected(() => promisify(exec)(`"${process.execPath}" -e 0`, { cwd: missing() }), 'child_process.exec cwd'))
  it('util.promisify(execFile) still resolves { stdout, stderr } through the guard', async () => {
    const r = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("ok")'])
    expect(r).toEqual({ stdout: 'ok', stderr: '' })
  })
})

describe('path spellings that reach a real home are refused', () => {
  const variants: [string, boolean, () => unknown][] = [
    ['.. from an allowed folder', true, () => SCRATCH + path.sep + path.relative(SCRATCH, inMissing())],
    ['forward slashes', true, () => inMissing().split(path.sep).join('/')],
    ['mixed separators', WIN, () => inMissing().split('\\').map((c, i) => (i ? (i % 2 ? '/' : '\\') + c : c)).join('')],
    ['a Buffer', true, () => Buffer.from(inMissing())],
    ['a file: URL', true, () => pathToFileURL(inMissing())],
    ['another case', FOLDS, () => inMissing().toUpperCase()],
    ['a trailing dot and space on a component', WIN, () => REAL + '. ' + inMissing().slice(REAL.length)],
    ['a \\\\?\\ prefix', WIN, () => '\\\\?\\' + inMissing()],
    ['a \\\\.\\ prefix', WIN, () => '\\\\.\\' + inMissing()],
    ['a stream suffix', WIN, () => inMissing() + ':s'],
  ]
  for (const [label, applies, target] of variants) {
    it.runIf(applies)(label, () => expectRefused(() => writeFileSync(target() as string, 'x'), 'fs.writeFileSync'))
  }
})

describe('spawns that would act on a real home throw', () => {
  it.each<[string, () => unknown]>([
    ['child_process.spawn cwd', () => spawn(process.execPath, ['-e', '0'], { cwd: missing() })],
    ['child_process.spawnSync cwd', () => spawnSync(process.execPath, ['-e', '0'], { cwd: missing() })],
    ['child_process.exec cwd', () => exec(`"${process.execPath}" -e 0`, { cwd: missing() }, noop)],
    ['child_process.execSync cwd', () => execSync(`"${process.execPath}" -e 0`, { cwd: missing(), stdio: 'ignore' })],
    ['child_process.execFile cwd', () => execFile(process.execPath, ['-e', '0'], { cwd: missing() }, noop)],
    ['child_process.execFileSync cwd', () => execFileSync(process.execPath, ['-e', '0'], { cwd: missing(), stdio: 'ignore' })],
    ['child_process.fork cwd', () => fork(path.join(SCRATCH, 'noop.cjs'), [], { cwd: missing(), stdio: 'ignore' })],
  ])('%s', (op, run) => {
    writeFileSync(path.join(SCRATCH, 'noop.cjs'), '')
    expectRefused(run, op)
  })

  it.runIf(PTY_LOADS)('node-pty spawn with a real-home cwd', async () => {
    expect(ptyGuarded()).toBe(true)
    const pty = await import('node-pty')
    expectRefused(() => pty.spawn(process.execPath, ['-e', '0'], { cwd: missing() }), 'node-pty.spawn cwd')
  })

  it.each(HOME_VARS.map((n) => [n]))('an explicit env whose %s is in a real home', (name) => {
    expectRefused(
      () => spawnSync(process.execPath, ['-e', '0'], { env: { ...MIN_ENV, [name]: missing() }, stdio: 'ignore' }),
      `child_process.spawnSync env ${name}`,
    )
  })

  it.runIf(WIN)('a home variable spelled in another case', () => {
    expectRefused(
      () => spawnSync(process.execPath, ['-e', '0'], { env: { ...MIN_ENV, userprofile: missing() }, stdio: 'ignore' }),
      'child_process.spawnSync env USERPROFILE',
    )
  })

  it.runIf(WIN && /^[a-z]:\\/i.test(REAL))('HOMEDRIVE + HOMEPATH naming a real home', () => {
    expectRefused(
      () =>
        spawnSync(process.execPath, ['-e', '0'], {
          env: { ...MIN_ENV, HOMEDRIVE: REAL.slice(0, 2), HOMEPATH: REAL.slice(2) },
          stdio: 'ignore',
        }),
      'child_process.spawnSync env HOMEDRIVE+HOMEPATH',
    )
  })

  it('an inherited env whose HOME a test pointed at a real home', () => {
    const saved = process.env.HOME
    process.env.HOME = REAL
    try {
      expectRefused(() => spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }), 'child_process.spawnSync env HOME')
    } finally {
      process.env.HOME = saved
    }
  })

  it.each<[string, () => string]>([
    ['the real .claude', () => path.join(REAL, '.claude')],
    ['the real .claude.json', () => path.join(REAL, '.claude.json')],
    ['a file in the real .codex', () => path.join(REAL, '.codex', 'auth.json')],
    ['the real credentials file', () => path.join(REAL, '.claude', '.credentials.json')],
    ['the real home itself', () => REAL],
    ['a --name=value option', () => '--settings=' + path.join(REAL, '.claude', 'settings.json')],
    ['a ~ path', () => '~/.claude'],
  ])('an argument naming %s', (_label, arg) => {
    expectRefused(() => spawnSync(process.execPath, ['-e', '0', arg()], { stdio: 'ignore' }), 'child_process.spawnSync argv')
  })

  it('a real-home config path inside a shell command line or an -e script', () => {
    expectRefused(
      () => execSync(`"${process.execPath}" -e 0 "${path.join(REAL, '.claude')}"`, { stdio: 'ignore' }),
      'child_process.execSync argv',
    )
    expectRefused(
      () => spawnSync(process.execPath, ['-e', `void ${JSON.stringify(path.join(REAL, '.codex'))}`], { stdio: 'ignore' }),
      'child_process.spawnSync argv',
    )
  })

  it('an executable that lives under a real home may run (running a binary is not a mutation)', () => {
    const r = spawnSync(path.join(missing(), 'tool.exe'), [], { stdio: 'ignore' })
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')
    expect(drainViolations()).toEqual([])
  })

  it('an argument naming the isolated .claude is fine', () => {
    const r = spawnSync(process.execPath, ['-e', '0', path.join(os.homedir(), '.claude')], { stdio: 'ignore' })
    expect(r.status).toBe(0)
    expect(drainViolations()).toEqual([])
  })
})

describe('a spawn gets the isolated home, never the real one', () => {
  it('an explicit env that omits the home variables gets the isolated ones filled in', () => {
    const out = path.join(isolatedRoot() ?? SCRATCH, `env-${TAG}-explicit.json`)
    const r = spawnSync(process.execPath, ['-e', PRINT_ENV, out], { env: { ...MIN_ENV } })
    expect(r.status, String(r.stderr)).toBe(0)
    const child = readEnvFile(out)
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      expect(inside(child[name], isolatedRoot()), `${name}=${child[name]}`).toBe(true)
    }
    // Unset, they fall back to the (isolated) HOME / USERPROFILE: left unset on purpose.
    expect(child.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(child.CODEX_HOME).toBeUndefined()
  })

  it('an inherited env carries the isolated values', () => {
    const out = path.join(isolatedRoot() ?? SCRATCH, `env-${TAG}-inherited.json`)
    const r = spawnSync(process.execPath, ['-e', PRINT_ENV, out])
    expect(r.status, String(r.stderr)).toBe(0)
    const child = readEnvFile(out)
    for (const name of HOME_VARS) expect(inside(child[name], isolatedRoot()), `${name}=${child[name]}`).toBe(true)
  })
})

describe('refusals are recorded', () => {
  it('a refusal the caller catches is still recorded', () => {
    try {
      writeFileSync(inMissing(), 'x')
    } catch {
      /* caught on purpose */
    }
    const recorded = drainViolations() as Recorded[]
    expect(recorded.map((v) => v.op)).toEqual(['fs.writeFileSync'])
  })

  it.fails('a refusal the code under test swallows still fails its test (shared afterEach)', () => {
    try {
      rmSync(missing())
    } catch {
      /* swallowed on purpose: the shared afterEach must still fail this test */
    }
  })
})

describe('the pure checker (simulated roots, any host)', () => {
  type FakeStat = { isSymbolicLink: () => boolean }
  // A tiny win32-flavoured fake filesystem: folders that exist and links (target strings).
  function fakeFs(dirs: string[], links: Record<string, string> = {}) {
    const key = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    const strip = (t: string): string => t.replace(/^\\\\\?\\/, '').replace(/\\+$/, '')
    const dirSet = new Set(dirs.map(key))
    const linkMap = new Map(Object.entries(links).map(([k, v]) => [key(k), v]))
    const enoent = (): never => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const realpathSync = (p: string): string => {
      const k = key(p)
      for (const [lk, t] of linkMap) {
        if (k === lk) return realpathSync(strip(t))
        if (k.startsWith(lk + '\\')) return realpathSync(strip(t) + p.slice(lk.length))
      }
      return dirSet.has(k) ? p : enoent()
    }
    return {
      lstatSync: (p: string): FakeStat | undefined => {
        if (linkMap.has(key(p))) return { isSymbolicLink: () => true }
        try {
          realpathSync(p)
          return { isSymbolicLink: () => false }
        } catch {
          return undefined
        }
      },
      realpathSync,
      readlinkSync: (p: string): string => {
        const t = linkMap.get(key(p))
        if (t === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
        return t
      },
    }
  }

  const win = createHomeChecker({
    platform: 'win32',
    realRoots: ['C:\\Users\\alice'],
    allowedRoots: [
      { path: 'C:\\Users\\alice\\AppData\\Local\\Temp', kind: 'tmp' },
      { path: 'C:\\Users\\alice\\src\\repo', kind: 'project' },
    ],
    fsImpl: fakeFs([]),
    cwd: () => 'C:\\work',
  })

  it.each<[string, unknown]>([
    ['plain', 'C:\\Users\\alice\\.claude\\x'],
    ['case and separators', 'c:/users/ALICE/.claude/x'],
    ['.. out of the temp folder', 'C:\\Users\\alice\\AppData\\Local\\Temp\\..\\x'],
    ['an all-dots segment read as ..', 'C:\\Users\\alice\\AppData\\Local\\Temp\\...\\x'],
    ['a trailing dot and space', 'C:\\Users\\alice. \\x'],
    ['trailing dots', 'C:\\Users\\alice..\\x'],
    ['a stream on the home folder', 'C:\\Users\\alice:stream'],
    ['a stream on a file', 'C:\\Users\\alice\\x::$DATA'],
    ['\\\\?\\', '\\\\?\\C:\\Users\\alice\\x'],
    ['\\\\.\\', '\\\\.\\C:\\Users\\alice\\x'],
    ['\\??\\', '\\??\\C:\\Users\\alice\\x'],
    ['\\\\?\\UNC admin share', '\\\\?\\UNC\\localhost\\C$\\Users\\alice\\x'],
    ['an admin share by address', '\\\\127.0.0.1\\c$\\users\\alice\\x'],
    ['an unmappable device path', '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x'],
    ['a file: URL string', 'file:///C:/Users/alice/x'],
    ['a file: URL object', new URL('file:///C:/Users/alice/x')],
    ['a Buffer', Buffer.from('C:\\Users\\alice\\x')],
    ['a relative path', '..\\Users\\alice\\x'],
  ])('win32 protects %s', (_label, input) => {
    expect(win.isProtected(input)).toBe(true)
  })

  it.each<[string, string]>([
    ['the temp folder', 'C:\\Users\\alice\\AppData\\Local\\Temp\\x'],
    ['the temp folder spelled with a trailing dot', 'C:\\Users\\alice\\AppData\\Local\\Temp.\\x'],
    ['the project root under the home', 'C:\\Users\\alice\\src\\repo\\tests\\x'],
    ['another user', 'C:\\Users\\bob\\x'],
    ['a name that only starts like the home', 'C:\\Users\\alicex\\y'],
    ['a named pipe', '\\\\.\\pipe\\x'],
    ['another drive', 'D:\\x'],
  ])('win32 allows %s', (_label, input) => {
    expect(win.isProtected(input)).toBe(false)
  })

  it('a link from an allowed folder into a real home is followed (live, dangling, \\\\?\\ junction)', () => {
    const c = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice'],
      allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }],
      fsImpl: fakeFs(['C:\\', 'C:\\Users', 'C:\\Users\\alice', 'C:\\T'], {
        'C:\\T\\link': 'C:\\Users\\alice',
        'C:\\T\\dangling': 'C:\\Users\\alice\\.claude\\new-file',
        'C:\\T\\junction': '\\\\?\\C:\\Users\\alice\\',
      }),
      cwd: () => 'C:\\T',
    })
    expect(c.isProtected('C:\\T\\link\\new\\f')).toBe(true)
    expect(c.isProtected('C:\\T\\dangling')).toBe(true)
    expect(c.isProtected('C:\\T\\junction\\.claude')).toBe(true)
    expect(c.isProtected('C:\\T\\plain\\f')).toBe(false)
  })

  it('the more specific root wins; on a tie temp wins and the project root does not', () => {
    const nested = createHomeChecker({ platform: 'win32', realRoots: ['C:\\T\\cfg'], allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }], fsImpl: fakeFs([]) })
    expect(nested.isProtected('C:\\T\\cfg\\x')).toBe(true)
    expect(nested.isProtected('C:\\T\\y')).toBe(false)
    const tieProject = createHomeChecker({ platform: 'win32', realRoots: ['C:\\R'], allowedRoots: [{ path: 'C:\\R', kind: 'project' }], fsImpl: fakeFs([]) })
    expect(tieProject.isProtected('C:\\R\\x')).toBe(true)
    const tieTmp = createHomeChecker({ platform: 'win32', realRoots: ['C:\\R'], allowedRoots: [{ path: 'C:\\R', kind: 'tmp' }], fsImpl: fakeFs([]) })
    expect(tieTmp.isProtected('C:\\R\\x')).toBe(false)
  })

  it('posix compares case-sensitively, darwin folds case', () => {
    const none = { lstatSync: () => undefined, realpathSync: () => { throw new Error('ENOENT') }, readlinkSync: () => { throw new Error('EINVAL') } }
    const roots = { realRoots: ['/home/bob'], allowedRoots: [{ path: '/tmp', kind: 'tmp' as const }, { path: '/home/bob/work/repo', kind: 'project' as const }], fsImpl: none, cwd: () => '/' }
    const linux = createHomeChecker({ ...roots, platform: 'linux' })
    expect(linux.isProtected('/home/bob/.claude/x')).toBe(true)
    expect(linux.isProtected('/home/bob/work/repo/tests/x')).toBe(false)
    expect(linux.isProtected('/home/bob/work/repo/../../.claude')).toBe(true)
    expect(linux.isProtected('/tmp/x')).toBe(false)
    expect(linux.isProtected('/HOME/bob/x')).toBe(false)
    expect(createHomeChecker({ ...roots, platform: 'darwin' }).isProtected('/HOME/bob/x')).toBe(true)
  })

  it('an argument names a real home configuration only when it is one', () => {
    const c = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice', 'D:\\cfg\\claude', 'E:\\res\\account-profiles'],
      configRoots: ['D:\\cfg\\claude', 'E:\\res\\account-profiles'],
      allowedRoots: [{ path: 'C:\\Users\\alice\\AppData\\Local\\Temp', kind: 'tmp' }],
      fsImpl: fakeFs([]),
      cwd: () => 'C:\\work',
    })
    for (const hit of [
      'C:\\Users\\alice\\.claude',
      'C:\\Users\\alice\\.claude.json',
      'C:\\Users\\alice\\.codex\\auth.json',
      'C:\\Users\\alice',
      'C:\\Users\\alice\\x\\.credentials.json',
      '~/.claude',
      'D:\\cfg\\claude\\settings.json',
      'E:\\res\\account-profiles\\p-1',
    ]) {
      expect(c.configHit(hit), hit).not.toBeNull()
    }
    for (const miss of [
      'C:\\Users\\alice\\AppData\\Local\\Temp\\home\\.claude\\.credentials.json',
      'C:\\Users\\alice\\work\\.claude',
      'C:\\Users\\alice\\AppData\\Local\\Programs\\tool.exe',
      'C:\\Users\\bob\\.claude',
      'C:\\elsewhere\\account-profiles\\p-1',
    ]) {
      expect(c.configHit(miss), miss).toBeNull()
    }
  })

  it('an account-profiles folder above a real root is a real root too', () => {
    expect(deriveAccountProfilesRoots(['F:\\R\\account-profiles\\profile-1', 'C:\\Users\\a'], 'win32')).toEqual(['F:\\R\\account-profiles'])
    expect(deriveAccountProfilesRoots(['/srv/x/account-profiles/p'], 'linux')).toEqual(['/srv/x/account-profiles'])
  })
})

describe('probes: isolatedProbeEnv and probe-guard.mjs', () => {
  it('builds a FRESH env: nothing inherited but the essentials, the six home variables inside the root', () => {
    const root = mkdtempSync(path.join(SCRATCH, 'probe-env-'))
    process.env.CCC_ISO_SENTINEL = 'inherited'
    try {
      const env = isolatedProbeEnv(root)
      expect(env.CCC_ISO_SENTINEL).toBeUndefined()
      const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'HOMEDRIVE', 'HOMEPATH', MARKER_ENV, ...HOME_VARS])
      for (const k of Object.keys(env)) expect(allowed.has(k.toUpperCase()) || allowed.has(k), k).toBe(true)
      for (const name of HOME_VARS) {
        expect(inside(env[name], root), `${name}=${env[name]}`).toBe(true)
        expect(isDir(env[name]), name).toBe(true)
      }
      const marker = JSON.parse(env[MARKER_ENV]) as { real: string[]; isolated: string }
      expect(marker.real.map(norm)).toContain(norm(REAL))
      expect(norm(marker.isolated)).toBe(norm(root))
    } finally {
      delete process.env.CCC_ISO_SENTINEL
    }
  })

  it('refuses a probe root inside a real home', () => {
    expectRefused(() => isolatedProbeEnv(missing()), 'isolatedProbeEnv')
  })

  const PROBE = [
    "import fs from 'node:fs'",
    "import { spawnSync } from 'node:child_process'",
    "const t = JSON.parse(fs.readFileSync(new URL('./targets.json', import.meta.url), 'utf8'))",
    'const guard = await import(t.guardUrl)',
    'const refused = {}',
    'const attempt = async (name, fn) => { try { await fn(); refused[name] = "no refusal" } catch (e) { refused[name] = e && e.code } }',
    "await attempt('rmSync', () => fs.rmSync(t.del))",
    "await attempt('writeFileSync', () => fs.writeFileSync(t.write, 'x'))",
    "await attempt('promisesRm', () => fs.promises.rm(t.del))",
    "await attempt('spawnCwd', () => { const r = spawnSync(process.execPath, ['-e', '0'], { cwd: t.cwd }); if (r.error) throw r.error })",
    "await attempt('spawnEnvHome', () => spawnSync(process.execPath, ['-e', '0'], { env: { PATH: process.env.PATH, HOME: t.envHome } }))",
    "await attempt('spawnArgv', () => spawnSync(process.execPath, ['-e', '0', t.argv]))",
    'const recorded = guard.drainViolations().length',
    "spawnSync(process.execPath, ['-e', t.printEnv, t.out], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } })",
    "fs.writeFileSync(t.results, JSON.stringify({ refused, recorded, childEnv: JSON.parse(fs.readFileSync(t.out, 'utf8')) }))",
  ].join('\n')

  it('refuses the same operations in a plain-node probe, and hands its children the probe home', () => {
    const root = mkdtempSync(path.join(SCRATCH, 'probe-'))
    const t = {
      guardUrl: pathToFileURL(PROBE_GUARD).href,
      del: missing(),
      write: inMissing(),
      cwd: missing(),
      envHome: missing(),
      argv: path.join(REAL, '.claude'),
      printEnv: PRINT_ENV,
      out: path.join(root, 'child-env.json'),
      results: path.join(root, 'results.json'),
    }
    writeFileSync(path.join(root, 'targets.json'), JSON.stringify(t))
    writeFileSync(path.join(root, 'probe.mjs'), PROBE)
    const r = spawnSync(process.execPath, ['--import', t.guardUrl, path.join(root, 'probe.mjs')], {
      env: isolatedProbeEnv(root),
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status, r.stderr).toBe(0)
    const res = JSON.parse(readFileSync(t.results, 'utf8')) as { refused: Record<string, string>; recorded: number; childEnv: Record<string, string> }
    expect(res.refused).toEqual({
      rmSync: VIOLATION_CODE,
      writeFileSync: VIOLATION_CODE,
      promisesRm: VIOLATION_CODE,
      spawnCwd: VIOLATION_CODE,
      spawnEnvHome: VIOLATION_CODE,
      spawnArgv: VIOLATION_CODE,
    })
    expect(res.recorded).toBe(6)
    const child: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.childEnv)) child[WIN ? k.toUpperCase() : k] = v
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) expect(inside(child[name], root), `${name}=${child[name]}`).toBe(true)
  })

  it('a probe that swallows a refusal exits non-zero', () => {
    const root = mkdtempSync(path.join(SCRATCH, 'probe-swallow-'))
    writeFileSync(path.join(root, 'target.txt'), missing())
    writeFileSync(
      path.join(root, 'probe.mjs'),
      "import fs from 'node:fs'\nconst t = fs.readFileSync(new URL('./target.txt', import.meta.url), 'utf8')\ntry { fs.rmSync(t) } catch { /* swallowed */ }\n",
    )
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(PROBE_GUARD).href, path.join(root, 'probe.mjs')], {
      env: isolatedProbeEnv(root),
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(VIOLATION_CODE)
  })
})

// Last: these two tests move the home variables on purpose.
describe('the home variables are re-asserted before every test', () => {
  const saved: Record<string, string | undefined> = {}
  let ownTemp = ''
  afterAll(() => {
    for (const name of HOME_VARS) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    reassertHomeEnv()
  })

  it('a test moves them: to a real home, to nowhere, to a foreign folder, to its own temp folder', () => {
    for (const name of HOME_VARS) saved[name] = process.env[name]
    process.env.HOME = REAL
    process.env.CLAUDE_CONFIG_DIR = path.join(REAL, '.claude')
    delete process.env.USERPROFILE
    process.env.APPDATA = path.resolve('/elsewhere')
    ownTemp = mkdtempSync(path.join(SCRATCH, 'own-home-'))
    process.env.CODEX_HOME = ownTemp
  })

  it('the next test starts from the isolated values; a temp folder the file chose is kept', () => {
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'CLAUDE_CONFIG_DIR']) {
      expect(inside(process.env[name], isolatedRoot()), `${name}=${process.env[name]}`).toBe(true)
    }
    expect(process.env.CODEX_HOME).toBe(ownTemp)
  })
})
