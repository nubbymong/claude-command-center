// [host] Tests and probes never act on a real home.
//
// Covers the guard installed by tests/helpers/home-isolation.ts (setupFiles[0]) and
// its plain-node twin tests/helpers/probe-guard.mjs: the home variables point at an
// isolated folder, and the covered fs and spawn calls aimed at a real home throw
// TEST_ISOLATION_VIOLATION, whatever the import form or path spelling; node children
// load the guard too.
//
// Every real-home target below is harmless if the guard were missing: deletes and
// renames name a random entry that does not exist, writes and creates go into a
// random folder that does not exist (the call fails ENOENT and creates nothing),
// copies and links read a source that does not exist, spawns either run
// `node -e 0`, run a script that does not exist, or fail on a missing working
// folder, and the fd checks run in a child whose "real" home is a scratch folder.
// The API is imported from the core module, not from the setup entry, so a config
// without the setup runs these tests unguarded and they fail.
import { afterAll, describe, expect, it } from 'vitest'
import fsDefault from 'fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
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
import { Worker } from 'node:worker_threads'
import {
  CONFIG_HOME_VARS,
  HOME_VARS,
  MARKER_ENV,
  PROBE_GUARD_URL,
  VIOLATION_CODE,
  XDG_VARS,
  createHomeChecker,
  deriveAccountProfilesRoots,
  drainViolations,
  isReadOnlyFlag,
  isRealHomePath,
  isolatedProbeEnv,
  isolatedRoot,
  pinDataDirectory,
  ptyGuarded,
  realHomeRoots,
  reassertHomeEnv,
  runnerTempsFrom,
} from '../../helpers/home-guard-core.mjs'

const DATA_DIR_AT_LOAD = process.env.CCC_E2E_DATA_DIR
const WIN = process.platform === 'win32'
const FOLDS = WIN || process.platform === 'darwin'
const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const CORE_URL = pathToFileURL(path.resolve(__dirname, '../../helpers/home-guard-core.mjs')).href
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

/** Quiet whatever an unguarded call handed back (a child, a stream, a worker, a promise). */
function settle(result: unknown): void {
  if (!result || typeof result !== 'object') return
  const r = result as { on?: unknown; kill?: unknown; destroy?: unknown; terminate?: unknown; then?: unknown; catch?: unknown }
  if (typeof r.on === 'function') (r.on as (e: string, f: () => void) => void).call(result, 'error', noop)
  for (const m of ['kill', 'destroy', 'terminate'] as const) {
    if (typeof r[m] === 'function') {
      try {
        const out = (r[m] as () => unknown).call(result)
        if (out && typeof (out as Promise<unknown>).catch === 'function') (out as Promise<unknown>).catch(noop)
      } catch {
        /* already gone */
      }
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
function upperKeys(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) out[WIN ? k.toUpperCase() : k] = v
  return out
}

/** Write a child script and its targets into a fresh scratch folder; return the script path. */
function childScript(name: string, body: string, targets: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(SCRATCH, `${name}-`))
  writeFileSync(path.join(dir, 'targets.json'), JSON.stringify({ guardUrl: PROBE_GUARD_URL, coreUrl: CORE_URL, ...targets }))
  const file = path.join(dir, 'child.mjs')
  writeFileSync(file, ["import fs from 'node:fs'", "const t = JSON.parse(fs.readFileSync(new URL('./targets.json', import.meta.url), 'utf8'))", body].join('\n'))
  return file
}
/** Run a child script; return its parsed stdout, status and stderr. */
function runChild(file: string, opts: { env?: Record<string, string>; preload?: boolean; cwd?: string; pre?: string[] } = {}) {
  const args = [...(opts.pre ?? []), ...(opts.preload === false ? [file] : ['--import', PROBE_GUARD_URL, file])]
  const r = spawnSync(process.execPath, args, { env: opts.env ?? { ...MIN_ENV }, cwd: opts.cwd ?? path.dirname(file), encoding: 'utf8', timeout: 60_000 })
  let out: Record<string, unknown> = {}
  try {
    out = JSON.parse(r.stdout || '{}') as Record<string, unknown>
  } catch {
    out = { unparsed: r.stdout }
  }
  return { out, status: r.status, stderr: r.stderr }
}
const ATTEMPT = 'const out = {}; const attempt = async (name, fn) => { try { await fn(); out[name] = "no refusal" } catch (e) { out[name] = e && e.code } }'

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

  it("pins the app's data folder (CCC_E2E_DATA_DIR) inside the worker's temp folder, before any test module loads", () => {
    // Read when this file loaded, before any hook ran: what data-paths sees at import.
    expect(inside(DATA_DIR_AT_LOAD, os.tmpdir()), String(DATA_DIR_AT_LOAD)).toBe(true)
    expect(isDir(DATA_DIR_AT_LOAD ?? '')).toBe(true)
  })

  it.runIf(!WIN)('points the XDG folders inside the isolated root too', () => {
    for (const name of XDG_VARS) expect(inside(process.env[name], isolatedRoot()), `${name}=${process.env[name]}`).toBe(true)
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
    // 0x40 is _O_TEMPORARY (delete on close) on Windows and O_CREAT on Linux.
    ['fs.openSync', () => fsNs.openSync(inMissing(), 0x40)],
    ['fs.openSync', () => fsNs.openSync(inMissing(), 'x')],
    ['fs.open', () => fsNs.open(inMissing(), 'r+', noop)],
    ['fs.createWriteStream', () => fsNs.createWriteStream(inMissing())],
  ]
  it.each(cases)('%s', (op, run) => expectRefused(run, op))

  // Node 24+ only (absent on Node 20, where the guard simply has nothing to wrap).
  const disposableSync = (fsNs as unknown as { mkdtempDisposableSync?: (p: string) => unknown }).mkdtempDisposableSync
  it.runIf(typeof disposableSync === 'function')('fs.mkdtempDisposableSync (where this Node has it)', () => {
    expectRefused(() => (disposableSync as (p: string) => unknown)(inMissing() + '-'), 'fs.mkdtempDisposableSync')
  })

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

  it('read-only flags are an allow-list', () => {
    for (const f of [undefined, 'r', 'rs', 'sr', 0]) expect(isReadOnlyFlag(f), String(f)).toBe(true)
    // Numeric flags from this platform's own constants (their values differ per OS).
    const C = fsNs.constants as unknown as Record<string, number | undefined>
    const writeBits = ['O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC', 'O_APPEND', 'O_EXCL'].map((n) => C[n]).filter((n): n is number => typeof n === 'number' && n > 0)
    expect(writeBits.length).toBeGreaterThan(4)
    // 0x40 is _O_TEMPORARY (delete on close) on Windows.
    for (const f of ['w', 'r+', 'a', 'as', 'wx', 'R', 'rw', ...writeBits, ...(WIN ? [0x40] : []), {}, 1.5]) expect(isReadOnlyFlag(f), String(f)).toBe(false)
  })
})

describe('reads with a write flag, and the other entry points, aimed at a real home throw', () => {
  it.each<[string, () => unknown]>([
    ['fs.readFileSync', () => fsNs.readFileSync(inMissing(), { flag: 'w' })],
    ['fs.readFileSync', () => fsNs.readFileSync(inMissing(), { encoding: 'utf8', flag: 'w' })],
    ['fs.readFileSync', () => fsNs.readFileSync(inMissing(), { flag: 0x40 as unknown as string })],
    ['fs.readFile', () => fsNs.readFile(inMissing(), { flag: 'a' }, noop)],
    ['fs.createReadStream', () => fsNs.createReadStream(inMissing(), { flags: 'w' })],
  ])('%s', (op, run) => expectRefused(run, op))

  it('fs.promises.readFile with a write flag', () => expectRejected(() => fsp.readFile(inMissing(), { flag: 'w' }), 'fs.promises.readFile'))
  const disposable = (fsp as unknown as { mkdtempDisposable?: (p: string) => Promise<unknown> }).mkdtempDisposable
  it.runIf(typeof disposable === 'function')('fs.promises.mkdtempDisposable (where this Node has it)', () =>
    expectRejected(() => (disposable as (p: string) => Promise<unknown>)(inMissing() + '-'), 'fs.promises.mkdtempDisposable'))

  it('a URL-like object is read the way fs reads it (hostname + pathname), not by its href', () => {
    const target = new URL(pathToFileURL(inMissing()).href)
    const likeUrl = { href: pathToFileURL(path.join(SCRATCH, 'x')).href, protocol: 'file:', hostname: '', pathname: target.pathname }
    expectRefused(() => writeFileSync(likeUrl as unknown as URL, 'x'), 'fs.writeFileSync')
  })

  it.each(['fs', 'fs_dir', 'spawn_sync', 'process_wrap'])("process.binding('%s') is refused", (name) => {
    expectRefused(() => (process as unknown as { binding: (n: string) => unknown }).binding(name), 'process.binding')
  })

  it('a worker_threads Worker is refused (its builtins would be unguarded)', () => {
    expectRefused(() => new Worker('0', { eval: true }), 'worker_threads.Worker')
  })

  it("a toolchain worker (a script in this project's node_modules: esbuild's sync service) starts", async () => {
    const esbuild = requireCjs('esbuild') as { transformSync: (c: string, o: object) => { code: string } }
    expect(esbuild.transformSync('let x: number = 1', { loader: 'ts' }).code).toContain('let x = 1')
    // Named by a file: URL too (loaded without esbuild's worker data it only loads, then exits).
    const w = new Worker(pathToFileURL(requireCjs.resolve('esbuild')))
    expect(await new Promise((res, rej) => { w.once('exit', res); w.once('error', rej) })).toBe(0)
    expect(drainViolations()).toEqual([])
  })

  it('a worker script outside node_modules is refused, however it is named', () => {
    const file = path.join(SCRATCH, 'own-worker.cjs')
    writeFileSync(file, '')
    expectRefused(() => new Worker(file), 'worker_threads.Worker')
    expectRefused(() => new Worker(pathToFileURL(file)), 'worker_threads.Worker')
    // Out of node_modules again through '..', and a data: URL.
    expectRefused(() => new Worker(path.join(PROJECT_ROOT, 'node_modules') + path.sep + '..' + path.sep + 'own-worker.cjs'), 'worker_threads.Worker')
    expectRefused(() => new Worker(new URL('data:text/javascript,0')), 'worker_threads.Worker')
    // eval code is refused even when it reads like a path into node_modules.
    expectRefused(() => new Worker(path.join(PROJECT_ROOT, 'node_modules', 'x.js'), { eval: true }), 'worker_threads.Worker')
  })

  it('a toolchain worker handed a preload in its execArgv is refused (the preload would run before the guard)', () => {
    const preload = path.join(SCRATCH, 'preload.cjs')
    writeFileSync(preload, '')
    const url = pathToFileURL(preload).href
    const script = path.join(PROJECT_ROOT, 'node_modules', `ccc-iso-missing-${TAG}.js`)
    for (const execArgv of [['--require', preload], ['-r', preload], [`--require=${preload}`], ['--import', url], [`--import=${url}`], ['--loader', url], ['--experimental-loader', url]]) {
      expectRefused(() => new Worker(script, { execArgv }), 'worker_threads.Worker execArgv')
    }
  })

  it('so is the original Worker reached through Worker.prototype.constructor', () => {
    const Ctor = (Worker.prototype as unknown as { constructor: new (code: string, o: object) => unknown }).constructor
    expectRefused(() => new Ctor('0', { eval: true }), 'worker_threads.Worker')
  })

  it.runIf(typeof (process as unknown as { execve?: unknown }).execve === 'function')('process.execve is refused (it would replace the process)', () => {
    expectRefused(() => (process as unknown as { execve: (f: string, a: string[], e: object) => void }).execve(process.execPath, [process.execPath, '-e', '0'], {}), 'process.execve')
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
  it("named import from 'node:worker_threads'", () => expectRefused(() => new Worker('0', { eval: true }), 'worker_threads.Worker'))
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
    // Any UNC share fails closed (this one does not even exist).
    ['a UNC path', WIN, () => `\\\\localhost\\ccc-iso-no-share-${TAG}\\f`],
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

  it.runIf(WIN)('a UNC working folder', () => {
    expectRefused(() => spawnSync(process.execPath, ['-e', '0'], { cwd: `\\\\localhost\\ccc-iso-no-share-${TAG}` }), 'child_process.spawnSync cwd')
  })

  it.runIf(PTY_LOADS)('node-pty spawn with a real-home cwd', async () => {
    expect(ptyGuarded()).toBe(true)
    const pty = await import('node-pty')
    expectRefused(() => pty.spawn(process.execPath, ['-e', '0'], { cwd: missing() }), 'node-pty.spawn cwd')
  })

  it.each([...HOME_VARS, ...XDG_VARS, 'TEMP', 'TMP', 'TMPDIR'].map((n) => [n]))('an explicit env whose %s is in a real home', (name) => {
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

  it('a home variable inherited through the env prototype (Node reads it with for...in)', () => {
    const env = Object.assign(Object.create({ CODEX_HOME: missing() }) as Record<string, string>, MIN_ENV)
    expectRefused(() => spawnSync(process.execPath, ['-e', '0'], { env, stdio: 'ignore' }), 'child_process.spawnSync env CODEX_HOME')
  })

  it('a home variable that is not a string (Node coerces it)', () => {
    const real = missing()
    const env = { ...MIN_ENV, CODEX_HOME: { toString: () => real } } as unknown as NodeJS.ProcessEnv
    expectRefused(() => spawnSync(process.execPath, ['-e', '0'], { env, stdio: 'ignore' }), 'child_process.spawnSync env CODEX_HOME')
  })

  it.runIf(WIN && /^[a-z]:\\/i.test(REAL))('HOMEDRIVE + HOMEPATH naming a real home, or HOMEPATH alone (the drive is filled)', () => {
    expectRefused(
      () => spawnSync(process.execPath, ['-e', '0'], { env: { ...MIN_ENV, HOMEDRIVE: REAL.slice(0, 2), HOMEPATH: REAL.slice(2) }, stdio: 'ignore' }),
      'child_process.spawnSync env HOMEDRIVE+HOMEPATH',
    )
    const drive = (isolatedRoot() ?? '').slice(0, 2).toUpperCase()
    if (drive === REAL.slice(0, 2).toUpperCase()) {
      expectRefused(
        () => spawnSync(process.execPath, ['-e', '0'], { env: { ...MIN_ENV, HOMEPATH: REAL.slice(2) }, stdio: 'ignore' }),
        'child_process.spawnSync env HOMEDRIVE+HOMEPATH',
      )
    }
  })

  it.each([['GIT_CONFIG_GLOBAL'], ['npm_config_cache'], ['npm_config_userconfig']])('an explicit env whose %s is in a real home', (name) => {
    expectRefused(
      () => spawnSync(process.execPath, ['-e', '0'], { env: { ...MIN_ENV, [name]: path.join(missing(), 'x') }, stdio: 'ignore' }),
      `child_process.spawnSync env ${name}`,
    )
  })

  it('a git or npm config variable that names a real home is pointed into the isolated home for this process', () => {
    const real = path.join(missing(), 'npm-cache')
    process.env.npm_config_cache = real
    try {
      reassertHomeEnv()
      expect(inside(process.env.npm_config_cache, isolatedRoot()), String(process.env.npm_config_cache)).toBe(true)
    } finally {
      delete process.env.npm_config_cache
    }
  })

  it('a direct ChildProcess.prototype.spawn is checked like a spawn (cwd, env)', () => {
    const run = (opts: Record<string, unknown>) => () => {
      const c = new cpNs.ChildProcess()
      c.on('error', noop)
      ;(c as unknown as { spawn: (o: object) => unknown }).spawn({ file: process.execPath, args: [process.execPath, '-e', '0'], envPairs: [], stdio: 'ignore', ...opts })
      return c
    }
    expectRefused(run({ cwd: missing() }), 'ChildProcess.spawn cwd')
    expectRefused(run({ cwd: SCRATCH, envPairs: [`HOME=${missing()}`, `PATH=${MIN_ENV.PATH}`] }), 'ChildProcess.spawn env HOME')
  })

  it('a cd or pushd into a real home, or into the folder above one, in a shell line', () => {
    const parent = path.dirname(REAL)
    expectRefused(() => execSync(`cd "${parent}" && "${process.execPath}" -e 0`, { stdio: 'ignore' }), 'child_process.execSync argv')
    expectRefused(() => execSync(`cd "${missing()}" && "${process.execPath}" -e 0`, { stdio: 'ignore' }), 'child_process.execSync argv')
    if (WIN) {
      expectRefused(
        () => spawnSync('cmd.exe', ['/d', '/s', '/c', `cd /d "${parent}" && "${process.execPath}" -e 0`], { stdio: 'ignore', windowsVerbatimArguments: true }),
        'child_process.spawnSync argv',
      )
    } else {
      expectRefused(() => spawnSync('sh', ['-c', `cd "${parent}" && true`], { stdio: 'ignore' }), 'child_process.spawnSync argv')
    }
    // A PowerShell -Command line (the executable does not exist).
    expectRefused(
      () => spawnSync(path.join(SCRATCH, 'pwsh.exe'), ['-NoProfile', '-Command', `Set-Location "${parent}"; exit 0`], { stdio: 'ignore' }),
      'child_process.spawnSync argv',
    )
  })

  it.each(CONFIG_HOME_VARS.map((n) => [n]))('an explicit env whose %s (a Claude / Codex / app config folder) is in a real home', (name) => {
    expectRefused(
      () => spawnSync(process.execPath, ['-e', '0'], { env: { ...MIN_ENV, [name]: path.join(missing(), 'x') }, stdio: 'ignore' }),
      `child_process.spawnSync env ${name}`,
    )
  })

  it('a config-folder variable that names a real home is pointed into the isolated home for this process', () => {
    process.env.ANTHROPIC_CONFIG_DIR = path.join(missing(), 'anthropic')
    try {
      reassertHomeEnv()
      expect(inside(process.env.ANTHROPIC_CONFIG_DIR, isolatedRoot()), String(process.env.ANTHROPIC_CONFIG_DIR)).toBe(true)
    } finally {
      delete process.env.ANTHROPIC_CONFIG_DIR
    }
  })

  it('the data folder pin replaces an inherited value outside the temp area and keeps one inside it', () => {
    const name = 'CCC_ISO_PIN_TEST'
    const fresh = mkdtempSync(path.join(SCRATCH, 'pin-'))
    const own = mkdtempSync(path.join(SCRATCH, 'pin-own-'))
    try {
      process.env[name] = path.join(path.parse(PROJECT_ROOT).root, `ccc-iso-elsewhere-${TAG}`)
      expect(pinDataDirectory(name, fresh)).toBe(fresh)
      process.env[name] = own
      expect(pinDataDirectory(name, fresh)).toBe(own)
      delete process.env[name]
      expect(pinDataDirectory(name, fresh)).toBe(fresh)
    } finally {
      delete process.env[name]
    }
  })

  it.runIf(WIN)('a child env without TEMP gets the live TEMP libuv copies in, which is checked', () => {
    const saved = process.env.TEMP
    process.env.TEMP = missing()
    try {
      expectRefused(() => spawnSync(process.execPath, ['-e', '0'], { env: { ...MIN_ENV }, stdio: 'ignore' }), 'child_process.spawnSync env TEMP')
    } finally {
      process.env.TEMP = saved
    }
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

  const user = path.basename(REAL)
  it.each<[string, boolean, () => string]>([
    ['the real .claude', true, () => path.join(REAL, '.claude')],
    ['the real .claude.json', true, () => path.join(REAL, '.claude.json')],
    ['a file in the real .codex', true, () => path.join(REAL, '.codex', 'auth.json')],
    ['the real credentials file', true, () => path.join(REAL, '.claude', '.credentials.json')],
    ['the real home itself', true, () => REAL],
    ['any other path in the real home', true, () => path.join(missing(), 'Documents')],
    ['a --name=value option, at any depth', true, () => '--cfg=k=' + path.join(REAL, '.claude', 'settings.json')],
    ['a bracketed list', true, () => `writable_roots=["${path.join(REAL, '.codex')}"]`],
    ['a long argument', true, () => 'x'.repeat(6000) + ' ' + path.join(REAL, '.claude')],
    ['a glob into the real home', true, () => path.join(REAL, '.cl*')],
    ['a glob that reaches the real home', true, () => path.join(path.dirname(REAL), user.slice(0, -1) + '*', '.claude')],
    ['~user', /^[A-Za-z0-9._-]+$/.test(user), () => `~${user}/.claude`],
    ['an MSYS spelling', WIN && /^[a-z]:\\/i.test(REAL), () => `/${REAL[0].toLowerCase()}/${REAL.slice(3).split('\\').join('/')}/.claude`],
    ['a WSL spelling', WIN && /^[a-z]:\\/i.test(REAL), () => `/mnt/${REAL[0].toLowerCase()}/${REAL.slice(3).split('\\').join('/')}/.claude`],
    ['a UNC spelling', WIN, () => `\\\\localhost\\ccc-iso-no-share-${TAG}\\.claude`],
  ])('an argument naming %s', (_label, applies, arg) => {
    if (!applies) return
    expectRefused(() => spawnSync(process.execPath, ['-e', '0', arg()], { stdio: 'ignore' }), 'child_process.spawnSync argv')
  })

  it('a real-home path inside a shell command line or an -e script', () => {
    expectRefused(
      () => execSync(`"${process.execPath}" -e 0 "${path.join(REAL, '.claude')}"`, { stdio: 'ignore' }),
      'child_process.execSync argv',
    )
    expectRefused(
      () => spawnSync(process.execPath, ['-e', `void ${JSON.stringify(path.join(REAL, '.codex'))}`], { stdio: 'ignore' }),
      'child_process.spawnSync argv',
    )
  })

  it('a node script in a real home outside its npm or nvm folder (the script does not exist)', () => {
    expectRefused(() => spawnSync(process.execPath, [path.join(missing(), 'cli.js')], { stdio: 'ignore' }), 'child_process.spawnSync argv')
    expectRefused(() => fork(path.join(missing(), 'cli.js'), [], { stdio: 'ignore' }), 'child_process.fork argv')
  })

  it('an executable that lives under a real home may run (running a binary is not a mutation)', () => {
    const r = spawnSync(path.join(missing(), 'tool.exe'), [], { stdio: 'ignore' })
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')
    expect(drainViolations()).toEqual([])
  })

  it('arguments naming the isolated home, ~ (the child HOME), URLs and scripts are fine', () => {
    const args = ['-e', '0', path.join(os.homedir(), '.claude'), '~/.claude/x', 'https://example.com/a/b', 'http://127.0.0.1:1/mcp', '/* c */ a / b', 'tests/x', '/v', '/s', '/d']
    const r = spawnSync(process.execPath, args, { stdio: 'ignore' })
    expect(r.status).toBe(0)
    expect(drainViolations()).toEqual([])
  })
})

describe('a node child gets the guard, and the isolated home, never the real one', () => {
  const PRINT = [
    'const g = process[Symbol.for("ccc.test-home-guard.state")]',
    "fs.writeFileSync(t.out, JSON.stringify({ env: process.env, guarded: !!g, entry: g ? g.entry : null }))",
  ].join('\n')

  it('an explicit env that omits the home variables gets the isolated ones; the guard preload and marker stay out of view', () => {
    const out = path.join(isolatedRoot() ?? SCRATCH, `env-${TAG}-explicit.json`)
    const r = runChild(childScript('print-explicit', PRINT, { out }), { preload: false })
    expect(r.status, r.stderr).toBe(0)
    const res = JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string>; guarded: boolean; entry: string }
    const child = upperKeys(res.env)
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME']) {
      expect(inside(child[name], isolatedRoot()), `${name}=${child[name]}`).toBe(true)
    }
    // Unset, it falls back to the (isolated) HOME; the managed launch strips it on purpose.
    expect(child.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(res.guarded).toBe(true)
    expect(res.entry).toBe('probe')
    expect(child.NODE_OPTIONS).toBeUndefined()
    expect(child[MARKER_ENV]).toBeUndefined()
  })

  it("an explicit env that omits the temp variables gets this process's (POSIX does not copy them in)", () => {
    const out = path.join(isolatedRoot() ?? SCRATCH, `env-${TAG}-temp.json`)
    const r = runChild(childScript('print-temp', PRINT, { out }), { preload: false })
    expect(r.status, r.stderr).toBe(0)
    const child = upperKeys((JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string> }).env)
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
      expect(process.env[name], name).toBeTruthy()
      expect(norm(child[name]), name).toBe(norm(process.env[name] ?? ''))
    }
  })

  it("a child handed its own home gets the other folders under that home, not the isolated ones", () => {
    const own = mkdtempSync(path.join(SCRATCH, 'own-child-home-'))
    const out = path.join(isolatedRoot() ?? SCRATCH, `env-${TAG}-own-home.json`)
    const r = runChild(childScript('print-own', PRINT, { out }), { preload: false, env: { ...MIN_ENV, HOME: own, USERPROFILE: own } })
    expect(r.status, r.stderr).toBe(0)
    const child = upperKeys((JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string> }).env)
    expect(norm(child.CODEX_HOME)).toBe(norm(path.join(own, '.codex')))
    if (WIN) expect(norm(child.APPDATA)).toBe(norm(path.join(own, 'AppData', 'Roaming')))
    else expect(norm(child.XDG_CONFIG_HOME)).toBe(norm(path.join(own, '.config')))
  })

  it('an inherited env carries the isolated values', () => {
    const out = path.join(isolatedRoot() ?? SCRATCH, `env-${TAG}-inherited.json`)
    const file = childScript('print-inherited', PRINT, { out })
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const res = JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string>; guarded: boolean }
    const child = upperKeys(res.env)
    for (const name of HOME_VARS) expect(inside(child[name], isolatedRoot()), `${name}=${child[name]}`).toBe(true)
    expect(res.guarded).toBe(true)
  })

  it('a node child that writes to the real home is refused in the child, and exits non-zero', () => {
    const body = [ATTEMPT, 'await attempt("rmSync", () => fs.rmSync(t.del))', 'await attempt("writeFileSync", () => fs.writeFileSync(t.write, "x"))', 'process.stdout.write(JSON.stringify(out))'].join('\n')
    const r = runChild(childScript('child-writes', body, { del: missing(), write: inMissing() }), { preload: false })
    expect(r.out).toEqual({ rmSync: VIOLATION_CODE, writeFileSync: VIOLATION_CODE })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(VIOLATION_CODE)
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

  it("a refusal of a Buffer or file: URL path names that path (Node's recursive rm passes Buffers)", () => {
    const target = missing()
    // Spelled with a `..`, so the path as given differs from the form the guard resolved.
    const given = path.dirname(target) + path.sep + 'x' + path.sep + '..' + path.sep + path.basename(target)
    for (const arg of [Buffer.from(given), pathToFileURL(given)]) {
      try {
        fsNs.unlinkSync(arg)
      } catch {
        /* caught on purpose */
      }
    }
    const recorded = drainViolations() as Recorded[]
    // The URL parser itself drops the `..`.
    expect(recorded.map((v) => [v.op, v.target])).toEqual([['fs.unlinkSync', given], ['fs.unlinkSync', target]])
  })

  it.fails('a refusal the code under test swallows still fails its test (shared afterEach)', () => {
    try {
      rmSync(missing())
    } catch {
      /* swallowed on purpose: the shared afterEach must still fail this test */
    }
  })
})

describe('the guard in a plain-node child (probe-guard.mjs)', () => {
  it('protects a home that only the environment names (an account-profiles USERPROFILE outside the OS profile)', () => {
    // A folder at the drive root that does not exist and is never created.
    const envHome = path.join(path.parse(PROJECT_ROOT).root, `ccc-iso-envhome-${TAG}`, 'account-profiles', 'p1')
    const envCodex = path.join(path.parse(PROJECT_ROOT).root, `ccc-iso-envcodex-${TAG}`)
    const envAnthropic = path.join(path.parse(PROJECT_ROOT).root, `ccc-iso-envanthropic-${TAG}`)
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      'out.home = g.isRealHomePath(t.home); out.cred = g.isRealHomePath(t.cred); out.profiles = g.isRealHomePath(t.profiles); out.cfg = g.isRealHomePath(t.cfg); out.codex = g.isRealHomePath(t.codex); out.anthropic = g.isRealHomePath(t.anthropic)',
      'await attempt("rmSync", () => fs.rmSync(t.del))',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const file = childScript('env-home', body, {
      home: envHome,
      cred: path.join(envHome, '.claude', '.credentials.json'),
      profiles: path.join(path.dirname(envHome), 'p2'),
      cfg: path.join(envHome, '.claude'),
      del: path.join(envHome, `.ccc-iso-canary-${TAG}`),
      codex: path.join(envCodex, 'auth.json'),
      anthropic: path.join(envAnthropic, 'x'),
    })
    // On Windows the variable name is matched case-insensitively, as the OS does.
    const codexKey = WIN ? 'codex_home' : 'CODEX_HOME'
    const r = runChild(file, {
      env: { ...MIN_ENV, USERPROFILE: envHome, CLAUDE_CONFIG_DIR: path.join(envHome, '.claude'), [codexKey]: envCodex, ANTHROPIC_CONFIG_DIR: envAnthropic },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ home: true, cred: true, profiles: true, cfg: true, codex: true, anthropic: true, rmSync: VIOLATION_CODE })
    expect(existsSync(envAnthropic)).toBe(false)
    expect(existsSync(path.dirname(path.dirname(envHome)))).toBe(false)
    expect(existsSync(envCodex)).toBe(false)
  })

  it('refuses fd and FileHandle metadata calls on a real-home file opened read-only', () => {
    // The child's "real" home is a scratch folder: HOME points there and its temp folder is elsewhere.
    const sim = mkdtempSync(path.join(SCRATCH, 'simhome-'))
    const home = path.join(sim, 'home')
    const tmp = path.join(sim, 'tmp')
    mkdirSync(home)
    mkdirSync(tmp)
    writeFileSync(path.join(home, 'f.txt'), 'x')
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      'const fd = fs.openSync(t.homeFile, "r")',
      'await attempt("fchmodSync", () => fs.fchmodSync(fd, 0o644))',
      'await attempt("futimesSync", () => fs.futimesSync(fd, new Date(), new Date()))',
      'await attempt("ftruncateSync", () => fs.ftruncateSync(fd, 0))',
      'await attempt("fchmod", () => new Promise((res, rej) => fs.fchmod(fd, 0o644, (e) => (e ? rej(e) : res()))))',
      'fs.closeSync(fd)',
      // The next open usually reuses the closed fd number: a closed fd must be forgotten.
      'const fdReuse = fs.openSync(t.tmpFile, "w")',
      'await attempt("reused", () => fs.futimesSync(fdReuse, new Date(), new Date()))',
      'fs.closeSync(fdReuse)',
      'const fh = await fs.promises.open(t.homeFile, "r")',
      'await attempt("fhChmod", () => fh.chmod(0o644))',
      'await attempt("fhUtimes", () => fh.utimes(new Date(), new Date()))',
      // Through the prototype, not the instance.
      'await attempt("protoChmod", () => Object.getPrototypeOf(fh).chmod.call(fh, 0o644))',
      'await attempt("protoWrite", () => Object.getPrototypeOf(fh).write.call(fh, Buffer.from("x")))',
      'await fh.close()',
      'const fd2 = fs.openSync(t.tmpFile, "w")',
      'await attempt("control", () => fs.futimesSync(fd2, new Date(), new Date()))',
      'fs.closeSync(fd2)',
      'out.recorded = g.drainViolations().length',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const file = childScript('fd', body, { homeFile: path.join(home, 'f.txt'), tmpFile: path.join(tmp, 'g.txt') })
    const marker = JSON.stringify({ v: 1, real: [], tmp: [tmp], inst: [] })
    const r = runChild(file, { env: { ...MIN_ENV, HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp, [MARKER_ENV]: marker } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({
      fchmodSync: VIOLATION_CODE,
      futimesSync: VIOLATION_CODE,
      ftruncateSync: VIOLATION_CODE,
      fchmod: VIOLATION_CODE,
      reused: 'no refusal',
      fhChmod: VIOLATION_CODE,
      fhUtimes: VIOLATION_CODE,
      protoChmod: VIOLATION_CODE,
      protoWrite: VIOLATION_CODE,
      control: 'no refusal',
      recorded: 8,
    })
  })

  it("a program in a real home's npm folder run through cmd /c or sh -c may run; one elsewhere in that home may not", () => {
    const sim = mkdtempSync(path.join(SCRATCH, 'shimsim-'))
    const home = path.join(sim, 'home')
    const tmp = path.join(sim, 'tmp')
    const npm = path.join(home, 'npm')
    mkdirSync(npm, { recursive: true })
    mkdirSync(tmp)
    const ext = WIN ? '.cmd' : '.sh'
    const ok = path.join(npm, `ok${ext}`)
    const other = path.join(home, `other${ext}`)
    for (const f of [ok, other]) writeFileSync(f, WIN ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const inner: Record<string, string> = { ...MIN_ENV, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, LOCALAPPDATA: tmp, TEMP: tmp, TMP: tmp, TMPDIR: tmp }
    if (WIN) Object.assign(inner, { HOMEDRIVE: tmp.slice(0, 2), HOMEPATH: tmp.slice(2) })
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      "const { spawnSync } = await import('node:child_process')",
      'const run = (p) => t.win',
      '  ? spawnSync("cmd.exe", ["/d", "/s", "/c", `""${p}" --version"`], { env: t.inner, cwd: t.tmp, windowsVerbatimArguments: true, encoding: "utf8" })',
      '  : spawnSync("sh", ["-c", `"${p}" --version`], { env: t.inner, cwd: t.tmp, encoding: "utf8" })',
      'await attempt("installed", () => { const r = run(t.ok); if (r.status !== 0) throw new Error("exit " + r.status + " " + r.stderr) })',
      'await attempt("elsewhere", () => run(t.other))',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const file = childScript('shim', body, { ok, other, inner, tmp, win: WIN })
    const marker = JSON.stringify({ v: 1, real: [], tmp: [tmp], inst: [npm] })
    const r = runChild(file, { env: { ...MIN_ENV, HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp, [MARKER_ENV]: marker } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ installed: 'no refusal', elsewhere: VIOLATION_CODE })
  })

  it('isolating fails loudly when os.homedir() does not follow the redirect', () => {
    const body = [
      'const g = await import(t.coreUrl)',
      "const os = (await import('node:os')).default",
      'os.homedir = () => t.elsewhere',
      'let result = "no throw"',
      'try { g.installHomeGuard({ entry: "vitest", isolate: true }) } catch (e) { result = e && e.message && e.message.includes("home isolation did not take effect") ? "threw" : String(e) }',
      'process.stdout.write(JSON.stringify({ result }))',
    ].join('\n')
    const r = runChild(childScript('homedir', body, { elsewhere: path.join(SCRATCH, 'not-the-isolated-home') }))
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ result: 'threw' })
  })

  it('a forged marker cannot make the real home, or a folder in it, a temp or isolated folder', () => {
    // Neither folder exists; the deletes name entries inside them.
    const sub = path.join(REAL, `.ccc-iso-forged-${TAG}`)
    const iso = path.join(REAL, `.ccc-iso-forged-iso-${TAG}`)
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      'await attempt("home", () => fs.rmSync(t.del))',
      'await attempt("tmpInHome", () => fs.rmSync(t.delSub))',
      'await attempt("isolatedInHome", () => fs.rmSync(t.delIso))',
      'await attempt("tmpNamedInHome", () => fs.rmSync(t.delTmpNamed))',
      'if (t.delAncestor) await attempt("tmpAncestorInHome", () => fs.rmSync(t.delAncestor))',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    // Named like a temp folder, holds no real home, but does not hold the child's own temp folder.
    const tmpNamed = path.join(sub, 'tmp')
    // A folder in the real home that holds the temp folder (AppData on Windows) but is not named like one.
    const rel = path.relative(REAL, os.tmpdir())
    const ancestor = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).length > 1 ? path.join(REAL, rel.split(path.sep)[0]) : undefined
    const delAncestor = ancestor ? path.join(ancestor, `.ccc-iso-forged-anc-${TAG}`, 'c') : undefined
    const file = childScript('forged', body, { del: missing(), delSub: path.join(sub, 'c'), delIso: path.join(iso, 'c'), delTmpNamed: path.join(tmpNamed, 'c'), delAncestor })
    for (const isolated of [REAL, iso]) {
      const marker = JSON.stringify({ v: 1, real: [], tmp: [REAL, sub, tmpNamed, ...(ancestor ? [ancestor] : [])], inst: [], isolated })
      const r = runChild(file, { env: { ...MIN_ENV, [MARKER_ENV]: marker } })
      expect(r.status, r.stderr).toBe(0)
      expect(r.out, isolated).toEqual({
        home: VIOLATION_CODE,
        tmpInHome: VIOLATION_CODE,
        isolatedInHome: VIOLATION_CODE,
        tmpNamedInHome: VIOLATION_CODE,
        ...(ancestor ? { tmpAncestorInHome: VIOLATION_CODE } : {}),
      })
    }
    expect(existsSync(sub) || existsSync(iso)).toBe(false)
  })

  it('an install folder handed over in a marker, or named by NVM_HOME, cannot make the real home exempt', () => {
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      "const { spawnSync } = await import('node:child_process')",
      'try { spawnSync(process.execPath, [t.script], { stdio: "ignore" }); out.scriptInHome = "no refusal" } catch (e) { out.scriptInHome = e && e.op }',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    // The script does not exist: an unguarded run only fails to find it. The marker
    // names the isolated root, so the child's inherited (isolated) home is no real home
    // and only the argument check can refuse.
    const file = childScript('forged-inst', body, { script: path.join(missing(), 'cli.js') })
    const marker = JSON.stringify({ v: 1, real: [], tmp: [], inst: [REAL], isolated: isolatedRoot() })
    const r = runChild(file, { env: { ...MIN_ENV, NVM_HOME: REAL, NVM_DIR: REAL, [MARKER_ENV]: marker } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ scriptInHome: 'child_process.spawnSync argv' })
  })

  it('a child marker always carries the parent real homes, merged into one the caller passed', () => {
    const body = ['const st = process[Symbol.for("ccc.test-home-guard.state")]', 'process.stdout.write(JSON.stringify({ marker: st ? st.markerRaw : null }))'].join('\n')
    const given = path.join(SCRATCH, 'given-real')
    const r = runChild(childScript('merge', body, {}), { env: { ...MIN_ENV, [MARKER_ENV]: JSON.stringify({ v: 1, real: [given], tmp: [], inst: [] }) } })
    expect(r.status, r.stderr).toBe(0)
    const marker = JSON.parse(String(r.out.marker)) as { real: string[] }
    const got = marker.real.map(norm)
    expect(got).toContain(norm(given))
    for (const root of realHomeRoots()) expect(got, root).toContain(norm(root))
  })

  it('with no isolated home to fill and no home given, a child env without HOME is refused; one given a home gets the rest under it', () => {
    const tmpHome = mkdtempSync(path.join(SCRATCH, 'tmphome-'))
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      "const { spawnSync } = await import('node:child_process')",
      'const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }',
      'await attempt("noHome", () => spawnSync(process.execPath, ["-e", "0"], { cwd: t.tmpHome, env: { ...base } }))',
      'await attempt("givenHome", () => { const r = spawnSync(process.execPath, ["-e", "0"], { cwd: t.tmpHome, env: { ...base, HOME: t.tmpHome } }); if (r.status !== 0) throw new Error("exit " + r.status) })',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    // A marker naming no isolated root: the child has no isolated home to fill in. Its
    // own home is a temp folder, so the values libuv copies in on Windows are safe.
    const r = runChild(childScript('fallback', body, { tmpHome }), {
      env: { ...MIN_ENV, HOME: tmpHome, USERPROFILE: tmpHome, [MARKER_ENV]: JSON.stringify({ v: 1, real: [], tmp: [], inst: [] }) },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ noHome: VIOLATION_CODE, givenHome: 'no refusal' })
  })

  it("a node script in a real home's npm folder may run; a script elsewhere in that home may not", () => {
    // The child's "real" home is a scratch folder holding an npm folder.
    const sim = mkdtempSync(path.join(SCRATCH, 'instsim-'))
    const home = path.join(sim, 'home')
    const tmp = path.join(sim, 'tmp')
    const npm = path.join(home, 'npm')
    mkdirSync(npm, { recursive: true })
    mkdirSync(tmp)
    writeFileSync(path.join(npm, 'ok.cjs'), '')
    writeFileSync(path.join(home, 'other.cjs'), '')
    const inner: Record<string, string> = { ...MIN_ENV, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, LOCALAPPDATA: tmp, TEMP: tmp, TMP: tmp, TMPDIR: tmp }
    if (WIN) Object.assign(inner, { HOMEDRIVE: tmp.slice(0, 2), HOMEPATH: tmp.slice(2) })
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      "const { spawnSync } = await import('node:child_process')",
      'await attempt("installed", () => { const r = spawnSync(process.execPath, [t.ok], { env: t.inner, cwd: t.tmp, encoding: "utf8" }); if (r.status !== 0) throw new Error("exit " + r.status + " " + r.stderr) })',
      'await attempt("elsewhere", () => spawnSync(process.execPath, [t.other], { env: t.inner, cwd: t.tmp }))',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const file = childScript('install', body, { ok: path.join(npm, 'ok.cjs'), other: path.join(home, 'other.cjs'), inner, tmp })
    const marker = JSON.stringify({ v: 1, real: [], tmp: [tmp], inst: [npm] })
    const r = runChild(file, { env: { ...MIN_ENV, HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp, [MARKER_ENV]: marker } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ installed: 'no refusal', elsewhere: VIOLATION_CODE })
  })

  it("a CI runner's RUNNER_TEMP is a temp area only in the runner layout, from the env or the marker; a caller's own value is checked", () => {
    // The runner layout: <work>/_temp beside the checkout. Here <work> is the folder that
    // holds this checkout, made a real home for the child through the marker; <work>/_temp
    // does not exist, so an allowed mkdir in it fails with ENOENT and creates nothing.
    const work = path.dirname(PROJECT_ROOT)
    const good = path.join(work, '_temp')
    expect(existsSync(good), `${good} must not exist for this test`).toBe(false)
    const bad = path.join(work, `ccc-iso-x-${TAG}`, '_temp')
    const sim = mkdtempSync(path.join(SCRATCH, 'runner-'))
    const home = path.join(sim, 'home')
    const tmp = path.join(sim, 'tmp')
    const own = path.join(home, 'x', '_temp') // <home>\x\_temp: temp-named, not the layout
    for (const d of [tmp, own]) mkdirSync(d, { recursive: true })
    // A grandchild env rebuilt from an allowlist (no RUNNER_TEMP), as the app's CLI runner builds one.
    const inner: Record<string, string> = { ...MIN_ENV, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, LOCALAPPDATA: tmp, TEMP: tmp, TMP: tmp, TMPDIR: tmp }
    if (WIN) Object.assign(inner, { HOMEDRIVE: tmp.slice(0, 2), HOMEPATH: tmp.slice(2) })
    const MK = [
      "const { spawnSync } = await import('node:child_process')",
      'const mk = (target, env) => () => { const r = spawnSync(process.execPath, ["-e", "require(\'node:fs\').mkdirSync(process.argv[1])", target], { env, cwd: t.tmp, encoding: "utf8" }); if (r.status !== 0) throw Object.assign(new Error(r.stderr), { code: r.stderr.includes(t.code) ? t.code : r.stderr.includes("ENOENT") ? "ENOENT" : "exit " + r.status }) }',
    ]
    const marker = (extra: object) => JSON.stringify({ v: 1, real: [], tmp: [tmp], inst: [], ...extra })
    const base = { ...MIN_ENV, TEMP: tmp, TMP: tmp, TMPDIR: tmp }
    const targets = { inner, tmp, code: VIOLATION_CODE, good, bad, own, sep: path.sep, probeRoot: path.join(tmp, 'probe'), forged: JSON.stringify({ v: 1, real: [], tmp: [], inst: [], runner: [] }) }

    // 1. Handed over in the marker (the CI shape): accepted, and passed on to grandchildren
    //    through the marker, through a probe env, and through RUNNER_TEMP alone.
    const one = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      ...MK,
      'await attempt("inMarker", () => fs.mkdirSync(t.good + t.sep + "x"))',
      'await attempt("notLayout", () => fs.mkdirSync(t.bad + t.sep + "x"))',
      'await attempt("viaMarker", mk(t.good + t.sep + "y", t.inner))',
      'await attempt("viaProbe", () => mk(t.good + t.sep + "z", g.isolatedProbeEnv(t.probeRoot))())',
      'await attempt("viaEnvOnly", mk(t.good + t.sep + "w", { ...t.inner, RUNNER_TEMP: t.good, CCC_HOME_GUARD: t.forged }))',
      'await attempt("envChecked", mk(t.tmp + t.sep + "q1", { ...t.inner, RUNNER_TEMP: t.bad }))',
      // A grandchild whose own environment names a home inside it (a CI step's CODEX_HOME
      // under RUNNER_TEMP) keeps the folder as a temp area and that home as a real one.
      'await attempt("besideEnvHome", mk(t.good + t.sep + "v", { ...t.inner, CODEX_HOME: t.good + t.sep + "h" }))',
      'await attempt("inEnvHome", mk(t.good + t.sep + "h" + t.sep + "x", { ...t.inner, CODEX_HOME: t.good + t.sep + "h" }))',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const a = runChild(childScript('runner-layout', one, targets), { env: { ...base, HOME: tmp, USERPROFILE: tmp, [MARKER_ENV]: marker({ real: [work], runner: [good, bad] }) } })
    expect(a.status, a.stderr).toBe(0)
    expect(a.out).toEqual({ inMarker: 'ENOENT', notLayout: VIOLATION_CODE, viaMarker: 'ENOENT', viaProbe: 'ENOENT', viaEnvOnly: 'ENOENT', envChecked: VIOLATION_CODE, besideEnvHome: 'ENOENT', inEnvHome: VIOLATION_CODE })

    // 2. A temp-named folder in the home that is not the layout (<home>\x\_temp), as this
    //    process's own RUNNER_TEMP: not a temp area; handing that same value on is no refusal.
    const two = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      ...MK,
      'await attempt("inOwn", () => fs.mkdirSync(t.own + t.sep + "x"))',
      'await attempt("ownValue", mk(t.tmp + t.sep + "q2", { ...t.inner, RUNNER_TEMP: t.own }))',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const b = runChild(childScript('runner-own', two, targets), { env: { ...base, HOME: home, USERPROFILE: home, RUNNER_TEMP: own, [MARKER_ENV]: marker({}) } })
    expect(b.status, b.stderr).toBe(0)
    expect(b.out).toEqual({ inOwn: VIOLATION_CODE, ownValue: 'no refusal' })
    expect(existsSync(path.join(own, 'x'))).toBe(false)
  })

  it("a toolchain worker runs guarded: esbuild's worker refuses to start its service in a real home", () => {
    // The child's "real" home is a scratch folder known only through the marker (as a
    // parent's real roots are), and the child works in it. The worker starts (it is not
    // refused), and inside it the guard refuses to start esbuild's service there; an
    // unguarded worker, or one not handed the marker, would start it.
    const sim = mkdtempSync(path.join(SCRATCH, 'wsim-'))
    const home = path.join(sim, 'home')
    const tmp = path.join(sim, 'tmp')
    const tmpHome = path.join(tmp, 'h')
    mkdirSync(home)
    mkdirSync(tmpHome, { recursive: true })
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      "const { createRequire } = await import('node:module')",
      'process.chdir(t.home)',
      'const esbuild = createRequire(t.projectFile)("esbuild")',
      'try { esbuild.transformSync("let x: number = 1", { loader: "ts" }); out.worker = "no refusal" } catch (e) { const m = String(e && e.message); out.worker = !m.includes(t.code) ? "other: " + m.slice(0, 300) : m.includes("worker_threads.Worker") ? "worker refused" : t.code }',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const file = childScript('toolchain-worker', body, { home, projectFile: path.join(PROJECT_ROOT, 'package.json'), code: VIOLATION_CODE })
    const marker = JSON.stringify({ v: 1, real: [home], tmp: [tmp], inst: [] })
    const r = runChild(file, { env: { ...MIN_ENV, HOME: tmpHome, USERPROFILE: tmpHome, TEMP: tmp, TMP: tmp, TMPDIR: tmp, [MARKER_ENV]: marker } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ worker: VIOLATION_CODE })
  })

  it("a toolchain worker does not inherit this process's preloads (they would run before the guard)", () => {
    // The child runs with a --require preload that reports from any worker it runs in.
    const dir = mkdtempSync(path.join(SCRATCH, 'wpre-'))
    const preload = path.join(dir, 'preload.cjs')
    writeFileSync(preload, "const wt = require('node:worker_threads'); if (!wt.isMainThread && wt.parentPort) wt.parentPort.postMessage('preload ran in a worker')\n")
    const body = [
      'const g = await import(t.guardUrl)',
      "const { Worker } = await import('node:worker_threads')",
      'const out = {}',
      // esbuild without its worker data only loads, then exits.
      'const w = new Worker(t.esbuildMain)',
      'const msgs = []',
      'w.on("message", (m) => msgs.push(m))',
      'out.exit = await new Promise((res) => { w.once("exit", res); w.once("error", (e) => res("error " + (e && e.message))) })',
      'out.preloadInWorker = msgs.includes("preload ran in a worker")',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const r = runChild(childScript('worker-preload', body, { esbuildMain: requireCjs.resolve('esbuild') }), { pre: ['--require', preload] })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ exit: 0, preloadInWorker: false })
  })

  it('the running node binary as the command word of a hook command is no refusal when it sits in a real home; as an operand, or the rest of that home, it is', () => {
    // The folder holding this node binary is a real home for the child, handed over in the
    // marker as a parent's real roots are (macOS runners keep node under HOME, and a test
    // hands it to a git hook). The grandchild only runs `node -e 0` with the argument:
    // nothing reads or writes it.
    const binDir = path.dirname(process.execPath)
    const sim = mkdtempSync(path.join(SCRATCH, 'execsim-'))
    const tmp = path.join(sim, 'tmp')
    mkdirSync(tmp)
    const inner: Record<string, string> = { ...MIN_ENV, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, LOCALAPPDATA: tmp, TEMP: tmp, TMP: tmp, TMPDIR: tmp }
    if (WIN) Object.assign(inner, { HOMEDRIVE: tmp.slice(0, 2), HOMEPATH: tmp.slice(2) })
    const body = [
      'const g = await import(t.guardUrl)',
      ATTEMPT,
      "const { spawnSync } = await import('node:child_process')",
      'const run = (arg) => () => { const r = spawnSync(process.execPath, ["-e", "0", arg], { env: t.inner, cwd: t.tmp }); if (r.status !== 0) throw new Error("exit " + r.status) }',
      'await attempt("hook", run(`"${process.execPath}" "${t.tmp}/mark.js" fsmonitor`))',
      'await attempt("sibling", run(`"${process.execPath}x" fsmonitor`))',
      // Not as an operand, nor with a stream suffix.
      'await attempt("operand", run(process.execPath))',
      'await attempt("stream", run(`"${process.execPath}::$DATA" x`))',
      'g.drainViolations()',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const file = childScript('exec-arg', body, { inner, tmp })
    const marker = JSON.stringify({ v: 1, real: [binDir], tmp: [tmp], inst: [] })
    const r = runChild(file, { env: { ...MIN_ENV, HOME: tmp, USERPROFILE: tmp, TEMP: tmp, TMP: tmp, TMPDIR: tmp, [MARKER_ENV]: marker } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ hook: 'no refusal', sibling: VIOLATION_CODE, operand: VIOLATION_CODE, stream: VIOLATION_CODE })
  })

  it('upgrades a probe-entry guard when the vitest entry loads later in the same process', () => {
    const body = [
      'const g = await import(t.coreUrl)',
      'const before = g.guardEntry()',
      'let unisolated = "no throw"; try { g.assertHomeIsolated() } catch (e) { unisolated = "threw" }',
      'g.installHomeGuard({ entry: "vitest", isolate: true })',
      'let isolated = "ok"; try { g.assertHomeIsolated() } catch (e) { isolated = String(e.message) }',
      'const os = await import("node:os")',
      'process.stdout.write(JSON.stringify({ before, unisolated, after: g.guardEntry(), isolated, homeInside: os.homedir().toLowerCase().startsWith(String(g.isolatedRoot()).toLowerCase()) }))',
    ].join('\n')
    // A marker naming no isolated root: the child starts guarded but not isolated.
    const r = runChild(childScript('upgrade', body, {}), { env: { ...MIN_ENV, [MARKER_ENV]: JSON.stringify({ v: 1, real: [], tmp: [], inst: [] }) } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.out).toEqual({ before: 'probe', unisolated: 'threw', after: 'vitest', isolated: 'ok', homeInside: true })
  })
})

describe('the isolated home looks like a real one', () => {
  // The 8.3 short form of a folder (Windows; empty when the volume makes no short names).
  const shortForm = (dir: string): string => {
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${dir}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true })
    const s = (r.stdout ?? '').trim()
    return s.includes('~') ? s : ''
  }
  const sim = WIN ? mkdtempSync(path.join(SCRATCH, 'short-name-folder-')) : ''
  const short = WIN ? shortForm(sim) : ''

  // Windows runners' TEMP carries 8.3 short names (RUNNER~1); a real profile path never does.
  it.runIf(WIN && short !== '')('on Windows it has no 8.3 short names, even when TEMP is written with them', () => {
    const body = [
      'const g = await import(t.coreUrl)',
      'g.installHomeGuard({ entry: "vitest", isolate: true })',
      'process.stdout.write(JSON.stringify({ root: g.isolatedRoot(), local: process.env.LOCALAPPDATA, home: process.env.USERPROFILE }))',
    ].join('\n')
    const r = runChild(childScript('short-temp', body, {}), { env: { ...MIN_ENV, TEMP: short, TMP: short, [MARKER_ENV]: JSON.stringify({ v: 1, real: [], tmp: [], inst: [] }) } })
    expect(r.status, r.stderr).toBe(0)
    const out = r.out as { root: string; local: string; home: string }
    for (const v of [out.root, out.local, out.home]) expect(v, v).not.toContain('~')
    // The long form of the short TEMP (the child removed the folder when it exited). On a
    // runner the scratch folder itself sits under a short TEMP, so compare long forms.
    expect(norm(out.root).startsWith(norm(fsNs.realpathSync.native(sim)) + path.sep)).toBe(true)
  })
})

describe('the pure checker (simulated roots, any host)', () => {
  type FakeStat = { isSymbolicLink: () => boolean; isDirectory: () => boolean }
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
        if (linkMap.has(key(p))) return { isSymbolicLink: () => true, isDirectory: () => false }
        try {
          realpathSync(p)
          return { isSymbolicLink: () => false, isDirectory: () => true }
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
      readdirSync: (p: string): string[] => {
        const k = key(p)
        return [...dirSet, ...linkMap.keys()].filter((e) => e.startsWith(k + '\\') && !e.slice(k.length + 1).includes('\\')).map((e) => e.slice(k.length + 1))
      },
    }
  }

  const win = createHomeChecker({
    platform: 'win32',
    realRoots: ['C:\\Users\\alice', 'C:\\Users\\John Smith'],
    userNames: ['alice'],
    allowedRoots: [
      { path: 'C:\\Users\\alice\\AppData\\Local\\Temp', kind: 'tmp' },
      { path: 'C:\\Users\\alice\\src\\repo', kind: 'project' },
    ],
    installRoots: ['C:\\Users\\alice\\AppData\\Roaming\\npm'],
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
    ['any UNC share', '\\\\localhost\\Users\\alice\\x'],
    ['a UNC share with forward slashes', '//server/share/x'],
    ['an unmappable device path', '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\x'],
    ['a file: URL string', 'file:///C:/Users/alice/x'],
    ['a file: URL object', new URL('file:///C:/Users/alice/x')],
    ['a URL-like object read by hostname and pathname', { href: 'file:///D:/safe', protocol: 'file:', hostname: '', pathname: '/C:/Users/alice/x' }],
    ['a Buffer', Buffer.from('C:\\Users\\alice\\x')],
    ['a relative path', '..\\Users\\alice\\x'],
    ['a root with a space', 'C:\\Users\\John Smith\\x'],
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

  it.each<[string]>([
    ['C:\\Users\\alice\\.claude'],
    ['C:\\Users\\alice\\Documents\\x'],
    ['C:\\Users\\alice'],
    ['C:\\Users\\alice\\.cl*'],
    ['C:\\Users\\ali*\\.claude'],
    ['C:\\Users\\{alice,bob}\\x'],
    ['~alice/.claude'],
    ['/c/Users/alice/.claude'],
    ['/mnt/c/Users/alice/x'],
    ['/cygdrive/c/users/alice'],
    ['/proc/cygdrive/c/Users/alice/.claude'],
    ['\\\\localhost\\Users\\alice\\.claude'],
    ['//localhost/Users/alice'],
    ['--cfg=k=C:\\Users\\alice\\.claude'],
    ['writable_roots=["C:\\Users\\alice\\.codex"]'],
    ['cd /d "C:\\Users\\John Smith\\x" && del y'],
    ['"C:\\Users\\John Smith\\Docs"'],
    ['C:\\Users\\alice\\src\\repo\\..\\..\\.claude'],
    ['file:///C:/Users/alice/x'],
    ['void "C:\\\\Users\\\\alice\\\\.codex"'],
    ['"\\\\localhost\\share\\x"'],
  ])('win32 argument %s is refused', (arg) => {
    expect(win.argHit(arg, 'C:\\work')).not.toBeNull()
    expect(win.argHit('x'.repeat(5000) + ' ' + arg, 'C:\\work'), 'after a long prefix').not.toBeNull()
  })

  it.each<[string]>([
    ['-e'],
    ['console.log(1/2)'],
    ['/* comment */ x'],
    ['C:\\Users\\alice\\AppData\\Local\\Temp\\x'],
    ['C:\\Users\\alice\\src\\repo\\tests\\x.ts'],
    ['C:\\Users\\bob\\.claude'],
    ['C:\\Users\\alicex\\y'],
    ['https://example.com/users/alice'],
    ['https://example.com/a/b'],
    ['--url=wss://h/x'],
    ['http://127.0.0.1:3000/mcp'],
    ['--registry=https://registry.npmjs.org/'],
    ['x.replace(/\\\\\\\\/g, "/")'],
    ['"\\\\\\\\server\\\\share"'],
    ['~/.claude/statusline.sh'],
    ['~~x'],
    ['/c'],
    ['D:\\Users\\alice\\x'],
    ['\\\\.\\pipe\\x'],
    ['require("path").join(__dirname, "..")'],
    ['require("fs").writeFileSync("C:\\\\Users\\\\alice\\\\AppData\\\\Local\\\\Temp\\\\x", "x")'],
    ['"C:\\\\Users\\\\alice\\\\src\\\\repo\\\\tests\\\\x.ts"'],
  ])('win32 argument %s is allowed', (arg) => {
    expect(win.argHit(arg, 'C:\\work')).toBeNull()
  })

  it('a /v switch read as drive V: (a mapped network share) is no refusal; V:\\x as written is', () => {
    const c = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice'],
      fsImpl: fakeFs(['C:\\', '\\\\server\\share'], { 'V:\\': '\\\\server\\share' }),
      cwd: () => 'C:\\work',
    })
    expect(c.argHit('/v', 'C:\\work')).toBeNull()
    expect(c.argHit('V:\\x', 'C:\\work')).not.toBeNull()
  })

  it('a volume-GUID path is mapped to its drive before the device rule; an unmapped one still fails closed', () => {
    const vol = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}'
    const c = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice'],
      allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }],
      fsImpl: fakeFs(['C:\\', 'C:\\Users', 'C:\\Users\\alice', 'C:\\T'], { [vol]: 'C:\\' }),
      cwd: () => 'C:\\T',
    })
    expect(c.isProtected(vol + '\\Users\\alice\\x')).toBe(true)
    expect(c.isProtected(vol + '\\T\\x')).toBe(false)
    expect(c.isProtected('\\\\?\\Volume{fedcba98-7654-3210-fedc-ba9876543210}\\T\\x')).toBe(true)
  })

  it('a cd / pushd / Set-Location into a real home, or above one, in a shell line', () => {
    for (const line of [
      'cd /d "C:\\Users\\alice" && del x',
      'cd C:\\Users && rmdir /s alice',
      'pushd C:\\Users\\alice\\.claude',
      'Set-Location C:\\Users; rm -r alice',
      'Set-Location -Path C:\\Users\\alice',
      'Push-Location C:\\Users',
      'cd /c/Users/alice && rm x',
      'cd/d "C:\\Users" && rmdir /s alice',
      'cd\\ && rmdir /s Users\\alice',
      'cd /d C:\\ && del Users\\alice\\x',
    ]) {
      expect(win.cdHit(line, 'C:\\work'), line).not.toBeNull()
    }
    expect(win.cdHit('cd.. && del .claude', 'C:\\Users\\alice\\x')).not.toBeNull()
    for (const line of ['cd /d "C:\\Users\\alice\\AppData\\Local\\Temp\\x" && del y', 'cd sub && dir', 'cd D:\\ && dir', 'echo cd', 'cd /v', 'cdx C:\\Users']) {
      expect(win.cdHit(line, 'C:\\work'), line).toBeNull()
    }
    // `cd ..` to a drive root: refused on the drive that holds a real home, fine elsewhere.
    expect(win.cdHit('cd .. && dir', 'C:\\work')).not.toBeNull()
    expect(win.cdHit('cd .. && dir', 'D:\\work')).toBeNull()
  })

  it('the command word of a cmd /c or sh -c line, and only that position, is exempt', () => {
    const shim = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd'
    expect(win.commandWord(`""${shim}" --version"`).word).toBe(shim)
    expect(win.commandWord('"C:\\Program Files\\x.cmd" a b').word).toBe('C:\\Program Files\\x.cmd')
    expect(win.commandWord("  '/home/u/.npm-global/bin/codex' --version").word).toBe('/home/u/.npm-global/bin/codex')
    expect(win.commandWord('tool.exe --x').word).toBe('tool.exe')
    // An unquoted word ends at shell punctuation.
    expect(win.commandWord(`${shim};del y`).word).toBe(shim)
    expect(win.commandWord('a&b').word).toBe('a')
    const base = 'C:\\work'
    expect(win.argHit(`""${shim}" --version"`, base)).not.toBeNull()
    expect(win.argHit(win.stripCommandWord(`""${shim}" --version"`, base), base)).toBeNull()
    expect(win.argHit(win.stripCommandWord(`${shim};echo ok`, base), base)).toBeNull()
    // The same path as an operand elsewhere in the line is still refused.
    expect(win.argHit(win.stripCommandWord(`"${shim}" & del /q "${shim}"`, base), base)).not.toBeNull()
    expect(win.argHit(win.stripCommandWord(`${shim};del ${shim}`, base), base)).not.toBeNull()
    expect(win.argHit(win.stripCommandWord(`""${shim}" C:\\Users\\alice\\.claude"`, base), base)).not.toBeNull()
    // Outside the npm folder nothing is blanked.
    expect(win.stripCommandWord('"C:\\Users\\alice\\bin\\claude.cmd" x', base)).toBe('"C:\\Users\\alice\\bin\\claude.cmd" x')
  })

  it('links are followed past the caps: deep fs paths, and argument candidates past the full-check cap', () => {
    const c = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice'],
      allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }],
      fsImpl: fakeFs(['C:\\', 'C:\\Users', 'C:\\Users\\alice', 'C:\\T'], { 'C:\\T\\link': 'C:\\Users\\alice' }),
      cwd: () => 'C:\\T',
    })
    expect(c.isProtected('C:\\T\\link\\' + 'd\\'.repeat(80) + 'f')).toBe(true)
    const many = Array.from({ length: 300 }, (_, i) => `k${i}=C:\\T\\p${i}`).join(' ')
    expect(c.argHit(many, 'C:\\T')).toBeNull()
    expect(c.argHit(`${many} C:\\T\\link\\x`, 'C:\\T')).not.toBeNull()
  })

  it('checking a 64 KB argument stays linear: well under 250 ms with the real filesystem', { timeout: 20_000 }, () => {
    const root = path.parse(PROJECT_ROOT).root
    const c = createHomeChecker({
      realRoots: [path.join(root, `ccc-iso-perf-${TAG}`, 'home')],
      allowedRoots: [{ path: os.tmpdir(), kind: 'tmp' }, { path: PROJECT_ROOT, kind: 'project' }],
    })
    const abs = (i: number): string => (WIN ? `C:\\ccc-iso-perf-${TAG}\\p${i}\\q` : `/ccc-iso-perf-${TAG}/p${i}/q`)
    // Many `=` with path-like values, many distinct absolute paths, and one long token full of separators.
    const big = Array.from({ length: 1800 }, (_, i) => `k${i}=./x/${i} ${abs(i)}`).join(' ')
    const deep = 'ab/c'.repeat(8192)
    expect(big.length).toBeGreaterThan(64 * 1024)
    let best = Infinity
    for (let n = 0; n < 3; n++) {
      const t0 = performance.now()
      expect(c.argHit(big, PROJECT_ROOT)).toBeNull()
      expect(c.argHit(deep, PROJECT_ROOT)).toBeNull()
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(250)
  })

  it('a script in a real home counts as installed only inside its npm or nvm folder', () => {
    expect(win.inInstallRoot('C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\x\\cli.js')).toBe(true)
    expect(win.inInstallRoot('C:\\Users\\alice\\AppData\\Roaming\\npm-x\\cli.js')).toBe(false)
    expect(win.inInstallRoot('C:\\Users\\alice\\x.js')).toBe(false)
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

  it('an operation on the entry itself (unlink, rm, rename) does not follow a link in the last component; its folder is followed', () => {
    // A link inside the home (C:\Users\alice\lnk), reached through dirlink: the fake fs
    // only knows links by their own path, so this one is told apart here.
    const linkInHome = (p: string) => p.toLowerCase() === 'c:\\t\\dirlink\\lnk'
    const ff = fakeFs(['C:\\', 'C:\\Users', 'C:\\Users\\alice', 'C:\\Users\\alice\\bin', 'C:\\T', 'C:\\T\\arg0'], {
        // A CLI's helper link to its own binary, made under the CLI's home's tmp folder.
        'C:\\T\\arg0\\apply_patch': 'C:\\Users\\alice\\bin\\cli.exe',
        'C:\\T\\dirlink': 'C:\\Users\\alice',
      })
    const c = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice'],
      allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }],
      fsImpl: { ...ff, lstatSync: (p: string) => (linkInHome(p) ? { isSymbolicLink: () => true, isDirectory: () => false } : ff.lstatSync(p)) },
      cwd: () => 'C:\\T',
    })
    expect(c.classify('C:\\T\\arg0\\apply_patch')).not.toBeNull()
    expect(c.classifyEntry('C:\\T\\arg0\\apply_patch')).toBeNull()
    expect(c.classifyEntry(Buffer.from('C:\\T\\arg0\\apply_patch'))).toBeNull()
    expect(c.classifyEntry('C:\\T\\dirlink')).toBeNull()
    // Through a link in the folder part, and a real-home path as written: still refused.
    expect(c.classifyEntry('C:\\T\\dirlink\\.claude')).not.toBeNull()
    expect(c.classifyEntry('C:\\T\\dirlink\\bin\\cli.exe')).not.toBeNull()
    // A link that is the last component, inside the home through a folder link: its folder
    // is followed, so it is the home's entry.
    expect(c.classifyEntry('C:\\T\\dirlink\\lnk')).not.toBeNull()
    expect(c.classifyEntry('C:\\Users\\alice\\.claude')).not.toBeNull()
    expect(c.classifyEntry('C:\\T\\..\\Users\\alice\\x')).not.toBeNull()
    expect(c.classifyEntry('\\\\server\\share\\x')).not.toBeNull()
    // Written with a trailing separator, or ending in `.`, the path names the link's target
    // (POSIX reads `link/` as `link/.`): checked the full way.
    for (const p of ['C:\\T\\dirlink\\', 'C:\\T\\dirlink/', 'C:\\T\\dirlink\\.']) expect(c.classifyEntry(p), p).not.toBeNull()
    expect(c.classifyEntry('C:\\T\\arg0\\')).toBeNull()
  })

  it('an entry that is not a link is checked by its real path: an 8.3 alias of a home, a subst or mapped drive root', () => {
    const base = fakeFs(['C:\\', 'C:\\Users', 'C:\\Users\\alice', 'C:\\T'], { 'C:\\T\\link': 'C:\\Users\\alice' })
    // Not links: names the filesystem resolves to the home (lstat sees a plain folder).
    const aliases: [string, string][] = [['c:\\users\\alicel~1', 'C:\\Users\\alice'], ['y:', 'C:\\Users\\alice'], ['x:', '\\\\server\\home']]
    const real = (p: string): string => {
      for (const [a, to] of aliases) if (p.toLowerCase() === a || p.toLowerCase().startsWith(a + '\\')) return to + p.slice(a.length)
      return p
    }
    const fsImpl = {
      ...base,
      lstatSync: (p: string) => (real(p) !== p ? { isSymbolicLink: () => false, isDirectory: () => true } : base.lstatSync(p)),
      realpathSync: (p: string) => (real(p) !== p ? real(p) : base.realpathSync(p)),
    }
    const c = createHomeChecker({ platform: 'win32', realRoots: ['C:\\Users\\alice'], allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }], fsImpl, cwd: () => 'C:\\T' })
    for (const p of ['C:\\Users\\ALICEL~1', 'C:\\Users\\ALICEL~1\\.claude', 'Y:\\', 'Y:\\.claude', 'X:\\']) expect(c.classifyEntry(p), p).not.toBeNull()
    // The link itself is still only a link.
    expect(c.classifyEntry('C:\\T\\link')).toBeNull()
  })

  // Measured: the two loop paths below read links 80 times with one shared budget per
  // resolution; a budget that restarts at each link grows without bound.
  const LOOP_READLINK_LIMIT = 200
  it('on POSIX a `..` after a link goes up from the link target, as the kernel reads it; Windows reads `..` by name, as it does', () => {
    const dirs = ['/', '/tmp', '/tmp/dir', '/home', '/home/u', '/home/u/sub']
    const links: [string, string][] = [['/tmp/plink', '/home/u/sub'], ['/home/u/out', '/tmp/dir']]
    const real = (p: string): string => {
      for (const [l, to] of links) if (p === l || p.startsWith(l + '/')) return to + p.slice(l.length)
      return p
    }
    let readlinks = 0
    const fail = (code: string): never => {
      throw Object.assign(new Error(code), { code })
    }
    const c = createHomeChecker({
      platform: 'linux',
      realRoots: ['/home/u'],
      allowedRoots: [{ path: '/tmp', kind: 'tmp' }],
      fsImpl: {
        lstatSync: (p: string) =>
          links.some(([l]) => l === p) || p === '/tmp/loop' ? { isSymbolicLink: () => true, isDirectory: () => false } : dirs.includes(real(p)) ? { isSymbolicLink: () => false, isDirectory: () => true } : undefined,
        realpathSync: (p: string) => (p === '/tmp/loop' || p.startsWith('/tmp/loop/') ? fail('ELOOP') : dirs.includes(real(p)) ? real(p) : fail('ENOENT')),
        // A link to itself through `..`: the walk must end, not recurse. Counted, and cut off
        // well past any sane cost, so a walk that grows without bound fails instead of hanging.
        readlinkSync: (p: string) => {
          if (++readlinks > 5000) fail('ELOOP')
          return p === '/tmp/loop' ? 'loop/../loop' : (links.find(([l]) => l === p)?.[1] ?? fail('EINVAL'))
        },
      },
      cwd: () => '/tmp',
    })
    // /tmp/plink -> /home/u/sub, so /tmp/plink/../x is /home/u/x.
    for (const p of ['/tmp/plink/../x', '/tmp/plink/../sub/../.ssh', 'plink/../x', '/tmp/plink/./../x']) {
      expect(c.classify(p), p).not.toBeNull()
      expect(c.classifyEntry(p), p).not.toBeNull()
    }
    expect(c.argHit('/tmp/plink/../x', '/tmp')).not.toBeNull()
    // A plain folder: `..` is its parent either way.
    expect(c.classify('/tmp/dir/../x')).toBeNull()
    expect(c.classifyEntry('/tmp/dir/../x')).toBeNull()
    // Both readings are checked (fails closed): /home/u/out -> /tmp/dir, so the kernel reads
    // /home/u/out/../x as /tmp/x, but the home spelling stays refused.
    expect(c.classify('/home/u/out/../x')).not.toBeNull()
    // A link loop through `..` ends within the shared link budget (40 links per resolution),
    // instead of recursing without end.
    readlinks = 0
    expect(c.classify('/tmp/loop/x')).toBeNull()
    expect(c.classify('/tmp/loop/../x')).toBeNull()
    expect(readlinks, 'links read for two loop paths').toBeLessThan(LOOP_READLINK_LIMIT)
    // Windows resolves `..` by name before it follows a link, so the guard does too.
    const w = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice'],
      allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }],
      fsImpl: fakeFs(['C:\\', 'C:\\T', 'C:\\Users', 'C:\\Users\\alice', 'C:\\Users\\alice\\sub'], { 'C:\\T\\plink': 'C:\\Users\\alice\\sub' }),
      cwd: () => 'C:\\T',
    })
    expect(w.classify('C:\\T\\plink\\..\\x')).toBeNull()
    expect(w.classify('C:\\T\\plink\\x')).not.toBeNull()
  })

  it('on POSIX a trailing slash names the target of a folder link: an rm of it is checked the full way', () => {
    const c = createHomeChecker({
      platform: 'linux',
      realRoots: ['/home/bob'],
      allowedRoots: [{ path: '/tmp', kind: 'tmp' }],
      fsImpl: {
        lstatSync: (p: string) => (p === '/tmp/link' || p === '/tmp/odd\\' ? { isSymbolicLink: () => true, isDirectory: () => false } : ['/', '/tmp', '/home', '/home/bob'].includes(p) ? { isSymbolicLink: () => false, isDirectory: () => true } : undefined),
        realpathSync: (p: string) => {
          if (p === '/tmp/link' || p === '/tmp/odd\\') return '/home/bob'
          if (['/', '/tmp', '/home', '/home/bob'].includes(p)) return p
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        },
        readlinkSync: (p: string) => {
          if (p === '/tmp/link' || p === '/tmp/odd\\') return '/home/bob'
          throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
        },
      },
      cwd: () => '/tmp',
    })
    expect(c.classifyEntry('/tmp/link')).toBeNull()
    for (const p of ['/tmp/link/', '/tmp/link/.', '/tmp/link//']) expect(c.classifyEntry(p), p).not.toBeNull()
    // A backslash is a name character there, not a separator: a link whose name ends in
    // one is still only a link.
    expect(c.classifyEntry('/tmp/link\\')).toBeNull()
    expect(c.classifyEntry('/tmp/odd\\')).toBeNull()
  })

  it('a recursive copy destination holding a link into a real home is caught', () => {
    const fake = fakeFs(['C:\\', 'C:\\Users', 'C:\\Users\\alice', 'C:\\T', 'C:\\T\\dest', 'C:\\T\\dest\\sub', 'C:\\T\\clean', 'C:\\T\\clean\\sub'], {
      'C:\\T\\dest\\sub\\lnk': 'C:\\Users\\alice',
    })
    const c = createHomeChecker({ platform: 'win32', realRoots: ['C:\\Users\\alice'], allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }], fsImpl: fake, cwd: () => 'C:\\T' })
    expect(c.treeHit('C:\\T\\dest')).not.toBeNull()
    expect(c.treeHit('C:\\T\\clean')).toBeNull()
    expect(c.treeHit('C:\\T\\absent')).toBeNull()
  })

  it('the more specific root wins; on a tie only the isolated root does', () => {
    const nested = createHomeChecker({ platform: 'win32', realRoots: ['C:\\T\\cfg'], allowedRoots: [{ path: 'C:\\T', kind: 'tmp' }], fsImpl: fakeFs([]) })
    expect(nested.isProtected('C:\\T\\cfg\\x')).toBe(true)
    expect(nested.isProtected('C:\\T\\y')).toBe(false)
    for (const kind of ['project', 'tmp'] as const) {
      const tie = createHomeChecker({ platform: 'win32', realRoots: ['C:\\R'], allowedRoots: [{ path: 'C:\\R', kind }], fsImpl: fakeFs([]) })
      expect(tie.isProtected('C:\\R\\x'), kind).toBe(true)
    }
    const tieIso = createHomeChecker({ platform: 'win32', realRoots: ['C:\\R'], allowedRoots: [{ path: 'C:\\R', kind: 'isolated' }], fsImpl: fakeFs([]) })
    expect(tieIso.isProtected('C:\\R\\x')).toBe(false)
  })

  it('posix compares case-sensitively, darwin folds case; arguments are checked the same way', () => {
    const none = { lstatSync: () => undefined, realpathSync: () => { throw new Error('ENOENT') }, readlinkSync: () => { throw new Error('EINVAL') } }
    const roots = {
      realRoots: ['/home/bob'],
      userNames: ['bob'],
      allowedRoots: [{ path: '/tmp', kind: 'tmp' as const }, { path: '/home/bob/work/repo', kind: 'project' as const }],
      fsImpl: none,
      cwd: () => '/home/bob/work/repo',
    }
    const linux = createHomeChecker({ ...roots, platform: 'linux' })
    expect(linux.isProtected('/home/bob/.claude/x')).toBe(true)
    expect(linux.isProtected('/home/bob/work/repo/tests/x')).toBe(false)
    expect(linux.isProtected('/home/bob/work/repo/../../.claude')).toBe(true)
    expect(linux.isProtected('/tmp/x')).toBe(false)
    expect(linux.isProtected('/HOME/bob/x')).toBe(false)
    expect(createHomeChecker({ ...roots, platform: 'darwin' }).isProtected('/HOME/bob/x')).toBe(true)
    for (const a of ['/home/bob/.claude', '~bob/.claude', 'PATH=/bin:/home/bob/.codex', '/home/bob', '/home/*', '../../.claude']) expect(linux.argHit(a, '/home/bob/work/repo'), a).not.toBeNull()
    for (const a of ['/home/bob/work/repo/tests/x', '/tmp/x', '/usr/bin/git', 'a / b', 'http://x/y', '~/.claude']) expect(linux.argHit(a, '/home/bob/work/repo'), a).toBeNull()
  })

  it('a binary named in executables is exempt only as the command word of a command line; never as an operand, a destination or another spelling', () => {
    const none = { lstatSync: () => undefined, realpathSync: () => { throw new Error('ENOENT') }, readlinkSync: () => { throw new Error('EINVAL') } }
    const node = '/Users/bob/toolcache/node/20/bin/node'
    const base = '/private/var/T'
    const roots = { realRoots: ['/Users/bob'], userNames: ['bob'], allowedRoots: [{ path: base, kind: 'tmp' as const }], fsImpl: none, cwd: () => base, platform: 'darwin' }
    const mac = createHomeChecker({ ...roots, executables: [node] })
    const hook = `"${node}" "${base}/x/mark.js" fsmonitor`
    // darwin folds case, so another casing of the same spelling is the same file.
    for (const a of [hook, `core.fsmonitor=${hook}`, `${node} ${base}/x/mark.js`, `'${node}' -e 0`, `"${node.toUpperCase()}" x`, 'fsmonitor', 'bob']) expect(mac.argHit(a, base), a).toBeNull()
    for (const a of [
      node, // an operand on its own (cp x <node>)
      `${base}/x ${node}`,
      `"${node}"`, // a command word with nothing after it reads as an operand
      `"${node}" x ${node}`, // the second one is an operand
      `"${node}" /Users/bob/.claude/x`,
      `"${node}::$DATA" x`,
      `"${node}:evil" x`,
      `"${node}." x`,
      `"${node} " x`,
      `"${node}  -e 0"`, // one quoted word: the binary is not its command word
      `${node}: x`,
      `${node}-other x`,
      '/Users/bob/toolcache/node/20/bin/npm x',
      `${node}/../../.ssh x`,
      '~bob/x',
    ]) expect(mac.argHit(a, base), a).not.toBeNull()
    expect(createHomeChecker(roots).argHit(hook, base)).not.toBeNull()
    // The command word of a shell line: that position only.
    expect(mac.stripCommandWord(`"${node}" x.js`, base)).not.toContain(node)
    expect(mac.stripCommandWord(`cp x "${node}"`, base)).toContain(node)
    // A link in the home that leads to the binary is still a path in the home, and on
    // Windows the forward-slash spelling counts as the same word.
    const viaLink = createHomeChecker({
      platform: 'win32',
      realRoots: ['C:\\Users\\alice'],
      executables: ['C:\\Users\\alice\\nodejs\\node.exe'],
      fsImpl: fakeFs(['C:\\Users\\alice\\nodejs\\node.exe', 'C:\\Users\\alice\\bin'], { 'C:\\Users\\alice\\bin\\node.exe': 'C:\\Users\\alice\\nodejs\\node.exe' }),
      cwd: () => 'C:\\work',
    })
    expect(viaLink.argHit('"C:\\Users\\alice\\nodejs\\node.exe" x', 'C:\\work')).toBeNull()
    expect(viaLink.argHit('"C:/Users/alice/nodejs/node.exe" x', 'C:\\work')).toBeNull()
    expect(viaLink.argHit('"C:\\Users\\alice\\bin\\node.exe" x', 'C:\\work')).not.toBeNull()
    expect(viaLink.argHit('"C:\\Users\\alice\\nodejs\\node.exe::$DATA" x', 'C:\\work')).not.toBeNull()
  })

  it("a runner temp folder counts only in GitHub's layout: <work>/_temp beside the checkout, holding no home", () => {
    const none = { lstatSync: () => undefined, realpathSync: () => { throw new Error('ENOENT') }, readlinkSync: () => { throw new Error('EINVAL') } }
    const posix = (c: string[], homes = ['/home/r']) => runnerTempsFrom(c, { projectRoot: '/home/r/work/repo/repo', homes, platform: 'linux', fsImpl: none })
    // The CI shape (Linux and macOS: <work> = ~/work).
    expect(posix(['/home/r/work/_temp'])).toEqual(['/home/r/work/_temp'])
    expect(posix(['/home/r/work/_temp/'])).toEqual(['/home/r/work/_temp'])
    for (const c of [
      '/home/r/x/_temp', // <home>/x/_temp: not beside the checkout
      '/home/r/work/Temp',
      '/home/r/work/t',
      '/home/r/work/tmp',
      '/home/r/work/_TEMP', // case-sensitive here
      '/home/r/.codex/tmp',
      '/home/r/work/repo/repo/../../x/_temp',
      'work/_temp', // relative
      '_temp',
      '',
    ]) expect(posix([c]), c).toEqual([])
    // Relative: never read against the working folder.
    expect(runnerTempsFrom(['../_temp', '_temp'], { projectRoot: process.cwd(), homes: [], platform: process.platform, fsImpl: none })).toEqual([])
    // One that holds a home it is given (the guard passes the trusted ones; a home only the
    // environment names inside a runner temp folder stays a real home instead).
    expect(posix(['/home/r/work/_temp'], ['/home/r', '/home/r/work/_temp/codex-home'])).toEqual([])
    // The Windows runner shape (D:\a\_temp beside D:\a\<repo>\<repo>), case folded.
    const win = (c: string) => runnerTempsFrom([c], { projectRoot: 'D:\\a\\repo\\repo', homes: ['C:\\Users\\u'], platform: 'win32', fsImpl: fakeFs([]) })
    expect(win('D:\\a\\_temp')).toEqual(['D:\\a\\_temp'])
    expect(win('D:\\a\\_TEMP')).toEqual(['D:\\a\\_TEMP'])
    for (const c of ['C:\\Users\\u\\x\\_temp', 'C:\\Users\\u\\AppData\\Local\\Temp', 'D:\\b\\_temp', 'D:\\a\\Temp']) expect(win(c), c).toEqual([])
  })

  it('an account-profiles folder above a real root is a real root too', () => {
    expect(deriveAccountProfilesRoots(['F:\\R\\account-profiles\\profile-1', 'C:\\Users\\a'], 'win32')).toEqual(['F:\\R\\account-profiles'])
    expect(deriveAccountProfilesRoots(['/srv/x/account-profiles/p'], 'linux')).toEqual(['/srv/x/account-profiles'])
  })
})

describe('probes: isolatedProbeEnv and probe-guard.mjs', () => {
  it('builds a FRESH env: nothing inherited but the essentials, the home variables inside the root, the guard preloaded', () => {
    const root = mkdtempSync(path.join(SCRATCH, 'probe-env-'))
    process.env.CCC_ISO_SENTINEL = 'inherited'
    try {
      const env = isolatedProbeEnv(root)
      expect(env.CCC_ISO_SENTINEL).toBeUndefined()
      const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'HOMEDRIVE', 'HOMEPATH', 'NODE_OPTIONS', MARKER_ENV, ...HOME_VARS, ...XDG_VARS])
      for (const k of Object.keys(env)) expect(allowed.has(k.toUpperCase()) || allowed.has(k), k).toBe(true)
      for (const name of HOME_VARS) {
        expect(inside(env[name], root), `${name}=${env[name]}`).toBe(true)
        expect(isDir(env[name]), name).toBe(true)
      }
      expect(env.NODE_OPTIONS).toBe(`--import=${PROBE_GUARD_URL}`)
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
      guardUrl: PROBE_GUARD_URL,
      del: missing(),
      write: inMissing(),
      cwd: missing(),
      envHome: missing(),
      argv: path.join(REAL, '.claude'),
      printEnv: 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))',
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
    const child = upperKeys(res.childEnv)
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) expect(inside(child[name], root), `${name}=${child[name]}`).toBe(true)
  })

  it('a probe that swallows a refusal exits non-zero', () => {
    const root = mkdtempSync(path.join(SCRATCH, 'probe-swallow-'))
    writeFileSync(path.join(root, 'target.txt'), missing())
    writeFileSync(
      path.join(root, 'probe.mjs'),
      "import fs from 'node:fs'\nconst t = fs.readFileSync(new URL('./target.txt', import.meta.url), 'utf8')\ntry { fs.rmSync(t) } catch { /* swallowed */ }\n",
    )
    const r = spawnSync(process.execPath, ['--import', PROBE_GUARD_URL, path.join(root, 'probe.mjs')], {
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
